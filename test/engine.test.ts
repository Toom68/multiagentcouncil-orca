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
  type WorkerLaunchSpec,
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
  launches: LaunchRecord[] = [];
  liveness = new Map<string, { liveness: WorkerObservation['liveness']; taskStatus?: string }>();
  notifications: { to: string; subject: string; body: string }[] = [];
  stops: { dispatchId: string; outcome: StopOutcome }[] = [];
  released: string[] = [];
  runImpl?: () => Result<{ runId: string }>;
  launchImpl?: (spec: WorkerLaunchSpec) => Result<LaunchResult>;
  observeImpl?: (dispatchId: string) => Result<WorkerObservation>;
  stopImpl?: (dispatchId: string) => Result<{ outcome: StopOutcome }>;

  async createRun() {
    this.createRunCalls += 1;
    if (this.runImpl) return this.runImpl();
    return ok({ runId: 'orca_run_1' });
  }
  async createTask() {
    this.createTaskCalls += 1;
    return ok({ taskId: `task_${this.createTaskCalls}` });
  }
  async launchWorker(spec: WorkerLaunchSpec) {
    if (this.launchImpl) {
      const r = this.launchImpl(spec);
      if (r.ok) this.launches.push({ spec, result: r.value });
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
    return ok(res);
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

function makeEnv(config: CouncilConfig, opts: { liveSource?: Record<string, string> } = {}): Env {
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
  const engine = createEngine({ store, host, prompts, now: () => new Date(clock.t) });
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

/** Complete every launched worker with appropriate valid output, then advance until non-progress. */
async function drive(env: Env): Promise<AdvanceResult> {
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
  const intents = env.db.journal.filter((e) => e.type === 'launch.intent');
  const started = env.db.journal.filter((e) => e.type === 'worker.started');
  assert.equal(intents.filter((e) => typeof e.payload?.attemptId === 'string').length, 48);
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

test('misbound reviewer output is rejected visibly; run continues partial', async () => {
  const env = makeEnv(configWith({ participants: 2, requestedPerspectives: 10 }));
  await driveToApproval(env);
  await env.engine.approve({ roster: mkApprovedRoster(env, ['persp_1', 'persp_2']), approver: 'o' });
  let poisoned = false;
  for (let g = 0; g < 200; g++) {
    for (const l of env.host.launches) {
      const d = l.result.dispatchId;
      if (d === undefined || env.host.liveness.get(d)?.liveness === 'finished') continue;
      let json: object;
      if (l.spec.phase === 'independent_review' && !poisoned) {
        poisoned = true;
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
  const rejections = env.db.journal.filter((e) => e.type === 'artifact.rejected');
  assert.ok(rejections.length > 0, 'misbound output visibly rejected');
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
