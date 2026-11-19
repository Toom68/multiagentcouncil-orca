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
  `supervise --advance`; you never run `run-create`/`run-use` for the council.
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
`prompts/supervisor.md` — the generated supervisor spec.

`--config` is effectively required on a fresh run: it must carry a complete
`staff.{organiser,scribe,supervisor}` of catalog AgentChoices — `init`
refuses without it (the roster approval gate cannot authorize staff work
retroactively). `execution.{catalogVersion,policyHash}` is captured at init,
not supplied. Core keys: `requestedPerspectives` (15 of 10–25),
`participants` (15), `concurrency` (5), `rounds` (1 of 1–3),
`maxFindingsPerSeat` (7), `maxChallengesPerSeatPerRound` (3), `envelopeBytes`
(8192), computed `maxLaunches`, `deadlines` object. Fields absent in old
saved runs are preserved exactly (legacy behavior, never re-hashed). Print
`COUNCIL init --help` / `catalog --json` for the live schema rather than
guessing field names.

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

Write `<runDir>/roster.approved.json` — exactly `config.participants` `seats`,
each `{seatId, perspectiveId, participantId, agent: {agent, model,
permissionMode, profile?}}`. `perspectiveId` must come from the proposal (one
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

**Approval is two actions.** `council approve` emits a journaled approval-wake
notification AND prints an explicit `wakeCommand` — send it, a file write
alone never wakes the supervisor agent:

```text
ORCA orchestration send --to dispatch:<supervisorDispatchId> --subject "approval recorded" --body "approval.json written for run <crun_id>; run council supervise --advance"
```

(Replying to the `needs_approval` mail works the same.) Its next `advance`
re-checks the hash and launches reviewers.

## Step 5 — observe and finish

- Progress: `COUNCIL status --run <runDir>` (read-only; safe any time).
- Worker mail meant for you arrives in YOUR mailbox; consume it yourself.
- On `finished`, the supervisor's `worker_done` carries the outcome and
  `--report-path`. Read `report.md` first, then `report.json`. A partially
  failed run is marked partial — never treat it as clean.
- Evidence: `code_location` citations are re-resolved against the recorded
  snapshot when findings enter the canonical ledger — invalid pieces are
  rejected and journaled, and claims built only on rejected evidence grade
  `unsupported`. Grades are derived, never trusted: reviewer-produced evidence
  can never reach `verified_defect` in v1 — the ceiling is `plausible_risk`.

## Cancellation

```text
COUNCIL cancel --run <runDir>
```

Issues a guarded `worker-stop` per live participant, fences their Dispatches,
marks the run `cancelled`, and reports what is confirmed vs unverifiable.
`stop_unknown` means *not proven stopped* — inspect, never assume. To stop the
supervisor: `ORCA orchestration worker-stop --dispatch <id>`;
`worker-abandon` only when you must force abandonment. Never `terminal close`
a worker terminal; `worker-release` reclaims settled workers only when Orca
confirms release — `ok:true` with `state:retained` is a custody decision, not
release proof. Stop/release uncertainty stays visible; never infer process
exit from an accepted command or a quiet terminal.

## Recovery from uncertain outcomes

- A lost or ambiguous launch/mutation result is an **unknown outcome**, not
  permission to retry. Reconcile first: `ORCA orchestration request-show
  --request <id>` reports `completed|pending|absent`; re-issue the same
  command with `--retry-request <id>` only after that.
- Failed `worker-start`: read `stage`/`failedStage`/`effects`/
  `residualResources` from the receipt; retry the SAME Task with
  `worker-start --task <id> --retry-of <dispatchId>` — never a fresh `--spec`
  (that creates a new Task). Three failures circuit-break the Dispatch.
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

## Manual driving (no supervisor worker)

Skip Step 2 to own the loop yourself: on each wake run `COUNCIL supervise
--run <runDir> --advance`, repeat while it prints `progress`, end the turn on
`wait`/`needs_approval`/`finished`/`blocked`. Run `approve`/`cancel` as above
— after `approve`, the next `advance` you run IS the wake (you are the
supervisor). Same ground rules: no polls, your own mailbox only, and the
first manual `advance` on a run with no child Run binds you to it — restore
your prior binding afterwards.

## Honest boundaries

- Reviewer edit bans, "no peer mail/reads", and egress limits are
  **cooperative** prompt rules, not sandbox guarantees. The run verifies
  drift afterwards (snapshot re-hash detects files changed — never who);
  it cannot prevent a determined worker or observe reads/egress. A bypass
  permission mode is not a review sandbox.
- No Orca MCP server or native plugin is involved — none exists for this on
  the verified Orca build; do not promise one.
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
- `council` commands are the implemented CLI; `COUNCIL help` prints the
  authoritative command list for the installed version.
