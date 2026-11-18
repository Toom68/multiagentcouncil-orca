# Build plan

The primary orchestrator integrates and pushes completed stages. Planning workers may challenge this breakdown before implementation begins.

| Stage | Deliverable | State |
| --- | --- | --- |
| 0 | Verify Orca, Devin SWE-2 Max, GitHub access; record brief and collaboration rules | Complete |
| 1 | Compare architecture and host integration options; define review quality and protocol | Complete |
| 2 | Approve architecture, contracts, file ownership, and implementation assignments | Pending: design and ownership approved; shared code contracts next |
| 3 | Implement durable council core and approval enforcement | Pending |
| 4 | Implement Orca execution, agent messaging, organiser, and scribe | Pending |
| 5 | Implement invocation surfaces, installation, and user documentation | Pending |
| 6 | Independent review, integration tests, live Orca smoke test, and fixes | Pending |

## Design assignments

- Architecture planner owns `docs/design/architecture-proposal.md`.
- Orca integration planner owns `docs/design/orca-integration-proposal.md`.
- Review methodology planner owns `docs/design/review-methodology-proposal.md`.

All three must identify tradeoffs, failure modes, an implementable first version, and evidence for host capability claims. They may exchange ideas through Orca mail. These are proposals; the primary orchestrator chooses and records the final design before implementation.

All three planning workers delivered their proposals and exchanged focused peer critiques using Orca mail. The primary orchestrator reviewed them and recorded the approved first-release scope and exclusive file ownership in `docs/design/IMPLEMENTATION.md`. All implementation work uses Devin `swe-2-max` with the user-requested development bypass mode. The shared contracts stage precedes dependent implementation.
