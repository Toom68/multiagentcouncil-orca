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
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_VERSION, type ProposedRoster, type ApprovedRoster } from '../src/contracts.js';
import { CATALOG_VERSION, LAUNCH_POLICY_HASH } from '../src/catalog.js';
import { createStore } from '../src/store.js';
import { recordManagedWrite, receiptJournalFields } from '../src/artifacts.js';

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
  // Never leak the host's own Orca identity into spawned children: a stray
  // ORCA_TERMINAL_HANDLE would let init/status capture a real recipient and
  // send real orchestration mail from a test. Tests that need an identity
  // pass it explicitly via env (fakeOrca).
  const base = { ...process.env };
  for (const k of ['ORCA_TERMINAL_HANDLE', 'ORCA_DISPATCH_ID', 'ORCA_TASK_ID', 'NODE_OPTIONS']) {
    if (!(k in env)) delete base[k];
  }
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...base, ...env }, timeout: 60_000 },
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
  return cli(args, env).then((r) => {
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    // A payload.helper.pid means the progress lane spawned a real detached
    // argv helper — track every spawn so afterEach never leaks one (bounded
    // to 24h by the module itself, but tests clean up immediately).
    const h = body !== null && typeof body === 'object' ? (body.helper as Record<string, unknown> | undefined) : undefined;
    if (h !== undefined && typeof h.pid === 'number') spawnedHelperPids.push(h.pid);
    return { ...r, body };
  });
}

const spawnedHelperPids: number[] = [];
test.afterEach(() => {
  for (const pid of spawnedHelperPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

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
  // Minimal env — never copy process.env wholesale (it would leak the host's
  // real ORCA_* identity and let the run capture/send real orchestration mail).
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ORCA_CLI_COMMAND: NO_ORCA,
  };
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
  // Init runs against a clean temp COPY of the tracked fixture tree — live
  // council artifacts under .council/.council-dev (host-run output, never
  // tracked source) stay out of the copy, so the check is independent of
  // any real council run that targeted the fixture. The original fixture
  // and its artifacts are untouched.
  const targetCopy = path.join(dir, 'review-target');
  cpSync(FIXTURE_TARGET, targetCopy, {
    recursive: true,
    filter: (source) => !['.council', '.council-dev'].includes(path.basename(source)),
  });
  const r = await cliJson(
    ['init', '--objective', objective, '--target', targetCopy, '--config', staffConfig(dir), '--json'],
    { COUNCIL_HOME: path.join(dir, 'council-home'), ORCA_CLI_COMMAND: NO_ORCA },
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const snap = JSON.parse(
    readFileSync(path.join(r.body.runDir as string, 'snapshot.json'), 'utf8'),
  ) as { files: Record<string, unknown> };
  assert.ok(Object.keys(snap.files).includes('src/pagination.js'));
  // The reviewed target itself was not mutated: run state lives under the
  // external COUNCIL_HOME, so no .council appears inside the copy.
  assert.ok(!existsSync(path.join(targetCopy, '.council')));
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
  for (const c of checks) assert.ok(['verified', 'missing', 'failed', 'unverified'].includes(c.status));
  // Host memory is informational and always present: a session-fit estimate
  // with its documented per-session footprint, never a readiness gate.
  const memory = checks.find((c) => c.name === 'memory')!;
  assert.equal(memory.required, false);
  assert.ok(['verified', 'unverified'].includes(memory.status));
  const mem = r.body.memory as {
    ramFreeMb: number;
    ramTotalMb: number;
    additionalSessionsEstimated: number;
    perSessionEstimate: { commitMb: number; ramMb: number };
    peakSessionsRequired?: number;
  };
  assert.equal(typeof mem.ramFreeMb, 'number');
  assert.equal(typeof mem.ramTotalMb, 'number');
  assert.equal(typeof mem.additionalSessionsEstimated, 'number');
  assert.ok(mem.perSessionEstimate.commitMb > 0 && mem.perSessionEstimate.ramMb > 0);
  assert.equal(mem.peakSessionsRequired, undefined); // no --config: no council sizing
});

test('doctor memory item warns when the council cannot fit — never a hard gate', async () => {
  const dir = tmp('doctor-mem');
  const cfg = path.join(dir, 'mem.json');
  writeFileSync(cfg, JSON.stringify({ participants: 15, staff: STAFF }));

  // An absurd per-session footprint forces the estimate to zero: the council
  // peak (15 seats + scribe + supervisor) can never fit — warning, not failure.
  const noFit = await cliJson(['doctor', '--config', cfg, '--json'], {
    COUNCIL_SESSION_COMMIT_MB: '999999999',
    COUNCIL_SESSION_RAM_MB: '999999999',
  });
  assert.equal(noFit.code, 0);
  const memNo = noFit.body.memory as {
    additionalSessionsEstimated: number;
    peakSessionsRequired: number;
    fits: boolean;
    warning?: string;
  };
  assert.equal(memNo.peakSessionsRequired, 17);
  assert.equal(memNo.fits, false);
  assert.match(memNo.warning ?? '', /15 seats.*scribe.*supervisor/);
  const memCheck = (noFit.body.checks as { name: string; required: boolean; status: string }[]).find(
    (c) => c.name === 'memory',
  )!;
  assert.equal(memCheck.required, false); // informational — `ready` never flips on it

  // A tiny footprint always fits: no warning, fits true.
  const fits = await cliJson(['doctor', '--config', cfg, '--json'], {
    COUNCIL_SESSION_COMMIT_MB: '1',
    COUNCIL_SESSION_RAM_MB: '1',
  });
  assert.equal(fits.code, 0);
  const memYes = fits.body.memory as { fits: boolean; warning?: string };
  assert.equal(memYes.fits, true);
  assert.equal(memYes.warning, undefined);
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
  // receipts-v1 genesis: store.initialize writes run.initialized as seq 1.
  assert.equal(empty.body.totalEvents, 1);
  assert.equal((empty.body.events as { type: string }[])[0].type, 'run.initialized');

  const store = createStore({ runDir });
  const appended = await store.appendJournal([
    { ts: new Date().toISOString(), type: 'phase.entered', actor: 'engine', payload: { status: 'organising' } },
  ]);
  assert.ok(appended.ok);
  const r = await cliJson(['tail', '--run', runDir, '--lines', '5', '--json'], env);
  assert.equal(r.code, 0);
  assert.equal(r.body.totalEvents, 2);
  assert.equal((r.body.events as { type: string }[])[1].type, 'phase.entered');
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
  const snapshot = drift.body.snapshot as { drift: boolean; changed: string[]; blockingDrift: boolean };
  assert.equal(snapshot.drift, true);
  assert.equal(snapshot.blockingDrift, true);
  assert.deepEqual(snapshot.changed, ['src/app.js']);
});

/** Drive a fresh run through the approval gate via the real CLI + store. */
async function approveRun(f: InitFixture, seats = 2): Promise<void> {
  const store = createStore({ runDir: f.runDir });
  assert.ok((await store.writeProposedRoster(proposedRoster(f.runId, 10))).ok);
  const rosterPath = path.join(f.target, 'roster.approved.json');
  writeFileSync(rosterPath, JSON.stringify(approvedRoster(f.runId, seats)));
  const locked = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    st.value.status = 'awaiting_approval';
    return store.saveState(st.value);
  });
  assert.ok(locked.ok);
  const ok = await cliJson(['approve', '--run', f.runDir, '--roster', rosterPath, '--json'], f.env);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
}

interface VerifyApproval {
  present: boolean;
  bindingIntact?: boolean;
  matchesStateHash?: boolean;
  matchesCurrentArtifacts?: boolean;
  rebuiltHash?: string;
  recordHash?: string;
  unreadableArtifacts?: Record<string, string>;
}

test('verify parity: a tampered approved roster fails the rebuilt-binding check the gate enforces', async () => {
  const f = await initRun({ perspectives: 10, participants: 2 });
  await approveRun(f);

  const clean = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(clean.code, 0);
  assert.equal(clean.body.verified, true);
  const appr0 = clean.body.approval as VerifyApproval;
  assert.equal(appr0.matchesCurrentArtifacts, true);
  assert.equal(appr0.rebuiltHash, appr0.recordHash);

  // Edit ONLY roster.approved.json — a schema-valid seat-model swap that
  // leaves approval.json and state.json untouched. The stored record is
  // internally consistent yet the launch gate would invalidate it.
  const rosterFile = path.join(f.runDir, 'roster.approved.json');
  const original = readFileSync(rosterFile, 'utf8');
  const tampered = JSON.parse(original) as { seats: { agent: { model: string } }[] };
  tampered.seats[0].agent.model = 'swe-2-maxx';
  writeFileSync(rosterFile, JSON.stringify(tampered, null, 2));

  const stale = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(stale.code, 0);
  assert.equal(stale.body.verified, false, 'stored-consistent but stale approval must not verify');
  const appr = stale.body.approval as VerifyApproval;
  assert.equal(appr.bindingIntact, true, 'the stored record itself is untouched — still internally consistent');
  assert.equal(appr.matchesCurrentArtifacts, false, 'rebuilt binding diverges from the recorded approval');
  assert.notEqual(appr.rebuiltHash, appr.recordHash);
  const human = await cli(['verify', '--run', f.runDir], f.env);
  assert.match(human.stdout, /artifacts DIVERGED|INTEGRITY ISSUES/);

  // Restore, then tamper the PROPOSED roster instead — proposedRosterHash
  // is inside the binding, so this must fail identically.
  writeFileSync(rosterFile, original);
  const proposedFile = path.join(f.runDir, 'roster.proposed.json');
  const proposedOriginal = readFileSync(proposedFile, 'utf8');
  const tamperedProposed = JSON.parse(proposedOriginal) as { perspectives: { name: string }[] };
  tamperedProposed.perspectives[0].name = 'Tampered charter name';
  writeFileSync(proposedFile, JSON.stringify(tamperedProposed, null, 2));
  const stale2 = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(stale2.body.verified, false);
  assert.equal((stale2.body.approval as VerifyApproval).matchesCurrentArtifacts, false);

  // Back to clean — parity holds in both directions.
  writeFileSync(proposedFile, proposedOriginal);
  const restored = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(restored.body.verified, true);
  assert.equal((restored.body.approval as VerifyApproval).matchesCurrentArtifacts, true);
});

test('verify parity: tampered state objective/config fails, unreadable artifacts are honest', async () => {
  const f = await initRun({ perspectives: 10, participants: 2 });
  await approveRun(f);

  // state.objective is inside the binding — a schema-valid edit must diverge.
  const stateFile = path.join(f.runDir, 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { objective: string };
  const originalObjective = state.objective;
  state.objective = 'Tampered objective — not what was approved';
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const stale = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(stale.body.verified, false);
  assert.equal((stale.body.approval as VerifyApproval).matchesCurrentArtifacts, false);
  // The file-vs-state objective divergence is visible too.
  assert.equal((stale.body.objectiveMd as { matchesStateObjective: boolean }).matchesStateObjective, false);
  state.objective = originalObjective;
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const restored = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(restored.body.verified, true);

  // A deleted roster.approved.json cannot be rebuilt against — reported as
  // unreadable, never silently OK (the gate fails approval_stale identically).
  rmSync(path.join(f.runDir, 'roster.approved.json'));
  const gone = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(gone.body.verified, false);
  const appr = gone.body.approval as VerifyApproval;
  assert.equal(appr.matchesCurrentArtifacts, false);
  assert.ok(appr.unreadableArtifacts !== undefined);
  assert.match(appr.unreadableArtifacts!.approvedRoster, /.+/);
});

test('verify reads the authoritative journal — a corrupt middle line fails closed', async () => {
  const f = await initRun();
  const store = createStore({ runDir: f.runDir });
  // Two extra events so the tampered line sits mid-journal like the audit repro.
  const app = await store.appendJournal([
    { ts: new Date().toISOString(), type: 'error', actor: 'cli', payload: { op: 'probe', detail: 'a' } },
    { ts: new Date().toISOString(), type: 'error', actor: 'cli', payload: { op: 'probe', detail: 'b' } },
  ]);
  assert.ok(app.ok, JSON.stringify(app));
  const journalPath = path.join(f.runDir, 'events.jsonl');
  const lines = readFileSync(journalPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  assert.ok(lines.length >= 3, 'marker + 2 appended events expected');
  const mid = JSON.parse(lines[1]) as { actor?: string };
  mid.actor = 'forged';
  lines[1] = JSON.stringify(mid);
  writeFileSync(journalPath, lines.join('\n') + '\n');
  // Verify must fail closed on the corrupt chain — never report a
  // verified snapshot over a journal it declined to read.
  const r = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.notEqual(r.code, 0);
  const errBody = r.body.error as { code: string; details?: { reason?: string } };
  assert.equal(errBody.code, 'io_error');
  assert.equal(errBody.details?.reason, 'journal_corrupt');
});

test('verify binds the journal — marker disagreement and tracked-byte tamper are not verified', async () => {
  const f = await initRun();
  // journalBinding + launchGate must be reported on a healthy run.
  const clean = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  assert.equal(clean.body.verified, true);
  assert.equal((clean.body.managedArtifacts as { journalBinding: string }).journalBinding, 'bound');
  assert.equal(clean.body.launchGate, true);
  assert.equal(clean.body.managedBlocking, null);

  // Marker disagreement: strip council.json's integrityPolicy while the
  // journal still carries the receipts-v1 marker → policy conflict →
  // verified:false even though nothing else drifted.
  const metaPath = path.join(f.runDir, 'council.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { integrityPolicy?: string };
  const policy = meta.integrityPolicy;
  delete meta.integrityPolicy;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  const conflict = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(conflict.code, 0, conflict.stdout + conflict.stderr);
  assert.equal(conflict.body.verified, false, 'meta/journal marker disagreement must never verify');
  assert.equal((conflict.body.managedArtifacts as { policy: string }).policy, 'conflict');
  assert.equal(conflict.body.managedBlocking, 'policy conflict');

  // Restore, then tamper a TRACKED managed artifact's bytes — receipts
  // bound to the journal must convict the drift; verified:false.
  meta.integrityPolicy = policy;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  const store = createStore({ runDir: f.runDir });
  const w = await recordManagedWrite(store, 'artifacts/verify-probe.txt', 'receipted bytes\n', 'archive');
  assert.ok(w.ok, JSON.stringify(w));
  assert.ok(w.value.receipt !== undefined);
  // The index receipt alone is index_only — the artifact.written journal
  // event is what binds it (engine emits one per managed write).
  const jw = await store.appendJournal([
    {
      ts: new Date().toISOString(),
      type: 'artifact.written',
      actor: 'cli',
      payload: { kind: 'archive', ...receiptJournalFields(w.value.receipt) },
    },
  ]);
  assert.ok(jw.ok, JSON.stringify(jw));
  const okAfterWrite = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(
    okAfterWrite.body.verified,
    true,
    `a valid tracked artifact verifies clean: ${JSON.stringify({
      lg: okAfterWrite.body.launchGate,
      mb: okAfterWrite.body.managedBlocking,
      m: okAfterWrite.body.managedArtifacts,
      w: okAfterWrite.body.warnings,
    }).slice(0, 1500)}`,
  );
  writeFileSync(path.join(f.runDir, 'artifacts', 'verify-probe.txt'), 'tampered bytes\n');
  const tampered = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(tampered.code, 0);
  assert.equal(tampered.body.verified, false, 'a changed tracked byte must block verification');
  assert.equal(tampered.body.managedBlocking, 'journal-tracked artifacts not clean');
});

test('verify: added-only source drift is visible but non-blocking; pinned drift blocks and advises a new run', async () => {
  const { runDir, target, env } = await initRun();
  // A file the snapshot never pinned — the launch gate journals this as
  // non-blocking growth; verify must say so, not cry drift-blocked.
  writeFileSync(path.join(target, 'src', 'added.js'), 'export const added = true;\n');
  const v = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal(v.code, 0);
  assert.equal(v.body.verified, true, 'added-only drift does not block launches — verified must mirror the gate');
  const snap = v.body.snapshot as { drift: boolean; blockingDrift: boolean; added: string[]; manifestChanged: string[] };
  assert.equal(snap.drift, true);
  assert.equal(snap.blockingDrift, false);
  assert.deepEqual(snap.added, ['src/added.js']);
  assert.deepEqual(snap.manifestChanged, []);
  assert.ok((v.body.warnings as string[]).some((w) => /added/i.test(w)));

  // Pinned manifest drift DOES block — and the recovery text prescribes a
  // new run, never a nonexistent re-snapshot (clm_0004).
  writeFileSync(path.join(target, 'src', 'app.js'), 'export function main() { return 3; }\n');
  const blocked = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal(blocked.body.verified, false);
  const snap2 = blocked.body.snapshot as { blockingDrift: boolean; manifestChanged: string[]; added: string[] };
  assert.equal(snap2.blockingDrift, true);
  assert.ok(snap2.manifestChanged.includes('src/app.js'));
  assert.ok(snap2.added.includes('src/added.js'), 'added files stay visible alongside pinned drift');
  assert.match(blocked.body.note as string, /create a new run/);
  assert.doesNotMatch(blocked.body.note as string, /re-snapshot/);
  const human = await cli(['verify', '--run', runDir], env);
  assert.match(human.stdout, /create a new run/);
  assert.doesNotMatch(human.stdout, /re-snapshot/);
});

test('verify: objective.md divergence is surfaced as a warning, not silently ignored', async () => {
  const { runDir, env } = await initRun();
  const objectiveFile = path.join(runDir, 'objective.md');
  writeFileSync(objectiveFile, 'A different objective than the bound one.\n');
  const v = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal(v.code, 0);
  // The file is human-facing only — the hash binds state.objective — so the
  // verdict stays clean but the divergence is loud.
  assert.equal(v.body.verified, true);
  assert.equal((v.body.objectiveMd as { present: boolean; matchesStateObjective: boolean }).matchesStateObjective, false);
  assert.ok((v.body.warnings as string[]).some((w) => /objective\.md diverges/i.test(w)));
  const human = await cli(['verify', '--run', runDir], env);
  assert.match(human.stdout, /objective\.md: DIVERGED/);

  // Missing objective.md is likewise surfaced, not fatal.
  rmSync(objectiveFile);
  const gone = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal((gone.body.objectiveMd as { present: boolean }).present, false);
  assert.ok((gone.body.warnings as string[]).some((w) => /objective\.md missing/i.test(w)));
});

test('verify: a bound approvalHash with a missing approval.json fails like the gate', async () => {
  const { runDir, env } = await initRun();
  const stateFile = path.join(runDir, 'state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { approvalHash: string | null };
  state.approvalHash = 'a'.repeat(64);
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const v = await cliJson(['verify', '--run', runDir, '--json'], env);
  assert.equal(v.code, 0);
  assert.equal(v.body.verified, false, 'the gate blocks an approvalHash it cannot revalidate — verify must agree');
  assert.equal((v.body.approval as { present: boolean }).present, false);
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
  assert.match(ok.body.note as string, /already attempted the supervisor wake/);
  // No supervisor recorded and no council Run bound → the journaled
  // approval-wake honestly reports 'skipped', and wakeCommand is null.
  const supWake = ok.body.supervisorWake as { outcome: string; reason?: string };
  assert.equal(supWake.outcome, 'skipped');
  assert.match(supWake.reason!, /no supervisor identity or run bound/);
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

/** A run at the approval gate with a bound child Run and a recorded supervisor. */
async function approvalGateRun(): Promise<InitFixture & { rosterPath: string }> {
  const f = await initRun({ perspectives: 10, participants: 2 });
  const store = createStore({ runDir: f.runDir });
  assert.ok((await store.writeProposedRoster(proposedRoster(f.runId, 10))).ok);
  const rosterPath = path.join(f.target, 'roster.approved.json');
  writeFileSync(rosterPath, JSON.stringify(approvedRoster(f.runId, 2)));
  const locked = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    st.value.status = 'awaiting_approval';
    st.value.orcaRunId = 'run_child';
    st.value.supervisor = { terminalHandle: 'term_sup', dispatchId: 'ctx_sup' };
    return store.saveState(st.value);
  });
  assert.ok(locked.ok);
  return { ...f, rosterPath };
}

const approvalSends = (log: string) =>
  orcaCalls(log).filter((a) => a[1] === 'send' && a.some((t) => /approval granted/.test(t)));

test('approve: the supervisor wake goes to dispatch:<id> without --dispatch-id; a clean receipt has no error fields', async () => {
  const f = await approvalGateRun();
  const { env, log } = fakeOrca(tmp('approve-wake-ok'), {
    'orchestration send': [{ ok: true, result: { message: { id: 'msg_w1' }, mutation: { requestId: 'req_w1', replayed: false } } }],
  }, 'term_primary');
  const r = await cliJson(['approve', '--run', f.runDir, '--roster', f.rosterPath, '--json'], { ...f.env, ...env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const sends = approvalSends(log);
  assert.equal(sends.length, 1, JSON.stringify(orcaCalls(log)));
  const argv = sends[0];
  assert.equal(argv[argv.indexOf('--to') + 1], 'dispatch:ctx_sup');
  assert.ok(!argv.includes('--dispatch-id'), `no --dispatch-id payload: ${argv.join(' ')}`);
  assert.equal(argv[argv.indexOf('--from') + 1], 'term_primary');
  assert.deepEqual(r.body.supervisorWake, { to: 'dispatch:ctx_sup', outcome: 'sent', requestId: 'req_w1' });
});

test('approve: an uncertain supervisor wake shows the journaled host errorCode in JSON and human output', async () => {
  const f = await approvalGateRun();
  const message = 'Dispatch ctx_sup belongs to Run run_parent, not run_child. Orchestration mutation request ID: req_w2.';
  const scenario = {
    'orchestration send': [{
      ok: false,
      error: { code: 'dispatch_run_mismatch', message, data: { orchestrationRequestId: 'req_w2' } },
    }],
  };
  const { env, log } = fakeOrca(tmp('approve-wake-unknown'), scenario, 'term_primary');
  const r = await cliJson(['approve', '--run', f.runDir, '--roster', f.rosterPath, '--json'], { ...f.env, ...env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(approvalSends(log).length, 1, 'one send — no automatic retry');
  assert.deepEqual(r.body.supervisorWake, {
    to: 'dispatch:ctx_sup',
    outcome: 'unknown',
    errorCode: 'dispatch_run_mismatch',
    error: message,
    requestId: 'req_w2',
  });
  const receipt = readFileSync(path.join(f.runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> })
    .filter((e) => e.type === 'mail.sent' && e.payload?.kind === 'approval-wake' && e.payload.outcome !== 'intent');
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].payload?.errorCode, 'dispatch_run_mismatch', 'journaled, not just printed');
  assert.match(r.body.wakeCommand as string, /--to dispatch:ctx_sup/);

  // Human output carries the code.
  const g = await approvalGateRun();
  const g2 = fakeOrca(tmp('approve-wake-human'), scenario, 'term_primary');
  const human = await cli(['approve', '--run', g.runDir, '--roster', g.rosterPath], { ...g.env, ...g2.env });
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /supervisor wake: unknown → dispatch:ctx_sup \[dispatch_run_mismatch\] — Dispatch ctx_sup belongs/);
});

test('approve/verify/status accept a legacy approval-wake receipt without errorCode/error', async () => {
  const f = await approvalGateRun();
  // No supervisor Dispatch and no child Run → the engine journals 'skipped'
  // and approve prints without error fields; then append a legacy-shaped
  // receipt (journals written before errorCode existed) and read it back.
  const store = createStore({ runDir: f.runDir });
  const locked = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    st.value.supervisor = null;
    st.value.orcaRunId = null;
    return store.saveState(st.value);
  });
  assert.ok(locked.ok);
  const r = await cliJson(['approve', '--run', f.runDir, '--roster', f.rosterPath, '--json'], f.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal((r.body.supervisorWake as { outcome: string }).outcome, 'skipped');
  const appended = await store.withLock(() =>
    store.appendJournal([{
      ts: new Date().toISOString(),
      type: 'mail.sent',
      actor: 'engine',
      payload: { to: 'run:run_child', outcome: 'unknown', mailIntentId: 'mi_legacy', requestId: 'req_legacy', kind: 'approval-wake' },
    }]),
  );
  assert.ok(appended.ok, JSON.stringify(appended));
  const v = await cliJson(['verify', '--run', f.runDir, '--json'], f.env);
  assert.equal(v.code, 0, 'a legacy receipt parses');
  const st = await cliJson(['status', '--run', f.runDir, '--json'], f.env);
  assert.equal(st.code, 0, st.stdout + st.stderr);
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
    // A faithful post-engine journal: the engine emitted the receipts-v1
    // marker event at the head of the journal on its first advance — a run
    // this deep in the lifecycle always carries it.
    return store.appendJournal([
      {
        ts: new Date().toISOString(),
        type: 'run.initialized',
        actor: 'engine',
        payload: { runId: f.runId, integrity: 'receipts-v1', snapshotId: f.snapshotId },
      },
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
  // run-current (a READ for wake-recipient backfill) is fine; the mutation is
  // what manual mode must never perform — no run-use, ever.
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
    ['malformed row', { workers: [null] }, 'custody_unproven', /no dispatch id and no terminal identity/i],
    ['unidentifiable row', { workers: [{ garbage: true }] }, 'custody_unproven', /no dispatch id and no terminal identity/i],
    // Physical 'released' without an explicit verdict is NOT proof of safe reuse.
    ['verdict-less released row', { workers: [{ terminal: 'term_t5', dispatchId: 'ctx_x', outcome: 'released' }] }, 'custody_unproven', /no explicit verdict/i],
    ['verdict-less settled row', { workers: [{ terminal: 'term_t5', dispatchId: 'ctx_x', state: 'settled' }] }, 'custody_unproven', /no explicit verdict/i],
    // A clearly-live row is a real ownership conflict — named differently.
    ['live owner', { workers: [{ terminal: 'term_t5', dispatchId: 'ctx_live', outcome: 'in_progress', liveness: 'live' }] }, 'terminal_owned', /already owns/i],
    // Nested terminal.handle is a real identity too (adapter audit F3) —
    // an active owner there must NOT slip past the custody filter.
    ['nested live owner', { workers: [{ terminal: { handle: 'term_t5' }, dispatchId: 'ctx_nl', outcome: 'in_progress' }] }, 'terminal_owned', /already owns/i],
    ['nested verdict-less row', { workers: [{ terminal: { handle: 'term_t5' }, dispatchId: 'ctx_nv', outcome: 'released' }] }, 'custody_unproven', /no explicit verdict/i],
    // A verdict-less row whose terminal identity cannot be read cannot prove
    // it is not parked on our terminal — custody fails closed.
    ['unreadable identity verdict-less', { workers: [{ terminal: { noHandle: true }, dispatchId: 'ctx_u', outcome: 'released' }] }, 'custody_unproven', /placement cannot be proven/i],
    ['contradictory identity verdict-less', { workers: [{ terminal: 'term_a', terminalHandle: 'term_b', dispatchId: 'ctx_c', outcome: 'released' }] }, 'custody_unproven', /contradictory/i],
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
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ORCA_CLI_COMMAND: NO_ORCA };
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
  const env2: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ORCA_CLI_COMMAND: NO_ORCA };
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

// ─── supervisor replacement (--replace, clm_0037) ────────────────────────────
//
// The dead-supervisor dead end: a recorded supervisor whose terminal is gone
// (Orca restart invalidates runtime-scoped handles) had NO supported path —
// start-supervisor refused on the recorded identity, --as-supervisor refused
// on a different handle, and an attached record refused a relaunch. --replace
// is the only door out: journal-first retirement allowed ONLY when the old
// terminal is provably stale (documented code, never guessed from quiet or
// released) AND every recorded attach/dispatch custody resolves. All cases
// below use the fake host; nothing here is a live integration test.

const STALE_SHOW = {
  ok: false,
  error: { code: 'terminal_handle_stale', message: 'terminal not found — handle is stale' },
};

/** sha256 of the run's supervisor spec — required for a valid startup record. */
function specSha(runDir: string): string {
  return createHash('sha256')
    .update(readFileSync(path.join(runDir, 'prompts', 'supervisor.md')))
    .digest('hex');
}

function journalAll(runDir: string): { seq: number; type: string; payload?: Record<string, unknown> }[] {
  return readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { seq: number; type: string; payload?: Record<string, unknown> });
}

/**
 * Persist a recorded supervisor identity + (optionally) its startup record —
 * the shape a live-or-crashed supervisor leaves behind.
 */
async function seedSupervisor(
  f: InitFixture,
  opts: {
    terminal?: string;
    dispatch?: string | null;
    recordStatus?: string;
    boundRunId?: string;
    requestIds?: Record<string, string>;
    noRecord?: boolean;
  } = {},
): Promise<void> {
  const terminal = opts.terminal ?? 'term_dead';
  const dispatch = opts.dispatch === undefined ? 'ctx_dead' : opts.dispatch;
  const store = createStore({ runDir: f.runDir });
  const w = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    st.value.supervisor = { terminalHandle: terminal, dispatchId: dispatch };
    return store.saveState(st.value);
  });
  assert.ok(w.ok, `seed failed: ${JSON.stringify(w)}`);
  if (opts.noRecord === true) return;
  const rec = {
    schemaVersion: 1,
    runId: f.runId,
    specSha256: specSha(f.runDir),
    supervisor: {
      command: 'devin --model swe-2-max --permission-mode dangerous',
      expectedAgent: 'devin',
      choice: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
    },
    execution: { catalogVersion: CATALOG_VERSION, policyHash: LAUNCH_POLICY_HASH },
    lane: 'task-under-caller-run',
    boundRunId: opts.boundRunId ?? 'run_caller',
    taskId: 'task_dead',
    terminalHandle: terminal,
    requestIds: opts.requestIds ?? { taskCreate: 'req_t', terminalCreate: 'req_term', workerStart: 'req_ws' },
    status: opts.recordStatus ?? 'attached',
    dispatchId: dispatch,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(path.join(f.runDir, 'supervisor'), { recursive: true });
  writeFileSync(
    path.join(f.runDir, 'supervisor', 'startup.json'),
    JSON.stringify(rec, null, 2) + '\n',
  );
}

/** The fresh-launch half of a replace scenario (new resources attach cleanly). */
function freshLaunchScenario(newHandle = 'term_new', newDispatch = 'ctx_new'): Record<string, unknown[]> {
  return {
    'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
    'orchestration task-create': [{ ok: true, result: { task: { id: 'task_new' } } }],
    'terminal create': [{ ok: true, result: { terminal: { handle: newHandle } } }],
    'terminal wait': [{ ok: true, result: {} }],
    'terminal show': [
      { ok: true, result: { terminal: { handle: newHandle, connected: true, agentIdentity: 'devin', agentWait: null } } },
    ],
    'orchestration worker-start': [{ ok: true, result: { dispatch: { id: newDispatch } } }],
  };
}

/**
 * Persist a startup record at an arbitrary issue stage — the shape a crash
 * mid-launch leaves behind. `issued` markers are what prove (or fail to
 * prove) that a host mutation was never requested.
 */
function seedStartupRecord(f: InitFixture, over: Record<string, unknown>): void {
  const rec = {
    schemaVersion: 1,
    runId: f.runId,
    specSha256: specSha(f.runDir),
    supervisor: {
      command: 'devin --model swe-2-max --permission-mode dangerous',
      expectedAgent: 'devin',
      choice: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
    },
    execution: { catalogVersion: CATALOG_VERSION, policyHash: LAUNCH_POLICY_HASH },
    lane: 'task-under-caller-run',
    boundRunId: 'run_caller',
    taskId: null,
    terminalHandle: null,
    requestIds: {},
    status: 'intent',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
  mkdirSync(path.join(f.runDir, 'supervisor'), { recursive: true });
  writeFileSync(path.join(f.runDir, 'supervisor', 'startup.json'), JSON.stringify(rec, null, 2) + '\n');
}

const READY_SHOW = (h: string) => ({
  'terminal wait': [{ ok: true, result: {} }],
  'terminal show': [{ ok: true, result: { terminal: { handle: h, connected: true, agentIdentity: 'devin', agentWait: null } } }],
});

test('start-supervisor resumes a v2 task_created crash — same Task, exactly one terminal+attach', async () => {
  const f = await initRun();
  // Crash shape: task receipt persisted, terminal-create never issued.
  seedStartupRecord(f, {
    status: 'task_created',
    taskId: 'task_sup',
    requestIds: { taskCreate: 'req_t' },
    issued: { taskCreate: true },
  });
  const { env, log } = fakeOrca(
    tmp('sup-res-v2'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_v2' } } }],
      ...READY_SHOW('term_v2'),
      'orchestration worker-list': [{ ok: true, result: { workers: [] } }],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_v2' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'launched');
  assert.equal(hasCall(log, 'orchestration task-create'), false, 'recorded task must be reused — never re-created');
  const termCreates = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'terminal create');
  assert.equal(termCreates.length, 1, 'the missing terminal is created exactly once');
  const ws = orcaCalls(log).find((a) => a.slice(0, 2).join(' ') === 'orchestration worker-start')!;
  assert.ok(ws.includes('task_sup') && ws.includes('term_v2'));
  const rec = JSON.parse(readFileSync(path.join(f.runDir, 'supervisor', 'startup.json'), 'utf8')) as {
    issued: Record<string, boolean>;
    status: string;
  };
  assert.equal(rec.issued.terminalCreate, true, 'the resumed create left a durable issue marker');
  assert.equal(rec.status, 'attached');
});

test('start-supervisor resumes a v2 intent crash (no stages issued) — issues each exactly once', async () => {
  const f = await initRun();
  seedStartupRecord(f, { status: 'intent', issued: {} });
  const { env, log } = fakeOrca(
    tmp('sup-res-intent'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_v2' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_v2i' } } }],
      ...READY_SHOW('term_v2i'),
      'orchestration worker-list': [{ ok: true, result: { workers: [] } }],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_v2i' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'launched');
  assert.equal(
    orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create').length,
    1,
    'proven-not-issued task-create runs exactly once',
  );
  assert.equal(orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'terminal create').length, 1);
  const rec = JSON.parse(readFileSync(path.join(f.runDir, 'supervisor', 'startup.json'), 'utf8')) as {
    issued: Record<string, boolean>;
  };
  assert.equal(rec.issued.taskCreate, true);
  assert.equal(rec.issued.terminalCreate, true);
});

test('start-supervisor refuses a v2 record whose issued stage has no identity — zero new mutations', async () => {
  const f = await initRun();
  // terminal-create WAS issued but the handle never landed — the terminal
  // may exist out there; creating another is a duplicate.
  seedStartupRecord(f, {
    status: 'task_created',
    taskId: 'task_sup',
    requestIds: { taskCreate: 'req_t' },
    issued: { taskCreate: true, terminalCreate: true },
  });
  const { env, log } = fakeOrca(
    tmp('sup-res-unproven'),
    { 'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }] },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'launch_unknown');
  assert.match((r.body.error as Record<string, unknown>).message as string, /terminal-create as issued/);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
  assert.equal(hasCall(log, 'terminal create'), false);
  assert.equal(hasCall(log, 'orchestration worker-start'), false);
});

test('start-supervisor fails closed on a legacy (no issued map) ambiguous record — zero new mutations', async () => {
  // Legacy shape: predates `issued` — a missing identity cannot prove the
  // create was never requested, so the only safe answer is launch_unknown.
  for (const [name, over, match] of [
    ['missing terminal handle', { status: 'paused', taskId: 'task_sup', terminalHandle: null }, /legacy record.*terminal/i],
    ['missing both ids', { status: 'intent', taskId: null, terminalHandle: null }, /legacy record.*task id/i],
  ] as const) {
    const f = await initRun();
    seedStartupRecord(f, over);
    const { env, log } = fakeOrca(
      tmp(`sup-legacy-${name.replace(/\W+/g, '-')}`),
      { 'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }] },
      'term_primary',
    );
    const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
    assert.notEqual(r.code, 0, name);
    assert.equal((r.body.error as Record<string, unknown>).code, 'launch_unknown', name);
    assert.match((r.body.error as Record<string, unknown>).message as string, match, name);
    assert.equal(hasCall(log, 'orchestration task-create'), false, `${name}: no task-create over unknown custody`);
    assert.equal(hasCall(log, 'terminal create'), false, `${name}: no terminal create over unknown custody`);
  }
});

test('start-supervisor pauses a resume when the bound Run changed — zero new mutations', async () => {
  const f = await initRun();
  seedStartupRecord(f, {
    status: 'task_created',
    taskId: 'task_sup',
    issued: { taskCreate: true },
  });
  const { env, log } = fakeOrca(
    tmp('sup-res-rebind'),
    // The caller now resolves a DIFFERENT Run than the record was built on.
    { 'orchestration run-current': [{ ok: true, result: { runId: 'run_other' } }] },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'paused');
  assert.equal((r.body.reason as { code: string }).code, 'binding_changed');
  assert.equal(hasCall(log, 'orchestration task-create'), false);
  assert.equal(hasCall(log, 'terminal create'), false);
  assert.equal(hasCall(log, 'orchestration worker-start'), false);
  const rec = JSON.parse(readFileSync(path.join(f.runDir, 'supervisor', 'startup.json'), 'utf8')) as { status: string };
  assert.equal(rec.status, 'paused', 'record preserved — never overwritten with fresh state');
});

test('start-supervisor --replace refuses when nothing is recorded and no retirement is journaled', async () => {
  const f = await initRun();
  const { env } = fakeOrca(tmp('sup-rep-none'), {}, 'term_primary');
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'invalid_transition');
  assert.match((r.body.error as Record<string, unknown>).message as string, /nothing to replace/i);
  assert.equal(readState(f.runDir).supervisor, null);
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 0);
});

test('start-supervisor --replace refuses a still-resolving recorded terminal — stale never inferred', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  const { env, log } = fakeOrca(
    tmp('sup-rep-live'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      // The handle still resolves — even disconnected. A live record is NOT stale.
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_dead', connected: false, agentIdentity: 'devin', agentWait: null } } },
      ],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'invalid_transition');
  assert.match((r.body.error as Record<string, unknown>).message as string, /still resolves/i);
  // Identity, journal and record are all untouched — nothing was retired.
  assert.equal(readState(f.runDir).supervisor?.terminalHandle, 'term_dead');
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 0);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
  assert.equal(hasCall(log, 'terminal create'), false);
});

test('start-supervisor --replace refuses unproven staleness — a generic show failure is not proof', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  const { env, log } = fakeOrca(
    tmp('sup-rep-unproven'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      // Timeout-shaped failure: NOT the documented staleness verdict.
      'terminal show': [{ ok: false, error: { code: 'transient_timeout', message: 'connection timed out' } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'launch_unknown');
  assert.match((r.body.error as Record<string, unknown>).message as string, /not provably gone|definitive staleness/i);
  assert.equal(readState(f.runDir).supervisor?.terminalHandle, 'term_dead');
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 0);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
});

test('start-supervisor --replace refuses while the recorded worker-start request is pending', async () => {
  const f = await initRun();
  await seedSupervisor(f, { recordStatus: 'start_issued' });
  const { env, log } = fakeOrca(
    tmp('sup-rep-pending'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal show': [STALE_SHOW],
      'orchestration request-show': [{ ok: true, result: { state: 'pending' } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'launch_unknown');
  assert.match((r.body.error as Record<string, unknown>).message as string, /still pending/i);
  assert.equal(readState(f.runDir).supervisor?.terminalHandle, 'term_dead');
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 0);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
});

test('start-supervisor --replace refuses a live recorded dispatch — custody unresolved', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  const { env, log } = fakeOrca(
    tmp('sup-rep-livedispatch'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal show': [STALE_SHOW],
      'orchestration worker-show': [
        { ok: true, result: { dispatch: { id: 'ctx_dead', outcome: 'in_progress', liveness: 'live' } } },
      ],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'invalid_transition');
  assert.match((r.body.error as Record<string, unknown>).message as string, /still live/i);
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 0);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
});

test('start-supervisor --replace refuses a verdict-less worker row — released is not custody', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  const { env, log } = fakeOrca(
    tmp('sup-rep-verdictless'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal show': [STALE_SHOW],
      // worker-show can't settle the dispatch → a scoped ledger must.
      'orchestration worker-show': [{ ok: false, error: { code: 'unknown_dispatch', message: 'no such dispatch' } }],
      'orchestration worker-list': [
        { ok: true, result: { workers: [{ dispatchId: 'ctx_dead', terminal: 'term_dead', outcome: 'released' }] } },
      ],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'launch_unknown');
  assert.match((r.body.error as Record<string, unknown>).message as string, /no decisive verdict/i);
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 0);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
});

test('start-supervisor --replace refuses a nested-terminal live ledger row — identity normalized', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  const { env, log } = fakeOrca(
    tmp('sup-rep-nested'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal show': [STALE_SHOW],
      // worker-show can't settle the dispatch → the scoped ledger must.
      'orchestration worker-show': [{ ok: false, error: { code: 'unknown_dispatch', message: 'no such dispatch' } }],
      // A row claiming our terminal through nested terminal.handle — adapter
      // audit F3: it must reach the custody filter, never slip past it.
      'orchestration worker-list': [
        { ok: true, result: { workers: [{ dispatchId: 'ctx_nested', terminal: { handle: 'term_dead' }, outcome: 'in_progress' }] } },
      ],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'invalid_transition');
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 0);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
});

test('start-supervisor --replace refuses a verdict-less row with an unproven identity', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  const { env, log } = fakeOrca(
    tmp('sup-rep-unplaced'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal show': [STALE_SHOW],
      'orchestration worker-show': [{ ok: false, error: { code: 'unknown_dispatch', message: 'no such dispatch' } }],
      // The row's claimed terminal identity is self-contradictory and it
      // carries no verdict — it cannot prove it is not our supervisor.
      'orchestration worker-list': [
        { ok: true, result: { workers: [{ dispatchId: 'ctx_elsewhere', terminal: 'term_a', terminalHandle: 'term_b', outcome: 'released' }] } },
      ],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--json'], env);
  assert.notEqual(r.code, 0);
  assert.equal((r.body.error as Record<string, unknown>).code, 'launch_unknown');
  assert.match((r.body.error as Record<string, unknown>).message as string, /contradictory terminal identity/i);
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 0);
  assert.equal(hasCall(log, 'orchestration task-create'), false);
});

test('start-supervisor --replace retires a provably-stale supervisor — journaled, archived, fresh launch', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  const dir = tmp('sup-rep-ok');
  const { env, log } = fakeOrca(
    dir,
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal show': [
        STALE_SHOW, // the recorded supervisor's terminal is provably stale
        { ok: true, result: { terminal: { handle: 'term_new', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-show': [
        { ok: true, result: { dispatch: { id: 'ctx_dead', outcome: 'stopped' } } },
      ],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_new' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_new' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_new' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'launched');
  const replacedFrom = r.body.replacedFrom as { retired: string; archivePath: string | null };
  assert.equal(replacedFrom.retired, 'term_dead');
  assert.ok(replacedFrom.archivePath !== null, 'old record archived before the new launch');

  // New identity persisted — the old one is fully retired, not overwritten.
  const after = readState(f.runDir);
  assert.equal(after.supervisor?.terminalHandle, 'term_new');
  assert.equal(after.supervisor?.dispatchId, 'ctx_new');

  // Journal-first durable retirement with the evidence + original record.
  const retiredEvents = journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired');
  assert.equal(retiredEvents.length, 1);
  const payload = retiredEvents[0].payload!;
  assert.equal(payload.terminalHandle, 'term_dead');
  assert.equal(payload.dispatchId, 'ctx_dead');
  const probes = payload.probes as Record<string, Record<string, unknown>>;
  assert.equal(probes.terminalShow.state, 'stale');
  assert.equal((payload.record as Record<string, unknown>).status, 'attached');
  assert.equal((payload.record as Record<string, unknown>).terminalHandle, 'term_dead');

  // The archive preserves the full original record + probes.
  const archive = JSON.parse(readFileSync(path.join(f.runDir, replacedFrom.archivePath!), 'utf8')) as {
    kind: string;
    identity: { terminalHandle: string };
    record: { status: string; terminalHandle: string };
    probes: Record<string, unknown>;
  };
  assert.equal(archive.identity.terminalHandle, 'term_dead');
  assert.equal(archive.record.status, 'attached');
  assert.equal(archive.record.terminalHandle, 'term_dead');
  assert.match(replacedFrom.archivePath!, /^supervisor\/retired\//);

  // Fresh resources exactly once — never a duplicate of the old pair.
  const taskCreates = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration task-create');
  const termCreates = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'terminal create');
  const starts = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'orchestration worker-start');
  assert.equal(taskCreates.length, 1);
  assert.equal(termCreates.length, 1);
  assert.equal(starts.length, 1);
  // No rebinding: the caller's Run stays the caller's.
  assert.equal(hasCall(log, 'orchestration run-use'), false);
  assert.equal(r.body.callerRun, 'run_caller');
});

test('start-supervisor --replace resolves an unverifiable dispatch via complete scoped-ledger absence', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  const { env } = fakeOrca(
    tmp('sup-rep-ledger'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal show': [
        STALE_SHOW,
        { ok: true, result: { terminal: { handle: 'term_new', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-show': [{ ok: false, error: { code: 'unknown_dispatch', message: 'no such dispatch' } }],
      // Complete scoped ledger, zero rows → the unproven dispatch is absent.
      'orchestration worker-list': [{ ok: true, result: { workers: [] } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_new' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_new' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_new' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'launched');
  const retired = journalAll(f.runDir).find((e) => e.type === 'supervisor.retired')!;
  const probes = retired.payload!.probes as Record<string, Record<string, unknown>>;
  const workerShow = probes.workerShow as Record<string, { state: string }>;
  assert.equal(workerShow.ctx_dead.state, 'absent_on_complete_ledger');
});

test('start-supervisor --replace replays a journaled retirement idempotently after a crash', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  // Simulate the crash seam: the durable supervisor.retired decision exists,
  // but archive/tombstone/state-clear never ran.
  const store = createStore({ runDir: f.runDir });
  const j = await store.appendJournal([
    {
      ts: new Date().toISOString(),
      type: 'supervisor.retired',
      actor: 'orchestrator',
      payload: {
        terminalHandle: 'term_dead',
        dispatchId: 'ctx_dead',
        reason: 'explicit --replace',
        probes: { terminalShow: { state: 'stale', code: 'terminal_handle_stale' } },
        record: { status: 'attached', terminalHandle: 'term_dead' },
      },
    },
  ]);
  assert.ok(j.ok);

  const { env, log } = fakeOrca(
    tmp('sup-rep-replay'),
    freshLaunchScenario(),
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'launched');
  // The recorded decision is reused — not re-proven, not duplicated.
  assert.equal(journalAll(f.runDir).filter((e) => e.type === 'supervisor.retired').length, 1);
  // No terminal-show probe for term_dead ran (only the new terminal's
  // readiness show): one 'terminal show' call total.
  const shows = orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'terminal show');
  assert.equal(shows.length, 1);
  assert.ok(shows[0].includes('term_new'));
  assert.equal(readState(f.runDir).supervisor?.terminalHandle, 'term_new');
  // The old record was still archived by the replayed retirement.
  assert.ok(existsSync(path.join(f.runDir, 'supervisor', 'retired')), 'archive dir exists');
});

test('start-supervisor --replace on a self-recorded supervisor (no startup record) preserves identity evidence', async () => {
  const f = await initRun();
  await seedSupervisor(f, { noRecord: true });
  const { env } = fakeOrca(
    tmp('sup-rep-norec'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'terminal show': [
        STALE_SHOW,
        { ok: true, result: { terminal: { handle: 'term_new', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-show': [
        { ok: true, result: { dispatch: { id: 'ctx_dead', outcome: 'failed' } } },
      ],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_new' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_new' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_new' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'launched');
  const replacedFrom = r.body.replacedFrom as { archivePath: string | null };
  assert.ok(replacedFrom.archivePath !== null);
  assert.match(replacedFrom.archivePath!, /identity-term_dead\.json$/);
  const archive = JSON.parse(readFileSync(path.join(f.runDir, replacedFrom.archivePath!), 'utf8')) as {
    kind: string;
    identity: { terminalHandle: string; dispatchId: string };
  };
  assert.equal(archive.kind, 'supervisor-identity');
  assert.equal(archive.identity.dispatchId, 'ctx_dead');
});

test('status is read-only and reports supervisor health, activity age, phase deadline and actions', async () => {
  const f = await recoveryRun(); // intent_recorded attempt + journaled task-create refusal + recorded supervisor
  const { env, log } = fakeOrca(
    tmp('status-ro'),
    {
      'terminal show': [STALE_SHOW],
      'orchestration worker-show': [
        { ok: true, result: { dispatch: { id: 'ctx_sup', outcome: 'stopped' } } },
      ],
    },
    'term_primary',
  );
  const r = await cliJson(['status', '--run', f.runDir, '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);

  const health = r.body.supervisorHealth as Record<string, unknown>;
  assert.equal(health.probe, 'stale');
  assert.equal(health.dispatch, 'ended:stopped');
  const activity = r.body.activity as { lastEventAt: string | null; ageMs: number | null; events: number };
  assert.ok(activity.events > 0);
  assert.ok(activity.ageMs !== null && activity.ageMs >= 0);
  const phase = r.body.phase as { status: string; deadlineMs: number | null; overDeadline: boolean };
  assert.equal(phase.status, 'independent_review');
  assert.equal(typeof phase.deadlineMs, 'number');

  const actions = r.body.pendingActions as { kind: string; detail: string; command?: string }[];
  // The journaled no-task intent → the exact reconcile command.
  const recon = actions.find((a) => a.kind === 'reconcile');
  assert.ok(recon !== undefined, 'expected an actionable reconcile pending action');
  assert.match(recon!.command!, /--attempt att_rev-1_independent_review_r0_0 --confirm-no-effects 74a45889-c510-491e-9598-26264fc8f5c7/);
  // A provably-stale supervisor → the exact replacement command.
  const rep = actions.find((a) => a.kind === 'replace');
  assert.ok(rep !== undefined, 'expected a replace pending action for the stale supervisor');
  assert.match(rep!.command!, /start-supervisor --run .* --replace/);
  // Attempt-level dispatch exposure for manual fencing.
  const attempts = r.body.attempts as { attempts: { dispatchId: unknown }[] }[];
  assert.ok(Array.isArray(attempts) && attempts.length > 0);

  // Progress + integrity blocks are present and honest.
  assert.ok('notify' in r.body);
  assert.ok('integrity' in r.body);

  // Read-only proof: no host mutation ran — only the two documented reads.
  const mutating = orcaCalls(log).filter((a) =>
    ['orchestration task-create', 'orchestration worker-start', 'orchestration run-use', 'orchestration send', 'terminal create', 'terminal wait'].includes(
      a.slice(0, 2).join(' '),
    ),
  );
  assert.equal(mutating.length, 0, `status mutated the host: ${JSON.stringify(mutating)}`);
});

/** Recursive relative file listing — read-only proof for status diagnostics. */
function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out.sort();
}

test('status displays a corrupt progress outbox as unavailable — never as zero sends — and writes nothing', async () => {
  const f = await initRun();
  const outbox = path.join(f.runDir, 'progress', 'outbox.json');

  // A genuinely-new run: the outbox may be absent or empty — either way the
  // diagnostic shows 'ok' and zero counters, distinguishable from corruption.
  const fresh = await cliJson(['status', '--run', f.runDir, '--json'], f.env);
  assert.equal(fresh.code, 0, fresh.stdout + fresh.stderr);
  const n0 = fresh.body.notify as { outboxState?: string; deliveries?: { total?: number } };
  assert.equal(n0.outboxState, 'ok');
  assert.equal(n0.deliveries?.total, 0);

  // Corrupt the outbox custody file directly — counts must never render as
  // evidence of zero sends (they are placeholders, per the progress owner).
  mkdirSync(path.dirname(outbox), { recursive: true });
  writeFileSync(outbox, '{"schemaVersion":1,"intents":[CORRUPTED!!!');
  const before = listFiles(f.runDir);

  const r = await cliJson(['status', '--run', f.runDir, '--json'], f.env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const n = r.body.notify as { outboxState?: string; outboxError?: string; deliveries?: { total?: number; sent?: number } };
  assert.equal(n.outboxState, 'unavailable');
  assert.ok(typeof n.outboxError === 'string' && n.outboxError.length > 0);

  // Human output: unavailable + placeholders named, never a '0/0 sent' line.
  const human = await cli(['status', '--run', f.runDir], f.env);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /outbox UNAVAILABLE/);
  assert.match(human.stdout, /placeholders, NOT evidence of zero sends/);
  assert.doesNotMatch(human.stdout, /\b0\/0 sent\b/);

  // Read-only: status did not rebuild, rewrite, or extend anything.
  assert.deepEqual(listFiles(f.runDir), before);
  assert.equal(readFileSync(outbox, 'utf8'), '{"schemaVersion":1,"intents":[CORRUPTED!!!');
});

test('status does not advertise reconcile for an intent with no journaled request id', async () => {
  const f = await recoveryRun({ failureMessage: 'task-create failed: adapter exploded with no request id' });
  const { env } = fakeOrca(
    tmp('status-nointent'),
    {
      'terminal show': [STALE_SHOW],
      'orchestration worker-show': [{ ok: true, result: { dispatch: { id: 'ctx_sup', outcome: 'stopped' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['status', '--run', f.runDir, '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const actions = r.body.pendingActions as { kind: string; detail: string; command?: string }[];
  // The intent must surface as observation guidance — NEVER an invented
  // reconcile command (there is no journaled request id to confirm).
  const reconcile = actions.find((a) => a.kind === 'reconcile');
  assert.equal(reconcile, undefined);
  const inspect = actions.find((a) => a.kind === 'inspect' && /intent_recorded/.test(a.detail));
  assert.ok(inspect !== undefined, 'expected observation guidance for the intent_recorded attempt');
  assert.equal(inspect!.command, undefined);
});

test('init captures the caller bound Run as the wake recipient; --notify overrides', async () => {
  // Caller-bound capture: init inside an Orca terminal bound to run_parent
  // persists progress/recipient.json BEFORE any supervisor exists.
  const dir = tmp('init-recipient');
  const target = path.join(dir, 'target');
  writeTree(target, { 'src/a.js': 'const a = 1;\n' });
  const objective = path.join(dir, 'objective.md');
  writeFileSync(objective, 'Objective.\n');
  const councilHome = path.join(dir, 'council-home');
  const { env } = fakeOrca(
    dir,
    { 'orchestration run-current': [{ ok: true, result: { runId: 'run_parent' } }] },
    'term_primary',
  );
  env.COUNCIL_HOME = councilHome;
  const r = await cliJson(
    ['init', '--objective', objective, '--target', target, '--config', staffConfig(dir), '--json'],
    env,
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const recipient = JSON.parse(
    readFileSync(path.join(r.body.runDir as string, 'progress', 'recipient.json'), 'utf8'),
  ) as { to: string; source: string };
  assert.equal(recipient.to, 'run:run_parent');
  assert.equal(recipient.source, 'caller_run');
  const notify = r.body.notifyRecipient as { captured: boolean; recipient?: string };
  assert.equal(notify.captured, true);
  assert.equal(notify.recipient, 'run:run_parent');

  // Explicit --notify beats caller evidence.
  const dir2 = tmp('init-notify');
  const target2 = path.join(dir2, 'target');
  writeTree(target2, { 'src/a.js': 'const a = 1;\n' });
  const objective2 = path.join(dir2, 'objective.md');
  writeFileSync(objective2, 'Objective.\n');
  const { env: env2 } = fakeOrca(
    dir2,
    { 'orchestration run-current': [{ ok: true, result: { runId: 'run_parent' } }] },
    'term_primary',
  );
  env2.COUNCIL_HOME = path.join(dir2, 'council-home');
  const r2 = await cliJson(
    ['init', '--objective', objective2, '--target', target2, '--config', staffConfig(dir2), '--notify', 'run:run_explicit', '--json'],
    env2,
  );
  assert.equal(r2.code, 0, r2.stdout + r2.stderr);
  const recipient2 = JSON.parse(
    readFileSync(path.join(r2.body.runDir as string, 'progress', 'recipient.json'), 'utf8'),
  ) as { to: string; source: string };
  assert.equal(recipient2.to, 'run:run_explicit');
  assert.equal(recipient2.source, 'explicit');
});

test('start-supervisor --replace preserves the first durable recipient — never recaptured from the child context', async () => {
  const f = await initRun();
  await seedSupervisor(f);
  // Pre-persisted recipient — the initiating primary's original parent Run.
  mkdirSync(path.join(f.runDir, 'progress'), { recursive: true });
  writeFileSync(
    path.join(f.runDir, 'progress', 'recipient.json'),
    JSON.stringify({ schemaVersion: 1, to: 'run:run_origin', source: 'caller_run', recordedAt: new Date().toISOString() }, null, 2) + '\n',
  );
  const { env } = fakeOrca(
    tmp('sup-rep-recipient'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_different' } }],
      'terminal show': [
        STALE_SHOW,
        { ok: true, result: { terminal: { handle: 'term_new', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-show': [
        { ok: true, result: { dispatch: { id: 'ctx_dead', outcome: 'stopped' } } },
      ],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_new' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_new' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_new' } } }],
    },
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--replace', '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  // The replacing operator's own bound Run (run_different) must NOT displace
  // the persisted parent target — first durable wins without --notify.
  const recipient = JSON.parse(
    readFileSync(path.join(f.runDir, 'progress', 'recipient.json'), 'utf8'),
  ) as { to: string };
  assert.equal(recipient.to, 'run:run_origin');
  const notify = r.body.notifyRecipient as { recipient?: string; changed?: boolean };
  assert.equal(notify.recipient, 'run:run_origin');
  assert.notEqual(notify.changed, true);
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

// ─── Cross-lane integration: journal-head integrity marker ───────────────────
// Primary decision (msg_6de23577d5bd): store.initialize writes the receipts-v1
// run.initialized marker as journal seq 1 for NEW runs — no lazy first-engine-
// call dependence, no marker vocabulary in cli.ts. This test drives the REAL
// store with nothing seeded: the CLI's own journaled worker.started (seq 2+)
// must never leave a non-empty unmarked journal for the next engine call.
// RED until the artifacts lane lands the initialize-side marker.

test('real store init → start-supervisor → supervise --advance never hits integrity_policy_conflict', async () => {
  const f = await initRun();
  const { env, log } = fakeOrca(
    tmp('e2e-marker'),
    {
      'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
      'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
      'terminal create': [{ ok: true, result: { terminal: { handle: 'term_sup' } } }],
      'terminal wait': [{ ok: true, result: {} }],
      'terminal show': [
        { ok: true, result: { terminal: { handle: 'term_sup', connected: true, agentIdentity: 'devin', agentWait: null } } },
      ],
      'orchestration worker-start': [{ ok: true, result: { dispatch: { id: 'ctx_sup' } } }],
    },
    'term_primary',
  );
  const s = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(s.code, 0, s.stdout + s.stderr);
  assert.equal(s.body.outcome, 'launched');
  // Nothing was seeded: the journal's events are exactly what the real code
  // wrote. The first event must carry the receipts-v1 marker (store.initialize
  // contract) — the CLI's worker.started is allowed only AFTER it.
  const events = journalAll(f.runDir);
  assert.ok(events.length > 0);
  const first = events[0] as { type: string; payload?: Record<string, unknown> };
  assert.equal(first.type, 'run.initialized');
  assert.equal(first.payload?.integrity, 'receipts-v1');

  // The engine call resolves the integrity policy — a non-empty unmarked
  // journal is a conflict; this must advance (or fail for any OTHER reason).
  const adv = await cliJson(['supervise', '--run', f.runDir, '--advance', '--as-supervisor', '--json'], {
    ...env,
    ORCA_TERMINAL_HANDLE: 'term_sup',
  });
  if (adv.code !== 0) {
    const e = adv.body.error as { code?: string; message?: string; details?: { reason?: string } };
    assert.notEqual(e.details?.reason, 'integrity_policy_conflict', adv.stdout + adv.stderr);
  }
  // Fake-host note: any later failure here is scenario-shaped, not the bug.
  void log;
});

// ─── first-turn submission check on the supervisor launch path ──────────────

const SUP_RULE = '─'.repeat(60);
/** Exact live tail of a stuck first-turn Devin (2026-11-21). */
const SUP_STUCK = [
  `${SUP_RULE} (bypass permissions on) ─`,
  '❭ Please carry out this task from my Orca coordinator by following the brief I pasted below.',
  '  [Pasted text #1 +297 lines]',
  SUP_RULE,
  'SWE-2 Max                                    ctrl+v to paste image in clipboard',
  'Update v3000.14.30821 available!',
];
const SUP_WORKING = [
  '⣠ Running tools · 12s (esc twice to interrupt)',
  `${SUP_RULE} (bypass permissions on) ─`,
  '❭ Guide Devin while it works',
  SUP_RULE,
];
const screenEnv = (tail: string[]) => ({ ok: true, result: { terminal: { handle: 'term_newsup', status: 'running', source: 'screen', tail } } });
const supShow = (title: string) => ({ ok: true, result: { terminal: { handle: 'term_newsup', title, connected: true, agentIdentity: 'devin', agentWait: null } } });
/** worker-start receipt exactly as Orca returned it for a Devin supervisor (input_accepted only). */
const DEVIN_WS_RECEIPT = {
  ok: true,
  result: {
    state: 'ready',
    dispatchId: 'ctx_newsup',
    taskId: 'task_sup',
    stage: 'input_accepted',
    turnStart: 'unsupported',
    prompt: { stages: ['input_accepted'], provider: 'unsupported', observation: 'unsupported' },
  },
};
function supervisorScenario(extra: Record<string, unknown[]>): Record<string, unknown[]> {
  return {
    'orchestration run-current': [{ ok: true, result: { runId: 'run_caller' } }],
    'orchestration task-create': [{ ok: true, result: { task: { id: 'task_sup' } } }],
    'terminal create': [{ ok: true, result: { terminal: { handle: 'term_newsup' } } }],
    'terminal wait': [{ ok: true, result: {} }],
    'orchestration worker-start': [DEVIN_WS_RECEIPT],
    ...extra,
  };
}
const submitJournal = (runDir: string) =>
  readFileSync(path.join(runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { type: string; payload?: Record<string, unknown> })
    .filter((e) => e.type.startsWith('launch.submit'));

test('start-supervisor: an unsubmitted first-turn brief gets exactly one bare Enter, then is confirmed started', async () => {
  const f = await initRun();
  const dir = tmp('sup-submit');
  const { env, log } = fakeOrca(
    dir,
    supervisorScenario({
      'terminal show': [supShow('Devin ready'), supShow('Devin ready'), supShow('Devin ready'), supShow('Devin ready'), supShow('⠴ Devin')],
      'terminal read': [screenEnv(SUP_STUCK), screenEnv(SUP_STUCK), screenEnv(SUP_STUCK), screenEnv(SUP_WORKING)],
      'terminal send': [{ ok: true, id: 'send-rcpt-1', result: { send: { handle: 'term_newsup', accepted: true, bytesWritten: 1 } } }],
    }),
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], { ...env, COUNCIL_SUBMIT_PROBE_MS: '3000' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const sub = r.body.submission as Record<string, unknown>;
  assert.equal(sub.state, 'started');
  assert.equal(sub.nudged, true);
  assert.equal(sub.nudgeOutcome, 'sent');
  assert.equal(sub.turnStart, 'unsupported');
  const calls = orcaCalls(log);
  const sends = calls.filter((a) => a.slice(0, 2).join(' ') === 'terminal send');
  assert.equal(sends.length, 1, 'exactly one nudge');
  assert.deepEqual(sends[0], ['terminal', 'send', '--terminal', 'term_newsup', '--text', '\r', '--json']);
  const wsAt = calls.findIndex((a) => a.slice(0, 2).join(' ') === 'orchestration worker-start');
  const sendAt = calls.findIndex((a) => a.slice(0, 2).join(' ') === 'terminal send');
  assert.ok(wsAt >= 0 && sendAt > wsAt, 'the nudge follows the dispatch');
  // Only documented read commands probe; nothing else is ever typed.
  for (const a of calls.slice(wsAt + 1)) {
    const head = a.slice(0, 2).join(' ');
    assert.ok(['terminal show', 'terminal read', 'orchestration worker-show', 'terminal send'].includes(head), head);
  }
  const ev = submitJournal(f.runDir).map((e) => [e.type, e.payload?.stage ?? e.payload?.state, e.payload?.scope]);
  assert.deepEqual(ev, [
    ['launch.submit_check', 'unsubmitted', 'supervisor'],
    ['launch.submit_nudge', 'intent', 'supervisor'],
    ['launch.submit_nudge', 'receipt', 'supervisor'],
    ['launch.submit_check', 'started', 'supervisor'],
  ]);
  assert.equal(readState(f.runDir).supervisor?.dispatchId, 'ctx_newsup');
});

test('start-supervisor: an inconclusive check is a visible warning with the manual command — no nudge, launch still succeeds', async () => {
  const f = await initRun();
  const dir = tmp('sup-submit-inconclusive');
  const odd = [`${SUP_RULE} (bypass permissions on) ─`, '❭ something unexpected', SUP_RULE];
  const { env, log } = fakeOrca(
    dir,
    supervisorScenario({
      'terminal show': [supShow('Devin ready')],
      'terminal read': Array.from({ length: 20 }, () => screenEnv(odd)),
    }),
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], { ...env, COUNCIL_SUBMIT_PROBE_MS: '1200' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.body.outcome, 'launched');
  const sub = r.body.submission as Record<string, unknown>;
  assert.equal(sub.state, 'inconclusive');
  assert.equal(sub.warning, 'first_check_inconclusive');
  assert.equal(sub.command, "orca terminal send --terminal term_newsup --text $'\\r'");
  assert.equal(hasCall(log, 'terminal send'), false, 'never nudged on an inconclusive check');
  const warn = submitJournal(f.runDir).filter((e) => e.type === 'launch.submit_unconfirmed');
  assert.equal(warn.length, 1);
  assert.equal(warn[0]!.payload?.terminalHandle, 'term_newsup');

  // council status keeps the warning visible with the exact manual command.
  const st = await cliJson(['status', '--run', f.runDir, '--json'], { ...env, COUNCIL_SUBMIT_PROBE_MS: '1200' });
  assert.equal(st.code, 0, st.stdout + st.stderr);
  const submission = st.body.submission as Record<string, unknown>[];
  assert.equal(submission.length, 1);
  assert.equal(submission[0]!.scope, 'supervisor');
  assert.equal(submission[0]!.reason, 'first_check_inconclusive');
  const actions = st.body.pendingActions as { kind: string; command?: string }[];
  const act = actions.find((a) => a.kind === 'submit');
  assert.ok(act !== undefined, JSON.stringify(actions));
  assert.equal(act.command, "orca terminal send --terminal term_newsup --text $'\\r'");
  assert.equal(hasCall(log, 'terminal send'), false, 'status is read-only');

  // A later engine step proves the supervisor advanced the run — the warning retires.
  const store = createStore({ runDir: f.runDir });
  assert.ok((await store.appendJournal([{ ts: new Date().toISOString(), type: 'phase.entered', actor: 'engine', payload: { status: 'organising' } }])).ok);
  const st2 = await cliJson(['status', '--run', f.runDir, '--json'], { ...env, COUNCIL_SUBMIT_PROBE_MS: '1200' });
  assert.equal((st2.body.submission as unknown[]).length, 0);
});

test('start-supervisor: a receipt with observed (or absent) turn start skips the check entirely', async () => {
  const f = await initRun();
  const dir = tmp('sup-submit-observed');
  const { env, log } = fakeOrca(
    dir,
    supervisorScenario({
      'terminal show': [supShow('Devin ready')],
      'orchestration worker-start': [{ ok: true, result: { dispatchId: 'ctx_newsup', turnStart: 'observed' } }],
    }),
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal('submission' in r.body, false);
  assert.equal(hasCall(log, 'terminal read'), false);
  assert.equal(hasCall(log, 'terminal send'), false);
  assert.equal(submitJournal(f.runDir).length, 0);
});

test('status surfaces a crash-orphaned nudge intent (no receipt) for an active attempt, never for settled ones', async () => {
  const f = await initRun({ perspectives: 10, participants: 2 });
  const store = createStore({ runDir: f.runDir });
  const mk = (attemptId: string, status: string, handle: string) => ({
    attemptId,
    participantId: attemptId.includes('rev-1') ? 'rev-1' : 'rev-2',
    phase: 'independent_review',
    round: null,
    taskId: 'task_x',
    dispatchId: 'ctx_x',
    terminalHandle: handle,
    launchIntentId: 'li_x',
    status,
    createdAt: new Date().toISOString(),
    artifacts: [],
  });
  const w = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    const s = st.value;
    s.status = 'independent_review';
    s.orcaRunId = 'run_child';
    s.participants = (['rev-1', 'rev-2'] as const).map((pid, i) => ({
      participantId: pid,
      role: 'reviewer' as const,
      seatId: `seat-${i + 1}`,
      perspectiveId: `p${i + 1}`,
      agent: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
      retainedTerminal: null,
      status: 'active' as const,
      attempts: [
        mk(`att_${pid}_independent_review_r0_0`, pid === 'rev-1' ? 'dispatched' : 'settled_ok', `term_${pid}`),
      ] as never,
    }));
    const saved = await store.saveState(s);
    if (!saved.ok) return saved;
    return store.appendJournal(
      (['rev-1', 'rev-2'] as const).map((pid) => ({
        ts: new Date().toISOString(),
        type: 'launch.submit_nudge' as const,
        actor: 'engine',
        participantId: pid,
        phase: 'independent_review' as const,
        payload: { attemptId: `att_${pid}_independent_review_r0_0`, terminalHandle: `term_${pid}`, stage: 'intent', nudgeId: `sn_${pid}` },
      })),
    );
  });
  assert.ok(w.ok, JSON.stringify(w));
  const st = await cliJson(['status', '--run', f.runDir, '--json'], f.env);
  assert.equal(st.code, 0, st.stdout + st.stderr);
  const submission = st.body.submission as Record<string, unknown>[];
  assert.equal(submission.length, 1, JSON.stringify(submission));
  assert.equal(submission[0]!.attemptId, 'att_rev-1_independent_review_r0_0');
  assert.equal(submission[0]!.reason, 'nudge_receipt_missing');
  assert.equal(submission[0]!.command, "orca terminal send --terminal term_rev-1 --text $'\\r'");
  const actions = st.body.pendingActions as { kind: string; command?: string; detail: string }[];
  assert.ok(actions.some((a) => a.kind === 'submit' && a.command === submission[0]!.command && a.detail.includes('rev-1')));
  const human = await cli(['status', '--run', f.runDir], f.env);
  assert.match(human.stdout, /\[submit\]/);
  assert.match(human.stdout, /orca terminal send --terminal term_rev-1 --text \$'\\r'/);
});

test('start-supervisor: a journaled supervisor nudge intent forbids another nudge on that terminal', async () => {
  const f = await initRun();
  const store = createStore({ runDir: f.runDir });
  assert.ok((await store.appendJournal([{
    ts: new Date().toISOString(),
    type: 'launch.submit_nudge',
    actor: 'orchestrator',
    payload: { scope: 'supervisor', terminalHandle: 'term_newsup', dispatchId: 'ctx_old', stage: 'intent', nudgeId: 'sn_old' },
  }])).ok);
  const dir = tmp('sup-submit-guard');
  const { env, log } = fakeOrca(
    dir,
    supervisorScenario({
      'terminal show': [supShow('Devin ready')],
      'terminal read': Array.from({ length: 6 }, () => screenEnv(SUP_STUCK)),
    }),
    'term_primary',
  );
  const r = await cliJson(['start-supervisor', '--run', f.runDir, '--wait-ms', '1000', '--json'], { ...env, COUNCIL_SUBMIT_PROBE_MS: '3000' });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const sub = r.body.submission as Record<string, unknown>;
  assert.equal(sub.state, 'unsubmitted');
  assert.equal(sub.warning, 'nudge_already_attempted');
  assert.equal(hasCall(log, 'terminal send'), false, 'at most one nudge per terminal, even across runs of the command');
});

// ─── council cleanup ─────────────────────────────────────────────────────────

/**
 * A terminal (cancelled) run whose journal records ONE engine-created
 * reviewer terminal (term_c1), a supervisor startup record (term_sup), and a
 * second reviewer terminal that was never journaled as created (term_unrec).
 */
async function cleanupRun(): Promise<InitFixture> {
  const f = await initRun({ perspectives: 10, participants: 2 });
  const store = createStore({ runDir: f.runDir });
  const attempt = (pid: string, handle: string, dispatchId: string) => ({
    attemptId: `att_${pid}_independent_review_r0_0`,
    participantId: pid,
    phase: 'independent_review' as const,
    round: null,
    taskId: `task_${pid}`,
    dispatchId,
    terminalHandle: handle,
    launchIntentId: `li_${pid}`,
    status: 'settled_ok' as const,
    createdAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    artifacts: [],
  });
  const w = await store.withLock(async () => {
    const st = await store.loadState();
    if (!st.ok) return st;
    const s = st.value;
    s.status = 'cancelled';
    s.orcaRunId = 'run_child';
    s.supervisor = { terminalHandle: 'term_sup', dispatchId: 'ctx_sup' };
    s.participants = [
      { participantId: 'rev-1', role: 'reviewer', seatId: 'seat-1', perspectiveId: 'p1', agent: { ...DEVIN }, retainedTerminal: 'term_c1', status: 'settled', attempts: [attempt('rev-1', 'term_c1', 'ctx_r1')] },
      { participantId: 'rev-2', role: 'reviewer', seatId: 'seat-2', perspectiveId: 'p2', agent: { ...DEVIN }, retainedTerminal: 'term_unrec', status: 'settled', attempts: [attempt('rev-2', 'term_unrec', 'ctx_r2')] },
    ];
    const ws = await store.saveState(s);
    if (!ws.ok) return ws;
    return store.appendJournal([
      { ts: new Date().toISOString(), type: 'run.initialized', actor: 'engine', payload: { runId: f.runId, integrity: 'receipts-v1', snapshotId: f.snapshotId } },
      { ts: new Date().toISOString(), type: 'task.created', actor: 'engine', participantId: 'rev-1', payload: { attemptId: 'att_rev-1_independent_review_r0_0', scope: 'terminal', terminalHandle: 'term_c1', intentId: 'li_rev-1:terminal-create', taskId: 'task_rev-1', dispatchMarker: true } },
      { ts: new Date().toISOString(), type: 'run.finished', actor: 'engine', payload: { outcome: 'cancelled', reason: 'test' } },
    ]);
  });
  assert.ok(w.ok, JSON.stringify(w));
  assert.ok((await store.writeArtifact('supervisor/startup.json', JSON.stringify({
    schemaVersion: 1, runId: f.runId, specSha256: 'x', status: 'attached', terminalHandle: 'term_sup', dispatchId: 'ctx_sup', taskId: 'task_sup', requestIds: {},
  }))).ok);
  return f;
}

test('cleanup refuses a non-terminal run before any host call', async () => {
  const f = await initRun();
  const { env, log } = fakeOrca(tmp('cleanup-live'), {}, 'term_primary');
  const r = await cliJson(['cleanup', '--run', f.runDir, '--json'], env);
  assert.equal(r.code, 4, r.stdout + r.stderr); // invalid_transition
  assert.match((r.body.error as Record<string, unknown>).message as string, /terminal run/);
  assert.equal(orcaCalls(log).length, 0);
});

test('cleanup closes recorded participant + supervisor terminals (release first), never an unrecorded one; status points at it', async () => {
  const f = await cleanupRun();
  const settled = { ok: true, result: { dispatchId: 'ctx_sup', state: 'succeeded', outcome: 'succeeded' } };
  const retained = { ok: true, result: { state: 'retained', reason: 'user_requested', processAction: 'none' } };
  const { env, log } = fakeOrca(
    tmp('cleanup-term'),
    {
      'orchestration worker-show': [settled, settled, settled, settled],
      'orchestration worker-release': [retained, retained],
      'terminal close': [
        { ok: true, result: { close: { handle: 'term_c1', ptyKilled: true } } },
        { ok: true, result: { close: { handle: 'term_sup', ptyKilled: true } } },
      ],
    },
    'term_primary',
  );
  const before = await cliJson(['status', '--run', f.runDir, '--json'], env);
  assert.equal(before.code, 0, before.stdout + before.stderr);
  const pending = (before.body.pendingActions as { kind: string; command?: string; detail: string }[]).find((a) => a.kind === 'cleanup');
  assert.ok(pending !== undefined, JSON.stringify(before.body.pendingActions));
  assert.match(pending.command ?? '', /^council cleanup --run /);
  assert.match(pending.detail, /term_c1/);
  assert.doesNotMatch(pending.detail, /term_unrec/);

  const r = await cliJson(['cleanup', '--run', f.runDir, '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const terms = r.body.terminals as { terminalHandle: string; owner: string; outcome: string }[];
  assert.deepEqual(terms.map((t) => [t.terminalHandle, t.owner, t.outcome]), [
    ['term_c1', 'participant', 'closed'],
    ['term_sup', 'supervisor', 'closed'],
  ]);
  assert.deepEqual(r.body.summary, { closed: 2, alreadyGone: 0, skipped: 0, failed: 0 });
  const calls = orcaCalls(log).map((a) => a.join(' '));
  assert.ok(calls.every((c) => !c.includes('term_unrec') && !c.includes('ctx_r2')), 'the unrecorded terminal and its dispatch are never touched');
  const idx = (s: string) => calls.findIndex((c) => c.includes(s));
  assert.ok(idx('worker-release --dispatch ctx_r1') >= 0 && idx('worker-release --dispatch ctx_r1') < idx('terminal close --terminal term_c1'));
  assert.ok(idx('worker-release --dispatch ctx_sup') >= 0 && idx('worker-release --dispatch ctx_sup') < idx('terminal close --terminal term_sup'));
  assert.ok(calls.every((c) => !/taskkill|kill/.test(c)));
  const closes = journalAll(f.runDir).filter((e) => e.type === 'terminal.close');
  assert.deepEqual(closes.map((e) => [e.payload?.terminalHandle, e.payload?.stage, e.payload?.outcome ?? null]), [
    ['term_c1', 'intent', null], ['term_c1', 'receipt', 'closed'],
    ['term_sup', 'intent', null], ['term_sup', 'receipt', 'closed'],
  ]);
  assert.equal(readState(f.runDir).status, 'cancelled', 'cleanup never changes run state');

  // Idempotent: a second pass closes nothing and status no longer asks for cleanup.
  const again = await cliJson(['cleanup', '--run', f.runDir, '--json'], env);
  assert.equal(again.code, 0);
  assert.deepEqual((again.body.terminals as { outcome: string }[]).map((t) => t.outcome), ['skipped', 'skipped']);
  assert.equal(orcaCalls(log).filter((a) => a.slice(0, 2).join(' ') === 'terminal close').length, 2);
  const after = await cliJson(['status', '--run', f.runDir, '--json'], env);
  assert.ok(!(after.body.pendingActions as { kind: string }[]).some((a) => a.kind === 'cleanup'));
});

test('cleanup run from the supervisor terminal never closes itself', async () => {
  const f = await cleanupRun();
  const settled = { ok: true, result: { dispatchId: 'ctx_sup', state: 'succeeded', outcome: 'succeeded' } };
  const { env, log } = fakeOrca(tmp('cleanup-self'), { 'orchestration worker-show': [settled, settled] }, 'term_sup');
  const r = await cliJson(['cleanup', '--run', f.runDir, '--json'], env);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const sup = (r.body.terminals as { owner: string; outcome: string; reason?: string }[]).find((t) => t.owner === 'supervisor')!;
  assert.equal(sup.outcome, 'skipped');
  assert.match(sup.reason ?? '', /calling terminal/);
  assert.ok(!orcaCalls(log).some((a) => a.join(' ') === 'terminal close --terminal term_sup --json'));
});
