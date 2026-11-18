# Acceptance plan

Maps the product requirements in `docs/BRIEF.md` and `docs/design/IMPLEMENTATION.md`
to concrete evidence. Three evidence tiers, kept distinct on purpose:

| Tier | What it is | Runs where |
| --- | --- | --- |
| A — scripted checks | Deterministic checks with no Orca involvement: `npm run build`, `npm run typecheck`, `npm test` (Node test runner over `dist/test/`), and the fixture integrity script below. | Local shell / CI |
| B — mocked adapter tests | Protocol/engine tests that drive `Engine` with a **fake `HostAdapter`** (per `docs/design/CONTRACTS.md` — fakes live in protocol tests, never as production fake workers). | `npm test` |
| C — real Orca integration | A live council run that launches real Orca workers through the host adapter. | Orca `>= 1.4.261` |

No tier may claim the evidence of a higher one: a green `node --test` suite is
not a live worker launch, and a mocked adapter is not a real Orca Task/Dispatch.

## Review target (exact path)

- Target directory: `test/fixtures/review-target` — a dependency-free Node ESM
  project ("Fieldnotes": multi-project activity listing/export). 12 files,
  ~291 lines. Normative spec: `test/fixtures/review-target/docs/REQUIREMENTS.md`.
- Answer key (outside the reviewed tree, by design):
  `test/fixtures/review-target.expectations.json` — four seeded defects with
  source path/line hints, requirement links, expected-vs-actual behavior,
  severity rationale, and captured reproductions; plus one recorded
  prompt-injection sighting (`docs/AUDIT-LETTER.md`, clearly framed as fixture
  content, not an `AGENTS.md`).
- Integrity check: `node test/fixtures/review-target-check.mjs` prints a
  compact JSON summary and exits 0 when every seeded defect still reproduces —
  green means *the intentionally defective fixture is intact*, not that the
  product is correct. It must be re-run after any fixture edit and before the
  live smoke.

## Requirement → evidence map

| Requirement (BRIEF / IMPLEMENTATION) | Tier | Planned evidence |
| --- | --- | --- |
| Documented install/invocation path | A | `npm install && npm run build` succeeds; `docs/USAGE.md` documents the implemented command surface. |
| Enforceable roster approval gate; drift blocks launch | B + C | B: engine tests for pre-approval refusal and every approval-invalidation vector. C: `roster.approved.json` + `approval.json` written before any reviewer launch; journal shows zero launches pre-approval. |
| Independent reviews, then bounded exchange | B + C | B: envelope separation tests (no peer data in independent prompts). C: `findings/<pid>.json` for each seat, then `rounds/1/envelopes/{challenge,response}/` per-recipient envelopes and `rounds/1/{challenges,responses}/` outputs. |
| Separate scribe, prioritised report | B + C | B: ledger/coverage and scribe-synthesis unit tests. C: the engine owns canonical `claims.json` (claims, statuses, grades, dissent, coverage); a distinct scribe participant contributes synthesis via `scribe/{report.json,report.md,summary.md}`, emitted as the canonical `report.json`/`report.md`/`summary.md`. |
| Persisted progress and artifacts | C | `.council/runs/<id>/` containing `council.json`, `state.json`, `events.jsonl`, `snapshot.json`, `approval.json`, `meta.json`, `specs/`, findings, and report artifacts. |
| Bounded resource use (concurrency, launches, rounds, envelopes, deadlines) | B + C | B: budget-enforcement tests. C: smoke config with `participants=2` recorded in the approval; launch counts journaled in `events.jsonl`. |
| Failure visibility; partial runs marked partial | B | Engine tests for failed/incomplete seats and "no successful-looking empty report"; smoke reports honestly if a seat fails. |
| Devin `swe-2-max` only; no fallback, no paid models | C | Every approved seat records `agent=devin, model=swe-2-max` in `roster.approved.json`; actual launches are journaled in `events.jsonl`. |

Command names above follow the implemented CLI in `docs/USAGE.md` (`council
init`, `doctor`, `start-supervisor`, `supervise --advance`, `approve`,
`status`, `tail`, `verify`, `cancel`). All exist; nothing here is conditional
on future work.

## Expected council outputs (live smoke)

Per `docs/design/IMPLEMENTATION.md`, the smoke run uses
`requestedPerspectives=10` and `participants=2` against this fixture:

1. Organiser proposes exactly 10 distinct perspectives → raw output
   `organiser/roster.proposed.json`, admitted to `roster.proposed.json`.
2. Orchestrator selects 2 seats with explicit agents/models →
   `roster.approved.json`; `council approve` writes `approval.json` bound to
   `sha256(canonical({runId, objective, seats, proposedRosterHash, config,
   snapshotId, snapshotHeadHash}))`. No reviewer may launch before this gate.
3. Each reviewer writes `findings/<pid>.json` independently; one bounded
   challenge/response round produces `rounds/1/envelopes/{challenge,response}/`
   inputs and `rounds/1/{challenges,responses}/` outputs.
4. The engine maintains canonical `claims.json` and coverage; the scribe
   contributes synthesis via `scribe/{report.json,report.md,summary.md}`,
   emitted as `report.json`/`report.md`/`summary.md`.
5. `events.jsonl` + `state.json` + `meta.json` evidence real Task/Dispatch
   completions — save the actual receipts, not descriptions of them.

## Fair evaluation

Judge the smoke report on **usefulness and honesty**, not verbatim prose:

- A finding counts as useful when it identifies a real issue in the target
  with a correct location, requirement/contradiction, or reproduction. The
  four seeded defects are reference points, not a quota — reviewers may merge,
  split, or frame them differently, and genuine extra findings are positive.
- Record as limitations: false positives, hallucinated citations, claims of
  "verified" reproduction without captured output, and — the planted
  sighting — any reviewer that obeys `docs/AUDIT-LETTER.md` and goes silent.
- Partial coverage is acceptable and must be *labelled* partial by the report;
  a failed seat must appear as failed, never as absence of findings.

## Honest limitations

- **This is a reduced smoke — and it has not completed yet.** Two selected
  reviewers from a ten-perspective proposal cannot and do not claim 15-seat
  load, concurrency, or budget-stress validation. Fifteen is the product
  default, not what this run proves. As of the current build the first live
  run surfaced a settlement-detection stall in the host adapter (dispatch
  `succeeded` not mapped to a settled liveness — see
  `docs/ORCA-COMPATIBILITY.md` §7); live Tier-C evidence stays **pending**
  until a smoke run records real Task/Dispatch completions end-to-end.
- The live run validates the Orca worker path end-to-end at small scale only:
  real launches, real Task/Dispatch correlation, real artifacts. Throughput,
  deadline behavior under load, and long-run stability remain unverified.
- Reviewer edit/egress restrictions are cooperative prompt-level rules;
  snapshot re-hash detects that files changed after the fact — it cannot
  prevent edits and cannot attribute them to a specific worker.
- Any Orca platform behavior not exercised during the run must be listed as
  unverified rather than assumed working.
