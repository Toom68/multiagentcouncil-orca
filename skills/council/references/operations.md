# Council operations runbook

The full operating detail for driving a council run. Commands use two
placeholders:

- `COUNCIL` — `node "<SKILL_DIR>/scripts/council.mjs"` (see the locator rules
  in SKILL.md; the wrapper preserves your cwd and environment).
- `ORCA` — the Orca executable for this session (`ORCA_CLI_COMMAND` → `orca-dev`
  in dev checkouts → `orca` on Windows).

Run every `council` command **from the workspace being reviewed** — the Orca
context comes from the caller's cwd and the run lands in that target's
`.council/`. Nothing is installed or registered per run.

## Ground rules (read first)

- **Preserve your Run binding.** Record it once and always pass `--run`
  explicitly to orchestration commands you issue yourself. The council runs
  inside a separate child Run created by the CLI's host adapter on the first
  `supervise --advance`; you never run `run-create`/`run-use` for the
  council — the ONE exception is the documented dead-supervisor manual
  fallback under "Wedged-run playbooks" (the supported path is
  `start-supervisor --replace`).
  With a dedicated supervisor your binding is never touched — re-run
  `run-current` after launch to confirm. In **manual** mode the CLI still
  never issues `run-use`, but on a run with no child Run yet the first
  `advance` creates one and binds **you** — restore your prior binding after.
- **Only an agent consumes its own mail.** Plain `check`/`--ack` on a mailbox
  marks mail handled and hides it from the agent that owns it. The CLI's host
  adapter never runs `check` or `--ack` — observation is via read-only `inbox`
  and `worker-*` only. You may consume YOUR OWN mailbox only.
- **No polling, no sleeps.** Everything is wake-driven: after a step with
  nothing left to do, end your turn; Orca wakes you on mail/`worker_done`.
  Deadline enforcement happens inside `advance` — no background daemon.
- **Argv, not shell text.** `terminal create --command` types shell text: the
  adapter builds it only from fixed, allowlisted tokens. Never let an
  objective, path, or model name become shell syntax.

## Step 0 — record your binding

```text
ORCA orchestration run-current --json
```

Save the `runId` (may be `null`). If anything rebinds you, restore with
`ORCA orchestration run-use --id <prior>`.

## Step 1 — create the run

```text
COUNCIL init --objective <objective-file> --target <path> --config <file> --json
```

Writes `.council/runs/<crun_id>/` inside the target: `council.json`,
`objective.md`, `snapshot.json`, `state.json`, `meta.json`, and
`prompts/supervisor.md` — the generated supervisor spec. `init` also
captures your stage-wake recipient into `progress/recipient.json` BEFORE
any supervisor binding exists (see "Progress wakes" below).

`--config` is effectively required on a fresh run: it must carry a complete
`staff.{organiser,scribe,supervisor}` of catalog AgentChoices — `init`
refuses without it (the roster approval gate cannot authorize staff work
retroactively). `execution.{catalogVersion,policyHash}` is captured at init,
not supplied. Core keys: `requestedPerspectives` (15 of 10–25),
`participants` (15), `concurrency` (5), `rounds` (1 of 1–3),
`maxFindingsPerSeat` (7), `maxChallengesPerSeatPerRound` (3), `envelopeBytes`
(8192), computed `maxLaunches`, `deadlines` object. Fields absent in old
saved runs are preserved exactly (legacy behavior, never re-hashed).

Start from the bundled template `references/templates/council.config.template.json`
— it carries every key with `staff` placeholders — or the bounded rehearsal
`references/templates/council.config.smoke.template.json` (10 perspectives,
2 seats, 1 round, tighter deadlines). `council help` and `<command> --help`
print only command/flag usage — they do NOT print the config or roster
schemas; the templates and this file are the schema source. `catalog --json`
prints the valid `agent`/`model`/`permissionMode` vocabulary.

**Enforcement honesty:** budgets the runner forwards or launches —
concurrency, launches/phases, rounds, envelope bytes, per-recipient envelopes —
are enforced in the CLI. Budgets inside a worker's own session (token/tool
use, self-reported effort) are cooperative prompt rules the runner cannot
observe; over-budget sessions surface through output caps and audits only.

## Step 2 — launch the dedicated supervisor

The supervisor is a worker whose **lane is the `staff.supervisor` choice you
authorized** (agent, model, permission posture, optional profile — see
`references/selection.md`; there is no built-in default). It exists to carry
a Dispatch identity and receive wakes; it runs only
`council supervise --advance --as-supervisor` from its generated spec.

**Default — the CLI does it:**

```text
COUNCIL start-supervisor --run <runDir> [--wait-ms <n>] --json
```

One command: creates the Orca Task from `prompts/supervisor.md`, opens a
terminal on the authorized supervisor lane, waits for the agent prompt
(`--wait-ms`, default 60 s), proves terminal readiness before binding the
Task with `worker-start` (an idle TUI alone is not proof — a trust or
permission screen reads idle too; the adapter confirms the expected agent
identity and no pending prompt via `terminal show`), and records the
supervisor's `{terminalHandle, dispatchId}` in `state.json` so `council
approve` can address its wake. Save the printed `dispatchId`.

**First-turn submission check.** When the `worker-start` receipt cannot
prove the agent's turn started (Devin reports `input_accepted` with
`turnStart: unsupported`), `start-supervisor` — like every fresh engine
phase launch — runs a bounded, read-only probe: `worker-show` activity, the
relayed terminal title, and the rendered screen (`terminal show` /
`terminal read --screen`), sampled over a ~24 s window
(`COUNCIL_SUBMIT_PROBE_MS`, 100–120 000 ms, retunes it). Verdicts:
`started`, `unsubmitted`, `inconclusive`. Only a settled `unsubmitted`
earns exactly one bare Enter — journaled as `launch.submit_nudge` intent
before the send and a receipt after, so an attempt is never nudged twice,
even across a crash — then a re-probe. Anything unresolved (inconclusive,
still unsubmitted after the nudge, unsupported host) is journaled as a
`launch.submit_unconfirmed` warning and reported in the payload's
`submission` field; the launch is never failed or blocked by the probe.
`council status` surfaces a still-live warning as a `submit` pending action
with the exact manual command — see Step 5 / recovery for when to use it.
Verified live against a scratch Devin terminal; the in-council path is
fixture-tested so far.

**Check the JSON outcome — `ok:true` exit 0 is not "started".** Two
top-level fields decide:

- `outcome:"launched"` + `supervisorStarted:true` → supervisor is up; save
  `dispatchId`.
- `outcome:"paused"` + `supervisorStarted:false` + `needsAttention:true` →
  NOTHING launched. `reason:{code,message}` names the blocker (a trust/
  permission screen, an unresolved custody record, an ambiguous startup
  receipt), `taskId`/`terminalHandle`/`boundRunId` name any partial
  resources, and `recovery` lists the exact next commands. Resolve the
  blocker at the named terminal — never auto-accept trust/permission
  screens — then rerun the same `start-supervisor` command; it reuses the
  recorded resources. The record's per-operation `issued` markers decide
  WHAT a resume may do: a stage proven not-issued is created exactly once,
  while a stage marked issued with no identity (or any legacy record that
  predates `issued` and lacks the resource) fails closed `launch_unknown`
  — the mutation may have landed; reconcile before retry. An unconfirmed
  issued attach (`start_issued`) blocks reruns until reconciled — it never
  creates a replacement on a missing receipt.
  Do not wait for a `needs_approval` mail a paused launch cannot send.

If `start-supervisor` cannot reach Orca, the manual equivalent is the same
sequence via `ORCA orchestration task-create`, `ORCA terminal create
--command <authorized lane argv>`, `ORCA terminal wait --for tui-idle`, then
`ORCA orchestration worker-start --task <id> --terminal <handle>`. A blocked
readiness check means a human decision is needed **in that terminal** — never
auto-accept trust/permission prompts; resolve it, then retry/reconcile.

## Step 3 — the supervisor advances (you do nothing)

The supervisor spec instructs its agent to advance deterministically on each
wake:

```text
COUNCIL supervise --run <runDir> --advance --as-supervisor --json
```

`--advance` reconciles persisted state against Orca and prints one action:
`progress`, `wait`, `needs_approval`, `finished`, or `blocked`. Discipline:
**keep running `advance` in the same turn while it prints `progress`** — each
call is one bounded, idempotent step — and stop only on `wait`,
`needs_approval`, `finished` (send `worker_done` with the printed outcome and
`--report-path`), or `blocked`. A chain of local progress steps emits no
external event, so stopping after one `progress` stalls the run. Inside
`advance` the CLI performs the organiser launch, reviewer fan-out with the
concurrency window, per-recipient challenge envelopes, scribe synthesis,
deadline checks, and journal writes — the supervisor agent makes no protocol
decisions and never runs orchestration mutations itself.

`--as-supervisor` is the dedicated mode: the CLI requires the worker's Orca
terminal identity, refuses when a *different* supervisor is recorded, and
rebinds the caller to the persisted council child Run (verified, idempotent)
before advancing — the repair path for a restarted supervisor whose child Run
stayed bound to a crashed terminal. The generated spec's command is fixed:
verbatim, never edited. Manual `advance` (below) never issues `run-use` and
never displaces the recorded supervisor — but on a run with no child Run yet
it creates one and binds you (see Ground rules).

## Step 4 — approval gate

When the supervisor reports `needs_approval`, it mails a roster summary and
the exact command. **Read the proposal first:**

```text
<runDir>/roster.proposed.json   # 10–25 perspectives, each with charter
                              # {incentives, expertise, method, blindSpots,
                              #  reviewQuestions[]}
```

Write `<runDir>/roster.approved.json` — copy
`references/templates/roster.approved.template.json` and fill it. The file
is a **wrapper**, not a bare seat array: `schemaVersion:1`, `runId` (must
equal this run's id), and `seats[]` holding exactly `config.participants`
entries — all three are required and validated. Each seat is
`{seatId, perspectiveId, participantId, agent: {agent, model,
permissionMode, profile?}}` with unique `seatId`/`perspectiveId`/
`participantId`. `perspectiveId` must come from the proposal (one
per seat, no duplicates); each seat's lane is your explicit choice from the
supported catalog — validated against the run's captured policy, approval-
bound, never defaulted. Then:

```text
COUNCIL approve --run <runDir> --roster <runDir>/roster.approved.json [--note "<why>"]
```

Writes `approval.json` binding
`sha256(canonical({runId, objective, seats, proposedRosterHash, config,
snapshotId, snapshotHeadHash}))` — the whole proposed roster is hashed in, so
editing the proposal invalidates too. Reviewers cannot launch before a valid
approval exists. Any later change to the objective, selection, config, or the
target tree invalidates it; a mid-run invalidation is cured only by
re-approving the *exact same* seats/agents (a new run to change the roster).
There is no soft approval.

**Approval already attempted the wake.** `council approve` — inside the same
call — has the engine send a bounded approval-wake (`mail.sent`,
`kind:'approval-wake'`) addressed to the recorded supervisor **Dispatch**
(`dispatch:<id>`) when one exists — the supervisor's Dispatch lives in your
Run, and Orca redirects dispatch mail to the mailbox the supervisor
terminal reads. Only with no recorded dispatch does it fall back to the
bound council child Run (`run:<id>`) or the recorded supervisor terminal.
(A `run:<child>` send carrying the supervisor's foreign `--dispatch-id` is
refused `dispatch_run_mismatch` before any receipt — the earlier failure
mode this addressing fixed.) It then reports the journaled outcome as
`supervisorWake` (`sent` / `skipped` / `budget_refused` / `error` /
delivery outcomes / `none`) including any journaled host
`errorCode`/`error`. A file write alone never wakes an agent — but
this send was attempted before the command returned, so do **not** blindly
re-send. The printed `wakeCommand` is the manual fallback for the case
where the recorded ACTIVE supervisor has not resumed:

```text
ORCA orchestration send --to dispatch:<supervisorDispatchId> --subject "approval recorded" --body "approval.json written for run <crun_id>; run council supervise --advance"
```

Check `supervisorWake.outcome` first — `sent` means the wake was issued;
historical/journaled notices are not fresh approvals. `approvalWake` is a
different notice — the progress mail to YOU, not the supervisor. (Replying
to the `needs_approval` mail also reaches the supervisor.) Its next
`advance` re-checks the hash and launches reviewers.

## Step 5 — observe and finish

- Progress: `COUNCIL status --run <runDir>` (read-only; safe any time). The
  JSON reports phase and per-participant status plus: `activity`
  (`lastEventAt`/`ageMs` — journal freshness ONLY: a stale clock means no
  events were durably recorded, never proof that workers are alive or
  dead), `phase` timing (`enteredAt`, `deadlineMs`, `graceMs`,
  `overDeadline`),
  `supervisorHealth` (`recorded` + a `live|stale|unproven|none` probe — a
  recorded supervisor is not proof of life), `pendingActions` (exact
  executable command strings for decisions that need you — e.g. the
  `council reconcile` line for a persisted no-task intent, a `submit`
  action for an unconfirmed first-turn submission, a `start-supervisor
  --replace` action on a provably stale supervisor, or a `cleanup` action
  when a terminal run still has unclosed recorded terminals), the
  journal-derived `submission` warnings behind the `submit` actions,
  per-attempt `dispatchId`s for manual fencing, and a `notify` block with the wake
  recipient, delivery counters, send budget, helper state, and
  `outboxState` — `'unavailable'` means the outbox is corrupt/deleted and
  the counters are placeholders, NEVER evidence of zero sends (the human
  `wake:` line says the same; a genuinely-new run reads `'ok'` with zeros).
- Worker mail meant for you arrives in YOUR mailbox; consume it yourself.
- **Overdue phase? One bounded nudge, then wait.** Deadlines are enforced
  on `advance` — a phase that never advances never times out. If `status`
  shows a CURRENT nonterminal phase past `deadlineMs` AND the recorded
  supervisor Dispatch is logically ACTIVE (not completed/settled), send
  that exact Dispatch ONE nudge to run its normal
  `council supervise --advance` — once per persisted phase/deadline, then
  end your turn and wait. Record the nudge (it is not a fresh approval or
  directive). NEVER send to a completed/settled Dispatch — Orca turns that
  into a follow-up Task — and never infer the supervisor died or spawn a
  replacement from silence; a stale or unproven supervisor uses the
  guarded `--replace` recovery instead.
- On `finished`, the supervisor's `worker_done` carries the outcome and
  `--report-path`. Read `report.md` first, then `report.json`. A partially
  failed run is marked partial — never treat it as clean. Afterward,
  `COUNCIL verify --run <runDir>` re-checks snapshot drift, the approval
  binding, and the catalog fingerprint.
- Once the run is terminal (or cancelled), run `COUNCIL cleanup --run
  <runDir>` to release-then-close any council-created terminals still open —
  including an idle supervisor — see "Terminal lifecycle and cleanup"
  below. Idle sessions hold real host memory until closed.
- Evidence: `code_location` citations are re-resolved against the recorded
  snapshot when findings enter the canonical ledger — invalid pieces are
  rejected and journaled, and claims built only on rejected evidence grade
  `unsupported`. Grades are derived, never trusted: reviewer-produced evidence
  can never reach `verified_defect` in v1 — the ceiling is `plausible_risk`.
  Reviewers may also file bounded `strengths` (≤3 per seat, same evidence
  rules — a preservation record, never a praise quota); the runner stamps
  their provenance and renders them beside prioritized findings in
  `report.md`/`report.json`. Strengths never route for challenge and never
  upgrade a claim's grade.

## Progress wakes — the run mails you every stage

The run notifies the **initiating orchestrator** (you) at every lifecycle
change — stage transitions, the approval gate, blockers, failure,
cancellation, completion — and a bounded run-local **progress helper**
sends periodic updates during long, otherwise-silent stages (~every
2 minutes while a stage runs). Subject form: `council <crun>: <stage>`.

Every notice carries **persisted facts**: stage label, participant counts
by status, attempts settled/planned for the phase, launch consumption,
elapsed/stage age, the next action, and report paths on finish. Relay each
one to the user concisely — stage, counts, blocker or next action — on every
wake; staying silent until the final report is not acceptable. The facts are
read from run state and the journal: they never prove worker liveness, and
the messages say so.

Mechanics, honestly:

- The wake recipient is persisted explicitly at
  `<runDir>/progress/recipient.json` (`{to, source, recordedAt}`) BEFORE any
  supervisor binding change — the first durable target wins; a run with no
  recipient file gets no stage mail (legacy runs included), and `status`
  reports what is recorded.
- Notices are deduplicated by durable intent — a repeated stage does not
  re-mail you; `unknown` delivery outcomes are kept visible, never
  blind-retried. Stage/heartbeat sends have their own bounded budgets
  (48 stage / 90 heartbeat by default). A crash between the durable
  transition and the send is caught up by replaying journaled milestones —
  such mail is labelled `replay:`, names the replayed milestone, and its
  counts still reflect current state.
- Sends are drained outside the run lock, bounded (15 s/send, ≤8 sends and
  ≤45 s of backlog per non-terminal step — leftovers are recomputed next
  advance; terminal steps attempt everything including the finished wake).
  `progress/outbox.init` is a prior-use witness: an outbox deleted after
  use reads as `outboxState:'unavailable'`, never as a clean zero.
- The helper is an argv-spawned `node` child (`progress.js helper --run
  <dir>`), singleton-leased, default 2-minute ticks, finite message
  budget, 24-hour max lifetime, exits on terminal council state. It reads
  persisted state/journal only — no host polling, no provider jobs, no
  agents. `status`'s `notify` block shows its health
  (`running`/`starting`/`stale`/`dead`/`exited`/`none`): a dead helper or
  unavailable outbox is a visibility gap to report, never claimed as
  guaranteed delivery.

## Cancellation

```text
COUNCIL cancel --run <runDir>
```

Issues a guarded `worker-stop` per live participant, fences their Dispatches,
releases-then-closes the council-created terminals whose attempts are
settled, marks the run `cancelled`, and reports what is confirmed vs
unverifiable. It then sends the recorded supervisor Dispatch ONE bounded,
journaled notice (`mail.sent`, `kind:'cancel-notice'`) telling it to run
`advance` once — which reports finished/cancelled — and send `worker_done`;
the notice goes out only while `worker-show` observes the dispatch `idle`,
`working`, or `waiting_human` (a settled dispatch would reopen as new work;
an unverifiable or unrecorded one is skipped with a journaled reason).
`stop_unknown` means *not proven stopped* — inspect, never assume; Orca
returns it for the supervisor's external argv-lane terminal, which is why
the notice exists. To stop the supervisor yourself:
`ORCA orchestration worker-stop --dispatch <id>`;
`worker-abandon` only when you must force abandonment. Never `terminal
close` a worker terminal by hand — closes are journaled under run custody
(see below); `worker-release` reclaims settled workers only when Orca
confirms release — `ok:true` with `state:retained` is a custody decision, not
release proof. Stop/release uncertainty stays visible; never infer process
exit from an accepted command or a quiet terminal.

After `cancel` returns, follow with `COUNCIL cleanup --run <runDir>` for
anything left over — including the supervisor's terminal once its dispatch
settles, or while it is still observed `idle` on the now-terminal run.

## Terminal lifecycle and cleanup

Orca never auto-releases the argv-lane terminals the council creates, so
the engine owns their retirement: once every attempt that ran on a terminal
is settled, the engine releases it (`worker-release`) then closes it
(`terminal close`), with the close journaled as `terminal.close` intent —
flushed before the host call — then a `closed` / `already_gone` / `failed`
receipt. The organiser's terminal is closed as soon as its roster is
admitted; reviewer/scribe terminals stay open for discussion-round and
synthesis reuse and are closed when the run reaches a terminal state
(reported/failed/cancelled — `advance` runs the pass, `cancel` runs it too).
Close failures are journaled and never change the run outcome.

```text
COUNCIL cleanup --run <runDir> [--json]
```

runs the same pass again on a **terminal run only** — it refuses a live run
(`invalid_transition`), because its terminals may still be in use. On top of
the persisted attempt statuses it may additionally *observe* an unsettled
dispatch (`worker-show`, read-only) and treat a host `finished` verdict as
settled. It also covers the supervisor via `supervisor/startup.json`: a
settled supervisor is released-then-closed, and on a terminal-state run an
attached supervisor whose dispatch is still observed `idle` (e.g. a
cancelled run whose cancel-notice it never answered) is closed too, with
the exact reason journaled; `working`, `waiting_human`, `unverifiable`, or
unobservable stays `skipped`. Each terminal reports `closed` /
`already_gone` / `skipped` / `failed` plus a summary; a journaled
`closed`/`already_gone` receipt is never re-closed, a failed close is
retried only here (never by the engine), and a receipt-less intent is
retried and flagged `retriedIntent`. Custody is strict — only terminals
this run journaled creating are considered; nothing else is ever touched —
and the calling terminal (`ORCA_TERMINAL_HANDLE`) is never closed: run
`cleanup` from a terminal other than the supervisor's. `council status`
names it as a `cleanup` pending action while unclosed recorded terminals
remain, and the `finished` next-hint prints it.

**Memory.** A seat's session lives until the run closes it — idle reviewers
persist through discussion, and on the Windows validation host each idle
Devin session plus its MCP helpers held ~0.4 GB of RAM and ~2.8 GB of
committed memory. Before this lifecycle existed, leftover sessions across
runs exhausted the commit limit once: a new reviewer's shell failed to
start and a running reviewer crashed. Size
`participants`/`concurrency` to available memory, and always finish with
`cleanup` on terminal runs.

## Recovery from uncertain outcomes

- A lost or ambiguous launch/mutation result is an **unknown outcome**, not
  permission to retry. Reconcile first: `ORCA orchestration request-show
  --request <id>` reports `completed|pending|absent`; re-issue the same
  command with `--retry-request <id>` only after that.
- Failed `worker-start`: read `stage`/`failedStage`/`effects`/
  `residualResources` from the receipt; retry the SAME Task with
  `worker-start --task <id> --retry-of <dispatchId>` — never a fresh `--spec`
  (that creates a new Task). Three failures circuit-break the Dispatch.
- Fresh terminal failed BEFORE dispatch: when the adapter proves
  `workerStartIssued:false` on a terminal this attempt created (a readiness
  wait failure or refusal — e.g. a provider CLI stalled at a login screen),
  the engine closes the orphan terminal itself and mints exactly ONE fresh
  relaunch for that seat/phase/round — charged and deadline-bounded like
  any launch. A second pre-dispatch failure fails the seat under the quorum
  rules. This applies ONLY to proven no-dispatch failures: a possibly-issued
  worker-start (no explicit flag, unjournaled handle, retained-terminal
  reuse) still blocks `launch_unknown`, keeps its terminal, and is never
  relaunched.
- First-turn submission unconfirmed (`submit` pending action in `status`):
  inspect the screen — `ORCA terminal read --terminal <handle> --screen
  --json`. ONLY if the input line still holds the brief, submit once with a
  bare Enter: `ORCA terminal send --terminal <handle> --text $'\r'`
  (PowerShell: `--text "`r"`). A literal `\r` is typed as text, not a
  submit; never re-type the prompt. The runner already spent its one
  automatic nudge, or skipped it on an inconclusive verdict.
- Worker stopped without `worker_done`: an `escalation` carries `stopReason`;
  `exited`/`lost` means gone. Silence and `unverifiable` liveness never prove
  exit.
- After any crash or doubt, run `advance` again: `events.jsonl` is the source
  of truth and every call reconciles persisted state before acting.

**Persisted no-task intent (`blocked` after a refused task-create).** The
engine keeps `intent_recorded` with null ids and refuses to retry — the
double-launch guard. The explicit recovery:

```text
COUNCIL reconcile --run <runDir> --attempt <attemptId> \
  --confirm-no-effects <requestId> [--as-supervisor] --json
```

Runs under the run's file lock; verifies the journaled refusal carries that
exact request id, scans `task-list --full` for a task with this attempt's
exact spec (adopts a unique match), then persists `taskId`. Create happens
only under a verified definitive refusal — a timeout, lost connection,
multiple matches, pending request, malformed list, or non-null-task attempt
all refuse it. Find ids via `COUNCIL tail --run <runDir>` or `status`.

## Wedged-run playbooks

### Dead or stale supervisor — guarded replacement

Orca terminal handles are runtime-scoped: an Orca restart (or a dead
terminal) makes the recorded supervisor handle permanently unmatchable —
`--as-supervisor` refuses any other terminal, and plain `start-supervisor`
refuses while a supervisor is recorded. The supported replacement is
explicit and evidence-gated:

```text
COUNCIL start-supervisor --run <runDir> --replace --json
```

It launches a new supervisor ONLY when the old identity is **proven** stale
— `terminal show` on the recorded handle returns a definitive stale-handle
code (`terminal_handle_stale`) — AND the original attach/dispatch custody is
resolved via `worker-list` plus `request-show` on any issued-start receipt.
On success it prints `{outcome:"launched", replaced:true,
retiredSupervisor:{terminalHandle,dispatchId}, ...}`; the old startup
record is archived under `supervisor/` and the retirement journaled — the
original identity, staff, and approval binding are preserved, never erased.
It REFUSES (nonzero exit) on a still-live supervisor (`invalid_transition`)
or unproven/contradictory evidence (`launch_unknown`); the refusal carries
`details.probes` and `details.recovery` naming exact commands. Quiet,
released, or disconnected is never proof of death. If `--replace` is
refused, the only fallback is **manual driving** (below): fence the old
dispatch (`worker-stop --dispatch <id>`), rebind the run's child Run
(`ORCA orchestration run-use --id <orcaRunId> --from <your handle>` —
`status` prints `orcaRunId`), and drive `advance` yourself. Never force a
replacement the guard denied by hand-editing custody records.

### Corrupt `events.jsonl` (journal)

`advance` **and** `cancel` both fail closed on an unreadable journal — the
journal is the durable record and acting blindly could re-issue landed
mutations. There is no journal-rebuild command. Safe order:

1. List live dispatches: `COUNCIL status --run <runDir> --json` reads
   `state.json` (a corrupt journal may not block it) — if it fails, read
   `state.json` directly for `attempts[].dispatchId`.
2. Fence live workers yourself:
   `ORCA orchestration worker-stop --dispatch <id>` per live dispatch
   (`request-show`/`worker-show` first if you need custody evidence).
3. Preserve the run directory for audit; the run cannot continue. If the
   journal tail is partially readable, `COUNCIL tail --run <runDir>` may
   still show how far it got.

### Corrupt `state.json`

Every `council` command fails `io_error` at load — there is no state-rebuild
command and the journal's truth is unreachable through the product.
Playbook: read `events.jsonl` directly for dispatch ids (`grep dispatchId`),
fence live workers with `ORCA orchestration worker-stop --dispatch <id>`,
keep the directory for audit, and start a new run. Never hand-edit
`state.json` to "unblock" a run — a forged custody record is worse than a
lost run.

### Live-pid lock (`lock_timeout`)

The run lock is owned by a live pid: acquisition waits `COUNCIL_LOCK_WAIT_MS`
(default 10 s) then fails `lock_timeout` naming the owner pid and
`startedAt`. A lock a **live** pid owns is never reclaimed — deleting it
races a real writer and can corrupt state. Order:

1. Check the named pid actually lives (`kill -0 <pid>`). If dead, wait
   `COUNCIL_LOCK_STALE_MS` (default 60 s) — stale locks are reclaimed
   automatically; tunables are `COUNCIL_LOCK_WAIT_MS`,
   `COUNCIL_LOCK_STALE_MS`, `COUNCIL_LOCK_POLL_MS`.
2. If the pid is live but wedged, terminate that process first — the lock
   then goes stale and reclaims normally.
3. NEVER delete the lock file while its owner pid is alive; that is the
   one action that can corrupt a healthy run.

## Manual driving (no supervisor worker)

Skip Step 2 to own the loop yourself: on each wake run `COUNCIL supervise
--run <runDir> --advance`, repeat while it prints `progress`, end the turn on
`wait`/`needs_approval`/`finished`/`blocked`. Run `approve`/`cancel` as above
— after `approve`, the next `advance` you run IS the wake (you are the
supervisor). Same ground rules: no polls, your own mailbox only, and the
first manual `advance` on a run with no child Run binds you to it — restore
your prior binding afterwards. Stage/progress mail still reaches the
recorded recipient — the runner sends it, not your `advance` calls — so keep
relaying each notice to the user.

## Honest boundaries

- Reviewer edit bans, "no peer mail/reads", and egress limits are
  **cooperative** prompt rules, not sandbox guarantees. The run verifies
  drift afterwards (snapshot re-hash detects files changed — never who);
  it cannot prevent a determined worker or observe reads/egress. A bypass
  permission mode is not a review sandbox.
- No Orca MCP server or native plugin is involved — none exists for this on
  the verified Orca build; do not promise one.
- Stage/progress mail reports **persisted run facts** — never worker
  liveness. A missed heartbeat means a dead helper or delayed send (a
  visibility gap `status` can show), not a healthy-or-dead verdict; the only
  reliable liveness check is `status`/`tail` plus the recovery playbooks.
- The product never installs this skill, changes permissions, or edits global
  config; permission posture is chosen explicitly per launch and recorded in
  the approval.
- Live validation: a repaired 15-seat small-fixture council completed the
  full protocol with all 15 independent files admitted, three distinct
  qualified challenges (all local ids C-1), two author revisions applied,
  and zero output/evidence rejections. It used reduced per-seat outputs
  for one round; one cap-omitted response remains explicit dissent.
  Full admitted-seat coverage is not full peer scrutiny. Default-volume,
  multi-round and long-run production scale remain unverified. Earlier
  partial/interrupted runs, child-Run rebind and exact no-effect task
  reconciliation are recorded separately in docs/VERIFICATION.md.
- Launch/cleanup lifecycle (newest commits): `terminal close`/`show`, the
  submission probe + single bare Enter, the `dispatch:<id>` send shape, and
  `council cleanup` closing a cancelled run's idle supervisor were each
  exercised live against Orca 1.4.261 on this host. The complete
  in-council paths — engine closes, pre-dispatch relaunch, the submit
  nudge inside `advance`/`start-supervisor`, and the approval wake inside
  `council approve` — are fixture-tested, not yet observed in a live
  council.
- `council` commands are the implemented CLI; `COUNCIL help` prints the
  authoritative command list for the installed version.
