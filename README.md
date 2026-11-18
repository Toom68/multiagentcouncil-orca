# Multiagent Council for Orca

A council of independent reviewers that challenges a project, debates the findings, and returns an evidence-backed report to its primary orchestrator.

This repository is in its initial design stage. It does not yet contain a working council runner.

The intended flow is: an organiser proposes 10–25 distinct review perspectives; the primary orchestrator approves the roster and agent choices; reviewers inspect independently, discuss bounded rounds, and a dedicated scribe records findings and disagreements. The orchestrator receives a prioritised report with evidence, uncertainty, and actionable follow-up work.

Orca is the first execution environment. A portable core should allow later Claude CLI and Codex integrations without rebuilding the council protocol.

See [the product brief](docs/BRIEF.md) and [the build plan](docs/BUILD-PLAN.md).
