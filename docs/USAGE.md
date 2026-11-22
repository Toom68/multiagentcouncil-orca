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
  Linux and Windows (`.github/workflows/ci.yml`); development validation ran
  on Windows against Node 26.7.0 — check the repository's Actions page for
  current CI status rather than assuming green.
- A running Orca (the council is Orca-first; the core protocol is host-agnostic
  behind `src/host/` for later adapters). The adapter surface in
  `docs/ORCA-COMPATIBILITY.md` was verified against Orca **1.4.261** on Windows.
- Agent CLIs only for the lanes you actually select. The shipped launch
  catalog (`src/catalog.ts`, `council catalog --json`) documents `devin`,
  `claude`, and `codex` argv lanes with fixed permission/effort/profile
  mappings; `devin` has run live councils (with `swe-2-max` and
  Devin-hosted Claude Opus) and `codex` has completed a reviewer seat in a
  mixed-provider live council — the `claude` CLI lane remains help-verified
  only. Paid `*-lightning` variants
  and automatic model fallbacks are never selected, and an unavailable
  choice fails visibly — never a substitute.
- No MCP server, no native Orca plugin, no global config or permission changes
  are required or performed. The optional `scripts/install.mjs` installer
  copies the agent skill and records only the runtime path — see
  [AI-INSTALL.md](AI-INSTALL.md).

## Build and invoke

```sh
npm install
npm run build
npm test
```

Ready-made config/roster templates with placeholder staff and seat choices
ship under `skills/council/references/templates/` — see
[Configuration](#configuration) below. Run the CLI as `node dist/src/cli.js <command>` from this checkout — the
package `bin` maps `council` to `dist/src/cli.js` (see `package.json`). All
commands accept `--json`; agent callers should prefer it. `council help`, no
arguments, or `<command> --help` prints the command list.

### Running it on another project

Two supported paths; neither registers an Orca plugin, MCP server, or global
config:

1. **Install-once skill (recommended for agents).** From a built checkout,
   `node scripts/install.mjs` copies `skills/council/` into the user skill
   dirs (`~/.agents/skills/council`, `~/.claude/skills/council`) and records
   the built CLI in a managed pointer; `--project <dir>` scopes the install
   to one project instead. Agents then invoke the bundled locator
   `node <SKILL_DIR>/scripts/council.mjs <command>` from the workspace being
   reviewed — no checkout path to paste. `COUNCIL_CLI` overrides resolution
   explicitly. Full agent-facing guide, dry-run/inspection, conflict and
   preservation rules: [AI-INSTALL.md](AI-INSTALL.md).
2. **Direct invocation.** Invoke the built CLI by absolute path **from the
   target workspace** — `node <checkout>/dist/src/cli.js init ...` — because
   the Orca context comes from the caller's working directory and the run
   lands under that target's `.council/` tree. Tell the supervising agent to
   read `<checkout>/skills/council/SKILL.md` by absolute path.

A `council` command on `PATH` is optional: a user may run `npm link` in this
checkout themselves if they want one — nothing does it automatically, and no
Orca skill/plugin registration is required or attempted.

## The run directory

Every run lives under `<target>/.council/runs/<crun_id>/` (the `.council/` tree
is git-ignored; set `COUNCIL_HOME` to relocate it):

```
council.json            # immutable run identity {runId, target, snapshotId, createdAt}
state.json              # mutable CouncilState: status, participants, budgets, supervisor identity
events.jsonl            # append-only journal — the durable record of every decision;
                        #  a receipts-v1 run's first event is run.initialized at seq 1
                        #  {runId, snapshotId, integrity:'receipts-v1'} — legacy runs
                        #  have no marker and stay honestly untracked (never upgraded
                        #  or downgraded by hand)
objective.md            # the review objective verbatim
snapshot.json           # {snapshotId, gitHead, headHash, files: path→sha256} of the target
meta.json               # tool/node/platform versions + launchBudgetFloor — for reproducibility
prompts/supervisor.md   # the generated supervisor spec (written by init)
specs/<attemptId>.md    # the exact spec file each worker attempt received
supervisor/startup.json # supervisor startup custody record (ids, issued markers,
                        #  pause reasons) — also the cleanup custody source;
                        #  retired records archive under supervisor/retired/

organiser/roster.proposed.json   # the organiser worker's raw output
roster.proposed.json    # the validated, persisted proposal (what you review)
roster.approved.json    # YOUR selected seats + explicit agent/model/permission choices
approval.json           # the persisted approval record + binding payload (hash-bound)

findings/<pid>.json                     # each reviewer's independent findings
                                        #  (findings[] + optional bounded strengths[])
claims.json                             # the canonical claim ledger (grades, statuses,
                                        #  evidence, provenance, dissent, history,
                                        #  canonical strengths, discussion routing)
rounds/<n>/envelopes/challenge/<pid>.json   # per-recipient challenge envelope (only
rounds/<n>/envelopes/response/<pid>.json    #  input a discussion worker may read)
rounds/<n>/challenges/<pid>.json        # challenger outputs
rounds/<n>/responses/<pid>.json         # author rebuttals / revisions / withdrawals

scribe/notes.json                       # initial scribe notes over admitted findings
scribe/report.json                     # scribe narrative (SynthesisFile); legacy full reports accepted
rejected/                              # preserved rejected output and complete validation diagnostics
report.json, report.md, summary.md      # the canonical final report artifacts

progress/recipient.json                 # the persisted stage-wake recipient {to, source, recordedAt}
progress/outbox.json                    # durable dedupe/delivery receipts for stage notices
progress/outbox.init                    # prior-use witness: written once after the first
                                        #  durable outbox write — an outbox missing while
                                        #  this exists means custody was deleted post-use
progress/outbox.lock                    # the outbox's own O_EXCL lock (never the Store lock)
progress/helper.lease, helper.json      # the bounded progress helper's lease + diagnostics
```

Nothing under the run directory requires the reviewed project to be modified.
Reviewer read-only behavior is a **cooperative prompt rule**, not a sandbox —
the snapshot re-hash performed during the run detects that files changed; it
cannot prevent the change and cannot say who changed it. The `.council` and
`.council-dev` trees are themselves **excluded** from the snapshot manifest:
run artifacts are managed and validated by the runner, but they are not
drift-protected and are never part of the reviewed corpus.

## Commands

### `council init` — create a run

```text
council init --objective <file> --target <path> --config <file> [--notify <target>] --json
```

Creates the run directory, snapshots the target (git HEAD plus a per-file hash
manifest), resolves and validates the config, writes `meta.json` (including
`launchBudgetFloor`, the minimum launches this config needs), and emits
`prompts/supervisor.md` plus the exact `advanceCommand` the supervisor runs.
It also captures the **progress-wake recipient** — the initiating
orchestrator's mail target — into `progress/recipient.json` BEFORE any
supervisor binding exists, so stage notices keep reaching you even if the
supervisor identity later changes (see "Progress wakes" below).
`--notify <target>` records an explicit mail target instead of the
caller-derived one; `start-supervisor --notify` does the same before its
binding work, and the first durable target wins thereafter.

**Fresh runs require an explicit, complete staff.** `--config` must carry
`staff.organiser`, `staff.scribe`, and `staff.supervisor` — each an
AgentChoice `{agent, model, permissionMode, effort?, profile?}` validated
against the shipped catalog *before* any run state is created (the roster
gate cannot authorize staff work retroactively). A staff-less config is
refused. `init` also captures the catalog execution fingerprint
(`execution.catalogVersion`, `execution.policyHash`) into the config — a
config-supplied fingerprint must match the shipped catalog exactly — so a
later catalog change blocks launches rather than silently reinterpreting
approved choices. Staff and fingerprint flow into the approval hash like
every other config field.

The full brief is preserved in council artifacts, prompts and the approval
binding. Only a bounded descriptive label is sent to Orca's shorter Run
objective field; a multi-kilobyte review brief does not need to be shortened
to fit that host metadata limit.

### `council catalog` — supported launch lanes (read-only)

```text
council catalog --json
```

Reports `catalogVersion`, the launch-policy hash, and each documented lane:
binary, model flag, permission-posture tokens, effort/profile selectors where
verified, a `verification` label (`live-verified` / `help-verified` /
`unverified`), and **local binary presence**. Presence is PATH visibility
only — it never implies the account is authenticated, approved, free, or
unlimited. The command launches nothing and inspects no credentials.

### `council doctor` — environment check

```text
council doctor [--config <file> | --run <runDir>] --json
```

Reports each check as `verified` / `missing` / `failed` / `unverified`:
Node ≥ 22, the `orca` executable (`ORCA_CLI_COMMAND` or `orca` on PATH)
plus a live `orca status --json` call — the always-required host checks.
Every catalog lane also appears as an *informational* presence check. With
`--config` or `--run`, each staff role's AgentChoice is validated against
the catalog and only the **selected** agents' binaries gate readiness; a
legacy staff-less config is reported as such. `ready` is true when every
required check verifies.

The `memory` item is informational (`verified` when measured, `unverified`
when the platform's commit probe ran and failed — never a readiness gate):
`ramFreeMb`/`ramTotalMb` from `os.freemem()`/`os.totalmem()`, and free
commit where measurable — Windows via `Win32_OperatingSystem`
`FreeVirtualMemory`/`TotalVirtualMemorySize` through a fixed argv-spawned
PowerShell CIM query (`windows-cim`), Linux via `/proc/meminfo`
`CommitLimit`−`Committed_AS` plus `MemAvailable` (`linux-proc`), other
platforms RAM only. `additionalSessionsEstimated` counts how many more
agent sessions fit at the per-session footprint in `perSessionEstimate`
(~3.4 GB commit + ~0.4 GB RAM — one idle Devin worker plus MCP helpers
measured on a single Windows host; `COUNCIL_SESSION_COMMIT_MB` /
`COUNCIL_SESSION_RAM_MB` override). With `--config`/`--run` it also reports
`peakSessionsRequired` (`participants` seats + scribe + supervisor — the
organiser's terminal closes before reviewers launch; `concurrency` bounds
active work, not idle sessions) and warns (`fits:false` + `warning`) when
the estimate says it will not fit. If it warns, tell the user and suggest
closing idle agent sessions they do not need, or reduce `participants`;
never close terminals the council did not create.

### `council start-supervisor` — launch the dedicated supervisor worker

```text
council start-supervisor --run <runDir> [--wait-ms <n>] [--replace] --json
```

Creates the supervisor's Orca Task from `prompts/supervisor.md`, opens a
terminal running the run's `staff.supervisor` lane resolved through the
shipped catalog (the approved `{agent, model, permissionMode, effort?,
profile?}` becomes fixed argv tokens; a recorded execution-fingerprint
mismatch refuses before any host call; legacy pre-staff runs keep the
original `devin --model swe-2-max --permission-mode dangerous` pin), waits
for the agent's prompt (`terminal wait --for tui-idle`,
`--wait-ms` bounds it, default 60 s, range 1 000–600 000), then `worker-start`s
the Task on that terminal and persists the supervisor's
`{terminalHandle, dispatchId}` into `state.json` so `council approve` can
address its wake. The worker command string is built only from fixed
allowlisted tokens — nothing user-supplied ever becomes shell syntax.

The idle wait is followed by a `terminal show` check of the exact terminal,
connection, expected agent identity and explicit absence of an agent prompt.
A trust or permission screen pauses setup; it is never accepted automatically.
After `worker.started` is journaled it runs the same first-turn submission
check described under `supervise --advance` (lanes where Orca cannot observe
turn start, e.g. Devin) and reports a `submission` field — a
`launch.submit_unconfirmed` warning means `council status` will show a
`submit` pending action.
JSON callers must check `outcome`/`supervisorStarted`: a command exiting 0
with `ok:true` can still report `outcome:"paused"`,
`supervisorStarted:false`, `needsAttention:true` — it has not launched a
supervisor. The payload then carries `reason:{code,message}` naming the
blocker (a trust/permission screen, an unresolved custody record, an
ambiguous startup receipt), any partial `taskId`/`terminalHandle`/
`boundRunId`, `startupRecord`, `recovery` instructions, and `requestIds`.
Resolve the blocker, then rerun the same command — it reuses the recorded
resources.

`supervisor/startup.json` records startup intent, spec hash, caller binding,
resource IDs and known request IDs under the run lock. New records also
persist a per-operation **`issued` marker** (`issued.taskCreate`,
`issued.terminalCreate`) *before* each host call — so a crash mid-launch
leaves "issued, outcome unproven" durably distinguishable from "never
issued". After resolving a readiness prompt, rerun the same
`start-supervisor --run` command: a stage proven not-issued is created
exactly once while recorded resources (Task, terminal) are reused —
a task_created crash resumes with the same Task and creates only the
missing terminal. A record that marks a stage issued but carries no
identity for it **fails closed** (`launch_unknown`): the mutation may have
landed with a lost receipt — reconcile via `task-list`/`worker-list` and the
worktree before any retry. **Legacy records** (written before `issued`
existed) cannot prove a missing identity was never created — a missing
task/terminal stays ambiguous and refuses rather than risk a duplicate;
the record is preserved for manual recovery, never erased. An unconfirmed
issued attach (`start_issued`) blocks reruns until reconciled;
it never creates a replacement on a missing receipt. Changed binding, malformed
custody records or an already recorded supervisor also refuse a second launch.

The supervisor Task attaches to the caller's **bound** Orca Run (your existing
binding is preserved, never rebound). When the caller has no bound Run — e.g.
a first-time `init` followed directly by `start-supervisor` — the documented
`worker-start --spec-file` path creates or joins a Run implicitly instead of
failing. Either way the response reports `callerRun` and `lane` honestly.

**`--replace` — guarded dead-supervisor replacement.** Orca terminal handles
are runtime-scoped: an Orca restart makes the recorded handle permanently
unmatchable, and plain `start-supervisor` refuses while a supervisor is
recorded. `--replace` launches a new supervisor only when the old identity is
**proven** stale — `terminal show` returns a definitive stale-handle code —
and the original attach/dispatch custody is resolved (`worker-list` plus
`request-show` on any issued-start receipt). Success prints
`{outcome:"launched", replaced:true, retiredSupervisor:{...}}`; the old
startup record is archived and the retirement journaled. It refuses on a
still-live supervisor (`invalid_transition`) or unproven/contradictory
evidence (`launch_unknown`) with `details.probes`/`details.recovery` — quiet
or disconnected is never proof of death.

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

**First-turn submission check.** A fresh launch whose `worker-start`
receipt cannot prove the agent's turn started (Devin reports
`input_accepted` with `turnStart: unsupported`) is probed before the launch
returns: a bounded, read-only loop samples `worker-show` activity, the
relayed terminal title, and the rendered screen (`terminal show` /
`terminal read --screen`), classifying the launch `started`, `unsubmitted`,
or `inconclusive`. Only a settled `unsubmitted` verdict earns one bare
Enter — journaled as a `launch.submit_nudge` intent before the send and a
receipt after, so an attempt is never nudged twice even across a crash —
followed by a re-probe. Anything unresolved becomes a journaled
`launch.submit_unconfirmed` warning; the probe never fails or blocks an
attempt. Retained-terminal follow-up turns and receipts with no
`turnStart` field are not probed. The window defaults to ~24 s and is set
by `COUNCIL_SUBMIT_PROBE_MS` (integer, 100–120 000 ms; the sample interval
is window/12 clamped to 50 ms–2 s, and an `unsubmitted` verdict must hold
for two intervals). `council status` shows still-relevant warnings as
`submit` pending actions with the exact manual command — see the recovery
playbooks for when to use it.

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

Validates your `roster.approved.json`, which is a **wrapper object**, not a
bare seat array — `schemaVersion:1`, `runId` (must equal the run's id), and
`seats[]` with exactly `config.participants` entries, each selecting one
proposed `perspectiveId` with unique `seatId`/`participantId` and an explicit
`agent`/`model`/`permissionMode` (a fill-in template ships at
`skills/council/references/templates/roster.approved.template.json`).
`approve` then persists `approval.json`:
a record whose `hash` is SHA-256 over the canonical binding
`{runId, objective, seats, proposedRosterHash, config, snapshotId,
snapshotHeadHash}` — so the approval is bound to the exact proposed roster as
well as your seat selection, the config, and the pinned source. Reviewers
launch only while a valid approval exists. Any drift — edited objective,
changed roster or config, or a changed target tree — invalidates it and blocks
launches until you approve again; a mid-run invalidation must be cured by
re-approving the *exact same* seats/agents, not a new roster (start a new run
to change seats).

**Waking the supervisor.** `Engine.approve` already attempts the bounded
approval-wake itself — a `mail.sent` event (`kind: "approval-wake"`)
addressed to the recorded supervisor **Dispatch** (`dispatch:<id>`) when
one exists, else the bound council child Run (`run:<id>`), else the
recorded supervisor terminal. The Dispatch lives in the caller's Run — the
supervisor starts under it and later coordinates the council child Run —
so a `run:<child>` send naming the supervisor's `--dispatch-id` is refused
`dispatch_run_mismatch` before any receipt; the wake addresses the Dispatch
itself and Orca routes it to the mailbox the supervisor terminal reads.
`council approve` reads that journal back and reports it as
`supervisorWake` (`outcome`: `sent`, `skipped`, `budget_refused`, `error`,
a delivery outcome like `unknown`/`refused`, or `none` when nothing is
journaled) plus any journaled host `errorCode`/`error`.
A file write alone is never an Orca wake — but this send was attempted
before the command returns, so **do not blindly duplicate it**: the printed
`wakeCommand` is the manual fallback for the case where the recorded
*active* supervisor has not resumed. Historical or journaled notices are
not fresh approvals. `approvalWake` is a different notice — the
primary-side progress mail to the initiating orchestrator, not the
supervisor. When you drive `advance` manually there is no separate
supervisor — your next call is the wake.

### `council status` — observability

```text
council status --run <runDir> --json
```

Prints the run status, per-participant status and active attempt (with
`dispatchId` for manual fencing), consumption
(`launches` vs `maxLaunches`, `mailSent`), `approvalHash`, the quorum
position (reviewers with admitted independent findings vs
`ceil(quorumRatio × seats)` — a coverage diagnostic, not a gate), and
`pendingDecisions`/`pendingActions` (e.g. re-approve after invalidation,
reconcile an `intent_recorded` no-task attempt — never relaunch; an
`unknown` attempt gets observation guidance, never the reconcile command;
a `submit` action names the manual submit command for a first-turn
submission the probe left unconfirmed; a `replace` action on a provably
stale supervisor; a `cleanup` action when a terminal run still has
unclosed recorded terminals). The `submission` array lists the
journal-derived first-turn warnings behind any `submit` actions.
Additive diagnostics: `activity` (`lastEventAt`, `ageMs`, event count — a
stalled run reads as stale, not as "working"), `phase` timing (`enteredAt`,
`deadlineMs`, `graceMs`, `overDeadline`), `supervisorHealth` (`recorded`
plus a `live|stale|unproven|none` probe — a recorded supervisor is not
proof of life), and a `notify` block reporting the wake recipient,
delivery counters (`total/sent/unknown/refused/sending`), send budget,
last delivery, helper state (`running|starting|stale|dead|exited|none`),
`runStatus`, and `outboxState` (`ok` or `unavailable`). **`outboxState:
'unavailable'` means the outbox custody file is corrupt, unreadable, or
missing-after-use — the delivery counters are then placeholders, never
evidence of zero sends**; `outboxError` names the read failure
(`<code>: <message>`). A genuinely-new run reads `outboxState:'ok'` with
zero counters — distinguishable from corruption. The human output carries
the same diagnosis on its `wake:` line. Read-only: `status` never
captures a recipient, creates files, takes locks, rebuilds the outbox,
sends mail, or spawns the helper.

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

Reports integrity only, and reads the **authoritative journal first** —
a corrupt `events.jsonl` fails closed with the same `journal_corrupt`
diagnostic that halts `status`/`advance`; verify never reports `verified`
over a journal it declined to read (no repair, no rebuild, read-only).
It then re-hashes the live target against `snapshot.json`
(drift + changed paths), recomputes the approval binding hash against
`approval.json` (`bindingIntact`, `matchesStateHash`), and compares the run's
recorded execution fingerprint against the shipped catalog (`catalog`:
`intact` / `drifted`, or `legacy` on pre-catalog runs). The JSON exposes
`launchGate` — snapshot + approval + catalog, exactly what the launch gate
enforces — plus `managedArtifacts` and `managedBlocking`. Runs whose journal
carries the durable `receipts-v1` marker (`run.initialized` at seq 1)
get a journal-BOUND managed-artifact audit (`journalBinding:'bound'` —
the validated events, not a reread or a rebuilt index, supply the receipts):
hash receipts on admitted managed artifacts prove the recorded artifacts
still match their receipts, not that the artifacts' contents are correct
or complete. Legacy runs (no marker) report `untracked` honestly rather
than retro-verified, and a mismatched or stripped marker is never
downgraded into a passing verdict. `verified: true` requires `launchGate`
AND `managedBlocking: null` — a meta/journal marker disagreement
(`policy:'conflict'`), an unreadable audit, or any changed/missing/
index-only journal-tracked artifact forces `verified:false`, while
untracked files and stale-index projection drift stay warnings. It
is **not** a proof of truth of findings, and it never executes or validates
cited code. Recovery differs by failure: a changed pinned file means the
approved corpus is invalidated — **pinned snapshots are immutable, so start
a NEW run** (there is no re-snapshot path; re-approval alone cannot cure it
because the binding still references the stale snapshot). A mismatched
approval binding is cured by re-approving the *exact same* seats and config.
A drifted catalog fingerprint refuses launches until the catalog again
matches the bound `execution.policyHash` — restore the prior catalog or
create a new run. A persisted no-task intent is resolved by `reconcile`.

### `council cancel` — explicit cancellation

```text
council cancel --run <runDir> [--reason "<text>"] --json
```

Guarded `requestStop` per live attempt (including `timed_out` ones — a deadline
mark is not proof of death), releases-then-closes the council-created
terminals whose attempts are settled, marks the run
`cancelled`, and reports `confirmedStopped` vs `unverifiable` attempts. A
worker that never reported is inspected, never assumed dead.

Once cancelled, the engine sends the recorded supervisor Dispatch ONE
bounded, journaled notice (`mail.sent`, `kind:'cancel-notice'`) telling it
to run `advance` once — which reports finished/cancelled — and send
`worker_done`. It is sent only while `worker-show` observes the dispatch
`idle`, `working`, or `waiting_human`: a settled dispatch would reopen as
new work, and an unverifiable or unrecorded one is skipped with a journaled
reason. Orca's `worker-stop` cannot stop the supervisor's external
argv-lane terminal (`stop_unknown`), so this notice plus `council cleanup`
(below) is what retires it.

Orca may keep user-retained or unreclaimable sessions open. Cleanup respects
that decision: `released:false` means release was not confirmed; it does not
prove process exit. Only an explicit stopped result confirms cancellation.
Inspect the journal and host receipt for unresolved resources; never force-close
them to make a run appear clean.

### `council cleanup` — close leftover council terminals on a finished run

```text
council cleanup --run <runDir> --json
```

Terminal runs only (`reported` / `failed` / `cancelled`) — it refuses
`invalid_transition` before any host call on a live run, whose terminals
may still be in use. Orca never auto-releases the argv-lane terminals the
council creates, so the engine already releases then closes each terminal
it journaled creating once every attempt on it has settled — the
organiser's right after its roster is admitted; reviewers' and scribes'
when the run reaches a terminal state or is cancelled (retained terminals
reused by later phases stay open until then). `cleanup` runs the same
release-then-close pass again over every terminal the run journaled
creating — participant terminals plus the supervisor's, proven by
`supervisor/startup.json` — and may additionally *observe* an unsettled
dispatch (`worker-show`, read-only): a host `finished` verdict counts as
settled, and on a terminal-state run an attached supervisor still observed
`idle` may be closed even without `worker_done` (the exact reason is
journaled). Anything `working`, `waiting_human`, `unverifiable`, or
unobservable stays `skipped` with its reason journaled.

Each terminal reports `closed` / `already_gone` / `skipped` / `failed` plus
a summary; a journaled `closed`/`already_gone` receipt is never re-closed,
a failed close is retried only here (never by the engine), and a
receipt-less close intent is retried and flagged `retriedIntent`. Custody
is strict: only terminals this run created and journaled are considered —
nothing else is ever touched — and the calling terminal
(`ORCA_TERMINAL_HANDLE`) is never closed, so run `cleanup` from a terminal
other than the supervisor's. `council status` surfaces it as a `cleanup`
pending action while unclosed recorded terminals remain, and the
`finished` next-hint of `supervise --advance` names it.

## Progress wakes — the run mails the initiating orchestrator

The run notifies the **initiating orchestrator** at every lifecycle change —
stage transitions, the approval gate, blockers, failure, completion — and a
bounded run-local **progress helper** mails periodic updates during long,
otherwise-silent stages (~every 2 minutes while a stage runs). Subject form:
`council <crun>: <stage>`; the body carries persisted facts — stage label,
participant/attempt counts, launch consumption, elapsed/stage age, the next
action, and report paths on finish — never worker-liveness claims.

- The recipient is captured into `progress/recipient.json` at `init` (or
  overridden explicitly with `init`/`start-supervisor --notify <target>`)
  **before** any supervisor binding exists — the first durable target
  wins; a run with no recipient file gets no stage mail (legacy runs
  included).
- Notices are deduplicated by durable intent and carry their own bounded
  send budgets (default `stageMax:48` / `heartbeatMax:90`) — a repeated
  stage does not re-mail; `unknown` delivery outcomes stay visible rather
  than blind-retried, and `refused` gets one retry before
  `refused_final`. Delivery states are `sent | unknown | sending |
  refused | refused_final | invalid_recipient` — `sending` is custody in
  flight or crashed mid-send (possibly landed), never re-attempted
  automatically.
- Sends are drained **outside the Store lock** after the transition is
  durable, so a hung send never serializes council mutations. Drain
  bounds: 15 s per-send timeout, 5 s outbox-lock wait; a non-terminal
  advance attempts at most 8 sends and 45 s of backlog (skipped events
  stay pending and are recomputed next advance), while a terminal advance
  attempts every computed event — the `finished` wake is never stranded
  (64-event absolute cap, finished exempt). A crash window between the
  state flush and the outbox intent is recovered by replaying durable
  journal milestones — such catch-up mail is labelled `replay:` and names
  the replayed milestone; its counts still reflect CURRENT state.
- `progress/outbox.json` is guarded by the `progress/outbox.init`
  prior-use witness (written once after the first durable outbox write):
  an outbox missing while the witness exists means custody was deleted
  post-use and reads as unavailable — it is never silently reset.
- The helper is an argv-spawned `node` child — no shell, no agents, no
  provider jobs — with a singleton lease, default 2-minute tick interval,
  finite message budget, and a 24-hour maximum lifetime; it exits on
  terminal council state. It reads persisted state/journal only: **no
  host status polling**. `status`'s `notify` block reports recipient,
  delivery counters, and helper health — a dead helper or an unavailable
  outbox is a visibility gap, never claimed as guaranteed delivery.
- The supervisor agent sends none of this itself — stage mail is
  runner-emitted; its spec forbids forwarding it.

## Recovery playbooks

- **Dead/stale supervisor**: `start-supervisor --run <dir> --replace`
  (evidence-gated — see above). Refused means the old identity is not
  proven stale; manual driving remains the fallback.
- **Corrupt `events.jsonl`**: `advance` and `cancel` both fail closed — the
  journal is durable truth. Fence live workers manually
  (`worker-stop --dispatch <id>` from `status`/state records), preserve the
  directory, start a new run. No journal rebuild exists.
- **Corrupt `state.json`**: every command fails `io_error` at load — no
  state rebuild exists. Fence live workers by dispatch ids from
  `events.jsonl`, keep the directory for audit.
- **`lock_timeout`**: the lock names its live owner pid. Dead owner →
  automatic stale reclaim after `COUNCIL_LOCK_STALE_MS` (60 s; waits
  `COUNCIL_LOCK_WAIT_MS` 10 s). NEVER delete a lock its live pid still
  owns — that races a real writer.
- **Fresh terminal failed before dispatch**: a readiness-wait failure or
  refusal on a terminal the attempt itself created (e.g. a provider CLI
  stalled at a login screen) is a proven pre-dispatch failure — the engine
  closes the orphan and mints exactly one relaunch for that
  seat/phase/round; a second pre-dispatch failure fails the seat under the
  quorum rules. Anything less proven — a possibly-issued `worker-start` —
  still blocks `launch_unknown`, keeps its terminal, and is never
  relaunched.
- **Unsubmitted first-turn prompt** (`submit` pending action in `status`):
  read the screen (`orca terminal read --terminal <h> --screen --json`);
  only if the input line still holds the brief, submit once with a bare
  Enter — `orca terminal send --terminal <h> --text $'\r'` (PowerShell:
  `--text "`r"`; a literal `\r` types text, it does not submit). Never
  re-type the prompt; the runner already spent or skipped its one
  automatic nudge.
- **Leftover council terminals on a finished run**: `council cleanup --run
  <runDir>` (see above) releases-then-closes them — including an idle
  supervisor on a cancelled run, whose external terminal answers
  `worker-stop` with `stop_unknown`.

## Configuration

`--config <file>` at `init` overrides these defaults; the resolved config is
persisted, hashed into the approval binding, and journaled. Unknown keys are
ignored; invalid values are refused. Fill-in templates ship at
`skills/council/references/templates/`: `council.config.template.json`
(every key below with `staff` placeholders) and
`council.config.smoke.template.json` (a bounded rehearsal: 10 perspectives,
2 seats, 1 round, tightened budgets). Enforcement is split honestly: limits the
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
| `quorumRatio` | 0.67 ((0,1]) | coverage diagnostic, not a gate: the fraction of selected seats that must produce **admitted** independent findings for quorum to be met — below it the report carries an explicit quorum limitation and stays visibly partial; missing selected seats still make coverage partial even when quorum is met; a settled-but-rejected seat does not count |
| `maxLaunches` | `minViable + 8` | hard cap on total worker launches; the floor is `minViableLaunches = participants + 2·participants·rounds + 3`: organiser (1) + independent reviews + scribe notes (1) + challenge and response launches per seat per round + scribe synthesis (1); retries consume it too — an explicit value below the floor is refused |
| `maxFindingsPerSeat` | 7 | findings cap per reviewer — forces prioritisation |
| `maxChallengesPerSeatPerRound` | 3 | per-seat per-round challenge cap |
| `maxResponsesPerSeatPerRound` | 3 | per-seat per-round author-response cap |
| `envelopeBytes` | 8192 | per-recipient work-envelope byte cap (complete entries are trimmed visibly; JSON is never cut mid-token) |
| `maxMailPerParticipant` | 6 | per-seat runner-originated mail cap |
| `maxTextChars` | 4000 | declared free-text bound — parsed, persisted and approval-bound, but **not currently wired into admission**; the enforced limits are the itemized per-field caps in each worker spec (`title` ≤200, `note` ≤2000, `argument` ≤4000, `summary` ≤8000, …) |
| `deadlines` | object below | per-phase wall-clock limits in ms, checked inside `advance` (never real-time) |
| `staff` | required on fresh runs | `{organiser, scribe, supervisor}` — each a complete AgentChoice `{agent, model, permissionMode, effort?, profile?}` from the shipped catalog; a partial staff object is invalid |
| `execution` | captured by `init` | `{catalogVersion, policyHash}` — the shipped catalog fingerprint; a supplied fingerprint must match or init refuses |

`AgentChoice` axes: `agent` is the CLI lane (`devin`/`claude`/`codex`);
`model` is an explicit model id validated as data; `permissionMode` is a
posture token from that lane's explicit map (the user-facing `bypass` maps to
each lane's documented all-access mode); `effort` is honored only where the
lane documents a selector (Claude `--effort`); `profile` is a named CLI
profile (Codex `--profile` only — never a config-file path). Any choice the
catalog cannot launch is refused — no fallback, no substitution.

`deadlines` defaults: `organiserMs` 30 min, `independentMs` 4 h,
`scribeNotesMs` 1 h, `challengeMs` 2 h, `responseMs` 2 h, `synthesisMs` 2 h,
`runMs` 24 h (whole run), `graceMs` 30 min. Each accepts 1 000 ms – 7 days.

Seat count is also a memory commitment: each seat's agent session stays
open (idle) between its phases until the run's terminal cleanup closes it.
Measured on the Windows validation host, one Devin worker plus its MCP
helper processes held ~3.4 GB of committed memory (CLI ~2.4 GB, MCP ~1.0
GB) and ~0.4 GB of RAM; a long-running session grows further. Before the
release-then-close lifecycle existed, leftover sessions across runs
exhausted the host's commit limit (0.3 GB free) — a new reviewer's shell
failed to start and a running reviewer crashed. Before choosing the seat
count, run `council doctor --config <file>` and read the `memory` item: it
estimates how many additional agent sessions fit and warns when the
council's peak retained sessions (participants + scribe + supervisor) will
not. If it warns, tell the user and suggest closing idle agent sessions
they do not need, or reduce `participants` — never close terminals the
council did not create. Run `council cleanup` after every finished or
cancelled run.

With `participants=15` and `rounds=1` the launch floor is `15 + 30 + 3 = 48`,
so the default `maxLaunches` is 56; with `rounds=3` the floor is
`15 + 90 + 3 = 108`. Set `participants`/`rounds` lower to shrink the floor —
e.g. the bounded smoke template
(`skills/council/references/templates/council.config.smoke.template.json`)
uses `requestedPerspectives=10`, `participants=2`, `rounds=1` → a floor of
`2 + 4 + 3 = 9` launches before retry slack, and tightens per-seat budgets
and deadlines for a cheap end-to-end rehearsal.

## Flow recap for the calling agent

0. `doctor --config <file> --json` — preflight Node/Orca plus the selected
   staff's binaries, and read the `memory` item for seat-count headroom
   before committing launches.
1. `init` (with an explicit `staff` in `--config` — see the templates under
   `skills/council/references/templates/`) → `start-supervisor`
   (which resolves the run's `staff.supervisor` catalog lane and records the
   supervisor's dispatch) — or drive `supervise --advance` yourself per wake.
   With a dedicated supervisor your Orca Run binding stays untouched; the
   council lives in a separate child Run the engine creates on the first
   advance. If you drive `advance` manually on a run that has no child Run
   yet, the host binds **you** to the child Run it creates — see the manual
   mode note under `supervise --advance` above.
2. Wait for the supervisor's `needs_approval` mail (council stage mail also
   arrives — relay each notice's stage/counts/next action to the user);
   review `roster.proposed.json`; write `roster.approved.json` (wrapper:
   `schemaVersion`, `runId`, `seats[]`); run `approve` — its
   `supervisorWake` reports the journaled approval-wake to the supervisor
   Dispatch; the printed `send --to dispatch:<id>` nudge is the manual
   fallback, used only if the recorded active supervisor has not resumed.
3. Wait; `status` and `tail` are read-only and safe any time. Stage mail and
   bounded heartbeats keep arriving — relay each to the user concisely;
   silence until the final report is not acceptable.
4. Read `report.md` / `report.json` when the supervisor reports `finished`,
   then `verify` the run, then `cleanup --run <runDir>` to close leftover
   council terminals (also after a `cancel`). Partial results are visibly
   marked partial; a wholly failed run emits no successful-looking report.

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
  agreement never upgrades a claim. Reviewer `strengths` are bounded
  preservation records — never routed for challenge, never grade input.
- Does not replay or rebuild state: `events.jsonl` is a durable, hash-chained
  record for audit and reconciliation, not a state-replay engine.
- Does not promise notification delivery: stage/progress mail carries
  persisted facts deduplicated durably — never a worker-liveness verdict —
  and a dead helper or failed send is a visible gap, not hidden silence.
- Does not install a skill for you or touch global config; the optional
  installer only copies the skill and records the runtime path (see
  [AI-INSTALL.md](AI-INSTALL.md)). The user-facing "bypass" posture maps to
  each lane's documented all-access mode at the catalog boundary — a
  separately approved product posture, not a silent default.
- Does not silently fall back to other or paid models; every seat's and
  staff role's agent/model/permission/effort/profile is an explicit,
  approved, catalog-validated choice — `devin` (`swe-2-max`, Devin-hosted
  Claude Opus) and `codex` have run live council seats; the `claude` CLI
  lane is help-verified — treat its first real launch as unproven, and check
  `claude auth status` first.
- Does not guarantee first-turn submission recovery end-to-end: the probe
  classifies terminal TUI text — inherently brittle, and verified live only
  on Devin lanes (a scratch terminal and one council). It warns rather than
  fails, so an unresolved
  `submit` warning still relies on the manual command it names.
- Does not claim every lifecycle path is live-proven: a live council
  verified the approval wake, the first-turn submit nudge, engine terminal
  closes and `council cleanup` end to end (see VERIFICATION.md,
  "Lifecycle fixes verified live"); the pre-dispatch relaunch and the
  cancel notice to a supervisor are fixture-tested only.
- Does not produce automatic fixes or rerun-diff reports in this release.

## Validation status — honest ledger

- `npm test` passed **732/732** on the integrated `4370a1d` snapshot —
  recorded in [NEXT-RELEASE-VERIFICATION.md](NEXT-RELEASE-VERIFICATION.md)
  stage 4 (fake-host suite — no live provider claims). On Windows Node
  26.7.0 the same suite first exposed one POSIX-only path assertion; after
  that test fix it runs **732 tests, 729 pass, 0 fail, 3 skipped** (file
  symlinks need extra Windows privileges). The Linux/Windows Node
  22.x/24.x CI matrix is recorded separately; local tests do not establish
  current CI status.
- A **15-seat live Orca council completed the full protocol** on the
  Fieldnotes fixture using Devin `swe-2-max`: organiser, exact roster
  approval, 15/15 admitted independent files, separate scribe notes,
  bounded discussion, two applied author revisions, and final synthesis.
  Three reviewers minted local `C-1` and all retained distinct qualified
  identities. No output/evidence rejections occurred; final verification
  found no fixture drift and an intact approval/catalog binding.
- This run used two findings and one challenge/response per seat for one
  round. One response was cap-omitted and remains explicit unresolved
  dissent; 27/30 claims received no challenge. Full seat coverage is not
  full adversarial scrutiny or proof. Default output-volume throughput,
  multi-round and long-run production scale remain unverified.
- [VERIFICATION.md](VERIFICATION.md) preserves the completed run's
  metrics, prior partial/cancelled runs, fault-injection audits and custody
  limits. The earlier reduced smoke remains historical evidence.
