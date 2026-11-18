# Build plan

The primary orchestrator integrates and pushes completed stages. Planning workers may challenge this breakdown before implementation begins.

| Stage | Deliverable | State |
| --- | --- | --- |
| 0 | Verify Orca, Devin SWE-2 Max, GitHub access; record brief and collaboration rules | Complete |
| 1 | Compare architecture and host integration options; define review quality and protocol | Pending |
| 2 | Approve architecture, contracts, file ownership, and implementation assignments | Pending |
| 3 | Implement durable council core and approval enforcement | Pending |
| 4 | Implement Orca execution, agent messaging, organiser, and scribe | Pending |
| 5 | Implement invocation surfaces, installation, and user documentation | Pending |
| 6 | Independent review, integration tests, live Orca smoke test, and fixes | Pending |

## Design assignments

- Architecture planner owns `docs/design/architecture-proposal.md`.
- Orca integration planner owns `docs/design/orca-integration-proposal.md`.
- Review methodology planner owns `docs/design/review-methodology-proposal.md`.

All three must identify tradeoffs, failure modes, an implementable first version, and evidence for host capability claims. They may exchange ideas through Orca mail. These are proposals; the primary orchestrator chooses and records the final design before implementation.

The three design workers have been launched in Orca using Devin `swe-2-max`. Stage 1 remains pending until their proposals have been reviewed and integrated. The user requested bypass mode for these development workers.
