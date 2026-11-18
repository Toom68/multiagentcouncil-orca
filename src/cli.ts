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
  type HostAdapter,
  type Result,
  type Store,
} from './contracts.js';
import { createEngine } from './engine.js';
import {
  extractDispatchInfo,
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

/** Quote one token for a verbatim spec command line; refuses unusable chars. */
function cmdToken(path: string): string {
  if (path.includes('"')) {
    fail('config_invalid', `path cannot be embedded in the supervisor command (contains a double quote): ${path}`);
  }
  return /\s/.test(path) ? `"${path}"` : path;
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
    fail('adapter_error', `orca ${args[0]} ${args[1] ?? ''} failed: ${e?.message ?? 'unknown'}`, {
      details: { adapterCode: e?.code ?? 'unknown', data: e?.data },
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

// ─── Output ──────────────────────────────────────────────────────────────────

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
  const advanceCommand = `node ${cmdToken(cliPath)} supervise --run ${cmdToken(runDir)} --advance --json`;
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
  blocked: 'unrecoverable condition — inspect <runDir>/events.jsonl and decide (fix the cause or `council cancel`)',
};

async function cmdSupervise(argv: readonly string[]): Promise<{ payload: Record<string, unknown>; human: string }> {
  const v = parseFlags('supervise', argv, {
    run: { type: 'string' },
    advance: { type: 'boolean', default: false },
  });
  const runDir = reqStr(v, 'run', '--run <runDir>');
  if (v.advance !== true) {
    usage('council supervise performs one bounded step: pass --advance (see docs/USAGE.md)');
  }

  const { store, engine } = makeEngine(runDir);

  // Record the supervisor's durable identity so `council approve` can address
  // its wake exactly (writing approval files alone never wakes the agent).
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (handle !== undefined) {
    const identified = await store.withLock(async () => {
      const st = await store.loadState();
      if (!st.ok) return st;
      const state = st.value;
      if (state.supervisor?.terminalHandle === handle && state.supervisor.dispatchId !== null) {
        return { ok: true as const, value: false };
      }
      state.supervisor = {
        terminalHandle: handle,
        dispatchId: state.supervisor?.dispatchId ?? process.env.ORCA_DISPATCH_ID ?? null,
      };
      const w = await store.saveState(state);
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
      ...(res.artifacts !== undefined ? { artifacts: res.artifacts } : {}),
      ...(res.outcome !== undefined ? { outcome: res.outcome } : {}),
      ...(res.reportPaths !== undefined ? { reportPaths: res.reportPaths } : {}),
      runDir,
    },
    human: [
      `state: ${res.status}   action: ${res.action}`,
      ...(res.note !== undefined ? [`note:  ${res.note}`] : []),
      `next:  ${NEXT_HINT[res.action]}`,
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
  const approver = (note === undefined ? baseApprover : `${baseApprover} — ${note}`).slice(0, 200);

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

  // 1) Task for the supervisor under the CALLER's binding (not the council run).
  const taskReceipt = await orcaCli([
    'orchestration',
    'task-create',
    '--spec-file',
    specPath,
    `--task-title=Council supervisor ${state.runId}`,
    ...fromArgs,
    '--json',
  ]);
  const tr = taskReceipt as Record<string, unknown> | undefined;
  const taskId =
    (tr?.task as Record<string, unknown> | undefined)?.id ??
    (tr?.id as string | undefined) ??
    (tr?.taskId as string | undefined);
  if (typeof taskId !== 'string' || taskId.length === 0) {
    fail('adapter_error', 'task-create returned no task id — reconcile before retry', {
      details: { adapterCode: 'missing_task_id', receipt: taskReceipt },
    });
  }

  // 2) Terminal running the pinned Devin lane (fixed allowlisted tokens only).
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

  // 3) Wait for the agent CLI to reach its prompt before injecting the Task.
  await orcaCli(
    ['terminal', 'wait', '--terminal', terminalHandle, '--for', 'tui-idle', '--timeout-ms', String(waitMs), '--json'],
    waitMs + 15_000,
  );

  // 4) Bind the Task to the waiting terminal.
  const startReceipt = await orcaCli([
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
  ]);
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
      receipts: { taskCreate: taskReceipt, workerStart: startReceipt },
      note:
        dispatchId === undefined
          ? 'worker-start returned no dispatch id in its receipt — reconcile via `orca orchestration worker-list` before retrying; the terminal is live'
          : 'supervisor launched — it will drive `council supervise --advance` on each wake',
    },
    human: [
      `supervisor launched for ${state.runId}`,
      `  task:     ${taskId}`,
      `  terminal: ${terminalHandle} (${SUPERVISOR_COMMAND})`,
      `  dispatch: ${dispatchId ?? 'NOT RETURNED — reconcile via orca orchestration worker-list'}`,
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
  supervise --run <runDir> --advance
            one bounded, idempotent engine step; prints {state, action, note}
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
