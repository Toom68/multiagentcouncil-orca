# Next release implementation plan — 2026-11-19

Authorized by the user after the completed post-repair council. Implement the
four work packages in POST-REPAIR-COUNCIL.md, including concrete persona-specific
strengths alongside prioritized criticism. Treat findings as hypotheses to reproduce.
Primary orchestrator approves architecture and owns integration, commits and pushes
to main. Development workers use only Devin swe-2-max with dangerous permissions.

## Approved architecture

- Preserve organiser → exact persisted approval → independent review → bounded
  discussion → separate scribe → report. Keep dissent/history and explicit agent
  selection. No votes or revisions establish truth; no auto-fix reviewer mode.
- Make participant/attempt creation idempotent under journal-ahead/state-behind
  recovery. Unknown mutation errors default to uncertainty unless concrete
  no-effects evidence proves a refusal. Malformed host lists never mean empty.
- Hash-pin managed admitted outputs, ledger versions, envelopes and reports in
  journal receipts; verify the bytes when consumed, not just at first admission.
  Parse ledgers/envelopes on re-read. Envelope bytes cannot authorize their own
  changed assignments. Version the integrity policy for new runs; report honest
  legacy/untracked status on old runs. No same-UID sandbox/coherent-rewrite claim.
- Keep hash receipts tied to exact bytes and path/version; corrective attempts
  preserve rejected originals. Journal-first custody/order and finite budgets
  survive crashes. Journal terminal creation intent and returned resource identity
  so pre-attach resources are visible; ambiguity never licenses another creation.
- Add explicit supervisor replacement only when the old identity is proven stale
  and attach custody is resolved. Preserve old startup/identity history, staff and
  approval binding; reuse/adopt recorded resources rather than blindly retrying.
  Keep a documented manual recovery path and caller Run binding.
- Status is a read-only diagnostic: include activity age, phase/deadline timing,
  supervisor health, exact actionable pending decisions and uncertainty. No timer
  daemon for status, fabricated liveness or implicit host rebinding for status/verify.
- User amendment: wake the initiating orchestrator at every lifecycle stage,
  approval/blocker/failure and completion, with concrete counts and next action.
  Long stages also need bounded progress wakes (default two minutes), so silence
  is never presented as evidence of health. Persist the intended recipient before
  supervisor binding changes. Use documented Orca mail; never consume mail or
  rebind the primary to the child Run. Deduplicate stage messages durably and
  retain uncertain delivery receipts without blind retries. A run-local bounded
  timer helper is approved solely for these progress wakes: argv-based, no agents,
  no new scheduled provider jobs, no worker/status host polling, finite lifetime
  and message budget, singleton lease, and clean exit on terminal council state.
  A dead helper/host must be visible, not advertised as guaranteed delivery.
  The bundled skill instructs the awakened primary to relay concise user updates.
- Add optional, bounded Strength records: perspective/participant provenance,
  specific feature, benefit to that role, supporting evidence, and what to
  preserve. Absence is valid; no praise quota or invented criticism to attach it
  to. Validate citations like findings; keep legacy artifacts loadable. Strengths
  travel through independent output, scribe input, JSON and readable reports,
  without replacing prioritized findings or upgrading certainty.
- Link discussion records by qualified challenge id. Distinguish filed/answered/
  unanswered challenges, retained positions and genuine unresolved dissent;
  answer/revision does not erase disagreement or imply that a claim is true.
  Record assigned claim ids once and count unassigned claims, byte-trimmed entries
  and author-cap response omissions separately without N-fold duplication.
- Put limitations in summary.md, use the same ordering as report.md, and include
  snapshot/head/objective provenance in exported reports. Escape/fence untrusted
  markdown so reviewer prose cannot impersonate runner-authored sections.
- Improve bundled setup guidance with explicit staff and roster wrapper examples,
  paused startup outcomes, doctor/verify, bounded configurations and recovery.
  Do not change provider credentials/global settings or launch other providers.
- Add full-default-volume and rounds=2 fake-host lifecycle checks; run bounded
  live verification after integration. Real user-directory installation and
  non-Devin provider smokes are not automatic side effects of this implementation.

## Exclusive file ownership

Workers share the checkout; no worker commits/pushes/resets/stashes or edits
another lane's files. Interfaces are coordinated through Orca mail before use.

1. **engine**: src/engine.ts; test/engine.test.ts; test/acceptance.test.ts.
   Participant idempotence, managed-artifact consumption/writes, terminal custody
   stage integration, routing metrics, status facts and integration regressions.
2. **adapter**: src/host/orca.ts; src/host/process.ts; test/orca.test.ts;
   test/process.test.ts. Conservative errors/lists and terminal-create custody
   callbacks/receipts with documented host commands only.
3. **ledger-report**: src/contracts.ts; src/validation.ts; src/claims.ts;
   src/report.ts; test/contracts.test.ts; test/validation.test.ts;
   test/claims.test.ts; test/report.test.ts. Shared additive contracts/parsers,
   strengths, discussion accounting, provenance and safe readable rendering.
4. **operator**: src/cli.ts; test/cli.test.ts. Guarded supervisor replacement,
   status/verify diagnostics and managed integrity display, useful command help.
5. **artifacts**: src/store.ts; src/artifacts.ts (new); test/store.test.ts;
   test/artifacts.test.ts (new). Hash receipt/index/verification helpers and
   durability/integrity regressions. Coordinate engine/CLI integration; do not
   independently edit their files. Existing snapshot exclusion policy unchanged.
6. **prompts-docs**: src/prompts.ts; test/prompts.test.ts; README.md;
   docs/USAGE.md; docs/design/CONTRACTS.md; skills/council/SKILL.md;
   skills/council/references/*; examples/* (new only if useful).
   Structured strengths, honest independence/authority wording, real templates,
   explicit paused/status/recovery guidance and no unearned verification claims.
7. **progress**: src/progress.ts (new); test/progress.test.ts (new).
   Run-local progress outbox, deduplicated stage and periodic wake helper,
   bounded lifetime/lease/receipts. Publish exact APIs to engine and operator;
   they own their integration points. No direct engine/CLI/contracts edits.

Ledger-report owns all shared contracts and validation exports; the engine,
operator, adapter and artifact lanes request additive interfaces by mail early.
The artifacts lane owns the shared integrity helper APIs and must publish exact
signatures plus failure/legacy policy to engine and operator before integration.
Primary owns this plan and final verification/release records.

## Acceptance and delivery

Reproduce high-priority crash cases first, add meaningful fault-injection and
malformed-receipt tests, and preserve all existing safeguards. Independently
review and audit recovery/integrity seams after worker tests pass. Validate
coherent dependency-aware stages in isolated checkouts when needed. Push each
completed validated stage to main; clearly label any interruption checkpoints.
After the complete suite passes, run a bounded live council that exercises
structured strengths, discussion accounting, integrity verification and final
report limitations. Record source-backed counts and remaining limits; mocked
host effects are not live integration. No unrelated MCP/plugin/second-host,
legacy-removal, global configuration or broad simplification work in this release.
