# Discovery & Installation Proposal — Public Multiagent Council

Status: proposal for review. Planning only; no code or configuration is
implemented here. Sole authored file: this document (ownership per coordinator
mail `msg_843c62c0c1d6`).

Requirement source: `docs/BRIEF.md` §"Public-use extension requested
2026-11-19" — after **one** installation, an agent in any Orca project can
discover the council from a request like "spin up a council", without a
checkout-specific path pasted into every prompt. Distribution stays
provider-neutral: no hard-coded user paths, subscription assumptions,
free-model posture, or bypass defaults become universal settings.

All capability claims below were verified on **2026-11-19** against the local
installs on `tomy`'s Windows host: **Orca 1.4.261** (`orca ... --help`,
`orca skills list`, `orca skills get orca-plugin-authoring`, `orca skills
installed`), **Devin CLI** (`devin skills paths`, `devin skills list`,
`devin plugins install --help`), **Codex CLI** (`codex plugin ... --help`,
`codex plugin marketplace list --json`, plus the on-disk marketplace layout
under `~/.codex/.tmp/bundled-marketplaces/`), **Claude Code** (`claude --help`,
`claude plugin ... --help`), and the real `~/.agents/skills` install tree.
Anything not exercised is marked *unverified*.

## 1. What each host actually supports (verified evidence)

| Surface | Verified capability | Distribution verdict |
| --- | --- | --- |
| **Shared `.agents/skills`** | `~/.agents/skills/<name>/SKILL.md` is scanned by Devin (`devin skills paths` lists it as a user skill dir; `devin skills list` shows `/orca-cli`, `/orchestration`, `/agents:pane` loading from it live). Orca itself installs bundled skills here and links them into per-agent dirs (`orca skills install --help`: "the shared .agents/skills folder"). Project `.agents/skills/` is also a documented Devin project dir. | **Primary universal install target.** One copy reaches Devin and the cross-agent `.agents` convention. Whether Claude/Codex scan `.agents` is *unverified* on this build — mirror into their own dirs. |
| **Orca `skills install`** | `orca skills install --skill <n>` installs **bundled-only** skills ("Bundled skill to act on"); `--all`, `--local`, `--agent <names>`/`universal`, `--dry-run`, `--force` with backup to `~/.agents/.orca-skill-backups`. No flag accepts a third-party path. | **Cannot distribute ours.** But its layout and update semantics (copy → link → skip-changed → backup-on-force) are the documented convention our installer mirrors. |
| **Orca native plugin** | `orca-plugin-authoring` guide: *"Sidebar cards, task sources, connections, MCP servers and skills are reserved and not buildable yet: say so instead of faking them."* Templates are themes/editors/panels/worker hooks only. | **Not available.** Do not fake a plugin skill contribution; revisit when Orca opens the surface. |
| **Devin plugin install** | `devin plugins install <SOURCE>`: "a GitHub `owner/repo`, a git URL, or a local path... **A repository with no plugin manifest but skills under `skills/<name>/SKILL.md` installs as a skills-only plugin named after the repository**"; `-y` skips the trust prompt; `--local` = this machine only. `devin plugins list/info/update/remove` manage lifecycle. Our repo already matches the convention (`skills/council/SKILL.md`). | **Documented first-class path for Devin** — *help-verified, not exercised* (install is a mutation; exercise inside an isolated home during implementation). |
| **Codex plugin marketplace** | `codex plugin marketplace add <SOURCE>` accepts "a local path, owner/repo[@ref], HTTPS Git URL, or SSH Git URL" (`--ref`, `--sparse`); `codex plugin add <name>@<mp>` installs. On-disk layout verified: `<repo>/.agents/plugins/marketplace.json` → `{name, plugins:[{name, source:{source:"local",path:"./plugins/<p>"}, policy, category}]}`; each plugin = `plugins/<p>/.codex-plugin/plugin.json` (`"skills": "./skills/"`) + `plugins/<p>/skills/<name>/SKILL.md`. `codex plugin marketplace list` shows configured `openai-*` marketplaces; `orca skills installed` enumerates their cache — installed Codex skills are Orca-visible. | **Documented path for Codex**, requires two small manifest files + a `plugins/` tree in our repo (see §4 phase 2). No verified direct `~/.codex/skills` or `.agents` scan on this build — *unverified*. |
| **Claude Code plugin marketplace** | `claude plugin marketplace add <source>` — "a marketplace from a URL, path, or GitHub repo"; `claude plugin install <plugin>@<mp>`, `list/update/uninstall/validate <path>` exist. `--plugin-dir` loads a plugin dir per-session; skills resolve as `/skill-name` (`claude --help`). Manifest convention is public Claude Code plugin format (`.claude-plugin/plugin.json`) — *convention assumed, `claude plugin validate` verifies at implementation*. | **Documented path for Claude**, same manifest-tree pattern as Codex (`.claude-plugin/` instead of `.codex-plugin/`). |
| **Claude direct skills dir** | `~/.claude/skills/<name>/SKILL.md` (user) and `<project>/.claude/skills/` (project). Verified live: `~/.claude/skills/pane` exists and loads; Devin's `skills list` also picks it up as `/claude:pane`. `dir /AL` shows it is a real directory (copy), not a junction. | **Write target** in the universal installer for Claude coverage without marketplace plumbing. |
| **Devin direct skills dirs** | `devin skills paths`: user = `%APPDATA%\devin\skills`, `%APPDATA%\cognition\skills`, `~/.agents/skills`; project = `.devin/skills`, `.cognition/skills`, `.agents/skills`. | Covered by the `.agents` master copy — no need to write `%APPDATA%` separately; avoid duplicate `/agents:council`-style listings. |
| **Per-project AGENTS.md injection** | Would require editing every target project's rules file — mutates the reviewed project, is unremovable in practice, and violates least-access. | **Rejected.** Not a discovery mechanism; explicitly out of scope per BRIEF. |

## 2. Options compared

**A. Portable local installer (recommended primary).** A small zero-dep
`scripts/install.mjs` in this repo: copies `skills/council/` into
`~/.agents/skills/council` (universal) and mirrors into `~/.claude/skills/council`
(Claude), writes a runtime pointer file, verifies discovery, reports conflicts.
Follows Orca's own update semantics (skip unchanged/divergent, backup on
`--force`). Works on hosts with any subset of agents; no network beyond the
initial clone. This is the only option that needs nothing beyond the
already-shipped skill directory and documented agent dirs.

**B. Project-scoped installation.** Same installer with `--project <dir>`
writing `<proj>/.agents/skills/council` + `<proj>/.claude/skills/council`.
Right for per-project pinning/CI or a user who wants no global writes; but it
reintroduces a per-project step — it does not satisfy "install once" alone.
Offered as a flag, not the default.

**C. Native plugin/marketplace distribution.** Devin: works today with zero
repo changes (`devin plugins install Toom68/multiagentcouncil-orca` —
skills-only plugin). Codex/Claude: works once two manifest trees exist in the
repo (`.agents/plugins/marketplace.json` + `.codex-plugin/plugin.json`, and
`.claude-plugin/`). Documented and managed (`update/remove` handled by each
CLI), but each covers one agent and Codex/Claude need new repo metadata.
Phase 2 complement, not a substitute for A.

**D. Orca `skills install` / Orca plugin skill contribution.** Impossible:
bundled-only and reserved respectively (verified quotes above). Do not fake.

**Recommendation:** ship **A** as the single "install once" step, with **C**
advertised per-agent in docs (Devin path immediately usable). B is a flag on
the same script. Nothing in this design requires an Orca plugin, MCP server,
or UI.

## 3. Recommended design

### 3.1 The discoverable SKILL (small, honest boundaries)

Keep `skills/council/SKILL.md` as the only required artifact; optional
`skills/council/references/` (usage detail, orca receipts) stay out of the main
context until needed — same pattern as Orca's own bundled skills.

- `name: council`, `description` retains the trigger phrases already present
  ("spin up a council", multi-reviewer critique, "council") — auto-selection is
  probability-raising, not guaranteed (§6).
- Header states the runtime **locator contract** (below) and the honest
  boundaries already in the file (presence ≠ authenticated/licensed/free; ask
  one short question when provider/cost/preference is unknown; never install
  skills or touch global config itself).
- Policy boundary: seat/staff provider vocabulary is delegated to the
  read-only `council catalog --json` output (see §3.3, coordinated with the
  provider-routing planner) — the skill names the command, never enumerates
  models inline, so an installed skill cannot smuggle this user's
  `swe-2-max`/bypass dev posture into a universal setting.
- Slash-invocation note: where the host supports it the skill is also
  callable as `/council` — the deterministic fallback when auto-selection
  doesn't fire.

### 3.2 Runtime locator — no checkout paths, ever

`COUNCIL` resolves in order; every step is verifiable, none fabricates:

1. `council` on `PATH` — produced by `npm install -g multiagent-council` (when
   published) or `npm link` inside a clone; `package.json` already maps
   `bin.council → dist/src/cli.js`.
2. `COUNCIL_CLI` env var — absolute path to `dist/src/cli.js`; explicit escape
   hatch for unbuilt/dev checkouts.
3. Pointer file `~/.council/install.json` — written by the installer:
   `{"cli": "<abs path to dist/src/cli.js>", "version": "<pkg version>",
   "installedAt": "<iso>"}`. This is the link between a *portable* install and
   the *clone it came from*; it contains no secrets and no other state.
4. Otherwise: print the resolution order and the install command, and stop.
   The skill instructs agents never to scan the filesystem for the checkout.

### 3.3 Capability/policy query (new small CLI surface, owned by CLI dev)

Proposed `council catalog --json` (name TBD with the provider-routing
planner): prints lane names, allowlisted model/permission/effort tokens, and
verification status per lane — the same data approval validates. Read-only,
no side effects, never reports auth status (it cannot verify auth — binary
presence is reported as presence only). This is the single contract the SKILL
references; it doubles as the installer self-check in §5.

### 3.4 Installer behavior (`scripts/install.mjs`, zero deps)

- `node scripts/install.mjs [--project <dir>] [--dry-run] [--force]
  [--uninstall] [--json]`
- Writes only: `~/.agents/skills/council/`, `~/.claude/skills/council/` (when
  `~/.claude` exists or `--claude` given), `~/.council/install.json`. Project
  mode writes `<proj>/.agents/skills/council/` + `<proj>/.claude/skills/`.
  Nothing else is created, appended, or edited — no settings.json, no
  AGENTS.md, no other skills.
- Conflict rules (mirroring `orca skills install` semantics): if the target
  `council/` exists — identical content-hash → skip; divergent → skip and
  report as a warning; `--force` moves the divergent copy to
  `~/.agents/.council-backups/<timestamp>/` then installs. A foreign
  (non-council) same-named dir is never overwritten.
- Each installed dir carries `.install-manifest.json`
  `{source, version, files:[{path,sha256}], installedAt}` → idempotent
  re-runs, exact uninstall (remove only manifest-listed files + now-empty
  dirs), and future version-skew detection between skill and CLI.
- `--uninstall` removes manifest-listed files and the pointer file only.
- Exit codes: 0 ok/warnings-reported, 1 a target failed; `--dry-run` prints
  the plan digest without writing.
- No secrets anywhere: the skill dir contains SKILL.md + references only.

### 3.5 Update and migration

- Update = re-run the installer after `git pull`/`npm run build` (idempotent
  via manifest hash). Codex/Claude marketplace installs update via
  `... plugin update`; Devin via `devin plugins update`.
- Migration from the current manual path: today's flow (clone → build →
  absolute path to `cli.js` + SKILL.md) keeps working; the installer simply
  adds the pointer + skill copies. USAGE.md's "Running it on another project"
  section gets a one-line pointer to the install script (docs-owner change).

## 4. Concrete first implementation (proposed split — primary assigns)

| File | Change | Proposed owner |
| --- | --- | --- |
| `docs/design/discovery-installation-proposal.md` | this document | this planner |
| `scripts/install.mjs` | **new**, zero-dep Node installer per §3.4 | startup dev (CLI surface owner) or assigned implementer |
| `test/install.test.*` | temp-home unit tests per §5 | test owner |
| `skills/council/SKILL.md` | locator block (§3.2), catalog-command + `/council` fallback, keep existing honest boundaries | flagged shared surface — primary assigns |
| `src/cli.ts` | `catalog --json` read-only subcommand (§3.3) — coordinated with provider-routing proposal | CLI dev |
| `docs/USAGE.md` | "Install once, discover everywhere" section + migration note | docs owner |
| `.agents/plugins/marketplace.json`, `plugins/council/.codex-plugin/plugin.json`, `plugins/council/skills` | **phase 2**: Codex marketplace; `.claude-plugin/` analog for Claude | phase 2 |
| `plugins/council/skills/council` | keep in sync by copying `skills/council` at release/`npm pack` time — no git symlinks (Windows portability) | phase 2 |

v1 deliberately changes **no** engine/contracts/host files: discovery is a
packaging + docs problem, not a protocol change.

## 5. Verification plan

- **Isolated homes (no real user dirs touched):** POSIX `HOME=$T`; Windows
  `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME`, `HOME` all pointed at a temp
  dir (per-agent home roots differ — `devin` uses `%APPDATA%\devin` +
  `~/.agents`, Claude `~/.claude`, Codex `~/.codex`). Run installer with
  `--dry-run` then real; assert writes land only inside the temp root.
- **Idempotency:** second run is a no-op (manifest hash match).
- **Conflicts:** pre-seeded divergent `council/` → reported and skipped;
  `--force` → backup exists and install proceeds; foreign same-named dir
  untouched; unwritable target → exit 1 with the location named.
- **Uninstall:** removes exactly the manifest files + pointer.
- **Independent fresh-agent forward-test (the proof that matters):** in an
  isolated home with only the installed skill, start a fresh agent
  (`devin -p`, `claude -p`, `codex exec`) in a fixture project and prompt
  "spin up a council"; assert from the transcript/result that SKILL.md was
  loaded and the locator resolved (agent emits `council init/status` from
  PATH or pointer — not a pasted path). Run per supported agent, label each
  result live vs. skipped-if-agent-absent. Per AGENTS.md, never describe a
  mocked host as this test.
- **Command-level checks** agents can run post-install:
  `devin skills list | grep council`, `claude plugin list`,
  `codex plugin list`, `council catalog --json` (when added).

## 6. Refresh semantics and honest limits

- **Existing sessions do not discover new skills.** Devin resolves skills at
  session start (`devin skills list` reflects the next launch); Claude
  mid-session needs `/plugin install` or restart; Codex a new session.
  Document "install, then start a new agent session"; a running session
  cannot be forced to notice.
- **Skill auto-selection is never guaranteed.** The model decides per
  request; the description maximizes trigger odds. The deterministic
  fallbacks: `/council` where slash-skills resolve, or "use the council
  skill". Nothing can compel selection — say so.
- **Presence ≠ authentication.** An installed `devin`/`claude`/`codex`
  binary says nothing about login, subscription, permission posture, or
  cost — the skill instructs one short question before launches depending on
  those (per BRIEF), and `catalog` reports availability only.
- **Agent coverage is only what's verified.** Windsurf/other Orca agents
  aren't claimed; extending the matrix requires the same evidence per agent.
- **Remote Orca environments** (`--environment`, SSH `host`s): the installer
  must run on the machine where the agent runs; v1 is local-only.
- **Skill↔CLI version skew** is advisory until `catalog` stamps versions;
  the manifest hash gives the data, enforcement is out of scope.
- **Devin plugin trust prompt** needs `-y` for non-interactive installs;
  `devin plugins install --local` keeps it machine-scoped (personal plugins
  otherwise follow the account).

## 7. Evidence appendix (commands actually run, 2026-11-19, Windows)

| Command | Proved |
| --- | --- |
| `orca skills install --help` | Bundled-only registry; shared `.agents/skills` master + per-agent links; `--local`, `--agent universal`, backup-on-`--force` semantics; `--dry-run`. |
| `orca skills get orca-plugin-authoring` | "connections, MCP servers and skills are reserved and not buildable yet" — verbatim. |
| `orca skills installed` | Enumerates `.agents` skills *and* "Codex plugin cache" sources — Orca-visible cross-agent discovery. |
| `devin skills paths` / `devin skills list` | Devin's user dirs (`%APPDATA%\devin`, `%APPDATA%\cognition`, `~/.agents/skills`) and project dirs (`.devin`, `.cognition`, `.agents`); live load of `.agents` skills (`/orca-cli` etc.); foreign-dir namespacing (`/claude:pane`, `/agents:pane`). |
| `devin plugins install --help` | GitHub `owner/repo`, git URL, local path, `#subdir`; skills-only plugin from `skills/<name>/SKILL.md`; `-y`, `--local`. |
| `codex plugin marketplace add/list`, on-disk tree | Marketplace = `<repo>/.agents/plugins/marketplace.json`; plugin = `.codex-plugin/plugin.json` (`"skills":"./skills/"`) + `skills/<name>/SKILL.md`; `add` takes local path or git repo (`--ref`, `--sparse`). |
| `claude plugin marketplace --help`, `claude --help` | `marketplace add <source>` (URL/path/GitHub repo), `plugin install/list/update/validate`; `--plugin-dir` per-session; skills resolve `/skill-name`. |
| `ls ~/.agents/skills`, `~/.claude/skills`, `dir /AL` | Real install tree: Orca's copy+link convention; `.claude/skills/pane` is a real dir — plain copies are the portable floor. |
| `docs/USAGE.md`, `package.json` | Current manual-path flow; `bin.council → dist/src/cli.js` already correct for `npm link`/global installs. |
