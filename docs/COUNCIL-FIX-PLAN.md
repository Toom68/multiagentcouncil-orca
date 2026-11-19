# Council repair plan — 2026-11-19

The live 15-seat council crun_01M7RQP9MT8C6PE2MSW48KW3GK completed with only three admitted independent reviews and no applied author responses. Its findings are hypotheses to reproduce, not automatic implementation requirements. Repair the observed failures and investigate all 21 admitted claims before expanding the product.

## Architecture decisions

- Keep organiser → persisted roster approval → independent review → bounded discussion → separate scribe. No persona vote upgrades evidence to truth.
- Keep explicit provider/model choices, approval binding, configurable resource budgets, honest process custody and uncertain-mutation refusal. No automatic provider fallback.
- Invalid worker output may receive at most one corrective fresh attempt per phase/seat, carrying exact validation diagnostics, charged against maxLaunches and deadlines. Preserve rejected artifacts and journal; never silently truncate findings or loosen their schema to make a run pass. Budget exhaustion remains visible.
- Qualify challenge identity by round and challenger before routing; responses must reference the exact assigned qualified identity. Preserve all co-authors and show omitted envelope assignments explicitly.
- Preserve remedies, open questions, original author assessments and challenger evidence with provenance. Optional new persisted fields must support legacy run artifacts. Scribe narrative remains visibly separate from runner facts; summary must prominently carry deterministic coverage/dispute facts. Do not invent confirmed/resolved truth from agreement.
- Evidence checks must bind readable file bytes to the approved manifest hash, check snippets within the cited line range and reject empty snippets; missing or drifted files cannot masquerade as checked citations. Citation-shaped fields on other evidence kinds must not bypass checks.
- Keep source snapshots immutable: drift recovery instructs the operator to create a new run. No in-place re-snapshot feature in this repair.
- Make scribe notes an explicit downstream input, and simplify synthesis to the narrative actually consumed while retaining legacy report compatibility.
- Fresh launch attempts must persist intent before host mutation. Unknown host outcomes never authorize blind retry. Any durability repair must include fault-injection evidence and preserve ambiguous outcomes rather than pretending they did not happen.
- Quorum measures admitted independent findings, not process settlement. A below-quorum run may emit an explicitly partial diagnostic report, never success-looking coverage. Document this policy consistently.

## Work ownership

All workers use `devin --model swe-2-max --permission-mode dangerous`. Primary orchestrator owns integration, commits and pushes. Workers communicate through Orca mail and do not commit, push, reset or edit another worker's files.

1. **Portability and CLI**: src/cli.ts; scripts/install.mjs; skills/council/scripts/council.mjs; test/cli.test.ts; test/install.test.ts; docs/AI-INSTALL.md. Symlink guards, macOS canonical path tests, verify parity and actionable drift advice.
2. **Evidence, ledger and report**: src/claims.ts; src/contracts.ts; src/validation.ts; src/report.ts; test/claims.test.ts; test/contracts.test.ts; test/validation.test.ts; test/report.test.ts. Claims 8–20 as applicable: qualified routing, provenance, evidence, grades, dedupe, narratives and synthesis parser. This worker owns shared interface changes and must mail their exact signatures to engine/prompts workers before changes requiring them.
3. **Engine and persistence**: src/engine.ts; src/store.ts; src/host/*; test/engine.test.ts; test/store.test.ts; test/orca.test.ts; test/process.test.ts; test/acceptance.test.ts. Corrective attempts, approval profile/runtime choice equality, response rejection journaling, scribe notes consumption, quorum, mail accounting, and reproduce/repair crash/receipt persistence issues. Coordinate shared contracts with worker 2; do not edit its files.
4. **Prompts and documentation**: src/prompts.ts; test/prompts.test.ts; skills/council/SKILL.md; skills/council/references/*; docs/USAGE.md; docs/design/CONTRACTS.md; docs/VERIFICATION.md; README.md. Accurate output limits/contracts, independent review, qualified challenge IDs, scribe inputs/narrative, cooperative boundary honesty, config/quorum/recovery documentation. Record only validation actually observed.

## Integration and acceptance

For each worker, review its diff and evidence, run meaningful focused tests, commit only its owned coherent changes and push the current branch to origin. Integrate shared API dependencies before claiming a green build. Run the complete test suite after integration. Then exercise a bounded live council and explicitly measure admitted findings, distinct challenge routing and applied responses; do not call fake-host tests live validation. Document any non-reproduced claims and residual limitations. Keep .council artifacts and credentials out of Git.
