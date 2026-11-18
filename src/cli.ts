#!/usr/bin/env node
/**
 * `council` — the Multiagent Council CLI (see docs/USAGE.md).
 *
 * One deterministic entry point for the whole lifecycle: create a run
 * (`init`), verify the environment (`doctor`), drive one bounded engine step
 * (`supervise --advance`), record the approval gate (`approve`), observe
 * (`status`, `tail`, `verify`), stop (`cancel`), and optionally launch the
 * dedicated supervisor worker (`start-supervisor`).
 *
 * Every command accepts `--json` and prints `{ok:true,...}` on success or
 * `{ok:false,error:{code,message,issues?,details?}}` on failure; errors map
 * CouncilError.code to a stable non-zero exit code (see EXIT_BY_CODE). All
 * Orca interaction goes through the real HostAdapter — this file contains no
 * protocol logic and no fake workers.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  SCHEMA_VERSION,
  type AdvanceResult,
  type ApprovedRoster,
  type CouncilConfig,
  type CouncilError,
  type CouncilErrorCode,
  type CouncilState,
  type HostAdapter,
  type Participant,
  type PhaseAttempt,
  type Result,
  type Store,
} from './contracts.js';
import { createEngine } from './engine.js';
import {
  extractDispatchInfo,
  extractRequestId,
  createOrcaAdapter,
  parseOrcaEnvelope,
} from './host/orca.js';
import { resolveExecutable, runProcess } from './host/process.js';
import { createPromptBuilder } from './prompts.js';
import { captureSnapshot } from './snapshot.js';
import { createStore } from './store.js';
import {
  canonicalApprovalHash,
  err,
  minViableLaunches,
  parseApprovedRoster,
  resolveConfig,
} from './validation.js';

// ─── Exit codes ──────────────────────────────────────────────────────────────

const EXIT_INTERNAL = 1;
const EXIT_USAGE = 2;

/** Stable CouncilError.code → process exit code mapping. */
const EXIT_BY_CODE: Record<CouncilErrorCode, number> = {
  schema_invalid: EXIT_USAGE,
  config_invalid: EXIT_USAGE,
  roster_invalid: EXIT_USAGE,
  approval_required: 3,
  approval_stale: 3,
  invalid_transition: 4,
  barrier_refused: 5,
  budget_exceeded: 6,
  deadline_exceeded: 7,
  untrusted_output: 8,
  snapshot_drift: 9,
  adapter_error: 10,
  launch_unknown: 11,
  io_error: 12,
  cancelled: 13,
  unsupported: 14,
};

// ─── Small plumbing ──────────────────────────────────────────────────────────

class CliError extends Error {
  readonly error: CouncilError;
  constructor(error: CouncilError) {
    super(error.message);
    this.name = 'CliError';
    this.error = error;
  }
}

function fail(
  code: CouncilErrorCode,
  message: string,
  extra?: { issues?: CouncilError['issues']; details?: Record<string, unknown> },
): never {
  throw new CliError(err(code, message, extra));
}

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new CliError(r.error);
  return r.value;
};

/** Crockford base32 ULID — ids must satisfy the contract id charset. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(now = Date.now()): string {
  const bytes = randomBytes(16);
  let out = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i += 2) {
    const v = bytes.readUInt16BE(i);
    out += CROCKFORD[v % 32] + CROCKFORD[(v >> 5) % 32];
  }
  return out;
}

function usage(msg: string): never {
  return fail('config_invalid', msg, { details: { reason: 'usage' } });
}

interface ParsedFlags {
  json: boolean;
  help?: boolean;
  [k: string]: unknown;
}

function parseFlags(
  command: string,
  argv: readonly string[],
  options: Record<string, { type: 'string' | 'boolean'; default?: string | boolean }>,
): ParsedFlags {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        ...options,
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    usage(`council ${command}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const v = parsed!.values as ParsedFlags;
  if (v.help === true) usage(`council ${command} — see \`council help ${command}\` or docs/USAGE.md`);
  return v;
}

function reqStr(v: ParsedFlags, key: string, flag: string): string {
  const s = v[key];
  if (typeof s !== 'string' || s.length === 0) usage(`missing required ${flag}`);
  return s as string;
}

function optStr(v: ParsedFlags, key: string): string | undefined {
  const s = v[key];
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}

async function readJsonFile(path: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (e) {
    fail('io_error', `cannot read ${what} ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return JSON.parse(text!);
  } catch (e) {
    fail('schema_invalid', `${what} ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Quote one token for a verbatim spec command line. Paths are normalized to
 * forward slashes — Node accepts them on every OS and they are literal in
 * both POSIX shells and cmd.exe double-quoted strings. Bare tokens use a
 * shell-safe charset only; anything else is double-quoted unless it contains
 * a character that stays dangerous inside double quotes (`"` `$` `` ` `` `!`
 * `%` `^` `\` or a control char) — those fail loudly instead of ever
 * becoming shell syntax.
 */
const BARE_TOKEN_RE = /^[A-Za-z0-9_./:@-]+$/;
const DQUOTE_UNSAFE_RE = /["$`!%^\\\x00-\x1f]/;

function cmdToken(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (BARE_TOKEN_RE.test(normalized)) return normalized;
  if (DQUOTE_UNSAFE_RE.test(normalized)) {
    fail('config_invalid', `path cannot be embedded safely in the supervisor command: ${path}`);
  }
  return `"${normalized}"`;
}

// ─── Host wiring (real adapter, lazily resolved) ─────────────────────────────

function orcaExecutable(): string {
  const cmd = process.env.ORCA_CLI_COMMAND ?? 'orca';
  try {
    return resolveExecutable(cmd);
  } catch (e) {
    fail(
      'adapter_error',
      `orca executable not resolvable (${cmd}): ${e instanceof Error ? e.message : String(e)} — run \`council doctor\` to inspect the environment`,
    );
  }
}

/**
 * Defer Orca executable resolution to the first adapter call. Read-only
 * commands (status/tail/verify) must work where no Orca is installed; commands
 * that do reach the host get an honest adapter_error instead of a constructor
 * crash.
 */
function lazyHost(): HostAdapter {
  let real: HostAdapter | undefined;
  let initError: CouncilError | undefined;
  const get = (): Result<HostAdapter> => {
    if (real !== undefined) return { ok: true, value: real };
    if (initError !== undefined) return { ok: false, error: initError };
    try {
      real = createOrcaAdapter({
        ...(process.env.ORCA_CLI_COMMAND !== undefined
          ? { executablePath: process.env.ORCA_CLI_COMMAND }
          : {}),
        ...(process.env.ORCA_TERMINAL_HANDLE !== undefined
          ? { fromHandle: process.env.ORCA_TERMINAL_HANDLE }
          : {}),
      });
      return { ok: true, value: real };
    } catch (e) {
      initError = err(
        'adapter_error',
        `cannot create Orca host adapter: ${e instanceof Error ? e.message : String(e)}`,
        { details: { reason: 'adapter_init' } },
      );
      return { ok: false, error: initError };
    }
  };
  const call = <T>(m: (h: HostAdapter) => Promise<Result<T>>): Promise<Result<T>> => {
    const g = get();
    if (!g.ok) return Promise.resolve({ ok: false, error: g.error });
    return m(g.value);
  };
  return {
    createRun: (i) => call((h) => h.createRun(i)),
    createTask: (i) => call((h) => h.createTask(i)),
    launchWorker: (i) => call((h) => h.launchWorker(i)),
    observeWorker: (i) => call((h) => h.observeWorker(i)),
    sendNotification: (i) => call((h) => h.sendNotification(i)),
    requestStop: (i) => call((h) => h.requestStop(i)),
    releaseWorker: (i) => call((h) => h.releaseWorker(i)),
  };
}

function makeEngine(runDir: string) {
  const store = createStore({ runDir });
  const engine = createEngine({
    store,
    host: lazyHost(),
    prompts: createPromptBuilder(),
  });
  return { store, engine };
}

async function loadRun(store: Store) {
  const st = await store.loadState();
  if (!st.ok) {
    if (st.error.code === 'io_error') {
      fail('io_error', `run directory unreadable or not initialized: ${store.runDir}`, {
        details: st.error.details,
      });
    }
    throw new CliError(st.error);
  }
  return st.value;
}

/**
 * Run one `orca` CLI command through the bounded argv boundary and unwrap the
 * JSON envelope. Uncertain outcomes surface as adapter errors — callers must
 * reconcile, never blind-retry.
 */
async function orcaCli(args: readonly string[], timeoutMs = 60_000): Promise<unknown> {
  const file = orcaExecutable();
  const proc = await runProcess({ file, args }, { timeoutMs });
  if (proc.reason === 'timed_out') {
    fail('adapter_error', `orca ${args.join(' ')} timed out after ${timeoutMs}ms`, {
      details: { adapterCode: 'local_timeout', args: [...args] },
    });
  }
  if (proc.reason === 'spawn_failed') {
    fail('adapter_error', `orca spawn failed: ${proc.stderr}`, {
      details: { adapterCode: 'spawn_failed' },
    });
  }
  const parsed = parseOrcaEnvelope(proc);
  if (parsed.kind === 'json') {
    if (parsed.envelope.ok) return parsed.envelope.result;
    const e = parsed.envelope.error;
    const requestId = extractRequestId(parsed.envelope);
    fail('adapter_error', `orca ${args[0]} ${args[1] ?? ''} failed: ${e?.message ?? 'unknown'}`, {
      details: {
        adapterCode: e?.code ?? 'unknown',
        data: e?.data,
        ...(requestId !== undefined ? { requestId } : {}),
      },
    });
  }
  if (parsed.kind === 'error_line') {
    fail('adapter_error', `orca ${args[0]} failed: ${parsed.error.message}`, {
      details: { adapterCode: parsed.error.code },
    });
  }
  fail('adapter_error', `orca ${args[0]} returned unparseable output (exit ${proc.exitCode})`, {
    details: {
      adapterCode: 'unparsed_output',
      stdoutTail: proc.stdout.slice(-400),
      stderrTail: proc.stderr.slice(-400),
    },
  });
}

/** Non-throwing variant of orcaCli for reads whose failure is itself data. */
async function tryOrcaCli(args: readonly string[], timeoutMs = 60_000): Promise<Result<unknown>> {
  try {
    return { ok: true, value: await orcaCli(args, timeoutMs) };
  } catch (e) {
    if (e instanceof CliError) return { ok: false, error: e.error };
    return {
      ok: false,
      error: err('io_error', `unexpected failure: ${e instanceof Error ? e.message : String(e)}`),
    };
  }
}

/** Pull a run id from a run-current / run-use receipt (tolerant of shapes). */
function extractRunId(receipt: unknown): string | null {
  const r = receipt as Record<string, unknown> | null;
  if (r === null || typeof r !== 'object') return null;
  const run = r.run as Record<string, unknown> | undefined;
  const candidates = [r.runId, r.run_id, run?.id, run?.runId, r.id];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

/**
 * Dedicated-supervisor binding: ensure the CALLER terminal coordinates the
 * persisted council child Run. Idempotent — an already-correct binding is
 * left untouched; a missing or stale one is repaired through the documented
 * `orca orchestration run-use --id <run> --from <handle>` under the
 * supervisor's own identity (a coordinator resumes a run it supervises; a
 * worker could never bind its own/ancestor Run and we never target those —
 * only the persisted child Run). Manual driving never calls this: it must
 * not silently steal a live unrelated Run or displace another supervisor.
 * The caller's own prior binding is reported, never overwritten by us — and
 * start-supervisor keeps the primary caller's binding untouched entirely.
 */
async function ensureBoundToRun(
  orcaRunId: string,
  handle: string,
): Promise<{ prior: string | null; rebound: boolean }> {
  // Reads use the verified bare forms under the caller's own injected
  // identity (the handle IS this terminal); --from is only for the mutation.
  const before = await tryOrcaCli(['orchestration', 'run-current', '--json']);
  const prior = before.ok ? extractRunId(before.value) : null;
  if (prior === orcaRunId) return { prior, rebound: false };
  const used = await tryOrcaCli([
    'orchestration',
    'run-use',
    '--id',
    orcaRunId,
    '--from',
    handle,
    '--json',
    '--full',
  ]);
  if (!used.ok) throw new CliError(used.error);
  // run-use is a mutation: verify the intended end state actually took hold.
  const after = await tryOrcaCli(['orchestration', 'run-current', '--json']);
  const nowId = after.ok ? extractRunId(after.value) : null;
  if (nowId !== orcaRunId) {
    fail(
      'adapter_error',
      `run-use returned but this terminal is not verifiably bound to ${orcaRunId} (current: ${nowId ?? 'unverifiable'}) — reconcile the Orca binding before advancing`,
      { details: { adapterCode: 'bind_unverified', orcaRunId } },
    );
  }
  return { prior, rebound: true };
}

/**
 * Gate for --as-supervisor invocations: the caller must carry an Orca
 * terminal identity and must BE the recorded supervisor (or claim the role
 * when none is recorded). Refusing here prevents a second supervisor — or
 * the primary driving manually — from silently displacing the live one.
 */
function requireDedicatedSupervisor(state: CouncilState, handle: string | undefined): string {
  if (handle === undefined || handle.length === 0) {
    fail(
      'config_invalid',
      '--as-supervisor requires an Orca terminal identity (ORCA_TERMINAL_HANDLE); the dedicated supervisor always runs inside Orca',
      { details: { reason: 'missing_terminal_handle' } },
    );
  }
  const recorded = state.supervisor;
  if (recorded !== null && recorded.terminalHandle !== handle) {
    fail(
      'invalid_transition',
      `this run's recorded supervisor is ${recorded.terminalHandle} — refusing to take over another supervisor's run; launch a fresh supervisor via \`council start-supervisor\` or run from the recorded terminal`,
      { details: { recordedSupervisor: recorded } },
    );
  }
  return handle;
}

function emit(payload: Record<string, unknown>, json: boolean, human: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...payload }, null, 2)}\n`);
  } else {
    process.stdout.write(`${human}\n`);
  }
}

function emitError(e: CouncilError, json: boolean): number {
  if (json) {
    const error: Record<string, unknown> = { code: e.code, message: e.message };
    if (e.issues !== undefined) error.issues = e.issues;
    if (e.details !== undefined) error.details = e.details;
    process.stdout.write(`${JSON.stringify({ ok: false, error }, null, 2)}\n`);
  } else {
    let text = `error [${e.code}]: ${e.message}`;
    for (const i of e.issues ?? []) {
      text += `\n  ${i.path}: ${i.message} (${i.code})`;
    }
    process.stderr.write(`${text}\n`);
  }
  return EXIT_BY_CODE[e.code] ?? EXIT_INTERNAL;
}

// ─── council init ────────────────────────────────────────────────────────────

async function cmdInit(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('init', argv, {
    objective: { type: 'string' },
    target: { type: 'string' },
    config: { type: 'string' },
  });
  const objectivePath = reqStr(v, 'objective', '--objective <file>');
  const targetArg = reqStr(v, 'target', '--target <path>');
  const configPath = optStr(v, 'config');

  let objective: string;
  try {
    objective = (await fsp.readFile(objectivePath, 'utf8')).trim();
  } catch (e) {
    fail('io_error', `cannot read objective file ${objectivePath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (objective!.length === 0) fail('config_invalid', `objective file ${objectivePath} is empty`);

  const targetAbs = resolve(targetArg);
  if (!existsSync(targetAbs)) fail('config_invalid', `target does not exist: ${targetAbs}`);

  const rawConfig = configPath === undefined ? undefined : await readJsonFile(configPath, 'config file');
  const cfg = resolveConfig(rawConfig);
  if (!cfg.ok) fail('config_invalid', 'invalid council config', { issues: cfg.issues });
  const config = cfg.value;

  const snap = unwrap(await captureSnapshot(targetAbs));
  const snapshot = snap;

  const runId = `crun_${ulid()}`;
  const councilRoot = process.env.COUNCIL_HOME !== undefined
    ? resolve(process.env.COUNCIL_HOME)
    : join(targetAbs, '.council');
  const runDir = join(councilRoot, 'runs', runId);
  await fsp.mkdir(runDir, { recursive: true });

  const store = createStore({ runDir });
  unwrap(
    await store.initialize({
      runId,
      targetRoot: snapshot.targetRoot,
      objective: objective!,
      config,
      snapshot,
    }),
  );

  const cliPath = fileURLToPath(import.meta.url);
  const advanceCommand = `node ${cmdToken(cliPath)} supervise --run ${cmdToken(runDir)} --advance --as-supervisor --json`;
  const prompts = createPromptBuilder();
  const spec = prompts.supervisor(
    {
      runId,
      runDir,
      targetRoot: snapshot.targetRoot,
      objective: objective!,
      snapshotId: snapshot.snapshotId,
      config,
    },
    { advanceCommand },
  );
  unwrap(await store.writeArtifact('prompts/supervisor.md', spec));

  const meta = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    tool: { name: 'multiagent-council', cli: 'council' },
    node: process.version,
    platform: process.platform,
    createdAt: new Date().toISOString(),
    snapshotId: snapshot.snapshotId,
    launchBudgetFloor: minViableLaunches(config),
  };
  unwrap(await store.writeArtifact('meta.json', `${JSON.stringify(meta, null, 2)}\n`));

  return {
    payload: {
      runId,
      runDir,
      snapshotId: snapshot.snapshotId,
      config,
      launchBudgetFloor: meta.launchBudgetFloor,
      supervisorSpec: 'prompts/supervisor.md',
      advanceCommand,
      hint: 'launch the supervisor worker with `council start-supervisor --run <runDir>` or per skills/council/SKILL.md, then let it drive `council supervise --advance`',
    },
    human: [
      `run created: ${runId}`,
      `  runDir:    ${runDir}`,
      `  snapshot:  ${snapshot.snapshotId} (${Object.keys(snapshot.files).length} files)`,
      `  seats:     ${config.participants} reviewers from ${config.requestedPerspectives} perspectives`,
      `  budget:    maxLaunches ${config.maxLaunches} (floor ${meta.launchBudgetFloor})`,
      `  supervisor spec written to prompts/supervisor.md`,
      `next: council start-supervisor --run <runDir>  (or launch it manually per skills/council/SKILL.md)`,
    ].join('\n'),
  };
}

// ─── council doctor ──────────────────────────────────────────────────────────

interface DoctorCheck {
  name: string;
  required: boolean;
  status: 'verified' | 'missing' | 'failed';
  version?: string;
  detail?: string;
}

async function checkCli(
  name: string,
  command: string,
  versionArgs: readonly string[],
  required: boolean,
): Promise<DoctorCheck> {
  let file: string;
  try {
    file = resolveExecutable(command);
  } catch (e) {
    return {
      name,
      required,
      status: 'missing',
      detail: `not on PATH: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const check: DoctorCheck = { name, required, status: 'verified', detail: file };
  if (versionArgs.length > 0) {
    const proc = await runProcess({ file, args: versionArgs }, { timeoutMs: 15_000 });
    if (proc.reason === 'exited' && proc.exitCode === 0) {
      const line = (proc.stdout.trim().split('\n')[0] ?? '').trim();
      if (line.length > 0) check.version = line.slice(0, 120);
    } else {
      check.detail = `${file} (${versionArgs.join(' ')} did not exit 0: ${proc.reason} code=${proc.exitCode})`;
    }
  }
  return check;
}

async function cmdDoctor(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  parseFlags('doctor', argv, {});
  const checks: DoctorCheck[] = [];

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'node',
    required: true,
    status: nodeMajor >= 22 ? 'verified' : 'failed',
    version: process.version,
    detail: nodeMajor >= 22 ? undefined : 'council requires Node.js >= 22',
  });

  // Orca executable + a real status call through the bounded argv boundary.
  const orcaCmd = process.env.ORCA_CLI_COMMAND ?? 'orca';
  let orcaFile: string | undefined;
  try {
    orcaFile = resolveExecutable(orcaCmd);
    checks.push({ name: 'orca', required: true, status: 'verified', detail: orcaFile });
  } catch (e) {
    checks.push({
      name: 'orca',
      required: true,
      status: 'missing',
      detail: `not on PATH: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  if (orcaFile !== undefined) {
    const proc = await runProcess({ file: orcaFile, args: ['status', '--json'] }, { timeoutMs: 20_000 });
    if (proc.reason === 'timed_out') {
      checks.push({ name: 'orca.status', required: true, status: 'failed', detail: 'timed out after 20s' });
    } else if (proc.reason === 'spawn_failed') {
      checks.push({ name: 'orca.status', required: true, status: 'failed', detail: `spawn failed: ${proc.stderr}` });
    } else if (proc.exitCode === 0) {
      const check: DoctorCheck = { name: 'orca.status', required: true, status: 'verified', detail: 'orca status --json ok' };
      const env = parseOrcaEnvelope(proc);
      if (env.kind === 'json' && env.envelope.ok) {
        const r = env.envelope.result;
        const ver =
          typeof r === 'object' && r !== null
            ? ((r as Record<string, unknown>).version ??
              (r as Record<string, unknown>).appVersion ??
              ((r as Record<string, unknown>).app as Record<string, unknown> | undefined)?.version)
            : undefined;
        if (typeof ver === 'string') check.version = ver;
      }
      checks.push(check);
    } else {
      checks.push({
        name: 'orca.status',
        required: true,
        status: 'failed',
        detail: `exit ${proc.exitCode}: ${(proc.stderr || proc.stdout).slice(-200)}`,
      });
    }
  }

  checks.push(await checkCli('devin', 'devin', ['--version'], true));
  checks.push(await checkCli('claude', 'claude', ['--version'], false));
  checks.push(await checkCli('codex', 'codex', ['--version'], false));

  const ready = checks.every((c) => !c.required || c.status === 'verified');
  return {
    payload: {
      ready,
      checks,
      note: 'missing optional agent CLIs only narrow roster choices; required checks gate real worker launches',
    },
    human: [
      `environment: ${ready ? 'READY' : 'NOT READY'}`,
      ...checks.map(
        (c) =>
          `  ${c.status.padEnd(8)} ${c.name}${c.required ? ' (required)' : ''}${c.version ? ` — ${c.version}` : ''}${c.detail ? ` — ${c.detail}` : ''}`,
      ),
    ].join('\n'),
  };
}

// ─── council supervise ───────────────────────────────────────────────────────

const NEXT_HINT: Record<AdvanceResult['action'], string> = {
  progress:
    'internal work remains — invoke `council supervise --run <runDir> --advance` again immediately in the same turn',
  wait: 'nothing to do — end the turn and wait for an Orca wake (mail or worker_done)',
  needs_approval:
    'review <runDir>/roster.proposed.json, write roster.approved.json, run `council approve --run <runDir> --roster <file>`, then nudge the supervisor via `orca orchestration send --to dispatch:<supervisorDispatchId>`',
  finished: 'run is terminal — report the printed outcome (and reportPaths) to the coordinator',
  blocked: 'unrecoverable condition — inspect <runDir>/events.jsonl and decide (fix the cause, `council reconcile` a persisted no-task intent, or `council cancel`)',
};

async function cmdSupervise(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('supervise', argv, {
    run: { type: 'string' },
    advance: { type: 'boolean', default: false },
    'as-supervisor': { type: 'boolean', default: false },
  });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  if (v.advance !== true) {
    usage('council supervise performs one bounded step: pass --advance (see docs/USAGE.md)');
  }

  const { store, engine } = makeEngine(runDir);
  const state = await loadRun(store);
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  const dedicated = v['as-supervisor'] === true;
  let binding: { prior: string | null; rebound: boolean } | null = null;

  if (dedicated) {
    // Dedicated supervision: this terminal IS the run's supervisor. Bind it
    // to the persisted council child Run when a restart left that Run bound
    // to a vanished terminal — a mutation the host requires before any
    // task-create/worker-start can land. Never attempted in manual mode.
    const h = requireDedicatedSupervisor(state, handle);
    if (state.orcaRunId !== null) {
      binding = await ensureBoundToRun(state.orcaRunId, h);
    }
  }

  // Record the supervisor's durable identity so `council approve` can address
  // its wake exactly (writing approval files alone never wakes the agent).
  // A manual advance may record itself only when no DIFFERENT supervisor is
  // recorded — it must never overwrite a live supervisor's identity.
  if (
    handle !== undefined &&
    (dedicated || state.supervisor === null || state.supervisor.terminalHandle === handle)
  ) {
    const identified = await store.withLock(async () => {
      const st = await store.loadState();
      if (!st.ok) return st;
      const s = st.value;
      if (s.supervisor?.terminalHandle === handle && s.supervisor.dispatchId !== null) {
        return { ok: true as const, value: false };
      }
      s.supervisor = {
        terminalHandle: handle,
        dispatchId: s.supervisor?.dispatchId ?? process.env.ORCA_DISPATCH_ID ?? null,
      };
      const w = await store.saveState(s);
      if (!w.ok) return w;
      return { ok: true as const, value: true };
    });
    // Identity persistence is best-effort here: a failure surfaces on the next
    // advance call anyway and must not block the step itself.
    void identified;
  }

  const res = unwrap(await engine.advance());
  return {
    payload: {
      state: res.status,
      action: res.action,
      note: res.note ?? null,
      nextHint: NEXT_HINT[res.action],
      ...(binding !== null ? { binding } : {}),
      ...(res.artifacts !== undefined ? { artifacts: res.artifacts } : {}),
      ...(res.outcome !== undefined ? { outcome: res.outcome } : {}),
      ...(res.reportPaths !== undefined ? { reportPaths: res.reportPaths } : {}),
      runDir,
    },
    human: [
      `state: ${res.status}   action: ${res.action}`,
      ...(res.note !== undefined ? [`note:  ${res.note}`] : []),
      ...(binding !== null && binding.rebound
        ? [`bound: this terminal now coordinates ${state.orcaRunId} (was ${binding.prior ?? 'unbound'})`]
        : []),
      `next:  ${NEXT_HINT[res.action]}`,
    ].join('\n'),
  };
}

// ─── council reconcile ───────────────────────────────────────────────────────

/** Orca-issued request id shape (uuid form used in refusal receipts). */
const REQUEST_ID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const REQUEST_ID_TEST = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

function firstStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function asRec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

const normWs = (s: string): string => s.replace(/\s+/g, ' ').trim();
const normPath = (s: string): string => s.replace(/\\/g, '/');

/** Engine-identical worker task title (engine.ts launchAttempt). */
function attemptTaskTitle(p: Participant, attempt: PhaseAttempt): string {
  return `council ${attempt.phase}${attempt.round !== null ? ` r${attempt.round}` : ''} ${p.participantId}`;
}

/** Every request id a journaled task-create failure carries (message + payload). */
function journaledRequestIds(event: { payload?: Record<string, unknown> }): string[] {
  const out = new Set<string>();
  const p = event.payload ?? {};
  for (const v of [p.requestId, p.request_id, asRec(p.data)?.orchestrationRequestId]) {
    const m = typeof v === 'string' ? v.match(REQUEST_ID_TEST) : null;
    if (m !== null) out.add(m[0]);
  }
  if (typeof p.message === 'string') {
    for (const m of p.message.matchAll(REQUEST_ID_RE)) out.add(m[0]);
  }
  return [...out];
}

/**
 * task-list rows — refuse malformed or incomplete receipts rather than let a
 * bad read masquerade as "zero matching tasks" and unlock a second create.
 * A receipt must expose an explicit array; every row must be an object with
 * at least one identifiable field (id or spec-ish), else the read is treated
 * as untrusted evidence and reconciliation refuses.
 */
function taskRowsStrict(receipt: unknown, runId: string): Record<string, unknown>[] {
  const r = asRec(receipt);
  const list = r?.tasks ?? r?.items ?? (Array.isArray(receipt) ? receipt : undefined);
  if (!Array.isArray(list)) {
    fail('launch_unknown', `task-list for Run ${runId} returned no task array — the receipt is malformed or incomplete; reconcile manually`, {
      details: { adapterCode: 'malformed_task_list' },
    });
  }
  for (const row of list) {
    if (typeof row !== 'object' || row === null) {
      fail('launch_unknown', `task-list for Run ${runId} contains a non-object row — refusing to treat the read as reliable`, {
        details: { adapterCode: 'malformed_task_list' },
      });
    }
    const identifiable = [
      row.id, row.taskId, row.specFile, row.spec_file, row.specPath, row.spec_path,
      row.spec, row.title, row.taskTitle, row.task,
    ].some((v) => v !== undefined && v !== null);
    if (!identifiable) {
      fail('launch_unknown', `task-list for Run ${runId} contains a row with no task id or spec fields — refusing to treat the read as reliable`, {
        details: { adapterCode: 'incomplete_task_list' },
      });
    }
  }
  return list as Record<string, unknown>[];
}

/**
 * Does a task-list row belong to this exact attempt? Match by the spec-file
 * path the task was created from (tolerant of relocated run dirs), by the
 * full spec text, or by the deterministic task title plus run/participant
 * markers inside the spec text. Anything ambiguous is the caller's problem —
 * never a coin flip.
 */
function taskMatchesAttempt(
  row: Record<string, unknown>,
  ctx: {
    specRel: string;
    specAbsNorm: string;
    expectedSpecNorm: string;
    expectedTitle: string;
    runId: string;
    participantId: string;
  },
): boolean {
  const specRef = firstStr(
    row.specFile, row.spec_file, row.specPath, row.spec_path, row.specfile,
    asRec(row.task)?.specFile, row.file, row.path,
  );
  if (specRef !== undefined) {
    const n = normPath(specRef);
    if (n === ctx.specAbsNorm || n.endsWith(`/${ctx.specRel}`)) return true;
  }
  const specText = firstStr(row.spec, asRec(row.task)?.spec, asRec(row.result)?.spec);
  if (specText !== undefined) {
    if (normWs(specText) === ctx.expectedSpecNorm) return true;
    const title = firstStr(row.title, row.taskTitle, asRec(row.task)?.title);
    if (
      title === ctx.expectedTitle &&
      specText.includes(ctx.runId) &&
      specText.includes(ctx.participantId)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Is the recorded task-create failure a VERIFIED definitive no-effect
 * refusal? Only then may a fresh task be created — a timeout, lost
 * connection, or any generic failure can leave a live task behind, and a
 * request id plus operator confirmation alone does not disprove that.
 * Definitive means: the journaled refusal text explicitly states no change
 * was applied (the host's "Nothing changed" guarantee), an explicit
 * effects:'none' marker, or a structured refused/rejected request state.
 */
function isDefinitiveRefusal(failure: { payload?: Record<string, unknown> }, requestState: string): boolean {
  const p = failure.payload ?? {};
  const d = asRec(p.data);
  const texts = [p.message, d?.message, p.error].filter((x): x is string => typeof x === 'string');
  if (texts.some((t) => /nothing changed/i.test(t))) return true;
  const effects = firstStr(p.effects, d?.effects);
  if (effects !== undefined && /^(none|no[-_]?effects)$/i.test(effects)) return true;
  return ['refused', 'rejected', 'no_effects'].includes(requestState);
}

/**
 * Reconcile a persisted launch intent whose task-create was definitively
 * refused (the "no-task intent" case: intent_recorded, every host id null,
 * engine refusing to retry on its own). Explicit operator confirmation
 * names the Orca request id of the recorded refusal; the host task list is
 * then inspected for a task carrying this attempt's exact spec — a unique
 * match is adopted, and a fresh task-create is allowed ONLY under a verified
 * definitive refusal. The whole read/probe/list/resolve/persist transaction
 * runs inside the store's run lock so a second concurrent reconcile blocks,
 * re-reads state, and sees the persisted taskId — never two task-creates.
 * Any ambiguity, unresolved operation, or present dispatch refuses: never
 * launch twice, never blind-retry.
 */
async function cmdReconcile(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('reconcile', argv, {
    run: { type: 'string' },
    attempt: { type: 'string' },
    'confirm-no-effects': { type: 'string' },
    'as-supervisor': { type: 'boolean', default: false },
  });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  const attemptId = reqStr(v, 'attempt', '--attempt <attemptId>');
  const confirm = reqStr(v, 'confirm-no-effects', '--confirm-no-effects <requestId>');
  const dedicated = v['as-supervisor'] === true;

  const { store } = makeEngine(runDir);
  // Serialize the ENTIRE transaction under the run lock. Inner store calls
  // (loadState/readJournal/readArtifact/saveState/appendJournal) run directly
  // inside this lock session — withLock is not reentrant, so nothing below
  // may call it again. CliError is caught into a Result so its specific code
  // survives (a thrown one would be flattened to io_error).
  const txn = await store.withLock(
    async (): Promise<Result<{ payload: Record<string, unknown>; human: string }>> => {
      try {
        return { ok: true, value: await reconcileUnderLock(store, runDir, attemptId, confirm, dedicated) };
      } catch (e) {
        if (e instanceof CliError) return { ok: false, error: e.error };
        return {
          ok: false,
          error: err('io_error', `reconcile failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`),
        };
      }
    },
  );
  return unwrap(txn);
}

async function reconcileUnderLock(
  store: Store,
  runDir: string,
  attemptId: string,
  confirm: string,
  dedicated: boolean,
): Promise<{ payload: Record<string, unknown>; human: string }> {
  const st = await store.loadState();
  if (!st.ok) {
    if (st.error.code === 'io_error') {
      fail('io_error', `run directory unreadable or not initialized: ${store.runDir}`, {
        details: st.error.details,
      });
    }
    throw new CliError(st.error);
  }
  const state = st.value;
  if (state.orcaRunId === null) {
    fail('invalid_transition', 'no Orca Run is recorded for this council run — there is nothing to reconcile against');
  }
  const orcaRunId = state.orcaRunId;

  const located = state.participants
    .flatMap((p) => p.attempts.map((a) => ({ p, a })))
    .find(({ a }) => a.attemptId === attemptId);
  if (located === undefined) {
    fail('config_invalid', `no attempt ${attemptId} in this run`, {
      details: { attempts: state.participants.flatMap((p) => p.attempts.map((a) => a.attemptId)) },
    });
  }
  const { p, a: attempt } = located;

  if (attempt.status !== 'intent_recorded') {
    fail(
      'invalid_transition',
      `attempt ${attemptId} is '${attempt.status}' — reconcile applies only to a persisted no-task launch intent (intent_recorded)`,
      { details: { attemptId, status: attempt.status } },
    );
  }
  if (attempt.taskId !== null || attempt.dispatchId !== null || attempt.terminalHandle !== null) {
    fail(
      'invalid_transition',
      `attempt ${attemptId} already carries task/dispatch/terminal ids — a launch may exist; reconcile through worker observation, never relaunch`,
      { details: { attemptId, taskId: attempt.taskId, dispatchId: attempt.dispatchId, terminalHandle: attempt.terminalHandle } },
    );
  }

  const journal = unwrap(await store.readJournal());
  const failureEvent = [...journal].reverse().find(
    (e) => e.type === 'error' && e.payload?.op === 'task-create' && e.payload.attemptId === attemptId,
  );
  if (failureEvent === undefined) {
    fail(
      'invalid_transition',
      `no failed task-create is journaled for ${attemptId} — the engine guard does not apply; run \`council supervise --advance\` instead`,
    );
  }
  const recordedIds = journaledRequestIds(failureEvent);
  if (recordedIds.length === 0) {
    fail(
      'launch_unknown',
      `the recorded task-create failure for ${attemptId} carries no Orca request id — its outcome cannot be confirmed a definitive no-effect refusal; inspect events.jsonl seq ${failureEvent.seq} and reconcile manually before any retry`,
      { details: { attemptId, journalSeq: failureEvent.seq } },
    );
  }
  if (!recordedIds.includes(confirm)) {
    fail('config_invalid', `--confirm-no-effects ${confirm} does not match the recorded task-create failure request id(s): ${recordedIds.join(', ')}`, {
      details: { attemptId, recordedRequestIds: recordedIds },
    });
  }

  const handle = process.env.ORCA_TERMINAL_HANDLE;
  let binding: { prior: string | null; rebound: boolean } | null = null;
  if (dedicated) {
    const h = requireDedicatedSupervisor(state, handle);
    binding = await ensureBoundToRun(orcaRunId, h);
  }

  // Advisory request ledger: 'completed' forces the adopt-only path, 'pending'
  // refuses outright; every other answer (or an unreadable one) defers to the
  // authoritative task-list scan below.
  let requestState = 'unread';
  const probe = await tryOrcaCli([
    'orchestration', 'request-show', '--request', confirm, '--json',
  ]);
  if (probe.ok) {
    requestState = firstStr(asRec(probe.value)?.state, asRec(probe.value)?.status) ?? 'unknown';
    if (requestState === 'pending' || requestState === 'in_progress') {
      fail(
        'launch_unknown',
        `request ${confirm} is still ${requestState} — the task-create may yet land; resolve it before any retry`,
        { details: { attemptId, requestId: confirm } },
      );
    }
  }
  const completed = requestState === 'completed' || requestState === 'done';

  const specRel = `specs/${attemptId}.md`;
  const specRead = await store.readArtifact(specRel);
  if (!specRead.ok) {
    fail('io_error', `expected spec artifact ${specRel} is missing — cannot verify a matching host task; reconcile manually`, {
      details: { attemptId },
    });
  }
  const expectedSpecNorm = normWs(specRead.value);
  const expectedTitle = attemptTaskTitle(p, attempt);
  const specAbsNorm = normPath(resolve(runDir, specRel));

  const listed = await tryOrcaCli([
    'orchestration', 'task-list', '--run', orcaRunId, '--full', '--json',
  ]);
  if (!listed.ok) {
    // An unreadable task ledger means the attempt's host state is unknown —
    // refuse rather than risk a second task for the same intent.
    throw new CliError(listed.error);
  }
  const rows = taskRowsStrict(listed.value, orcaRunId);
  const matches = rows.filter((row) =>
    taskMatchesAttempt(row, {
      specRel,
      specAbsNorm,
      expectedSpecNorm,
      expectedTitle,
      runId: state.runId,
      participantId: p.participantId,
    }),
  );
  const matchIds = matches
    .map((row) => firstStr(row.id, row.taskId, asRec(row.task)?.id))
    .filter((x): x is string => typeof x === 'string');

  let taskId: string;
  let resolution: 'adopted' | 'created';
  if (matches.length > 1) {
    fail(
      'launch_unknown',
      `${matches.length} host tasks match attempt ${attemptId} (${matchIds.join(', ')}) — refusing to pick; inspect \`orca orchestration task-list --run ${orcaRunId} --full\` and reconcile manually`,
      { details: { attemptId, matches: matchIds } },
    );
  } else if (matches.length === 1) {
    const found = matchIds[0];
    if (found === undefined) {
      fail('launch_unknown', `the matching host task for ${attemptId} exposes no task id — reconcile manually`, {
        details: { attemptId },
      });
    }
    taskId = found;
    resolution = 'adopted';
  } else if (completed) {
    fail(
      'launch_unknown',
      `request ${confirm} is recorded completed but no host task matches ${attemptId} — investigate before any retry`,
      { details: { attemptId, requestId: confirm } },
    );
  } else if (!isDefinitiveRefusal(failureEvent, requestState)) {
    // A uuid + operator confirmation + empty list is NOT proof of no-effects:
    // a timed-out or otherwise generic failure may have left a live task.
    // Adoption above stays allowed; creation needs the definitive refusal.
    fail(
      'launch_unknown',
      `the recorded task-create failure for ${attemptId} is not a verified definitive no-effect refusal (request ${confirm}, state '${requestState}') — a timed-out or generic failure may have created a task anyway; inspect the request ledger and \`task-list --run ${orcaRunId} --full\` manually, or adopt a matching task`,
      { details: { attemptId, requestId: confirm, requestState } },
    );
  } else {
    // Verified definitive refusal + zero matching tasks: exactly one fresh task.
    const created = await lazyHost().createTask({
      runId: orcaRunId,
      specFilePath: resolve(runDir, specRel),
      title: expectedTitle,
    });
    if (!created.ok) {
      // Keep the engine guard armed for this attempt — the failed retry is
      // journaled exactly like the original failure.
      unwrap(
        await store.appendJournal([
          {
            ts: new Date().toISOString(),
            type: 'error',
            actor: 'engine',
            phase: attempt.phase,
            participantId: p.participantId,
            payload: {
              op: 'task-create',
              attemptId,
              code: created.error.code,
              message: created.error.message,
            },
          },
        ]),
      );
      throw new CliError(created.error);
    }
    taskId = created.value.taskId;
    resolution = 'created';
  }

  // Persist the real task id before any launch: the engine's null-task guard
  // is bypassed only by this journaled reconciliation, never erased. Already
  // inside the run lock — re-check the attempt is still the null-task intent
  // in case anything raced the outer reads.
  const st2 = await store.loadState();
  if (!st2.ok) throw new CliError(st2.error);
  const cur = st2.value.participants
    .find((pp) => pp.participantId === p.participantId)
    ?.attempts.find((a) => a.attemptId === attemptId);
  if (cur === undefined || cur.status !== 'intent_recorded' || cur.taskId !== null) {
    fail(
      'invalid_transition',
      `attempt ${attemptId} changed during reconciliation — aborting; re-inspect before retry`,
      { details: { attemptId } },
    );
  }
  cur.taskId = taskId;
  unwrap(await store.saveState(st2.value));
  unwrap(
    await store.appendJournal([
      {
        ts: new Date().toISOString(),
        type: 'task.created',
        actor: 'engine',
        phase: attempt.phase,
        participantId: p.participantId,
        payload: { attemptId, taskId, scope: 'task', reconciled: resolution, confirmedRequestId: confirm },
      },
    ]),
  );

  const advance = `council supervise --run ${cmdToken(runDir)} --advance --as-supervisor --json`;
  return {
    payload: {
      attemptId,
      participantId: p.participantId,
      resolution,
      taskId,
      orcaRunId,
      requestState,
      confirmedRequestId: confirm,
      ...(binding !== null ? { binding } : {}),
      next: advance,
      note: `attempt reconciled (${resolution}); run the advance command to launch the worker on this task — do not relaunch`,
    },
    human: [
      `reconciled ${attemptId}: ${resolution} task ${taskId}`,
      ...(binding !== null && binding.rebound
        ? [`  bound this terminal to ${orcaRunId} (was ${binding.prior ?? 'unbound'})`]
        : []),
      `  next: ${advance}`,
    ].join('\n'),
  };
}

// ─── council approve ─────────────────────────────────────────────────────────

async function cmdApprove(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('approve', argv, {
    run: { type: 'string' },
    roster: { type: 'string' },
    note: { type: 'string' },
  });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  const rosterPath = reqStr(v, 'roster', '--roster <file>');
  const note = optStr(v, 'note');

  const { store, engine } = makeEngine(runDir);
  const state = await loadRun(store);

  const proposedR = await store.readProposedRoster();
  if (!proposedR.ok) {
    fail('approval_required', 'no proposed roster on record; the organiser must finish first', {
      details: { reason: proposedR.error.message },
    });
  }
  const raw = await readJsonFile(rosterPath, 'roster file');
  const parsed = parseApprovedRoster(raw, {
    runId: state.runId,
    proposed: proposedR.value,
    config: { participants: state.config.participants },
  });
  if (!parsed.ok) fail('roster_invalid', `roster file ${rosterPath} failed validation`, { issues: parsed.issues });
  const roster: ApprovedRoster = parsed.value;

  const baseApprover =
    process.env.ORCA_TERMINAL_HANDLE ?? process.env.USER ?? process.env.USERNAME ?? 'cli';
  // The contract caps approval.approver at 128 chars (validation.ts
  // parseApprovalRecord) — a longer note must be truncated here, not at 200,
  // or the persisted record fails schema validation. The approver identity
  // stays intact: truncation can only ever eat into the note tail.
  const approver = (note === undefined ? baseApprover : `${baseApprover} — ${note}`).slice(0, 128);

  const res = unwrap(await engine.approve({ roster, approver }));

  const supDispatch = state.supervisor?.dispatchId;
  const wakeCommand =
    supDispatch !== null && supDispatch !== undefined
      ? `orca orchestration send --to dispatch:${supDispatch} --subject "approval recorded" --body "approval.json written for run ${state.runId}; run council supervise --advance"`
      : null;
  return {
    payload: {
      approvalId: res.approvalId,
      hash: res.hash,
      approver,
      seats: roster.seats.length,
      supervisor: state.supervisor,
      wakeCommand,
      note: 'approving does NOT wake the supervisor by itself — send the wakeCommand above (a file write is not an Orca wake); when you drive `council supervise --advance` yourself, your next call IS the wake',
    },
    human: [
      `approval recorded: ${res.approvalId}`,
      `  hash:   ${res.hash}`,
      `  seats:  ${roster.seats.length}   approver: ${approver}`,
      `  IMPORTANT: approval does not wake the supervisor.`,
      wakeCommand !== null
        ? `  wake it: ${wakeCommand}`
        : `  no supervisor dispatch recorded — your next \`council supervise --advance\` is the wake`,
    ].join('\n'),
  };
}

// ─── council status ──────────────────────────────────────────────────────────

async function cmdStatus(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('status', argv, { run: { type: 'string' } });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  const { store, engine } = makeEngine(runDir);
  const state = await loadRun(store);
  const st = unwrap(await engine.status());

  const reviewers = state.participants.filter((p) => p.role === 'reviewer');
  const settled = reviewers.filter((p) => p.status === 'settled').length;
  const quorum = Math.ceil(state.config.quorumRatio * Math.max(1, reviewers.length));
  return {
    payload: {
      runId: state.runId,
      status: st.status,
      discussion: st.discussion,
      participants: st.participants,
      consumption: st.consumption,
      approvalHash: st.approvalHash,
      pendingDecisions: st.pendingDecisions,
      quorum: {
        seats: reviewers.length,
        settled,
        required: reviewers.length === 0 ? 0 : quorum,
        met: reviewers.length > 0 && settled >= quorum,
      },
      supervisor: state.supervisor,
      orcaRunId: state.orcaRunId,
      runDir,
    },
    human: [
      `run ${state.runId} — ${st.status}${st.discussion !== null ? ` (round ${st.discussion.round}, ${st.discussion.stage})` : ''}`,
      `  seats:      ${reviewers.length} reviewers, ${settled} settled (quorum ${quorum})`,
      `  budget:     ${st.consumption.launches}/${state.config.maxLaunches} launches, ${st.consumption.mailSent} mail`,
      `  approval:   ${st.approvalHash ?? 'none'}`,
      ...st.participants.map(
        (p) => `  ${p.status.padEnd(10)} ${p.participantId} (${p.role})${p.activeAttempt !== null ? ` — ${p.activeAttempt}` : ''}`,
      ),
      ...st.pendingDecisions.map((d) => `  pending:  ${d}`),
    ].join('\n'),
  };
}

// ─── council cancel ──────────────────────────────────────────────────────────

async function cmdCancel(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('cancel', argv, {
    run: { type: 'string' },
    reason: { type: 'string' },
  });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  const reason = optStr(v, 'reason') ?? 'cancelled via council CLI';

  const { store, engine } = makeEngine(runDir);
  await loadRun(store); // fail early on a missing/corrupt run
  unwrap(await engine.cancel({ reason }));

  const after = await loadRun(store);
  const confirmed: string[] = [];
  const unverifiable: string[] = [];
  for (const p of after.participants) {
    for (const a of p.attempts) {
      if (a.status === 'stopped') confirmed.push(a.attemptId);
      else if (a.status === 'dispatched' || a.status === 'working' || a.status === 'unknown') {
        unverifiable.push(`${a.attemptId} (dispatch ${a.dispatchId ?? 'none'}, status ${a.status})`);
      }
    }
  }
  return {
    payload: {
      runId: after.runId,
      status: after.status,
      reason,
      confirmedStopped: confirmed,
      unverifiable,
      note:
        unverifiable.length === 0
          ? 'every live participant confirmed stopped'
          : `${unverifiable.length} participant(s) not proven stopped — inspect them; silence never proves exit`,
    },
    human: [
      `run ${after.runId} → ${after.status} (${reason})`,
      `  confirmed stopped: ${confirmed.length === 0 ? 'none' : confirmed.join(', ')}`,
      `  unverifiable:      ${unverifiable.length === 0 ? 'none' : unverifiable.join('; ')}`,
    ].join('\n'),
  };
}

// ─── council tail ────────────────────────────────────────────────────────────

async function cmdTail(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('tail', argv, {
    run: { type: 'string' },
    lines: { type: 'string' },
  });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  const linesRaw = optStr(v, 'lines');
  let lines = 20;
  if (linesRaw !== undefined) {
    lines = Number.parseInt(linesRaw, 10);
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000) {
      usage('--lines must be an integer in 1..1000');
    }
  }
  const { store } = makeEngine(runDir);
  await loadRun(store); // fail early on a missing/corrupt run
  const journal = unwrap(await store.readJournal());
  const events = journal.slice(Math.max(0, journal.length - lines));
  return {
    payload: { runDir, totalEvents: journal.length, shown: events.length, events },
    human:
      events.length === 0
        ? 'journal is empty'
        : events
            .map(
              (e) =>
                `#${e.seq} ${e.ts} ${e.type}${e.phase ? ` ${e.phase}` : ''}${e.round !== undefined ? ` r${e.round}` : ''}${e.participantId ? ` ${e.participantId}` : ''}${e.payload !== undefined ? ` ${JSON.stringify(e.payload)}` : ''}`,
            )
            .join('\n'),
  };
}

// ─── council verify ──────────────────────────────────────────────────────────

async function cmdVerify(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('verify', argv, { run: { type: 'string' } });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  const { store } = makeEngine(runDir);
  const state = await loadRun(store);

  const drift = unwrap(await store.verifySourceSnapshot());
  const appr = await store.readApproval();
  const approval: Record<string, unknown> = { present: appr.ok };
  let bindingIntact: boolean | null = null;
  let stateHashMatch: boolean | null = null;
  if (appr.ok) {
    const recomputed = canonicalApprovalHash(appr.value.binding);
    bindingIntact = recomputed === appr.value.record.hash;
    stateHashMatch = state.approvalHash === appr.value.record.hash;
    approval.recordHash = appr.value.record.hash;
    approval.recomputedHash = recomputed;
    approval.bindingIntact = bindingIntact;
    approval.matchesStateHash = stateHashMatch;
    approval.approver = appr.value.record.approver;
    approval.createdAt = appr.value.record.createdAt;
  } else {
    approval.reason = appr.error.message;
  }
  const verified =
    drift.drift === false && (bindingIntact === null ? true : bindingIntact && stateHashMatch !== false);
  return {
    payload: {
      runId: state.runId,
      verified,
      snapshot: { drift: drift.drift, changed: drift.changed, snapshotId: state.snapshotId },
      approval,
      note: 'reports only — a drifted tree or mismatched binding means re-snapshot and re-approve are required before any launch',
    },
    human: [
      `run ${state.runId}: ${verified ? 'VERIFIED' : 'INTEGRITY ISSUES'}`,
      `  snapshot ${state.snapshotId ?? 'none'}: ${drift.drift ? `DRIFT (${drift.changed.length} changed)` : 'clean'}`,
      ...(drift.changed.length > 0 ? drift.changed.slice(0, 10).map((c) => `    changed: ${c}`) : []),
      appr.ok
        ? `  approval: binding ${bindingIntact === true ? 'intact' : 'MISMATCH'}${stateHashMatch === false ? ', state hash differs' : ''}`
        : `  approval: none (${appr.error.message})`,
    ].join('\n'),
  };
}

// ─── council start-supervisor ────────────────────────────────────────────────

const SUPERVISOR_COMMAND = 'devin --model swe-2-max --permission-mode dangerous';

async function cmdStartSupervisor(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('start-supervisor', argv, {
    run: { type: 'string' },
    'wait-ms': { type: 'string' },
  });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  const waitMsRaw = optStr(v, 'wait-ms');
  let waitMs = 60_000;
  if (waitMsRaw !== undefined) {
    waitMs = Number.parseInt(waitMsRaw, 10);
    if (!Number.isInteger(waitMs) || waitMs < 1_000 || waitMs > 600_000) {
      usage('--wait-ms must be an integer in 1000..600000');
    }
  }

  const { store } = makeEngine(runDir);
  const state = await loadRun(store);
  const specPath = join(runDir, 'prompts', 'supervisor.md');
  if (!existsSync(specPath)) {
    fail('io_error', `supervisor spec missing: ${specPath} — run \`council init\` first`, {
      details: { reason: 'missing_supervisor_spec' },
    });
  }
  const fromArgs =
    process.env.ORCA_TERMINAL_HANDLE !== undefined ? ['--from', process.env.ORCA_TERMINAL_HANDLE] : [];

  // The supervisor Task belongs under the caller's bound Run when one exists
  // (the caller's binding is preserved — we never run-use here). With no
  // bound Run, task-create has nothing to attach to; the documented
  // `worker-start --spec-file` path creates or joins a Run implicitly, so a
  // first-time invocation still works. An unreadable binding takes the same
  // path — it covers both cases.
  const current = await tryOrcaCli(['orchestration', 'run-current', ...fromArgs, '--json']);
  const boundRunId = current.ok ? extractRunId(current.value) : null;

  let taskId: string | null = null;
  let taskReceipt: unknown = null;
  if (boundRunId !== null) {
    // Task for the supervisor under the CALLER's binding (not the council run).
    taskReceipt = await orcaCli([
      'orchestration',
      'task-create',
      '--spec-file',
      specPath,
      `--task-title=Council supervisor ${state.runId}`,
      ...fromArgs,
      '--json',
    ]);
    const tr = taskReceipt as Record<string, unknown> | undefined;
    const tid =
      (tr?.task as Record<string, unknown> | undefined)?.id ??
      (tr?.id as string | undefined) ??
      (tr?.taskId as string | undefined);
    if (typeof tid !== 'string' || tid.length === 0) {
      fail('adapter_error', 'task-create returned no task id — reconcile before retry', {
        details: { adapterCode: 'missing_task_id', receipt: taskReceipt },
      });
    }
    taskId = tid;
  }

  // Terminal running the pinned Devin lane (fixed allowlisted tokens only).
  const termReceipt = await orcaCli([
    'terminal',
    'create',
    '--worktree',
    'active',
    '--title=council-supervisor',
    `--command=${SUPERVISOR_COMMAND}`,
    '--json',
  ]);
  const tm = termReceipt as Record<string, unknown> | undefined;
  const terminalHandle =
    (tm?.terminal as Record<string, unknown> | undefined)?.handle ??
    (tm?.handle as string | undefined);
  if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
    fail('adapter_error', 'terminal create returned no handle — inspect the worktree before retrying', {
      details: { adapterCode: 'missing_terminal_handle', receipt: termReceipt },
    });
  }

  // Wait for the agent CLI to reach its prompt before injecting the Task.
  await orcaCli(
    ['terminal', 'wait', '--terminal', terminalHandle, '--for', 'tui-idle', '--timeout-ms', String(waitMs), '--json'],
    waitMs + 15_000,
  );

  // Bind the Task to the waiting terminal — an explicit pre-created Task when
  // the caller has a bound Run, otherwise the documented spec-file form that
  // creates/joins a Run implicitly.
  const startReceipt = await orcaCli(
    taskId !== null
      ? [
          'orchestration',
          'worker-start',
          '--task',
          taskId,
          '--terminal',
          terminalHandle,
          '--worktree',
          'current',
          ...fromArgs,
          '--json',
        ]
      : [
          'orchestration',
          'worker-start',
          '--spec-file',
          specPath,
          `--task-title=Council supervisor ${state.runId}`,
          '--terminal',
          terminalHandle,
          '--worktree',
          'current',
          ...fromArgs,
          '--json',
          '--full',
        ],
  );
  if (taskId === null) {
    const sr = startReceipt as Record<string, unknown> | undefined;
    taskId =
      ((sr?.task as Record<string, unknown> | undefined)?.id as string | undefined) ??
      (sr?.taskId as string | undefined) ??
      ((sr?.id as string | undefined) ?? null);
  }
  const { dispatchId } = extractDispatchInfo(startReceipt);

  // Persist the durable supervisor identity for `council approve` wakes.
  unwrap(
    await store.withLock(async () => {
      const st = await store.loadState();
      if (!st.ok) return st;
      st.value.supervisor = { terminalHandle, dispatchId: dispatchId ?? null };
      return store.saveState(st.value);
    }),
  );

  return {
    payload: {
      runId: state.runId,
      runDir,
      taskId,
      terminalHandle,
      dispatchId: dispatchId ?? null,
      command: SUPERVISOR_COMMAND,
      callerRun: boundRunId,
      lane:
        boundRunId !== null
          ? 'task-under-caller-run'
          : 'implicit-run (worker-start --spec-file — no bound Run on the caller)',
      receipts: { taskCreate: taskReceipt, workerStart: startReceipt },
      note:
        dispatchId === undefined
          ? 'worker-start returned no dispatch id in its receipt — reconcile via `orca orchestration worker-list` before retrying; the terminal is live'
          : 'supervisor launched — it will drive `council supervise --advance --as-supervisor` on each wake',
    },
    human: [
      `supervisor launched for ${state.runId}`,
      `  task:     ${taskId ?? 'created implicitly by worker-start (id not in receipt)'}`,
      `  terminal: ${terminalHandle} (${SUPERVISOR_COMMAND})`,
      `  dispatch: ${dispatchId ?? 'NOT RETURNED — reconcile via orca orchestration worker-list'}`,
      `  caller Run: ${boundRunId ?? 'none — implicit Run created/joined by worker-start'}`,
    ].join('\n'),
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const COMMANDS: Record<
  string,
  (argv: readonly string[]) => Promise<{ payload: Record<string, unknown>; human: string }>
> = {
  init: cmdInit,
  doctor: cmdDoctor,
  supervise: cmdSupervise,
  reconcile: cmdReconcile,
  approve: cmdApprove,
  status: cmdStatus,
  cancel: cmdCancel,
  tail: cmdTail,
  verify: cmdVerify,
  'start-supervisor': cmdStartSupervisor,
};

const HELP = `council — Multiagent Council CLI (docs/USAGE.md)

usage: council <command> [flags] [--json]

commands:
  init      --objective <file> --target <path> [--config <file>]
            create <target>/.council/runs/<crun_id>/ (COUNCIL_HOME relocates),
            snapshot the target, write the supervisor spec
  start-supervisor --run <runDir>
            launch the dedicated supervisor worker (Orca task + Devin terminal)
  supervise --run <runDir> --advance [--as-supervisor]
            one bounded, idempotent engine step; prints {state, action, note}.
            --as-supervisor is the dedicated supervisor's own mode: it binds
            this terminal to the persisted child Run (run-use) when a restart
            orphaned the binding — never used for manual driving
  reconcile --run <runDir> --attempt <attemptId> --confirm-no-effects <requestId> [--as-supervisor]
            resolve a persisted no-task launch intent: adopt the unique host
            task carrying this attempt's spec, or create exactly one task
            after a confirmed no-effect refusal; refuses on any ambiguity
  approve   --run <runDir> --roster <file> [--note <text>]
            record the hash-bound roster approval (does not wake the supervisor)
  status    --run <runDir>          phase, per-seat health, budgets, quorum
  tail      --run <runDir> [--lines N]   last N journal events (read-only)
  verify    --run <runDir>          snapshot drift + approval binding integrity
  cancel    --run <runDir> [--reason <text>]   guarded stop of live workers
  doctor                          environment check (node/orca/agent CLIs)

all commands accept --json for machine-readable output.
`;

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  const json = argv.includes('--json');
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return command === undefined ? EXIT_USAGE : 0;
  }
  const handler = COMMANDS[command];
  if (handler === undefined) {
    return emitError(
      err('unsupported', `unknown command ${JSON.stringify(command)}`, {
        details: { commands: Object.keys(COMMANDS) },
      }),
      json,
    );
  }
  try {
    const { payload, human } = await handler(argv.slice(1));
    emit(payload, json, human);
    return 0;
  } catch (e) {
    if (e instanceof CliError) return emitError(e.error, json);
    return emitError(
      err('io_error', `unexpected failure: ${e instanceof Error ? e.message : String(e)}`),
      json,
    );
  }
}

const invokedDirectly = (() => {
  const a = process.argv[1];
  if (a === undefined) return false;
  try {
    return resolve(a) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

export { main };
