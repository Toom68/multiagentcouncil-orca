# Using Multiagent Council

Multiagent Council gives a primary orchestrator one practical way to request
diverse, critical feedback on a project, plan, or codebase. An organiser proposes
10–25 distinct review perspectives; you approve the exact roster, agents, models,
and budgets; reviewers inspect a pinned snapshot of the target independently;
they exchange bounded, evidence-bearing challenges; and a separate scribe returns
a prioritised report with dissent, confidence, and citations preserved.

This document describes the implemented `council` CLI (`src/cli.ts`) against the
approved design in `docs/design/IMPLEMENTATION.md`. Every command below exists
and is covered by `test/cli.test.ts` / `test/acceptance.test.ts`.

## Requirements

- Node.js ≥ 22 and npm. The supported CI matrix is Node **22.x and 24.x** on
  Linux (`.github/workflows/ci.yml`); development validation ran on Windows
  against Node 26.7.0 — check the repository's Actions page for current CI
  status rather than assuming green.
- A running Orca (the council is Orca-first; the core protocol is host-agnostic
  behind `src/host/` for later adapters). The adapter surface in
  `docs/ORCA-COMPATIBILITY.md` was verified against Orca **1.4.261** on Windows.
- Agent CLIs only if you launch real workers: the default — and the only
  allowlisted and live-validated lane so far — is Devin CLI with model
  `swe-2-max`. Other Orca agent ids (`claude`, `codex`, …) need an explicit
  launch policy in `src/host/orca.ts` and are unverified. Paid `*-lightning`
  variants and automatic model fallbacks are never selected.
- No MCP server, no native Orca plugin, no global config or permission changes
  are required or performed. The product does not install its own skill.

## Build and invoke

```sh
npm install
npm run build
npm test
```

Run the CLI as `node dist/src/cli.js <command>` from this checkout — the
package `bin` maps `council` to `dist/src/cli.js` (see `package.json`). All
commands accept `--json`; agent callers should prefer it. `council help` (or no
arguments) prints the command list.

### Running it on another project

There is nothing to install or register — no Orca plugin, no MCP server, no
global writes. From the workspace you want reviewed:

1. Clone and build this repository anywhere (e.g. `npm install && npm run
   build`), then note the absolute path to `dist/src/cli.js`.
2. Invoke it by absolute path **from the target workspace** —
   `node <checkout>/dist/src/cli.js init --objective "..." --json` — because
   the Orca context comes from the caller's working directory and the run
   directory is created under that target's `.council/` tree.
3. Tell the supervising agent to read `<checkout>/skills/council/SKILL.md` by
   absolute path; it contains the exact command loop it must run.

A `council` command on `PATH` is optional: a user may run `npm link` in this
checkout themselves if they want one — nothing does it automatically, and no
Orca skill/plugin registration is required or attempted.

## The run directory

Every run lives under `<target>/.council/runs/<crun_id>/` (the `.council/` tree
is git-ignored; set `COUNCIL_HOME` to relocate it):

```
council.json            # immutable run identity {runId, target, snapshotId, createdAt}
state.json              # mutable CouncilState: status, participants, budgets, supervisor identity
events.jsonl            # append-only journal — the durable record of every decision
objective.md            # the review objective verbatim
snapshot.json           # {snapshotId, gitHead, headHash, files: path→sha256} of the target
meta.json               # tool/node/platform versions + launchBudgetFloor — for reproducibility
prompts/supervisor.md   # the generated supervisor spec (written by init)
specs/<attemptId>.md    # the exact spec file each worker attempt received

organiser/roster.proposed.json   # the organiser worker's raw output
roster.proposed.json    # the validated, persisted proposal (what you review)
roster.approved.json    # YOUR selected seats + explicit agent/model/permission choices
approval.json           # the persisted approval record + binding payload (hash-bound)

findings/<pid>.json                     # each reviewer's independent findings
claims.json                             # the canonical claim ledger (grades, statuses,
                                        #  evidence, provenance, dissent, history)
rounds/<n>/envelopes/challenge/<pid>.json   # per-recipient challenge envelope (only
rounds/<n>/envelopes/response/<pid>.json    #  input a discussion worker may read)
rounds/<n>/challenges/<pid>.json        # challenger outputs
rounds/<n>/responses/<pid>.json         # author rebuttals / revisions / withdrawals

scribe/notes.json                       # initial scribe notes over admitted findings
scribe/report.json|report.md|summary.md # the scribe's raw synthesis outputs
report.json, report.md, summary.md      # the canonical final report artifacts
```

Nothing under the run directory requires the reviewed project to be modified.
Reviewer read-only behavior is a **cooperative prompt rule**, not a sandbox —
the snapshot re-hash performed during the run detects that files changed; it
cannot prevent the change and cannot say who changed it.

## Commands

### `council init` — create a run

```text
council init --objective <file> --target <path> [--config <file>] --json
```

Creates the run directory, snapshots the target (git HEAD plus a per-file hash
manifest), resolves and validates the config, writes `meta.json` (including
`launchBudgetFloor`, the minimum launches this config needs), and emits
`prompts/supervisor.md` plus the exact `advanceCommand` the supervisor runs.

The full brief is preserved in council artifacts, prompts and the approval
binding. Only a bounded descriptive label is sent to Orca's shorter Run
objective field; a multi-kilobyte review brief does not need to be shortened
to fit that host metadata limit.

### `council doctor` — environment check

```text
council doctor --json
```

Reports each check as `verified` / `missing` / `failed`: Node ≥ 22, the `orca`
executable (`ORCA_CLI_COMMAND` or `orca` on PATH) plus a live `orca status
--json` call, `devin` (required for the default lane), and `claude`/`codex`
(optional). Prints `ready` when every required check verifies; missing optional
agent CLIs only narrow roster choices.

### `council start-supervisor` — launch the dedicated supervisor worker

```text
council start-supervisor --run <runDir> [--wait-ms <n>] --json
```

Creates the supervisor's Orca Task from `prompts/supervisor.md`, opens a
terminal running the pinned lane `devin --model swe-2-max --permission-mode
dangerous`, waits for the agent's prompt (`terminal wait --for tui-idle`,
`--wait-ms` bounds it, default 60 s, range 1 000–600 000), then `worker-start`s
the Task on that terminal and persists the supervisor's
`{terminalHandle, dispatchId}` into `state.json` so `council approve` can
address its wake. The worker command string is built only from fixed
allowlisted tokens — nothing user-supplied ever becomes shell syntax.

The idle wait is followed by a `terminal show` check of the exact terminal,
connection, expected agent identity and explicit absence of an agent prompt.
A trust or permission screen pauses setup; it is never accepted automatically.
JSON callers must check `outcome`/`supervisorStarted`: a successful command can
report `outcome:"paused"`, `supervisorStarted:false`, `needsAttention:true`,
the existing Task/terminal IDs, and recovery instructions. It has not launched
a supervisor in that case.

`supervisor/startup.json` records startup intent, spec hash, caller binding,
resource IDs and known request IDs under the run lock. After resolving a
readiness prompt, rerun the same `start-supervisor --run` command to reuse the
recorded resources. An unconfirmed issued attach blocks reruns until reconciled;
it never creates a replacement on a missing receipt. Changed binding, malformed
custody records or an already recorded supervisor also refuse a second launch.

The supervisor Task attaches to the caller's **bound** Orca Run (your existing
binding is preserved, never rebound). When the caller has no bound Run — e.g.
a first-time `init` followed directly by `start-supervisor` — the documented
`worker-start --spec-file` path creates or joins a Run implicitly instead of
failing. Either way the response reports `callerRun` and `lane` honestly.

### `council supervise --advance` — one deterministic step

```text
council supervise --run <runDir> --advance [--as-supervisor] --json
```

The heart of the product. Each call reconciles persisted state against Orca
(tasks, workers, artifacts) and performs bounded work, then prints
`{state, action, note, nextHint}`:

| `action` | meaning |
|---|---|
| `progress` | one bounded step ran — run `advance` again immediately in the same turn |
| `wait` | nothing to do — end the turn and wait for an Orca wake |
| `needs_approval` | roster is ready; the supervisor mails the caller the approval summary |
| `finished` | run reached a terminal outcome; report the printed `outcome`/`reportPaths` |
| `blocked` | unrecoverable condition needing an orchestrator decision (a persisted no-task intent is resolved by `council reconcile` — below) |

It is idempotent and safe to re-run — including after a crash — because it always
reconciles before acting. There is no daemon: deadlines are evaluated inside
`advance` calls. **Important:** a `progress` result means more local work exists
right now; the calling agent must keep advancing until a non-`progress` action,
because no external event will arrive to wake a purely local transition.
`--advance` is required; bare `supervise` is a usage error.

**`--as-supervisor` — the dedicated supervisor's mode.** The generated
`advanceCommand` in `prompts/supervisor.md` includes it. In this mode the CLI
requires an Orca terminal identity (`ORCA_TERMINAL_HANDLE`), refuses to run if
a *different* supervisor terminal is recorded in `state.json`, and binds the
caller to the persisted council child Run before advancing: `run-current` →
`run-use --id <run> --from <handle>` → verified `run-current`. This repairs the
crash case where the child Run stayed bound to a vanished terminal — Orca
refuses task-create for any caller not bound to that Run. The flag exists only
for the dedicated supervisor. In **manual** mode the CLI never issues
`run-use` (it never rebinds you to an existing Run) and never displaces a
recorded supervisor's identity — but it is not binding-neutral in one case:
when a run has no child Orca Run yet, the first `advance` creates one and the
host binds **you** to it, displacing whatever Run you were bound to before.
If you are manually driving a fresh run while bound to another Run, either
rebind back afterwards (`orca orchestration run-use --id <your-run> --from
<handle>`) or prefer a dedicated supervisor.

### `council reconcile` — resolve a persisted no-task launch intent

```text
council reconcile --run <runDir> --attempt <attemptId> \
  --confirm-no-effects <requestId> [--as-supervisor] --json
```

When a worker's task-create was **definitively refused** (Orca's refusal
carries an `Orchestration mutation request ID` and states "Nothing changed"),
the engine persists `intent_recorded` with `taskId/dispatchId/terminalHandle`
all null and refuses to retry on its own — the durable guard against
double-launch. `reconcile` is the explicit, evidence-based way through. The
whole transaction — state read, journal check, binding, request probe,
task-list, adopt-or-create, persist — runs under the run's file lock, so two
concurrent reconciles on one attempt can never both create a task: the second
blocks, re-reads, and refuses on the persisted `taskId`.

1. `--confirm-no-effects` must name the **exact request id** journaled on the
   recorded `task-create` failure for that attempt (see `council tail`). A
   journaled failure with no request id refuses outright — there is nothing
   to confirm against.
2. With `--as-supervisor` the caller is bound to the child Run first (same
   rules as `supervise --advance --as-supervisor`); otherwise your current
   binding is used as-is.
3. `task-list --full` is inspected for a task carrying this attempt's exact
   spec (`specs/<attemptId>.md`): a unique match is **adopted** — safe even
   when the failure's outcome is uncertain, because adopting an existing task
   creates nothing.
4. **Zero matches permits `create` only under a verified definitive refusal**:
   the journaled refusal text explicitly states no change was applied ("Nothing
   changed"), carries an explicit `effects: "none"` marker, or the request
   ledger reports the mutation `refused`/`rejected`. A timeout, connection
   loss, or any other generic failure — even with a matching request id and
   confirmation — refuses the create path: such a failure can leave a live
   task behind. A malformed or incomplete `task-list` receipt (no task array,
   non-object or unidentifiable rows) also refuses rather than counting as
   zero tasks.
5. The resolved `taskId` plus a journaled `task.created` event are persisted
   before any launch; the next `supervise --advance` launches the worker on it.

Any ambiguity refuses rather than guesses: multiple matching tasks, a pending
or completed-but-absent request, a missing spec artifact, a missing/mismatched
request id, an unreadable task ledger, or an attempt that is not a null-task
intent. Nothing is ever reset, erased, or retried blindly.

### `council approve` — the enforceable gate

```text
council approve --run <runDir> --roster <file> [--note "<text>"] --json
```

Validates your `roster.approved.json` (exactly `config.participants` seats, each
selecting one proposed `perspectiveId` with unique `seatId`/`participantId` and
an explicit `agent`/`model`/`permissionMode`), then persists `approval.json`:
a record whose `hash` is SHA-256 over the canonical binding
`{runId, objective, seats, proposedRosterHash, config, snapshotId,
snapshotHeadHash}` — so the approval is bound to the exact proposed roster as
well as your seat selection, the config, and the pinned source. Reviewers
launch only while a valid approval exists. Any drift — edited objective,
changed roster or config, or a changed target tree — invalidates it and blocks
launches until you approve again; a mid-run invalidation must be cured by
re-approving the *exact same* seats/agents, not a new roster (start a new run
to change seats).

**Waking the supervisor.** `Engine.approve` emits a bounded approval-wake
notification through the host adapter — addressed to the bound council child
Run (`run:<id>`, or the supervisor terminal when no run is bound) and carrying
the supervisor's dispatch id — journaled as `mail.sent` with
`kind: "approval-wake"`. Independently, `council approve` prints an explicit
`wakeCommand` (an `orca orchestration send --to dispatch:<supervisorDispatchId>`
nudge) — **send it**: a file write alone is never an Orca wake. When you drive
`advance` manually there is no separate supervisor — your next call is the
wake.

### `council status` — observability

```text
council status --run <runDir> --json
```

Prints the run status, per-participant status and active attempt, consumption
(`launches` vs `maxLaunches`, `mailSent`), `approvalHash`, quorum position
(settled reviewers vs `ceil(quorumRatio × seats)`), and `pendingDecisions`
(e.g. re-approve after invalidation, reconcile an `unknown` attempt — never
relaunch). Read-only.

### `council tail` — journal inspection

```text
council tail --run <runDir> [--lines <n>] --json
```

Prints the last `n` journal events from `events.jsonl` (default 20, range
1–1000). Read-only; the journal is the durable record, not a replay engine.

### `council verify` — integrity check

```text
council verify --run <runDir> --json
```

Reports integrity only: re-hashes the live target against `snapshot.json`
(drift + changed paths) and recomputes the approval binding hash against
`approval.json` (`bindingIntact`, `matchesStateHash`). `verified: true` means
no drift and an intact approval — it is **not** a proof of truth of findings,
and it never executes or validates cited code. A drifted tree or mismatched
binding means re-snapshot and re-approve before any launch.

### `council cancel` — explicit cancellation

```text
council cancel --run <runDir> [--reason "<text>"] --json
```

Guarded `requestStop` per live attempt (including `timed_out` ones — a deadline
mark is not proof of death), requests release of settled retained terminals, marks the run
`cancelled`, and reports `confirmedStopped` vs `unverifiable` attempts. A
worker that never reported is inspected, never assumed dead.

Orca may keep user-retained or unreclaimable sessions open. Cleanup respects
that decision: `released:false` means release was not confirmed; it does not
prove process exit. Only an explicit stopped result confirms cancellation.
Inspect the journal and host receipt for unresolved resources; never force-close
them to make a run appear clean.

## Configuration

`--config <file>` at `init` overrides these defaults; the resolved config is
persisted, hashed into the approval binding, and journaled. Unknown keys are
ignored; invalid values are refused. Enforcement is split honestly: limits the
runner physically controls (concurrency, launches, rounds, envelope bytes,
forwarded mail, findings/challenge/response caps at ingest, deadlines) are
enforced by the CLI; limits inside a worker's own session (token/tool use,
network egress) are cooperative prompt rules — the runner cannot observe them,
only cap and validate outputs afterwards.

| key | default | meaning |
|---|---|---|
| `requestedPerspectives` | 15 (valid 10–25) | how many perspectives the organiser must propose |
| `participants` | 15 (≤ `requestedPerspectives`) | reviewer seats selected from the proposal |
| `concurrency` | 5 | launch window — cost rate, not coverage |
| `rounds` | 1 (valid 1–3) | bounded challenge+response rounds |
| `quorumRatio` | 0.67 ((0,1]) | fraction of seats that must settle for a phase to close with partial coverage |
| `maxLaunches` | `minViable + 8` | hard cap on total worker launches; the floor is `minViableLaunches = participants + 2·participants·rounds + 3`: organiser (1) + independent reviews + scribe notes (1) + challenge and response launches per seat per round + scribe synthesis (1); retries consume it too — an explicit value below the floor is refused |
| `maxFindingsPerSeat` | 7 | findings cap per reviewer — forces prioritisation |
| `maxChallengesPerSeatPerRound` | 3 | per-seat per-round challenge cap |
| `maxResponsesPerSeatPerRound` | 3 | per-seat per-round author-response cap |
| `envelopeBytes` | 8192 | per-recipient work-envelope byte cap (complete entries are trimmed visibly; JSON is never cut mid-token) |
| `maxMailPerParticipant` | 6 | per-seat runner-originated mail cap |
| `maxTextChars` | 4000 | cap on any single free-text field in worker output |
| `deadlines` | object below | per-phase wall-clock limits in ms, checked inside `advance` (never real-time) |

`deadlines` defaults: `organiserMs` 30 min, `independentMs` 4 h,
`scribeNotesMs` 1 h, `challengeMs` 2 h, `responseMs` 2 h, `synthesisMs` 2 h,
`runMs` 24 h (whole run), `graceMs` 30 min. Each accepts 1 000 ms – 7 days.

With `participants=15` and `rounds=1` the launch floor is `15 + 30 + 3 = 48`,
so the default `maxLaunches` is 56; with `rounds=3` the floor is
`15 + 90 + 3 = 108`. Set `participants`/`rounds` lower to shrink the floor —
e.g. the reduced smoke config is `requestedPerspectives=10`, `participants=2`.

## Flow recap for the calling agent

1. `init` → `start-supervisor` (which runs the pinned
   `devin --model swe-2-max --permission-mode dangerous` lane and records the
   supervisor's dispatch) — or drive `supervise --advance` yourself per wake.
   With a dedicated supervisor your Orca Run binding stays untouched; the
   council lives in a separate child Run the engine creates on the first
   advance. If you drive `advance` manually on a run that has no child Run
   yet, the host binds **you** to the child Run it creates — see the manual
   mode note under `supervise --advance` above.
2. Wait for the supervisor's `needs_approval` mail; review
   `roster.proposed.json`; write `roster.approved.json`; run `approve`; then
   send the printed `send --to dispatch:<id>` nudge so the supervisor's next
   `advance` sees the approval (the engine also emits a journaled
   approval-wake notification — the explicit nudge is the reliable wake).
3. Wait; `status` and `tail` are read-only and safe any time.
4. Read `report.md` / `report.json` when the supervisor reports `finished`.
   Partial results are visibly marked partial; a wholly failed run emits no
   successful-looking report.

`skills/council/SKILL.md` carries the same recipe in agent-loadable form with
full Orca command syntax, mail-consumption rules, cancellation, and uncertain-
outcome recovery.

## What the council does NOT do

- Does not let reviewers edit the reviewed project — a prompt-level
  (*cooperative*) rule. Snapshot re-hash detects that files changed; it does
  not prevent edits and does not attribute them to a specific worker.
- Does not observe or prevent worker network egress or file reads — also
  cooperative prompt rules; only admitted output is validated.
- Does not claim `verified_defect` from reviewer output: in v1 the ledger caps
  reviewer-derived grades at `plausible_risk`; a matching citation or repeated
  agreement never upgrades a claim.
- Does not replay or rebuild state: `events.jsonl` is a durable, hash-chained
  record for audit and reconciliation, not a state-replay engine.
- Does not install a skill, change permission posture, or touch global config;
  the user-facing "bypass" posture maps to Devin CLI `--permission-mode
  dangerous` at the adapter boundary — a separately approved product posture,
  not a silent default.
- Does not silently fall back to other or paid models; every seat's
  agent/model/permission is an explicit, approved, allowlisted choice — and
  only `devin`/`swe-2-max` is allowlisted by default or validated live.
- Does not produce automatic fixes or rerun-diff reports in this release.

## Validation status — honest ledger

- Module + acceptance tests (`npm test`) pass locally on Windows Node 26.7.0;
  the GitHub CI matrix runs the same suite on Linux Node 22.x/24.x.
- A **reduced live smoke completed the full protocol**: organiser → approval
  of 2 seats from 10 perspectives → independent reviews → one real peer
  challenge/response round → separate scribe → report, all on Devin
  `swe-2-max`. The report is partial because one independent output failed
  schema validation. Seven admitted claims covered the four fixture seeds,
  with dissent and missing coverage preserved. This is small-scale live
  validation; the 15-seat lifecycle is covered by fake-host tests, not a live
  load test. [VERIFICATION.md](VERIFICATION.md) records the evidence and the
  recovery/cleanup findings.
