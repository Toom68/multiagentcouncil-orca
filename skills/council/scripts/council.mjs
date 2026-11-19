#!/usr/bin/env node
/**
 * council runtime locator — installed beside the council skill so agents can
 * invoke `node <this file> <council args>` without a checkout path.
 *
 * Resolution order (first VALID source wins):
 *   1. COUNCIL_CLI env — explicit absolute path to a built cli.js.
 *   2. This skill dir's .install-manifest.json → runtime.cli (written by
 *      scripts/install.mjs — installed-skill-owned metadata).
 *   3. <home>/.council/install.json → cli (user-scope pointer).
 * Project files under the reviewed target are never trusted as config.
 *
 * The resolved CLI is validated (absolute, exists, regular file, not this
 * wrapper) and invoked as `node <cli> <args>` via an argv array — cwd and
 * the Orca identity environment pass through verbatim. No shell, no PATH
 * search, no disk scan. Failures name the source and the fix.
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(import.meta.url);
const SKILL_DIR = path.resolve(path.dirname(WRAPPER), '..');
const MANIFEST = path.join(SKILL_DIR, '.install-manifest.json');

/**
 * Canonical-path file identity. Node realpaths import.meta.url but keeps
 * argv[1] as typed — a textual resolve() comparison silently mismatches
 * under any symlinked path component (e.g. /var→/private/var on macOS,
 * linked checkouts, dotfile-managed skill dirs). realpath both sides;
 * fall back to the textual match only when realpath itself fails.
 */
function sameFile(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

function homeDir(env) {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

function readPointerCli(file, field) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const cli = doc?.[field];
    return typeof cli === 'string' && cli.length > 0 ? cli : null;
  } catch {
    return null;
  }
}

function manifestVersion() {
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    return m?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A candidate is usable iff it is an absolute path to a real file. */
function validateCli(cli) {
  if (!path.isAbsolute(cli)) return { ok: false, why: 'not an absolute path' };
  if (sameFile(cli, WRAPPER)) {
    return { ok: false, why: 'points at this locator, not the built CLI' };
  }
  try {
    const st = lstatSync(cli);
    if (!st.isFile()) return { ok: false, why: 'not a regular file' };
  } catch {
    return { ok: false, why: 'does not exist' };
  }
  return { ok: true };
}

function resolve(env = process.env) {
  const candidates = [];
  if (typeof env.COUNCIL_CLI === 'string' && env.COUNCIL_CLI.length > 0) {
    candidates.push({ source: 'COUNCIL_CLI env', cli: env.COUNCIL_CLI, explicit: true });
  }
  let manifestCli = null;
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    manifestCli = typeof m?.runtime?.cli === 'string' ? m.runtime.cli : null;
  } catch {
    manifestCli = null;
  }
  if (manifestCli) candidates.push({ source: `${MANIFEST} runtime.cli`, cli: manifestCli });
  const userPointer = path.join(homeDir(env), '.council', 'install.json');
  const userCli = readPointerCli(userPointer, 'cli');
  if (userCli) candidates.push({ source: `${userPointer} cli`, cli: userCli });

  const broken = [];
  for (const c of candidates) {
    const v = validateCli(c.cli);
    if (v.ok) return { found: true, ...c };
    broken.push({ ...c, why: v.why });
    // An explicit override that is wrong must surface, never silently degrade
    // to a managed pointer.
    if (c.explicit) return { found: false, broken, triedEnv: true };
  }
  return { found: false, broken, triedEnv: candidates.length > 0 };
}

const HELP = `council runtime locator v${manifestVersion()}
Usage: node <path-to-this-file> <council command> [args]

Resolves the built multiagent-council CLI in order:
  1. COUNCIL_CLI=<absolute path to dist/src/cli.js>   (explicit override)
  2. <this skill>/.install-manifest.json → runtime.cli (installer-written)
  3. ~/.council/install.json → cli                     (user-scope pointer)
The resolved path must be an existing regular file; it is invoked as
\`node <cli> <args>\` from your current directory with this environment.

Any other arguments are forwarded to the council CLI verbatim.
`;

if (process.argv[1] && sameFile(process.argv[1], WRAPPER)) {
  const args = process.argv.slice(2);
  if (args.includes('--locator-help')) {
    console.log(HELP);
    process.exit(0);
  }
  const r = resolve();
  if (!r.found) {
    console.error('council: no usable runtime located.');
    for (const b of r.broken) console.error(`  ${b.source} -> ${b.cli} (${b.why})`);
    if (r.broken.length === 0) {
      console.error('  No COUNCIL_CLI, skill manifest pointer, or ~/.council/install.json found.');
      console.error('  Install: clone the multiagent-council repository, run `npm install && npm run build`, then `node scripts/install.mjs`.');
    } else {
      console.error('  Fix: rebuild the recorded checkout (`npm run build` there), re-run `node scripts/install.mjs`, or set COUNCIL_CLI to a built dist/src/cli.js.');
    }
    console.error('  --locator-help prints the full resolution order.');
    process.exit(2);
  }
  const forwarded = args.length === 0 || args[0] === '--help' || args[0] === '-h' ? ['help'] : args;
  const child = spawnSync(process.execPath, [r.cli, ...forwarded], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
  if (child.error) {
    console.error(`council: failed to launch node for ${r.cli}: ${child.error.message}`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}
