/**
 * Progress module tests: fake clock + fake sendMail, real tmp run dirs, and
 * one real argv-spawn helper smoke. No live Orca, no real agents.
 *
 * Covers: every lifecycle milestone, durable dedupe (incl. crash-inflight and
 * restart-window), unknown/throw/timeout custody, single no-effects retry,
 * separate stage/heartbeat budgets, terminal-state write silence, recipient
 * capture/upgrade/override/rejection, lease singleton + reclaim rules,
 * helper tick/exit paths, and read-only progressStatus.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CouncilState, Result, RunStatus } from '../src/contracts.js';
import {
  captureRecipient,
  createProgressNotifier,
  ensureHelper,
  loadRecipient,
  progressStatus,
  runHelperLoop,
  HELPER_LEASE_FILE,
  HELPER_STATE_FILE,
  OUTBOX_FILE,
  PROGRESS_DIR,
  RECIPIENT_FILE,
  type ProgressOutbox,
  type ProgressSendMail,
} from '../src/progress.js';

const T0 = Date.parse('2026-11-19T12:00:00.000Z');
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = (error: { code: string; message: string; details?: Record<string, unknown> }): Result<never> => ({
  ok: false,
  error: error as never,
});

function unwrap<T>(r: Result<T>): T {
  assert.ok(r.ok, r.ok ? '' : `${r.error.code}: ${r.error.message}`);
  return r.value;
}

const CLEANUP: string[] = [];
after(() => {
  for (const d of CLEANUP) rmSync(d, { recursive: true, force: true });
});

function tmpRun(): string {
  const d = mkdtempSync(join(tmpdir(), 'pgx-'));
  CLEANUP.push(d);
  return d;
}

function makeConfig(): CouncilState['config'] {
  return {
    schemaVersion: 1,
    requestedPerspectives: 15,
    participants: 3,
    concurrency: 2,
    rounds: 2,
    quorumRatio: 0.67,
    maxLaunches: 30,
    maxFindingsPerSeat: 3,
    maxChallengesPerSeatPerRound: 3,
    maxResponsesPerSeatPerRound: 3,
    envelopeBytes: 8192,
    maxMailPerParticipant: 6,
    maxTextChars: 4000,
    deadlines: {
      organiserMs: 1_800_000,
      independentMs: 14_400_000,
      scribeNotesMs: 3_600_000,
      challengeMs: 7_200_000,
      responseMs: 7_200_000,
      synthesisMs: 7_200_000,
      runMs: 86_400_000,
      graceMs: 1_800_000,
    },
  };
}

function makeState(over: Partial<CouncilState> = {}): CouncilState {
  return {
    schemaVersion: 1,
    runId: 'crun_test',
    orcaRunId: 'run_child9',
    status: 'organising',
    targetRoot: '/target',
    objective: 'objective',
    config: makeConfig(),
    snapshotId: 'snap_1',
    approvalHash: null,
    participants: [],
    discussion: null,
    supervisor: null,
    consumption: { launches: 2, mailSent: 1 },
    phaseEnteredAt: new Date(T0).toISOString(),
    createdAt: new Date(T0).toISOString(),
    ...over,
  };
}

function writeState(runDir: string, state: CouncilState): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(state));
}

function readJson(runDir: string, rel: string): unknown {
  return JSON.parse(readFileSync(join(runDir, rel), 'utf8'));
}

function readOutboxFile(runDir: string): ProgressOutbox {
  return readJson(runDir, OUTBOX_FILE) as ProgressOutbox;
}

interface SentMail {
  to: string;
  subject: string;
  body: string;
}

function fakeSend(impl?: (i: SentMail) => Result<{ outcome: 'sent' | 'unknown'; requestId?: string; messageId?: string }>) {
  const calls: SentMail[] = [];
  const send: ProgressSendMail = async (input) => {
    calls.push({ to: input.to, subject: input.subject, body: input.body });
    if (impl !== undefined) return impl(input);
    return ok({ outcome: 'sent', requestId: `req_${calls.length}`, messageId: `msg_${calls.length}` });
  };
  return { calls, send };
}

async function capture(runDir: string, over: Partial<Parameters<typeof captureRecipient>[0]> = {}) {
  return captureRecipient({
    runDir,
    callerRunId: 'run_primary',
    callerHandle: 'term_primary',
    self: { orcaRunId: 'run_child9' },
    ...over,
  });
}

// ─── captureRecipient ───────────────────────────────────────────────────────

test('captureRecipient prefers durable caller Run, writes recipient.json once', async () => {
  const dir = tmpRun();
  const r = unwrap(await capture(dir));
  assert.equal(r.recipient.to, 'run:run_primary');
  assert.equal(r.recipient.source, 'caller_run');
  assert.equal(r.changed, true);

  // Second capture with a different run: first durable target wins.
  const again = unwrap(await capture(dir, { callerRunId: 'run_other' }));
  assert.equal(again.recipient.to, 'run:run_primary');
  assert.equal(again.changed, false);
  assert.equal(again.recipient.observations?.length, 1);
  assert.equal(again.recipient.observations?.[0].to, 'run:run_other');
});

test('captureRecipient falls back to terminal handle, then upgrades to Run', async () => {
  const dir = tmpRun();
  const first = unwrap(await capture(dir, { callerRunId: null }));
  assert.equal(first.recipient.to, 'term_primary');
  assert.equal(first.recipient.source, 'caller_terminal');

  const up = unwrap(await capture(dir, { callerRunId: 'run_primary' }));
  assert.equal(up.recipient.to, 'run:run_primary');
  assert.equal(up.recipient.source, 'caller_run');
  assert.equal(up.changed, true);
});

test('captureRecipient explicit target overrides; identical re-capture is a no-op', async () => {
  const dir = tmpRun();
  await capture(dir);
  const exp = unwrap(await capture(dir, { to: 'dispatch:ctx_explicit' }));
  assert.equal(exp.recipient.to, 'dispatch:ctx_explicit');
  assert.equal(exp.recipient.source, 'explicit');
  assert.equal(exp.changed, true);
  const noop = unwrap(await capture(dir, { to: 'dispatch:ctx_explicit' }));
  assert.equal(noop.changed, false);
});

test('captureRecipient rejects self/child and malformed targets', async () => {
  const dir = tmpRun();
  const selfRun = await capture(dir, { callerRunId: 'run_child9' });
  assert.equal(selfRun.ok, false);
  assert.match(selfRun.ok ? '' : selfRun.error.message, /own child Run/);

  const selfTerm = await capture(dir, {
    callerRunId: null,
    callerHandle: 'term_sup',
    self: { supervisorHandle: 'term_sup' },
  });
  assert.equal(selfTerm.ok, false);
  assert.match(selfTerm.ok ? '' : selfTerm.error.message, /supervisor terminal/);

  const childDisp = await capture(dir, {
    to: 'dispatch:ctx_councilworker',
    self: { councilDispatchIds: ['ctx_councilworker'] },
  });
  assert.equal(childDisp.ok, false);
  assert.match(childDisp.ok ? '' : childDisp.error.message, /council-owned dispatch/);

  const bad = await capture(dir, { to: 'not a target' });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok ? '' : bad.error.code, 'config_invalid');

  const noEvidence = await capture(dir, { callerRunId: null, callerHandle: undefined });
  assert.equal(noEvidence.ok, false);
  assert.equal(existsSync(join(dir, RECIPIENT_FILE)), false);
});

test('captureRecipient serializes concurrent captures — one winner', async () => {
  const dir = tmpRun();
  const [a, b] = await Promise.all([
    capture(dir, { callerRunId: 'run_A' }),
    capture(dir, { callerRunId: 'run_B' }),
  ]);
  assert.equal(a.ok && b.ok, true);
  const kept = unwrap(await loadRecipient(dir))!;
  // First lock winner persists; the loser observed and kept it.
  assert.ok(['run:run_A', 'run:run_B'].includes(kept.to));
  assert.equal(kept.observations?.length, 1);
});

// ─── stage milestones ───────────────────────────────────────────────────────

async function notifiedRun(over: Partial<CouncilState> = {}) {
  const dir = tmpRun();
  writeState(dir, makeState(over));
  await capture(dir);
  return dir;
}

test('stage milestones send once each with persisted counts; repeats dedupe', async () => {
  const dir = await notifiedRun({ status: 'organising' });
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0 + 60_000) });

  const r1 = unwrap(await n.notify({ kind: 'stage', status: 'organising' }));
  assert.equal(r1.outcome, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'run:run_primary');
  assert.match(calls[0].subject, /organiser/);
  assert.match(calls[0].body, /launches: 2\/30/);
  assert.match(calls[0].body, /does not verify worker or host liveness/);

  const r2 = unwrap(await n.notify({ kind: 'stage', status: 'organising' }));
  assert.equal(r2.outcome, 'deduped');
  assert.equal(calls.length, 1);

  // Fresh notifier instance: dedupe is durable, not in-memory.
  const n2 = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0 + 90_000) });
  const r3 = unwrap(await n2.notify({ kind: 'stage', status: 'organising' }));
  assert.equal(r3.outcome, 'deduped');
  assert.equal(calls.length, 1);
});

test('every lifecycle stage notifies: awaiting approval, approval, stages, finished', async () => {
  const dir = await notifiedRun({ status: 'awaiting_approval', approvalHash: 'abc123def4567890' });
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });

  const stages: [RunStatus, RegExp][] = [
    ['awaiting_approval', /awaiting roster approval/],
    ['independent_review', /independent review/],
    ['scribe_notes', /scribe notes/],
  ];
  for (const [status, re] of stages) {
    writeState(dir, makeState({ status, approvalHash: 'abc123def4567890' }));
    const r = unwrap(await n.notify({ kind: 'stage', status }));
    assert.equal(r.outcome, 'sent', `stage ${status}`);
    assert.match(calls[calls.length - 1].subject, re);
  }

  const ap = unwrap(await n.notify({ kind: 'approval' }));
  assert.equal(ap.outcome, 'sent');
  assert.match(calls[calls.length - 1].subject, /approval granted/);

  writeState(dir, makeState({ status: 'reported' }));
  const fin = unwrap(await n.notify({ kind: 'finished', outcome: 'succeeded', reportPaths: ['report.md', 'report.json', 'summary.md'] }));
  assert.equal(fin.outcome, 'sent');
  assert.match(calls[calls.length - 1].body, /report\.md/);
  assert.match(calls[calls.length - 1].subject, /finished: succeeded/);

  // Distinct intents: 3 stages + approval + finished = 5 deliveries
  const box = readOutboxFile(dir);
  assert.equal(box.deliveries.length, 5);
  assert.equal(calls.length, 5);
});

test('discussion cursor round/stage produce distinct intents', async () => {
  const dir = await notifiedRun();
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });

  writeState(dir, makeState({ status: 'discussing', discussion: { round: 1, stage: 'challenges' } }));
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'discussing' })).outcome, 'sent');
  assert.match(calls[0].subject, /round 1 challenges/);

  writeState(dir, makeState({ status: 'discussing', discussion: { round: 1, stage: 'responses' } }));
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'discussing' })).outcome, 'sent');

  writeState(dir, makeState({ status: 'discussing', discussion: { round: 2, stage: 'challenges' } }));
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'discussing' })).outcome, 'sent');
  assert.match(calls[2].subject, /round 2 challenges/);

  // Same cursor again → deduped
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'discussing' })).outcome, 'deduped');
  assert.equal(calls.length, 3);
});

test('blocked dedupes on reason; distinct blockers each notify once', async () => {
  const dir = await notifiedRun({ status: 'independent_review' });
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });

  assert.equal(unwrap(await n.notify({ kind: 'blocked', reason: 'task_error: launch unknown' })).outcome, 'sent');
  assert.equal(unwrap(await n.notify({ kind: 'blocked', reason: 'task_error: launch unknown' })).outcome, 'deduped');
  assert.equal(unwrap(await n.notify({ kind: 'blocked', reason: 'budget exceeded' })).outcome, 'sent');
  assert.equal(calls.length, 2);
  assert.match(calls[0].body, /resolve blocker/);
});

test('terminal status via stage shares the finished intent — no double wake', async () => {
  const dir = await notifiedRun({ status: 'reported' });
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });

  assert.equal(unwrap(await n.notify({ kind: 'finished', outcome: 'succeeded' })).outcome, 'sent');
  // An advance retry that reports status as a stage event must dedupe, not resend.
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'reported' })).outcome, 'deduped');
  assert.equal(calls.length, 1);
});

test('no sends or new intents after terminal state — heartbeat and blocked skip', async () => {
  const dir = await notifiedRun({ status: 'reported' });
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });

  assert.equal(unwrap(await n.notify({ kind: 'heartbeat' })).outcome, 'skipped_terminal');
  assert.equal(unwrap(await n.notify({ kind: 'blocked', reason: 'late' })).outcome, 'skipped_terminal');
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'discussing' })).outcome, 'skipped_terminal');
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(dir, OUTBOX_FILE)), false);
});

test('no recipient → clean outcome, nothing persisted or sent', async () => {
  const dir = tmpRun();
  writeState(dir, makeState());
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });
  const r = unwrap(await n.notify({ kind: 'stage', status: 'organising' }));
  assert.equal(r.outcome, 'no_recipient');
  assert.equal(calls.length, 0);
  assert.equal(existsSync(join(dir, OUTBOX_FILE)), false);
});

test('malformed recipient file → send-time revalidation fails safe', async () => {
  const dir = await notifiedRun();
  writeFileSync(join(dir, RECIPIENT_FILE), JSON.stringify({ wrong: 'shape' }));
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'organising' })).outcome, 'no_recipient');

  // Recipient pointing at the council's own child Run → refused, recorded, never sent.
  writeFileSync(
    join(dir, RECIPIENT_FILE),
    JSON.stringify({ schemaVersion: 1, to: 'run:run_child9', source: 'explicit', recordedAt: new Date(T0).toISOString() }),
  );
  const r2 = unwrap(await n.notify({ kind: 'stage', status: 'organising' }));
  assert.equal(r2.outcome, 'invalid_recipient');
  assert.equal(calls.length, 0);
  const box = readOutboxFile(dir);
  assert.equal(box.deliveries[0].delivery, 'invalid_recipient');
});

// ─── custody: unknown / crash / refused / timeout ───────────────────────────

test('unknown delivery is retained and never resent', async () => {
  const dir = await notifiedRun();
  const { calls, send } = fakeSend(() => ok({ outcome: 'unknown', requestId: 'req_u1' }));
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });

  const r = unwrap(await n.notify({ kind: 'stage', status: 'organising' }));
  assert.equal(r.outcome, 'unknown');
  assert.equal(r.requestId, 'req_u1');
  const d = readOutboxFile(dir).deliveries[0];
  assert.equal(d.delivery, 'unknown');
  assert.equal(d.requestId, 'req_u1');

  // Retries of the same milestone dedupe — an unknown is possibly landed.
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'organising' })).outcome, 'deduped');
  assert.equal(calls.length, 1);
});

test('thrown sendMail and generic Result error both map to unknown custody', async () => {
  const dir = await notifiedRun();
  const { send: thrower } = fakeSend(() => {
    throw new Error('adapter exploded');
  });
  const n = createProgressNotifier({ runDir: dir, sendMail: thrower, now: () => new Date(T0) });
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'organising' })).outcome, 'unknown');

  const dir2 = await notifiedRun();
  const { send: generic } = fakeSend(() => failRes({ code: 'adapter_error', message: 'mystery' }));
  const n2 = createProgressNotifier({ runDir: dir2, sendMail: generic, now: () => new Date(T0) });
  assert.equal(unwrap(await n2.notify({ kind: 'stage', status: 'organising' })).outcome, 'unknown');
  // Neither is retried — possibly landed.
  assert.equal(unwrap(await n2.notify({ kind: 'stage', status: 'organising' })).outcome, 'deduped');
});

test('proven no-effects refusal retries exactly once, then refuses final', async () => {
  const dir = await notifiedRun();
  const { calls, send } = fakeSend(() =>
    failRes({ code: 'adapter_error', message: 'definitely refused', details: { uncertain: false } }),
  );
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });

  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'organising' })).outcome, 'refused');
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'organising' })).outcome, 'refused_final');
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'organising' })).outcome, 'deduped');
  assert.equal(calls.length, 2);
  assert.equal(readOutboxFile(dir).deliveries[0].attempts, 2);
});

test('crash between intent and send leaves sending custody — never resent', async () => {
  const dir = await notifiedRun();
  // Pre-seed an outbox whose intent never got a receipt (crash mid-send).
  mkdirSync(join(dir, PROGRESS_DIR), { recursive: true });
  const box: ProgressOutbox = {
    schemaVersion: 1,
    runId: 'crun_test',
    counters: { stage: 1, heartbeat: 0, budgetRefusals: 0 },
    deliveries: [
      {
        intentId: 'stage:organising',
        kind: 'stage',
        stageKey: 'organising',
        subject: 'x',
        body: 'y',
        recipient: 'run:run_primary',
        createdAt: new Date(T0).toISOString(),
        attempts: 1,
        delivery: 'sending',
      },
    ],
  };
  writeFileSync(join(dir, OUTBOX_FILE), JSON.stringify(box));

  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0 + 60_000) });
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'organising' })).outcome, 'deduped');
  assert.equal(calls.length, 0);
});

test('send timeout marks unknown; a late send result cannot overwrite custody', async () => {
  const dir = await notifiedRun();
  let resolveLate!: (v: Result<{ outcome: 'sent'; messageId: string }>) => void;
  const hanging: ProgressSendMail = () =>
    new Promise((res) => {
      resolveLate = res;
    });
  const n = createProgressNotifier({ runDir: dir, sendMail: hanging, sendTimeoutMs: 80, now: () => new Date(T0) });
  const r = unwrap(await n.notify({ kind: 'stage', status: 'organising' }));
  assert.equal(r.outcome, 'unknown');
  assert.match(r.detail ?? '', /timed out/);

  // The hanging send "completes" afterwards — delivery stays unknown.
  resolveLate(ok({ outcome: 'sent', messageId: 'late' }));
  await new Promise((r2) => setTimeout(r2, 30));
  const d = readOutboxFile(dir).deliveries[0];
  assert.equal(d.delivery, 'unknown');
  assert.equal(d.messageId, undefined);
});

// ─── budgets ────────────────────────────────────────────────────────────────

test('stage budget is finite, charged at intent, durable across instances', async () => {
  const dir = await notifiedRun({ status: 'independent_review' });
  const { calls, send } = fakeSend(() => ok({ outcome: 'unknown' }));
  const mk = () => createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0), budget: { stageMax: 2 } });

  // Distinct stage events to spend the budget.
  writeState(dir, makeState({ status: 'discussing', discussion: { round: 1, stage: 'challenges' } }));
  assert.equal(unwrap(await mk().notify({ kind: 'stage', status: 'discussing' })).outcome, 'unknown');
  writeState(dir, makeState({ status: 'discussing', discussion: { round: 1, stage: 'responses' } }));
  assert.equal(unwrap(await mk().notify({ kind: 'stage', status: 'discussing' })).outcome, 'unknown');
  // Third distinct event exceeds cap — unknowns still charged it.
  writeState(dir, makeState({ status: 'discussing', discussion: { round: 2, stage: 'challenges' } }));
  assert.equal(unwrap(await mk().notify({ kind: 'stage', status: 'discussing' })).outcome, 'budget_refused');
  assert.equal(calls.length, 2);
  const box = readOutboxFile(dir);
  assert.equal(box.counters.stage, 2);
  assert.equal(box.counters.budgetRefusals, 1);
});

test('heartbeat budget is separate from stage budget', async () => {
  const dir = await notifiedRun();
  const { calls, send } = fakeSend();
  let t = T0;
  const n = createProgressNotifier({
    runDir: dir,
    sendMail: send,
    now: () => new Date(t),
    budget: { heartbeatMax: 2, stageMax: 1 },
    heartbeatIntervalMs: 60_000,
  });
  assert.equal(unwrap(await n.notify({ kind: 'heartbeat' })).outcome, 'sent');
  t += 61_000;
  assert.equal(unwrap(await n.notify({ kind: 'heartbeat' })).outcome, 'sent');
  t += 61_000;
  assert.equal(unwrap(await n.notify({ kind: 'heartbeat' })).outcome, 'budget_refused');
  // Stage budget untouched by heartbeat spend.
  assert.equal(unwrap(await n.notify({ kind: 'stage', status: 'organising' })).outcome, 'sent');
  assert.equal(calls.length, 3);
});

test('heartbeat dedupes per window across helper restarts', async () => {
  const dir = await notifiedRun();
  const { calls, send } = fakeSend();
  let t = T0;
  const mk = () =>
    createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(t), heartbeatIntervalMs: 120_000 });
  assert.equal(unwrap(await mk().notify({ kind: 'heartbeat' })).outcome, 'sent');
  // Same window, "new helper" → deduped, no resend.
  assert.equal(unwrap(await mk().notify({ kind: 'heartbeat' })).outcome, 'deduped');
  t += 121_000;
  assert.equal(unwrap(await mk().notify({ kind: 'heartbeat' })).outcome, 'sent');
  assert.equal(calls.length, 2);
});

// ─── body content ───────────────────────────────────────────────────────────

test('deadline breach warns honestly; counts reflect persisted participants', async () => {
  const dir = tmpRun();
  const state = makeState({
    status: 'independent_review',
    phaseEnteredAt: new Date(T0 - 20_000_000).toISOString(), // way past deadline+grace
    participants: [
      { participantId: 'p1', role: 'reviewer', seatId: 's1', perspectiveId: 'x', agent: { agent: 'devin', model: 'm', permissionMode: 'bypass' }, retainedTerminal: null, attempts: [], status: 'settled' },
      { participantId: 'p2', role: 'reviewer', seatId: 's2', perspectiveId: 'y', agent: { agent: 'devin', model: 'm', permissionMode: 'bypass' }, retainedTerminal: null, attempts: [], status: 'active' },
    ],
  });
  writeState(dir, state);
  await capture(dir);
  const { calls, send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });
  assert.equal(unwrap(await n.notify({ kind: 'heartbeat' })).outcome, 'sent');
  assert.match(calls[0].body, /WARNING: stage exceeded its persisted deadline\+grace/);
  assert.match(calls[0].body, /may be stalled/);
  assert.match(calls[0].body, /seats: 1\/2 settled/);
});

// ─── ensureHelper ───────────────────────────────────────────────────────────

test('ensureHelper skips terminal/no-state/no-recipient runs', async () => {
  const dirEmpty = tmpRun();
  assert.equal(unwrap(await ensureHelper({ runDir: dirEmpty })).state, 'skipped_no_state');

  const dirTerm = await notifiedRun({ status: 'reported' });
  assert.equal(unwrap(await ensureHelper({ runDir: dirTerm })).state, 'skipped_terminal');

  const dirNoRec = tmpRun();
  writeState(dirNoRec, makeState());
  assert.equal(unwrap(await ensureHelper({ runDir: dirNoRec })).state, 'no_recipient');
  assert.equal(existsSync(join(dirNoRec, HELPER_LEASE_FILE)), false);
});

test('ensureHelper spawns argv child once; second call reports already_running', async () => {
  const dir = await notifiedRun();
  const spawns: { file: string; args: string[] }[] = [];
  const spawnFn = (plan: { file: string; args: string[] }) => {
    spawns.push(plan);
    return ok({ pid: 424_242 });
  };
  const r = unwrap(await ensureHelper({ runDir: dir, spawnFn }));
  assert.equal(r.state, 'started');
  assert.equal(r.pid, 424_242);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, process.execPath);
  // argv: [module.js, 'helper', '--run', dir, '--interval-ms', ..., '--nonce', n, ...]
  const a = spawns[0].args;
  assert.equal(a[1], 'helper');
  assert.ok(a.includes('--run') && a.includes(dir));
  assert.ok(a.includes('--nonce'));
  assert.ok(a.every((x) => typeof x === 'string'));

  const again = unwrap(await ensureHelper({ runDir: dir, spawnFn }));
  assert.equal(again.state, 'already_running');
  assert.equal(spawns.length, 1);
});

test('lease reclaim: expired + dead owner → new helper; alive/unproven → refuse', async () => {
  const dir = await notifiedRun();
  const leasePath = join(dir, HELPER_LEASE_FILE);
  mkdirSync(join(dir, PROGRESS_DIR), { recursive: true });

  // Expired lease owned by a pid that cannot exist (2^22 is safely dead).
  // Times are real-clock relative: T0 is a fixture instant, not "now".
  const deadPid = 4_194_304;
  writeFileSync(
    leasePath,
    JSON.stringify({ nonce: 'old', pid: deadPid, startedAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 5_000).toISOString() }),
  );
  const spawns: { file: string; args: string[] }[] = [];
  const r = unwrap(await ensureHelper({ runDir: dir, spawnFn: (p) => { spawns.push(p); return ok({ pid: 555 }); } }));
  assert.equal(r.state, 'started');
  assert.equal(spawns.length, 1);
  const newLease = readJson(dir, HELPER_LEASE_FILE) as { nonce: string; pid: number };
  assert.notEqual(newLease.nonce, 'old');
  assert.equal(newLease.pid, 555);

  // Unexpired lease with live pid (our own process) → already_running.
  writeFileSync(
    leasePath,
    JSON.stringify({ nonce: 'live', pid: process.pid, startedAt: new Date(T0).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  );
  const held = unwrap(await ensureHelper({ runDir: dir, spawnFn: (p) => { spawns.push(p); return ok({ pid: 556 }); } }));
  assert.equal(held.state, 'already_running');
  assert.equal(spawns.length, 1);

  // Expired lease but owner pid still alive → refuse to risk two helpers.
  writeFileSync(
    leasePath,
    JSON.stringify({ nonce: 'zombie', pid: process.pid, startedAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() }),
  );
  const refused = unwrap(await ensureHelper({ runDir: dir, spawnFn: (p) => { spawns.push(p); return ok({ pid: 557 }); } }));
  assert.equal(refused.state, 'error');
  assert.match(refused.detail ?? '', /unverifiable|alive/);
  assert.equal(spawns.length, 1);
});

test('spawn failure rolls back the lease', async () => {
  const dir = await notifiedRun();
  const r = unwrap(await ensureHelper({
    runDir: dir,
    spawnFn: () => failRes({ code: 'io_error', message: 'no node' }),
  }));
  assert.equal(r.state, 'spawn_failed');
  assert.equal(existsSync(join(dir, HELPER_LEASE_FILE)), false);
});

// ─── helper loop ────────────────────────────────────────────────────────────

function seedLease(runDir: string, nonce: string): void {
  mkdirSync(join(runDir, PROGRESS_DIR), { recursive: true });
  writeFileSync(
    join(runDir, HELPER_LEASE_FILE),
    JSON.stringify({ nonce, pid: null, startedAt: new Date(T0).toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() }),
  );
}

test('helper loop ticks heartbeats, renews lease, exits on terminal state', async () => {
  const dir = await notifiedRun({ status: 'independent_review' });
  const nonce = 'n1';
  seedLease(dir, nonce);
  const { calls, send } = fakeSend();
  let t = T0;
  let ticks = 0;
  const sleep = async () => {
    ticks += 1;
    t += 120_000;
    if (ticks === 2) writeState(dir, makeState({ status: 'reported' }));
  };
  const res = unwrap(await runHelperLoop({
    runDir: dir,
    nonce,
    intervalMs: 120_000,
    maxLifetimeMs: 3_600_000,
    sendMail: send,
    now: () => new Date(t),
    sleep,
  }));
  assert.equal(res.exitReason, 'terminal:reported');
  assert.equal(calls.length, 2); // two heartbeats, then terminal — nothing after
  assert.match(calls[0].body, /progress heartbeat/);
  assert.match(calls[0].body, /helper: tick 1 · interval 120s/);
  assert.equal(existsSync(join(dir, HELPER_LEASE_FILE)), false); // lease released
  const hs = readJson(dir, HELPER_STATE_FILE) as { exitReason: string; ticks: number };
  assert.equal(hs.exitReason, 'terminal:reported');
});

test('helper exits on heartbeat budget with a final bounded expired notice', async () => {
  const dir = await notifiedRun();
  const nonce = 'n2';
  seedLease(dir, nonce);
  const { calls, send } = fakeSend();
  let t = T0;
  const res = unwrap(await runHelperLoop({
    runDir: dir,
    nonce,
    intervalMs: 60_000,
    maxLifetimeMs: 86_400_000,
    sendMail: send,
    now: () => new Date(t),
    sleep: async () => { t += 60_000; },
    budget: { heartbeatMax: 2 },
  }));
  assert.equal(res.exitReason, 'heartbeat_budget_exhausted');
  // 2 heartbeats + 1 helper_expired notice (stage budget), all persisted.
  const box = readOutboxFile(dir);
  assert.equal(box.counters.heartbeat, 2);
  assert.equal(box.deliveries.filter((d) => d.kind === 'helper_expired').length, 1);
  assert.equal(calls.length, 3);
});

test('helper exits on lifetime bound; helper_expired is journaled', async () => {
  const dir = await notifiedRun();
  const nonce = 'n3';
  seedLease(dir, nonce);
  const { calls, send } = fakeSend();
  let t = T0;
  const res = unwrap(await runHelperLoop({
    runDir: dir,
    nonce,
    intervalMs: 120_000,
    maxLifetimeMs: 200_000,
    sendMail: send,
    now: () => new Date(t),
    sleep: async () => { t += 120_000; },
  }));
  assert.equal(res.exitReason, 'lifetime_exceeded');
  const box = readOutboxFile(dir);
  assert.ok(box.deliveries.some((d) => d.kind === 'helper_expired'));
  assert.equal(calls.length, box.deliveries.filter((d) => d.delivery === 'sent').length);
});

test('helper exits lease_lost when another generation takes over', async () => {
  const dir = await notifiedRun();
  seedLease(dir, 'mine');
  const { send } = fakeSend();
  let t = T0;
  const res = unwrap(await runHelperLoop({
    runDir: dir,
    nonce: 'mine',
    intervalMs: 120_000,
    maxLifetimeMs: 3_600_000,
    sendMail: send,
    now: () => new Date(t),
    sleep: async () => {
      t += 120_000;
      // A newer helper generation replaces the lease mid-sleep.
      seedLease(dir, 'other');
    },
  }));
  assert.equal(res.exitReason, 'lease_lost');
});

test('helper exits cleanly on cancellation and mismatch without sending', async () => {
  const dir = await notifiedRun();
  seedLease(dir, 'n4');
  const { calls, send } = fakeSend();
  const res = unwrap(await runHelperLoop({
    runDir: dir,
    nonce: 'n4',
    intervalMs: 120_000,
    maxLifetimeMs: 3_600_000,
    sendMail: send,
    now: () => new Date(T0),
    sleep: async () => {},
    stopped: () => true,
  }));
  assert.equal(res.exitReason, 'cancelled');
  assert.equal(calls.length, 0);

  const dir2 = await notifiedRun();
  seedLease(dir2, 'different');
  const res2 = unwrap(await runHelperLoop({
    runDir: dir2,
    nonce: 'nope',
    intervalMs: 120_000,
    maxLifetimeMs: 3_600_000,
    sendMail: send,
    now: () => new Date(T0),
    sleep: async () => {},
  }));
  assert.equal(res2.exitReason, 'lease_mismatch');
  assert.equal(calls.length, 0);
});

// ─── progressStatus (read-only) ─────────────────────────────────────────────

test('progressStatus is read-only: creates nothing on an empty run dir', async () => {
  const dir = tmpRun();
  const r = unwrap(await progressStatus(dir));
  assert.equal(r.recipient, null);
  assert.equal(r.helper.state, 'none');
  assert.equal(r.runStatus, null);
  assert.equal(existsSync(join(dir, PROGRESS_DIR)), false);
});

test('progressStatus reports recipient, deliveries, budget and helper state', async () => {
  const dir = await notifiedRun();
  const { send } = fakeSend();
  const n = createProgressNotifier({ runDir: dir, sendMail: send, now: () => new Date(T0) });
  await n.notify({ kind: 'stage', status: 'organising' });
  writeFileSync(
    join(dir, HELPER_LEASE_FILE),
    JSON.stringify({ nonce: 'h1', pid: process.pid, startedAt: new Date(T0).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  );
  const r = unwrap(await progressStatus(dir));
  assert.equal(r.recipient?.to, 'run:run_primary');
  assert.equal(r.deliveries.sent, 1);
  assert.equal(r.budget.stageUsed, 1);
  assert.equal(r.helper.state, 'running');
  assert.equal(r.helper.pid, process.pid);
  assert.equal(r.runStatus, 'organising');
  assert.match(r.lastDelivery?.subject ?? '', /organiser/);
});

// ─── real argv helper smoke ─────────────────────────────────────────────────

test('real spawned helper: argv child heartbeats via fake orca, exits on terminal', async () => {
  // Repo fake-orca convention (test/fixtures/orca-recovery.cjs): the host
  // boundary spawns `ORCA_CLI_COMMAND <argv>` with shell:false, so we point
  // it at `node` and --require a fixture into every node child. `node
  // orchestration send ...` has argv[1]==='orchestration' → the fixture logs
  // and answers a canned envelope; inside any other process it is a no-op.
  const dir = tmpRun();
  writeState(dir, makeState({ status: 'independent_review' }));
  await capture(dir);

  const mailLog = join(dir, 'mails.log');
  const fixture = join(dir, 'fake-orca.cjs');
  writeFileSync(
    fixture,
    `(function () {
  const path = require('node:path');
  const argv = process.argv.slice(1);
  if (path.basename(argv[0] ?? '') !== 'orchestration') return;
  require('node:fs').appendFileSync(${JSON.stringify(mailLog)}, JSON.stringify(argv) + '\\n');
  process.stdout.write(JSON.stringify({ ok: true, result: { messageId: 'm_fake', mutation: { requestId: 'r_fake' } } }) + '\\n');
  process.exit(0);
})();
`,
  );

  const envKeys = ['ORCA_CLI_COMMAND', 'NODE_OPTIONS'] as const;
  const prevEnv = envKeys.map((k) => process.env[k]);
  process.env.ORCA_CLI_COMMAND = process.execPath;
  process.env.NODE_OPTIONS = `--require ${fixture}`;
  try {
    const ensured = unwrap(await ensureHelper({
      runDir: dir,
      helper: { intervalMs: 250, maxLifetimeMs: 20_000 },
    }));
    assert.equal(ensured.state, 'started', ensured.detail);
    const pid = ensured.pid!;

    // Let it tick a few times, then mark the run terminal.
    await new Promise((r) => setTimeout(r, 900));
    writeState(dir, makeState({ status: 'reported' }));

    // Wait for exit (bounded — helper must die on its own).
    const deadline = Date.now() + 15_000;
    let exited = false;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        exited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(exited, true, 'helper child did not exit after terminal state');

    const hs = readJson(dir, HELPER_STATE_FILE) as { exitReason?: string };
    assert.match(hs.exitReason ?? '', /terminal:reported/);
    const box = readOutboxFile(dir);
    const hbs = box.deliveries.filter((d) => d.kind === 'heartbeat');
    assert.ok(hbs.length >= 1, 'expected at least one heartbeat delivery');
    assert.equal(hbs.every((d) => d.delivery === 'sent'), true);
    const log = existsSync(mailLog) ? readFileSync(mailLog, 'utf8') : '';
    assert.match(log, /orchestration/, 'fake orca never received a send');
    assert.match(log, /--to/, 'mail argv missing --to');
  } finally {
    envKeys.forEach((k, i) => {
      if (prevEnv[i] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[i];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
