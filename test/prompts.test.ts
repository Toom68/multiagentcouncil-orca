/**
 * Tests for src/prompts.ts — behavioral checks on generated worker specs:
 * content boundaries per role, JSON output contracts, peer-data isolation in
 * independent prompts, retained evidence/dissent instructions, and shell-safe
 * argv guidance. Deliberately NOT snapshot tests: they assert invariants, not
 * wording.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromptBuilder } from '../src/prompts.js';
import type {
  CouncilConfig,
  Perspective,
  PromptContext,
} from '../src/contracts.js';

// Non-default sentinel values prove interpolation is config-driven, not
// hardcoded: e.g. findings cap 42, perspectives 12.
const config: CouncilConfig = {
  schemaVersion: 1,
  requestedPerspectives: 12,
  participants: 9,
  concurrency: 5,
  rounds: 1,
  quorumRatio: 0.67,
  maxLaunches: 60,
  maxFindingsPerSeat: 42,
  maxChallengesPerSeatPerRound: 4,
  maxResponsesPerSeatPerRound: 5,
  envelopeBytes: 8192,
  maxMailPerParticipant: 6,
  maxTextChars: 9876,
  deadlines: {
    organiserMs: 600000,
    independentMs: 2700000,
    scribeNotesMs: 900000,
    challengeMs: 900000,
    responseMs: 600000,
    synthesisMs: 900000,
    runMs: 14400000,
    graceMs: 300000,
  },
};

const ctx: PromptContext = {
  runId: 'crun_test01abc',
  runDir: 'C:\\work\\proj\\.council\\runs\\crun_test01abc',
  targetRoot: 'C:\\work\\proj',
  objective: 'Review the billing module for correctness and security.',
  snapshotId: 'snap_abc123',
  config,
};

const perspective: Perspective = {
  perspectiveId: 'P-sec-authn',
  name: 'Authentication security reviewer',
  charter: {
    incentives: 'Success = a demonstrated bypass; failure = a shipped hole',
    expertise: 'authn/z, session management, token lifecycle',
    method: 'threat_model + code_read',
    blindSpots: 'UI copy, build tooling',
    reviewQuestions: [
      'Can refresh tokens be replayed?',
      'What happens when refresh races logout?',
    ],
  },
  tags: ['security', 'breaker'],
};

const b = createPromptBuilder();

// Every worker spec shares these invariants.
function allWorkerSpecs(): Record<string, string> {
  return {
    organiser: b.organiser(ctx, {
      participantId: 'p-organiser',
      outputPath: 'roster.proposed.json',
    }),
    reviewerIndependent: b.reviewerIndependent(ctx, {
      participantId: 'p-rev-1',
      perspective,
      outputPath: 'findings/p-rev-1.json',
    }),
    scribeNotes: b.scribeNotes(ctx, {
      participantId: 'p-scribe',
      admittedFindingsPaths: ['findings/p-rev-1.json', 'findings/p-rev-2.json'],
      outputPath: 'scribe-notes.json',
    }),
    challenge: b.challenge(ctx, {
      participantId: 'p-rev-2',
      envelopePath: 'rounds/1/envelopes/challenge/p-rev-2.json',
      outputPath: 'rounds/1/challenges/p-rev-2.json',
    }),
    authorResponse: b.authorResponse(ctx, {
      participantId: 'p-rev-1',
      envelopePath: 'rounds/1/envelopes/response/p-rev-1.json',
      outputPath: 'rounds/1/responses/p-rev-1.json',
    }),
    scribeSynthesis: b.scribeSynthesis(ctx, {
      participantId: 'p-scribe',
      ledgerPath: 'claims.json',
      journalPath: 'events.jsonl',
      reportJsonPath: 'report.json',
      reportMdPath: 'report.md',
      summaryPath: 'summary.md',
      notesPath: 'scribe/notes.json',
    }),
  };
}

describe('builder surface', () => {
  test('exposes all seven builders', () => {
    for (const name of [
      'organiser',
      'reviewerIndependent',
      'scribeNotes',
      'challenge',
      'authorResponse',
      'scribeSynthesis',
      'supervisor',
    ] as const) {
      assert.equal(typeof b[name], 'function', `${name} must be a function`);
    }
  });
});

describe('shared invariants', () => {
  for (const [role, spec] of Object.entries(allWorkerSpecs())) {
    test(`${role}: names run/snapshot and forbids further agents`, () => {
      assert.match(spec, /crun_test01abc/);
      assert.match(spec, /snap_abc123/);
      assert.match(spec, /do NOT start other agents/i);
    });
    test(`${role}: marks the untrusted-content boundary`, () => {
      assert.match(spec, /untrusted/i);
    });
    test(`${role}: uses JSON contracts, never YAML`, () => {
      assert.match(spec, /```json/);
      assert.doesNotMatch(spec, /```ya?ml/);
    });
    test(`${role}: permits only the coordinator-bound orchestration signals`, () => {
      // worker_done is required for completion; ask/escalation are the only
      // other allowed signals. The old blanket `orca orchestration` ban made
      // the required worker_done impossible — it must not return.
      assert.match(spec, /worker_done/);
      assert.match(spec, /`ask`/);
      assert.match(spec, /`escalation`/);
      assert.match(spec, /coordinator-bound/);
      assert.doesNotMatch(spec, /do NOT run\s+`orca orchestration` commands/i);
    });
    test(`${role}: forbids extra agents, peer mail, and foreign mailboxes`, () => {
      assert.match(spec, /do NOT start other agents/i);
      assert.match(spec, /never mail to peers/i);
      assert.match(spec, /never a consuming `check`\/`--ack`/i);
    });
    test(`${role}: labels cooperative restrictions without claiming detection`, () => {
      assert.match(spec, /cooperative/i);
      // The runner detects snapshot drift (files changed), validates admitted
      // output, and journals rejections — it cannot observe reads, egress, or
      // stray writes, and cannot attribute edits to a specific worker.
      assert.match(spec, /proves files changed, not who changed them/);
      assert.match(spec, /cannot prevent or fully observe egress/i);
      assert.doesNotMatch(spec, /attributed to you/i);
      assert.doesNotMatch(spec, /detects it through your artifacts/i);
      assert.doesNotMatch(spec, /journaled as suspect/i);
    });
  }
});

describe('organiser', () => {
  const spec = allWorkerSpecs().organiser;
  test('demands the configured perspective count and charter fields', () => {
    assert.match(spec, /exactly \*\*12 distinct review perspectives\*\*/);
    for (const field of [
      'incentives',
      'expertise',
      'method',
      'blindSpots',
      'reviewQuestions',
    ]) {
      assert.match(spec, new RegExp(field));
    }
  });
  test('requires structural diversity, not adjectives', () => {
    assert.match(spec, /structural, not cosmetic/i);
  });
  test('names the exact output path and ProposedRoster contract', () => {
    assert.match(spec, /roster\.proposed\.json/);
    assert.match(spec, /ProposedRoster/);
    assert.match(spec, /exactly one JSON file/i);
  });
});

describe('independent reviewer', () => {
  const spec = allWorkerSpecs().reviewerIndependent;
  test('embeds the full perspective charter verbatim', () => {
    for (const text of [
      'Authentication security reviewer',
      'Success = a demonstrated bypass',
      'threat_model + code_read',
      'UI copy, build tooling',
      'Can refresh tokens be replayed?',
      'What happens when refresh races logout?',
    ]) {
      assert.match(spec, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
  test('carries the configured findings cap', () => {
    assert.match(spec, /`42` findings/);
  });
  test('contains NO peer artifacts or peer identities', () => {
    // Independent prompts must never admit peer data: no envelope paths,
    // ledger/journal artifacts, round dirs, or other participants' ids.
    for (const forbidden of [
      'rounds/',
      'claims.json',
      'events.jsonl',
      'envelopePath',
      'p-rev-2',
      'p-scribe',
      'ChallengeAssignment',
      'ResponseAssignment',
    ]) {
      assert.ok(!spec.includes(forbidden), `must not contain ${forbidden}`);
    }
  });
  test('seals independence and labels it cooperative', () => {
    assert.match(spec, /INDEPENDENT review/);
    assert.match(spec, /cooperative/i);
    // Reads of peer artifacts are a cooperative rule — the runner cannot
    // observe them, so the spec must not claim it journals/attributes reads.
    assert.match(spec, /cannot observe/i);
    assert.doesNotMatch(spec, /journals and attributes/i);
  });
  test('states evidence rules and grade re-derivation honestly', () => {
    assert.match(spec, /unsupported/);
    assert.match(spec, /re-derives/);
  });
  test('pins the counterEvidence object-shape contract — objects, never strings', () => {
    // Regression for the live partial run: a reviewer's findings were rejected
    // because counterEvidence held bare strings. The spec must show the same
    // Evidence-object shape as evidence, forbid string elements, and keep []
    // honest — plus ask for a field-type self-check without claiming repair.
    assert.match(spec, /Evidence OBJECT `\{kind, note/);
    assert.match(spec, /\{"kind":"reasoned","note":"/);
    assert.match(spec, /never a bare string/i);
    assert.match(spec, /counterEvidence: \[\]/);
    assert.match(spec, /Self-check your JSON field types/i);
    assert.match(spec, /never silently fixes or truncates/i);
  });
  test('states the real validator caps verbatim — the dominant rejection cause', () => {
    // Regression for crun_01M7RQP9MT8C6PE2MSW48KW3GK: 12 of 15 seats were
    // rejected at admission dominantly because finding titles exceeded the
    // never-documented 200-char cap. Every enforced limit must be stated.
    for (const cap of [
      /\`title\` ≤200 chars/,
      /\`note\` ≤2000/,
      /\`snippet\` ≤1000/,
      /\`steps\`\/\`observed\` ≤4000/,
      /\`path\` ≤240/,
      /≤10 entries of ≤500 chars each/,
      /\`notes\` ≤4000/,
      /\`evidence\` 1–20 items/,
      /\`counterEvidence\` ≤20 items/,
      /\[0,1\]/,
    ]) {
      assert.match(spec, cap);
    }
  });
  test('requires self-validation — no CLI command pre-validates worker output', () => {
    // There is no `council validate`/`check` command; the spec must require
    // the worker to check its file against the listed limits by inspection.
    assert.match(spec, /No `council` command pre-validates worker output/i);
    assert.match(spec, /check EVERY field against[\s\S]*limits/i);
    assert.match(spec, /rejected whole/i);
  });
  test('states fail-closed citation rules so workers cite only what they read', () => {
    assert.match(spec, /fail-closed/i);
    assert.match(spec, /`path` requires `startLine` on ANY evidence kind/i);
    assert.match(spec, /verbatim text found inside the cited `startLine`–`endLine` range/i);
    assert.match(spec, /no whole-file fallback/i);
    assert.match(spec, /no whitespace-only snippets/i);
    assert.match(spec, /match the approved snapshot/i);
  });
  test('seals peer-synthesis charters into the independent phase', () => {
    // A roadmap/synthesis perspective cannot consume peers in this phase —
    // the spec must say peer claims arrive only via later envelopes.
    assert.match(spec, /synthesizing the council's own findings/i);
    assert.match(spec, /peer claims do not exist yet/i);
    assert.match(spec, /bounded discussion envelopes/i);
  });
});

describe('scribe notes', () => {
  const spec = allWorkerSpecs().scribeNotes;
  test('lists every admitted findings path verbatim', () => {
    assert.match(spec, /findings\/p-rev-1\.json/);
    assert.match(spec, /findings\/p-rev-2\.json/);
  });
  test('requires claim summaries keyed by findingId, no invented verification', () => {
    assert.match(spec, /ScribeNotesFile/);
    assert.match(spec, /findingId/);
    assert.match(spec, /cannot invent verification/i);
  });
});

describe('challenge', () => {
  const spec = allWorkerSpecs().challenge;
  test('points at exactly one envelope and forbids ledger/peer reads', () => {
    assert.match(spec, /rounds\/1\/envelopes\/challenge\/p-rev-2\.json/);
    assert.match(spec, /ONLY peer content you may read/i);
    assert.match(spec, /Do NOT open the claim ledger/);
    // must not be told to read findings files or the journal
    assert.ok(!spec.includes('events.jsonl`'));
    assert.ok(!spec.includes('findings/p-'));
  });
  test('lists all challenge kinds and demands evidence-bearing output', () => {
    for (const kind of [
      'missing_evidence',
      'counterexample',
      'overstated',
      'duplicate',
      'scope',
      'other',
    ]) {
      assert.match(spec, new RegExp(kind));
    }
    assert.match(spec, /actionable/i);
    assert.match(spec, /ChallengesFile/);
  });
  test('carries the configured per-round cap', () => {
    assert.match(spec, /at most 4 challenges/i);
  });
  test('explains runner-side challengeId qualification', () => {
    // Regression for crun_01M7RQP9MT8C6PE2MSW48KW3GK: every seat minted C-1,
    // collapsing the routing index. Workers mint locally-unique ids; the
    // spec must explain the runner qualifies them as ch-r<round>-<32 hex>.
    assert.match(spec, /unique id per challenge inside this file/i);
    assert.match(spec, /ch-r<round>-<32 hex>/);
    assert.match(spec, /cannot collide/i);
  });
  test('restricts challenges to assigned claims and states evidence caps', () => {
    assert.match(spec, /assigned in YOUR envelope/i);
    assert.match(spec, /\`argument\` ≤4000 chars/);
    assert.match(spec, /\`evidence\` ≤10 items/);
  });
  test('requires evidence for counterexample challenges', () => {
    assert.match(spec, /`counterexample` challenges require ≥1 `evidence` item/i);
    assert.match(spec, /MUST carry at least one evidence item/i);
  });
});

describe('author response', () => {
  const spec = allWorkerSpecs().authorResponse;
  test('lists all four dispositions and the revise contract', () => {
    for (const d of ['defend', 'revise', 'withdraw', 'escalate']) {
      assert.match(spec, new RegExp(`\`${d}\``));
    }
    assert.match(spec, /revisedFinding/);
    assert.match(spec, /ResponsesFile/);
  });
  test('preserves dissent and withdrawal explicitly', () => {
    assert.match(spec, /Withdrawals are preserved/);
    assert.match(spec, /the ledger preserves dissent/i);
  });
  test('carries the configured response cap', () => {
    assert.match(spec, /at most 5 responses/i);
  });
  test('requires verbatim echo of the qualified challengeId', () => {
    // Response admission compares ids verbatim; the spec must forbid
    // re-minting and name the qualified ch-r<round>-<32 hex> form.
    assert.match(spec, /EXACT qualified id/i);
    assert.match(spec, /ch-r<round>-<32 hex>/);
    assert.match(spec, /never re-mint/i);
    assert.match(spec, /QUALIFIED id/i);
  });
  test('states the revisedFinding limits (title cap bit a live run)', () => {
    // rev-11's response was rejected: missing revisedFinding + title >200.
    assert.match(spec, /required when `disposition` is `revise`/);
    assert.match(spec, /≤200 chars/);
  });
});

describe('scribe synthesis', () => {
  const spec = allWorkerSpecs().scribeSynthesis;
  test('names all input and output paths verbatim', () => {
    for (const path of [
      'claims.json',
      'events.jsonl',
      'report.json',
      'scribe/notes.json',
    ]) {
      assert.match(spec, new RegExp(path.replace('.', '\\.')));
    }
  });
  test('demands only the narrative contract the runner reads', () => {
    // clm_0020: the old spec required a full CouncilReport whose claims the
    // runner discarded. The new contract is the slim SynthesisFile.
    assert.match(spec, /SynthesisFile/);
    assert.match(spec, /ONE JSON file/);
    assert.match(spec, /No `report\.md` or `summary\.md` is required/);
    assert.match(spec, /runner renders/i);
  });
  test('consumes scribe notes as an explicit, non-authoritative input', () => {
    // clm_0021: notes were admitted then never read. They must be a named
    // input, framed as a prior read — not truth.
    assert.match(spec, /Scribe notes: `scribe\/notes\.json`/);
    assert.match(spec, /not an authority|prior read/i);
  });
  test('forbids inventing verification and requires dissent retention', () => {
    assert.match(spec, /[Nn]ever invent verification/);
    assert.match(spec, /[Nn]ever omit dissent/);
    assert.match(spec, /partial/);
  });
  test('forbids asserting consensus or closure the record lacks', () => {
    // No truth-by-consensus and no invented claim closure: clm_0014 found no
    // actor can produce confirmed/resolved, and clm_0018 found the summary
    // ships unchecked — the prompt is the behavioral guard.
    assert.match(spec, /never upgrade agreement into truth/i);
    assert.match(spec, /the council agreed/);
    assert.match(spec, /never assert claims were confirmed, resolved/i);
  });
  test('frames narrative as self-checked authored layer, not validator-checked', () => {
    // Coordinator review: nothing semantically verifies the prose — the spec
    // must say the runner's facts are deterministic and the scribe must
    // self-check its narrative, not claim it "is checked" downstream.
    assert.match(spec, /deterministic run facts/i);
    assert.match(spec, /self-check it against the record/i);
    assert.doesNotMatch(spec, /your narrative is checked against/i);
  });
});

describe('boundary honesty', () => {
  for (const [role, spec] of Object.entries(allWorkerSpecs())) {
    test(`${role}: managed artifacts are not claimed ignored`, () => {
      // The old wording "anything else written inside the run directory is
      // ignored" was false: ledger/envelopes/journal/peer outputs are read.
      assert.doesNotMatch(spec, /is ignored/i);
      assert.match(spec, /managed artifacts/i);
      assert.match(spec, /tampering/i);
    });
    test(`${role}: .council is not claimed snapshot-protected`, () => {
      // .council/.council-dev are excluded prefixes — drift checks cover the
      // reviewed target manifest, never the run dir itself.
      assert.match(spec, /outside the reviewed snapshot/i);
      assert.doesNotMatch(spec, /snapshot.*protects|protected by the snapshot/i);
    });
  }
});

describe('corrective attempt (repair context)', () => {
  const repair = {
    contract: 'FindingsFile',
    diagnostics: [
      'file.findings[0].title: exceeds 200 characters (too_long)',
      'file.findings[6].remedies[2]: exceeds 500 characters (too_long)',
    ],
    previousArtifactPath: 'findings/p-rev-1.rejected.json',
  };
  const repaired = b.reviewerIndependent(ctx, {
    participantId: 'p-rev-1',
    perspective,
    outputPath: 'findings/p-rev-1.json',
    repair,
  });
  const normal = allWorkerSpecs().reviewerIndependent;

  test('absent repair leaves the spec untouched', () => {
    assert.doesNotMatch(normal, /Corrective attempt/);
    assert.doesNotMatch(normal, /rejected\.json/);
  });
  test('carries the exact diagnostics verbatim, delimited as untrusted data', () => {
    assert.match(repaired, /Corrective attempt/);
    assert.match(repaired, /```text[\s\S]*file\.findings\[0\]\.title: exceeds 200 characters \(too_long\)[\s\S]*```/);
    assert.match(repaired, /never instructions/i);
    assert.match(repaired, /FindingsFile/);
  });
  test('bounds the repair to the assigned artifact — no unrelated rework', () => {
    assert.match(repaired, /ONLY the assigned artifact/i);
    assert.match(repaired, /Do not redo unaffected work/i);
    assert.match(repaired, /final attempt/i);
    assert.match(repaired, /at\s+most one corrective launch/i);
  });
  test('does not promise admission — diagnostics are recorded reasons, re-validated whole', () => {
    // Coordinator review: a repaired file is validated again end-to-end and
    // may surface further issues; the spec must not promise admissibility.
    assert.match(repaired, /recorded rejection reasons/i);
    assert.match(repaired, /ENTIRE revised artifact is validated again/i);
    assert.match(repaired, /no admission is guaranteed/i);
    assert.doesNotMatch(repaired, /a file that fixes\s+every listed issue is admissible/i);
  });
  test('points at the preserved rejected file when supplied', () => {
    assert.match(repaired, /findings\/p-rev-1\.rejected\.json/);
  });
  test('keeps the same assignment and output contract as a normal spec', () => {
    // A corrective attempt is the identical task: same output path, same
    // contract name, same caps — only the repair preamble differs.
    for (const anchor of [
      /findings\/p-rev-1\.json/,
      /FindingsFile/,
      /`title` ≤200 chars/,
      /INDEPENDENT review/,
    ]) {
      assert.match(repaired, anchor);
    }
  });
  test('repair block renders for every builder role', () => {
    const cases: [string, string][] = [
      ['organiser', b.organiser(ctx, {
        participantId: 'p-organiser', outputPath: 'roster.proposed.json', repair,
      })],
      ['scribeNotes', b.scribeNotes(ctx, {
        participantId: 'p-scribe', admittedFindingsPaths: [], outputPath: 'scribe/notes.json', repair,
      })],
      ['challenge', b.challenge(ctx, {
        participantId: 'p-rev-2', envelopePath: 'e.json', outputPath: 'c.json', repair,
      })],
      ['authorResponse', b.authorResponse(ctx, {
        participantId: 'p-rev-1', envelopePath: 'e.json', outputPath: 'r.json', repair,
      })],
      ['scribeSynthesis', b.scribeSynthesis(ctx, {
        participantId: 'p-scribe', ledgerPath: 'claims.json', journalPath: 'events.jsonl',
        reportJsonPath: 'report.json', reportMdPath: 'report.md', summaryPath: 'summary.md', repair,
      })],
    ];
    for (const [name, spec] of cases) {
      assert.match(spec, /Corrective attempt/, `${name} must carry the repair block`);
      assert.match(spec, /file\.findings\[0\]\.title: exceeds 200 characters/, name);
    }
  });
});

describe('supervisor', () => {
  const advanceCommand =
    'node dist/src/cli.js supervise --run C:\\work\\proj\\.council\\runs\\crun_test01abc --advance --json';
  const spec = b.supervisor(ctx, { advanceCommand });
  test('embeds the advance command verbatim as fixed argv', () => {
    assert.ok(spec.includes(advanceCommand));
    assert.match(spec, /Never edit its tokens/);
  });
  test('loops on progress, ends turn on wait', () => {
    assert.match(spec, /progress[\s\S]*run the same command again/i);
    assert.match(spec, /`wait`[\s\S]*end your turn/i);
  });
  test('reports finished via worker_done with report-path', () => {
    assert.match(spec, /`finished`[\s\S]*worker_done[\s\S]*report-path/i);
  });
  test('forbids orchestration mutations and foreign mailboxes', () => {
    assert.match(spec, /Never run `orca orchestration` mutations/);
    assert.match(spec, /Consume only YOUR OWN mailbox/i);
  });
  test('asks coordinator to nudge after approval', () => {
    assert.match(spec, /send --to dispatch:<yourDispatchId>/);
  });
});
