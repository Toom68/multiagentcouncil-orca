/**
 * Opt-in lean-MCP environment (config.leanMcp): pure-filesystem coverage for
 * src/host/devin-lean.ts — mcp list parsing (names/status only), create vs
 * merge planning, exact-byte backups and restores, same-name user entries,
 * minimal read_config_from merges, .git/info/exclude handling, and
 * cleanup idempotence. Engine integration coverage lives in engine.test.ts
 * (generation before the first devin launch + restore in both cleanup paths).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Result } from '../src/contracts.js';
import { err, resolveConfig } from '../src/validation.js';
import {
  applyLeanPlan,
  ensureGitExclude,
  LEAN_CONFIG_REL,
  LEAN_GIT_EXCLUDE_LINES,
  LEAN_MCP_CONFIG_REL,
  planLeanWrites,
  parseMcpListEnabledNames,
  READ_CONFIG_FROM_KEYS,
  restoreLeanFiles,
} from '../src/host/devin-lean.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = <T>(msg: string): Result<T> => ({ ok: false, error: err('io_error', msg) });

const roots: string[] = [];
function wt(): string {
  const d = mkdtempSync(join(tmpdir(), 'lean-wt-'));
  roots.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const readRel = (root: string, rel: string) => readFileSync(join(root, ...rel.split('/')), 'utf8');
const existsRel = (root: string, rel: string) => existsSync(join(root, ...rel.split('/')));
const writeRel = (root: string, rel: string, bytes: string) => {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
};

/** In-memory run-dir backup plumbing (engine wires the real Store). */
function memBackups(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    backupExists: async (rel: string) => map.has(rel),
    writeBackup: async (rel: string, bytes: string) => {
      map.set(rel, bytes);
      return ok(undefined);
    },
    readBackup: async (rel: string) =>
      map.has(rel) ? ok(map.get(rel)!) : failRes<string>(`backup ${rel} missing`),
  };
}

async function generate(root: string, names: string[], oursNames?: string[]) {
  const plan = await planLeanWrites({ worktreeRoot: root, names, ...(oursNames !== undefined ? { oursNames } : {}) });
  assert.ok(plan.ok, 'plan failed');
  const b = memBackups();
  const applied = await applyLeanPlan({ plan: plan.value, backupExists: b.backupExists, writeBackup: b.writeBackup });
  return { plan: plan.value, applied, backups: b };
}

// ─── parseMcpListEnabledNames ───────────────────────────────────────────────

test('mcp list parser: enabled names only, status rows respected, details ignored', () => {
  const out = [
    'Installed MCP servers',
    '',
    '  • github-mcp-server',
    '    Command: npx -y @github/mcp --token supersecret',
    '    Source: user',
    '  ✗ linear  (disabled)',
    '    Command: npx -y linear-mcp --key do-not-copy-me',
    '  • notion-mcp-server',
    '    URL: https://mcp.notion.example/mcp?api_key=hidden',
    '',
  ].join('\n');
  assert.deepEqual(parseMcpListEnabledNames(out), ['github-mcp-server', 'notion-mcp-server']);
});

test('mcp list parser: a name enabled at one scope but disabled later resolves disabled', () => {
  const out = ['  • filesystem', '    Command: npx fs --secret x', '  ✗ filesystem  (disabled)', '    Source: local'].join('\n');
  assert.deepEqual(parseMcpListEnabledNames(out), []);
});

test('mcp list parser: dedupes repeated scope rows and tolerates empty output', () => {
  assert.deepEqual(parseMcpListEnabledNames('  • a\n  • a\n'), ['a']);
  assert.deepEqual(parseMcpListEnabledNames(''), []);
  assert.deepEqual(parseMcpListEnabledNames('No MCP servers installed\n'), []);
});

// ─── plan: create vs merge ──────────────────────────────────────────────────

test('plan: absent files are created whole with all stubs and all config keys', async () => {
  const root = wt();
  const { plan } = await generate(root, ['a', 'b']);
  const mcp = plan.files.find((f) => f.rel === LEAN_MCP_CONFIG_REL)!;
  const cfg = plan.files.find((f) => f.rel === LEAN_CONFIG_REL)!;
  assert.equal(mcp.action, 'created');
  assert.equal(cfg.action, 'created');
  assert.deepEqual(mcp.stubbedNames, ['a', 'b']);
  assert.equal(cfg.configKeys!.length, READ_CONFIG_FROM_KEYS.length);
  assert.equal(mcp.backupBytes, undefined);
});

test('plan+apply: generated file writes bare disabled stubs — no command/url/env anywhere', async () => {
  const root = wt();
  const { applied } = await generate(root, ['alpha', 'beta']);
  assert.equal(applied.files.length, 2);
  const written = JSON.parse(readRel(root, LEAN_MCP_CONFIG_REL));
  assert.deepEqual(written, { mcpServers: { alpha: { disabled: true }, beta: { disabled: true } } });
  const cfg = JSON.parse(readRel(root, LEAN_CONFIG_REL));
  assert.equal(Object.keys(cfg.read_config_from).length, READ_CONFIG_FROM_KEYS.length);
  assert.ok(Object.values(cfg.read_config_from).every((v) => v === false));
});

test('plan: existing user mcp file merges — stubs added, user entries untouched, backup recorded', async () => {
  const root = wt();
  const userBytes = JSON.stringify({ mcpServers: { mine: { command: 'npx mine --secret TOKEN' } }, other: 1 }, null, 2);
  writeRel(root, LEAN_MCP_CONFIG_REL, userBytes);
  const { plan, applied, backups } = await generate(root, ['alpha', 'beta']);
  const mcp = plan.files.find((f) => f.rel === LEAN_MCP_CONFIG_REL)!;
  assert.equal(mcp.action, 'merged');
  const rec = applied.files.find((f) => f.path === LEAN_MCP_CONFIG_REL)!;
  assert.equal(rec.action, 'merged');
  assert.equal(rec.backupSha256, sha256(userBytes));
  assert.ok(rec.backup !== undefined);
  assert.equal(backups.map.get(rec.backup!), userBytes, 'backup must hold the EXACT original bytes');
  const merged = JSON.parse(readRel(root, LEAN_MCP_CONFIG_REL));
  assert.deepEqual(merged.mcpServers.mine, { command: 'npx mine --secret TOKEN' });
  assert.deepEqual(merged.mcpServers.alpha, { disabled: true });
  assert.equal(merged.other, 1);
});

test('plan: a same-named user entry is left untouched and warned', async () => {
  const root = wt();
  writeRel(root, LEAN_MCP_CONFIG_REL, JSON.stringify({ mcpServers: { alpha: { command: 'npx alpha --key K' } } }));
  const { applied } = await generate(root, ['alpha', 'beta']);
  const rec = applied.files.find((f) => f.path === LEAN_MCP_CONFIG_REL)!;
  assert.deepEqual(rec.stubbedNames, ['beta'], 'only beta was added');
  assert.ok(applied.warnings.some((w) => w.includes('alpha')));
  const merged = JSON.parse(readRel(root, LEAN_MCP_CONFIG_REL));
  assert.deepEqual(merged.mcpServers.alpha, { command: 'npx alpha --key K' }, 'user entry untouched');
});

test('plan: unparseable user file is backed up and replaced, never edited in place', async () => {
  const root = wt();
  const junk = 'this is not json {';
  writeRel(root, LEAN_MCP_CONFIG_REL, junk);
  const { applied, backups } = await generate(root, ['a']);
  const rec = applied.files.find((f) => f.path === LEAN_MCP_CONFIG_REL)!;
  assert.equal(rec.action, 'merged');
  assert.equal(backups.map.get(rec.backup!), junk);
  assert.ok(applied.warnings.some((w) => w.includes('not parseable')));
  assert.deepEqual(JSON.parse(readRel(root, LEAN_MCP_CONFIG_REL)).mcpServers.a, { disabled: true });
});

test('plan: read_config_from merges minimally — only unset keys go false', async () => {
  const root = wt();
  const userBytes = JSON.stringify({ read_config_from: { claude: true, windsurf: false }, permissions: { allow: ['x'] } }, null, 2);
  writeRel(root, LEAN_CONFIG_REL, userBytes);
  const { applied, backups } = await generate(root, ['a']);
  const rec = applied.files.find((f) => f.path === LEAN_CONFIG_REL)!;
  assert.equal(backups.map.get(rec.backup!), userBytes);
  const merged = JSON.parse(readRel(root, LEAN_CONFIG_REL));
  assert.equal(merged.read_config_from.claude, true, 'user-set value preserved');
  assert.equal(merged.read_config_from.windsurf, false);
  assert.equal(rec.configKeys!.length, READ_CONFIG_FROM_KEYS.length - 2);
  assert.ok(!rec.configKeys!.includes('claude'));
  assert.deepEqual(merged.permissions, { allow: ['x'] });
});

// ─── Crash-safe regeneration (ours-like recognition) ────────────────────────

test('plan: a file holding only our stubs from a prior intent is re-created, not backed up', async () => {
  const root = wt();
  // Simulates a crash after apply but before the receipt journaled.
  writeRel(root, LEAN_MCP_CONFIG_REL, JSON.stringify({ mcpServers: { a: { disabled: true } } }, null, 2));
  const plan = await planLeanWrites({ worktreeRoot: root, names: ['a', 'b'], oursNames: ['a'] });
  assert.ok(plan.ok);
  const mcp = plan.value.files.find((f) => f.rel === LEAN_MCP_CONFIG_REL)!;
  assert.equal(mcp.action, 'created', 'ours-like partial write is recognised as ours');
  assert.equal(mcp.backupBytes, undefined);
});

test('plan: a file with our stubs PLUS user entries is merged, never assumed ours', async () => {
  const root = wt();
  writeRel(root, LEAN_MCP_CONFIG_REL, JSON.stringify({ mcpServers: { a: { disabled: true }, theirs: { command: 'x' } } }));
  const plan = await planLeanWrites({ worktreeRoot: root, names: ['a'], oursNames: ['a'] });
  assert.ok(plan.ok);
  const mcp = plan.value.files.find((f) => f.rel === LEAN_MCP_CONFIG_REL)!;
  assert.equal(mcp.action, 'merged');
});

// ─── apply: backup discipline ───────────────────────────────────────────────

test('apply: an existing run-dir backup is never clobbered (first backup wins)', async () => {
  const root = wt();
  writeRel(root, LEAN_MCP_CONFIG_REL, JSON.stringify({ mcpServers: { theirs: { command: 't' } } }));
  const plan = await planLeanWrites({ worktreeRoot: root, names: ['a'] });
  assert.ok(plan.ok);
  const pristine = 'PRISTINE-FIRST-BACKUP';
  const b = memBackups({ 'lean/mcp_config.local.json.bak': pristine });
  const applied = await applyLeanPlan({ plan: plan.value, backupExists: b.backupExists, writeBackup: b.writeBackup });
  assert.equal(b.map.get('lean/mcp_config.local.json.bak'), pristine);
  assert.ok(applied.warnings.some((w) => w.includes('existing backup')));
});

test('apply: backup failure leaves the user file untouched and reports a failure', async () => {
  const root = wt();
  const userBytes = JSON.stringify({ mcpServers: { theirs: { command: 't' } } });
  writeRel(root, LEAN_MCP_CONFIG_REL, userBytes);
  const plan = await planLeanWrites({ worktreeRoot: root, names: ['a'] });
  assert.ok(plan.ok);
  const applied = await applyLeanPlan({
    plan: plan.value,
    backupExists: async () => false,
    writeBackup: async () => failRes('disk full'),
  });
  assert.ok(applied.failures.some((f) => f.path === LEAN_MCP_CONFIG_REL));
  assert.equal(readRel(root, LEAN_MCP_CONFIG_REL), userBytes, 'user file byte-identical');
});

// ─── git exclude ────────────────────────────────────────────────────────────

test('git exclude: appends both paths once to .git/info/exclude', async () => {
  const root = wt();
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  const r1 = await ensureGitExclude(root);
  assert.ok(r1.applied);
  const content = readFileSync(r1.excludePath!, 'utf8');
  for (const line of LEAN_GIT_EXCLUDE_LINES) assert.ok(content.includes(line));
  const r2 = await ensureGitExclude(root);
  assert.ok(r2.applied);
  assert.deepEqual(r2.added, [], 'idempotent — second run adds nothing');
});

test('git exclude: worktree gitfile resolves through commondir', async () => {
  const root = wt();
  const common = mkdtempSync(join(tmpdir(), 'lean-commondir-'));
  roots.push(common);
  const worktreeGit = join(common, 'worktrees', 'w1');
  mkdirSync(worktreeGit, { recursive: true });
  writeFileSync(join(worktreeGit, 'commondir'), '../..\n');
  writeFileSync(join(root, '.git'), `gitdir: ${worktreeGit}\n`);
  const r = await ensureGitExclude(root);
  assert.ok(r.applied);
  assert.equal(r.excludePath, join(common, 'info', 'exclude'));
  assert.ok(readFileSync(r.excludePath!, 'utf8').includes(LEAN_GIT_EXCLUDE_LINES[0]));
});

test('git exclude: absent .git reports not-applied without failing', async () => {
  const root = wt();
  const r = await ensureGitExclude(root);
  assert.equal(r.applied, false);
  assert.ok(r.warning !== undefined);
});

// ─── restore: exact bytes back, created files gone, idempotent ──────────────

test('restore: created files are deleted, merged files get their exact bytes back', async () => {
  const root = wt();
  const userBytes = JSON.stringify({ mcpServers: { theirs: { command: 'npx t --key SECRET' } }, other: true }, null, 2);
  writeRel(root, LEAN_MCP_CONFIG_REL, userBytes);
  const { applied, backups } = await generate(root, ['a', 'b']);
  assert.equal(applied.files.length, 2);
  const res = await restoreLeanFiles({ worktreeRoot: root, files: applied.files, readBackup: backups.readBackup });
  assert.ok(res.allClean);
  // config.local was created → deleted; mcp_config was merged → exact bytes.
  assert.equal(existsRel(root, LEAN_CONFIG_REL), false);
  assert.equal(readRel(root, LEAN_MCP_CONFIG_REL), userBytes, 'byte-exact restore');
  const outcomes = Object.fromEntries(res.entries.map((e) => [e.path, e.outcome]));
  assert.equal(outcomes[LEAN_CONFIG_REL], 'deleted');
  assert.equal(outcomes[LEAN_MCP_CONFIG_REL], 'restored');
});

test('restore: both created files removed, empty .devin dir cleaned up', async () => {
  const root = wt();
  const { applied, backups } = await generate(root, ['a']);
  const res = await restoreLeanFiles({ worktreeRoot: root, files: applied.files, readBackup: backups.readBackup });
  assert.ok(res.allClean);
  assert.equal(existsRel(root, LEAN_MCP_CONFIG_REL), false);
  assert.equal(existsRel(root, '.devin'), false, 'empty .devin removed');
});

test('restore: idempotent — a second pass skips absent created files, restores merged harmlessly', async () => {
  const root = wt();
  const userBytes = JSON.stringify({ read_config_from: { claude: true } });
  writeRel(root, LEAN_CONFIG_REL, userBytes);
  const { applied, backups } = await generate(root, ['a']);
  const first = await restoreLeanFiles({ worktreeRoot: root, files: applied.files, readBackup: backups.readBackup });
  assert.ok(first.allClean);
  const second = await restoreLeanFiles({ worktreeRoot: root, files: applied.files, readBackup: backups.readBackup });
  // Re-running restore still converges: merged file restored from backup again, created file absent → skipped.
  assert.equal(readRel(root, LEAN_CONFIG_REL), userBytes);
});

test('restore: a merged file whose backup is missing keeps the file with our keys stripped', async () => {
  const root = wt();
  const userBytes = JSON.stringify({ mcpServers: { theirs: { command: 't' } } });
  writeRel(root, LEAN_MCP_CONFIG_REL, userBytes);
  const { applied } = await generate(root, ['a']);
  const noBackups = memBackups();
  const res = await restoreLeanFiles({ worktreeRoot: root, files: applied.files, readBackup: noBackups.readBackup });
  const cur = JSON.parse(readRel(root, LEAN_MCP_CONFIG_REL));
  assert.equal(cur.mcpServers.a, undefined, 'our stub stripped');
  assert.deepEqual(cur.mcpServers.theirs, { command: 't' }, 'user entry kept');
  assert.ok(res.warnings.length > 0);
});

test('restore: a created file that gained outside content is kept minus our keys', async () => {
  const root = wt();
  const { applied, backups } = await generate(root, ['a']);
  // Simulate the user adding their own entry after our generation.
  const cur = JSON.parse(readRel(root, LEAN_MCP_CONFIG_REL));
  cur.mcpServers.user_added = { command: 'npx u' };
  writeRel(root, LEAN_MCP_CONFIG_REL, JSON.stringify(cur));
  const res = await restoreLeanFiles({ worktreeRoot: root, files: applied.files, readBackup: backups.readBackup });
  const after = JSON.parse(readRel(root, LEAN_MCP_CONFIG_REL));
  assert.equal(after.mcpServers.a, undefined);
  assert.deepEqual(after.mcpServers.user_added, { command: 'npx u' });
  const mcpEntry = res.entries.find((e) => e.path === LEAN_MCP_CONFIG_REL)!;
  assert.equal(mcpEntry.outcome, 'kept');
});

test('restore: backup sha mismatch refuses the suspect bytes and falls back to stripping', async () => {
  const root = wt();
  const userBytes = JSON.stringify({ mcpServers: { theirs: { command: 't' } } });
  writeRel(root, LEAN_MCP_CONFIG_REL, userBytes);
  const { applied } = await generate(root, ['a']);
  const tampered = memBackups({ 'lean/mcp_config.local.json.bak': 'TAMPERED-BYTES' });
  const res = await restoreLeanFiles({ worktreeRoot: root, files: applied.files, readBackup: tampered.readBackup });
  const cur = readRel(root, LEAN_MCP_CONFIG_REL);
  assert.notEqual(cur, 'TAMPERED-BYTES');
  assert.ok(res.warnings.some((w) => w.includes('sha256 mismatch')));
  assert.equal(JSON.parse(cur).mcpServers.a, undefined, 'our key stripped in the rescue path');
});

// ─── config binding ─────────────────────────────────────────────────────────

test('resolveConfig: leanMcp is an optional boolean — absent stays absent, non-boolean rejected', () => {
  const absent = resolveConfig({});
  assert.ok(absent.ok);
  assert.equal(absent.value.leanMcp, undefined);
  const on = resolveConfig({ leanMcp: true });
  assert.ok(on.ok);
  assert.equal(on.value.leanMcp, true);
  const off = resolveConfig({ leanMcp: false });
  assert.ok(off.ok);
  assert.equal(off.value.leanMcp, false);
  const bad = resolveConfig({ leanMcp: 'yes' });
  assert.equal(bad.ok, false);
});

test('resolveConfig: flipping leanMcp changes the resolved config (approval-binding visible)', () => {
  const a = resolveConfig({});
  const b = resolveConfig({ leanMcp: true });
  assert.ok(a.ok && b.ok);
  assert.notDeepEqual(a.value, b.value, 'state.config differs → canonical approval hash differs');
});
