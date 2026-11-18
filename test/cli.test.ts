/**
 * Tests for src/cli.ts — the `council` command surface.
 *
 * Every check spawns the REAL built CLI (`node dist/src/cli.js`) as a child
 * process — argv parsing, exit codes and stdout/stderr contract are exercised
 * end-to-end, never through an in-process shim. Commands that could reach
 * Orca (approve/supervise) run with ORCA_CLI_COMMAND pointed at a nonexistent
 * binary so the real adapter degrades to an honest adapter_error and no test
 * ever touches the live host.
 *
 * Run dirs live in OS temp dirs via COUNCIL_HOME; targets are synthetic trees
 * (plus one read-only pass over the seeded fixture). Nothing in the repo is
 * mutated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_VERSION, type ProposedRoster, type ApprovedRoster } from '../src/contracts.js';
import { createStore } from '../src/store.js';

// dist/test/cli.test.js → dist/src/cli.js
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_TARGET = path.join(REPO_ROOT, 'test', 'fixtures', 'review-target');
/** An orca binary that can never resolve — neutralises host calls in tests. */
const NO_ORCA = 'definitely-not-a-real-orca-binary-xyzzy';

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliRun> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code)
              : 1;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function cliJson(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return cli(args, env).then((r) => ({ ...r, body: JSON.parse(r.stdout) as Record<string, unknown> }));
}

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `council-cli-${prefix}-`));
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

interface InitFixture {
  runId: string;
  runDir: string;
  snapshotId: string;
  councilHome: string;
  target: string;
  env: NodeJS.ProcessEnv;
}

/** Run `council init` against a synthetic target; returns parsed output. */
async function initRun(opts: { perspectives?: number; participants?: number; targetFiles?: Record<string, string> } = {}): Promise<InitFixture> {
  const dir = tmp('init');
  const target = path.join(dir, 'target');
  writeTree(
    target,
    opts.targetFiles ?? {
      'src/app.js': 'export function main() { return 1; }\n',
      'src/util.js': 'export const util = () => null;\n',
      'README.md': '# synthetic target\n',
    },
  );
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'Review the synthetic target for correctness defects.\n');
  const councilHome = path.join(dir, 'council-home');
  const env: NodeJS.ProcessEnv = { COUNCIL_HOME: councilHome, ORCA_CLI_COMMAND: NO_ORCA };

  const args = ['init', '--objective', objective, '--target', target];
  if (opts.perspectives !== undefined || opts.participants !== undefined) {
    const config = path.join(dir, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        ...(opts.perspectives !== undefined ? { requestedPerspectives: opts.perspectives } : {}),
        ...(opts.participants !== undefined ? { participants: opts.participants } : {}),
      }),
    );
    args.push('--config', config);
  }
  args.push('--json');

  const r = await cliJson(args, env);
  assert.equal(r.code, 0, `init failed: ${r.stdout}${r.stderr}`);
  assert.equal(r.body.ok, true);
  return {
    runId: r.body.runId as string,
    runDir: r.body.runDir as string,
    snapshotId: r.body.snapshotId as string,
    councilHome,
    target,
    env,
  };
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
        reviewQuestions: [`question ${i + 1}?`],
      },
      tags: [],
    })),
  };
}

function approvedRoster(runId: string, seats: number): ApprovedRoster {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    seats: Array.from({ length: seats }, (_, i) => ({
      seatId: `seat-${i + 1}`,
      perspectiveId: `p${i + 1}`,
      participantId: `rev-${i + 1}`,
      agent: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
    })),
  };
}

// ─── argv handling / output shape ────────────────────────────────────────────

test('help and unknown command', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: council <command>/);

  const helpCmd = await cli(['help']);
  assert.equal(helpCmd.code, 0);
  assert.match(helpCmd.stdout, /init +--objective/);

  const bare = await cli([]);
  assert.equal(bare.code, 2);
  assert.match(bare.stdout, /usage: council <command>/);

  const bad = await cliJson(['frobnicate', '--json']);
  assert.equal(bad.code, 14); // unsupported
  assert.equal(bad.body.ok, false);
  assert.equal((bad.body.error as Record<string, unknown>).code, 'unsupported');
  assert.match((bad.body.error as Record<string, unknown>).message as string, /frobnicate/);
});

test('unknown flag and missing required flag are usage errors', async () => {
  const badFlag = await cliJson(['init', '--objective', 'x', '--target', 'y', '--bogus', '--json']);
  assert.equal(badFlag.code, 2);
  assert.equal(badFlag.body.ok, false);
  assert.equal((badFlag.body.error as Record<string, unknown>).code, 'config_invalid');

  const missing = await cliJson(['init', '--json']);
  assert.equal(missing.code, 2);
  assert.match((missing.body.error as Record<string, unknown>).message as string, /--objective/);

  const missingRun = await cliJson(['status', '--json']);
  assert.equal(missingRun.code, 2);
  assert.match((missingRun.body.error as Record<string, unknown>).message as string, /--run/);
});

test('human (non-json) error goes to stderr with code', async () => {
  const r = await cli(['status', '--run', path.join(tmp('norun'), 'nope')]);
  assert.equal(r.code, 12); // io_error
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /error \[io_error\]/);
});

// ─── init ────────────────────────────────────────────────────────────────────

test('init creates the documented run-dir layout', async () => {
  const dir = tmp('layout');
  const target = path.join(dir, 'target');
  writeTree(target, { 'src/a.js': 'const a = 1;\n', 'docs/s.md': 'spec\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'Objective text here.\n');
  const councilHome = path.join(dir, 'council-home');

  const r = await cliJson(
    ['init', '--objective', objective, '--target', target, '--json'],
    { COUNCIL_HOME: councilHome },
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.ok, true);
  const runId = r.body.runId as string;
  const runDir = r.body.runDir as string;
  assert.match(runId, /^crun_[0-9A-Z]{26}$/);
  assert.equal(path.dirname(runDir), path.join(councilHome, 'runs'));
  assert.equal(typeof r.body.snapshotId, 'string');
  assert.equal(typeof r.body.launchBudgetFloor, 'number');
  assert.match(r.body.advanceCommand as string, /supervise --run .* --advance --json/);

  for (const rel of [
    'council.json',
    'state.json',
    'objective.md',
    'snapshot.json',
    'events.jsonl',
    'meta.json',
    'prompts/supervisor.md',
  ]) {
    assert.ok(existsSync(path.join(runDir, rel)), `missing ${rel}`);
  }

  const state = JSON.parse(readFileSync(path.join(runDir, 'state.json'), 'utf8')) as {
    status: string;
    runId: string;
    participants: unknown[];
    config: { participants: number; requestedPerspectives: number };
  };
  assert.equal(state.runId, runId);
  assert.equal(state.status, 'initialized');
  assert.equal(state.participants.length, 0);
  assert.equal(state.config.participants, 15);
  assert.equal(state.config.requestedPerspectives, 15);

  const snap = JSON.parse(readFileSync(path.join(runDir, 'snapshot.json'), 'utf8')) as {
    snapshotId: string;
    files: Record<string, unknown>;
  };
  assert.equal(snap.snapshotId, r.body.snapshotId);
  assert.deepEqual(Object.keys(snap.files).sort(), ['docs/s.md', 'src/a.js']);

  const spec = readFileSync(path.join(runDir, 'prompts', 'supervisor.md'), 'utf8');
  assert.match(spec, new RegExp(runId));
  assert.match(spec, /supervise --run .* --advance --json/);
});

test('init default (no COUNCIL_HOME) puts the run under <target>/.council', async () => {
  const dir = tmp('defhome');
  const target = path.join(dir, 'target');
  writeTree(target, { 'a.js': 'const a = 1;\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'Review it.\n');
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.COUNCIL_HOME;
  const r = await cliJson(['init', '--objective', objective, '--target', target, '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const runDir = r.body.runDir as string;
  assert.equal(runDir, path.join(target, '.council', 'runs', r.body.runId as string));
  // .council is snapshot-excluded: verifySourceSnapshot must stay clean.
  const verify = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal(verify.code, 0);
  assert.equal(verify.body.verified, true);
});

test('init --config applies config and rejects invalid/under-floor values', async () => {
  const dir = tmp('cfg');
  const target = path.join(dir, 'target');
  writeTree(target, { 'a.js': 'x\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'obj\n');
  const env = { COUNCIL_HOME: path.join(dir, 'council-home'), ORCA_CLI_COMMAND: NO_ORCA };

  const goodCfg = path.join(dir, 'good.json');
  writeFileSync(goodCfg, JSON.stringify({ requestedPerspectives: 10, participants: 2, rounds: 1 }));
  const ok = await cliJson(['init', '--objective', objective, '--target', target, '--config', goodCfg, '--json'], env);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const cfg = ok.body.config as { participants: number; requestedPerspectives: number; maxLaunches: number };
  assert.equal(cfg.participants, 2);
  assert.equal(cfg.requestedPerspectives, 10);
  assert.equal(cfg.maxLaunches, 9 + 8); // minViable(2,1)=9 + slack 8
  assert.equal(ok.body.launchBudgetFloor, 9);

  const badCfg = path.join(dir, 'bad.json');
  writeFileSync(badCfg, JSON.stringify({ requestedPerspectives: 30 }));
  const bad = await cliJson(['init', '--objective', objective, '--target', target, '--config', badCfg, '--json'], env);
  assert.equal(bad.code, 2);
  assert.equal((bad.body.error as Record<string, unknown>).code, 'config_invalid');
  assert.ok(Array.isArray((bad.body.error as Record<string, unknown>).issues));

  const floorCfg = path.join(dir, 'floor.json');
  writeFileSync(floorCfg, JSON.stringify({ participants: 2, rounds: 1, maxLaunches: 5 })); // < minViable 9
  const floor = await cliJson(['init', '--objective', objective, '--target', target, '--config', floorCfg, '--json'], env);
  assert.equal(floor.code, 2);
  assert.equal((floor.body.error as Record<string, unknown>).code, 'config_invalid');
  assert.match(
    JSON.stringify((floor.body.error as Record<string, unknown>).issues),
    /maxLaunches/,
  );
});

test('init on the seeded fixture target works (read-only)', async () => {
  const dir = tmp('fixture');
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'Review the Fieldnotes fixture.\n');
  const r = await cliJson(
    ['init', '--objective', objective, '--target', FIXTURE_TARGET, '--json'],
    { COUNCIL_HOME: path.join(dir, 'council-home'), ORCA_CLI_COMMAND: NO_ORCA },
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const snap = JSON.parse(
    readFileSync(path.join(r.body.runDir as string, 'snapshot.json'), 'utf8'),
  ) as { files: Record<string, unknown> };
  assert.ok(Object.keys(snap.files).includes('src/pagination.js'));
  // The fixture itself was not mutated.
  assert.ok(!existsSync(path.join(FIXTURE_TARGET, '.council')));
});

// ─── doctor ──────────────────────────────────────────────────────────────────

test('doctor returns structured per-check results and never fails hard', async () => {
  const r = await cliJson(['doctor', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.ready, 'boolean');
  const checks = r.body.checks as { name: string; required: boolean; status: string }[];
  const names = checks.map((c) => c.name);
  for (const expected of ['node', 'orca', 'devin', 'claude', 'codex']) {
    assert.ok(names.includes(expected), `missing doctor check ${expected}`);
  }
  // orca.status is only probed when the executable resolves.
  const orca = checks.find((c) => c.name === 'orca')!;
  assert.equal(orca.status === 'verified', names.includes('orca.status'));
  const node = checks.find((c) => c.name === 'node')!;
  assert.equal(node.status, 'verified'); // the suite itself runs on >=22
  for (const c of checks) assert.ok(['verified', 'missing', 'failed'].includes(c.status));
});

// ─── status / tail / verify (read-only) ─────────────────────────────────────

test('status on a fresh run is initialized and read-only', async () => {
  const { runId, runDir, env } = await initRun();
  const r = await cliJson(['status', '--run', runDir, '--json'], env);
  assert.equal(r.code, 0);
  assert.equal(r.body.runId, runId);
  assert.equal(r.body.status, 'initialized');
  assert.deepEqual(r.body.participants, []);
  assert.deepEqual(r.body.consumption, { launches: 0, mailSent: 0 });
  assert.equal(r.body.approvalHash, null);
  const quorum = r.body.quorum as { seats: number; met: boolean };
  assert.equal(quorum.seats, 0);
  assert.equal(quorum.met, false);
});

test('tail returns journal events read-only', async () => {
  const { runDir, env } = await initRun();
  const empty = await cliJson(['tail', '--run', runDir, '--json'], env);
  assert.equal(empty.code, 0);
  assert.equal(empty.body.totalEvents, 0);
  assert.deepEqual(empty.body.events, []);

  const store = createStore({ runDir });
  const appended = await store.appendJournal([
    { ts: new Date().toISOString(), type: 'phase.entered', actor: 'engine', payload: { status: 'organising' } },
  ]);
  assert.ok(appended.ok);
  const r = await cliJson(['tail', '--run', runDir, '--lines', '5', '--json'], env);
  assert.equal(r.code, 0);
  assert.equal(r.body.totalEvents, 1);
  assert.equal((r.body.events as { type: string }[])[0].type, 'phase.entered');
});

test('verify reports snapshot drift and approval integrity', async () => {
  const { runDir, target, env } = await initRun();
  const clean = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal(clean.code, 0);
  assert.equal(clean.body.verified, true);
  assert.deepEqual((clean.body.snapshot as { changed: string[] }).changed, []);
  assert.equal((clean.body.approval as { present: boolean }).present, false);

  writeFileSync(path.join(target, 'src', 'app.js'), 'export function main() { return 2; /* drifted */ }\n');
  const drift = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal(drift.code, 0);
  assert.equal(drift.body.verified, false);
  const snapshot = drift.body.snapshot as { drift: boolean; changed: string[] };
  assert.equal(snapshot.drift, true);
  assert.deepEqual(snapshot.changed, ['src/app.js']);
});

// ─── approve gating ──────────────────────────────────────────────────────────

test('approve refuses before the organiser produced a roster', async () => {
  const { runDir, target, env } = await initRun({ perspectives: 10, participants: 2 });
  const rosterPath = path.join(target, 'roster.approved.json');
  writeFileSync(rosterPath, JSON.stringify(approvedRoster('crun_irrelevant', 2)));
  const r = await cliJson(['approve', '--run', runDir, '--roster', rosterPath, '--json'], env);
  assert.equal(r.code, 3); // approval_required
  assert.equal(r.body.ok, false);
  assert.equal((r.body.error as Record<string, unknown>).code, 'approval_required');
});

test('approve rejects a schema-invalid roster file', async () => {
  const { runId, runDir, target, env } = await initRun({ perspectives: 10, participants: 2 });
  const store = createStore({ runDir });
  const w = await store.writeProposedRoster(proposedRoster(runId, 10));
  assert.ok(w.ok);

  // Wrong seat count (1 seat where config wants 2).
  const badPath = path.join(target, 'bad.json');
  writeFileSync(badPath, JSON.stringify(approvedRoster(runId, 1)));
  const bad = await cliJson(['approve', '--run', runDir, '--roster', badPath, '--json'], env);
  assert.equal(bad.code, 2);
  assert.equal((bad.body.error as Record<string, unknown>).code, 'roster_invalid');

  // Unknown perspective id.
  const unknownSeat = approvedRoster(runId, 2);
  unknownSeat.seats[0].perspectiveId = 'p-nope';
  const unkPath = path.join(target, 'unk.json');
  writeFileSync(unkPath, JSON.stringify(unknownSeat));
  const unk = await cliJson(['approve', '--run', runDir, '--roster', unkPath, '--json'], env);
  assert.equal(unk.code, 2);
  assert.equal((unk.body.error as Record<string, unknown>).code, 'roster_invalid');
  assert.match(JSON.stringify((unk.body.error as Record<string, unknown>).issues), /p-nope/);
});

test('approve refuses while the run is not awaiting approval, approves at the gate, then refuses re-approval', async () => {
  const { runId, runDir, target, env } = await initRun({ perspectives: 10, participants: 2 });
  const store = createStore({ runDir });
  assert.ok((await store.writeProposedRoster(proposedRoster(runId, 10))).ok);

  const rosterPath = path.join(target, 'roster.approved.json');
  writeFileSync(rosterPath, JSON.stringify(approvedRoster(runId, 2)));

  // Status still 'initialized' → the engine refuses.
  const early = await cliJson(['approve', '--run', runDir, '--roster', rosterPath, '--json'], env);
  assert.equal(early.code, 4); // invalid_transition
  assert.equal((early.body.error as Record<string, unknown>).code, 'invalid_transition');

  // Drive the run to the approval gate through the real store (as the organiser
  // step would), then approve through the real CLI.
  const locked = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    st.value.status = 'awaiting_approval';
    return store.saveState(st.value);
  });
  assert.ok(locked.ok);

  const ok = await cliJson(['approve', '--run', runDir, '--roster', rosterPath, '--note', 'looks right', '--json'], env);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(ok.body.ok, true);
  assert.match(ok.body.approvalId as string, /^appr_/);
  assert.match(ok.body.hash as string, /^[0-9a-f]{64}$/);
  assert.equal(ok.body.seats, 2);
  assert.match(ok.body.note as string, /does NOT wake/);
  // No supervisor recorded → wakeCommand is null and the note says so.
  assert.equal(ok.body.wakeCommand, null);

  // approval.json exists and is hash-bound; approvalHash landed in state.
  const approval = JSON.parse(readFileSync(path.join(runDir, 'approval.json'), 'utf8')) as {
    record: { hash: string; approver: string };
    binding: { seats: unknown[] };
  };
  assert.equal(approval.record.hash, ok.body.hash);
  assert.equal((approval.binding.seats as unknown[]).length, 2);
  const state = JSON.parse(readFileSync(path.join(runDir, 'state.json'), 'utf8')) as {
    approvalHash: string | null;
    status: string;
    participants: { participantId: string; role: string }[];
  };
  assert.equal(state.approvalHash, ok.body.hash);
  assert.equal(state.status, 'independent_review');
  assert.equal(state.participants.filter((p) => p.role === 'reviewer').length, 2);

  // Re-approval of the same (or any) roster is refused while bound.
  const again = await cliJson(['approve', '--run', runDir, '--roster', rosterPath, '--json'], env);
  assert.equal(again.code, 4);
  assert.equal((again.body.error as Record<string, unknown>).code, 'invalid_transition');

  // verify now reports a bound, intact approval.
  const verify = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal(verify.code, 0);
  const appr = verify.body.approval as { present: boolean; bindingIntact: boolean; matchesStateHash: boolean };
  assert.equal(appr.present, true);
  assert.equal(appr.bindingIntact, true);
  assert.equal(appr.matchesStateHash, true);
});

// ─── supervise ───────────────────────────────────────────────────────────────

test('supervise requires --advance and reports a bounded step', async () => {
  const { runDir, env } = await initRun();
  const noAdvance = await cliJson(['supervise', '--run', runDir, '--json'], env);
  assert.equal(noAdvance.code, 2);
  assert.match((noAdvance.body.error as Record<string, unknown>).message as string, /--advance/);

  // ORCA_CLI_COMMAND points at a nonexistent binary: run-create fails with an
  // honest adapter error and the engine reports `blocked` — never a retry.
  const r = await cliJson(['supervise', '--run', runDir, '--advance', '--json'], env);
  assert.equal(r.code, 0);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.action, 'blocked');
  assert.equal(r.body.state, 'initialized');
  assert.match(r.body.note as string, /run-create|adapter|orca/i);
  assert.equal(typeof r.body.nextHint, 'string');
});

// ─── cancel ──────────────────────────────────────────────────────────────────

test('cancel marks a non-terminal run cancelled and reports honestly', async () => {
  const { runDir, env } = await initRun();
  const r = await cliJson(['cancel', '--run', runDir, '--reason', 'test cleanup', '--json'], env);
  assert.equal(r.code, 0);
  assert.equal(r.body.status, 'cancelled');
  assert.deepEqual(r.body.confirmedStopped, []);
  assert.deepEqual(r.body.unverifiable, []);

  const after = await cliJson(['status', '--run', runDir, '--json'], env);
  assert.equal(after.body.status, 'cancelled');

  const again = await cliJson(['cancel', '--run', runDir, '--json'], env);
  assert.equal(again.code, 4); // invalid_transition — already terminal
});
