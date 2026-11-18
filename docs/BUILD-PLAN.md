# Build plan

The primary orchestrator integrates and pushes completed stages. Planning workers may challenge this breakdown before implementation begins.

| Stage | Deliverable | State |
| --- | --- | --- |
| 0 | Verify Orca, Devin SWE-2 Max, GitHub access; record brief and collaboration rules | Complete |
| 1 | Compare architecture and host integration options; define review quality and protocol | Complete |
| 2 | Approve architecture, contracts, file ownership, and implementation assignments | Complete |
| 3 | Implement durable council core and approval enforcement | Complete |
| 4 | Implement Orca execution, agent messaging, organiser, and scribe | Pending: adapter and protocol implemented; complete live council validation outstanding |
| 5 | Implement invocation surfaces, installation, and user documentation | Pending: CLI and skill implemented; final documentation alignment outstanding |
| 6 | Independent review, integration tests, live Orca smoke test, and fixes | Pending: 223 local tests pass and audit fixes landed; Linux CI and live smoke outstanding |

## Design assignments

- Architecture planner owns `docs/design/architecture-proposal.md`.
- Orca integration planner owns `docs/design/orca-integration-proposal.md`.
- Review methodology planner owns `docs/design/review-methodology-proposal.md`.

All three must identify tradeoffs, failure modes, an implementable first version, and evidence for host capability claims. They may exchange ideas through Orca mail. These are proposals; the primary orchestrator chooses and records the final design before implementation.

All three planning workers delivered their proposals and exchanged focused peer critiques using Orca mail. The primary orchestrator reviewed them and recorded the approved first-release scope and exclusive file ownership in `docs/design/IMPLEMENTATION.md`. All implementation work uses Devin `swe-2-max` with the user-requested development bypass mode. The shared contracts stage precedes dependent implementation.

The shared TypeScript interfaces, validation, storage/snapshots, protocol/claims/reports, host adapter, prompts/skill, CLI, CI definition, and acceptance fixture have been implemented and pushed. Approval includes the full proposal hash and explicit worker Run IDs. An independent lightweight Codex audit found timeout slot accounting and final-source-drift gaps; fixes are committed with tests.

After the Orca crash, the primary Codex orchestrator recovered the clean checkout, reclaimed the build Run, and reran `npm test`: 223/223 passed on Windows Node 26.7.0. Linux Node 22/24 CI exposed an independence-test path assumption; a Devin release-readiness worker owns that repair and final docs. The saved live smoke has a completed organiser and valid ten-perspective proposal, but reviewer discussion and scribe completion have not yet been verified live. Worker concurrency is kept small during recovery.
