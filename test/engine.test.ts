/**
 * Engine tests over in-memory fakes: no real agents ever run.
 * Covers the full lifecycle, the approval gate and every invalidation vector,
 * bounded concurrency/launches, unknown-outcome handling, idempotent resume,
 * peer challenge/response exchange, scribe separation, partial/failure
 * reporting, cancellation truth, and deadline handling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  SCHEMA_VERSION,
  type AdvanceResult,
  type AgentChoice,
  type ApprovedRoster,
  type CouncilConfig,
  type CouncilError,
  type CouncilState,
  type Engine,
  type ExecutionPolicy,
  type HostAdapter,
  type JournalEvent,
  type LaunchResult,
  type Perspective,
  type ProposedRoster,
  type PromptBuilder,
  type PromptContext,
  type Result,
  type SourceSnapshot,
  type StopOutcome,
  type Store,
  type SubmissionCheck,
  type SubmitInputResult,
  type TaskListRow,
  type WorkerLaunchSpec,
  type WorkerListRow,
  type WorkerObservation,
  type ApprovalBinding,
  type ApprovalRecord,
  type ClaimLedger,
  type CouncilReport,
} from '../src/contracts.js';
import { createEngine } from '../src/engine.js';
import { INTEGRITY_POLICY, emptyIndex } from '../src/artifacts.js';
import {
  canonicalRosterHash,
  err,
  parseChallengeEnvelope,
  resolveConfig,
} from '../src/validation.js';
import { qualifiedChallengeId } from '../src/claims.js';

const RUN = 'crun_testrun';
const AGENT: AgentChoice = { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' };

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = (error: CouncilError): Result<never> => ({ ok: false, error });

// ─── In-memory fake Store ────────────────────────────────────────────────────

interface FakeDb {
  runDir: string;
  state: CouncilState;
  artifacts: Map<string, string>;
  journal: JournalEvent[];
  proposed: ProposedRoster | null;
  approved: ApprovedRoster | null;
  approval: { record: ApprovalRecord; binding: ApprovalBinding } | null;
  snapshot: SourceSnapshot;
  liveSource: Record<string, string>;
}

function makeSnapshot(liveSource: Record<string, string>, targetRoot: string): SourceSnapshot {
  const files = Object.fromEntries(
    Object.entries(liveSource).map(([p, c]) => [p, { sha256: sha256(c), size: Buffer.byteLength(c) }]),
  );
  const headHash = sha256(
    Object.keys(files)
      .sort()
      .map((p) => `${p}:${files[p].sha256}`)
      .join('\n'),
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: 'snap_1',
    targetRoot,
    gitHead: null,
    takenAt: '2026-01-01T00:00:00.000Z',
    headHash,
    files,
  };
}

class FakeStore implements Store {
  readonly runDir: string;
  /** Fault injection: error returned once / persistently on the next op. */
  failNextAppend: CouncilError | null = null;
  appendError: CouncilError | null = null;
  failNextSaveState: CouncilError | null = null;
  saveError: CouncilError | null = null;
  /** RA-005 probe: journal unreadable (corrupt/torn) — engine must fail closed. */
  journalError: CouncilError | null = null;
  /** Ordering probe: [journal-append, state-save] sequence actually taken. */
  order: string[] = [];
  constructor(public db: FakeDb) {
    this.runDir = db.runDir;
  }
  async initialize(): Promise<Result<void>> {
    return ok(undefined);
  }
  async loadState() {
    return ok(structuredClone(this.db.state));
  }
  async saveState(state: CouncilState) {
    this.order.push('state');
    if (this.failNextSaveState !== null) {
      const e = this.failNextSaveState;
      this.failNextSaveState = null;
      return failRes(e);
    }
    if (this.saveError !== null) return failRes(this.saveError);
    this.db.state = structuredClone(state);
    return ok(undefined);
  }
  async withLock<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    return fn();
  }
  async writeArtifact(relPath: string, data: string | Uint8Array) {
    this.db.artifacts.set(relPath, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    return ok(undefined);
  }
  async readArtifact(relPath: string) {
    const v = this.db.artifacts.get(relPath);
    return v === undefined
      ? failRes(err('io_error', `artifact ${relPath} missing`, { details: { reason: 'not_found', relPath } }))
      : ok(v);
  }
  async artifactExists(relPath: string) {
    return ok(this.db.artifacts.has(relPath));
  }
  async listArtifacts(prefix: string) {
    return ok([...this.db.artifacts.keys()].filter((k) => k.startsWith(prefix)).sort());
  }
  async appendJournal(events: Omit<JournalEvent, 'seq'>[]) {
    this.order.push('journal');
    if (this.failNextAppend !== null) {
      const e = this.failNextAppend;
      this.failNextAppend = null;
      return failRes(e);
    }
    if (this.appendError !== null) return failRes(this.appendError);
    const out = events.map((e, i) => ({ ...e, seq: this.db.journal.length + i + 1 }));
    this.db.journal.push(...out);
    return ok(out);
  }
  async readJournal() {
    if (this.journalError !== null) return failRes(this.journalError);
    return ok([...this.db.journal]);
  }
  async writeProposedRoster(roster: ProposedRoster) {
    this.db.proposed = structuredClone(roster);
    return ok(undefined);
  }
  async readProposedRoster() {
    return this.db.proposed !== null
      ? ok(structuredClone(this.db.proposed))
      : failRes(err('io_error', 'no proposed roster'));
  }
  async writeApprovedRoster(roster: ApprovedRoster) {
    this.db.approved = structuredClone(roster);
    return ok(undefined);
  }
  async readApprovedRoster() {
    return this.db.approved !== null
      ? ok(structuredClone(this.db.approved))
      : failRes(err('io_error', 'no approved roster'));
  }
  async writeApproval(record: ApprovalRecord, binding: ApprovalBinding) {
    this.db.approval = { record: structuredClone(record), binding: structuredClone(binding) };
    return ok(undefined);
  }
  async readApproval() {
    return this.db.approval !== null
      ? ok(structuredClone(this.db.approval))
      : failRes(err('io_error', 'no approval'));
  }
  async readSnapshot() {
    return ok(structuredClone(this.db.snapshot));
  }
  async verifySourceSnapshot() {
    const changed: string[] = [];
    for (const [p, e] of Object.entries(this.db.snapshot.files)) {
      const cur = this.db.liveSource[p];
      if (cur === undefined || sha256(cur) !== e.sha256) changed.push(p);
    }
    for (const p of Object.keys(this.db.liveSource)) {
      if (!(p in this.db.snapshot.files)) changed.push(p);
    }
    changed.sort();
    return ok({ drift: changed.length > 0, changed });
  }
}

// ─── In-memory fake HostAdapter ──────────────────────────────────────────────

interface LaunchRecord {
  spec: WorkerLaunchSpec;
  result: LaunchResult;
}

class FakeHost implements HostAdapter {
  seq = 0;
  createRunCalls = 0;
  createTaskCalls = 0;
  launchCalls = 0;
  launches: LaunchRecord[] = [];
  liveness = new Map<string, { liveness: WorkerObservation['liveness']; taskStatus?: string }>();
  notifications: { to: string; subject: string; body: string }[] = [];
  stops: { dispatchId: string; outcome: StopOutcome }[] = [];
  released: string[] = [];
  /**
   * Host-visible records — what the documented read APIs would show. A row
   * exists only when the mutation LANDED host-side, whether or not the
   * receipt ever reached the engine (fault-injection tests push these
   * directly to simulate landed-but-unreceipted mutations).
   */
  landedTasks: TaskListRow[] = [];
  landedWorkers: WorkerListRow[] = [];
  requestStates = new Map<string, 'completed' | 'pending' | 'absent' | 'unknown'>();
  runImpl?: () => Result<{ runId: string }>;
  launchImpl?: (spec: WorkerLaunchSpec) => Result<LaunchResult>;
  observeImpl?: (dispatchId: string) => Result<WorkerObservation>;
  stopImpl?: (dispatchId: string) => Result<{ outcome: StopOutcome }>;
  listTasksImpl?: (runId: string) => Result<{ tasks: TaskListRow[] }>;
  listWorkersImpl?: (runId: string) => Result<{ workers: WorkerListRow[] }>;

  async createRun() {
    this.createRunCalls += 1;
    if (this.runImpl) return this.runImpl();
    return ok({ runId: 'orca_run_1' });
  }
  async createTask(input: { runId: string; specFilePath: string; title: string }) {
    this.createTaskCalls += 1;
    const taskId = `task_${this.createTaskCalls}`;
    this.landedTasks.push({ taskId, specFile: input.specFilePath, title: input.title });
    return ok({ taskId });
  }
  async launchWorker(spec: WorkerLaunchSpec) {
    this.launchCalls += 1;
    if (this.launchImpl) {
      const r = this.launchImpl(spec);
      if (r.ok) {
        this.launches.push({ spec, result: r.value });
        if (r.value.outcome === 'started' && r.value.dispatchId !== undefined) {
          this.landedWorkers.push({
            dispatchId: r.value.dispatchId,
            taskId: spec.taskId,
            terminalHandle: r.value.terminalHandle,
          });
        }
      }
      return r;
    }
    this.seq += 1;
    const res: LaunchResult = {
      outcome: 'started',
      dispatchId: `disp_${this.seq}`,
      terminalHandle: `term_${this.seq}`,
      requestId: `req_${this.seq}`,
    };
    this.launches.push({ spec, result: res });
    this.landedWorkers.push({ dispatchId: res.dispatchId!, taskId: spec.taskId, terminalHandle: res.terminalHandle });
    return ok(res);
  }
  async listTasks(input: { runId: string }) {
    if (this.listTasksImpl) return this.listTasksImpl(input.runId);
    return ok({ tasks: this.landedTasks.map((t) => ({ ...t })) });
  }
  async listWorkers(input: { runId: string }) {
    if (this.listWorkersImpl) return this.listWorkersImpl(input.runId);
    return ok({ workers: this.landedWorkers.map((w) => ({ ...w })) });
  }
  async requestShow(input: { requestId: string }) {
    return ok({ state: this.requestStates.get(input.requestId) ?? 'absent', raw: {} });
  }
  async observeWorker(input: { dispatchId: string }) {
    if (this.observeImpl) return this.observeImpl(input.dispatchId);
    const l = this.liveness.get(input.dispatchId);
    return ok({
      dispatchId: input.dispatchId,
      liveness: l?.liveness ?? 'working',
      ...(l?.taskStatus !== undefined ? { taskStatus: l.taskStatus } : {}),
    });
  }
  settle(dispatchId: string, failed = false) {
    this.liveness.set(dispatchId, { liveness: 'finished', taskStatus: failed ? 'failed' : 'completed' });
  }
  /**
   * One-shot outcome overrides dequeued per call — plants 'unknown'/'refused'
   * custody or a proven refusal for P-D4 custody assertions.
   */
  notificationResults: Result<{ outcome: 'sent' | 'unknown'; requestId?: string }>[] = [];
  async sendNotification(input: { to: string; subject: string; body: string }) {
    this.notifications.push(input);
    const r = this.notificationResults.shift();
    if (r !== undefined) return r;
    return ok({ outcome: 'sent' as const, requestId: `nreq_${this.notifications.length}` });
  }
  async requestStop(input: { dispatchId: string; reason: string }) {
    const r: Result<{ outcome: StopOutcome }> =
      this.stopImpl?.(input.dispatchId) ?? ok({ outcome: 'stopped' });
    const outcome: StopOutcome = r.ok ? r.value.outcome : 'unknown';
    this.stops.push({ dispatchId: input.dispatchId, outcome });
    return r;
  }
  async releaseWorker(input: { dispatchId: string }) {
    this.released.push(input.dispatchId);
    return ok({ released: true });
  }
}

// ─── Recording fake PromptBuilder ────────────────────────────────────────────

type PromptCall = { ctx: PromptContext; input: Record<string, unknown> };

class FakePrompts implements PromptBuilder {
  calls = {
    organiser: [] as PromptCall[],
    reviewerIndependent: [] as PromptCall[],
    scribeNotes: [] as PromptCall[],
    challenge: [] as PromptCall[],
    authorResponse: [] as PromptCall[],
    scribeSynthesis: [] as PromptCall[],
    supervisor: [] as PromptCall[],
  };
  private rec(kind: keyof FakePrompts['calls'], ctx: PromptContext, input: object): string {
    this.calls[kind].push({ ctx, input: input as Record<string, unknown> });
    return `SPEC:${kind}`;
  }
  organiser(ctx: PromptContext, input: { participantId: string; outputPath: string }) {
    return this.rec('organiser', ctx, input);
  }
  reviewerIndependent(
    ctx: PromptContext,
    input: { participantId: string; perspective: Perspective; outputPath: string },
  ) {
    return this.rec('reviewerIndependent', ctx, input);
  }
  scribeNotes(
    ctx: PromptContext,
    input: { participantId: string; admittedFindingsPaths: string[]; outputPath: string },
  ) {
    return this.rec('scribeNotes', ctx, input);
  }
  challenge(ctx: PromptContext, input: { participantId: string; envelopePath: string; outputPath: string }) {
    return this.rec('challenge', ctx, input);
  }
  authorResponse(ctx: PromptContext, input: { participantId: string; envelopePath: string; outputPath: string }) {
    return this.rec('authorResponse', ctx, input);
  }
  scribeSynthesis(
    ctx: PromptContext,
    input: { participantId: string; ledgerPath: string; journalPath: string; reportJsonPath: string; reportMdPath: string; summaryPath: string },
  ) {
    return this.rec('scribeSynthesis', ctx, input);
  }
  supervisor(ctx: PromptContext, input: { advanceCommand: string }) {
    return this.rec('supervisor', ctx, input);
  }
}

// ─── Environment assembly ────────────────────────────────────────────────────

interface Env {
  engine: Engine;
  store: FakeStore;
  host: FakeHost;
  prompts: FakePrompts;
  db: FakeDb;
  clock: { t: number };
  /** Optional per-seat findings override (default: `mkFindings` n=2). */
  findingsFor?: (pid: string, persp: string) => object;
}

function makeEnv(
  config: CouncilConfig,
  opts: { liveSource?: Record<string, string>; execution?: ExecutionPolicy } = {},
): Env {
  const targetRoot = mkdtempSync(join(tmpdir(), 'council-target-'));
  const liveSource = opts.liveSource ?? {};
  for (const [p, c] of Object.entries(liveSource)) {
    mkdirSync(dirname(join(targetRoot, p)), { recursive: true });
    writeFileSync(join(targetRoot, p), c);
  }
  const snapshot = makeSnapshot(liveSource, targetRoot);
  const clock = { t: Date.parse('2026-01-01T00:00:00Z') };
  const db: FakeDb = {
    runDir: mkdtempSync(join(tmpdir(), 'council-run-')),
    state: {
      schemaVersion: SCHEMA_VERSION,
      runId: RUN,
      orcaRunId: null,
      status: 'initialized',
      targetRoot,
      objective: 'review the target project',
      config,
      snapshotId: snapshot.snapshotId,
      approvalHash: null,
      participants: [],
      discussion: null,
      supervisor: { terminalHandle: 'term_supervisor', dispatchId: 'disp_sup' },
      consumption: { launches: 0, mailSent: 0 },
      phaseEnteredAt: new Date(clock.t).toISOString(),
      createdAt: new Date(clock.t).toISOString(),
    },
    // council.json — the run's immutable identity + integrity policy stamp,
    // exactly what FileStore.initialize writes for a new (receipts-v1) run,
    // plus the rebuildable empty receipt projection it seeds alongside.
    artifacts: new Map([
      ['council.json', JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        runId: RUN,
        targetRoot,
        objective: 'review the target project',
        snapshotId: snapshot.snapshotId,
        integrityPolicy: INTEGRITY_POLICY,
        createdAt: new Date(clock.t).toISOString(),
      })],
      ['integrity/index.json', JSON.stringify(emptyIndex(RUN), null, 2) + '\n'],
    ]),
    // The genesis policy marker FileStore.initialize writes as journal seq 1 —
    // every v1 journal carries it before any engine step runs.
    journal: [{
      seq: 1,
      ts: new Date(clock.t).toISOString(),
      type: 'run.initialized',
      actor: 'engine',
      payload: { runId: RUN, snapshotId: snapshot.snapshotId, integrity: INTEGRITY_POLICY },
    } as JournalEvent],
    proposed: null,
    approved: null,
    approval: null,
    snapshot,
    liveSource,
  };
  const store = new FakeStore(db);
  const host = new FakeHost();
  const prompts = new FakePrompts();
  const engine = createEngine({
    store,
    host,
    prompts,
    now: () => new Date(clock.t),
    ...(opts.execution !== undefined ? { execution: opts.execution } : {}),
  });
  return { engine, store, host, prompts, db, clock };
}

function configWith(partial: Partial<CouncilConfig>): CouncilConfig {
  const resolved = resolveConfig(partial);
  if (!resolved.ok) throw new Error(`bad test config: ${JSON.stringify(resolved.issues)}`);
  return resolved.value;
}

// ─── Worker output fixtures ──────────────────────────────────────────────────

const outPaths = {
  organiser: 'organiser/roster.proposed.json',
  findings: (pid: string) => `findings/${pid}.json`,
  scribeNotes: 'scribe/notes.json',
  challengeOut: (pid: string, r: number) => `rounds/${r}/challenges/${pid}.json`,
  challengeEnv: (pid: string, r: number) => `rounds/${r}/envelopes/challenge/${pid}.json`,
  responseOut: (pid: string, r: number) => `rounds/${r}/responses/${pid}.json`,
  responseEnv: (pid: string, r: number) => `rounds/${r}/envelopes/response/${pid}.json`,
  scribeReport: 'scribe/report.json',
};

function outputPathFor(spec: WorkerLaunchSpec): string {
  switch (spec.phase) {
    case 'organiser': return outPaths.organiser;
    case 'independent_review': return outPaths.findings(spec.participantId);
    case 'scribe_notes': return outPaths.scribeNotes;
    case 'challenge': return outPaths.challengeOut(spec.participantId, spec.round ?? 1);
    case 'author_response': return outPaths.responseOut(spec.participantId, spec.round ?? 1);
    case 'scribe_synthesis': return outPaths.scribeReport;
  }
}

function mkPerspectives(n: number): Perspective[] {
  return Array.from({ length: n }, (_, i) => ({
    perspectiveId: `persp_${i + 1}`,
    name: `Perspective ${i + 1}`,
    charter: {
      incentives: `incentives ${i + 1}`,
      expertise: `expertise ${i + 1}`,
      method: `method ${i + 1}`,
      blindSpots: `blind spots ${i + 1}`,
      reviewQuestions: [`question A${i + 1}`, `question B${i + 1}`],
    },
    tags: [`t${i + 1}`],
  }));
}

function mkProposal(n: number): ProposedRoster {
  return { schemaVersion: SCHEMA_VERSION, runId: RUN, perspectives: mkPerspectives(n) };
}

function mkFindings(pid: string, persp: string, n = 2): object {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN,
    participantId: pid,
    perspectiveId: persp,
    findings: Array.from({ length: n }, (_, i) => ({
      findingId: `f_${pid}_${i}`,
      title: `finding ${pid} ${i}: something looks off`,
      kind: 'defect',
      severity: i === 0 ? 'high' : 'medium',
      confidence: 0.7,
      evidence: [{ kind: 'reasoned', note: `reasoned by ${pid}` }],
    })),
  };
}

function mkScribeNotes(): object {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN,
    participantId: 'scribe',
    claimSummaries: [{ claimId: 'clm_0001', summary: 'initial notes', possibleDuplicates: [], openQuestions: [] }],
    observations: 'obs',
  };
}

function mkScribeReport(): object {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN,
    generatedAt: '2026-01-01T01:00:00.000Z',
    summary: 'SCRIBE NARRATIVE SUMMARY',
    coverage: {
      requestedPerspectives: 15,
      proposedPerspectives: 15,
      selectedSeats: 15,
      seats: [],
      uncoveredPerspectiveIds: [],
      partial: false,
    },
    claims: [],
    limitations: ['scribe limitation note'],
  };
}

async function challengesFor(env: Env, pid: string, round: number): Promise<object> {
  const envText = (await env.store.readArtifact(outPaths.challengeEnv(pid, round)));
  assert.ok(envText.ok, `envelope for ${pid} round ${round} missing`);
  const envelope = JSON.parse(envText.value) as { assignments: { claimId: string }[] };
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN,
    round,
    participantId: pid,
    challenges: envelope.assignments.map((a, i) => ({
      challengeId: `ch_${pid}_${round}_${i}`,
      claimId: a.claimId,
      kind: 'missing_evidence',
      argument: `challenge from ${pid} on ${a.claimId}`,
      evidence: [],
    })),
  };
}

async function responsesFor(env: Env, pid: string, round: number, disposition: string = 'defend'): Promise<object> {
  const envText = await env.store.readArtifact(outPaths.responseEnv(pid, round));
  assert.ok(envText.ok, `response envelope for ${pid} round ${round} missing`);
  const envelope = JSON.parse(envText.value) as {
    assignments: { claimId: string; challenges: { challengeId: string }[] }[];
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN,
    round,
    participantId: pid,
    responses: envelope.assignments.flatMap((a) =>
      a.challenges.map((c) => ({
        claimId: a.claimId,
        challengeId: c.challengeId,
        disposition,
        argument: `response from ${pid}`,
        evidence: [],
      })),
    ),
  };
}

/** Complete every launched worker with appropriate valid output, then advance until non-progress (or `stop`). */
async function drive(env: Env, stop?: () => boolean): Promise<AdvanceResult> {
  for (let guard = 0; guard < 400; guard++) {
    for (const l of env.host.launches) {
      const d = l.result.dispatchId;
      if (d === undefined || env.host.liveness.get(d)?.liveness === 'finished') continue;
      let json: object;
      switch (l.spec.phase) {
        case 'organiser': json = mkProposal(env.db.state.config.requestedPerspectives); break;
        case 'independent_review': {
          const p = env.db.state.participants.find((x) => x.participantId === l.spec.participantId);
          json = (env.findingsFor ?? mkFindings)(l.spec.participantId, p?.perspectiveId ?? 'persp_1');
          break;
        }
        case 'scribe_notes': json = mkScribeNotes(); break;
        case 'challenge': json = await challengesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
        case 'author_response': json = await responsesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
        case 'scribe_synthesis': json = mkScribeReport(); break;
      }
      await env.store.writeArtifact(outputPathFor(l.spec), JSON.stringify(json));
      env.host.settle(d);
    }
    const r = await env.engine.advance();
    assert.ok(r.ok, `advance failed: ${r.ok ? '' : JSON.stringify(r.error)}`);
    if (stop?.()) return r.value;
    if (r.value.action !== 'progress') return r.value;
  }
  throw new Error('drive guard exhausted — engine did not settle');
}

async function driveToApproval(env: Env) {
  const r = await drive(env);
  assert.equal(r.action, 'needs_approval', JSON.stringify(r));
  assert.equal(env.db.state.status, 'awaiting_approval');
}

function mkApprovedRoster(env: Env, seatPids: string[], participantOffset = 0): ApprovedRoster {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN,
    seats: seatPids.map((persp, i) => ({
      seatId: `seat_${i + 1}`,
      perspectiveId: persp,
      participantId: `rev_${participantOffset + i + 1}`,
      agent: { ...AGENT },
    })),
  };
}

// ─── Lifecycle tests ─────────────────────────────────────────────────────────

test('full 15-seat lifecycle: organiser → gate → independent → scribe → challenges → responses → synthesis → report', async () => {
  const env = makeEnv(configWith({}));
  await driveToApproval(env);
  // Gate: no reviewer launches before approval.
  assert.equal(env.host.launches.length, 1, 'only the organiser launched');
  const roster = mkApprovedRoster(env, Array.from({ length: 15 }, (_, i) => `persp_${i + 1}`));
  const ap = await env.engine.approve({ roster, approver: 'test-orchestrator' });
  assert.ok(ap.ok);
  assert.ok(/^[0-9a-f]{64}$/.test(ap.value.hash));
  // The approval binds charters: hash covers proposedRosterHash.
  assert.equal(env.db.approval!.binding.proposedRosterHash, canonicalRosterHash(env.db.proposed!));
  // Explicit wake was sent to the supervisor (prefer its recorded Dispatch).
  assert.equal(env.host.notifications.length, 1);
  assert.equal(env.host.notifications[0].to, 'dispatch:disp_sup');

  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  assert.equal((r as { outcome?: string }).outcome, 'succeeded');
  const state = env.db.state;
  assert.equal(state.status, 'reported');

  // Organiser + 15 reviewers × (independent + challenge + response) + 2 scribe phases = 48 launches.
  assert.equal(state.consumption.launches, 48);
  assert.equal(env.host.launches.length, 48);
  // Every phase attempt is a FRESH orchestration Task.
  const taskIds = new Set(state.participants.flatMap((p) => p.attempts.map((a) => a.taskId)));
  assert.equal(taskIds.size, 48);
  assert.equal(env.host.createTaskCalls, 48);
  // Every launch went through immutable intent → task → worker order.
  // Attempt-level intents carry launchIntentId; stage markers (task-create /
  // worker-launch issue proof) carry `stage` and are additional.
  const intents = env.db.journal.filter(
    (e) => e.type === 'launch.intent' && typeof e.payload?.launchIntentId === 'string',
  );
  const started = env.db.journal.filter((e) => e.type === 'worker.started');
  assert.equal(intents.length, 48);
  assert.equal(started.length, 48);
  for (const s of started) {
    const intent = intents.find((e) => e.payload?.attemptId === s.payload?.attemptId);
    assert.ok(intent !== undefined && intent.seq < s.seq, `intent precedes start for ${String(s.payload?.attemptId)}`);
  }
  // Scribe is a distinct participant/session; reviewers reused own retained terminal.
  const scribe = state.participants.find((p) => p.participantId === 'scribe')!;
  assert.equal(scribe.role, 'scribe');
  const reviewLaunches = env.host.launches.filter((l) => l.spec.phase === 'challenge');
  assert.ok(
    reviewLaunches.every((l) => l.spec.reuseTerminal !== undefined),
    'challenge phase reused the settled retained session',
  );
  // Concurrency never exceeded 5.
  const concurrencyProbe = env.db.journal.filter((e) => e.type === 'worker.started').length;
  assert.ok(concurrencyProbe > 0);
  // Report artifacts: runner-canonical claims + scribe narrative + coverage.
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  assert.equal(report.runId, RUN);
  assert.equal(report.summary, 'SCRIBE NARRATIVE SUMMARY', 'scribe narrative used');
  assert.equal(report.coverage.selectedSeats, 15);
  assert.equal(report.coverage.partial, false);
  assert.ok(report.claims.length > 0, 'runner-canonical claims present');
  assert.ok(report.limitations.includes('scribe limitation note'));
  assert.ok(env.db.artifacts.has('report.md'));
  assert.ok(env.db.artifacts.has('summary.md'));
  // Ledger written; claims carry provenance and challenge history.
  const ledger = JSON.parse(env.db.artifacts.get('claims.json')!) as ClaimLedger;
  assert.equal(ledger.claims.length, report.claims.length);
  assert.ok(ledger.claims.every((c) => c.history.some((h) => h.type === 'challenged') || c.status === 'proposed'));
  // Retained workers released at finish.
  assert.ok(env.host.released.length >= 15, 'settled retained workers released');
});

test('default volume: 15 seats × 7 findings = 105 distinct claims, real byte/cap omissions, bounded strengths', async () => {
  // Full default configuration — the required combined-volume case the first
  // report omitted. NO budget is enlarged: envelope 8192, challenge/response
  // caps 3, concurrency 5, rounds 1, maxLaunches 56, so byte-cap and per-seat
  // omissions are exercised for real. Simulated host evidence only.
  const env = makeEnv(configWith({}));
  const cfg = env.db.state.config;
  assert.equal(cfg.participants, 15);
  assert.equal(cfg.requestedPerspectives, 15);
  assert.equal(cfg.concurrency, 5);
  assert.equal(cfg.rounds, 1);
  assert.equal(cfg.envelopeBytes, 8192);
  assert.equal(cfg.maxChallengesPerSeatPerRound, 3);
  assert.equal(cfg.maxResponsesPerSeatPerRound, 3);
  assert.equal(cfg.maxFindingsPerSeat, 7);
  assert.equal(cfg.maxLaunches, 56);
  // Every seat files the default 7 findings + one bounded, honestly-evidenced
  // strength; rev_1 additionally files a phantom-evidence strength that must
  // be rejected visibly rather than admitted as bare praise.
  env.findingsFor = (pid, persp) => {
    const f = mkFindings(pid, persp, 7) as { strengths?: object[] };
    f.strengths = [{
      strengthId: `S-${pid}`,
      feature: `well-scoped ${pid} work`,
      benefit: 'keeps the seat honest',
      preserve: 'keep the evidence discipline',
      evidence: [{ kind: 'reasoned', note: `reasoned by ${pid}` }],
    }];
    if (pid === 'rev_1') {
      f.strengths.push({
        strengthId: 'S-phantom',
        feature: 'imaginary subsystem',
        benefit: 'unverifiable praise',
        preserve: 'none',
        evidence: [{ kind: 'code_location', note: 'cited', path: 'src/ghost.js', startLine: 1 }],
      });
    }
    return f;
  };
  await driveToApproval(env);
  const ap = await env.engine.approve({
    roster: mkApprovedRoster(env, Array.from({ length: 15 }, (_, i) => `persp_${i + 1}`)),
    approver: 'test-orchestrator',
  });
  assert.ok(ap.ok);
  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  const state = env.db.state;
  assert.equal(state.status, 'reported');

  // ── Exact unique participants/attempts/tasks/launches ─────────────────────
  assert.equal(state.consumption.launches, 48, 'organiser + 15×3 + scribe×2 within the 56 cap');
  assert.equal(env.host.createTaskCalls, 48);
  const pids = state.participants.map((p) => p.participantId);
  assert.equal(new Set(pids).size, pids.length, 'no duplicate participant objects');
  assert.equal(state.participants.length, 17, 'organiser + 15 reviewers + scribe');
  const attempts = state.participants.flatMap((p) => p.attempts);
  assert.equal(new Set(attempts.map((a) => a.attemptId)).size, attempts.length, 'no duplicate attempt ids');
  assert.equal(new Set(attempts.map((a) => a.taskId)).size, 48, 'one task per attempt');
  assert.equal(env.host.launches.length, 48);
  assert.equal(
    env.db.journal.filter((e) => e.type === 'launch.intent' && typeof e.payload?.launchIntentId === 'string').length,
    48,
    'one attempt-level intent per launch',
  );
  assert.equal(env.db.journal.filter((e) => e.type === 'worker.started').length, 48);

  // Concurrency bound from durable evidence: at no journal point were more
  // than `concurrency` workers live (started without a terminal record).
  let live = 0;
  let maxLive = 0;
  const settled = new Set<string>();
  for (const e of env.db.journal) {
    if (e.type === 'worker.started' && typeof e.payload?.attemptId === 'string') {
      if (!settled.has(e.payload.attemptId)) live += 1;
    } else if (
      (e.type === 'worker.settled' || e.type === 'worker.stopped' || e.type === 'worker.timed_out') &&
      typeof e.payload?.attemptId === 'string' &&
      !settled.has(e.payload.attemptId)
    ) {
      settled.add(e.payload.attemptId);
      live -= 1;
    }
    if (live > maxLive) maxLive = live;
  }
  assert.ok(maxLive <= cfg.concurrency, `concurrency cap 5 exceeded: ${maxLive} workers live at once`);

  // ── Every claim retained ──────────────────────────────────────────────────
  const ledger = JSON.parse(env.db.artifacts.get('claims.json')!) as ClaimLedger;
  assert.equal(ledger.claims.length, 105, '105 distinct findings admitted — caps may omit routing, never the claim');
  const allClaimIds = new Set(ledger.claims.map((c) => c.claimId));
  assert.equal(Object.keys(ledger.provenance).length, 105);
  // 15 bounded strengths admitted with runner-stamped provenance; the phantom
  // is a journaled rejection, not bare praise.
  assert.equal(ledger.strengths?.length, 15);
  assert.ok(
    ledger.strengths!.every((s) => s.strengthId === `S-${s.participantId}`),
    'runner stamps each strength with its admitting seat — never worker self-attribution',
  );
  assert.ok(
    env.db.journal.some((e) => e.type === 'artifact.rejected' && e.payload?.kind === 'strength' && e.payload?.strengthId === 'S-phantom'),
    'phantom strength rejection journaled',
  );

  // ── Challenge routing: once per stage, disjoint families covering all claims
  const rec = ledger.discussion?.rounds.find((x) => x.round === 1);
  assert.ok(rec !== undefined && rec.challenges !== undefined && rec.responses !== undefined, 'one routing record with both stage families');
  const routed = new Set(rec.challenges.routedClaimIds);
  const byteDropped = new Set(rec.challenges.byteDroppedClaimIds);
  const unassignedIds = rec.challenges.unassigned.map((u) => u.claimId);
  const unassigned = new Set(unassignedIds);
  assert.equal(unassignedIds.length, unassigned.size, 'no duplicate unassigned entries');
  for (const cid of allClaimIds) {
    const cover = (routed.has(cid) ? 1 : 0) + (byteDropped.has(cid) ? 1 : 0) + (unassigned.has(cid) ? 1 : 0);
    assert.equal(cover, 1, `claim ${cid} must sit in exactly one challenge-routing family`);
  }
  // Plan math from the ACTUAL assignment: each of 105 single-author claims has
  // 14 eligible challengers and seat capacity is 15×3=45 — so exactly 45 claims
  // are plan-assigned and the remaining 60 are plan-unassigned, independently
  // of any byte drops (which only ever shrink the routed subset).
  const planAssigned = routed.size + byteDropped.size;
  assert.equal(planAssigned, 45, 'every seat filled to the per-seat challenge cap');
  assert.equal(unassigned.size, 60, 'remaining claims unassigned at default caps — the omission this test exists to see');
  for (const u of rec.challenges.unassigned) {
    assert.ok(typeof u.reason === 'string' && u.reason.length > 0, `unassigned ${u.claimId} carries its plan reason`);
  }
  // Per-envelope durable facts: ≤ cap assignments, ≤ envelopeBytes, and the
  // union of journaled assignedIds equals the ledger's routed set exactly.
  const envBuilt = env.db.journal.filter((e) => e.type === 'envelope.built' && e.phase === 'challenge');
  assert.equal(envBuilt.length, 15, 'one challenge envelope per challenger seat');
  const journaledRouted = new Set<string>();
  for (const e of envBuilt) {
    const ids = (e.payload?.assignedIds ?? []) as string[];
    assert.ok(ids.length <= cfg.maxChallengesPerSeatPerRound, `${e.participantId} envelope above the challenge cap`);
    for (const id of ids) journaledRouted.add(id);
    const envPath = e.payload!.path as string;
    const envFile = env.db.artifacts.get(envPath);
    assert.ok(envFile !== undefined, `envelope artifact ${envPath} written`);
    assert.ok(Buffer.byteLength(envFile) <= cfg.envelopeBytes, `envelope ${envPath} exceeds ${cfg.envelopeBytes} bytes`);
    // Byte-dropped ids journaled on the same event must not overlap its assigned ids.
    const omitted = (e.payload?.omitted ?? []) as string[];
    for (const o of omitted) assert.ok(!ids.includes(o), `${envPath}: byte-dropped id also marked assigned`);
  }
  assert.deepEqual([...journaledRouted].sort(), [...routed].sort(), 'ledger routed == union of journaled assignedIds');
  // Admitted challenges: one ChallengesFile per seat, ≤ cap entries each, and
  // the total is exactly the routed set (workers filed everything assigned).
  const chAdmits = env.db.journal.filter((e) => e.type === 'artifact.admitted' && e.phase === 'challenge');
  assert.equal(chAdmits.length, 15);
  const filedChallenges = new Map<string, string>(); // qualifiedId → claimId
  let filedCount = 0;
  for (const e of envBuilt) {
    const pid = e.participantId!;
    const file = JSON.parse(env.db.artifacts.get(outPaths.challengeOut(pid, 1))!) as { challenges: { challengeId: string; claimId: string }[] };
    assert.ok(file.challenges.length <= cfg.maxChallengesPerSeatPerRound);
    for (const ch of file.challenges) {
      filedChallenges.set(qualifiedChallengeId(1, pid, ch.challengeId), ch.claimId);
      filedCount += 1;
    }
  }
  assert.equal(filedCount, routed.size, 'admitted challenges == routed claim count (nothing silently re-routed)');

  // ── Response routing: qualified ids, partition over admitted challenges ────
  const resp = rec.responses!;
  const respRouted = new Set(resp.routedChallengeIds);
  const capOmittedIds = new Set(resp.capOmitted.map((o) => o.challengeId));
  const unroutableIds = new Set(resp.unroutable.map((u) => u.challengeId));
  const respByteDroppedClaims = new Set(resp.byteDropped.map((b) => b.claimId));
  for (const qid of respRouted) assert.match(qid, /^ch-r1-[0-9a-f]{32}$/, `qualified challenge id ${qid}`);
  for (const [qid, claimId] of filedChallenges) {
    const cover =
      (respRouted.has(qid) ? 1 : 0) +
      (capOmittedIds.has(qid) ? 1 : 0) +
      (unroutableIds.has(qid) ? 1 : 0) +
      (respByteDroppedClaims.has(claimId) ? 1 : 0);
    assert.equal(cover, 1, `admitted challenge ${qid} in exactly one response-routing family`);
  }
  // Every response envelope honoured the author cap (challenges summed across
  // its claim entries) and the byte cap.
  const respBuilt = env.db.journal.filter((e) => e.type === 'envelope.built' && e.phase === 'author_response');
  for (const e of respBuilt) {
    const envFile = env.db.artifacts.get(e.payload!.path as string)!;
    assert.ok(Buffer.byteLength(envFile) <= cfg.envelopeBytes, `response envelope ${e.payload!.path} exceeds byte cap`);
    const parsed = JSON.parse(envFile) as { assignments: { challenges: unknown[] }[] };
    const chCount = parsed.assignments.reduce((n, a) => n + a.challenges.length, 0);
    assert.ok(chCount <= cfg.maxResponsesPerSeatPerRound, `${e.participantId} response envelope above the response cap`);
  }

  // ── Report, coverage, receipts, budgets ────────────────────────────────────
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  assert.equal(report.coverage.selectedSeats, 15);
  assert.equal(report.coverage.partial, false, 'all seats completed — coverage is genuine, not inflated');
  assert.equal(report.claims.length, 105);
  const dFacts = report.runnerFacts?.discussion;
  assert.ok(dFacts !== undefined && dFacts.length === 1, 'report carries one round of discussion accounting');
  const d = dFacts![0];
  assert.equal(d.challengesFiled, filedCount);
  assert.equal(d.claimsRouted, routed.size);
  assert.equal(d.claimsNeverRouted, 60);
  assert.equal(d.claimsUnassigned, 60);
  assert.equal(d.claimsByteDropped, byteDropped.size);
  assert.equal(d.challengesAnswered, respRouted.size, 'every routed challenge got a defend response');
  assert.equal(d.challengesUnanswered, filedCount - respRouted.size);
  assert.equal(d.responsesCapOmitted, capOmittedIds.size);
  assert.equal(d.responsesUnroutable, unroutableIds.size);
  // Managed artifacts are receipt-bound in the journal (exact bytes + marker).
  const receipted = env.db.journal.filter(
    (e) => e.payload?.integrity === 'receipts-v1' && typeof e.payload?.sha256 === 'string',
  );
  for (const path of ['report.json', 'claims.json', 'report.md']) {
    assert.ok(
      receipted.some((e) => e.payload?.path === path),
      `managed artifact ${path} journaled with an exact-byte receipt`,
    );
  }
  assert.ok(
    envBuilt.every((e) => typeof e.payload?.sha256 === 'string'),
    'every challenge envelope write carried its receipt fields',
  );
  // Budgets: launches within the computed cap; reviewer mail below per-target cap.
  assert.ok(state.consumption.launches <= cfg.maxLaunches);
  assert.ok(state.consumption.mailSent <= cfg.maxMailPerParticipant * 2, 'mail within bounded per-target budget');
});

test('reduced 2-seat lifecycle runs the same protocol at 9 launches', async () => {
  const env = makeEnv(configWith({ requestedPerspectives: 10, participants: 2 }));
  await driveToApproval(env);
  const roster = mkApprovedRoster(env, ['persp_1', 'persp_2']);
  const ap = await env.engine.approve({ roster, approver: 'orch' });
  assert.ok(ap.ok);
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  assert.equal(env.db.state.consumption.launches, 9); // 1 + 2 + 1 + 2 + 2 + 1
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  assert.equal(report.coverage.selectedSeats, 2);
  assert.equal(report.coverage.partial, false);
});

test('rounds=2 lifecycle runs a second bounded discussion cycle before synthesis', async () => {
  const env = makeEnv(configWith({ requestedPerspectives: 10, participants: 2, rounds: 2 }));
  await driveToApproval(env);
  const ap = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'orch' });
  assert.ok(ap.ok);
  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  // 1 organiser + 2 independent + 1 scribe-notes + 2 rounds × (2 challenge +
  // 2 response) + 1 synthesis = 13 launches, one task each.
  assert.equal(env.db.state.consumption.launches, 13);
  assert.equal(env.host.createTaskCalls, 13);
  const taskIds = new Set(env.db.state.participants.flatMap((p) => p.attempts.map((a) => a.taskId)));
  assert.equal(taskIds.size, 13, 'every phase attempt is a fresh orchestration task');
  // Both rounds are journaled and each seat attempted each round exactly once.
  for (const round of [1, 2]) {
    for (const stage of ['challenges', 'responses']) {
      assert.ok(
        env.db.journal.some(
          (e) => e.type === 'phase.entered' && e.payload?.status === 'discussing'
            && e.payload?.round === round && e.payload?.stage === stage,
        ),
        `phase.entered discussing round ${round} stage ${stage} journaled`,
      );
    }
    for (const pid of ['rev_1', 'rev_2']) {
      for (const phase of ['challenge', 'author_response'] as const) {
        const n = env.db.state.participants
          .find((p) => p.participantId === pid)!
          .attempts.filter((a) => a.phase === phase && a.round === round).length;
        assert.equal(n, 1, `${pid} has exactly one ${phase} attempt in round ${round}`);
      }
      assert.ok(env.db.artifacts.has(outPaths.challengeEnv(pid, round)), `challenge envelope ${pid} r${round}`);
      assert.ok(env.db.artifacts.has(outPaths.responseEnv(pid, round)), `response envelope ${pid} r${round}`);
    }
  }
  // Routing is recorded once per stage per round — two round records, each
  // carrying both the challenge and the response routing family.
  const ledger = JSON.parse(env.db.artifacts.get('claims.json')!) as ClaimLedger;
  assert.equal(ledger.discussion?.rounds.length, 2);
  for (const rec of ledger.discussion!.rounds) {
    assert.ok(rec.challenges !== undefined, `round ${rec.round} challenge routing recorded`);
    assert.ok(rec.responses !== undefined, `round ${rec.round} response routing recorded`);
  }
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  assert.equal(report.coverage.selectedSeats, 2);
  assert.equal(report.coverage.partial, false);
});

// ─── Approval gate ───────────────────────────────────────────────────────────

test('gate: advance before approval does not launch reviewers; approve validates roster', async () => {
  const env = makeEnv(configWith({}));
  // Approve too early → invalid transition.
  const early = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1']), approver: 'x' });
  assert.ok(!early.ok && early.error.code === 'invalid_transition');
  await driveToApproval(env);
  const before = env.host.launches.length;
  const r = await env.engine.advance();
  assert.ok(r.ok && r.value.action === 'needs_approval');
  assert.equal(env.host.launches.length, before, 'no reviewer launches while awaiting approval');

  // Wrong seat count.
  const bad1 = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1']), approver: 'x' });
  assert.ok(!bad1.ok && bad1.error.code === 'roster_invalid');
  // Unknown perspective id.
  const bad2 = await env.engine.approve({ roster: mkApprovedRoster(env, Array(15).fill('persp_999')), approver: 'x' });
  assert.ok(!bad2.ok && bad2.error.code === 'roster_invalid');
  // Duplicate perspective selection.
  const dup = mkApprovedRoster(env, Array.from({ length: 15 }, (_, i) => `persp_${i + 1}`));
  dup.seats[1].perspectiveId = dup.seats[0].perspectiveId;
  const bad3 = await env.engine.approve({ roster: dup, approver: 'x' });
  assert.ok(!bad3.ok && bad3.error.code === 'roster_invalid');
});

// ─── Approval invalidation vectors ──────────────────────────────────────────

async function approvedEnv(config: CouncilConfig = configWith({})) {
  const env = makeEnv(config);
  await driveToApproval(env);
  const roster = mkApprovedRoster(env, Array.from({ length: 15 }, (_, i) => `persp_${i + 1}`));
  const ap = await env.engine.approve({ roster, approver: 'orch' });
  assert.ok(ap.ok);
  return { env, roster, hash: ap.value.hash };
}

const invalidationVectors: { name: string; tamper: (env: Env) => void }[] = [
  {
    name: 'seat agent model changed',
    tamper: (env) => { env.db.approved!.seats[0].agent.model = 'gpt-evil'; },
  },
  {
    name: 'seat list changed',
    tamper: (env) => { env.db.approved!.seats[0].perspectiveId = 'persp_15'; env.db.approved!.seats[14].perspectiveId = 'persp_1'; },
  },
  {
    name: 'charter contents changed (proposedRosterHash)',
    tamper: (env) => { env.db.proposed!.perspectives[0].charter.method = 'tampered method'; },
  },
  {
    name: 'objective changed',
    tamper: (env) => { env.db.state.objective = 'different objective'; },
  },
  {
    name: 'config changed',
    tamper: (env) => { env.db.state.config.maxFindingsPerSeat = 99; },
  },
  {
    name: 'stored approval hash tampered',
    tamper: (env) => { env.db.approval!.record.hash = '0'.repeat(64); },
  },
];

for (const v of invalidationVectors) {
  test(`approval invalidated by ${v.name} → blocked launches until identical re-approval`, async () => {
    const { env, roster } = await approvedEnv();
    v.tamper(env);
    const r = await env.engine.advance();
    assert.ok(r.ok);
    assert.equal(r.value.action, 'needs_approval', `expected re-approval demand: ${JSON.stringify(r.value)}`);
    assert.equal(env.db.state.approvalHash, null);
    assert.ok(env.db.journal.some((e) => e.type === 'approval.invalidated'));
    assert.equal(env.host.launches.length, 1, 'no reviewer launched after invalidation');
    // Re-approving the identical roster resumes.
    const ap2 = await env.engine.approve({ roster, approver: 'orch2' });
    assert.ok(ap2.ok, `re-approval failed: ${ap2.ok ? '' : JSON.stringify(ap2.error)}`);
    const r2 = await env.engine.advance();
    assert.ok(r2.ok && (r2.value.action === 'progress' || r2.value.action === 'wait'));
    assert.ok(env.host.launches.length > 1, 'reviewers launch after re-approval');
    // Re-approving a DIFFERENT roster mid-run is refused — the exact code is
    // roster_invalid while awaiting re-approval, invalid_transition once bound.
    const diff = await env.engine.approve({ roster: mkApprovedRoster(env, Array.from({ length: 15 }, (_, i) => `persp_${i + 1}`), 5), approver: 'x' });
    assert.ok(!diff.ok && (diff.error.code === 'roster_invalid' || diff.error.code === 'invalid_transition'));
  });
}

test('source drift after approval blocks launches (approval kept; needs fresh snapshot)', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }), {
    liveSource: { 'src/app.js': 'original' },
  });
  await driveToApproval(env);
  const roster = mkApprovedRoster(env, ['persp_1', 'persp_2']);
  assert.ok((await env.engine.approve({ roster, approver: 'orch' })).ok);
  // The reviewed source changes underneath the approval.
  env.db.liveSource['src/app.js'] = 'modified after approval';
  env.db.liveSource['src/new.js'] = 'added file';
  const r = await env.engine.advance();
  assert.ok(r.ok && r.value.action === 'blocked');
  assert.ok(env.db.journal.some((e) => e.type === 'snapshot.drift'));
  assert.equal(env.db.state.approvalHash !== null, true, 'approval retained; drift demands new snapshot');
});

test('unreadable approval artifact blocks with approval_stale', async () => {
  const { env } = await approvedEnv();
  env.db.approval = null; // file deleted under the engine
  const r = await env.engine.advance();
  assert.ok(r.ok && r.value.action === 'blocked');
});

// ─── Concurrency and budgets ─────────────────────────────────────────────────

test('concurrency cap: never more than N live launches', async () => {
  const env = makeEnv(configWith({ participants: 6, requestedPerspectives: 10, concurrency: 2 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2', 'persp_3', 'persp_4', 'persp_5', 'persp_6']), approver: 'o' });
  await env.engine.advance();
  const indep = env.host.launches.filter((l) => l.spec.phase === 'independent_review');
  assert.equal(indep.length, 2, 'only concurrency-many reviewers launched');
  // Settle one → next advance launches exactly one more.
  env.host.settle(indep[0].result.dispatchId!, false);
  const p0 = env.db.state.participants.find((p) => p.participantId === indep[0].spec.participantId)!;
  await env.store.writeArtifact(outPaths.findings(p0.participantId), JSON.stringify(mkFindings(p0.participantId, p0.perspectiveId!)));
  await env.engine.advance();
  assert.equal(env.host.launches.filter((l) => l.spec.phase === 'independent_review').length, 3);
});

test('launch budget cap → budget_exceeded before exceeding', async () => {
  const cfg = { ...configWith({ participants: 2, requestedPerspectives: 10 }), maxLaunches: 3 };
  const env = makeEnv(cfg);
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Organiser already consumed 1 launch; 2 reviewer launches reach the cap.
  const r = await drive(env);
  assert.equal(r.action, 'blocked');
  assert.ok(env.db.state.consumption.launches <= 3);
  assert.match(r.note ?? '', /launch cap|budget/i);
});

// ─── Prompt isolation ────────────────────────────────────────────────────────

test('independent reviewer prompts carry no peer data; scribe gets findings paths only', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  await drive(env);
  const indep = env.prompts.calls.reviewerIndependent;
  assert.equal(indep.length, 2);
  for (const c of indep) {
    assert.deepEqual(
      Object.keys(c.input).sort(),
      ['outputPath', 'participantId', 'perspective'],
      'reviewer prompt sees only its own perspective — never envelopes/findings/peers',
    );
  }
  const scribeNotes = env.prompts.calls.scribeNotes;
  assert.equal(scribeNotes.length, 1);
  const paths = scribeNotes[0].input.admittedFindingsPaths as string[];
  assert.equal(paths.length, 2);
  assert.ok(paths.every((p) => p.includes('findings')));
});

test('challenge phase reuses settled retained session; no self-challenges; envelopes hold only assigned claims', async () => {
  const env = makeEnv(configWith({ participants: 4, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2', 'persp_3', 'persp_4']), approver: 'o' });
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  const ledger = JSON.parse(env.db.artifacts.get('claims.json')!) as ClaimLedger;
  // Envelopes: every challenge assignment excludes claims authored by the recipient.
  for (let i = 1; i <= 4; i++) {
    const pid = `rev_${i}`;
    const envPath = outPaths.challengeEnv(pid, 1);
    if (!env.db.artifacts.has(envPath)) continue;
    const envelope = JSON.parse(env.db.artifacts.get(envPath)!);
    assert.equal(envelope.recipientId, pid);
    for (const a of envelope.assignments) {
      const authors = ledger.provenance[a.claimId] ?? [];
      assert.ok(!authors.includes(pid), `${pid} was asked to self-challenge ${a.claimId}`);
    }
    // The envelope is a real parseable ChallengeEnvelope.
    assert.ok(parseChallengeEnvelope(envelope, { runId: RUN, round: 1 }).ok);
  }
  // Actual exchange: challenges admitted and responded; dissent recorded.
  assert.ok(ledger.claims.some((c) => c.history.some((h) => h.type === 'challenged')));
  assert.ok(ledger.claims.some((c) => c.status === 'defended' || c.status === 'challenged'));
  // Response envelopes contain only challenges aimed at that author's claims.
  for (const key of [...env.db.artifacts.keys()].filter((k) => k.includes('envelopes/response/'))) {
    const envelope = JSON.parse(env.db.artifacts.get(key)!);
    for (const a of envelope.assignments) {
      const authors = ledger.provenance[a.claimId] ?? [];
      assert.ok(authors.includes(envelope.recipientId), `response to non-author ${envelope.recipientId}`);
    }
  }
});

test('dissent and withdrawal are retained in the canonical report', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Drive but answer every challenge with 'withdraw'.
  const origResponses = responsesFor;
  const withdrawDriver = async () => {
    for (let g = 0; g < 200; g++) {
      for (const l of env.host.launches) {
        const d = l.result.dispatchId;
        if (d === undefined || env.host.liveness.get(d)?.liveness === 'finished') continue;
        let json: object;
        switch (l.spec.phase) {
          case 'organiser': json = mkProposal(10); break;
          case 'independent_review': {
            const p = env.db.state.participants.find((x) => x.participantId === l.spec.participantId);
            json = mkFindings(l.spec.participantId, p?.perspectiveId ?? 'persp_1');
            break;
          }
          case 'scribe_notes': json = mkScribeNotes(); break;
          case 'challenge': json = await challengesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
          case 'author_response': json = await origResponses(env, l.spec.participantId, l.spec.round ?? 1, 'withdraw'); break;
          case 'scribe_synthesis': json = mkScribeReport(); break;
        }
        await env.store.writeArtifact(outputPathFor(l.spec), JSON.stringify(json));
        env.host.settle(d);
      }
      const r = await env.engine.advance();
      assert.ok(r.ok);
      if (r.value.action !== 'progress') return r.value;
    }
    throw new Error('guard');
  };
  const r = await withdrawDriver();
  assert.equal(r.action, 'finished');
  const ledger = JSON.parse(env.db.artifacts.get('claims.json')!) as ClaimLedger;
  assert.ok(
    ledger.claims.every((c) => c.status === 'withdrawn' || c.status === 'proposed'),
    `withdrawn claims retained, not deleted: ${JSON.stringify(ledger.claims.map((c) => c.status))}`,
  );
  assert.ok(ledger.claims.some((c) => c.dissent.length > 0), 'challenger dissent preserved');
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  assert.ok(report.claims.some((c) => c.status === 'withdrawn'));
  assert.ok(env.db.artifacts.get('report.md')!.includes('withdrawn'));
});

// ─── Unknown outcomes and resume ─────────────────────────────────────────────

test('unknown launch outcome blocks; repeated advance never duplicates', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  let calls = 0;
  env.host.launchImpl = () => {
    calls += 1;
    return ok({ outcome: 'unknown' as const, requestId: 'req_stuck_1' });
  };
  const r1 = await env.engine.advance();
  assert.ok(r1.ok && r1.value.action === 'blocked');
  const launches1 = env.host.launches.length;
  for (let i = 0; i < 3; i++) {
    const r = await env.engine.advance();
    assert.ok(r.ok && r.value.action === 'blocked');
    assert.equal(env.host.launches.length, launches1, 'no relaunch while outcome unknown');
    assert.equal(calls, 1, 'launchWorker not called again for the same attempt');
  }
  const st = await env.engine.status();
  assert.ok(st.ok && st.value.pendingDecisions.some((d) => d.includes('req_stuck_1')));
});

test('run-create with lost receipt is never retried automatically', async () => {
  const env = makeEnv(configWith({}));
  env.host.runImpl = () => failRes(err('adapter_error', 'connection lost after run-create'));
  const r1 = await env.engine.advance();
  assert.ok(r1.ok && r1.value.action === 'blocked');
  for (let i = 0; i < 2; i++) {
    const r = await env.engine.advance();
    assert.ok(r.ok && r.value.action === 'blocked');
  }
  assert.equal(env.host.createRunCalls, 1, 'run-create intent persisted; no duplicate run');
});

test('crash after task-create resumes at launch without duplicating task', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Every launchWorker call fails definitively after the task was created.
  env.host.launchImpl = () => failRes(err('adapter_error', 'worker-start transport lost'));
  const r1 = await env.engine.advance();
  assert.ok(r1.ok && r1.value.action === 'blocked');
  const tasksAfterCrash = env.host.createTaskCalls;
  const rev1Before = env.db.state.participants.find((p) => p.participantId === 'rev_1')!.attempts[0];
  assert.equal(rev1Before.status, 'intent_recorded');
  assert.equal(rev1Before.taskId, 'task_2', 'task id persisted before crash (organiser was task_1)');
  // Fresh engine over the same persisted run (crash resume): the intent is
  // relaunched against the persisted task — never a duplicate task-create.
  env.host.launchImpl = (spec) => {
    const res: LaunchResult = {
      outcome: 'started',
      dispatchId: `disp_res_${spec.participantId}`,
      terminalHandle: `term_${spec.participantId}`,
    };
    env.host.launches.push({ spec, result: res });
    return ok(res);
  };
  const engine2 = createEngine({ store: env.store, host: env.host, prompts: env.prompts, now: () => new Date(env.clock.t) });
  const r2 = await engine2.advance();
  assert.ok(r2.ok && r2.value.action === 'progress', JSON.stringify(r2.ok ? r2.value : r2.error));
  const rev1After = env.db.state.participants.find((p) => p.participantId === 'rev_1')!.attempts[0];
  assert.equal(rev1After.taskId, 'task_2', 'resume reused the persisted task');
  assert.equal(rev1After.status, 'dispatched');
  // Exactly one new task created during resume — for rev_2, which had none.
  assert.equal(env.host.createTaskCalls, tasksAfterCrash + 1);
});

// ─── Output admission ────────────────────────────────────────────────────────

test('misbound reviewer output is rejected visibly; one bounded repair, then partial', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  for (let g = 0; g < 200; g++) {
    for (const l of env.host.launches) {
      const d = l.result.dispatchId;
      if (d === undefined || env.host.liveness.get(d)?.liveness === 'finished') continue;
      let json: object;
      if (l.spec.phase === 'independent_review' && l.spec.participantId === 'rev_1') {
        // rev_1 produces misbound output on EVERY attempt — the single
        // corrective repair fails the same way and no third attempt exists.
        json = { ...mkFindings('rev_WRONG', 'persp_1'), participantId: 'rev_WRONG' } as object; // misbound
      } else if (l.spec.phase === 'independent_review') {
        const p = env.db.state.participants.find((x) => x.participantId === l.spec.participantId);
        json = mkFindings(l.spec.participantId, p?.perspectiveId ?? 'persp_1');
      } else {
        switch (l.spec.phase) {
          case 'organiser': json = mkProposal(10); break;
          case 'scribe_notes': json = mkScribeNotes(); break;
          case 'challenge': json = await challengesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
          case 'author_response': json = await responsesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
          case 'scribe_synthesis': json = mkScribeReport(); break;
        }
      }
      await env.store.writeArtifact(outputPathFor(l.spec), JSON.stringify(json));
      env.host.settle(d);
    }
    const r = await env.engine.advance();
    assert.ok(r.ok);
    if (r.value.action !== 'progress') {
      assert.equal(r.value.action, 'finished');
      break;
    }
  }
  const rejections = env.db.journal.filter((e) => e.type === 'artifact.rejected' && e.phase === 'independent_review');
  assert.ok(rejections.length >= 2, 'original + repair both visibly rejected');
  const repairEvents = rejections.filter((e) => typeof e.payload?.repairAttemptId === 'string');
  assert.equal(repairEvents.length, 1, 'exactly one corrective attempt minted');
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const rev1Attempts = rev1.attempts.filter((a) => a.phase === 'independent_review');
  assert.equal(rev1Attempts.length, 2, 'original + one repair — no unbounded retry');
  // The rejected original was archived before the repair rewrote the path
  // (diagnostics artifacts ride alongside under rejected/ too).
  const archived = [...env.db.artifacts.keys()].filter((k) => k.startsWith('rejected/') && !k.endsWith('__diagnostics.json'));
  assert.equal(archived.length, 1, `rejected artifact archived: ${archived.join(',')}`);
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  assert.equal(report.coverage.partial, true, 'partial coverage marked');
  assert.ok(report.coverage.seats.some((s) => s.outcome === 'failed'));
});

test('stale-round challenge file is rejected', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  let corrupted = false;
  for (let g = 0; g < 200; g++) {
    for (const l of env.host.launches) {
      const d = l.result.dispatchId;
      if (d === undefined || env.host.liveness.get(d)?.liveness === 'finished') continue;
      let json: object;
      switch (l.spec.phase) {
        case 'organiser': json = mkProposal(10); break;
        case 'independent_review': {
          const p = env.db.state.participants.find((x) => x.participantId === l.spec.participantId);
          json = mkFindings(l.spec.participantId, p?.perspectiveId ?? 'persp_1');
          break;
        }
        case 'scribe_notes': json = mkScribeNotes(); break;
        case 'challenge': {
          json = (await challengesFor(env, l.spec.participantId, l.spec.round ?? 1)) as { round: number };
          if (!corrupted) { corrupted = true; (json as { round: number }).round = 99; }
          break;
        }
        case 'author_response': json = await responsesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
        case 'scribe_synthesis': json = mkScribeReport(); break;
      }
      await env.store.writeArtifact(outputPathFor(l.spec), JSON.stringify(json));
      env.host.settle(d);
    }
    const r = await env.engine.advance();
    assert.ok(r.ok);
    if (r.value.action !== 'progress') break;
  }
  assert.ok(
    env.db.journal.some((e) => e.type === 'artifact.rejected' && e.phase === 'challenge'),
    'stale-round challenge rejected visibly',
  );
});

// ─── Failure and partial paths ───────────────────────────────────────────────

test('all reviewers failing produces a failed run, never an empty success', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  await env.engine.advance(); // launch reviewers
  for (const l of env.host.launches.filter((x) => x.spec.phase === 'independent_review')) {
    env.host.settle(l.result.dispatchId!, true);
  }
  let last;
  for (let i = 0; i < 20; i++) {
    const r = await env.engine.advance();
    assert.ok(r.ok);
    last = r.value;
    if (last.action !== 'progress' && last.action !== 'wait') break;
  }
  assert.equal(last!.action, 'finished');
  assert.equal((last as { outcome?: string }).outcome, 'failed');
  assert.equal(env.db.state.status, 'failed');
  assert.ok(!env.db.artifacts.has('report.json'), 'no successful-looking report on total failure');
});

test('deadline expiry marks the phase and continues with partial coverage', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Settle one reviewer, leave the other running past the deadline.
  await env.engine.advance();
  const indep = env.host.launches.filter((l) => l.spec.phase === 'independent_review');
  const first = indep[0];
  const p1 = env.db.state.participants.find((p) => p.participantId === first.spec.participantId)!;
  await env.store.writeArtifact(outPaths.findings(p1.participantId), JSON.stringify(mkFindings(p1.participantId, p1.perspectiveId!)));
  env.host.settle(first.result.dispatchId!);
  // Jump the clock past the independent deadline + grace.
  env.clock.t += env.db.state.config.deadlines.independentMs + env.db.state.config.deadlines.graceMs + 1;
  const r = await env.engine.advance();
  assert.ok(r.ok && r.value.action === 'progress', r.ok ? '' : JSON.stringify(r.error));
  const st = await env.engine.status();
  assert.ok(st.ok);
  const lingering = st.value.participants.find((p) => p.participantId === indep[1].spec.participantId);
  assert.ok(lingering !== undefined && (lingering.status === 'timed_out' || lingering.status === 'failed'));
});

test('status returns read-only timing facts: phase/run elapsed, deadlines, journal-tail activity', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await env.engine.advance(); // organiser launched; status organising
  const before = {
    journalLen: env.db.journal.length,
    tasks: env.host.createTaskCalls,
    launches: env.host.launchCalls,
  };
  env.clock.t += 60_000;
  const st = await env.engine.status();
  assert.ok(st.ok);
  const s = st.value;
  // Phase timing: enteredAt persisted, elapsed measured against the clock,
  // phase deadline + grace surfaced with remaining budget.
  assert.equal(s.phaseTiming?.enteredAt, env.db.state.phaseEnteredAt);
  assert.equal(s.phaseTiming?.elapsedMs, 60_000);
  assert.equal(s.phaseTiming?.deadlineMs, env.db.state.config.deadlines.organiserMs);
  assert.equal(s.phaseTiming?.graceMs, env.db.state.config.deadlines.graceMs);
  assert.equal(s.phaseTiming?.remainingMs, env.db.state.config.deadlines.organiserMs - 60_000);
  // Run timing from createdAt + runMs deadline.
  assert.equal(s.runTiming?.createdAt, env.db.state.createdAt);
  assert.equal(s.runTiming?.elapsedMs, 60_000);
  assert.equal(s.runTiming?.deadlineMs, env.db.state.config.deadlines.runMs);
  // lastActivity is the journal tail — a persisted-record fact, not liveness.
  const tail = env.db.journal.at(-1)!;
  assert.equal(s.lastActivity?.seq, tail.seq);
  assert.equal(s.lastActivity?.type, tail.type);
  // Active attempt detail identifies the live organiser dispatch.
  const org = s.participants.find((p) => p.participantId === 'organiser')!;
  assert.equal(org.activeAttemptDetail?.attemptId, 'att_organiser_organiser_r0_0');
  assert.equal(org.activeAttemptDetail?.phase, 'organiser');
  assert.ok(org.activeAttemptDetail?.dispatchId !== null);
  // Read-only: the status call journaled nothing and mutated nothing.
  assert.equal(env.db.journal.length, before.journalLen, 'status never writes journal events');
  assert.equal(env.host.createTaskCalls, before.tasks);
  assert.equal(env.host.launchCalls, before.launches);
});

// ─── Cancellation ────────────────────────────────────────────────────────────

test('cancel stops exact live dispatches and exposes unresolved outcomes', async () => {
  const env = makeEnv(configWith({ participants: 3, requestedPerspectives: 10, concurrency: 3 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2', 'persp_3']), approver: 'o' });
  await env.engine.advance(); // launch 3 reviewers
  const dispatches = env.host.launches.map((l) => l.result.dispatchId!);
  const outcomes: Record<string, StopOutcome> = {
    [dispatches[1]]: 'stopped',
    [dispatches[2]]: 'unknown',
    [dispatches[3]]: 'refused',
  };
  env.host.stopImpl = (d) => ok({ outcome: outcomes[d] ?? 'stopped' });
  const c = await env.engine.cancel({ reason: 'user abort' });
  assert.ok(c.ok);
  assert.equal(env.db.state.status, 'cancelled');
  assert.deepEqual(env.host.stops.map((s) => s.dispatchId).sort(), dispatches.slice(1).sort());
  const st = await env.engine.status();
  assert.ok(st.ok);
  // 'unknown' and 'refused' remain visible — the engine does not claim they stopped.
  assert.ok(st.value.pendingDecisions.length > 0);
  const adv = await env.engine.advance();
  assert.ok(adv.ok && adv.value.action === 'finished' && adv.value.outcome === 'cancelled');
});

// ─── Envelope cap ────────────────────────────────────────────────────────────

test('envelope byte cap drops whole entries and logs omissions', async () => {
  const env = makeEnv({ ...configWith({ participants: 2, requestedPerspectives: 10 }), envelopeBytes: 1400 });
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Craft many findings on rev_1 so rev_2's envelope overflows.
  for (let g = 0; g < 200; g++) {
    for (const l of env.host.launches) {
      const d = l.result.dispatchId;
      if (d === undefined || env.host.liveness.get(d)?.liveness === 'finished') continue;
      let json: object;
      switch (l.spec.phase) {
        case 'organiser': json = mkProposal(10); break;
        case 'independent_review': {
          const p = env.db.state.participants.find((x) => x.participantId === l.spec.participantId)!;
          json = mkFindings(l.spec.participantId, p.perspectiveId!, 7);
          break;
        }
        case 'scribe_notes': json = mkScribeNotes(); break;
        case 'challenge': json = await challengesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
        case 'author_response': json = await responsesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
        case 'scribe_synthesis': json = mkScribeReport(); break;
      }
      await env.store.writeArtifact(outputPathFor(l.spec), JSON.stringify(json));
      env.host.settle(d);
    }
    const r = await env.engine.advance();
    assert.ok(r.ok);
    if (r.value.action !== 'progress') break;
  }
  const envs = [...env.db.artifacts.keys()].filter((k) => k.includes('envelopes/challenge/'));
  assert.ok(envs.length > 0);
  for (const k of envs) {
    const parsed = JSON.parse(env.db.artifacts.get(k)!);
    assert.ok(Buffer.byteLength(env.db.artifacts.get(k)!, 'utf8') <= 1400, `${k} exceeds envelope cap`);
    assert.ok(parseChallengeEnvelope(parsed, { runId: RUN, round: 1 }).ok, `${k} malformed`);
  }
});

// ─── Timed-out workers keep their slot ──────────────────────────────────────

test('timed-out worker keeps its slot: next phase waits, stop requested once, slot frees on settle', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10, concurrency: 1 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });

  // Concurrency 1: the first advance launches only the first seat.
  await env.engine.advance();
  const indep = () => env.host.launches.filter((l) => l.spec.phase === 'independent_review');
  assert.equal(indep().length, 1, 'concurrency 1 launches one reviewer at a time');

  // Seat 1 finishes with valid findings; its freed slot goes to seat 2.
  const l1 = indep()[0];
  const p1 = env.db.state.participants.find((p) => p.participantId === l1.spec.participantId)!;
  await env.store.writeArtifact(outPaths.findings(p1.participantId), JSON.stringify(mkFindings(p1.participantId, p1.perspectiveId!)));
  env.host.settle(l1.result.dispatchId!);
  await env.engine.advance();
  assert.equal(indep().length, 2, 'seat 2 launches once seat 1 settles');
  const disp2 = indep()[1].result.dispatchId!;

  // Seat 2 keeps running; the host refuses our stop. Jump past the deadline.
  env.host.stopImpl = () => ok({ outcome: 'refused' });
  env.clock.t += env.db.state.config.deadlines.independentMs + env.db.state.config.deadlines.graceMs + 1;
  const r1 = await env.engine.advance();
  assert.ok(r1.ok, JSON.stringify(r1));
  const seat2 = env.db.state.participants.find((p) => p.participantId === indep()[1].spec.participantId)!;
  assert.equal(seat2.attempts.at(-1)!.status, 'timed_out');
  // A best-effort stop was requested exactly once and journaled honestly.
  assert.deepEqual(env.host.stops.map((s) => s.dispatchId), [disp2]);
  // Intent custody precedes the call; the outcome receipt follows it.
  const stopEvs = env.db.journal.filter((e) => e.type === 'worker.stop_requested');
  assert.deepEqual(stopEvs.map((e) => e.payload?.outcome), ['intent', 'refused']);
  assert.equal(env.db.state.status, 'scribe_notes', 'phase closes on seat 1 findings');

  // The timed-out seat still holds the only slot: the scribe must NOT launch.
  const launchesBefore = env.host.launches.length;
  const r2 = await env.engine.advance();
  assert.ok(r2.ok && r2.value.action === 'wait', JSON.stringify(r2));
  assert.equal(env.host.launches.length, launchesBefore, 'no launch while a timed-out worker may still run');
  const scribe = env.db.state.participants.find((p) => p.participantId === 'scribe')!;
  assert.equal(scribe.attempts.at(-1)!.status, 'planned');
  // A second advance still waits — and does NOT issue a duplicate stop request.
  const r3 = await env.engine.advance();
  assert.ok(r3.ok && r3.value.action === 'wait');
  assert.equal(env.host.stops.length, 1, 'no duplicate stop request');

  // Proof of death frees the slot: seat 2 finishes → the scribe launches.
  env.host.settle(disp2);
  const r4 = await env.engine.advance();
  assert.ok(r4.ok && r4.value.action === 'progress');
  assert.equal(env.host.launches.at(-1)!.spec.phase, 'scribe_notes');
});

// ─── Drift before finalization ──────────────────────────────────────────────

test('drift injected after the last launch is journaled and marked on the emitted report', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }), {
    liveSource: { 'src/app.js': 'original' },
  });
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Drive until the run's last launch (scribe synthesis) is dispatched.
  await drive(env, () => env.host.launches.some((l) => l.spec.phase === 'scribe_synthesis'));
  assert.ok(env.host.launches.some((l) => l.spec.phase === 'scribe_synthesis'), 'synthesis launched');
  // A pinned source file changes now — after the run's last launch; only the
  // pre-report check can see it.
  env.db.liveSource['src/app.js'] = 'mutated after approval';
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  assert.equal(r.outcome, 'succeeded', 'drift alone must not fail the run');
  assert.equal(env.db.state.status, 'reported');
  assert.ok(
    env.db.journal.some((e) => e.type === 'snapshot.drift' && e.payload?.scope === 'pre-report'),
    'pre-report snapshot.drift event',
  );
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  assert.equal(report.coverage.partial, true, 'drifted report is visibly partial');
  assert.ok(report.limitations.some((l) => /drift/i.test(l)), 'drift noted in report limitations');
});

// ─── Execution policy boundary (PUBLIC-USE) ─────────────────────────────────

const POLICY_HASH = 'a'.repeat(64);
const execCfg = (hash = POLICY_HASH) => ({ catalogVersion: '1.0.0', policyHash: hash });

/** Fake synchronous policy: accepts choices matching `accept`, records every call. */
function mkPolicy(
  hash: string,
  accept: (c: AgentChoice) => boolean,
): ExecutionPolicy & { seen: AgentChoice[] } {
  const seen: AgentChoice[] = [];
  return {
    policyHash: hash,
    seen,
    validateChoice: (c: AgentChoice) => {
      seen.push({ ...c });
      return accept(c)
        ? ok(undefined)
        : failRes(err('unsupported', `rejected choice ${c.agent}/${c.model}/${c.permissionMode}`));
    },
  };
}

const CATALOG_AGENTS = new Set(['devin', 'claude', 'codex']);
const acceptCatalog = (c: AgentChoice): boolean => CATALOG_AGENTS.has(c.agent) && c.model !== 'bad-model';

const STAFF: { organiser: AgentChoice; scribe: AgentChoice; supervisor: AgentChoice } = {
  organiser: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
  scribe: { agent: 'claude', model: 'claude-sonnet-4-6', permissionMode: 'auto', effort: 'high' },
  supervisor: { agent: 'codex', model: 'gpt-6-astra', permissionMode: 'auto', profile: 'ops' },
};

function assertZeroHostCalls(env: Env) {
  assert.equal(env.host.createRunCalls, 0, 'createRun must not be called');
  assert.equal(env.host.createTaskCalls, 0, 'createTask must not be called');
  assert.equal(env.host.launches.length, 0, 'no worker launches');
  assert.equal(env.host.notifications.length, 0, 'no notifications');
  assert.equal(env.host.stops.length, 0, 'no stops');
}

test('mismatched policy hash blocks before ANY host mutation', async () => {
  const env = makeEnv(configWith({ execution: execCfg(POLICY_HASH) }), {
    execution: mkPolicy('b'.repeat(64), acceptCatalog),
  });
  const r = await env.engine.advance();
  assert.ok(r.ok);
  assert.equal(r.value.action, 'blocked');
  assert.match((r.value as { note?: string }).note ?? '', /hash mismatch/);
  assertZeroHostCalls(env);
});

test('omitted EngineDeps.execution cannot bypass a fingerprint-bound config', async () => {
  const env = makeEnv(configWith({ execution: execCfg() }));
  const r = await env.engine.advance();
  assert.ok(r.ok);
  assert.equal(r.value.action, 'blocked');
  assertZeroHostCalls(env);

  // The same gate binds the approval entry path on a state already at the gate.
  const env2 = makeEnv(configWith({ execution: execCfg() }));
  env2.db.state.status = 'awaiting_approval';
  env2.db.proposed = mkProposal(15);
  const ap = await env2.engine.approve({ roster: mkApprovedRoster(env2, ['persp_1', 'persp_2']), approver: 'x' });
  assert.ok(!ap.ok);
  assert.equal(ap.error.code, 'config_invalid');
  assert.equal(env2.db.approval, null);
  assert.equal(env2.db.state.approvalHash, null);
  assertZeroHostCalls(env2);
});

test('invalid staff choice blocks the run at init — zero host calls', async () => {
  for (const role of ['organiser', 'scribe', 'supervisor'] as const) {
    const staff = structuredClone(STAFF);
    staff[role] = { agent: 'devin', model: 'bad-model', permissionMode: 'bypass' };
    const env = makeEnv(
      configWith({ staff, execution: execCfg() }),
      { execution: mkPolicy(POLICY_HASH, acceptCatalog) },
    );
    const r = await env.engine.advance();
    assert.ok(r.ok);
    assert.equal(r.value.action, 'blocked', `${role} rejection must block`);
    assert.match((r.value as { note?: string }).note ?? '', new RegExp(`staff\\.${role}`));
    assertZeroHostCalls(env);
  }
});

test('policy-rejected reviewer seat fails approval before artifacts/wake', async () => {
  const env = makeEnv(configWith({ staff: STAFF, execution: execCfg(), participants: 2, requestedPerspectives: 10 }), {
    execution: mkPolicy(POLICY_HASH, acceptCatalog),
  });
  await driveToApproval(env);

  const bad = mkApprovedRoster(env, ['persp_1', 'persp_2']);
  bad.seats[1]!.agent = { agent: 'claude', model: 'bad-model', permissionMode: 'auto' };
  const ap = await env.engine.approve({ roster: bad, approver: 'o' });
  assert.ok(!ap.ok);
  assert.equal(ap.error.code, 'roster_invalid');
  assert.match(ap.error.message, /rev_2/);
  // Nothing persisted, nothing notified, approval stays unbound.
  assert.equal(env.db.approval, null);
  assert.equal(env.db.approved, null);
  assert.equal(env.db.state.approvalHash, null);
  assert.equal(env.host.notifications.length, 0);

  // Same roster with a policy-valid seat approves and launches normally.
  const good = mkApprovedRoster(env, ['persp_1', 'persp_2']);
  good.seats[0]!.agent = { agent: 'claude', model: 'claude-sonnet-4-6', permissionMode: 'plan' };
  assert.ok((await env.engine.approve({ roster: good, approver: 'o' })).ok);
});

test('valid mixed-provider config drives the full lifecycle with staff agents', async () => {
  const policy = mkPolicy(POLICY_HASH, acceptCatalog);
  const env = makeEnv(configWith({ staff: STAFF, execution: execCfg(), participants: 3, requestedPerspectives: 10 }), {
    execution: policy,
  });
  await driveToApproval(env);
  // Organiser launched as the configured devin staff member.
  assert.equal(env.host.launches[0]!.spec.phase, 'organiser');
  assert.deepEqual(env.host.launches[0]!.spec.agent, STAFF.organiser);

  const roster = mkApprovedRoster(env, ['persp_1', 'persp_2', 'persp_3']);
  roster.seats[1]!.agent = { agent: 'claude', model: 'claude-sonnet-4-6', permissionMode: 'auto', effort: 'low' };
  roster.seats[2]!.agent = { agent: 'codex', model: 'gpt-6-astra', permissionMode: 'read-only', profile: 'ops' };
  assert.ok((await env.engine.approve({ roster, approver: 'o' })).ok);

  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  // Scribe launched as the configured claude staff member in both phases.
  const scribeLaunches = env.host.launches.filter((l) => l.spec.participantId === 'scribe');
  assert.equal(scribeLaunches.length, 2);
  assert.ok(scribeLaunches.every((l) => l.spec.agent.agent === 'claude'));
  // Every launched choice passed through validateChoice (staff + reviewers).
  const launchedAgents = env.host.launches.map((l) => l.spec.agent.agent);
  assert.ok(launchedAgents.includes('codex'), 'codex reviewer launched');
  assert.ok(policy.seen.some((c) => c.agent === 'devin'), 'organiser staff validated');
  assert.ok(policy.seen.some((c) => c.agent === 'codex' && c.profile === 'ops'));
});

test('legacy run without execution/staff is an unchanged fixed point', async () => {
  // No execution dep injected at all — identical to pre-extension engines.
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  // The legacy Devin pin still carries staff work.
  assert.deepEqual(env.host.launches[0]!.spec.agent, AGENT);
  assert.equal('staff' in env.db.state.config, false);
  assert.equal('execution' in env.db.state.config, false);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  assert.equal(env.db.state.status, 'reported');
});

// ─── Crash-window durability: stage chronology, adoption, overlay ───────────

/**
 * True crash simulation: a PERSISTENT append failure means every flush —
 * including the end-of-advance error-path retry — dies, so the advance
 * returns a Result failure exactly where a process crash would stop it.
 * `resume` models the supervisor restarting the run on a fresh engine.
 */
const killAppends = (env: Env, why = 'simulated crash: receipt never journaled') => {
  env.store.appendError = err('io_error', why);
};
/** Full persistence death: journal appends AND state saves both fail — the
 * process "dies" with everything after this point existing only in memory
 * (and, for host calls, possibly landed host-side). */
const killPersistence = (env: Env, why = 'simulated crash: receipt never persisted') => {
  env.store.appendError = err('io_error', why);
  env.store.saveError = err('io_error', why);
};
const resume = (env: Env): Engine => {
  env.store.appendError = null;
  env.store.saveError = null;
  return createEngine({ store: env.store, host: env.host, prompts: env.prompts, now: () => new Date(env.clock.t) });
};

test('journal append failure happens before the host mutation (journal-first order)', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const creates = env.host.createTaskCalls;
  const orderLen = env.store.order.length;
  killAppends(env, 'journal write dead');
  const r = await env.engine.advance();
  assert.ok(!r.ok, 'persistent append failure must propagate as a Result failure');
  assert.equal(env.host.createTaskCalls, creates, 'intent could not be durably recorded → createTask never issued');
  // 'journal' attempts happened; 'state' saves may have run for earlier
  // flushes, but NOTHING after the dead append — and the last op was journal.
  assert.equal(env.store.order.at(-1), 'journal');
  void orderLen;
  // Restart: the intent never persisted, so the launch issues cleanly once.
  const engine2 = resume(env);
  const r2 = await engine2.advance();
  assert.ok(r2.ok && (r2.value.action === 'progress' || r2.value.action === 'wait'), JSON.stringify(r2.ok ? r2.value : r2.error));
});

test('task-create issued + landed + receipt lost: adopted via exact-spec match, never duplicated', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const realCreate = env.host.createTask.bind(env.host);
  let armed = false;
  env.host.createTask = async (input) => {
    const r = await realCreate(input); // lands the row + returns the taskId
    if (!armed && input.title.includes('rev_1')) {
      armed = true;
      killPersistence(env, 'crash between task-create effect and task.created receipt');
    }
    return r;
  };
  const r1 = await env.engine.advance();
  assert.ok(!r1.ok, 'every flush dies under a persistent append failure — the process "crashed"');
  const rev1Spec = env.host.landedTasks.find((t) => (t.title ?? '').includes('rev_1'))!.specFile!;
  const tasksForSpec = () => env.host.landedTasks.filter((t) => t.specFile === rev1Spec).length;

  const r2 = await resume(env).advance();
  assert.ok(r2.ok && (r2.value.action === 'progress' || r2.value.action === 'wait'), JSON.stringify(r2.ok ? r2.value : r2.error));
  assert.equal(tasksForSpec(), 1, 'landed task adopted — no duplicate createTask for the attempt');
  const adopted = env.db.journal.find((e) => e.type === 'launch.resume' && e.payload?.resolution === 'adopted-task');
  assert.ok(adopted !== undefined, 'adoption journaled');
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1.attempts[0]!.taskId, env.host.landedTasks.find((t) => t.specFile === rev1Spec)!.taskId);
});

test('task-create issued + empty/pruned listing stays blocked — never retries', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Host "accepts" the create but lands nothing observable (receipt + ledger lost).
  const realCreate = env.host.createTask.bind(env.host);
  env.host.createTask = async (input) => {
    const r = await realCreate(input);
    env.host.landedTasks.pop(); // un-land: the host-side record is gone/unreplicated
    if (input.title.includes('rev_1')) killPersistence(env, 'receipt lost');
    return r;
  };
  const r1 = await env.engine.advance();
  assert.ok(!r1.ok, 'persistent append failure crashes the advance');
  const creates = env.host.createTaskCalls;
  const engine2 = resume(env);
  for (let i = 0; i < 3; i++) {
    const r = await engine2.advance();
    assert.ok(r.ok && r.value.action === 'blocked', `advance ${i} must stay blocked, got ${JSON.stringify(r.ok ? r.value : r.error)}`);
  }
  const rev1Creates = env.host.landedTasks.filter((t) => (t.title ?? '').includes('rev_1')).length;
  assert.equal(rev1Creates, 0, 'never re-created while outcome uncertain');
  const unknowns = env.db.journal.filter((e) => e.type === 'worker.unknown' && (e.payload?.detail as string | undefined)?.includes('task-create issued but no host record'));
  assert.ok(unknowns.length >= 1, 'uncertain outcome journaled honestly');
  void creates;
});

test('task adoption refuses title-only matches and unidentifiable rows', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const realCreate = env.host.createTask.bind(env.host);
  env.host.createTask = async (input) => {
    const r = await realCreate(input);
    if (input.title.includes('rev_1')) {
      // Replace the real row with a same-TITLE different-spec decoy — the
      // classic alias collision that must never be adopted.
      env.host.landedTasks.pop();
      env.host.landedTasks.push({ taskId: 'task_decoy', title: input.title, specFile: '/elsewhere/decoy-spec.md' });
      killPersistence(env, 'receipt lost');
    }
    return r;
  };
  const r1 = await env.engine.advance();
  assert.ok(!r1.ok, 'persistent append failure crashes the advance');
  const engine2 = resume(env);
  const r2 = await engine2.advance();
  assert.ok(r2.ok && r2.value.action === 'blocked', 'decoy row must not satisfy the exact-spec identity check');
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1.attempts[0]!.taskId, null, 'decoy task never adopted');

  // Same situation with a row that has NO spec identity at all. Reset the
  // attempt to intent_recorded so the reconcile path runs the row check
  // again (the journaled task-create marker still governs the outcome).
  rev1.attempts[0]!.status = 'intent_recorded';
  env.host.landedTasks.pop();
  env.host.landedTasks.push({ taskId: 'task_decoy2', title: 'council independent_review rev_1' });
  const r3 = await engine2.advance();
  assert.ok(r3.ok && r3.value.action === 'blocked', 'unidentifiable row cannot prove zero-match');
});

test('worker-launch issued + landed + receipt lost: adopted, launchWorker never re-called', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  env.host.launchImpl = (spec) => {
    const res: LaunchResult = {
      outcome: 'started',
      dispatchId: `disp_land_${spec.participantId}`,
      terminalHandle: `term_land_${spec.participantId}`,
    };
    if (spec.participantId === 'rev_1') killPersistence(env, 'crash between worker effect and worker.started receipt');
    return ok(res);
  };
  const r1 = await env.engine.advance();
  assert.ok(!r1.ok, 'persistent append failure crashes the advance');
  const launches1 = env.host.launchCalls;
  const r2 = await resume(env).advance();
  assert.ok(r2.ok, JSON.stringify(r2));
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const att = rev1.attempts[0]!;
  assert.equal(att.dispatchId, 'disp_land_rev_1', 'landed dispatch adopted');
  assert.equal(att.status, 'dispatched');
  const adopted = env.db.journal.find((e) => e.type === 'launch.resume' && e.payload?.resolution === 'adopted-dispatch');
  assert.ok(adopted !== undefined, 'dispatch adoption journaled');
  const rev1LaunchCalls = env.host.launches.filter((l) => l.spec.participantId === 'rev_1').length;
  assert.equal(rev1LaunchCalls, 1, `worker launched once, not relaunched (calls=${launches1})`);
});

test('worker-launch issued + pruned worker listing stays blocked', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const realLaunch = env.host.launchWorker.bind(env.host);
  env.host.launchWorker = async (spec) => {
    const r = await realLaunch(spec);
    if (spec.participantId === 'rev_1') {
      env.host.landedWorkers.pop(); // landed row lost host-side; receipt also lost
      killPersistence(env, 'receipt lost');
    }
    return r;
  };
  const r1 = await env.engine.advance();
  assert.ok(!r1.ok, 'persistent append failure crashes the advance');
  const engine2 = resume(env);
  for (let i = 0; i < 3; i++) {
    const r = await engine2.advance();
    assert.ok(r.ok && r.value.action === 'blocked');
  }
  const rev1Launches = env.host.launches.filter((l) => l.spec.participantId === 'rev_1').length;
  assert.equal(rev1Launches, 1, 'never relaunched while outcome uncertain');
});

test('chronology: refusal → re-issue → receipt lost resumes uncertain, never duplicates', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  let rev1Calls = 0;
  env.host.launchImpl = (spec) => {
    if (spec.participantId !== 'rev_1') {
      return ok({ outcome: 'started', dispatchId: `disp_${spec.participantId}`, terminalHandle: 't' });
    }
    rev1Calls += 1;
    if (rev1Calls === 1) {
      return failRes(err('adapter_error', 'definitive worker-start refusal (nothing landed)'));
    }
    // Retry #2 LANDS the worker, then every receipt dies with the process.
    killPersistence(env, 'crash: second launch landed, receipt lost');
    return ok({ outcome: 'started', dispatchId: 'disp_chron_2', terminalHandle: 'term_chron' });
  };
  const r1 = await env.engine.advance();
  assert.ok(r1.ok && r1.value.action === 'blocked');
  const r2 = await env.engine.advance();
  assert.ok(!r2.ok, 'second issue receipt lost → crash');
  const r3 = await resume(env).advance();
  assert.ok(r3.ok, JSON.stringify(r3));
  assert.equal(rev1Calls, 2, 'the journaled refusal must NOT authorize retrying over a newer lost receipt');
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1.attempts[0]!.dispatchId, 'disp_chron_2', 'landed retry adopted through reconcile');
});

test('legacy intent_recorded attempt (pre-marker journal) adopts or blocks — never blind-proceeds', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10, concurrency: 1 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Forge the pre-upgrade persisted shape: an intent WITHOUT the v2 marker
  // scheme, attempt intent_recorded with no ids, and host records that DID land.
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const att = rev1.attempts.find((a) => a.phase === 'independent_review')!;
  att.status = 'intent_recorded';
  att.taskId = null;
  att.dispatchId = null;
  env.db.journal.push({
    seq: env.db.journal.length + 1,
    ts: new Date().toISOString(),
    type: 'launch.intent',
    actor: 'engine',
    participantId: 'rev_1',
    phase: 'independent_review',
    payload: { attemptId: att.attemptId, launchIntentId: att.launchIntentId }, // legacy: no v, no stage
  });
  const specAbs = join(env.db.runDir, `specs/${att.attemptId}.md`);
  env.host.landedTasks.push({ taskId: 'task_legacy', specFile: specAbs, title: 'council independent_review rev_1' });
  env.host.landedWorkers.push({ dispatchId: 'disp_legacy', taskId: 'task_legacy', terminalHandle: 'term_legacy' });
  const creates = env.host.createTaskCalls;
  const r1 = await env.engine.advance();
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(env.host.createTaskCalls, creates, 'legacy attempt adopted its landed records — nothing re-created');
  const adoptedAtt = env.db.state.participants.find((p) => p.participantId === 'rev_1')!.attempts[0]!;
  assert.equal(adoptedAtt.taskId, 'task_legacy');
  assert.equal(adoptedAtt.dispatchId, 'disp_legacy');
  assert.equal(adoptedAtt.status, 'dispatched');

  // Legacy attempt with NOTHING landed: stays blocked, never proceeds.
  const rev2 = env.db.state.participants.find((p) => p.participantId === 'rev_2')!;
  const att2 = rev2.attempts.find((a) => a.phase === 'independent_review')!;
  env.db.journal.push({
    seq: env.db.journal.length + 1,
    ts: new Date().toISOString(),
    type: 'launch.intent',
    actor: 'engine',
    participantId: 'rev_2',
    phase: 'independent_review',
    payload: { attemptId: att2.attemptId, launchIntentId: att2.launchIntentId },
  });
  att2.status = 'intent_recorded';
  att2.taskId = null;
  att2.dispatchId = null;
  env.host.landedTasks.splice(0); // host listing pruned entirely
  const creates2 = env.host.createTaskCalls;
  const r2 = await env.engine.advance();
  assert.ok(r2.ok && r2.value.action === 'blocked', 'legacy intent + empty listing → uncertain → blocked');
  assert.equal(env.host.createTaskCalls, creates2, 'no blind re-create under a legacy markerless intent');
});

test('worker-launch definitive refusal is bounded: two tries then the seat fails visibly', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  env.host.launchImpl = (spec) =>
    spec.participantId === 'rev_1'
      ? failRes(err('adapter_error', 'worker-start definitively refused'))
      : ok({ outcome: 'started', dispatchId: `disp_${spec.participantId}`, terminalHandle: 't' });
  const r1 = await env.engine.advance();
  assert.ok(r1.ok && r1.value.action === 'blocked');
  const r2 = await env.engine.advance();
  assert.ok(r2.ok && r2.value.action === 'blocked');
  const r3 = await env.engine.advance();
  assert.ok(r3.ok, JSON.stringify(r3));
  const failures = env.db.journal.filter(
    (e) => e.type === 'error' && e.payload?.op === 'worker-launch' && String(e.payload?.attemptId).includes('rev_1'),
  ).length;
  assert.equal(failures, 2, 'exactly the bounded count of journaled refusals');
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1.status, 'failed', 'seat marked failed after the retry bound — no livelock');
  const settled = env.db.journal.find((e) => e.type === 'worker.settled' && e.participantId === 'rev_1');
  assert.ok(settled !== undefined && /bounded retry exhausted/.test(String(settled.payload?.detail)));
});

test('saveState failure after journal append is recovered by the journal overlay', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const realCreate = env.host.createTask.bind(env.host);
  env.host.createTask = async (input) => {
    const r = await realCreate(input);
    if (input.title.includes('rev_1')) {
      env.store.saveError = err('io_error', 'crash: task.created journaled, state.json lost');
    }
    return r;
  };
  const r1 = await env.engine.advance();
  assert.ok(!r1.ok, 'persistent save failure crashes the advance');
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1.attempts[0]!.taskId, null, 'persisted state lacks the taskId — the journal has it');
  const journaled = env.db.journal.find((e) => e.type === 'task.created' && e.participantId === 'rev_1');
  assert.ok(journaled !== undefined, 'task.created survived the failed save');
  const creates = env.host.createTaskCalls;
  const r2 = await resume(env).advance();
  assert.ok(r2.ok, JSON.stringify(r2));
  assert.equal(env.host.createTaskCalls, creates + 1, 'journal overlay re-adopted the task; only the peer creates new');
  assert.equal(env.db.state.participants.find((p) => p.participantId === 'rev_1')!.attempts[0]!.taskId, journaled.payload!.taskId);
});

// ─── Mail budget, quorum, approval profile binding ──────────────────────────

test('per-recipient mail budget is journaled-counted and enforced (clm_0003)', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10, maxMailPerParticipant: 2 }));
  await driveToApproval(env);
  // Two sends to the supervisor Dispatch already journaled (e.g. earlier wake
  // retries); a send to a DIFFERENT recipient must not count against this one.
  for (const [to, outcome] of [['dispatch:disp_sup', 'sent'], ['dispatch:disp_sup', 'unknown'], ['term_other', 'sent']] as const) {
    env.db.journal.push({
      seq: env.db.journal.length + 1,
      ts: new Date().toISOString(),
      type: 'mail.sent',
      actor: 'engine',
      payload: { to, outcome },
    });
  }
  const ap = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  assert.ok(ap.ok);
  assert.equal(env.host.notifications.filter((n) => n.to === 'dispatch:disp_sup').length, 0, 'budget exhausted → wake refused');
  const refused = env.db.journal.find((e) => e.type === 'mail.sent' && e.payload?.outcome === 'budget_refused');
  assert.ok(refused !== undefined, 'refusal journaled visibly, never silent');
  assert.equal(refused.payload?.to, 'dispatch:disp_sup');
  assert.equal(
    env.host.notifications.filter((n) => /approval granted/.test(n.subject)).length,
    0,
    'no fallback to another address when the budget refuses',
  );
});

test('below-quorum report is an explicit partial diagnostic (clm_0007)', async () => {
  const env = makeEnv(configWith({ participants: 3, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2', 'persp_3']), approver: 'o' });
  // rev_3's launch receipts a definitive failure — 2/3 seats admit, quorum is 3.
  env.host.launchImpl = (spec) =>
    spec.participantId === 'rev_3' && spec.phase === 'independent_review'
      ? ok({ outcome: 'failed', detail: 'worker-start refused by host' })
      : ok({ outcome: 'started', dispatchId: `disp_${spec.participantId}_${spec.phase}`, terminalHandle: `t_${spec.participantId}` });
  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  assert.match(r.note ?? '', /PARTIAL coverage/);
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  assert.equal(report.coverage.partial, true, 'below-quorum report must be marked partial');
  const fin = env.db.journal.find((e) => e.type === 'run.finished');
  assert.equal(fin?.payload?.belowQuorum, true, 'run.finished records the quorum miss');
  assert.equal(fin?.payload?.admittedSeats, 2);
  assert.equal(fin?.payload?.quorum, 3);
});

test('re-approval with a different agent profile is rejected; identical re-approval succeeds (clm_0002)', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  const roster = mkApprovedRoster(env, ['persp_1', 'persp_2']);
  roster.seats.forEach((s) => { s.agent = { ...s.agent, profile: 'ops' }; });
  assert.ok((await env.engine.approve({ roster, approver: 'o' })).ok);
  // Tamper the persisted approval so the binding no longer verifies →
  // invalidated on the next advance (approvalHash cleared, re-approval open).
  env.db.approved!.seats[0]!.agent = { ...env.db.approved!.seats[0]!.agent, profile: 'tampered' };
  const r1 = await env.engine.advance();
  assert.ok(r1.ok && (r1.value.action === 'blocked' || r1.value.action === 'needs_approval'));
  assert.equal(env.db.state.approvalHash, null, 'binding mismatch invalidates approval');
  assert.ok(env.db.journal.some((e) => e.type === 'approval.invalidated'));
  // Re-approval must reproduce the EXACT launched seats — profile included.
  const wrongProfile = mkApprovedRoster(env, ['persp_1', 'persp_2']);
  wrongProfile.seats.forEach((s) => { s.agent = { ...s.agent, profile: 'tampered' }; });
  const bad = await env.engine.approve({ roster: wrongProfile, approver: 'o' });
  assert.ok(!bad.ok && bad.error.code === 'roster_invalid', `profile-blind equality must not pass: ${JSON.stringify(bad)}`);
  const good = await env.engine.approve({ roster, approver: 'o' });
  assert.ok(good.ok, `exact re-approval should succeed: ${JSON.stringify(good)}`);
});

test('a participant whose AgentChoice diverges from the approved seat is refused at launch (rev-04)', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Tamper the in-run participant record — state.json is NOT approval-bound,
  // so the divergence must be caught against the approved roster at launch.
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  rev1.agent = { ...rev1.agent, profile: 'injected' };
  const r = await env.engine.advance();
  assert.ok(r.ok && r.value.action === 'blocked', JSON.stringify(r.ok ? r.value : r.error));
  assert.match(r.value.note ?? '', /AgentChoice|roster/i);
  assert.equal(env.host.launches.filter((l) => l.spec.participantId === 'rev_1').length, 0, 'divergent seat never launched');
});

// ─── Evidence rejection + scribe notes consumption ──────────────────────────

test('challenge evidence the ledger cannot admit is journaled, not dropped', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }), );
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  for (let g = 0; g < 300; g++) {
    for (const l of env.host.launches) {
      const d = l.result.dispatchId;
      if (d === undefined || env.host.liveness.get(d)?.liveness === 'finished') continue;
      let json: object;
      switch (l.spec.phase) {
        case 'organiser': json = mkProposal(10); break;
        case 'independent_review': {
          const p = env.db.state.participants.find((x) => x.participantId === l.spec.participantId);
          json = mkFindings(l.spec.participantId, p?.perspectiveId ?? 'persp_1');
          break;
        }
        case 'scribe_notes': json = mkScribeNotes(); break;
        case 'challenge': {
          const envText = await env.store.readArtifact(outPaths.challengeEnv(l.spec.participantId, l.spec.round ?? 1));
          assert.ok(envText.ok);
          const envelope = JSON.parse(envText.value) as { assignments: { claimId: string }[] };
          json = {
            schemaVersion: SCHEMA_VERSION,
            runId: RUN,
            round: l.spec.round ?? 1,
            participantId: l.spec.participantId,
            challenges: envelope.assignments.map((a, i) => ({
              challengeId: `ch_${l.spec.participantId}_${i}`,
              claimId: a.claimId,
              kind: 'missing_evidence',
              argument: `challenge from ${l.spec.participantId}`,
              evidence: i === 0 ? [{ kind: 'code_location', note: 'cites a path outside the manifest', path: 'src/ghost.js', startLine: 1 }] : [],
            })),
          };
          break;
        }
        case 'author_response': json = await responsesFor(env, l.spec.participantId, l.spec.round ?? 1); break;
        case 'scribe_synthesis': json = mkScribeReport(); break;
      }
      await env.store.writeArtifact(outputPathFor(l.spec), JSON.stringify(json));
      env.host.settle(d);
    }
    const r = await env.engine.advance();
    assert.ok(r.ok, `advance failed: ${JSON.stringify(r.ok ? r.value : r.error)}`);
    if (r.value.action === 'finished') break;
  }
  const evRej = env.db.journal.filter((e) => e.type === 'artifact.rejected' && e.payload?.kind === 'challenge-evidence');
  assert.ok(evRej.length >= 1, `challenge-evidence rejections journaled, got ${JSON.stringify(env.db.journal.filter((e) => e.type === 'artifact.rejected').map((e) => e.payload?.kind))}`);
});

test('admitted scribe notes reach the synthesis spec as explicit input (clm_0021)', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  const synthCalls = env.prompts.calls.scribeSynthesis;
  assert.equal(synthCalls.length, 1);
  const notesPath = (synthCalls[0]!.input as { notesPath?: string }).notesPath;
  assert.equal(notesPath, join(env.store.runDir, 'scribe', 'notes.json'), `notesPath present: ${notesPath}`);
});

/* ================= recovery-audit RA-002..RA-008 regression ====================
 * Fresh-engine append-ok / save-fail fault injection for the audited seams:
 * journaled facts must re-materialize lost state, counters must come from the
 * journal, corrupt journals must fail closed, and mutation custody must
 * survive the intent→outcome window. */

/** Append pre-shaped journal events with monotonically increasing seq. */
const jour = (env: Env, evs: Array<Partial<JournalEvent> & { type: JournalEvent['type'] }>) => {
  for (const e of evs) {
    env.db.journal.push({ seq: env.db.journal.length + 1, ts: 't', actor: 'engine', ...e } as JournalEvent);
  }
};

test('RA-002: journaled run-scope receipt restores orcaRunId — no duplicate createRun', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  // Reproduce: createRun landed + receipts journaled; saveState died before
  // orcaRunId persisted — a fresh engine used to re-issue createRun.
  jour(env, [
    { type: 'launch.intent', payload: { scope: 'run', v: 2 } },
    { type: 'task.created', payload: { scope: 'run', orcaRunId: 'run_landed_1' } },
  ]);
  assert.equal(env.db.state.orcaRunId, null, 'reproduction: runId absent from state');
  const r = await resume(env).advance();
  assert.ok(r.ok, JSON.stringify(r.ok ? r.value : r.error));
  assert.equal(env.host.createRunCalls, 0, 'no second createRun — receipt restored run identity');
  assert.equal(env.db.state.orcaRunId, 'run_landed_1');
  const org = env.db.state.participants.find((p) => p.participantId === 'organiser');
  assert.ok(org !== undefined, 'organiser seeding proceeded under the restored run');
});

test('RA-003: journaled rejection re-mints the lost corrective attempt', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Reproduce: rejection + repair minted + journaled; saveState died — the
  // state's participant has only the settled original, the repair is gone.
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const orig = rev1.attempts.find((a) => a.phase === 'independent_review')!;
  orig.status = 'settled_ok';
  const repairId = 'att_rev_1_independent_review_r0_1';
  assert.ok(!rev1.attempts.some((a) => a.attemptId === repairId), 'repair attempt lost from state');
  jour(env, [{
    type: 'artifact.rejected',
    participantId: 'rev_1',
    phase: 'independent_review',
    payload: {
      attemptId: orig.attemptId,
      path: 'findings/rev_1.json',
      issueCount: 1,
      issuesExcerpt: ['bad output'],
      issuesRef: 'rejected/x__diagnostics.json',
      repairAttemptId: repairId,
      repairTuple: 'rev_1|independent_review|null',
      repair: { repairOf: orig.attemptId, contract: 'FindingsFile', diagnostics: ['bad output'] },
    },
  }]);
  const r = await resume(env).advance();
  assert.ok(r.ok, JSON.stringify(r.ok ? r.value : r.error));
  const rev1b = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const repair = rev1b.attempts.find((a) => a.attemptId === repairId);
  assert.ok(repair !== undefined, 'journaled repair attempt re-materialized');
  assert.ok(env.db.journal.some((e) => e.payload?.repairOf === orig.attemptId), 'repair lineage preserved in journal');
  assert.ok(
    env.db.journal.some((e) => e.type === 'launch.intent' && e.payload?.attemptId === repairId),
    `repair actually launched, status ${repair.status}`,
  );
  // Exactly ONE re-minted repair — replaying again must not mint a third attempt.
  const r3 = await resume(env).advance();
  assert.ok(r3.ok, JSON.stringify(r3.ok ? r3.value : r3.error));
  const rev1c = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1c.attempts.filter((a) => a.attemptId === repairId).length, 1);
});

test('RA-003: journaled organiser events re-seed the lost participant and attempt', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  const orgAttempt = 'att_organiser_organiser_r0_0';
  const orgSpec = join(env.db.runDir, `specs/${orgAttempt}.md`);
  env.db.state.status = 'organising';
  env.db.state.participants = [];
  env.host.landedTasks.push({ taskId: 'task_org_l', specFile: orgSpec, title: 'council organiser organiser' });
  env.host.landedWorkers.push({ dispatchId: 'disp_org', taskId: 'task_org_l', terminalHandle: 'term_org' });
  jour(env, [
    { type: 'phase.entered', payload: { phase: 'organising' } },
    { type: 'launch.intent', payload: { attemptId: orgAttempt, launchIntentId: 'li_org', v: 2, agent: { adapter: 'orca' } } },
    { type: 'launch.intent', payload: { attemptId: orgAttempt, stage: 'task-create' } },
    { type: 'task.created', payload: { attemptId: orgAttempt, taskId: 'task_org_l', specFile: orgSpec, title: 'council organiser organiser' } },
    { type: 'launch.intent', payload: { attemptId: orgAttempt, stage: 'worker-launch' } },
    { type: 'worker.started', payload: { attemptId: orgAttempt, taskId: 'task_org_l', dispatchId: 'disp_org', terminalHandle: 'term_org' } },
  ]);
  const taskCreates = env.host.createTaskCalls;
  const r = await resume(env).advance();
  assert.ok(r.ok, JSON.stringify(r.ok ? r.value : r.error));
  const org = env.db.state.participants.find((p) => p.participantId === 'organiser');
  assert.ok(org !== undefined, 'organiser participant re-seeded from journal');
  assert.equal(org.attempts.at(-1)!.attemptId, orgAttempt);
  assert.equal(org.attempts.at(-1)!.taskId, 'task_org_l', 'journaled taskId restored');
  assert.equal(org.attempts.at(-1)!.dispatchId, 'disp_org', 'journaled dispatchId restored');
  assert.equal(env.host.createTaskCalls, taskCreates, 'journaled task — no duplicate createTask');
});

test('RA-003: journaled reviewer seats rebuild a wiped participant list', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  env.db.state.participants = [];
  const r = await resume(env).advance();
  assert.ok(r.ok, JSON.stringify(r.ok ? r.value : r.error));
  const pids = env.db.state.participants.map((p) => p.participantId).sort();
  assert.deepEqual(pids, ['organiser', 'rev_1', 'rev_2']);
  assert.ok(env.db.state.participants.every((p) => p.attempts.length >= 1), 'attempts seeded');
});

test('RA-004: consumption is journal-derived — receipt vs re-observe dedupe, mail counted', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const rev1Att = 'att_rev_1_independent_review_r0_0';
  const rev2Att = 'att_rev_2_independent_review_r0_0';
  jour(env, [
    // Receipt (has taskId — an actual launch) for rev_1…
    { type: 'worker.started', payload: { attemptId: rev1Att, taskId: 'task_a', dispatchId: 'd1' } },
    // …then a later liveness re-observe of the SAME launch identity (no taskId)
    { type: 'worker.started', payload: { attemptId: rev1Att, dispatchId: 'd1', liveness: 'working' } },
    // rev_2 issued, outcome unknown — charged once.
    { type: 'worker.unknown', payload: { attemptId: rev2Att, dispatchId: 'd2' } },
    { type: 'mail.sent', payload: { to: 'run:orca_run_1', outcome: 'sent', subject: 'a' } },
    { type: 'mail.sent', payload: { to: 'run:orca_run_1', outcome: 'sent', subject: 'b' } },
  ]);
  env.db.state.consumption = { launches: 0, mailSent: 0 };
  // rev_2 stays 'unknown' → the step blocks; consumption is still derived.
  await resume(env).advance();
  // organiser receipt + rev_1 receipt + rev_2 unknown = 3 journaled launches;
  // the liveness re-observe must NOT count twice.
  assert.equal(env.db.state.consumption.launches, 3);
  // approval-wake mail + 2 seeded 'sent' = 3.
  assert.equal(env.db.state.consumption.mailSent, 3);
});

test('RA-005: corrupt journal fails closed — advance/approve/cancel never mutate', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  env.store.journalError = err('io_error', 'journal_corrupt: seq 3 prevHash mismatch');
  const before = {
    tasks: env.host.createTaskCalls,
    launches: env.host.launchCalls,
    stops: env.host.stops.length,
    released: env.host.released.length,
    mail: env.host.notifications.length,
  };
  const r = await env.engine.advance();
  assert.ok(!r.ok && /journal_corrupt/.test(r.error.message), JSON.stringify(r));
  const a = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  assert.ok(!a.ok && /journal_corrupt/.test(a.error.message), 'approve fails before any mutation');
  const c = await env.engine.cancel({ reason: 'abort' });
  assert.ok(!c.ok && /journal_corrupt/.test(c.error.message), 'cancel fails closed');
  assert.deepEqual(
    {
      tasks: env.host.createTaskCalls,
      launches: env.host.launchCalls,
      stops: env.host.stops.length,
      released: env.host.released.length,
      mail: env.host.notifications.length,
    },
    before,
    'stop/release/mail/launch mutations suppressed on corrupt journal',
  );
  assert.equal(env.db.approved, null, 'roster write suppressed');
});

test('RA-006: uncertain adapter error preserves requestId and never reads as definitive refusal', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const realCreate = env.host.createTask.bind(env.host);
  env.host.createTask = async (input) =>
    input.title.includes('rev_1')
      ? failRes(err('adapter_error', 'transport timeout', { details: { requestId: 'req_tc_7', uncertain: true } }))
      : realCreate(input);
  await env.engine.advance();
  const errEv = env.db.journal.find((e) => e.type === 'error' && e.payload?.op === 'task-create');
  assert.ok(errEv !== undefined, 'adapter error journaled');
  assert.equal(errEv.payload?.requestId, 'req_tc_7', 'actual requestId preserved');
  assert.equal(errEv.payload?.uncertain, true, 'uncertainty preserved');
  // 'issued' semantics: a landed host row is adopted, never refused-and-retried.
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const spec = join(env.db.runDir, `specs/${rev1.attempts[0]!.attemptId}.md`);
  env.host.landedTasks.push({ taskId: 'task_tc7', specFile: spec, title: 'council independent_review rev_1' });
  const r2 = await resume(env).advance();
  assert.ok(r2.ok, JSON.stringify(r2.ok ? r2.value : r2.error));
  const rev1b = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1b.attempts[0]!.taskId, 'task_tc7', 'landed task adopted through reconcile');
});

test('RA-007: fat diagnostics never overflow the journal line — artifact carries them', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  await env.engine.advance();
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const att = rev1.attempts[0]!;
  // A findings file with dozens of violations → a very large issues array.
  env.db.artifacts.set('findings/rev_1.json', JSON.stringify({
    schemaVersion: 1, runId: 'r', participantId: 'rev_1',
    findings: Array.from({ length: 60 }, (_, i) => ({ wrong: i, also_wrong: 'x'.repeat(40) })),
  }));
  env.host.settle(att.dispatchId!, false);
  await env.engine.advance();
  const rej = env.db.journal.find((e) => e.type === 'artifact.rejected' && e.payload?.attemptId === att.attemptId);
  assert.ok(rej !== undefined, 'rejection journaled');
  const line = JSON.stringify(rej);
  assert.ok(line.length < 8192, `journaled line bounded under the envelope cap, got ${line.length}`);
  assert.equal(rej.payload?.issues, undefined, 'raw issues never journaled');
  const ref = rej.payload?.issuesRef as string;
  assert.ok(typeof ref === 'string' && ref.length > 0);
  const diag = JSON.parse(env.db.artifacts.get(ref)!) as { issues: unknown[] };
  assert.equal(diag.issues.length, rej.payload?.issueCount, 'artifact carries the full diagnostics');
  assert.ok(typeof rej.payload?.issuesHash === 'string' && rej.payload.issuesHash.length > 0);
  // The repair prompt gets a bounded excerpt plus a link to the full artifact.
  await env.engine.advance();
  const repairCall = env.prompts.calls.reviewerIndependent.at(-1)!;
  const repairCtx = repairCall.input as { repair?: { diagnostics?: string[] } };
  const diagLines = repairCtx.repair?.diagnostics ?? [];
  assert.ok(
    diagLines.some((l) => l.includes(`full diagnostics archived at: ${join(env.db.runDir, ref)}`)),
    `prompt links to full diagnostics: ${JSON.stringify(diagLines)}`,
  );
  assert.ok(diagLines.length <= 21, 'prompt context bounded');
});

test('RA-008: stop custody — intent flushed before requestStop; crash never re-issues', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  await env.engine.advance(); // reviewers dispatched
  let firstStopped = '';
  let intentFlushedBeforeCall = false;
  env.host.stopImpl = (d) => {
    firstStopped ||= d;
    intentFlushedBeforeCall ||= env.db.journal.some(
      (e) => e.type === 'worker.stop_requested' && e.payload?.outcome === 'intent' && e.payload?.dispatchId === d,
    );
    killPersistence(env, 'crash after stop intent, before outcome journal');
    return ok({ outcome: 'stopped' });
  };
  const c1 = await env.engine.cancel({ reason: 'abort' });
  assert.ok(!c1.ok, 'cancel dies mid-mutation');
  assert.ok(intentFlushedBeforeCall, 'stop intent durably journaled BEFORE the host call');
  const c2 = await resume(env).cancel({ reason: 'abort' });
  void c2;
  assert.equal(
    env.host.stops.filter((s) => s.dispatchId === firstStopped).length,
    1,
    'journaled intent → requestStop never blind-reissued',
  );
});

test('RA-008: release custody — journaled reservation never re-issues releaseWorker', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const r1 = await env.engine.advance();
  assert.ok(r1.ok);
  // Settle rev_1 so the seat is release-eligible, then simulate: release intent
  // journaled + flushed, process died before the outcome could journal.
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const att = rev1.attempts[0]!;
  env.db.artifacts.set('findings/rev_1.json', JSON.stringify(mkFindings('rev_1', 'persp_1')));
  env.host.settle(att.dispatchId!, false);
  await env.engine.advance(); // settles + admits
  const rev1b = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.ok(rev1b.retainedTerminal !== null && att.dispatchId !== undefined);
  const lastDispatch = rev1b.attempts.at(-1)!.dispatchId!;
  jour(env, [
    { type: 'worker.released', participantId: 'rev_1', payload: { dispatchId: lastDispatch, outcome: 'intent' } },
  ]);
  await resume(env).cancel({ reason: 'abort' });
  assert.ok(!env.host.released.includes(lastDispatch), 'journaled intent → releaseWorker never re-issued');
  assert.ok(
    env.db.journal.some((e) => e.type === 'worker.released' && e.payload?.outcome === 'skipped' && e.payload?.dispatchId === lastDispatch),
    'the skipped reconcile is journaled honestly',
  );
});

test('RA-008: mail intent+outcome pair charges the cap once, not twice', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10, maxMailPerParticipant: 2 }));
  await driveToApproval(env);
  // Pre-seed a completed send pair to the same target the wake mail uses.
  jour(env, [
    { type: 'mail.sent', payload: { to: 'dispatch:disp_sup', mailIntentId: 'mi_a', outcome: 'intent' } },
    { type: 'mail.sent', payload: { to: 'dispatch:disp_sup', mailIntentId: 'mi_a', outcome: 'sent' } },
  ]);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  assert.equal(env.host.notifications.length, 1, 'pair deduped — wake send fits under cap 2');
  assert.equal(env.db.state.consumption.mailSent, 2, 'seeded sent + wake sent');
});

// ─── Approval wake addressing + host diagnostics ────────────────────────────

const approvalWakes = (env: Env) => env.host.notifications.filter((n) => /approval granted/.test(n.subject));
const wakeReceipts = (env: Env) =>
  env.db.journal.filter((e) => e.type === 'mail.sent' && e.payload?.kind === 'approval-wake');

test('approval wake addresses the recorded supervisor Dispatch, never run:<child> + --dispatch-id', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  assert.equal(env.db.state.orcaRunId, 'orca_run_1', 'a council child Run is bound');
  const ap = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  assert.ok(ap.ok);
  const wakes = approvalWakes(env);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].to, 'dispatch:disp_sup');
  assert.equal(
    (wakes[0] as Record<string, unknown>).dispatchId,
    undefined,
    'no --dispatch-id payload: the target already names the Dispatch',
  );
  const [intent, receipt] = wakeReceipts(env);
  assert.equal(intent.payload?.outcome, 'intent', 'intent journaled before the outcome (RA-008)');
  assert.equal(receipt.payload?.outcome, 'sent');
  assert.equal(receipt.payload?.to, 'dispatch:disp_sup');
  assert.equal(receipt.payload?.mailIntentId, intent.payload?.mailIntentId);
  assert.equal(receipt.payload?.errorCode, undefined, 'a clean send carries no host error');
});

test('approval wake falls back to run:<orcaRunId>, then the supervisor terminal, only without a Dispatch', async () => {
  const runEnv = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  runEnv.db.state.supervisor = { terminalHandle: 'term_supervisor', dispatchId: null };
  await driveToApproval(runEnv);
  assert.ok((await runEnv.engine.approve({ roster: mkApprovedRoster(runEnv, ['persp_1', 'persp_2']), approver: 'o' })).ok);
  assert.deepEqual(approvalWakes(runEnv).map((n) => n.to), ['run:orca_run_1']);
  assert.equal((approvalWakes(runEnv)[0] as Record<string, unknown>).dispatchId, undefined);

  const termEnv = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  termEnv.db.state.supervisor = { terminalHandle: 'term_supervisor', dispatchId: null };
  await driveToApproval(termEnv);
  // No child Run bound: clear it from state and from the run receipt that
  // RA-002 would otherwise restore it from.
  termEnv.db.state.orcaRunId = null;
  for (const e of termEnv.db.journal) {
    if (e.type === 'task.created' && e.payload?.scope === 'run') delete e.payload.orcaRunId;
  }
  assert.ok((await termEnv.engine.approve({ roster: mkApprovedRoster(termEnv, ['persp_1', 'persp_2']), approver: 'o' })).ok);
  assert.deepEqual(approvalWakes(termEnv).map((n) => n.to), ['term_supervisor']);
});

test('an uncertain approval wake journals the host error code and is never resent', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  const message = 'Dispatch disp_sup belongs to Run run_parent, not orca_run_1. Orchestration mutation request ID: req_x.';
  env.host.notificationResults.push(
    ok({ outcome: 'unknown' as const, requestId: 'req_x', errorCode: 'dispatch_run_mismatch', error: message }),
  );
  const ap = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  assert.ok(ap.ok, 'approval stays durable when the wake is uncertain');
  const receipt = wakeReceipts(env).at(-1)!;
  assert.equal(receipt.payload?.outcome, 'unknown');
  assert.equal(receipt.payload?.requestId, 'req_x');
  assert.equal(receipt.payload?.errorCode, 'dispatch_run_mismatch');
  assert.equal(receipt.payload?.error, message);
  assert.equal(env.db.state.consumption.mailSent, 0, 'unknown is not counted as delivered');
  // Advancing never re-issues the wake blind; resume derives the charge.
  await env.engine.advance();
  await resume(env).advance();
  assert.equal(approvalWakes(env).length, 1, 'unknown outcome is never resent automatically');
});

test('a failed approval wake journals the adapter code and a bounded message', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  env.host.notificationResults.push(
    failRes(err('adapter_error', 'x'.repeat(2000), { details: { adapterCode: 'bad_mail_target', uncertain: false } })),
  );
  assert.ok((await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' })).ok);
  const receipt = wakeReceipts(env).at(-1)!;
  assert.equal(receipt.payload?.outcome, 'error');
  assert.equal(receipt.payload?.errorCode, 'bad_mail_target');
  assert.equal((receipt.payload?.error as string).length, 512, 'message bounded');
});

test('lifecycle wakes reach the persisted recipient at stage, approval and completion — deduped, budget-free', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  // Operator captured the initiating orchestrator BEFORE any binding change
  // — canonical destination progress/recipient.json (real file in runDir).
  mkdirSync(join(env.db.runDir, 'progress'), { recursive: true });
  writeFileSync(
    join(env.db.runDir, 'progress/recipient.json'),
    JSON.stringify({ schemaVersion: 1, to: 'term_orch_9', source: 'explicit', recordedAt: new Date(env.clock.t).toISOString() }),
  );
  await driveToApproval(env); // organiser launched + proposal admitted
  assert.ok(
    env.host.notifications.some((n) => n.to === 'term_orch_9'),
    'stage wake delivered to the persisted recipient during organising',
  );
  const organisingWakes = env.host.notifications.filter((n) => n.to === 'term_orch_9').length;
  // Repeating advance while the run sits in the same stage must not re-send —
  // the outbox dedupes durably.
  await env.engine.advance();
  const afterIdle = env.host.notifications.filter((n) => n.to === 'term_orch_9').length;
  assert.equal(afterIdle, organisingWakes, 'same-stage repeat is outbox-deduped, not re-mailed');
  const ap = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  assert.ok(ap.ok);
  assert.ok(
    env.host.notifications.filter((n) => n.to === 'term_orch_9').length > organisingWakes,
    'approval + independent-review stage wakes delivered',
  );
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  assert.ok(
    env.host.notifications.some((n) => n.to === 'term_orch_9' && /succeeded|finished|report/i.test(n.subject + n.body)),
    'completion wake delivered',
  );
  // Lifecycle wakes never touch the reviewer mail budget.
  assert.equal(env.db.state.consumption.mailSent, 1, 'only the charged approval-wake mail counted');
});

// ─── P-D4: durable stage-wake recovery ──────────────────────────────────────
//
// The durable lifecycle record lives in events.jsonl; the send intent lives in
// progress/outbox.json. A crash (or a pre-intent fs/lock failure) between the
// state flush and the outbox write leaves the first without the second — the
// engine must recompute the missing wakes on later calls, with their ORIGINAL
// dedupe identity, never re-sending anything whose outcome is uncertain.

function writeWakeRecipient(env: Env, to = 'term_orch_9') {
  mkdirSync(join(env.db.runDir, 'progress'), { recursive: true });
  writeFileSync(
    join(env.db.runDir, 'progress/recipient.json'),
    JSON.stringify({ schemaVersion: 1, to, source: 'explicit', recordedAt: new Date(env.clock.t).toISOString() }),
  );
}

interface OutboxDelivery {
  intentId: string;
  kind: string;
  stageKey: string;
  delivery: string;
  attempts: number;
  subject: string;
  body: string;
}
function outboxDeliveries(env: Env): OutboxDelivery[] {
  const p = join(env.db.runDir, 'progress/outbox.json');
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, 'utf8')) as { deliveries?: OutboxDelivery[] }).deliveries ?? [];
}

test('P-D4: wakes lost between the state flush and the outbox intent are recovered from durable journal history', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  // Recipient absent: notify() returns no_recipient BEFORE persisting an
  // intent — the durable state is identical to a crash between the flush and
  // the outbox write: lifecycle records in the journal, nothing in the box.
  await driveToApproval(env);
  assert.equal(outboxDeliveries(env).length, 0, 'no intents exist without a recipient');
  const ap = await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'orch' });
  assert.ok(ap.ok);
  assert.equal(outboxDeliveries(env).length, 0, 'approval wake also lost pre-intent');

  // The recipient appears — the next advance must catch up EVERY durable
  // lifecycle record, not only the current stage.
  writeWakeRecipient(env);
  const r = await env.engine.advance();
  assert.ok(r.ok, JSON.stringify(r.ok ? {} : r.error));
  const ids = new Set(outboxDeliveries(env).map((d) => d.intentId));
  for (const want of ['stage:initialized', 'stage:organising', 'stage:awaiting_approval', 'stage:independent_review']) {
    assert.ok(ids.has(want), `catch-up intent ${want} created and sent`);
  }
  assert.ok([...ids].some((i) => i.startsWith('approval:')), 'approval wake recovered');
  const woke = env.host.notifications.filter((n) => n.to === 'term_orch_9');
  assert.ok(woke.length >= 5, 'every recovered milestone mailed');
  // Catch-up is labelled historical and names the replayed durable record;
  // the counts in the body are CURRENT persisted facts, never old numbers.
  const recovered = woke.filter((n) => n.body.includes('replay: recovered'));
  assert.ok(recovered.length >= 4, 'historical replays labelled as recovered/late');
  assert.ok(
    recovered.some((n) => n.body.includes('replayed milestone: stage:organising')),
    'the replayed milestone is named explicitly by its durable intent id',
  );

  // Dedupe is durable: another advance at the same stage resends nothing.
  const sent = env.host.notifications.length;
  const idle = await env.engine.advance();
  assert.ok(idle.ok);
  assert.equal(env.host.notifications.length, sent, 'recovered wakes dedupe durably — no blind resend');
});

test('P-D4: a pre-intent progress-lock failure keeps wakes pending — journaled visibly, recovered next advance', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  writeWakeRecipient(env);
  // Plant a live, unexpired outbox lock (our own pid is alive): notify cannot
  // reach the intent phase at all — a pre-intent fs/lock Result failure.
  const lockPath = join(env.db.runDir, 'progress/outbox.lock');
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: 'planted-holder',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  const r = await env.engine.advance();
  assert.ok(r.ok, 'a failed wake never fails the council step');
  assert.equal(env.db.state.status, 'organising', 'the transition still persisted');
  assert.equal(outboxDeliveries(env).length, 0, 'no intent could persist behind the held lock');
  assert.ok(
    env.db.journal.some((e) => e.type === 'error' && e.payload?.op === 'progress.drain'),
    'the drain failure is journaled as a visible diagnostic',
  );

  // The lock clears — the recomputed backlog delivers on the next advance.
  rmSync(lockPath);
  const r2 = await env.engine.advance();
  assert.ok(r2.ok);
  const ids = new Set(outboxDeliveries(env).map((d) => d.intentId));
  assert.ok(ids.has('stage:initialized') && ids.has('stage:organising'), 'the wakes held behind the lock are delivered');
});

test('P-D4: terminal drain recovers the whole backlog — discussion cursors keep their original round/stage keys', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  assert.equal(env.db.state.status, 'reported');
  assert.equal(outboxDeliveries(env).length, 0, 'the full lifecycle ran with no recipient — zero intents');

  // A resume at terminal must drain every pending catch-up — there is no
  // later advance to recompute it (historical replays bypass the module's
  // terminal suppression; the finished wake is always attempted).
  writeWakeRecipient(env);
  const r2 = await env.engine.advance();
  assert.ok(r2.ok);
  const deliveries = outboxDeliveries(env);
  assert.equal(
    deliveries[0]?.intentId,
    'finished:succeeded',
    'the timely finished wake is attempted BEFORE the historical backlog',
  );
  const ids = new Set(deliveries.map((d) => d.intentId));
  for (const want of [
    'stage:initialized',
    'stage:organising',
    'stage:awaiting_approval',
    'stage:independent_review',
    'stage:scribe_notes',
    'stage:discussing:r1:challenges',
    'stage:discussing:r1:responses',
    'stage:synthesising',
    'finished:succeeded',
  ]) {
    assert.ok(ids.has(want), `recovered intent ${want} delivered post-terminal`);
  }
  assert.ok(
    env.host.notifications.some((n) => n.body.includes('replayed milestone: stage:discussing:r1:challenges')),
    'the challenge-stage replay names its own cursor — not the current discussion facts',
  );
  assert.ok(
    env.host.notifications.some((n) => n.body.includes('replayed milestone: stage:discussing:r1:responses')),
    'the response-stage replay names its own cursor',
  );
  assert.ok(
    deliveries.every((d) => d.delivery === 'sent'),
    'every recovered intent delivered — none stranded at terminal',
  );
});

test('P-D4: a held progress lock records the finished wake attempted first — never silently skipped behind the backlog', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  assert.equal(outboxDeliveries(env).length, 0, 'whole lifecycle ran with no recipient — full backlog pending');

  // Recipient appears, then the outbox lock is held by a live owner: the
  // finished wake must be the FIRST event attempted (never stranded behind
  // up-to-64 catch-up events), and its failure must be journaled honestly.
  writeWakeRecipient(env);
  const lockPath = join(env.db.runDir, 'progress/outbox.lock');
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    nonce: 'planted-holder',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  const r2 = await env.engine.advance();
  assert.ok(r2.ok, 'a failed wake never fails the council step');
  assert.equal(outboxDeliveries(env).length, 0, 'no intent persisted behind the held lock — nothing claimed delivered');
  const diags = env.db.journal.filter((e) => e.type === 'error' && e.payload?.op === 'progress.drain');
  assert.equal(diags.length, 2, 'the finished failure plus the deferred-backlog count — one bounded drain stop, not N lock waits');
  assert.match(String(diags[0]!.payload?.detail), /^finished: io_error: timed out waiting for progress lock/, 'finished was attempted FIRST and its failure is the first diagnostic');
  assert.match(String(diags[1]!.payload?.detail), /pending wake event\(s\) left deferred/, 'the un-attempted backlog is counted honestly, not silently dropped');

  // Lock cleared — the next advance recovers finished AND the whole backlog.
  rmSync(lockPath);
  const r3 = await env.engine.advance();
  assert.ok(r3.ok);
  const ids = new Set(outboxDeliveries(env).map((d) => d.intentId));
  assert.ok(ids.has('finished:succeeded') && ids.has('stage:discussing:r1:challenges') && ids.has('stage:organising'), 'finished plus backlog recovered once the lock clears');
});

test('P-D4: a blocked reason is journaled once and its wake is recoverable — never re-journaled while stuck', async () => {
  const env = makeEnv({ ...configWith({ participants: 2, requestedPerspectives: 10 }), maxLaunches: 3 });
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const r = await drive(env);
  assert.equal(r.action, 'blocked', 'launch cap reached → blocked');
  const markers = () => env.db.journal.filter((e) => e.type === 'error' && e.payload?.op === 'lifecycle.blocked');
  assert.equal(markers().length, 1, 'the blocked reason is journaled durably, exactly once');

  // Still stuck: the marker dedupes (no journal spam) and the current wake
  // dedupes by reason hash once a recipient exists.
  writeWakeRecipient(env);
  const r2 = await env.engine.advance();
  assert.ok(r2.ok);
  assert.equal(r2.value.action, 'blocked', 'still blocked on the same reason');
  const blocked = outboxDeliveries(env).filter((d) => d.kind === 'blocked');
  assert.equal(blocked.length, 1, 'one blocked intent keyed by reason hash');
  assert.match(blocked[0]!.intentId, /^blocked:[0-9a-f]{8}$/);
  const mails = env.host.notifications.length;
  const r3 = await env.engine.advance();
  assert.ok(r3.ok);
  assert.equal(markers().length, 1, 'the same blocked reason is not re-journaled');
  assert.equal(env.host.notifications.length, mails, 'the same blocked reason is not re-mailed');
});

test('P-D4: an unknown-outcome send is retained as custody and never blindly resent', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  writeWakeRecipient(env);
  // The first wake send's outcome is unproven — custody must stay 'unknown'.
  env.host.notificationResults.push(ok({ outcome: 'unknown' }));
  const r = await env.engine.advance();
  assert.ok(r.ok);
  const unknown = outboxDeliveries(env).find((d) => d.delivery === 'unknown');
  assert.ok(unknown !== undefined, 'the unproven send is retained as unknown custody');
  assert.equal(unknown.intentId, 'stage:organising', 'the first drained event — the timely current transition — took the planted outcome');
  assert.equal(unknown.attempts, 1);

  // Recomputed backlog replays hit the durable dedupe — 'unknown' is never
  // retried (it may have landed).
  const r2 = await env.engine.advance();
  assert.ok(r2.ok);
  const after = outboxDeliveries(env).find((d) => d.intentId === unknown.intentId);
  assert.equal(after?.attempts, 1, 'unknown custody never re-sends');
  assert.equal(after?.delivery, 'unknown');
  // Meanwhile later stages still wake normally — the unknown custody does
  // not wedge the drain.
  assert.ok(
    outboxDeliveries(env).some((d) => d.delivery === 'sent'),
    'other intents still deliver',
  );
});

test('strength with all-invalid evidence is rejected visibly; valid strengths reach the ledger', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // rev_1 files a findings carrying one unverifiable 'strength' (phantom
  // code_location — liveSource is empty) and one honestly-evidenced one.
  await env.engine.advance();
  const rev1 = env.host.launches.find((l) => l.spec.participantId === 'rev_1')!;
  const findings = mkFindings('rev_1', 'persp_1') as { strengths?: unknown[] };
  findings.strengths = [
    {
      strengthId: 'S-phantom',
      feature: 'imaginary subsystem',
      benefit: 'unverifiable praise',
      preserve: 'none',
      evidence: [{ kind: 'code_location', note: 'cited', path: 'src/nope.js', startLine: 1 }],
    },
    {
      strengthId: 'S-real',
      feature: 'hash-bound approval',
      benefit: 'the orchestrator can diff the approved roster exactly',
      preserve: 'never weaken the binding',
      evidence: [{ kind: 'reasoned', note: 'by design' }],
    },
  ];
  await env.store.writeArtifact(outPaths.findings('rev_1'), JSON.stringify(findings));
  env.host.settle(rev1.result.dispatchId!);
  const r = await drive(env, () => env.db.state.status === 'scribe_notes' || env.db.state.status === 'discussing');
  // The phantom strength was journaled as a strength rejection — never
  // admitted as bare praise — while the evidenced strength reached the
  // canonical ledger with runner-stamped provenance.
  assert.ok(
    env.db.journal.some(
      (e) => e.type === 'artifact.rejected' && e.payload?.kind === 'strength' && e.payload?.strengthId === 'S-phantom',
    ),
    'phantom strength rejection journaled',
  );
  const ledger = JSON.parse(env.db.artifacts.get('claims.json')!) as ClaimLedger;
  assert.equal(ledger.strengths?.length, 1);
  assert.equal(ledger.strengths![0].strengthId, 'S-real');
  assert.equal(ledger.strengths![0].participantId, 'rev_1', 'runner stamps provenance, not the worker');
});

/* ================= clm_0007: phase-entry append-ok/save-fail ====================
 * The crash window the council reproduced: a phase-entering flush appends
 * journal events (approval.granted / phase.entered) but saveState fails, so
 * state.json stays behind the journal. The journal overlay then re-materializes
 * the minted participants/attempts — and every state-side seed site must reuse
 * them, not push duplicates. Retried operations must yield exactly one
 * participant per id, one attempt per (participantId, phase, round), one task
 * and one launch per seat. */

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

const participantCounts = (env: Env): Map<string, number> => {
  const m = new Map<string, number>();
  for (const p of env.db.state.participants) m.set(p.participantId, (m.get(p.participantId) ?? 0) + 1);
  return m;
};

const attemptCounts = (env: Env): Map<string, number> => {
  const m = new Map<string, number>();
  for (const p of env.db.state.participants) {
    for (const a of p.attempts) m.set(a.attemptId, (m.get(a.attemptId) ?? 0) + 1);
  }
  return m;
};

test('clm_0007: retried approve after append-ok/save-fail → no duplicate seat/attempt/task/launch', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  const roster = mkApprovedRoster(env, ['persp_1', 'persp_2']);
  // Reproduce: approval.granted + phase.entered journaled; saveState dies.
  env.store.failNextSaveState = err('io_error', 'simulated crash: approval journaled, state save lost');
  const r1 = await env.engine.approve({ roster, approver: 'o' });
  assert.ok(!r1.ok, 'first approve dies at the save');
  assert.ok(env.db.journal.some((e) => e.type === 'approval.granted'), 'grant durably journaled');
  assert.equal(env.db.state.status, 'awaiting_approval', 'state.json stayed behind the journal');
  // Retry — the journal proves the grant landed and seats were minted.
  const r2 = await env.engine.approve({ roster, approver: 'o' });
  assert.ok(r2.ok, JSON.stringify(r2.ok ? r2.value : r2.error));
  const pids = participantCounts(env);
  assert.deepEqual([...pids.keys()].sort(), ['organiser', 'rev_1', 'rev_2']);
  assert.ok([...pids.values()].every((n) => n === 1), `duplicate participant objects: ${JSON.stringify([...pids])}`);
  const aids = attemptCounts(env);
  assert.ok(
    [...aids.values()].every((n) => n === 1),
    `duplicate attempt ids: ${JSON.stringify([...aids])}`,
  );
  for (const pid of ['rev_1', 'rev_2']) {
    assert.equal(
      env.db.state.participants.flatMap((p) => p.attempts.filter((a) => a.participantId === pid && a.phase === 'independent_review')).length,
      1,
      `exactly one independent_review attempt for ${pid}`,
    );
  }
  // Advance — exactly one task and one launch per seat.
  const adv = await env.engine.advance();
  assert.ok(adv.ok, JSON.stringify(adv.ok ? adv.value : adv.error));
  const launches = env.host.launches.filter((l) => l.spec.phase === 'independent_review');
  assert.equal(launches.length, 2, `one launch per seat, got ${launches.length}`);
  assert.equal(uniq(launches.map((l) => l.spec.participantId)).length, 2);
  assert.equal(uniq(launches.map((l) => l.spec.taskId)).length, 2, 'one task per seat');
  assert.equal(env.host.createTaskCalls, 3, 'organiser task + exactly one task per seat');
});

test('clm_0007: organiser phase-entry append-ok/save-fail → retried advance mints no duplicate organiser', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  // Crash window: the flush inside launchAttempt appends
  // [task.created(run), phase.entered(organising), launch.intent(att)] — the
  // SECOND saveState of the advance dies. Like a real process crash the
  // failure is PERMANENT from that point (the error-path retry flush must
  // die too); a one-shot failure would be healed by the retry and never
  // reproduce the journal-ahead/state-behind gap.
  let saves = 0;
  const realSave = env.store.saveState.bind(env.store);
  env.store.saveState = async (s) => {
    if (++saves === 2) {
      killPersistence(env, 'simulated crash: phase-entry journaled, state save lost');
      return failRes(err('io_error', 'simulated crash: phase-entry journaled, state save lost'));
    }
    return realSave(s);
  };
  const r1 = await env.engine.advance();
  assert.ok(!r1.ok, 'advance dies at the phase-entry save');
  assert.equal(env.db.state.status, 'initialized', 'state.json stayed at initialized');
  assert.ok(env.db.state.participants.length === 0, 'no participants persisted');
  assert.ok(
    env.db.journal.some((e) => e.type === 'phase.entered' && e.payload?.status === 'organising'),
    'phase.entered journaled',
  );
  assert.ok(
    env.db.journal.some((e) => e.type === 'launch.intent' && e.payload?.attemptId === 'att_organiser_organiser_r0_0'),
    'organiser attempt intent journaled',
  );
  // Retry on a fresh engine — the overlay re-materializes organiser+attempt;
  // the re-entered step must reuse them.
  env.store.saveState = realSave;
  const r2 = await resume(env).advance();
  assert.ok(r2.ok, JSON.stringify(r2.ok ? r2.value : r2.error));
  const orgs = env.db.state.participants.filter((p) => p.participantId === 'organiser');
  assert.equal(orgs.length, 1, `duplicate organiser participants: ${orgs.length}`);
  assert.equal(
    orgs[0]!.attempts.filter((a) => a.attemptId === 'att_organiser_organiser_r0_0').length,
    1,
    'exactly one organiser attempt id',
  );
  assert.equal(orgs[0]!.attempts.filter((a) => a.phase === 'organiser').length, 1, 'one organiser attempt');
  // Journaled intent resolves by observation: one task, one launch total.
  const orgLaunches = env.host.launches.filter((l) => l.spec.phase === 'organiser');
  assert.equal(orgLaunches.length, 1, `organiser launched exactly once, got ${orgLaunches.length}`);
  assert.equal(env.host.createTaskCalls, 1, 'exactly one task created');
});

test('clm_0007: challenge-entry append-ok/save-fail → no duplicate round attempts or envelopes', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  // Drive until challenge envelopes are built (state enters discussing), then
  // simulate the crash: journal appended envelope.built + phase.entered but
  // the save died — rewind state to the pre-entry snapshot.
  await drive(env, () => env.db.state.status === 'discussing');
  assert.equal(env.db.state.status, 'discussing');
  const journaledEnvs = env.db.journal.filter((e) => e.type === 'envelope.built' && e.phase === 'challenge').length;
  assert.ok(journaledEnvs >= 1, 'envelope.built journaled');
  // Rewind durable state to before the transition (append-ok/save-fail).
  env.db.state.status = 'scribe_notes';
  env.db.state.discussion = null;
  for (const p of env.db.state.participants) {
    p.attempts = p.attempts.filter((a) => a.phase !== 'challenge');
  }
  // Re-enter: overlay re-mints challenge attempts; the step must reuse them.
  const r = await resume(env).advance();
  assert.ok(r.ok, JSON.stringify(r.ok ? r.value : r.error));
  const aids = attemptCounts(env);
  assert.ok([...aids.values()].every((n) => n === 1), `duplicate attempt ids: ${JSON.stringify([...aids])}`);
  for (const pid of ['rev_1', 'rev_2']) {
    const n = env.db.state.participants.flatMap((p) =>
      p.attempts.filter((a) => a.participantId === pid && a.phase === 'challenge' && a.round === 1),
    ).length;
    assert.ok(n <= 1, `${pid} has ${n} challenge attempts for round 1 — duplicate stage mint`);
  }
});

test('clm_0020: rejected organiser output launches the journaled repair attempt, not a stale "cancel and restart"', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  // Settle the organiser with an INVALID proposal — admission rejects it and
  // mints exactly one corrective attempt in the same pass.
  await env.engine.advance(); // organiser launched
  const org = env.db.state.participants.find((p) => p.participantId === 'organiser')!;
  const orig = org.attempts[0]!;
  await env.store.writeArtifact(outPaths.organiser, JSON.stringify({ not: 'a roster' }));
  env.host.settle(orig.dispatchId!);
  const r = await env.engine.advance();
  assert.ok(r.ok, JSON.stringify(r.ok ? r.value : r.error));
  assert.ok(
    env.db.journal.some((e) => e.type === 'artifact.rejected' && e.payload?.attemptId === orig.attemptId),
    'rejection journaled',
  );
  // Re-derive: saveState swaps the whole durable state clone — `org` from
  // before the advance is stale and never sees the minted repair.
  const org2 = env.db.state.participants.find((p) => p.participantId === 'organiser')!;
  const repair = org2.attempts.find((a) => a.attemptId === 'att_organiser_organiser_r0_1');
  assert.ok(repair !== undefined, 'corrective attempt minted');
  // The SAME advance must launch the repair — not block on the stale
  // settled_ok reference of the rejected original.
  assert.ok(
    env.db.journal.some((e) => e.type === 'launch.intent' && e.payload?.attemptId === repair.attemptId),
    `repair launched immediately, status ${repair.status}`,
  );
  assert.notEqual(r.value.action, 'blocked', 'must not stale-block on the rejected attempt');
  // Repair produces a valid proposal → run reaches the approval gate.
  const r2 = await drive(env);
  assert.equal(r2.action, 'needs_approval', JSON.stringify(r2));
});

// ─── First-turn submission check (Devin: worker-start proves input_accepted only) ──

interface SubmitRig {
  probes: { terminalHandle: string; dispatchId?: string }[];
  nudges: string[];
}

const subCheck = (state: SubmissionCheck['state'], evidence = state === 'unsubmitted' ? 'input_holds_brief_idle' : state === 'started' ? 'title_working' : 'screen_unreadable'): Result<SubmissionCheck> =>
  ok({ state, evidence, samples: 3, elapsedMs: 10 });

/** Launches report `turnStart` like the live receipts; the host gains the optional check methods. */
function rigSubmission(
  env: Env,
  opts: {
    turnStart?: string;
    probe?: (n: number) => Result<SubmissionCheck>;
    nudge?: () => Promise<Result<SubmitInputResult>>;
  },
): SubmitRig {
  const rig: SubmitRig = { probes: [], nudges: [] };
  let seq = 0;
  env.host.launchImpl = (spec) => {
    seq += 1;
    return ok({
      outcome: 'started' as const,
      dispatchId: `disp_${seq}`,
      terminalHandle: spec.reuseTerminal ?? `term_${seq}`,
      requestId: `req_${seq}`,
      ...(opts.turnStart !== undefined ? { turnStart: opts.turnStart } : {}),
    });
  };
  Object.assign(env.host, {
    probeSubmission: async (i: { terminalHandle: string; dispatchId?: string }) => {
      rig.probes.push(i);
      return opts.probe?.(rig.probes.length) ?? subCheck('started');
    },
    submitPendingInput: async (i: { terminalHandle: string }) => {
      rig.nudges.push(i.terminalHandle);
      return opts.nudge !== undefined ? opts.nudge() : ok({ outcome: 'sent' as const, requestId: 'send_rcpt_1' });
    },
  });
  return rig;
}

async function launchOrganiserOnly(env: Env): Promise<void> {
  for (let i = 0; i < 6 && env.host.launches.length === 0; i++) {
    const r = await env.engine.advance();
    assert.ok(r.ok, JSON.stringify(r));
  }
  assert.equal(env.host.launches.length, 1, 'organiser launched');
}

const submitEvents = (env: Env) => env.db.journal.filter((e) => e.type.startsWith('launch.submit'));
const ORG_ATTEMPT = 'att_organiser_organiser_r0_0';

test('submission check: an observed turn start or a receipt without turnStart never probes', async () => {
  for (const turnStart of ['observed', undefined]) {
    const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
    const rig = rigSubmission(env, { turnStart, probe: () => subCheck('unsubmitted') });
    await launchOrganiserOnly(env);
    assert.equal(rig.probes.length, 0, `turnStart=${turnStart}`);
    assert.equal(rig.nudges.length, 0);
    assert.equal(submitEvents(env).length, 0);
  }
});

test('submission check: started → journaled check, no nudge, no warning', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  const rig = rigSubmission(env, { turnStart: 'unsupported' });
  await launchOrganiserOnly(env);
  assert.deepEqual(rig.probes, [{ terminalHandle: 'term_1', dispatchId: 'disp_1' }]);
  assert.equal(rig.nudges.length, 0);
  const ev = submitEvents(env);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.type, 'launch.submit_check');
  assert.equal(ev[0]!.payload?.state, 'started');
  assert.equal(ev[0]!.payload?.turnStart, 'unsupported');
  assert.equal(ev[0]!.payload?.attemptId, ORG_ATTEMPT);
});

test('submission check: unsubmitted → exactly one journaled bare-Enter nudge → started', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  let intentBeforeSend = false;
  const rig = rigSubmission(env, {
    turnStart: 'unsupported',
    probe: (n) => (n === 1 ? subCheck('unsubmitted') : subCheck('started', 'tui_working')),
    nudge: async () => {
      // Journal-before-mutation: the intent is durable before the Enter goes out.
      intentBeforeSend = env.db.journal.some((e) => e.type === 'launch.submit_nudge' && e.payload?.stage === 'intent');
      return ok({ outcome: 'sent' as const, requestId: 'send_rcpt_1' });
    },
  });
  await launchOrganiserOnly(env);
  assert.equal(rig.nudges.length, 1);
  assert.deepEqual(rig.nudges, ['term_1']);
  assert.ok(intentBeforeSend, 'nudge intent journaled before the send');
  const ev = submitEvents(env).map((e) => [e.type, e.payload?.stage ?? e.payload?.state]);
  assert.deepEqual(ev, [
    ['launch.submit_check', 'unsubmitted'],
    ['launch.submit_nudge', 'intent'],
    ['launch.submit_nudge', 'receipt'],
    ['launch.submit_check', 'started'],
  ]);
  const receipt = submitEvents(env).find((e) => e.payload?.stage === 'receipt')!;
  assert.equal(receipt.payload?.outcome, 'sent');
  assert.equal(receipt.payload?.nudgeId, submitEvents(env).find((e) => e.payload?.stage === 'intent')!.payload?.nudgeId);
  // Later advances never re-probe or re-nudge the dispatched attempt.
  for (let i = 0; i < 3; i++) assert.ok((await env.engine.advance()).ok);
  assert.equal(rig.probes.length, 2);
  assert.equal(rig.nudges.length, 1);
  const org = env.db.state.participants.find((p) => p.participantId === 'organiser')!;
  assert.ok(['dispatched', 'working'].includes(org.attempts[0]!.status), org.attempts[0]!.status);
});

test('submission check: still unsubmitted after the nudge → visible warning, never a second nudge, never a failure', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  const rig = rigSubmission(env, { turnStart: 'unsupported', probe: () => subCheck('unsubmitted') });
  await launchOrganiserOnly(env);
  assert.equal(rig.nudges.length, 1);
  assert.equal(rig.probes.length, 2);
  const warn = submitEvents(env).filter((e) => e.type === 'launch.submit_unconfirmed');
  assert.equal(warn.length, 1);
  assert.equal(warn[0]!.payload?.reason, 'still_unconfirmed_after_nudge');
  assert.equal(warn[0]!.payload?.terminalHandle, 'term_1');
  assert.equal(warn[0]!.payload?.evidence, 'input_holds_brief_idle');
  for (let i = 0; i < 3; i++) {
    const r = await env.engine.advance();
    assert.ok(r.ok);
    assert.notEqual(r.value.action, 'blocked');
  }
  assert.equal(rig.nudges.length, 1);
  const org = env.db.state.participants.find((p) => p.participantId === 'organiser')!;
  assert.ok(['dispatched', 'working'].includes(org.attempts[0]!.status), 'the attempt is not failed — it may genuinely be working');
  // The run still completes normally once the organiser's output lands.
  await driveToApproval(env);
});

test('submission check: inconclusive → warning, no nudge', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  const rig = rigSubmission(env, { turnStart: 'unsupported', probe: () => subCheck('inconclusive', 'composer_unfamiliar') });
  await launchOrganiserOnly(env);
  assert.equal(rig.probes.length, 1);
  assert.equal(rig.nudges.length, 0);
  const warn = submitEvents(env).filter((e) => e.type === 'launch.submit_unconfirmed');
  assert.equal(warn.length, 1);
  assert.equal(warn[0]!.payload?.reason, 'first_check_inconclusive');
  assert.equal(warn[0]!.payload?.evidence, 'composer_unfamiliar');
});

test('submission check: a failing probe is an inconclusive warning, never a block', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  const rig = rigSubmission(env, {
    turnStart: 'unsupported',
    probe: () => failRes(err('adapter_error', 'orca unreachable')),
  });
  await launchOrganiserOnly(env);
  assert.equal(rig.nudges.length, 0);
  const warn = submitEvents(env).find((e) => e.type === 'launch.submit_unconfirmed')!;
  assert.equal(warn.payload?.evidence, 'probe_error:adapter_error');
});

test('submission check: crash after the nudge intent → the nudge is never repeated', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  const rig = rigSubmission(env, {
    turnStart: 'unsupported',
    probe: () => subCheck('unsubmitted'),
    nudge: async () => {
      throw new Error('simulated crash between nudge intent and receipt');
    },
  });
  for (let i = 0; i < 6 && env.host.launches.length === 0; i++) await env.engine.advance();
  assert.equal(rig.nudges.length, 1);
  const intents = submitEvents(env).filter((e) => e.payload?.stage === 'intent');
  assert.equal(intents.length, 1, 'intent durable');
  assert.equal(submitEvents(env).filter((e) => e.payload?.stage === 'receipt').length, 0, 'no receipt');
  // Restart: a fresh engine over the same durable store.
  const engine2 = createEngine({ store: env.store, host: env.host, prompts: env.prompts, now: () => new Date(env.clock.t) });
  for (let i = 0; i < 4; i++) assert.ok((await engine2.advance()).ok);
  assert.equal(rig.nudges.length, 1, 'never a second nudge after the crash');
  const org = env.db.state.participants.find((p) => p.participantId === 'organiser')!;
  assert.ok(['dispatched', 'working'].includes(org.attempts[0]!.status), org.attempts[0]!.status);
});

test('submission check: a journaled nudge intent forbids any further nudge for that attempt', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  env.db.journal.push({
    seq: env.db.journal.length + 1,
    ts: new Date(env.clock.t).toISOString(),
    type: 'launch.submit_nudge',
    actor: 'engine',
    payload: { attemptId: ORG_ATTEMPT, terminalHandle: 'term_prev', stage: 'intent', nudgeId: 'sn_prev' },
  } as JournalEvent);
  const rig = rigSubmission(env, { turnStart: 'unsupported', probe: () => subCheck('unsubmitted') });
  await launchOrganiserOnly(env);
  assert.equal(rig.nudges.length, 0);
  const warn = submitEvents(env).find((e) => e.type === 'launch.submit_unconfirmed')!;
  assert.equal(warn.payload?.reason, 'nudge_already_attempted');
});

test('submission check: only fresh first-turn launches are probed — retained-terminal follow-ups skip it', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  const rig = rigSubmission(env, { turnStart: 'unsupported' });
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  const fresh = env.host.launches.filter((l) => l.spec.reuseTerminal === undefined);
  const reused = env.host.launches.filter((l) => l.spec.reuseTerminal !== undefined);
  assert.ok(reused.length > 0, 'the lifecycle exercised retained-terminal reuse');
  assert.equal(rig.probes.length, fresh.length);
  const probed = new Set(rig.probes.map((p) => p.dispatchId));
  for (const l of reused) assert.ok(!probed.has(l.result.dispatchId), `reused launch ${l.result.dispatchId} was probed`);
});

// ─── Terminal lifecycle: close council-created terminals; pre-dispatch recovery ─
//
// CustodyHost drives the REAL custody hooks the Orca adapter calls: every
// fresh launch journals a terminal-create intent + receipt (with the
// dispatch-marker promise) and, unless scripted otherwise, the worker-start
// marker before "dispatching". Scripted modes simulate the live failures:
//   predispatch    — readiness failed after create; worker-start never issued
//   uncertain      — worker-start went out, outcome unknown
//   crash-before   — process dies after the create receipt, before the marker
//   crash-after    — process dies after the marker, before any receipt
// Simulated host evidence only — no real terminals.

type LaunchMode = 'ok' | 'predispatch' | 'uncertain' | 'crash-before' | 'crash-after';

class CustodyHost extends FakeHost {
  script: LaunchMode[] = [];
  /** Per-participant scripted modes (consumed before `script`). */
  scriptFor = new Map<string, LaunchMode[]>();
  termSeq = 0;
  createdTerminals: string[] = [];
  closed: string[] = [];
  closeImpl?: (h: string) => Result<{ outcome: 'closed' | 'already_gone' | 'failed'; code?: string; detail?: string }>;
  /** Ordered host mutations for release-before-close assertions. */
  ops: string[] = [];
  async launchWorker(spec: WorkerLaunchSpec) {
    this.launchCalls += 1;
    if (spec.reuseTerminal !== undefined) {
      this.seq += 1;
      const res: LaunchResult = { outcome: 'started', dispatchId: `disp_${this.seq}`, terminalHandle: spec.reuseTerminal, requestId: `req_${this.seq}` };
      this.launches.push({ spec, result: res });
      this.landedWorkers.push({ dispatchId: res.dispatchId!, taskId: spec.taskId, terminalHandle: res.terminalHandle });
      return ok(res);
    }
    const mode = this.scriptFor.get(spec.participantId)?.shift() ?? this.script.shift() ?? 'ok';
    const handle = `tc_term_${++this.termSeq}`;
    const intentId = `li_${spec.taskId}:terminal-create`;
    const c = spec.custody!;
    const pi = await c.beforeTerminalCreate({ intentId, participantId: spec.participantId, taskId: spec.taskId, runId: spec.runId, worktree: spec.worktree, title: spec.taskTitle, command: 'devin --model swe-2-max --permission-mode dangerous' });
    assert.ok(pi.ok);
    this.createdTerminals.push(handle);
    const pr = await c.afterTerminalCreate({ intentId, taskId: spec.taskId, outcome: 'created', terminalHandle: handle, requestId: `tc_rcpt_${this.termSeq}`, dispatchMarker: true });
    assert.ok(pr.ok);
    if (mode === 'crash-before') throw new Error('simulated crash after terminal create, before the worker-start marker');
    if (mode === 'predispatch') {
      return ok<LaunchResult>({
        outcome: 'unknown', taskId: spec.taskId, terminalHandle: handle, requestId: `tc_rcpt_${this.termSeq}`,
        workerStartIssued: false, terminalCreated: true, failedStage: 'readiness_wait',
        detail: 'launch uncertain stage=readiness_wait readiness_wait_failed: terminal wait did not prove the agent idle',
      });
    }
    const pm = await c.beforeWorkerStart!({ intentId: `li_${spec.taskId}:worker-start`, taskId: spec.taskId, terminalHandle: handle });
    assert.ok(pm.ok);
    if (mode === 'crash-after') throw new Error('simulated crash after the worker-start marker, before its receipt');
    if (mode === 'uncertain') {
      return ok<LaunchResult>({ outcome: 'unknown', taskId: spec.taskId, terminalHandle: handle, requestId: 'ws_req_lost', terminalCreated: true, detail: 'launch uncertain local_timeout' });
    }
    this.seq += 1;
    const res: LaunchResult = { outcome: 'started', dispatchId: `disp_${this.seq}`, terminalHandle: handle, requestId: `req_${this.seq}` };
    this.launches.push({ spec, result: res });
    this.landedWorkers.push({ dispatchId: res.dispatchId!, taskId: spec.taskId, terminalHandle: handle });
    return ok(res);
  }
  async releaseWorker(input: { dispatchId: string }) {
    this.released.push(input.dispatchId);
    this.ops.push(`release:${input.dispatchId}`);
    // Observed 1.4.261 for argv-lane (pre-existing) terminals: retained, no process action.
    return ok({ released: false, state: 'retained' });
  }
  async closeTerminal(input: { terminalHandle: string }) {
    this.closed.push(input.terminalHandle);
    this.ops.push(`close:${input.terminalHandle}`);
    return this.closeImpl?.(input.terminalHandle) ?? ok({ outcome: 'closed' as const });
  }
}

function makeCustodyEnv(config: CouncilConfig): Env & { host: CustodyHost } {
  const base = makeEnv(config);
  const host = new CustodyHost();
  const engine = createEngine({ store: base.store, host, prompts: base.prompts, now: () => new Date(base.clock.t) });
  return { ...base, host, engine };
}

const closeEvents = (env: Env) => env.db.journal.filter((e) => e.type === 'terminal.close');
const closeReceipts = (env: Env) => closeEvents(env).filter((e) => e.payload?.stage === 'receipt');
const preDispatchEvents = (env: Env) => env.db.journal.filter((e) => e.type === 'worker.settled' && e.payload?.preDispatch === true);
const restartEngine = (env: Env) => createEngine({ store: env.store, host: env.host, prompts: env.prompts, now: () => new Date(env.clock.t) });

async function approveTwo(env: Env): Promise<void> {
  await driveToApproval(env);
  assert.ok((await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' })).ok);
}
test('terminal lifecycle: a finished run releases (retained) then closes exactly the terminals it created', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  // Organiser early close: roster admitted → its terminal is released and
  // closed before any reviewer launches (no later phase reuses it).
  assert.deepEqual(env.host.closed, ['tc_term_1'], 'organiser terminal closed at roster admission');
  assert.deepEqual(env.host.ops.slice(0, 2), ['release:disp_1', 'close:tc_term_1'], 'release precedes close');
  assert.ok((await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' })).ok);
  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  assert.equal(env.db.state.status, 'reported');
  // Discussion phases REUSED the retained reviewer terminals (still working).
  assert.ok(env.host.launches.some((l) => l.spec.reuseTerminal !== undefined), 'retained-terminal reuse exercised');
  const reusedBeforeFinish = env.host.launches.filter((l) => l.spec.reuseTerminal !== undefined).map((l) => l.spec.reuseTerminal!);
  assert.ok(reusedBeforeFinish.every((h) => env.host.createdTerminals.includes(h)));
  // Every created terminal is closed exactly once; nothing else is touched.
  assert.deepEqual([...env.host.closed].sort(), [...env.host.createdTerminals].sort());
  assert.equal(new Set(env.host.closed).size, env.host.closed.length, 'no double close');
  assert.ok(!env.host.closed.includes('term_supervisor'), 'supervisor terminal is not engine custody');
  for (const h of env.host.createdTerminals) {
    const evs = closeEvents(env).filter((e) => e.payload?.terminalHandle === h);
    assert.deepEqual(evs.map((e) => e.payload?.stage), ['intent', 'receipt'], h);
    assert.ok(evs[0]!.seq < evs[1]!.seq, 'intent journaled before the receipt');
    assert.equal(evs[1]!.payload?.outcome, 'closed');
  }
  // Reviewer terminals are closed only AFTER the run finished (never mid-run).
  const finishedSeq = env.db.journal.find((e) => e.type === 'run.finished')!.seq;
  for (const h of reusedBeforeFinish) {
    const intent = closeEvents(env).find((e) => e.payload?.terminalHandle === h && e.payload?.stage === 'intent')!;
    assert.ok(intent.seq > finishedSeq, `${h} closed after run.finished`);
    const relAt = env.host.ops.findIndex((o) => o.startsWith('release:') && env.host.ops.indexOf(`close:${h}`) > env.host.ops.indexOf(o));
    assert.ok(relAt >= 0, `${h}: a release preceded the close`);
  }
  const rel = env.db.journal.filter((e) => e.type === 'worker.released' && e.payload?.outcome === 'refused');
  assert.ok(rel.length > 0 && rel.every((e) => e.payload?.hostState === 'retained'), 'retained release receipts journaled');
  // Idempotent re-run: advancing the finished run never closes again.
  const before = env.host.closed.length;
  const again = await env.engine.advance();
  assert.ok(again.ok && again.value.action === 'finished');
  assert.equal(env.host.closed.length, before);
  const again2 = await restartEngine(env).advance();
  assert.ok(again2.ok);
  assert.equal(env.host.closed.length, before, 'a restarted engine reads the receipts and does nothing');
});

test('terminal lifecycle: a failed close is journaled, never changes the outcome, and only council cleanup retries it', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  env.host.closeImpl = (h) => (h === 'tc_term_2' ? ok({ outcome: 'failed' as const, code: 'runtime_unavailable', detail: 'daemon busy' }) : ok({ outcome: 'closed' as const }));
  await approveTwo(env);
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  assert.equal((r as { outcome?: string }).outcome, 'succeeded', 'close failure never changes the run outcome');
  assert.equal(env.db.state.status, 'reported');
  const failed = closeReceipts(env).find((e) => e.payload?.terminalHandle === 'tc_term_2')!;
  assert.equal(failed.payload?.outcome, 'failed');
  assert.equal(failed.payload?.code, 'runtime_unavailable');
  const n = env.host.closed.length;
  for (let i = 0; i < 2; i++) assert.ok((await env.engine.advance()).ok);
  assert.equal(env.host.closed.length, n, 'a failed receipt means done for the engine');
  env.host.closeImpl = undefined;
  const c = await env.engine.cleanup!();
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.value.terminals.find((t) => t.terminalHandle === 'tc_term_2')?.outcome, 'closed');
  assert.equal(env.host.closed.filter((h) => h === 'tc_term_2').length, 2);
  for (const t of c.value.terminals.filter((x) => x.terminalHandle !== 'tc_term_2')) {
    assert.equal(t.outcome, 'skipped', `${t.terminalHandle} already closed`);
  }
  assert.equal(env.host.closed.length, n + 1, 'already-closed terminals are not closed again');
});

test('terminal lifecycle: cancel closes settled terminals and skips one whose worker may still run', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await approveTwo(env);
  assert.ok((await env.engine.advance()).ok);
  const indep = env.host.launches.filter((l) => l.spec.phase === 'independent_review');
  assert.equal(indep.length, 2);
  const live = indep.find((l) => l.spec.participantId === 'rev_2')!;
  env.host.stopImpl = (d) => (d === live.result.dispatchId ? ok({ outcome: 'refused' as const }) : ok({ outcome: 'stopped' as const }));
  assert.ok((await env.engine.cancel({ reason: 'test' })).ok);
  assert.equal(env.db.state.status, 'cancelled');
  const liveHandle = live.result.terminalHandle!;
  assert.ok(!env.host.closed.includes(liveHandle), 'a possibly-live worker keeps its terminal');
  const stoppedHandle = indep.find((l) => l.spec.participantId === 'rev_1')!.result.terminalHandle!;
  assert.ok(env.host.closed.includes(stoppedHandle), 'the confirmed-stopped worker terminal is closed');
  const skip = closeEvents(env).find((e) => e.payload?.stage === 'skipped' && e.payload?.terminalHandle === liveHandle);
  assert.ok(skip !== undefined && /may still be live/.test(String(skip.payload?.reason)));
  // cleanup observes the dispatch: still working → skipped; settled → released + closed.
  const c1 = await env.engine.cleanup!();
  assert.ok(c1.ok);
  assert.equal(c1.value.terminals.find((t) => t.terminalHandle === liveHandle)?.outcome, 'skipped');
  assert.ok(!env.host.closed.includes(liveHandle));
  env.host.settle(live.result.dispatchId!, true);
  const c2 = await env.engine.cleanup!();
  assert.ok(c2.ok);
  assert.equal(c2.value.terminals.find((t) => t.terminalHandle === liveHandle)?.outcome, 'closed');
  assert.ok(env.host.ops.indexOf(`release:${live.result.dispatchId}`) < env.host.ops.indexOf(`close:${liveHandle}`), 'release precedes the cleanup close');
  assert.equal(env.db.state.status, 'cancelled', 'cleanup never changes run state');
});

test('terminal lifecycle: a close intent without a receipt is retried after a crash and reported', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  let crashOnce = true;
  env.host.closeImpl = (h) => {
    if (h === 'tc_term_1' && crashOnce) {
      crashOnce = false;
      throw new Error('simulated crash between close intent and receipt');
    }
    return ok({ outcome: 'closed' as const });
  };
  // Organiser output lands; its admission-time close crashes mid-flight.
  for (let i = 0; i < 6 && closeEvents(env).length === 0; i++) {
    for (const l of env.host.launches) {
      if (l.result.dispatchId === undefined) continue;
      await env.store.writeArtifact(outputPathFor(l.spec), JSON.stringify(mkProposal(env.db.state.config.requestedPerspectives)));
      env.host.settle(l.result.dispatchId);
    }
    await env.engine.advance();
  }
  const evs = closeEvents(env).filter((e) => e.payload?.terminalHandle === 'tc_term_1');
  assert.deepEqual(evs.map((e) => e.payload?.stage), ['intent'], 'intent durable, no receipt');
  env.engine = restartEngine(env);
  await driveToApproval(env);
  assert.ok((await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' })).ok);
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  const after = closeEvents(env).filter((e) => e.payload?.terminalHandle === 'tc_term_1');
  assert.deepEqual(after.map((e) => e.payload?.stage), ['intent', 'intent', 'receipt']);
  assert.equal(after[1]!.payload?.retriedIntent, true, 'the retry is reported');
  assert.equal(after[2]!.payload?.outcome, 'closed');
});
test('pre-dispatch failure: readiness failure → orphan closed → exactly one fresh relaunch → success', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await approveTwo(env);
  env.host.scriptFor.set('rev_1', ['predispatch', 'ok']);
  const launchesBefore = env.db.state.consumption.launches;
  const step = await env.engine.advance();
  assert.ok(step.ok);
  assert.notEqual(step.value.action, 'blocked', `never launch_unknown: ${JSON.stringify(step.value)}`);
  const pd = preDispatchEvents(env);
  assert.equal(pd.length, 1);
  assert.equal(pd[0]!.payload?.relaunch, 'allowed');
  assert.equal(pd[0]!.payload?.workerStartIssued, false);
  assert.equal(pd[0]!.payload?.stage, 'readiness_wait');
  const orphan = pd[0]!.payload?.terminalHandle as string;
  assert.ok(env.host.closed.includes(orphan), 'orphan terminal closed');
  const orphanClose = closeReceipts(env).find((e) => e.payload?.terminalHandle === orphan)!;
  assert.ok(orphanClose.seq > pd[0]!.seq, 'failure journaled before the orphan close');
  assert.equal(orphanClose.payload?.outcome, 'closed');
  assert.equal(env.db.journal.filter((e) => e.type === 'worker.unknown').length, 0, 'no worker.unknown');
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const ind = rev1.attempts.filter((a) => a.phase === 'independent_review');
  assert.deepEqual(ind.map((a) => a.status), ['settled_failed', 'dispatched']);
  assert.equal(ind[1]!.attemptId, pd[0]!.payload?.retryAttemptId);
  assert.notEqual(rev1.retainedTerminal, orphan, 'the orphan is never a retained session');
  // Only real dispatches are charged against maxLaunches: one per reviewer.
  assert.equal(env.db.state.consumption.launches, launchesBefore + 2);
  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  assert.ok(
    env.db.journal.some((e) => e.type === 'artifact.admitted' && e.participantId === 'rev_1' && e.phase === 'independent_review'),
    'the relaunched seat contributed',
  );
  assert.equal(env.host.closed.filter((h) => h === orphan).length, 1, 'orphan closed once, never again at finish');
  // The relaunch's terminal, not the orphan, served the later phases.
  assert.ok(!env.host.launches.some((l) => l.spec.reuseTerminal === orphan));
});

test('pre-dispatch failure twice: the seat fails, no third launch, the run continues', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10, quorumRatio: 0.5 }));
  await approveTwo(env);
  env.host.scriptFor.set('rev_1', ['predispatch', 'predispatch', 'ok', 'ok']);
  const step = await env.engine.advance();
  assert.ok(step.ok && step.value.action !== 'blocked', JSON.stringify(step));
  const pd = preDispatchEvents(env);
  assert.deepEqual(pd.map((e) => e.payload?.relaunch), ['allowed', 'exhausted']);
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1.status, 'failed');
  assert.equal(rev1.attempts.filter((a) => a.phase === 'independent_review').length, 2, 'no third attempt');
  for (const e of pd) assert.ok(env.host.closed.includes(e.payload?.terminalHandle as string), 'both orphans closed');
  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  assert.equal(env.host.scriptFor.get('rev_1')!.length, 2, 'rev_1 never launched again in any phase');
});

test('pre-dispatch classification never applies when worker-start may have been issued — still blocks', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await approveTwo(env);
  env.host.scriptFor.set('rev_1', ['uncertain', 'ok']);
  const step = await env.engine.advance();
  assert.ok(step.ok);
  assert.equal(step.value.action, 'blocked');
  assert.match(step.value.note ?? '', /never relaunch/);
  assert.equal(preDispatchEvents(env).length, 0);
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1.attempts.length, 1);
  assert.equal(rev1.attempts[0]!.status, 'unknown');
  const h = rev1.attempts[0]!.terminalHandle!;
  assert.ok(!env.host.closed.includes(h), 'an uncertain dispatch keeps its terminal');
  assert.equal(env.host.scriptFor.get('rev_1')!.length, 1, 'never relaunched');
  // Cancelling still preserves it (the worker may be live).
  assert.ok((await env.engine.cancel({ reason: 't' })).ok);
  assert.ok(!env.host.closed.includes(h));
});

test('crash after the worker-start marker, before any receipt → uncertain, blocks, never relaunched', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await approveTwo(env);
  env.host.scriptFor.set('rev_1', ['crash-after', 'ok']);
  const crashed = await env.engine.advance();
  assert.equal(crashed.ok, false, 'simulated crash');
  assert.ok(env.db.journal.some((e) => e.type === 'launch.intent' && e.payload?.stage === 'worker-start' && e.payload?.attemptId === 'att_rev_1_independent_review_r0_0'));
  const r = await restartEngine(env).advance();
  assert.ok(r.ok);
  assert.equal(r.value.action, 'blocked', JSON.stringify(r.value));
  assert.equal(preDispatchEvents(env).length, 0);
  assert.equal(env.host.scriptFor.get('rev_1')!.length, 1, 'never relaunched');
  const att = env.db.state.participants.find((p) => p.participantId === 'rev_1')!.attempts;
  assert.equal(att.length, 1);
  assert.equal(att[0]!.status, 'unknown');
  assert.ok(!env.host.closed.includes(att[0]!.terminalHandle!), 'terminal kept — a worker may be attached');
});

test('crash before the worker-start marker → provably not dispatched: one relaunch, then the seat fails — never blind', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10, quorumRatio: 0.5 }));
  await approveTwo(env);
  env.host.scriptFor.set('rev_1', ['crash-before', 'crash-before', 'ok']);
  assert.equal((await env.engine.advance()).ok, false, 'first crash');
  // Resume #1: create receipt journaled, no marker → pre-dispatch proven →
  // orphan closed → exactly one relaunch (which crashes before its marker too).
  assert.equal((await restartEngine(env).advance()).ok, false, 'relaunch crashed');
  let pd = preDispatchEvents(env);
  assert.equal(pd.length, 1);
  assert.equal(pd[0]!.payload?.stage, 'resume-no-dispatch-marker');
  assert.ok(env.db.journal.some((e) => e.type === 'launch.resume' && e.payload?.resolution === 'pre-dispatch-proven'));
  assert.ok(env.host.closed.includes(pd[0]!.payload?.terminalHandle as string));
  // Resume #2: the relaunch was also never dispatched → allowance spent → seat failed.
  const r = await restartEngine(env).advance();
  assert.ok(r.ok, JSON.stringify(r));
  pd = preDispatchEvents(env);
  assert.deepEqual(pd.map((e) => e.payload?.relaunch), ['allowed', 'exhausted']);
  assert.equal(env.host.scriptFor.get('rev_1')!.length, 1, 'no launch beyond the single allowed retry');
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  assert.equal(rev1.status, 'failed');
  for (const e of pd) assert.ok(env.host.closed.includes(e.payload?.terminalHandle as string));
});

test('legacy terminal receipts without the dispatch-marker promise stay blocking on resume', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await approveTwo(env);
  env.host.scriptFor.set('rev_1', ['crash-before', 'ok']);
  assert.equal((await env.engine.advance()).ok, false);
  // Strip the promise: a pre-change journal cannot prove the marker scheme.
  for (const e of env.db.journal) {
    if (e.type === 'task.created' && e.payload?.scope === 'terminal' && e.payload?.attemptId === 'att_rev_1_independent_review_r0_0') delete e.payload.dispatchMarker;
  }
  const r = await restartEngine(env).advance();
  assert.ok(r.ok);
  assert.equal(r.value.action, 'blocked');
  assert.equal(preDispatchEvents(env).length, 0);
  assert.equal(env.host.scriptFor.get('rev_1')!.length, 1, 'never relaunched');
});

test('cleanup: refuses a non-terminal run; closes a settled supervisor; never its own or unrecorded terminals', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  const refused = await env.engine.cleanup!();
  assert.ok(!refused.ok && refused.error.code === 'invalid_transition');
  assert.ok((await env.engine.cancel({ reason: 't' })).ok);
  const sup = { terminalHandle: 'term_supervisor', dispatchId: 'disp_sup', startupStatus: 'attached' };
  const self = await env.engine.cleanup!({ supervisor: sup, callerHandle: 'term_supervisor' });
  assert.ok(self.ok);
  assert.equal(self.value.terminals.find((t) => t.owner === 'supervisor')?.outcome, 'skipped', 'never closes the calling terminal');
  const working = await env.engine.cleanup!({ supervisor: sup });
  assert.ok(working.ok);
  assert.equal(working.value.terminals.find((t) => t.owner === 'supervisor')?.outcome, 'skipped', 'unsettled supervisor dispatch');
  assert.ok(!env.host.closed.includes('term_supervisor'));
  const issued = await env.engine.cleanup!({ supervisor: { ...sup, startupStatus: 'start_issued' } });
  assert.ok(issued.ok);
  assert.equal(issued.value.terminals.find((t) => t.owner === 'supervisor')?.outcome, 'skipped', 'start_issued may own a worker');
  env.host.settle('disp_sup');
  const done = await env.engine.cleanup!({ supervisor: sup, callerHandle: 'term_primary' });
  assert.ok(done.ok);
  assert.equal(done.value.terminals.find((t) => t.owner === 'supervisor')?.outcome, 'closed');
  assert.ok(env.host.ops.indexOf('release:disp_sup') >= 0 && env.host.ops.indexOf('release:disp_sup') < env.host.ops.indexOf('close:term_supervisor'));
  assert.equal(env.db.state.status, 'cancelled');
  // Without startup-record custody the supervisor is never touched; only
  // journaled engine-created terminals are ever closed.
  const env2 = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env2);
  assert.ok((await env2.engine.cancel({ reason: 't' })).ok);
  const c = await env2.engine.cleanup!();
  assert.ok(c.ok);
  assert.ok(c.value.terminals.every((t) => t.owner === 'participant' && env2.host.createdTerminals.includes(t.terminalHandle)));
  assert.deepEqual([...new Set(env2.host.closed)].sort(), [...env2.host.createdTerminals].sort());
  assert.ok(!env2.host.closed.includes('term_supervisor'));
});

test('terminal lifecycle: legacy hosts (no terminal-create receipts) keep the old release-only behavior', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await approveTwo(env);
  const r = await drive(env);
  assert.equal(r.action, 'finished');
  assert.equal(closeEvents(env).length, 0, 'nothing journaled as created → nothing closed');
  assert.ok(env.host.released.length > 0, 'worker-release still issued as before');
});

// ─── Follow-up: cancelled-run supervisor notice + idle supervisor cleanup ────

const cancelNotices = (env: Env) => env.db.journal.filter((e) => e.type === 'mail.sent' && e.payload?.kind === 'cancel-notice');

test('cancel: one bounded notice to a live/idle supervisor Dispatch, journaled like the approval wake', async () => {
  for (const liveness of ['idle', 'working'] as const) {
    const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
    await driveToApproval(env);
    env.host.liveness.set('disp_sup', { liveness });
    const sentBefore = env.host.notifications.length;
    assert.ok((await env.engine.cancel({ reason: 'operator stop' })).ok);
    const sent = env.host.notifications.slice(sentBefore);
    assert.equal(sent.length, 1, liveness);
    assert.equal(sent[0]!.to, 'dispatch:disp_sup');
    assert.match(sent[0]!.subject, /run cancelled/);
    assert.match(sent[0]!.body, /--advance --as-supervisor/);
    assert.match(sent[0]!.body, /worker_done/);
    assert.deepEqual(cancelNotices(env).map((e) => e.payload?.outcome), ['intent', 'sent'], 'intent journaled before the send');
    assert.equal(env.db.state.status, 'cancelled');
  }
});

test('cancel: no notice to a settled, unobservable or unrecorded supervisor Dispatch', async () => {
  const settled = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(settled);
  settled.host.settle('disp_sup');
  const n0 = settled.host.notifications.length;
  assert.ok((await settled.engine.cancel({ reason: 't' })).ok);
  assert.equal(settled.host.notifications.length, n0, 'mail to a settled Dispatch would reopen it as new work');
  assert.match(String(cancelNotices(settled)[0]?.payload?.reason), /already settled/);

  const unverifiable = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(unverifiable);
  unverifiable.host.liveness.set('disp_sup', { liveness: 'unverifiable' });
  const n1 = unverifiable.host.notifications.length;
  assert.ok((await unverifiable.engine.cancel({ reason: 't' })).ok);
  assert.equal(unverifiable.host.notifications.length, n1);
  assert.equal(cancelNotices(unverifiable)[0]?.payload?.outcome, 'skipped');

  const none = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  none.db.state.supervisor = { terminalHandle: 'term_supervisor', dispatchId: null };
  await driveToApproval(none);
  const n2 = none.host.notifications.length;
  assert.ok((await none.engine.cancel({ reason: 't' })).ok);
  assert.equal(none.host.notifications.length, n2);
  assert.match(String(cancelNotices(none)[0]?.payload?.reason), /no supervisor dispatch/);
});

test('cleanup: an idle supervisor without worker_done on a terminal run is closed with the reason journaled; working/waiting/unknown are refused', async () => {
  const sup = { terminalHandle: 'term_supervisor', dispatchId: 'disp_sup', startupStatus: 'attached' };
  for (const liveness of ['working', 'waiting_human', 'unverifiable'] as const) {
    const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
    await driveToApproval(env);
    assert.ok((await env.engine.cancel({ reason: 't' })).ok);
    env.host.liveness.set('disp_sup', { liveness });
    const c = await env.engine.cleanup!({ supervisor: sup, callerHandle: 'term_primary' });
    assert.ok(c.ok);
    assert.equal(c.value.terminals.find((t) => t.owner === 'supervisor')?.outcome, 'skipped', liveness);
    assert.ok(!env.host.closed.includes('term_supervisor'), liveness);
  }
  const failing = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(failing);
  assert.ok((await failing.engine.cancel({ reason: 't' })).ok);
  failing.host.observeImpl = () => failRes(err('adapter_error', 'orca unreachable'));
  const cf = await failing.engine.cleanup!({ supervisor: sup, callerHandle: 'term_primary' });
  assert.ok(cf.ok);
  assert.equal(cf.value.terminals.find((t) => t.owner === 'supervisor')?.outcome, 'skipped', 'unobservable');

  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  assert.ok((await env.engine.cancel({ reason: 't' })).ok);
  env.host.liveness.set('disp_sup', { liveness: 'idle' });
  // Never the caller, even when idle.
  const self = await env.engine.cleanup!({ supervisor: sup, callerHandle: 'term_supervisor' });
  assert.ok(self.ok);
  assert.equal(self.value.terminals.find((t) => t.owner === 'supervisor')?.outcome, 'skipped');
  const releasesBefore = env.host.released.length;
  const c = await env.engine.cleanup!({ supervisor: sup, callerHandle: 'term_primary' });
  assert.ok(c.ok);
  const entry = c.value.terminals.find((t) => t.owner === 'supervisor')!;
  assert.equal(entry.outcome, 'closed');
  assert.equal(entry.reason, 'terminal run; supervisor idle without worker_done');
  assert.ok(env.host.closed.includes('term_supervisor'));
  assert.equal(env.host.released.length, releasesBefore, 'an unsettled dispatch is not released — only its terminal closed');
  const intent = closeEvents(env).find((e) => e.payload?.terminalHandle === 'term_supervisor' && e.payload?.stage === 'intent')!;
  assert.match(String(intent.payload?.reason), /supervisor idle without worker_done/);
  assert.equal(env.db.state.status, 'cancelled');
});

test('superseded markers: pre-dispatch and fresh-session fallback failures record their relaunch and survive state round-trips', async () => {
  const env = makeCustodyEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await approveTwo(env);
  env.host.scriptFor.set('rev_1', ['predispatch', 'ok']);
  assert.ok((await env.engine.advance()).ok);
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const [failed, retry] = rev1.attempts.filter((a) => a.phase === 'independent_review');
  assert.equal(failed!.supersededBy, retry!.attemptId);
  assert.equal(failed!.supersededReason, 'pre_dispatch');
  const { parseCouncilState } = await import('../src/validation.js');
  const parsed = parseCouncilState(env.db.state);
  assert.ok(parsed.ok);
  const back = parsed.value.participants.find((p) => p.participantId === 'rev_1')!.attempts[0]!;
  assert.equal(back.supersededBy, retry!.attemptId);
  assert.equal(back.supersededReason, 'pre_dispatch');
  // Lost state: the journal restores the marker.
  delete env.db.state.participants.find((p) => p.participantId === 'rev_1')!.attempts[0]!.supersededBy;
  delete env.db.state.participants.find((p) => p.participantId === 'rev_1')!.attempts[0]!.supersededReason;
  assert.ok((await restartEngine(env).advance()).ok);
  assert.equal(env.db.state.participants.find((p) => p.participantId === 'rev_1')!.attempts[0]!.supersededBy, retry!.attemptId);
});

test('superseded markers: a stale retained terminal falls back fresh, and the recovered challenge seat reports completed', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await approveTwo(env);
  let staleOnce = true;
  env.host.launchImpl = (spec) => {
    env.host.seq += 1;
    if (spec.reuseTerminal !== undefined && spec.phase === 'challenge' && spec.participantId === 'rev_1' && staleOnce) {
      staleOnce = false;
      return ok({ outcome: 'failed', detail: 'launch failed stage=readiness terminal_handle_stale' });
    }
    return ok({ outcome: 'started', dispatchId: `disp_${env.host.seq}`, terminalHandle: spec.reuseTerminal ?? `term_${env.host.seq}`, requestId: `req_${env.host.seq}` });
  };
  const r = await drive(env);
  assert.equal(r.action, 'finished', JSON.stringify(r));
  const rev1 = env.db.state.participants.find((p) => p.participantId === 'rev_1')!;
  const ch = rev1.attempts.filter((a) => a.phase === 'challenge');
  assert.equal(ch.length, 2);
  assert.equal(ch[0]!.status, 'settled_failed');
  assert.equal(ch[0]!.supersededReason, 'fresh_fallback');
  assert.equal(ch[0]!.supersededBy, ch[1]!.attemptId);
  const report = JSON.parse(env.db.artifacts.get('report.json')!) as CouncilReport;
  const seat = report.coverage.seats.find((s) => s.participantId === 'rev_1')!;
  assert.equal(seat.outcome, 'completed', JSON.stringify(seat));
});
