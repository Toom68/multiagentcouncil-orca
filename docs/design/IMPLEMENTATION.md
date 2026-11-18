# Approved first-release design

This decision supersedes conflicting details in the three design proposals. The primary orchestrator approved it on 2026-11-18.

## Shape and scope

Ship one TypeScript/Node npm package with a `council` executable and a repository-contained Orca skill. Use no runtime dependencies unless an implementation need justifies one. Use `npm`, TypeScript compilation, and Node's test runner. Keep host execution behind an adapter. Do not build a native plugin, MCP server, web UI, remote execution support, automatic fixes, or rerun comparison in this release.

The main orchestrator starts a separate council supervisor worker. That worker invokes deterministic CLI advance steps, ends its turn when awaiting external events, and resumes on Orca wakes. Its child Run holds the organiser, reviewers, and scribe. The main orchestrator's existing Run binding must remain intact. A caller can also drive steps manually by following the skill.

The lifecycle is: create → organiser → awaiting approval → independent review → scribe initial notes → targeted peer challenges → author responses → optional further bounded rounds → scribe synthesis → report. The organiser and scribe are real separate agent sessions. The scribe sees every admitted contribution through persisted artifacts. Reviewers communicate by receiving other reviewers' findings and challenges through the runner's per-recipient envelopes. There is no unbounded group chat.

## Required behavior

- The organiser proposes an explicitly requested number of distinct perspectives, validated in the range 10–25; default 15. A selected roster has a configurable number of reviewer seats, default 15. One selected perspective per seat; the reviewer count cannot exceed the proposed count. A smoke run may select two seats from a valid ten-perspective proposal.
- The primary orchestrator explicitly approves the selected perspective IDs, agent/model choices, objective, source snapshot, budgets, and permission posture. Approval stores a stable canonical SHA-256 hash. Configuration or source drift blocks launch and requires fresh approval. This is a workflow gate and drift check, not a defense against a malicious local process that can rewrite all run files.
- Default development model is exactly Devin `swe-2-max`, with no automatic model fallback. Product configuration may choose other installed Orca agent IDs/models explicitly. Do not silently launch a paid model. Development workers run in bypass mode at the user's request; document the product's separately approved permission configuration.
- Default reviewer concurrency 5, discussion rounds 1, maximum rounds 3, findings per reviewer 7, challenges per reviewer per round 3, envelope size 8192 bytes, configurable total launch and wall-clock limits. Charge every actual worker phase/launch against budgets. Do not truncate JSON into invalid data; reject or deterministically trim complete entries with a visible record.
- Independent findings are collected before peer findings are included in any reviewer prompt. This prevents accidental anchoring through runner inputs. Shared filesystem access is NOT a security seal.
- Canonical findings retain provenance, evidence, confidence, severity, challenge history, responses, withdrawals, counterevidence, and dissent. Claim status and evidence grade are separate. Missing/invalid citations produce unsupported claims. A matching citation or repeated agreement does not prove a defect. In v1, unaudited reviewer claims of reproduction must not be presented as independently verified defects.
- Reports show failed/incomplete seats and uncovered perspectives. A wholly failed review must not produce a successful completion signal. Partial reports must be visibly marked partial. Never replace a failure with a successful-looking empty report.
- Only documented Orca CLI commands; never private databases or guessed RPC endpoints. Host processes use executable/argument arrays with `shell: false`. `terminal create --command` is itself a shell-text interface: build its agent command only from strictly validated, allowlisted tokens or a safely quoted, checked-in wrapper. No objective, path, or model text may become shell syntax.
- Caller/supervisor agents consume their own Orca mail. Helpers NEVER run consuming `check` or `--ack`. Read bounded `inbox` history or supplied message files, deduplicate IDs, and use worker records/output artifacts for reconciliation. No background polling/sleep loops. Deadline checks happen on advance calls; do not claim a sleeping supervisor enforces real-time timeouts without a verified wake mechanism.
- A lost launch receipt is an uncertain outcome, not permission to launch again. Persist an intent before mutation; retain request/operation IDs; report unknown outcomes and reconcile before retry. Do not implement uncontrolled retries, stop on silence, or bypass Orca's retry circuit breaker.
- Reuse a reviewer's known retained terminal for its later challenge/response phase through a new supervised Task, so every phase has explicit Task/Dispatch completion correlation. Keep required sessions open. Do not rely on undocumented follow-up dispatch IDs. Nonterminal agents may require a clearly documented fresh-session fallback carrying the previous artifacts, charged to budgets.
- Reviewer restrictions on edits, additional agents, external communication, and egress are prompt-level unless actually enforced by the selected agent/sandbox. Detect snapshot changes; do not claim prevention. No product-side permission changes or plugin installation as a side effect.

## Package and ownership

Use this small layout rather than a multi-package workspace. Shared interfaces must be agreed before other modules implement against them.

| Owner | Exclusive files |
| --- | --- |
| Contracts developer | `package.json`, `package-lock.json`, `tsconfig.json`, `src/contracts.ts`, `src/validation.ts`, `test/validation.test.ts` |
| Storage developer | `src/store.ts`, `src/snapshot.ts`, `test/store.test.ts`, `test/snapshot.test.ts` |
| Protocol developer | `src/engine.ts`, `src/claims.ts`, `src/report.ts`, `test/engine.test.ts`, `test/claims.test.ts` |
| Orca adapter developer | `src/host/orca.ts`, `src/host/process.ts`, `test/orca.test.ts`, `test/fixtures/orca-*`, `docs/ORCA-COMPATIBILITY.md` |
| Prompt/skill developer | `src/prompts.ts`, `skills/council/**`, `test/prompts.test.ts`, `docs/USAGE.md` |
| CLI/integration developer (assigned after core contracts) | `src/cli.ts`, `test/cli.test.ts`, `test/acceptance.test.ts`, `.github/workflows/ci.yml`, `README.md` |

The primary orchestrator owns `docs/BUILD-PLAN.md`, this decision, assignments, Git commits/pushes, integration decisions, and final verification. Workers do not commit in this shared checkout and may not modify another owner's files. A worker needing interface changes must send a concrete request to the contracts owner/coordinator.

## Contract handoff

The contracts developer must publish a short `docs/design/CONTRACTS.md` and working `src/contracts.ts` before dependent implementation starts. The contract includes the following types and callable boundaries, with exact names/signatures chosen once and then frozen:

- Serializable config, perspective/proposal, selected seat/agent choice, approval, source snapshot, findings/evidence, typed challenges and responses, scribe notes/synthesis, canonical claim ledger, participant/phase attempt, state, journal event, final report, and structured error.
- `HostAdapter`: create a dedicated Run, start a supervised phase worker (with optional retained session), observe its Task/Dispatch outcome, send a bounded notification, inspect liveness, and request a guarded stop only on explicit cancellation. Every result exposes durable IDs and uncertain outcomes. Adapter methods never consume caller mail. Include a fake implementation in protocol tests, not production fake workers.
- Store operations: initialize/load/save run, lock a mutation, atomic artifact reads/writes, append/read journal, hash approval, approve exact roster/config, and verify source snapshot. Keep errors machine-readable.
- Engine: `advance` one bounded reconciliation step from persisted state plus HostAdapter and prompt builder; `approve`, `status`, and explicit `cancel` operations. Return a machine-readable next action (`wait`, `needs_approval`, `progress`, `finished`, `blocked`) and artifact pointers. Workers' output files are schema-validated and correlated with the right completed phase before admission.
- Prompt builders: organiser, independent reviewer, scribe notes, challenge, author response, final scribe, and supervisor; each names exact writable output paths, includes JSON output contracts and budgets, frames target/peer content as untrusted data, and forbids further agents.

The contract stage is complete only when TypeScript compilation and its validation tests pass. Downstream developers can then import the actual interfaces. No speculative duplicate type systems or private per-module schema variants.

## Verification and delivery

Meaningful automated tests must cover preapproval refusal, all approval invalidation vectors, invalid/oversized output, bounded concurrency/launches, cross-phase input separation, real peer challenge/response flow, preserved dissent/withdrawals, unknown launch outcomes without duplication, partial/failed seats, journal durability, snapshot drift, and CLI install/invocation.

After module tests and integration pass, run a live Orca council on a small fixture: one organiser proposing ten perspectives, two selected reviewers, one real challenge/response round, and a separate scribe. Use Devin `swe-2-max` only, approve the exact config explicitly, preserve caller Run binding, save evidence of actual Task/Dispatch completions and resulting reports. This is a reduced smoke council, not proof that a 15-seat load test ran. List any unverified platform behavior honestly.

Commit and push coherent stages to the repository's `main` branch. Do not publish an npm package, tag a plugin release, or change account settings unless separately requested.
