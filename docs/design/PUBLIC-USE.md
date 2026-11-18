# Approved public-use extension

Primary-orchestrator decision, 2026-11-19. This supersedes conflicting details
in the discovery and provider-routing proposals. Existing v0.1 live evidence
remains valid for its original scope; new discovery and mixed-agent behavior
needs its own validation.

## Discovery and installation

Ship a zero-dependency local installer and the existing Node CLI. Use a shared
`~/.agents/skills/council` copy for Devin and modern Codex, and a
`~/.claude/skills/council` copy for Claude Code. These are user skills for local
coding agents in Orca, not installation into the consumer ChatGPT/Claude apps.
Sources: [OpenAI skill discovery](https://learn.chatgpt.com/docs/build-skills),
[Claude Code skills](https://code.claude.com/docs/en/skills), and the locally
verified `devin skills paths`. Avoid duplicate legacy Codex copies by default.

Orca's bundled-skill installer cannot install this third-party skill, and
native-plugin skill contributions are reserved on the verified Orca build.
Do not invent a manifest contribution, append instructions to every project's
AGENTS.md, or add a background hook. Marketplace packaging can follow later;
the supported local installer must already satisfy install-once discovery.

The skill entrypoint should be short: recognition, runtime location, user
preferences, core approval/recovery invariants, and links to detailed operating
references. Keep implicit selection enabled. Explain explicit fallback invocation
(`$council` in Codex, `/council` in Claude/Devin where supported) and recommend
a fresh session after installation if the skill does not appear. Refresh differs
by client; do not claim that every running session is incapable of reloading.

An installed script beside the skill resolves the built CLI without requiring
the user to paste checkout paths: explicit `COUNCIL_CLI` override first, then a
managed user/project installation pointer. Validate the pointer and invoke Node
with an argument array while preserving the target cwd and Orca identity. If no
runtime is available, give installation instructions and stop. Never scan the
disk for a checkout or silently execute a different similarly named command.

Installer scope: user install by default, optional project install, dry-run,
owned-copy update, conflict reporting, backed-up replacement of owned modified
copies only when explicitly forced, and conservative uninstall. Keep manifests
with hashes. Never overwrite a foreign skill, follow an unexpected symlink for
deletion, remove user-modified files during uninstall, or change provider settings,
credentials, PATH or arbitrary project instructions. Test with temporary homes.
Do not install into this user's real directories until the implementation is
reviewed and an installation target is explicitly selected.

## Selection and execution

Separate the CLI agent, model ID, optional named CLI profile, effort, and
permission posture. The caller can choose different supported agents/models per
seat and staff role. Ship documented Devin, Claude Code and Codex launch lanes;
label live verification separately from help/test verification. Do not claim
support for arbitrary suppliers without a documented adapter or profile selector.

Choice precedence: explicit request, relevant established chat/saved preferences,
then a concise question when providers, costs, auth or permission choices remain
materially uncertain. Genuine user-local preferences are valid; they are not
universal package defaults. The installer stores only runtime location/ownership,
not provider preferences. A future preferences command is unnecessary now:
explicit run config and contextual preferences are sufficient.

New CLI-created runs require explicit organiser, scribe and supervisor choices.
Do not silently choose Devin or bypass posture for public users. Staff choices
must be resolved before organiser/supervisor launch, since the later roster gate
cannot authorize work retroactively. Keep the existing roster approval gate for
reviewer and scribe execution. Honor existing authorization without repeated
questions; do not fabricate knowledge of cost or authentication.

Use additive `CouncilConfig.staff` and `CouncilConfig.execution` fields.
`staff` contains `{organiser, scribe, supervisor}` AgentChoices. `execution`
contains `{catalogVersion, policyHash}`. Both are included through the existing
config approval hash. Preserve absent fields exactly when parsing old saved
states/approvals; never inject new defaults that alter historical hashes. Only
legacy runs without these fields retain their original Devin choices. Fresh CLI
init must require resolved staff and capture the current catalog fingerprint.

`AgentChoice.profile` is optional and approval-bound. Implement named profile
selection only for a documented CLI flag (initially Codex `--profile`). Do not
treat Claude `--settings` paths or Devin config paths as named provider profiles.
Reject unsupported profile requests; never ignore one or claim an ambient account
matches an unverified requested account. The council never calls Orca account
selection or edits global provider settings. Without an explicit profile the
CLI uses its existing account/environment; report this as ambient, not as a
guaranteed supplier identity. Configured profiles can select other suppliers
where the chosen CLI supports them, without exposing credentials to council data.

## Catalog and protocol boundary

Implement a typed, versioned, shipped catalog module and read-only
`council catalog --json`. It reports supported lanes, permission/effort/profile
selectors, model-selection mode and local binary presence. Presence never means
authenticated, approved, free, or unlimited. No personal account pricing or usage
assumptions belong in the shipped catalog. Do not launch providers merely to probe
them. The caller supplies an explicit model ID; validate it as data, not shell
syntax. An unavailable model must fail visibly, with no substitute or fallback.

Use fixed, documented argv templates with explicit permission mappings for each
CLI. Keep command composition shell-safe, including provider/model selectors
where the supported syntax permits them. Never accept arbitrary shell templates
from a reviewed project. Catalog profiles and permission maps must not silently
change an approved launch. New runs capture its version/hash; a mismatch blocks
launches and is reported before host mutation. Preserve logical settlement,
physical liveness, retained-session identity and unknown-outcome safeguards.

The portable engine does not load Orca catalog files. Extend `EngineDeps` with
an optional execution-policy dependency containing `policyHash` and a synchronous
`validateChoice(AgentChoice): Result<void>`. New execution-config runs require
this dependency, check its fingerprint before launching/approving, and validate
staff and reviewer choices. Legacy runs retain existing behavior. The CLI and
Orca adapter obtain the same concrete policy implementation from `src/catalog.ts`.

## Ownership and order

1. Startup developer finishes its current CLI/adapter fixes before those files
   are reassigned. No public-extension worker edits them concurrently.
2. Contracts/catalog owner: `src/contracts.ts`, `src/validation.ts`,
   `test/validation.test.ts`, new `src/catalog.ts`, new `test/catalog.test.ts`.
   Publish exact callable exports before downstream work. No engine/CLI/host edits.
3. Installer/skill owner: `scripts/install.mjs`, `test/install.test.ts`,
   `skills/council/**`. No package metadata, runtime source, or public docs edits.
4. After contracts land, protocol owner: `src/engine.ts`, `test/engine.test.ts`.
   CLI/adapter owner: `src/cli.ts`, `src/host/orca.ts`, their tests and the
   existing Orca recovery fixture. Primary assigns actual workers explicitly.
5. Primary owns integration, package metadata, public documentation, verification,
   commits and pushes. Workers send patches/evidence and never commit.

Validate mixed staff/seats, exact model/profile/permission forwarding, approval
invalidation, policy drift, absence of public defaults, legacy hash compatibility,
and no-fallback behavior with meaningful fake-host tests. Validate install/update/
uninstall conflicts in isolated homes, then do a fresh free-Devin discovery
forward-test against a disposable fixture. Do not spend paid Claude/Codex usage
for live tests without explicit authorization. Label untested live lanes honestly.
Do not touch the independently running OSINTGPT council or its approval gate.
