---
name: council
description: >-
  Run a Multiagent Council review from inside Orca: one organiser proposes review
  perspectives, you approve the exact roster and agent/model choices, independent
  reviewers inspect a snapshot of the target, exchange bounded evidence-bearing
  challenges, and a separate scribe returns a prioritised report. Use when the user
  asks for a council review, a multi-reviewer critique of a project/plan/codebase,
  or says "council". Requires the `council` CLI built from this repository and a
  running Orca. The council never installs skills, changes permissions, edits the
  reviewed project, or alters global config on its own.
---

# Council skill

This skill teaches the **calling agent** (the primary orchestrator) how to run a
council and stay out of its way. All protocol logic — state machine, budgets,
approval hashing, claim ledger, journaling — lives in the `council` CLI. Your job
is three decisions: launch the supervisor, approve the roster, read the report.

Commands below use two placeholders:

- `ORCA` — the Orca executable for this session, resolved per the `orchestration`
  skill (`ORCA_CLI_COMMAND` → `orca-dev` in dev checkouts → `orca` on Windows).
- `COUNCIL` — the built CLI: `node <checkout>/dist/src/cli.js`, invoked by
  absolute path (`npm install && npm run build` in the checkout first; the
  package's `bin` maps `council` to `dist/src/cli.js`). Run every `council`
  command **from the workspace being reviewed** — the Orca context comes from
  the caller's working directory, and the run directory is created under that
  target's `.council/`. Nothing is installed or registered: no plugin, no MCP
  server, no global writes (a user may `npm link` manually if they want a
  `council` command on PATH — nothing does it for them).

## Ground rules (read first)

- **Preserve your Run binding.** Record it once and always pass `--run` explicitly
  to orchestration commands you issue yourself. The council runs inside a
  separate child Run created by the `council` CLI's host adapter on the first
  `supervise --advance`, and you never run `run-create`/`run-use` for the
  council yourself. With a dedicated supervisor your own binding is never
  touched — re-run `run-current` after launching it to confirm. In **manual**
  mode (you drive `advance` yourself) the CLI still never issues `run-use`,
  but on a run with no child Run yet the first `advance` creates one and the
  host binds **you** to it — that displaces your prior binding; restore it
  with Step 0's `run-use` afterwards.
- **Only an agent consumes its own mail.** Plain `check`/`--ack` on a mailbox
  marks mail handled and hides it from the agent that owns it. The `council`
  CLI's host adapter never runs `check` or `--ack` at all — observation is via
  read-only `inbox` and `worker-*` commands only. You may run consuming
  `check` for YOUR OWN mailbox only; never for a helper's.
- **No polling, no sleeps.** Everything is wake-driven: after any step that has
  nothing to do, end your turn; Orca wakes you when mail or a `worker_done`
  arrives. Deadline enforcement happens inside `advance` calls — there is no
  background daemon.
- **Argv, not shell text.** `terminal create --command` types shell text: build
  it only from fixed, allowlisted tokens (the Devin pin below). Never let an
  objective, path, or model name become shell syntax.

## Step 0 — record your binding

```text
ORCA orchestration run-current --json
```

Save the `runId` (may be `null`). If anything ever rebinds you, restore with
`ORCA orchestration run-use --id <prior>`.

## Step 1 — create the run

```text
COUNCIL init --objective <objective-file> --target <path> [--config <file>] --json
```

Writes `.council/runs/<crun_id>/` inside the target: `council.json`,
`objective.md`, `snapshot.json`, `state.json`, `meta.json`, and
`prompts/supervisor.md` — the generated supervisor spec. `--config` overrides
defaults (`requestedPerspectives` 15 of 10–25, `participants` 15,
`concurrency` 5, `rounds` 1 of 1–3, `maxFindingsPerSeat` 7,
`maxChallengesPerSeatPerRound` 3, `envelopeBytes` 8192, computed `maxLaunches`
floor + slack, `deadlines` object — see docs/USAGE.md for the full table).

**Enforcement honesty:** budgets the runner physically forwards or launches —
concurrency, launches/phases, rounds, envelope bytes, per-recipient envelopes —
are enforced in the CLI. Budgets inside a worker's own session (token/tool use,
self-reported effort) are cooperative prompt rules the runner cannot observe;
over-budget sessions surface only through output caps and audits, never
prevention.

## Step 2 — launch the dedicated supervisor

The supervisor is a Devin `swe-2-max` worker that exists to carry a Dispatch
identity and receive wakes; it runs only `council supervise --advance
--as-supervisor` (the dedicated mode embedded in its generated spec).

**Default — the CLI does it:**

```text
COUNCIL start-supervisor --run <runDir> [--wait-ms <n>] --json
```

One command: creates the Orca Task from `prompts/supervisor.md`, opens a
terminal on the pinned lane `devin --model swe-2-max --permission-mode
dangerous`, waits for the agent prompt (`--wait-ms`, default 60 s), binds the
Task with `worker-start`, and records the supervisor's
`{terminalHandle, dispatchId}` in `state.json` so `council approve` can
address its wake. Save the printed `dispatchId`.

**Manual equivalent** (what `start-supervisor` runs internally — use only to
debug or when the command cannot reach Orca):

```text
ORCA orchestration task-create --spec-file <runDir>/prompts/supervisor.md --task-title "Council supervisor" --json
ORCA terminal create --worktree active --title council-supervisor --command "devin --model swe-2-max --permission-mode dangerous" --json
ORCA terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
ORCA orchestration worker-start --task <taskId> --terminal <handle> --worktree current --json
```

**Alternative — agent lane** (`--agent devin`, model from Devin's own account
config; only if the operator confirmed that config):

```text
ORCA orchestration worker-start --task <taskId> --worktree current --agent devin --json
```

Never pass `--model` to `worker-start` for Devin — it does not cover Devin
(`worker-start --help`). Never select `*-lightning` models; never set
`DEVIN_REFUSAL_FALLBACK`. Save the returned `dispatchId`.

## Step 3 — what the supervisor does (you do nothing here)

The supervisor spec instructs its agent to advance deterministically on each
wake:

```text
COUNCIL supervise --run <runDir> --advance --as-supervisor --json
```

`--advance` reconciles persisted state against Orca and prints one action:
`progress` (one bounded step ran), `wait`, `needs_approval`, `finished`, or
`blocked`. The discipline is: **keep running `advance` in the same turn while it
prints `progress` — each call is still one bounded, idempotent step — and stop
the turn only when it prints `wait`** (nothing left to do), `needs_approval`
(mail the caller), `finished` (send `worker_done` with the printed outcome and
`--report-path`), or `blocked`. This matters: a chain of purely local progress
steps emits no external event, so stopping after a single `progress` would
stall the run forever. Inside `advance` the CLI performs the organiser launch,
reviewer fan-out with the concurrency window, per-recipient challenge
envelopes, scribe synthesis, deadline checks, and journal writes. The
supervisor agent makes no protocol decisions and never runs orchestration
mutations itself — the CLI does that through the host adapter.

`--as-supervisor` is the dedicated supervisor's mode: the CLI requires the
worker's Orca terminal identity, refuses when a *different* supervisor is
recorded, and rebinds the caller to the persisted council child Run
(`run-use --id <run> --from <handle>`, then verifies) before advancing — the
repair path for a restarted supervisor whose child Run stayed bound to a
crashed terminal (Orca refuses task-create for any unbound caller). The
generated spec's command is fixed: the worker must run it verbatim, never
edit, append to, or interpolate it. Manual `advance` (Step "Manual driving")
never issues `run-use` and never displaces the recorded supervisor — but on a
run with no child Run yet, the first manual `advance` creates it and the host
binds you to it (see Ground rules).

## Step 4 — approval gate (the only gate that matters)

When the supervisor reports `needs_approval`, it mails you a roster summary and
the exact command. Before approving, READ the proposal:

```text
<runDir>/roster.proposed.json   # 10–25 perspectives, each with charter
                                # {incentives, expertise, method, blindSpots,
                                #  reviewQuestions[]}
```

Write your selection to `<runDir>/roster.approved.json` — exactly
`config.participants` `seats`, each
`{seatId, perspectiveId, participantId, agent: {agent, model, permissionMode}}`:
`perspectiveId` must come from the proposal (one per seat, no duplicates), and
the agent choice is explicit and approval-bound — the only allowlisted and
live-validated lane is `devin` / `swe-2-max` / permissionMode `bypass` (the
adapter maps `bypass` → Devin CLI `--permission-mode dangerous`; any other
posture needs an explicit adapter policy). Then:

```text
COUNCIL approve --run <runDir> --roster <runDir>/roster.approved.json [--note "<why>"]
```

This writes `approval.json` binding
`sha256(canonical({runId, objective, seats, proposedRosterHash, config,
snapshotId, snapshotHeadHash}))` — the whole proposed roster is hashed in, so
editing the proposal invalidates too. Reviewers cannot launch before a valid
approval exists. Any later change to the objective, selection, config, or the
target tree itself invalidates it and blocks launches; a mid-run invalidation
is cured only by re-approving the *exact same* seats/agents (start a new run
to change the roster). There is no soft approval.

**Approval is two actions, not one.** `council approve` emits a journaled
approval-wake notification through the engine (to the bound council Run,
carrying the supervisor's dispatch id) AND prints an explicit `wakeCommand` —
send it, because a file write alone never wakes the supervisor agent:

```text
ORCA orchestration send --to dispatch:<supervisorDispatchId> --subject "approval recorded" --body "approval.json written for run <crun_id>; run council supervise --advance"
```

(Replying to the supervisor's `needs_approval` mail works the same way.) Its next
`advance` re-checks the hash and launches reviewers.

## Step 5 — observe and finish

- Progress: `COUNCIL status --run <runDir>` (read-only; safe any time).
- Worker mail meant for you arrives in YOUR mailbox; consume it yourself.
- On `finished`, the supervisor's `worker_done` carries the outcome and
  `--report-path`. Read `<runDir>/report.md` first, then `report.json`. A
  partially failed run is marked partial — never treat it as clean.
- Evidence: `code_location` citations are re-resolved against the recorded
  snapshot (path in the manifest, line range and snippet against the file
  text) when findings enter the canonical ledger — invalid pieces are rejected
  and journaled, and claims built only on rejected evidence grade
  `unsupported`. Grades are derived, never trusted: in v1 reviewer-produced
  evidence can never reach `verified_defect` — the ceiling is
  `plausible_risk`, and a matching citation or peer agreement upgrades
  nothing.

## Cancellation

```text
COUNCIL cancel --run <runDir>
```

Issues a guarded `worker-stop` per live participant, fences their Dispatches,
marks the run `cancelled`, and reports what is confirmed vs unverifiable.
`stop_unknown` means *not proven stopped* — inspect, never assume. If the
supervisor itself must go, `ORCA orchestration worker-stop --dispatch
<supervisorDispatchId>`; `worker-abandon` only fences it when you must force
abandonment. Never `terminal close` a worker terminal; `worker-release` reclaims
settled workers.

## Recovery from uncertain outcomes

- A lost or ambiguous launch/mutation result is an **unknown outcome**, not
  permission to retry. Reconcile first: `ORCA orchestration request-show
  --request <id>` reports `completed|pending|absent`; re-issue the same command
  with `--retry-request <id>` only after that.
- Failed `worker-start`: read `stage`/`failedStage`/`effects`/`residualResources`
  from the JSON receipt; retry the SAME Task with `worker-start --task <id>
  --retry-of <dispatchId>` — never a fresh `--spec` (that creates a new Task).
  Three failures circuit-break the Dispatch; do not route around it.
- Worker stopped without `worker_done`: an `escalation` carries `stopReason`;
  `exited`/`lost` means gone. Silence and `unverifiable` liveness never prove
  exit.
- After any crash or doubt, just run `advance` again: `events.jsonl` is the
  source of truth and every call reconciles persisted state before acting.

**Supervisor restart on a saved run.** A restarted supervisor whose child Run
stayed bound to a crashed terminal is repaired by the product: its generated
advance command already carries `--as-supervisor`, which rebinds the caller to
`state.json`'s `orcaRunId` (verified, idempotent) before stepping. Do not
run `run-use` by hand as a workaround — the CLI performs and verifies it.

**Persisted no-task intent (`blocked` after a refused task-create).** When a
worker's task-create was definitively refused (journal `error` with
`op:"task-create"` carrying an `Orchestration mutation request ID`), the
engine keeps `intent_recorded` with null `taskId/dispatchId/terminalHandle`
and refuses to retry — the double-launch guard. The explicit recovery is:

```text
COUNCIL reconcile --run <runDir> --attempt <attemptId> \
  --confirm-no-effects <requestId> [--as-supervisor] --json
```

The whole transaction runs under the run's file lock — a concurrent
`reconcile` on the same attempt blocks and then refuses on the persisted
`taskId`, never a second task-create. It verifies the journaled refusal
carries that exact request id, scans `task-list --full` for a task carrying
this attempt's exact spec (adopt a unique match), then persists `taskId` +
`task.created` — the next `advance` launches on it. **Create happens only
under a verified definitive refusal**: the journaled refusal says "Nothing
changed", carries an explicit no-effects marker, or the request ledger
reports `refused`/`rejected`. A timeout, lost connection, or other generic
failure — even with a matching request id — refuses the create path; so do
multiple matches, a pending request, a malformed `task-list`, a
missing/mismatched request id, or a non-null-task attempt. Adoption of a
unique existing match stays allowed under an uncertain failure — adopting
creates nothing. Find `attemptId`/`requestId` via `COUNCIL tail --run
<runDir>` or `status`.

## Manual driving (no supervisor worker)

If you prefer to own the loop yourself, skip Step 2: on each wake run `COUNCIL
supervise --run <runDir> --advance`, repeat it while it prints `progress`, and
end your turn when it reaches `wait`, `needs_approval`, `finished`, or
`blocked`. Run `approve`/`cancel` as above — and after `approve`, the next
`advance` you run IS the wake; no mail nudge is needed because you are the
supervisor. The same ground rules apply: no poll loops, your own mailbox only.
Binding caveat, repeated from the ground rules: manual mode never runs
`run-use`, but the first `advance` on a run with no child Run yet creates it
and binds you to it — restore your prior binding afterwards if you had one.

## Honest boundaries (do not over-promise)

- Reviewer edit bans, "no peer mail/reads", and egress limits are
  **cooperative** prompt-level rules, not sandbox guarantees. The run verifies
  drift afterwards (snapshot re-hash detects files changed — never who changed
  them); it cannot prevent a determined worker or observe reads/egress.
- No Orca MCP server or native plugin is involved — none exists for this on
  Orca 1.4.261; do not promise one.
- The product never installs this skill, changes permissions, or edits global
  config; all permission posture is chosen explicitly per launch and recorded in
  the approval.
- Live validation status: module and acceptance tests pass; the reduced live
  smoke (10 perspectives / 2 reviewers) is **pending** — the supervisor-recovery
  path (child-Run rebind + one task reconciliation) was exercised live against
  a real crashed-supervisor run, but no end-to-end run has finished yet
  (docs/ORCA-COMPATIBILITY.md §7). Do not claim an end-to-end live run until
  it records real receipts.
- `council` commands here are the implemented CLI; `docs/USAGE.md` is the
  authoritative reference (flags, artifact paths, config keys).
