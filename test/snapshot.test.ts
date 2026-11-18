/**
 * Tests for src/snapshot.ts — run from dist/test against OS temp dirs.
 * Covers determinism, exclusions, secrets, symlinks, unsafe names, limits,
 * git HEAD capture (dir + worktree file + packed-refs + non-git), drift diff,
 * Windows-style paths with spaces, and no-mutation of the scanned tree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  captureSnapshot,
  diffSnapshotFiles,
  manifestHeadHash,
  readGitHead,
  scanSourceTree,
  SNAPSHOT_EXCLUDED_DIRS,
  SNAPSHOT_SECRET_DIRS,
} from '../src/snapshot.js';
import { parseSourceSnapshot } from '../src/validation.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'council-snap-'));
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

const SHA = /^[0-9a-f]{64}$/;

test('captures a deterministic sorted manifest on a basic tree', async () => {
  const root = tmp();
  writeTree(root, {
    'b/second.ts': 'export const two = 2;\n',
    'a/first.ts': 'export const one = 1;\n',
    'README.md': '# hello\n',
  });
  const a = await captureSnapshot(root);
  assert.ok(a.ok, JSON.stringify(a));
  const snap = a.value;
  assert.deepEqual(Object.keys(snap.files), ['README.md', 'a/first.ts', 'b/second.ts']);
  for (const entry of Object.values(snap.files)) {
    assert.match(entry.sha256, SHA);
    assert.ok(entry.size > 0);
  }
  assert.match(snap.headHash, SHA);
  assert.equal(snap.gitHead, null); // not a git checkout
  assert.equal(manifestHeadHash(snap.files), snap.headHash);
  // Parser self-consistency is guaranteed by captureSnapshot.
  assert.ok(parseSourceSnapshot(snap).ok);

  const b = await captureSnapshot(root, { takenAt: new Date() });
  assert.ok(b.ok);
  assert.equal(b.value.headHash, snap.headHash, 'same tree → same headHash');
  assert.equal(b.value.snapshotId, snap.snapshotId, 'default id is content-derived');
});

test('a root directory name containing spaces canonicalizes fine', async () => {
  const parent = tmp();
  const root = path.join(parent, 'my project dir');
  mkdirSync(root);
  writeTree(root, { 'src/x.ts': 'x\n' });
  const r = await captureSnapshot(root);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.value.targetRoot.includes('my project dir'));
  assert.deepEqual(Object.keys(r.value.files), ['src/x.ts']);
});

test('excluded runtime/control/generated dirs never enter the manifest', async () => {
  const root = tmp();
  writeTree(root, { 'src/keep.ts': 'keep\n' });
  for (const dir of SNAPSHOT_EXCLUDED_DIRS) {
    writeTree(root, { [`${dir}/generated.js`]: 'generated\n' });
  }
  const r = await captureSnapshot(root);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value.files), ['src/keep.ts']);
  // And the scan itself reports what it skipped.
  const scan = await scanSourceTree(r.value.targetRoot);
  assert.ok(scan.ok);
  assert.equal(scan.value.skipped.excludedDirs, SNAPSHOT_EXCLUDED_DIRS.length);
});

test('secret files/dirs are skipped and recorded, templates are kept', async () => {
  const root = tmp();
  writeTree(root, {
    '.env': 'TOKEN=abc\n',
    '.env.local': 'TOKEN=abc\n',
    '.env.example': 'TOKEN=\n',
    'keys/private.pem': 'PEM\n',
    'keys/api.key': 'KEY\n',
    'id_rsa': 'PRIVATE\n',
    '.npmrc': '//registry/:_authToken=x\n',
    'src/app.ts': 'ok\n',
  });
  for (const dir of SNAPSHOT_SECRET_DIRS) {
    writeTree(root, { [`${dir}/credentials`]: 'secret\n' });
  }
  const scan = await scanSourceTree(root);
  assert.ok(scan.ok);
  const manifest = Object.keys(scan.value.files);
  assert.ok(manifest.includes('src/app.ts'));
  assert.ok(manifest.includes('.env.example'), 'templates are reviewable');
  assert.ok(!manifest.some((p) => p === '.env' || p === '.env.local'));
  assert.ok(!manifest.some((p) => p.startsWith('keys/') || p === 'id_rsa' || p === '.npmrc'));
  assert.ok(!manifest.some((p) => p.split('/').some((s) => SNAPSHOT_SECRET_DIRS.includes(s))));
  assert.deepEqual(
    scan.value.skipped.secretFiles.sort(),
    ['.env', '.env.local', '.npmrc', 'id_rsa', 'keys/api.key', 'keys/private.pem'].sort(),
  );
});

test('symlinks/junctions are skipped, never followed', async (t) => {
  const root = tmp();
  const outside = tmp();
  writeTree(outside, { 'outside.txt': 'outside\n' });
  writeTree(root, { 'real.txt': 'real\n' });
  try {
    symlinkSync(outside, path.join(root, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    t.skip(`cannot create directory link here: ${e}`);
    return;
  }
  const scan = await scanSourceTree(root);
  assert.ok(scan.ok);
  assert.deepEqual(Object.keys(scan.value.files), ['real.txt']);
  assert.deepEqual(scan.value.skipped.symlinks, ['linkdir']);
  // File symlink best-effort (needs privilege on Windows).
  try {
    symlinkSync(path.join(root, 'real.txt'), path.join(root, 'linkfile.txt'), 'file');
  } catch {
    return; // platform refused; dir-junction check above already covered policy
  }
  const scan2 = await scanSourceTree(root);
  assert.ok(scan2.ok);
  assert.deepEqual(Object.keys(scan2.value.files), ['real.txt']);
  assert.deepEqual(scan2.value.skipped.symlinks.sort(), ['linkdir', 'linkfile.txt']);
});

test('files with unsafe relative paths are skipped and recorded', async () => {
  const root = tmp();
  writeTree(root, { 'with space.txt': 'spaced\n', 'normal.txt': 'ok\n' });
  const scan = await scanSourceTree(root);
  assert.ok(scan.ok);
  assert.deepEqual(Object.keys(scan.value.files), ['normal.txt']);
  assert.deepEqual(scan.value.skipped.unsafePaths, ['with space.txt']);
});

test('git HEAD is captured from a real-style .git directory', async () => {
  const root = tmp();
  const head = 'a'.repeat(40);
  writeTree(root, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/refs/heads/main': `${head}\n`,
    'src/x.ts': 'x\n',
  });
  const r = await captureSnapshot(root);
  assert.ok(r.ok);
  assert.equal(r.value.gitHead, head);
  // .git itself is excluded from the manifest.
  assert.deepEqual(Object.keys(r.value.files), ['src/x.ts']);
});

test('git HEAD resolves via a worktree .git file and packed-refs', async () => {
  const root = tmp();
  const gitdir = path.join(tmp(), 'actual-gitdir');
  const head = 'b'.repeat(40);
  mkdirSync(path.join(gitdir, 'refs', 'heads'), { recursive: true });
  writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/wt\n');
  // Loose ref missing → falls back to packed-refs.
  writeFileSync(path.join(gitdir, 'packed-refs'), `# pack\n${head} refs/heads/wt\n`);
  writeFileSync(path.join(root, '.git'), `gitdir: ${gitdir}\n`);
  writeTree(root, { 'f.txt': 'f\n' });
  const r = await captureSnapshot(root);
  assert.ok(r.ok);
  assert.equal(r.value.gitHead, head);
});

test('detached HEAD is captured directly', async () => {
  const root = tmp();
  const head = 'c'.repeat(40);
  writeTree(root, { '.git/HEAD': `${head}\n`, 'f.txt': 'f\n' });
  assert.equal(await readGitHead(root), head);
});

test('limits: too many files, oversize file, missing root, file root', async () => {
  const root = tmp();
  writeTree(root, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'big.bin': 'x'.repeat(1024) });

  const many = await captureSnapshot(root, { limits: { maxFiles: 2 } });
  assert.ok(!many.ok);
  assert.equal(many.error.details?.reason, 'too_many_files');

  const big = await captureSnapshot(root, { limits: { maxFileBytes: 16 } });
  assert.ok(!big.ok);
  assert.equal(big.error.details?.reason, 'file_too_large');
  assert.equal(big.error.details?.file, 'big.bin');

  const missing = await captureSnapshot(path.join(root, 'does-not-exist'));
  assert.ok(!missing.ok);
  assert.equal(missing.error.details?.reason, 'root_unreadable');

  const asFile = await captureSnapshot(path.join(root, 'a.txt'));
  assert.ok(!asFile.ok);
  assert.equal(asFile.error.details?.reason, 'root_not_directory');
});

test('drift diff detects added, removed and modified paths', async () => {
  const root = tmp();
  writeTree(root, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  const s1 = await scanSourceTree(root);
  assert.ok(s1.ok);
  const beforeFiles = s1.value.files;

  writeFileSync(path.join(root, 'a.txt'), 'a-changed\n'); // modify
  writeFileSync(path.join(root, 'd.txt'), 'd\n'); // add
  await fsp.rm(path.join(root, 'b.txt')); // remove

  const s2 = await scanSourceTree(root);
  assert.ok(s2.ok);
  assert.deepEqual(diffSnapshotFiles(beforeFiles, s2.value.files), ['a.txt', 'b.txt', 'd.txt']);
});

test('capture never mutates the target tree', async () => {
  const root = tmp();
  writeTree(root, { 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
  const listing = (d: string): string[] =>
    readdirSync(d, { recursive: true }).map(String).sort();
  const beforeEntries = listing(root);
  const r = await captureSnapshot(root);
  assert.ok(r.ok);
  assert.deepEqual(listing(root), beforeEntries, 'no files created/removed');
  assert.equal(existsSync(path.join(root, '.council-dev')), false);
});

test('empty tree produces an empty manifest and valid snapshot', async () => {
  const root = tmp();
  const r = await captureSnapshot(root);
  assert.ok(r.ok);
  assert.deepEqual(r.value.files, {});
  assert.match(r.value.headHash, SHA);
  assert.ok(parseSourceSnapshot(r.value).ok);
});
