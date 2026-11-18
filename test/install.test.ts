/**
 * Tests for the public-use installer (scripts/install.mjs) and the installed
 * runtime locator (skills/council/scripts/council.mjs).
 *
 * Everything runs as a real subprocess against isolated temp homes created by
 * mkdtempSync — no test ever writes into a real user directory. The locator's
 * end-to-end cases spawn the repo's built CLI (dist/src/cli.js, produced by
 * `npm run build` before the suite) through the installed skill copy, proving
 * argv/cwd/env pass-through without a pasted checkout path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const INSTALL = join(REPO, 'scripts', 'install.mjs');
const WRAPPER = join(REPO, 'skills', 'council', 'scripts', 'council.mjs');
const BUILT_CLI = join(REPO, 'dist', 'src', 'cli.js');

type Spawned = { status: number | null; stdout: string; stderr: string };

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function install(args: string[], env: NodeJS.ProcessEnv = {}): Spawned {
  const r = spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function wrapper(args: string[], env: NodeJS.ProcessEnv = {}, cwd?: string, wrapperPath = WRAPPER): Spawned {
  const e = { ...process.env };
  delete e.COUNCIL_CLI;
  Object.assign(e, env);
  const r = spawnSync(process.execPath, [wrapperPath, ...args], {
    encoding: 'utf8',
    cwd: cwd ?? REPO,
    env: e,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function out(res: Spawned) {
  return JSON.parse(res.stdout) as {
    ok: boolean;
    dryRun?: boolean;
    scope?: string;
    build?: { cli: string; present: boolean };
    pointer?: { path: string; cli?: string; written?: boolean; removed?: boolean; preserved?: boolean; kind?: string; previousCli?: string; dryRun?: boolean; reason?: string };
    destinations?: Array<{
      dest: string;
      action: string;
      writes?: Array<{ file: string; op: string }>;
      removes?: Array<{ file: string }>;
      preserves?: Array<{ file: string; reason: string }>;
      backups?: Array<{ file: string }>;
      conflicts?: Array<{ reason: string }>;
      manifest?: { runtime?: { cli?: string } };
    }>;
    errors?: string[];
    warnings?: string[];
  };
}

describe('scripts/install.mjs', () => {
  it('--help prints usage and writes nothing', () => {
    const h = tmp('council-h-');
    const r = install(['--home', h, '--dry-run', '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--home/);
    assert.match(r.stdout, /--dry-run/);
    assert.ok(!existsSync(join(h, '.agents')));
  });

  it('rejects unknown args and relative --home', () => {
    assert.equal(install(['--bogus']).status, 2);
    const r = install(['--home', 'relative/path']);
    assert.equal(r.status, 2);
  });

  it('dry-run reports the full plan and writes nothing', () => {
    const h = tmp('council-h-');
    const r = install(['--home', h, '--dry-run', '--json']);
    assert.equal(r.status, 0);
    const j = out(r);
    assert.equal(j.dryRun, true);
    assert.equal(j.destinations?.length, 2);
    assert.ok(j.destinations?.every((d) => d.action === 'install' && (d.writes?.length ?? 0) > 0));
    assert.ok(!existsSync(join(h, '.agents')), 'dry-run must not create dirs');
    assert.ok(!existsSync(join(h, '.council')), 'dry-run must not write the pointer');
  });

  it('installs into both agent skill dirs with manifest + user pointer', () => {
    const h = tmp('council-h-');
    const r = install(['--home', h, '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = out(r);
    assert.ok(j.ok);
    for (const rel of ['.agents/skills/council', '.claude/skills/council']) {
      const dest = join(h, ...rel.split('/'));
      assert.ok(existsSync(join(dest, 'SKILL.md')), `${rel} SKILL.md`);
      assert.ok(existsSync(join(dest, 'scripts', 'council.mjs')), `${rel} locator`);
      assert.ok(existsSync(join(dest, 'references', 'operations.md')), `${rel} references`);
      const m = JSON.parse(readFileSync(join(dest, '.install-manifest.json'), 'utf8')) as {
        name: string;
        schema: number;
        files: Array<{ path: string; sha256: string }>;
        runtime: { cli: string };
      };
      assert.equal(m.name, 'council');
      assert.equal(m.schema, 1);
      assert.ok(m.files.length > 0);
      assert.equal(m.runtime.cli, BUILT_CLI);
    }
    const pointer = JSON.parse(readFileSync(join(h, '.council', 'install.json'), 'utf8')) as { cli: string };
    assert.ok(pointer.cli.endsWith(join('dist', 'src', 'cli.js')) || pointer.cli.endsWith('dist/src/cli.js'));
    // The pointer carries an ownership marker + runtime location only — no
    // provider prefs, and the marker proves it is installer-owned.
    assert.deepEqual(Object.keys(pointer).sort(), ['cli', 'installedAt', 'name', 'schema', 'source', 'version']);
    assert.equal((pointer as { name?: string }).name, 'council');
    assert.equal((pointer as { source?: string }).source, 'multiagent-council');
  });

  it('is idempotent — a second run reports unchanged', () => {
    const h = tmp('council-h-');
    assert.equal(install(['--home', h, '--json']).status, 0);
    const j = out(install(['--home', h, '--json']));
    assert.ok(j.destinations?.every((d) => d.action === 'unchanged'));
    assert.equal(j.errors?.length ?? 0, 0);
  });

  it('update preserves user-modified owned files unless forced, then backs up', () => {
    const h = tmp('council-h-');
    install(['--home', h, '--json']);
    const dest = join(h, '.agents', 'skills', 'council');
    const target = join(dest, 'SKILL.md');
    writeFileSync(target, 'USER EDIT');

    // No force: preserved, not overwritten.
    const j1 = out(install(['--home', h, '--json']));
    const agents = j1.destinations?.find((d) => d.dest.includes('.agents'));
    assert.ok(agents?.preserves?.some((p) => p.file === 'SKILL.md'), JSON.stringify(agents?.preserves));
    assert.equal(readFileSync(target, 'utf8'), 'USER EDIT');

    // Forced: backed up under .council-backups/, file replaced with source.
    const j2 = out(install(['--home', h, '--force', '--json']));
    const agents2 = j2.destinations?.find((d) => d.dest.includes('.agents'));
    assert.ok(agents2?.backups?.some((b) => b.file === 'SKILL.md'));
    assert.notEqual(readFileSync(target, 'utf8'), 'USER EDIT');
    const backupRoot = join(h, '.agents', 'skills', '.council-backups');
    assert.ok(existsSync(backupRoot));
    const stamped = readdirSync(backupRoot);
    assert.equal(stamped.length, 1);
    assert.equal(readFileSync(join(backupRoot, stamped[0]!, 'SKILL.md'), 'utf8'), 'USER EDIT');
  });

  it('refuses a foreign same-named skill dir and leaves it untouched', () => {
    const h = tmp('council-h-');
    const foreign = join(h, '.agents', 'skills', 'council');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'precious.txt'), 'not ours');
    const r = install(['--home', h, '--json']);
    assert.equal(r.status, 1);
    const j = out(r);
    const agents = j.destinations?.find((d) => d.dest.includes('.agents'));
    assert.equal(agents?.action, 'conflict');
    assert.equal(readFileSync(join(foreign, 'precious.txt'), 'utf8'), 'not ours');
    assert.ok(!existsSync(join(foreign, '.install-manifest.json')));
    // The non-conflicting .claude dest still installs.
    assert.ok(existsSync(join(h, '.claude', 'skills', 'council', 'SKILL.md')));
  });

  it('uninstall removes only manifest-owned unmodified files', () => {
    const h = tmp('council-h-');
    install(['--home', h, '--json']);
    const dest = join(h, '.agents', 'skills', 'council');
    const modified = join(dest, 'SKILL.md');
    writeFileSync(modified, 'USER EDIT');
    writeFileSync(join(dest, 'foreign-note.txt'), 'foreign');
    const j = out(install(['--home', h, '--uninstall', '--json']));
    const agents = j.destinations?.find((d) => d.dest.includes('.agents'));
    assert.equal(agents?.action, 'uninstall');
    assert.ok(agents?.removes && agents.removes.length > 0);
    assert.equal(readFileSync(modified, 'utf8'), 'USER EDIT', 'modified file preserved');
    assert.equal(readFileSync(join(dest, 'foreign-note.txt'), 'utf8'), 'foreign', 'foreign file preserved');
    assert.ok(existsSync(join(dest, '.install-manifest.json')), 'manifest kept while preserves remain');
    // .claude dest was unmodified: fully removed.
    assert.ok(!existsSync(join(h, '.claude', 'skills', 'council')));
    // Pointer kept — installed content remains.
    assert.ok(existsSync(join(h, '.council', 'install.json')));
  });

  it('clean uninstall removes everything including the pointer', () => {
    const h = tmp('council-h-');
    install(['--home', h, '--json']);
    const j = out(install(['--home', h, '--uninstall', '--json']));
    assert.ok(j.destinations?.every((d) => d.action === 'uninstall'));
    assert.ok(!existsSync(join(h, '.agents', 'skills', 'council')));
    assert.ok(!existsSync(join(h, '.claude', 'skills', 'council')));
    assert.ok(!existsSync(join(h, '.council', 'install.json')));
  });

  it('refuses to traverse a linked/junction destination', (t) => {
    const h = tmp('council-h-');
    const real = tmp('council-real-');
    const skillsRoot = join(h, '.agents', 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    const dest = join(skillsRoot, 'council');
    try {
      symlinkSync(real, dest, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink/junction creation not permitted here');
      return;
    }
    const r = install(['--home', h, '--json']);
    assert.equal(r.status, 1);
    const j = out(r);
    const agents = j.destinations?.find((d) => d.dest.includes('.agents'));
    assert.equal(agents?.action, 'conflict');
    assert.ok(agents?.conflicts?.some((c) => /link|junction/i.test(c.reason)));
    assert.ok(!existsSync(join(real, 'SKILL.md')), 'nothing written through the link');
  });

  it('project scope installs under the project and writes no user pointer', () => {
    const h = tmp('council-h-');
    const p = tmp('council-proj-');
    const r = install(['--home', h, '--project', p, '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = out(r);
    assert.equal(j.scope, 'project');
    assert.ok(existsSync(join(p, '.agents', 'skills', 'council', 'SKILL.md')));
    assert.ok(existsSync(join(p, '.claude', 'skills', 'council', 'SKILL.md')));
    // Pointer lives only in the skill-adjacent manifest, never in the user home.
    assert.ok(!existsSync(join(h, '.council')));
    const m = JSON.parse(readFileSync(join(p, '.agents', 'skills', 'council', '.install-manifest.json'), 'utf8')) as {
      runtime: { cli: string };
    };
    assert.ok(m.runtime.cli.length > 0);
    // And never inside the reviewed project's own .council either.
    assert.ok(!existsSync(join(p, '.council')));
  });

  it('refuses a linked ancestor under the install root on FRESH install', (t) => {
    const h = tmp('council-h-');
    const outside = tmp('council-outside-');
    try {
      symlinkSync(outside, join(h, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink/junction creation not permitted here');
      return;
    }
    const r = install(['--home', h, '--json']);
    assert.equal(r.status, 1);
    const j = out(r);
    const agents = j.destinations?.find((d) => d.dest.includes('.agents'));
    assert.equal(agents?.action, 'conflict');
    assert.ok(agents?.conflicts?.some((c) => /link|junction|ancestor/i.test(c.reason)));
    assert.equal(readdirSync(outside).length, 0, 'nothing written through the linked ancestor');
    // The unaffected .claude destination still installed.
    assert.ok(existsSync(join(h, '.claude', 'skills', 'council', 'SKILL.md')));
  });

  it('refuses a linked ancestor under the install root on update and uninstall too', (t) => {
    const h = tmp('council-h-');
    const outside = tmp('council-outside-');
    install(['--home', h, '--json']); // clean first install
    const skillsDir = join(h, '.agents', 'skills');
    // Replace <h>/.agents/skills with a junction: update AND uninstall must refuse.
    rmSync(skillsDir, { recursive: true });
    try {
      symlinkSync(outside, skillsDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink/junction creation not permitted here');
      return;
    }
    const upd = out(install(['--home', h, '--json']));
    const updAgents = upd.destinations?.find((d) => d.dest.includes('.agents'));
    assert.equal(updAgents?.action, 'conflict');
    const un = out(install(['--home', h, '--uninstall', '--json']));
    const unAgents = un.destinations?.find((d) => d.dest.includes('.agents'));
    assert.equal(unAgents?.action, 'conflict');
    assert.equal(readdirSync(outside).length, 0);
  });

  it('preserves and reports a foreign (non-owned) pointer — never overwrites it', () => {
    const h = tmp('council-h-');
    const councilDir = join(h, '.council');
    mkdirSync(councilDir, { recursive: true });
    writeFileSync(join(councilDir, 'install.json'), JSON.stringify({ cli: 'C:/someone/else/cli.js', note: 'not ours' }));
    const r = install(['--home', h, '--json']);
    assert.equal(r.status, 1);
    const j = out(r);
    assert.equal(j.pointer?.preserved, true);
    const kept = JSON.parse(readFileSync(join(councilDir, 'install.json'), 'utf8')) as { cli: string };
    assert.equal(kept.cli, 'C:/someone/else/cli.js', 'foreign pointer content untouched');
    // Skill files still installed — the pointer conflict is reported, not blocking.
    assert.ok(existsSync(join(h, '.agents', 'skills', 'council', 'SKILL.md')));
  });

  it('refuses a linked .council ancestor — pointer never written through it', (t) => {
    const h = tmp('council-h-');
    const outside = tmp('council-outside-');
    // .council is a junction — the pointer path must not be followed.
    try {
      symlinkSync(outside, join(h, '.council'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink/junction creation not permitted here');
      return;
    }
    const r = install(['--home', h, '--json']);
    const j = out(r);
    assert.equal(r.status, 1);
    assert.equal(j.pointer?.preserved, true);
    assert.equal(readdirSync(outside).length, 0, 'nothing written through linked .council');
  });

  it('refuses a symlinked pointer file — the link target is never touched', (t) => {
    const h = tmp('council-h-');
    const outside = tmp('council-outside-');
    const councilDir = join(h, '.council');
    mkdirSync(councilDir, { recursive: true });
    const victim = join(outside, 'victim.json');
    writeFileSync(victim, '{"keep":"me"}');
    try {
      symlinkSync(victim, join(councilDir, 'install.json'), 'file');
    } catch {
      t.skip('file symlink not permitted here');
      return;
    }
    const r = install(['--home', h, '--json']);
    const j = out(r);
    assert.equal(r.status, 1);
    assert.equal(j.pointer?.preserved, true);
    assert.equal(readFileSync(victim, 'utf8'), '{"keep":"me"}', 'link target never touched');
  });

  it('refuses a forced backup when .council-backups is a junction — file stays in place', (t) => {
    const h = tmp('council-h-');
    const outside = tmp('council-outside-');
    install(['--home', h, '--json']);
    const dest = join(h, '.agents', 'skills', 'council');
    writeFileSync(join(dest, 'SKILL.md'), 'USER EDIT');
    try {
      symlinkSync(outside, join(h, '.agents', 'skills', '.council-backups'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink/junction creation not permitted here');
      return;
    }
    const j = out(install(['--home', h, '--force', '--json']));
    const agents = j.destinations?.find((d) => d.dest.includes('.agents'));
    assert.ok(agents?.conflicts?.some((c) => /council-backups|link|junction/i.test(c.reason)));
    assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'USER EDIT', 'modified file preserved — no write through link');
    assert.equal(readdirSync(outside).length, 0, 'backup never escaped the root');
  });

  it('refuses to write through a junctioned subdir inside an owned skill dir', (t) => {
    const h = tmp('council-h-');
    const outside = tmp('council-outside-');
    install(['--home', h, '--json']);
    const dest = join(h, '.agents', 'skills', 'council');
    // Owned subdir replaced by a junction whose target lacks the file — the
    // 'missing file → restore' path must not write through the link.
    rmSync(join(dest, 'references'), { recursive: true });
    mkdirSync(join(outside, 'references'), { recursive: true });
    try {
      symlinkSync(join(outside, 'references'), join(dest, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('symlink/junction creation not permitted here');
      return;
    }
    const r = install(['--home', h, '--json']);
    assert.equal(r.status, 1);
    assert.ok(/link|junction/i.test(String(r.stderr) + String(r.stdout)), 'apply failure mentions link/junction');
    assert.ok(!existsSync(join(outside, 'references', 'operations.md')), 'nothing written through the junction');
  });

  it('refreshes an owned pointer on reinstall and reports the previous target', () => {
    const h = tmp('council-h-');
    install(['--home', h, '--json']);
    const pointerPath = join(h, '.council', 'install.json');
    const p = JSON.parse(readFileSync(pointerPath, 'utf8')) as { cli: string };
    p.cli = join(h, 'old-location', 'cli.js');
    writeFileSync(pointerPath, JSON.stringify(p));
    const j = out(install(['--home', h, '--json']));
    assert.equal(j.pointer?.written, true);
    assert.equal(j.pointer?.previousCli, p.cli);
    const now = JSON.parse(readFileSync(pointerPath, 'utf8')) as { cli: string; name: string };
    assert.equal(now.cli, BUILT_CLI);
    assert.equal(now.name, 'council');
  });

  it('uninstall preserves and reports a foreign pointer while still removing owned skills', () => {
    const h = tmp('council-h-');
    install(['--home', h, '--json']);
    const pointerPath = join(h, '.council', 'install.json');
    writeFileSync(pointerPath, JSON.stringify({ cli: 'C:/foreign/cli.js' }));
    const r = install(['--home', h, '--uninstall', '--json']);
    const j = out(r);
    assert.equal(r.status, 1);
    assert.equal(j.pointer?.preserved, true);
    const kept = JSON.parse(readFileSync(pointerPath, 'utf8')) as { cli: string };
    assert.equal(kept.cli, 'C:/foreign/cli.js', 'foreign pointer content untouched');
    assert.ok(!existsSync(join(h, '.agents', 'skills', 'council')));
  });

  it('reports a missing build honestly but still installs the skill', () => {
    const h = tmp('council-h-');
    const j = out(install(['--home', h, '--json']));
    assert.equal(j.build?.cli.endsWith(join('dist', 'src', 'cli.js')) || j.build?.cli.endsWith('dist/src/cli.js'), true);
    // In this checkout the build exists; the field simply must be honest either way.
    assert.equal(j.build?.present, existsSync(BUILT_CLI));
  });
});

describe('skills/council/scripts/council.mjs locator', () => {
  it('--locator-help prints the resolution order and exits 0 without a runtime', () => {
    const h = tmp('council-h-');
    const r = wrapper(['--locator-help'], { HOME: h, USERPROFILE: h });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /COUNCIL_CLI/);
    assert.match(r.stdout, /install\.json/);
  });

  it('fails actionably with no pointer, env, or runtime — exit 2, no disk scan', () => {
    const h = tmp('council-h-');
    const r = wrapper(['status'], { HOME: h, USERPROFILE: h });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no usable runtime/i);
    assert.match(r.stderr, /install\.json|COUNCIL_CLI/);
  });

  it('a broken explicit COUNCIL_CLI surfaces instead of degrading silently', () => {
    const h = tmp('council-h-');
    const missing = join(h, 'nowhere', 'cli.js');
    const r = wrapper(['status'], { HOME: h, USERPROFILE: h, COUNCIL_CLI: missing });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /COUNCIL_CLI/);
    assert.match(r.stderr, /nowhere/);
  });

  it('COUNCIL_CLI runs the resolved CLI: argv/cwd/env pass through, spaced paths ok', () => {
    const spaced = tmp('council spaced dir ');
    const stub = join(spaced, 'fake cli.js');
    writeFileSync(
      stub,
      'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),marker:process.env.COUNCIL_TEST_MARKER??null}))',
    );
    const workDir = tmp('council-work-');
    const r = wrapper(['status', '--json'], { COUNCIL_CLI: stub, COUNCIL_TEST_MARKER: 'm-42' }, workDir);
    assert.equal(r.status, 0, r.stderr);
    const seen = JSON.parse(r.stdout) as { argv: string[]; cwd: string; marker: string | null };
    assert.deepEqual(seen.argv, ['status', '--json']);
    assert.equal(seen.cwd, workDir);
    assert.equal(seen.marker, 'm-42');
  });

  it('installed skill resolves through its manifest and runs the real CLI help', () => {
    const h = tmp('council-h-');
    const r = install(['--home', h, '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const installedWrapper = join(h, '.agents', 'skills', 'council', 'scripts', 'council.mjs');
    const work = tmp('council-target-');
    const w = wrapper([], { HOME: h, USERPROFILE: h }, work, installedWrapper);
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stdout, /init|approve|supervise/i);
  });

  it('a stale manifest pointer fails with the recorded path and a fix', () => {
    const h = tmp('council-h-');
    install(['--home', h, '--json']);
    const manifest = join(h, '.agents', 'skills', 'council', '.install-manifest.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { runtime: { cli: string } };
    m.runtime.cli = join(h, 'moved', 'cli.js');
    writeFileSync(manifest, JSON.stringify(m));
    // User pointer also stale — no valid source remains.
    const pointer = join(h, '.council', 'install.json');
    const p = JSON.parse(readFileSync(pointer, 'utf8')) as { cli: string };
    p.cli = join(h, 'moved', 'cli.js');
    writeFileSync(pointer, JSON.stringify(p));
    const r = wrapper(['status'], { HOME: h, USERPROFILE: h }, undefined, join(h, '.agents', 'skills', 'council', 'scripts', 'council.mjs'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /moved/);
    assert.match(r.stderr, /rebuild|npm run build|COUNCIL_CLI/i);
  });
});
