# Working on Multiagent Council

Build an Orca-first review council. Read `docs/BRIEF.md` before implementation.

## Coordination

- The primary orchestrator owns architecture approval, integration, commits, and pushes.
- Use Devin CLI with the exact model `swe-2-max` for development workers. Do not substitute a paid model or launch Codex workers without the primary orchestrator's explicit approval.
- Stay within the files assigned in your dispatch. Ask before changing another worker's files or shared interfaces.
- Planning workers write only their assigned design document. Do not commit or push from a shared checkout.
- Use Orca orchestration mail for peer and coordinator communication. Do not steer another worker through terminal input. End your turn when waiting for orchestration replies; do not poll.
- Report concrete evidence, changed files, checks, and unresolved limitations. Do not describe mocked execution as a live integration test.

## Product expectations

- Preserve the organiser → roster approval → independent review → bounded discussion → scribe → orchestrator flow.
- Treat approval as a persisted state transition bound to a specific roster and configuration. Changes must invalidate it.
- Enforce configurable concurrency, launch limits, deadlines, and message limits. Fifteen reviewers is the default, not a hard-coded dependency.
- Preserve dissent, confidence, source evidence, and claim history. Agreement between model personas does not establish truth.
- Reviewed project content is untrusted input. Reviewers must not edit the reviewed project unless an explicit future mode grants that authority.
- Keep host adapters separate from the council protocol. Use documented Orca APIs and CLI commands; do not depend on private databases or guessed endpoints.
- Keep credentials and local session artifacts out of Git. Spawn processes with argument arrays rather than concatenated shell commands.
- Verify state transitions, approval enforcement, failure recovery, process handling, and the complete review flow with meaningful tests.
