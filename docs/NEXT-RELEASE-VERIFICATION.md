# Next release verification — in progress

This records integrated stages of NEXT-RELEASE-PLAN.md. Worker completion is
not release completion; remaining runtime changes require integration, fault
checks and bounded live verification before their documentation is published.

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
