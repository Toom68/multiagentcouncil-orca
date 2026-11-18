# Architecture proposal — Multiagent Council for Orca

Status: proposal, v1 scope. Author: architecture planner (dispatch `ctx_8caad8e6a789`).
Verified against Orca `1.4.261` on Windows (`orca status --json`), `devin` CLI `3000.11.92`,
and the version-matched `orca skills get orchestration` / `orca-cli` / `orca-plugin-authoring`
guides on this machine. Every capability claim cites the command or reference it was read from;
items not yet proven live are listed under **Open questions**.

## 1. Recommendation in one paragraph

Build the council as a **Node/TypeScript CLI (`council`) plus an Orca skill**, driven by a
dedicated **supervisor agent worker** (Devin `swe-2-max`, free) that the primary orchestrator
launches with one documented command. All protocol logic — state machine, budgets, approval
enforcement, claim ledger, journaling — lives in the CLI, not in prompts. Reviewers, the
organiser and the scribe are **real Orca supervised workers** coordinated through documented
`orca orchestration` commands (`run-create`, `task-create`, `worker-start`, `send`, `check`,
`inbox`, `reply`, `worker-*`). An MCP server and a native plugin are both rejected for v1 (see
§5); the plugin becomes an optional observer/guard later. The portable core is host-agnostic:
Orca is one `HostDriver` implementation behind an interface, so Claude/Codex execution can be
added without touching protocol code.

## 2. Verified host capabilities (evidence)

| Capability | Evidence |
| --- | --- |
| Nested coordinator Runs: a worker may `run-create` and coordinate a child Run; nested coordinators get group mail in their child Run mailbox | `orchestration` skill guide, "Several Runs"; `run-create --help` |
| All orchestration commands accept `--from <handle>` / `--run <id>` | `send`, `task-create`, `run-create`, `worker-start`, `check` help |
| Supervised workers: `worker-start (--task|--spec|--spec-file) --worktree ... (--agent|--terminal) [--model][--effort][--retry-of][--timeout-ms]`; receipt carries `next`, `failedStage` | `worker-start --help` |
| Custom argv workers: `terminal create --command` then `worker-start --task --terminal <handle>` | `references/low-level-topology.md`; `terminal create --help` |
| `worker-start --model` covers Claude/Codex/Cursor/Antigravity/Grok/Muse/OMP/Pi only; other agents (incl. Devin) launch with the model from their own config | `worker-start --help` Notes; confirmed by orca-integration peer on 1.4.261 |
| `devin` is a first-class agent kind; `devin --model <MODEL>` / `DEVIN_MODEL` pin the model | `account add --agent claude\|codex\|opencode\|devin`; `agent.resume` agent union; `devin --help` |
| Follow-up turns: `send --to dispatch:<id>` to a finished/closed worker creates a follow-up Task that reports `worker_done` — same agent session, preserved context | `send --help` Notes |
| Consuming `check` marks a FIFO batch handled; watchers must `--peek`; `inbox --terminal run:<id>\|dispatch:<id>` re-reads handled mail | `check --help` Notes |
| Bounded read: `worker-read --dispatch` (`--source auto\|transcript\|terminal`) | `worker-read` summary, orchestration command list |
| Liveness/accounting: `worker-list --run --terminal-state`, `worker-show --dispatch` (incl. `observation.agentWait`) | `worker-list`, `worker-show` help |
| Guarded stop/abandon/release; 3-failure `--retry-of` circuit breaker; `task-update` reopen flow | `references/recovery-and-cleanup.md`; `task-update` help |
| Decision gates: `gate-create --task --question --options`, `gate-resolve --id --resolution` | `gate-create`, `gate-resolve` help |
| Blocking wait: `check --wait --timeout-ms` (documented; not polling) | `check --help` |
| Trusted-worker plugins expose **no** orchestration host methods (no run/task/mail/gate calls, no exec); `agent.launch`, `terminal.*`, `agents.list`, `agent.status.changed`, `workspace.create`, storage/secrets/settings exist; plugin hooks (`agent.launch.before`, `agent.prompt.before`, `agent.tool.before`) can deny/rewrite launches and orchestration prompt injections; plugin MCP/skills contributions are reserved | `orca skills get orca-plugin-authoring --reference references/host-api.md`, `events.md` |
| Worker spec from file: `worker-start --spec-file <path>` (relative paths OK — no shell quoting issues) | `worker-start --help` Notes |
| Idempotent reissue: `--retry-request <id>` on mutating commands | all orchestration help |

## 3. Topology and roles

```
primary orchestrator (user's agent; owns its own Run)
   │  terminal create --command "devin --model swe-2-max" → worker-start --terminal   (§7)
   ▼
council SUPERVISOR worker  =  Devin agent (swe-2-max) running `council supervise`
   │  binds a child Run (orcaRunId recorded in council.json); owns all council mail
   ├── ORGANISER worker      (1 dispatch, devin/swe-2-max)  → roster.proposed.json
   ├── REVIEWER workers      (p dispatches, default 15; configurable agent per seat)
   ├── SCRIBE worker         (1 dispatch; live from discussion open)
   └── all findings/claims/envelopes/report as files under .council/runs/<id>/
```

- **Primary orchestrator** does exactly three things: launch the supervisor, approve the
  roster (writes `approval.json` via `council approve` — and may also `reply` to the
  supervisor's `ask` mail for UX), and read the report. Its own Run binding is untouched.
- **Supervisor** is an agent only because Orca supervision needs an agent terminal: it gives
  us a Dispatch identity, preamble, liveness, stop/abandon and `worker_done` for free. The
  agent contains zero protocol logic — its spec says: *run `council supervise --advance`;
  when it prints `awaiting_external`, end your turn; when it prints `run_finished`, send
  `worker_done` with the printed outcome and `--report-path`.* Everything deterministic is
  inside the CLI, which is testable without any LLM.
- **Organiser, reviewers, scribe** are ordinary supervised workers in the supervisor's child
  Run. Each maps 1:1 to an orchestration **Task**; each launch attempt is a **Dispatch**
  (`--retry-of` chains on retry).
- **Why a child Run, not the parent's Run:** the parent's mailbox stays clean; council Tasks,
  gates and dispatches are namespaced; group/exact addressing work inside the child Run.
  Nested coordinators are documented (§2, row 1).

## 4. Lifecycle — exact state machine

`state.json` holds `status`; every transition appends to `events.jsonl`. Transitions are
guarded in code inside `council supervise --advance`; the supervisor agent cannot move the
machine by editing files (files are re-validated and hash-checked).

```
initialized
  └─organiser dispatched→ organising
        └─worker_done + roster.proposed.json VALID→ awaiting_approval
        └─worker failed (retries exhausted | deadline)→ failed
awaiting_approval
        └─approval.json valid (§9)→ approved
        └─approval rejected / expiry→ cancelled
        └─roster/config/snapshot drift→ stays awaiting_approval, approval.invalidated
approved
        └─participants dispatched (concurrency window)→ independent_review
independent_review
        └─all settled→ independent_closed
        └─deadline AND settled≥quorum→ independent_closed (coverage=partial, journaled)
        └─deadline AND settled<quorum→ failed
independent_closed
        └─round 1 opened→ discussing
discussing   (substate: round n, envelopes out → collecting)
        └─round closed & n<maxRounds→ discussing (n+1)
        └─round closed & n=maxRounds (or no challenges issued)→ discussion_closed
discussion_closed
        └─scribe synthesize sent→ synthesising
synthesising
        └─report.json + report.md valid→ reporting
        └─scribe failed→ retry once cold from journal (§13) else failed
reporting
        └─parent notified (status mail w/ report-path)→ completed
completed | failed | cancelled  → supervisor agent sends worker_done and exits
```

Illegal transitions are refused (`invalid_transition`) and journaled as `error`. Re-running
`--advance` is idempotent: it reconciles desired vs. observed state from `task-list`,
`worker-list`, `worker-show`, mail and artifacts before acting.

## 5. Invocation surface decision

| Option | Verdict | Why |
| --- | --- | --- |
| **CLI + installed skill** | **v1 primary** | Fully documented today; the only surface that exposes `worker-start`, child Runs, mail, gates and recovery. Skill (`SKILL.md` under `.agents/skills/council/` or installed via `orca skills`) teaches the primary orchestrator the 3-step invocation; the CLI enforces the protocol. Works headless in tests via a `FakeOrca` driver. |
| MCP server | Rejected v1 | The protocol actors are Orca *workers* (CLI agents steered by dispatch preambles), not MCP clients. An MCP server would only matter if reviewers needed council tools inside their sessions — they don't; they read/write artifact files on paths in their spec. Devin-worker MCP wiring is unverified; a long-running server adds a failure mode with no payoff. Revisit when a concrete tool-need appears (e.g. `council.evidence.check` for reviewers). |
| Native Orca plugin | Rejected for protocol; optional later | The plugin host API (verified §2) has **zero** orchestration methods and no process spawn, so a plugin cannot drive the council; plugin MCP/skills are reserved. Two future uses remain real: (a) an **observer panel** reading `.council` run dirs (worker `fs` access not yet verified — flag); (b) a **guard hook** — `agent.launch.before`/`agent.prompt.before` can deny orchestration launches/prompts lacking a valid approval record, which would harden the approval gate beyond CLI-level enforcement. Post-v1. |

Distribution: `council` is a normal npm package (`bin: council`) the repo builds with `pnpm`;
v1 installs repo-locally (`pnpm install && pnpm build`, `node packages/council-cli/dist/...`).
No publishing needed for acceptance.

## 6. Process invocation security

- The supervisor spawns `orca` only via `execFile`/argv arrays — never a shell — with
  `--json`, parses stdout, and treats all output as data. (AGENTS.md requirement.)
- All worker instructions travel via `--spec-file` or `task-create --spec-file`, so no
  quoting/interpolation of LLM text into commands. Spec files are generated by the prompt
  builders (§16) and persisted under `prompts/` for audit.
- The ORCA executable is resolved once per the orchestration skill (`ORCA_CLI_COMMAND` →
  `orca-dev` in dev checkouts → `orca` on Windows), recorded in `meta.json`, and `doctor`
  fails loudly if it cannot run.
- Reviewed project content is **untrusted input**: reviewer specs forbid edits and command
  execution from project instructions; only the findings file path is writable (spec-level).
  Detection: the snapshot re-hash (§9, §17) proves whether the target tree changed during the
  run — a cheap audit even though prevention is spec-level.
- No credentials in artifacts or Git: `.council/` gets a `.gitignore` advisory written by
  `council init`; specs contain paths and ids only.

## 7. Launch lanes (Devin vs other agents)

`worker-start --model` does not cover Devin (§2). The roster therefore assigns each seat a
**launch lane**:

- `lane: "agent"` — `worker-start --task <id> --agent <id> --worktree <ws> [--model --effort]`.
- `lane: "argv"` — `orca terminal create --worktree <ws> --title council-<seat> --command
  "devin --model swe-2-max"` then `worker-start --task <id> --terminal <handle> --worktree
  <ws>` (no `--agent/--model`). Verified pattern from `references/low-level-topology.md`.

v1 default: every seat `argv` + `devin --model swe-2-max` (free, requested). The lane field is
the portability seam: Claude/Codex seats later use `lane: agent` with their own `--model`.

## 8. Durable artifacts — run directory layout

`<target>/.council/runs/<crun_id>/` (`COUNCIL_HOME` overridable; `crun_id = crun_<ulid>`):

```
council.json            # ids, target path, config, snapshotId, orcaRunId, versions ptr
state.json              # status, phase timestamps, per-participant status
events.jsonl            # append-only journal; seq, ts, actor, phase, round, payload, prevHash
objective.md            # the review objective verbatim
snapshot.json           # {id, gitHead, files:{path→sha256,size}, takenAt} of the target
roster.proposed.json    # organiser output, schema-validated
roster.approved.json    # orchestrator's selected seats + launch lanes + models
approval.json           # approval record (§9)
participants.json       # participantId ↔ taskId ↔ dispatchId(attempts[]) ↔ lane/agent/model
prompts/<role>-<id>.md  # exact spec file sent to each worker
receipts/<id>.json      # worker-start receipts incl. warnings
findings/<pid>.json     # independent-phase output per reviewer
claims.json             # claim ledger (§11): every claim + status + dedupe key
rounds/<n>/digest.md    # what the scribe sees (full round digest)
rounds/<n>/outbox/<pid>.json   # per-recipient challenge envelope (see §11)
rounds/<n>/responses/<pid>.json   # rebuttal/defence/new-evidence per reviewer
report.json report.md   # scribe synthesis
meta.json               # council version, orca version, devin version, models, timings
transcript.jsonl        # view over events.jsonl: all mail in/out, rendered readable
summary.md              # 1-page readable result for the user
```

`events.jsonl` is the single source of truth; `state.json`/`claims.json` are rebuildable
projections (`council rebuild`).

## 9. Approval binding and invalidation

- `roster.approved.json` is produced by the **orchestrator**, not inferred: it lists the
  selected perspective ids and per-seat `{lane, agent, model, effort}`.
- `council approve` writes `approval.json = {approvalId, approverHandle, orcaDispatchId,
  hash, createdAt}` where `hash = sha256(canonicalJSON({objective, roster.approved,
  config, snapshotId, snapshot.headHash}))`.
- The supervisor launches reviewers **iff** `approval.json` exists and its hash recomputes
  equal over the current files. Enforcement is in `launch-reviewers`'s guard — code, not
  prompt. A forged/stale approval fails the hash and blocks.
- **Invalidation:** any change to objective, roster selection, seats, config params, or the
  target snapshot (re-hashed before launch) emits `approval.invalidated`, returns the machine
  to `awaiting_approval`, and requires a fresh `council approve`. Editing `roster.proposed`
  (e.g. re-running the organiser) voids both derived artifacts.
- UX channel: the supervisor sends the parent an `ask`/status mail summarising the roster and
  naming the exact `council approve` command; the parent's `reply` is convenience — the
  durable, enforced artifact is always `approval.json`. (This avoids depending on unanswered
  mailbox-routing questions, see §22.)

## 10. Perspectives vs participants — semantics

- Organiser proposes `10 ≤ N ≤ 25` **perspectives** in `roster.proposed.perspectives[]`:
  `{id, name, charter:{incentives, expertise, method, blindSpots, reviewQuestions[]}, tags[]}`.
- `config.participants` (default **15**) is the seat count. The approved roster selects a
  subset of proposed ids of exactly that size; **one seat per perspective, no duplicates, no
  invented perspectives** — validator refuses anything else. Changing either the selection or
  the count is a new approval (§9).
- If the orchestrator wants fewer seats than proposed, it picks; if it wants perspectives not
  proposed, it must send the roster back (`rejected` + note) — the organiser re-proposes.
- Diversity is structural, not adjectival: schema requires `incentives/method/blindSpots`
  fields and a linter warns when `>60%` of approved seats share a primary tag or when all
  seats share one model id (monoculture warning — journaled, non-blocking in v1 since
  swe-2-max is the only confirmed-free lane).

## 11. Messaging, envelopes, claim ledger, journal

**No broadcast, no peer-to-peer.** All discussion is hub-and-spoke through the supervisor —
this is the anti-groupthink and budget mechanism (AGENTS.md: no uncontrolled all-to-all
chatter; methodology peer requirement confirmed by mail `msg_05e21acde272`).

- Independent phase: each reviewer writes `findings/<pid>.json` then `worker_done`. No
  reviewer sees another's findings.
- Claim ledger `claims.json`: supervisor normalises all findings into claims
  `{claimId, title, kind: defect|risk|suggestion|question, grade:
  verified_defect|plausible_risk|speculative|unsupported, status:
  proposed|challenged|defended|revised|escalated|confirmed|resolved|withdrawn,
  evidence[], dedupeKey, history[]}`. `status` tracks process and uses the canonical enum
  committed in `review-methodology-proposal.md` (§8.3); `grade` tracks evidence strength and
  is deliberately orthogonal — do not collapse them (peer mail `msg_93625fa8064e`).
  Dedupe merges near-duplicates keeping provenance (`sourceFindings[]`) — social agreement
  never multiplies a claim.
- Discussion round `n`: supervisor (with the scribe's digest input) chooses which claims need
  challenge, builds **one envelope per recipient** `rounds/<n>/outbox/<pid>.json` containing
  *only* the claim(s) under challenge, the challenge question, and the response schema —
  never the transcript. The reviewer is woken with `send --to dispatch:<pid>` carrying the
  envelope path (exact single-recipient delivery; follow-up task on the same Dispatch → same
  agent session keeps context, §2).
- Responses are files `rounds/<n>/responses/<pid>.json`, schema-validated on ingest;
  `worker_done` closes each follow-up task.
- Budgets enforced in code: `maxRounds` (default 2), `maxChallengesPerReviewerPerRound`
  (default 3), envelope byte cap (default 8 KiB), findings cap per reviewer (default 7),
  `maxMailPerParticipant`. Over-cap material is truncated deterministically and the
  truncation is journaled.
- `events.jsonl` journals every `mail.sent`/`mail.received`/`envelope.built`/`response.
  ingested` with ids and byte counts — the transcript is a projection, and a full recount is
  always possible.

**Mail ingest discipline:** the supervisor agent never runs bare `check`. `--advance`
performs `check --peek` → journal the batch (dedupe by message id) → `check` (consume the
same still-unread batch). Crash between peek and consume is safe: next advance re-reads and
dedupes. Any other script/watcher touching the supervisor's mailbox must use `--peek` /
`inbox` (peer-verified rule: only the coordinator agent may consume `check`).

## 12. Phase barriers

Every barrier is a guard function consulted before acting; each writes `phase.entered` or
`barrier.refused` with the reason:

| Barrier | Guard |
| --- | --- |
| organiser → approval | `roster.proposed.json` validates; else re-prompt once then fail |
| approval → launch | valid `approval.json` hash (§9) |
| independent → discussion | all participants settled **or** (deadline reached **and** settled ≥ `quorum`, default 2/3 of seats) |
| round → round+1 | all live respondents settled or deadline; ledger updated |
| discussion → synthesis | `n = maxRounds` or a round produced zero pending challenges |
| synthesis → report | `report.json` validates; every `verified_defect` carries captured `repro` evidence or a validated contradiction (§17); all citations resolve against `snapshotId` |

## 13. Worker correlation and recovery

- `participants.json` is the correlation table: `{participantId, role, taskId,
  attempts:[{dispatchId, worktree, lane, startedAt}], status, findingsFile}`.
- Specs embed `crun_id`, `participantId`, `phase`, `round` and the exact artifact paths —
  workers can only write where the spec says.
- Reconcile-then-act: each `--advance` cross-checks `task-list --run <child>` and
  `worker-list --run <child>` against the ledger before launching or waiting, so a supervisor
  restart (or agent crash → same spec rerun) resumes cleanly.
- Failure handling honours `references/recovery-and-cleanup.md` exactly: retry is
  `worker-start --task <same> --retry-of <dispatch>` (max 3 → circuit breaker → phase policy);
  stop only via `worker-stop` on confirmed or unverifiable-but-exact identity, claim stop only
  on confirmed result; `worker-abandon` for explicit abandonment; `worker-release` for
  reclaimable failed-start terminals. Silence/timeout alone never marks a worker dead.
- Scribe is cold-restartable: its entire input is the run directory; a failed scribe is
  retried once on the same task with a spec that says "read everything under
  `.council/runs/<id>`".
- Parent-visible failure: the supervisor ends `worker_done --outcome failed` with the journal
  tail and `state.json` pointer — failures are never smoothed over.

## 14. Deadlines and budgets

`config` (all journaled; all enforced by the runner, not prompts):

```
participants: 15, quorumRatio: 0.67, maxConcurrentWorkers: 5,
maxLaunches: 40, maxRounds: 2, maxChallengesPerReviewerPerRound: 3,
envelopeBytes: 8192, maxFindingsPerReviewer: 7, maxMailPerParticipant: 6,
organiserDeadlineMs, independentDeadlineMs, roundDeadlineMs,
scribeDeadlineMs, runDeadlineMs, graceMs
```

Deadline policy `quorum_proceed`: soft deadline → `deadline.hit` event + status mail to the
parent and keep waiting up to `graceMs`; hard deadline → apply §12 partial-coverage rule or
fail the phase. Reviewer terminals that outlive a hard deadline get a guarded `worker-stop`;
result recorded as observed, never assumed.

## 15. Scribe lifecycle

- **Started live at `open-round 1`** (brief: "listens to all contributions"): its spec grants
  read access to the run dir; each round it receives the full `digest.md` (scribe-only — it
  sees everything, unlike reviewers) plus ingested responses, and maintains its own working
  notes file.
- `discussion_closed` → supervisor sends the scribe `synthesize` (follow-up on its Dispatch).
- Scribe writes `report.json` + `report.md`, `worker_done`. CLI validates: findings carry
  `kind`, `grade`, `severity`, `confidence`, `evidence[]`, `counterEvidence[]`, `remedies[]`,
  `openQuestions[]`, `claimIds[]`; `grade` separates **verified defects** from
  **plausible risks** and **speculative** material (§17 for what may claim `verified_defect`);
  dissent preserved via `claim.status`/`history` — minorities are never deleted.
- One cold retry from journal on failure (§13). Report verification per §17 before the parent
  is notified.

## 16. Interfaces — public surface

CLI (`packages/council-cli`), all `--json` where useful:

```
council init --objective <file> --target <path> [--config <file>]   # creates run dir, snapshot
council doctor                                                    # env/capability check
council supervise --run <dir> --advance                           # one reconcile+act step
council approve --run <dir> --roster <file> [--note]               # writes approval.json
council status --run <dir> | council tail --run <dir>              # observability
council verify --run <dir>                                        # re-check evidence vs snapshot
council abort --run <dir>                                         # guarded stop all, mark cancelled
council rebuild --run <dir>                                       # state/claims from events.jsonl
```

Supervisor spec contract (generated): *Run `council supervise --run <dir> --advance`; parse
the printed JSON `{state, action, note}`; if `action=wait`, end your turn; on any wake, run it
again; if `action=finish`, send `worker_done` with the given outcome and `--report-path`;
never run `orca orchestration` commands yourself; if advance prints `needs_decision`, use
`ask`.* — an LLM supervisor exists only for wake delivery, Dispatch identity and edge-case
questions; it owns no protocol decisions.

Worker I/O contract (all roles): inputs = spec file + named artifact paths; outputs = the
named artifact files + `worker_done` with `--files-modified`/`--report-path`. No worker ever
needs orchestration mail as a data channel; mail is only a doorbell.

## 17. Evidence vs hallucination; monoculture; budgets; reproducibility

- **Evidence discipline:** `findings.evidence[]` requires `{kind: code_location|repro|
  scenario|reasoned|speculative, path?, lines?, snippet?, note}` — `code_location` must carry
  `path+lines`; `repro` must carry captured steps + observed result. `council verify`
  re-resolves every citation against `snapshot.json` and live files and stamps
  `citation: verified|stale|unverifiable`. **A matching citation alone never establishes
  `verified_defect`** (coordinator ruling, `msg_53a6dd811433`): that grade requires a `repro`
  entry with captured reproduction, or a contradiction another participant independently
  validated recorded in `claims.history`; everything else caps at `plausible_risk`. The
  report schema makes the grade structural, not tonal, and the scribe spec mandates
  downgrading unverifiable citations.
- **Enforcement honesty** — what is runner-enforced vs prompt-only in v1:

  | Policy | v1 enforcement |
  | --- | --- |
  | Approval gate, phase barriers, quorum, deadlines, message/round/envelope caps, seat↔perspective binding | **Hard** — FSM guards + hash check + file envelopes (§9, §12, §14) |
  | Single-recipient delivery, no reviewer↔reviewer talk | **Hard** — supervisor is the only mail sender; envelopes carry one claim |
  | Findings cite snapshot-pinned `path:line`; drift detection | **Hard for citation validity** — `council verify` re-hashes; staleness is provable |
  | `verified_defect` grading | **Schema-hard** — grade field exists and `report.json` is rejected without `repro`/validated-contradiction evidence; the *quality* of a repro is scribe+spec level |
  | Read-only target access | **Prompt-level** — spec forbids edits and reviewers share `cwd`; no sandbox sealing in v1. Snapshot re-hash *detects* modification; it does not prevent it |
  | Token/tool-use limits inside a reviewer session | **Prompt-level** — not observable or enforceable by the runner; mitigated by sliced inputs, output-file caps, and `worker-read` audit |
  | Network egress restriction | **None** — not promised in v1 |
  | Worker start/stop/retry truthfulness | **Hard** — Orca receipts + recovery reference semantics; silence never proves exit |
- **Model monoculture:** v1 reality — only `devin/swe-2-max` is confirmed free, so all seats
  default to it; diversity comes from the charter fields + independent-phase isolation +
  routed (not broadcast) challenge. The roster schema carries per-seat `agent/model` and the
  validator warns on uniformity, so mixed fleets are a config change, not a redesign.
- **Context budgets:** spec files embed only the slice a worker needs (charter + its
  envelopes); reviewers never receive the transcript; the scribe receives digests + ledger,
  with deterministic truncation + a `truncated: true` flag in the report when over cap.
- **Reproducibility:** every spec, receipt, roster, approval and message is persisted;
  `meta.json` records tool versions. A rerun of the same `crun` spec is structurally
  comparable via `council verify --diff` — outputs are LLM-generated, so we promise audit,
  not byte-identical replay (stated honestly in the report header).

## 18. Language choice — TypeScript/Node, with caveats

Chosen: **TypeScript on Node LTS**, ESM, `pnpm` workspace, `ajv` for JSON-Schema validation,
`ulid` for ids — deliberately few deps. Reasons: the Orca plugin API is already TS if we add
the observer later; JSON-schema-first design fits TS; Windows/macOS/Linux parity including
`execFile` argv semantics; cheap contributor familiarity. Honest challenge considered: a
zero-dep single-file Node script could do this, but the FSM + schemas + fake-driver tests
want a real package; Python was rejected (packaging/venv friction on user machines and no
path to the plugin surface); Bun adds a runtime users may lack. If the team wants even fewer
moving parts, dropping to plain `.mjs` + JSDoc types is a viable fallback at some cost to
refactor safety.

## 19. Module/file split — non-overlapping ownership

```
packages/council-core/            # pure TS, zero Orca deps — fully unit-testable
  src/schema/{index,roster,config,finding,response,claim,report,envelope}.ts   (Dev A)
  schemas/*.json                  # JSON Schema 2020-12 sources of truth           (Dev A)
  src/state/{machine.ts,guards.ts,transitions.ts}                              (Dev B)
  src/state/{journal.ts,store.ts,snapshot.ts}                                  (Dev B)
  src/domain/{claims.ts,digest.ts,budget.ts,quorum.ts,approval.ts}             (Dev C)
  src/prompts/{organiser.ts,reviewer.ts,scribe.ts,envelope.ts}                 (Dev C)
  src/driver.ts                   # HostDriver interface (see below)             (Dev B+C contract)
packages/council-orca/
  src/{cli.ts,orchestration.ts,mailbox.ts,identity.ts,launch.ts}               (Dev D)
  src/fake-orca.ts                # in-memory HostDriver for tests              (Dev D)
packages/council-cli/
  src/{index.ts,commands/*.ts}    # thin: parse → core → driver                 (Dev E)
packages/council-skill/
  SKILL.md + references/          # invocation + approval UX for orchestrators   (Dev E)
tests/{unit,contract,e2e}/                                                   (all; Dev E leads e2e)
docs/                             # this file + integration + methodology docs   (planners)
```

`HostDriver` (the portability seam): `runCreate, taskCreate, workerStart, send, check,
inbox, reply, workerShow, workerList, workerRead, workerStop, workerRelease, terminalCreate`.
Core emits `Action[]`; only `council-orca` executes them. A `ClaudeDriver`/`CodexDriver`
later implements the same interface with `claude -p`/`codex exec` behind files+stdout.

## 20. Test strategy

- **Unit (no Orca):** every FSM transition incl. all refusals; schema validators incl.
  adversarial rosters; approval hash bind/invalidate (each invalidation vector); dedupe/ledger
  merge; digest bounds and truncation; quorum/deadline math; envelope single-recipient
  construction (assert no other claim ids leak into an outbox file).
- **Contract (`FakeOrca`):** full simulated runs — organiser→approval→15 reviewers→2 rounds→
  scribe→report; verify launch only post-approval; crash-resume by replaying events; timeout→
  quorum partial path; retry-of chain → breaker respected.
- **Integration (real Orca, cheap):** mini-council `--participants 2` (4 perspectives),
  `--rounds 1`, all Devin swe-2-max on this repo — exercises real `worker-start --terminal`
  argv lane, real mail, real `worker_done`, real scribe. This is the acceptance smoke test:
  it is a *live* run, explicitly not mocked.
- **Failure drills:** kill a reviewer mid-round (deadline→partial), tamper `roster.approved`
  (launch refused), corrupt `findings/x.json` (ingest quarantines + retry), stop supervisor
  mid-run and rerun `--advance` (idempotent resume).
- **Acceptance mapping:** each BRIEF acceptance bullet maps to ≥1 named test in
  `tests/e2e/acceptance.md`.

## 21. v1 scope — in / deferred

In: all of §3–§16 with Devin-only seats; file-envelope discussion; snapshot-pinned evidence
checks; CLI observability; live smoke test. Deferred (labelled): plugin observer panel and
guard hook (needs worker-side `fs` verification); MCP tool surface for reviewers;
mixed-provider fleets (config-ready, unverified); `--on <server>` remote workers;
`check --wait` long-block supervision (the advance-loop needs no daemon); `gate-create` as the
approval UX (cross-Run gate semantics unverified — file approval is primary);
`devin -p` headless batch reviewers (loses supervision; note only).

## 22. Open questions / to verify live

1. Does a consuming `check` on a child-Run-bound terminal also drain that terminal's
   **dispatch** mailbox (parent→supervisor guidance)? Partially resolved by documented fact:
   `check --help` says `inbox --terminal <mailbox>` names `dispatch:<id>` "including mail it
   read before it bound a helper Run" — the dispatch mailbox persists and `inbox` reads it,
   but nothing states a consuming `check` drains both mailboxes. v1 treats
   dispatch-addressed mail to a bound terminal as possibly invisible: parent→supervisor
   uses `send --to run:<childRun>` + artifacts (integration peer concurs, `msg_6b407f7f421c`).
2. `worker-start --terminal` against a `terminal create --command "devin --model swe-2-max"`
   terminal: confirm the Dispatch adopts it and the preamble injects cleanly on Orca 1.4.261
   (low-level-topology reference documents the pattern; integration planner owns live proof).
3. Whether `devin` is accepted by plain `worker-start --agent devin` on this build (help says
   "such as" — non-exhaustive; account + plugin unions confirm the kind exists). If yes it
   simplifies the argv lane to an optional optimisation.
4. `gate-create`/`gate-resolve` semantics across the parent/child Run boundary (nice-to-have
   approval UX only).
5. Plugin worker `fs` access for a future read-only observer panel.
6. Exact `task-list --ready` semantics for `--deps` chains (Tasks for reviewers can also gate
   launch order; we use the file gate as primary).

## 23. Sources

`orca status --json` (1.4.261); `orca skills get orchestration` + references
`coordinator-loop.md`, `messaging-and-gates.md`, `placement-and-remote.md`,
`recovery-and-cleanup.md`, `low-level-topology.md`; `orca skills get orca-cli`;
`orca skills get orca-plugin-authoring` + references `host-api.md`, `events.md`;
`--help` for `orchestration {worker-start,send,check,run-create,task-create,task-list,
task-update,gate-create,gate-resolve,gate-list,dispatch,inbox,ask,worker-list,worker-show,
worker-read}` and `terminal create`, `agent launch`; `devin --help`; peer mail from
review-methodology (`msg_05e21acde272`, `msg_93625fa8064e`) and orca-integration
(`msg_b17ad05cb0ad`, `msg_6b407f7f421c`) planners; coordinator rulings `msg_ed798c8861f0`,
`msg_53a6dd811433`.
