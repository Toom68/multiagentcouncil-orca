/**
 * Run-local progress notifications for Multiagent Council.
 *
 * The initiating primary orchestrator is woken at every council lifecycle
 * milestone (stage entry, approval, blocker, failure, cancel, completion) by
 * the engine calling {@link ProgressNotifier.notify} after durable state
 * transitions, and during long silent stages by a bounded run-local timer
 * helper emitting deduplicated heartbeats.
 *
 * Design rules (user amendment, NEXT-RELEASE-PLAN.md):
 *
 * - Every wake conveys persisted facts only: run status, durable counts,
 *   elapsed/stage age, next action, report paths. A notification NEVER claims
 *   worker or host liveness it did not verify; a dead helper is visible as
 *   stale diagnostics, never as guaranteed delivery.
 * - The recipient is captured once by the operator BEFORE any binding
 *   mutation ({@link captureRecipient}), preferring the durable parent Run
 *   target over a terminal handle. Self/child targets (the council's own Run,
 *   supervisor terminal or council dispatches) are rejected at capture and
 *   re-validated at every send.
 * - Delivery custody is journal-first, inside `progress/` and fully separate
 *   from the engine Store: intent + budget are persisted BEFORE the host
 *   send; `unknown`/in-flight outcomes are never resent; only a proven
 *   no-effects refusal (details.uncertain === false) may retry once.
 * - The helper is argv-spawned, singleton via a nonce lease, finite in
 *   lifetime and message count, reads state.json/journal only (no worker or
 *   status polling), exits on terminal council state, and is never a daemon,
 *   a provider job, or an agent.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CouncilError,
  CouncilState,
  Result,
  RunStatus,
} from './contracts.js';
import { createOrcaAdapter, parseMailTarget } from './host/orca.js';

// ─── Errors ─────────────────────────────────────────────────────────────────

const err = (
  code: CouncilError['code'],
  message: string,
  details?: Record<string, unknown>,
): CouncilError => ({ code, message, ...(details === undefined ? {} : { details }) });

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = <T>(error: CouncilError): Result<T> => ({ ok: false, error });

// ─── Layout ─────────────────────────────────────────────────────────────────

/** Everything this module owns lives under <runDir>/progress/. */
export const PROGRESS_DIR = 'progress';
export const RECIPIENT_FILE = 'progress/recipient.json';
export const OUTBOX_FILE = 'progress/outbox.json';
/**
 * Prior-use witness: written once after the first durable outbox write.
 * Its presence with a MISSING outbox proves the custody file was deleted
 * post-use — readOutbox then fails closed instead of resetting counters.
 * It cannot prove same-UID authorship or defend a hostile restore; it only
 * distinguishes "never used" from "used, then removed".
 */
export const OUTBOX_WITNESS_FILE = 'progress/outbox.init';
export const OUTBOX_LOCK = 'progress/outbox.lock';
export const HELPER_LEASE_FILE = 'progress/helper.lease';
export const HELPER_STATE_FILE = 'progress/helper.json';

// ─── Public types ───────────────────────────────────────────────────────────

export type ProgressRecipientSource = 'explicit' | 'caller_run' | 'caller_terminal';

/** Durable notify target. First capture wins unless an explicit override. */
export interface ProgressRecipient {
  schemaVersion: 1;
  /** Mail target: "run:<id>" | "dispatch:<id>" | "term_…" | other valid form. */
  to: string;
  source: ProgressRecipientSource;
  recordedAt: string; // ISO-8601
  /**
   * Audit trail: later caller evidence that disagreed with the kept target.
   * Bounded; informational only.
   */
  observations?: { to: string; source: ProgressRecipientSource; at: string; kept: string }[];
}

/** Evidence the caller (operator CLI) supplies — never read from env here. */
export interface RecipientCaptureInput {
  runDir: string;
  /** Explicit target (e.g. a --notify flag). Always wins when valid. */
  to?: string;
  /** Caller's terminal handle (ORCA_TERMINAL_HANDLE), if any. */
  callerHandle?: string;
  /** Caller's bound Run BEFORE any binding mutation, if known. */
  callerRunId?: string | null;
  /** Identities a recipient must never resolve to. */
  self?: {
    orcaRunId?: string | null;
    supervisorHandle?: string | null;
    councilDispatchIds?: readonly string[];
  };
  now?: Date;
}

export interface ProgressRecipientResult {
  recipient: ProgressRecipient;
  /** True when the file changed (first capture, upgrade, explicit override). */
  changed: boolean;
}

/**
 * Marker for an event replayed from durable journal history (engine P-D4
 * catch-up): labels the body as recovered/late and derives the next-action
 * line from CURRENT persisted state — a historical blocker/approval may
 * already be resolved. NEVER changes intentId, dedupe, or budget; it DOES
 * bypass terminal suppression so a terminal resume can still backfill a
 * lost stage/approval/blocked wake (heartbeat/helper_expired have no
 * historical flag and stay suppressed at terminal).
 */
interface ProgressHistorical {
  historical?: boolean;
}

export type ProgressEvent =
  | ({
      kind: 'stage';
      status: RunStatus;
      note?: string;
      /**
       * Explicit discussion cursor for the intent key (engine replays a
       * journal phase.entered with its original {round,stage}); absent
       * falls back to current facts. Used only for status 'discussing'.
       */
      cursor?: { round: number; stage: string };
    } & ProgressHistorical)
  | ({ kind: 'blocked'; reason: string; note?: string } & ProgressHistorical)
  | ({
      kind: 'finished';
      outcome: 'succeeded' | 'failed' | 'cancelled';
      reportPaths?: string[];
      note?: string;
    } & ProgressHistorical)
  | ({
      kind: 'approval';
      approver?: string;
      /**
       * Explicit approval hash for the `approval:<hash8>` intent id; absent
       * falls back to current facts.approvalHash.
       */
      approvalHash?: string;
      note?: string;
    } & ProgressHistorical)
  | {
      kind: 'heartbeat';
      note?: string;
      /** Helper bounds advertised honestly in the heartbeat body. */
      helper?: {
        tick: number;
        intervalMs: number;
        lifetimeRemainingMs: number | null;
        budgetRemaining: number;
      };
    }
  | { kind: 'helper_expired'; reason: string; note?: string };

const isHistoricalReplay = (event: ProgressEvent): boolean =>
  (event.kind === 'stage' ||
    event.kind === 'blocked' ||
    event.kind === 'approval' ||
    event.kind === 'finished') &&
  event.historical === true;

export type ProgressKind =
  | 'stage'
  | 'blocked'
  | 'finished'
  | 'approval'
  | 'heartbeat'
  | 'helper_expired';

export type DeliveryState =
  | 'sending' // intent persisted, host call in flight or crashed — possibly landed
  | 'sent'
  | 'unknown' // host outcome unproven — retained, NEVER resent
  | 'refused' // proven no-effects refusal — eligible for one retry
  | 'refused_final' // refused again after the retry allowance
  | 'invalid_recipient'; // recipient rejected at send-time revalidation

export interface ProgressDelivery {
  intentId: string;
  kind: ProgressKind;
  stageKey: string;
  subject: string;
  body: string;
  recipient: string;
  createdAt: string;
  attempts: number;
  delivery: DeliveryState;
  lastAttemptAt?: string;
  sentAt?: string;
  requestId?: string;
  messageId?: string;
  detail?: string;
}

export interface ProgressOutbox {
  schemaVersion: 1;
  runId: string | null;
  /** Sends charged at intent persist — crash/unknown/error all count. */
  counters: { stage: number; heartbeat: number; budgetRefusals: number };
  deliveries: ProgressDelivery[];
}

export interface ProgressBudget {
  /** Max sends of stage/blocked/finished/approval/helper_expired kinds. */
  stageMax: number;
  /** Max heartbeat sends for the whole run, across all helper generations. */
  heartbeatMax: number;
}

export const DEFAULT_PROGRESS_BUDGET: ProgressBudget = { stageMax: 48, heartbeatMax: 90 };
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 120_000;
export const DEFAULT_HELPER_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_SEND_TIMEOUT_MS = 30_000;

export interface ProgressSendMailInput {
  to: string;
  subject: string;
  body: string;
  taskId?: string;
  dispatchId?: string;
}

/** Same contract as HostAdapter.sendNotification. */
export type ProgressSendMail = (
  input: ProgressSendMailInput,
) => Promise<Result<{ outcome: 'sent' | 'unknown'; requestId?: string; messageId?: string }>>;

/** Persisted state reader — engine injects store.loadState; default reads state.json. */
export type ProgressReadState = () => Promise<Result<CouncilState>>;

export interface ProgressDeps {
  runDir: string;
  sendMail: ProgressSendMail;
  now?: () => Date;
  readState?: ProgressReadState;
  /** Hard bound on one send; on expiry the intent is marked unknown. */
  sendTimeoutMs?: number;
  budget?: Partial<ProgressBudget>;
  /** Heartbeat dedupe window; the helper's tick interval uses the same. */
  heartbeatIntervalMs?: number;
  /** Injectable for tests: acquire/release are normally real file ops. */
  lockWaitMs?: number;
  /**
   * Test seam for the directory fsync after durable writes (observes
   * ordering, injects failures). Default: real fsync; unsupported-platform
   * errors are tolerated, others fail the write closed.
   */
  fsyncDir?: (dir: string) => Promise<void>;
}

export type ProgressNotifyOutcome =
  | 'sent'
  | 'deduped'
  | 'unknown'
  | 'refused'
  | 'refused_final'
  | 'error'
  | 'budget_refused'
  | 'no_recipient'
  | 'invalid_recipient'
  | 'skipped_terminal'
  | 'skipped_no_state';

export interface ProgressNotifyResult {
  outcome: ProgressNotifyOutcome;
  intentId?: string;
  delivery?: DeliveryState;
  requestId?: string;
  messageId?: string;
  detail?: string;
}

export interface ProgressNotifier {
  /**
   * Fire-and-record one milestone. Never throws; returns the send outcome so
   * the caller may journal it. Safe to call after every durable transition —
   * repeats of the same milestone dedupe durably.
   */
  notify(event: ProgressEvent): Promise<Result<ProgressNotifyResult>>;
}

export type HelperEnsureState =
  | 'started'
  | 'already_running'
  | 'skipped_terminal'
  | 'skipped_no_state'
  | 'no_recipient'
  | 'spawn_failed'
  | 'error';

export interface HelperEnsureResult {
  state: HelperEnsureState;
  pid?: number;
  nonce?: string;
  detail?: string;
}

export interface HelperOptions {
  intervalMs?: number;
  maxLifetimeMs?: number;
  sendTimeoutMs?: number;
}

export interface HelperEnsureDeps {
  runDir: string;
  now?: () => Date;
  helper?: HelperOptions;
  /** Injectable child spawn — default: detached argv node child. */
  spawnFn?: (plan: { file: string; args: string[] }) => Result<{ pid: number }>;
  lockWaitMs?: number;
  /** Test seam — directory fsync after the durable lease write. */
  fsyncDir?: (dir: string) => Promise<void>;
}

export interface HelperStatusView {
  state: 'running' | 'starting' | 'stale' | 'dead' | 'exited' | 'none';
  pid?: number;
  nonce?: string;
  startedAt?: string;
  lastTickAt?: string;
  expiresAt?: string;
  lastSendOutcome?: string;
  exitReason?: string;
  detail?: string;
}

export interface ProgressStatusView {
  recipient: ProgressRecipient | null;
  budget: ProgressBudget & { stageUsed: number; heartbeatUsed: number; budgetRefusals: number };
  deliveries: { total: number; sent: number; unknown: number; refused: number; sending: number };
  lastDelivery: ProgressDelivery | null;
  helper: HelperStatusView;
  runStatus: string | null;
  /**
   * 'ok' = the outbox custody file parsed cleanly; 'unavailable' = it is
   * corrupt, unreadable, or missing-after-use — the counts above are then
   * placeholders, NEVER evidence of zero sends.
   */
  outboxState: 'ok' | 'unavailable';
  outboxError?: string;
}

// ─── Small utilities ────────────────────────────────────────────────────────

const iso = (d: Date): string => d.toISOString();
const sha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

const asRec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['reported', 'failed', 'cancelled']);

const describeErr = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function pidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return null; // EPERM or anything else: unverifiable
  }
}

async function readJsonFile(abs: string): Promise<Result<unknown>> {
  try {
    const text = await fsp.readFile(abs, 'utf8');
    return ok(JSON.parse(text) as unknown);
  } catch (e) {
    return failRes(
      err('io_error', `cannot read ${abs}: ${describeErr(e)}`, {
        fsCode: (e as NodeJS.ErrnoException).code,
      }),
    );
  }
}

/** fsync a directory so a rename/create inside it is durable post-crash. */
const defaultFsyncDir = async (dir: string): Promise<void> => {
  const fh = await fsp.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
};

/** Platforms that cannot fsync a directory report one of these — tolerated. */
const isUnsupportedDirSync = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'ENOTSUP' || code === 'EINVAL' || code === 'EPERM' || code === 'EISDIR' || code === 'EBADF';
};

/**
 * Durable JSON write: tmp file → fsync file → rename → fsync directory.
 * The file fsync protects the CONTENT; the directory fsync protects the
 * NAME (the rename itself is only a page-cache entry until synced).
 * A dir-fsync error on a platform that supports it makes the write fail
 * closed — an unjournaled send/spawn must never ride on unproven storage.
 */
async function atomicWriteJson(
  abs: string,
  value: unknown,
  fsyncDir: (dir: string) => Promise<void> = defaultFsyncDir,
): Promise<Result<void>> {
  const tmp = `${abs}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, abs);
    try {
      await fsyncDir(path.dirname(abs));
    } catch (e) {
      if (!isUnsupportedDirSync(e)) throw e;
    }
    return ok(undefined);
  } catch (e) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* tmp may not exist */
    }
    return failRes(err('io_error', `atomic write failed for ${abs}: ${describeErr(e)}`));
  }
}

// ─── Progress lock (separate from Store.withLock — never shared) ────────────

interface LockOwner {
  pid: number;
  nonce: string;
  createdAt: string;
  expiresAt: string;
}

const LOCK_LEASE_MS = 30_000;

/**
 * Serialize outbox/recipient/lease mutations inside progress/ with an O_EXCL
 * lock file. Stale reclaim requires BOTH an expired lease AND a verifiably
 * dead owner pid (or an owner record we can prove is ours-by-nonce); pid age
 * alone never authorizes reclaim, and an unverifiable owner keeps the lock.
 */
async function withProgressLock<T>(
  runDir: string,
  waitMs: number,
  now: () => Date,
  fn: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const lockPath = path.join(runDir, OUTBOX_LOCK);
  const nonce = randomUUID();
  const deadline = Date.now() + waitMs;
  try {
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  } catch (e) {
    return failRes(err('io_error', `cannot create progress dir: ${describeErr(e)}`));
  }

  for (;;) {
    try {
      const fh = await fsp.open(lockPath, 'wx');
      const owner: LockOwner = {
        pid: process.pid,
        nonce,
        createdAt: iso(now()),
        expiresAt: new Date(Date.now() + LOCK_LEASE_MS).toISOString(),
      };
      try {
        await fh.writeFile(JSON.stringify(owner));
      } finally {
        await fh.close();
      }
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        return failRes(err('io_error', `cannot create progress lock: ${describeErr(e)}`));
      }
    }

    // Lock exists: inspect owner before deciding anything.
    let owner: LockOwner | null = null;
    let raw: string | null = null;
    try {
      raw = await fsp.readFile(lockPath, 'utf8');
      const parsed = asRec(JSON.parse(raw));
      if (
        parsed !== undefined &&
        typeof parsed.pid === 'number' &&
        typeof parsed.nonce === 'string' &&
        typeof parsed.expiresAt === 'string'
      ) {
        owner = parsed as unknown as LockOwner;
      }
    } catch {
      /* unreadable/corrupt — treated as unknown owner */
    }

    const expired = owner === null || Date.parse(owner.expiresAt) <= Date.now();
    const dead = owner !== null && pidAlive(owner.pid) === false;
    if (expired && (owner === null || dead)) {
      // Guarded reclaim: only remove the exact bytes we observed.
      try {
        const again = await fsp.readFile(lockPath, 'utf8');
        if (again === raw) await fsp.unlink(lockPath);
      } catch {
        /* already gone — loop retries */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      return failRes(
        err(
          'io_error',
          `timed out waiting for progress lock held by ${
            owner ? `pid ${owner.pid} (since ${owner.createdAt})` : 'unreadable owner'
          }`,
          { reason: 'progress_lock_timeout' },
        ),
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  try {
    return await fn();
  } finally {
    try {
      const raw = await fsp.readFile(lockPath, 'utf8');
      const parsed = asRec(JSON.parse(raw));
      if (parsed?.nonce === nonce) await fsp.unlink(lockPath);
    } catch {
      /* lock already gone */
    }
  }
}

// ─── Tolerant persisted-file readers ────────────────────────────────────────

/**
 * Deep enough shape check for everything deriveFacts reads — runId/status
 * plus the nested subtrees (participants[], consumption, config.deadlines,
 * config.maxLaunches) whose absence used to TypeError mid-derivation
 * (audit P-D1). A parseable-but-incomplete state is rejected EXACTLY like
 * an unparseable one: unreadable facts, unknown counts, wakes still send.
 */
function stateShapeOk(v: unknown): v is CouncilState {
  const s = asRec(v);
  if (s === undefined) return false;
  if (typeof s.runId !== 'string' || typeof s.status !== 'string') return false;
  if (!Array.isArray(s.participants)) return false;
  const consumption = asRec(s.consumption);
  if (consumption === undefined || typeof consumption.launches !== 'number') return false;
  const config = asRec(s.config);
  if (config === undefined || typeof config.maxLaunches !== 'number') return false;
  if (asRec(config.deadlines) === undefined) return false;
  return true;
}

function fileReadState(runDir: string): ProgressReadState {
  return async () => {
    const r = await readJsonFile(path.join(runDir, 'state.json'));
    if (!r.ok) return r as Result<never>;
    if (!stateShapeOk(r.value)) {
      return failRes(
        err('schema_invalid', 'state.json is not a recognizable CouncilState', {
          reason: 'progress_state_malformed',
        }),
      );
    }
    return ok(r.value);
  };
}

async function readJournalTailTs(runDir: string): Promise<string | null> {
  try {
    const text = await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    const lines = text.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && i > lines.length - 50; i--) {
      try {
        const ev = asRec(JSON.parse(lines[i]));
        const ts = asStr(ev?.ts);
        if (ts !== undefined) return ts;
      } catch {
        /* keep scanning older lines */
      }
    }
  } catch {
    /* journal absent/unreadable — caller reports unknown age */
  }
  return null;
}

// ─── Recipient capture & validation ─────────────────────────────────────────

function mailTargetKind(to: string): { kind: string; id: string } | null {
  try {
    return parseMailTarget(to);
  } catch {
    return null;
  }
}

function recipientSelfViolation(
  to: string,
  self: RecipientCaptureInput['self'],
): string | null {
  if (self === undefined) return null;
  const parsed = mailTargetKind(to);
  if (parsed === null) return `unparseable target ${JSON.stringify(to)}`;
  if (parsed.kind === 'run' && self.orcaRunId != null && parsed.id === self.orcaRunId) {
    return `target is the council's own child Run ${parsed.id}`;
  }
  if (parsed.kind === 'terminal' && self.supervisorHandle != null && parsed.id === self.supervisorHandle) {
    return `target is the council supervisor terminal ${parsed.id}`;
  }
  if (
    parsed.kind === 'dispatch' &&
    self.councilDispatchIds !== undefined &&
    self.councilDispatchIds.includes(parsed.id)
  ) {
    return `target is a council-owned dispatch ${parsed.id}`;
  }
  return null;
}

function resolveTarget(input: RecipientCaptureInput): Result<{ to: string; source: ProgressRecipientSource }> {
  if (input.to !== undefined) {
    if (mailTargetKind(input.to) === null) {
      return failRes(
        err('config_invalid', `explicit notify target is not a valid mail target: ${JSON.stringify(input.to)}`),
      );
    }
    return ok({ to: input.to, source: 'explicit' });
  }
  if (input.callerRunId != null && input.callerRunId.length > 0) {
    // Same mail-target validation as the explicit/handle paths (audit P-D3):
    // a malformed caller run id must fail at capture, never persist a
    // target every send would refuse as invalid_recipient forever.
    const to = `run:${input.callerRunId}`;
    if (mailTargetKind(to) === null) {
      return failRes(
        err('config_invalid', `caller run id is not a valid mail target: ${JSON.stringify(input.callerRunId)}`),
      );
    }
    return ok({ to, source: 'caller_run' });
  }
  if (input.callerHandle !== undefined && input.callerHandle.length > 0) {
    if (mailTargetKind(input.callerHandle) === null) {
      return failRes(
        err('config_invalid', `caller terminal handle is not a valid mail target: ${JSON.stringify(input.callerHandle)}`),
      );
    }
    return ok({ to: input.callerHandle, source: 'caller_terminal' });
  }
  return failRes(
    err('config_invalid', 'no notify recipient could be resolved — pass an explicit target, callerRunId or callerHandle', {
      reason: 'no_recipient_evidence',
    }),
  );
}

/**
 * Capture the initiating orchestrator's notify target durably — call at init
 * and start-supervisor BEFORE any binding mutation. Serialized under the
 * progress lock so concurrent captures cannot race. First durable target
 * wins; a captured terminal is upgraded once to a caller Run when a later
 * capture supplies one; only an explicit `to` overrides thereafter.
 */
export async function captureRecipient(
  input: RecipientCaptureInput,
): Promise<Result<ProgressRecipientResult>> {
  const now = () => input.now ?? new Date();
  const resolved = resolveTarget(input);
  const abs = path.join(input.runDir, RECIPIENT_FILE);

  return withProgressLock(input.runDir, 8_000, now, async () => {
    const existingR = await readJsonFile(abs);
    const existing = existingR.ok ? parseRecipient(existingR.value) : null;

    if (!resolved.ok) {
      // No usable evidence: keep whatever is recorded rather than clobber.
      if (existing !== null) return ok({ recipient: existing, changed: false });
      return resolved as Result<never>;
    }
    const cand = resolved.value;
    const violation = recipientSelfViolation(cand.to, input.self);
    if (violation !== null) {
      return failRes(
        err('config_invalid', `refusing notify recipient: ${violation}`, {
          reason: 'recipient_is_self',
          target: cand.to,
        }),
      );
    }

    if (existing !== null) {
      if (cand.source !== 'explicit') {
        if (existing.source === 'caller_terminal' && cand.source === 'caller_run' && existing.to !== cand.to) {
          // Upgrade a weaker handle capture to the durable parent Run once.
          const upgraded: ProgressRecipient = {
            ...existing,
            to: cand.to,
            source: 'caller_run',
            observations: [
              ...(existing.observations ?? []),
              { to: existing.to, source: existing.source, at: existing.recordedAt, kept: cand.to },
            ].slice(-8),
          };
          const w = await atomicWriteJson(abs, upgraded);
          if (!w.ok) return w as Result<never>;
          return ok({ recipient: upgraded, changed: true });
        }
        if (existing.to !== cand.to) {
          const obs = [
            ...(existing.observations ?? []),
            { to: cand.to, source: cand.source, at: iso(now()), kept: existing.to },
          ].slice(-8);
          const kept: ProgressRecipient = { ...existing, observations: obs };
          const w = await atomicWriteJson(abs, kept);
          if (!w.ok) return w as Result<never>;
          return ok({ recipient: kept, changed: false });
        }
        return ok({ recipient: existing, changed: false });
      }
      // Explicit override — deliberate operator invocation only.
      if (existing.to === cand.to && existing.source === 'explicit') {
        return ok({ recipient: existing, changed: false });
      }
      const next: ProgressRecipient = {
        schemaVersion: 1,
        to: cand.to,
        source: 'explicit',
        recordedAt: iso(now()),
        observations: [
          ...(existing.observations ?? []),
          { to: existing.to, source: existing.source, at: existing.recordedAt, kept: cand.to },
        ].slice(-8),
      };
      const w = await atomicWriteJson(abs, next);
      if (!w.ok) return w as Result<never>;
      return ok({ recipient: next, changed: true });
    }

    const fresh: ProgressRecipient = {
      schemaVersion: 1,
      to: cand.to,
      source: cand.source,
      recordedAt: iso(now()),
    };
    const w = await atomicWriteJson(abs, fresh);
    if (!w.ok) return w as Result<never>;
    return ok({ recipient: fresh, changed: true });
  });
}

function parseRecipient(v: unknown): ProgressRecipient | null {
  const r = asRec(v);
  if (r === undefined) return null;
  const to = asStr(r.to);
  const source = asStr(r.source);
  const recordedAt = asStr(r.recordedAt);
  if (to === undefined || recordedAt === undefined) return null;
  if (source !== 'explicit' && source !== 'caller_run' && source !== 'caller_terminal') return null;
  const observations = Array.isArray(r.observations)
    ? (r.observations.filter((o) => asRec(o) !== undefined) as ProgressRecipient['observations'])
    : undefined;
  return { schemaVersion: 1, to, source, recordedAt, ...(observations === undefined ? {} : { observations }) };
}

/** Read-only load of the persisted recipient (null when absent/malformed). */
export async function loadRecipient(runDir: string): Promise<Result<ProgressRecipient | null>> {
  const r = await readJsonFile(path.join(runDir, RECIPIENT_FILE));
  if (!r.ok) {
    // Absent file is a clean "unconfigured"; other read errors surface.
    if (r.error.details?.fsCode === 'ENOENT') return ok(null);
    return failRes(r.error);
  }
  return ok(parseRecipient(r.value));
}

// ─── Facts: persisted counts for message bodies ─────────────────────────────

interface RunFacts {
  runId: string;
  status: RunStatus | 'unreadable';
  discussion: { round: number; stage: string } | null;
  participantsByStatus: Record<string, number>;
  reviewers: { total: number; settled: number; failed: number; working: number; planned: number };
  phaseAttempts: { phase: string; round: number | null; settled: number; total: number } | null;
  launches: { used: number; cap: number };
  mailSent: number;
  createdAt: string | null;
  phaseEnteredAt: string | null;
  approvalHash: string | null;
  orcaRunId: string | null;
  supervisorHandle: string | null;
  councilDispatchIds: string[];
  runDeadlineMs: number | null;
  stageDeadlineMs: number | null;
  graceMs: number;
  lastJournalTs: string | null;
}

const ATTEMPT_SETTLED = new Set(['settled_ok', 'settled_failed', 'timed_out', 'stopped']);
const ATTEMPT_PENDING = new Set(['planned', 'intent_recorded', 'dispatched', 'working', 'unknown']);

function statusPhase(
  status: RunStatus,
  cursor: { round: number; stage: string } | null,
): { phase: string; round: number | null } | null {
  switch (status) {
    case 'organising':
      return { phase: 'organiser', round: null };
    case 'independent_review':
      return { phase: 'independent_review', round: null };
    case 'scribe_notes':
      return { phase: 'scribe_notes', round: null };
    case 'discussing':
      return cursor === null
        ? { phase: 'challenge', round: 1 }
        : { phase: cursor.stage === 'responses' ? 'author_response' : 'challenge', round: cursor.round };
    case 'synthesising':
      return { phase: 'scribe_synthesis', round: null };
    default:
      return null;
  }
}

function deriveFacts(state: CouncilState | null, lastJournalTs: string | null): RunFacts {
  const base: RunFacts = {
    runId: state?.runId ?? 'unknown',
    status: state?.status ?? 'unreadable',
    discussion:
      state?.discussion === null || state?.discussion === undefined
        ? null
        : { round: state.discussion.round, stage: state.discussion.stage },
    participantsByStatus: {},
    reviewers: { total: 0, settled: 0, failed: 0, working: 0, planned: 0 },
    phaseAttempts: null,
    launches: { used: state?.consumption.launches ?? 0, cap: state?.config.maxLaunches ?? 0 },
    mailSent: state?.consumption.mailSent ?? 0,
    createdAt: state?.createdAt ?? null,
    phaseEnteredAt: state?.phaseEnteredAt ?? null,
    approvalHash: state?.approvalHash ?? null,
    orcaRunId: state?.orcaRunId ?? null,
    supervisorHandle: state?.supervisor?.terminalHandle ?? null,
    councilDispatchIds: [],
    runDeadlineMs: state?.config.deadlines.runMs ?? null,
    stageDeadlineMs: null,
    graceMs: state?.config.deadlines.graceMs ?? 0,
    lastJournalTs,
  };
  if (state === null) return base;

  const dispatchIds = new Set<string>();
  if (state.supervisor?.dispatchId != null) dispatchIds.add(state.supervisor.dispatchId);
  const byStatus: Record<string, number> = {};
  let phaseAgg: { phase: string; round: number | null; settled: number; total: number } | null = null;
  const cur = statusPhase(state.status, base.discussion);
  for (const p of state.participants) {
    // Per-element defense (audit P-D1): a torn participant/attempt entry is
    // skipped, never allowed to TypeError the whole fact derivation.
    const pr = asRec(p);
    if (pr === undefined) continue;
    const pStatus = asStr(pr.status);
    if (pStatus !== undefined) byStatus[pStatus] = (byStatus[pStatus] ?? 0) + 1;
    if (pr.role === 'reviewer') {
      base.reviewers.total += 1;
      if (pStatus === 'settled') base.reviewers.settled += 1;
      else if (pStatus === 'failed' || pStatus === 'timed_out' || pStatus === 'stopped') {
        base.reviewers.failed += 1;
      } else if (pStatus === 'active') base.reviewers.working += 1;
      else base.reviewers.planned += 1;
    }
    const attempts = Array.isArray(pr.attempts) ? pr.attempts : [];
    for (const a of attempts) {
      const ar = asRec(a);
      if (ar === undefined) continue;
      if (typeof ar.dispatchId === 'string' && ar.dispatchId.length > 0) dispatchIds.add(ar.dispatchId);
      if (cur !== null && ar.phase === cur.phase && ar.round === cur.round) {
        phaseAgg ??= { phase: cur.phase, round: cur.round, settled: 0, total: 0 };
        phaseAgg.total += 1;
        if (ATTEMPT_SETTLED.has(ar.status as string) || (!ATTEMPT_PENDING.has(ar.status as string) && ar.settledAt !== undefined)) {
          phaseAgg.settled += 1;
        }
      }
    }
  }
  base.councilDispatchIds = [...dispatchIds];
  base.participantsByStatus = byStatus;
  base.phaseAttempts = phaseAgg;

  const dl = state.config.deadlines;
  base.stageDeadlineMs =
    state.status === 'organising'
      ? dl.organiserMs
      : state.status === 'independent_review'
        ? dl.independentMs
        : state.status === 'scribe_notes'
          ? dl.scribeNotesMs
          : state.status === 'discussing'
            ? base.discussion?.stage === 'responses'
              ? dl.responseMs
              : dl.challengeMs
            : state.status === 'synthesising'
              ? dl.synthesisMs
              : null;
  return base;
}

// ─── Message building ───────────────────────────────────────────────────────

const STAGE_LABEL: Record<string, string> = {
  initialized: 'run initialized',
  organising: 'organiser stage',
  awaiting_approval: 'awaiting roster approval',
  independent_review: 'independent review stage',
  scribe_notes: 'scribe notes stage',
  discussing: 'discussion stage',
  synthesising: 'synthesis stage',
  reported: 'run reported',
  failed: 'run failed',
  cancelled: 'run cancelled',
};

function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function stageLabel(facts: RunFacts): string {
  if (facts.status === 'discussing' && facts.discussion !== null) {
    return `discussion round ${facts.discussion.round} ${facts.discussion.stage}`;
  }
  return STAGE_LABEL[facts.status] ?? facts.status;
}

function nextActionFor(facts: RunFacts, event: ProgressEvent): string {
  // A historical replay may describe a milestone that is already resolved —
  // its next action must come from CURRENT persisted state alone, never the
  // replayed payload (primary constraint for P-D4 catch-up wakes).
  if (!isHistoricalReplay(event)) {
    if (event.kind === 'blocked') return `resolve blocker: ${event.reason.slice(0, 200)}`;
    if (event.kind === 'approval') return 'approval recorded — the supervisor advances on its next wake';
    if (event.kind === 'finished') {
      return event.outcome === 'succeeded'
        ? 'review the report artifacts listed below'
        : `run ended ${event.outcome} — inspect journal/report paths with \`council status\`/\`tail\``;
    }
  }
  return currentActionFor(facts);
}

function currentActionFor(facts: RunFacts): string {
  switch (facts.status) {
    case 'awaiting_approval':
      return 'approve the exact proposed roster (`council approve`) — no reviewers launch before that gate';
    case 'reported':
      return 'review the report artifacts';
    case 'failed':
    case 'cancelled':
      return 'inspect journal/status for the terminal record';
    case 'initialized':
      return 'launch the supervisor to begin organising';
    case 'organising':
      return 'wait for the organiser to propose a roster for approval';
    default:
      if (facts.approvalHash === null && facts.status !== 'unreadable') {
        return 'approval was invalidated — re-approve the exact roster to resume';
      }
      return 'supervisor advances on its next wake; heartbeats continue while this stage runs';
  }
}

const MAX_BODY_BYTES = 7_500;

/**
 * The milestone a historical stage replay actually names — from the event's
 * own status/cursor, never current facts (the run may have advanced far past
 * it). Engine follow-up finding: labelling replays with the CURRENT stage
 * hid which durable record was recovered.
 */
function replayedStageLabel(event: Extract<ProgressEvent, { kind: 'stage' }>, facts: RunFacts): string {
  if (event.status === 'discussing') {
    const cur =
      event.cursor !== undefined &&
      Number.isInteger(event.cursor.round) &&
      event.cursor.round > 0 &&
      typeof event.cursor.stage === 'string' &&
      event.cursor.stage.length > 0
        ? event.cursor
        : facts.discussion;
    return cur !== null ? `discussion round ${cur.round} ${cur.stage}` : 'discussion stage';
  }
  return STAGE_LABEL[event.status] ?? event.status;
}

function buildMessage(
  facts: RunFacts,
  event: ProgressEvent,
  intentId: string,
  now: Date,
): { subject: string; body: string } {
  const historical = isHistoricalReplay(event);
  const label =
    event.kind === 'blocked'
      ? 'blocked'
      : event.kind === 'finished'
        ? `finished: ${event.outcome}`
        : event.kind === 'approval'
          ? 'approval granted'
          : event.kind === 'heartbeat'
            ? `progress heartbeat — ${stageLabel(facts)}`
            : event.kind === 'helper_expired'
              ? 'progress helper expiring'
              : historical
                ? `replay: ${replayedStageLabel(event, facts)}`
                : stageLabel(facts);

  const subject = `council ${facts.runId}: ${label}`.slice(0, 512);
  const lines: string[] = [`council ${facts.runId} — ${label}`];

  if (historical) {
    lines.push(
      'replay: recovered from persisted journal history — this milestone may predate the current stage and may already be resolved; the counts below are CURRENT facts',
    );
    // Name the durable record being recovered so the recipient can
    // correlate it against outbox intents/journal (native replacement for
    // the engine-side `note` workaround).
    lines.push(`replayed milestone: ${intentId}`);
    if (event.kind === 'blocked') {
      lines.push(`historical blocker evidence (may already be resolved): ${event.reason.slice(0, 200)}`);
    }
  }

  const runAge = facts.createdAt !== null ? now.getTime() - Date.parse(facts.createdAt) : null;
  const stageAge = facts.phaseEnteredAt !== null ? now.getTime() - Date.parse(facts.phaseEnteredAt) : null;
  lines.push(
    `status: ${facts.status}${facts.discussion !== null ? ` r${facts.discussion.round}/${facts.discussion.stage}` : ''}` +
      `${stageAge !== null ? ` (stage age ${fmtDuration(stageAge)}` : ''}` +
      `${runAge !== null ? `${stageAge !== null ? ',' : ' ('} run elapsed ${fmtDuration(runAge)})` : stageAge !== null ? ')' : ''}`,
  );

  if (facts.reviewers.total > 0) {
    const r = facts.reviewers;
    lines.push(`seats: ${r.settled}/${r.total} settled · ${r.working} working · ${r.planned} planned · ${r.failed} failed`);
  }
  if (facts.phaseAttempts !== null) {
    const pa = facts.phaseAttempts;
    lines.push(`phase ${pa.phase}${pa.round !== null ? ` r${pa.round}` : ''}: ${pa.settled}/${pa.total} attempts settled`);
  }
  lines.push(`launches: ${facts.launches.used}/${facts.launches.cap}`);

  if (event.kind === 'heartbeat' && facts.lastJournalTs !== null) {
    lines.push(`last recorded activity: ${fmtDuration(now.getTime() - Date.parse(facts.lastJournalTs))} ago`);
  }

  // Honest stalled-run signal: persisted deadline math, never liveness claims.
  if (facts.stageDeadlineMs !== null && stageAge !== null && stageAge > facts.stageDeadlineMs + facts.graceMs) {
    lines.push(
      `WARNING: stage exceeded its persisted deadline+grace by ${fmtDuration(stageAge - facts.stageDeadlineMs - facts.graceMs)} — ` +
        `the run may be stalled; inspect with \`council status\``,
    );
  }
  if (facts.runDeadlineMs !== null && runAge !== null && runAge > facts.runDeadlineMs + facts.graceMs) {
    lines.push('WARNING: run exceeded its persisted run deadline+grace — inspect with `council status`');
  }

  lines.push(`next: ${nextActionFor(facts, event)}`);

  if (event.kind === 'finished' && event.reportPaths !== undefined && event.reportPaths.length > 0) {
    lines.push(`reports: ${event.reportPaths.join(', ')}`);
  }
  if (event.note !== undefined) lines.push(`note: ${event.note.slice(0, 400)}`);

  if (event.kind === 'heartbeat' && event.helper !== undefined) {
    const hb = event.helper;
    lines.push(
      `helper: tick ${hb.tick} · interval ${Math.round(hb.intervalMs / 1000)}s` +
        `${hb.lifetimeRemainingMs !== null ? ` · ~${fmtDuration(hb.lifetimeRemainingMs)} lifetime left` : ''}` +
        ` · ${hb.budgetRemaining} heartbeat budget left`,
    );
  }
  lines.push('persisted facts only — this update does not verify worker or host liveness');

  let body = lines.join('\n');
  while (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES && lines.length > 3) {
    lines.splice(lines.length - 3, 1);
    body = lines.join('\n');
  }
  return { subject, body };
}

// ─── Outbox ─────────────────────────────────────────────────────────────────

function emptyOutbox(runId: string | null): ProgressOutbox {
  return { schemaVersion: 1, runId, counters: { stage: 0, heartbeat: 0, budgetRefusals: 0 }, deliveries: [] };
}

const DELIVERY_STATES: ReadonlySet<string> = new Set([
  'sending',
  'sent',
  'unknown',
  'refused',
  'refused_final',
  'invalid_recipient',
]);

/**
 * STRICT outbox validation (primary-reproduced HIGH): every field the writer
 * emits must be present and well-typed — a torn-but-parseable file is custody
 * we cannot reason about, exactly like unparseable JSON. A structural
 * anomaly fails closed; the file is NEVER treated as empty.
 */
function parseOutbox(v: unknown, runId: string | null): Result<ProgressOutbox> {
  const fail = (why: string): Result<ProgressOutbox> =>
    failRes(
      err('io_error', `progress outbox is malformed (${why}) — refusing to reset or trust custody; inspect progress/outbox.json`, {
        reason: 'outbox_malformed',
        why,
      }),
    );
  const r = asRec(v);
  if (r === undefined) return fail('not a JSON object');
  if (r.schemaVersion !== 1) return fail('schemaVersion is not 1');
  if (!(typeof r.runId === 'string' || r.runId === null)) return fail('runId is not a string|null');
  const counters = asRec(r.counters);
  if (
    counters === undefined ||
    typeof counters.stage !== 'number' ||
    typeof counters.heartbeat !== 'number' ||
    typeof counters.budgetRefusals !== 'number'
  ) {
    return fail('counters are not {stage,heartbeat,budgetRefusals: number}');
  }
  if (!Array.isArray(r.deliveries)) return fail('deliveries is not an array');
  for (const d of r.deliveries) {
    const dr = asRec(d);
    if (
      dr === undefined ||
      typeof dr.intentId !== 'string' ||
      dr.intentId.length === 0 ||
      typeof dr.delivery !== 'string' ||
      !DELIVERY_STATES.has(dr.delivery) ||
      typeof dr.attempts !== 'number'
    ) {
      return fail('a delivery entry is malformed — dedupe/custody cannot be proven');
    }
  }
  return ok({
    schemaVersion: 1,
    runId: (r.runId as string | null) ?? runId,
    counters: {
      stage: counters.stage as number,
      heartbeat: counters.heartbeat as number,
      budgetRefusals: counters.budgetRefusals as number,
    },
    deliveries: r.deliveries as ProgressDelivery[],
  });
}

/**
 * Read the outbox FAIL-CLOSED: any existing-but-unreadable or malformed file
 * is a visible error — never an empty outbox that would erase counters and
 * authorize re-sends (primary-reproduced HIGH). Only a genuinely ABSENT
 * file may initialize, and then only when no prior-use witness exists; a
 * witness without an outbox means custody was deleted post-use → error.
 */
async function readOutbox(runDir: string, runId: string | null): Promise<Result<ProgressOutbox>> {
  const r = await readJsonFile(path.join(runDir, OUTBOX_FILE));
  if (!r.ok) {
    if (r.error.details?.fsCode !== 'ENOENT') {
      return failRes(
        err('io_error', `progress outbox exists but cannot be read — refusing to reset custody: ${r.error.message}`, {
          reason: 'outbox_unreadable',
          fsCode: r.error.details?.fsCode,
        }),
      );
    }
    // No outbox file: only a true fresh start may initialize. A prior-use
    // witness without an outbox means the custody file was deleted AFTER
    // sends — fail closed, never silently reset (documented limit: the
    // witness proves prior use, not authorship or same-UID integrity).
    const w = await readJsonFile(path.join(runDir, OUTBOX_WITNESS_FILE));
    if (w.ok) {
      return failRes(
        err(
          'io_error',
          'progress outbox is missing but a prior-use witness exists — the custody file was deleted after sends; refusing to reset. Reconcile progress/outbox.json manually.',
          { reason: 'outbox_missing_after_use' },
        ),
      );
    }
    if (w.error.details?.fsCode !== 'ENOENT') {
      return failRes(
        err('io_error', `progress outbox is missing and its prior-use witness is unreadable: ${w.error.message}`, {
          reason: 'outbox_witness_unreadable',
        }),
      );
    }
    return ok(emptyOutbox(runId));
  }
  return parseOutbox(r.value, runId);
}

/**
 * Lay the prior-use witness AFTER a successful outbox write — presence then
 * distinguishes "outbox deleted" from "never used". Best-effort: auxiliary
 * evidence that never blocks a send (its own absence is detected, not
 * assumed). O_EXCL — never overwrites an existing witness.
 */
async function ensureOutboxWitness(
  runDir: string,
  runId: string | null,
  fsyncDir: (dir: string) => Promise<void>,
): Promise<void> {
  const abs = path.join(runDir, OUTBOX_WITNESS_FILE);
  try {
    const fh = await fsp.open(abs, 'wx');
    try {
      await fh.writeFile(
        `${JSON.stringify({ schemaVersion: 1, runId, initializedAt: new Date().toISOString() })}\n`,
      );
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fsyncDir(path.dirname(abs));
    } catch (e) {
      if (!isUnsupportedDirSync(e)) throw e;
    }
  } catch {
    /* exists, or platform cannot — auxiliary evidence only */
  }
}

// ─── Intent id derivation ───────────────────────────────────────────────────

function intentFor(
  event: ProgressEvent,
  facts: RunFacts,
  heartbeatIntervalMs: number,
  now: Date,
): { intentId: string; kind: ProgressKind; stageKey: string } | null {
  switch (event.kind) {
    case 'stage': {
      if (TERMINAL_STATUSES.has(event.status as RunStatus)) {
        // Terminal statuses share the finished intent so a finished() call and
        // a stage call for the same transition can never double-send.
        const outcome =
          event.status === 'reported' ? 'succeeded' : event.status === 'failed' ? 'failed' : 'cancelled';
        return { intentId: `finished:${outcome}`, kind: 'finished', stageKey: `finished:${outcome}` };
      }
      // Engine replays carry their original journal cursor (P-D4): an
      // explicit {round,stage} wins over current facts so a historical r1
      // wake cannot be mis-keyed once state has advanced to r2.
      const replayCursor =
        event.cursor !== undefined &&
        Number.isInteger(event.cursor.round) &&
        event.cursor.round > 0 &&
        typeof event.cursor.stage === 'string' &&
        event.cursor.stage.length > 0
          ? event.cursor
          : facts.discussion;
      const key =
        event.status === 'discussing' && replayCursor !== null
          ? `discussing:r${replayCursor.round}:${replayCursor.stage}`
          : event.status;
      return { intentId: `stage:${key}`, kind: 'stage', stageKey: key };
    }
    case 'blocked':
      return { intentId: `blocked:${sha8(event.reason)}`, kind: 'blocked', stageKey: 'blocked' };
    case 'finished':
      return { intentId: `finished:${event.outcome}`, kind: 'finished', stageKey: `finished:${event.outcome}` };
    case 'approval': {
      const rawHash = event.approvalHash ?? facts.approvalHash;
      const h = rawHash !== null && rawHash.length > 0 ? rawHash.slice(0, 8) : 'unknown';
      return { intentId: `approval:${h}`, kind: 'approval', stageKey: 'approval' };
    }
    case 'heartbeat': {
      const w = Math.floor(now.getTime() / heartbeatIntervalMs);
      return { intentId: `hb:${w}`, kind: 'heartbeat', stageKey: `hb:${w}` };
    }
    case 'helper_expired':
      return { intentId: `helper_expired:${sha8(event.reason)}`, kind: 'helper_expired', stageKey: 'helper_expired' };
  }
}

// ─── Notifier ───────────────────────────────────────────────────────────────

const SEND_BUDGET_KIND: Record<ProgressKind, 'stage' | 'heartbeat'> = {
  stage: 'stage',
  blocked: 'stage',
  finished: 'stage',
  approval: 'stage',
  heartbeat: 'heartbeat',
  helper_expired: 'stage',
};

export function createProgressNotifier(deps: ProgressDeps): ProgressNotifier {
  const now = () => (deps.now !== undefined ? deps.now() : new Date());
  const readState = deps.readState ?? fileReadState(deps.runDir);
  const sendTimeoutMs = deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const budget: ProgressBudget = { ...DEFAULT_PROGRESS_BUDGET, ...(deps.budget ?? {}) };
  const hbInterval = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const lockWaitMs = deps.lockWaitMs ?? 8_000;
  const fsyncDir = deps.fsyncDir ?? defaultFsyncDir;

  const notify = async (event: ProgressEvent): Promise<Result<ProgressNotifyResult>> => {
    try {
      const at = now();
      const stR = await readState();
      // Sanitize ANY state source through the deep shape guard (audit P-D1):
      // a parseable-but-incomplete state degrades to unreadable facts —
      // never a TypeError that kills the wake.
      const state = stR.ok && stateShapeOk(stR.value) ? stR.value : null;
      const journalTs = await readJournalTailTs(deps.runDir).catch(() => null);
      const facts = deriveFacts(state, journalTs);

      // Terminal runs accept only the finished milestone itself — plus
      // bounded engine-origin HISTORICAL catch-up wakes so a terminal resume
      // can still backfill a lost stage/approval/blocked notice (approved
      // P-D4 design). Helper heartbeats stay suppressed; dedupe/budgets
      // apply to replays identically.
      if (
        state !== null &&
        TERMINAL_STATUSES.has(state.status) &&
        event.kind !== 'finished' &&
        !(event.kind === 'stage' && TERMINAL_STATUSES.has(event.status as RunStatus)) &&
        !isHistoricalReplay(event)
      ) {
        return ok({ outcome: 'skipped_terminal' });
      }

      const intent = intentFor(event, facts, hbInterval, at);
      if (intent === null) {
        return failRes(err('config_invalid', 'unrecognizable progress event'));
      }

      // Recipient + self revalidation before any intent is persisted.
      const recR = await loadRecipient(deps.runDir);
      if (!recR.ok) return failRes(recR.error);
      const recipient = recR.value;
      if (recipient === null) {
        return ok({ outcome: 'no_recipient', intentId: intent.intentId });
      }
      const violation = recipientSelfViolation(recipient.to, {
        orcaRunId: facts.orcaRunId,
        supervisorHandle: facts.supervisorHandle,
        councilDispatchIds: facts.councilDispatchIds,
      });
      if (violation !== null) {
        // Persist the refusal once per intent — visible evidence, never sent.
        const recResult = await withProgressLock(deps.runDir, lockWaitMs, now, async () => {
          const boxR = await readOutbox(deps.runDir, facts.runId === 'unknown' ? null : facts.runId);
          if (!boxR.ok) return boxR as Result<never>;
          const box = boxR.value;
          if (box.deliveries.some((d) => d.intentId === intent.intentId)) return ok('recorded' as const);
          box.deliveries.push({
            intentId: intent.intentId,
            kind: intent.kind,
            stageKey: intent.stageKey,
            subject: '',
            body: '',
            recipient: recipient.to,
            createdAt: iso(at),
            attempts: 0,
            delivery: 'invalid_recipient',
            detail: violation,
          });
          const w = await atomicWriteJson(path.join(deps.runDir, OUTBOX_FILE), box, fsyncDir);
          if (!w.ok) return w as Result<never>;
          await ensureOutboxWitness(deps.runDir, box.runId, fsyncDir);
          return ok('recorded' as const);
        });
        void recResult;
        return ok({ outcome: 'invalid_recipient', intentId: intent.intentId, detail: violation });
      }

      const { subject, body } = buildMessage(facts, event, intent.intentId, at);
      const outboxPath = path.join(deps.runDir, OUTBOX_FILE);
      const budgetKind = SEND_BUDGET_KIND[intent.kind];

      // ── Phase 1 (locked): dedupe check, budget charge, persist intent ──
      type Prep =
        | { action: 'deduped' }
        | { action: 'budget_refused' }
        | { action: 'send'; delivery: ProgressDelivery };
      const prep = await withProgressLock<Prep>(deps.runDir, lockWaitMs, now, async () => {
        const boxR = await readOutbox(deps.runDir, facts.runId === 'unknown' ? null : facts.runId);
        if (!boxR.ok) return boxR as Result<never>;
        const box = boxR.value;
        const existing = box.deliveries.find((d) => d.intentId === intent.intentId);
        if (existing !== undefined) {
          if (existing.delivery === 'sent' || existing.delivery === 'unknown' || existing.delivery === 'sending') {
            return ok({ action: 'deduped' as const });
          }
          if (existing.delivery === 'invalid_recipient' || existing.delivery === 'refused_final') {
            return ok({ action: 'deduped' as const });
          }
          // 'refused' with attempts left → the single allowed retry.
          if (existing.attempts >= 2) {
            existing.delivery = 'refused_final';
            const w = await atomicWriteJson(outboxPath, box, fsyncDir);
            if (!w.ok) return w as Result<never>;
            return ok({ action: 'deduped' as const });
          }
          existing.attempts += 1;
          existing.lastAttemptAt = iso(at);
          existing.delivery = 'sending';
          const w = await atomicWriteJson(outboxPath, box, fsyncDir);
          if (!w.ok) return w as Result<never>;
          await ensureOutboxWitness(deps.runDir, box.runId, fsyncDir);
          return ok({ action: 'send' as const, delivery: existing });
        }
        const cap = budgetKind === 'stage' ? budget.stageMax : budget.heartbeatMax;
        const used = box.counters[budgetKind];
        if (used >= cap) {
          box.counters.budgetRefusals += 1;
          const w = await atomicWriteJson(outboxPath, box, fsyncDir);
          if (!w.ok) return w as Result<never>;
          return ok({ action: 'budget_refused' as const });
        }
        const delivery: ProgressDelivery = {
          intentId: intent.intentId,
          kind: intent.kind,
          stageKey: intent.stageKey,
          subject,
          body,
          recipient: recipient.to,
          createdAt: iso(at),
          attempts: 1,
          delivery: 'sending',
          lastAttemptAt: iso(at),
        };
        box.counters[budgetKind] += 1; // charged at intent, before the host call
        box.deliveries.push(delivery);
        const w = await atomicWriteJson(outboxPath, box, fsyncDir);
        if (!w.ok) return w as Result<never>;
        await ensureOutboxWitness(deps.runDir, box.runId, fsyncDir);
        return ok({ action: 'send' as const, delivery });
      });
      if (!prep.ok) return failRes(prep.error);
      if (prep.value.action === 'deduped') {
        return ok({ outcome: 'deduped', intentId: intent.intentId });
      }
      if (prep.value.action === 'budget_refused') {
        return ok({ outcome: 'budget_refused', intentId: intent.intentId });
      }

      // ── Phase 2 (unlocked): bounded host send ──
      const sendInput: ProgressSendMailInput = { to: recipient.to, subject, body };
      const sendPromise = Promise.resolve()
        .then(() => deps.sendMail(sendInput))
        .then(
          (r): { tag: 'result'; r: typeof r } => ({ tag: 'result', r }),
          (e): { tag: 'throw'; e: unknown } => ({ tag: 'throw', e }),
        );
      const timeout = new Promise<{ tag: 'timeout' }>((resolvePromise) => {
        const t = setTimeout(() => resolvePromise({ tag: 'timeout' }), sendTimeoutMs);
        t.unref?.();
      });
      const raced = await Promise.race([sendPromise, timeout]);
      // A late-resolving send must never mutate delivery state post-timeout:
      // the intent is already marked unknown — swallow its result.
      void sendPromise.catch(() => undefined);

      let delivery: DeliveryState;
      let detail: string | undefined;
      let requestId: string | undefined;
      let messageId: string | undefined;
      if (raced.tag === 'timeout') {
        delivery = 'unknown';
        detail = `send timed out after ${sendTimeoutMs}ms — outcome unproven, retained as unknown custody`;
      } else if (raced.tag === 'throw') {
        // A send that threw before a definitive no-effects proof is UNKNOWN:
        // the mutation may have landed without a receipt.
        delivery = 'unknown';
        detail = `send threw: ${describeErr(raced.e).slice(0, 300)} — treated as unknown`;
      } else if (!raced.r.ok) {
        const provenRefusal = raced.r.error.details?.uncertain === false;
        delivery = provenRefusal ? 'refused' : 'unknown';
        detail = `${raced.r.error.code}: ${raced.r.error.message}`.slice(0, 400);
      } else {
        delivery = raced.r.value.outcome === 'sent' ? 'sent' : 'unknown';
        requestId = raced.r.value.requestId;
        messageId = raced.r.value.messageId;
        if (delivery === 'unknown') detail = 'host returned outcome:unknown';
      }

      // ── Phase 3 (locked): record the delivery receipt ──
      const finalDelivery: DeliveryState =
        delivery === 'refused' && prep.value.action === 'send' && prep.value.delivery.attempts >= 2
          ? 'refused_final'
          : delivery;
      const receipt = await withProgressLock(deps.runDir, lockWaitMs, now, async () => {
        const boxR = await readOutbox(deps.runDir, facts.runId === 'unknown' ? null : facts.runId);
        if (!boxR.ok) return boxR as Result<never>;
        const box = boxR.value;
        const d = box.deliveries.find((x) => x.intentId === intent.intentId);
        if (d !== undefined) {
          d.delivery = finalDelivery;
          if (requestId !== undefined) d.requestId = requestId;
          if (messageId !== undefined) d.messageId = messageId;
          if (detail !== undefined) d.detail = detail;
          if (delivery === 'sent' || delivery === 'unknown') d.sentAt = iso(now());
          const w = await atomicWriteJson(outboxPath, box, fsyncDir);
          if (!w.ok) return w as Result<never>;
        }
        return ok(undefined);
      });
      if (!receipt.ok) return failRes(receipt.error);

      return ok({
        outcome: finalDelivery,
        intentId: intent.intentId,
        delivery: finalDelivery,
        ...(requestId === undefined ? {} : { requestId }),
        ...(messageId === undefined ? {} : { messageId }),
        ...(detail === undefined ? {} : { detail }),
      });
    } catch (e) {
      return failRes(err('io_error', `progress notify failed: ${describeErr(e)}`));
    }
  };

  return { notify };
}

// ─── Helper: bounded run-local heartbeat process ────────────────────────────

interface HelperLease {
  nonce: string;
  /**
   * null = the generation was leased but its child never completed
   * nonce-pinned registration — UNREGISTERED, never proof of a dead or a
   * live helper (audit P-D2). Reclaimable once expired under the progress
   * lock; a late old child then fails its nonce check and sends ZERO.
   */
  pid: number | null;
  startedAt: string;
  expiresAt: string;
  /** Diagnostics: the fenced unregistered generation this lease replaced. */
  supersedes?: { nonce: string; pid: number | null; startedAt: string; fencedAt: string };
}

function parseLease(v: unknown): HelperLease | null {
  const r = asRec(v);
  if (r === undefined || typeof r.nonce !== 'string' || typeof r.expiresAt !== 'string') return null;
  const sup = asRec(r.supersedes);
  const supersedes =
    sup !== undefined && typeof sup.nonce === 'string'
      ? {
          nonce: sup.nonce,
          pid: typeof sup.pid === 'number' ? sup.pid : null,
          startedAt: typeof sup.startedAt === 'string' ? sup.startedAt : '',
          fencedAt: typeof sup.fencedAt === 'string' ? sup.fencedAt : '',
        }
      : undefined;
  return {
    nonce: r.nonce,
    pid: typeof r.pid === 'number' ? r.pid : null,
    startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    expiresAt: r.expiresAt,
    ...(supersedes === undefined ? {} : { supersedes }),
  };
}

function parseHelperState(v: unknown): HelperStatusView | null {
  const r = asRec(v);
  if (r === undefined) return null;
  return {
    state: 'exited',
    ...(typeof r.pid === 'number' ? { pid: r.pid } : {}),
    ...(asStr(r.nonce) !== undefined ? { nonce: r.nonce as string } : {}),
    ...(asStr(r.startedAt) !== undefined ? { startedAt: r.startedAt as string } : {}),
    ...(asStr(r.lastTickAt) !== undefined ? { lastTickAt: r.lastTickAt as string } : {}),
    ...(asStr(r.lastSendOutcome) !== undefined ? { lastSendOutcome: r.lastSendOutcome as string } : {}),
    ...(asStr(r.exitReason) !== undefined ? { exitReason: r.exitReason as string } : {}),
  };
}

function defaultSpawn(plan: { file: string; args: string[] }): Result<{ pid: number }> {
  try {
    const child = spawn(plan.file, plan.args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    if (child.pid === undefined) {
      return failRes(err('io_error', 'spawn returned no pid'));
    }
    return ok({ pid: child.pid });
  } catch (e) {
    return failRes(err('io_error', `helper spawn failed: ${describeErr(e)}`));
  }
}

/**
 * Ensure a bounded heartbeat helper exists for a non-terminal run. Idempotent
 * and safe to call on every advance: the nonce lease admits exactly one live
 * helper; reclaim requires an expired lease plus a verifiably dead owner pid.
 * NEVER relaunches crashed runs — it only covers silent non-terminal stages
 * with bounded progress wakes.
 */
export async function ensureHelper(deps: HelperEnsureDeps): Promise<Result<HelperEnsureResult>> {
  const now = () => (deps.now !== undefined ? deps.now() : new Date());
  const intervalMs = deps.helper?.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxLifetimeMs = deps.helper?.maxLifetimeMs ?? DEFAULT_HELPER_MAX_LIFETIME_MS;
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const lockWaitMs = deps.lockWaitMs ?? 8_000;
  const fsyncDir = deps.fsyncDir ?? defaultFsyncDir;
  const leasePath = path.join(deps.runDir, HELPER_LEASE_FILE);

  const stR = await fileReadState(deps.runDir)();
  if (!stR.ok) {
    return ok({ state: 'skipped_no_state', detail: stR.error.message });
  }
  if (TERMINAL_STATUSES.has(stR.value.status)) {
    return ok({ state: 'skipped_terminal', detail: `run is ${stR.value.status}` });
  }
  const recR = await loadRecipient(deps.runDir);
  if (!recR.ok) return failRes(recR.error);
  if (recR.value === null) {
    return ok({ state: 'no_recipient', detail: 'no progress recipient captured yet' });
  }

  // Locked lease check + create; the child self-registers its pid.
  const nonce = randomUUID().slice(0, 12);
  type LeasePrep =
    | { action: 'held'; lease: HelperLease | null }
    | { action: 'stale_unproven'; lease: HelperLease | null }
    | { action: 'created'; lease: HelperLease };
  const prep = await withProgressLock<LeasePrep>(deps.runDir, lockWaitMs, now, async () => {
    const leaseR = await readJsonFile(leasePath);
    const lease = leaseR.ok ? parseLease(leaseR.value) : null;
    let fenced: HelperLease['supersedes'] | undefined;
    if (lease !== null) {
      const expired = Date.parse(lease.expiresAt) <= Date.now();
      if (!expired) {
        return ok({ action: 'held' as const, lease });
      }
      if (lease.pid === null) {
        // Audit P-D2 protocol: a null pid means UNREGISTERED — the leased
        // generation never completed nonce-pinned registration. That is not
        // proof of a dead helper, but it IS proof there is no registered
        // live owner to protect, so an expired unregistered lease may be
        // fenced/replaced under THIS lock with a fresh nonce. A late old
        // child then fails its nonce check in registration and sends ZERO.
        // Fencing is guarded by re-reading the exact bytes we observed.
        try {
          const raw = await fsp.readFile(leasePath, 'utf8');
          const current = parseLease(JSON.parse(raw));
          if (current?.nonce === lease.nonce && current.pid === null) {
            await fsp.unlink(leasePath);
            fenced = {
              nonce: lease.nonce,
              pid: null,
              startedAt: lease.startedAt,
              fencedAt: iso(now()),
            };
          } else if (current !== null && current.pid !== null) {
            // The child registered between our reads — it is now a real
            // owner; the live/EPERM rules below decide, never the fence.
            const aliveNow = pidAlive(current.pid);
            if (aliveNow !== false) {
              return ok({ action: 'stale_unproven' as const, lease: current });
            }
            try {
              const again = await fsp.readFile(leasePath, 'utf8');
              if (parseLease(JSON.parse(again))?.nonce === current.nonce) await fsp.unlink(leasePath);
            } catch {
              /* gone — proceed */
            }
          }
        } catch {
          /* gone — proceed */
        }
      } else {
        const alive = pidAlive(lease.pid);
        if (alive !== false) {
          // Expired but owner pid unverifiable/alive — never risk two helpers.
          return ok({ action: 'stale_unproven' as const, lease });
        }
        // Expired AND owner verifiably dead: guarded byte-compare reclaim.
        try {
          const raw = await fsp.readFile(leasePath, 'utf8');
          const current = parseLease(JSON.parse(raw));
          if (current?.nonce === lease.nonce) await fsp.unlink(leasePath);
        } catch {
          /* gone — proceed */
        }
      }
    }
    const fresh: HelperLease = {
      nonce,
      pid: null,
      startedAt: iso(now()),
      expiresAt: new Date(Date.now() + Math.max(intervalMs * 3, 30_000)).toISOString(),
      ...(fenced === undefined ? {} : { supersedes: fenced }),
    };
    try {
      await fsp.mkdir(path.dirname(leasePath), { recursive: true });
      const fh = await fsp.open(leasePath, 'wx');
      try {
        await fh.writeFile(`${JSON.stringify(fresh)}\n`);
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await fsyncDir(path.dirname(leasePath));
      } catch (e) {
        if (!isUnsupportedDirSync(e)) throw e;
      }
      return ok({ action: 'created' as const, lease: fresh });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return ok({ action: 'held' as const, lease });
      return failRes(err('io_error', `cannot create helper lease: ${describeErr(e)}`));
    }
  });
  if (!prep.ok) return failRes(prep.error);
  if (prep.value.action === 'held') {
    const l = prep.value.lease;
    return ok({
      state: 'already_running',
      ...(l !== null && l.pid !== null ? { pid: l.pid } : {}),
      ...(l !== null ? { nonce: l.nonce } : {}),
    });
  }
  if (prep.value.action === 'stale_unproven') {
    return ok({
      state: 'error',
      detail: 'helper lease expired but owner pid is unverifiable/alive — not reclaiming; inspect progress/helper.lease',
    });
  }

  const moduleFile = fileURLToPath(import.meta.url);
  const args = [
    moduleFile,
    'helper',
    '--run',
    deps.runDir,
    '--interval-ms',
    String(intervalMs),
    '--nonce',
    nonce,
    '--max-lifetime-ms',
    String(maxLifetimeMs),
    '--send-timeout-ms',
    String(deps.helper?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
  ];
  const spawned = spawnFn({ file: process.execPath, args });
  if (!spawned.ok) {
    // Roll back the lease so a retry can spawn cleanly.
    try {
      const raw = await fsp.readFile(leasePath, 'utf8');
      const l = parseLease(JSON.parse(raw));
      if (l?.nonce === nonce) await fsp.unlink(leasePath);
    } catch {
      /* leave for stale reclaim */
    }
    return ok({ state: 'spawn_failed', detail: spawned.error.message });
  }
  // Retain fenced-generation diagnostics: the helper state file records the
  // unregistered lease this generation replaced (bounded, single latest).
  if (prep.value.action === 'created' && prep.value.lease.supersedes !== undefined) {
    await writeHelperState(deps.runDir, {
      lastFencedLease: prep.value.lease.supersedes,
    }).catch(() => undefined);
  }
  // Best-effort pid record — the child also self-registers under the lock.
  const reg = await withProgressLock(deps.runDir, lockWaitMs, now, async () => {
    const leaseR = await readJsonFile(leasePath);
    const lease = leaseR.ok ? parseLease(leaseR.value) : null;
    if (lease === null || lease.nonce !== nonce) return ok(undefined);
    lease.pid = spawned.value.pid;
    const w = await atomicWriteJson(leasePath, lease, fsyncDir);
    return w;
  });
  void reg;
  return ok({ state: 'started', pid: spawned.value.pid, nonce });
}

// ─── Helper loop (in-process; the child entrypoint wraps this) ──────────────

export interface HelperLoopDeps {
  runDir: string;
  nonce: string;
  intervalMs: number;
  maxLifetimeMs: number;
  sendMail: ProgressSendMail;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  sendTimeoutMs?: number;
  budget?: Partial<ProgressBudget>;
  /** Cooperative cancel — checked between ticks. */
  stopped?: () => boolean;
  lockWaitMs?: number;
  /** Test seam: cap ticks regardless of other bounds. */
  maxTicks?: number;
  /** Test seam — directory fsync after durable lease/registration writes. */
  fsyncDir?: (dir: string) => Promise<void>;
}

export interface HelperExitRecord {
  exitReason: string;
  ticks: number;
}

async function writeHelperState(
  runDir: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const abs = path.join(runDir, HELPER_STATE_FILE);
  const prior = await readJsonFile(abs);
  const cur = prior.ok ? (asRec(prior.value) ?? {}) : {};
  await atomicWriteJson(abs, { ...cur, ...patch }).catch(() => undefined);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/**
 * The helper's bounded loop. Each tick re-reads persisted run facts only —
 * state.json + journal tail — and emits a deduplicated heartbeat. Exits on
 * terminal state, budget/lifetime exhaustion, lease loss, or cancellation.
 */
export async function runHelperLoop(deps: HelperLoopDeps): Promise<Result<HelperExitRecord>> {
  const now = () => (deps.now !== undefined ? deps.now() : new Date());
  const sleep = deps.sleep ?? realSleep;
  const lockWaitMs = deps.lockWaitMs ?? 8_000;
  const fsyncDir = deps.fsyncDir ?? defaultFsyncDir;
  const leasePath = path.join(deps.runDir, HELPER_LEASE_FILE);
  const startedAt = now();
  let ticks = 0;

  const notifier = createProgressNotifier({
    runDir: deps.runDir,
    sendMail: deps.sendMail,
    now: deps.now,
    sendTimeoutMs: deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
    budget: deps.budget,
    heartbeatIntervalMs: deps.intervalMs,
    lockWaitMs,
    fsyncDir,
  });

  // Self-register: the lease must carry our nonce; write our pid if empty.
  const reg = await withProgressLock<boolean>(deps.runDir, lockWaitMs, now, async () => {
    const leaseR = await readJsonFile(leasePath);
    const lease = leaseR.ok ? parseLease(leaseR.value) : null;
    if (lease === null || lease.nonce !== deps.nonce) return ok(false);
    if (lease.pid === null) {
      lease.pid = process.pid;
      const w = await atomicWriteJson(leasePath, lease, fsyncDir);
      if (!w.ok) return w as Result<never>;
    }
    return ok(lease.pid === process.pid || lease.pid === null);
  });
  if (!reg.ok) return reg as Result<never>;
  if (reg.value === false) {
    return ok({ exitReason: 'lease_mismatch', ticks });
  }

  const exit = async (reason: string): Promise<Result<HelperExitRecord>> => {
    await writeHelperState(deps.runDir, {
      exitReason: reason,
      exitAt: iso(now()),
      ticks,
    });
    // Release the lease only if it is still ours.
    await withProgressLock(deps.runDir, lockWaitMs, now, async () => {
      const leaseR = await readJsonFile(leasePath);
      const lease = leaseR.ok ? parseLease(leaseR.value) : null;
      if (lease !== null && lease.nonce === deps.nonce) {
        try {
          await fsp.unlink(leasePath);
        } catch {
          /* already gone */
        }
      }
      return ok(undefined);
    });
    return ok({ exitReason: reason, ticks });
  };

  await writeHelperState(deps.runDir, {
    nonce: deps.nonce,
    pid: process.pid,
    startedAt: iso(startedAt),
    intervalMs: deps.intervalMs,
    maxLifetimeMs: deps.maxLifetimeMs,
    exitReason: null,
  });

  for (;;) {
    if (deps.stopped?.() === true) return await exit('cancelled');
    const at = now();
    if (at.getTime() - startedAt.getTime() > deps.maxLifetimeMs) {
      await notifier.notify({ kind: 'helper_expired', reason: 'lifetime_exceeded' });
      return await exit('lifetime_exceeded');
    }
    if (deps.maxTicks !== undefined && ticks >= deps.maxTicks) {
      return await exit('max_ticks');
    }

    const stR = await fileReadState(deps.runDir)();
    if (stR.ok && TERMINAL_STATUSES.has(stR.value.status)) {
      return await exit(`terminal:${stR.value.status}`);
    }

    // Lease still ours? A mismatch means another helper generation took over.
    const leaseR = await readJsonFile(leasePath);
    const lease = leaseR.ok ? parseLease(leaseR.value) : null;
    if (lease === null || lease.nonce !== deps.nonce) {
      return await exit('lease_lost');
    }

    const boxR = await readOutbox(deps.runDir, stR.ok ? stR.value.runId : null);
    if (!boxR.ok) {
      // Custody unreadable → heartbeat budget is unproven: exit closed,
      // never send on a guessed budget (HIGH corrupt-outbox rule).
      await writeHelperState(deps.runDir, { lastSendOutcome: `error:${boxR.error.code}` }).catch(() => undefined);
      return await exit('outbox_unreadable');
    }
    const box = boxR.value;
    const hbMax = deps.budget?.heartbeatMax ?? DEFAULT_PROGRESS_BUDGET.heartbeatMax;
    if (box.counters.heartbeat >= hbMax) {
      await notifier.notify({ kind: 'helper_expired', reason: 'heartbeat_budget_exhausted' });
      return await exit('heartbeat_budget_exhausted');
    }

    const sent = await notifier.notify({
      kind: 'heartbeat',
      ...(stR.ok ? {} : { note: 'state.json unreadable — counts unavailable' }),
      helper: {
        tick: ticks + 1,
        intervalMs: deps.intervalMs,
        lifetimeRemainingMs: deps.maxLifetimeMs - (at.getTime() - startedAt.getTime()),
        budgetRemaining: hbMax - box.counters.heartbeat,
      },
    });
    ticks += 1;
    await writeHelperState(deps.runDir, {
      lastTickAt: iso(at),
      ticks,
      lastSendOutcome: sent.ok ? sent.value.outcome : `error:${sent.error.code}`,
    });

    // Renew our lease (nonce-pinned) before sleeping.
    await withProgressLock<boolean>(deps.runDir, lockWaitMs, now, async () => {
      const r = await readJsonFile(leasePath);
      const l = r.ok ? parseLease(r.value) : null;
      if (l === null || l.nonce !== deps.nonce) return ok(false);
      l.expiresAt = new Date(Date.now() + Math.max(deps.intervalMs * 3, 30_000)).toISOString();
      const w = await atomicWriteJson(leasePath, l, fsyncDir);
      if (!w.ok) return w as Result<never>;
      return ok(true);
    }).then((renew) => {
      if (renew.ok && renew.value === false) {
        // lost the lease mid-run — the next loop check exits lease_lost
      }
    });

    await sleep(deps.intervalMs);
  }
}

// ─── Progress status (read-only — never creates dirs/locks/sends/spawns) ────

export async function progressStatus(runDir: string): Promise<Result<ProgressStatusView>> {
  try {
    const recR = await loadRecipient(runDir).catch(
      (): Result<ProgressRecipient | null> => ok(null),
    );
    const recipient = recR.ok ? recR.value : null;

    const boxR = await readOutbox(runDir, null);
    // Corrupt/unavailable custody is reported honestly — placeholder counts
    // are flagged via outboxState, never presented as zero sends.
    const box = boxR.ok ? boxR.value : emptyOutbox(null);
    const outboxState: ProgressStatusView['outboxState'] = boxR.ok ? 'ok' : 'unavailable';
    const deliveries = box.deliveries;
    const counts = { total: deliveries.length, sent: 0, unknown: 0, refused: 0, sending: 0 };
    for (const d of deliveries) {
      if (d.delivery === 'sent') counts.sent += 1;
      else if (d.delivery === 'unknown' || d.delivery === 'sending') counts.unknown += 1;
      else if (d.delivery === 'refused' || d.delivery === 'refused_final' || d.delivery === 'invalid_recipient') {
        counts.refused += 1;
      }
    }
    const lastDelivery = deliveries.length > 0 ? deliveries[deliveries.length - 1] : null;

    // Helper evaluation: lease + diagnostics + pid check — no mutation.
    const leaseR = await readJsonFile(path.join(runDir, HELPER_LEASE_FILE));
    const lease = leaseR.ok ? parseLease(leaseR.value) : null;
    const hsR = await readJsonFile(path.join(runDir, HELPER_STATE_FILE));
    const hs = hsR.ok ? parseHelperState(hsR.value) : null;

    let helper: HelperStatusView;
    if (hs !== null && hs.exitReason !== undefined && hs.exitReason !== null) {
      helper = { ...hs, state: 'exited' };
    } else if (lease === null) {
      helper =
        hs !== null && hs.lastTickAt !== undefined
          ? { ...hs, state: 'dead', detail: 'helper diagnostics exist but no lease — helper is gone' }
          : { state: 'none' };
    } else {
      const expired = Date.parse(lease.expiresAt) <= Date.now();
      const alive = lease.pid !== null ? pidAlive(lease.pid) : null;
      if (!expired && alive === true) {
        helper = { ...(hs ?? {}), state: 'running', pid: lease.pid!, nonce: lease.nonce, expiresAt: lease.expiresAt };
      } else if (!expired && lease.pid === null) {
        helper = { state: 'starting', nonce: lease.nonce, expiresAt: lease.expiresAt };
      } else if (!expired && alive === null) {
        helper = { ...(hs ?? {}), state: 'stale', pid: lease.pid ?? undefined, nonce: lease.nonce, detail: 'owner pid unverifiable' };
      } else if (alive === true) {
        helper = { ...(hs ?? {}), state: 'stale', pid: lease.pid!, nonce: lease.nonce, detail: 'lease expired but pid still alive' };
      } else {
        helper = { ...(hs ?? {}), state: 'dead', pid: lease.pid ?? undefined, nonce: lease.nonce, detail: 'lease expired and owner pid is dead' };
      }
    }
    if (hs !== null && helper.state !== 'exited') {
      helper = { ...helper, ...hs, state: helper.state };
    }

    let runStatus: string | null = null;
    try {
      const stR = await fileReadState(runDir)();
      if (stR.ok) runStatus = stR.value.status;
    } catch {
      /* status display is best-effort */
    }

    return ok({
      recipient,
      budget: {
        ...DEFAULT_PROGRESS_BUDGET,
        stageUsed: box.counters.stage,
        heartbeatUsed: box.counters.heartbeat,
        budgetRefusals: box.counters.budgetRefusals,
      },
      deliveries: counts,
      lastDelivery,
      helper,
      runStatus,
      outboxState,
      ...(boxR.ok ? {} : { outboxError: `${boxR.error.code}: ${boxR.error.message}` }),
    });
  } catch (e) {
    return failRes(err('io_error', `progressStatus failed: ${describeErr(e)}`));
  }
}

// ─── argv send implementation (helper entrypoint) ───────────────────────────

/**
 * The helper's send path: the documented Orca host adapter (argv-only
 * `orca orchestration send`), addressed from the persisted supervisor
 * handle when one exists. Injected sendMail is used everywhere else.
 */
function createArgvSendMail(runDir: string): ProgressSendMail {
  return async (input) => {
    let fromHandle: string | undefined;
    const stR = await fileReadState(runDir)();
    if (stR.ok) fromHandle = stR.value.supervisor?.terminalHandle ?? undefined;
    let host;
    try {
      host = createOrcaAdapter({
        ...(process.env.ORCA_CLI_COMMAND !== undefined ? { executablePath: process.env.ORCA_CLI_COMMAND } : {}),
        ...(fromHandle !== undefined ? { fromHandle } : {}),
      });
    } catch (e) {
      return failRes(
        err('adapter_error', `cannot build orca adapter: ${describeErr(e)}`, {
          details: { uncertain: false, reason: 'adapter_init' },
        }),
      );
    }
    try {
      const r = await host.sendNotification(input);
      if (!r.ok) {
        // Definitive local refusals the adapter proves never reached the host
        // (bad target validation) carry uncertain:false; anything else stays
        // conservative-unknown per the custody rule.
        const noEffects = r.error.details?.adapterCode === 'bad_mail_target' ||
          r.error.details?.adapterCode === 'bad_subject' ||
          r.error.details?.adapterCode === 'notification_too_large';
        return failRes({
          ...r.error,
          details: { ...(r.error.details ?? {}), uncertain: !noEffects },
        });
      }
      return ok(r.value);
    } catch (e) {
      return failRes(
        err('adapter_error', `sendNotification threw: ${describeErr(e)}`, {
          details: { uncertain: true },
        }),
      );
    }
  };
}

// ─── Helper executable entrypoint ───────────────────────────────────────────

function parseHelperArgv(argv: readonly string[]): Result<{
  runDir: string;
  nonce: string;
  intervalMs: number;
  maxLifetimeMs: number;
  sendTimeoutMs: number;
}> {
  if (argv[0] !== 'helper') {
    return failRes(err('unsupported', `expected 'helper' subcommand`));
  }
  const flags = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) {
      return failRes(err('unsupported', `malformed helper argv at ${JSON.stringify(argv[i])}`));
    }
    flags.set(argv[i].slice(2), argv[i + 1]);
  }
  const runDir = flags.get('run');
  const nonce = flags.get('nonce');
  if (runDir === undefined || nonce === undefined) {
    return failRes(err('unsupported', 'helper requires --run <dir> --nonce <n>'));
  }
  const num = (k: string, d: number): number => {
    const v = flags.get(k);
    if (v === undefined) return d;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return ok({
    runDir,
    nonce,
    intervalMs: num('interval-ms', DEFAULT_HEARTBEAT_INTERVAL_MS),
    maxLifetimeMs: num('max-lifetime-ms', DEFAULT_HELPER_MAX_LIFETIME_MS),
    sendTimeoutMs: num('send-timeout-ms', DEFAULT_SEND_TIMEOUT_MS),
  });
}

/**
 * `node dist/src/progress.js helper --run <dir> --nonce <n> [...]` — the
 * bounded child the ensureHelper spawn executes. Exported for tests; the
 * module guard below wires it to real argv only when invoked directly.
 */
export async function runHelperMain(
  argv: readonly string[],
  deps?: Partial<HelperLoopDeps>,
): Promise<number> {
  const parsed = parseHelperArgv(argv);
  if (!parsed.ok) {
    process.stderr.write(`progress helper: ${parsed.error.message}\n`);
    return 2;
  }
  const p = parsed.value;
  let stop = false;
  const onSig = () => {
    stop = true;
  };
  process.on('SIGTERM', onSig);
  process.on('SIGINT', onSig);
  // The standalone child exists only for this loop: hold one ref'd handle so
  // unref'd internal waits (between-tick sleep, send timeout) cannot drain the
  // event loop and let Node exit early on an "unsettled top-level await".
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    const res = await runHelperLoop({
      runDir: p.runDir,
      nonce: p.nonce,
      intervalMs: p.intervalMs,
      maxLifetimeMs: p.maxLifetimeMs,
      sendTimeoutMs: p.sendTimeoutMs,
      sendMail: deps?.sendMail ?? createArgvSendMail(p.runDir),
      ...(deps?.now !== undefined ? { now: deps.now } : {}),
      ...(deps?.sleep !== undefined ? { sleep: deps.sleep } : {}),
      ...(deps?.stopped !== undefined ? { stopped: deps.stopped } : { stopped: () => stop }),
      ...(deps?.budget !== undefined ? { budget: deps.budget } : {}),
      ...(deps?.maxTicks !== undefined ? { maxTicks: deps.maxTicks } : {}),
      ...(deps?.lockWaitMs !== undefined ? { lockWaitMs: deps.lockWaitMs } : {}),
    });
    if (!res.ok) {
      process.stderr.write(`progress helper: ${res.error.code} ${res.error.message}\n`);
      return 1;
    }
    return 0;
  } finally {
    clearInterval(keepAlive);
    process.off('SIGTERM', onSig);
    process.off('SIGINT', onSig);
  }
}

const invokedDirectly = (() => {
  const a = process.argv[1];
  if (a === undefined) return false;
  try {
    return realpathSync(a) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly && process.argv[2] === 'helper') {
  process.exitCode = await runHelperMain(process.argv.slice(2));
}
