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

### `council supervise --advance` — one deterministic step

```text
council supervise --run <runDir> --advance --json
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
| `blocked` | unrecoverable condition needing an orchestrator decision |

It is idempotent and safe to re-run — including after a crash — because it always
reconciles before acting. There is no daemon: deadlines are evaluated inside
`advance` calls. **Important:** a `progress` result means more local work exists
right now; the calling agent must keep advancing until a non-`progress` action,
because no external event will arrive to wake a purely local transition.
`--advance` is required; bare `supervise` is a usage error.

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
mark is not proof of death), releases retained terminals, marks the run
`cancelled`, and reports `confirmedStopped` vs `unverifiable` attempts. A
worker that never reported is inspected, never assumed dead.

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
   Your own Orca Run binding stays untouched; the council lives in a separate
   child Run the engine creates on the first advance.
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
- A **reduced live smoke** (organiser → approval → `requestedPerspectives=10`,
  `participants=2` reviewers → one challenge/response round → scribe, all on
  Devin `swe-2-max`) is the designed validation target and is **pending** — a
  first live run surfaced a settlement-detection stall in the host adapter
  (see `docs/ORCA-COMPATIBILITY.md` §7); record its real receipts before
  claiming live validation.
