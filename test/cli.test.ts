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
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_VERSION, type ProposedRoster, type ApprovedRoster } from '../src/contracts.js';
import { CATALOG_VERSION, LAUNCH_POLICY_HASH } from '../src/catalog.js';
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
/** The pinned Devin development lane — one catalog-valid AgentChoice. */
const DEVIN = { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' } as const;
/** A complete explicit staff — fresh init refuses anything less. */
const STAFF = { organiser: DEVIN, scribe: DEVIN, supervisor: DEVIN };

/** Write a minimal complete-staff config file for direct init calls. */
function staffConfig(dir: string, extra: Record<string, unknown> = {}): string {
  const config = path.join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ staff: STAFF, ...extra }));
  return config;
}

async function initRun(
  opts: {
    perspectives?: number;
    participants?: number;
    targetFiles?: Record<string, string>;
    /** Merged into the written config.json (e.g. staff overrides). */
    config?: Record<string, unknown>;
  } = {},
): Promise<InitFixture> {
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
  const config = path.join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      ...(opts.perspectives !== undefined ? { requestedPerspectives: opts.perspectives } : {}),
      ...(opts.participants !== undefined ? { participants: opts.participants } : {}),
      staff: STAFF,
      ...(opts.config ?? {}),
    }),
  );
  args.push('--config', config);
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

test('per-command --help exits 0 before flag, config, or host resolution', async () => {
  const initHelp = await cli(['init', '--help']);
  assert.equal(initHelp.code, 0);
  assert.match(initHelp.stdout, /usage: council <command>/);
  assert.match(initHelp.stdout, /init +--objective/);

  const dashH = await cli(['status', '-h']);
  assert.equal(dashH.code, 0);
  assert.match(dashH.stdout, /status +--run/);

  // A nonexistent --config is never read and an unknown flag never parsed —
  // help short-circuits the whole handler path.
  const cfgHelp = await cli(['init', '--help', '--config', path.join(tmp('nocfg'), 'missing.json')]);
  assert.equal(cfgHelp.code, 0);
  assert.match(cfgHelp.stdout, /usage: council <command>/);

  const bogusFlagHelp = await cli(['init', '--bogus', '--help']);
  assert.equal(bogusFlagHelp.code, 0);
  assert.match(bogusFlagHelp.stdout, /usage: council <command>/);
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
    ['init', '--objective', objective, '--target', target, '--config', staffConfig(dir), '--json'],
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
  assert.match(r.body.advanceCommand as string, /supervise --run .* --advance --as-supervisor --json/);

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
  assert.match(spec, /supervise --run .* --advance --as-supervisor --json/);
});

test('init default (no COUNCIL_HOME) puts the run under <target>/.council', async () => {
  const dir = tmp('defhome');
  const target = path.join(dir, 'target');
  writeTree(target, { 'a.js': 'const a = 1;\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'Review it.\n');
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.COUNCIL_HOME;
  const r = await cliJson(
    ['init', '--objective', objective, '--target', target, '--config', staffConfig(dir), '--json'],
    env,
  );
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
  writeFileSync(goodCfg, JSON.stringify({ requestedPerspectives: 10, participants: 2, rounds: 1, staff: STAFF }));
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
    ['init', '--objective', objective, '--target', FIXTURE_TARGET, '--config', staffConfig(dir), '--json'],
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
  for (const expected of ['node', 'orca', 'catalog.devin', 'catalog.claude', 'catalog.codex']) {
    assert.ok(names.includes(expected), `missing doctor check ${expected}`);
  }
  // Only host checks are required — no agent CLI is universally required.
  assert.equal(checks.find((c) => c.name === 'node')!.required, true);
  assert.equal(checks.find((c) => c.name === 'orca')!.required, true);
  for (const lane of ['catalog.devin', 'catalog.claude', 'catalog.codex']) {
    assert.equal(checks.find((c) => c.name === lane)!.required, false, `${lane} must stay informational`);
  }
  // orca.status is only probed when the executable resolves.
  const orca = checks.find((c) => c.name === 'orca')!;
  assert.equal(orca.status === 'verified', names.includes('orca.status'));
  const node = checks.find((c) => c.name === 'node')!;
  assert.equal(node.status, 'verified'); // the suite itself runs on >=22
  for (const c of checks) assert.ok(['verified', 'missing', 'failed'].includes(c.status));
});

test('doctor --config gates only the SELECTED staff, not every catalog CLI', async () => {
  const dir = tmp('doctor-sel');
  // A complete staff on the Claude lane: codex/devin presence is irrelevant.
  const cfg = path.join(dir, 'sel.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      staff: {
        organiser: { agent: 'claude', model: 'sonnet-1', permissionMode: 'accept-edits' },
        scribe: { agent: 'claude', model: 'sonnet-1', permissionMode: 'accept-edits' },
        supervisor: { agent: 'claude', model: 'sonnet-1', permissionMode: 'accept-edits' },
      },
    }),
  );
  const r = await cliJson(['doctor', '--config', cfg, '--json']);
  assert.equal(r.code, 0);
  const checks = r.body.checks as { name: string; required: boolean; status: string; detail?: string }[];
  for (const role of ['organiser', 'scribe', 'supervisor']) {
    const seat = checks.find((c) => c.name === `staff.${role}`)!;
    assert.equal(seat.required, true);
    assert.match(String(seat.detail), /claude/);
  }
  // An invalid choice fails visibly — never assumed or substituted.
  const badCfg = path.join(dir, 'bad.json');
  writeFileSync(badCfg, JSON.stringify({ staff: { ...STAFF, scribe: { agent: 'mystery', model: 'x', permissionMode: 'bypass' } } }));
  const bad = await cliJson(['doctor', '--config', badCfg, '--json']);
  assert.equal(bad.code, 0); // doctor reports, never throws
  const badChecks = bad.body.checks as { name: string; status: string }[];
  assert.equal(badChecks.find((c) => c.name === 'staff.scribe')!.status, 'failed');
  assert.equal(bad.body.ready, false);
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

// ─── supervisor recovery: rebinding + reconcile ──────────────────────────────
//
// A fake `orca` stands in for the host: ORCA_CLI_COMMAND points at the Node
// executable and NODE_OPTIONS --require's test/fixtures/orca-recovery.cjs into
// every spawned child. `node orchestration <verb>` has argv[1]==='orchestration'
// so the fixture emits a canned JSON envelope; in the council CLI itself it is
// a no-op. Scenario queues are FIFO per command family; every invocation is
// logged so tests prove exactly what ran (or never ran). No real host is
// touched and no agent ever launches — only CLI-level commands.

const FAKE_ORCA_SRC = path.join(REPO_ROOT, 'test', 'fixtures', 'orca-recovery.cjs');

/** Wire a fake orca host into the env for one test; returns the call log path. */
function fakeOrca(
  dir: string,
  scenario: Record<string, unknown[]>,
  handle?: string,
): { env: NodeJS.ProcessEnv; log: string } {
  const fixture = path.join(dir, 'orca-fake.cjs');
  copyFileSync(FAKE_ORCA_SRC, fixture);
  const scenarioPath = path.join(dir, 'orca-scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const log = path.join(dir, 'orca.log');
  return {
    log,
    env: {
      ORCA_CLI_COMMAND: process.execPath, // `node orchestration ...`
      NODE_OPTIONS: `--require ${fixture}`,
      FAKE_ORCA_SCENARIO: scenarioPath,
      FAKE_ORCA_LOG: log,
      ...(handle !== undefined ? { ORCA_TERMINAL_HANDLE: handle } : {}),
    },
  };
}

/**
 * Every fake-orca invocation, oldest first. The logged argv[0] is the resolved
 * entry path ('.../orchestration'), so it is normalized to its basename to
 * yield [['orchestration','run-current',...], ...].
 */
function orcaCalls(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { argv?: string[] })
    .filter((e): e is { argv: string[] } => Array.isArray(e.argv))
    .map((e) => [path.basename(e.argv[0] ?? ''), ...e.argv.slice(1)]);
}

/** Fixture spy snapshots: files the fake orca captured at the exact moment a
 *  host command ran — proves what the durable record said at that seam. */
function spyReads(log: string): { spy: string; content?: string; error?: string }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { spy?: string; content?: string; error?: string })
    .filter((e) => typeof e.spy === 'string') as { spy: string; content?: string; error?: string }[];
}

const hasCall = (log: string, head: string): boolean =>
  orcaCalls(log).some((a) => a.slice(0, 2).join(' ') === head);

interface RecoveryFixture extends InitFixture {
  attemptId: string;
  requestId: string;
  specRel: string;
  specText: string;
}

/**
 * Persist the live-smoke crash shape: a run in independent_review whose
 * reviewer task-create was definitively refused (journaled request id,
 * "Nothing changed"), leaving a null-task intent_recorded attempt that the
 * engine's launch guard refuses to retry on its own.
 */
async function recoveryRun(
  opts: {
    supervisorHandle?: string;
    specText?: string;
    attemptExtras?: Record<string, unknown>;
    /** Journaled task-create failure text; defaults to the real definitive
     * refusal ("not bound ... Nothing changed. request ID: <uuid>"). */
    failureMessage?: string;
  } = {},
): Promise<RecoveryFixture> {
  const f = await initRun({ perspectives: 10, participants: 2 });
  const store = createStore({ runDir: f.runDir });
  const attemptId = 'att_rev-1_independent_review_r0_0';
  const requestId = '74a45889-c510-491e-9598-26264fc8f5c7';
  const specRel = `specs/${attemptId}.md`;
  const specText =
    opts.specText ??
    `# worker spec\nrun ${f.runId}\nparticipant rev-1\nphase independent_review\n`;
  assert.ok((await store.writeArtifact(specRel, specText)).ok);

  const w = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    const s = st.value;
    s.status = 'independent_review';
    s.orcaRunId = 'run_child';
    s.supervisor = {
      terminalHandle: opts.supervisorHandle ?? 'term_sup',
      dispatchId: 'ctx_sup',
    };
    s.participants = [
      {
        participantId: 'rev-1',
        role: 'reviewer',
        seatId: 'seat-1',
        perspectiveId: 'p1',
        agent: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
        retainedTerminal: null,
        status: 'active',
        attempts: [
          {
            attemptId,
            participantId: 'rev-1',
            phase: 'independent_review',
            round: null,
            taskId: null,
            dispatchId: null,
            terminalHandle: null,
            launchIntentId: 'li_test',
            status: 'intent_recorded',
            createdAt: new Date().toISOString(),
            artifacts: [],
            ...(opts.attemptExtras ?? {}),
          },
        ],
      },
    ];
    const wres = await store.saveState(s);
    if (!wres.ok) return wres;
    return store.appendJournal([
      {
        ts: new Date().toISOString(),
        type: 'error',
        actor: 'engine',
        phase: 'independent_review',
        participantId: 'rev-1',
        payload: {
          op: 'task-create',
          attemptId,
          code: 'adapter_error',
          message:
            opts.failureMessage ??
            `This caller is not bound to Run run_child, which is bound to term_deadbeef. Nothing changed. Orchestration mutation request ID: ${requestId}.`,
        },
      },
    ]);
  });
  assert.ok(w.ok, `fixture setup failed: ${JSON.stringify(w)}`);
  return { ...f, attemptId, requestId, specRel, specText };
}

function readState(runDir: string) {
  return JSON.parse(readFileSync(path.join(runDir, 'state.json'), 'utf8')) as {
    orcaRunId: string | null;
    supervisor: { terminalHandle: string; dispatchId: string | null } | null;
    status: string;
    participants: {
      participantId: string;
      attempts: { attemptId: string; taskId: string | null; status: string }[];
    }[];
  };
}

function journalTail(runDir: string, n = 3): { type: string; payload?: Record<string, unknown> }[] {
  const lines = readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return lines.slice(-n).map((l) => JSON.parse(l));
}

test('supervise --advance --as-supervisor rebinds an orphaned council child Run', async () => {
  const { runDir } = await recoveryRun();
  const dir = tmp('rebind');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [
        { ok: true, result: { runId: 'run_unrelated' } }, // before
        { ok: true, result: { runId: 'run_child' } }, // verification after run-use
      ],
      'orchestration run-use': [{ ok: true, result: { runId: 'run_child' } }],
    },
    'term_sup',
  );

  const r = await cliJson(['supervise', '--run', runDir, '--advance', '--as-supervisor', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.ok, true);
  const binding = r.body.binding as { prior: string | null; rebound: boolean };
  assert.equal(binding.prior, 'run_unrelated');
  assert.equal(binding.rebound, true);

  const use = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'orchestration run-use')!;
  assert.ok(use.includes('--id'));
  assert.ok(use.includes('run_child'));
  assert.ok(use.includes('term_sup'));
});

test('supervise --advance --as-supervisor leaves a correct binding untouched', async () => {
  const { runDir } = await recoveryRun();
  const dir = tmp('bound');
  const { env, log } = fakeOrca(
    dir,
    { 'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }] },
    'term_sup',
  );

  const r = await cliJson(['supervise', '--run', runDir, '--advance', '--as-supervisor', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal((r.body.binding as { rebound: boolean }).rebound, false);
  assert.equal(hasCall(log, 'orchestration run-use'), false); // already bound → no mutation
});

test('supervise --advance --as-supervisor refuses a different recorded supervisor and verifies the binding', async () => {
  // Different supervisor: refuses BEFORE touching the host.
  const { runDir } = await recoveryRun({ supervisorHandle: 'term_other' });
  const d1 = tmp('takeover');
  const f1 = fakeOrca(d1, {}, 'term_sup');
  const r1 = await cliJson(['supervise', '--run', runDir, '--advance', '--as-supervisor', '--json'], f1.env);
  assert.equal(r1.code, 4); // invalid_transition
  assert.match((r1.body.error as Record<string, unknown>).message as string, /term_other/);
  assert.equal(orcaCalls(f1.log).length, 0); // no run-current, no run-use

  // Binding that does not verify: run-use "succeeded" but the terminal is
  // still bound elsewhere → adapter_error, never a silent advance.
  const { runDir: runDir2 } = await recoveryRun();
  const d2 = tmp('bindfail');
  const f2 = fakeOrca(
    d2,
    {
      'orchestration run-current': [
        { ok: true, result: { runId: 'run_unrelated' } },
        { ok: true, result: { runId: 'run_still_wrong' } },
      ],
      'orchestration run-use': [{ ok: true, result: { runId: 'run_child' } }],
    },
    'term_sup',
  );
  const r2 = await cliJson(['supervise', '--run', runDir2, '--advance', '--as-supervisor', '--json'], f2.env);
  assert.equal(r2.code, 10); // adapter_error — bind_unverified
  assert.match((r2.body.error as Record<string, unknown>).message as string, /not verifiably bound/);
});

test('manual supervise --advance never rebinds and never overwrites another supervisor identity', async () => {
  const { runDir } = await recoveryRun({ supervisorHandle: 'term_other' });
  const dir = tmp('manual');
  const { env, log } = fakeOrca(dir, {}, 'term_manual');

  const r = await cliJson(['supervise', '--run', runDir, '--advance', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal('binding' in r.body, false); // manual mode reports no binding
  assert.equal(hasCall(log, 'orchestration run-current'), false);
  assert.equal(hasCall(log, 'orchestration run-use'), false);
  // The recorded supervisor was NOT displaced by the manual driver's handle.
  assert.equal(readState(runDir).supervisor?.terminalHandle, 'term_other');
});

test('reconcile creates exactly one task under a confirmed no-effects refusal', async () => {
  const f = await recoveryRun();
  const dir = tmp('recon-create');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'refused' } }],
      'orchestration task-list': [
        { ok: true, result: { tasks: [{ id: 'task_unrelated', spec: 'DIFFERENT SPEC entirely' }] } },
      ],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_new1' } } }],
    },
    'term_sup',
  );

  const r = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    env,
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.resolution, 'created');
  assert.equal(r.body.taskId, 'task_new1');

  const st = readState(f.runDir);
  assert.equal(st.participants[0].attempts[0].taskId, 'task_new1');
  assert.equal(st.participants[0].attempts[0].status, 'intent_recorded'); // guard still holds until launch

  const tail = journalTail(f.runDir);
  const created = tail.find((e) => e.type === 'task.created')!;
  assert.equal(created.payload?.taskId, 'task_new1');
  assert.equal(created.payload?.reconciled, 'created');
  assert.equal(created.payload?.confirmedRequestId, f.requestId);

  const create = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'orchestration task-create')!;
  assert.ok(create.includes('--spec-file'));
  assert.ok(create.some((a) => a.endsWith(f.attemptId + '.md')));
  assert.equal(
    orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create').length,
    1,
    'exactly one task-create',
  );

  // Recovery is exactly-once: the attempt now carries a taskId, so a second
  // reconcile refuses without touching the host again.
  const again = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    env,
  );
  assert.equal(again.code, 4); // invalid_transition — already carries a task id
  assert.equal(
    orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create').length,
    1,
    'still exactly one task-create',
  );
});

test('reconcile adopts the unique host task carrying this attempt spec', async () => {
  const f = await recoveryRun();
  const dir = tmp('recon-adopt');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'refused' } }],
      'orchestration task-list': [
        {
          ok: true,
          result: {
            tasks: [
              { id: 'task_mine', title: 'council independent_review r0 rev-1', spec: f.specText },
              { id: 'task_other', spec: 'some other spec' },
            ],
          },
        },
      ],
    },
    'term_sup',
  );

  const r = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    env,
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.resolution, 'adopted');
  assert.equal(r.body.taskId, 'task_mine');
  assert.equal(readState(f.runDir).participants[0].attempts[0].taskId, 'task_mine');
  assert.equal(hasCall(log, 'orchestration task-create'), false); // adopted — never created
});

test('reconcile refuses ambiguous and mismatched evidence without touching the host', async () => {
  // Two matching tasks → launch_unknown, no task-create.
  const f = await recoveryRun();
  const d1 = tmp('recon-ambig');
  const f1 = fakeOrca(
    d1,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'refused' } }],
      'orchestration task-list': [
        { ok: true, result: { tasks: [{ id: 'task_a', spec: f.specText }, { id: 'task_b', spec: f.specText }] } },
      ],
    },
    'term_sup',
  );
  const r1 = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    f1.env,
  );
  assert.equal(r1.code, 11); // launch_unknown
  assert.equal(hasCall(f1.log, 'orchestration task-create'), false);
  assert.equal(readState(f.runDir).participants[0].attempts[0].taskId, null);

  // Wrong confirmation id → config_invalid before any host read.
  const f2x = await recoveryRun();
  const d2 = tmp('recon-wrongid');
  const f2 = fakeOrca(d2, {}, 'term_sup');
  const r2 = await cliJson(
    ['reconcile', '--run', f2x.runDir, '--attempt', f2x.attemptId, '--confirm-no-effects', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--as-supervisor', '--json'],
    f2.env,
  );
  assert.equal(r2.code, 2); // config_invalid
  assert.match((r2.body.error as Record<string, unknown>).message as string, new RegExp(f2x.requestId));
  assert.equal(orcaCalls(f2.log).length, 0);

  // Pending request → the mutation may still land; refuse.
  const f3 = await recoveryRun();
  const d3 = tmp('recon-pending');
  const f3o = fakeOrca(
    d3,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'pending' } }],
    },
    'term_sup',
  );
  const r3 = await cliJson(
    ['reconcile', '--run', f3.runDir, '--attempt', f3.attemptId, '--confirm-no-effects', f3.requestId, '--as-supervisor', '--json'],
    f3o.env,
  );
  assert.equal(r3.code, 11); // launch_unknown
  assert.equal(hasCall(f3o.log, 'orchestration task-create'), false);
  assert.equal(readState(f3.runDir).participants[0].attempts[0].taskId, null);
});

test('reconcile keeps the engine guard armed when the retried task-create also fails', async () => {
  const f = await recoveryRun();
  const dir = tmp('recon-refail');
  const { env } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'refused' } }],
      'orchestration task-list': [{ ok: true, result: { tasks: [] } }],
      'orchestration task-create': [
        { ok: false, error: { code: 'refused', message: 'still not bound. Nothing changed. Orchestration mutation request ID: 11111111-2222-3333-4444-555555555555.' } },
      ],
    },
    'term_sup',
  );
  const r = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    env,
  );
  assert.equal(r.code, 10); // adapter_error
  assert.equal(readState(f.runDir).participants[0].attempts[0].taskId, null); // still null-task
  const errs = journalTail(f.runDir, 2).filter((e) => e.type === 'error');
  assert.equal(errs.length >= 1, true);
  assert.equal(errs[errs.length - 1].payload?.op, 'task-create'); // failure journaled, guard stays armed
});

test('concurrent reconciles on the same attempt create at most one task', async () => {
  // The whole read/probe/list/create/persist transaction runs under the run
  // lock: the loser blocks, re-reads state, sees the persisted taskId and
  // refuses invalid_transition — it never reaches the host at all.
  const f = await recoveryRun();
  const dir = tmp('recon-race');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'refused' } }],
      'orchestration task-list': [{ ok: true, result: { tasks: [] } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_race' } } }],
    },
    'term_sup',
  );
  const args = ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'];
  const [r1, r2] = await Promise.all([cliJson(args, env), cliJson(args, env)]);
  const codes = [r1.code, r2.code].sort();
  assert.deepEqual(codes, [0, 4], `one success one refusal, got ${r1.code} and ${r2.code}: ${r1.stderr} ${r2.stderr}`);
  assert.equal(
    orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create').length,
    1,
    'at most one task-create across both invocations',
  );
  assert.equal(readState(f.runDir).participants[0].attempts[0].taskId, 'task_race');
});

test('reconcile refuses to create on a timeout/unknown failure — even with a uuid and confirmation', async () => {
  // A journaled request id + operator confirmation + empty task-list is NOT
  // proof of no-effects: the timed-out task-create may have landed anyway.
  const f = await recoveryRun({
    failureMessage: `task-create request timed out; outcome unknown. Orchestration mutation request ID: 74a45889-c510-491e-9598-26264fc8f5c7.`,
  });
  const dir = tmp('recon-timeout');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'absent' } }], // ledger has no record either
      'orchestration task-list': [{ ok: true, result: { tasks: [] } }],
    },
    'term_sup',
  );
  const r = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    env,
  );
  assert.equal(r.code, 11, r.stdout + r.stderr); // launch_unknown
  assert.match((r.body.error as Record<string, unknown>).message as string, /not a verified definitive/);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
  assert.equal(readState(f.runDir).participants[0].attempts[0].taskId, null);

  // The same uncertain failure still allows ADOPTION of a unique matching
  // task — adopting an existing task can never create a duplicate.
  const f2 = await recoveryRun({
    failureMessage: `connection lost during task-create; outcome unknown. Orchestration mutation request ID: 74a45889-c510-491e-9598-26264fc8f5c7.`,
  });
  const d2 = tmp('recon-adopt-uncertain');
  const f2o = fakeOrca(
    d2,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'absent' } }],
      'orchestration task-list': [
        { ok: true, result: { tasks: [{ id: 'task_landed', spec: f2.specText }] } },
      ],
    },
    'term_sup',
  );
  const r2 = await cliJson(
    ['reconcile', '--run', f2.runDir, '--attempt', f2.attemptId, '--confirm-no-effects', f2.requestId, '--as-supervisor', '--json'],
    f2o.env,
  );
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.equal(r2.body.resolution, 'adopted');
  assert.equal(r2.body.taskId, 'task_landed');
  assert.equal(hasCall(f2o.log, 'orchestration task-create'), false);
});

test('reconcile treats a structured refused request state as verified no-effects and creates', async () => {
  // Journal message has no definitive marker, but the request ledger says the
  // mutation was refused — that is the structured verified no-effects signal.
  const f = await recoveryRun({
    failureMessage: `task-create rejected. Orchestration mutation request ID: 74a45889-c510-491e-9598-26264fc8f5c7.`,
  });
  const dir = tmp('recon-structured');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'refused' } }],
      'orchestration task-list': [{ ok: true, result: { tasks: [] } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_struct' } } }],
    },
    'term_sup',
  );
  const r = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    env,
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.resolution, 'created');
  assert.equal(r.body.taskId, 'task_struct');
  assert.equal(
    orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create').length,
    1,
  );
});

test('reconcile refuses malformed or incomplete task-list receipts instead of treating them as empty', async () => {
  const f = await recoveryRun();
  const cases: [string, unknown][] = [
    ['no task array at all', { result: 'unavailable' }],
    ['tasks field is not an array', { tasks: 'two tasks, trust me' }],
    ['non-object row', { tasks: ['task_a', { id: 'task_ok', spec: 'x' }] }],
    ['row with no identifiable fields', { tasks: [{ id: 'task_ok', spec: 'x' }, { status: 'running' }] }],
  ];
  for (const [label, receipt] of cases) {
    const dir = tmp('recon-malf');
    const { env, log } = fakeOrca(
      dir,
      {
        'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
        'orchestration request-show': [{ ok: true, result: { state: 'refused' } }],
        'orchestration task-list': [{ ok: true, result: receipt }],
      },
      'term_sup',
    );
    const r = await cliJson(
      ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
      env,
    );
    assert.equal(r.code, 11, `case "${label}": ${r.stdout} ${r.stderr}`);
    assert.equal(hasCall(log, 'orchestration task-create'), false, `case "${label}" created a task`);
  }
  assert.equal(readState(f.runDir).participants[0].attempts[0].taskId, null);
});

test('reconcile refuses an unreadable task ledger instead of assuming zero tasks', async () => {
  const f = await recoveryRun();
  const dir = tmp('recon-unread');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_child' } }],
      'orchestration request-show': [{ ok: true, result: { state: 'refused' } }],
      'orchestration task-list': [{ ok: false, error: { code: 'refused', message: 'run ledger unavailable' } }],
    },
    'term_sup',
  );
  const r = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    env,
  );
  assert.equal(r.code, 10, r.stdout + r.stderr); // adapter_error — ledger unreadable
  assert.equal(hasCall(log, 'orchestration task-create'), false);
  assert.equal(readState(f.runDir).participants[0].attempts[0].taskId, null);
});

test('reconcile refuses a journaled failure that carries no request id', async () => {
  const f = await recoveryRun({
    failureMessage: 'task-create failed: spawn error before the request was ever issued',
  });
  const dir = tmp('recon-nouuid');
  const { env, log } = fakeOrca(dir, {}, 'term_sup');
  const r = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--as-supervisor', '--json'],
    env,
  );
  assert.equal(r.code, 11, r.stdout + r.stderr); // launch_unknown — no request id to confirm
  assert.match((r.body.error as Record<string, unknown>).message as string, /no Orca request id/);
  assert.equal(orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create').length, 0);
  assert.equal(readState(f.runDir).participants[0].attempts[0].taskId, null);
});

test('reconcile refuses non-null-task attempts and missing evidence', async () => {
  // Attempt already carrying a task id → invalid_transition.
  const f = await recoveryRun({ attemptExtras: { taskId: 'task_already' } });
  const dir = tmp('recon-carried');
  const { env } = fakeOrca(dir, {}, 'term_sup');
  const r = await cliJson(
    ['reconcile', '--run', f.runDir, '--attempt', f.attemptId, '--confirm-no-effects', f.requestId, '--json'],
    env,
  );
  assert.equal(r.code, 4); // invalid_transition

  // Unknown attempt id → config_invalid.
  const f2 = await recoveryRun();
  const r2 = await cliJson(
    ['reconcile', '--run', f2.runDir, '--attempt', 'att_nope', '--confirm-no-effects', f2.requestId, '--json'],
    env,
  );
  assert.equal(r2.code, 2);
});

test('start-supervisor preserves an existing caller Run binding', async () => {
  const f = await initRun();
  const dir = tmp('sup-bound');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_newsup' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_newsup', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_newsup' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.callerRun, 'run_caller');
  assert.equal(r.body.taskId, 'task_sup');
  // No run-use: the caller's binding is preserved, never overwritten.
  assert.equal(hasCall(log, 'orchestration run-use'), false);
  const ws = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'orchestration worker-start')!;
  assert.ok(ws.includes('--task'));
  assert.equal(hasCall(log, 'orchestration run-current'), true);
  assert.equal(readState(f.runDir).supervisor?.terminalHandle, 'term_newsup');
});

test('start-supervisor with no bound Run uses worker-start --spec-file implicit Run', async () => {
  const f = await initRun();
  const dir = tmp('sup-unbound');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: null } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_newsup2' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_newsup2', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-start': [
        { ok: true, result: { dispatch: { id: 'ctx_newsup2' }, task: { id: 'task_implicit' } } },
      ],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.callerRun, null);
  // No pre-created task: task-create is skipped entirely.
  assert.equal(hasCall(log, 'orchestration task-create'), false);
  const ws = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'orchestration worker-start')!;
  assert.ok(ws.includes('--spec-file'));
  assert.ok(!ws.includes('--task') || ws.indexOf('--spec-file') < (ws.indexOf('--task') === -1 ? Infinity : ws.indexOf('--task')));
  assert.equal(readState(f.runDir).supervisor?.terminalHandle, 'term_newsup2');
});

test('start-supervisor pauses on a trust screen, then resumes the SAME task+terminal', async () => {
  const f = await initRun();
  const dir = tmp('sup-trust');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [
        { ok: true, result: { runId: 'run_caller' } },
        { ok: true, result: { runId: 'run_caller' } },
      ],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_t1' } } }],
      'terminal wait': [{ ok: true, result: {} }, { ok: true, result: {} }],
      'terminal show': [
        // Idle but stuck on a workspace-trust menu — the live bug shape.
        { ok: true, result: { terminal: { handle: 'term_t1', connected: true, agentIdentity: 'devin', agentWait: 'workspace-trust' } } },
        // After the human resolves trust inside that terminal.
        { ok: true, result: { terminal: { handle: 'term_t1', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-list': [{ ok: true, result: { workers: [] } }],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_sup' } } }],
    },
    'term_primary',
  );
  const args = ['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'];

  const r1 = await cliJson(args, env);
  assert.equal(r1.code, 0, r1.stdout + r1.stderr);
  assert.equal(r1.body.outcome, 'paused');
  assert.equal(r1.body.supervisorStarted, false);
  assert.equal(r1.body.needsAttention, true);
  assert.equal((r1.body.reason as { code: string }).code, 'agent_not_ready');
  assert.match((r1.body.reason as { message: string }).message, /waiting|trust|prompt/i);
  assert.equal(r1.body.taskId, 'task_sup');
  assert.equal(r1.body.terminalHandle, 'term_t1');
  assert.match(String(r1.body.recovery), /never auto-accept|re-run/i);
  // worker-start NEVER ran — the refusal precedes it.
  assert.equal(hasCall(log, 'orchestration worker-start'), false);
  // Durable evidence: task+terminal recorded, supervisor NOT persisted.
  const rec1 = JSON.parse(readFileSync(path.join(f.runDir, 'supervisor', 'startup.json'), 'utf8')) as {
    taskId: string | null;
    terminalHandle: string | null;
    status: string;
  };
  assert.equal(rec1.taskId, 'task_sup');
  assert.equal(rec1.terminalHandle, 'term_t1');
  assert.equal(rec1.status, 'paused');
  assert.equal(readState(f.runDir).supervisor, null);

  // Re-run after trust is resolved: recorded resources are reused, never duplicated.
  const r2 = await cliJson(args, env);
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.equal(r2.body.outcome, 'launched');
  const taskCreates = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create');
  const termCreates = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'terminal create');
  assert.equal(taskCreates.length, 1, 'recorded task reused — no duplicate task-create');
  assert.equal(termCreates.length, 1, 'recorded terminal reused — no duplicate terminal create');
  const ws = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'orchestration worker-start')!;
  assert.ok(ws.includes('task_sup') && ws.includes('term_t1'), 'same task+terminal on resume');
  assert.equal(readState(f.runDir).supervisor?.terminalHandle, 'term_t1');
});

test('start-supervisor pauses — never launches — on unrecognized/disconnected/malformed readiness', async () => {
  for (const [name, showResult, code] of [
    ['unrecognized agent', { terminal: { handle: 'term_t2', connected: true, agentIdentity: null, agentWait: null } }, 'agent_not_ready'],
    ['disconnected terminal', { terminal: { handle: 'term_t2', connected: false, agentIdentity: 'devin', agentWait: null } }, 'agent_not_ready'],
    ['malformed show receipt', { terminal: null }, 'readiness_unproven'],
    ['show describing another terminal', { terminal: { handle: 'term_other', connected: true, agentIdentity: 'devin', agentWait: null } }, 'readiness_unproven'],
    ['missing agentWait field', { terminal: { handle: 'term_t2', connected: true, agentIdentity: 'devin' } }, 'readiness_unproven'],
  ] as const) {
    const f = await initRun();
    const dir = tmp(`sup-nr-${name.replace(/\W+/g, '-')}`);
    const { env, log } = fakeOrca(
      dir,
      {
        'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
        'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup2' } } }],
        'terminal create': [{ ok: true, result: { terminal: { handle: 'term_t2' } } }],
        'terminal wait': [{ ok: true, result: {} }],
        'terminal show': [{ ok: true, result: showResult }],
      },
      'term_primary',
    );
    const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
    assert.equal(r.code, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.equal(r.body.outcome, 'paused', name);
    assert.equal((r.body.reason as { code: string }).code, code, name);
    assert.equal(hasCall(log, 'orchestration worker-start'), false, `${name}: worker-start must never run`);
    assert.equal(readState(f.runDir).supervisor, null, `${name}: no supervisor persisted`);
  }
});

test('start-supervisor pauses on a definitive worker-start refusal, then resumes on the SAME task', async () => {
  const f = await initRun();
  const dir = tmp('sup-refused');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [
        { ok: true, result: { runId: 'run_caller' } },
        { ok: true, result: { runId: 'run_caller' } },
      ],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_t3' } } }],
      'terminal wait': [{ ok: true, result: {} }, { ok: true, result: {} }],
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_t3', connected: true, agentIdentity: 'devin', agentWait: null } } },
        { ok: true, result: { terminal: { handle: 'term_t3', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-list': [{ ok: true, result: { workers: [] } }],
      'orchestration worker-start': [
        // Definitive refusal — the host's own "Nothing changed" marker.
        { ok: false, error: { code: 'not_bound', message: 'This caller is not bound. Nothing changed. Orchestration mutation request ID: u-1.' } },
        { ok: true, result: { dispatch: { id: 'ctx_sup3' } } },
      ],
    },
    'term_primary',
  );
  const args = ['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'];
  const r1 = await cliJson(args, env);
  assert.equal(r1.code, 0, r1.stdout + r1.stderr);
  assert.equal(r1.body.outcome, 'paused');
  assert.equal((r1.body.reason as { code: string }).code, 'start_refused');
  // Definitive refusal is resumable: the second run re-issues on the same resources.
  const r2 = await cliJson(args, env);
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  assert.equal(r2.body.outcome, 'launched');
  const taskCreates = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create');
  assert.equal(taskCreates.length, 1, 'no duplicate task after a definitive refusal');
  const starts = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration worker-start');
  assert.equal(starts.length, 2);
  assert.ok(starts[1].includes('task_sup'), 'resume starts the recorded task');
});

test('start-supervisor locks an unconfirmed worker-start — a re-run refuses rather than double-dispatch', async () => {
  const f = await initRun();
  const dir = tmp('sup-uncertain');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_t4' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_t4', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      // Timeout-shaped failure: NOT definitive — the mutation may have landed.
      // spyFile makes the fake host snapshot the durable record at the exact
      // moment worker-start arrives — proving start_issued was persisted
      // BEFORE the mutation, not only after its outcome.
      'orchestration worker-start': [
        {
          ok: false,
          error: { code: 'unknown', message: 'connection lost waiting for mutation receipt' },
          spyFile: path.join(f.runDir, 'supervisor', 'startup.json'),
          spyLabel: 'record-at-worker-start',
        },
      ],
    },
    'term_primary',
  );
  const args = ['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'];
  const r1 = await cliJson(args, env);
  assert.equal(r1.code, 0, r1.stdout + r1.stderr);
  assert.equal(r1.body.outcome, 'paused');
  assert.equal((r1.body.reason as { code: string }).code, 'start_uncertain');
  const rec = JSON.parse(readFileSync(path.join(f.runDir, 'supervisor', 'startup.json'), 'utf8')) as { status: string };
  assert.equal(rec.status, 'start_issued');
  // At the invocation seam the record already said start_issued — a crash
  // here can never be mistaken for "no start was attempted".
  const spy = spyReads(log).find((s) => s.spy === 'record-at-worker-start');
  assert.ok(spy?.content, 'expected the fake host to snapshot the record at worker-start');
  assert.match(spy!.content!, /"status":\s*"start_issued"/);

  // Re-run REFUSES — an unconfirmed dispatch must be reconciled, never re-issued.
  const r2 = await cliJson(args, env);
  assert.notEqual(r2.code, 0);
  const errOut = `${r2.stdout}${r2.stderr}`;
  assert.match(errOut, /already issued|launch_unknown/i);
  // Exactly one worker-start ever ran.
  const starts = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration worker-start');
  assert.equal(starts.length, 1);
});

test('start-supervisor resume refuses unsafe worker-list ledgers — never guesses custody', async () => {
  for (const [name, workerListResult, code, match] of [
    ['missing workers array', { other: 1 }, 'custody_unproven', /no workers array/i],
    ['malformed row', { workers: [null] }, 'custody_unproven', /no identifiable/i],
    ['unidentifiable row', { workers: [{ garbage: true }] }, 'custody_unproven', /no identifiable/i],
    // Physical 'released' without an explicit verdict is NOT proof of safe reuse.
    ['verdict-less released row', { workers: [{ terminal: 'term_t5', dispatchId: 'ctx_x', outcome: 'released' }] }, 'custody_unproven', /no explicit verdict/i],
    ['verdict-less settled row', { workers: [{ terminal: 'term_t5', dispatchId: 'ctx_x', state: 'settled' }] }, 'custody_unproven', /no explicit verdict/i],
    // A clearly-live row is a real ownership conflict — named differently.
    ['live owner', { workers: [{ terminal: 'term_t5', dispatchId: 'ctx_live', outcome: 'in_progress', liveness: 'live' }] }, 'terminal_owned', /already owns/i],
    // Explicit verdicts on OTHER terminals do not block.
    ['settled elsewhere is free', { workers: [{ terminal: 'term_other', dispatchId: 'ctx_o', outcome: 'succeeded' }] }, 'launched', ''],
  ] as const) {
    const f = await initRun();
    const dir = tmp(`sup-cust-${name.replace(/\W+/g, '-')}`);
    const { env, log } = fakeOrca(
      dir,
      {
        'orchestration run-current': [
          { ok: true, result: { runId: 'run_caller' } },
          { ok: true, result: { runId: 'run_caller' } },
        ],
        'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
        'terminal create': [{ ok: true, result: { terminal: { handle: 'term_t5' } } }],
        'terminal wait': [{ ok: true, result: {} }, { ok: true, result: {} }],
        'terminal show': [
          // First run pauses on a trust prompt → a resumable record exists.
          { ok: true, result: { terminal: { handle: 'term_t5', connected: true, agentIdentity: 'devin', agentWait: 'workspace-trust' } } },
          { ok: true, result: { terminal: { handle: 'term_t5', connected: true, agentIdentity: 'devin', agentWait: null } } },
        ],
        'orchestration worker-list': [{ ok: true, result: workerListResult }],
        'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_sup5' } } }],
      },
      'term_primary',
    );
    const args = ['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'];
    const r1 = await cliJson(args, env);
    assert.equal(r1.body.outcome, 'paused', `${name} setup: ${r1.stdout}${r1.stderr}`);
    const r2 = await cliJson(args, env);
    assert.equal(r2.code, 0, `${name}: ${r2.stdout}${r2.stderr}`);
    assert.equal(r2.body.outcome, code === 'launched' ? 'launched' : 'paused', name);
    if (code !== 'launched') {
      assert.equal((r2.body.reason as { code: string }).code, code, name);
      assert.match((r2.body.reason as { message: string }).message, match, name);
      assert.equal(hasCall(log, 'orchestration worker-start'), false, `${name}: no start on unproven custody`);
    }
  }
});

test('start-supervisor refuses when state already records a supervisor — zero host calls', async () => {
  const f = await initRun();
  const store = createStore({ runDir: f.runDir });
  const st = await store.loadState();
  assert.ok(st.ok);
  st.value.supervisor = { terminalHandle: 'term_existing', dispatchId: 'ctx_existing' };
  assert.ok((await store.saveState(st.value)).ok);

  const dir = tmp('sup-exists');
  const { env, log } = fakeOrca(dir, {}, 'term_primary');
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.match(`${r.stdout}${r.stderr}`, /already records a supervisor|invalid_transition/i);
  assert.equal(orcaCalls(log).length, 0, 'refusal precedes every host call');
});

test('init quotes spaced supervisor command paths and refuses dangerous shell chars', async () => {
  // A target path containing spaces: the generated supervisor advance command
  // must quote that token — never emit a bare path that the agent could split.
  const dir = tmp('quote');
  const spacedTarget = path.join(dir, 'tar get dir');
  writeTree(spacedTarget, { 'a.js': 'const a = 1;\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'Quote me.\n');
  // No COUNCIL_HOME: the run dir lands under the spaced target itself.
  const env: NodeJS.ProcessEnv = { ...process.env, ORCA_CLI_COMMAND: NO_ORCA };
  delete env.COUNCIL_HOME;
  const ok = await cliJson(
    ['init', '--objective', objective, '--target', spacedTarget, '--config', staffConfig(dir), '--json'],
    env,
  );
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  const cmd = ok.body.advanceCommand as string;
  // The run dir lives under the spaced target → its token is double-quoted.
  assert.match(cmd, /supervise --run "[^"]*" --advance --as-supervisor --json/);
  // No unquoted bare-space run dir leaked into the command.
  assert.doesNotMatch(cmd, /supervise --run \S+ \S+ --advance/);
  const spec = readFileSync(path.join(ok.body.runDir as string, 'prompts', 'supervisor.md'), 'utf8');
  assert.match(spec, /--advance --as-supervisor --json/);

  // Shell-dangerous characters in the path (e.g. `$`, backtick, `!`) are
  // refused outright — quoting them inside a fixed command would still
  // interpolate under the agent's shell.
  const dir2 = tmp('danger');
  const evilTarget = path.join(dir2, 'tar$get');
  writeTree(evilTarget, { 'a.js': 'const a = 1;\n' });
  const objective2 = path.join(dir2, 'objective.md');
  writeFileSync(objective2, 'Danger.\n');
  const env2: NodeJS.ProcessEnv = { ...process.env, ORCA_CLI_COMMAND: NO_ORCA };
  delete env2.COUNCIL_HOME;
  const evil = await cliJson(
    ['init', '--objective', objective2, '--target', evilTarget, '--config', staffConfig(dir2), '--json'],
    env2,
  );
  assert.equal(evil.code, 2); // config_invalid — cannot embed safely
  assert.equal((evil.body.error as Record<string, unknown>).code, 'config_invalid');
  assert.match((evil.body.error as Record<string, unknown>).message as string, /cannot be embedded safely/);
});

test('approve truncates an over-long note at the contract cap without failing', async () => {
  const { runId, runDir, target, env } = await initRun({ perspectives: 10, participants: 2 });
  const store = createStore({ runDir });
  assert.ok((await store.writeProposedRoster(proposedRoster(runId, 10))).ok);
  const rosterPath = path.join(target, 'roster.approved.json');
  writeFileSync(rosterPath, JSON.stringify(approvedRoster(runId, 2)));
  const locked = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    st.value.status = 'awaiting_approval';
    return store.saveState(st.value);
  });
  assert.ok(locked.ok);

  const longNote = 'n'.repeat(500); // far beyond the 128-char approver cap
  const r = await cliJson(['approve', '--run', runDir, '--roster', rosterPath, '--note', longNote, '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const approval = JSON.parse(readFileSync(path.join(runDir, 'approval.json'), 'utf8')) as {
    record: { approver: string };
  };
  // Contract cap is 128 chars; the base approver identity stays the prefix.
  assert.ok(approval.record.approver.length <= 128);
  assert.match(approval.record.approver, /^cli|^[^ ]+ — /);
});

// ─── catalog / staff / execution fingerprint ────────────────────────────────

test('catalog --json reports lanes, selectors and binary presence without auth claims', async () => {
  const r = await cliJson(['catalog', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.body.catalogVersion, CATALOG_VERSION);
  assert.equal(r.body.policyHash, LAUNCH_POLICY_HASH);
  const agents = r.body.agents as {
    agent: string;
    lane: string;
    permissionModes: string[];
    profileFlag: string | null;
    effortFlag: string | null;
    binary: { present: boolean; path?: string };
    verification: string;
  }[];
  assert.deepEqual(agents.map((a) => a.agent).sort(), ['claude', 'codex', 'devin']);
  for (const a of agents) {
    assert.equal(a.lane, 'argv');
    assert.equal(typeof a.binary.present, 'boolean');
    assert.ok(a.permissionModes.length > 0);
    assert.ok(['live-verified', 'help-verified', 'unverified'].includes(a.verification));
  }
  assert.equal(agents.find((a) => a.agent === 'codex')!.profileFlag, '--profile');
  assert.equal(agents.find((a) => a.agent === 'claude')!.effortFlag, '--effort');
  // Presence is PATH visibility only — never auth/approval/free/cost claims.
  assert.match(String(r.body.note), /not imply.*authenticated|informational/i);
  // No host calls happen at all: catalog is read-only.
  const { env, log } = fakeOrca(tmp('cat-orca'), {}, 'term_x');
  const r2 = await cliJson(['catalog', '--json'], env);
  assert.equal(r2.code, 0);
  assert.equal(orcaCalls(log).length, 0, 'catalog must never call orca');
});

test('init refuses a missing or partial staff — no defaults injected, no run created', async () => {
  const dir = tmp('nostaff');
  const target = path.join(dir, 'target');
  writeTree(target, { 'a.js': 'x\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'obj\n');
  const env = { COUNCIL_HOME: path.join(dir, 'council-home'), ORCA_CLI_COMMAND: NO_ORCA };

  // No config at all → staff missing.
  const none = await cliJson(['init', '--objective', objective, '--target', target, '--json'], env);
  assert.equal(none.code, 2);
  assert.equal((none.body.error as Record<string, unknown>).code, 'config_invalid');
  assert.match((none.body.error as Record<string, unknown>).message as string, /staff|catalog/);

  // Config present but staff absent → still refused.
  const cfgPath = path.join(dir, 'no-staff.json');
  writeFileSync(cfgPath, JSON.stringify({})); // schema-valid, staff simply absent
  const missing = await cliJson(['init', '--objective', objective, '--target', target, '--config', cfgPath, '--json'], env);
  assert.equal(missing.code, 2);
  assert.match((missing.body.error as Record<string, unknown>).message as string, /staff/);

  // Partial staff (organiser only) → schema-invalid config, still refused.
  const partial = path.join(dir, 'partial.json');
  writeFileSync(partial, JSON.stringify({ staff: { organiser: DEVIN } }));
  const pr = await cliJson(['init', '--objective', objective, '--target', target, '--config', partial, '--json'], env);
  assert.equal(pr.code, 2);
  assert.equal((pr.body.error as Record<string, unknown>).code, 'config_invalid');

  // Nothing was created — no run dir exists anywhere.
  assert.equal(existsSync(path.join(dir, 'council-home')), false, 'refused init must create nothing');
});

test('init validates every staff choice against the catalog before any mutation', async () => {
  const dir = tmp('badstaff');
  const target = path.join(dir, 'target');
  writeTree(target, { 'a.js': 'x\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'obj\n');
  const env = { COUNCIL_HOME: path.join(dir, 'council-home'), ORCA_CLI_COMMAND: NO_ORCA };

  for (const [name, staff] of [
    ['unknown agent', { ...STAFF, scribe: { agent: 'mystery', model: 'm', permissionMode: 'bypass' } }],
    ['unknown posture', { ...STAFF, supervisor: { agent: 'devin', model: 'swe-2-max', permissionMode: 'yolo' } }],
    ['unsupported effort', { ...STAFF, organiser: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass', effort: 'high' } }],
    ['profile on a profile-less lane', { ...STAFF, scribe: { agent: 'claude', model: 'sonnet-1', permissionMode: 'accept-edits', profile: 'work' } }],
    ['unsafe model token', { ...STAFF, scribe: { agent: 'devin', model: 'x; rm -rf /', permissionMode: 'bypass' } }],
    ['leading-@ model token', { ...STAFF, scribe: { agent: 'devin', model: '@splat', permissionMode: 'bypass' } }],
  ] as const) {
    const cfg = path.join(dir, `${name.replace(/\W+/g, '-')}.json`);
    writeFileSync(cfg, JSON.stringify({ staff }));
    const r = await cliJson(['init', '--objective', objective, '--target', target, '--config', cfg, '--json'], env);
    assert.equal(r.code !== 0, true, name);
    assert.equal(r.body.ok, false, name);
  }
  assert.equal(existsSync(path.join(dir, 'council-home')), false, 'refused init must create nothing');
});

test('init captures the catalog fingerprint and refuses a mismatched supplied one', async () => {
  const dir = tmp('fprint');
  const target = path.join(dir, 'target');
  writeTree(target, { 'a.js': 'x\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'obj\n');
  const env = { COUNCIL_HOME: path.join(dir, 'council-home'), ORCA_CLI_COMMAND: NO_ORCA };

  // A WRONG fingerprint (valid shape, wrong hash) is refused — never silently overwritten.
  const bad = staffConfig(dir, { execution: { catalogVersion: 'cat_test_0', policyHash: '0'.repeat(64) } });
  const r1 = await cliJson(['init', '--objective', objective, '--target', target, '--config', bad, '--json'], env);
  assert.equal(r1.code, 2);
  assert.match((r1.body.error as Record<string, unknown>).message as string, /fingerprint|match/i);

  // The correct fingerprint is accepted and persisted verbatim.
  const good = staffConfig(dir, { execution: { catalogVersion: CATALOG_VERSION, policyHash: LAUNCH_POLICY_HASH } });
  const r2 = await cliJson(['init', '--objective', objective, '--target', target, '--config', good, '--json'], env);
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  const state = readState(r2.body.runDir as string) as unknown as {
    config: { staff: { supervisor: { agent: string } }; execution: { catalogVersion: string; policyHash: string } };
  };
  assert.equal(state.config.staff.supervisor.agent, 'devin');
  assert.equal(state.config.execution.catalogVersion, CATALOG_VERSION);
  assert.equal(state.config.execution.policyHash, LAUNCH_POLICY_HASH);
});

/**
 * Tamper a run's persisted config as an EXTERNAL edit would — a drifted
 * fingerprint can never come through saveState (the schema validator would
 * refuse it); it arrives as a file the run must detect on READ. Values must
 * stay schema-valid (right shapes, right lengths) so loadState still parses —
 * the drift is policy-level, not structural.
 */
function mutateConfig(runDir: string, fn: (c: Record<string, unknown>) => void): void {
  const p = path.join(runDir, 'state.json');
  const s = JSON.parse(readFileSync(p, 'utf8')) as { config: Record<string, unknown> };
  fn(s.config);
  writeFileSync(p, JSON.stringify(s, null, 2));
}

test('verify reports catalog intact / drifted / legacy honestly', async () => {
  const f = await initRun();
  const clean = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(clean.code, 0);
  assert.equal((clean.body.catalog as { status: string }).status, 'intact');
  assert.equal(clean.body.verified, true);

  // Tamper the recorded fingerprint — verify calls it drifted, verified false.
  // Schema-valid shape (64-hex) so the drift is detected at READ, not at schema.
  mutateConfig(f.runDir, (c) => {
    (c.execution as { policyHash: string }).policyHash = '1'.repeat(64);
  });
  const drifted = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal((drifted.body.catalog as { status: string }).status, 'drifted');
  assert.equal(drifted.body.verified, false);

  // A legacy run (staff/execution absent) reports 'legacy' — absence stays absent.
  const f2 = await initRun();
  mutateConfig(f2.runDir, (c) => {
    delete c.staff;
    delete c.execution;
  });
  const legacy = await cliJson(['verify', '--run', f2.runDir, '--json'], f2.env);
  assert.equal(legacy.code, 0);
  assert.equal((legacy.body.catalog as { status: string }).status, 'legacy');
  assert.equal(legacy.body.verified, true);
});

test('start-supervisor refuses BEFORE any host call when the fingerprint drifted', async () => {
  const f = await initRun();
  mutateConfig(f.runDir, (c) => {
    (c.execution as { catalogVersion: string }).catalogVersion = 'cat_other';
  });
  const { env, log } = fakeOrca(tmp('sup-drift'), {}, 'term_primary');
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 2);
  assert.equal((r.body.error as Record<string, unknown>).code, 'config_invalid');
  assert.match((r.body.error as Record<string, unknown>).message as string, /fingerprint|catalog/i);
  assert.equal(orcaCalls(log).length, 0, 'a drifted fingerprint must refuse before ANY host call');
});

test('start-supervisor uses the SELECTED staff supervisor lane exactly', async () => {
  // Mixed staff: claude supervisor on the effort selector.
  const f = await initRun({
    config: {
      staff: {
        organiser: DEVIN,
        scribe: DEVIN,
        supervisor: { agent: 'claude', model: 'sonnet-1', permissionMode: 'accept-edits', effort: 'high' },
      },
    },
  });
  const { env, log } = fakeOrca(
    tmp('sup-claude'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_cl' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_cl', connected: true, agentIdentity: 'claude', agentWait: null } } },
      ],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_cl' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'launched');
  // The EXACT selected CLI argv reaches terminal create — no devin default.
  const tc = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'terminal create')!;
  assert.ok(tc.includes('--command=claude --model sonnet-1 --permission-mode acceptEdits --effort high'));
  // The startup record pins the choice + fingerprint.
  const rec = JSON.parse(readFileSync(path.join(f.runDir, 'supervisor', 'startup.json'), 'utf8')) as {
    supervisor: { command: string; expectedAgent: string; choice: { agent: string } };
    execution: { policyHash: string };
    status: string;
  };
  assert.equal(rec.supervisor.command, 'claude --model sonnet-1 --permission-mode acceptEdits --effort high');
  assert.equal(rec.supervisor.expectedAgent, 'claude');
  assert.equal(rec.supervisor.choice.agent, 'claude');
  assert.equal(rec.execution.policyHash, LAUNCH_POLICY_HASH);
  assert.equal(rec.status, 'attached');
  // The emitted payload reports the selected lane, never the legacy Devin pin.
  assert.equal(r.body.command, 'claude --model sonnet-1 --permission-mode acceptEdits --effort high');
});

test('start-supervisor on a codex staff supervisor emits the multi-token posture + named profile', async () => {
  const f = await initRun({
    config: {
      staff: {
        organiser: DEVIN,
        scribe: DEVIN,
        supervisor: { agent: 'codex', model: 'gpt-x', permissionMode: 'bypass', profile: 'work' },
      },
    },
  });
  const { env, log } = fakeOrca(
    tmp('sup-codex'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_cx' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_cx', connected: true, agentIdentity: 'codex', agentWait: null } } },
      ],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_cx' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const tc = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'terminal create')!;
  assert.ok(
    tc.includes('--command=codex --model gpt-x --sandbox danger-full-access --ask-for-approval never --profile work'),
  );
});

test('start-supervisor refuses to reuse resources after the staff choice changed', async () => {
  const f = await initRun();
  const dir = tmp('sup-changed');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_t1' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      // First run: trust screen → paused with durable resources.
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_t1', connected: true, agentIdentity: 'devin', agentWait: 'workspace-trust' } } },
      ],
    },
    'term_primary',
  );
  const r1 = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r1.body.outcome, 'paused');

  // The operator changes the supervisor staff choice between runs — the
  // recorded resources must NEVER silently serve a different supervisor.
  mutateConfig(f.runDir, (c) => {
    (c.staff as { supervisor: unknown }).supervisor = {
      agent: 'claude',
      model: 'sonnet-1',
      permissionMode: 'accept-edits',
    };
  });
  const r2 = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r2.code, 2);
  assert.equal((r2.body.error as Record<string, unknown>).code, 'config_invalid');
  assert.match((r2.body.error as Record<string, unknown>).message as string, /pins supervisor|changed/i);
  assert.equal(hasCall(log, 'orchestration worker-start'), false);
  assert.equal(readState(f.runDir).supervisor, null);
});

test('start-supervisor on a legacy (staff-less) run keeps the original Devin pin', async () => {
  const f = await initRun();
  // Legacy shape: staff and execution fields entirely absent — as a run saved
  // before the catalog existed would look. Absence must stay absence.
  mutateConfig(f.runDir, (c) => {
    delete c.staff;
    delete c.execution;
  });
  const { env, log } = fakeOrca(
    tmp('sup-legacy'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_lg' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_lg', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_lg' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const tc = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'terminal create')!;
  assert.ok(tc.includes('--command=devin --model swe-2-max --permission-mode dangerous'));
  const rec = JSON.parse(readFileSync(path.join(f.runDir, 'supervisor', 'startup.json'), 'utf8')) as {
    supervisor: { command: string; choice: unknown };
    execution: unknown;
  };
  assert.equal(rec.supervisor.command, 'devin --model swe-2-max --permission-mode dangerous');
  assert.equal(rec.supervisor.choice, null);
  assert.equal(rec.execution, null);
});

test('catalog --json is honest when a supported CLI is absent from PATH', async () => {
  // Simulate "devin absent, another lane present": PATH carries only the
  // fixture directory, so none of the binaries resolve — and catalog must
  // report MISSING, never assume presence or substitute a lane.
  const { env } = fakeOrca(tmp('cat-path'), {}, 'term_x');
  env.PATH = path.join(tmpdir(), 'definitely-empty-path-xyzzy');
  const r = await cliJson(['catalog', '--json'], env);
  assert.equal(r.code, 0);
  const agents = r.body.agents as { agent: string; binary: { present: boolean } }[];
  for (const a of agents) {
    assert.equal(a.binary.present, false, `${a.agent} should report MISSING on an empty PATH`);
  }
  // Still honest data — version/hash/selectors are all reported regardless.
  assert.equal(r.body.catalogVersion, CATALOG_VERSION);
});
