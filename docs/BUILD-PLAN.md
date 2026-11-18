# Build plan

The primary orchestrator integrates and pushes completed stages. Planning workers may challenge this breakdown before implementation begins.

| Stage | Deliverable | State |
| --- | --- | --- |
| 0 | Verify Orca, Devin SWE-2 Max, GitHub access; record brief and collaboration rules | Complete |
| 1 | Compare architecture and host integration options; define review quality and protocol | Complete |
| 2 | Approve architecture, contracts, file ownership, and implementation assignments | Complete |
| 3 | Implement durable council core and approval enforcement | Complete |
| 4 | Implement Orca execution, agent messaging, organiser, and scribe | Complete: real reduced council finished every phase, with partial coverage explicitly reported |
| 5 | Implement invocation surfaces, installation, and user documentation | Complete |
| 6 | Independent review, integration tests, live Orca smoke test, and fixes | Pending: final guarded-cleanup edge-case review and CI for its integration; 282 tests pass and live evidence is recorded |

## Design assignments

- Architecture planner owns `docs/design/architecture-proposal.md`.
- Orca integration planner owns `docs/design/orca-integration-proposal.md`.
- Review methodology planner owns `docs/design/review-methodology-proposal.md`.

All three must identify tradeoffs, failure modes, an implementable first version, and evidence for host capability claims. They may exchange ideas through Orca mail. These are proposals; the primary orchestrator chooses and records the final design before implementation.

All three planning workers delivered their proposals and exchanged focused peer critiques using Orca mail. The primary orchestrator reviewed them and recorded the approved first-release scope and exclusive file ownership in `docs/design/IMPLEMENTATION.md`. All implementation work uses Devin `swe-2-max` with the user-requested development bypass mode. The shared contracts stage precedes dependent implementation.

The shared TypeScript interfaces, validation, storage/snapshots, protocol/claims/reports, host adapter, prompts/skill, CLI, CI definition, and acceptance fixture have been implemented and pushed. Approval includes the full proposal hash and explicit worker Run IDs. An independent lightweight Codex audit found timeout slot accounting and final-source-drift gaps; fixes are committed with tests.

After the Orca crash, the primary recovered the saved council through dedicated-supervisor rebinding and exact no-effect task reconciliation. Linux Node 22/24 CI passes after repairing a cross-platform independence-test assumption. Real Orca receipts drove fixes for mutation retry IDs, terminal flags, explicit settlement outcomes, and cleanup truthfulness.

The reduced live council completed organiser, approval, independent reviews, peer challenge/response, and separate-scribe synthesis. Its report contains seven canonical claims covering all four fixture seeds and preserving dissent. Coverage is explicitly partial: one independent output failed strict schema admission, two invalid evidence snippets were excluded, and discussion bounds omitted assignments. The 15-seat lifecycle is covered by a deterministic fake-host test, not a live load test. See `docs/VERIFICATION.md` for concrete receipts, checks, and limits. Final cleanup-source integration and CI remain before stage 6 closes.
