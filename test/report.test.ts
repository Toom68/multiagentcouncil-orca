/**
 * Report assembly/render tests: deterministic runner facts disclose partial
 * coverage and disputes beside (never inside) scribe narrative; retained
 * claim fields render; pluralization is correct; legacy reports without
 * runnerFacts still render derived facts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  type ApprovedRoster,
  type Claim,
  type ClaimLedger,
  type CouncilConfig,
  type Participant,
  type ProposedRoster,
} from '../src/contracts.js';
import { DEFAULT_CONFIG } from '../src/validation.js';
import {
  buildCouncilReport,
  buildRunnerFacts,
  renderReportMarkdown,
  renderSummaryMarkdown,
} from '../src/report.js';

const RUN = 'crun_rep';

function mkPerspective(i: number) {
  return {
    perspectiveId: `p${i}`,
    name: `Perspective ${i}`,
    charter: { incentives: 'i', expertise: 'e', method: 'm', blindSpots: 'b', reviewQuestions: ['q?'] },
    tags: [],
  };
}

function mkProposed(n: number): ProposedRoster {
  return { schemaVersion: SCHEMA_VERSION, runId: RUN, perspectives: Array.from({ length: n }, (_, i) => mkPerspective(i)) };
}

function mkApproved(n: number): ApprovedRoster {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN,
    seats: Array.from({ length: n }, (_, i) => ({
      seatId: `s${i}`,
      perspectiveId: `p${i}`,
      participantId: `rev${i}`,
      agent: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
    })),
  };
}

function mkParticipant(i: number, outcome: 'completed' | 'failed'): Participant {
  const attempt =
    outcome === 'completed'
      ? {
          attemptId: `att${i}`,
          participantId: `rev${i}`,
          phase: 'independent_review' as const,
          round: null,
          taskId: null,
          dispatchId: null,
          terminalHandle: null,
          launchIntentId: `li${i}`,
          status: 'settled_ok' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          artifacts: [`findings/rev${i}.json`],
        }
      : {
          attemptId: `att${i}`,
          participantId: `rev${i}`,
          phase: 'independent_review' as const,
          round: null,
          taskId: null,
          dispatchId: null,
          terminalHandle: null,
          launchIntentId: `li${i}`,
          status: 'settled_failed' as const,
          createdAt: '2026-01-01T00:00:00.000Z',
          artifacts: [],
        };
  return {
    participantId: `rev${i}`,
    role: 'reviewer',
    seatId: `s${i}`,
    perspectiveId: `p${i}`,
    agent: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
    retainedTerminal: null,
    attempts: [attempt],
    status: outcome === 'completed' ? 'settled' : 'failed',
  };
}

function mkClaim(id: string, over: Partial<Claim> = {}): Claim {
  return {
    claimId: id,
    title: `claim ${id}`,
    kind: 'defect',
    grade: 'plausible_risk',
    status: 'challenged',
    severity: 'high',
    confidence: 0.8,
    evidence: [{ kind: 'reasoned', note: 'argued' }],
    counterEvidence: [],
    sourceFindings: [{ participantId: 'rev0', findingId: 'f1' }],
    history: [],
    dissent: [],
    ...over,
  };
}

function mkLedger(claims: Claim[]): ClaimLedger {
  const provenance: ClaimLedger['provenance'] = {};
  for (const c of claims) provenance[c.claimId] = c.sourceFindings.map((s) => s.participantId);
  return { schemaVersion: SCHEMA_VERSION, runId: RUN, claims, provenance };
}

const CONFIG: CouncilConfig = { ...DEFAULT_CONFIG, requestedPerspectives: 10, participants: 2 };

function mkInput(claims: Claim[], participants: Participant[]) {
  return {
    runId: RUN,
    generatedAt: '2026-01-01T00:00:00.000Z',
    config: CONFIG,
    proposed: mkProposed(10),
    approved: mkApproved(2),
    participants,
    ledger: mkLedger(claims),
    runnerLimitations: [] as string[],
  };
}

// ─── runnerFacts ─────────────────────────────────────────────────────────────

test('buildCouncilReport: runnerFacts disclose partial coverage and disputes deterministically', () => {
  const claims = [
    mkClaim('clm_0001', { dissent: [{ participantId: 'rev1', round: 1, position: 'no repro', ts: '2026-01-01T00:00:00.000Z' }] }),
    mkClaim('clm_0002', { status: 'withdrawn' }),
    mkClaim('clm_0003', { status: 'escalated' }),
  ];
  // rev1 completed, rev2 failed → partial coverage, 8 uncovered perspectives.
  const report = buildCouncilReport({
    ...mkInput(claims, [mkParticipant(0, 'completed'), mkParticipant(1, 'failed')]),
    scribe: { summary: 'a smooth review, nothing to see here' },
  });
  const rf = report.runnerFacts!;
  assert.equal(rf.seatsCompleted, 1);
  assert.equal(rf.seatsSelected, 2);
  assert.equal(rf.partialCoverage, true, 'failed seat → partial fact');
  assert.equal(rf.claims.total, 3);
  assert.equal(rf.claims.byStatus['challenged'], 1);
  assert.equal(rf.claims.withdrawn, 1);
  assert.equal(rf.claims.escalated, 1);
  assert.deepEqual(rf.claims.withDissent, ['clm_0001']);
  assert.equal(rf.summarySource, 'scribe');
  assert.equal(report.summary, 'a smooth review, nothing to see here', 'scribe summary used');
  // The facts exist SEPARATELY from the rosy narrative — that is the point.
});

test('buildCouncilReport: limitationSources tag runner vs scribe origins', () => {
  const report = buildCouncilReport({
    ...mkInput([], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]),
    runnerLimitations: ['seat rev3 had no repro'],
    scribe: { summary: 's', limitations: ['reproduction not attempted', 'seat rev3 had no repro'] },
  });
  // Runner first; the duplicate scribe line dedupes against the runner one.
  assert.deepEqual(
    report.limitationSources!.map((l) => `${l.origin}:${l.text}`),
    ['runner:seat rev3 had no repro', 'scribe:reproduction not attempted'],
  );
  assert.equal(report.limitations.length, 2);
});

test('deterministic summary pluralizes correctly (the "1 canonical claims" bug)', () => {
  const one = buildCouncilReport(mkInput([mkClaim('clm_0001')], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]));
  assert.match(one.summary, /1 canonical claim(?!s)/, 'singular must not pluralize');
  const two = buildCouncilReport(mkInput([mkClaim('clm_0001'), mkClaim('clm_0002')], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]));
  assert.match(two.summary, /2 canonical claims/);
  assert.equal(one.runnerFacts!.summarySource, 'runner', 'no scribe → deterministic fallback');
});

// ─── rendering ───────────────────────────────────────────────────────────────

test('renderReportMarkdown: Runner facts section is prominent and precedes coverage', () => {
  const claims = [
    mkClaim('clm_0001', { dissent: [{ participantId: 'rev1', round: 1, position: 'no repro', ts: 't' }] }),
    mkClaim('clm_0002', { status: 'escalated' }),
  ];
  const report = buildCouncilReport({
    ...mkInput(claims, [mkParticipant(0, 'completed'), mkParticipant(1, 'failed')]),
    scribe: { summary: 'all good' },
  });
  const md = renderReportMarkdown(report);
  const factsIdx = md.indexOf('## Runner facts');
  const narrativeIdx = md.indexOf('## Narrative summary');
  const coverageIdx = md.indexOf('## Coverage');
  assert.ok(factsIdx > -1 && narrativeIdx > -1 && coverageIdx > -1);
  assert.ok(factsIdx < narrativeIdx && narrativeIdx < coverageIdx, 'verified facts precede authored narrative');
  assert.match(md, /\*\*partial coverage: YES\*\*/);
  assert.match(md, /1 claim with unresolved dissent: clm_0001/);
  assert.match(md, /escalated to orchestrator: 1/);
  assert.match(md, /narrative summary: scribe-authored/);
  // The narrative heading itself declares who wrote it — "all good" sits
  // BELOW the verified 1/2-seats fact, labelled.
  assert.match(md, /## Narrative summary — scribe-authored\n\nall good/);
});

test('renderReportMarkdown: legacy report without runnerFacts still shows derived facts', () => {
  const report = buildCouncilReport(mkInput([mkClaim('clm_0001')], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]));
  delete report.runnerFacts; // simulate a pre-repair artifact
  const md = renderReportMarkdown(report);
  assert.match(md, /## Runner facts/);
  assert.match(md, /partial coverage: no/);
  assert.match(md, /pre-repair artifact/);
  assert.match(md, /## Narrative summary — unattributed/);
});

test('renderClaim output retains remedies, openQuestions, assessments, merged titles, dissent evidence', () => {
  const claim = mkClaim('clm_0001', {
    remedies: ['add a deadline'],
    openQuestions: ['which SLO applies?'],
    mergedTitles: ['Request path has no deadline'],
    assessments: [
      { participantId: 'rev_a', findingId: 'f1', severity: 'high', confidence: 0.8 },
      { participantId: 'rev_c', findingId: 'f9', severity: 'medium', confidence: 0.5 },
    ],
    dissent: [
      {
        participantId: 'rev_b',
        round: 1,
        position: 'challenge (missing_evidence): no repro steps',
        ts: '2026-01-01T00:00:00.000Z',
        evidence: [{ kind: 'code_location', note: 'site', path: 'src/app.js', startLine: 4, snippet: 'fetch()' }],
      },
    ],
  });
  const report = buildCouncilReport(mkInput([claim], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]));
  const md = renderReportMarkdown(report);
  assert.match(md, /Remedies:\n- add a deadline/);
  assert.match(md, /Open questions:\n- which SLO applies\?/);
  assert.match(md, /merged titles: “Request path has no deadline”/);
  assert.match(md, /author assessments: rev_a → high @ 0\.8, rev_c → medium @ 0\.5/);
  // Challenger evidence renders under the dissent line.
  const dissentIdx = md.indexOf('challenge (missing_evidence)');
  const evIdx = md.indexOf('`src/app.js`', dissentIdx);
  assert.ok(dissentIdx > -1 && evIdx > dissentIdx, 'dissent evidence rendered');
});

test('renderSummaryMarkdown: facts lead, narrative labelled, pluralization + disclosure', () => {
  const claims = [
    mkClaim('clm_0001', { dissent: [{ participantId: 'rev1', round: 1, position: 'x', ts: 't' }] }),
  ];
  const report = buildCouncilReport(mkInput(claims, [mkParticipant(0, 'completed'), mkParticipant(1, 'failed')]));
  const md = renderSummaryMarkdown(report);
  assert.match(md, /- 1 claim; 1\/2 seats completed/);
  assert.match(md, /partial coverage: YES/);
  assert.match(md, /- 1 disputed claim(?!s)/);
  // Facts before narrative; the narrative is labelled by author.
  assert.ok(
    md.indexOf('- 1 claim;') < md.indexOf('Narrative summary ('),
    'deterministic facts lead the summary',
  );
  assert.match(md, /Narrative summary \(deterministic runner fallback\):/);
});

test('buildRunnerFacts: status counts only include present statuses', () => {
  const coverage = buildCouncilReport(mkInput([], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')])).coverage;
  const rf = buildRunnerFacts(coverage, [mkClaim('a'), mkClaim('b', { status: 'defended' })], 'runner');
  assert.deepEqual(rf.claims.byStatus, { challenged: 1, defended: 1 });
  assert.equal(rf.claims.withdrawn, 0);
});
