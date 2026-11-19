# Shared contracts — frozen v1

Source of truth: `src/contracts.ts`. Everything is JSON-serializable; all
interfaces return `Result<T>` / `ParseResult<T>` instead of throwing. This file
states the exact module boundaries dependent workers implement against. Do not
create parallel type systems or per-module schema variants. Interface-change
requests go to the contracts owner via the coordinator only.

Frozen decisions encoded here (from `IMPLEMENTATION.md`): a **fresh
orchestration Task per phase** even on a retained terminal (`WorkerLaunchSpec.
reuseTerminal` + `Participant.retainedTerminal`); **uncertain outcomes are
reported, never retried silently** (`LaunchResult.outcome === 'unknown'` +
retained `requestId`); **adapters never consume caller mail** (no check/ack —
observation via worker records + bounded `inbox`); **reviewer-asserted grades
are untrusted** (`Finding.assertedGrade` vs derived `Claim.grade`).

## `src/contracts.ts` exports

### Results / errors

- `ValidationIssue { path, code, message }`
- `ParseResult<T> = {ok:true; value:T} | {ok:false; issues: ValidationIssue[]}`
- `CouncilErrorCode` — `'schema_invalid'|'config_invalid'|'roster_invalid'|'approval_required'|'approval_stale'|'invalid_transition'|'barrier_refused'|'budget_exceeded'|'deadline_exceeded'|'untrusted_output'|'snapshot_drift'|'adapter_error'|'launch_unknown'|'io_error'|'cancelled'|'unsupported'`
- `CouncilError { code, message, issues?, details? }`
- `Result<T> = {ok:true; value:T} | {ok:false; error: CouncilError}`

### Id aliases (all `string`)

`CouncilRunId, OrcaRunId, TaskId, DispatchId, TerminalHandle, MessageId,
PerspectiveId, ParticipantId, SeatId, FindingId, ClaimId, ChallengeId,
AttemptId, SnapshotId, ApprovalId`; `SCHEMA_VERSION = 1`.

### Config / agents

- `CouncilConfig` — resolved shape (defaults applied): `requestedPerspectives`
  (10–25, def 15), `participants` (def 15), `concurrency` (5), `rounds` (1–3,
  def 1), `quorumRatio` (0.67), `maxLaunches` (default = workflow minimum +
  slack, see below), `maxFindingsPerSeat` (7),
  `maxChallengesPerSeatPerRound` (3), `maxResponsesPerSeatPerRound` (3),
  `envelopeBytes` (8192), `maxMailPerParticipant`, `maxTextChars`, `deadlines`.
  Launch budget: every phase is a fresh Task, so a complete run needs
  `participants + 2·participants·rounds + 3` launches before retries;
  `minViableLaunches(config)` gives that minimum and `resolveConfig` refuses
  an explicit `maxLaunches` below it.
- `PhaseDeadlines` — `{organiserMs, independentMs, scribeNotesMs, challengeMs,
  responseMs, synthesisMs, runMs, graceMs}`. Deadline enforcement is
  wake-driven: evaluated inside `advance` calls; there is no daemon.
- `quorumRatio` — coverage diagnostic, not a gate. The quorum measure counts
  reviewers with **admitted** independent findings against
  `ceil(quorumRatio × selectedSeats)`; settled-but-rejected seats do not
  count. A below-quorum run emits an explicitly partial diagnostic report —
  never success-looking coverage.
- `AgentChoice { agent, model, effort?, permissionMode, profile? }` —
  explicit, approval-bound, token-charset validated; no model fallback.
  `profile` is an optional named CLI profile (Codex `--profile`), part of
  the approved seat identity.

### Roster / approval / snapshot

- `Perspective { perspectiveId, name, charter{incentives,expertise,method,blindSpots,reviewQuestions[]}, tags[] }`
- `ProposedRoster` (roster.proposed.json): `perspectives[]` = exactly
  `requestedPerspectives`, unique ids.
- `SeatAssignment { seatId, perspectiveId, participantId, agent }`
- `ApprovedRoster` (roster.approved.json): `seats[]` = exactly `participants`;
  unique seat + perspective ids; each perspectiveId ∈ proposal.
- `SourceSnapshot { snapshotId, targetRoot, gitHead|null, takenAt, headHash,
  files: Record<path,{sha256,size}> }`; `SnapshotDrift { drift, changed[] }`.
- `ApprovalBinding` — canonical hashed payload `{runId, objective, seats,
  proposedRosterHash, config, snapshotId, snapshotHeadHash}`. The
  `proposedRosterHash` (canonical sha256 of the whole ProposedRoster via
  `canonicalRosterHash`) binds the approved charters and the proposal: editing
  mandates/methods/blind spots/questions or the proposal invalidates approval.
- `ApprovalRecord { approvalId, hash /* sha256 of binding */, approver,
  createdAt }`.

### Worker output files

- `Evidence { kind, note, path?, startLine?, endLine?, snippet?, steps?,
  observed? }`; `code_location` requires `path` (safe-relative) + `startLine`;
  `repro` requires `steps` + `observed`.
- `Finding { findingId, title, kind, severity, confidence, assertedGrade?,
  evidence[], counterEvidence?, remedies?, openQuestions? }`
- `Strength { strengthId, feature, benefit, preserve, evidence[] }` —
  optional worker-asserted preservation record: a specific existing feature,
  the concrete role-specific benefit, what must not be lost, and evidence
  under the identical kind/citation rules as `Finding.evidence`. Bounded by
  `MAX_STRENGTHS_PER_FILE = 3` (a constant, not a config key — the approval
  binding stays byte-stable). `CanonicalStrength extends Strength` adds
  runner-stamped `participantId`/`perspectiveId` — workers never stamp their
  own provenance.
- `FindingsFile` (findings/`<pid>`.json) — independent phase. `findings`
  requires unique `findingId`s (duplicate ids reject the file); optional
  `strengths?: Strength[]` — absent or `[]` both valid, zero is a legitimate
  answer, more than 3 rejects the file, duplicate `strengthId`s reject.
  A strength whose ENTIRE evidence list fails citation checks is dropped
  with a journaled rejection; partial failures keep the surviving items.
- `Challenge { challengeId, claimId, kind, argument, evidence[] }`;
  `ChallengesFile` (rounds/`<n>`/challenges/`<pid>`.json). Challengers mint
  locally-unique ids; the ledger **qualifies** each id by challenger and
  round before routing/history (deterministic, ID_RE-bounded, e.g.
  `ch-r<round>-<32 hex>`), so identical local ids across seats cannot
  collide.
- `AuthorResponse { claimId, challengeId, disposition:
  'defend'|'revise'|'withdraw'|'escalate', argument, evidence[],
  revisedFinding? }`; `ResponsesFile` (rounds/`<n>`/responses/`<pid>`.json).
  Responses echo the qualified `challengeId` from the assignment verbatim.
- `WorkEnvelope<TAssignment> { phase, round, recipientId, assignments[],
  outputPath, outputContract }` — the ONLY way a reviewer sees peer output:
  exactly one recipient, never the transcript. `ChallengeEnvelope`,
  `ResponseEnvelope`, `ChallengeAssignment`, `ResponseAssignment`,
  `ClaimView` (sanitized claim projection).

### Ledger / scribe / report

- `Claim { claimId, title, kind, grade, status, severity, confidence,
  evidence[], counterEvidence[], sourceFindings[], history[], dissent[],
  remedies?, openQuestions?, assessments?, mergedTitles?, challenges?,
  dedupeKey?, rejectedEvidence? }`;
  `ClaimStatus = 'proposed'|'challenged'|'defended'|'revised'|'escalated'|
  'confirmed'|'resolved'|'withdrawn'`; `EvidenceGrade = 'verified_defect'|
  'plausible_risk'|'speculative'|'unsupported'`; `ClaimLedger`,
  `ClaimEvent`, `DissentRecord`, `FindingKind`, `Severity`, `EvidenceKind`,
  `ChallengeKind`, `ClaimAssessment`.
- `ClaimChallenge { challengeId /*qualified*/, round, challengerPid, kind,
  answered, response?{participantId,disposition} }` — one admitted
  challenge's lifecycle on its claim. `answered` is a fact, never a verdict:
  a 'defend' keeps the dispute live, 'revise'/'withdraw' adopt or moot it,
  'escalate' hands it to the orchestrator. `DissentRecord.challengeId?`
  links dissent to the qualified challenge (absent on merge-rating dissent
  and legacy records).
- `ClaimLedger` adds optional `strengths?: CanonicalStrength[]` (runner-
  provenanced, never challenged or graded) and `discussion?: {rounds:
  RoundRoutingRecord[]}` — durable per-round routing records
  (`ChallengeRoutingRecord {routedClaimIds, byteDroppedClaimIds,
  unassigned[]}`, `ResponseRoutingRecord {routedChallengeIds, byteDropped[],
  capOmitted[], unroutable[]}`) separating routed/examined claims from
  never-routed ones and byte-cap drops from plan-level unassigned. Legacy
  ledgers lack both and stay loadable.
- `ReportProvenance { snapshotId, gitHead|null, targetRoot, objective }`
  binds the exported report to the exact source it covers.
  `CouncilReport` adds optional `provenance`, `runnerFacts` (deterministic
  counts incl. `unansweredChallenges?`, `strengths?` count and per-round
  `DiscussionRoundFacts` — filed/answered/unanswered challenges and the
  routed/no-challenge/never-routed claim split), `strengths?:
  CanonicalStrength[]`, and `limitationSources` (provenance-tagged
  runner-vs-scribe limitations). `summary.md` carries the limitations block
  in report order.
- `ScribeNotesFile` — initial scribe pass artifact; an explicit input to
  `scribeSynthesis` via `notesPath` (a prior read, never an authority).
- `SynthesisFile { schemaVersion, runId, participantId, generatedAt?,
  summary, limitations[] }` — the ONLY narrative contract the runner reads
  from the scribe (`parseSynthesisFile`); the runner renders the canonical
  `CouncilReport`/report.md/summary.md itself. Legacy full-report scribe
  artifacts remain accepted via `parseReportFile`.
- `CouncilReport` + `ReportCoverage` + `SeatOutcome` — `coverage.partial`
  visible; failed seats named; a wholly failed run produces no report.

### State / journal

- `PhaseKind = 'organiser'|'independent_review'|'scribe_notes'|'challenge'|
  'author_response'|'scribe_synthesis'`
- `PhaseAttempt { attemptId, participantId, phase, round, taskId, dispatchId,
  terminalHandle, launchIntentId, requestId?, status, artifacts[] }`;
  `AttemptStatus` includes `unknown` and `intent_recorded`.
- `Participant { participantId, role, seatId, perspectiveId, agent,
  retainedTerminal, attempts[], status }`; `ParticipantRole`, `ParticipantStatus`.
- `RunStatus = 'initialized'|'organising'|'awaiting_approval'|
  'independent_review'|'scribe_notes'|'discussing'|'synthesising'|'reported'|
  'failed'|'cancelled'`; `DiscussionCursor { round, stage }`.
- `CouncilState` (state.json) — includes `supervisor {terminalHandle,
  dispatchId} | null`: the supervisor's durable identity so `council approve`
  run by the primary orchestrator can send it an exact wake (file writes alone
  do not wake the agent). `JournalEvent` + `JournalEventType` (finite union,
  `events.jsonl` rows).

## Callable boundaries

### `HostAdapter` — implement in `src/host/orca.ts`

```
createRun({objective})                                  → Result<{runId}>
createTask({runId, specFilePath, title, deps?})         → Result<{taskId}>
launchWorker(WorkerLaunchSpec /* includes runId */)     → Result<LaunchResult>
observeWorker({dispatchId})                             → Result<WorkerObservation>
sendNotification({to, subject, body, taskId?, dispatchId?})
                                                        → Result<{outcome, requestId?, messageId?}>
requestStop({dispatchId, reason})                       → Result<{outcome: 'stopped'|'unknown'|'refused'}>
releaseWorker({dispatchId})                             → Result<{released: boolean}>
```

Constraints: documented Orca CLI only; argv arrays (`shell:false`); **never**
consuming `check`/`--ack`; `unknown` outcomes retain `requestId`; Devin lane =
validated argv (`devin --model swe-2-max --permission-mode <approved>`) via
`terminal create --command` + `worker-start --terminal`; generic lanes may use
`--agent`/`--model` when explicitly configured. Types: `WorkerLaunchSpec`,
`LaunchResult`, `WorkerObservation`, `WorkerLiveness`, `StopOutcome`.

### `Store` — implement in `src/store.ts` as `createStore(options): Store`

```
initialize({runId,targetRoot,objective,config,snapshot}) → Result<void>
loadState / saveState                                    → Result<CouncilState>/Result<void>
withLock(fn)                                             → Result<T>
writeArtifact / readArtifact / artifactExists / listArtifacts(prefix)
appendJournal(events-without-seq)                        → Result<JournalEvent[]>
readJournal()
writeProposedRoster / readProposedRoster
writeApprovedRoster / readApprovedRoster
writeApproval(record, binding) / readApproval
readSnapshot / verifySourceSnapshot                      → Result<SnapshotDrift>
```

Atomic writes; append-only journal; safe-relative paths; machine-readable
errors. `CreateStore` type exported from contracts.

### `PromptBuilder` — implement in `src/prompts.ts` as `createPromptBuilder(): PromptBuilder`

```
organiser(ctx, {participantId, outputPath, repair?})
reviewerIndependent(ctx, {participantId, perspective, outputPath, repair?})   // never sees peer data
scribeNotes(ctx, {participantId, admittedFindingsPaths[], outputPath, repair?})
challenge(ctx, {participantId, envelopePath, outputPath, repair?})
authorResponse(ctx, {participantId, envelopePath, outputPath, repair?})
scribeSynthesis(ctx, {participantId, ledgerPath, journalPath, notesPath?, reportJsonPath, reportMdPath, summaryPath, repair?})
supervisor(ctx, {advanceCommand})
```

`PromptContext` supplies `runId, runDir, targetRoot, objective, snapshotId,
config`. Every builder names exact writable paths, JSON output contract,
budgets, untrusted-content boundary, no-further-agents, honest cooperative
labels for edit/egress restrictions. Optional `repair?: RepairContext
{contract, diagnostics[], previousArtifactPath?}` is present only on the
single bounded corrective attempt for a participant/phase/round —
diagnostics are verbatim validator issues, rendered delimited as untrusted
data, and the spec bounds the retry to repairing only the assigned
artifact. `notesPath` points at the admitted `scribe/notes.json` when it
exists. Spec output rules state the real validator caps verbatim.

### `Engine` — implement in `src/engine.ts` as `createEngine(deps): Engine`

```
advance()   → Result<AdvanceResult{action:'wait'|'needs_approval'|'progress'|'finished'|'blocked', ...}>
approve({roster, approver}) → Result<{approvalId, hash}>
status()    → Result<EngineStatus>
cancel({reason}) → Result<void>
```

`EngineDeps { store, host, prompts, now? }`. `advance` is one bounded,
idempotent reconcile+act step: ingest observations, validate/admit artifacts,
enforce barriers/budgets/deadlines (checked on advance — no real-time claims),
launch due work, persist. `now` is injectable for deterministic tests.
`action === 'progress'` means internal work remains — the caller MAY call
`advance` again in the same turn (bounded loop until a non-progress action;
one-call-per-wake alone can deadlock internal transitions).

### `progress` — implement in `src/progress.ts` (new, v1)

Run-local stage/progress notification surface. Owns everything under
`<runDir>/progress/` — `recipient.json`, `outbox.json` (+ its own `O_EXCL`
lock — never shares `Store.withLock` or the journal), `helper.lease`,
`helper.json`. Never consumes mail, never rebinds the caller, never spawns
agents or provider jobs.

```
captureRecipient({runDir, to?, callerHandle?, callerRunId?, self?, now?})
   → Result<{recipient:{to,source,recordedAt}, changed:boolean}>
```

Persists `progress/recipient.json` — the ONE canonical wake destination —
**before** any supervisor binding change (init + start-supervisor).
Preference: explicit `to` > `callerRunId`→`run:<id>` > `callerHandle`→term_.
Rejects malformed and self/child targets; first durable target wins unless
explicit override; absent on legacy runs = unconfigured, never inferred.

```
createProgressNotifier({runDir, sendMail, now?, readState?, budget?})
   → notifier
notifier.notify(event: ProgressEvent) → Result<{outcome:'sent'|'deduped'|
   'retry'|'unknown'|'error'|'refused'|'budget_refused'|'no_recipient'|
   'skipped_terminal', intentId, delivery?}>
ProgressEvent = {kind:'stage',status,note?} | {kind:'blocked',reason,note?}
   | {kind:'finished',outcome:'succeeded'|'failed'|'cancelled',reportPaths?}
   | {kind:'approval',approver?} | {kind:'heartbeat'} /* helper only */
```

`sendMail` is injected `HostAdapter.sendNotification`. Durable intentIds
dedupe repeats (`stage:<status>[:rN:…]`, `approval:<hash8>`,
`blocked:<sha8>`, `finished:<outcome>`, `hb:<window>`); `unknown` is never
resent, `error`/`refused` retried once. Bounded budgets (stage/heartbeat)
persisted in the outbox — separate from `maxMailPerParticipant`. Message:
subject `council <crun>: <stage>`, body = persisted facts (status,
participant/attempt counts, launch consumption, elapsed/stage age, next
action, reportPaths on finish) + the fixed honesty line that facts do not
verify worker liveness. ≤8192B.

```
ensureHelper({runDir, now?, spawnFn?, helper?{intervalMs=120000,
   maxLifetimeMs}}) → {state:'started'|'already_running'|'skipped_terminal'
   |'no_recipient'|'lease_held'|'spawn_failed', pid?}
```

Argv-spawned detached child `node progress.js helper --run <dir>` — no
shell, no agents. Singleton via `helper.lease` (O_EXCL + stale reclaim);
each tick reads persisted state + journal tail only — NO host
status/observe polls — and exits on terminal state, budget, or lifetime.
`progressStatus(runDir)` is read-only: recipient, delivery counters,
`lastDelivery`, budget, and `helper.state
('running'|'stale'|'dead'|'exited'|'none')` — a dead helper is a visible
gap, never claimed as guaranteed delivery.

Engine calls `notify` post-flush (stage/blocked/finished, approval inside
`approve`); engine/operator call `ensureHelper` idempotently. The
supervisor agent sends no stage mail — its outbound list is unchanged.

## `src/validation.ts` exports (contracts owner, this dispatch)

- `resolveConfig(raw): ParseResult<CouncilConfig>` — apply defaults + validate.
- `parseProposedRoster(raw, {runId, requestedPerspectives}): ParseResult<ProposedRoster>`
- `parseApprovedRoster(raw, {runId, proposed, config}): ParseResult<ApprovedRoster>`
- `parseFindingsFile(raw, ctx): ParseResult<FindingsFile>`
- `parseChallengesFile(raw, ctx)`, `parseResponsesFile(raw, ctx)`
- `parseChallengeEnvelope(raw, ctx)`, `parseResponseEnvelope(raw, ctx)`
- `parseScribeNotesFile(raw, ctx)`, `parseReportFile(raw, ctx)`,
  `parseSynthesisFile(raw, ctx)` — the slim scribe narrative contract;
  `parseReportFile` remains for legacy full-report artifacts.
- `parseClaimLedger(raw, ctx{runId?})` — re-read parser for claims.json so
  managed artifacts are parsed on consumption, never trusted casts.
- `parseSourceSnapshot(raw): ParseResult<SourceSnapshot>`
- `parseApprovalRecord(raw)`, `parseApprovalBinding(raw)`
- `parseCouncilState(raw)`, `parseJournalEvent(raw)`, `parsePhaseAttempt(raw)`,
  `parseParticipant(raw)`
- `assertSafeRelativePath(path): ParseResult<string>`
- `minViableLaunches(config): number` — `participants + 2·participants·rounds
  + 3`, the workflow launch floor `resolveConfig` enforces.
- `maxClaimGrade(evidence, opts?): EvidenceGrade` — honest grade ceiling; a
  reviewer-asserted `verified_defect` can never pass through.
- `canonicalApprovalHash(binding): string` — deterministic sha256 (sync,
  Node `crypto`).
- `canonicalRosterHash(roster): string` — canonical sha256 of the whole
  ProposedRoster; the value stored in `ApprovalBinding.proposedRosterHash`.
- `DEFAULT_CONFIG: CouncilConfig` — frozen approved defaults.
- `err(code,message,extra?)`: `CouncilError`; `fail(path,code,message)`:
  `ValidationIssue`; `parseFail(issues)`.

All parsers are pure, synchronous, dependency-free, and bound sizes/text/enum
values per `CouncilConfig`/frozen caps.
