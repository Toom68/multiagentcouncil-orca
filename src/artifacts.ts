/**
 * Exact-byte integrity receipts for managed run artifacts (clm_0004/0032/0041).
 *
 * Problem: after a worker output is admitted, a work envelope built, the claim
 * ledger rewritten, or a report emitted, later phases re-read those bytes with
 * no binding to what was actually admitted/written — a post-admission rewrite
 * (tamper, accident, lingering worker) is consumed silently.
 *
 * Design (approved):
 *  - Receipts {path,category,sha256,bytes,version} bind the EXACT bytes held at
 *    write/admission time — never a re-read (no hash/write races).
 *  - The JOURNAL is authoritative: receipt fields ride existing event payloads
 *    (artifact.admitted / artifact.written / envelope.built / claim.updated /
 *    report.written) inside the hash-chained, fsynced journal. Consumption
 *    verification uses collectReceipts(journalEvents) — no file alone can
 *    invent a receipt, and a changed managed artifact fails visibly.
 *  - integrity/index.json is a REBUILDABLE PROJECTION: a lock-free lookup for
 *    read-only audit and an advisory cross-check, never consulted as
 *    authorization by the consuming engine. rebuildIndexFromEvents() resyncs
 *    it from the journal; tampering only the index fails or is rebuilt.
 *  - Policy marker: new runs stamp integrityPolicy 'receipts-v1' into
 *    council.json at initialize (before any managed content) plus an empty
 *    index, and the engine mirrors it on the run.initialized journal event.
 *    Metadata and journal markers must AGREE — a stripped marker on either
 *    side is a policy conflict, never a silent downgrade to 'legacy'. Legacy
 *    runs (no marker anywhere) are honestly untracked: every verdict is
 *    'untracked' and nothing is retroactively verified.
 *
 * Crash ordering (write bytes → update index → journal receipt at flush):
 *   a) crash after artifact write, before index/journal → the file holds
 *      unreceipted bytes; verify reports 'mismatch'/'untracked'. Recovery:
 *      the engine replays the step (nothing durable past the write landed),
 *      regenerates the content and records a fresh receipt — versioned
 *      categories absorb this; immutable categories surface receipt_conflict
 *      instead of laundering new bytes. Never a silent new receipt.
 *   b) crash after index update, before journal append → the index leads the
 *      journal (projection ahead of authority): entries still verify vs the
 *      index on the audit path, and a journal-bound rebuild drops the pending
 *      entries honestly. Journal-bound engine verification stays exact.
 *   c) crash mid-index write → atomic tmp+rename leaves the index intact or
 *      absent; a missing index under a v1 marker is a visible error, and
 *      rebuildIndexFromEvents restores the projection.
 *  For immutable categories recordManagedWrite compares existing bytes BEFORE
 *  writing: a different-bytes overwrite of a receipted path is refused
 *  (receipt_conflict) so the original is preserved — rejected-archive
 *  originals and admitted worker outputs can never be laundered by rewrite.
 *
 * Limits (documented, per the threat boundary): a hostile same-UID writer can
 * coherently rewrite artifact + index + journal — no same-UID sandbox or
 * coherent-rewrite defense is claimed. Receipts detect incoherent tampering,
 * torn writes and accidental mutation, and they prove WHICH bytes were
 * admitted; they do not prove admitted content was true.
 *
 * This module never reads or appends the journal and never takes the store
 * lock: no recursive readJournal, no competing append writer, and verify/
 * audit reads never block a legitimate pending runner write.
 */

import { createHash } from 'node:crypto';

import type {
  CouncilError,
  CouncilRunId,
  JournalEvent,
  ParseResult,
  Result,
  Store,
  ValidationIssue,
} from './contracts.js';
import { SCHEMA_VERSION } from './contracts.js';
import { assertSafeRelativePath, err } from './validation.js';

// ─── Policy marker and index location ────────────────────────────────────────

/** Integrity policy identifier stamped into council.json + index + journal. */
export const INTEGRITY_POLICY = 'receipts-v1' as const;
export type IntegrityPolicy = typeof INTEGRITY_POLICY | 'legacy';

/** Run-relative path of the rebuildable receipt projection. */
export const INTEGRITY_INDEX_PATH = 'integrity/index.json';

/**
 * Journal payload field carrying the policy marker: the engine emits
 * run.initialized with `integrity: 'receipts-v1'` on tracked runs.
 */
export const INTEGRITY_MARKER_FIELD = 'integrity';

/** Bounded index size: a run produces far fewer managed artifacts than this. */
const MAX_INDEX_ENTRIES = 4096;
/**
 * Files that may never carry receipts (self-referential or special).
 * '__proto__' is refused because assigning it as a Record key would invoke
 * the prototype setter rather than store an entry.
 */
const FORBIDDEN_RECEIPT_PATHS: ReadonlySet<string> = new Set([
  INTEGRITY_INDEX_PATH,
  'events.jsonl',
  'lock',
  '__proto__',
]);

// ─── Categories ──────────────────────────────────────────────────────────────

/**
 * Bounded receipt categories.
 *  - worker_output: admitted worker outputs — immutable once receipted.
 *  - envelope: runner-built work envelopes — immutable once built.
 *  - archive: rejected/* preserved originals + diagnostics — immutable.
 *  - ledger: claims.json — versioned; consume the LATEST receipt only.
 *  - report: report.json/report.md/summary.md — versioned.
 *  - runner: other runner-managed writes (specs/, supervisor/, meta.json) — versioned.
 */
export type ReceiptCategory =
  | 'worker_output'
  | 'envelope'
  | 'archive'
  | 'ledger'
  | 'report'
  | 'runner';

export const RECEIPT_CATEGORIES: readonly ReceiptCategory[] = [
  'worker_output',
  'envelope',
  'archive',
  'ledger',
  'report',
  'runner',
] as const;

/**
 * Categories whose bytes are fixed for the life of the path: a second
 * different-bytes receipt is a visible conflict, not a new version.
 */
export const IMMUTABLE_CATEGORIES: ReadonlySet<ReceiptCategory> = new Set([
  'worker_output',
  'envelope',
  'archive',
]);

// ─── Receipt + index types ───────────────────────────────────────────────────

export interface ArtifactReceipt {
  /** Safe-relative artifact path inside the run dir. */
  path: string;
  category: ReceiptCategory;
  /** sha256 hex of the exact bytes. */
  sha256: string;
  /** Byte length of the exact bytes. */
  bytes: number;
  /** Per-path version, >= 1; strict increase for versioned categories. */
  version: number;
}

export interface IndexEntry extends ArtifactReceipt {
  /** ISO-8601 time the projection recorded this receipt. */
  recordedAt: string;
}

/** integrity/index.json — rebuildable projection of journaled receipts. */
export interface IntegrityIndex {
  schemaVersion: typeof SCHEMA_VERSION;
  policy: typeof INTEGRITY_POLICY;
  runId: CouncilRunId;
  updatedAt: string;
  /** path → latest receipt known to the projection. */
  entries: Record<string, IndexEntry>;
}

export type VerifyStatus = 'ok' | 'mismatch' | 'missing' | 'untracked';

export interface VerifyVerdict {
  status: VerifyStatus;
  path: string;
  /** Which receipt source produced the verdict — journal is authoritative. */
  source: 'journal' | 'index' | 'none';
  /** The receipt consulted, when one existed. */
  receipt?: ArtifactReceipt;
  actualSha256?: string;
  actualBytes?: number;
}

// ─── Result plumbing ─────────────────────────────────────────────────────────

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = (error: CouncilError): Result<never> => ({ ok: false, error });

const ioErr = (
  reason: string,
  message: string,
  details: Record<string, unknown> = {},
): CouncilError => err('io_error', message, { details: { reason, ...details } });

const describeErr = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Hash the exact bytes at hand — hex digest + byte length. */
export function sha256Bytes(bytes: string | Uint8Array): { sha256: string; bytes: number } {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

// ─── Pure receipt helpers ────────────────────────────────────────────────────

/** Build a receipt over the exact bytes held by the caller. */
export function receiptForBytes(
  relPath: string,
  bytes: string | Uint8Array,
  category: ReceiptCategory,
  version = 1,
): Result<ArtifactReceipt> {
  const pr = assertSafeRelativePath(relPath);
  if (!pr.ok) {
    return failRes(
      err('untrusted_output', `unsafe receipt path ${JSON.stringify(relPath)}`, {
        issues: pr.issues,
        details: { reason: 'unsafe_path', relPath },
      }),
    );
  }
  if (FORBIDDEN_RECEIPT_PATHS.has(pr.value)) {
    return failRes(
      err('untrusted_output', `receipts are forbidden for ${pr.value}`, {
        details: { reason: 'forbidden_receipt_path', relPath: pr.value },
      }),
    );
  }
  if (!RECEIPT_CATEGORIES.includes(category)) {
    return failRes(
      err('schema_invalid', `unknown receipt category ${JSON.stringify(category)}`, {
        details: { reason: 'bad_category', category },
      }),
    );
  }
  if (!Number.isInteger(version) || version < 1) {
    return failRes(
      err('schema_invalid', `receipt version must be a positive integer (got ${version})`, {
        details: { reason: 'bad_version', version },
      }),
    );
  }
  const { sha256, bytes: len } = sha256Bytes(bytes);
  return ok({ path: pr.value, category, sha256, bytes: len, version });
}

/**
 * Journal payload fields for a receipt — merged by the caller into existing
 * event types (artifact.admitted, artifact.written, envelope.built,
 * claim.updated, report.written). Additive on the open payload record.
 */
export function receiptJournalFields(receipt: ArtifactReceipt): Record<string, unknown> {
  return {
    path: receipt.path,
    category: receipt.category,
    sha256: receipt.sha256,
    bytes: receipt.bytes,
    version: receipt.version,
    [INTEGRITY_MARKER_FIELD]: INTEGRITY_POLICY,
  };
}

/**
 * Extract a receipt from a journal event payload, or null when the payload
 * does not carry a well-formed receipts-v1 receipt. A payload that LOOKS
 * like a receipt (has path+sha256) but is malformed is reported via
 * `malformed` so collectReceipts can surface it as an anomaly instead of
 * silently ignoring it.
 */
export function receiptFromJournalPayload(
  payload: unknown,
): { receipt: ArtifactReceipt | null; malformed: string | null } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { receipt: null, malformed: null };
  }
  const p = payload as Record<string, unknown>;
  if (p[INTEGRITY_MARKER_FIELD] !== INTEGRITY_POLICY) {
    return { receipt: null, malformed: null };
  }
  const looks = p.path !== undefined || p.sha256 !== undefined;
  if (
    typeof p.path !== 'string' ||
    typeof p.sha256 !== 'string' ||
    !SHA256_HEX.test(p.sha256) ||
    typeof p.bytes !== 'number' ||
    !Number.isInteger(p.bytes) ||
    p.bytes < 0 ||
    typeof p.version !== 'number' ||
    !Number.isInteger(p.version) ||
    p.version < 1 ||
    typeof p.category !== 'string' ||
    !(RECEIPT_CATEGORIES as readonly string[]).includes(p.category)
  ) {
    return {
      receipt: null,
      malformed: looks ? 'receipt fields present but malformed' : null,
    };
  }
  if (assertSafeRelativePath(p.path).ok !== true) {
    return { receipt: null, malformed: 'receipt path fails safety rules' };
  }
  return {
    receipt: {
      path: p.path,
      category: p.category as ReceiptCategory,
      sha256: p.sha256,
      bytes: p.bytes,
      version: p.version,
    },
    malformed: null,
  };
}

/**
 * Fold journaled receipt payloads into the latest receipt per path.
 *
 * Sequence rules (a receipt stream is an append-only version chain):
 *  - A malformed receipt-looking payload → anomaly, entry unchanged.
 *  - Category change on an existing path → anomaly, keep the FIRST receipt
 *    (a worker_output cannot launder into a versioned category).
 *  - version < current, or same version with different bytes → anomaly,
 *    keep the existing receipt (never rewrite history).
 *  - same version + same bytes → idempotent re-record, no anomaly.
 *  - IMMUTABLE category: any different-bytes later receipt → anomaly,
 *    keep the first receipt (consumption fails on the new bytes).
 *  - VERSIONED category: strictly greater version supersedes; a version
 *    skipping ahead (> +1) is accepted but noted (a journaled receipt was
 *    lost to an append gap — suspicious, not silently fine).
 */
export function collectReceipts(events: readonly JournalEvent[]): {
  receipts: Map<string, ArtifactReceipt>;
  anomalies: string[];
} {
  const receipts = new Map<string, ArtifactReceipt>();
  const anomalies: string[] = [];
  for (const e of events) {
    const { receipt, malformed } = receiptFromJournalPayload(e.payload);
    if (malformed !== null) {
      anomalies.push(`seq ${e.seq}: malformed receipt payload on ${e.type} (${malformed})`);
      continue;
    }
    if (receipt === null) continue;
    const prev = receipts.get(receipt.path);
    if (prev === undefined) {
      receipts.set(receipt.path, receipt);
      continue;
    }
    if (prev.category !== receipt.category) {
      anomalies.push(
        `seq ${e.seq}: category change on ${receipt.path} (${prev.category} → ${receipt.category}) — keeping first receipt`,
      );
      continue;
    }
    if (receipt.version < prev.version) {
      anomalies.push(
        `seq ${e.seq}: version regression on ${receipt.path} (v${prev.version} → v${receipt.version}) — keeping v${prev.version}`,
      );
      continue;
    }
    if (receipt.version === prev.version) {
      if (receipt.sha256 !== prev.sha256 || receipt.bytes !== prev.bytes) {
        anomalies.push(
          `seq ${e.seq}: same-version different-bytes receipt on ${receipt.path} (v${prev.version}) — keeping first`,
        );
      }
      continue;
    }
    // receipt.version > prev.version
    if (IMMUTABLE_CATEGORIES.has(prev.category)) {
      anomalies.push(
        `seq ${e.seq}: re-minted immutable ${receipt.path} v${prev.version} → v${receipt.version} — keeping v${prev.version}`,
      );
      continue;
    }
    if (receipt.version !== prev.version + 1) {
      anomalies.push(
        `seq ${e.seq}: version skip on ${receipt.path} (v${prev.version} → v${receipt.version}) — receipt chain has a gap`,
      );
    }
    receipts.set(receipt.path, receipt);
  }
  return { receipts, anomalies };
}

/**
 * Verify exact bytes against a receipt. A missing receipt yields 'untracked'
 * (the caller decides severity: a managed path on a v1 run expects one; a
 * legacy run expects none).
 */
export function verifyBytes(
  receipt: ArtifactReceipt | null | undefined,
  relPath: string,
  bytes: string | Uint8Array,
  source: 'journal' | 'index' | 'none' = 'none',
): VerifyVerdict {
  if (receipt === null || receipt === undefined) {
    return { status: 'untracked', path: relPath, source };
  }
  const { sha256, bytes: len } = sha256Bytes(bytes);
  if (sha256 === receipt.sha256 && len === receipt.bytes) {
    return { status: 'ok', path: relPath, source, receipt };
  }
  return {
    status: 'mismatch',
    path: relPath,
    source,
    receipt,
    actualSha256: sha256,
    actualBytes: len,
  };
}

/**
 * Would recording `next` alongside `existing` be legal? Same-hash/same-version
 * is an idempotent re-record; immutable-category different bytes is a hard
 * conflict; versioned categories record cleanly. Used to guard both index and
 * journal-derived receipts before minting.
 */
export function checkRecordable(
  existing: ArtifactReceipt | undefined,
  next: ArtifactReceipt,
): Result<void> {
  if (existing === undefined) return ok(undefined);
  if (existing.category !== next.category) {
    return failRes(
      err('io_error', `receipt category conflict on ${next.path} (${existing.category} → ${next.category})`, {
        details: {
          reason: 'receipt_conflict',
          kind: 'category_change',
          path: next.path,
          existing,
          next,
        },
      }),
    );
  }
  if (existing.sha256 === next.sha256 && existing.bytes === next.bytes) {
    return ok(undefined); // idempotent re-record of identical bytes
  }
  if (IMMUTABLE_CATEGORIES.has(next.category)) {
    return failRes(
      err('io_error', `immutable receipt conflict on ${next.path}: different bytes already receipted`, {
        details: {
          reason: 'receipt_conflict',
          kind: 'immutable_rewrite',
          path: next.path,
          existing,
          next,
        },
      }),
    );
  }
  if (next.version <= existing.version) {
    return failRes(
      err('io_error', `versioned receipt on ${next.path} must increase version (${existing.version} → ${next.version})`, {
        details: {
          reason: 'receipt_conflict',
          kind: 'version_regression',
          path: next.path,
          existing,
          next,
        },
      }),
    );
  }
  return ok(undefined);
}

// ─── Policy resolution ───────────────────────────────────────────────────────

export interface PolicySignals {
  /** council.json `integrityPolicy` field value (absent on legacy runs). */
  metaPolicy: unknown;
  /**
   * Does the journal carry the receipts-v1 marker? `null` = journal is empty
   * (pre-first-advance: the marker cannot be judged yet).
   */
  journalHasMarker: boolean | null;
  /** integrity/index.json exists. */
  indexPresent: boolean;
}

/**
 * Marker agreement: metadata and journal must tell the same story.
 *  - meta v1 ∧ (journal empty | journal marked) → 'receipts-v1'
 *  - meta v1 ∧ non-empty unmarked journal → conflict (stripped journal marker)
 *  - meta absent/other ∧ journal marked → conflict (stripped/forged meta)
 *  - meta absent ∧ journal unmarked → 'legacy' (index presence is reported,
 *    never upgrades the verdict)
 *  - meta has any other value → conflict (unknown policy)
 * A conflict is a hard error: callers must reject, never silently downgrade.
 */
export function resolveIntegrityPolicy(
  signals: PolicySignals,
): Result<{ policy: IntegrityPolicy; indexPresent: boolean }> {
  const { metaPolicy, journalHasMarker, indexPresent } = signals;
  const conflict = (detail: string): Result<never> =>
    failRes(
      err('io_error', `integrity policy conflict: ${detail}`, {
        details: {
          reason: 'integrity_policy_conflict',
          metaPolicy,
          journalHasMarker,
          indexPresent,
        },
      }),
    );
  if (metaPolicy === INTEGRITY_POLICY) {
    if (journalHasMarker === false) {
      return conflict('council.json marks receipts-v1 but the journal carries no policy marker');
    }
    return ok({ policy: INTEGRITY_POLICY, indexPresent });
  }
  if (metaPolicy === undefined) {
    if (journalHasMarker === true) {
      return conflict('journal marks receipts-v1 but council.json has no integrityPolicy field');
    }
    return ok({ policy: 'legacy', indexPresent });
  }
  return conflict(`unknown integrityPolicy value ${JSON.stringify(metaPolicy)}`);
}

/** True when any event payload carries the v1 marker (run.initialized first). */
export function journalHasPolicyMarker(events: readonly JournalEvent[]): boolean | null {
  if (events.length === 0) return null;
  return events.some(
    (e) =>
      typeof e.payload === 'object' &&
      e.payload !== null &&
      (e.payload as Record<string, unknown>)[INTEGRITY_MARKER_FIELD] === INTEGRITY_POLICY,
  );
}

// ─── Index parse/serialize ───────────────────────────────────────────────────

export function emptyIndex(runId: CouncilRunId, now: Date = new Date()): IntegrityIndex {
  return {
    schemaVersion: SCHEMA_VERSION,
    policy: INTEGRITY_POLICY,
    runId,
    updatedAt: now.toISOString(),
    entries: {},
  };
}

export function parseIntegrityIndex(raw: unknown): ParseResult<IntegrityIndex> {
  const issues: ValidationIssue[] = [];
  const bad = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message });
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    bad('', 'type', 'integrity index must be an object');
    return { ok: false, issues };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== SCHEMA_VERSION) bad('schemaVersion', 'bad_value', 'unsupported schemaVersion');
  if (o.policy !== INTEGRITY_POLICY) bad('policy', 'bad_value', `expected ${INTEGRITY_POLICY}`);
  if (typeof o.runId !== 'string' || o.runId.length === 0) bad('runId', 'type', 'runId required');
  if (typeof o.updatedAt !== 'string') bad('updatedAt', 'type', 'updatedAt required');
  if (typeof o.entries !== 'object' || o.entries === null || Array.isArray(o.entries)) {
    bad('entries', 'type', 'entries must be an object');
    return { ok: false, issues };
  }
  const entries: Record<string, IndexEntry> = {};
  const entriesObj = (o.entries ?? {}) as Record<string, unknown>;
  for (const [key, v] of Object.entries(entriesObj)) {
    const pr = assertSafeRelativePath(key);
    if (
      !pr.ok ||
      pr.value !== key ||
      FORBIDDEN_RECEIPT_PATHS.has(key) ||
      // '__proto__' assignment would invoke the prototype setter, not store
      // an own entry — a crafted index could otherwise pollute the object.
      key === '__proto__'
    ) {
      bad(`entries.${key}`, 'unsafe_path', 'entry key is not a safe managed path');
      continue;
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      bad(`entries.${key}`, 'type', 'entry must be an object');
      continue;
    }
    const e = v as Record<string, unknown>;
    const ver = e.version;
    const cat = e.category;
    const entOk =
      e.path === key &&
      typeof e.sha256 === 'string' &&
      SHA256_HEX.test(e.sha256) &&
      typeof e.bytes === 'number' &&
      Number.isInteger(e.bytes) &&
      e.bytes >= 0 &&
      typeof ver === 'number' &&
      Number.isInteger(ver) &&
      ver >= 1 &&
      typeof cat === 'string' &&
      (RECEIPT_CATEGORIES as readonly string[]).includes(cat) &&
      typeof e.recordedAt === 'string';
    if (!entOk) {
      bad(`entries.${key}`, 'schema_invalid', 'entry shape/hash/category/version invalid');
      continue;
    }
    entries[key] = {
      path: key,
      category: cat as ReceiptCategory,
      sha256: e.sha256 as string,
      bytes: e.bytes as number,
      version: ver as number,
      recordedAt: e.recordedAt as string,
    };
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schemaVersion: SCHEMA_VERSION,
      policy: INTEGRITY_POLICY,
      runId: o.runId as CouncilRunId,
      updatedAt: o.updatedAt as string,
      entries,
    },
  };
}

// ─── Store-backed helpers (no journal, no locks) ─────────────────────────────

const COUNCIL_META = 'council.json';

/** Read council.json loosely — the same loose shape the store itself parses. */
async function readCouncilMeta(
  store: Store,
): Promise<Result<Record<string, unknown>>> {
  const r = await store.readArtifact(COUNCIL_META);
  if (!r.ok) return r as Result<never>;
  try {
    const v = JSON.parse(r.value);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return failRes(ioErr('council_meta_corrupt', 'council.json is not a JSON object'));
    }
    return ok(v as Record<string, unknown>);
  } catch (e) {
    return failRes(ioErr('bad_json', `cannot parse council.json: ${describeErr(e)}`));
  }
}

async function runIdOf(store: Store): Promise<Result<CouncilRunId>> {
  const meta = await readCouncilMeta(store);
  if (!meta.ok) return meta as Result<never>;
  const id = meta.value.runId;
  if (typeof id !== 'string' || id.length === 0) {
    return failRes(ioErr('council_meta_corrupt', 'council.json missing runId'));
  }
  return ok(id);
}

/**
 * Marker/index signals without touching the journal. `metaPolicy` is returned
 * verbatim (absent marker → undefined) so the caller can run
 * resolveIntegrityPolicy() with the journal signal it already holds; a
 * non-empty journal without the marker is a conflict, never a downgrade.
 */
export async function integrityPolicy(store: Store): Promise<
  Result<{
    metaPolicy: unknown;
    markerPresent: boolean;
    indexPresent: boolean;
  }>
> {
  const meta = await readCouncilMeta(store);
  if (!meta.ok) return meta as Result<never>;
  const metaPolicy = meta.value.integrityPolicy;
  const index = await store.artifactExists(INTEGRITY_INDEX_PATH);
  if (!index.ok) return index as Result<never>;
  return ok({
    metaPolicy,
    markerPresent: metaPolicy !== undefined,
    indexPresent: index.value,
  });
}

/** Load + strictly parse the receipt projection; index file must match runId. */
export async function loadIndex(store: Store): Promise<Result<IntegrityIndex>> {
  const r = await store.readArtifact(INTEGRITY_INDEX_PATH);
  if (!r.ok) {
    return failRes(
      ioErr('index_missing', `integrity index unreadable: ${r.error.message}`, {
        relPath: INTEGRITY_INDEX_PATH,
      }),
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(r.value);
  } catch (e) {
    return failRes(
      ioErr('index_corrupt', `integrity index is not valid JSON: ${describeErr(e)}`),
    );
  }
  const parsed = parseIntegrityIndex(raw);
  if (!parsed.ok) {
    return failRes(
      err('schema_invalid', 'integrity index failed validation', {
        issues: parsed.issues,
        details: { reason: 'index_corrupt' },
      }),
    );
  }
  const id = await runIdOf(store);
  if (!id.ok) return id;
  if (parsed.value.runId !== id.value) {
    return failRes(
      ioErr('index_corrupt', `integrity index runId ${parsed.value.runId} != run ${id.value}`),
    );
  }
  return ok(parsed.value);
}

async function saveIndex(store: Store, index: IntegrityIndex): Promise<Result<void>> {
  const w = await store.writeArtifact(
    INTEGRITY_INDEX_PATH,
    JSON.stringify(index, null, 2) + '\n',
  );
  if (!w.ok) return w;
  return ok(undefined);
}

/**
 * Serialize index read-modify-write per run directory (in-process). Multiple
 * store instances on the same dir chain here; cross-process ordering relies
 * on the caller running inside the engine's mutation lock — this is
 * documented, not a second lock.
 */
const indexChains = new Map<string, Promise<void>>();
function withIndex<T>(store: Store, fn: () => Promise<Result<T>>): Promise<Result<T>> {
  const key = store.runDir;
  const prev = indexChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  indexChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export interface RecordOutcome {
  receipt: ArtifactReceipt;
  /** Non-empty when the projection disagreed with the journal-authoritative prior. */
  indexAnomaly?: string;
}

/**
 * Shared record path: compute the receipt over caller-held bytes, check
 * journal-authoritative `prior` plus the index entry, then update the index.
 * `prior` (collectReceipts output) always wins version allocation — a stale
 * or tampered index can never mint a higher version laundering unknown bytes.
 * Callers should fold each returned receipt into their working `prior` map so
 * back-to-back writes in one step are not mistaken for projection drift.
 */
async function recordInto(
  store: Store,
  relPath: string,
  bytes: string | Uint8Array,
  category: ReceiptCategory,
  prior: Map<string, ArtifactReceipt> | undefined,
  now: Date,
): Promise<Result<RecordOutcome>> {
  // Normalize once so index lookups, prior lookups, and the minted receipt
  // all key on the same canonical relative path.
  const pr = assertSafeRelativePath(relPath);
  if (!pr.ok) {
    return failRes(
      err('untrusted_output', `unsafe artifact path ${JSON.stringify(relPath)}`, {
        issues: pr.issues,
        details: { reason: 'unsafe_path', relPath },
      }),
    );
  }
  const safeRel = pr.value;
  if (FORBIDDEN_RECEIPT_PATHS.has(safeRel)) {
    return failRes(
      err('untrusted_output', `receipts are forbidden for ${safeRel}`, {
        details: { reason: 'forbidden_receipt_path', relPath: safeRel },
      }),
    );
  }
  return withIndex(store, async () => {
    const idx = await loadIndex(store);
    if (!idx.ok) return idx as Result<never>;
    const existing = idx.value.entries[safeRel];
    const base = prior?.get(safeRel);
    // Idempotent re-record: identical bytes under the same category return
    // the standing receipt untouched — no version bump, no projection drift.
    const incoming = sha256Bytes(bytes);
    const same = (r: ArtifactReceipt | undefined): boolean =>
      r !== undefined && r.category === category &&
      r.bytes === incoming.bytes && r.sha256 === incoming.sha256;
    if (same(base)) return ok({ receipt: base! });
    if (base === undefined && same(existing)) return ok({ receipt: existing! });
    // Authoritative prior wins version allocation; an index ahead of it is a
    // projection anomaly (pending same-step receipts are legit when the
    // caller did not fold them into `prior`; a quiescent divergence is real
    // drift). The anomaly is returned for the caller to journal, never hidden.
    const indexAnomaly =
      base !== undefined && existing !== undefined && existing.version > base.version
        ? `index entry for ${safeRel} (v${existing.version}) is ahead of the journaled receipt (v${base.version}) — projection drift; rebuildIndexFromEvents reconciles`
        : undefined;
    const version = Math.max(base?.version ?? 0, existing?.version ?? 0) + 1;
    const r0 = receiptForBytes(safeRel, bytes, category, 1);
    if (!r0.ok) return r0 as Result<never>;
    const next: ArtifactReceipt = { ...r0.value, version };
    for (const guard of [base, existing]) {
      const chk = checkRecordable(guard, next);
      if (!chk.ok) return chk as Result<never>;
    }
    if (Object.keys(idx.value.entries).length >= MAX_INDEX_ENTRIES && existing === undefined) {
      return failRes(
        ioErr('index_full', `integrity index is full (${MAX_INDEX_ENTRIES} entries)`, {
          relPath: safeRel,
        }),
      );
    }
    idx.value.entries[safeRel] = { ...next, recordedAt: now.toISOString() };
    idx.value.updatedAt = now.toISOString();
    const w = await saveIndex(store, idx.value);
    if (!w.ok) return w as Result<never>;
    return ok({ receipt: next, ...(indexAnomaly !== undefined ? { indexAnomaly } : {}) });
  });
}

/**
 * Runner-managed write: persist the exact bytes, then record the receipt in
 * the projection. The caller journals receiptJournalFields(receipt).
 *
 * IMMUTABLE categories are preserve-first: if the path already holds
 * different bytes the write is REFUSED (receipt_conflict) — the original is
 * never overwritten by a receipt-loss/replay ambiguity.
 */
export async function recordManagedWrite(
  store: Store,
  relPath: string,
  bytes: string | Uint8Array,
  category: ReceiptCategory,
  opts: { prior?: Map<string, ArtifactReceipt>; now?: Date } = {},
): Promise<Result<RecordOutcome>> {
  const pr = assertSafeRelativePath(relPath);
  if (!pr.ok) {
    return failRes(
      err('untrusted_output', `unsafe artifact path ${JSON.stringify(relPath)}`, {
        issues: pr.issues,
        details: { reason: 'unsafe_path', relPath },
      }),
    );
  }
  if (FORBIDDEN_RECEIPT_PATHS.has(pr.value)) {
    return failRes(
      err('untrusted_output', `receipts are forbidden for ${pr.value}`, {
        details: { reason: 'forbidden_receipt_path', relPath: pr.value },
      }),
    );
  }
  if (IMMUTABLE_CATEGORIES.has(category)) {
    // Preserve-first: compare existing bytes before any write.
    const existing = await store.readArtifact(pr.value);
    if (existing.ok) {
      const { sha256, bytes: len } = sha256Bytes(existing.value);
      const want = sha256Bytes(bytes);
      if (sha256 !== want.sha256 || len !== want.bytes) {
        return failRes(
          err('io_error', `refusing to overwrite immutable ${pr.value}: existing bytes differ`, {
            details: {
              reason: 'receipt_conflict',
              kind: 'immutable_rewrite',
              path: pr.value,
              existingSha256: sha256,
              incomingSha256: want.sha256,
            },
          }),
        );
      }
      // Identical content already on disk — ensure the receipt exists.
      return recordInto(store, pr.value, bytes, category, opts.prior, opts.now ?? new Date());
    }
    if (existing.error.details?.reason !== 'not_found') return existing as Result<never>;
  }
  const w = await store.writeArtifact(pr.value, bytes);
  if (!w.ok) return w as Result<never>;
  return recordInto(store, pr.value, bytes, category, opts.prior, opts.now ?? new Date());
}

/**
 * Admission record: the artifact already exists (a worker wrote it) and the
 * caller consumed exact bytes. Records the receipt in the projection only —
 * never re-reads, never writes the artifact.
 */
export async function noteReceipt(
  store: Store,
  relPath: string,
  bytesRead: string,
  category: ReceiptCategory = 'worker_output',
  opts: { prior?: Map<string, ArtifactReceipt>; now?: Date } = {},
): Promise<Result<RecordOutcome>> {
  return recordInto(store, relPath, bytesRead, category, opts.prior, opts.now ?? new Date());
}

/**
 * Read a managed artifact and verify its exact bytes against a receipt.
 * Resolution order for the consulted receipt:
 *   opts.receipt → opts.receipts.get(path) → index projection.
 * When opts.receipts is present (even an EMPTY map) the index is NEVER
 * consulted — the journal map is authoritative and a missing key is an
 * honest 'untracked', not a silent pass.
 */
export async function readVerifiedArtifact(
  store: Store,
  relPath: string,
  opts: {
    receipt?: ArtifactReceipt;
    receipts?: Map<string, ArtifactReceipt>;
  } = {},
): Promise<Result<{ text: string; verdict: VerifyVerdict; receipt?: ArtifactReceipt }>> {
  const pr = assertSafeRelativePath(relPath);
  if (!pr.ok) {
    return failRes(
      err('untrusted_output', `unsafe artifact path ${JSON.stringify(relPath)}`, {
        issues: pr.issues,
        details: { reason: 'unsafe_path', relPath },
      }),
    );
  }
  const safeRel = pr.value;
  const textRes = await store.readArtifact(safeRel);
  let receipt: ArtifactReceipt | undefined;
  let source: 'journal' | 'index' | 'none' = 'none';
  if (opts.receipt !== undefined) {
    receipt = opts.receipt;
    source = 'journal';
  } else if (opts.receipts !== undefined) {
    // The caller holds a journal-derived map — it is authoritative and the
    // index is NEVER consulted for a missing key (even on an empty map).
    receipt = opts.receipts.get(safeRel);
    source = 'journal';
  } else {
    const idx = await loadIndex(store);
    if (!idx.ok) return idx as Result<never>;
    receipt = idx.value.entries[safeRel];
    source = 'index';
  }
  if (!textRes.ok) {
    if (textRes.error.details?.reason === 'not_found' && receipt !== undefined) {
      return ok({
        text: '',
        verdict: { status: 'missing', path: safeRel, source, receipt },
        receipt,
      });
    }
    return textRes as Result<never>;
  }
  const verdict = verifyBytes(receipt, safeRel, textRes.value, source);
  return ok({
    text: textRes.value,
    verdict,
    ...(receipt !== undefined ? { receipt } : {}),
  });
}

// ─── Audit (read-only; never writes) ─────────────────────────────────────────

export interface AuditEntry {
  path: string;
  category: ReceiptCategory;
  version: number;
  recordedSha256: string;
  recordedBytes: number;
  exists: boolean;
  actualSha256?: string;
  actualBytes?: number;
  /** ok | changed | missing | index_only (no journaled receipt when bound) */
  status: 'ok' | 'changed' | 'missing' | 'index_only';
}

export interface IntegrityAudit {
  policy: IntegrityPolicy | 'conflict';
  markerPresent: boolean;
  indexPresent: boolean;
  indexStatus: 'ok' | 'missing' | 'corrupt' | 'unverified';
  /** index↔journal binding: 'bound' when events were supplied, 'unbound' otherwise. */
  journalBinding: 'bound' | 'unbound';
  artifacts: AuditEntry[];
  /** Files under the run dir that look managed but carry no receipt. */
  untracked: string[];
  /** Receipts journaled but absent from the index (stale projection). */
  journalOnly: string[];
  anomalies: string[];
  summary: {
    tracked: number;
    verified: number;
    changed: number;
    missing: number;
    untracked: number;
    legacy: boolean;
  };
}

/** Top-level files that are managed but verified by OTHER mechanisms. */
const EXCLUDED_UNTRACKED = new Set([
  'council.json',
  'state.json',
  'events.jsonl',
  'lock',
  'objective.md',
  'snapshot.json',
  'roster.proposed.json',
  'roster.approved.json',
  'approval.json',
  'meta.json',
]);
const MAX_AUDIT_FILES = 8192;

/**
 * Read-only managed-artifact audit for `council verify`/`status`. With
 * `opts.events` (the journal the caller already holds) every index entry and
 * journal receipt is cross-bound — an index-only receipt is reported, a
 * journaled receipt missing from the index is 'journalOnly'. Without events
 * the audit marks itself 'unbound' honestly rather than claiming authority.
 */
export async function verifyManagedArtifacts(
  store: Store,
  opts: { events?: readonly JournalEvent[]; now?: Date } = {},
): Promise<Result<IntegrityAudit>> {
  const pol = await integrityPolicy(store);
  if (!pol.ok) return pol as Result<never>;
  const { metaPolicy, markerPresent, indexPresent } = pol.value;
  const journalMarker = opts.events !== undefined ? journalHasPolicyMarker(opts.events) : null;
  const resolved = resolveIntegrityPolicy({
    metaPolicy,
    journalHasMarker: journalMarker,
    indexPresent,
  });
  // Policy conflicts are reported, not thrown: the audit must describe a
  // broken run, not refuse to describe it.
  const policy: IntegrityAudit['policy'] = !resolved.ok
    ? 'conflict'
    : resolved.value.policy === INTEGRITY_POLICY
      ? INTEGRITY_POLICY
      : 'legacy';
  const policyError = !resolved.ok ? resolved.error.message : undefined;

  const anomalies: string[] = [];
  if (policyError !== undefined) anomalies.push(policyError);

  const idx = indexPresent ? await loadIndex(store) : null;
  const indexStatus: IntegrityAudit['indexStatus'] = !indexPresent
    ? 'missing'
    : idx !== null && idx.ok
      ? opts.events !== undefined
        ? 'ok'
        : 'unverified'
      : 'corrupt';
  const entries = idx !== null && idx.ok ? idx.value.entries : {};

  const journalBound = opts.events !== undefined;
  const collected = journalBound ? collectReceipts(opts.events!) : null;
  const journalReceipts = collected?.receipts ?? null;
  if (collected !== null) anomalies.push(...collected.anomalies);

  const artifacts: AuditEntry[] = [];
  for (const ent of Object.values(entries)) {
    const jr = journalReceipts?.get(ent.path);
    // Index↔journal drift: a bound projection that disagrees with the
    // authoritative receipt is suspect (tamper or crash mid-record).
    if (jr !== undefined && jr !== null &&
        (jr.sha256 !== ent.sha256 || jr.bytes !== ent.bytes || jr.version !== ent.version)) {
      anomalies.push(
        `index entry for ${ent.path} diverges from the journaled receipt ` +
        `(index v${ent.version} ${ent.sha256.slice(0, 12)}… vs journal v${jr.version} ${jr.sha256.slice(0, 12)}…)`, 
      );
    }
    const base: Omit<AuditEntry, 'status' | 'exists' | 'actualSha256' | 'actualBytes'> = {
      path: ent.path,
      category: ent.category,
      version: ent.version,
      recordedSha256: ent.sha256,
      recordedBytes: ent.bytes,
    };
    const r = await store.readArtifact(ent.path);
    if (!r.ok) {
      artifacts.push({ ...base, exists: false, status: 'missing' });
      continue;
    }
    const { sha256, bytes: len } = sha256Bytes(r.value);
    const matchesIndex = sha256 === ent.sha256 && len === ent.bytes;
    let status: AuditEntry['status'];
    if (journalBound && jr === undefined) {
      status = 'index_only';
    } else if (journalBound && jr !== undefined && (sha256 !== jr.sha256 || len !== jr.bytes)) {
      status = 'changed';
    } else {
      status = matchesIndex ? 'ok' : 'changed';
    }
    artifacts.push({ ...base, exists: true, status, actualSha256: sha256, actualBytes: len });
  }

  const journalOnly: string[] = [];
  if (journalReceipts !== null) {
    for (const [p, jr] of journalReceipts) {
      const ie = entries[p];
      if (ie === undefined) {
        journalOnly.push(p);
        // Surface journaled receipts even when the index lost them — the
        // file still verifies against the authoritative record.
        const r = await store.readArtifact(p);
        const base = {
          path: p,
          category: jr.category,
          version: jr.version,
          recordedSha256: jr.sha256,
          recordedBytes: jr.bytes,
        };
        if (!r.ok) {
          artifacts.push({ ...base, exists: false, status: 'missing' });
        } else {
          const { sha256, bytes: len } = sha256Bytes(r.value);
          artifacts.push({
            ...base,
            exists: true,
            status: sha256 === jr.sha256 && len === jr.bytes ? 'ok' : 'changed',
            actualSha256: sha256,
            actualBytes: len,
          });
        }
      }
    }
    journalOnly.sort();
  }

  const untracked: string[] = [];
  const listed = await store.listArtifacts('');
  if (listed.ok) {
    for (const p of listed.value.slice(0, MAX_AUDIT_FILES)) {
      if (p === INTEGRITY_INDEX_PATH || EXCLUDED_UNTRACKED.has(p)) continue;
      const receipted = entries[p] !== undefined || journalReceipts?.has(p) === true;
      if (!receipted) untracked.push(p);
    }
    untracked.sort();
  }

  const summary = {
    tracked: artifacts.length,
    verified: artifacts.filter((a) => a.status === 'ok').length,
    changed: artifacts.filter((a) => a.status === 'changed').length,
    missing: artifacts.filter((a) => a.status === 'missing').length,
    untracked: untracked.length,
    legacy: policy === 'legacy',
  };
  return ok({
    policy,
    markerPresent,
    indexPresent,
    indexStatus,
    journalBinding: journalBound ? 'bound' : 'unbound',
    artifacts,
    untracked,
    journalOnly,
    anomalies,
    summary,
  });
}

/**
 * Explicit projection repair: rebuild integrity/index.json purely from
 * journaled receipts. Index-only entries (never journaled) are dropped —
 * the journal is the authority. Called by recovery tooling or by the engine
 * inside its mutation lock; never by read-only verify/status paths.
 */
export async function rebuildIndexFromEvents(
  store: Store,
  events: readonly JournalEvent[],
  opts: { now?: Date } = {},
): Promise<Result<{ entries: number; anomalies: string[]; droppedIndexOnly: string[] }>> {
  const id = await runIdOf(store);
  if (!id.ok) return id as Result<never>;
  const { receipts, anomalies } = collectReceipts(events);
  const now = opts.now ?? new Date();
  const index = emptyIndex(id.value, now);
  for (const [p, r] of receipts) {
    index.entries[p] = { ...r, recordedAt: now.toISOString() };
  }
  const dropped: string[] = [];
  const old = await loadIndex(store);
  if (old.ok) {
    for (const p of Object.keys(old.value.entries)) {
      if (!receipts.has(p)) dropped.push(p);
    }
    dropped.sort();
  }
  const w = await saveIndex(store, index);
  if (!w.ok) return w as Result<never>;
  return ok({ entries: Object.keys(index.entries).length, anomalies, droppedIndexOnly: dropped });
}
