/**
 * Opt-in lean-MCP environment for Devin-lane council workers (config.leanMcp).
 *
 * Mechanism (verified on the dev host — .council-dev/reports/lean-devin.md):
 * a `.devin` directory is discovered by walking UP from a Devin session's
 * cwd, and project-scope `*.local.json` entries override same-named user-scope
 * ones. Writing `{ "mcpServers": { "<name>": {"disabled": true} } }` stubs for
 * every enabled user-scope server plus `{ "read_config_from": { <all keys>:
 * false } }` at the worktree root makes Devin sessions started there come up
 * with zero MCP helper processes — names are the ONLY thing ever copied
 * (Command/URL/args/env lines carry credentials and are never persisted).
 *
 * This module is deliberately pure filesystem logic: the engine supplies the
 * worktree root and the enumerated names (via an injected LeanEnvProbe), and
 * supplies run-dir backup IO. Every write is atomic (tmp+rename); a plan is
 * computed from reads BEFORE any write so the engine can journal the exact
 * intent first.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import type {
  CouncilError,
  LeanEnvFileRecord,
  LeanEnvRestoreEntry,
  Result,
} from '../contracts.js';
import { err } from '../validation.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Worktree-root-relative generated files (posix form for records/journal). */
export const LEAN_MCP_CONFIG_REL = '.devin/mcp_config.local.json';
export const LEAN_CONFIG_REL = '.devin/config.local.json';

/** Run-dir-relative directory holding exact-byte backups of merged user files. */
export const LEAN_BACKUP_DIR = 'lean';

/**
 * Every documented `read_config_from` source key (verified against Devin CLI
 * v3000.11.92 docs/config schema). Setting them all false suppresses runtime
 * imports of foreign agent configs and account (cloud) MCP/rules.
 */
export const READ_CONFIG_FROM_KEYS = [
  'agents_standard',
  'claude',
  'cloud',
  'codex',
  'copilot',
  'cursor',
  'kiro',
  'opencode',
  'windsurf',
  'zed',
] as const;

/** Lines appended to `.git/info/exclude` so the generated files never dirty `git status`. */
export const LEAN_GIT_EXCLUDE_LINES = [
  '.devin/mcp_config.local.json',
  '.devin/config.local.json',
] as const;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = (error: CouncilError): Result<never> => ({ ok: false, error });
const isObj = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null && !Array.isArray(u);

// ─── `devin mcp list` output parsing (names + status only) ───────────────────

/**
 * Enabled MCP server names from `devin mcp list` stdout. The output rows look
 * like `  • <name>` (enabled) and `  ✗ <name>  (disabled)`; every row is
 * followed by `Command:`/`URL:`/`Source:` detail lines that carry credentials
 * and are NEVER parsed. A name listed enabled at one scope and disabled at a
 * higher-priority scope resolves to disabled (local stubs beat user entries —
 * same rule the CLI applies).
 */
export function parseMcpListEnabledNames(stdout: string): string[] {
  const enabled = new Set<string>();
  const disabled = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const disabledRow =
      /^\s*✗\s+(.+?)\s*\(disabled\)\s*$/.exec(line) ??
      /^\s*•\s+(.+?)\s*\(disabled\)\s*$/.exec(line);
    if (disabledRow !== null) {
      const name = disabledRow[1]!.trim();
      if (name.length > 0) {
        disabled.add(name);
        enabled.delete(name);
      }
      continue;
    }
    const enabledRow = /^\s*[•✓✔]\s+(.+?)\s*$/.exec(line);
    if (enabledRow !== null) {
      const name = enabledRow[1]!.trim();
      if (name.length > 0 && !disabled.has(name)) enabled.add(name);
    }
  }
  return [...enabled].sort();
}

// ─── Small fs plumbing ───────────────────────────────────────────────────────

/** tmp+rename write — a failed write never leaves a torn target file. */
async function atomicWrite(abs: string, bytes: string): Promise<void> {
  const tmp = `${abs}.lean-${process.pid}-${createHash('sha1').update(bytes).digest('hex').slice(0, 8)}.tmp`;
  try {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(bytes, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, abs);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

const readIfExists = async (abs: string): Promise<string | undefined> => {
  try {
    return await fsp.readFile(abs, 'utf8');
  } catch {
    return undefined;
  }
};

// ─── Generation plan (reads only — journalable before any write) ─────────────

export interface LeanFilePlan {
  /** Worktree-root-relative posix path (one of the two generated files). */
  rel: string;
  /** 'created' = file absent or proven ours; 'merged' = user file to extend. */
  action: 'created' | 'merged';
  /** Exact bytes to write (normalized JSON, trailing newline). */
  content: string;
  /** Existing bytes to back up before merging (present iff action 'merged'). */
  backupBytes?: string;
  /** MCP names we add disabled stubs for (mcp_config file). */
  stubbedNames?: string[];
  /** read_config_from keys we set false (config file). */
  configKeys?: string[];
  /** True when the write can be skipped (merged file already satisfied). */
  alreadySatisfied?: boolean;
}

export interface LeanPlan {
  worktreeRoot: string;
  files: LeanFilePlan[];
  warnings: string[];
}

/** Stub shape we write — a bare `{"disabled": true}` is sufficient and safe. */
const STUB = { disabled: true } as const;
const stubValue = (v: unknown): boolean => isObj(v) && v.disabled === true && Object.keys(v).length === 1;

/**
 * True when an existing file can only be a leftover of OUR generation —
 * every entry is a bare disabled stub (mcp_config) or an all-false
 * read_config_from block (config) whose keys are all within `oursNames`.
 * Used to recognize a partial write from a crash between journal intent and
 * receipt so regeneration records it as 'created' (cleanup deletes) instead
 * of backing it up as a user file.
 */
function isOursLike(parsed: unknown, rel: string, oursNames: readonly string[]): boolean {
  if (!isObj(parsed)) return false;
  if (rel === LEAN_MCP_CONFIG_REL) {
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'mcpServers') return false;
    const srv = parsed.mcpServers;
    if (!isObj(srv)) return false;
    return Object.entries(srv).every(([n, v]) => oursNames.includes(n) && stubValue(v));
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'read_config_from') return false;
  const rcf = parsed.read_config_from;
  if (!isObj(rcf)) return false;
  return Object.entries(rcf).every(([k, v]) => oursNames.includes(k) && v === false);
}

function planMcpConfig(
  existing: string | undefined,
  names: readonly string[],
  oursNames: readonly string[],
  warnings: string[],
): LeanFilePlan {
  const content = `${JSON.stringify({ mcpServers: Object.fromEntries(names.map((n) => [n, STUB])) }, null, 2)}\n`;
  if (existing === undefined) {
    return { rel: LEAN_MCP_CONFIG_REL, action: 'created', content, stubbedNames: [...names] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    warnings.push(`${LEAN_MCP_CONFIG_REL} is not parseable JSON — backed up and replaced with generated stubs`);
    return { rel: LEAN_MCP_CONFIG_REL, action: 'merged', content, backupBytes: existing, stubbedNames: [...names] };
  }
  if (isOursLike(parsed, LEAN_MCP_CONFIG_REL, oursNames)) {
    return { rel: LEAN_MCP_CONFIG_REL, action: 'created', content, stubbedNames: [...names] };
  }
  if (!isObj(parsed)) {
    warnings.push(`${LEAN_MCP_CONFIG_REL} is not a JSON object — backed up and replaced with generated stubs`);
    return { rel: LEAN_MCP_CONFIG_REL, action: 'merged', content, backupBytes: existing, stubbedNames: [...names] };
  }
  const merged = { ...parsed };
  const existingSrv = isObj(merged.mcpServers) ? { ...merged.mcpServers } : {};
  if (merged.mcpServers !== undefined && !isObj(merged.mcpServers)) {
    warnings.push(`${LEAN_MCP_CONFIG_REL} mcpServers is not an object — replaced (original bytes backed up)`);
  }
  const added: string[] = [];
  for (const name of names) {
    if (name in existingSrv) {
      warnings.push(`stub skipped for ${JSON.stringify(name)} — a same-named user entry exists; left untouched`);
      continue;
    }
    existingSrv[name] = { ...STUB };
    added.push(name);
  }
  merged.mcpServers = existingSrv;
  const mergedContent = `${JSON.stringify(merged, null, 2)}\n`;
  return {
    rel: LEAN_MCP_CONFIG_REL,
    action: 'merged',
    content: mergedContent,
    backupBytes: existing,
    stubbedNames: added,
    alreadySatisfied: mergedContent === existing,
  };
}

function planDevinConfig(
  existing: string | undefined,
  oursNames: readonly string[],
  warnings: string[],
): LeanFilePlan {
  const allFalse = Object.fromEntries(READ_CONFIG_FROM_KEYS.map((k) => [k, false]));
  const content = `${JSON.stringify({ read_config_from: allFalse }, null, 2)}\n`;
  if (existing === undefined) {
    return { rel: LEAN_CONFIG_REL, action: 'created', content, configKeys: [...READ_CONFIG_FROM_KEYS] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    warnings.push(`${LEAN_CONFIG_REL} is not parseable JSON — backed up and replaced with generated config`);
    return { rel: LEAN_CONFIG_REL, action: 'merged', content, backupBytes: existing, configKeys: [...READ_CONFIG_FROM_KEYS] };
  }
  if (isOursLike(parsed, LEAN_CONFIG_REL, oursNames)) {
    return { rel: LEAN_CONFIG_REL, action: 'created', content, configKeys: [...READ_CONFIG_FROM_KEYS] };
  }
  if (!isObj(parsed)) {
    warnings.push(`${LEAN_CONFIG_REL} is not a JSON object — backed up and replaced with generated config`);
    return { rel: LEAN_CONFIG_REL, action: 'merged', content, backupBytes: existing, configKeys: [...READ_CONFIG_FROM_KEYS] };
  }
  const merged = { ...parsed };
  const existingRcf = isObj(merged.read_config_from) ? { ...merged.read_config_from } : {};
  if (merged.read_config_from !== undefined && !isObj(merged.read_config_from)) {
    warnings.push(`${LEAN_CONFIG_REL} read_config_from is not an object — replaced (original bytes backed up)`);
  }
  const added: string[] = [];
  for (const key of READ_CONFIG_FROM_KEYS) {
    if (key in existingRcf) continue; // user-set values (true or false) stay untouched
    existingRcf[key] = false;
    added.push(key);
  }
  merged.read_config_from = existingRcf;
  const mergedContent = `${JSON.stringify(merged, null, 2)}\n`;
  return {
    rel: LEAN_CONFIG_REL,
    action: 'merged',
    content: mergedContent,
    backupBytes: existing,
    configKeys: added,
    alreadySatisfied: mergedContent === existing,
  };
}

/**
 * Compute the generation plan from the worktree's current state. READS ONLY —
 * the engine journals the returned plan as its lean.env intent before
 * applyLeanPlan writes anything, keeping generation crash-safe.
 *
 * `oursNames` carries the names from a prior journaled generation INTENT
 * (crash between intent and receipt): a file consisting solely of stubs for
 * those names is recognized as our own partial write, not a user file.
 */
export async function planLeanWrites(input: {
  worktreeRoot: string;
  names: string[];
  oursNames?: string[];
}): Promise<Result<LeanPlan>> {
  const warnings: string[] = [];
  const ours = input.oursNames ?? input.names;
  const mcpAbs = path.join(input.worktreeRoot, ...LEAN_MCP_CONFIG_REL.split('/'));
  const cfgAbs = path.join(input.worktreeRoot, ...LEAN_CONFIG_REL.split('/'));
  const [mcpExisting, cfgExisting] = await Promise.all([readIfExists(mcpAbs), readIfExists(cfgAbs)]);
  return ok({
    worktreeRoot: input.worktreeRoot,
    files: [
      planMcpConfig(mcpExisting, input.names, ours, warnings),
      planDevinConfig(cfgExisting, [...READ_CONFIG_FROM_KEYS], warnings),
    ],
    warnings,
  });
}

// ─── Apply (writes; runs after the journaled intent) ────────────────────────

const BACKUP_NAME: Record<string, string> = {
  [LEAN_MCP_CONFIG_REL]: 'mcp_config.local.json.bak',
  [LEAN_CONFIG_REL]: 'config.local.json.bak',
};

export interface LeanApplyResult {
  files: LeanEnvFileRecord[];
  failures: { path: string; error: string }[];
  warnings: string[];
}

/**
 * Execute a planned generation. For every merged file the exact original
 * bytes are backed up into the run dir FIRST (never clobbered — an existing
 * backup from an earlier crashed attempt wins, being the older/pristine
 * copy); the merged content is then written atomically.
 */
export async function applyLeanPlan(input: {
  plan: LeanPlan;
  backupExists: (backupRel: string) => Promise<boolean>;
  writeBackup: (backupRel: string, bytes: string) => Promise<Result<void>>;
}): Promise<LeanApplyResult> {
  const files: LeanEnvFileRecord[] = [];
  const failures: { path: string; error: string }[] = [];
  const warnings: string[] = [...input.plan.warnings];
  for (const f of input.plan.files) {
    const rec: LeanEnvFileRecord = { path: f.rel, action: f.action };
    if (f.stubbedNames !== undefined) rec.stubbedNames = f.stubbedNames;
    if (f.configKeys !== undefined) rec.configKeys = f.configKeys;
    try {
      if (f.action === 'merged' && f.backupBytes !== undefined) {
        const backupRel = `${LEAN_BACKUP_DIR}/${BACKUP_NAME[f.rel]}`;
        rec.backup = backupRel;
        rec.backupSha256 = sha256(f.backupBytes);
        if (!(await input.backupExists(backupRel))) {
          const w = await input.writeBackup(backupRel, f.backupBytes);
          if (!w.ok) {
            // Never merge over a user file whose original bytes are not
            // durably preserved — leave the file untouched and report.
            failures.push({ path: f.rel, error: `backup write failed: ${w.error.message}` });
            warnings.push(`${f.rel} left untouched — could not back up its original bytes`);
            continue;
          }
        } else {
          warnings.push(`${f.rel}: existing backup ${backupRel} kept (earlier generation attempt)`);
        }
      }
      if (f.alreadySatisfied === true && f.action === 'merged') {
        warnings.push(`${f.rel} already satisfied — merged file unchanged`);
        files.push(rec);
        continue;
      }
      const abs = path.join(input.plan.worktreeRoot, ...f.rel.split('/'));
      await atomicWrite(abs, f.content);
      files.push(rec);
    } catch (e) {
      failures.push({ path: f.rel, error: e instanceof Error ? e.message : String(e) });
      warnings.push(`${f.rel} write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { files, failures, warnings };
}

// ─── git exclude (best-effort — failures are journaled, never fatal) ─────────

export interface GitExcludeOutcome {
  applied: boolean;
  excludePath?: string;
  added?: string[];
  warning?: string;
}

/**
 * Resolve the repository's `info/exclude` path. Handles both a real `.git`
 * directory and a linked-worktree `.git` FILE (`gitdir: <path>` whose
 * `commondir` points at the shared git dir, where info/exclude lives).
 */
async function gitExcludePath(worktreeRoot: string): Promise<string | undefined> {
  const dotgit = path.join(worktreeRoot, '.git');
  try {
    const st = await fsp.stat(dotgit);
    if (st.isDirectory()) return path.join(dotgit, 'info', 'exclude');
    if (!st.isFile()) return undefined;
    const text = await fsp.readFile(dotgit, 'utf8');
    const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(text);
    if (m === null) return undefined;
    const gitdir = path.resolve(worktreeRoot, m[1]!);
    const commondir = (await readIfExists(path.join(gitdir, 'commondir')))?.trim();
    const commonDir = commondir !== undefined && commondir.length > 0
      ? path.resolve(gitdir, commondir)
      : gitdir;
    return path.join(commonDir, 'info', 'exclude');
  } catch {
    return undefined;
  }
}

/**
 * Append the generated file paths to `.git/info/exclude` (idempotent — only
 * lines not already present). Entries are deliberately LEFT on cleanup:
 * exclude lines for absent files are no-ops. Never touches tracked ignore
 * files. Absent `.git` or any failure degrades to {applied:false} with a
 * warning the caller journals.
 */
export async function ensureGitExclude(worktreeRoot: string): Promise<GitExcludeOutcome> {
  try {
    const excludePath = await gitExcludePath(worktreeRoot);
    if (excludePath === undefined) return { applied: false, warning: 'no .git dir/file at worktree root' };
    const existing = (await readIfExists(excludePath)) ?? '';
    const lines = existing.split(/\r?\n/);
    const missing = LEAN_GIT_EXCLUDE_LINES.filter((l) => !lines.includes(l));
    if (missing.length === 0) return { applied: true, excludePath, added: [] };
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await fsp.mkdir(path.dirname(excludePath), { recursive: true });
    await fsp.appendFile(excludePath, `${prefix}${missing.join('\n')}\n`, 'utf8');
    return { applied: true, excludePath, added: missing };
  } catch (e) {
    return { applied: false, warning: `git exclude update failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── Restore (cleanup: exact-byte restore or delete-what-we-created) ─────────

export interface LeanRestoreResult {
  entries: LeanEnvRestoreEntry[];
  warnings: string[];
  /** True when every recorded file reached a clean end state. */
  allClean: boolean;
}

/** Remove OUR entries from a live user file, keeping everything else. */
function stripOurs(rel: string, current: string, rec: LeanEnvFileRecord): { content: string; removed: string[] } | 'unparseable' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(current);
  } catch {
    return 'unparseable';
  }
  if (!isObj(parsed)) return 'unparseable';
  const removed: string[] = [];
  const out = { ...parsed };
  if (rel === LEAN_MCP_CONFIG_REL && isObj(out.mcpServers)) {
    const srv = { ...out.mcpServers };
    for (const n of rec.stubbedNames ?? []) {
      if (stubValue(srv[n])) {
        delete srv[n];
        removed.push(n);
      }
    }
    out.mcpServers = srv;
  } else if (rel === LEAN_CONFIG_REL && isObj(out.read_config_from)) {
    const rcf = { ...out.read_config_from };
    for (const k of rec.configKeys ?? []) {
      if (rcf[k] === false) {
        delete rcf[k];
        removed.push(k);
      }
    }
    out.read_config_from = rcf;
  }
  return { content: `${JSON.stringify(out, null, 2)}\n`, removed };
}

/**
 * Restore the worktree to its pre-generation state. 'merged' files get their
 * exact backed-up bytes written back (backup verified against the journaled
 * sha256 — a corrupt backup triggers the strip-fallback instead of a blind
 * restore). 'created' files are deleted when they still hold only our
 * entries; a file that gained user content keeps it, minus our keys.
 */
export async function restoreLeanFiles(input: {
  worktreeRoot: string;
  files: LeanEnvFileRecord[];
  readBackup: (backupRel: string) => Promise<Result<string>>;
}): Promise<LeanRestoreResult> {
  const entries: LeanEnvRestoreEntry[] = [];
  const warnings: string[] = [];
  let allClean = true;
  let deletedAny = false;
  for (const rec of input.files) {
    const abs = path.join(input.worktreeRoot, ...rec.path.split('/'));
    try {
      if (rec.action === 'merged') {
        let backup: string | undefined;
        const r = await input.readBackup(rec.backup ?? '');
        if (r.ok) backup = r.value;
        if (backup !== undefined && rec.backupSha256 !== undefined && sha256(backup) !== rec.backupSha256) {
          warnings.push(`${rec.path}: backup ${rec.backup} sha256 mismatch — refusing to restore suspect bytes; stripping our keys instead`);
          backup = undefined;
        }
        if (backup !== undefined) {
          await atomicWrite(abs, backup);
          entries.push({ path: rec.path, outcome: 'restored' });
          continue;
        }
        // Backup unavailable/corrupt — rescue: strip only our keys.
        const current = await readIfExists(abs);
        if (current === undefined) {
          warnings.push(`${rec.path}: file absent and no readable backup (${rec.backup ?? 'none'})`);
          entries.push({ path: rec.path, outcome: 'skipped', reason: 'file absent; backup unavailable' });
          continue;
        }
        const stripped = stripOurs(rec.path, current, rec);
        if (stripped === 'unparseable') {
          warnings.push(`${rec.path}: backup unavailable and live file unparseable — left untouched`);
          entries.push({ path: rec.path, outcome: 'failed', reason: 'backup unavailable; live file unparseable' });
          allClean = false;
          continue;
        }
        await atomicWrite(abs, stripped.content);
        warnings.push(`${rec.path}: backup unavailable — stripped our keys (${stripped.removed.join(', ') || 'none'}) instead of restoring`);
        entries.push({ path: rec.path, outcome: 'kept', reason: 'backup unavailable; our keys stripped' });
        continue;
      }
      // action 'created': delete when the file still holds only our entries.
      const current = await readIfExists(abs);
      if (current === undefined) {
        entries.push({ path: rec.path, outcome: 'skipped', reason: 'already absent' });
        continue;
      }
      let parsed: unknown;
      let parseFailed = false;
      try {
        parsed = JSON.parse(current);
      } catch {
        parseFailed = true;
      }
      if (parseFailed) {
        // Cannot prove the file is still ours — never delete unverifiable bytes.
        entries.push({ path: rec.path, outcome: 'kept', reason: 'unparseable since generation; left untouched' });
        warnings.push(`${rec.path} is unparseable since generation — left in place`);
        continue;
      }
      if (isOursLike(parsed, rec.path, rec.stubbedNames ?? rec.configKeys ?? [])) {
        await fsp.unlink(abs);
        deletedAny = true;
        entries.push({ path: rec.path, outcome: 'deleted' });
        continue;
      }
      // The file gained content we did not write — strip only our keys.
      const stripped = stripOurs(rec.path, current, rec);
      if (stripped === 'unparseable') {
        entries.push({ path: rec.path, outcome: 'kept', reason: 'modified since generation; left untouched' });
        warnings.push(`${rec.path} was modified since generation — left in place`);
        continue;
      }
      await atomicWrite(abs, stripped.content);
      warnings.push(`${rec.path} gained outside content since generation — kept it, removed our keys (${stripped.removed.join(', ') || 'none'})`);
      entries.push({ path: rec.path, outcome: 'kept', reason: 'outside content preserved; our keys stripped' });
    } catch (e) {
      allClean = false;
      entries.push({ path: rec.path, outcome: 'failed', reason: e instanceof Error ? e.message : String(e) });
      warnings.push(`${rec.path} restore failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (deletedAny) {
    // Best-effort: remove the .devin dir only when it is now empty.
    await fsp.rmdir(path.join(input.worktreeRoot, '.devin')).catch(() => {});
  }
  return { entries, warnings, allClean };
}

/** Exported for tests: the exact stub payload shape applied to a name. */
export function leanStubFor(_name: string): { disabled: true } {
  return { ...STUB };
}
