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

- **Node.js >= 22**. No runtime dependencies. The CI matrix covers Node
  22.x/24.x on Linux; local validation ran on Windows Node 26.7.0.
- **Orca** CLI on `PATH` (or `ORCA_CLI_COMMAND`) — the only production host in
  v1; the adapter surface is verified against Orca 1.4.261
  ([docs/ORCA-COMPATIBILITY.md](docs/ORCA-COMPATIBILITY.md)).
- **Agent CLIs** for the staff and seat lanes you choose. The shipped catalog
  (`council catalog --json`) documents `devin`, `claude`, and `codex` argv
  lanes; `devin` + `swe-2-max` is the only lane exercised live so far —
  the others are help-verified, not live-verified. There is no default
  provider: fresh runs require an explicit staff and per-seat choices, each
  validated against the catalog and bound by the roster approval.

## Build & run

```sh
npm ci
npm run build

node dist/src/cli.js catalog --json                # supported lanes + selectors
node dist/src/cli.js init --objective ./OBJECTIVE.md --target /path/to/project --config ./council.config.json
node dist/src/cli.js start-supervisor --run <runDir>   # or supervise --advance yourself
node dist/src/cli.js status --run <runDir> --json
# at the gate: write roster.approved.json, then
node dist/src/cli.js approve --run <runDir> --roster <runDir>/roster.approved.json
```

`--config` must carry an explicit `staff` object — `{organiser, scribe,
supervisor}`, each an AgentChoice `{agent, model, permissionMode,
effort?, profile?}` from the shipped catalog. There is no default provider.

The package also exposes a `council` bin → `dist/src/cli.js`. To install the
agent skill once so any project can discover it, run
`node scripts/install.mjs` (dry-run first; see
[docs/AI-INSTALL.md](docs/AI-INSTALL.md) for the agent-facing guide). See
[docs/USAGE.md](docs/USAGE.md) for the full command surface, the run-directory
layout, and the approval-wake model, and
[skills/council/SKILL.md](skills/council/SKILL.md) for the agent-facing
operating guide.

## v1 scope

- **In scope**: organiser → approval gate → independent review → bounded
  discussion → scribe → report; durable journal-backed state; hash-bound
  approval invalidated by config/source drift; bounded launches/concurrency/
  deadlines/envelopes enforced by the runner.
- **Status**: 504 automated tests pass locally. A repaired **15-seat live
  Orca council completed the full protocol** with 15/15 independent files
  admitted, 30 claims, three distinct qualified challenges (all local ids
  were `C-1`), two applied author revisions and zero output/evidence
  rejections. One response was omitted by the configured per-author cap;
  its dissent remains unresolved. This was a small-fixture, one-round run
  with reduced per-seat output budgets, not a production load test.
  [docs/VERIFICATION.md](docs/VERIFICATION.md) records the evidence,
  earlier interrupted/partial runs and remaining limits; the repair plan
  is in [docs/COUNCIL-FIX-PLAN.md](docs/COUNCIL-FIX-PLAN.md).
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
[docs/VERIFICATION.md](docs/VERIFICATION.md) ·
[docs/design/IMPLEMENTATION.md](docs/design/IMPLEMENTATION.md) ·
[docs/design/CONTRACTS.md](docs/design/CONTRACTS.md)
