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
- `COUNCIL` — the built CLI: `node dist/src/cli.js` in this checkout
  (`npm install && npm run build`; the package's `bin` maps `council` to
  `dist/src/cli.js`).

## Ground rules (read first)

- **Preserve your Run binding.** Record it once and always pass `--run` explicitly
  to orchestration commands you issue yourself. The council runs inside a child
  Run owned by the supervisor worker, so your own Run is never touched — and you
  never run `run-create`/`run-use` for the council yourself; binding a child Run
  is the supervisor's job. Re-run `run-current` after launching the supervisor to
  confirm your binding is unchanged.
- **Only an agent consumes its own mail.** Plain `check`/`--ack` on a mailbox
  marks mail handled and hides it from the agent that owns it. The supervisor's
  `council` CLI only ever uses `check --peek` / `inbox`. You may run consuming
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

Writes `.council/runs/<crun_id>/` inside the target: `objective.md`,
`snapshot.json`, `state.json`, and `prompts/supervisor.md` — the generated
supervisor spec. `--config` overrides defaults (participants 15, concurrency 5,
rounds 1 of max 3, findings/reviewer 7, challenges/reviewer/round 3, envelope
8192 bytes, launch and wall-clock limits).

**Enforcement honesty:** budgets the runner physically forwards or launches —
concurrency, launches/phases, rounds, envelope bytes, per-recipient envelopes —
are enforced in the CLI. Budgets inside a worker's own session (token/tool use,
self-reported effort) are cooperative prompt rules the runner cannot observe;
over-budget sessions surface only through output caps and audits, never
prevention.

## Step 2 — launch the dedicated supervisor

The supervisor is a Devin `swe-2-max` worker that exists to carry a Dispatch
identity and receive wakes; it runs only `council supervise --advance`. Two
approved launch lanes:

**Default — custom argv lane (pins the model):**

```text
ORCA orchestration task-create --spec-file <runDir>/prompts/supervisor.md --task-title "Council supervisor" --json
ORCA terminal create --worktree active --title council-supervisor --command "devin --model swe-2-max" --json
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
COUNCIL supervise --run <runDir> --advance --json
```

`--advance` reconciles persisted state against Orca and prints one action:
`progress` (one bounded step ran), `wait`, `needs_approval`, `finished`, or
`blocked`. The discipline is: **keep running `advance` in the same turn while it
prints `progress` — each call is still one bounded, idempotent step — and stop
the turn only when it prints `wait`** (nothing left to do), `needs_approval`
(mail the caller), `finished` (send `worker_done` with the printed outcome and
`--report-path`), or `blocked`. This matters: a chain of purely local progress
steps emits no external event, so stopping after a single `progress` would
stall the run forever. Inside `advance` the CLI performs the child-Run binding,
organiser launch, reviewer fan-out with the concurrency window, per-recipient
challenge envelopes, scribe synthesis, deadline checks, and journal writes. The
supervisor agent makes no protocol decisions and never runs orchestration
mutations itself — the CLI does that through the host adapter.

## Step 4 — approval gate (the only gate that matters)

When the supervisor reports `needs_approval`, it mails you a roster summary and
the exact command. Before approving, READ the proposal:

```text
<runDir>/roster.proposed.json   # 10–25 perspectives, each with charter
                                # {incentives, expertise, method, blindSpots,
                                #  reviewQuestions[]}
```

Write your selection to `<runDir>/roster.approved.json`: a subset of the
proposed perspective ids, one per seat, each with an explicit
`{lane, agent, model}` — default lane `argv`, agent `devin`, model `swe-2-max`.
Then:

```text
COUNCIL approve --run <runDir> --roster <runDir>/roster.approved.json [--note "<why>"]
```

This writes `approval.json` binding `sha256(canonical({objective, approved
roster, config, snapshot}))`. Reviewers cannot launch before it exists. Any
later change to the objective, selection, config, or the target tree itself
(re-hashed at launch) invalidates the approval and returns the run to
`awaiting_approval` — approve again explicitly. There is no soft approval.

**Approval is two actions, not one.** Writing `approval.json` changes files but
wakes nobody — the supervisor is idle waiting for mail. After `council approve`
succeeds, explicitly wake it:

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
- Evidence: citation re-resolution against the recorded snapshot happens inside
  `advance` at the report barrier and is journaled in `events.jsonl`; a matching
  citation alone never upgrades a claim to `verified_defect` — that grade needs
  captured reproduction or a contradiction validated by another participant.

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

## Manual driving (no supervisor worker)

If you prefer to own the loop yourself, skip Step 2: on each wake run `COUNCIL
supervise --run <runDir> --advance`, repeat it while it prints `progress`, and
end your turn when it reaches `wait`, `needs_approval`, `finished`, or
`blocked`. Run `approve`/`cancel` as above — and after `approve`, the next
`advance` you run IS the wake; no mail nudge is needed because you are the
supervisor. The same ground rules apply: no poll loops, your own mailbox only.

## Honest boundaries (do not over-promise)

- Reviewer edit bans, "no external communication", and egress limits are
  **cooperative** prompt-level rules, not sandbox guarantees. The run verifies
  drift afterwards (snapshot re-hash); it cannot prevent a determined worker.
- No Orca MCP server or native plugin is involved — none exists for this on
  Orca 1.4.261; do not promise one.
- The product never installs this skill, changes permissions, or edits global
  config; all permission posture is chosen explicitly per launch and recorded in
  the approval.
- `council` command names here reflect the approved design in
  `docs/design/IMPLEMENTATION.md`; `docs/USAGE.md` marks which are already
  implemented in the current build.
