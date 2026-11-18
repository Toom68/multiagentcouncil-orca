# Orca Host Compatibility — verified behavior for the council adapter

Scope: `src/host/process.ts` (safe subprocess boundary) and `src/host/orca.ts`
(Orca CLI adapter). Everything labeled **verified** was exercised against Orca
**1.4.261** on Windows (`C:\Users\tomy\AppData\Local\Programs\orca\resources\bin\orca`)
during the integration-design phase or via `--help` / live read commands.
Anything not exercised live is labeled **assumed from docs/help** and carries a
receipt-validation note in `src/host/orca.ts`.

## 1. Executable and process spawning (Windows)

- `orca` resolves to `orca.exe` (a `bin/orca.cmd` shim also exists; `cmd.exe`
  would be required to run it, so the adapter resolves `.exe` first via PATHEXT
  order and fails closed otherwise).
- All spawns use `child_process.spawn` with an **argv array** and
  `shell: false`. No string is ever concatenated into a shell line by the
  adapter. The single exception in *shape* is `terminal create --command` —
  which takes one shell command string — so the adapter only builds it from
  tokens matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` or `^--[a-z][a-z0-9-]*$`, after
  allowlist checks on binary/model/permission tokens (see §4).
- Timeouts: every call carries a hard timeout; on expiry the adapter SIGTERMs,
  waits a grace period (default 2 s), then SIGKILLs. A timed-out **mutation**
  is reported as *uncertain* (the mutation may have landed).
- Output caps: stdout 4 MiB, stderr 1 MiB by default; output past the cap is
  drained (children cannot deadlock on a full pipe) but not retained. A
  truncated `--json` payload yields `unparsed_output`/uncertain, never a
  silent half-parse.
- Windows signal caveat: `SIGTERM`/`SIGKILL` both map to `TerminateProcess` —
  there is no graceful signal; "grace" is only a wait, not a different signal.
- Environment: the child **inherits the caller's full environment verbatim**.
  Orca's CLI depends on injected control/identity variables —
  `ORCA_PANE_KEY`, `ORCA_TERMINAL_HANDLE`, `ORCA_RUNTIME_SOURCE*`, session
  auth — to act with the caller's identity; a blanket strip breaks
  authorization (confirmed by coordinator). Passing env to the user's trusted
  `orca` binary is normal. Secret hygiene is enforced on the OUTPUT side:
  credential-shaped values (`sk-…`, `ghp_…`, `xox*-`, private-key blocks,
  `*_KEY|TOKEN|SECRET|PASSWORD=` assignments) are masked in every
  error/stderr string the boundary produces.

## 2. Verified command surface (1.4.261)

Run/Task:

- `orchestration run-create --objective <text> [--from <handle>] [--retry-request <orca-id>] [--full] --json` → `{ok:true, result:{...}}` (**verified**; `runId` extraction in the adapter tries `result.run.id` then `result.id` — reconcile via `run-show` if the shape differs).
- `orchestration run-current --json` → `{result:{runId: <id>|null}}` (**verified**: returns `null` inside an unbound worker).
- `orchestration task-create --spec-file <path> --task-title <text> --run <run_id> [--deps <json-array>] [--from] [--retry-request <orca-id>] [--full] --json` (help-verified; `--spec-file` accepts cwd-relative paths).
- `orchestration task-update`, `task-show`, `task-list` (read/list surfaces).

Workers:

- `orchestration worker-start --task <task_id> [--worktree <sel>] [--agent <name> | --terminal <handle> | --chat] [--model <m>] [--effort <lvl>] [--run <run_id>] [--retry-request <orca-id>] [--full] --json` (**verified help**). Agent names observed: `devin`, `claude`, `codex` (+ configured others).
- `orchestration worker-show --dispatch <ctx_...> --json` → dispatch record incl. `dispatchId`, `taskId`, `from`/`to` handles, `requestId`, `state`, timestamps (**verified**).
- `orchestration worker-list --run <run_id> [--terminal-state <s>] --json` → `{result:{workers:[{dispatchId, taskId, state, outcome, liveness, agent, terminal, terminalState, workspace, host}]}}` (**verified row shape**).
- `orchestration worker-read --dispatch <ctx_...> [--limit n] [--cursor <c>] [--source auto|transcript|terminal] --json` (**verified help**). Output includes agent name and model as seen by the host (e.g. "SWE-2 Max").
- `orchestration worker-stop --dispatch <ctx>` — fences + stops supervised processes; `stop_unknown` possible (**verified help/behavior docs**).
- `orchestration worker-abandon --dispatch <ctx>` — fence without claiming process termination.
- `orchestration worker-release --dispatch <ctx>` — archives output then releases the terminal (settled workers only).
- `orchestration worker-keep-open --dispatch <ctx>` — cancels auto-release so a terminal can receive a later-phase Task.
- `orchestration dispatch / dispatch-show` — inspect dispatch records.

Mail (worker-facing):

- `orchestration send --from <handle> --to <target> --subject <s> --body <b> --type <t> [--task-id] [--dispatch-id] [--phase] [--retry-request <orca-id>] [--full]` (**verified**: worker→worker `send --to dispatch:<ctx>` delivered `msg_…` receipts; `--to run:<id>` and `--to term_<h>` exist; terminal-only mailboxes warn *"Delivery is not durable after that terminal closes; prefer run:<id> or dispatch:<id>"*).
- `orchestration inbox [--run <id> | --terminal <h>] [--limit n] --json` — **read-only history** (**verified**). This is the only history surface the adapter uses.
- `orchestration check` — **consuming** mailbox drain for the *bound* agent. The adapter never calls it (and never `--ack`). Note: `check` has no `--from` flag (**verified**: `invalid_argument: Unknown flag --from`).
- `orchestration ask / reply --id <msg> --body <b>` — question/answer flows.

Gates / requests:

- `orchestration gate-create --task <id> --question <q> [--from] [--retry-request <orca-id>]`, `gate-resolve --id <gate> --resolution <r>`, `gate-show`, `gate-list` — approval gates (**verified help**; `gate-list` is Run-scoped and errors `run_required` for unbound workers).
- `orchestration request-show --request <req_id> --json` — status of a recorded mutation request (**verified exists**).
- `orchestration approve` / `deny` — hidden-but-functional permission commands (**verified**: `approve --help` prints usage though it is absent from the top-level list).

Terminals:

- `terminal create [--worktree <sel>] [--title <t>] [--command <text>] --json` → result containing the terminal handle (`result.terminal.handle`/`result.handle`; adapter extracts tolerantly).
- `terminal wait --terminal <handle> --for tui-idle [--timeout-ms n] --json` — readiness probe.
- `terminal show / list` — handle/state inspection.
- **`orca terminal` is a different command class than `orca orchestration`:**
  `create`/`wait` have **no `--full`** (verified live —
  `invalid_argument: Unknown flag --full for command: terminal create`
  killed a launch when the flag leaked onto it) and **no `--retry-request`**
  equivalent. Their envelope's top-level `id` (verified live:
  `terminal create` → `{"id":"d7c3581f-…"}`) is the only request evidence;
  it is recorded for observability but is **never** replayed. The adapter
  scopes `mutation: true`/`--full` strictly to `orchestration` commands and
  emits terminal argv bare.

## 3. Run binding, identity, and durable IDs

- A worker (this adapter) has **no bound Run** (`run-current` → `null`). The
  primary orchestrator's Run is `run_<hex>`; the council supervisor must own a
  **separate child Run** created with `run-create`, and every subsequent call
  carries explicit `--run <run_id>` so the caller's binding is never assumed or
  stolen. `gate-list`/`send`/`worker-*` without `--run` fail with
  `run_required` — the adapter always passes it.
- Durable identities the adapter persists in every result: `runId`, `taskId`,
  `dispatchId` (`ctx_…`, addressable as `dispatch:ctx_…`), `terminalHandle`
  (`term_…`), plus the Orca-issued `requestId` from each mutation receipt —
  the only id `--retry-request` accepts (see §5). A local `requestKey` still
  correlates intent in receipts/journal but never reaches argv.
- `worker_done` is the durable completion signal; `worker-list`/`worker-show`
  rows carry `state`, `outcome` (`in_progress|succeeded|failed`), `liveness`,
  `terminalState`. **Silence is not exit** — a quiet worker can be alive;
  conversely a dead terminal with an unsettled dispatch is failed/uncertain.

## 4. Custom argv lane — pinning `devin --model swe-2-max`

Verified facts:

- `devin` CLI v3000.11.92 accepts `--model <id>` (env `DEVIN_MODEL`); the
  account catalog lists `swe-2-max` as **Free** (lightning variants are paid —
  never substitute).
- `worker-start --model <m>` is honored for Claude/Codex-class agents but is
  **not** a reliable Devin selector — the adapter *refuses*
  `{agent:'devin', model:…}` with `unsupported_lane`.

The lane the adapter implements (`startPhaseWorker`, lane `argv`):

```
terminal create --worktree <sel> --title <t> --command "devin --model swe-2-max --permission-mode dangerous"   # bare — no --full
terminal wait --terminal <term_…> --for tui-idle --timeout-ms <n>                                          # bare — no --full
orchestration worker-start --task <task_id> --run <run_id> --worktree <sel> --terminal <term_…> --json --full
```

The durable uncertain-outcome surface of this lane is `worker-start` (the
orchestration mutation carrying the request id); the two `terminal` steps
are evidence-only and are never retry-requested.

- The `--command` string is assembled **only** from allowlisted tokens:
  binary ∈ `allowedAgentBinaries` (default `['devin']`), flags are fixed
  literals, model/permission values must both match `COMMAND_TOKEN_RE` and
  appear in the configured allowlist (`swe-2-max`; the permission mode
  approved for the Run). Nothing else — paths, objectives, titles, user text —
  can enter the string.
- **Permission mode mapping (verified against `devin --help` on this host):**
  Devin CLI `--permission-mode` accepts only `auto | accept-edits | smart |
  dangerous`. The council/AGENTS.md posture named **"bypass"** is user-facing
  vocabulary; the adapter maps it explicitly to `dangerous` (the
  all-tools-approved mode) via `AgentLaunchPolicy.permissionModeMap`, accepts
  `dangerous` directly, and **rejects every other mode** — `bypass` is never
  emitted to the CLI.
- `terminal wait --for tui-idle` failing leaves the terminal in an unknown
  readiness state → outcome `uncertain` (reconcile, do not blindly recreate).
- Retained terminals: a settled worker's terminal may receive a new phase
  Task, but the adapter first proves no active dispatch owns it
  (`worker-list --run` filtered by terminal + unsettled outcome/state).
  Overlapping active work on one terminal is refused.

## 5. Mutation recovery and uncertainty semantics — VERIFIED 1.4.261

- **`--retry-request` takes an Orca-issued request id, never a caller key.**
  `send --help`: *"Reissue an earlier request by its ID; replays its result
  instead of repeating it."* A live council smoke proved Orca **rejects**
  caller-chosen keys: `"--retry-request must be the UUID Orca reported for the
  original request; pass it exactly as printed, or omit the flag to start a
  new request."` The adapter therefore sends **no retry flag on first
  attempts** and keeps `requestKey` only as a local intent id for
  receipts/journal — it never reaches argv.
- **Request-id receipt locations (verified live on this host):**
  - Success mutation (`--json --full`, real output):
    `{"id":"dca32296-…","ok":true,"result":{"message":{…,"id":"msg_…"},
    "mutation":{"requestId":"a50e6900-…","replayed":false}},"_meta":{…}}`
    → the recovery handle is `result.mutation.requestId` (UUID). The plain
    `--json` receipt trims to `{"ok":true,"result":{"messageId":"msg_…"}}`
    with no request id — **orchestration** mutations therefore always
    request `--full` (only `orchestration` commands accept it; see
    "Terminals" above for the verified `terminal create` rejection).
  - Failure receipt (verified):
    `{"ok":false,"error":{"code":"terminal_not_found","message":"…
    Orchestration mutation request ID: ec262ac1-…","data":
    {"orchestrationRequestId":"ec262ac1-…","originalCommand":[…]}}}`
    → `error.data.orchestrationRequestId`.
- **`request-show --request <id> --json`** reports
  `{"ok":true,"result":{"requestId":"<id>","state":"absent|pending|completed",
  "interpretation":"…"}}`. Verified: an absent id returns `state:"absent"`
  with *"Absent is not proof that nothing happened"*; a real completed send
  id returns `state:"completed"` (probe: `60c90055-…` → completed).
- **Recovery flow implemented:** `requestShow(requestId)` →
  completed/pending ⇒ do not re-issue; absent/unproven ⇒ `retryMutation`
  re-issues the exact logged argv + `--retry-request <id>` (same process only;
  it refuses an id it never logged rather than fabricating argv). A mutation
  that died before any reply (local timeout) yields no Orca id → reconcile by
  observation (`worker-list --run`), never by blind re-launch.
- `uncertain` outcomes the adapter surfaces (do not auto-retry):
  `outcome_unknown`, `stop_unknown`, `release_unknown`, `unverifiable`,
  `runtime_unavailable`, `server_mail_unsupported`, `source_changed`, local
  `local_timeout`, `unparsed_output`, `missing_terminal_handle`,
  `missing_run_id`/`missing_task_id` (success envelope without expected id).
- `worker-start` failed-with-stage receipts may carry `failedStage`
  (e.g. `agent_readiness`); retry uses `worker-start --retry-of <dispatch>`
  on the **same** Task — the engine owns the 3-strike circuit-breaker.

## 6. Enforcement reality

- **Host-enforced (hard)**: mail isolation between dispatches, `run_required`
  for Run-scoped commands, permission `deny`/`approve` at gates, launch/turn
  limits on supervised workers, child-worktree write confinement, dedup by
  `requestId`, `run_required`/`invalid_argument` argument errors.
- **Detective (post-check)**: file-scope violations are not prevented — detect
  via `git status`/`worker-list` receipts after the fact.
- **Cooperative (prompt-only)**: reviewer network-egress restraint, byte/round
  budgets enforced by the council ledger (not by Orca), persona dissent
  quality. These cannot be enforced by the host; report them honestly.

## 7. Unverified / caveats

1. Exact `worker-start`/`terminal create` receipt field names are extracted
   tolerantly (`result.dispatchId | .dispatch.id | .dispatchId`,
   `result.terminal.handle | .handle`); reconcile via `worker-list --run` when
   absent — live shapes not exercised during module work (no live launches).
2. Whether a consuming `check` on a child-Run-bound terminal drains the
   original dispatch mailbox is **unverified** (testing risks deafening the
   caller's own mail). The adapter sidesteps this by never calling `check`.
3. `terminal wait --for tui-idle` semantics for `devin` specifically are
   assumed from generic help; a failed wait is treated as `uncertain`.
4. `--effort` values accepted per agent are not enumerated in help; adapter
   passes through allowlisted tokens only.
5. Remote/`host != local` worker behavior is untested; `worker-list` exposes
   `host` for detection.
6. `orchestration approve`/`deny` are hidden (absent from `--help` listing)
   but functional; treat their surface as unstable.
7. `send --phase` exists on the worker mail surface; scribe/phase typing is
   cooperative — Orca does not validate phase names.
8. Long-running mailbox growth and `inbox --limit` pagination shape are
   unverified at scale.
