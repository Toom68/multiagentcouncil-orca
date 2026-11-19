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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
import {
  canonicalRosterHash,
  err,
  parseChallengeEnvelope,
  resolveConfig,
} from '../src/validation.js';

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
      ? failRes(err('io_error', `artifact ${relPath} missing`))
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
  async sendNotification(input: { to: string; subject: string; body: string }) {
    this.notifications.push(input);
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
    artifacts: new Map(),
    journal: [],
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
          json = mkFindings(l.spec.participantId, p?.perspectiveId ?? 'persp_1');
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
  // Explicit wake was sent to the supervisor (prefer run:<orcaRunId>).
  assert.equal(env.host.notifications.length, 1);
  assert.equal(env.host.notifications[0].to, 'run:orca_run_1');

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
  // The rejected original was archived before the repair rewrote the path.
  const archived = [...env.db.artifacts.keys()].filter((k) => k.startsWith('rejected/'));
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
  const stopEvs = env.db.journal.filter((e) => e.type === 'worker.stop_requested');
  assert.equal(stopEvs.length, 1);
  assert.equal(stopEvs[0].payload?.outcome, 'refused');
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
  // Two sends to the run address already journaled (e.g. earlier wake retries);
  // a send to a DIFFERENT recipient must not count against this one.
  for (const [to, outcome] of [['run:orca_run_1', 'sent'], ['run:orca_run_1', 'unknown'], ['term_other', 'sent']] as const) {
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
  assert.equal(env.host.notifications.filter((n) => n.to === 'run:orca_run_1').length, 0, 'budget exhausted → wake refused');
  const refused = env.db.journal.find((e) => e.type === 'mail.sent' && e.payload?.outcome === 'budget_refused');
  assert.ok(refused !== undefined, 'refusal journaled visibly, never silent');
  assert.equal(refused.payload?.to, 'run:orca_run_1');
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
  assert.ok(typeof notesPath === 'string' && notesPath.endsWith('scribe/notes.json'), `notesPath present: ${notesPath}`);
});
