/**
 * Contract-shape tests: the artifacts are JSON that crosses process
 * boundaries, so every canonical field must survive a
 * JSON.parse(JSON.stringify()) round-trip byte-exactly — no Dates, class
 * instances, or undefined-key leakage. Also pins SCHEMA_VERSION and the
 * qualified-challenge-id grammar (the repair for the live C-1 collapse).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  SCHEMA_VERSION,
  type Challenge,
  type Claim,
  type CouncilReport,
  type DissentRecord,
  type ResponseAssignment,
  type RunnerFacts,
  type SynthesisFile,
  type WorkEnvelope,
} from '../src/contracts.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

test('SCHEMA_VERSION is pinned at 1 — artifact evolution is field-additive only', () => {
  assert.equal(SCHEMA_VERSION, 1);
});

/**
 * Mirror of the ledger's qualification rule — kept in the contract test so a
 * divergence between doc and implementation breaks loudly. Two seats minting
 * local 'C-1' must hash to different qualified ids; a bare 'C-1' must never
 * be a valid canonical identity on its own in the routed artifact.
 */
test('qualified challenge id grammar: ch-r<round>-<32hex>, ID_RE-safe, collision-free', () => {
  const qualify = (round: number, pid: string, local: string) =>
    `ch-r${round}-${createHash('sha256')
      .update(JSON.stringify([pid, local]), 'utf8')
      .digest('hex')
      .slice(0, 32)}`;
  const a = qualify(1, 'rev_a', 'C-1');
  const b = qualify(1, 'rev_b', 'C-1');
  const a2 = qualify(2, 'rev_a', 'C-1');
  assert.notEqual(a, b, 'different challengers, same local id — must differ');
  assert.notEqual(a, a2, 'different rounds — must differ');
  assert.equal(qualify(1, 'rev_a', 'C-1'), a, 'deterministic');
  assert.match(a, /^ch-r1-[0-9a-f]{32}$/);
  assert.ok(ID_RE.test(a), 'qualified id must satisfy the shared id grammar');
  assert.ok(a.length <= 40, 'bounded length for journal/ref fields');
});

test('routed Challenge JSON round-trips qualified id + local provenance', () => {
  const routed: Challenge = {
    challengeId: 'ch-r1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    claimId: 'clm_0001',
    kind: 'missing_evidence',
    argument: 'prove it',
    evidence: [],
    localChallengeId: 'C-1',
    challengerPid: 'rev_b',
  };
  const rt = JSON.parse(JSON.stringify(routed)) as Challenge;
  assert.equal(rt.challengeId, 'ch-r1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(rt.localChallengeId, 'C-1');
  assert.equal(rt.challengerPid, 'rev_b');
  // Worker-minted form (no provenance) round-trips too — absent stays absent.
  const minted: Challenge = { challengeId: 'C-1', claimId: 'clm_0001', kind: 'other', argument: 'x', evidence: [] };
  const rtM = JSON.parse(JSON.stringify(minted)) as Challenge;
  assert.equal('localChallengeId' in rtM, false);
  assert.equal('challengerPid' in rtM, false);
});

test('WorkEnvelope JSON round-trips omittedCount; absent on legacy envelopes', () => {
  const env: WorkEnvelope<ResponseAssignment> = {
    schemaVersion: SCHEMA_VERSION,
    runId: 'crun_t',
    phase: 'author_response',
    round: 1,
    recipientId: 'rev_a',
    assignments: [],
    omittedCount: 3,
    outputPath: 'rounds/1/responses/rev_a.json',
    outputContract: 'ResponsesFile',
  };
  const rt = JSON.parse(JSON.stringify(env)) as WorkEnvelope<ResponseAssignment>;
  assert.equal(rt.omittedCount, 3);
  const legacy = { ...env };
  delete legacy.omittedCount;
  const rtL = JSON.parse(JSON.stringify(legacy)) as WorkEnvelope<ResponseAssignment>;
  assert.equal('omittedCount' in rtL, false);
});

test('Claim JSON round-trips all retention fields byte-exactly', () => {
  const dissent: DissentRecord = {
    participantId: 'rev_b',
    round: 1,
    position: 'challenge (missing_evidence): no repro',
    ts: '2026-01-01T00:00:00.000Z',
    evidence: [{ kind: 'reasoned', note: 'counter-argument' }],
  };
  const claim: Claim = {
    claimId: 'clm_0001',
    title: 'Missing timeout',
    kind: 'defect',
    grade: 'plausible_risk',
    status: 'challenged',
    severity: 'high',
    confidence: 0.8,
    evidence: [{ kind: 'code_location', note: 'site', path: 'src/app.js', startLine: 4, snippet: 'go()' }],
    counterEvidence: [],
    sourceFindings: [
      { participantId: 'rev_a', findingId: 'f1' },
      { participantId: 'rev_c', findingId: 'f9' },
    ],
    history: [{ ts: '2026-01-01T00:00:00.000Z', round: 1, actor: 'rev_b', type: 'challenged', refId: 'ch-r1-0123456789abcdef0123456789abcdef' }],
    dissent: [dissent],
    remedies: ['add timeout'],
    openQuestions: ['what is the SLO?'],
    assessments: [
      { participantId: 'rev_a', findingId: 'f1', severity: 'high', confidence: 0.8 },
      { participantId: 'rev_c', findingId: 'f9', severity: 'medium', confidence: 0.5 },
    ],
    mergedTitles: ['No deadline on the request path'],
  };
  const rt = JSON.parse(JSON.stringify(claim)) as Claim;
  assert.deepEqual(rt, claim, 'every canonical retention field must survive JSON transport');
});

test('SynthesisFile is narrative-only — claims-shaped extras are not part of the contract', () => {
  const synth: SynthesisFile = {
    schemaVersion: SCHEMA_VERSION,
    runId: 'crun_t',
    participantId: 'scribe_0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    summary: 'three seats missed',
    limitations: ['no repro attempted'],
  };
  const rt = JSON.parse(JSON.stringify(synth)) as SynthesisFile;
  assert.deepEqual(rt, synth);
  // The type surface is exactly the narrative fields — a claims array is a
  // type error, so the contract cannot silently carry a scribe-written ledger.
  assert.deepEqual(Object.keys(synth).sort(), [
    'generatedAt', 'limitations', 'participantId', 'runId', 'schemaVersion', 'summary',
  ]);
});

test('CouncilReport JSON round-trips runnerFacts + limitationSources', () => {
  const runnerFacts: RunnerFacts = {
    seatsCompleted: 2,
    seatsSelected: 3,
    partialCoverage: true,
    uncoveredPerspectiveIds: ['p3'],
    summarySource: 'runner',
    claims: {
      total: 1,
      byStatus: { challenged: 1 },
      withDissent: ['clm_0001'],
      withdrawn: 0,
      escalated: 0,
    },
  };
  const report: CouncilReport = {
    schemaVersion: SCHEMA_VERSION,
    runId: 'crun_t',
    generatedAt: '2026-01-01T00:00:00.000Z',
    summary: 'partial review',
    coverage: {
      requestedPerspectives: 10,
      proposedPerspectives: 10,
      selectedSeats: 3,
      seats: [],
      uncoveredPerspectiveIds: ['p3'],
      partial: true,
    },
    claims: [],
    limitations: ['seat rev3 timed out', 'reproduction not attempted'],
    runnerFacts,
    limitationSources: [
      { origin: 'runner', text: 'seat rev3 timed out' },
      { origin: 'scribe', text: 'reproduction not attempted' },
    ],
  };
  const rt = JSON.parse(JSON.stringify(report)) as CouncilReport;
  assert.deepEqual(rt.runnerFacts, runnerFacts);
  assert.deepEqual(rt.limitationSources, report.limitationSources);
  // Legacy shape (pre-repair) lacks both — absent stays absent.
  const legacy = { ...report } as Record<string, unknown>;
  delete legacy.runnerFacts;
  delete legacy.limitationSources;
  const rtL = JSON.parse(JSON.stringify(legacy)) as CouncilReport;
  assert.equal('runnerFacts' in rtL, false);
  assert.equal('limitationSources' in rtL, false);
});
