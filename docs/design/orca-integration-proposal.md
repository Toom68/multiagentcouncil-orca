# Orca Integration Proposal — Multiagent Council

Status: proposal for Stage 1 review. Planning only; no application code is implemented here.

All capability claims below were verified against a running local Orca **1.4.261**
(`orca --version` → `1.4.261`; `orca status --json` → `runtime.appVersion 1.4.261`,
`runtimeId 3a1b609a-cbe7-4afa-9911-02d64be681d8`) on **Windows (win32)**, using
`orca <cmd> --help`, `orca skills get orchestration` (+ all five references),
`orca skills get orca-cli`, `orca skills get orca-plugin-authoring` (+ `host-api.md`,
`events.md`), `orca agent-context --json` (335 commands), and read-only inspection of
the live dispatch that ran this planner. Anything not verified is marked
*unverified*.

## 1. Options compared

| Surface | What it can do on 1.4.261 | Verdict |
| --- | --- | --- |
| **CLI + skill** (`orca orchestration`, `orca terminal/worktree/agent`, bundled `orchestration`/`orca-cli` skills) | Full supervised lifecycle: Runs, Tasks, Dispatches, `worker-start` (local or paired server), mail (`send`/`check`/`reply`/`ask`/`inbox`), gates, worker inspect/stop/abandon/release/keep-open, idempotent mutations (`--retry-request`, `request-show`), terminal + worktree control, `agent launch --model/--effort`. | **Primary and only complete path.** Recommended v1. |
| **MCP stdio** | There is **no `orca mcp` command** (verified against full `orca --help` and the `agent-context` schema). Orca 1.4.261 exposes no MCP server surface. Plugins **cannot** contribute MCP servers or skills — `orca-plugin-authoring` states "Sidebar cards, task sources, connections, MCP servers and skills are reserved and not buildable yet." Agent-side only: `devin mcp add` exists (verified `devin mcp --help`), and Claude/Codex have their own per-CLI MCP config. | **Not available as an Orca host surface.** Optional future per-agent tooling for reviewers; the transport stays orchestration mail + files regardless. |
| **Native plugin** (`trusted-worker`, host API 1.10) | Worker methods: `workspace.*`, `terminal.*` (create/read/send/close/focus/list), `agent.launch`, `agent.resume`, `agents.list`, `automation.*`, `storage`, `secrets`, `settings`, `statusBar.update`, `appearance.*`, `editor.open`, `commands.run`, `notifications.show`. Events: `workspace.created/removed/changed`, `agent.status.changed`, `editor.typography.changed`. Hooks (since 1.4.248): `agent.launch.before`, `agent.prompt.before` (fires for "an orchestration dispatch"), `terminal.send`, `agent.tool.before/after`, `workspace.create.before/after`, `editor.save.before`. **No orchestration methods at all** — a plugin cannot create Runs/Tasks/Dispatches and cannot send or read mail. No network; the worker sandbox only reaches `host.call` methods. | **Not usable as the council transport.** Valuable *optional* v2 layer: read-only council panel (`agents.list`, `agent.status.changed`, `storage`), approval notifications, and policy guardrails (`agent.launch.before` / `agent.prompt.before` can rewrite or deny launches and orchestration prompt injection). |

**Recommendation:** build on the **orchestration CLI driven by a bundled skill +
a thin coordinator-side helper CLI**. Ship an MCP server later only if a concrete
need appears (e.g. structured finding-submission tools for Claude/Codex
reviewers). Ship a `trusted-worker` plugin later as a dashboard/guardrail
complement — it is additive, never load-bearing.

**v1 scope discipline:** the v1 deliverable is exactly *invocation → organiser →
approval gate → reviewers → one real peer-exchange round → distinct scribe →
report delivery* (per coordinator guidance, 2026-11-18). Everything marked
*optional* or *v2* below (direct-peer mail, plugin panel, MCP tools, remote
`--on` placement, multi-round tuning) is deferred, not built.

## 1.5 Enforcement reality — what Orca actually guarantees

Per coordinator direction, enforcement claims are split into three honest
classes. Prompt rules alone are *cooperative*, never sandbox guarantees.

**Enforced by Orca/documented mechanics (real):**

- *Mail isolation:* each recipient has its own mailbox; a worker's `check`
  reads only its dispatch mail. Hub-and-spoke relay (§2.5A) is enforced because
  workers literally cannot see peers' mail — the coordinator controls 100% of
  forwarded content, so message budgets and round structure hold physically.
- *Concurrency/launch limits:* real — reviewers exist only if the coordinator
  calls `worker-start`. No Orca mechanism launches workers autonomously.
- *Approval ordering:* real if the coordinator refuses to issue reviewer
  `task-create`/`worker-start` before the approval hash matches (the council
  code is the gatekeeper). Whether `gate-create` additionally blocks
  `worker-start` host-side is *unverified* (§2.3).
- *Write confinement (optional, structural):* reviewers in `--worktree
  new-child` get a separate checkout — their edits land in that worktree,
  never in the reviewed tree, and the whole thing is discarded on cleanup.
  Trade-off: they cannot see uncommitted work-in-progress, so `current` +
  detection (below) fits "review a build in progress" better.
- *Permission prompts:* with a non-bypass permission posture, a reviewer's
  edit/exec attempt surfaces as a prompt the coordinator can `deny
  --dispatch --prompt --reason` or `approve --dispatch --prompt --reason`
  (both verified commands; `approve` is hidden from `orchestration --help`
  but functional; `observation.agentWait` shows parked workers). This is
  real *write* enforcement — the planner workers here ran in bypass mode,
  so the council must deliberately choose the posture per launch.

**Detective, not preventive:**

- *"Reviewers must not edit":* with `--worktree current`, verify post-hoc —
  `git status` on the reviewed tree after each reviewer settles; a dirty tree
  fails the review and is evidence for the report. Cheap and deterministic.
- *Output honesty:* `worker-read` captures real terminal output after the
  fact; `inbox`/`dispatch-show` audit who was mailed.

**Cooperative only (prompt-level, must be labeled as such):**

- *No-exfiltration/egress limits:* Orca has **no** network control over agent
  CLI workers (unlike plugins, which get no network at all). "Do not send
  project content anywhere" is a prompt rule only — label it cooperative in
  specs and docs.
- *Message budgets in topology B (direct peer):* nothing stops a worker
  sending more mail; budgets there are advisory. Use topology A when budgets
  matter.
- *Perspective adherence, evidence quality, deadlines as agent-internal
  behavior:* enforced only by spec text + coordinator deadline enforcement
  (external `worker-stop`) respectively.
- *Devin `--sandbox` exists* (research preview; exec-write confinement +
  `Deny(Read)` paths per `devin --help`) — a possible *additional* argv-level
  confinement knob for custom-argv reviewers, unverified for council use and
  not an Orca guarantee either way.

## 2. Council flow → verified Orca primitives

Terminology: the *primary orchestrator* is the Orca agent (terminal or chat)
that owns the council. The *council coordinator* is the code path inside that
agent that executes the commands below — in v1 it is the primary orchestrator
itself reading `SKILL.md` and/or calling a thin `council` helper CLI per step.

### 2.1 Invocation and Run binding

```text
orca orchestration run-current --json
orca orchestration run-create --objective "Council review: <objective>" --json
```

- `run-current` reports the caller's prior binding (`{"runId": null}` when none —
  verified). Record it.
- `run-create` creates and binds a dedicated council Run. A Run "is a namespace
  and home inbox. It never schedules or places workers" (`run-create --help`).
- **Preserve the parent's binding:** commands without `--run` use *the newest
  Run* (`coordinator-loop.md`). The council MUST pass `--run <council_run_id>`
  on every `task-create`, `worker-start`, `task-list`, `task-update`,
  `worker-list`, `inbox` call so the parent's other Runs are never touched.
  `run-use --id <prior>` re-binds the prior Run if needed. Workers cannot bind
  Runs (`run-use --help`: "A worker cannot bind its own or ancestor Run").
- **Why a dedicated child Run, not the parent's existing Run:** group addresses
  (`@all`, `@codex`, …) reach "the live Dispatches of your own Run"
  (`send --help`). A separate Run keeps council fan-out, `task-list`, and
  `inbox` scoped, and gives the council a clean teardown boundary. A parent
  coordinator may instead pass `--run <existing>` deliberately; the council
  must never silently join "newest".
- **Nested coordinators are supported:** my own dispatch record shows
  `"depth": 1` (`dispatch-show --task task_87e64d5ea17d`). A worker with no Run
  binding gets a new Run bound to it on `worker-start --spec` (`worker-start
  --help`), so a council launched *by a dispatched worker* works: its workers
  land at `depth+1`. Nesting is capped — council reviewers and the scribe must
  be leaf workers and must not `worker-start` further. If the primary
  orchestrator is a leaf worker under the cap, the whole council still fits
  (organiser/reviewers/scribe are all depth+1 children).
- **Completion routing is automatic:** a worker's `send` with no `--to` goes to
  its coordinator "also after it finished" (`send --help`); `worker_done` is an
  exact-Dispatch signal. Mail lands in the bound Run's mailbox = the terminal
  that ran `run-create`/`worker-start`. When the council coordinator is itself
  a worker, its own `worker_done` reaches *its* coordinator — no absolute
  routing needed. To address another Run's coordinator explicitly,
  `send --to run:<run_id>` exists (`send --help`, `check --help`).
- **Mailbox after a worker binds a child Run** (raised by the architecture
  planner): `check --help` documents `inbox --terminal dispatch:<id>` covering
  "mail it read before it bound a helper Run", so the dispatch mailbox
  *persists*. What is *unverified* on 1.4.261: whether a consuming plain
  `check` on the now-bound terminal drains *both* the bound child-Run mailbox
  and its original dispatch mailbox. Until proven, route parent→supervisor
  guidance via `send --to run:<child_run>` (durable Run mailbox) plus file
  artifacts — not via `dispatch:<worker>` mail to a possibly-bound terminal.
- **`reply` durability caveat (verified live):** `reply --id` to a peer mailed
  to a `term_*`-only mailbox returns `warnings: ["... is a live terminal-only
  mailbox. Delivery is not durable after that terminal closes; prefer run:<id>
  or dispatch:<id>."]`. Prefer `send --to dispatch:<id>` over `reply` for
  anything that must survive a terminal's lifecycle.

### 2.2 Organiser

```text
orca orchestration task-create --spec-file council-runs/<id>/specs/organiser.md --task-title "Council organiser" --run <run> --json
orca orchestration worker-start --task <task_org> --worktree current --agent devin --run <run> --json
```

- `--spec-file <path|->` is the right input envelope for long specs: "reads the
  spec from a file (relative to the current directory) or stdin (-) on this
  machine, so quotes and backticks need no shell escaping" (`worker-start
  --help`). Verified in practice: this project's three planners were dispatched
  from `.council-dev/specs/*.txt`.
- `worker-start` exit 0 = ready; exit 1 = `failed`/`outcome_unknown` with
  `stage`/`failedStage`/`effects`/`residualResources` and recovery commands in
  JSON (`worker-start --help`). A missing agent CLI fails as an
  `agent_readiness` timeout.
- `--worktree current` shares the coordinator's checkout — correct for the
  council since reviewers must read (never edit) the same project and the
  shared artifact directory. Use `new-child`/`new-top-level` only if isolation
  is ever wanted; note workers started in a *new* worktree are **kept open**
  automatically and must be released (`worker-start --help`).
- Organiser output contract: write `council-runs/<id>/roster.json`, then
  `send --type worker_done --outcome succeeded --report-path
  council-runs/<id>/roster.json` (3-sentence `--body`).

### 2.3 Roster approval gate

Two layers, both verified:

```text
orca orchestration task-create --spec-file specs/review-phase.md --task-title "Council review" --run <run> --json
orca orchestration gate-create --task <task_review> --question "Approve roster.json (hash <h>)? <n> reviewers, agent devin/swe-2-max" --json
# when the primary orchestrator decides:
orca orchestration gate-resolve --id <gate_id> --resolution "approved; roster+config sha256 <h>" --json
```

- `gate-create` creates "a decision gate blocking a task" and `gate-resolve`
  resolves it (`--help`). This is the Orca-native record of the approval on the
  Task itself.
- The *enforceable binding* is council-side: the coordinator persists
  `council-runs/<id>/approval.json = { rosterHash, configHash, gateId,
  resolution, resolvedAt }`. Reviewer `task-create`/`worker-start` calls are
  issued only when `sha256(roster.json + council-config) == approval.rosterHash`.
  Any roster edit, reviewer-count change, agent/model change, or config change
  produces a new hash → approval invalid → a new gate is required. This
  satisfies "approval as a persisted state transition bound to a specific
  roster and configuration" (AGENTS.md).
- *Unverified:* exact blocking semantics of a gate (whether `worker-start` on a
  gated Task refuses, or the gate is advisory metadata) and whether the desktop
  shows a resolve UI. Confirm in the smoke test (§7); the file-level hash gate
  is enforced regardless.
- Alternative encoding without `gate-*`: keep reviewer Tasks in `pending` and
  flip `--status ready` only after approval (`task-update --status`; valid
  statuses: pending, ready, dispatched, completed, failed, blocked). `--deps`
  on `task-create`/`worker-start` exists for DAG ordering (`task-list --ready`
  gates on it — *unverified* whether it also blocks direct `worker-start`).

### 2.4 Reviewers (default 15, configurable)

```text
# Per reviewer i, after approval:
orca orchestration task-create --spec-file council-runs/<id>/specs/reviewer-<i>.md --task-title "Reviewer <i>: <perspective>" --run <run> --json
orca orchestration worker-start --task <task_ri> --worktree current --agent devin --run <run> --json
```

- **Concurrency** is coordinator-enforced: start at most `K` workers, and on
  each wake (`worker_done`, `escalation`, or `check` batch) start the next
  pending reviewer while `active < K`. `worker-list --run <run> --json` gives
  `state`, `outcome`, `liveness`, `terminalState` per dispatch (verified on the
  live run); `worker-show --dispatch <id>` gives one worker's
  `stage`/`liveness`/`activity` plus `observation.agentWait` (worker parked on
  a human-only prompt — healthy, not failed).
- **Deadlines:** council-level, not Orca-level. The coordinator records a
  per-reviewer deadline in the state file; on a wake past deadline it requests
  `worker-stop --dispatch <id>` (fences the Dispatch and stops the agent
  terminal and its helpers; `stop_unknown` exit 1 means *not proven stopped* —
  inspect `worker-show`, never assume). Silence/`unverifiable` liveness never
  proves exit (`recovery-and-cleanup.md`).
- **Message limits:** council-level. Spec text states each reviewer's budget
  (e.g. ≤3 outbound messages per round); the coordinator drops/forwards
  nothing beyond budget when relaying (§2.5). Orca has no mail-volume knob —
  document as a protocol budget.
- **`--keep-open`:** start the organiser and scribe with `--keep-open` (or call
  `worker-keep-open --dispatch <id>`) if they must answer post-report
  follow-ups. Finished workers otherwise close on their own; new-worktree
  workers auto-stay-open and need `worker-release --dispatch <id>`.

### 2.5 Peer discussion — concrete routing

Two verifiable topologies:

**A. Hub-and-spoke relay (recommended v1).** Reviewers use default routing —
`send`/`reply` go to the coordinator. Each bounded round:

1. Coordinator wake delivers reviewer mail (findings, questions, rebuttals) to
   the Run mailbox; coordinator appends each message to
   `council-runs/<id>/discussion.jsonl` (the ledger — preserves dissent,
   confidence, claim history).
2. Coordinator builds a per-reviewer digest (dedup, cap N messages, mark
   round r+1) and fans out:
   `orca orchestration send --to dispatch:<ctx_ri> --subject "round 2" --body <digest>`
   — "`send --to dispatch:<id>` … Orca durably relays it to a connected worker
   server" (`send --help`); a working worker gets it next turn.
3. Repeat for `R` rounds (default 1–2), then the phase closes and the scribe
   Task starts.

Every byte passes through the coordinator: budgets are enforceable, the ledger
is complete for the scribe, and no worker needs peers' addresses. Verified:
worker→coordinator default send, coordinator→worker `send --to dispatch:<id>`.

**B. Direct peer exchange (verified possible, optional).** A worker can
`send --to dispatch:<peer_ctx>` inside the same Run — verified live: this
planner sent `msg_b17ad05cb0ad` to `dispatch:ctx_8caad8e6a789`. Peer addresses
would be seeded into reviewer specs. It saves coordinator turns but the
coordinator/scribe never sees the content unless reviewers also forward it,
and budgets can't be enforced. Use only if hub relay proves too slow.

*Unverified:* whether worker→worker `send --to dispatch:<id>` is officially
supported beyond observed behavior, and whether a worker may address
`run:<run_id>` or `@worktree:<id>` groups. Smoke-test before relying on B.

**Do NOT** use `terminal send` to steer workers — the orchestration skill
forbids steering through terminals; mail is the channel. A `dispatch:<id>`
mailbox is the right address for supervised workers (`orca-cli` guide).

### 2.6 Scribe and report

- The scribe is a **distinct supervised worker** started after discussion
  closes: `worker-start --task <task_scribe> --worktree current --agent devin
  --keep-open`. Its spec names `council-runs/<id>/` containing
  `discussion.jsonl`, per-reviewer `findings-*.json`, and `roster.json`.
- It writes `report.md` + `report.json` and reports
  `worker_done --outcome succeeded --report-path council-runs/<id>/report.md
  --files-modified report.md,report.json`.
- **No long-running service or event callback is needed anywhere.** The whole
  council is mail-driven: the coordinator ends its turn after each step and
  Orca wakes it per message batch (`orchestration` skill: "Orca wakes you").
  A worker can only read *its own* mailbox — a live "listener" scribe could
  not observe other workers' mail anyway, so the ledger-file design is the
  correct mechanism, not a workaround. Plugin events (`agent.status.changed`
  etc.) carry no mail/orchestration payloads, so an event-driven scribe via
  plugin is also impossible — another reason the relay+ledger design wins.
- `worker-read --dispatch <id> --source auto|transcript|terminal` captures any
  worker's output for audit, "even after the terminal is released"
  (`worker-read --help`).

## 3. Input/output envelope

| Direction | Mechanism | Notes |
| --- | --- | --- |
| Coordinator → worker (task) | `--spec-file <path>` | File-based; no quoting issues; self-contained spec: objective, role, perspective, scope, budgets, artifact paths, output contract, "do not edit the reviewed project". |
| Coordinator → worker (follow-up) | `send --to dispatch:<id>` (+ `--thread-id`, `--payload <json>`) | Use `--task-id/--dispatch-id/--phase` flags over raw `--payload` JSON — "PowerShell strips JSON quotes easily" (`send --help`). |
| Worker → coordinator | `send` (default), `reply --id <msg>`, `ask --question` | `reply` threads to a message; `ask` returns at once for active workers and the answer arrives as mail. |
| Worker completion | `send --type worker_done --outcome succeeded|failed [--files-modified csv] [--report-path path]` | Settles the Task. `--report-path` is the canonical artifact pointer. A failure must be `--outcome failed`, never hidden in prose. |
| Bulk data | Artifact files under `council-runs/<id>/` | Mail previews truncate at ~200 chars in `inbox` rows; keep payloads small, files big. `.gitignore` already covers `.council/` and `.council-dev/` — keep runtime artifacts out of Git (AGENTS.md). |
| Coordinator state | `council-runs/<id>/state.json` | Run/Task/Dispatch/gate IDs, per-reviewer status, deadlines, approval record — survives Orca restarts and coordinator context loss. |
| Agent schema discovery | `orca agent-context --json` | Machine-readable schema of all 335 commands — use in the helper CLI for forward-compat checks. |

## 4. Agent and model selection — the Devin gap (verified)

- `--agent` takes "an Orca agent id enabled on the worker server" — the help
  lists `claude, codex, cursor, antigravity, muse, zcode, opencode, opencode2`
  ("such as", non-exhaustive). `devin` is a first-class Orca agent on this
  host: `terminal show` on this worker's terminal reports `agentIdentity:
  "devin"`; `account add|list|select|rm` accept `--agent devin`; `agent
  hooks status` shows devin hooks `installed` + `managedHooksPresent: true`;
  the plugin `agent.resume` enum includes `"devin"`.
- **`--model` does NOT cover Devin.** `worker-start --help`: "--model supports
  Claude, Codex, Cursor, Antigravity, Grok, and Muse opaque provider model
  ids… Other agents, including zcode, launch with the model from their own
  config." Devin is absent from the supported list → `worker-start --agent
  devin --model swe-2-max` will not pin the model.
- **Verified pin paths** (`devin --help`, `devin acp --help`, `devin models
  list` on this account, 2026-11-18):
  - `devin --model <id>` argv flag, or `DEVIN_MODEL` env.
  - `devin acp --model` for the stdio ACP embedding (non-Orca future).
  - `devin models list` confirms `swe-2-max` is **Free** on this account
    (262K context), as are `swe-2-high/medium` and `swe-2-flash-*`; the
    `*-lightning` variants are paid ($1/$5 per Mtok) and must never be
    selected. `swe` is a family alias — always pin the full `swe-2-max` id.
  - `devin acp --refusal-fallback` / `DEVIN_REFUSAL_FALLBACK` exists — the
    council must **not** set it (brief: no automatic model fallbacks).
- **Custom argv supervised worker** (for pinning or future agents), from
  `low-level-topology.md` — verified pattern:

  ```text
  orca terminal create --worktree active --title "reviewer-07" --command "devin --model swe-2-max" --json
  orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
  orca orchestration worker-start --task <task_ri> --terminal <handle> --worktree current --run <run> --json
  ```

  `worker-start --terminal` adopts the existing terminal and injects the Task
  preamble; omit `--agent/--model/--effort` in that form. The `--terminal`
  reuse path also re-adopts a *proven* settled worker's terminal before its
  `autoReleaseAt` (relevant for cheap multi-round reuse: one Devin pane can
  host sequential reviewer Tasks — but reusing one pane across reviewers
  weakens independence; prefer fresh panes per reviewer in v1).
- **Alternative without custom argv:** rely on the Devin account's configured
  default model (its own config) and omit `--model`. Document both; the
  custom-argv lane is the deterministic pin.
- The council needs a launch abstraction `{ agent: "devin", argv?: [...] }`:
  `argv` present → `terminal create --command` + `worker-start --terminal`;
  absent → `worker-start --agent`. This is the seam for future
  Claude/Codex (§8).

## 5. Windows process spawning and foreground/background

- **Never spawn agent CLIs yourself.** `worker-start` / `agent launch` /
  `worktree create --agent` go through Orca's agent launch (PTY, managed
  hooks, supervised lifecycle, permission menus). Manual `spawn("devin")`
  would be unsupervised: no Dispatch, no mail, no `worker_done`.
- `terminal create --command "<text>"` *types* the text into the workspace's
  default shell — quoting follows that shell, and `--shell
  cmd.exe|powershell.exe|pwsh.exe|wsl.exe|bash.exe|git-bash` chooses the shell
  (`terminal create --help`; Windows-only flag). `"devin --model swe-2-max"`
  needs no inner quotes — safe. For anything with spaces/quotes, prefer a
  checked-in `scripts/*.cmd|*.ps1` wrapper and type its path.
- The council's own helper processes (if any) use `spawn(cmd, args[])` arrays,
  never concatenated shell strings (AGENTS.md).
- Foreground/background: `worker-start` and `agent launch` run background by
  default; "how the worker runs follows the user's own setting for new agent
  tabs; there is no flag for it" (`worker-start --help`). `--focus` /
  `--activate` reveal/switch — never pass them from the council. Surface is
  chat or terminal per the user's Chat|CLI choice; the launch receipt reports
  `outcome.kind`. **Not every worker has a terminal** (`worker-start --help`):
  chat-surface workers are driven by the same orchestration verbs via
  `orca_session_id` mailboxes — the council must never assume a `term_*`
  handle.
- `terminal_handle_stale`/restart: handles are runtime-scoped; after an Orca
  restart re-list (`terminal list`, `worker-list`) and continue with the
  replacement handle only — never dual-send.
- `ORCA_CLI_COMMAND` was unset here; plain `orca` resolves correctly on this
  Windows host (`.../Programs/orca/resources/bin/orca`). The `orca-ide` vs
  `orca` executable caveat applies to Linux only. The coordinator noted this
  box is PowerShell: quote `--to "@all"`/`@worktree:<id>` and comma-separated
  `--types`, and prefer flag args over inline JSON.

## 6. Idempotency, failure, and cleanup semantics (verified)

| Situation | Mechanism |
| --- | --- |
| Mutation response lost/ambiguous | Re-issue exact command with `--retry-request <id>` (send/check/worker-start/terminal send/etc. all support it); `request-show --request <id>` is read-only and reports `completed`/`pending`/`absent`. Never blindly re-run a mutation — that's how duplicate workers start. |
| `worker-start` failed or `outcome_unknown` | Read `stage`/`failedStage`/`effects`/`residualResources` from JSON; retry the **same Task** with `worker-start --task <id> --retry-of <dispatch_id>` (a fresh `--spec` would create a new Task). `--retry-of` does not inherit placement — repeat `--worktree`/`--agent`. |
| 3 failed starts in a `--retry-of` chain | Dispatch circuit-breaks; Task fails. "Never route around the breaker with a new Run or Task." Reopen only the same Task (`task-update --status ready` + fresh `worker-start`) after the user asks. A worker's own failed `worker_done` does not advance the count. |
| Worker stopped without `worker_done` | `escalation` mail carries `stopReason`; `exited`/`lost` = gone → retry or report. |
| Cancel an unsettled attempt | `worker-stop --dispatch <id>` — fences + stops agent terminal and helpers; exit 1 `stop_unknown` ≠ stopped. `worker-abandon` fences without claiming stop (keeps resources). `deny`/`approve --dispatch --prompt --reason` answer a worker's permission prompt (deny by default; `approve` is hidden from `--help` but functional). |
| Reclaim terminals | `worker-release --dispatch <id>` for settled workers (archives output first); reclaimable workers auto-release at `autoReleaseAt`; `worker-keep-open`/`--keep-open` cancels that. Never `terminal close` a worker terminal — use release. |
| Reading a possibly-dead worker | `worker-show` (state/liveness/`observation.agentWait`); `worker-read` (bounded output, survives release). |
| Nuclear option | `orchestration reset --all|--tasks|--messages` — only when the user gives the state up. |

**Inbox safety:** only the coordinator agent may run a *consuming* `check`
(it marks the batch handled; mail is then invisible to the real agent). Any
script/helper — including the council CLI — must use `check --peek`
(`--peek --wait` allowed) and must never `--ack` or plain `check`
(`check --help`, `orchestration` skill). `inbox --terminal run:<id>|
dispatch:<id>` is the read-only history view for context recovery.
`check --wait` exists (1 ms–30 min, keepalives on stderr) but the council's
default is *end turn and be woken* — no poll loops, no `sleep` watchers.

## 7. Cheap live smoke test (all Devin `swe-2-max`, Free)

Run in the coordinator's current worktree; ~1 organiser + 2 reviewers +
1 scribe; small specs; no new checkouts.

1. `run-create` → record `runId`; verify `run-current` before/after restores
   cleanly.
2. Organiser: `task-create --spec-file` + `worker-start` → verify dispatch id
   in receipt, `worker_done` mail, `roster.json` artifact.
3. Gate: `gate-create` on the review task → try `worker-start` for a reviewer
   → record whether it refuses (determines if gate is hard or advisory) →
   `gate-resolve` → start proceeds.
4. Two reviewers: independent specs, then one relay round
   (`send --to dispatch:`) → verify each gets only its digest, ledger file
   complete, `worker-list` states sane. Also verify a worker→worker
   `send --to dispatch:<peer>` if topology B is ever wanted.
5. Scribe: `--keep-open` start → `report.md`/`report.json` → `worker_done`.
6. Kill test: `worker-stop` on one reviewer → confirm fencing + terminal
   state; `worker-release` on all settled dispatches → `worker-list
   --terminal-state` shows `released`.
7. Idempotency test: `send` with a saved `--retry-request` id → replayed
   receipt, no duplicate mail; `request-show` on it → `completed`.
8. `--spec-file -` stdin path and a PowerShell-quoting sanity pass
   (`--to "@all"` if groups are ever used).

Total cost: four short-lived free-tier Devin sessions; verifies every
transition the acceptance checklist needs.

## 8. Future compatibility seam (direct Claude/Codex)

Keep the Orca dependency behind a host adapter with this shape:

```text
launchWorker(specText, { agent } | { argv } ) -> { dispatchId, handle }
sendTo(dispatchId, envelope) / awaitMailBatch() / replyTo(msgId, body)
readWorker(dispatchId) / showWorker(dispatchId) / stopWorker(dispatchId)
listWorkers(runId) / createGate(taskId, question) / resolveGate(id, res)
```

- Orca implementation = the commands in §2–§6 (mail + Tasks + gates).
- Direct-Claude implementation (later): `claude -p` headless children or
  `orca claude-teams` (exists in `--help`, unverified semantics); Codex:
  `codex` CLI headless. Mail fabric replaced by a JSONL bus over files/pipes —
  the *envelope* (Task spec text, findings JSON, worker_done summary) stays
  identical, so organiser/reviewer/scribe specs and the state machine are
  unchanged. `--model`/`--effort` support exists for Claude and Codex through
  `worker-start`/`agent launch` when those agents run inside Orca.
- Per-agent MCP tools could later give reviewers structured finding
  submission (devin/claude/codex each have their own MCP config paths — all
  per-CLI, none Orca-level).

## 9. Module ownership suggestions (for the architecture planner)

| Module | Owns | Must not touch |
| --- | --- | --- |
| `src/core/` | Council protocol: state machine, roster/approval hashing, finding/roster/report schemas, budget rules, ledger writer. Zero Orca imports. | Orca CLI |
| `src/host/orca/` | The adapter: command builders (`--json` everywhere), receipt parsing, `--retry-request`/`request-show` idempotency, dispatch/handle registry, gate ops, mail encode/decode, `terminal create` custom-argv lane. | Protocol rules |
| `src/cli/` (or `bin/council`) | Coordinator-side helper the orchestrator calls per step: `council init|plan|approve|launch-reviewers|step|status|scribe|cleanup`. Reads/writes `state.json`; never runs a consuming `check` (peek only). | Prompt text |
| `skills/council/SKILL.md` | The recipe the primary orchestrator loads: when to call which `council` command, wake handling, approval UX. | Implementation |
| `specs/` | Organiser/reviewer/scribe prompt templates + output contracts. | Runtime code |
| `tests/` | Envelope round-trips, state machine + approval invalidation, adapter contract tests against a fake `orca` binary on PATH, PowerShell quoting cases. | — |

## 10. Acceptance checklist

- [ ] Primary orchestrator can invoke: `run-create` (or `--run` existing) →
      organiser `worker-start` → roster arrives as `worker_done` +
      `--report-path` artifact. Run binding of the caller preserved (explicit
      `--run` everywhere; `run-current`/`run-use` recorded).
- [ ] Approval gate blocks reviewer starts until resolved; approval record
      binds `sha256(roster+config)`; editing roster/config invalidates it and
      no reviewer Task proceeds (verified by test + smoke §7.3).
- [ ] N reviewer Tasks start with configurable N (default 15) and
      concurrency K; `worker-list`/`worker-show` states tracked; deadlines
      enforced via `worker-stop`; `deny` available for permission prompts.
- [ ] At least one real peer-exchange round over orchestration mail
      (`send --to dispatch:`), ledger persisted, budgets enforced by relay.
- [ ] Scribe is a distinct worker; `report.md` + `report.json` produced;
      dissent/confidence/evidence preserved per methodology spec.
- [ ] Completion routes to the invoking caller's mailbox (coordinator
      binding), including the council-as-nested-coordinator case.
- [ ] No bare `check` by scripts (peek only), no poll/sleep loops, no
      terminal steering of workers, no private DB access, no invented APIs.
- [ ] Devin pinned to `swe-2-max` via argv/config (not `--model`); no
      `*-lightning`, no `DEVIN_REFUSAL_FALLBACK`.
- [ ] Idempotent mutations: `--retry-request` + `request-show` used after any
      uncertain outcome; `--retry-of` for failed starts; circuit breaker
      respected.
- [ ] Windows: `--spec-file` used for long specs; PowerShell-safe quoting;
      argv-array spawning for own helpers; `--shell` respected.
- [ ] Cleanup: `worker-release` for settled workers; `worker-stop`/`abandon`
      documented; no orphan kept-open new-worktree workers.
- [ ] Caveats file: gate blocking semantics, `--deps` readiness semantics,
      worker→worker `send` support, chat-surface workers — all smoke-tested
      and labeled verified/unverified.

## 11. Sources

Commands (`orca … --help` / `--json` on Orca 1.4.261): `orchestration
run-create|run-use|run-current|run-list|run-show`, `task-create|task-list|
task-update`, `worker-start|worker-show|worker-read|worker-stop|
worker-abandon|worker-release|worker-keep-open|worker-list`, `send`, `check`,
`reply`, `ask`, `inbox`, `dispatch`, `dispatch-show`, `gate-create|
gate-resolve|gate-list`, `request-show`, `deny`, `approve`, `reset`; `terminal create|
list|show|read|send|wait`, `agent launch|hooks status`, `worktree
create|ps|show|current`, `account list`, `host list`, `status`, `plugin list`,
`agent-context`. Guides: `orca skills get orchestration` +
`references/{coordinator-loop,messaging-and-gates,recovery-and-cleanup,
low-level-topology,placement-and-remote}.md`; `orca skills get orca-cli`;
`orca skills get orca-plugin-authoring` + `references/{host-api,events}.md`.
Devin CLI 3000.11.92: `devin --help`, `devin models list`, `devin mcp --help`,
`devin acp --help`. Live evidence: this dispatch `ctx_fd605867c4cc`
(`worker-show`, `dispatch-show`, `terminal show` — `agentIdentity: devin`,
SWE-2 Max footer), `worker-list` rows for the three planner workers, and
peer mail `msg_b17ad05cb0ad` proving worker→worker `send --to dispatch:`.

## 12. Caveats and open items

1. Gate blocking semantics (hard refusal vs advisory) — smoke §7.3.
2. `--deps` readiness vs direct `worker-start` — smoke §7.4.
3. Worker→worker `send --to dispatch:` worked once here; confirm it is a
   supported path before designing topology B around it.
4. Whether `worker-start --agent devin` accepts a model through Devin's own
   config vs requiring the custom-argv lane — the custom-argv lane is
   verified sufficient; the plain `--agent` path's model resolution is
   account-config dependent.
5. Chat-surface workers (`outcome.kind = structured`) have no terminal
   handle — worker verbs cover them, but the custom-argv lane requires a
   terminal surface. The council should tolerate either.
6. Permission mode: this box ran the planners in bypass mode (coordinator-
   selected). Council install docs must state the required permission posture;
   `deny`/`agentWait` cover prompts for non-bypass runs.
7. `worker-start --on` remote placement exists but is untested here (single
   local host, `host list` shows only `local`). Out of scope for v1.
8. Whether a consuming `check` on a child-Run-bound worker terminal also
   drains its original dispatch mailbox — unverified (§2.1). Route
   parent→supervisor guidance via `run:<child_run>` + artifacts instead.
9. `orchestration approve --dispatch <id> --prompt <approval_id> --reason
   <text>` exists and works (`--help` verified) but is absent from the
   `orchestration --help` command list — a hidden-but-real command. It lets a
   coordinator allow a worker's permission prompt "when the user lets
   coordinators approve"; the council should prefer `deny` by default and use
   `approve` only under an explicit policy.
