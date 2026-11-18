# Multiagent Council

A council of independent reviewers that inspects a project, debates its findings
in bounded rounds, and returns an evidence-backed report to a primary
orchestrator. Orca is the execution host; the council protocol lives behind a
host-adapter boundary so other hosts can follow.

Flow: an organiser proposes 10–25 review perspectives → the orchestrator
approves a hash-bound roster → reviewers inspect independently → a bounded
challenge/response discussion → a scribe preserves findings, dissent, and
provenance → the orchestrator receives a report with evidence, confidence,
limitations, and honest coverage.

## Requirements

- **Node.js >= 22** (tested on 22.x and 24.x). No runtime dependencies.
- **Orca** CLI on `PATH` (or `ORCA_CLI_COMMAND`) — the only production host in v1.
- **Devin CLI** on `PATH` for real review workers (default agent `devin`,
  model `swe-2-max`). Other agent CLIs are optional.

## Build & run

```sh
npm ci
npm run build

node dist/src/cli.js init --objective ./OBJECTIVE.md --target /path/to/project
node dist/src/cli.js start-supervisor --run <runDir>   # or supervise --advance yourself
node dist/src/cli.js status --run <runDir> --json
```

The package also exposes a `council` bin → `dist/src/cli.js`. See
[docs/USAGE.md](docs/USAGE.md) for the full command surface, the run-directory
layout, and the approval-wake model, and
[skills/council/SKILL.md](skills/council/SKILL.md) for the agent-facing
operating guide.

## v1 scope

- **In scope**: organiser → approval gate → independent review → bounded
  discussion → scribe → report; durable journal-backed state; hash-bound
  approval invalidated by config/source drift; bounded launches/concurrency/
  deadlines/envelopes enforced by the runner.
- **Cooperative (prompt-level, not sandboxed)**: reviewer edit restrictions,
  network/egress limits, and per-worker token/tool budgets. The runner enforces
  what it can observe; the rest is enforced by the worker prompts.
- **Out of scope**: no npm publish, no Orca plugin/MCP packaging, no non-Orca
  host adapter, no cross-run coordination.

## Development

```sh
npm run build          # tsc → dist/
npm test               # node --test dist/test/*.test.js
```

[docs/BRIEF.md](docs/BRIEF.md) · [docs/USAGE.md](docs/USAGE.md) ·
[docs/design/IMPLEMENTATION.md](docs/design/IMPLEMENTATION.md) ·
[docs/design/CONTRACTS.md](docs/design/CONTRACTS.md)
