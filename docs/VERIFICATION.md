# Verification record

The Orca-first CLI/skill v0.1 completes the council protocol. A real reduced
council produced an explicitly partial report; automated tests also exercise
a complete 15-seat lifecycle. These are different levels of evidence.

## Automated checks

On 2026-11-19, Windows Node 26.7.0:

- `npm test`: clean TypeScript build and 285 passing tests, zero failures
  after the guarded-cleanup repair.
- `npm run typecheck`: passed.
- `node test/fixtures/review-target-check.mjs`: passed; all four deliberately
  seeded defects still reproduce and the hostile-document note remains.
  This confirms fixture integrity, not correctness of the fixture product.
- Linux CI on Node 22/24 passed for the final source repair,
  [commit e431bda](https://github.com/Toom68/multiagentcouncil-orca/actions/runs/44399699955),
  [the evidence-format prompt repair, commit 0b2bbb7](https://github.com/Toom68/multiagentcouncil-orca/actions/runs/44397310228),
  and the earlier
  [reconciliation hardening, commit d2fe7e7](https://github.com/Toom68/multiagentcouncil-orca/actions/runs/44394430137).
- `doctor --json` reported `ready:true` for Node, Orca, live Orca status,
  and Devin. Optional Claude/Codex binary detection does not validate those lanes.

The tests cover approval refusal/invalidation, independent input separation,
strict output schemas, claim provenance and dissent, citation rejection,
budgets, deadlines, process handling, unknown outcomes, locking, drift checks,
and crash recovery. `test/engine.test.ts` includes a fake-host 15-seat run
with 48 fresh phase Tasks and a complete report. Fake-host tests do not prove
live agent behavior or throughput.

## Real Orca run

Post-release startup regressions from the first OSINTGPT setup increased the
local suite to 303 passing tests. The repair separates long review briefs from
Orca Run labels, pauses on trust/unproven readiness, and preserves supervisor
resource evidence. A fake-host crash seam checks that attach intent is durable
before the host call; malformed custody ledgers refuse reuse. This is automated
recovery evidence, not a new live council or proof of new provider integrations.

Host: Orca 1.4.261 on Windows; Devin CLI 3000.11.92, pinned `swe-2-max` with
`--permission-mode dangerous` (the explicitly requested bypass posture).
No fallback model was used.

The target was an ignored copy of the tracked Fieldnotes fixture, separate
from its answer key. The completed council is
`crun_01M7QF3H30KGXZJ2DXMZ8AGFVX`, child Orca Run `run_29e9a8ec4853`.
Its report timestamp is `2026-11-18T20:50:28.821Z` (19 November in Brisbane).
The configuration requested 10 perspectives, selected 2 seats, concurrency 2,
one discussion round, an 8192-byte envelope limit and 17 phase launches maximum.
Actual consumption was 7 phase launches. This count excludes the supervising
wrapper and development/diagnostic workers.

| Phase | Task | Dispatch |
| --- | --- | --- |
| Organiser | `task_4e757dfde09e` | `ctx_0c5cc9ffa889` |
| Spec reviewer: independent | `task_7cf63898711e` | `ctx_7e4ec1070411` |
| Access reviewer: independent | `task_1742224df883` | `ctx_c7be6e3f40ee` |
| Separate scribe: notes | `task_d0d308c09be6` | `ctx_68607a186044` |
| Spec reviewer: challenge | `task_a616c023809c` | `ctx_8b84614a672a` |
| Access reviewer: response | `task_3671d49aacc6` | `ctx_fae1e0192221` |
| Separate scribe: synthesis | `task_ba672483c05b` | `ctx_c032111e1e93` |

The organiser proposed ten charters. The primary selected spec traceability
and access-control adversarial perspectives, explicitly chose each seat's
agent/model/permission posture, and approved before reviewer launches.
Approval hash:

```text
411c26932e46cb89bf79eb56893bd0e44904363fa53df10d6aa1b6ca0f9c7733
```

The final `verify --json` reported snapshot `snap_6df5e89a04c20e17` with
`drift:false`, matching recorded/recomputed approval hashes,
`bindingIntact:true`, and `matchesStateHash:true`. The primary remained bound
to its original build Run `run_9e0098940d02` after dedicated supervision.
Reviewers reused their own settled sessions for discussion; the scribe used
a distinct session. Canonical `claims.json`, `report.json`, `report.md`,
`summary.md`, phase outputs, envelopes, and the 81-event journal were inspected.
The store validated the journal's sequence/hash chain; approval is event 13
and the first reviewer launch is event 22. The final report passed
`parseReportFile`, with seven claims, `partial:true`, and one dissent entry.

## Result and limits

Seven canonical claims covered access-control bypass, malformed-user handling,
export field leakage, pagination, page-size clamping, mutable return references,
and the hostile-document note. The four planted code defects were identified.
All claims stayed at `plausible_risk`; neither asserted reproductions nor
model agreement were promoted to independently verified truth.

The report is **partial**. Both reviewers wrote seven raw findings, but the
spec review was rejected at admission: `findings[4].counterEvidence[0]` and
`findings[6].counterEvidence[0]` were strings where Evidence objects were
required. Only the access review supplied admitted independent findings;
quorum 2 was not met. The failed seat and nine uncovered perspectives are
visible in coverage. The later spec-reviewer challenge was admitted and the
access reviewer defended its claim; the unresolved disagreement over the
malformed-user claim's high severity remains in the ledger.

Two quoted evidence snippets failed snapshot matching and were excluded.
Five discussion assignments were omitted by size/cap limits. Only two of
seven claims reached a challenge envelope, with one actual challenge filed.
The report records these omissions rather than implying comprehensive debate.
The reviewer prompt now gives an explicit Evidence-object example and asks
for a field-type self-check. That is cooperative guidance, not automatic
repair or proof that future agents will always return valid output. The live
run was not rerun after this wording change.

## Recovery and cleanup

The same persisted council survived the Orca crash. Its dedicated supervisor
rebound to the saved child Run through the product's `--as-supervisor` mode.
An earlier task-create had definitively returned “Nothing changed” with request
`74a45889-c510-491e-9598-26264fc8f5c7`. The explicit `reconcile` command
correlated the exact attempt/spec, created Task `task_7cf63898711e`, persisted
it, and resumed without editing run state by hand. Tests additionally exercise
unknown-outcome refusal, malformed ledgers, unique-task adoption, and concurrent
reconciliation under a run lock.

An initial settlement mapping missed Orca's explicit `state:succeeded` when
the terminal was retained and physical liveness unverifiable. The repaired
adapter admitted real completed phases without equating success to process exit.

The original journal's four final `worker.released` events claim
`released:true`. They are **not reliable release evidence**: the then-current
adapter treated any `ok:true` envelope as release. A single later guarded
release diagnostic on the final scribe Dispatch returned:

```json
{
  "ok": true,
  "result": {
    "dispatchId": "ctx_c032111e1e93",
    "state": "retained",
    "reason": "user_requested",
    "processAction": "none",
    "archive": null
  }
}
```

The diagnostic request was `d70f3797-f13a-422f-a341-2b31ea4b8789`. It was
not retried or forced. The source repair now requires explicit disposition
proof; the exact retained receipt is a regression case. The historical
journal remains untouched. No claim is made that all sessions physically
exited or that the new cleanup mapping was validated by a forced live release.

## Unverified scope

Live evidence covers the local Devin lane at small scale, including partial
failure and recovery. Fifteen-seat live load, long-run stability, remote hosts,
other agent CLIs, and direct Claude/ChatGPT app integrations remain unverified.
The protocol/host boundary leaves room for them; v1 ships a local CLI and an
agent skill, without an MCP server or native Orca plugin.

Reviewer edit, peer-read, egress, and within-session token/tool limits are
cooperative prompt rules. The runner validates admitted artifacts and detects
source drift; dangerous permission mode does not supply a sandbox.

Raw local session artifacts remain ignored under `.council-dev/`. This record
includes correlation IDs and aggregate findings without publishing credentials,
private runtime state, or worker transcripts. Reproduce the procedure with
[USAGE.md](USAGE.md) and the tracked fixture; new model output will vary.

## Public-use extension (2026-11-19)

The discovery/provider-neutrality extension adds `src/catalog.ts` (versioned
launch policy + fingerprint), `staff`/`execution`/`AgentChoice.profile`
contract fields, the engine execution-policy boundary, catalog-wired CLI
(`init` staff requirement, `catalog`, staff-aware `doctor`, catalog-aware
`verify`, catalog-resolved `start-supervisor`), the zero-dependency
installer (`scripts/install.mjs`), the runtime locator
(`skills/council/scripts/council.mjs`), and a slimmed skill entrypoint with
bundled references.

Automated evidence on Windows Node 26.7.0: clean `tsc` build and **385
tests, 384 pass, 0 fail, 1 skip** (a Windows file-symlink privilege case;
junction variants run). Coverage includes: exact catalog argv rendering and
refusals (unknown agent, unsafe model/profile/effort, no fallback),
inherited-property safety, policy-hash mismatch blocking before any host
mutation, missing-policy and invalid-staff refusal at init and approval,
mixed-provider staff/seat lifecycle, legacy runs as an unchanged fixed
point, legacy approval-hash pin, catalog fingerprint capture/drift/legacy
verify, selected-lane supervisor launch (including a codex named-profile
lane), supervisor-pin reuse refusal, doctor staff gating, and
install/update/uninstall conflict + junction/foreign/pointer preservation
cases against isolated temp homes.

**Discovery forward-test (live, free Devin `swe-2-max`).** A disposable
folder workspace (`.council-dev/discovery-target/`) received a real
project-scope install via `node scripts/install.mjs --project <dir>` —
`.agents/skills/council` + `.claude/skills/council` copies and manifest
pointers only, no user-scope writes. A fresh Devin session
(`devin --model swe-2-max --permission-mode dangerous`, model shown in TUI)
was given a natural-language "spin up a council" request with no skill or
CLI path. The agent discovered the installed skill on its own, drove every
command through `scripts/council.mjs` (locator → manifest pointer → this
checkout's `dist/src/cli.js`), ran `catalog --json` and `init`, and stopped
as instructed before any supervisor/roster/approval/reviewer launch. The
persisted run `crun_01M7RER8AJWTXASDVA3YZCGQHG` shows `status:initialized`,
the explicitly chosen staff verbatim, and `execution.policyHash` equal to
the shipped `LAUNCH_POLICY_HASH`. This proves discovery → locator → CLI
wiring → catalog validation on the Devin lane only.

Honest limits of this evidence:

- `worker-start` cannot pin a Devin model (host refuses `--model`; the
  agent's own config selected `swe-2-flash-max`, also Free). The first
  attempt was stopped deliberately — dispatch `ctx_33f998f8890b`,
  `ptyKilled:true` — and the test was rerun on a terminal pinned by
  `--command` instead. Model choice for an `--agent devin` launch follows
  the account's own configuration; the shipped catalog never selects it.
- The forward-test exercised `init` only; no council worker launched, no
  supervisor, no reviewer. A mixed-provider live council remains untested —
  `claude`/`codex` lanes are help-verified, never live-verified.
- Minor UX note surfaced by the test agent: `init --help` exits
  `config_invalid`; `help` is the global usage command. Documented here as
  a papercut, not fixed in this stage.
- The disposable fixture, its installed skill copies, and the initialized
  run remain under `.council-dev/` (ignored) as evidence; no real user
  install was performed.
