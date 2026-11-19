# Verification record

The Orca-first CLI/skill v0.1 completes the council protocol. A real reduced
council produced an explicitly partial report; automated tests also exercise
a complete 15-seat lifecycle. These are different levels of evidence.

## Automated checks

On 2026-11-19, Windows Node 26.7.0:

- `npm test`: clean TypeScript build and 285 passing tests, zero failures
  after the guarded-cleanup repair.
- `npm run typecheck`: passed.
- `node test/fixtures/review-target-check.mjs`: passed; all four deliberately
  seeded defects still reproduce and the hostile-document note remains.
  This confirms fixture integrity, not correctness of the fixture product.
- Linux CI on Node 22/24 passed for the final source repair,
  [commit e431bda](https://github.com/Toom68/multiagentcouncil-orca/actions/runs/44399699955),
  [the evidence-format prompt repair, commit 0b2bbb7](https://github.com/Toom68/multiagentcouncil-orca/actions/runs/44397310228),
  and the earlier
  [reconciliation hardening, commit d2fe7e7](https://github.com/Toom68/multiagentcouncil-orca/actions/runs/44394430137).
- `doctor --json` reported `ready:true` for Node, Orca, live Orca status,
  and Devin. Optional Claude/Codex binary detection does not validate those lanes.

The tests cover approval refusal/invalidation, independent input separation,
strict output schemas, claim provenance and dissent, citation rejection,
budgets, deadlines, process handling, unknown outcomes, locking, drift checks,
and crash recovery. `test/engine.test.ts` includes a fake-host 15-seat run
with 48 fresh phase Tasks and a complete report. Fake-host tests do not prove
live agent behavior or throughput.

## Real Orca run

Post-release startup regressions from the first OSINTGPT setup increased the
local suite to 303 passing tests. The repair separates long review briefs from
Orca Run labels, pauses on trust/unproven readiness, and preserves supervisor
resource evidence. A fake-host crash seam checks that attach intent is durable
before the host call; malformed custody ledgers refuse reuse. This is automated
recovery evidence, not a new live council or proof of new provider integrations.

Host: Orca 1.4.261 on Windows; Devin CLI 3000.11.92, pinned `swe-2-max` with
`--permission-mode dangerous` (the explicitly requested bypass posture).
No fallback model was used.

The target was an ignored copy of the tracked Fieldnotes fixture, separate
from its answer key. The completed council is
`crun_01M7QF3H30KGXZJ2DXMZ8AGFVX`, child Orca Run `run_29e9a8ec4853`.
Its report timestamp is `2026-11-18T20:50:28.821Z` (19 November in Brisbane).
The configuration requested 10 perspectives, selected 2 seats, concurrency 2,
one discussion round, an 8192-byte envelope limit and 17 phase launches maximum.
Actual consumption was 7 phase launches. This count excludes the supervising
wrapper and development/diagnostic workers.

| Phase | Task | Dispatch |
| --- | --- | --- |
| Organiser | `task_4e757dfde09e` | `ctx_0c5cc9ffa889` |
| Spec reviewer: independent | `task_7cf63898711e` | `ctx_7e4ec1070411` |
| Access reviewer: independent | `task_1742224df883` | `ctx_c7be6e3f40ee` |
| Separate scribe: notes | `task_d0d308c09be6` | `ctx_68607a186044` |
| Spec reviewer: challenge | `task_a616c023809c` | `ctx_8b84614a672a` |
| Access reviewer: response | `task_3671d49aacc6` | `ctx_fae1e0192221` |
| Separate scribe: synthesis | `task_ba672483c05b` | `ctx_c032111e1e93` |

The organiser proposed ten charters. The primary selected spec traceability
and access-control adversarial perspectives, explicitly chose each seat's
agent/model/permission posture, and approved before reviewer launches.
Approval hash:

```text
411c26932e46cb89bf79eb56893bd0e44904363fa53df10d6aa1b6ca0f9c7733
```

The final `verify --json` reported snapshot `snap_6df5e89a04c20e17` with
`drift:false`, matching recorded/recomputed approval hashes,
`bindingIntact:true`, and `matchesStateHash:true`. The primary remained bound
to its original build Run `run_9e0098940d02` after dedicated supervision.
Reviewers reused their own settled sessions for discussion; the scribe used
a distinct session. Canonical `claims.json`, `report.json`, `report.md`,
`summary.md`, phase outputs, envelopes, and the 81-event journal were inspected.
The store validated the journal's sequence/hash chain; approval is event 13
and the first reviewer launch is event 22. The final report passed
`parseReportFile`, with seven claims, `partial:true`, and one dissent entry.

## Result and limits

Seven canonical claims covered access-control bypass, malformed-user handling,
export field leakage, pagination, page-size clamping, mutable return references,
and the hostile-document note. The four planted code defects were identified.
All claims stayed at `plausible_risk`; neither asserted reproductions nor
model agreement were promoted to independently verified truth.

The report is **partial**. Both reviewers wrote seven raw findings, but the
spec review was rejected at admission: `findings[4].counterEvidence[0]` and
`findings[6].counterEvidence[0]` were strings where Evidence objects were
required. Only the access review supplied admitted independent findings;
quorum 2 was not met. The failed seat and nine uncovered perspectives are
visible in coverage. The later spec-reviewer challenge was admitted and the
access reviewer defended its claim; the unresolved disagreement over the
malformed-user claim's high severity remains in the ledger.

Two quoted evidence snippets failed snapshot matching and were excluded.
Five discussion assignments were omitted by size/cap limits. Only two of
seven claims reached a challenge envelope, with one actual challenge filed.
The report records these omissions rather than implying comprehensive debate.
The reviewer prompt now gives an explicit Evidence-object example and asks
for a field-type self-check. That is cooperative guidance, not automatic
repair or proof that future agents will always return valid output. The live
run was not rerun after this wording change.

## Recovery and cleanup

The same persisted council survived the Orca crash. Its dedicated supervisor
rebound to the saved child Run through the product's `--as-supervisor` mode.
An earlier task-create had definitively returned “Nothing changed” with request
`74a45889-c510-491e-9598-26264fc8f5c7`. The explicit `reconcile` command
correlated the exact attempt/spec, created Task `task_7cf63898711e`, persisted
it, and resumed without editing run state by hand. Tests additionally exercise
unknown-outcome refusal, malformed ledgers, unique-task adoption, and concurrent
reconciliation under a run lock.

An initial settlement mapping missed Orca's explicit `state:succeeded` when
the terminal was retained and physical liveness unverifiable. The repaired
adapter admitted real completed phases without equating success to process exit.

The original journal's four final `worker.released` events claim
`released:true`. They are **not reliable release evidence**: the then-current
adapter treated any `ok:true` envelope as release. A single later guarded
release diagnostic on the final scribe Dispatch returned:

```json
{
  "ok": true,
  "result": {
    "dispatchId": "ctx_c032111e1e93",
    "state": "retained",
    "reason": "user_requested",
    "processAction": "none",
    "archive": null
  }
}
```

The diagnostic request was `d70f3797-f13a-422f-a341-2b31ea4b8789`. It was
not retried or forced. The source repair now requires explicit disposition
proof; the exact retained receipt is a regression case. The historical
journal remains untouched. No claim is made that all sessions physically
exited or that the new cleanup mapping was validated by a forced live release.

## Unverified scope

Live evidence covers the local Devin lane at small scale, including partial
failure and recovery. Fifteen-seat live load, long-run stability, remote hosts,
other agent CLIs, and direct Claude/ChatGPT app integrations remain unverified.
The protocol/host boundary leaves room for them; v1 ships a local CLI and an
agent skill, without an MCP server or native Orca plugin.

Reviewer edit, peer-read, egress, and within-session token/tool limits are
cooperative prompt rules. The runner validates admitted artifacts and detects
source drift; dangerous permission mode does not supply a sandbox.

Raw local session artifacts remain ignored under `.council-dev/`. This record
includes correlation IDs and aggregate findings without publishing credentials,
private runtime state, or worker transcripts. Reproduce the procedure with
[USAGE.md](USAGE.md) and the tracked fixture; new model output will vary.

## Public-use extension (2026-11-19)

The discovery/provider-neutrality extension adds `src/catalog.ts` (versioned
launch policy + fingerprint), `staff`/`execution`/`AgentChoice.profile`
contract fields, the engine execution-policy boundary, catalog-wired CLI
(`init` staff requirement, `catalog`, staff-aware `doctor`, catalog-aware
`verify`, catalog-resolved `start-supervisor`), the zero-dependency
installer (`scripts/install.mjs`), the runtime locator
(`skills/council/scripts/council.mjs`), and a slimmed skill entrypoint with
bundled references.

Automated evidence on Windows Node 26.7.0: clean `tsc` build and **385
tests, 384 pass, 0 fail, 1 skip** (a Windows file-symlink privilege case;
junction variants run). Coverage includes: exact catalog argv rendering and
refusals (unknown agent, unsafe model/profile/effort, no fallback),
inherited-property safety, policy-hash mismatch blocking before any host
mutation, missing-policy and invalid-staff refusal at init and approval,
mixed-provider staff/seat lifecycle, legacy runs as an unchanged fixed
point, legacy approval-hash pin, catalog fingerprint capture/drift/legacy
verify, selected-lane supervisor launch (including a codex named-profile
lane), supervisor-pin reuse refusal, doctor staff gating, and
install/update/uninstall conflict + junction/foreign/pointer preservation
cases against isolated temp homes.

**Discovery forward-test (live, free Devin `swe-2-max`).** A disposable
folder workspace (`.council-dev/discovery-target/`) received a real
project-scope install via `node scripts/install.mjs --project <dir>` —
`.agents/skills/council` + `.claude/skills/council` copies and manifest
pointers only, no user-scope writes. A fresh Devin session
(`devin --model swe-2-max --permission-mode dangerous`, model shown in TUI)
was given a natural-language "spin up a council" request with no skill or
CLI path. The agent discovered the installed skill on its own, drove every
command through `scripts/council.mjs` (locator → manifest pointer → this
checkout's `dist/src/cli.js`), ran `catalog --json` and `init`, and stopped
as instructed before any supervisor/roster/approval/reviewer launch. The
persisted run `crun_01M7RER8AJWTXASDVA3YZCGQHG` shows `status:initialized`,
the explicitly chosen staff verbatim, and `execution.policyHash` equal to
the shipped `LAUNCH_POLICY_HASH`. This proves discovery → locator → CLI
wiring → catalog validation on the Devin lane only.

Honest limits of this evidence:

- `worker-start` cannot pin a Devin model (host refuses `--model`; the
  agent's own config selected `swe-2-flash-max`, also Free). The first
  attempt was stopped deliberately — dispatch `ctx_33f998f8890b`,
  `ptyKilled:true` — and the test was rerun on a terminal pinned by
  `--command` instead. Model choice for an `--agent devin` launch follows
  the account's own configuration; the shipped catalog never selects it.
- The forward-test exercised `init` only; no council worker launched, no
  supervisor, no reviewer. A mixed-provider live council remains untested —
  `claude`/`codex` lanes are help-verified, never live-verified.
- Minor UX note surfaced by the test agent: `init --help` exited
  `config_invalid`. Fixed in a follow-up commit — `<command> --help`/`-h`
  now prints usage and exits 0 before any flag, config, or host resolution,
  covered by a CLI regression test.
- The disposable fixture, its installed skill copies, and the initialized
  run remain under `.council-dev/` (ignored) as evidence; no real user
  install was performed.

**Codex live-lane smoke (user-authorized, 2026-11-19).** On disposable
fixture `.council-dev/live-codex-target/` a run `crun_01M7RFXHW0YCBKDK41NAVDYGZ5`
was initialized with staff `devin+devin+codex` (supervisor `gpt-6.1-sol`,
`bypass` → `--sandbox danger-full-access --ask-for-approval never`).
`start-supervisor` launched `terminal create --command` with exactly that
argv (`term_2a5a158f`, task `task_601ba09ed33f`, dispatch `ctx_230c57b14d8c`,
Orca-observed `provider: codex`, TUI pinned `GPT-6.1-Sol`). The codex agent
consumed the supervisor spec, ran the prescribed
`supervise --advance --as-supervisor` verbatim, parsed the JSON action, and
reported a protocol-correct `worker_done` (`msg_653c3c28177c`) when the run
was found cancelled; `cancel` confirmed every live participant stopped.
Codex lane verification is upgraded to `live-verified` for this scope:
bring-up, model pin, spec intake, one advance, clean cancel — no full
council seat run yet. `claude` remains help-verified.

Found during the smoke and fixed in the same change: the
`start-supervisor` success payload reported the legacy `SUPERVISOR_COMMAND`
(`devin --model swe-2-max ...`) as `command` even on a codex lane — a
cosmetic misreport (the persisted `supervisor/startup.json`, emitted argv,
and host calls were always correct). The payload now echoes the recorded
lane command; a test pins it.

## Council repair round (2026-11-19, prompts/docs lane)

A 15-seat live council `crun_01M7RQP9MT8C6PE2MSW48KW3GK` completed the
protocol but admitted only 3 of 15 seats. Inspecting its `report.json` and
journal directly shows 21 claims, quorum 11 unmet, 14 admitted challenges
and 0 applied responses; dominant rejection causes were finding titles over
the never-documented 200-char cap, malformed `evidence`/`counterEvidence`
shapes, and challenge-id collisions (many seats minted the same bare
`C-1`). A separate scribe produced notes that nothing then consumed, and a
`revise` response was rejected for a missing `revisedFinding`. These are
artifact observations, treated as hypotheses during the repair, not assumed
root causes.

Prompt/spec changes implemented and tested in `src/prompts.ts` +
`test/prompts.test.ts`:

- Every output spec states the validator-enforced caps verbatim, read from
  `src/validation.ts`: `title` ≤200, `note` ≤2000, `snippet` ≤1000,
  `steps`/`observed` ≤4000, `path` ≤240, `remedies`/`openQuestions`
  ≤10×≤500, `notes` ≤4000, `evidence` 1–20, `counterEvidence` ≤20,
  `confidence` ∈ [0,1], ids ≤128, challenge/response `argument` ≤4000 and
  `evidence` ≤10, scribe-notes and synthesis bounds.
- `evidence`/`counterEvidence` elements shown as Evidence **objects**
  (`{"kind":"reasoned","note":"…"}`), never bare strings; specs require a
  field-type self-check by inspection — no `council validate`-style command
  exists and none is claimed.
- Fail-closed citation rules stated (path requires `startLine`, `snippet`
  verbatim inside the cited range, no whole-file fallback, no
  whitespace-only snippets, cited file must match the approved snapshot),
  matching the ledger owner's announced validation landing.
- Independent-review seal explicitly covers synthesis/roadmap charters:
  peer claims do not exist in that phase and arrive only via later bounded
  envelopes.
- Challenge specs say workers mint locally-unique ids (`C-1`, …) that the
  runner qualifies to `ch-r<round>-<32 hex>` per challenger/round;
  response specs require verbatim echo of the qualified id stamped on the
  embedded challenge. The qualification formula is landed in
  `src/contracts.ts` (`Challenge.localChallengeId`, `challengerPid`).
- `counterexample` challenges documented as requiring ≥1 `evidence` item
  (ledger-announced parser rule).
- Optional `repair?: RepairContext` implemented on all six builders exactly
  as landed in `contracts.ts`: verbatim diagnostics in a delimited
  ```text``` block, untrusted data never instructions, bounded to the
  assigned artifact, recorded rejection reasons — not a promise of
  admission (the whole revised artifact is re-validated and may surface
  further issues).
- `scribeSynthesis` emits only the slim `SynthesisFile`
  (`summary`/`limitations`) the runner reads, consumes admitted scribe
  notes via `notesPath` as a non-authoritative prior read, and frames its
  narrative as a self-checked authored layer alongside the runner's
  deterministic run facts — no claim that a validator checks the prose.
- Boundary honesty corrected: managed artifacts (ledger, envelopes,
  journal, peer outputs) are READ, not ignored; `.council`/`.council-dev`
  are excluded from the snapshot manifest (verified
  `SNAPSHOT_EXCLUDED_DIRS` in `src/snapshot.ts`); the journal hash chain
  detects inconsistent edits, not coherent same-host rewrites; edit/egress
  rules remain cooperative, never sandboxed.

Docs corrected in the same lane: `staff` mandatory at `init` (stale
"future/optional" wording removed), drift recovery = start a NEW run
(pinned snapshots are immutable; no re-snapshot path), `quorumRatio`
documented as an admitted-findings coverage diagnostic not a gate,
`.council` exclusion noted in USAGE, `AgentChoice.profile` and the new
`PromptBuilder` signatures/`SynthesisFile` in `docs/design/CONTRACTS.md`,
README status records the 15-seat partial run honestly.

Checks (macOS Node 26.8.1): focused TypeScript compile of
`src/prompts.ts` + `test/prompts.test.ts` + their imports clean;
`node --test` on the compiled prompts suite: **93 passing, 0 failing, 11
suites**. During peer integration, whole-project `npm run typecheck`
transiently showed errors only in other workers' in-flight files
(`src/engine.ts`, `src/host/orca.ts`, `test/claims.test.ts`); after their
landings the whole-project `npm run typecheck` is clean.

Limits: these are spec/wording repairs and prompt-level tests — they do not
prove a future live council will produce schema-valid output, and no live
rerun has been executed. Post-write verification: `parseSynthesisFile`
(summary ≤8000, limitations ≤20×1000, generatedAt ≤40 — exactly the caps
the spec states) and the `counterexample` ≥1-evidence rule have since
landed in `src/validation.ts`; `qualifiedChallengeId` is exported from
`src/claims.ts` with the documented `ch-r<round>-<32hex>` form.


## Integrated repair verification (primary orchestrator, 2026-11-19)

This section supersedes the mid-edit interface/build caveats in the prompts/docs
lane entry above. All announced parser and builder interfaces are implemented.
The primary orchestrator independently ran `npm test`: **501 tests passed,
0 failed, 25 suites**, on local macOS Node 26.8.1. `git diff --check` passed.
The original baseline was 383 passed / 3 failed; the symlink/path regressions
now pass. These are automated tests with fake-host orchestration effects,
not a live Orca council rerun.

| Council finding | Implemented disposition |
| --- | --- |
| clm_0001, clm_0005 | Canonical entry guards and macOS/symlink regression checks; CLI/install stage independently passed 93 tests. |
| clm_0002 | Full approved AgentChoice equality including profile, checked at reapproval and launch. |
| clm_0003 | Journal-derived per-recipient mail accounting; uncertain intents reserve budget. |
| clm_0004, clm_0006 | Immutable snapshot recovery says create a new run; staff/profile/invocation documentation aligned. |
| clm_0007 | Quorum counts admitted independent findings; below-quorum reports are explicitly partial diagnostics. Quorum is documented as a coverage diagnostic. |
| clm_0008–clm_0010 | Cited file bytes must match snapshot hash/size; snippets must be nonblank and match the cited range; citation-shaped fields are checked on every evidence kind. |
| clm_0011–clm_0013 | Grades recomputed after evidence changes; qualified challenge identities, exact response claim/round binding, all-author routing, bounded envelopes with visible omissions, provenance-preserving folds. |
| clm_0014 | Preserve honest challenged/defended/revised/withdrawn/escalated states. No vote-based confirmed/resolved claims were added; legacy enum values do not imply a verification facility exists. |
| clm_0015–clm_0017 | Retain remedies, open questions, challenger evidence and per-author assessments; dedupe uses overlapping admitted citation ranges rather than same-file membership. |
| clm_0018–clm_0020 | Deterministic facts precede labelled narrative, limitation authorship retained, pluralization repaired, slim synthesis contract with legacy compatibility. |
| clm_0021 | Admitted scribe notes explicitly supplied to final synthesis. |

The independent recovery audit reproduced additional append-success/state-save-
failure gaps despite the earlier 490 passing tests. Added regression cases cover
run identity restoration, lost planned/corrective attempts, durable launch charges,
corrupt-journal refusal, uncertain request evidence, oversized diagnostics and
pre-mutation stop/release/mail custody. Recovery uses exact identities and never
interprets an empty/pruned host listing as proof that a mutation did not happen.
Legacy markerless intents remain uncertain. Journal appends handle short writes
and fsync before success.

Remaining boundaries: a same-host writer can coherently rewrite local artifacts;
reviewer edit/egress restrictions are cooperative; narrative validation is not a
proof of prose faithfulness; deadlines and recovery need an external advance
(no timer daemon); uncertain stop/release/mail intents can remain unresolved.
Same-title findings without citations still use the documented title/kind merge
fallback. The independent recovery re-audit passed RA-001 through RA-009 using the original fake-host probes and call-count checks. A bounded live rerun remains pending at the time this verification entry is written.


The ledger stage (`667de44`) was independently validated in an isolated checkout
with only its required API call-site glue: **442/442 tests passed**. The integrated
engine/prompt stage (`1940b18`) has **501/501 tests passed** and passed the
independent repeat of the original recovery probes. In particular, the repeated
run-creation probe now issued zero createRun calls, restored the journaled run
identity, and the lost corrective-attempt probe issued exactly one repair launch.
The corrupted-journal probe returned journal_corrupt with zero host mutations.
These probes use fake hosts and do not establish live Orca behavior.


## Live validation restart observation (2026-11-19)

The repaired runtime started a real Orca council against the Fieldnotes fixture:
`crun_01M7RZE6YCB77MYHWX17YVH9PQ`, 15 selected Devin SWE-2 Max reviewers,
concurrency 5, one discussion round, two findings and one challenge/response per
seat, maxLaunches 100, quorumRatio 1. The primary reviewed and persisted the exact
roster approval before reviewers launched. This smaller per-seat output budget
bounds the live acceptance workload; it is not a full default-budget load test.

An Orca restart destroyed the supervisor terminal and five unfinished reviewer
terminals. Orca reported their dispatches abandoned/failed; they were not silently
re-launched. The primary resumed coordination of the existing child Run through
Orca's documented run-use command and advanced manually. The engine reconciled
the five failed reviewers, retained eight admitted independent findings files,
and launched the two previously unstarted seats. The recorded launch count is
16 (organiser plus 15 independent reviewer attempts). The recorded supervisor
identity remains historical; no replacement identity or approval was forged.

`council verify` after restart reported no fixture drift, the exact approval
binding intact and matching current artifacts, and the catalog fingerprint intact.
Thus the restart preserved admitted artifacts and approval while exposing lost
coverage honestly. At this observation the run is still in independent_review;
discussion routing and applied author responses are not yet established by this
live attempt. Because five selected seats failed, a later report must remain
partial. Automated 501-test and fake-host re-audit results remain separate from
this live evidence.


### Live independent phase closed

The resumed fixture run closed independent review with **10/10 returned findings
files admitted**, five restart-lost seats failed, and **zero artifact/evidence
rejections** in its journal at that boundary. It built 20 canonical claims;
remedies survived on all 20 and open questions on 17. Thus the live returned-output
admission and the previously dropped useful-output fields are exercised with
actual Devin outputs. This does not replace the missing five perspectives.
A separate scribe-notes worker launched; discussion and final synthesis remain
pending.


### Live retained-terminal preflight blocker

After scribe notes were admitted, the first challenge phase attempted to reuse a
reviewer terminal destroyed by the Orca restart. `terminal show` returned
`terminal_handle_stale` during the read-only readiness check; no worker-start
receipt/request/dispatch existed for the challenge. The adapter nevertheless
classified this preflight as uncertain, so the engine conservatively blocked
rather than taking its known-failure fresh-session fallback. The journal records
that block at event 177. This is additional live evidence and a new adapter fix;
it is not a successful discussion or a completed acceptance run.

The primary cancelled this interrupted run without rewriting its evidence or
approval. Cancellation retained one explicitly unverifiable challenge attempt
(no dispatch ID); it did not claim the process was stopped. A Devin SWE-2 Max
worker is assigned a narrow retained-terminal preflight classification fix with
regressions that keep transport errors, human prompts and newly-created-terminal
ambiguity conservative. A fresh live validation follows after that fix.


### Stale retained-terminal fix verified

The retained-terminal readiness path now recognizes only the recorded
`terminal_handle_stale` error as a known pre-attach failure. This enables the
engine's existing bounded fresh-session fallback. Trust/permission prompts,
wrong/unknown agents, transport failures, and ambiguity after creating a fresh
terminal remain uncertain, with custody preserved.

Primary verification: `npm test` **504/504 passed** (including **81 Orca adapter
tests**). The seeded-fixture CLI test now operates on a clean temporary copy,
excluding existing `.council`/`.council-dev` artifacts; prior live evidence remains
untouched. A live preflight probe against the actual vanished handle returned
`failed`, stage `readiness`, code `terminal_handle_stale` after exactly
`orchestration worker-list` and `terminal show`. Both results came from the real
Orca CLI; a process guard refused any mutation if unexpectedly attempted. Thus
this is live read-only preflight evidence, not a full live worker/review cycle.
Fresh full-protocol validation follows this fix.
