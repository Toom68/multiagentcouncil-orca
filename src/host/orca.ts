/**
 * Orca host adapter core: argv construction, strict token validation,
 * JSON-envelope handling, and bounded operations over `orca` CLI processes.
 *
 * Hard rules honored here (docs/design/IMPLEMENTATION.md, ORCA-COMPATIBILITY.md):
 * - Only documented `orca` commands; argv arrays + `shell: false` via process.ts.
 * - Mutations carry NO caller-chosen idempotency key: `--retry-request`
 *   accepts only an Orca-issued request id (verified 1.4.261). First attempts
 *   go out bare; the Orca requestId captured from the receipt is what makes an
 *   uncertain outcome re-issuable after request-show. The caller `requestKey`
 *   remains only as a local durable intent id for receipts/journal — it never
 *   reaches argv.
 * - Nothing here ever runs `orchestration check` (consuming) or `--ack`;
 *   history is read via `inbox`/`worker-*` read-only commands only.
 * - `terminal create --command` is shell text: agent argv is assembled only
 *   from tokens that pass a strict allowlist — no objective, path, model or
 *   free text may become shell syntax.
 * - Uncertain outcomes (outcome_unknown, timeout, stop_unknown, unverifiable)
 *   surface as `uncertain`, never as success or silent failure.
 */

import { createHash } from 'node:crypto';
import type {
  AgentChoice,
  CouncilError,
  DispatchId,
  HostAdapter,
  LaunchResult,
  MessageId,
  OrcaRunId,
  Result,
  StopOutcome,
  TaskId,
  TerminalHandle,
  WorkerLaunchSpec,
  WorkerLiveness,
  WorkerObservation,
} from '../contracts.js';
import {
  resolveExecutable,
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
  type SpawnPlan,
} from './process.js';
import { AGENT_CATALOG, resolveAgentLaunch } from '../catalog.js';

// ---------------------------------------------------------------------------
// Errors and result shapes
// ---------------------------------------------------------------------------

export class OrcaAdapterError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'OrcaAdapterError';
    this.code = code;
    this.data = data;
  }
}

/** Thrown before any spawn when an argv token fails validation. */
export class UnsafeTokenError extends OrcaAdapterError {
  constructor(what: string, value: string) {
    super(
      'unsafe_token',
      `Refusing to pass ${what} to a child process: ${JSON.stringify(value)}`,
    );
  }
}

export interface OrcaCliErrorShape {
  code: string;
  message: string;
  data?: unknown;
}

export interface OrcaCommandOk<T> {
  ok: true;
  value: T;
  /**
   * Orca-issued orchestration request id for this mutation, when the receipt
   * carries one (result.mutation.requestId under --full). This is the ONLY id
   * valid for --retry-request; absent on reads and on pre-`--full` receipts.
   */
  requestId?: string;
  /** Exit code of the CLI process (0). */
  exitCode: number;
  /** True when stdout was capped; callers should distrust partial JSON. */
  truncated: boolean;
}

export interface OrcaCommandFailure {
  ok: false;
  error: OrcaCliErrorShape;
  /**
   * Orca-issued orchestration request id when the failure receipt carries one
   * (error.data.orchestrationRequestId — verified 1.4.261). Needed to retry
   * or request-show the uncertain mutation.
   */
  requestId?: string;
  /**
   * True when the mutation may have landed but its outcome could not be
   * proven: outcome_unknown, local timeout, stop_unknown, unverifiable,
   * transient runtime states. The caller must reconcile (request-show /
   * worker-list) before retrying — never treat as a clean failure.
   */
  uncertain: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

export type OrcaCommandResult<T> = OrcaCommandOk<T> | OrcaCommandFailure;

// ---------------------------------------------------------------------------
// Token validation — the only things allowed to become argv or shell text
// ---------------------------------------------------------------------------

/** Long-run safe ids/flags: alnum plus `.` `_` `-` `:` `/` (covers run_/task_/ctx_/dispatch:/run:/swe-2-max/repo paths). */
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/**
 * Stricter rule for tokens joined into `terminal create --command` shell text.
 * Value tokens start alnum (never `-`, `@` — no option confusion, no
 * PowerShell splat) and may carry provider/model:level selector punctuation
 * (`:` `/` `+` `.` `_` `-`); flag tokens keep the strict `--word` shape.
 * Whitespace, quotes, and every shell operator stay impossible.
 */
const COMMAND_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$|^--[a-z][a-z0-9-]*$/;
/**
 * Paths handed to CLI flags (spec files, report paths). May be absolute or
 * relative to cwd; must not start with `-` (option confusion), must not
 * contain `..` segments or control/shell-glob characters. Spaces are fine —
 * argv is passed literally, never through a shell.
 */
const PATH_VALUE_RE = /^(?!-)(?!.*(?:^|[\/])\.\.(?:[\/]|$))[^<>"|?*\x00-\x1f]+$/;

export function assertSafeValue(what: string, value: string): string {
  if (!SAFE_VALUE_RE.test(value) || value.length > 256) {
    throw new UnsafeTokenError(what, value);
  }
  return value;
}

export function assertPathValue(what: string, value: string): string {
  if (!PATH_VALUE_RE.test(value) || value.length === 0 || value.length > 512) {
    throw new UnsafeTokenError(what, value);
  }
  return value;
}

export function assertCommandToken(what: string, value: string): string {
  if (!COMMAND_TOKEN_RE.test(value) || value.length > 128) {
    throw new UnsafeTokenError(what, value);
  }
  return value;
}

export function assertAllowlisted(
  what: string,
  value: string,
  allowed: readonly string[],
): string {
  assertCommandToken(what, value);
  if (!allowed.includes(value)) {
    throw new OrcaAdapterError(
      'not_allowlisted',
      `${what} ${JSON.stringify(value)} is not in the configured allowlist: ${allowed.join(', ')}`,
    );
  }
  return value;
}

/**
 * Build the `--command` text for `terminal create` from agent argv tokens.
 * Every token must match COMMAND_TOKEN_RE and, where a per-position allowlist
 * is configured (binary, model, permission mode), appear in it. The result is
 * a single-space join — still shell text downstream, so nothing else may be
 * inserted (no paths, objectives, free text, env assignments, redirections).
 */
export function buildAgentCommandText(tokens: readonly string[]): string {
  if (tokens.length === 0) {
    throw new OrcaAdapterError('empty_agent_command', 'Agent argv is empty');
  }
  tokens.forEach((t, i) => assertCommandToken(`agent argv[${i}]`, t));
  return tokens.join(' ');
}

/** Truncate to a UTF-8 byte budget without ever splitting a sequence. */
function boundedUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0b1100_0000) === 0b1000_0000) cut -= 1;
  return buf.subarray(0, cut).toString('utf8');
}

const RUN_LABEL_PREFIX = 'Council review — ';
const RUN_LABEL_MAX_BYTES = 1024;

/**
 * The full council objective stays verbatim in state, artifacts, prompts and
 * the approval hash. The Orca Run only ever receives a bounded descriptive
 * metadata label — host `run-create` refuses objectives over 1024 chars, so
 * the adapter boundary converts the brief (`Council review — <prefix…>`).
 */
export function runObjectiveLabel(objective: string): string {
  const budget = RUN_LABEL_MAX_BYTES - Buffer.byteLength(RUN_LABEL_PREFIX, 'utf8');
  if (Buffer.byteLength(objective, 'utf8') <= budget) return RUN_LABEL_PREFIX + objective;
  const ellipsis = '…';
  return (
    RUN_LABEL_PREFIX +
    boundedUtf8(objective, budget - Buffer.byteLength(ellipsis, 'utf8')) +
    ellipsis
  );
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

export interface OrcaEnvelope {
  ok: boolean;
  /** Top-level receipt id. On `orca terminal` commands this is the only
   *  request evidence (verified 1.4.261: `terminal create` returns
   *  `{"id":"d7c3581f-…"}`); orchestration mutations additionally carry
   *  `result.mutation.requestId`, which takes precedence. */
  id?: string;
  result?: unknown;
  error?: { code?: string; message?: string; data?: unknown };
}

const STDERR_ERROR_RE = /(?:^|\n)\s*error:\s*([a-z_]+):\s*(.+?)\s*$/i;

/**
 * Orca-issued request/receipt id from a receipt envelope. Verified locations
 * (1.4.261), in precedence order: success `result.mutation.requestId` (+ a
 * `replayed` flag) under `--full`; failure `error.data.orchestrationRequestId`;
 * otherwise the envelope's top-level `id` — the only evidence `orca terminal`
 * receipts carry. Only orchestration request ids are valid `--retry-request`
 * values; a terminal receipt id is recorded for observability, never replayed.
 */
export function extractRequestId(env: OrcaEnvelope): string | undefined {
  const r = typeof env.result === 'object' && env.result !== null
    ? (env.result as Record<string, unknown>)
    : undefined;
  const mutation = r && typeof r.mutation === 'object' && r.mutation !== null
    ? (r.mutation as Record<string, unknown>)
    : undefined;
  const fromResult =
    (typeof mutation?.requestId === 'string' && mutation.requestId) ||
    (typeof mutation?.request_id === 'string' && mutation.request_id) ||
    (typeof r?.requestId === 'string' && r.requestId) ||
    undefined;
  if (fromResult) return fromResult;
  const err = env.error;
  const data = err?.data;
  if (typeof data === 'object' && data !== null) {
    const v = (data as Record<string, unknown>).orchestrationRequestId;
    if (typeof v === 'string' && v.length > 0) return v;
  }
  if (typeof env.id === 'string' && env.id.length > 0) return env.id;
  return undefined;
}

/** Extract the JSON envelope or trailing `error: code: message` line from a finished process. */
export function parseOrcaEnvelope(proc: ProcessResult):
  | { kind: 'json'; envelope: OrcaEnvelope }
  | { kind: 'error_line'; error: OrcaCliErrorShape }
  | { kind: 'unparsed' } {
  const stdout = proc.stdout.trim();
  if (stdout.startsWith('{')) {
    try {
      const parsed = JSON.parse(stdout) as OrcaEnvelope;
      if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) {
        return { kind: 'json', envelope: parsed };
      }
    } catch {
      /* fall through to error-line / unparsed */
    }
  }
  const haystack = `${proc.stderr}\n${proc.stdout}`;
  const match = haystack.match(STDERR_ERROR_RE);
  if (match) {
    return {
      kind: 'error_line',
      error: { code: match[1], message: match[2] },
    };
  }
  return { kind: 'unparsed' };
}

/** Orca error codes that mean "the outcome could not be proven" — reconcile, never auto-retry. */
const UNCERTAIN_CODES = new Set([
  'outcome_unknown',
  'stop_unknown',
  'release_unknown',
  'unverifiable',
  'runtime_unavailable',
  'server_mail_unsupported',
  'source_changed',
]);

// ---------------------------------------------------------------------------
// OrcaHost — bounded operations over the `orca` CLI
// ---------------------------------------------------------------------------

export interface OrcaHostOptions {
  /** Explicit path to the orca executable; resolved via PATH when omitted. */
  executablePath?: string;
  /**
   * Base argv inserted before the command (e.g. ['--environment','local']).
   * Each entry is validated as a safe value token.
   */
  baseArgs?: readonly string[];
  /** Identity for mail mutations (`--from`), normally the supervisor handle. */
  fromHandle?: string;
  cwd?: string;
  /** Default per-command timeout; each call may override. */
  commandTimeoutMs?: number;
  /** Byte cap for outbound mail bodies (IMPLEMENTATION.md default 8192). */
  maxNotificationBytes?: number;
  /** Allowlist for `--agent` ids used with the agent launch lane. */
  allowedAgents?: readonly string[];
  /** Allowlist for model ids per agent lane, e.g. { devin: ['swe-2-max'] }. */
  allowedModels?: Readonly<Record<string, readonly string[]>>;
  /** Allowlist for agent argv binaries used in the custom-argv lane. */
  allowedAgentBinaries?: readonly string[];
  /** Injectable process runner — tests substitute a fake; defaults to runProcess. */
  spawnFn?: (plan: SpawnPlan, opts: RunProcessOptions) => Promise<ProcessResult>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_NOTIFICATION_BYTES = 8192;

export type WorkerLaunchLane =
  | { kind: 'agent'; agent: string; model?: string; effort?: string }
  | { kind: 'argv'; command: readonly string[]; readinessTimeoutMs?: number };

export interface StartPhaseWorkerInput {
  runId: string;
  taskId: string;
  worktree: string;
  lane: WorkerLaunchLane;
  /** Local durable intent id for receipts/journal. NEVER reaches Orca argv. */
  requestKey: string;
  /** Reuse a proven settled worker's terminal for a new phase Task. */
  retainedTerminal?: { handle: string };
  title?: string;
  terminalWaitTimeoutMs?: number;
}

export interface PhaseWorkerStart {
  taskId: string;
  runId: string;
  requestKey: string;
  outcome: 'ready' | 'failed' | 'uncertain';
  dispatchId?: string;
  workerAddress?: string;
  terminalHandle?: string;
  failedStage?: string;
  /** Orca-issued request id of the worker-start mutation (recovery handle). */
  requestId?: string;
  error?: OrcaCliErrorShape;
  /** Bounded copy of receipts for evidence; never trusted as proof alone. */
  receipts: Record<string, unknown>;
}

export class OrcaHost {
  private readonly plan: SpawnPlan;
  private readonly opts: Required<
    Pick<OrcaHostOptions, 'commandTimeoutMs' | 'maxNotificationBytes'>
  > &
    OrcaHostOptions;

  constructor(options: OrcaHostOptions = {}) {
    const file = options.executablePath
      ? resolveExecutable('orca', { explicitPath: options.executablePath })
      : resolveExecutable('orca');
    const baseArgs = (options.baseArgs ?? []).map((a, i) =>
      assertSafeValue(`baseArgs[${i}]`, a),
    );
    this.plan = { file, args: baseArgs };
    this.opts = {
      commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      maxNotificationBytes: DEFAULT_NOTIFICATION_BYTES,
      ...options,
    };
    if (options.fromHandle !== undefined) {
      assertSafeValue('fromHandle', options.fromHandle);
    }
  }

  /** Exposed for tests: the spawn plan in use. */
  get spawnPlan(): SpawnPlan {
    return this.plan;
  }

  /**
   * Run one `orca` command and map the process result into a typed result.
   * `args` are appended after baseArgs; `--json` is the caller's choice.
   *
   * `mutation: true` appends `--full` so the receipt carries
   * `result.mutation.requestId` (the Orca-issued request id needed for
   * recovery) and logs the argv for `retryMutation`. It is for
   * `orchestration` commands ONLY — `orca terminal` commands have no
   * `--full` and no retry semantics (verified 1.4.261:
   * `invalid_argument: Unknown flag --full`), so they must run bare; their
   * top-level envelope `id` is still captured as receipt evidence.
   * `retryRequestId` appends `--retry-request <id>` — the ONLY legitimate
   * use, re-issuing an earlier Orca orchestration request after request-show.
   */
  async run<T = unknown>(
    args: readonly string[],
    opts: { timeoutMs?: number; mutation?: boolean; retryRequestId?: string } = {},
  ): Promise<OrcaCommandResult<T>> {
    const timeoutMs = opts.timeoutMs ?? this.opts.commandTimeoutMs;
    const runner = this.opts.spawnFn ?? runProcess;
    const argv = [...this.plan.args, ...args];
    if (opts.mutation) argv.push('--full');
    if (opts.retryRequestId !== undefined) {
      argv.push('--retry-request', assertSafeValue('retryRequestId', opts.retryRequestId));
    }
    const proc = await runner({ file: this.plan.file, args: argv }, { timeoutMs, cwd: this.opts.cwd });

    if (proc.reason === 'timed_out') {
      return {
        ok: false,
        error: { code: 'local_timeout', message: `orca exceeded ${timeoutMs}ms` },
        uncertain: true,
        exitCode: null,
        timedOut: true,
      };
    }
    if (proc.reason === 'spawn_failed') {
      return {
        ok: false,
        error: { code: 'spawn_failed', message: proc.stderr },
        uncertain: false,
        exitCode: null,
        timedOut: false,
      };
    }

    // Mutations are logged so an uncertain outcome can be re-issued later with
    // --retry-request <orca-id> once the request id is known (or proven absent).
    const logged = opts.mutation
      ? { args: argv.slice(), requestId: undefined as string | undefined }
      : undefined;

    const parsed = parseOrcaEnvelope(proc);
    if (parsed.kind === 'json') {
      const env = parsed.envelope;
      const requestId = extractRequestId(env);
      if (logged) {
        if (requestId !== undefined) logged.requestId = requestId;
        this.mutationLog.push(logged);
      }
      if (env.ok) {
        return {
          ok: true,
          value: env.result as T,
          ...(requestId === undefined ? {} : { requestId }),
          exitCode: proc.exitCode ?? 0,
          truncated: proc.stdoutTruncated,
        };
      }
      const code = env.error?.code ?? 'unknown';
      const data = env.error?.data;
      return {
        ok: false,
        error: {
          code,
          message: env.error?.message ?? 'orca command failed',
          ...(data === undefined ? {} : { data }),
        },
        ...(requestId === undefined ? {} : { requestId }),
        uncertain: UNCERTAIN_CODES.has(code),
        exitCode: proc.exitCode,
        timedOut: false,
      };
    }
    if (parsed.kind === 'error_line') {
      if (logged) this.mutationLog.push(logged);
      return {
        ok: false,
        error: parsed.error,
        uncertain: UNCERTAIN_CODES.has(parsed.error.code),
        exitCode: proc.exitCode,
        timedOut: false,
      };
    }
    if (logged) this.mutationLog.push(logged);
    return {
      ok: false,
      error: {
        code: 'unparsed_output',
        message: `orca exited ${proc.exitCode} without a JSON envelope or error line`,
        data: {
          stdoutTail: proc.stdout.slice(-400),
          stderrTail: proc.stderr.slice(-400),
          stdoutTruncated: proc.stdoutTruncated,
          stderrTruncated: proc.stderrTruncated,
        },
      },
      // A mutation whose reply cannot be parsed is uncertain; reads can treat
      // it as a clean failure upstream via error.code.
      uncertain: true,
      exitCode: proc.exitCode,
      timedOut: false,
    };
  }

  /**
   * Mutations issued by this host instance, in order. `requestId` is filled
   * when Orca reported one; an empty requestId means the outcome never
   * produced an id (timeout/unparsable) — reconcile by observation, not retry.
   */
  readonly mutationLog: { args: string[]; requestId?: string }[] = [];

  /**
   * Reconcile + re-issue a logged mutation. Flow: request-show first —
   * 'completed'/'pending' means do NOT re-issue (return that state); 'absent'
   * or a refused/lost request means re-issue the exact argv plus
   * `--retry-request <id>` so Orca replays/executes the recorded request
   * instead of creating a new one. Never fabricates argv for an unknown id.
   */
  async retryMutation(
    requestId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<
    | { state: 'completed' | 'pending'; requestId: string }
    | { state: 'reissued'; requestId: string; result: OrcaCommandResult<unknown> }
    | { state: 'refused'; requestId: string; reason: string }
  > {
    const id = assertSafeValue('requestId', requestId);
    const probe = await this.showRequest(id);
    if (probe.ok) {
      const rec = asRecord(probe.value) ?? {};
      const state = firstString(rec.state, rec.status);
      if (state === 'completed' || state === 'done') {
        return { state: 'completed', requestId: id };
      }
      if (state === 'pending' || state === 'in_progress') {
        return { state: 'pending', requestId: id };
      }
      // 'absent' (or anything else): request-show could not prove it landed —
      // re-issue the recorded argv with --retry-request.
    }
    const logged = this.mutationLog.find((m) => m.requestId === id);
    if (!logged) {
      return {
        state: 'refused',
        requestId: id,
        reason:
          'no recorded argv for this request id in this process; refusing to fabricate a mutation',
      };
    }
    const args = logged.args.filter(
      (a, i) =>
        a !== '--full' &&
        a !== '--retry-request' &&
        !(i > 0 && logged.args[i - 1] === '--retry-request'),
    );
    const result = await this.run(args, { ...opts, mutation: true, retryRequestId: id });
    return { state: 'reissued', requestId: id, result };
  }

  // -- Run / Task lifecycle -------------------------------------------------

  /** Show the caller's currently bound Run so it can be preserved/restored. */
  async currentRun(): Promise<OrcaCommandResult<{ runId: string | null }>> {
    return this.run(['orchestration', 'run-current', '--json']);
  }

  /** Create a dedicated council Run. The caller must scope every later call with --run. */
  async createRun(
    objective: string,
    requestKey: string,
  ): Promise<OrcaCommandResult<{ runId: string }>> {
    if (objective.length === 0 || objective.length > 1024) {
      throw new OrcaAdapterError('bad_objective', 'objective must be 1..1024 chars');
    }
    const res = await this.run<{ run?: { id: string }; id?: string }>([
      'orchestration',
      'run-create',
      '--objective=' + objective,
      ...this.fromArgs(),
      '--json',
    ], { mutation: true });
    if (!res.ok) return res;
    const runId = res.value?.run?.id ?? res.value?.id;
    if (typeof runId !== 'string' || runId.length === 0) {
      return {
        ok: false,
        error: { code: 'missing_run_id', message: 'run-create returned no run id', data: res.value },
        uncertain: true,
        exitCode: res.exitCode,
        timedOut: false,
      };
    }
    return {
      ok: true,
      value: { runId },
      ...(res.requestId === undefined ? {} : { requestId: res.requestId }),
      exitCode: res.exitCode,
      truncated: res.truncated,
    };
  }

  /** Create a Task inside the council Run from a spec file (never inline spec text). */
  async createTask(input: {
    runId: string;
    specFile: string;
    title: string;
    requestKey: string;
    deps?: readonly string[];
  }): Promise<OrcaCommandResult<{ taskId: string }>> {
    const args = [
      'orchestration',
      'task-create',
      '--spec-file',
      assertPathValue('specFile', input.specFile),
      '--task-title=' + input.title,
      '--run',
      assertSafeValue('runId', input.runId),
      ...this.fromArgs(),
      '--json',
    ];
    if (input.deps && input.deps.length > 0) {
      const deps = input.deps.map((d, i) => assertSafeValue(`deps[${i}]`, d));
      args.splice(args.indexOf('--json'), 0, '--deps', JSON.stringify(deps));
    }
    const res = await this.run<{ task?: { id: string }; id?: string }>(args, { mutation: true });
    if (!res.ok) return res;
    const taskId = res.value?.task?.id ?? res.value?.id;
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return {
        ok: false,
        error: { code: 'missing_task_id', message: 'task-create returned no task id', data: res.value },
        uncertain: true,
        exitCode: res.exitCode,
        timedOut: false,
      };
    }
    return {
      ok: true,
      value: { taskId },
      ...(res.requestId === undefined ? {} : { requestId: res.requestId }),
      exitCode: res.exitCode,
      truncated: res.truncated,
    };
  }

  // -- Worker start lanes ----------------------------------------------------

  /**
   * Start one supervised phase worker.
   *
   * Lanes:
   * - `agent`: `worker-start --task --worktree --agent [--model --effort]`.
   *   --model is honored for Claude/Codex-class agents only; for Devin the
   *   argv lane is required (see ORCA-COMPATIBILITY.md §Custom argv lane).
   * - `argv`: `terminal create --command <validated tokens>` →
   *   `terminal wait --for tui-idle` → `worker-start --task --terminal`.
   *   Used to pin `devin --model swe-2-max --permission-mode <approved>`.
   *
   * A retained terminal may receive a new phase Task only after its prior
   * dispatch is proven settled (worker-show first); overlapping active work on
   * one terminal is refused before mutation.
   */
  async startPhaseWorker(input: StartPhaseWorkerInput): Promise<PhaseWorkerStart> {
    const receipts: Record<string, unknown> = {};
    const runId = assertSafeValue('runId', input.runId);
    const taskId = assertSafeValue('taskId', input.taskId);
    const requestKey = assertSafeValue('requestKey', input.requestKey);

    let terminalHandle: string | undefined;
    const expectedAgent =
      input.lane.kind === 'argv' ? input.lane.command[0] : input.lane.agent;

    if (input.retainedTerminal) {
      const handle = assertSafeValue('retainedTerminal.handle', input.retainedTerminal.handle);
      // Prove the previous assignment on this terminal settled before reuse.
      const settled = await this.terminalIsFree(handle, runId);
      receipts.terminalIsFree = settled;
      if (!settled.ok) {
        return {
          taskId,
          runId,
          requestKey,
          outcome: settled.uncertain ? 'uncertain' : 'failed',
          error: settled.error ?? {
            code: 'terminal_busy',
            message: `terminal ${handle} still owns active work`,
          },
          receipts,
        };
      }
      // A kept-open terminal can also sit on a trust/permission menu — the
      // same explicit readiness proof as the fresh-argv path applies.
      const ready = await this.terminalReady(handle, expectedAgent);
      receipts.terminalShow = ready.state === 'ready' ? ready.value : ready.value ?? ready.error;
      if (ready.state !== 'ready') {
        return {
          taskId,
          runId,
          requestKey,
          outcome: 'uncertain',
          failedStage: 'readiness',
          terminalHandle: handle,
          error: {
            code: ready.state === 'not_ready' ? 'agent_not_ready' : 'readiness_unproven',
            message: ready.message,
            ...(ready.value === undefined ? {} : { data: ready.value }),
          },
          receipts,
        };
      }
      terminalHandle = handle;
    } else if (input.lane.kind === 'argv') {
      const commandText = this.validatedAgentCommand(input.lane);
      // `orca terminal` commands take no --full and are never retry-requested;
      // the receipt's top-level `id` is still captured via extractRequestId.
      const created = await this.run<{ handle?: string; terminal?: { handle?: string } }>([
        'terminal',
        'create',
        '--worktree',
        assertSafeValue('worktree', input.worktree),
        '--title=' + (input.title ?? `council-${taskId.slice(-8)}`),
        '--command=' + commandText,
        '--json',
      ]);
      receipts.terminalCreate = created.ok ? created.value : created.error;
      if (!created.ok) {
        return {
          taskId,
          runId,
          requestKey,
          outcome: created.uncertain ? 'uncertain' : 'failed',
          ...(created.requestId === undefined ? {} : { requestId: created.requestId }),
          error: created.error,
          receipts,
        };
      }
      terminalHandle =
        created.value?.terminal?.handle ?? created.value?.handle ?? undefined;
      if (terminalHandle === undefined) {
        return {
          taskId,
          runId,
          requestKey,
          outcome: 'uncertain',
          error: {
            code: 'missing_terminal_handle',
            message: 'terminal create returned no handle; inspect the worktree before retrying',
            data: created.value,
          },
          receipts,
        };
      }
      // Wait for the agent CLI to reach its prompt before the Task is injected.
      const waited = await this.run([
        'terminal',
        'wait',
        '--terminal',
        terminalHandle,
        '--for',
        'tui-idle',
        '--timeout-ms',
        String(input.lane.readinessTimeoutMs ?? input.terminalWaitTimeoutMs ?? 60_000),
        '--json',
      ]);
      receipts.terminalWait = waited.ok ? waited.value : waited.error;
      if (!waited.ok) {
        return {
          taskId,
          runId,
          requestKey,
          outcome: 'uncertain',
          terminalHandle,
          requestId: created.requestId,
          error: {
            code: 'readiness_wait_failed',
            message:
              'terminal wait did not prove the agent idle; the terminal may still be usable — reconcile before retry',
            data: waited.error,
          },
          receipts,
        };
      }
      // tui-idle is not proof the agent is recognized and at a prompt — a
      // trust screen reads idle too. Require the documented terminal show
      // to prove the expected agent is present and not waiting on input.
      const ready = await this.terminalReady(terminalHandle, expectedAgent);
      receipts.terminalShow = ready.state === 'ready' ? ready.value : ready.value ?? ready.error;
      if (ready.state !== 'ready') {
        return {
          taskId,
          runId,
          requestKey,
          outcome: 'uncertain',
          failedStage: 'readiness',
          terminalHandle,
          requestId: created.requestId,
          error: {
            code: ready.state === 'not_ready' ? 'agent_not_ready' : 'readiness_unproven',
            message: ready.message,
            ...(ready.value === undefined ? {} : { data: ready.value }),
          },
          receipts,
        };
      }
    }

    const args: string[] = [
      'orchestration',
      'worker-start',
      '--task',
      taskId,
      '--run',
      runId,
      '--worktree',
      assertSafeValue('worktree', input.worktree),
    ];
    if (terminalHandle !== undefined) {
      args.push('--terminal', terminalHandle);
    } else if (input.lane.kind === 'agent') {
      const agent = assertAllowlisted(
        'agent',
        input.lane.agent,
        this.opts.allowedAgents ?? ['devin', 'claude', 'codex'],
      );
      args.push('--agent', agent);
      if (input.lane.model !== undefined) {
        // Orca --model is not honored for Devin (verified: devin CLI takes its
        // own --model flag). Pinning devin swe-2-max requires the argv lane.
        if (agent === 'devin') {
          throw new OrcaAdapterError(
            'unsupported_lane',
            'worker-start --model is not honored for agent "devin"; use the argv lane with devin --model swe-2-max --permission-mode <approved>',
          );
        }
        // Adapter policies already allowlisted the model; a host-level
        // allowlist applies only when explicitly configured for this agent.
        const allowed = this.opts.allowedModels?.[agent];
        const model =
          allowed === undefined
            ? assertCommandToken('model', input.lane.model)
            : assertAllowlisted('model', input.lane.model, allowed);
        args.push('--model', model);
        if (input.lane.effort !== undefined) {
          args.push('--effort', assertCommandToken('effort', input.lane.effort));
        }
      }
    }
    args.push('--json');

    const started = await this.run<Record<string, unknown>>(args, { mutation: true });
    receipts.workerStart = started.ok ? started.value : started.error;
    if (!started.ok) {
      return {
        taskId,
        runId,
        requestKey,
        outcome: started.uncertain ? 'uncertain' : 'failed',
        terminalHandle,
        ...(started.requestId === undefined ? {} : { requestId: started.requestId }),
        error: started.error,
        receipts,
      };
    }

    const extracted = extractDispatchInfo(started.value);
    return {
      taskId,
      runId,
      requestKey,
      outcome: 'ready',
      dispatchId: extracted.dispatchId,
      workerAddress: extracted.workerAddress,
      terminalHandle: terminalHandle ?? extracted.terminalHandle,
      ...(started.requestId === undefined ? {} : { requestId: started.requestId }),
      receipts,
    };
  }

  /**
   * Check whether a terminal is free to receive a new phase Task:
   * no active dispatch owns it, and the terminal itself is not busy.
   */
  private async terminalIsFree(
    handle: string,
    runId: string,
  ): Promise<{ ok: boolean; uncertain?: boolean; error?: OrcaCliErrorShape }> {
    const listed = await this.listWorkers(runId);
    if (!listed.ok) {
      return { ok: false, uncertain: listed.uncertain, error: listed.error };
    }
    // A retained terminal stays 'live' after its dispatch ends; a logical
    // end state in state/outcome vetoes the liveness signal (1.4.261).
    const active = listed.value.workers.find(
      (w) =>
        w.terminal === handle &&
        !isEndedDispatchState(w.outcome) &&
        !isEndedDispatchState(w.state) &&
        (w.outcome === 'in_progress' ||
          w.state === 'dispatched' ||
          w.state === 'ready' ||
          w.state === 'in_progress' ||
          w.state === 'working' ||
          w.state === 'running' ||
          w.liveness === 'live'),
    );
    if (active) {
      return {
        ok: false,
        error: {
          code: 'terminal_busy',
          message: `dispatch ${active.dispatchId} still owns terminal ${handle}`,
          data: active,
        },
      };
    }
    return { ok: true };
  }

  /**
   * Prove a terminal is actually ready to receive a Task — `tui-idle` alone
   * is insufficient: a workspace-trust or permission screen also reads idle,
   * and `worker-start` then refuses "not running a recognized agent" after
   * the terminal was already created. Readiness requires the documented
   * `terminal show` to report the terminal connected, carrying the expected
   * agent identity, and NOT waiting on a prompt (`agentWait === null`).
   * We never auto-accept trust/permission menus — a not-ready terminal is
   * reported, never poked.
   */
  private async terminalReady(
    handle: string,
    expectedAgent: string,
  ): Promise<
    | { state: 'ready'; value: unknown }
    | { state: 'not_ready' | 'unproven'; message: string; error?: OrcaCliErrorShape; value?: unknown }
  > {
    const shown = await this.run<Record<string, unknown>>([
      'terminal',
      'show',
      '--terminal',
      handle,
      '--json',
    ]);
    if (!shown.ok) {
      return {
        state: 'unproven',
        message: `terminal show for ${handle} failed (${shown.error.code}: ${shown.error.message}) — readiness could not be proven; inspect the terminal before retry`,
        error: shown.error,
      };
    }
    const t = asRecord(asRecord(shown.value)?.terminal ?? shown.value);
    if (t === undefined) {
      return {
        state: 'unproven',
        message: `terminal show for ${handle} returned no terminal record — readiness could not be proven; inspect the terminal before retry`,
        value: shown.value,
      };
    }
    const reported = firstString(t.handle);
    if (reported !== handle) {
      return {
        state: 'unproven',
        message: `terminal show described ${reported ?? 'an unidentified terminal'}, expected ${handle} — refusing to treat the read as this terminal`,
        value: shown.value,
      };
    }
    if (t.connected !== true) {
      return {
        state: 'not_ready',
        message: `terminal ${handle} is not connected — the agent may still be booting; inspect it, then retry/reconcile`,
        value: shown.value,
      };
    }
    const identity = firstString(t.agentIdentity);
    if (identity === undefined || identity.toLowerCase() !== expectedAgent.toLowerCase()) {
      return {
        state: 'not_ready',
        message: `terminal ${handle} is not running a recognized ${expectedAgent} agent (agentIdentity=${JSON.stringify(identity ?? null)}) — resolve it in the terminal (never auto-accept trust/permission prompts), then retry/reconcile`,
        value: shown.value,
      };
    }
    // The field must be OBSERVED — a receipt that omits agentWait entirely
    // proves nothing (the documented shape carries it null when prompt-free).
    if (!('agentWait' in t)) {
      return {
        state: 'unproven',
        message: `terminal show for ${handle} did not report agentWait — readiness could not be proven; inspect the terminal before retry`,
        value: shown.value,
      };
    }
    if (t.agentWait !== null) {
      return {
        state: 'not_ready',
        message: `terminal ${handle} agent is waiting on ${JSON.stringify(t.agentWait)} — a trust/permission/menu prompt needs a decision in that terminal (never auto-accept it); resolve it, then retry/reconcile`,
        value: shown.value,
      };
    }
    return { state: 'ready', value: shown.value };
  }

  /**
   * Validate custom-argv lane tokens into one --command string.
   * Composition is fully determined by configuration: binary, fixed flags and
   * allowlisted model/permission tokens only — no caller text can appear here.
   */
  private validatedAgentCommand(lane: { kind: 'argv'; command: readonly string[] }): string {
    // Default boundary = the shipped catalog binaries; explicit injection may
    // narrow it further. Every token still passes COMMAND_TOKEN_RE below.
    const binaries = this.opts.allowedAgentBinaries ?? CATALOG_BINARIES;
    assertAllowlisted('agent binary', lane.command[0], binaries);
    return buildAgentCommandText(lane.command);
  }

  // -- Observation (read-only; never consuming mail) -------------------------

  async showWorker(dispatchId: string): Promise<OrcaCommandResult<Record<string, unknown>>> {
    return this.run([
      'orchestration',
      'worker-show',
      '--dispatch',
      assertSafeValue('dispatchId', dispatchId),
      '--json',
    ]);
  }

  async readWorker(
    dispatchId: string,
    opts: { limit?: number; cursor?: string; source?: 'auto' | 'transcript' | 'terminal' } = {},
  ): Promise<OrcaCommandResult<Record<string, unknown>>> {
    const args = [
      'orchestration',
      'worker-read',
      '--dispatch',
      assertSafeValue('dispatchId', dispatchId),
    ];
    if (opts.source) args.push('--source', opts.source);
    if (opts.limit !== undefined) args.push('--limit', String(opts.limit));
    if (opts.cursor !== undefined) args.push('--cursor', assertSafeValue('cursor', opts.cursor));
    args.push('--json');
    return this.run(args);
  }

  async listWorkers(
    runId: string,
    opts: { terminalState?: string; limit?: number } = {},
  ): Promise<OrcaCommandResult<{ workers: WorkerListRow[] }>> {
    const args = [
      'orchestration',
      'worker-list',
      '--run',
      assertSafeValue('runId', runId),
    ];
    if (opts.terminalState) args.push('--terminal-state', assertSafeValue('terminalState', opts.terminalState));
    if (opts.limit !== undefined) args.push('--limit', String(opts.limit));
    args.push('--json');
    const res = await this.run<{ workers?: WorkerListRow[] }>(args);
    if (!res.ok) return res;
    return {
      ok: true,
      value: { workers: res.value?.workers ?? [] },
      exitCode: res.exitCode,
      truncated: res.truncated,
    };
  }

  /** Read-only mail history. NEVER a consuming check or --ack. */
  async inboxHistory(input: {
    runId?: string;
    mailbox?: string;
    limit?: number;
  }): Promise<OrcaCommandResult<Record<string, unknown>>> {
    const args = ['orchestration', 'inbox'];
    if (input.mailbox !== undefined) {
      args.push('--terminal', assertSafeValue('mailbox', input.mailbox));
    } else if (input.runId !== undefined) {
      args.push('--run', assertSafeValue('runId', input.runId));
    }
    if (input.limit !== undefined) args.push('--limit', String(input.limit));
    args.push('--json');
    return this.run(args);
  }

  // -- Mutations --------------------------------------------------------------

  /**
   * Bounded one-way notification to any validated mailbox target
   * ("dispatch:<id>", "run:<id>", "term_<h>", "orca_session_id:<id>").
   * Doorbell semantics only — real content lives in artifacts.
   */
  async sendMail(input: {
    target: string;
    subject: string;
    body: string;
    type?: string;
    taskId?: string;
    dispatchId?: string;
    phase?: string;
    requestKey: string;
  }): Promise<OrcaCommandResult<Record<string, unknown>>> {
    if (input.subject.length === 0 || input.subject.length > 512) {
      throw new OrcaAdapterError('bad_subject', 'subject must be 1..512 chars');
    }
    const bodyBytes = Buffer.byteLength(input.body, 'utf8');
    if (bodyBytes > this.opts.maxNotificationBytes) {
      throw new OrcaAdapterError(
        'notification_too_large',
        `body is ${bodyBytes} bytes; limit ${this.opts.maxNotificationBytes}. Trim complete entries — never split JSON.`,
      );
    }
    const args = [
      'orchestration',
      'send',
      '--to',
      assertSafeValue('mail target', input.target),
      '--subject=' + input.subject,
      '--body=' + input.body,
      '--type',
      input.type === undefined ? 'status' : assertCommandToken('type', input.type),
    ];
    if (input.taskId !== undefined) {
      args.push('--task-id', assertSafeValue('taskId', input.taskId));
    }
    if (input.dispatchId !== undefined) {
      args.push('--dispatch-id', assertSafeValue('dispatchId', input.dispatchId));
    }
    if (input.phase !== undefined) {
      args.push('--phase', assertCommandToken('phase', input.phase));
    }
    args.push(
      ...this.fromArgs(),
      '--json',
    );
    return this.run(args, { mutation: true });
  }

  /**
   * Guarded stop. Call only on explicit user/engine cancellation — never on
   * silence or suspicion. stop_unknown is an uncertain outcome.
   */
  async requestWorkerStop(
    dispatchId: string,
    requestKey: string,
  ): Promise<OrcaCommandResult<Record<string, unknown>>> {
    return this.run([
      'orchestration',
      'worker-stop',
      '--dispatch',
      assertSafeValue('dispatchId', dispatchId),
      '--json',
    ], { mutation: true });
  }

  /** Release a settled worker's terminal (archives output first). */
  async releaseWorker(
    dispatchId: string,
    requestKey: string,
  ): Promise<OrcaCommandResult<Record<string, unknown>>> {
    return this.run([
      'orchestration',
      'worker-release',
      '--dispatch',
      assertSafeValue('dispatchId', dispatchId),
      '--json',
    ], { mutation: true });
  }

  /** Keep a settled worker open for later phases (cancels auto-release). */
  async keepWorkerOpen(
    dispatchId: string,
    requestKey: string,
  ): Promise<OrcaCommandResult<Record<string, unknown>>> {
    return this.run([
      'orchestration',
      'worker-keep-open',
      '--dispatch',
      assertSafeValue('dispatchId', dispatchId),
      '--json',
    ], { mutation: true });
  }

  /**
   * Read-only task ledger for one Run (`orchestration task-list --run --full`).
   * The receipt must expose an explicit row array; malformed receipts surface
   * as an error rather than a fake "empty" that could unlock a duplicate
   * task-create.
   */
  async listTasks(runId: string): Promise<OrcaCommandResult<{ tasks: Record<string, unknown>[] }>> {
    const res = await this.run<{ tasks?: unknown; items?: unknown }>([
      'orchestration',
      'task-list',
      '--run',
      assertSafeValue('runId', runId),
      '--full',
      '--json',
    ]);
    if (!res.ok) return res;
    const raw = res.value;
    const list = raw?.tasks ?? raw?.items ?? (Array.isArray(raw) ? raw : undefined);
    if (!Array.isArray(list)) {
      return {
        ok: false,
        error: {
          code: 'malformed_task_list',
          message: `task-list for Run ${runId} returned no task array — refusing to treat the read as reliable`,
          data: raw,
        },
        uncertain: false,
        exitCode: res.exitCode,
        timedOut: false,
      };
    }
    for (const row of list) {
      const identifiable =
        typeof row === 'object' &&
        row !== null &&
        [row.id, row.taskId, row.specFile, row.spec_file, row.specPath, row.spec_path, row.spec, row.title, row.taskTitle, row.task].some(
          (v) => v !== undefined && v !== null,
        );
      if (!identifiable) {
        return {
          ok: false,
          error: {
            code: 'incomplete_task_list',
            message: `task-list for Run ${runId} contains a row with no task id or spec fields — refusing to treat the read as reliable`,
            data: row,
          },
          uncertain: false,
          exitCode: res.exitCode,
          timedOut: false,
        };
      }
    }
    return {
      ok: true,
      value: { tasks: list as Record<string, unknown>[] },
      exitCode: res.exitCode,
      truncated: res.truncated,
    };
  }

  /** Read-only reconciliation for a mutation whose response was lost. */
  async showRequest(requestId: string): Promise<OrcaCommandResult<Record<string, unknown>>> {
    return this.run([
      'orchestration',
      'request-show',
      '--request',
      assertSafeValue('requestId', requestId),
      '--json',
    ]);
  }

  // -- Approval gates ---------------------------------------------------------

  async createGate(input: {
    taskId: string;
    question: string;
    requestKey: string;
  }): Promise<OrcaCommandResult<Record<string, unknown>>> {
    return this.run([
      'orchestration',
      'gate-create',
      '--task',
      assertSafeValue('taskId', input.taskId),
      '--question=' + input.question,
      ...this.fromArgs(),
      '--json',
    ], { mutation: true });
  }

  async resolveGate(input: {
    gateId: string;
    resolution: string;
    requestKey: string;
  }): Promise<OrcaCommandResult<Record<string, unknown>>> {
    return this.run([
      'orchestration',
      'gate-resolve',
      '--id',
      assertSafeValue('gateId', input.gateId),
      '--resolution=' + input.resolution,
      ...this.fromArgs(),
      '--json',
    ], { mutation: true });
  }

  // -- internals ---------------------------------------------------------------

  private fromArgs(): string[] {
    return this.opts.fromHandle ? ['--from', this.opts.fromHandle] : [];
  }
}

// ---------------------------------------------------------------------------
// Receipt extraction helpers (tolerant: receipt shapes vary by surface)
// ---------------------------------------------------------------------------

export interface WorkerListRow {
  dispatchId: string;
  taskId?: string;
  state?: string;
  outcome?: string;
  liveness?: string;
  agent?: string;
  terminal?: string;
  terminalState?: string;
  workspace?: string;
  host?: string;
  [k: string]: unknown;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Explicit dispatch verdicts: a record carrying one of these in `outcome`
 * (worker-list) or `state` (worker-show, verified 1.4.261: 'succeeded')
 * proves the Task logically ended WITH that result. Generic lifecycle
 * markers ('settled', 'done', 'released'), stage fields, and physical
 * signals (dead/exited liveness, released terminals) say a session ended
 * but carry NO verdict — never proof of successful completion.
 */
const DECISIVE_OUTCOMES = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'abandoned',
  'stopped',
]);

function isDecisiveOutcome(v: unknown): v is string {
  return typeof v === 'string' && DECISIVE_OUTCOMES.has(v);
}

/**
 * Logical Dispatch end states — the dispatch is provably over regardless of
 * whether a verdict was reported. Used ONLY for resource-ownership questions
 * (terminal reuse), never for success/failure judgment.
 */
const DISPATCH_ENDED = new Set([...DECISIVE_OUTCOMES, 'settled', 'done', 'released']);

function isEndedDispatchState(v: unknown): boolean {
  return typeof v === 'string' && DISPATCH_ENDED.has(v);
}

/**
 * The explicit verdict a dispatch record carries. `outcome` (worker-list) is
 * the authoritative verdict field; worker-show `state` can carry one too —
 * a generic lifecycle state ('settled', 'in_progress', …) is NOT a verdict.
 * Two decisive fields that disagree are a conflict, never silently resolved.
 */
function dispatchVerdict(rec: Record<string, unknown>): {
  verdict?: string;
  conflict?: { outcome: string; state: string };
} {
  const outcome = firstString(rec.outcome, asRecord(rec.result)?.outcome);
  const state = firstString(rec.state);
  const dOutcome = isDecisiveOutcome(outcome) ? outcome : undefined;
  const dState = isDecisiveOutcome(state) ? state : undefined;
  if (dOutcome !== undefined && dState !== undefined && dOutcome !== dState) {
    return { conflict: { outcome: dOutcome, state: dState } };
  }
  return { verdict: dOutcome ?? dState };
}

/**
 * Pull durable IDs from a worker-start receipt. The exact nesting differs by
 * surface (terminal vs chat launch); try the documented shapes and report
 * undefined rather than inventing an id. The engine reconciles through
 * worker-list --run when a field is absent.
 */
export function extractDispatchInfo(receipt: unknown): {
  dispatchId?: string;
  workerAddress?: string;
  terminalHandle?: string;
} {
  const r = asRecord(receipt);
  if (!r) return {};
  const dispatch = asRecord(r.dispatch) ?? asRecord(r.worker) ?? asRecord(r.result);
  const launch = asRecord(r.launch);
  const outcome = asRecord(launch?.outcome) ?? asRecord(r.outcome);
  const dispatchId = firstString(
    r.dispatchId,
    dispatch?.dispatchId,
    dispatch?.id,
    r.dispatch_id,
  );
  const terminalHandle = firstString(
    r.terminal,
    r.terminalHandle,
    asRecord(r.terminal)?.handle,
    launch?.terminalHandle,
    outcome?.handle,
    dispatch?.terminal,
  );
  const workerAddress = firstString(
    dispatchId ? `dispatch:${dispatchId}` : undefined,
    r.workerAddress,
    outcome?.handle,
    r.orcaSessionId ? `orca_session_id:${String(r.orcaSessionId)}` : undefined,
  );
  return { dispatchId, workerAddress, terminalHandle };
}

// ---------------------------------------------------------------------------
// OrcaAdapter — the contracts HostAdapter implementation
// ---------------------------------------------------------------------------

/**
 * Per-agent launch policy. Anything not listed here cannot launch; there is
 * no implicit fallback to ambient agent/model/permission configuration.
 */
export interface AgentLaunchPolicy {
  /**
   * 'argv': build `terminal create --command` from validated tokens
   * (binary, fixed flags, allowlisted model/permission/effort values).
   * 'agent': `worker-start --agent <id> [--model] [--effort]`.
   */
  lane: 'agent' | 'argv';
  /** Exact allowlist of model ids for this agent. */
  models: readonly string[];
  /**
   * Exact allowlist of ACCEPTED permission-mode tokens for this agent
   * (user-facing values). For lane 'argv' the emitted CLI token comes from
   * permissionModeMap when present; for lane 'agent' the token can only be
   * applied when Orca itself supervises it (no documented flag) — list a
   * mode here ONLY if that posture is genuinely Orca-managed. Unknown modes
   * are rejected — never passed through to the CLI.
   */
  permissionModes: readonly string[];
  /**
   * Explicit user-facing → CLI token mapping for permission modes
   * (e.g. {bypass: "dangerous"} for devin, whose --permission-mode only
   * accepts auto|accept-edits|smart|dangerous). Absent entries emit the
   * accepted token unchanged.
   */
  permissionModeMap?: Readonly<Record<string, string>>;
  /** Exact allowlist of effort tokens (optional). */
  effortValues?: readonly string[];
  /** argv lane: fixed flags used to assemble the command. */
  modelFlag?: string;
  permissionFlag?: string;
  effortFlag?: string;
  /** argv lane: extra fixed tokens appended verbatim (each charset-checked). */
  extraArgv?: readonly string[];
}

/**
 * Binaries the shipped catalog may emit into `terminal create --command`.
 * Source of truth is AGENT_CATALOG — an allowlist check, not a policy.
 */
const CATALOG_BINARIES: readonly string[] = [
  ...new Set(Object.values(AGENT_CATALOG).map((e) => e.binary)),
];

/**
 * Back-compat export for programmatic callers that injected explicit policies.
 * The shipped default launch policy is src/catalog.ts (resolveAgentLaunch) —
 * this constant is no longer consulted unless a caller passes
 * OrcaAdapterOptions.agents explicitly.
 */
export const DEFAULT_AGENT_POLICIES: Readonly<Record<string, AgentLaunchPolicy>> = {
  devin: {
    lane: 'argv',
    models: ['swe-2-max'],
    permissionModes: ['bypass', 'dangerous'],
    permissionModeMap: { bypass: 'dangerous' },
    modelFlag: '--model',
    permissionFlag: '--permission-mode',
  },
};

export interface OrcaAdapterOptions extends OrcaHostOptions {
  /**
   * Launch policies keyed by Orca agent id. Omit for the shipped catalog
   * (resolveAgentLaunch) — explicit injection is for programmatic
   * back-compat/tests only and bypasses the catalog fingerprint story.
   */
  agents?: Readonly<Record<string, AgentLaunchPolicy>>;
  /**
   * Council Run to address when WorkerLaunchSpec.runId is not populated
   * (set automatically when this adapter created the Run).
   */
  boundRunId?: OrcaRunId;
  /** Readiness wait for the argv lane terminal (`terminal wait --for tui-idle`). */
  readinessTimeoutMs?: number;
}

/** Deterministic durable request key: retrying the same inputs replays, never duplicates. */
function requestKey(kind: string, ...parts: readonly (string | null | undefined)[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p ?? '').update('');
  return `council-${kind}-${h.digest('hex').slice(0, 20)}`;
}

function adapterErr(
  adapterCode: string,
  message: string,
  details?: Record<string, unknown>,
): CouncilError {
  return { code: 'adapter_error', message, details: { adapterCode, ...details } };
}

function unsupportedErr(message: string, details?: Record<string, unknown>): CouncilError {
  return { code: 'unsupported', message, details };
}

function failure<T>(error: CouncilError): Result<T> {
  return { ok: false, error };
}

const TERMINAL_STATES = new Set([
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released',
]);

/**
 * Contracts HostAdapter over the Orca CLI. Owns no Run of its own — every
 * call addresses the council Run explicitly so the caller's binding is
 * preserved. Never consumes mail (`check`/`--ack`); observation is read-only.
 */
export class OrcaAdapter implements HostAdapter {
  private readonly host: OrcaHost;
  private readonly opts: OrcaAdapterOptions;
  private boundRunId?: OrcaRunId;

  constructor(host: OrcaHost, options: OrcaAdapterOptions = {}) {
    this.host = host;
    this.opts = options;
    this.boundRunId = options.boundRunId;
    if (this.boundRunId !== undefined) assertSafeValue('boundRunId', this.boundRunId);
    if (options.fromHandle !== undefined) assertSafeValue('fromHandle', options.fromHandle);
  }

  private councilRunId(explicit?: string): Result<OrcaRunId> {
    const runId = explicit ?? this.boundRunId;
    if (runId === undefined) {
      return failure(
        adapterErr('no_run', 'no council Run bound; createRun first or pass runId'),
      );
    }
    try {
      return { ok: true, value: assertSafeValue('runId', runId) };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  async createRun(input: { objective: string }): Promise<Result<{ runId: OrcaRunId; requestId?: string }>> {
    try {
      if (input.objective.trim().length === 0) {
        return failure(adapterErr('bad_objective', 'objective must be non-empty'));
      }
      // Only the bounded label crosses into Orca — the full brief never does;
      // the low-level host check still guards whatever reaches argv.
      const res = await this.host.createRun(
        runObjectiveLabel(input.objective),
        requestKey('run', input.objective),
      );
      if (!res.ok) {
        return failure(
          adapterErr(res.error.code, res.error.message, {
            uncertain: res.uncertain,
            data: res.error.data,
          }),
        );
      }
      this.boundRunId = res.value.runId;
      return {
        ok: true,
        value: {
          runId: res.value.runId,
          ...(res.requestId === undefined ? {} : { requestId: res.requestId }),
        },
      };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  async createTask(input: {
    runId: OrcaRunId;
    specFilePath: string;
    title: string;
    deps?: TaskId[];
  }): Promise<Result<{ taskId: TaskId; requestId?: string }>> {
    try {
      const res = await this.host.createTask({
        runId: input.runId,
        specFile: input.specFilePath,
        title: input.title,
        deps: input.deps,
        requestKey: requestKey('task', input.runId, input.specFilePath, input.title),
      });
      if (!res.ok) {
        return failure(
          adapterErr(res.error.code, res.error.message, {
            uncertain: res.uncertain,
            data: res.error.data,
          }),
        );
      }
      return {
        ok: true,
        value: {
          taskId: res.value.taskId,
          ...(res.requestId === undefined ? {} : { requestId: res.requestId }),
        },
      };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  /**
   * Read-only reconciliation surfaces (optional HostAdapter capability):
   * the engine observes landed task/dispatch records after a crash so a
   * persisted launch intent is never retried blind. Pure reads, never mail.
   */
  async listTasks(input: {
    runId: OrcaRunId;
  }): Promise<Result<{ tasks: Record<string, unknown>[] }>> {
    try {
      const res = await this.host.listTasks(input.runId);
      if (!res.ok) {
        return failure(
          adapterErr(res.error.code, res.error.message, {
            uncertain: res.uncertain,
            data: res.error.data,
          }),
        );
      }
      return { ok: true, value: { tasks: res.value.tasks } };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  async listWorkers(input: {
    runId: OrcaRunId;
  }): Promise<Result<{ workers: WorkerListRow[] }>> {
    try {
      const res = await this.host.listWorkers(input.runId);
      if (!res.ok) {
        return failure(
          adapterErr(res.error.code, res.error.message, {
            uncertain: res.uncertain,
            data: res.error.data,
          }),
        );
      }
      return { ok: true, value: { workers: res.value.workers } };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  async launchWorker(input: WorkerLaunchSpec): Promise<Result<LaunchResult>> {
    const runIdRes = this.councilRunId(input.runId);
    if (!runIdRes.ok) return runIdRes;
    const runId = runIdRes.value;

    const choice = input.agent;
    let lane: WorkerLaunchLane;
    if (this.opts.agents !== undefined) {
      // Explicitly injected policies — programmatic/back-compat lane for
      // callers that supply their own allowlists (tests, embedders). The
      // shipped catalog remains the only production policy.
      const policy = this.opts.agents[choice.agent];
      if (policy === undefined) {
        return failure(
          unsupportedErr(
            `no launch policy for agent ${JSON.stringify(choice.agent)}; configure OrcaAdapterOptions.agents`,
            { agent: choice.agent },
          ),
        );
      }
      try {
        lane = buildLane(choice, policy);
      } catch (e) {
        return failure(e instanceof OrcaAdapterError ? unsupportedErr(e.message, { agent: choice.agent, model: choice.model }) : tokenErr(e));
      }
    } else {
      // Shared shipped catalog — single launch policy for CLI, engine and
      // adapter. resolveAgentLaunch validates + templates in one pure step;
      // an unavailable model/posture/profile fails here, never substituted.
      const resolved = resolveAgentLaunch(choice);
      if (!resolved.ok) return failure(resolved.error);
      lane = { kind: 'argv', command: resolved.value.command };
    }

    const key = requestKey(
      'launch',
      runId,
      input.taskId,
      input.worktree,
      input.reuseTerminal ?? '',
      JSON.stringify(choice),
    );
    let started;
    try {
      started = await this.host.startPhaseWorker({
        runId,
        taskId: input.taskId,
        worktree: input.worktree,
        lane,
        requestKey: key,
        retainedTerminal: input.reuseTerminal ? { handle: input.reuseTerminal } : undefined,
        title: input.taskTitle,
        terminalWaitTimeoutMs: this.opts.readinessTimeoutMs,
      });
    } catch (e) {
      return failure(tokenErr(e));
    }

    const base: LaunchResult = {
      outcome: 'failed',
      taskId: input.taskId,
      // The ORCA-issued request id is the recovery handle; the local intent
      // key only correlates this attempt inside our own receipts/journal.
      ...(started.requestId === undefined ? {} : { requestId: started.requestId }),
    };
    if (started.terminalHandle !== undefined) base.terminalHandle = started.terminalHandle;

    if (started.outcome === 'failed' || started.outcome === 'uncertain') {
      base.outcome = started.outcome === 'failed' ? 'failed' : 'unknown';
      base.detail = describeLaunchFailure(started);
      return { ok: true, value: base };
    }

    base.outcome = 'started';
    if (started.dispatchId !== undefined) base.dispatchId = started.dispatchId;

    // Retention: mark the dispatch so its terminal survives settle. A refused
    // keep-open is recorded in detail, not fatal — reuse will verify settled
    // state before the next phase and fail clearly if the terminal is gone.
    if (input.retainTerminal && started.dispatchId !== undefined) {
      const kept = await this.host.keepWorkerOpen(
        started.dispatchId,
        requestKey('keep', started.dispatchId),
      );
      if (!kept.ok) {
        base.detail = `worker started; worker-keep-open ${
          kept.uncertain ? 'outcome unknown' : `refused (${kept.error.code})`
        } — terminal may not survive settle`;
      } else if (!keepOpenConfirmed(kept.value)) {
        base.detail =
          'worker started; worker-keep-open did not confirm retention — terminal may not survive settle';
      }
    }
    return { ok: true, value: base };
  }

  async observeWorker(input: {
    dispatchId: DispatchId;
  }): Promise<Result<WorkerObservation>> {
    try {
      const res = await this.host.showWorker(input.dispatchId);
      if (!res.ok) {
        if (res.uncertain) {
          return {
            ok: true,
            value: {
              dispatchId: input.dispatchId,
              liveness: 'unverifiable',
              detail: `worker-show uncertain: ${res.error.code} ${res.error.message}`,
            },
          };
        }
        return failure(
          adapterErr(res.error.code, res.error.message, { data: res.error.data }),
        );
      }
      const rec = res.value ?? {};
      const obs: WorkerObservation = {
        dispatchId: input.dispatchId,
        liveness: mapLiveness(rec),
      };
      // taskStatus carries the explicit verdict first — a generic
      // state:'settled' must never mask a decisive outcome:'failed'.
      const { verdict, conflict } = dispatchVerdict(rec);
      const taskStatus =
        verdict ??
        (conflict === undefined
          ? firstString(
              rec.state,
              rec.outcome,
              asRecord(rec.task)?.state,
              asRecord(rec.task)?.status,
            )
          : undefined);
      if (taskStatus !== undefined) obs.taskStatus = taskStatus;
      const ts = firstString(rec.terminalState, asRecord(rec.terminal)?.state);
      if (ts !== undefined && TERMINAL_STATES.has(ts)) {
        obs.terminalState = ts as WorkerObservation['terminalState'];
      }
      if (conflict !== undefined) {
        obs.detail = `conflicting decisive fields: outcome='${conflict.outcome}' state='${conflict.state}' — refusing to pick a verdict`;
      } else if (obs.liveness === 'unverifiable') {
        obs.detail = 'worker record did not expose a decisive liveness/outcome field';
      }
      return { ok: true, value: obs };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  async sendNotification(input: {
    to: string;
    subject: string;
    body: string;
    taskId?: TaskId;
    dispatchId?: DispatchId;
  }): Promise<
    Result<{ outcome: 'sent' | 'unknown'; requestId?: string; messageId?: MessageId }>
  > {
    try {
      parseMailTarget(input.to);
    } catch (e) {
      return failure(tokenErr(e));
    }
    const key = requestKey(
      'mail',
      input.to,
      input.subject,
      input.body,
      input.taskId,
      input.dispatchId,
    );
    try {
      const res = await this.host.sendMail({
        target: input.to,
        subject: input.subject,
        body: input.body,
        taskId: input.taskId,
        dispatchId: input.dispatchId,
        requestKey: key,
      });
      if (!res.ok) {
        if (res.uncertain) {
          return {
            ok: true,
            value: {
              outcome: 'unknown',
              ...(res.requestId === undefined ? {} : { requestId: res.requestId }),
            },
          };
        }
        return failure(
          adapterErr(res.error.code, res.error.message, { data: res.error.data }),
        );
      }
      const messageId = firstString(
        res.value?.messageId,
        res.value?.id,
        asRecord(res.value?.message)?.id,
      );
      const out: {
        outcome: 'sent' | 'unknown';
        requestId?: string;
        messageId?: MessageId;
      } = {
        outcome: 'sent',
        ...(res.requestId === undefined ? {} : { requestId: res.requestId }),
      };
      if (messageId !== undefined) out.messageId = messageId;
      return { ok: true, value: out };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  async requestStop(input: {
    dispatchId: DispatchId;
    reason: string;
  }): Promise<Result<{ outcome: StopOutcome }>> {
    try {
      const res = await this.host.requestWorkerStop(
        input.dispatchId,
        requestKey('stop', input.dispatchId, input.reason),
      );
      if (!res.ok) {
        if (res.uncertain) return { ok: true, value: { outcome: 'unknown' } };
        return { ok: true, value: { outcome: 'refused' } };
      }
      // ok:true is not stop proof — claim cancellation only on a confirmed
      // stopped result (recovery-and-cleanup reference).
      return { ok: true, value: { outcome: mapStopReceipt(res.value) } };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  async releaseWorker(input: {
    dispatchId: DispatchId;
  }): Promise<Result<{ released: boolean }>> {
    try {
      const res = await this.host.releaseWorker(
        input.dispatchId,
        requestKey('release', input.dispatchId),
      );
      if (!res.ok) {
        return failure(
          adapterErr(res.error.code, res.error.message, { uncertain: res.uncertain }),
        );
      }
      // ok:true is not release proof — observed 1.4.261: worker-release can
      // return state 'retained' (reason 'user_requested') with nothing
      // released. Only an explicit released marker may claim released; a
      // retained/refused/release_pending/release_unknown or unrecognized
      // envelope reports released:false — custody stays with the terminal.
      return { ok: true, value: { released: releaseConfirmed(res.value) } };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  /**
   * Read-only reconciliation: ask Orca whether a mutation request already
   * took effect. States per request-show --help: completed | pending |
   * absent. 'absent' is NOT proof the request never landed (pruning).
   */
  async requestShow(input: { requestId: string }): Promise<
    Result<{ state: 'completed' | 'pending' | 'absent' | 'unknown'; raw: unknown }>
  > {
    try {
      const res = await this.host.showRequest(input.requestId);
      if (!res.ok) {
        return failure(adapterErr(res.error.code, res.error.message, { data: res.error.data }));
      }
      const rec = (res.value ?? {}) as Record<string, unknown>;
      const state = typeof rec.state === 'string' ? rec.state : 'unknown';
      const normalized =
        state === 'completed' || state === 'done'
          ? 'completed'
          : state === 'pending' || state === 'in_progress'
            ? 'pending'
            : state === 'absent'
              ? 'absent'
              : 'unknown';
      return { ok: true, value: { state: normalized, raw: res.value } };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }

  /**
   * Honest recovery for an uncertain mutation: request-show FIRST; only when
   * Orca cannot prove the request landed (absent) does this re-issue the
   * recorded argv with `--retry-request <id>`. Refuses when this process
   * never logged the mutation — never fabricates argv for a foreign id.
   * Not part of the HostAdapter contract surface; the engine may call it on
   * the concrete adapter (or a future contract method can forward to it).
   */
  async retryMutation(requestId: string): Promise<
    Result<
      | { state: 'completed' | 'pending' }
      | { state: 'reissued'; result: 'ok' | 'failed' | 'uncertain' }
      | { state: 'refused'; reason: string }
    >
  > {
    try {
      const out = await this.host.retryMutation(requestId);
      if (out.state === 'reissued') {
        const r = out.result;
        return {
          ok: true,
          value: {
            state: 'reissued',
            result: r.ok ? 'ok' : r.uncertain ? 'uncertain' : 'failed',
          },
        };
      }
      if (out.state === 'refused') {
        return { ok: true, value: { state: 'refused', reason: out.reason } };
      }
      return { ok: true, value: { state: out.state } };
    } catch (e) {
      return failure(tokenErr(e));
    }
  }
}

/** Factory used by CLI wiring and tests. */
export function createOrcaAdapter(options: OrcaAdapterOptions = {}): HostAdapter {
  return new OrcaAdapter(new OrcaHost(options), options);
}

// -- adapter internals -------------------------------------------------------

function tokenErr(e: unknown): CouncilError {
  if (e instanceof OrcaAdapterError) {
    return adapterErr(e.code, e.message);
  }
  return adapterErr('unexpected', e instanceof Error ? e.message : String(e));
}

/**
 * Resolve an AgentChoice to a concrete lane against its policy. Throws
 * OrcaAdapterError('unsupported_lane' | 'not_allowlisted' | 'unsafe_token')
 * for anything outside the approved envelope — callers must NOT fall back to
 * ambient config.
 */
function buildLane(choice: AgentChoice, policy: AgentLaunchPolicy): WorkerLaunchLane {
  if (policy.lane === 'argv') {
    const argv: string[] = [assertCommandToken('agent binary', choice.agent)];
    assertAllowlisted('model', choice.model, policy.models);
    argv.push(assertCommandToken('modelFlag', policy.modelFlag ?? '--model'), choice.model);
    assertAllowlisted('permissionMode', choice.permissionMode, policy.permissionModes);
    // Explicit user-facing → CLI mapping (e.g. bypass → dangerous). Never
    // pass the accepted token through blindly.
    const permissionArg = policy.permissionModeMap?.[choice.permissionMode] ?? choice.permissionMode;
    argv.push(
      assertCommandToken('permissionFlag', policy.permissionFlag ?? '--permission-mode'),
      assertCommandToken('permissionMode', permissionArg),
    );
    if (choice.effort !== undefined) {
      if (policy.effortFlag === undefined || policy.effortValues === undefined) {
        throw new OrcaAdapterError(
          'unsupported_lane',
          `agent ${choice.agent} policy does not support effort tokens`,
        );
      }
      assertAllowlisted('effort', choice.effort, policy.effortValues);
      argv.push(assertCommandToken('effortFlag', policy.effortFlag), choice.effort);
    }
    for (const extra of policy.extraArgv ?? []) {
      argv.push(assertCommandToken('extraArgv', extra));
    }
    return { kind: 'argv', command: argv };
  }

  // agent lane: worker-start --agent [--model] [--effort]; permissionMode must
  // be a posture Orca itself manages (allowlisted in the policy).
  assertAllowlisted('model', choice.model, policy.models);
  assertAllowlisted('permissionMode', choice.permissionMode, policy.permissionModes);
  if (choice.effort !== undefined && policy.effortValues !== undefined) {
    assertAllowlisted('effort', choice.effort, policy.effortValues);
  }
  return { kind: 'agent', agent: choice.agent, model: choice.model, effort: choice.effort };
}

function describeLaunchFailure(started: PhaseWorkerStart): string {
  const stage = started.failedStage ? ` stage=${started.failedStage}` : '';
  const err = started.error ? ` ${started.error.code}: ${started.error.message}` : '';
  return `launch ${started.outcome}${stage}${err}`.slice(0, 512);
}

/**
 * Map an Orca dispatch record to contract liveness. Field names are read
 * tolerantly; ambiguity collapses to 'unverifiable', never a guessed state.
 *
 * Only an explicit logical verdict (DECISIVE_OUTCOMES in `outcome`/`state`)
 * proves the Task finished: a retained session survives its Task and keeps
 * reporting live/idle/wait-menu liveness after the dispatch settled
 * (verified 1.4.261: state 'succeeded', stage 'settled', liveness
 * 'unverifiable', terminalState 'retained'). Physical death, released
 * resources, and verdict-less 'settled'/'done' markers are NOT completion
 * proof — claiming 'finished' on them would let the engine record a
 * guessed success. Contradictory verdicts are unverifiable, not a coin flip.
 */
export function mapLiveness(rec: Record<string, unknown>): WorkerLiveness {
  const outcome = firstString(rec.outcome, asRecord(rec.result)?.outcome);
  const liveness = firstString(rec.liveness);
  const state = firstString(rec.state);
  const stage = firstString(rec.stage);
  const terminalState = firstString(rec.terminalState);
  const wait = firstString(
    rec.waitReason,
    rec.blockedOn,
    rec.waitingOnHuman,
    asRecord(rec.wait)?.reason,
  );

  const { verdict, conflict } = dispatchVerdict(rec);
  if (verdict !== undefined) return 'finished';
  if (conflict !== undefined) return 'unverifiable';
  // End-of-life signals without a verdict: the session died, was released,
  // or a settled/done marker fired — the Task outcome is unproven, and it is
  // certainly not 'idle' (nothing is parked to resume).
  if (
    liveness === 'dead' ||
    liveness === 'exited' ||
    terminalState === 'released' ||
    terminalState === 'release_pending' ||
    terminalState === 'release_unknown' ||
    stage === 'settled' ||
    stage === 'done'
  ) {
    return 'unverifiable';
  }
  if (wait !== undefined && /permission|approval|human|input|gate/i.test(wait)) {
    return 'waiting_human';
  }
  if (
    outcome === 'in_progress' ||
    liveness === 'live' ||
    state === 'dispatched' ||
    state === 'working' ||
    state === 'in_progress' ||
    state === 'running' ||
    stage === 'dispatched' ||
    stage === 'active' ||
    stage === 'working' ||
    stage === 'in_progress' ||
    stage === 'running'
  ) {
    return 'working';
  }
  if (
    liveness === 'idle' ||
    state === 'idle' ||
    terminalState === 'retained' ||
    terminalState === 'reclaimable'
  ) {
    return 'idle';
  }
  return 'unverifiable';
}

/**
 * Collect every explicit state-like marker on a receipt. Each one is a
 * signed vote: `positive` when it equals a `positives` value; `negative`
 * when `negatives` is omitted (any other explicit value is a veto) or when
 * it is listed (a definitive negative); `unfamiliar` when `negatives` is
 * given and the value matches neither vocabulary — an unfamiliar state can
 * never prove either side, but it does veto positive confirmation.
 */
function markerVotes(
  v: Record<string, unknown>,
  fields: readonly (string | readonly string[])[],
  positives: readonly string[],
  negatives?: readonly string[],
): { positive: boolean; negative: boolean; unfamiliar: boolean } {
  let positive = false;
  let negative = false;
  let unfamiliar = false;
  const pos = new Set(positives);
  const neg = negatives === undefined ? undefined : new Set(negatives);
  for (const f of fields) {
    // A tuple is a nested path (['terminal','state'] → v.terminal.state).
    let cur: unknown = v;
    const path = typeof f === 'string' ? [f] : f;
    for (const k of path) cur = asRecord(cur)?.[k];
    const s = firstString(cur);
    if (s === undefined) continue;
    if (pos.has(s)) positive = true;
    else if (neg === undefined || neg.has(s)) negative = true;
    else unfamiliar = true;
  }
  return { positive, negative, unfamiliar };
}

/**
 * Confirmed retention needs UNAMBIGUOUS positive proof in a worker-keep-open
 * receipt: kept:true / keptOpen:true or a 'retained'/'kept' state, with no
 * contradicting marker. {kept:true, state:'released'} or
 * {kept:false, state:'retained'} stay unconfirmed.
 */
function keepOpenConfirmed(receipt: unknown): boolean {
  const v = asRecord(receipt);
  if (v === undefined) return false;
  const { positive, negative, unfamiliar } = markerVotes(
    v,
    ['state', 'status', 'terminalState', ['terminal', 'state']],
    ['retained', 'kept'],
  );
  return (
    (positive || v.kept === true || v.keptOpen === true) &&
    !negative &&
    !unfamiliar &&
    v.kept !== false &&
    v.keptOpen !== false
  );
}

/**
 * Explicit release proof in a worker-release receipt: released:true or a
 * 'released' state/terminalState/status, with no contradicting marker.
 * Anything else — 'retained', 'release_pending', 'release_unknown',
 * 'refused', a mixed receipt, or a shape this adapter does not recognize —
 * must not imply released.
 */
function releaseConfirmed(receipt: unknown): boolean {
  const v = asRecord(receipt);
  if (v === undefined) return false;
  const { positive, negative } = markerVotes(
    v,
    ['state', 'status', 'terminalState', ['terminal', 'state']],
    ['released'],
  );
  return (positive || v.released === true) && !negative && v.released !== false;
}

/**
 * Definitive non-stopped states on a worker-stop receipt: a still-surviving
 * or already-ended dispatch means the stop did not apply → 'refused'.
 * Values outside this vocabulary (pending, stop_unknown, novel states) are
 * NOT a refusal — they stay 'unknown'.
 */
const STOP_REFUSED_STATES = new Set([
  'in_progress',
  'working',
  'running',
  'dispatched',
  'ready',
  'live',
  'active',
  'retained',
  'reclaimable',
  'idle',
  'succeeded',
  'failed',
  'cancelled',
  'abandoned',
  'settled',
  'done',
  'released',
  'refused',
]);

/**
 * Conservative worker-stop receipt mapping (recovery-and-cleanup: claim
 * cancellation only on a confirmed stopped result). UNAMBIGUOUS stopped
 * proof across every state-like field (state, status, worker.state) →
 * 'stopped'; a definitive surviving/ended state, stopped:false, or
 * refused:true → 'refused'; contradictory markers, unfamiliar/pending
 * states, or an unrecognized envelope → 'unknown'.
 */
function mapStopReceipt(receipt: unknown): StopOutcome {
  const v = asRecord(receipt);
  if (v === undefined) return 'unknown';
  const { positive, negative, unfamiliar } = markerVotes(
    v,
    ['state', 'status', ['worker', 'state']],
    ['stopped'],
    [...STOP_REFUSED_STATES],
  );
  const positiveStop = positive || v.stopped === true;
  const negativeStop = negative || v.stopped === false || v.refused === true;
  if (positiveStop) return negativeStop || unfamiliar ? 'unknown' : 'stopped';
  if (unfamiliar) return 'unknown';
  if (negativeStop) return 'refused';
  return 'unknown';
}

/** Validate a mail target like "dispatch:ctx_…", "run:run_…", or a raw term_/orca_ handle. */
export function parseMailTarget(to: string): { kind: string; id: string } {
  const i = to.indexOf(':');
  if (i > 0) {
    const kind = to.slice(0, i);
    const id = to.slice(i + 1);
    if (!/^(dispatch|run|task|agent|worker|orca_session_id|session)$/.test(kind)) {
      throw new OrcaAdapterError(
        'bad_mail_target',
        `unknown mailbox kind ${JSON.stringify(kind)}`,
      );
    }
    return { kind, id: assertSafeValue('mail target id', id) };
  }
  if (!/^(term_|orca_)/.test(to)) {
    throw new OrcaAdapterError(
      'bad_mail_target',
      `mail target must be "<kind>:<id>" or a term_/orca_ handle, got ${JSON.stringify(to)}`,
    );
  }
  return { kind: 'terminal', id: assertSafeValue('mail target id', to) };
}
