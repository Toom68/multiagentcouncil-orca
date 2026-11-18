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
      envelopePath: 'rounds/1/outbox/p-rev-2.json',
      outputPath: 'rounds/1/challenges/p-rev-2.json',
    }),
    authorResponse: b.authorResponse(ctx, {
      participantId: 'p-rev-1',
      envelopePath: 'rounds/1/outbox/p-rev-1.json',
      outputPath: 'rounds/1/responses/p-rev-1.json',
    }),
    scribeSynthesis: b.scribeSynthesis(ctx, {
      participantId: 'p-scribe',
      ledgerPath: 'claims.json',
      journalPath: 'events.jsonl',
      reportJsonPath: 'report.json',
      reportMdPath: 'report.md',
      summaryPath: 'summary.md',
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
  });
  test('states evidence rules and grade re-derivation honestly', () => {
    assert.match(spec, /unsupported/);
    assert.match(spec, /re-derives/);
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
    assert.match(spec, /rounds\/1\/outbox\/p-rev-2\.json/);
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
});

describe('scribe synthesis', () => {
  const spec = allWorkerSpecs().scribeSynthesis;
  test('names all input and output paths verbatim', () => {
    for (const path of [
      'claims.json',
      'events.jsonl',
      'report.json',
      'report.md',
      'summary.md',
    ]) {
      assert.match(spec, new RegExp(path.replace('.', '\\.')));
    }
  });
  test('forbids inventing verification and requires dissent retention', () => {
    assert.match(spec, /[Nn]ever invent verification/);
    assert.match(spec, /[Nn]ever omit dissent/);
    assert.match(spec, /partial/);
  });
  test('must not alter ledger grades or statuses', () => {
    assert.match(spec, /never change a/);
    assert.match(spec, /CouncilReport/);
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
