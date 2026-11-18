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

## Public-use extension requested 2026-11-19

Install the capability once so an agent in an Orca project can discover the
council instructions from a request such as “spin up a council”, without the
user pasting a checkout-specific path. Use supported agent/Orca discovery
mechanisms, with portable installation, update and removal instructions; do
not invent native plugin skill contributions where Orca does not support them.

Council execution is provider-neutral: the primary agent can recommend a mix
of installed CLI agents, explicit models, and supported suppliers for individual
seats and staff roles. This product behavior is separate from this repository's
development-worker choice of free Devin SWE-2 Max. Do not hard-code this user's
paths, subscription assumptions, free-model preferences or bypass posture as
universal public settings.

Honor explicit user choices and relevant chat/saved preferences. When provider
permission, cost limits or selection preferences remain unknown, ask a short
question before launching work that depends on them. Explain model selection
without claiming a universally best model or inferring that an installed CLI
is authenticated, free or approved for unlimited use. Bind actual role/seat
choices to the run and approval; do not silently substitute a provider/model.
Keep the organiser → roster approval → independent reviews → bounded discussion
→ separate scribe flow and all existing recovery/resource safeguards.
