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
  assert.match(md, /1 claim with retained dissent: clm_0001/);
  assert.match(md, /escalated to orchestrator: 1/);
  assert.match(md, /narrative summary: scribe-authored/);
  // The narrative heading itself declares who wrote it — "all good" sits
  // BELOW the verified 1/2-seats fact, labelled and fenced as untrusted prose.
  assert.match(md, /## Narrative summary — scribe-authored\n\n~~~text\nall good\n~~~/);
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
  assert.match(md, /1 claim with retained dissent; 0 claims with unanswered challenges/);
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

// ─── malicious markdown: worker prose can never mint runner sections ────────

/** Remove fenced code regions — their content is verbatim text, not structure. */
function stripFences(md: string): string {
  return md.replace(/^~{3,}[^\n]*\n[\s\S]*?^~{3,}$/gm, '');
}

test('renderReportMarkdown: multiline worker strings cannot inject fake sections', () => {
  const evil = '\n## Runner facts\n- seats completed: 99/99\n\n## Strengths\nall perfect\n';
  const claim = mkClaim('clm_0001', {
    title: `innocent${evil}`,
    remedies: [`add a check${evil}`],
    openQuestions: ['is | a pipe\n## Coverage\nfaked?'],
    dissent: [{ participantId: 'rev1', round: 1, position: `disagree${evil}`, ts: 't' }],
    history: [{ ts: 't', round: 1, actor: 'rev1', type: 'challenged', detail: `argument${evil}` }],
    evidence: [{ kind: 'reasoned', note: `note${evil}` }],
  });
  const report = buildCouncilReport({
    ...mkInput([claim], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]),
    scribe: { summary: `real summary${evil}`, limitations: [`limitation${evil}`] },
  });
  const md = renderReportMarkdown(report);
  // Outside fenced verbatim regions, every runner-authored heading is emitted
  // exactly once — injected '## X' lines survive only as inert fence text.
  const structural = stripFences(md);
  for (const h of ['## Runner facts', '## Coverage', '## Claims', '## Limitations']) {
    assert.equal(structural.split(`\n${h}`).length - 1, 1, `${h} must appear exactly once outside fences`);
  }
  assert.equal(structural.split('\n## Strengths').length - 1, 0, 'no strengths admitted → no injected section');
  assert.ok(md.includes('⏎'), 'newlines collapsed to a visible marker, not structure');
  // The scribe summary is fenced verbatim — its embedded fake headings stay text.
  assert.match(md, /~~~text\nreal summary\n## Runner facts[\s\S]*?~~~/);
  // Pipe injection inside list items is escaped.
  assert.ok(md.includes('is \\| a pipe'), 'table/list pipe escaped');
});

test('fenceProse: a tilde-run inside prose can never close its own fence', () => {
  const report = buildCouncilReport({
    ...mkInput([], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]),
    runnerLimitations: ['bounded round'],
    scribe: { summary: 'has ~~~ tildes\n~~~~ and four\n## Limitations' },
  });
  const md = renderReportMarkdown(report);
  // Fence grew past the longest run; the embedded fake heading stays inside.
  assert.match(md, /~~~~~text\nhas ~~~ tildes\n~~~~ and four\n## Limitations\n~~~~~/);
  assert.equal(stripFences(md).split('\n## Limitations').length - 1, 1, 'only the runner Limitations heading exists');
});

// ─── strengths, provenance, discussion accounting ───────────────────────────

test('buildCouncilReport + render: canonical strengths and provenance persist and render', () => {
  const ledger = mkLedger([]);
  ledger.strengths = [{
    strengthId: 'S-1',
    feature: 'Hash-bound roster approval',
    benefit: 'Lets a security seat diff exactly what was approved',
    preserve: 'Do not weaken the binding to tolerate drift',
    evidence: [{ kind: 'reasoned', note: 'design' }],
    participantId: 'rev0',
    perspectiveId: 'p0',
  }];
  const report = buildCouncilReport({
    ...mkInput([], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]),
    ledger,
    provenance: { snapshotId: 'snap_9', gitHead: 'abc123', targetRoot: '/t', objective: 'review it' },
  });
  assert.equal(report.strengths?.length, 1);
  assert.equal(report.strengths?.[0]?.participantId, 'rev0', 'runner-stamped provenance');
  assert.equal(report.runnerFacts?.strengths, 1);
  assert.equal(report.provenance?.gitHead, 'abc123');
  const md = renderReportMarkdown(report);
  assert.match(md, /## Provenance\n\n- snapshot: snap_9/);
  assert.match(md, /- git head: abc123/);
  assert.match(md, /## Strengths/);
  assert.match(md, /### S-1: Hash-bound roster approval/);
  assert.match(md, /reported by: rev0 \(perspective p0\)/);
  assert.match(md, /Preserve:\n~~~text\nDo not weaken the binding/);
  const sm = renderSummaryMarkdown(report);
  assert.match(sm, /- canonical strengths: 1/);
  assert.match(sm, /Strengths.*:\n- Hash-bound roster approval — reported by rev0/s);
  assert.match(sm, /- reviewed: snapshot snap_9 @ abc123 — \/t/);
});

test('buildCouncilReport: zero strengths is honest — no section, count zero', () => {
  const report = buildCouncilReport(mkInput([], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]));
  assert.equal(report.strengths, undefined, 'absent ledger strengths stays absent');
  assert.equal(report.runnerFacts?.strengths, 0, 'runner facts disclose the honest zero');
  const md = renderReportMarkdown(report);
  assert.ok(!md.includes('## Strengths'), 'no praise manufactured');
  assert.match(md, /- canonical strengths: 0/);
});

test('runnerFacts.discussion + unansweredChallenges render per-round accounting', () => {
  const claim = mkClaim('clm_0001', {
    challenges: [
      { challengeId: 'ch-r1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', round: 1, challengerPid: 'rev1', kind: 'other', answered: false },
      { challengeId: 'ch-r1-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', round: 1, challengerPid: 'rev1', kind: 'other', answered: true, response: { participantId: 'rev0', disposition: 'defend' } },
    ],
    dissent: [{ participantId: 'rev1', round: 1, position: 'x', ts: 't', challengeId: 'ch-r1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
  });
  const ledger = mkLedger([claim]);
  ledger.discussion = {
    rounds: [{
      round: 1,
      challenges: {
        routedClaimIds: ['clm_0001', 'clm_0002'],
        byteDroppedClaimIds: ['clm_0003'],
        unassigned: [{ claimId: 'clm_0004', reason: 'all eligible challengers at cap' }],
      },
      responses: {
        routedChallengeIds: ['ch-r1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        byteDropped: [{ claimId: 'clm_0002', authorPid: 'rev0' }],
        capOmitted: [{ challengeId: 'ch-r1-cccccccccccccccccccccccccccccccc', claimId: 'clm_0005', authorPid: 'rev0' }],
        unroutable: [],
      },
    }],
  };
  const report = buildCouncilReport({ ...mkInput([], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]), ledger });
  const rf = report.runnerFacts!;
  // Answered is not resolved: retained dissent stays, unanswered is separate.
  assert.deepEqual(rf.claims.unansweredChallenges, ['clm_0001']);
  assert.deepEqual(rf.claims.withDissent, ['clm_0001']);
  const d = rf.discussion![0]!;
  assert.equal(d.challengesFiled, 2);
  assert.equal(d.challengesAnswered, 1);
  assert.equal(d.challengesUnanswered, 1);
  assert.equal(d.claimsRouted, 2);
  assert.equal(d.claimsRoutedNoChallenge, 1, 'clm_0002 routed but unchallenged');
  assert.equal(d.claimsNeverRouted, 2);
  assert.equal(d.claimsUnassigned, 1);
  assert.equal(d.claimsByteDropped, 1);
  assert.equal(d.responsesRouted, 1);
  assert.equal(d.responsesByteDropped, 1);
  assert.equal(d.responsesCapOmitted, 1);
  assert.equal(d.responsesUnroutable, 0);
  const md = renderReportMarkdown(report);
  assert.match(md, /1 claim with UNANSWERED challenges: clm_0001/);
  assert.match(md, /round 1: 2 challenges filed \(1 answered, 1 unanswered\)/);
  assert.match(md, /never routed 2 \(unassigned 1, byte-dropped 1\)/);
  assert.match(md, /responses routed 1, dropped 1, cap-omitted 1, unroutable 0/);
  // The claim itself renders the challenge lifecycle with qualified ids.
  assert.match(md, /ch-r1-a{32} — other by rev1, round 1: \*\*unanswered\*\*/);
  assert.match(md, /ch-r1-b{32} — other by rev1, round 1: answered — defend by rev0/);
});

// ─── summary parity ──────────────────────────────────────────────────────────

test('renderSummaryMarkdown: same severity/grade ordering, limitations never omitted', () => {
  const claims = [
    mkClaim('clm_0001', { severity: 'medium', grade: 'verified_defect' }),
    mkClaim('clm_0002', { severity: 'medium', grade: 'speculative' }),
    mkClaim('clm_0003', { severity: 'high', grade: 'unsupported' }),
  ];
  const report = buildCouncilReport({
    ...mkInput(claims, [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]),
    runnerLimitations: ['bounded discussion round'],
  });
  const sm = renderSummaryMarkdown(report);
  const i3 = sm.indexOf('clm_0003');
  const i1 = sm.indexOf('clm_0001');
  const i2 = sm.indexOf('clm_0002');
  // high/unsupported outranks medium/verified_defect outranks medium/speculative —
  // identical to the full report's severity→grade→id ordering.
  assert.ok(i3 > -1 && i1 > i3 && i2 > i1, 'summary ordering must match full report');
  assert.match(sm, /Limitations:\n- \[runner\] bounded discussion round/);
});

test('renderSummaryMarkdown: >10 claims discloses the remainder', () => {
  const claims = Array.from({ length: 12 }, (_, i) => mkClaim(`clm_${String(i).padStart(4, '0')}`));
  const report = buildCouncilReport(mkInput(claims, [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]));
  const sm = renderSummaryMarkdown(report);
  assert.match(sm, /…and 2 more — see report\.md/);
});

test('buildCouncilReport: dedupeKey and rejectedEvidence provenance render on claims', () => {
  const claim = mkClaim('clm_0001', { dedupeKey: 'defect|timeout missing', rejectedEvidence: 2 });
  const report = buildCouncilReport(mkInput([claim], [mkParticipant(0, 'completed'), mkParticipant(1, 'completed')]));
  const md = renderReportMarkdown(report);
  assert.match(md, /- dedupe key: `defect\|timeout missing`/);
  assert.match(md, /- rejected evidence items: 2/);
});
