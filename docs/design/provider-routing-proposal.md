# Provider routing proposal — mixed agents, models, and suppliers per seat

Status: proposal for the primary orchestrator. Planning-stage document;
changes no code. Write ownership: this file only (worker
task_fc917c50b9b0). Read-only inputs: `docs/BRIEF.md`, `src/**`, `docs/**`,
CLI `--help` output on this host, and the completed smoke run
`crun_01M7QF3H30KGXZJ2DXMZ8AGFVX`.

## 1. Problem

`docs/BRIEF.md` §"Public-use extension requested 2026-11-19" requires the
council to be provider-neutral: a primary agent (Claude, Codex, Devin, or any
other installed Orca agent) must be able to staff individual reviewer seats and
staff roles (organiser, scribe, supervisor) with a mix of installed CLI agents,
explicit models, and supported suppliers — chosen from the user's explicit
request, chat/saved preferences, or one concise question. The product must not
bake in this repository's development choice (free Devin `swe-2-max` +
`dangerous`) as a universal default, must never silently substitute a
provider/model, and must keep every actual choice bound to the run approval.

Today the seat schema and the launch adapter already support this in shape —
`AgentChoice {agent, model, effort?, permissionMode}` is approval-bound per
seat (`contracts.ts:149`, `approval binding` covers `seats`), and the adapter
resolves choices against per-agent launch policies with strict allowlists and
no ambient fallback (`host/orca.ts:1345–1400, 1866–1908`). What is missing is
breadth and honest defaults:

- Only one launch policy exists (`devin`, argv lane, `swe-2-max`).
- Three hard-coded Devin assumptions sit outside the approval binding.
- Nothing tells a calling agent which choices are valid, available,
  authenticated, or what they cost on *this* host.

## 2. Where Devin is hard-coded today (evidence)

| Place | Code | Effect |
|---|---|---|
| `src/engine.ts:94–99` | `COUNCIL_STAFF_AGENT = {agent:'devin', model:'swe-2-max', permissionMode:'bypass'}` | Organiser (line 1137) and both scribe phases (lines 1282, 1576–1601) always launch Devin. These participants are created by the engine, not chosen by the approver — staff identity is **not** in `approval.json`'s binding today. |
| `src/cli.ts:1435` | `SUPERVISOR_COMMAND = 'devin --model swe-2-max --permission-mode dangerous'` | `start-supervisor` always opens the pinned Devin argv lane. The supervisor is therefore always Devin, unselectable. |
| `src/cli.ts:661–663` | `doctor` requires `devin`, optional `claude`/`codex` | A host without Devin is declared NOT READY even when the user intends an all-Claude council. |
| `src/host/orca.ts:1391–1400` | `DEFAULT_AGENT_POLICIES = { devin: {...} }` | Any seat naming `claude`/`codex`/etc. fails at launch with `no launch policy` — the roster validates (token charset only, `validation.ts:479–493`) but cannot launch. |
| `skills/council/SKILL.md:91–127, 175–183` | skill instructs the Devin pin | The agent-facing recipe names Devin as "the only allowlisted and live-validated lane" — accurate today, must become catalog-driven. |

Two existing behaviors are correct and must be preserved: the approval gate
binds every post-organiser launch (`engine.ts:673–677`) and the adapter refuses
rather than falls back (`buildLane` throws `unsupported_lane`/`not_allowlisted`;
`worker-start --model` for `devin` is refused outright, `orca.ts:826–834`).

## 3. Verified launch surface (evidence)

All flags below were verified on this host on 2026-11-19 via `--help` /
read-only commands — **no agent was launched**. Orca version per
`docs/ORCA-COMPATIBILITY.md`: 1.4.261.

### 3.1 Orca (the host adapter's surface)

- `orchestration worker-start --task <id> --agent <id> [--model <id>]
  [--effort <level>]` — the **agent lane**. `--agent` takes Orca agent ids
  enabled on the worker server; help names `claude, codex, cursor,
  antigravity, muse, zcode, opencode, opencode2` (plus `devin`, exercised
  live). `--model` is honored for Claude/Codex/Cursor/Antigravity/Grok/Muse
  opaque provider ids, OMP roles/selectors (`provider/model:level`,
  `@worker`), and Pi `provider/id`; **not** honored for `devin` or `zcode`
  (those use their own config); OpenCode needs a pre-existing worktree and a
  verified execution-host CLI. `--effort` requires `--model` and is mapped
  per agent (Pi: `off, minimal, low, medium, high, xhigh, max`). Neither flag
  combines with `--terminal`.
- `terminal create --command <text>` → `terminal wait --for tui-idle` →
  `worker-start --terminal <h>` — the **argv lane**: required for Devin model
  pinning and usable for any locally installed CLI, built only from
  allowlisted tokens (`ORCA-COMPATIBILITY.md` §4).
- `orca account list [--agent claude|codex|opencode|devin|antigravity]
  --json` — lists **managed agent accounts** on this host; `system` denotes
  the provider's own sign-in outside Orca. `orca account select` picks the
  account new agent launches use. **There is no per-launch account flag** on
  `worker-start`: for the agent lane the provider profile is host-global.
- `orca agent launch --agent <id> [--model] [--effort] [--surface
  chat|terminal]` — unsupervised sibling surface; same model/effort
  semantics. Not used by the council (workers must be supervised Tasks) but
  confirms the vocabulary.

### 3.2 Agent CLIs (argv lane candidates, `--help` verified)

| CLI | Model selector | Effort | Permission posture | Notes |
|---|---|---|---|---|
| `devin` 3000.11.92 | `--model <id>` (env `DEVIN_MODEL`); `devin models list` prints the **account** catalog w/ prices (53 families; `swe-2-*` non-lightning marked `Free`, `*-lightning`/Claude/GPT paid) | none | `--permission-mode auto\|accept-edits\|smart\|dangerous` (default `auto`) | `--sandbox` exists (research preview). No fallback flag; env `DEVIN_REFUSAL_FALLBACK` must never be set. |
| `claude` | `--model <alias\|full>` (e.g. `sonnet`, `claude-sonnet-4-6`) | `--effort low\|medium\|high\|max` | `--permission-mode acceptEdits\|bypassPermissions\|default\|dontAsk\|plan\|auto`; `--dangerously-skip-permissions` | `--fallback-model` exists — **must never be passed** (fallback ban). `--max-budget-usd` exists (print mode only). |
| `codex` | `-m\|--model <id>`; `-c model="…"` | none observed in help | `-s\|--sandbox read-only\|workspace-write\|danger-full-access`; `-a\|--ask-for-approval on-request\|never`; `--dangerously-bypass-approvals-and-sandbox` | `--oss`/`--local-provider lmstudio\|ollama` = local supplier lane; `-p\|--profile` = config profile selector. Interactive TUI default; `codex exec` is the non-interactive mode. |

### 3.3 Honesty anchors

- Installed ≠ authenticated ≠ authorized ≠ free. `council doctor` already
  separates *binary present* from *usable*; nothing on the host proves a
  model is free except the provider's own catalog (e.g. `devin models list`
  prints `Free`/price per id) — and that is this account's catalog, not a
  universal price list.
- Orca agent-lane `--model` semantics differ per agent family; the only
  per-agent facts the product may assert are the ones in the launch catalog
  it ships, each labeled `verified_live | help_verified | unverified`.

## 4. Terminology the schema must keep separate

The brief's "agents/models/suppliers" collapses four distinct things:

1. **CLI agent** — the executable/TUI Orca runs: `devin`, `claude`, `codex`,
   or an Orca agent id (`opencode`, …). Schema field: `AgentChoice.agent`.
2. **Model (vendor model id)** — the model the agent runs: `swe-2-max`,
   `claude-sonnet-4-6`, OMP `provider/model:level`. Field: `AgentChoice.model`.
   Devin CLI's own `--model` accepts *other vendors'* ids
   (`claude-sonnet-4`, `codex`) — the CLI and the vendor are not the same
   thing; the catalog key is the **agent**, the model is a value.
3. **Provider/account profile** — whose subscription/credentials pay: an
   Orca managed account (`orca account list`), the provider's `system`
   sign-in, a CLI config profile (Codex `-p`, Claude `--settings`, Devin
   `--config`). New field: `AgentChoice.profile` (optional opaque token —
   see §5.2).
4. **Launch lane** — how the adapter starts it: `agent` (Orca-managed,
   `--model`/`--effort` proxying, host-global account) or `argv`
   (`terminal create --command` from allowlisted tokens, per-CLI flags). A
   catalog property, never a user string.

`permissionMode` stays a user-facing posture token (`bypass`, `auto`, …)
mapped per agent (`bypass` → Devin `dangerous`; `bypass` → Claude
`bypassPermissions`; `bypass` → Codex `danger-full-access`+`never` pair —
each mapping lives in that agent's catalog entry, not in code).

## 5. Recommended design

### 5.1 Launch catalog — what the product is allowed to launch

Promote `DEFAULT_AGENT_POLICIES` (one entry, in code) to a **versioned
launch catalog**: declarative per-agent policy data, shipped with the
package at `agents.catalog.json`, loaded and strictly validated at startup.
Same shape as today's `AgentLaunchPolicy`, extended:

```jsonc
{
  "schemaVersion": 1,
  "agents": {
    "devin": {
      "lane": "argv", "binary": "devin",
      "models": ["swe-2-max"],                       // allowlist mode (default)
      "modelsMode": "allowlist",                     // or "approval-pinned" (§5.1b)
      "modelFlag": "--model",
      "permissionModes": ["bypass", "auto", "dangerous"],
      "permissionModeMap": {"bypass": "dangerous"},
      "permissionFlag": "--permission-mode",
      "effortValues": null,                           // CLI has no effort flag
      "catalogProbe": ["models", "list"],             // read-only account catalog cmd
      "authProbe": ["doctor"],
      "readiness": {"expectedAgent": "devin"},
      "verification": "live-verified",
      "costNote": "per-account catalog; swe-2-* non-lightning marked Free on this account — never assumed on others"
    },
    "claude": {
      "lane": "agent",                                 // Orca proxies --model/--effort
      "modelsMode": "approval-pinned",
      "effortValues": ["low", "medium", "high", "max"],
      "permissionModes": ["bypass", "auto", "default"],
      "permissionModeMap": {"bypass": "bypassPermissions", "auto": "default"},
      "verification": "help-verified",
      "costNote": "subscription or API billing depends on the selected Orca account — unverified until the user's provider reports it"
    },
    "codex": {
      "lane": "argv", "binary": "codex",               // argv: posture needs -s and -a together
      "modelsMode": "approval-pinned",
      "modelFlag": "--model",
      "permissionModes": ["bypass", "auto"],
      "permissionArgv": {                             // posture → fixed token list
        "bypass": ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
        "auto":   ["--sandbox", "workspace-write",    "--ask-for-approval", "on-request"]
      },
      "verification": "help-verified",
      "costNote": "strict usage limits reported by this user — never chosen by default here; selectable when explicitly approved"
    }
  }
}
```

Rules:

- **Catalog is data, not shell.** Every field is validated through the same
  token rules as today (`TOKEN_RE`, allowlists); `permissionArgv` tokens are
  fixed literals from the file — no user input ever enters them. A malformed
  catalog fails closed at load. The catalog path is fixed next to the
  package; users never point the product at an arbitrary policy file in v1
  (extension point, §8).
- **`modelsMode: "allowlist"`** = today's behavior: the id must be in
  `models` (used for lanes we live-verify).
- **`modelsMode: "approval-pinned"`** = any `TOKEN_RE`-safe model id is
  launchable **because the approval hash already binds the exact string**
  (§5.3): the anti-substitution control moves from a stale list to the gate.
  Entries in this mode must carry `costNote` and are displayed with their
  verification label so the approver sees "unverified/paid-possible" before
  signing. This is what makes a public user free to pick
  `claude-fable-5-2-max` or `gpt-6-astra-high` without a product update.
- **Profile flag support:** optional `profileFlag`/`profileArgv` per agent
  (Codex `-p`, Claude `--settings`, Devin `--config`) emitted only when the
  seat sets `profile`; absent flag support + set profile = refuse (never
  ignore).
- **No remote lanes in v1:** `worker-start --on <server>` is untested
  (`ORCA-COMPATIBILITY.md` §7.5); catalog has no remote field. Out of scope.

### 5.2 Schema — seats and staff

`AgentChoice` gains one optional field (additive, `schemaVersion` stays 1):

```ts
interface AgentChoice {
  agent: string;            // Orca agent id or argv binary — catalog key
  model: string;            // provider model id; never a fallback list
  effort?: string;          // token, validated against catalog effortValues
  permissionMode: string;   // posture token, mapped by the catalog entry
  profile?: string;         // provider/account profile hint (token charset)
}
```

`profile` semantics, kept honest: it is a **hint recorded in the approval
binding and passed to the CLI only when that agent's catalog entry declares
a documented selector** (`profileFlag`/`profileArgv`). The agent lane has no
per-launch account flag, so for `lane:"agent"` entries a `profile` can only
be *asserted* ("expect Orca account `<profile>` is selected"); the catalog
marks such entries `profileMode: "ambient"` and `council doctor`/`catalog`
reports the currently selected `orca account list` row beside it. The
product never calls `account select` itself — that mutates host-global
state for all future launches.

`CouncilConfig` gains an optional `staff` object (all three optional,
resolved at `init`):

```jsonc
"staff": {
  "organiser":  {"agent":"devin","model":"swe-2-max","permissionMode":"bypass"},
  "scribe":     {"agent":"claude","model":"<approved>","permissionMode":"auto"},
  "supervisor": {"agent":"devin","model":"swe-2-max","permissionMode":"bypass"}
}
```

- `config` is already hashed into the approval binding → staff choices become
  approval-bound **without a schema migration**. `COUNCIL_STAFF_AGENT`
  becomes the *default resolution result*, not a constant: organiser/scribe
  participants read `config.staff.<role>`.
- **Pre-approval honesty:** the organiser and supervisor launch *before* the
  gate exists (the gate needs the organiser's output). The resolved staff
  choices are journaled at `launch.intent` and **echoed in the
  `needs_approval` payload** ("organiser ran as devin/swe-2-max/bypass") so
  the approver sees what already ran and can refuse approval; scribe and all
  reviewer launches remain post-approval-bound.
- `start-supervisor` resolves its lane from `config.staff.supervisor`
  (default = today's pin); `SUPERVISOR_COMMAND` becomes "render the resolved
  catalog lane", keeping identical argv for the default.

Seat schema (`SeatAssignment.agent`) is unchanged — approvers already write
per-seat `agent/model/permissionMode`; `profile`/`effort` ride along
optionally.

### 5.3 Approval binding — what the hash must cover

Current binding: `{runId, objective, seats, proposedRosterHash, config,
snapshotId, snapshotHeadHash}`. With §5.2, seats + staff + budgets are all
inside it already. Two additions keep the binding honest under a mutable
catalog:

1. `catalogHash` — sha256 of the resolved catalog subset used by this run
   (the entries for every `agent` referenced by seats+staff, canonicalized).
   Written to `approval.json` and `meta.json`; re-computed on `advance`. A
   catalog upgrade between approval and launch invalidates the approval —
   the correct outcome, since a policy change can alter what a token maps
   to. `council verify` reports `catalogIntact`.
2. `staffEcho` — the resolved pre-approval staff choices stored on the
   approval record for audit (not hashed separately; config covers them).

Any change to a seat's `agent`, `model`, `effort`, `permissionMode`, or
`profile` after approval = drift → re-approval of the exact same seats, per
the existing rule. There is no mid-run provider migration.

### 5.4 Decision UX — who chooses, and when the question is asked

The primary orchestrator (chat agent) resolves choices **before** `init`
and at the approval gate. Precedence, per the brief:

1. **Explicit user instruction** — "run the security seat on Codex, the rest
   on Devin" wins outright.
2. **Relevant saved/chat preference** — the user's standing choices from
   earlier conversation, or a **per-target** seeded default
   (`.council/config.json` in the reviewed workspace, resolved as the
   `--config` input at `init`). There is deliberately **no user-level
   provider-defaults file**: a globally installed skill must not smuggle one
   user's free-model posture into a universal default (agreed boundary with
   the discovery/install planner). The product reads preferences; it never
   writes them.
3. **One concise question** — asked only when the choice is *material*:
   paid/unknown-cost selection, a looser permission posture, an unverified
   lane, or an agent with no evidence of authentication. Choosing among
   already-authorized equivalent lanes the user pre-approved is not
   material — no mandatory repeated prompts.

Mechanics:

- `council catalog --json` (new, read-only): prints the catalog entries —
  agent, lane, allowed models or `approval-pinned`, permission tokens,
  effort values, `verification` label, `costNote` — intersected with local
  probes (binary on PATH via `--version`/`doctor`; Orca agent id in
  `worker-start` help; `orca account list` row when present). This is the
  contract surface the installed skill tells the primary agent to run —
  agents never parse the catalog file's private layout (agreed with the
  discovery/install planner). Probe honesty: a binary on PATH proves
  *presence only*; the command reports availability and, where a
  documented self-check exists (`devin doctor`, `codex doctor`, `claude
  doctor`), relays it as `cli-reported, unverified` — presence is never
  presented as authentication, permission, or cost clearance.
- The organiser's prompt gains an **advisory, non-binding**
  `suggestedAgent` per perspective (e.g. "security adversary benefits from
  a different vendor than the author"). Output schema gains one optional
  field; the approver may ignore it entirely — seats remain the approver's
  explicit pick. Diversity of suppliers across seats is a legitimate review
  goal (independent failure modes), but the product recommends, never
  decides.
- `needs_approval` payload additionally prints each seat's resolved lane +
  catalog verification label + the pre-approval staff echo, so the approval
  decision sees cost/auth posture in one place.
- `doctor` becomes catalog-driven: required = node/orca; every catalog agent
  reports `binary verified|missing`, `auth cli-reported|unverified` (the
  agent CLI's own self-check output relayed verbatim — e.g. `devin doctor`,
  `codex doctor`, `claude doctor` — never a product-verified auth claim),
  `account selected` for agent-lane entries. `ready` no longer
  requires Devin specifically — it requires the agents the *resolved*
  config will launch.

### 5.5 No-fallback guarantee (unchanged, extended)

- Launch failure of the approved lane → `failed`/`uncertain` outcome →
  blocked/escalate. Never retry with a different agent, model, or lane.
- Never emit `--fallback-model` (Claude), `DEVIN_REFUSAL_FALLBACK`, or any
  catalog `fallbacks` field — none exists.
- A `worker-start --retry-of` retry re-issues the *same* Task/lane (today's
  circuit-breaker), never a substitute.
- If an approved `profile`/account is not the ambient selection for an
  agent-lane launch, the adapter launches nothing and reports
  `profile_mismatch` — it never silently uses the wrong account. (Detection
  is best-effort via `account list` pre-launch; absent probe data is
  `unverified`, reported, not blocked — matching the product's
  honest-uncertainty style.)

### 5.6 Migration and backward compatibility

- `schemaVersion` stays 1; every addition is optional. Existing
  `roster.approved.json` files, `state.json` participants, and approvals
  parse unchanged.
- `config.staff` absent → resolves to the current Devin pin for all three
  roles (identical launches to today); a run may opt out per role.
- `agents.catalog.json` ships a `devin` entry byte-equivalent to today's
  policy → default behavior is a no-op for this repo's own development
  council (free `swe-2-max`, `bypass`→`dangerous`).
- Repo development policy (AGENTS.md: workers are Devin `swe-2-max`
  dangerous only) is a **repo-level constraint**, not a product default —
  the doc and skill say so explicitly; the catalog ships it as one entry
  among several.
- `journal`: `launch.intent` payload records the resolved lane + catalog
  version — no new event types needed; `approval.invalidated` gains a
  `catalogChanged` reason.

### 5.7 Testing

- **Fake-host lifecycle (required):** extend the existing adapter fake
  (`test/engine.test.ts`, `test/orca.test.ts` fixtures) with a 3-agent
  catalog (devin argv + claude agent-lane + codex argv). Cover: full
  protocol with mixed seats; `buildLane` per policy incl.
  `permissionArgv`/`profileFlag` rendering; approval invalidation on
  seat-agent edit, staff-config edit, catalog hash drift; refusal paths
  (`no launch policy`, `not_allowlisted` in allowlist mode, unsupported
  effort, unset `profile` on `ambient`-only profileMode); retained-terminal
  reuse refused across different agent identities (`terminal show` agent
  identity check already exists — test it against a mismatched seat);
  organiser/scribe reading `config.staff`.
- **Live checks (free lane only):** optional, only the already-authorized
  Devin `swe-2-max` lane — today's reduced smoke remains the evidence.
  Claude/Codex/live mixed runs are labeled **unverified live integrations**
  in the report/`doctor` until a user authorizes and runs them; the catalog
  `verification` field carries that label into the approval UI and into
  `report.json`'s provenance section.

### 5.8 Implementation ownership (per `IMPLEMENTATION.md` table)

| Owner | Files | Change |
|---|---|---|
| Contracts dev | `src/contracts.ts`, `src/validation.ts`, `test/validation.test.ts` | `AgentChoice.profile`, `CouncilConfig.staff`, catalog types, catalog file validation |
| Adapter dev | `src/host/orca.ts`, `agents.catalog.json` (new), `test/orca.test.ts`, `test/fixtures/orca-*`, `docs/ORCA-COMPATIBILITY.md` | catalog load + `buildLane` extensions (`approval-pinned`, `permissionArgv`, `profileFlag`), account-list probe, `catalogHash` |
| Protocol dev | `src/engine.ts`, `test/engine.test.ts` | staff from config, staff echo in `needs_approval`, catalog-hash binding/drift |
| CLI dev | `src/cli.ts`, `test/cli.test.ts` | `catalog` command, doctor rewrite, `start-supervisor` resolved lane, `verify` catalogIntact |
| Prompt/skill dev | `src/prompts.ts`, `skills/council/SKILL.md`, `docs/USAGE.md`, `test/prompts.test.ts` | organiser `suggestedAgent`, skill decision UX (precedence + one question), docs |

No shared-interface edits during planning; the startup developer
(`ctx_97732e5401db`) owns existing CLI/host/tests until report.

### 5.9 Main failure modes

1. **Catalog file malformed/missing** → init/doctor fails closed with a
   `config_invalid` listing the offending field. Recovery: reinstall/fix the
   shipped file; never edited per-run.
2. **Approved agent has no catalog entry / model not allowlisted** →
   `approve` refuses (allowlist mode) or launch blocked `unsupported`
   (approval-pinned never blocks on the list, but a missing *agent* policy
   always refuses). No substitute is attempted.
3. **Agent-lane `profile` set but profile selection is ambient** →
   `profile_mismatch`/`unverified` probe surfaced at approve time; user
   resolves via `account select` (their own action) or drops `profile`.
4. **Permission token with no catalog mapping** → approve refuses —
   posture is never passed through raw.
5. **Cost/auth unknown at approval** → seat is approvable only as an
   explicit `approval-pinned` choice shown with its `costNote`; the product
   presents "unknown" as unknown, never as free. A launch-time auth failure
   (`agent_readiness`) blocks the run honestly — today it surfaces as
   `blocked` + escalation, unchanged.
6. **Catalog upgrade mid-run** → `catalogHash` drift invalidates approval;
   `verify`/`status` report it; cure is re-approving identical seats under
   the new catalog (or pinning the prior catalog file).
7. **Retained-terminal reuse across agent change** → refused by the
   existing identity check; fresh-session fallback charged to budgets, as
   today.
8. **Peer/discovery intersection unresolved** → if no saved-preference file
   exists, precedence level 2 covers chat-observed preferences only;
   harmless, question fallback covers the rest.

## 6. Deferred / explicitly out of scope

- Remote workers (`--on <server>`), OSINTGPT or other mutation-capable
  integrations, MCP/native-plugin discovery, per-launch Orca account flags
  (host limitation — escalate to Orca if per-seat accounts are needed),
  price tracking/budget-USD enforcement (Claude's `--max-budget-usd` is
  print-mode only; a future cooperative cap could pass it where supported),
  user-authored catalog files (v1 ships a fixed catalog to keep the token
  invariant auditable), and automatic account selection.

## 7. Peer intersection

Exchanged with the discovery/install planner
(`dispatch:ctx_1c2720af3e5e`, owner of
`docs/design/discovery-installation-proposal.md`). Agreed boundary:

1. **Catalog surface:** a read-only `council catalog --json` subcommand is
   the contract the installed skill delegates to; the catalog file itself
   may be documented for transparency but agents do not parse its private
   layout. The command reports availability, never auth/permission claims
   it cannot verify — PATH presence ≠ authenticated (§5.4).
2. **Saved preferences:** no user-level provider-defaults file; provider
   choice stays per-run (`--config`, approval-hash-bound) with the optional
   per-target `.council/config.json` as the documented user-seeded default
   location; absent config → one short question per BRIEF. The peer's doc
   reserves the skill/policy boundary so this catalog schema is the single
   source the SKILL delegates to.
