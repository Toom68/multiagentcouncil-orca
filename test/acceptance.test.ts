/**
 * Acceptance test — the complete council lifecycle with REAL createStore +
 * REAL createEngine + a FakeHost test-double implementing the contracts
 * HostAdapter inside this file (fakes live in tests, never production).
 *
 * The run is created through the real CLI (`node dist/src/cli.js init`).
 * Worker "completions" are simulated honestly: the fake reports its dispatches
 * started/finished and the test writes the exact schema-valid artifacts a real
 * worker would emit at the documented paths — the engine's admission,
 * validation, ledger, envelope, and report machinery all run for real.
 *
 * No test ever launches a real agent or touches a real Orca: the fake adapter
 * is the only host, and the CLI's own Orca-dependent invocations run with
 * ORCA_CLI_COMMAND pointed at a nonexistent binary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCHEMA_VERSION,
  type AdvanceResult,
  type CouncilError,
  type FindingsFile,
  type HostAdapter,
  type LaunchResult,
  type ProposedRoster,
  type Result,
  type StopOutcome,
  type WorkerLaunchSpec,
  type WorkerObservation,
} from '../src/contracts.js';
import { CATALOG_EXECUTION_POLICY } from '../src/catalog.js';
import { createEngine } from '../src/engine.js';
import { createPromptBuilder } from '../src/prompts.js';
import { createStore } from '../src/store.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const NO_ORCA = 'definitely-not-a-real-orca-binary-xyzzy';
const AGENT = { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' } as const;

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`Result failed [${r.error.code}]: ${r.error.message}`);
  return r.value;
};

// ─── FakeHost — honest test-double of the contracts HostAdapter ─────────────

interface LaunchRecord {
  spec: WorkerLaunchSpec;
  dispatchId: string;
  settled: boolean;
}

class FakeHost implements HostAdapter {
  private seq = 0;
  runIds: string[] = [];
  tasks: { taskId: string; runId: string; specFilePath: string; title: string }[] = [];
  launches: LaunchRecord[] = [];
  mail: { to: string; subject: string; body: string }[] = [];
  stops: { dispatchId: string; reason: string }[] = [];
  releases: string[] = [];

  async createRun(input: { objective: string }) {
    const runId = `fake-orca-run-${++this.seq}`;
    this.runIds.push(runId);
    void input;
    return ok({ runId });
  }
  async createTask(input: { runId: string; specFilePath: string; title: string }) {
    const taskId = `fake-task-${++this.seq}`;
    this.tasks.push({ taskId, ...input });
    return ok({ taskId });
  }
  async launchWorker(spec: WorkerLaunchSpec): Promise<Result<LaunchResult>> {
    const dispatchId = `fake-dispatch-${++this.seq}`;
    this.launches.push({ spec, dispatchId, settled: false });
    return ok({
      outcome: 'started',
      taskId: spec.taskId,
      dispatchId,
      terminalHandle: spec.reuseTerminal ?? `fake-term-${this.seq}`,
      requestId: `fake-req-${this.seq}`,
    });
  }
  async observeWorker(input: { dispatchId: string }): Promise<Result<WorkerObservation>> {
    const l = this.launches.find((x) => x.dispatchId === input.dispatchId);
    if (l === undefined) {
      return ok({ dispatchId: input.dispatchId, liveness: 'unverifiable', detail: 'unknown dispatch' });
    }
    return ok({
      dispatchId: input.dispatchId,
      liveness: l.settled ? 'finished' : 'working',
      taskStatus: l.settled ? 'completed' : 'in_progress',
    });
  }
  async sendNotification(input: { to: string; subject: string; body: string }) {
    this.mail.push(input);
    return ok({ outcome: 'sent' as const, requestId: `fake-req-${++this.seq}` });
  }
  async requestStop(input: { dispatchId: string; reason: string }) {
    this.stops.push(input);
    for (const l of this.launches) if (l.dispatchId === input.dispatchId) l.settled = true;
    return ok({ outcome: 'stopped' as StopOutcome });
  }
  async releaseWorker(input: { dispatchId: string }) {
    this.releases.push(input.dispatchId);
    return ok({ released: true });
  }
  settle(dispatchId: string): void {
    for (const l of this.launches) if (l.dispatchId === dispatchId) l.settled = true;
  }
  settleAll(): void {
    for (const l of this.launches) l.settled = true;
  }
  unsettled(): LaunchRecord[] {
    return this.launches.filter((l) => !l.settled);
  }
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `council-acc-${prefix}-`));
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const TARGET_FILES = {
  'src/pagination.js': 'export function paginate(items, page, pageSize) { const start = page * pageSize; return items.slice(start, start + pageSize); }\n',
  'src/access.js': 'export function assertProjectAccess(user, projectId) { if (user.projectIds.length === 0) throw new Error("denied"); }\n',
  'src/app.js': 'export function list() { return []; }\n',
  'README.md': '# Fieldnotes fixture clone\n',
};

function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function proposedRoster(runId: string, count: number): ProposedRoster {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    perspectives: Array.from({ length: count }, (_, i) => ({
      perspectiveId: `p${i + 1}`,
      name: `Perspective ${i + 1}`,
      charter: {
        incentives: `incentives ${i + 1}`,
        expertise: `expertise ${i + 1}`,
        method: `method ${i + 1}`,
        blindSpots: `blind spots ${i + 1}`,
        reviewQuestions: [`review question ${i + 1}?`],
      },
      tags: [],
    })),
  };
}

function approvedRoster(runId: string) {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    seats: [
      { seatId: 'seat-1', perspectiveId: 'p1', participantId: 'rev-1', agent: AGENT },
      { seatId: 'seat-2', perspectiveId: 'p2', participantId: 'rev-2', agent: AGENT },
    ],
  };
}

const EXPECTED_OUTPUT: Record<string, (pid: string, round: number | null) => string> = {
  organiser: () => 'organiser/roster.proposed.json',
  independent_review: (pid) => `findings/${pid}.json`,
  scribe_notes: () => 'scribe/notes.json',
  challenge: (pid, r) => `rounds/${r}/challenges/${pid}.json`,
  author_response: (pid, r) => `rounds/${r}/responses/${pid}.json`,
  scribe_synthesis: () => 'scribe/report.json',
};

const REVIEWER_FINDINGS: Record<string, FindingsFile['findings']> = {
  'rev-1': [
    {
      findingId: 'f-a1',
      title: 'Pagination skips the first page of results',
      kind: 'defect',
      severity: 'high',
      confidence: 0.9,
      evidence: [
        { kind: 'code_location', note: 'start index uses page * pageSize', path: 'src/pagination.js', startLine: 1 },
        { kind: 'repro', note: 'page 1 misses first items', steps: 'paginate([a,b,c],1,2)', observed: "returns ['c']" },
      ],
      remedies: ['use (page - 1) * pageSize'],
    },
  ],
  'rev-2': [
    {
      findingId: 'f-b1',
      title: 'Project access check never compares the project id',
      kind: 'defect',
      severity: 'critical',
      confidence: 0.85,
      evidence: [
        { kind: 'code_location', note: 'only membership count is checked', path: 'src/access.js', startLine: 1 },
      ],
    },
    {
      findingId: 'f-b2',
      title: 'No input validation on page size',
      kind: 'risk',
      severity: 'medium',
      confidence: 0.6,
      evidence: [{ kind: 'reasoned', note: 'public API accepts any integer' }],
    },
  ],
};

interface Ctx {
  runId: string;
  runDir: string;
  target: string;
  env: NodeJS.ProcessEnv;
  store: ReturnType<typeof createStore>;
  host: FakeHost;
  engine: ReturnType<typeof createEngine>;
}

async function initRun(): Promise<Ctx> {
  const dir = tmp('run');
  const target = path.join(dir, 'target');
  writeTree(target, TARGET_FILES);
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'Review the target for correctness and isolation defects.\n');
  const config = path.join(dir, 'config.json');
  // Fresh init requires an explicit complete staff — the pinned Devin lane.
  writeFileSync(
    config,
    JSON.stringify({
      requestedPerspectives: 10,
      participants: 2,
      rounds: 1,
      staff: { organiser: AGENT, scribe: AGENT, supervisor: AGENT },
    }),
  );
  const env = { COUNCIL_HOME: path.join(dir, 'council-home'), ORCA_CLI_COMMAND: NO_ORCA };

  const r = await cli(['init', '--objective', objective, '--target', target, '--config', config, '--json'], env);
  assert.equal(r.code, 0, `init failed: ${r.stdout}${r.stderr}`);
  const body = JSON.parse(r.stdout) as { ok: boolean; runId: string; runDir: string };
  assert.equal(body.ok, true);

  const store = createStore({ runDir: body.runDir });
  const host = new FakeHost();
  // Runs init'd by the CLI carry config.execution — the engine gate requires
  // the matching injected policy, exactly as the CLI injects it.
  const engine = createEngine({
    store,
    host,
    prompts: createPromptBuilder(),
    execution: CATALOG_EXECUTION_POLICY,
  });
  return { runId: body.runId, runDir: body.runDir, target, env, store, host, engine };
}

const writeArtifact = async (ctx: Ctx, rel: string, value: unknown) =>
  unwrap(await ctx.store.writeArtifact(rel, JSON.stringify(value, null, 2)));

const readJson = async (ctx: Ctx, rel: string) =>
  JSON.parse(unwrap(await ctx.store.readArtifact(rel))) as Record<string, unknown>;

/** Write the phase-appropriate worker output for one unsettled launch. */
async function completeLaunch(ctx: Ctx, l: LaunchRecord): Promise<void> {
  const { participantId, phase, round } = l.spec;
  const outRel = EXPECTED_OUTPUT[phase](participantId, round);
  const state = unwrap(await ctx.store.loadState());
  switch (phase) {
    case 'organiser':
      await writeArtifact(ctx, outRel, proposedRoster(ctx.runId, 10));
      break;
    case 'independent_review': {
      const seat = state.participants.find((p) => p.participantId === participantId);
      const file: FindingsFile = {
        schemaVersion: SCHEMA_VERSION,
        runId: ctx.runId,
        participantId,
        perspectiveId: seat!.perspectiveId!,
        findings: REVIEWER_FINDINGS[participantId] ?? [],
      };
      await writeArtifact(ctx, outRel, file);
      break;
    }
    case 'scribe_notes': {
      const ledger = await readJson(ctx, 'claims.json');
      const claims = (ledger.claims ?? []) as { claimId: string; title: string }[];
      await writeArtifact(ctx, outRel, {
        schemaVersion: SCHEMA_VERSION,
        runId: ctx.runId,
        participantId,
        claimSummaries: claims.map((c) => ({
          claimId: c.claimId,
          summary: `summary of ${c.title}`,
          possibleDuplicates: [],
          openQuestions: [],
        })),
      });
      break;
    }
    case 'challenge': {
      const env = await readJson(ctx, `rounds/${round}/envelopes/challenge/${participantId}.json`);
      const assignments = (env.assignments ?? []) as { claimId: string }[];
      await writeArtifact(ctx, outRel, {
        schemaVersion: SCHEMA_VERSION,
        runId: ctx.runId,
        round,
        participantId,
        challenges: assignments.map((a, i) => ({
          challengeId: `ch-${participantId}-${round}-${i + 1}`,
          claimId: a.claimId,
          kind: 'missing_evidence',
          argument: 'the cited evidence does not establish the claimed defect',
          evidence: [{ kind: 'reasoned', note: 'read the same file; conclusion does not follow' }],
        })),
      });
      break;
    }
    case 'author_response': {
      const env = await readJson(ctx, `rounds/${round}/envelopes/response/${participantId}.json`);
      const assignments = (env.assignments ?? []) as { claimId: string; challenges: { challengeId: string }[] }[];
      const responses = assignments.flatMap((a, ai) =>
        a.challenges.map((c, ci) => ({
          claimId: a.claimId,
          challengeId: c.challengeId,
          disposition: ai === 0 && ci === 0 ? 'defend' : 'withdraw',
          argument: ai === 0 && ci === 0 ? 'the evidence stands: the defect reproduces as cited' : 'conceded — the claim was overstated',
          evidence: [{ kind: 'reasoned', note: 'response reasoning recorded honestly' }],
        })),
      );
      await writeArtifact(ctx, outRel, {
        schemaVersion: SCHEMA_VERSION,
        runId: ctx.runId,
        round,
        participantId,
        responses,
      });
      break;
    }
    case 'scribe_synthesis': {
      const state2 = unwrap(await ctx.store.loadState());
      await writeArtifact(ctx, outRel, {
        schemaVersion: SCHEMA_VERSION,
        runId: ctx.runId,
        generatedAt: new Date().toISOString(),
        summary: 'scribe synthesis narrative: prioritized findings with preserved dissent',
        coverage: {
          requestedPerspectives: state2.config.requestedPerspectives,
          proposedPerspectives: 10,
          selectedSeats: 2,
          seats: [],
          uncoveredPerspectiveIds: [],
          partial: false,
        },
        claims: [],
        limitations: ['acceptance scribe narrative — runner owns canonical claims'],
      });
      break;
    }
  }
  ctx.host.settle(l.dispatchId);
}

/** Advance until a non-progress action, simulating each launched worker. */
async function pump(ctx: Ctx, maxSteps = 40): Promise<AdvanceResult> {
  for (let i = 0; i < maxSteps; i += 1) {
    for (const l of ctx.host.unsettled()) {
      await completeLaunch(ctx, l);
    }
    const r = unwrap(await ctx.engine.advance());
    if (r.action === 'progress') continue;
    return r;
  }
  throw new Error('pump exceeded max steps');
}

// ─── The full lifecycle ──────────────────────────────────────────────────────

/**
 * Independence check for an independent-review spec. The spec MUST name the
 * seat's own output file — which legitimately ends in `findings/<pid>.json`
 * with a platform-dependent separator (`/` on POSIX, `\` on Windows) — and
 * must NOT reference anything produced by another participant. Own path is
 * scrubbed in both separator styles before the peer-artifact scan so the
 * check means "peer leakage", not "the findings dir exists at all".
 */
function assertIndependentSpec(spec: string, participantId: string, peers: string[]): void {
  const ownSuffixes = [`findings/${participantId}.json`, `findings\\${participantId}.json`];
  assert.ok(
    ownSuffixes.some((s) => spec.includes(s)),
    `independent spec must name its own output findings/${participantId}.json`,
  );
  let scrubbed = spec;
  for (const suffix of ownSuffixes) scrubbed = scrubbed.split(suffix).join('');
  for (const peer of peers) {
    assert.ok(
      !scrubbed.includes(peer),
      `independent spec references peer participant ${peer}`,
    );
  }
  for (const pat of [
    /findings[/\\][^\s`'"]+\.json/i, // any surviving findings artifact → a peer's
    /rounds[/\\]\d+[/\\]/i, // discussion round dirs (envelopes, challenges, responses)
    /claims\.json/i, // the claim ledger
    /events\.jsonl/i, // the journal
    /roster\.(proposed|approved)\.json/i, // organiser/approval artifacts
    /scribe[/\\]/i, // scribe artifacts
  ]) {
    assert.doesNotMatch(scrubbed, pat, `independent spec references peer artifact ${pat}`);
  }
}

test('complete flow: init → organiser → approval gate → reviews → discussion → report', async () => {
  const ctx = await initRun();
  const { host, store } = ctx;

  // 1) First advance: child run + organiser launch (fresh Task, real spec file).
  let r = unwrap(await ctx.engine.advance());
  assert.equal(r.action, 'progress');
  assert.equal(host.runIds.length, 1);
  assert.equal(host.launches.length, 1);
  assert.equal(host.launches[0].spec.phase, 'organiser');
  assert.ok(existsSync(host.launches[0].spec.specFilePath), 'organiser spec written');

  // 2) Organiser produces a valid proposal → gate engages, nothing launches.
  const gate = await pump(ctx);
  assert.equal(gate.action, 'needs_approval');
  assert.equal(gate.status, 'awaiting_approval');
  assert.equal(host.launches.length, 1, 'no worker may launch before approval');
  assert.ok(existsSync(path.join(ctx.runDir, 'roster.proposed.json')));

  // 3) Approve through the REAL CLI (hash-bound, persisted).
  const rosterFile = path.join(ctx.target, 'roster.approved.json');
  writeFileSync(rosterFile, JSON.stringify(approvedRoster(ctx.runId)));
  const appr = await cli(['approve', '--run', ctx.runDir, '--roster', rosterFile, '--note', 'acceptance run', '--json'], ctx.env);
  assert.equal(appr.code, 0, appr.stdout + appr.stderr);
  const apprBody = JSON.parse(appr.stdout) as { ok: boolean; hash: string; approvalId: string };
  assert.equal(apprBody.ok, true);
  assert.match(apprBody.hash, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(path.join(ctx.runDir, 'approval.json')));
  const approved = JSON.parse(readFileSync(path.join(ctx.runDir, 'roster.approved.json'), 'utf8')) as { seats: unknown[] };
  assert.equal(approved.seats.length, 2);

  // 4) Independent review: exactly two seats launch (the gate held at 1 until now).
  r = unwrap(await ctx.engine.advance());
  assert.equal(r.action, 'progress');
  const reviewLaunches = host.launches.filter((l) => l.spec.phase === 'independent_review');
  assert.equal(reviewLaunches.length, 2);
  assert.deepEqual(
    reviewLaunches.map((l) => l.spec.participantId).sort(),
    ['rev-1', 'rev-2'],
  );
  const reviewIds = reviewLaunches.map((l) => l.spec.participantId);
  for (const l of reviewLaunches) {
    const spec = readFileSync(l.spec.specFilePath, 'utf8');
    assert.match(spec, /independent/i);
    // Own output path is required; every peer-produced artifact is forbidden.
    assertIndependentSpec(spec, l.spec.participantId, reviewIds.filter((p) => p !== l.spec.participantId));
  }

  // 5) Drive the rest: scribe notes → challenge envelopes → responses → synthesis.
  const seenPhases: string[] = [];
  const finished = await (async (): Promise<AdvanceResult> => {
    for (let i = 0; i < 60; i += 1) {
      for (const l of ctx.host.unsettled()) {
        seenPhases.push(`${l.spec.phase}${l.spec.round !== null ? ` r${l.spec.round}` : ''}`);
        await completeLaunch(ctx, l);
      }
      const step = unwrap(await ctx.engine.advance());
      if (step.action !== 'progress') return step;
    }
    throw new Error('run did not finish');
  })();

  assert.equal(finished.action, 'finished');
  assert.equal(finished.outcome, 'succeeded');
  // Every expected phase actually launched.
  assert.ok(seenPhases.includes('scribe_notes'), 'scribe notes launched');
  assert.ok(seenPhases.some((p) => p.startsWith('challenge')), 'challenge stage ran');
  assert.ok(seenPhases.some((p) => p.startsWith('author_response')), 'response stage ran');
  assert.ok(seenPhases.includes('scribe_synthesis'), 'synthesis launched');

  // 6) Final artifacts exist and are honest.
  for (const rel of ['report.json', 'report.md', 'summary.md', 'claims.json']) {
    assert.ok(existsSync(path.join(ctx.runDir, rel)), `missing ${rel}`);
  }
  const report = JSON.parse(readFileSync(path.join(ctx.runDir, 'report.json'), 'utf8')) as {
    runId: string;
    coverage: { partial: boolean; selectedSeats: number; seats: { outcome: string }[] };
    claims: { status: string; grade: string; title: string }[];
    limitations: string[];
  };
  assert.equal(report.runId, ctx.runId);
  assert.equal(report.coverage.partial, false);
  assert.equal(report.coverage.selectedSeats, 2);
  assert.ok(report.claims.length >= 2, 'claims present in report');
  const md = readFileSync(path.join(ctx.runDir, 'report.md'), 'utf8');
  assert.match(md, /Pagination|access/i);

  const ledger = JSON.parse(readFileSync(path.join(ctx.runDir, 'claims.json'), 'utf8')) as {
    claims: { status: string; history: { type: string }[] }[];
  };
  assert.ok(
    ledger.claims.some((c) => c.history.some((h) => h.type === 'challenged')),
    'at least one claim was challenged',
  );

  // The journal records the whole story and verifies as a hash chain.
  const journal = unwrap(await store.readJournal());
  const types = new Set(journal.map((e) => e.type));
  for (const t of ['launch.intent', 'worker.started', 'roster.proposed', 'approval.granted', 'artifact.admitted', 'envelope.built', 'report.written', 'run.finished']) {
    assert.ok(types.has(t as never), `journal missing ${t}`);
  }
  const fin = journal.find((e) => e.type === 'run.finished')!;
  assert.equal((fin.payload as { outcome: string }).outcome, 'succeeded');

  // Terminal state.
  const status = await cli(['status', '--run', ctx.runDir, '--json'], ctx.env);
  const statusBody = JSON.parse(status.stdout) as { status: string; quorum: { met: boolean } };
  assert.equal(statusBody.status, 'reported');
});

test('approval invalidates on source drift — advance blocks until re-approved', async () => {
  const ctx = await initRun();
  unwrap(await ctx.engine.advance());
  const gate = await pump(ctx);
  assert.equal(gate.action, 'needs_approval');

  const rosterFile = path.join(ctx.target, 'roster.approved.json');
  writeFileSync(rosterFile, JSON.stringify(approvedRoster(ctx.runId)));
  const appr = await cli(['approve', '--run', ctx.runDir, '--roster', rosterFile, '--json'], ctx.env);
  assert.equal(appr.code, 0);

  // Drift the reviewed tree after approval.
  writeFileSync(path.join(ctx.target, 'src', 'app.js'), 'export function list() { return ["drifted"]; }\n');

  const r = unwrap(await ctx.engine.advance());
  assert.equal(r.action, 'blocked');
  assert.match(r.note ?? '', /snapshot|drift/i);
  assert.equal(ctx.host.launches.filter((l) => l.spec.phase === 'independent_review').length, 0, 'no reviewer launched past a stale approval');

  const journal = unwrap(await ctx.store.readJournal());
  assert.ok(journal.some((e) => e.type === 'snapshot.drift'));
});

test('engine.cancel confirms stops through the host adapter', async () => {
  const ctx = await initRun();
  unwrap(await ctx.engine.advance());
  const gate = await pump(ctx);
  assert.equal(gate.action, 'needs_approval');
  const rosterFile = path.join(ctx.target, 'roster.approved.json');
  writeFileSync(rosterFile, JSON.stringify(approvedRoster(ctx.runId)));
  assert.equal((await cli(['approve', '--run', ctx.runDir, '--roster', rosterFile, '--json'], ctx.env)).code, 0);
  const adv = unwrap(await ctx.engine.advance()); // reviewers launch, still unsettled
  assert.equal(ctx.host.unsettled().length, 2, `advance=${JSON.stringify(adv)}`);

  unwrap(await ctx.engine.cancel({ reason: 'operator stop' }));
  assert.equal(ctx.host.stops.length, 2, 'requestStop once per live dispatch');
  const st = unwrap(await ctx.store.loadState());
  assert.equal(st.status, 'cancelled');
  for (const p of st.participants.filter((x) => x.role === 'reviewer')) {
    assert.ok(p.attempts.every((a) => a.status === 'stopped'), 'reviewer attempts stopped');
  }
  const journal = unwrap(await ctx.store.readJournal());
  assert.equal(journal.filter((e) => e.type === 'worker.stopped').length, 2);
});

test('council cancel reports confirmed vs unverifiable stops honestly', async () => {
  const ctx = await initRun();
  unwrap(await ctx.engine.advance());
  const gate = await pump(ctx);
  assert.equal(gate.action, 'needs_approval');
  const rosterFile = path.join(ctx.target, 'roster.approved.json');
  writeFileSync(rosterFile, JSON.stringify(approvedRoster(ctx.runId)));
  assert.equal((await cli(['approve', '--run', ctx.runDir, '--roster', rosterFile, '--json'], ctx.env)).code, 0);
  const adv = unwrap(await ctx.engine.advance());
  assert.equal(ctx.host.unsettled().length, 2, `advance=${JSON.stringify(adv)}`);

  // The CLI's adapter cannot resolve (ORCA_CLI_COMMAND is dead): the run still
  // cancels, but stop confirmations are honestly unverifiable — not faked.
  const res = await cli(['cancel', '--run', ctx.runDir, '--reason', 'operator stop', '--json'], ctx.env);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const body = JSON.parse(res.stdout) as {
    status: string;
    confirmedStopped: string[];
    unverifiable: string[];
    note: string;
  };
  assert.equal(body.status, 'cancelled');
  assert.equal(body.confirmedStopped.length, 0);
  assert.equal(body.unverifiable.length, 2);
  assert.match(body.note, /not proven stopped|unverifiable/i);
});

// ─── Independence-check regression ───────────────────────────────────────────
// The complete-flow assertion once failed on POSIX because the seat's OWN
// output path (`…/findings/rev-1.json`) matched the peer-artifact pattern —
// on Windows it never did (`…\findings\rev-1.json`). These cases pin the
// helper's contract on both separator styles so neither platform can regress.

test('independence check accepts the own output path on POSIX and Windows separators', () => {
  const posix = [
    'You are the independent reviewer for participant `rev-1`.',
    'Write exactly one JSON file at this path:',
    '`/tmp/run/findings/rev-1.json`',
    'Report worker_done with `--report-path /tmp/run/findings/rev-1.json`.',
  ].join('\n');
  const windows = [
    'You are the independent reviewer for participant `rev-1`.',
    'Write exactly one JSON file at this path:',
    '`C:\\work\\run\\findings\\rev-1.json`',
    'Report worker_done with `--report-path C:\\work\\run\\findings\\rev-1.json`.',
  ].join('\n');
  assert.doesNotThrow(() => assertIndependentSpec(posix, 'rev-1', ['rev-2']));
  assert.doesNotThrow(() => assertIndependentSpec(windows, 'rev-1', ['rev-2']));
});

test('independence check rejects peer leakage on POSIX and Windows separators', () => {
  const leaks = [
    '/tmp/run/findings/rev-2.json', // peer findings, POSIX
    'C:\\work\\run\\findings\\rev-2.json', // peer findings, Windows
    '/tmp/run/rounds/1/envelopes/challenge/rev-1.json', // own-named envelope is still peer content
    'C:\\work\\run\\rounds\\2\\envelopes\\response\\rev-1.json',
    '/tmp/run/claims.json',
    'ask rev-2 what it found', // a peer identity, not a path
  ];
  for (const leak of leaks) {
    const spec = `own output \`/tmp/run/findings/rev-1.json\`\npeer material: ${leak}`;
    assert.throws(
      () => assertIndependentSpec(spec, 'rev-1', ['rev-2']),
      /peer|references|leaks/i,
      `must reject spec containing ${leak}`,
    );
  }
});

// ─── Null-task intent recovery (the live-smoke crash shape) ─────────────────
// The real saved run: supervisor restart → reviewer task-create refused with
// "Nothing changed" → attempt stuck intent_recorded with null ids. The engine
// must (1) refuse to blind-retry that task-create on the next advance and
// (2) resume cleanly once `council reconcile` has persisted a verified taskId.

test('engine guards a failed task-create and resumes through a reconciled taskId', async () => {
  const ctx = await initRun();
  unwrap(await ctx.engine.advance());
  const gate = await pump(ctx);
  assert.equal(gate.action, 'needs_approval');
  const rosterFile = path.join(ctx.target, 'roster.approved.json');
  writeFileSync(rosterFile, JSON.stringify(approvedRoster(ctx.runId)));
  assert.equal((await cli(['approve', '--run', ctx.runDir, '--roster', rosterFile, '--json'], ctx.env)).code, 0);

  // Sabotage the host exactly once: the next task-create is definitively
  // refused (the crashed-supervisor binding failure), then heals.
  const realCreateTask = ctx.host.createTask.bind(ctx.host);
  let refuseTaskCreate = true;
  let createCalls = 0;
  ctx.host.createTask = async (input: { runId: string; specFilePath: string; title: string }) => {
    createCalls += 1;
    if (refuseTaskCreate) {
      return {
        ok: false as const,
        error: {
          code: 'adapter_error',
          message:
            'This caller is not bound to Run fake-orca-run-1, which is bound to term_deadbeef. Nothing changed. Orchestration mutation request ID: 74a45889-c510-491e-9598-26264fc8f5c7.',
        },
      };
    }
    return realCreateTask(input);
  };

  // 1) First reviewer task-create fails → blocked, null-task intent persisted.
  const r1 = unwrap(await ctx.engine.advance());
  assert.equal(r1.action, 'blocked');
  assert.match(r1.note ?? '', /reconcile|intent/i);
  const st1 = unwrap(await ctx.store.loadState());
  const victim = st1.participants
    .flatMap((p) => p.attempts)
    .find((a) => a.phase === 'independent_review' && a.status === 'intent_recorded')!;
  assert.equal(victim.taskId, null);
  assert.equal(victim.dispatchId, null);
  const callsAfterFailure = createCalls;

  // 2) The journal-derived guard refuses a blind retry — no second createTask.
  const r2 = unwrap(await ctx.engine.advance());
  assert.equal(r2.action, 'blocked');
  assert.equal(createCalls, callsAfterFailure, 'engine must not retry a definitively refused task-create');
  assert.equal(ctx.host.launches.filter((l) => l.spec.phase === 'independent_review').length, 0);

  // 3) `council reconcile` persists the verified taskId + task.created event.
  const reconciledTaskId = 'task_reconciled_1';
  unwrap(
    await ctx.store.withLock(async () => {
      const st = await ctx.store.loadState();
      if (!st.ok) return st;
      const att = st.value.participants
        .flatMap((p) => p.attempts)
        .find((a) => a.attemptId === victim.attemptId)!;
      att.taskId = reconciledTaskId;
      const w = await ctx.store.saveState(st.value);
      if (!w.ok) return w;
      return ctx.store.appendJournal([
        {
          ts: new Date().toISOString(),
          type: 'task.created',
          actor: 'engine',
          phase: 'independent_review',
          participantId: victim.participantId,
          payload: { attemptId: victim.attemptId, taskId: reconciledTaskId, scope: 'task', reconciled: 'created' },
        },
      ]);
    }),
  );

  // 4) The reconciled attempt launches on the persisted taskId — the null-task
  //    guard is bypassed ONLY by the journaled reconciliation, and the peer
  //    reviewer still takes the normal createTask path.
  refuseTaskCreate = false;
  const r3 = unwrap(await ctx.engine.advance());
  assert.equal(r3.action, 'progress');
  const recovered = ctx.host.launches.find((l) => l.spec.participantId === victim.participantId)!;
  assert.equal(recovered.spec.taskId, reconciledTaskId, 'launch must use the reconciled task id, never a relaunched task');
  const state3 = unwrap(await ctx.store.loadState());
  const healed = state3.participants
    .flatMap((p) => p.attempts)
    .find((a) => a.attemptId === victim.attemptId)!;
  assert.equal(healed.status, 'dispatched');
  assert.equal(healed.taskId, reconciledTaskId);
});
