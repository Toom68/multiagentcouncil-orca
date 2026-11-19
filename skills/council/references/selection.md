# Staff and seat selection — choosing providers honestly

Every council launch needs resolved choices for **staff** (organiser, scribe,
supervisor) and for each approved roster **seat**. This reference defines the
axes, the precedence, and what each lane means. Nothing here picks a default —
a public install has none.

## The choice object

A choice is five independent axes, not a name:

| Axis | Meaning | Notes |
| --- | --- | --- |
| `agent` | the coding-agent CLI lane: `devin`, `claude`, `codex` | only lanes the shipped catalog documents are valid |
| `model` | explicit model ID for that CLI | validated as data, never shell syntax; an unavailable model fails visibly — no substitute |
| `profile` | optional **named CLI profile** | initially Codex `--profile` only; Claude `--settings` paths and Devin config paths are NOT named profiles — reject such requests, never silently accept |
| `effort` | effort/thinking level where the lane supports it | allowlisted tokens only |
| `permissionMode` | permission posture for the launch | the lane's documented vocabulary; posture is recorded in the approval |

`{agent, model, effort?, permissionMode, profile?}` — these are distinct.
"Claude Code" is a CLI, not a supplier guarantee; a configured profile can
route a CLI to another supplier without exposing credentials to council data.

Fill-in files ship under `references/templates/`:
`council.config.template.json` (the full config with `staff` placeholders),
`council.config.smoke.template.json` (a bounded first-run variant), and
`roster.approved.template.json` (the approval wrapper). Replace every
`<...>` with a validated catalog choice — leftovers fail loudly, never
default.

## The catalog is the contract

```text
node "<SKILL_DIR>/scripts/council.mjs" catalog --json
```

reports the versioned catalog: supported lanes, each lane's permission/effort/
profile selectors, model-selection mode, and **local binary presence**.
Presence ≠ authenticated ≠ approved ≠ free ≠ unlimited — the catalog reports
what exists, not what you may spend. Never probe providers by launching them.

New runs capture the catalog fingerprint (`execution.catalogVersion`,
`execution.policyHash`) into config and the approval hash; a catalog change
after approval blocks launches rather than silently reinterpreting choices.
Runs created before staff/execution fields exist keep their historical
behavior — old saved states and approval hashes are preserved exactly.

## Precedence (in order)

1. **Explicit request** — "use codex gpt-5-codex for the scribe, devin for
   reviewers" wins, after validating each axis against the catalog.
2. **Established chat/saved preferences** — genuine user-local preferences
   stated earlier are valid. They are *not* package defaults and must not be
   treated as universally approved.
3. **One concise question** — when provider, cost, authentication, or
   permission posture is materially uncertain, ask once. Honor authorization
   already given; never re-ask, and never launch on a guess.

## Per-lane notes

- **Devin**: argv lane with an explicit permission mapping (the catalog
  maps approved postures to Devin's documented `--permission-mode` values).
  Model and permission tokens are allowlisted; worker-start `--model` is not a
  reliable Devin selector. Without an explicit profile the lane uses its
  existing account/environment — report that as *ambient*, not a guaranteed
  supplier identity.
- **Claude Code**: agent lane; model/effort selectors per catalog. No
  `--settings` file is a named profile.
- **Codex**: agent lane; supports a named `--profile` per the catalog. Do not
  assume a profile name — validate it.
- The council never calls Orca account selection and never edits global
  provider settings. Staff and seat choices are bound to the run via
  `--config` and the approval — switching happens there, nowhere else.

## What must not happen

- No silent fallback to a "default" or "installed" agent when the requested
  one is unavailable — fail and say so.
- No per-seat Orca account switching; no credential exposure in run data.
- No claiming a lane is verified live when it is only documented — label live
  vs help/test verification honestly.
- No inventing suppliers: arbitrary suppliers need a documented adapter or
  profile selector in the catalog first.
