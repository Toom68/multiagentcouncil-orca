# Product brief

## Purpose

Give a project's primary agent orchestrator a practical way to request diverse, critical feedback about a product, plan, codebase, or build in progress. The council should uncover problems and useful tradeoffs, not manufacture a volume of complaints.

## Required experience

1. The primary orchestrator invokes the council against a named project and review objective.
2. One council organiser examines the objective and proposes 10–25 distinct personalities or professional perspectives. Each has a scope, relevant incentives, likely blind spots, and concrete review questions.
3. The organiser returns the roster to the primary orchestrator for approval. The orchestrator chooses the participating CLI agents/models and approves the actual configuration. No reviewers launch before this gate.
4. The approved roster runs with 15 reviewers by default, with configurable membership and concurrency. The organiser's proposed perspective count and selected participant count must have clear, validated semantics.
5. Reviewers first investigate independently. They then exchange complaints, counterarguments, and evidence through bounded discussion rounds.
6. A separate scribe listens to all contributions, tracks deduplication and disagreement, and returns a prioritised report to the primary orchestrator.

## Useful output

Findings should include impact, severity, confidence, supporting references (code locations or concrete product scenarios), proposed remedies, opposing evidence, and open questions. Separate reproduced defects from reasoned risks and speculative suggestions. Preserve a transcript and machine-readable report beside a readable summary.

## Constraints

- Orca-first. Decide between a CLI/skill, MCP server, native plugin, or a small combination using verified host capabilities.
- The core protocol should support later direct Claude and Codex integrations. Do not claim desktop compatibility before verifying supported integration paths.
- The user has strict Codex usage limits. Development uses Devin `swe-2-max`, confirmed free by the local account's model catalog on 2026-11-18. Avoid paid lightning variants and automatic model fallbacks.
- Commit and push coherent stages to `https://github.com/Toom68/multiagentcouncil-orca.git`.
- Avoid uncontrolled all-to-all chatter. Enforce budgets and distinguish independent findings from social agreement.
- Use least necessary project access, do not expose secrets, and keep review activity separate from automatic fixes.

## Initial delivery acceptance

A documented installation/invocation path, real Orca worker integration, an enforceable roster approval gate, independent reviews plus actual message exchange, a separate scribe, persisted progress and artifacts, bounded resource use, failure visibility, and meaningful automated and live smoke checks. Clearly label anything deferred or unavailable.
