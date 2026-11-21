# Orca Host Compatibility — verified behavior for the council adapter

Scope: `src/host/process.ts` (safe subprocess boundary) and `src/host/orca.ts`
(Orca CLI adapter). Everything labeled **verified** was exercised against Orca
**1.4.261** on Windows (`C:\Users\tomy\AppData\Local\Programs\orca\resources\bin\orca`)
during integration design and the reduced live council, or via `--help` / live read commands.
Anything not exercised live is labeled **assumed from docs/help** and carries a
receipt-validation note in `src/host/orca.ts`. A reduced end-to-end council
(organiser → approval → reviewers → discussion → scribe → report) completed
with partial review coverage. [VERIFICATION.md](VERIFICATION.md) records the
receipts, output rejection, recovery, and cleanup caveats.

## 1. Executable and process spawning (Windows)

- `orca` resolves to `orca.exe` (a `bin/orca.cmd` shim also exists; `cmd.exe`
  would be required to run it, so the adapter resolves `.exe` first via PATHEXT
  order and fails closed otherwise).
- All spawns use `child_process.spawn` with an **argv array** and
  `shell: false`. No string is ever concatenated into a shell line by the
  adapter. The single exception in *shape* is `terminal create --command` —
  which takes one shell command string — so the adapter only builds it from
  tokens matching `^[A-Za-z0-9][A-Za-z0-9._:/+-]*$` (alnum-led; `:`,`/`,`+`
  admitted for `provider/model:level` selector data) or
  `^--[a-z][a-z0-9-]*$`, after allowlist checks on binary/model/permission
  tokens (see §4). Whitespace, quotes, and shell operators stay impossible.
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
- `orchestration worker-stop --dispatch <ctx>` — fences + stops supervised processes; `stop_unknown` possible (**verified help/behavior docs**; observed live on an external argv-lane terminal — a cancelled run's supervisor answered `state:"stop_unknown", liveness:"unverifiable", terminalState:"retained"`, which is why `council cancel` notifies the supervisor and `council cleanup` closes such terminals by terminal custody instead).
- `orchestration worker-abandon --dispatch <ctx>` — fence without claiming process termination.
- `orchestration worker-release --dispatch <ctx>` — guarded release of a reclaimable settled worker; may return `ok:true` with `state:retained` and perform no process action (verified live; see §7).
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
- `terminal show / list` — handle/state inspection. The record fields the adapter relies on (**verified live**): `connected`, `agentIdentity`, `agentWait` (non-null ⇒ a prompt/menu is up — never auto-answered), `title` (host-relayed program title, e.g. a Devin spinner glyph or `Devin ready`), `orphaned`, `exitCause`.
- `terminal read --terminal <handle> --screen --json` → `{terminal:{source:"screen", tail:[…]}}` — the rendered screen; used by the first-turn submission probe (**verified live** on a Devin lane; only `source:"screen"` output is accepted, stream fallbacks read as unreadable).
- `terminal close --terminal <handle> --json` — closes one exact terminal (**verified live** on 1.4.261 via a local dev-only close probe): success returns `{close:{handle,tabId,ptyKilled:true}}`; a repeat close on the same handle returns the same ok envelope — the reliable "already gone" signal is a later `terminal show` record of `connected:false` + `orphaned:true`/`exitCause:{kind:…}` (e.g. `operator_close`); an unknown handle fails `terminal_handle_stale`.
- `terminal send --terminal <handle> --text <s>` — the one input the runner uses: a single real CR byte submits a pasted-but-unsubmitted Devin prompt (**verified live**; the adapter's `bareEnterArgv` passes `'\r'` as an argv token). A literal backslash-r is typed as text and does NOT submit; the manual form is `orca terminal send --terminal <h> --text $'\r'` (PowerShell: `--text "`r"`).
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

- A fresh worker may have **no bound Run** (`run-current` → `null`). The
  council runs in a **separate child Run** created by `run-create`; creating
  it binds that caller. A dedicated supervisor preserves the primary agent's
  binding. Manual first `advance` therefore changes its caller's binding;
  restore the prior one as documented in USAGE. Run-scoped creation/list
  commands carry explicit IDs; Dispatch commands carry the exact Dispatch ID
  and still require appropriate caller custody. IDs do not grant authority.
- A restarted dedicated supervisor uses `--as-supervisor` to verify its
  recorded terminal identity, bind to the saved child Run, and verify that
  binding before advancing. This recovered a real crashed-supervisor run;
  manual mode does not issue `run-use`.
- Durable identities the adapter persists in every result: `runId`, `taskId`,
  `dispatchId` (`ctx_…`, addressable as `dispatch:ctx_…`), `terminalHandle`
  (`term_…`), plus the Orca-issued `requestId` from each mutation receipt —
  the only id `--retry-request` accepts (see §5). A local `requestKey` still
  correlates intent in receipts/journal but never reaches argv.
- `worker_done` is the durable completion signal; `worker-list`/`worker-show`
  rows carry `state`, `outcome` (`in_progress|succeeded|failed`), `liveness`,
  `terminalState`. **Silence is not exit** — a quiet worker can be alive;
  conversely a dead terminal with an unsettled dispatch is failed/uncertain.

## 4. Custom argv lanes — the shipped launch catalog

Verified facts:

- `devin` CLI v3000.11.92 accepts `--model <id>` (env `DEVIN_MODEL`); the
  account catalog lists `swe-2-max` as **Free** (lightning variants are paid —
  never substitute).
- `worker-start --model <m>` is honored for Claude/Codex-class agents but is
  **not** a reliable Devin selector — so the catalog's Devin lane emits the
  model on `terminal create --command` argv instead.
- `claude --model/--effort/--permission-mode` and Devin
  `--permission-mode` are **help-verified** on this host; `codex
  --model/--profile/--sandbox/--ask-for-approval` is **live-verified** as a
  bounded supervisor launch and as a reviewer seat in a completed
  mixed-provider council. Devin lanes (`swe-2-max`, Devin-hosted
  `claude-opus-5-5-high`) have run live councils. For Devin, `worker-start`
  reports only `input_accepted` (`turnStart: unsupported`) — a pasted brief
  can sit unsubmitted. The runner now detects that with a bounded read-only
  probe (`worker-show` activity + `terminal show` title/`agentWait` +
  `terminal read --screen`, ~24 s window, `COUNCIL_SUBMIT_PROBE_MS`) and,
  only on a settled `unsubmitted` verdict, sends one journaled bare Enter
  (§2 `terminal send`); anything unresolved surfaces as a
  `launch.submit_unconfirmed` warning shown by `council status` — never a
  silent stall or a failed attempt. Probe and nudge were exercised live on
  a scratch Devin terminal and then in a live council, where both reviewer
  briefs sat unsubmitted and each was recovered by one Enter (see
  VERIFICATION.md, 2026-11-21).

The launch policy is the shipped catalog (`src/catalog.ts`,
`resolveAgentLaunch`): each AgentChoice `{agent, model, permissionMode,
effort?, profile?}` validates against fixed argv templates and explicit
posture maps — `devin`/`claude`/`codex` only, no other lane exists and none
is substituted. A run's recorded catalog fingerprint (`config.execution`)
must match the loaded catalog before any launch; `OrcaAdapterOptions.agents`
remains as a programmatic back-compat injection (tests, embedders) and is
not used by the shipped CLI path.

The lane the adapter implements (`startPhaseWorker`, lane `argv`):

```
terminal create --worktree <sel> --title <t> --command "<resolved catalog argv>"   # bare — no --full
terminal wait --terminal <term_…> --for tui-idle --timeout-ms <n>                  # bare — no --full
orchestration worker-start --task <task_id> --run <run_id> --worktree <sel> --terminal <term_…> --json --full
```

The durable uncertain-outcome surface of this lane is `worker-start` (the
orchestration mutation carrying the request id); the two `terminal` steps
are evidence-only and are never retry-requested.

- The `--command` string is assembled **only** from catalog tokens: binary ∈
  `allowedAgentBinaries` (default = the catalog's binaries
  `devin`/`claude`/`codex`), flags are the catalog's fixed literals,
  model/posture/effort/profile values must both match `COMMAND_TOKEN_RE` and
  resolve inside the catalog's explicit maps. Nothing else — paths,
  objectives, titles, user text — can enter the string.
- **Permission mode mapping (verified against `devin --help` on this host):**
  Devin CLI `--permission-mode` accepts only `auto | accept-edits | smart |
  dangerous`. The council posture named **"bypass"** is user-facing
  vocabulary; the catalog maps it to each lane's documented all-access mode
  (`dangerous` for Devin, `bypassPermissions` for Claude,
  `danger-full-access` + `--ask-for-approval never` for Codex) — `bypass` is
  never emitted to a CLI.
- `terminal wait --for tui-idle` failing leaves the terminal in an unknown
  readiness state → outcome `uncertain` (reconcile, do not blindly recreate).
- Retained terminals: a settled worker's terminal may receive a new phase
  Task, but the adapter first proves no active dispatch owns it
  (`worker-list --run` filtered by terminal + unsettled outcome/state).
  Overlapping active work on one terminal is refused. These argv-lane
  terminals are never auto-released — `worker-release` on them returns
  `state:'retained'` (verified live, §7.10) — so the engine releases then
  closes each terminal it journaled creating once every attempt on it has
  settled (organiser after roster admission, the rest at terminal
  state/cancel; `council cleanup` re-runs the pass on a finished run).

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
- **`dispatch_run_mismatch` on `orchestration send`** (root cause proven by a
  scratch-Run reproduction, recorded in an uncommitted dev report): a `send
  --to run:<X>` whose `--dispatch-id` names a Dispatch belonging to a
  different Run is refused *before any receipt is recorded* — the printed
  request id then reads `state:"absent"` on `request-show`, indistinguishable
  from "never sent". Orca also attaches a dispatched sender's own Dispatch
  automatically, so the refusal can fire with no explicit flag. The working
  shape is `send --to dispatch:<id>` with no `--dispatch-id`: Orca redirects
  it to the mailbox that terminal reads (verified — delivered `msg_…`,
  warning `recipient_run_bound_redirect`, request `completed`). This is why
  the approval wake targets `dispatch:<supervisor>` — the supervisor's
  Dispatch lives in the caller's Run, not the council child Run.

## 6. Enforcement reality

- **Observed host controls**: caller identity/Run custody, guarded
  stop/release, Orca-issued mutation request replay, and command argument
  validation. Do not infer filesystem or mail-read isolation from these.
- **Council-enforced**: approval binding, phase order, launch/concurrency
  limits, forwarded envelope bytes, message counts, and deadline checks when
  `advance` runs. There is no background deadline daemon.
- **Detective (post-check)**: snapshot re-hash detects source drift. It cannot
  prevent changes or identify which worker made them.
- **Cooperative (prompt-only)**: reviewer edit/peer-read/egress restrictions,
  token/tool budgets inside sessions, and persona behavior. The dangerous
  Devin permission mode is not a review sandbox.

## 7. Unverified / caveats

1. Local `worker-start`/`terminal create` receipts were exercised in the
   completed smoke. Their field names are extracted
   tolerantly (`result.dispatchId | .dispatch.id | .dispatchId`,
   `result.terminal.handle | .handle`); reconcile via `worker-list --run` when
   absent. An unfamiliar success envelope is not proof of a launch.
2. Whether a consuming `check` on a child-Run-bound terminal drains the
   original dispatch mailbox is **unverified** (testing risks deafening the
   caller's own mail). The adapter sidesteps this by never calling `check`.
3. `terminal wait --for tui-idle` succeeded for the pinned Devin lane in the
   live smoke and once for the codex argv lane. Other CLIs and readiness
   under load remain unverified; a
   failed wait is treated as `uncertain`.
4. `--effort` values are enumerated in the shipped catalog only for Claude
   (`low|medium|high|max`, help-verified); other lanes refuse effort
   requests rather than ignoring them.
5. Remote/`host != local` worker behavior is untested; `worker-list` exposes
   `host` for detection.
6. `orchestration approve`/`deny` are hidden (absent from `--help` listing)
   but functional; treat their surface as unstable.
7. `send --phase` exists on the worker mail surface; scribe/phase typing is
   cooperative — Orca does not validate phase names.
8. Long-running mailbox growth and `inbox --limit` pagination shape are
   unverified at scale.
9. **Live-smoke settlement stall (fixed and exercised).** The first end-to-end
   smoke surfaced a `worker-show` row reporting `state:"succeeded"`,
   `stage:"settled"`, `liveness:"unverifiable"`,
   `terminalState:"retained"` that the adapter's `mapLiveness` did not map to
   a settled outcome — the engine waited indefinitely on a finished worker.
   The repaired adapter requires an explicit logical verdict and keeps it
   separate from physical session liveness. The saved run then completed all
   phases; a settled success does not prove process exit or release.
10. **Guarded cleanup may keep a terminal.** A live `worker-release` returned
    `{state:"retained", reason:"user_requested", processAction:"none",
    archive:null}` inside an `ok:true` envelope. The earlier adapter wrongly
    logged `released:true` for that envelope. The repaired mapping requires
    explicit release proof; retained, pending, unknown, and unfamiliar results
    do not count as release. The original smoke journal is preserved with
    this correction documented separately, not rewritten. Stop confirmation
    is likewise distinct from command acceptance. The boolean release
    contract cannot distinguish pending from refused; both remain unconfirmed.
    The same `retained` result is expected on every council argv-lane
    terminal (`worker-release --help` documents that reused/pre-existing
    terminals are never closed by release) — the engine's release-then-close
    lifecycle relies on it, treating `released:false` as "still ours to
    close", never as release proof.
11. **First-turn submission probe limits.** `worker-show`'s `activity` for an
    unsubmitted-but-dispatched Devin could not be observed live, so mixed
    signals classify `inconclusive` — a visible warning, never a false
    `started`. The screen classifier matches current Devin TUI text
    (live-string fixtures); other lanes' screens and future TUI changes are
    unverified — they read as `inconclusive`, not `unsubmitted`, so they
    warn instead of nudging. The probe + single bare Enter ran live on a
    scratch Devin terminal and inside a live council on Devin lanes only.
