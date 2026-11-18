/**
 * Source-tree snapshot and drift scanning for the council store.
 *
 * A SourceSnapshot pins the reviewed tree: a deterministic manifest of
 * `posixRelativePath -> {sha256, size}` plus a `headHash` over the sorted
 * `"path:sha256"` lines. `verifySourceSnapshot` re-scans with the same rules
 * and diffs the manifest — additions, removals and modifications all surface
 * in `changed`.
 *
 * Exclusion policy (identical for capture and verify, documented and frozen):
 *  - Directory basenames in SNAPSHOT_EXCLUDED_DIRS — runtime/control/generated
 *    trees that must never make the council's own artifacts look like drift.
 *  - Directory basenames in SNAPSHOT_SECRET_DIRS and file basenames matching
 *    SECRET_FILE_* — common credential stores (.env, private keys, SSH keys,
 *    netrc/npmrc-style files, cloud credential files). `.env.example`-style
 *    templates are NOT treated as secrets.
 *  - Symlinks/junctions are SKIPPED (never followed, never hashed). They are
 *    recorded in `scan.skipped.symlinks` so a skipped link is visible rather
 *    than silent. A file replaced by a symlink reads as a removal → drift.
 *  - Files whose relative path fails `assertSafeRelativePath` (spaces,
 *    backslashes, ".." segments, non-token characters) are SKIPPED and
 *    recorded in `scan.skipped.unsafePaths`. They cannot appear in the
 *    manifest because snapshot.files keys are themselves safe-relative —
 *    and such paths are uncitable in evidence anyway.
 *  - FIFOs/sockets/devices are skipped like unsafe paths.
 *
 * Failure policy: unreadable directories/files, oversize files and
 * file-count/total-byte limits are hard errors (io_error with details) —
 * never a silently incomplete scan.
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type { Result, SourceSnapshot } from './contracts.js';
import { SCHEMA_VERSION } from './contracts.js';
import { err, ID_RE, assertSafeRelativePath, parseSourceSnapshot } from './validation.js';

// ─── Limits ──────────────────────────────────────────────────────────────────

export interface SnapshotLimits {
  /** Max regular files scanned (manifest entries + skipped unsafe files). */
  maxFiles: number;
  /** Max bytes read for any single file. */
  maxFileBytes: number;
  /** Max bytes read across the whole tree. */
  maxTotalBytes: number;
}

/**
 * Defaults sized for a source checkout. maxFiles stays under the 100_000 cap
 * enforced by parseSourceSnapshot so captured snapshots always re-parse.
 */
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxFiles: 50_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
};

/** parseSourceSnapshot rejects manifests above this many entries. */
export const SNAPSHOT_MAX_MANIFEST_FILES = 100_000;

const MAX_SKIP_LIST_ENTRIES = 256;

// ─── Exclusions ─────────────────────────────────────────────────────────────

/**
 * Runtime/control/generated directory basenames skipped at any depth.
 * `.council` + `.council-dev` hold the run's own artifacts (journal, specs);
 * excluding them prevents council output from registering as source drift.
 */
export const SNAPSHOT_EXCLUDED_DIRS: readonly string[] = [
  '.git',
  '.council',
  '.council-dev',
  'node_modules',
  'dist',
  'coverage',
];

/** Directory basenames that conventionally hold credentials. */
export const SNAPSHOT_SECRET_DIRS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
];

/** Exact secret-bearing file basenames (matched case-insensitively). */
const SECRET_FILE_EXACT = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.htpasswd',
  '.pgpass',
  '.git-credentials',
  '.kubeconfig',
  'kubeconfig',
  'credentials.json',
  'terraform.tfstate',
  '.dockercfg',
  '.dockerconfigjson',
]);

/** Secret-bearing file name patterns (private keys, env files, SSH keys). */
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|p8|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519|x25519)(\.pub)?$/i,
];

/** Templates/examples are shareable, not secrets: `.env.example` etc. */
const SECRET_ALLOW_PATTERN = /\.(example|sample|template)$/i;

export function isSecretFileBasename(basename: string): boolean {
  if (SECRET_ALLOW_PATTERN.test(basename)) return false;
  if (SECRET_FILE_EXACT.has(basename.toLowerCase())) return true;
  return SECRET_FILE_PATTERNS.some((re) => re.test(basename));
}

// ─── Scan types ─────────────────────────────────────────────────────────────

/** What a tree scan observed beyond the manifest itself. */
export interface SourceScanSkipped {
  /** Symlinked/junction entries — never followed. */
  symlinks: string[];
  /** Files matching secret patterns — never read or hashed. */
  secretFiles: string[];
  /** Files/dirs whose relative path is not safe-relative, plus non-regular files. */
  unsafePaths: string[];
  /** Directory count skipped by exclusion rules. */
  excludedDirs: number;
  /** True when any skip list hit MAX_SKIP_LIST_ENTRIES and names were dropped. */
  listsTruncated: boolean;
}

export interface SourceScan {
  /** posix relative path → content hash. Keys are sorted. */
  files: SourceSnapshot['files'];
  skipped: SourceScanSkipped;
  totalBytes: number;
}

export interface ScanOptions {
  limits?: Partial<SnapshotLimits>;
  /** Extra directory basenames to exclude (rare; prefer the frozen lists). */
  extraExcludedDirs?: readonly string[];
}

// ─── Hashing helpers ────────────────────────────────────────────────────────

/** sha256 over the sorted `"path:sha256"` lines — the approval/drift key. */
export function manifestHeadHash(files: SourceSnapshot['files']): string {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p}:${files[p].sha256}`);
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * Paths that differ between two manifests: removed (in `before` only),
 * added (in `after` only), or modified (hash/size differ). Sorted output.
 */
export function diffSnapshotFiles(
  before: SourceSnapshot['files'],
  after: SourceSnapshot['files'],
): string[] {
  const changed = new Set<string>();
  for (const p of Object.keys(before)) {
    const a = before[p];
    const b = after[p];
    if (b === undefined || b.sha256 !== a.sha256 || b.size !== a.size) changed.add(p);
  }
  for (const p of Object.keys(after)) {
    if (before[p] === undefined) changed.add(p);
  }
  return [...changed].sort();
}

// ─── Limits resolution ──────────────────────────────────────────────────────

function resolveLimits(
  raw: Partial<SnapshotLimits> | undefined,
): Result<SnapshotLimits> {
  const merged = { ...DEFAULT_SNAPSHOT_LIMITS, ...(raw ?? {}) };
  for (const key of ['maxFiles', 'maxFileBytes', 'maxTotalBytes'] as const) {
    const v = merged[key];
    if (!Number.isInteger(v) || v <= 0) {
      return {
        ok: false,
        error: err('config_invalid', `snapshot limit ${key} must be a positive integer`, {
          details: { reason: 'bad_limit', key, value: v },
        }),
      };
    }
  }
  if (merged.maxFiles > SNAPSHOT_MAX_MANIFEST_FILES) {
    return {
      ok: false,
      error: err(
        'config_invalid',
        `maxFiles ${merged.maxFiles} exceeds parse cap ${SNAPSHOT_MAX_MANIFEST_FILES}`,
        { details: { reason: 'bad_limit', key: 'maxFiles', value: merged.maxFiles } },
      ),
    };
  }
  return { ok: true, value: merged };
}

// ─── Tree scan ──────────────────────────────────────────────────────────────

function pushLimited(list: string[], value: string, skipped: SourceScanSkipped): void {
  if (list.length < MAX_SKIP_LIST_ENTRIES) list.push(value);
  else skipped.listsTruncated = true;
}

const ioFail = (
  reason: string,
  message: string,
  details: Record<string, unknown>,
): Result<never> => ({
  ok: false,
  error: err('io_error', message, { details: { reason, ...details } }),
});

/**
 * Walk `rootAbs` (an already-canonicalized absolute directory path) and hash
 * every regular file's content. Deterministic: directories are read in sorted
 * order and the manifest is keyed by sorted posix relative paths.
 *
 * Never follows symlinks, never reads secret files, never executes anything.
 */
export async function scanSourceTree(
  rootAbs: string,
  options: ScanOptions = {},
): Promise<Result<SourceScan>> {
  const lim = resolveLimits(options.limits);
  if (!lim.ok) return lim;
  const limits = lim.value;

  const excludedDirs = new Set([
    ...SNAPSHOT_EXCLUDED_DIRS,
    ...(options.extraExcludedDirs ?? []),
  ]);
  const secretDirs = new Set(SNAPSHOT_SECRET_DIRS.map((d) => d.toLowerCase()));

  const skipped: SourceScanSkipped = {
    symlinks: [],
    secretFiles: [],
    unsafePaths: [],
    excludedDirs: 0,
    listsTruncated: false,
  };

  const toHash: string[] = []; // sorted later
  let seenFiles = 0;

  const stack: string[] = [''];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir === '' ? rootAbs : path.join(rootAbs, ...relDir.split('/'));
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (e) {
      return ioFail(
        'unreadable_dir',
        `cannot scan directory ${relDir === '' ? '.' : relDir}: ${describeErr(e)}`,
        { dir: relDir === '' ? '.' : relDir },
      );
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const ent of entries) {
      const rel = relDir === '' ? ent.name : `${relDir}/${ent.name}`;
      if (ent.isSymbolicLink()) {
        pushLimited(skipped.symlinks, rel, skipped);
        continue;
      }
      if (ent.isDirectory()) {
        if (excludedDirs.has(ent.name) || secretDirs.has(ent.name.toLowerCase())) {
          skipped.excludedDirs++;
          continue;
        }
        stack.push(rel);
        continue;
      }
      if (!ent.isFile()) {
        // fifo/socket/device — not reviewable content.
        pushLimited(skipped.unsafePaths, rel, skipped);
        continue;
      }
      seenFiles++;
      if (seenFiles > limits.maxFiles) {
        return ioFail(
          'too_many_files',
          `source tree exceeds maxFiles=${limits.maxFiles} (raise limits.maxFiles or narrow the target)`,
          { maxFiles: limits.maxFiles, atPath: rel },
        );
      }
      if (isSecretFileBasename(ent.name)) {
        pushLimited(skipped.secretFiles, rel, skipped);
        continue;
      }
      const safe = assertSafeRelativePath(rel);
      if (!safe.ok) {
        pushLimited(skipped.unsafePaths, rel, skipped);
        continue;
      }
      toHash.push(safe.value);
    }
  }

  toHash.sort();
  const files: SourceSnapshot['files'] = {};
  let totalBytes = 0;
  for (const rel of toHash) {
    const abs = path.join(rootAbs, ...rel.split('/'));
    const hashed = await hashFile(abs, limits.maxFileBytes);
    if (!hashed.ok) {
      return ioFail(
        hashed.error.reason,
        `cannot hash ${rel}: ${hashed.error.message}`,
        { file: rel },
      );
    }
    totalBytes += hashed.value.size;
    if (totalBytes > limits.maxTotalBytes) {
      return ioFail(
        'total_too_large',
        `source tree exceeds maxTotalBytes=${limits.maxTotalBytes} at ${rel}`,
        { maxTotalBytes: limits.maxTotalBytes, atPath: rel },
      );
    }
    files[rel] = { sha256: hashed.value.sha256, size: hashed.value.size };
  }

  skipped.symlinks.sort();
  skipped.secretFiles.sort();
  skipped.unsafePaths.sort();
  return { ok: true, value: { files, skipped, totalBytes } };
}

type HashFileResult =
  | { ok: true; value: { sha256: string; size: number } }
  | { ok: false; error: { reason: string; message: string } };

async function hashFile(
  abs: string,
  maxFileBytes: number,
): Promise<HashFileResult> {
  // lstat before open so a just-swapped symlink is not followed silently.
  try {
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) {
      return { ok: false, error: { reason: 'unreadable_file', message: 'became a symlink during scan' } };
    }
    if (st.size > maxFileBytes) {
      return {
        ok: false,
        error: {
          reason: 'file_too_large',
          message: `size ${st.size} exceeds maxFileBytes=${maxFileBytes}`,
        },
      };
    }
  } catch (e) {
    return { ok: false, error: { reason: 'unreadable_file', message: describeErr(e) } };
  }

  const hash = createHash('sha256');
  let size = 0;
  let handle;
  try {
    handle = await fsp.open(abs, fsConstants.O_RDONLY);
  } catch (e) {
    return { ok: false, error: { reason: 'unreadable_file', message: describeErr(e) } };
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxFileBytes) {
        return {
          ok: false,
          error: {
            reason: 'file_too_large',
            message: `grew past maxFileBytes=${maxFileBytes} while reading`,
          },
        };
      }
      hash.update(buf.subarray(0, bytesRead));
    }
  } catch (e) {
    return { ok: false, error: { reason: 'unreadable_file', message: describeErr(e) } };
  } finally {
    await handle.close().catch(() => {});
  }
  return { ok: true, value: { sha256: hash.digest('hex'), size } };
}

function describeErr(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

// ─── git HEAD (no git dependency) ───────────────────────────────────────────

const GIT_HEX_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;
const MAX_GIT_FILE_BYTES = 1024 * 1024;

async function readSmallFile(p: string): Promise<string | null> {
  try {
    const fh = await fsp.open(p, 'r');
    try {
      const stat = await fh.stat();
      const buf = Buffer.alloc(Math.min(stat.size, MAX_GIT_FILE_BYTES));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

function resolveGitDir(targetRoot: string, content: string): string | null {
  const m = /^gitdir:\s*(.+)$/im.exec(content);
  if (!m) return null;
  return path.resolve(targetRoot, m[1].trim());
}

/**
 * Best-effort `.git` HEAD resolution without spawning git: handles a real
 * `.git` directory, a worktree `.git` file ("gitdir: …"), detached HEAD,
 * loose refs, `commondir` indirection and packed-refs. Returns null for
 * non-git roots and for anything unreadable — absence is honest, not an error.
 */
export async function readGitHead(targetRoot: string): Promise<string | null> {
  const dotGit = path.join(targetRoot, '.git');
  let gitDir: string | null = null;
  try {
    const st = await fsp.lstat(dotGit);
    if (st.isSymbolicLink()) return null; // never follow a .git link
    if (st.isDirectory()) gitDir = dotGit;
    else if (st.isFile()) {
      const content = await readSmallFile(dotGit);
      if (content !== null) gitDir = resolveGitDir(targetRoot, content);
    }
  } catch {
    return null;
  }
  if (gitDir === null) return null;

  const head = (await readSmallFile(path.join(gitDir, 'HEAD')))?.trim();
  if (!head) return null;
  if (GIT_HEX_RE.test(head)) return head.toLowerCase();

  const refMatch = /^ref:\s*(\S+)$/i.exec(head);
  if (!refMatch) return null;
  const ref = refMatch[1];

  const commonDir = await (async () => {
    const raw = await readSmallFile(path.join(gitDir!, 'commondir'));
    return raw ? path.resolve(gitDir!, raw.trim()) : gitDir!;
  })();

  for (const refFile of [
    path.join(gitDir, ref),
    path.join(commonDir, ref),
  ]) {
    const content = (await readSmallFile(refFile))?.trim();
    if (content && GIT_HEX_RE.test(content)) return content.toLowerCase();
  }
  for (const packed of [
    path.join(commonDir, 'packed-refs'),
    path.join(gitDir, 'packed-refs'),
  ]) {
    const content = await readSmallFile(packed);
    if (!content) continue;
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('#') || t.startsWith('^')) continue;
      const sp = t.indexOf(' ');
      if (sp === -1) continue;
      if (t.slice(sp + 1).trim() === ref && GIT_HEX_RE.test(t.slice(0, sp))) {
        return t.slice(0, sp).toLowerCase();
      }
    }
  }
  return null;
}

// ─── captureSnapshot ────────────────────────────────────────────────────────

export interface CaptureSnapshotOptions {
  /** Caller-supplied id (must match the contract id charset). Default: `snap_<headHash[:16]>` — deterministic per tree content. */
  snapshotId?: string;
  /** Inject a clock for tests; defaults to now. */
  takenAt?: Date;
  limits?: Partial<SnapshotLimits>;
  extraExcludedDirs?: readonly string[];
}

/**
 * Canonicalize `targetRoot` (realpath — works on Windows paths/spaces and
 * Unix), scan it under the frozen exclusion/limits policy, capture git HEAD
 * when the root is a checkout (no git binary required; non-git → null), and
 * return a contract-validated SourceSnapshot. Nothing is written and the
 * target is never executed or modified.
 */
export async function captureSnapshot(
  targetRoot: string,
  options: CaptureSnapshotOptions = {},
): Promise<Result<SourceSnapshot>> {
  if (typeof targetRoot !== 'string' || targetRoot.length === 0) {
    return {
      ok: false,
      error: err('config_invalid', 'targetRoot must be a non-empty path', {
        details: { reason: 'bad_target_root' },
      }),
    };
  }

  let rootAbs: string;
  try {
    rootAbs = await fsp.realpath(targetRoot);
  } catch (e) {
    return ioFail(
      'root_unreadable',
      `cannot canonicalize targetRoot ${JSON.stringify(targetRoot)}: ${describeErr(e)}`,
      { targetRoot },
    );
  }
  let rootIsDir = false;
  try {
    rootIsDir = (await fsp.stat(rootAbs)).isDirectory();
  } catch {
    /* covered by error below */
  }
  if (!rootIsDir) {
    return {
      ok: false,
      error: err('config_invalid', `targetRoot is not a directory: ${rootAbs}`, {
        details: { reason: 'root_not_directory', targetRoot: rootAbs },
      }),
    };
  }

  const scanned = await scanSourceTree(rootAbs, {
    limits: options.limits,
    extraExcludedDirs: options.extraExcludedDirs,
  });
  if (!scanned.ok) return scanned;

  const headHash = manifestHeadHash(scanned.value.files);
  const snapshotId = options.snapshotId ?? `snap_${headHash.slice(0, 16)}`;
  if (!ID_RE.test(snapshotId)) {
    return {
      ok: false,
      error: err('config_invalid', `snapshotId ${JSON.stringify(snapshotId)} is not a valid id`, {
        details: { reason: 'bad_snapshot_id', snapshotId },
      }),
    };
  }

  const takenAt = options.takenAt ?? new Date();
  if (Number.isNaN(takenAt.getTime())) {
    return {
      ok: false,
      error: err('config_invalid', 'takenAt is not a valid Date', {
        details: { reason: 'bad_taken_at' },
      }),
    };
  }

  const snapshot: SourceSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    snapshotId,
    targetRoot: rootAbs,
    gitHead: await readGitHead(rootAbs),
    takenAt: takenAt.toISOString(),
    headHash,
    files: scanned.value.files,
  };

  // Self-check against the real parser: a snapshot this module emits must
  // always re-parse (catches manifest/field violations before persistence).
  const parsed = parseSourceSnapshot(snapshot);
  if (!parsed.ok) {
    return {
      ok: false,
      error: err('schema_invalid', 'captureSnapshot produced an invalid snapshot', {
        issues: parsed.issues,
      }),
    };
  }
  return { ok: true, value: snapshot };
}
