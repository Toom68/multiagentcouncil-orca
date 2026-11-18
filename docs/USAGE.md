# Using Multiagent Council

Multiagent Council gives a primary orchestrator one practical way to request
diverse, critical feedback on a project, plan, or codebase. An organiser proposes
10–25 distinct review perspectives; you approve the exact roster, agents, models,
and budgets; reviewers inspect a pinned snapshot of the target independently;
they exchange bounded, evidence-bearing challenges; and a separate scribe returns
a prioritised report with dissent, confidence, and citations preserved.

This document describes the **approved CLI-first design**
(`docs/design/IMPLEMENTATION.md`). The `council` CLI is being implemented now;
until `src/cli.ts` lands, **every command below is `[planned]`** — each is
marked individually so this document is never read as a claim that it already
runs.

## Requirements

- Node.js ≥ 22 and npm.
- A running Orca (the council is Orca-first; the core protocol is host-agnostic
  for later Claude/Codex adapters). Verified against Orca `1.4.261` on Windows.
- Agent CLIs only if you launch real workers: the default and only confirmed-free
  lane is Devin CLI with model `swe-2-max`. Paid `*-lightning` variants and
  automatic model fallbacks are never selected by the council.
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
commands accept `--json`; agent callers should prefer it.

## The run directory

Every run lives under `<target>/.council/runs/<crun_id>/` (the `.council/` tree
is git-ignored; set `COUNCIL_HOME` to relocate it):

```
council.json            # ids, target, config, snapshotId, orcaRunId
state.json              # status + per-participant status
events.jsonl            # append-only journal — the source of truth
objective.md            # the review objective verbatim
snapshot.json           # {id, gitHead, files: path→sha256} of the target
roster.proposed.json    # organiser output (schema-validated)
roster.approved.json    # YOUR selected seats + launch lanes + models
approval.json           # the persisted approval record (hash-bound)
participants.json       # participantId ↔ taskId ↔ dispatchId ↔ lane/agent/model
prompts/<role>-<id>.md  # the exact spec each worker received
findings/<pid>.json     # each reviewer's independent findings
claims.json             # the claim ledger (statuses, grades, dissent, history)
rounds/<n>/outbox/<pid>.json     # per-recipient challenge envelope
rounds/<n>/responses/<pid>.json  # rebuttals / revisions / withdrawals
report.json, report.md  # the scribe's synthesis
summary.md              # the scribe's one-page executive summary
meta.json               # versions, models, timings — for reproducibility
```

Nothing under the run directory requires the reviewed project to be modified.
Reviewer read-only behavior is a **cooperative prompt rule**, not a sandbox —
the snapshot re-hash performed during the run detects violations after the
fact; it cannot prevent them.

## Commands

### `council init` — create a run — `[planned]`

```text
council init --objective <file> --target <path> [--config <file>] --json
```

Creates the run directory, writes the objective, snapshots the target (git HEAD
plus a per-file hash manifest), and emits `prompts/supervisor.md`.

### `council doctor` — environment check — `[planned]`

```text
council doctor --json
```

Verifies Node, Orca connectivity and version, the `orca` executable resolution,
agent CLIs on PATH, and reports each capability as verified or missing.

### `council supervise --advance` — one deterministic step — `[planned]`

```text
council supervise --run <runDir> --advance --json
```

The heart of the product. Each call reconciles persisted state against Orca
(tasks, workers, mail, artifacts) and performs at most one bounded action, then
prints `{state, action, note}`:

| `action` | meaning |
|---|---|
| `progress` | one bounded step ran — run `advance` again immediately in the same turn |
| `wait` | nothing to do — end the turn and wait for an Orca wake |
| `needs_approval` | roster is ready; the supervisor mails the caller the approval summary |
| `finished` | run reached `completed`/`failed`/`cancelled`; report the printed outcome |
| `blocked` | unrecoverable condition needing a human decision |

It is idempotent and safe to re-run — including after a crash — because it always
reconciles before acting. There is no daemon: deadlines are evaluated inside
`advance` calls. **Important:** a `progress` result means more local work exists
right now; the calling agent must keep advancing until a non-`progress` action,
because no external event will arrive to wake a purely local transition.

### `council approve` — the enforceable gate — `[planned]`

```text
council approve --run <runDir> --roster <file> [--note "<text>"] --json
```

Writes `approval.json` binding a SHA-256 over `{objective, approved roster,
config, snapshotId}`. Reviewers launch only while a valid approval exists. Any
drift — edited objective, changed selection or seat assignments, modified config,
or a changed target tree — invalidates the approval and blocks launch until you
approve again. The roster file must select proposed perspective ids only (one
per seat, no duplicates); seat count defaults to 15 and cannot exceed the number
of proposed perspectives.

**Approving does not wake the supervisor by itself.** After `approve` succeeds,
send the supervisor worker a nudge so its next `advance` sees the file:

```text
orca orchestration send --to dispatch:<supervisorDispatchId> --subject "approval recorded" --body "approval.json written; run council supervise --advance"
```

(When you drive `advance` manually there is no separate supervisor — your next
call is the wake.)

### `council status` — observability — `[planned]`

```text
council status --run <runDir> --json
```

Prints the phase, per-seat health, budget consumption, and quorum position.
Read-only. The full journal is `events.jsonl` in the run directory.

### `council cancel` — explicit cancellation — `[planned]`

```text
council cancel --run <runDir> --json
```

Guarded stop of every live participant (fenced Dispatches), marks the run
`cancelled`, and reports confirmed vs unverifiable stops. A worker that never
reported is inspected, never assumed dead.

## Configuration

`--config <file>` at `init` overrides these defaults; every value is journaled.
Enforcement is split honestly: limits the runner physically controls
(concurrency, launches, rounds, envelope bytes, forwarded mail, findings caps at
ingest, deadlines) are enforced by the CLI; limits inside a worker's own session
(token/tool use) are cooperative prompt rules — the runner cannot observe them,
only cap outputs and audit afterwards.

| key | default | meaning |
|---|---|---|
| `perspectives` | 15 (valid 10–25) | how many perspectives the organiser must propose |
| `participants` | 15 | reviewer seats; ≤ perspectives proposed |
| `maxConcurrentWorkers` | 5 | launch window — cost rate, not coverage |
| `maxLaunches` | default = workflow minimum + slack | floor is `minViableLaunches = participants + 2·participants·rounds + 3`: organiser (1) + independent reviews (participants) + scribe notes (1) + challenge and response launches per seat per round (2·participants·rounds) + scribe synthesis (1); retries consume it too — an explicit value below the floor is refused |
| `maxRounds` | 3 (start 1) | bounded challenge rounds |
| `maxChallengesPerReviewerPerRound` | 3 | per-seat discussion cap |
| `envelopeBytes` | 8192 | per-recipient challenge envelope cap |
| `maxFindingsPerReviewer` | 7 | forces prioritisation |
| `maxMailPerParticipant` | 6 | per-seat forwarded-mail cap (relay drops the excess) |
| `organiserDeadlineMs`, `independentDeadlineMs`, `roundDeadlineMs`, `scribeDeadlineMs`, `runDeadlineMs`, `graceMs` | — | phase and run deadlines, checked inside `advance` |
| `quorumRatio` | 0.67 | minimum settled seats to proceed past a deadline |

With participants 15 and rounds 3 the floor is `15 + 90 + 3 = 108` — enough for
the organiser, 15 independent reviews, scribe notes, three challenge+response
rounds per seat, and the final synthesis. Set it lower only with fewer
participants or rounds.

## Flow recap for the calling agent

1. `init` → launch the supervisor worker (`terminal create --command "devin
   --model swe-2-max"` + `worker-start --terminal`) with
   `prompts/supervisor.md` as its spec — or drive `advance` yourself per wake.
   Your own Orca Run binding stays untouched; the council lives in the
   supervisor's child Run.
2. Wait for `needs_approval` mail; review `roster.proposed.json`; write
   `roster.approved.json`; run `approve`; then nudge the supervisor via
   `send --to dispatch:<id>` so its next `advance` sees the approval.
3. Wait; check `status` whenever curious.
4. Read `report.md` / `report.json` when the supervisor reports `finished`.
   Partial results are visibly marked partial; a failed run never emits a
   successful-looking report.

`skills/council/SKILL.md` carries the same recipe in agent-loadable form with
full Orca command syntax, mail-consumption rules, cancellation, and uncertain-
outcome recovery.

## What the council does NOT do

- Does not let reviewers edit the reviewed project (prompt-level rule; the
  snapshot detects drift, it does not prevent it — labelled *cooperative*).
- Does not restrict worker network egress — not promised in v1.
- Does not install a skill, change permission posture, or touch global config.
- Does not silently fall back to other or paid models; every seat's agent/model
  is an explicit, approved choice.
- Does not produce automatic fixes or rerun-diff reports in this release.
