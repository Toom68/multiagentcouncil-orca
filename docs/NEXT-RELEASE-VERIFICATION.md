# Next release verification

This records integrated stages of NEXT-RELEASE-PLAN.md. Automated checks are
labelled separately from the bounded live Orca run. The local raw logs and run
artifacts are ignored by Git; this document retains the reviewable results.

## Stage 1: charter provenance and independence

The organiser now knows its charter text becomes descriptive reviewer assignment
data. Reviewer instructions identify the charter as organiser-authored and
orchestrator-approved, authoritative for review scope but unable to grant
permissions or override protocol rules. Independence accurately excludes peer
findings and discussion while naming the approved charter as an exception.

README's verification label now reflects the existing recorded evidence:
Devin full live councils; Codex bounded supervisor launch only; Claude remains
help-verified. This stage performs no additional provider launch.

Primary verification: isolated source snapshot based on `adf40d7`, containing
only these prompt/README changes and four accompanying prompt checks. Full
`npm test`: **508 passed, 0 failed, 0 skipped**. Source hashes and complete
output are retained locally in the ignored `.council/next-release` directory.
The initial snapshot setup accidentally left source unchanged; that run was
discarded, patch application was checked against base bytes, and the corrected
snapshot was tested before staging the exact verified file contents.

Structured strengths, stage notifications, recovery and integrity changes are
still separate in-progress stages. This is automated verification, not a new
live council or evidence of new runtime behavior.

## Stage 2: contracts, ledger and safe reporting

Integrated additive strength, challenge-lifecycle, routing and provenance
contracts; typed ledger/envelope/receipt parsers; canonical strengths with
runner-stamped provenance; and separate answered/unanswered challenge facts
while retaining dissent. Empty strengths remain valid. Reports include
limitations and preserve untrusted prose as inert markdown while JSON retains
the original text. New custody callback interfaces are optional pending engine
and adapter integration.

Primary verification used an isolated snapshot based on `5f6e1ab`, with only
the four contracts/validation/claims/report modules and their four test files.
Full `npm test`: **541 passed, 0 failed, 0 skipped**. Independent primary probes
confirmed duplicate challenge and response identities reject, valid local IDs
remain usable across seats/rounds, an existing 45-claim report still parses,
malicious headings/HTML/links stay inert, and JSON strings remain unchanged.
Exact source hashes, probes and logs remain under `.council/next-release`.

This is the protocol/reporting foundation. Engine routing records, complete
strength rejection diagnostics, export provenance and new reviewer prompts
require the subsequent integration stage. Progress delivery, artifact custody
and operator recovery still require independent audits and end-to-end checks.

## Stage 3: host custody and complete ledgers

Mutations with unknown errors remain uncertain. Terminal-create intent/receipt
callbacks preserve returned identity even if persistence throws, and local argv
validation precedes any recorded mutation. Retained-terminal checks normalize
supported terminal identities and refuse unreadable custody. Worker listings
follow bounded cursors and validate complete cumulative totals, row overlap,
scope and metadata types; incomplete or contradictory listings never mean an
empty ledger. A start without dispatch identity reports uncertainty.

The primary tested an isolated snapshot based on `f0b9885` containing only
`src/host/orca.ts` and `test/orca.test.ts` changes: **591 tests passed, 0 failed,
0 skipped**. All **64 independent audit checks** pass, plus eight malformed
metadata probes. Two recorded probe adjustments preserve their intent: cursor
cycle fixtures use distinct rows so the new overlap guard cannot mask that
test, and totals smaller than delivered rows now require rejection.

Read-only compatibility verification used the real Orca CLI: the strict adapter
accepted **37 worker rows across four pages** with a requested page size of 10,
and **31 task rows**. This verifies listing compatibility; it launches no worker
and is not a new live council. Exact tested bytes, probe adaptations and logs
remain in the ignored local verification directory.

The frozen pre-progress-fix integration snapshot passed 693 tests. Independent
probes found notification recovery gaps in that snapshot; stage 4 records the
corrected implementation and its verification.

## Stage 4: integrated recovery and progress

The integrated release adds journal-authoritative exact-byte artifact receipts,
typed artifact rereads, guarded supervisor replacement, issued-stage startup
custody, journal-bound read-only verification, and idempotent participant and
attempt recovery. It carries optional evidence-cited strengths, dissent and
challenge history, disjoint routing limits, source provenance, and markdown
safe for untrusted reviewer text. Progress uses a persisted primary recipient,
durable outbox intents, stage wakes and a two-minute helper heartbeat. Outbox
corruption and uncertain delivery fail closed; silence is never treated as
proof that a worker died.

The primary froze all 21 remaining changed files against `24bf3b5` and ran the
full suite on that exact snapshot: **732 passed, 0 failed, 0 skipped**. The
supervisor recovery probe passed **45/45** after updating one assertion from
the old generic error wording to the new `launch_unknown` refusal. The
read-only status/verify probe passed **31/31**, including the fixed
mid-journal corruption refusal. Independent recovery audits covered 211 checks
on the completed core snapshot; only the CLI closeout changed afterward, so
the primary reran the affected CLI probes and retained the earlier core checks
with their source hashes. The primary also repeated 48 notification/helper
probes against the corrected core snapshot and exercised corrupt/deleted
outbox and directory-fsync failures without resending uncertain mail.

Commit `b93a9b2` contains the integrated snapshot and was pushed to main. A
live-run observation found two progress-display defects: a helper diagnostics
record with `exitReason: null` was labelled exited despite its live PID, and
the fresh organiser stage suggested re-approval before any approval existed.
Commit `4370a1d` fixes both. TypeScript compiled cleanly and all **50/50**
focused progress checks passed, including regressions for those cases. The
active live run kept the prior built code; the following end-to-end evidence
is therefore for the `b93a9b2` runtime. After the live run, the primary rebuilt
and reran the full suite on `4370a1d`: **732 passed, 0 failed, 0 skipped**.

## Stage 5: bounded live Orca council

The primary ran `crun_01M7SV2AXNJECSFBXG8VG7VES9` against a disposable,
fictional 12-file Node library fixture, not this repository. The target was
reviewed read-only. Its configuration requested ten organiser perspectives,
selected four distinct Devin `swe-2-max` seats, limited concurrency to two,
used two discussion rounds, and capped launches at 50. Explicit roster
approval was persisted before any reviewer launched. The organiser, four
reviewers, scribe notes, both challenge/response rounds, and scribe synthesis
all completed with **19/50 launches**, **4/4 seats settled**, no failed seats,
and a `reported`/`succeeded` terminal outcome.

The report has **12 admitted claims**, **nine live and three withdrawn**,
**seven filed and answered challenges**, **six claims retaining dissent**, and
**nine optional, evidence-cited strengths**. These strengths are reviewer
authored preservation guidance, not verified endorsements or a praise quota.
All claims retain the runner's `plausible_risk` grade ceiling; the report does
not claim council agreement proves truth. The scribe identified access,
pagination and export defects, retained duplicate live claims and severity
disagreement, and recorded an embedded reviewer-directed audit letter as
untrusted input. One evidence item was rejected on a citation-range mismatch;
the limitation is visible in the summary and journal. Six proposed
perspectives were not selected, so coverage is explicitly limited to four.

The primary received **31/31 sent progress deliveries**: ten distinct stage
milestones from initialization through synthesis, one approval notice, one
finished notice, and 19 two-minute helper heartbeats. The initial approval
mail to the bound council child Run had an `unknown` delivery result. After
the supervisor stayed idle with no reviewer launch, the primary checked its
recorded live Dispatch and sent the documented one-time fallback wake; the
supervisor then launched reviewers. This demonstrates recovery but does not
claim that the uncertain automatic mail was delivered. The supervisor later
sent a `worker_done` receipt naming the generated reports.

Read-only `council verify` after completion returned `verified:true`, an intact
approval binding and pinned snapshot, `journalBinding:bound`, and **54/54
journal-tracked artifact receipts clean** with no changed or missing tracked
bytes. Seven operational files (progress and supervisor metadata) were
reported as untracked warnings, as designed. The live run did not exercise
fifteen seats, multiple providers, coherent same-UID journal forgery, or an OS
sandbox guarantee. Its reviewer reproductions were performed by agents and
reported by the scribe; this verification checks the council flow and custody,
not independent truth of each fixture finding.
