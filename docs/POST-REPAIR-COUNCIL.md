# Post-repair council review — 2026-11-19

A fresh review of Multiagent Council itself at `7f45fcb`, after the repaired
15-seat fixture acceptance. Objective: identify remaining prerequisite fixes and
recommend a practical expansion roadmap. This record reports the council's
findings; it does not implement them or promote reviewer agreement into truth.

Run: `crun_01M7S7E4XTC5FK2EXHZ75WC046`; snapshot:
`snap_fbf58d1b08f199d9`. Raw reports, journal, independent files and discussion
remain in the ignored run directory. They are not committed as local session
artifacts. Primary checked integrity before publishing this review record:
`council verify` was true, with no source drift and an intact approval/catalog
binding at completion.

## What happened

- All 15 independent reviewer files admitted, producing 45 claims and suggestions.
- One initially malformed reviewer output was rejected and corrected through the
  runner's bounded repair; no manual replacement or suppression of evidence.
- Separate scribe notes admitted; all 45 claims routed for challenge with zero
  envelope omissions under this run's configured budgets.
- Fifteen challenges received fifteen applied responses, all author revisions;
  six claims lowered severity, one raised it, one changed kind, and one corrected
  an evidence note. Thirty claims remained proposed, not verified.
- Ten author-response files carried those fifteen responses. All challenger
  positions remain in claim history/dissent. Retained dissent is not automatically
  unresolved dissent: all fifteen challenges were answered.
- Final state reported/succeeded; 44 engine-accounted phase launches under cap 100.
- Configuration: 15 seats, concurrency 5, one discussion round, at most three
  findings/challenges/responses per seat, 32768-byte envelopes, all explicitly
  selected Devin SWE-2 Max. This was not a multi-provider or multi-round test.

All canonical grades remain plausible_risk. Reported reproductions are reviewer
assertions with evidence, not independent proof by the primary orchestrator.
Duplicate clusters remain separate entries, so 45 claims is not 45 distinct bugs.

## Helpful existing features to preserve

Before approval, the primary added the user's request for concrete strengths to
every perspective's charter. The amendment is preserved in the run and included
in its approval binding. Criticism remained prioritized; there was no praise quota.
These are specific benefits reviewers identified in their independent notes:

| Existing feature | Who benefits and why |
| --- | --- |
| Hash-bound roster/config/source approval and explicit model choice | Security and provider reviewers value a launch matching what was actually authorized, with no silent provider substitution. |
| Fail-closed, snapshot-hash and line-range citation checks | Security, methodology and report consumers can distinguish rejected citations from admitted evidence; reviewers cannot self-upgrade grades. |
| Deterministic facts before labelled scribe narrative | Report consumers can see coverage and counts before reading model-authored interpretation. Keep limitation authorship visible too. |
| Qualified challenge IDs, coauthor routing and retained evidence/dissent | Methodology reviewers value traceable discussion without losing minority positions or conflating local C-1 identifiers. |
| Itemized validation, exact nextHint/wakeCommand guidance and actionable locator errors | First-run operators get concrete next steps; approval file writes are paired with an explicit wake. |
| Dependency injection, argv allowlisting, no consuming mailbox reads | Provider and security reviewers value testable seams, explicit launch policy and preserved mailbox custody. |
| Permission for empty findings/challenges | Reviewers can decline unsupported criticism rather than manufacture complaints to fill a quota. |

These strengths should be easier to see in the final product report, rather than
surviving mostly in reviewer notes and counter-evidence. A future report change
should include persona-specific benefits and preservation guidance with citations,
while keeping prioritized criticism prominent and avoiding generic praise.

## Recommended order for the next release

This is primary triage of the council record, not an instruction to auto-fix the
reviewed project. Reproduce the custody claims before choosing exact remedies.

| Work package | Evidence and acceptance |
| --- | --- |
| 1. Close remaining launch/custody risks | Prioritize clm_0007's reported duplicate participant/launch after a phase-entry append-success/state-save-failure, and the adapter's unknown-error/malformed-list classifications. Regression must show one participant and one launch per attempt after retry, while uncertainty never authorizes a duplicate. |
| 2. Detect post-admission artifact changes | clm_0004/clm_0032/clm_0041 overlap: admitted outputs, envelopes and the ledger are re-read without content binding. Hash-pin managed artifacts and validate on consumption; a changed artifact must fail visibly. This detects tampering; it does not defeat coherent same-user rewrites or enforce a sandbox. |
| 3. Make stalled/dead supervisors operable | clm_0037/clm_0038: document recovery, add an appropriately guarded replacement/wake path, and show activity age and deadline/phase status. Preserve original identity/custody records and the caller's Run binding. |
| 4. Improve report and onboarding honesty | Correct omission and answered-versus-unresolved dissent accounting; distinguish routed-but-unchallenged from never-routed; surface limitations in summary.md; add export provenance and concrete role-specific strengths. Provide starter staff/roster examples and explain paused startup in the bundled skill. |

Further evidence work: exercise combined default output volume and rounds=2 with
fake-host checks followed by a bounded live run; test the install-once locator
round-trip from another project. Non-Devin lane smokes require actual user
selection/authorization and available authentication; an unselected provider is
not a prerequisite for improving the current Devin workflow.

Defer MCP/native packaging, a second host and automatic fixes until a named user
need and documented integration/sandbox prerequisites exist. Repeat-run
comparison has demand in this conversation, but stable report identity/provenance
and reliable custody should precede it. Do not remove the adapter's agent lane
based on apparent dead code alone: the simplification and provider reviewers
explicitly disagree about its future value.

## Limits and disagreements

One model supplies all 15 seats, so methodological diversity does not eliminate
correlated blind spots. One round and universal revise dispositions do not prove
that every challenge was right. The record preserves a real disagreement about
removing the agent lane versus retaining its future integration value. Demand and
integration research were thin; effort estimates are reviewer judgments.

No application implementation changed during this council. Publishing this
record changes documentation after the reviewed snapshot was closed; subsequent
verification of that old snapshot will naturally see this new document.
