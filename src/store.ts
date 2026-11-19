/**
 * Durable artifact/state store for one council run directory.
 *
 * Layout created by `initialize` (all paths safe-relative to the run dir):
 *  - council.json          immutable run identity {schemaVersion, runId, targetRoot, objective, snapshotId, createdAt}
 *  - state.json            mutable CouncilState (validated on read AND write)
 *  - objective.md          verbatim review objective text
 *  - snapshot.json         SourceSnapshot of the target at approval time
 *  - events.jsonl          append-only journal; one canonical JSON event per
 *                         line; on receipts-v1 runs line 1 is the genesis
 *                         run.initialized event carrying the policy marker
 *                         (integrity: receipts-v1) — written at initialize so
 *                         the journal is never both non-empty and unmarked
 *  - roster.proposed.json  organiser output (validated before persistence)
 *  - roster.approved.json  orchestrator selection (validated vs proposal+config)
 *  - approval.json         {record, binding} pair (hash must match binding)
 *  - integrity/index.json  rebuildable receipt projection (src/artifacts.ts)
 *  - lock                  cross-process mutation lock file
 *
 * Atomicity: every file write goes to a same-directory temp file, is fsynced,
 * then renamed over the target — a failed write never clobbers a good file.
 * Temp files are unlinked on failure.
 *
 * Journal: lines are hash-linked (`prevHash` = sha256 of the previous stored
 * line bytes) and `seq` is contiguous from 1. `readJournal` verifies the whole
 * chain and returns a `journal_corrupt` error on truncation, bad JSON, seq
 * gaps or hash mismatches — records are never silently dropped. `appendJournal`
 * re-verifies before appending and refuses to extend a corrupt chain.
 *
 * Locking: `withLock` serializes mutations through (a) an in-process promise
 * queue and (b) an O_EXCL `lock` file carrying {pid, startedAt, host}.
 *  - A lock whose owner pid is verifiably dead (ESRCH) is reclaimed; a lock
 *    with an unreadable/missing owner is reclaimed only after
 *    COUNCIL_LOCK_STALE_MS (default 60s). A lock owned by a LIVE pid is never
 *    deleted — acquisition waits up to COUNCIL_LOCK_WAIT_MS (default 10s)
 *    then fails `lock_timeout` with owner details.
 *  - Documented limitations: pid liveness is checked via process.kill(pid,0)
 *    so a reused pid keeps a stale lock alive until the wait deadline; the
 *    check→unlink reclaim has an inherent small race (guarded by re-checking
 *    mtime/content, not eliminated); on EPERM the pid counts as alive.
 *  - `withLock` is NOT reentrant: a nested call fails `lock_nested` instead
 *    of deadlocking. Reentrancy is scoped by AsyncLocalStorage — internal
 *    calls inside a held lock session run under it; sibling calls in other
 *    async contexts queue and block on the file lock normally.
 *  - Plain artifact/state writes rely on single-file atomicity (tmp+rename)
 *    and do not take the file lock; only the journal and `withLock` do —
 *    composite mutations are the engine's job to wrap in `withLock`.
 *
 * Path safety: artifact paths must pass assertSafeRelativePath; the resolved
 * target's deepest existing ancestor is realpath-checked inside the run dir
 * (refuses symlink/junction escapes), and writing through a symlinked leaf is
 * refused even when it points inside the run dir.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import type {
  CouncilError,
  CouncilRunId,
  CouncilState,
  JournalEvent,
  ProposedRoster,
  Result,
  SnapshotDrift,
  Store,
  StoreOpenOptions,
  ValidationIssue,
} from './contracts.js';
import { SCHEMA_VERSION } from './contracts.js';
import {
  assertSafeRelativePath,
  canonicalApprovalHash,
  err,
  parseApprovedRoster,
  parseApprovalBinding,
  parseApprovalRecord,
  parseCouncilState,
  parseJournalEvent,
  parseProposedRoster,
  parseSourceSnapshot,
} from './validation.js';
import {
  INTEGRITY_INDEX_PATH,
  INTEGRITY_POLICY,
  emptyIndex,
} from './artifacts.js';
import {
  DEFAULT_SNAPSHOT_LIMITS,
  diffSnapshotFiles,
  manifestHeadHash,
  scanSourceTree,
} from './snapshot.js';

// ─── Stable artifact names (shared with engine/prompts via this export) ──────

export const STORE_PATHS = {
  council: 'council.json',
  state: 'state.json',
  objective: 'objective.md',
  snapshot: 'snapshot.json',
  journal: 'events.jsonl',
  proposedRoster: 'roster.proposed.json',
  approvedRoster: 'roster.approved.json',
  approval: 'approval.json',
  integrityIndex: INTEGRITY_INDEX_PATH,
  lock: 'lock',
} as const;

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_EVENTS_PER_APPEND = 1000;
const MAX_EVENT_LINE_BYTES = 32 * 1024;
const LOCK_POLL_MS_DEFAULT = 75;
const LOCK_WAIT_MS_DEFAULT = 10_000;
const LOCK_STALE_MS_DEFAULT = 60_000;

// ─── Result plumbing ────────────────────────────────────────────────────────

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = (error: CouncilError): Result<never> => ({ ok: false, error });

const ioErr = (
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): CouncilError => err('io_error', message, { details: { reason, ...details } });

const describeErr = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const v = Number.parseInt(raw, 10);
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

// ─── Journal canonical line form ────────────────────────────────────────────

/** Deterministic stored line: contract field order, JSON.stringify'd. */
function eventLine(ev: JournalEvent): string {
  const ordered: Record<string, unknown> = {
    seq: ev.seq,
    ts: ev.ts,
    type: ev.type,
    actor: ev.actor,
  };
  if (ev.phase !== undefined) ordered.phase = ev.phase;
  if (ev.round !== undefined) ordered.round = ev.round;
  if (ev.participantId !== undefined) ordered.participantId = ev.participantId;
  if (ev.payload !== undefined) ordered.payload = ev.payload;
  if (ev.prevHash !== undefined) ordered.prevHash = ev.prevHash;
  return JSON.stringify(ordered);
}

const lineHash = (line: string): string =>
  createHash('sha256').update(line, 'utf8').digest('hex');

// ─── Lock internals ─────────────────────────────────────────────────────────

interface LockOwner {
  pid: number;
  startedAt: string;
  host: string;
}

interface AcquiredLock {
  release(): Promise<void>;
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = errCode(e);
    if (code === 'ESRCH') return false;
    // EPERM (exists, different user) and unknown errors: conservatively alive —
    // we never blind-delete a lock we cannot prove is stale.
    return true;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Write the ENTIRE buffer to an open filehandle: a single write() may
 * short-write (partial bytes accepted), so loop until everything is out.
 * No position arg — callers must open in 'a' mode so each write lands at
 * EOF and concurrent O_APPEND writers cannot overwrite each other.
 * Exported for tests: the loop is exercised against a stub handle that
 * deliberately accepts only partial chunks per call.
 */
export async function writeFully(
  fh: { write(buf: Buffer, offset?: number): Promise<{ bytesWritten: number }> },
  buf: Buffer,
): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off);
    if (bytesWritten <= 0) {
      throw new Error(`write stalled after ${off}/${buf.length} bytes`);
    }
    off += bytesWritten;
  }
}

// ─── Store factory ──────────────────────────────────────────────────────────

export function createStore(options: StoreOpenOptions): Store {
  const runDirAbs = path.resolve(options.runDir);

  let rootRealCache: string | null = null;
  let runIdCache: CouncilRunId | null = null;
  let tail: Promise<unknown> = Promise.resolve(); // in-process serialization

  /**
   * Lock-session scope via AsyncLocalStorage: code running INSIDE a held lock
   * (public withLock or an internal mutation) sees depth>0 and must not
   * re-acquire; sibling calls in other async contexts see nothing and queue
   * normally. A global counter would wrongly mark unrelated calls as
   * "reentrant" and let them mutate unsynchronized.
   */
  const lockScope = new AsyncLocalStorage<{ depth: number }>();
  const inLockSession = (): boolean => (lockScope.getStore()?.depth ?? 0) > 0;

  // ── small helpers ──────────────────────────────────────────────────────

  const realpathRoot = async (): Promise<Result<string>> => {
    if (rootRealCache !== null) return ok(rootRealCache);
    try {
      rootRealCache = await fsp.realpath(runDirAbs);
      return ok(rootRealCache);
    } catch (e) {
      return failRes(
        ioErr('not_initialized', `run dir not readable: ${describeErr(e)}`, {
          runDir: runDirAbs,
        }),
      );
    }
  };

  const requireInitialized = async (): Promise<Result<void>> => {
    if (!existsSync(path.join(runDirAbs, STORE_PATHS.council))) {
      return failRes(
        ioErr('not_initialized', `run dir ${runDirAbs} is not initialized (no council.json)`, {
          runDir: runDirAbs,
        }),
      );
    }
    return ok(undefined);
  };

  const councilJson = async (): Promise<Result<Record<string, unknown>>> => {
    try {
      const raw = await fsp.readFile(path.join(runDirAbs, STORE_PATHS.council), 'utf8');
      const v = JSON.parse(raw);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return failRes(ioErr('council_meta_corrupt', 'council.json is not a JSON object'));
      }
      return ok(v as Record<string, unknown>);
    } catch (e) {
      return failRes(
        ioErr(
          errCode(e) === 'ENOENT' ? 'not_initialized' : 'read_failed',
          `cannot read council.json: ${describeErr(e)}`,
        ),
      );
    }
  };

  const runId = async (): Promise<Result<CouncilRunId>> => {
    if (runIdCache !== null) return ok(runIdCache);
    const meta = await councilJson();
    if (!meta.ok) return meta;
    const id = meta.value.runId;
    if (typeof id !== 'string' || id.length === 0) {
      return failRes(ioErr('council_meta_corrupt', 'council.json missing runId'));
    }
    runIdCache = id;
    return ok(id);
  };

  const isWin = process.platform === 'win32';
  const norm = (p: string) => (isWin ? p.toLowerCase() : p);
  const within = (root: string, p: string): boolean =>
    norm(p) === norm(root) || norm(p).startsWith(norm(root + path.sep));

  /**
   * Lexical + realpath containment. `abs` may not exist yet (writes): walk up
   * to the deepest existing ancestor, realpath it, and re-resolve — a
   * symlinked/junctioned ancestor escaping the run dir is refused.
   */
  const resolveUnder = async (
    relPath: string,
    opts: { forWrite: boolean },
  ): Promise<Result<{ abs: string }>> => {
    const pr = assertSafeRelativePath(relPath);
    if (!pr.ok) {
      return failRes(
        err('untrusted_output', `unsafe artifact path ${JSON.stringify(relPath)}`, {
          issues: pr.issues,
          details: { reason: 'unsafe_path', relPath },
        }),
      );
    }
    const rootReal = await realpathRoot();
    if (!rootReal.ok) return rootReal;

    const abs = path.resolve(runDirAbs, pr.value);
    if (opts.forWrite && abs === runDirAbs) {
      return failRes(
        err('untrusted_output', 'artifact path resolves to the run dir itself', {
          details: { reason: 'unsafe_path', relPath },
        }),
      );
    }

    let cursor = abs;
    const missing: string[] = [];
    while (!existsSync(cursor)) {
      missing.push(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    let ancReal: string;
    try {
      ancReal = await fsp.realpath(cursor);
    } catch (e) {
      return failRes(ioErr('resolve_failed', `cannot resolve ${cursor}: ${describeErr(e)}`));
    }
    const resolved = path.resolve(ancReal, ...missing.reverse());
    if (!within(rootReal.value, resolved)) {
      return failRes(
        err('untrusted_output', `artifact path escapes run dir via link: ${relPath}`, {
          details: { reason: 'symlink_escape', relPath, resolved },
        }),
      );
    }
    if (opts.forWrite && existsSync(abs)) {
      try {
        if ((await fsp.lstat(abs)).isSymbolicLink()) {
          return failRes(
            err('untrusted_output', `refusing to write through symlink: ${relPath}`, {
              details: { reason: 'symlink_escape', relPath },
            }),
          );
        }
      } catch (e) {
        return failRes(ioErr('resolve_failed', `cannot stat ${relPath}: ${describeErr(e)}`));
      }
    }
    return ok({ abs });
  };

  /**
   * Best-effort fsync of a directory after a rename so the directory entry
   * itself is durable (the file fsync alone does not guarantee the rename
   * survives an OS crash). Skipped silently where directories cannot be
   * opened/synced (Windows, some filesystems) — the tmp+rename protocol is
   * still correct, this only tightens the crash window.
   */
  const fsyncDir = async (dir: string): Promise<void> => {
    if (isWin) return;
    try {
      const dh = await fsp.open(dir, 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      /* platform/filesystem does not support directory fsync — best effort */
    }
  };

  const atomicWrite = async (abs: string, data: Buffer): Promise<Result<void>> => {
    const tmp = `${abs}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const fh = await fsp.open(tmp, 'w');
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, abs);
      await fsyncDir(path.dirname(abs));
      return ok(undefined);
    } catch (e) {
      await fsp.unlink(tmp).catch(() => {});
      return failRes(ioErr('write_failed', `atomic write failed: ${describeErr(e)}`, { abs }));
    }
  };

  const readJson = async (
    relPath: string,
  ): Promise<Result<{ raw: unknown; text: string }>> => {
    const resolved = await resolveUnder(relPath, { forWrite: false });
    if (!resolved.ok) return resolved;
    let text: string;
    try {
      text = await fsp.readFile(resolved.value.abs, 'utf8');
    } catch (e) {
      return failRes(
        ioErr(
          errCode(e) === 'ENOENT' ? 'not_found' : 'read_failed',
          `cannot read ${relPath}: ${describeErr(e)}`,
          { relPath },
        ),
      );
    }
    try {
      return ok({ raw: JSON.parse(text), text });
    } catch (e) {
      return failRes(
        ioErr('bad_json', `${relPath} is not valid JSON: ${describeErr(e)}`, { relPath }),
      );
    }
  };

  const schemaErr = (
    issues: ValidationIssue[],
    what: string,
    extraDetails: Record<string, unknown> = {},
  ): CouncilError =>
    err('schema_invalid', `${what} failed validation`, {
      issues,
      details: { reason: 'validation_failed', what, ...extraDetails },
    });

  // ── serialization + file lock ──────────────────────────────────────────

  /** Queue `fn` behind every other serialized op on this store instance. */
  const enqueue = <T>(fn: () => Promise<Result<T>>): Promise<Result<T>> => {
    const run = tail.then(fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const acquireLock = async (): Promise<Result<AcquiredLock>> => {
    const waitMs = envInt('COUNCIL_LOCK_WAIT_MS', LOCK_WAIT_MS_DEFAULT);
    const staleMs = envInt('COUNCIL_LOCK_STALE_MS', LOCK_STALE_MS_DEFAULT);
    const pollMs = envInt('COUNCIL_LOCK_POLL_MS', LOCK_POLL_MS_DEFAULT);
    const deadline = Date.now() + waitMs;
    const lockPath = path.join(runDirAbs, STORE_PATHS.lock);

    try {
      await fsp.mkdir(runDirAbs, { recursive: true });
    } catch (e) {
      return failRes(ioErr('lock_dir_failed', `cannot create run dir: ${describeErr(e)}`));
    }

    let lastOwner: LockOwner | null = null;
    for (;;) {
      try {
        const fh = await fsp.open(lockPath, 'wx');
        const owner: LockOwner = {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          host: hostname(),
        };
        try {
          await fh.writeFile(JSON.stringify(owner));
          await fh.sync();
        } finally {
          await fh.close();
        }
        return ok({
          release: async () => {
            // Only remove OUR lock: if the file was somehow replaced (e.g.
            // force-reclaimed by an older peer), unlinking would delete a
            // lock that no longer belongs to us.
            try {
              const raw = await fsp.readFile(lockPath, 'utf8');
              const parsed = JSON.parse(raw) as Partial<LockOwner>;
              if (parsed.pid === process.pid) await fsp.unlink(lockPath);
            } catch {
              /* lock already gone */
            }
          },
        });
      } catch (e) {
        if (errCode(e) !== 'EEXIST') {
          return failRes(
            ioErr('lock_acquire_failed', `cannot create lock file: ${describeErr(e)}`),
          );
        }
      }

      // The lock exists — inspect it before deciding anything.
      let owner: LockOwner | null = null;
      let mtimeMs = 0;
      let content: string | null = null;
      try {
        const st = await fsp.stat(lockPath);
        mtimeMs = st.mtimeMs;
        content = await fsp.readFile(lockPath, 'utf8');
        const parsed = JSON.parse(content) as Partial<LockOwner>;
        if (typeof parsed.pid === 'number' && typeof parsed.startedAt === 'string') {
          owner = { pid: parsed.pid, startedAt: parsed.startedAt, host: parsed.host ?? '' };
        }
      } catch {
        // unreadable mid-create or corrupt: treated as ownerless below
      }
      lastOwner = owner;

      const ageMs = Date.now() - mtimeMs;
      const ownerDead = owner !== null && !pidAlive(owner.pid);
      const unknownStale = owner === null && ageMs > staleMs;
      const reclaimable = ownerDead || unknownStale;

      if (reclaimable) {
        // Guarded reclaim: the lock must be byte-for-byte what we observed —
        // otherwise a live acquirer arrived in between and we leave it alone.
        try {
          const st2 = await fsp.stat(lockPath);
          const content2 = await fsp.readFile(lockPath, 'utf8');
          if (st2.mtimeMs === mtimeMs && content2 === content) {
            await fsp.unlink(lockPath);
            continue; // retry the create immediately
          }
        } catch (e) {
          if (errCode(e) === 'ENOENT') continue; // owner released between reads
          // EPERM/EBUSY: file is still held — fall through to the wait below.
        }
      }

      if (Date.now() + pollMs > deadline) {
        return failRes(
          ioErr(
            'lock_timeout',
            `timed out after ${waitMs}ms waiting for run lock held by ${owner ? `pid ${owner.pid} (since ${owner.startedAt})` : 'unknown owner'}`,
            {
              reason: 'lock_timeout',
              waitMs,
              owner: lastOwner ?? undefined,
            },
          ),
        );
      }
      await sleep(pollMs);
    }
  };

  /**
   * Serialize on the in-process queue, take the cross-process file lock, run.
   * Reentrant-aware for INTERNAL callers: when the current async context is
   * already inside a lock session (public withLock), inner helpers run
   * directly under it. Sibling calls in other contexts queue on `tail` and
   * block on the file lock — they cannot interleave journal/state mutations.
   */
  const withMutation = async <T>(fn: () => Promise<Result<T>>): Promise<Result<T>> => {
    if (inLockSession()) {
      try {
        return await fn();
      } catch (e) {
        return failRes(ioErr('exception', `mutation threw: ${describeErr(e)}`));
      }
    }
    return enqueue(async () => {
      const acq = await acquireLock();
      if (!acq.ok) return acq;
      try {
        return await lockScope.run({ depth: 1 }, fn);
      } catch (e) {
        return failRes(ioErr('exception', `mutation threw: ${describeErr(e)}`));
      } finally {
        await acq.value.release();
      }
    });
  };

  // ── journal raw read + chain verify ────────────────────────────────────

  interface JournalRead {
    events: JournalEvent[];
    lastLine: string | null;
  }

  /**
   * Fail-closed journal recovery guidance surfaced on every corruption
   * error. The journal is the durable record of issued host mutations —
   * silently dropping lines can make a later advance blind-retry a mutation
   * that already landed, so repair is an operator decision, never automatic.
   */
  const JOURNAL_RECOVERY_GUIDANCE =
    'journal corrupt: the run is halted (fail closed). Recovery: (1) copy events.jsonl ' +
    'to events.corrupt.jsonl in the run dir for forensics; (2) if and only if the reported ' +
    'line is an incomplete FINAL-line fragment, you may remove exactly that fragment after ' +
    'confirming its event carried no unaccounted host mutation (a lost launch.intent/error ' +
    'event can trigger a duplicate task-create or relaunch on resume); (3) for any ' +
    'mid-journal corruption, prevHash/seq mismatch, or uncertainty about landed mutations, ' +
    'abandon this run and start a new one — never delete intent events, they may have live ' +
    'host side effects';

  const corrupt = (
    cause: string,
    lineIndex: number,
    extra: Record<string, unknown> = {},
  ): CouncilError =>
    ioErr('journal_corrupt', `journal corrupt at line ${lineIndex + 1}: ${cause} — run halted; see details.recovery for the safe procedure`, {
      cause,
      line: lineIndex + 1,
      recovery: JOURNAL_RECOVERY_GUIDANCE,
      ...extra,
    });

  const readJournalRaw = async (): Promise<Result<JournalRead>> => {
    const journalPath = path.join(runDirAbs, STORE_PATHS.journal);
    let content: string;
    try {
      content = await fsp.readFile(journalPath, 'utf8');
    } catch (e) {
      if (errCode(e) === 'ENOENT') return ok({ events: [], lastLine: null });
      return failRes(ioErr('read_failed', `cannot read journal: ${describeErr(e)}`));
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_JOURNAL_BYTES) {
      return failRes(
        ioErr('journal_too_large', `journal exceeds ${MAX_JOURNAL_BYTES} bytes`),
      );
    }
    if (content === '') return ok({ events: [], lastLine: null });
    if (!content.endsWith('\n')) {
      const lineIndex = content.split('\n').length - 1;
      const byteOffset = Buffer.byteLength(content.slice(0, content.lastIndexOf('\n') + 1), 'utf8');
      return failRes(
        corrupt('truncated final line (possible torn append)', lineIndex, {
          byteOffset,
          tornBytes: Buffer.byteLength(content, 'utf8') - byteOffset,
          tornFragment: content.slice(content.lastIndexOf('\n') + 1).slice(0, 200),
        }),
      );
    }

    const lines = content.slice(0, -1).split('\n');
    const events: JournalEvent[] = [];
    let prevLine: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return failRes(corrupt('invalid JSON', i, { validPrefix: events.length }));
      }
      const parsed = parseJournalEvent(raw);
      if (!parsed.ok) {
        return failRes(
          corrupt('schema violation', i, {
            validPrefix: events.length,
            issues: parsed.issues,
          }),
        );
      }
      const ev = parsed.value;
      const expectedSeq = events.length === 0 ? 1 : events[events.length - 1].seq + 1;
      if (ev.seq !== expectedSeq) {
        return failRes(
          corrupt(`seq ${ev.seq}, expected ${expectedSeq}`, i, {
            validPrefix: events.length,
          }),
        );
      }
      if (prevLine === null) {
        if (ev.prevHash !== undefined) {
          return failRes(corrupt('first event carries prevHash', i));
        }
      } else {
        const expected = lineHash(prevLine);
        if (ev.prevHash !== expected) {
          return failRes(
            corrupt('prevHash mismatch', i, { validPrefix: events.length }),
          );
        }
      }
      events.push(ev);
      prevLine = line;
    }
    return ok({ events, lastLine: prevLine });
  };

  // ── state helpers ──────────────────────────────────────────────────────

  const loadConfigAndRunId = async (): Promise<
    Result<{ runId: CouncilRunId; state: CouncilState }>
  > => {
    const init = await requireInitialized();
    if (!init.ok) return init;
    const loaded = await readJson(STORE_PATHS.state);
    if (!loaded.ok) return loaded;
    const parsed = parseCouncilState(loaded.value.raw);
    if (!parsed.ok) return failRes(schemaErr(parsed.issues, 'state.json'));
    const id = await runId();
    if (!id.ok) return id;
    if (parsed.value.runId !== id.value) {
      return failRes(
        ioErr('run_id_mismatch', `state.runId ${parsed.value.runId} != council.json runId ${id.value}`),
      );
    }
    return ok({ runId: id.value, state: parsed.value });
  };

  const loadProposed = async (
    ctx: { runId: CouncilRunId; state: CouncilState },
  ): Promise<Result<ProposedRoster>> => {
    const loaded = await readJson(STORE_PATHS.proposedRoster);
    if (!loaded.ok) return loaded;
    const parsed = parseProposedRoster(loaded.value.raw, {
      runId: ctx.runId,
      requestedPerspectives: ctx.state.config.requestedPerspectives,
    });
    if (!parsed.ok) {
      return failRes(
        err('roster_invalid', 'stored roster.proposed.json failed validation', {
          issues: parsed.issues,
        }),
      );
    }
    return ok(parsed.value);
  };

  // ── the Store object ───────────────────────────────────────────────────

  const store: Store = {
    runDir: runDirAbs,

    initialize: (input) =>
      withMutation(async () => {
        if (existsSync(path.join(runDirAbs, STORE_PATHS.council))) {
          return failRes(
            ioErr('already_initialized', `run dir ${runDirAbs} already has council.json`),
          );
        }
        const snapParsed = parseSourceSnapshot(input.snapshot);
        if (!snapParsed.ok) {
          return failRes(schemaErr(snapParsed.issues, 'snapshot'));
        }
        const snapshot = snapParsed.value;
        // The snapshot must pin the same tree the run targets.
        let targetReal: string;
        try {
          targetReal = await fsp.realpath(input.targetRoot);
        } catch (e) {
          return failRes(
            err('config_invalid', `targetRoot unreadable: ${describeErr(e)}`, {
              details: { reason: 'bad_target_root', targetRoot: input.targetRoot },
            }),
          );
        }
        if (norm(targetReal) !== norm(snapshot.targetRoot)) {
          return failRes(
            err('config_invalid', 'snapshot.targetRoot does not match targetRoot', {
              details: {
                reason: 'snapshot_target_mismatch',
                targetReal,
                snapshotTarget: snapshot.targetRoot,
              },
            }),
          );
        }

        const now = new Date().toISOString();
        const state: CouncilState = {
          schemaVersion: SCHEMA_VERSION,
          runId: input.runId,
          orcaRunId: null,
          status: 'initialized',
          targetRoot: snapshot.targetRoot,
          objective: input.objective,
          config: input.config,
          snapshotId: snapshot.snapshotId,
          approvalHash: null,
          participants: [],
          discussion: null,
          supervisor: null, // CLI/supervisor sets its durable identity later
          consumption: { launches: 0, mailSent: 0 },
          phaseEnteredAt: now,
          createdAt: now,
        };
        const stateParsed = parseCouncilState(state);
        if (!stateParsed.ok) {
          return failRes(schemaErr(stateParsed.issues, 'state'));
        }

        const meta = {
          schemaVersion: SCHEMA_VERSION,
          runId: input.runId,
          targetRoot: snapshot.targetRoot,
          objective: input.objective,
          snapshotId: snapshot.snapshotId,
          // New-run integrity policy marker (src/artifacts.ts): receipts-v1
          // runs journal hash receipts for managed artifacts; legacy runs
          // without this marker stay honestly untracked, never retroactively
          // verified. The marker is written BEFORE any managed content.
          integrityPolicy: INTEGRITY_POLICY,
          createdAt: now,
        };

        // Genesis policy marker: the journal's FIRST line is the
        // run.initialized event carrying integrity: receipts-v1 — written at
        // initialization (before initialize returns) so no non-engine first
        // writer can leave a non-empty unmarked journal on a v1 run, which
        // resolveIntegrityPolicy would correctly convict as a stripped-marker
        // conflict. Built through the same parseJournalEvent + eventLine
        // primitive as appendJournal, so the hash chain and schema are
        // identical to every later event; the engine's lazy emit skips once
        // the marker is present, never duplicating it.
        const genesis: JournalEvent = {
          seq: 1,
          ts: now,
          type: 'run.initialized',
          actor: 'engine',
          payload: {
            runId: input.runId,
            snapshotId: snapshot.snapshotId,
            integrity: INTEGRITY_POLICY,
          },
        };
        const genesisParsed = parseJournalEvent(genesis);
        if (!genesisParsed.ok) {
          return failRes(schemaErr(genesisParsed.issues, 'journal event'));
        }
        const journalSeed = eventLine(genesisParsed.value) + '\n';

        // No managed artifact may already exist — never clobber a run.
        for (const p of [
          STORE_PATHS.council,
          STORE_PATHS.state,
          STORE_PATHS.objective,
          STORE_PATHS.snapshot,
          STORE_PATHS.journal,
          STORE_PATHS.integrityIndex,
        ]) {
          if (existsSync(path.join(runDirAbs, p))) {
            return failRes(
              ioErr('already_initialized', `refusing to overwrite existing ${p}`),
            );
          }
        }

        const written: string[] = [];
        const write = async (rel: string, data: string): Promise<Result<void>> => {
          const abs = path.join(runDirAbs, rel);
          const r = await atomicWrite(abs, Buffer.from(data, 'utf8'));
          if (r.ok) written.push(abs);
          return r;
        };

        const steps: [string, string][] = [
          [STORE_PATHS.council, JSON.stringify(meta, null, 2) + '\n'],
          [STORE_PATHS.state, JSON.stringify(stateParsed.value, null, 2) + '\n'],
          [STORE_PATHS.objective, input.objective + '\n'],
          [STORE_PATHS.snapshot, JSON.stringify(snapshot, null, 2) + '\n'],
          [STORE_PATHS.journal, journalSeed],
          [STORE_PATHS.integrityIndex, JSON.stringify(emptyIndex(input.runId), null, 2) + '\n'],
        ];
        for (const [rel, data] of steps) {
          const r = await write(rel, data);
          if (!r.ok) {
            // Roll back what THIS call created — never leave half a run.
            for (const f of written) await fsp.unlink(f).catch(() => {});
            return r;
          }
        }
        runIdCache = input.runId;
        return ok(undefined);
      }),

    loadState: async () => {
      const got = await loadConfigAndRunId();
      if (!got.ok) return got;
      return ok(got.value.state);
    },

    saveState: async (state) => {
      const init = await requireInitialized();
      if (!init.ok) return init;
      const parsed = parseCouncilState(state);
      if (!parsed.ok) return failRes(schemaErr(parsed.issues, 'state'));
      const id = await runId();
      if (!id.ok) return id;
      if (parsed.value.runId !== id.value) {
        return failRes(
          ioErr('run_id_mismatch', `state.runId ${parsed.value.runId} != run runId ${id.value}`),
        );
      }
      const resolved = await resolveUnder(STORE_PATHS.state, { forWrite: true });
      if (!resolved.ok) return resolved;
      return atomicWrite(
        resolved.value.abs,
        Buffer.from(JSON.stringify(parsed.value, null, 2) + '\n', 'utf8'),
      );
    },

    withLock: async <T>(fn: () => Promise<Result<T>>): Promise<Result<T>> => {
      if (inLockSession()) {
        // Public surface is non-reentrant: a nested lock would deadlock on
        // the in-process queue, so refuse it honestly.
        return failRes(
          ioErr('lock_nested', 'withLock is not reentrant; nested call refused'),
        );
      }
      return enqueue(async () => {
        const acq = await acquireLock();
        if (!acq.ok) return acq;
        try {
          return await lockScope.run({ depth: 1 }, fn);
        } catch (e) {
          return failRes(ioErr('exception', `withLock callback threw: ${describeErr(e)}`));
        } finally {
          await acq.value.release();
        }
      });
    },

    writeArtifact: async (relPath, data) => {
      const init = await requireInitialized();
      if (!init.ok) return init;
      const resolved = await resolveUnder(relPath, { forWrite: true });
      if (!resolved.ok) return resolved;
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      if (buf.length > MAX_ARTIFACT_BYTES) {
        return failRes(
          ioErr('artifact_too_large', `artifact ${relPath} exceeds ${MAX_ARTIFACT_BYTES} bytes`, {
            relPath,
            bytes: buf.length,
          }),
        );
      }
      return atomicWrite(resolved.value.abs, buf);
    },

    readArtifact: async (relPath) => {
      const init = await requireInitialized();
      if (!init.ok) return init;
      const resolved = await resolveUnder(relPath, { forWrite: false });
      if (!resolved.ok) return resolved;
      try {
        const text = await fsp.readFile(resolved.value.abs, 'utf8');
        return ok(text);
      } catch (e) {
        return failRes(
          ioErr(
            errCode(e) === 'ENOENT' ? 'not_found' : 'read_failed',
            `cannot read artifact ${relPath}: ${describeErr(e)}`,
            { relPath },
          ),
        );
      }
    },

    artifactExists: async (relPath) => {
      const init = await requireInitialized();
      if (!init.ok) return init;
      const resolved = await resolveUnder(relPath, { forWrite: false });
      if (!resolved.ok) return resolved;
      try {
        return ok((await fsp.stat(resolved.value.abs)).isFile());
      } catch {
        return ok(false);
      }
    },

    listArtifacts: async (prefix) => {
      const init = await requireInitialized();
      if (!init.ok) return init;
      let relPrefix = '';
      if (prefix !== '') {
        const pr = assertSafeRelativePath(prefix);
        if (!pr.ok) {
          return failRes(
            err('untrusted_output', `unsafe list prefix ${JSON.stringify(prefix)}`, {
              issues: pr.issues,
              details: { reason: 'unsafe_path', relPath: prefix },
            }),
          );
        }
        relPrefix = pr.value;
      }
      const rootReal = await realpathRoot();
      if (!rootReal.ok) return rootReal;
      const base = relPrefix === '' ? runDirAbs : path.join(runDirAbs, ...relPrefix.split('/'));
      let baseReal: string;
      try {
        baseReal = await fsp.realpath(base);
      } catch (e) {
        if (errCode(e) === 'ENOENT') return ok([]);
        return failRes(ioErr('resolve_failed', `cannot resolve prefix ${prefix}: ${describeErr(e)}`));
      }
      if (!within(rootReal.value, baseReal)) {
        return failRes(
          err('untrusted_output', `list prefix escapes run dir: ${prefix}`, {
            details: { reason: 'symlink_escape', relPath: prefix },
          }),
        );
      }
      const out: string[] = [];
      const walk = async (dirAbs: string, rel: string): Promise<Result<void>> => {
        let entries;
        try {
          entries = await fsp.readdir(dirAbs, { withFileTypes: true });
        } catch (e) {
          return failRes(ioErr('read_failed', `cannot list ${rel || '.'}: ${describeErr(e)}`));
        }
        for (const ent of entries) {
          const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`;
          if (ent.isDirectory()) {
            // Symlinked dirs report isSymbolicLink, not isDirectory — never
            // followed, so listings cannot escape the run dir.
            const r = await walk(path.join(dirAbs, ent.name), childRel);
            if (!r.ok) return r;
          } else if (ent.isFile()) {
            // Hide in-flight atomic temp files and the mutation lock.
            if (childRel === STORE_PATHS.lock) continue;
            if (/\.tmp-\d+-[0-9a-f]+$/.test(ent.name)) continue;
            out.push(childRel);
          }
        }
        return ok(undefined);
      };
      const walked = await walk(baseReal, '');
      if (!walked.ok) return walked;
      const prefixOut = out.map((p) => (relPrefix === '' ? p : `${relPrefix}/${p}`));
      return ok(prefixOut.sort());
    },

    appendJournal: async (events) => {
      if (!Array.isArray(events)) {
        return failRes(
          err('schema_invalid', 'appendJournal expects an array', {
            details: { reason: 'validation_failed' },
          }),
        );
      }
      if (events.length === 0) return ok([]);
      if (events.length > MAX_JOURNAL_EVENTS_PER_APPEND) {
        return failRes(
          err('schema_invalid', `append limited to ${MAX_JOURNAL_EVENTS_PER_APPEND} events`, {
            details: { reason: 'too_many_events', count: events.length },
          }),
        );
      }
      const init = await requireInitialized();
      if (!init.ok) return init;
      return withMutation(async () => {
        const cur = await readJournalRaw();
        if (!cur.ok) return cur as Result<never>; // never extend a corrupt chain

        let seq = cur.value.events.length;
        let prev = cur.value.lastLine === null ? undefined : lineHash(cur.value.lastLine);
        const stored: JournalEvent[] = [];
        const lines: string[] = [];
        for (const e of events) {
          const candidate: JournalEvent = {
            seq: seq + 1,
            ts: e.ts,
            type: e.type,
            actor: e.actor,
          };
          if (e.phase !== undefined) candidate.phase = e.phase;
          if (e.round !== undefined) candidate.round = e.round;
          if (e.participantId !== undefined) candidate.participantId = e.participantId;
          if (e.payload !== undefined) candidate.payload = e.payload;
          if (prev !== undefined) candidate.prevHash = prev;
          const parsed = parseJournalEvent(candidate);
          if (!parsed.ok) {
            return failRes(schemaErr(parsed.issues, 'journal event'));
          }
          let line: string;
          try {
            line = eventLine(candidate);
          } catch (e2) {
            return failRes(
              err('schema_invalid', `journal event payload is not serializable: ${describeErr(e2)}`, {
                details: { reason: 'validation_failed' },
              }),
            );
          }
          if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
            return failRes(
              err('schema_invalid', `journal event exceeds ${MAX_EVENT_LINE_BYTES} bytes`, {
                details: { reason: 'event_too_large', seq: candidate.seq },
              }),
            );
          }
          stored.push(candidate);
          lines.push(line);
          seq++;
          prev = lineHash(line);
        }
        const block = lines.join('\n') + '\n';
        try {
          // Same durability discipline as atomicWrite: fsync before success so
          // a journaled intent/effect survives an OS crash — the engine acts on
          // what the journal records, so a lost tail must not be possible.
          const fh = await fsp.open(path.join(runDirAbs, STORE_PATHS.journal), 'a');
          try {
            // 'a' mode guarantees every write lands at EOF; writeFully loops
            // until the whole block is out; fsync before reporting success.
            await writeFully(fh, Buffer.from(block, 'utf8'));
            await fh.sync();
          } finally {
            await fh.close();
          }
        } catch (e2) {
          return failRes(ioErr('write_failed', `journal append failed: ${describeErr(e2)}`));
        }
        return ok(stored);
      });
    },

    readJournal: async () => {
      const init = await requireInitialized();
      if (!init.ok) return init;
      return withMutation(async () => {
        const cur = await readJournalRaw();
        if (!cur.ok) return cur as Result<never>;
        return ok(cur.value.events);
      });
    },

    writeProposedRoster: async (roster) => {
      const ctx = await loadConfigAndRunId();
      if (!ctx.ok) return ctx;
      const parsed = parseProposedRoster(roster, {
        runId: ctx.value.runId,
        requestedPerspectives: ctx.value.state.config.requestedPerspectives,
      });
      if (!parsed.ok) {
        return failRes(
          err('roster_invalid', 'proposed roster failed validation', { issues: parsed.issues }),
        );
      }
      const resolved = await resolveUnder(STORE_PATHS.proposedRoster, { forWrite: true });
      if (!resolved.ok) return resolved;
      return atomicWrite(
        resolved.value.abs,
        Buffer.from(JSON.stringify(parsed.value, null, 2) + '\n', 'utf8'),
      );
    },

    readProposedRoster: async () => {
      const ctx = await loadConfigAndRunId();
      if (!ctx.ok) return ctx;
      const loaded = await readJson(STORE_PATHS.proposedRoster);
      if (!loaded.ok) return loaded;
      const parsed = parseProposedRoster(loaded.value.raw, {
        runId: ctx.value.runId,
        requestedPerspectives: ctx.value.state.config.requestedPerspectives,
      });
      if (!parsed.ok) {
        return failRes(
          err('roster_invalid', 'stored roster.proposed.json failed validation', {
            issues: parsed.issues,
          }),
        );
      }
      return ok(parsed.value);
    },

    writeApprovedRoster: async (roster) => {
      const ctx = await loadConfigAndRunId();
      if (!ctx.ok) return ctx;
      const proposed = await loadProposed(ctx.value);
      if (!proposed.ok) return proposed;
      const parsed = parseApprovedRoster(roster, {
        runId: ctx.value.runId,
        proposed: proposed.value,
        config: ctx.value.state.config,
      });
      if (!parsed.ok) {
        return failRes(
          err('roster_invalid', 'approved roster failed validation', { issues: parsed.issues }),
        );
      }
      const resolved = await resolveUnder(STORE_PATHS.approvedRoster, { forWrite: true });
      if (!resolved.ok) return resolved;
      return atomicWrite(
        resolved.value.abs,
        Buffer.from(JSON.stringify(parsed.value, null, 2) + '\n', 'utf8'),
      );
    },

    readApprovedRoster: async () => {
      const ctx = await loadConfigAndRunId();
      if (!ctx.ok) return ctx;
      const proposed = await loadProposed(ctx.value);
      if (!proposed.ok) return proposed;
      const loaded = await readJson(STORE_PATHS.approvedRoster);
      if (!loaded.ok) return loaded;
      const parsed = parseApprovedRoster(loaded.value.raw, {
        runId: ctx.value.runId,
        proposed: proposed.value,
        config: ctx.value.state.config,
      });
      if (!parsed.ok) {
        return failRes(
          err('roster_invalid', 'stored roster.approved.json failed validation', {
            issues: parsed.issues,
          }),
        );
      }
      return ok(parsed.value);
    },

    writeApproval: async (record, binding) => {
      const ctx = await loadConfigAndRunId();
      if (!ctx.ok) return ctx;
      const rec = parseApprovalRecord(record);
      if (!rec.ok) return failRes(schemaErr(rec.issues, 'approval record'));
      const bin = parseApprovalBinding(binding);
      if (!bin.ok) return failRes(schemaErr(bin.issues, 'approval binding'));
      const expected = canonicalApprovalHash(bin.value);
      if (rec.value.hash !== expected) {
        return failRes(
          err('approval_stale', 'approval hash does not match the supplied binding', {
            details: {
              reason: 'hash_mismatch',
              expected,
              got: rec.value.hash,
            },
          }),
        );
      }
      if (bin.value.runId !== ctx.value.runId) {
        return failRes(
          err('approval_stale', 'approval binding runId does not match this run', {
            details: { reason: 'run_id_mismatch', bindingRunId: bin.value.runId, runId: ctx.value.runId },
          }),
        );
      }
      if (bin.value.snapshotId !== ctx.value.state.snapshotId) {
        return failRes(
          err('approval_stale', 'approval binding snapshotId does not match this run', {
            details: {
              reason: 'snapshot_id_mismatch',
              bindingSnapshotId: bin.value.snapshotId,
              snapshotId: ctx.value.state.snapshotId,
            },
          }),
        );
      }
      const resolved = await resolveUnder(STORE_PATHS.approval, { forWrite: true });
      if (!resolved.ok) return resolved;
      const file = JSON.stringify({ record: rec.value, binding: bin.value }, null, 2) + '\n';
      return atomicWrite(resolved.value.abs, Buffer.from(file, 'utf8'));
    },

    readApproval: async () => {
      const ctx = await loadConfigAndRunId();
      if (!ctx.ok) return ctx;
      const loaded = await readJson(STORE_PATHS.approval);
      if (!loaded.ok) return loaded;
      const raw = loaded.value.raw;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return failRes(ioErr('bad_json', 'approval.json is not an object'));
      }
      const obj = raw as Record<string, unknown>;
      const rec = parseApprovalRecord(obj.record);
      const bin = parseApprovalBinding(obj.binding);
      if (!rec.ok) return failRes(schemaErr(rec.issues, 'stored approval record'));
      if (!bin.ok) return failRes(schemaErr(bin.issues, 'stored approval binding'));
      if (rec.value.hash !== canonicalApprovalHash(bin.value)) {
        return failRes(
          err('approval_stale', 'stored approval hash does not match its binding', {
            details: { reason: 'hash_mismatch' },
          }),
        );
      }
      return ok({ record: rec.value, binding: bin.value });
    },

    readSnapshot: async () => {
      const init = await requireInitialized();
      if (!init.ok) return init;
      const loaded = await readJson(STORE_PATHS.snapshot);
      if (!loaded.ok) return loaded;
      const parsed = parseSourceSnapshot(loaded.value.raw);
      if (!parsed.ok) return failRes(schemaErr(parsed.issues, 'snapshot.json'));
      return ok(parsed.value);
    },

    verifySourceSnapshot: async (): Promise<Result<SnapshotDrift>> => {
      const loaded = await readJson(STORE_PATHS.snapshot);
      if (!loaded.ok) return loaded;
      const parsed = parseSourceSnapshot(loaded.value.raw);
      if (!parsed.ok) return failRes(schemaErr(parsed.issues, 'snapshot.json'));
      const snapshot = parsed.value;

      // Manifest integrity: the stored headHash must commit to the stored
      // manifest exactly — a rewritten snapshot.json is not "drift", it is
      // corruption and reported as an error.
      const recomputed = manifestHeadHash(snapshot.files);
      if (recomputed !== snapshot.headHash) {
        return failRes(
          err('snapshot_drift', 'snapshot.json manifest does not match its headHash', {
            details: {
              reason: 'manifest_integrity',
              expected: snapshot.headHash,
              actual: recomputed,
            },
          }),
        );
      }

      const ctx = await loadConfigAndRunId();
      if (!ctx.ok) return ctx;
      if (ctx.value.state.snapshotId !== snapshot.snapshotId) {
        return failRes(
          err('snapshot_drift', 'state.snapshotId does not match snapshot.json', {
            details: {
              reason: 'snapshot_id_mismatch',
              stateSnapshotId: ctx.value.state.snapshotId,
              snapshotId: snapshot.snapshotId,
            },
          }),
        );
      }

      // Re-scan the live tree under the SAME rules (default limits,
      // identical exclusion/symlink policy). An unreadable/oversize tree is
      // an honest error, never a fabricated drift verdict.
      let targetReal: string;
      try {
        targetReal = await fsp.realpath(snapshot.targetRoot);
      } catch (e) {
        return failRes(
          ioErr('root_unreadable', `cannot canonicalize snapshot target: ${describeErr(e)}`, {
            targetRoot: snapshot.targetRoot,
          }),
        );
      }
      const scanned = await scanSourceTree(targetReal, { limits: DEFAULT_SNAPSHOT_LIMITS });
      if (!scanned.ok) return scanned;
      const changed = diffSnapshotFiles(snapshot.files, scanned.value.files);
      return ok({ drift: changed.length > 0, changed });
    },
  };

  return store;
}

export type { Store, StoreOpenOptions };
