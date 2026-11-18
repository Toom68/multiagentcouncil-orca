# AI-facing installation guide

This document is for a **coding agent** whose user asked it to install
Multiagent Council. It is self-contained: you do not need to read the rest of
the repository to perform a correct install. Everything here describes
`scripts/install.mjs` as implemented — verify against `node
scripts/install.mjs --help` if this file and the installer ever disagree.

## When installation is authorized

Install **only on an explicit user request** — e.g. "install the council
skill", "set up council so agents can run it", "make council available in this
project". A request to *use* a council implies a working install; a request
that never mentioned installing does not authorize one. When the request is
ambiguous about scope, ask one short question:

- **User install (default)** — the user wants the skill discoverable from any
  project on this machine.
- **Project install (`--project <dir>`)** — the user opted in to scoping the
  skill to one project only.

Never install on your own initiative, into a different user's home, or as a
side effect of an unrelated task.

## Prerequisites

- Node.js **≥ 22** (`node --version`). The installer and runtime are pure
  Node, zero dependencies, no network access.
- Git, to clone the repository.
- Windows, macOS, or Linux — paths below are written POSIX-style; use the
  platform equivalent (the installer handles both).

## Clone and build

```sh
git clone https://github.com/Toom68/multiagentcouncil-orca.git
cd multiagentcouncil-orca
npm install
npm run build        # produces dist/src/cli.js — the runtime the skill locates
```

Keep the checkout: the installed skill does **not** copy the runtime. Its
managed pointer records this checkout's `dist/src/cli.js`, so do not move or
delete the directory afterwards (if you must, re-run the installer to refresh
the pointer, or set `COUNCIL_CLI`).

## Inspect before writing (always)

```sh
node scripts/install.mjs --dry-run --json        # user scope
node scripts/install.mjs --project <dir> --dry-run --json   # project scope
```

Dry-run prints the full plan — every write, preserve, conflict, and the
pointer it would record — and **writes nothing**. Read it. A `conflict`
action means the installer found something it refuses to touch (see below);
report it to the user rather than working around it.

## Install

```sh
node scripts/install.mjs --json                  # default: user install
node scripts/install.mjs --project <dir> --json  # opted-in project install
```

**User install** copies `skills/council/` into both per-agent skill roots:

- `<home>/.agents/skills/council` — shared agentskills convention (Devin,
  modern Codex)
- `<home>/.claude/skills/council` — Claude Code personal skills

and writes the user-scope runtime pointer `<home>/.council/install.json`.

**Project install** copies into `<dir>/.agents/skills/council` and
`<dir>/.claude/skills/council` only, and writes **no** user pointer — each
installed copy still carries its own manifest pointer.

A missing `dist/src/cli.js` is a warning, not a failure: the skill installs
and the pointer is recorded, but council commands fail until you run
`npm install && npm run build` in the recorded checkout.

## Verify

```sh
node "<home-or-project>/.agents/skills/council/scripts/council.mjs" catalog --json
```

- Exit 0 with a JSON catalog ⇒ the locator resolved the built runtime.
- Exit 2 naming a pointer ⇒ the recorded CLI is missing or stale; rebuild the
  recorded checkout, re-run the installer, or export `COUNCIL_CLI`.
- Re-running the installer is idempotent — a clean second run reports
  `unchanged` for every destination.

**Discovery is per-session.** If the agent's next session does not show the
`council` skill, open a fresh session — skill refresh behavior differs by
client (Codex rescans `~/.agents/skills` automatically; other clients vary),
so do not claim a running session cannot reload.

## Runtime resolution order (what the skill does at run time)

`skills/council/scripts/council.mjs` resolves the built CLI in order:

1. `COUNCIL_CLI` — explicit absolute path override; a broken override fails
   visibly, it never degrades to a managed pointer.
2. The skill copy's `.install-manifest.json` → `runtime.cli`.
3. `~/.council/install.json` → `cli` (user installs only).

The resolved path must be an existing regular file. The wrapper invokes
`node <cli> <args>` via an argv array with the caller's cwd and environment —
no shell, no PATH search, no disk scan, no fallback to a similarly named
command.

## Safety and preservation rules (enforced by the installer)

- **Foreign skills are never touched.** A same-named `council` dir without
  our ownership manifest is a conflict — reported, left byte-identical.
- **Ownership is hashed.** Each install writes `.install-manifest.json` with
  per-file sha256. Update replaces only manifest-owned files still matching
  their recorded hash.
- **User edits are preserved.** A modified owned file is kept and reported;
  `--force` moves it to `.council-backups/<timestamp>/` first, then replaces.
- **Uninstall is conservative.** Only manifest-owned, unmodified files are
  removed; modified or foreign files stay and are reported. The user pointer
  is removed only when every destination released cleanly and the pointer is
  provably ours.
- **No link/junction traversal.** The installer refuses to write or delete
  through a symlink/junction — the destination itself, any ancestor under the
  install root, a junctioned in-skill subdir, or a linked `.council-backups`.

```sh
node scripts/install.mjs --uninstall --dry-run --json   # preview removal
node scripts/install.mjs --uninstall --json             # remove owned files
```

## What the installer never does

- Never installs for the consumer ChatGPT or Claude apps — these are user
  skills for **local coding agents** (Devin, Codex, Claude Code CLIs),
  typically inside Orca. Do not claim desktop-app compatibility.
- Never changes provider settings, credentials, PATH, global permissions,
  npm global packages, or project instructions (no edits to `AGENTS.md`,
  shell profiles, or Git config).
- Never records provider preferences — the pointer stores only the runtime
  path and ownership marker.
- Never performs an Orca skill/plugin registration — none exists for
  third-party skills on the verified Orca build.
- Never probes providers or launches agent CLIs to "test" them.

## After install: what the user/agent needs to know

- Staff and seat provider choices are **not** part of installation — they are
  made per run and bound by the roster approval. The installer does not and
  cannot pick a default provider.
- `council doctor --json` (through the locator) reports environment readiness
  and catalog lanes; binary presence is PATH visibility, not authentication.
- Update: pull the checkout, rebuild, re-run the installer — owned files
  update in place; user-modified files are preserved or backed up with
  `--force`.
- Remove: `--uninstall` as above, per scope (`--project <dir>` for project
  installs).
