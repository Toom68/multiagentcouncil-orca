#!/usr/bin/env node
/**
 * Multiagent Council skill installer — zero dependencies, no network.
 *
 * Copies `skills/council/` into per-agent user skill dirs so local coding
 * agents (Devin, modern Codex, Claude Code) discover the skill once, from any
 * project:
 *
 *   <home>/.agents/skills/council   shared agentskills convention (Devin+Codex)
 *   <home>/.claude/skills/council   Claude Code personal skills
 *
 * `--project <dir>` uses `<dir>/.agents/skills` + `<dir>/.claude/skills`.
 * A managed runtime pointer (skill manifest `runtime.cli`, and for user
 * installs `<home>/.council/install.json`) records only the built CLI path —
 * never provider preferences, credentials, PATH, or project instructions.
 *
 * Ownership: each installed dir carries `.install-manifest.json` with
 * per-file sha256. Update replaces only manifest-owned files that are still
 * unmodified; user-modified copies are preserved and reported (`--force`
 * backs them up under <dest>/../.council-backups/<ts>/). A same-named dir
 * without our manifest is foreign — never touched. Uninstall removes only
 * manifest-listed files whose content still matches; everything else stays.
 * Nothing follows a symlink/junction for deletion or replacement.
 *
 * Flags: --home <dir> (explicit isolated home; default real home),
 * --project <dir>, --uninstall, --dry-run, --force, --json, --help.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKILL_SRC = path.join(REPO_ROOT, 'skills', 'council');
const MANIFEST = '.install-manifest.json';
const SKILL_NAME = 'council';
const CLI_REL = path.join('dist', 'src', 'cli.js');

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const VERSION = String(pkg.version ?? '0.0.0');

// ---------------------------------------------------------------- utilities

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function sha256Text(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function within(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when any ancestor directory of `p` beneath `root` is a link/junction. */
function hasLinkedAncestor(root, p) {
  let dir = path.dirname(path.resolve(p));
  const stop = path.resolve(root);
  while (within(stop, dir) && dir !== stop) {
    if (isLink(dir)) return true;
    dir = path.dirname(dir);
  }
  return false;
}

function* walk(dir, prefix = '') {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs, rel);
    else if (e.isFile()) yield rel;
  }
}

/** Read an ownership manifest; {} shapes are distinguished by `kind`. */
function readManifest(destDir) {
  const mp = path.join(destDir, MANIFEST);
  if (isLink(mp) || !existsSync(mp)) return { kind: 'absent' };
  try {
    const m = JSON.parse(readFileSync(mp, 'utf8'));
    if (m && m.schema === 1 && m.name === SKILL_NAME && Array.isArray(m.files)) {
      return { kind: 'owned', manifest: m };
    }
    return { kind: 'foreign', why: 'manifest present but not owned by this installer' };
  } catch {
    return { kind: 'foreign', why: 'unreadable ownership manifest' };
  }
}

function resolveHome(env) {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

/**
 * Canonical-path file identity for the invoked-directly guard. Node
 * realpaths import.meta.url but keeps argv[1] as typed — a textual
 * resolve() comparison silently no-ops whenever the invoked path crosses
 * a symlink/junction (e.g. /var→/private/var on macOS, linked checkouts).
 */
function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * Read the managed runtime pointer. Ownership requires a regular non-link
 * file carrying our schema+name+source marker — anything else is foreign
 * content we must preserve and report, never follow or overwrite.
 */
function readPointer(p) {
  if (!existsSync(p)) return { kind: 'absent' };
  if (isLink(p)) return { kind: 'link' };
  try {
    if (!lstatSync(p).isFile()) return { kind: 'nonfile' };
  } catch {
    return { kind: 'nonfile' };
  }
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    if (doc && doc.schema === 1 && doc.name === SKILL_NAME && doc.source === 'multiagent-council') {
      return { kind: 'owned', doc };
    }
    return { kind: 'foreign' };
  } catch {
    return { kind: 'foreign' };
  }
}

// ------------------------------------------------------------------- plans

function planInstall(srcRoot, destDir, { cli, version, userPointer }) {
  const out = { dest: destDir, action: 'install', writes: [], preserves: [], conflicts: [], warnings: [] };
  if (!within(path.dirname(destDir), destDir)) {
    out.action = 'conflict';
    out.conflicts.push({ reason: 'destination escapes its root', path: destDir });
    return out;
  }
  if (existsSync(destDir)) {
    if (isLink(destDir)) {
      out.action = 'conflict';
      out.conflicts.push({ reason: 'destination is a link/junction — refusing to traverse it', path: destDir });
      return out;
    }
    if (!lstatSync(destDir).isDirectory()) {
      out.action = 'conflict';
      out.conflicts.push({ reason: 'destination exists and is not a directory', path: destDir });
      return out;
    }
  }
  const files = [...walk(srcRoot)].filter((f) => f !== MANIFEST);
  out.writes = files.map((f) => ({ file: f, op: 'write' }));
  out.manifest = {
    schema: 1,
    name: SKILL_NAME,
    source: 'multiagent-council',
    version,
    runtime: { cli },
    files: files.map((f) => ({
      path: f.replaceAll('\\', '/'),
      sha256: sha256File(path.join(srcRoot, f)),
    })),
    installedAt: new Date().toISOString(),
  };
  out.userPointer = userPointer ?? null;
  return out;
}

function planUpdate(srcRoot, destDir, manifest, { cli, version, force, userPointer }) {
  const out = { dest: destDir, action: 'update', writes: [], preserves: [], backups: [], conflicts: [], warnings: [] };
  const owned = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  const srcFiles = [...walk(srcRoot)].filter((f) => f !== MANIFEST);
  const srcSet = new Set(srcFiles);

  for (const rel of srcFiles) {
    const srcAbs = path.join(srcRoot, rel);
    const destAbs = path.join(destDir, rel);
    const destKey = rel.replaceAll('\\', '/');
    const ownedHash = owned.get(destKey);
    if (!existsSync(destAbs)) {
      out.writes.push({ file: rel, op: ownedHash === undefined ? 'write' : 'restore' });
      continue;
    }
    if (isLink(destAbs) || !lstatSync(destAbs).isFile()) {
      out.conflicts.push({ reason: 'path is a link/junction or non-file — refusing to replace', path: destAbs });
      continue;
    }
    if (hasLinkedAncestor(destDir, destAbs)) {
      out.conflicts.push({ reason: 'ancestor directory is a link/junction — refusing to replace through it', path: destAbs });
      continue;
    }
    const disk = sha256File(destAbs);
    const src = sha256File(srcAbs);
    if (disk === src && ownedHash === src) continue; // identical, nothing to do
    if (ownedHash === undefined) {
      // File ships in source but exists on disk and was never owned by us.
      out.conflicts.push({ reason: 'foreign file at a path this release ships — not overwriting', path: destAbs });
      continue;
    }
    if (disk === ownedHash) {
      out.writes.push({ file: rel, op: 'update' }); // owned and unmodified
      continue;
    }
    // Owned file the user modified: preserve unless forced.
    if (force) {
      out.writes.push({ file: rel, op: 'force-update' });
      out.backups.push({ file: rel, path: destAbs });
    } else {
      out.preserves.push({ file: rel, reason: 'user-modified since install (use --force to replace with backup)' });
    }
  }
  // A pre-planted linked backup root would leak files outside the root —
  // refuse the whole force-overwrite and keep the modified copies in place.
  if (out.backups.length > 0 && isLink(path.join(path.dirname(destDir), '.council-backups'))) {
    const leaked = new Set(out.backups.map((b) => b.file));
    out.writes = out.writes.filter((w) => !leaked.has(w.file));
    for (const f of leaked) out.preserves.push({ file: f, reason: 'backup root is a link/junction — refusing to write through it' });
    out.backups = [];
    out.conflicts.push({ reason: '.council-backups is a link/junction — refusing forced backup', path: path.join(path.dirname(destDir), '.council-backups') });
  }
  // Foreign files inside the owned dir (never in the manifest) are preserved.
  if (existsSync(destDir)) {
    for (const rel of walk(destDir)) {
      const key = rel.replaceAll('\\', '/');
      if (key === MANIFEST || owned.has(key)) continue;
      if (!srcSet.has(rel) && !srcSet.has(key)) {
        out.preserves.push({ file: rel, reason: 'foreign file inside owned dir — left in place' });
      }
    }
  }
  out.manifest = {
    schema: 1,
    name: SKILL_NAME,
    source: 'multiagent-council',
    version,
    runtime: { cli },
    files: srcFiles.map((f) => ({
      path: f.replaceAll('\\', '/'),
      sha256: sha256File(path.join(srcRoot, f)),
    })),
    installedAt: manifest.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  out.userPointer = userPointer ?? null;
  if (out.writes.length === 0 && out.conflicts.length === 0) out.action = 'unchanged';
  return out;
}

function planUninstall(destDir, manifest) {
  const out = { dest: destDir, action: 'uninstall', removes: [], preserves: [], conflicts: [], warnings: [] };
  for (const f of manifest.files) {
    const abs = path.join(destDir, f.path);
    if (!existsSync(abs)) continue;
    if (isLink(abs) || !lstatSync(abs).isFile() || hasLinkedAncestor(destDir, abs)) {
      out.preserves.push({ file: f.path, reason: 'link/junction or non-file — refusing to delete' });
      continue;
    }
    if (sha256File(abs) === f.sha256) out.removes.push({ file: f.path });
    else out.preserves.push({ file: f.path, reason: 'modified since install — left in place' });
  }
  return out;
}

// ------------------------------------------------------------------ apply

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function copyFile(srcAbs, destAbs, destRoot) {
  if (!within(path.dirname(destAbs), destAbs)) throw new Error(`refusing path outside target: ${destAbs}`);
  // A link/junction planted between the skill root and the file (or the file
  // itself) must never be traversed for a write — checked again at apply
  // time because existence checks alone see through the link.
  if (isLink(destAbs) || hasLinkedAncestor(destRoot, destAbs)) {
    throw new Error(`refusing to write through link/junction: ${destAbs}`);
  }
  ensureDir(path.dirname(destAbs));
  writeFileSync(destAbs, readFileSync(srcAbs));
}

function backupFile(srcAbs, backupRoot, rel) {
  const dest = path.join(backupRoot, rel);
  ensureDir(path.dirname(dest));
  renameSync(srcAbs, dest);
}

function applyPlan(plan, srcRoot, { dryRun }) {
  if (dryRun) return;
  if (plan.action === 'conflict') return;
  const backupRoot = path.join(path.dirname(plan.dest), '.council-backups', new Date().toISOString().replaceAll(':', '-'));
  for (const w of plan.writes ?? []) {
    if (w.op === 'force-update') backupFile(path.join(plan.dest, w.file), backupRoot, w.file);
    copyFile(path.join(srcRoot, w.file), path.join(plan.dest, w.file), plan.dest);
  }
  for (const r of plan.removes ?? []) {
    const rmAbs = path.join(plan.dest, r.file);
    if (isLink(rmAbs) || hasLinkedAncestor(plan.dest, rmAbs)) continue; // never traverse a link for deletion
    rmSync(rmAbs);
  }
  if (plan.manifest) {
    ensureDir(plan.dest);
    writeFileSync(path.join(plan.dest, MANIFEST), JSON.stringify(plan.manifest, null, 2) + '\n');
  }
  if (plan.action === 'uninstall') {
    // Remove the manifest only when it is still ours and unmodified.
    const mp = path.join(plan.dest, MANIFEST);
    if (existsSync(mp) && !isLink(mp) && plan.preserves.length === 0) {
      rmSync(mp);
      pruneEmptyDirs(plan.dest);
    }
  }
}

function pruneEmptyDirs(root) {
  // Remove now-empty directories under root, deepest first; root itself too.
  if (!existsSync(root) || isLink(root)) return;
  const dirs = [];
  for (const e of readdirSync(root, { withFileTypes: true, recursive: false })) {
    if (e.isDirectory() && !isLink(path.join(root, e.name))) dirs.push(path.join(root, e.name));
  }
  for (const d of dirs) pruneEmptyDirs(d);
  try {
    rmdirSync(root); // empty dirs only — never recursive
  } catch {
    /* not empty — keep */
  }
}

// -------------------------------------------------------------------- cli

const USAGE = `council skill installer — zero-dependency, no network.

Usage: node scripts/install.mjs [options]

  --home <dir>     Home directory to install under (default: your real home).
                   Tests and staging must always pass an isolated temp home.
  --project <dir>  Install into <dir>/.agents/skills and <dir>/.claude/skills
                   instead of the user's home (no user runtime pointer).
  --uninstall      Remove manifest-owned files only; anything modified or
                   foreign is preserved and reported.
  --dry-run        Print the full plan; write absolutely nothing.
  --force          Update: back up user-modified owned files under
                   .council-backups/<timestamp>/ then replace them.
  --json           Machine-readable plan/result.
  --help           This text.

Never overwrites a same-named foreign skill, follows a link for
delete/replace, or touches settings, credentials, PATH, or other projects.`;

export function run(argv, env = process.env) {
  const args = { home: null, project: null, uninstall: false, dryRun: false, force: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--force') args.force = true;
    else if (a === '--uninstall') args.uninstall = true;
    else if (a === '--home') args.home = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a.startsWith('--home=')) args.home = a.slice(7);
    else if (a.startsWith('--project=')) args.project = a.slice(9);
    else return { ok: false, code: 2, errors: [`unknown argument: ${a}`] };
  }
  if (args.help) return { ok: true, code: 0, help: USAGE };

  const home = args.home !== null && args.home !== undefined ? path.resolve(args.home) : path.resolve(resolveHome(env));
  if (args.home !== null && args.home !== undefined && !path.isAbsolute(args.home)) {
    return { ok: false, code: 2, errors: [`--home must be absolute: ${args.home}`] };
  }
  if (!existsSync(SKILL_SRC)) {
    return { ok: false, code: 1, errors: [`skill source missing: ${SKILL_SRC}`] };
  }

  const cli = path.join(REPO_ROOT, CLI_REL);
  const build = { cli, present: existsSync(cli) && lstatSync(cli).isFile() };
  const destRoots = args.project
    ? [path.join(path.resolve(args.project), '.agents', 'skills'), path.join(path.resolve(args.project), '.claude', 'skills')]
    : [path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills')];
  const userPointerPath = args.project ? null : path.join(home, '.council', 'install.json');

  const result = {
    ok: true,
    code: 0,
    json: args.json,
    dryRun: args.dryRun,
    scope: args.project ? 'project' : 'user',
    home,
    version: VERSION,
    build,
    destinations: [],
    pointer: null,
    warnings: [],
    errors: [],
  };
  if (!build.present) {
    result.warnings.push(
      `built CLI not found at ${cli} — the pointer is still recorded; run \`npm install && npm run build\` in that checkout before agents invoke the skill`,
    );
  }

  const scopeRoot = args.project ? path.resolve(args.project) : home;
  for (const root of destRoots) {
    const dest = path.join(root, SKILL_NAME);
    // A linked ancestor anywhere under the intended root (e.g. ~/.agents or
    // ~/.agents/skills) makes every write AND every removal unsafe — refuse
    // the destination outright rather than traverse the link.
    if (hasLinkedAncestor(scopeRoot, dest)) {
      result.destinations.push({
        dest,
        action: 'conflict',
        conflicts: [{ reason: 'ancestor directory under install root is a link/junction — refusing to write or remove through it', path: dest }],
      });
      result.errors.push(`conflict at ${dest}: linked ancestor under install root`);
      result.ok = false;
      continue;
    }
    if (args.uninstall) {
      const m = readManifest(dest);
      if (m.kind === 'absent') {
        result.destinations.push({ dest, action: 'skip', reason: existsSync(dest) ? 'no ownership manifest — foreign or never installed' : 'not installed' });
        continue;
      }
      if (m.kind === 'foreign') {
        result.destinations.push({ dest, action: 'conflict', conflicts: [{ reason: m.why, path: dest }] });
        result.errors.push(`refusing to uninstall foreign dir: ${dest}`);
        result.ok = false;
        continue;
      }
      const plan = planUninstall(dest, m.manifest);
      try {
        applyPlan(plan, SKILL_SRC, { dryRun: args.dryRun });
      } catch (e) {
        result.errors.push(`apply failed at ${dest}: ${e instanceof Error ? e.message : String(e)}`);
        result.ok = false;
      }
      result.destinations.push(plan);
      continue;
    }

    const m = readManifest(dest);
    let plan;
    if (!existsSync(dest)) {
      plan = planInstall(SKILL_SRC, dest, { cli, version: VERSION, userPointer: userPointerPath });
    } else if (isLink(dest)) {
      plan = { dest, action: 'conflict', writes: [], preserves: [], backups: [], conflicts: [{ reason: 'destination is a link/junction — refusing to traverse it', path: dest }], warnings: [] };
    } else if (m.kind === 'foreign') {
      plan = { dest, action: 'conflict', writes: [], preserves: [], backups: [], conflicts: [{ reason: m.why, path: dest }], warnings: [] };
    } else if (m.kind === 'absent') {
      plan = { dest, action: 'conflict', writes: [], preserves: [], backups: [], conflicts: [{ reason: 'same-named skill dir without our ownership manifest — refusing to touch it', path: dest }], warnings: [] };
    } else {
      plan = planUpdate(SKILL_SRC, dest, m.manifest, { cli, version: VERSION, force: args.force, userPointer: userPointerPath });
    }
    if (plan.action === 'conflict') result.errors.push(`conflict at ${dest}: ${plan.conflicts.map((c) => c.reason).join('; ')}`);
    try {
      applyPlan(plan, SKILL_SRC, { dryRun: args.dryRun });
    } catch (e) {
      result.errors.push(`apply failed at ${dest}: ${e instanceof Error ? e.message : String(e)}`);
      result.ok = false;
    }
    result.destinations.push(plan);
  }

  // Pointer lifecycle on uninstall: remove the user pointer only when every
  // destination was fully released AND the pointer is provably ours — a
  // regular non-link file carrying the ownership marker, beneath an unlinked
  // ancestor chain. Foreign/linked/modified content is preserved + reported.
  if (args.uninstall && userPointerPath && !args.dryRun && existsSync(userPointerPath)) {
    const pRead = readPointer(userPointerPath);
    if (pRead.kind !== 'owned' || hasLinkedAncestor(scopeRoot, userPointerPath)) {
      const why = pRead.kind !== 'owned' ? `pointer is ${pRead.kind}` : 'linked ancestor under home';
      result.pointer = { path: userPointerPath, removed: false, preserved: true, reason: `${why} — left untouched` };
      result.errors.push(`refusing to remove pointer at ${userPointerPath}: ${why}`);
      result.ok = false;
    } else {
      const released = result.destinations.filter((d) => d.action === 'uninstall');
      const leftovers = released.some((d) => (d.preserves?.length ?? 0) > 0);
      if (released.length > 0 && !leftovers) {
        rmSync(userPointerPath);
        result.pointer = { path: userPointerPath, removed: true };
        const parent = path.dirname(userPointerPath);
        if (!isLink(parent)) {
          try {
            rmdirSync(parent);
          } catch {
            /* not empty — keep */
          }
        }
      } else {
        result.pointer = { path: userPointerPath, removed: false, reason: 'installed content remains or nothing was released' };
      }
    }
  }

  // Managed runtime pointer — user scope only, runtime path only. An
  // existing pointer is overwritten only when provably ours.
  if (!args.uninstall && userPointerPath && !args.dryRun) {
    const anyConflict = result.destinations.every((d) => d.action === 'conflict');
    if (!anyConflict) {
      const pRead = readPointer(userPointerPath);
      if (pRead.kind === 'absent' || pRead.kind === 'owned') {
        if (hasLinkedAncestor(scopeRoot, userPointerPath)) {
          result.pointer = { path: userPointerPath, written: false, preserved: true, reason: 'linked ancestor under home — pointer not written' };
          result.errors.push(`refusing to write pointer at ${userPointerPath}: linked ancestor`);
          result.ok = false;
        } else {
          ensureDir(path.dirname(userPointerPath));
          const previousCli = pRead.kind === 'owned' && typeof pRead.doc.cli === 'string' && pRead.doc.cli !== cli ? pRead.doc.cli : undefined;
          writeFileSync(
            userPointerPath,
            JSON.stringify({ schema: 1, name: SKILL_NAME, source: 'multiagent-council', cli, version: VERSION, installedAt: new Date().toISOString() }, null, 2) + '\n',
          );
          result.pointer = { path: userPointerPath, cli, written: true, ...(previousCli === undefined ? {} : { previousCli }) };
        }
      } else {
        result.pointer = { path: userPointerPath, written: false, preserved: true, kind: pRead.kind, reason: `existing pointer is ${pRead.kind} — not installer-owned, left untouched` };
        result.errors.push(`refusing to overwrite ${pRead.kind} pointer at ${userPointerPath}`);
        result.ok = false;
      }
    }
  } else if (!args.uninstall && userPointerPath) {
    result.pointer = { path: userPointerPath, cli, written: false, dryRun: true };
  }

  if (result.errors.length > 0) {
    result.ok = false;
    result.code = 1;
  }
  return result;
}

function printHuman(r) {
  if (r.help) {
    console.log(r.help);
    return;
  }
  const mode = r.dryRun ? 'DRY-RUN ' : '';
  console.log(`${mode}council install v${r.version ?? '?'} — scope=${r.scope ?? '?'} home=${r.home ?? '?'}`);
  if (r.build) console.log(`cli: ${r.build.cli} ${r.build.present ? '(present)' : '(MISSING — build the checkout)'}`);
  for (const d of r.destinations ?? []) {
    console.log(`- ${d.dest}`);
    console.log(`  action: ${d.action}`);
    for (const w of d.writes ?? []) console.log(`    ${w.op}: ${w.file}`);
    for (const rm of d.removes ?? []) console.log(`    remove: ${rm.file}`);
    for (const b of d.backups ?? []) console.log(`    backup: ${b.file}`);
    for (const p of d.preserves ?? []) console.log(`    preserve: ${p.file} (${p.reason})`);
    for (const c of d.conflicts ?? []) console.log(`    CONFLICT: ${c.reason}`);
    if (d.reason) console.log(`    ${d.reason}`);
  }
  if (r.pointer) console.log(`pointer: ${r.pointer.path} ${r.pointer.written ? '(written)' : '(not written)'}`);
  for (const w of r.warnings ?? []) console.log(`warning: ${w}`);
  for (const e of r.errors ?? []) console.log(`error: ${e}`);
  console.log(r.ok ? 'ok' : 'FAILED');
}

if (process.argv[1] && sameFile(process.argv[1], fileURLToPath(import.meta.url))) {
  const r = run(process.argv.slice(2));
  if (r.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    printHuman(r);
  }
  process.exitCode = r.code ?? (r.ok ? 0 : 1);
}
