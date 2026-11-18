# Build plan

The primary orchestrator integrates and pushes completed stages. Planning workers may challenge this breakdown before implementation begins.

| Stage | Deliverable | State |
| --- | --- | --- |
| 0 | Verify Orca, Devin SWE-2 Max, GitHub access; record brief and collaboration rules | Complete |
| 1 | Compare architecture and host integration options; define review quality and protocol | Complete |
| 2 | Approve architecture, contracts, file ownership, and implementation assignments | Complete |
| 3 | Implement durable council core and approval enforcement | Complete |
| 4 | Implement Orca execution, agent messaging, organiser, and scribe | Pending: adapter and protocol implemented; complete live council validation outstanding |
| 5 | Implement invocation surfaces, installation, and user documentation | Complete |
| 6 | Independent review, integration tests, live Orca smoke test, and fixes | Pending: 254 local tests pass, audit fixes landed, and Node 22/24 Linux CI is green; live smoke finalization outstanding |

## Design assignments

- Architecture planner owns `docs/design/architecture-proposal.md`.
- Orca integration planner owns `docs/design/orca-integration-proposal.md`.
- Review methodology planner owns `docs/design/review-methodology-proposal.md`.

All three must identify tradeoffs, failure modes, an implementable first version, and evidence for host capability claims. They may exchange ideas through Orca mail. These are proposals; the primary orchestrator chooses and records the final design before implementation.

All three planning workers delivered their proposals and exchanged focused peer critiques using Orca mail. The primary orchestrator reviewed them and recorded the approved first-release scope and exclusive file ownership in `docs/design/IMPLEMENTATION.md`. All implementation work uses Devin `swe-2-max` with the user-requested development bypass mode. The shared contracts stage precedes dependent implementation.

The shared TypeScript interfaces, validation, storage/snapshots, protocol/claims/reports, host adapter, prompts/skill, CLI, CI definition, and acceptance fixture have been implemented and pushed. Approval includes the full proposal hash and explicit worker Run IDs. An independent lightweight Codex audit found timeout slot accounting and final-source-drift gaps; fixes are committed with tests.

After the Orca crash, the primary Codex orchestrator recovered the clean checkout, reclaimed the build Run, and reran `npm test`: 223/223 passed on Windows Node 26.7.0. Linux Node 22/24 CI exposed an independence-test path assumption; the repaired test allows the reviewer's own output while rejecting peer artifacts on both path styles. Prompts and documentation now match actual commands, artifact paths, config keys, permission handling, approval wakes, and cooperative access restrictions. Updated CI results remain to be observed.

Actual Orca receipts exposed a settlement-state mismatch in the adapter; its repair and outcome-safety regressions are committed and pass against the saved organiser receipt. GitHub CI for commit `f13c9ec` completed successfully on Node 22 and 24. The recovered live supervisor has admitted the ten-perspective proposal and received primary-orchestrator approval for two complementary Devin seats with one discussion round. Reviewer discussion and scribe completion remain to be verified live. Worker concurrency is kept small during recovery.
