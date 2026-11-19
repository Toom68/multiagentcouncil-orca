import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeRelativePath,
  canonicalApprovalHash,
  canonicalRosterHash,
  DEFAULT_CONFIG,
  maxClaimGrade,
  minViableLaunches,
  parseApprovedRoster,
  parseApprovalBinding,
  parseChallengeEnvelope,
  parseChallengesFile,
  parseCouncilState,
  parseFindingsFile,
  parseJournalEvent,
  parseProposedRoster,
  parseReportFile,
  parseResponseEnvelope,
  parseResponsesFile,
  parseScribeNotesFile,
  parseSourceSnapshot,
  parseSynthesisFile,
  resolveConfig,
} from '../src/validation.js';
import type {
  ApprovalBinding,
  CouncilConfig,
  Evidence,
  Perspective,
  ProposedRoster,
} from '../src/contracts.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const RUN = 'crun_test01';

function mkPerspective(i: number): Perspective {
  return {
    perspectiveId: `p${i}`,
    name: `Perspective ${i}`,
    charter: {
      incentives: `incentives ${i}`,
      expertise: `expertise ${i}`,
      method: `method ${i}`,
      blindSpots: `blind spots ${i}`,
      reviewQuestions: [`question ${i}?`],
    },
    tags: [`t${i}`],
  };
}

function mkProposal(n: number): ProposedRoster {
  return {
    schemaVersion: 1,
    runId: RUN,
    perspectives: Array.from({ length: n }, (_, i) => mkPerspective(i)),
  };
}

function mkSeat(i: number, p = `p${i}`) {
  return {
    seatId: `s${i}`,
    perspectiveId: p,
    participantId: `rev${i}`,
    agent: { agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass' },
  };
}

function mkApproved(n: number) {
  return { schemaVersion: 1, runId: RUN, seats: Array.from({ length: n }, (_, i) => mkSeat(i)) };
}

function issues(res: { ok: boolean; issues?: { code: string; path: string }[] }): string {
  return (res.ok ? [] : (res.issues ?? [])).map((i) => `${i.path}:${i.code}`).join(', ');
}

function hasCode(res: { ok: boolean; issues?: { code: string }[] }, code: string): boolean {
  return !res.ok && (res.issues ?? []).some((i) => i.code === code);
}

const ev = (kind: Evidence['kind'], extra: Partial<Evidence> = {}): Evidence => ({
  kind,
  note: 'note',
  ...extra,
});

// ─── resolveConfig ───────────────────────────────────────────────────────────

test('resolveConfig fills approved defaults', () => {
  const r = resolveConfig({});
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.requestedPerspectives, 15);
  assert.equal(r.value.participants, 15);
  assert.equal(r.value.concurrency, 5);
  assert.equal(r.value.rounds, 1);
  assert.equal(r.value.envelopeBytes, 8192);
  assert.equal(r.value.maxFindingsPerSeat, 7);
  assert.equal(r.value.maxChallengesPerSeatPerRound, 3);
  assert.equal(r.value.maxLaunches, minViableLaunches({ participants: 15, rounds: 1 }) + 8);
});

test('resolveConfig accepts smoke config (10 proposed, 2 seats)', () => {
  const r = resolveConfig({ requestedPerspectives: 10, participants: 2 });
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.requestedPerspectives, 10);
  assert.equal(r.value.participants, 2);
  assert.equal(r.value.maxLaunches, minViableLaunches({ participants: 2, rounds: 1 }) + 8);
});

test('resolveConfig rejects requestedPerspectives outside 10-25', () => {
  assert.ok(hasCode(resolveConfig({ requestedPerspectives: 9 }), 'too_small'));
  assert.ok(hasCode(resolveConfig({ requestedPerspectives: 26 }), 'too_large'));
});

test('resolveConfig rejects participants exceeding proposal', () => {
  const r = resolveConfig({ requestedPerspectives: 10, participants: 11 });
  assert.ok(hasCode(r, 'too_large'));
});

test('resolveConfig enforces rounds 1-3', () => {
  assert.ok(hasCode(resolveConfig({ rounds: 0 }), 'too_small'));
  assert.ok(hasCode(resolveConfig({ rounds: 4 }), 'too_large'));
  assert.ok(resolveConfig({ rounds: 3 }).ok);
});

test('resolveConfig refuses maxLaunches below workflow minimum', () => {
  // 15 seats / 1 round needs 15 + 30 + 3 = 48; 40 must fail (coordinator vector).
  const r = resolveConfig({ maxLaunches: 40 });
  assert.ok(hasCode(r, 'too_small'), issues(r));
  const okHigh = resolveConfig({ maxLaunches: 200 });
  assert.ok(okHigh.ok, issues(okHigh));
});

test('resolveConfig validates quorumRatio range', () => {
  assert.ok(hasCode(resolveConfig({ quorumRatio: 0 }), 'too_small'));
  assert.ok(hasCode(resolveConfig({ quorumRatio: 1.5 }), 'too_large'));
  assert.ok(resolveConfig({ quorumRatio: 0.5 }).ok);
});

test('resolveConfig rejects bad types and bad deadlines', () => {
  assert.ok(hasCode(resolveConfig({ participants: 'fifteen' }), 'type'));
  assert.ok(hasCode(resolveConfig({ deadlines: { organiserMs: 10 } }), 'too_small'));
});

// ─── paths ───────────────────────────────────────────────────────────────────

test('assertSafeRelativePath accepts plain relative paths', () => {
  for (const p of ['findings/rev1.json', 'rounds/1/outbox/rev2.json', 'a-b_c.d/e.json']) {
    assert.equal(assertSafeRelativePath(p).ok, true, p);
  }
});

test('assertSafeRelativePath rejects traversal and unsafe paths', () => {
  for (const p of ['../x', 'a/../b', '/abs', 'C:/x', 'a\\b', 'a//b', './x', 'a/./b', '', 'a b.txt', 'a:b', 'a?b']) {
    assert.equal(assertSafeRelativePath(p).ok, false, p);
  }
});

// ─── roster ──────────────────────────────────────────────────────────────────

test('parseProposedRoster accepts a valid 10-perspective proposal', () => {
  const r = parseProposedRoster(mkProposal(10), { runId: RUN, requestedPerspectives: 10 });
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.perspectives.length, 10);
});

test('parseProposedRoster enforces exact requested count', () => {
  assert.ok(hasCode(parseProposedRoster(mkProposal(9), { requestedPerspectives: 10 }), 'bad_count'));
  assert.ok(hasCode(parseProposedRoster(mkProposal(11), { requestedPerspectives: 10 }), 'bad_count'));
});

test('parseProposedRoster rejects duplicate perspective ids and bad charters', () => {
  const dup = mkProposal(10);
  dup.perspectives[1]!.perspectiveId = 'p0';
  assert.ok(hasCode(parseProposedRoster(dup, { requestedPerspectives: 10 }), 'duplicate'));
  const bad = mkProposal(10);
  (bad.perspectives[0]!.charter as Record<string, unknown>).method = '';
  assert.ok(hasCode(parseProposedRoster(bad, { requestedPerspectives: 10 }), 'too_short'));
});

test('parseProposedRoster rejects runId mismatch', () => {
  assert.ok(hasCode(parseProposedRoster(mkProposal(10), { runId: 'crun_other', requestedPerspectives: 10 }), 'mismatch'));
});

test('parseApprovedRoster accepts 2 seats selected from 10 (smoke)', () => {
  const cfg = resolveConfig({ requestedPerspectives: 10, participants: 2 });
  assert.ok(cfg.ok);
  const r = parseApprovedRoster(mkApproved(2), { runId: RUN, proposed: mkProposal(10), config: cfg.value });
  assert.ok(r.ok, issues(r));
});

test('parseApprovedRoster rejects unknown perspective, duplicates, wrong count', () => {
  const proposed = mkProposal(10);
  const cfg = resolveConfig({ requestedPerspectives: 10, participants: 2 });
  assert.ok(cfg.ok);
  const ctx = { runId: RUN, proposed, config: cfg.value };

  const unknown = mkApproved(2);
  unknown.seats[1]!.perspectiveId = 'not-proposed';
  assert.ok(hasCode(parseApprovedRoster(unknown, ctx), 'unknown'));

  const dupSeat = mkApproved(2);
  dupSeat.seats[1]!.seatId = 's0';
  assert.ok(hasCode(parseApprovedRoster(dupSeat, ctx), 'duplicate'));

  const dupPersp = mkApproved(2);
  dupPersp.seats[1]!.perspectiveId = 'p0';
  dupPersp.seats[1]!.participantId = 'revX';
  assert.ok(hasCode(parseApprovedRoster(dupPersp, ctx), 'duplicate'));

  assert.ok(hasCode(parseApprovedRoster(mkApproved(3), ctx), 'bad_count'));
});

test('parseApprovedRoster requires explicit per-seat agent/model/permission tokens', () => {
  const cfg = resolveConfig({ requestedPerspectives: 10, participants: 2 });
  assert.ok(cfg.ok);
  const ctx = { runId: RUN, proposed: mkProposal(10), config: cfg.value };
  const missing = mkApproved(2);
  delete (missing.seats[0]!.agent as Record<string, unknown>).model;
  assert.ok(hasCode(parseApprovedRoster(missing, ctx), 'type'));

  const shelly = mkApproved(2);
  (shelly.seats[0]!.agent as Record<string, unknown>).model = 'swe-2-max; rm -rf /';
  assert.ok(hasCode(parseApprovedRoster(shelly, ctx), 'bad_token'));

  const noPerm = mkApproved(2);
  delete (noPerm.seats[0]!.agent as Record<string, unknown>).permissionMode;
  assert.ok(hasCode(parseApprovedRoster(noPerm, ctx), 'type'));
});

// ─── findings ────────────────────────────────────────────────────────────────

function mkFinding(id = 'f1', evidence: Evidence[] = [ev('reasoned')]) {
  return {
    findingId: id,
    title: 'something is wrong',
    kind: 'defect',
    severity: 'high',
    confidence: 0.8,
    evidence,
  };
}

test('parseFindingsFile accepts a valid independent-phase file', () => {
  const r = parseFindingsFile(
    { schemaVersion: 1, runId: RUN, participantId: 'rev0', perspectiveId: 'p0', findings: [mkFinding()] },
    { runId: RUN, participantId: 'rev0', perspectiveId: 'p0' },
  );
  assert.ok(r.ok, issues(r));
});

test('parseFindingsFile enforces findings cap', () => {
  const findings = Array.from({ length: 8 }, (_, i) => mkFinding(`f${i}`));
  const r = parseFindingsFile(
    { schemaVersion: 1, runId: RUN, participantId: 'rev0', perspectiveId: 'p0', findings },
    { maxFindings: 7 },
  );
  assert.ok(hasCode(r, 'too_many'));
});

test('parseFindingsFile requires >=1 evidence item per finding', () => {
  const r = parseFindingsFile(
    { schemaVersion: 1, runId: RUN, participantId: 'rev0', perspectiveId: 'p0', findings: [mkFinding('f1', [])] },
    {},
  );
  assert.ok(hasCode(r, 'required'));
});

test('code_location evidence requires safe path and startLine', () => {
  const noPath = parseFindingsFile(
    { schemaVersion: 1, runId: RUN, participantId: 'rev0', perspectiveId: 'p0', findings: [mkFinding('f1', [ev('code_location', { startLine: 3 })])] },
    {},
  );
  assert.ok(hasCode(noPath, 'required'), issues(noPath));

  const traversal = parseFindingsFile(
    { schemaVersion: 1, runId: RUN, participantId: 'rev0', perspectiveId: 'p0', findings: [mkFinding('f1', [ev('code_location', { path: '../secret', startLine: 3 })])] },
    {},
  );
  assert.ok(hasCode(traversal, 'unsafe_path'), issues(traversal));

  const noLine = parseFindingsFile(
    { schemaVersion: 1, runId: RUN, participantId: 'rev0', perspectiveId: 'p0', findings: [mkFinding('f1', [ev('code_location', { path: 'src/a.ts' })])] },
    {},
  );
  assert.ok(hasCode(noLine, 'required'), issues(noLine));
});

test('repro evidence requires captured steps and observed result', () => {
  const r = parseFindingsFile(
    { schemaVersion: 1, runId: RUN, participantId: 'rev0', perspectiveId: 'p0', findings: [mkFinding('f1', [ev('repro', { steps: 'do x' })])] },
    {},
  );
  assert.ok(hasCode(r, 'required'));
});

test('finding enums are finite and bounded', () => {
  const badKind = { ...mkFinding(), kind: 'catastrophe' };
  const r = parseFindingsFile(
    { schemaVersion: 1, runId: RUN, participantId: 'rev0', perspectiveId: 'p0', findings: [badKind] },
    {},
  );
  assert.ok(hasCode(r, 'bad_enum'));
});

// ─── challenges / responses ──────────────────────────────────────────────────

test('parseChallengesFile accepts valid typed output', () => {
  const r = parseChallengesFile(
    {
      schemaVersion: 1, runId: RUN, round: 1, participantId: 'rev1',
      challenges: [{ challengeId: 'ch1', claimId: 'c1', kind: 'missing_evidence', argument: 'no repro', evidence: [] }],
    },
    { runId: RUN, round: 1, participantId: 'rev1' },
  );
  assert.ok(r.ok, issues(r));
});

test('parseChallengesFile enforces round, count and enums', () => {
  const mk = (challenges: unknown[]) => ({ schemaVersion: 1, runId: RUN, round: 1, participantId: 'rev1', challenges });
  assert.ok(hasCode(parseChallengesFile(mk([]), { round: 2 }), 'mismatch'));
  const tooMany = Array.from({ length: 4 }, (_, i) => ({ challengeId: `ch${i}`, claimId: 'c1', kind: 'other', argument: 'x', evidence: [] }));
  assert.ok(hasCode(parseChallengesFile(mk(tooMany), { max: 3 }), 'too_many'));
  assert.ok(hasCode(parseChallengesFile(mk([{ challengeId: 'c', claimId: 'c1', kind: 'rude', argument: 'x', evidence: [] }]), {}), 'bad_enum'));
});

test('parseResponsesFile requires revisedFinding on revise', () => {
  const base = { claimId: 'c1', challengeId: 'ch1', argument: 'fixed', evidence: [] };
  const noRevise = parseResponsesFile(
    { schemaVersion: 1, runId: RUN, round: 1, participantId: 'rev0', responses: [{ ...base, disposition: 'revise' }] },
    {},
  );
  assert.ok(hasCode(noRevise, 'required'), issues(noRevise));
  const withRevise = parseResponsesFile(
    { schemaVersion: 1, runId: RUN, round: 1, participantId: 'rev0', responses: [{ ...base, disposition: 'revise', revisedFinding: mkFinding() }] },
    {},
  );
  assert.ok(withRevise.ok, issues(withRevise));
});

// ─── envelopes ───────────────────────────────────────────────────────────────

test('parseChallengeEnvelope accepts single-recipient envelope', () => {
  const env = {
    schemaVersion: 1, runId: RUN, phase: 'challenge', round: 1, recipientId: 'rev1',
    assignments: [{
      assignmentId: 'a1', claimId: 'c1', question: 'is this reproducible?',
      claim: { claimId: 'c1', title: 't', kind: 'defect', severity: 'high', evidence: [ev('reasoned')], counterEvidence: [] },
    }],
    outputPath: 'rounds/1/challenges/rev1.json', outputContract: 'ChallengesFile',
  };
  const r = parseChallengeEnvelope(env, { runId: RUN, round: 1 });
  assert.ok(r.ok, issues(r));
});

test('parseChallengeEnvelope rejects unsafe outputPath and over-cap assignments', () => {
  const base = {
    schemaVersion: 1, runId: RUN, phase: 'challenge', round: 1, recipientId: 'rev1',
    outputPath: 'rounds/1/challenges/rev1.json', outputContract: 'ChallengesFile',
  };
  assert.ok(hasCode(parseChallengeEnvelope({ ...base, outputPath: '../../etc', assignments: [] }, {}), 'unsafe_path'));
  const many = Array.from({ length: 4 }, (_, i) => ({
    assignmentId: `a${i}`, claimId: 'c1', question: 'q',
    claim: { claimId: 'c1', title: 't', kind: 'defect', severity: 'high', evidence: [ev('reasoned')], counterEvidence: [] },
  }));
  assert.ok(hasCode(parseChallengeEnvelope({ ...base, assignments: many }, { maxAssignments: 3 }), 'too_many'));
});

// ─── snapshot / approval / hashing ───────────────────────────────────────────

function mkSnapshot() {
  return {
    schemaVersion: 1,
    snapshotId: 'snap1',
    targetRoot: '/repo',
    gitHead: 'abc123',
    takenAt: '2026-11-18T00:00:00Z',
    headHash: 'a'.repeat(64),
    files: { 'src/a.ts': { sha256: 'b'.repeat(64), size: 12 } },
  };
}

test('parseSourceSnapshot accepts valid and rejects unsafe file keys', () => {
  assert.ok(parseSourceSnapshot(mkSnapshot()).ok);
  const bad = mkSnapshot();
  (bad.files as Record<string, unknown>)['../escape'] = { sha256: 'b'.repeat(64), size: 1 };
  assert.ok(hasCode(parseSourceSnapshot(bad), 'unsafe_path'));
  const badHash = mkSnapshot();
  badHash.headHash = 'not-a-hash';
  assert.ok(hasCode(parseSourceSnapshot(badHash), 'bad_hash'));
});

function mkBinding(over: Partial<ApprovalBinding> = {}): ApprovalBinding {
  const cfg = resolveConfig({});
  if (!cfg.ok) throw new Error('config');
  return {
    schemaVersion: 1,
    runId: RUN,
    objective: 'review the thing',
    seats: mkApproved(15).seats,
    proposedRosterHash: canonicalRosterHash(mkProposal(15)),
    config: cfg.value,
    snapshotId: 'snap1',
    snapshotHeadHash: 'a'.repeat(64),
    ...over,
  };
}

test('canonicalApprovalHash is deterministic across key order', () => {
  const a = mkBinding();
  const b: ApprovalBinding = {
    schemaVersion: a.schemaVersion,
    runId: a.runId,
    objective: a.objective,
    seats: a.seats,
    proposedRosterHash: a.proposedRosterHash,
    config: a.config,
    snapshotId: a.snapshotId,
    snapshotHeadHash: a.snapshotHeadHash,
  };
  assert.equal(canonicalApprovalHash(a), canonicalApprovalHash(b));
});

test('approval hash changes on every invalidation vector', () => {
  const base = mkBinding();
  const h = canonicalApprovalHash(base);
  const vectors: Record<string, ApprovalBinding> = {
    objective: mkBinding({ objective: 'review another thing' }),
    seats: mkBinding({ seats: mkApproved(15).seats.map((s, i) => (i === 0 ? { ...s, seatId: 'different' } : s)) }),
    config: mkBinding({ config: { ...base.config, participants: 14 } }),
    snapshotHeadHash: mkBinding({ snapshotHeadHash: 'c'.repeat(64) }),
    proposedRosterHash: mkBinding({ proposedRosterHash: 'd'.repeat(64) }),
  };
  for (const [name, b] of Object.entries(vectors)) {
    assert.notEqual(canonicalApprovalHash(b), h, `vector ${name} must change the hash`);
  }
});

test('editing a perspective charter changes canonicalRosterHash (approval invalidates)', () => {
  const p1 = mkProposal(15);
  const p2 = mkProposal(15);
  p2.perspectives[3]!.charter.reviewQuestions = ['a different question?'];
  const p3 = mkProposal(15);
  p3.perspectives[3]!.charter.blindSpots = 'edited blind spots';
  const p4 = mkProposal(15);
  p4.perspectives = p4.perspectives.slice(0, 14);
  assert.notEqual(canonicalRosterHash(p1), canonicalRosterHash(p2), 'question edit');
  assert.notEqual(canonicalRosterHash(p1), canonicalRosterHash(p3), 'blindSpots edit');
  assert.notEqual(canonicalRosterHash(p1), canonicalRosterHash(p4), 'removal');
});

test('parseApprovalBinding requires proposedRosterHash', () => {
  const b = mkBinding() as unknown as Record<string, unknown>;
  delete b.proposedRosterHash;
  assert.ok(hasCode(parseApprovalBinding(b), 'type') || hasCode(parseApprovalBinding(b), 'required'), 'missing hash must fail');
  assert.ok(parseApprovalBinding(mkBinding()).ok);
});

// ─── grading ─────────────────────────────────────────────────────────────────

test('maxClaimGrade never lets reviewer-asserted claims reach verified_defect', () => {
  assert.equal(maxClaimGrade([ev('repro', { steps: 's', observed: 'o' })]), 'plausible_risk');
  assert.equal(maxClaimGrade([ev('repro', { steps: 's', observed: 'o' })], { independentlyValidated: true }), 'verified_defect');
  assert.equal(maxClaimGrade([ev('code_location', { path: 'a.ts', startLine: 1 })]), 'plausible_risk');
  assert.equal(maxClaimGrade([ev('speculative')]), 'speculative');
  assert.equal(maxClaimGrade([]), 'unsupported');
});

// ─── stored artifacts ────────────────────────────────────────────────────────

test('parseCouncilState round-trips a valid state', () => {
  const cfg = resolveConfig({});
  if (!cfg.ok) throw new Error('cfg');
  const state = {
    schemaVersion: 1, runId: RUN, orcaRunId: 'run_1', status: 'awaiting_approval',
    targetRoot: '/repo', objective: 'obj', config: cfg.value, snapshotId: 'snap1',
    approvalHash: null, participants: [], discussion: null,
    supervisor: { terminalHandle: 'term_1', dispatchId: 'ctx_1' },
    consumption: { launches: 1, mailSent: 2 },
    phaseEnteredAt: '2026-11-18T00:00:00Z', createdAt: '2026-11-18T00:00:00Z',
  };
  const r = parseCouncilState(state);
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.supervisor?.terminalHandle, 'term_1');
});

test('parseJournalEvent accepts a valid event and rejects bad type', () => {
  const good = { seq: 0, ts: '2026-11-18T00:00:00Z', type: 'phase.entered', actor: 'engine' };
  assert.ok(parseJournalEvent(good).ok);
  assert.ok(hasCode(parseJournalEvent({ ...good, type: 'made.up' }), 'bad_enum'));
});

test('parseScribeNotesFile and parseReportFile validate structure', () => {
  const notes = { schemaVersion: 1, runId: RUN, participantId: 'scribe0', claimSummaries: [{ claimId: 'c1', summary: 's', possibleDuplicates: [], openQuestions: [] }] };
  assert.ok(parseScribeNotesFile(notes, { runId: RUN, participantId: 'scribe0' }).ok);

  const report = {
    schemaVersion: 1, runId: RUN, generatedAt: '2026-11-18T00:00:00Z', summary: 'done',
    coverage: {
      requestedPerspectives: 10, proposedPerspectives: 10, selectedSeats: 2, partial: true,
      seats: [{
        participantId: 'rev0', perspectiveId: 'p0', seatId: 's0', outcome: 'completed',
        phasesCompleted: ['independent_review'],
      }],
      uncoveredPerspectiveIds: ['p9'],
    },
    claims: [], limitations: [],
  };
  const r = parseReportFile(report, { runId: RUN });
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.coverage.partial, true);
});

// ─── PUBLIC-USE: AgentChoice.profile ─────────────────────────────────────────

test('seat agent accepts optional named profile token and round-trips it', () => {
  const cfg = resolveConfig({ requestedPerspectives: 10, participants: 1 });
  assert.ok(cfg.ok);
  const seat = {
    seatId: 's0', perspectiveId: 'p0', participantId: 'rev0',
    agent: { agent: 'codex', model: 'gpt-6-astra', permissionMode: 'auto', profile: 'work' },
  };
  const r = parseApprovedRoster({ schemaVersion: 1, runId: RUN, seats: [seat] },
    { runId: RUN, proposed: mkProposal(10), config: cfg.value });
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.seats[0]!.agent.profile, 'work');
});

test('seat agent rejects an unsafe profile token and absent profile stays absent', () => {
  const cfg = resolveConfig({ requestedPerspectives: 10, participants: 1 });
  assert.ok(cfg.ok);
  const bad = {
    seatId: 's0', perspectiveId: 'p0', participantId: 'rev0',
    agent: { agent: 'codex', model: 'm', permissionMode: 'auto', profile: '../x' },
  };
  const r = parseApprovedRoster({ schemaVersion: 1, runId: RUN, seats: [bad] },
    { runId: RUN, proposed: mkProposal(10), config: cfg.value });
  assert.ok(!r.ok);
  assert.ok(hasCode(r, 'bad_token'));
  const good = parseApprovedRoster(mkApproved(1), { runId: RUN, proposed: mkProposal(10), config: cfg.value });
  assert.ok(good.ok, issues(good));
  assert.equal('profile' in good.value.seats[0]!.agent, false);
});

// ─── PUBLIC-USE: config.staff ────────────────────────────────────────────────

const mkChoice = (over: Record<string, unknown> = {}) => ({
  agent: 'devin', model: 'swe-2-max', permissionMode: 'bypass', ...over,
});

test('resolveConfig accepts a complete staff object with mixed agents', () => {
  const r = resolveConfig({
    staff: {
      organiser: mkChoice(),
      scribe: mkChoice({ agent: 'claude', model: 'claude-sonnet-4-6', permissionMode: 'auto', effort: 'high' }),
      supervisor: mkChoice({ agent: 'codex', model: 'gpt-6-astra', permissionMode: 'auto', profile: 'ops' }),
    },
  });
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.staff!.scribe.agent, 'claude');
  assert.equal(r.value.staff!.supervisor.profile, 'ops');
  // round-trip: re-resolving the resolved config is a fixed point
  const again = resolveConfig(r.value);
  assert.ok(again.ok, issues(again));
  assert.deepEqual(again.value.staff, r.value.staff);
});

test('resolveConfig rejects partial staff (all three roles required)', () => {
  assert.ok(hasCode(resolveConfig({ staff: { organiser: mkChoice(), scribe: mkChoice() } }), 'type'));
  assert.ok(hasCode(resolveConfig({ staff: 'devin' }), 'type'));
  assert.ok(hasCode(resolveConfig({ staff: {} }), 'type'));
});

test('resolveConfig rejects explicit null staff/execution while preserving absence', () => {
  assert.ok(hasCode(resolveConfig({ staff: null }), 'type'));
  assert.ok(hasCode(resolveConfig({ execution: null }), 'type'));
  const absent = resolveConfig({});
  assert.ok(absent.ok);
  assert.equal('staff' in absent.value, false);
  assert.equal('execution' in absent.value, false);
});

test('resolveConfig rejects an invalid choice inside staff', () => {
  const r = resolveConfig({
    staff: {
      organiser: mkChoice(),
      scribe: mkChoice({ permissionMode: 'bad mode!' }),
      supervisor: mkChoice(),
    },
  });
  assert.ok(!r.ok);
  assert.ok(hasCode(r, 'bad_token'));
});

// ─── PUBLIC-USE: config.execution ────────────────────────────────────────────

test('resolveConfig accepts a valid execution fingerprint and round-trips it', () => {
  const execution = { catalogVersion: '1.0.0', policyHash: 'a'.repeat(64) };
  const r = resolveConfig({ execution });
  assert.ok(r.ok, issues(r));
  assert.deepEqual(r.value.execution, execution);
  const again = resolveConfig(r.value);
  assert.ok(again.ok);
  assert.deepEqual(again.value.execution, execution);
});

test('resolveConfig rejects malformed execution fingerprint', () => {
  assert.ok(hasCode(resolveConfig({ execution: { catalogVersion: '1.0.0' } }), 'type'));
  assert.ok(hasCode(resolveConfig({ execution: { catalogVersion: '1.0.0', policyHash: 'zz' } }), 'bad_hash'));
  assert.ok(hasCode(resolveConfig({ execution: 'sha256:abc' }), 'type'));
});

// ─── PUBLIC-USE: legacy absence is preserved ─────────────────────────────────

test('resolveConfig keeps staff/execution ABSENT on legacy configs', () => {
  const r = resolveConfig({ participants: 2, requestedPerspectives: 10 });
  assert.ok(r.ok);
  assert.equal('staff' in r.value, false);
  assert.equal('execution' in r.value, false);
});

test('legacy approval binding keeps its canonical hash (no injected fields)', () => {
  // mkBinding() builds a config with no staff/execution — identical canonical
  // form to pre-extension bindings. The literal pins it against regressions.
  const b = mkBinding();
  assert.equal(canonicalApprovalHash(b), '02dc767b6df915ea2f1d32c19a8c0f5f1c452842b8fc5ff39eacbb522d2d1f6a');
});

test('approval hash covers staff/execution/profile when present (approval-bound)', () => {
  const base = mkBinding();
  const h = canonicalApprovalHash(base);
  const withStaff = mkBinding({
    config: { ...base.config, staff: { organiser: mkChoice(), scribe: mkChoice(), supervisor: mkChoice() } as never },
  });
  assert.notEqual(canonicalApprovalHash(withStaff), h);
  const withExec = mkBinding({
    config: { ...base.config, execution: { catalogVersion: '1.0.0', policyHash: 'e'.repeat(64) } },
  });
  assert.notEqual(canonicalApprovalHash(withExec), h);
  const seatProfile = mkBinding();
  seatProfile.seats[0]!.agent.profile = 'work';
  assert.notEqual(canonicalApprovalHash(seatProfile), h);
});

// ─── narrative synthesis contract (SynthesisFile) ────────────────────────────

test('parseSynthesisFile accepts narrative-only scribe output within caps', () => {
  const r = parseSynthesisFile(
    {
      schemaVersion: 1, runId: RUN, participantId: 'scribe0',
      generatedAt: '2026-11-18T00:00:00Z',
      summary: 'three seats missed; two claims disputed',
      limitations: ['seat rev3 timed out', 'no repro run'],
    },
    { runId: RUN, participantId: 'scribe0' },
  );
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.summary, 'three seats missed; two claims disputed');
  assert.deepEqual(r.value.limitations, ['seat rev3 timed out', 'no repro run']);
});

test('parseSynthesisFile enforces identity, caps and narrative-only shape', () => {
  const good = {
    schemaVersion: 1, runId: RUN, participantId: 'scribe0',
    summary: 's', limitations: [],
  };
  assert.ok(hasCode(parseSynthesisFile({ ...good, runId: 'crun_other' }, { runId: RUN }), 'mismatch'));
  assert.ok(hasCode(parseSynthesisFile({ ...good, participantId: 'other' }, { participantId: 'scribe0' }), 'mismatch'));
  assert.ok(hasCode(
    parseSynthesisFile({ ...good, summary: 'x'.repeat(8001) }, {}),
    'too_long',
  ));
  const tooMany = Array.from({ length: 21 }, (_, i) => `lim ${i}`);
  assert.ok(hasCode(
    parseSynthesisFile({ ...good, limitations: tooMany }, {}),
    'too_many',
  ));
  // A legacy FULL report (has coverage/claims, no participantId) cannot pass
  // as narrative — callers fall back to parseReportFile for those.
  const legacyReport = {
    schemaVersion: 1, runId: RUN, generatedAt: '2026-11-18T00:00:00Z',
    summary: 'done',
    coverage: {
      requestedPerspectives: 10, proposedPerspectives: 10, selectedSeats: 1, partial: false,
      seats: [], uncoveredPerspectiveIds: [],
    },
    claims: [], limitations: ['l'],
  };
  assert.ok(!parseSynthesisFile(legacyReport, { runId: RUN }).ok, 'full report must fail the narrative parser');
  assert.ok(parseReportFile(legacyReport, { runId: RUN }).ok, '…but still parses as a legacy report');
});

test('parseChallengesFile: counterexample requires evidence; other kinds do not', () => {
  const mk = (kind: string, evidence: unknown[]) => ({
    schemaVersion: 1, runId: RUN, round: 1, participantId: 'rev1',
    challenges: [{ challengeId: 'C-1', claimId: 'c1', kind, argument: 'arg', evidence }],
  });
  // counterexample with no evidence is a rejection — the claim is unfounded.
  assert.ok(hasCode(
    parseChallengesFile(mk('counterexample', []), {}),
    'required',
  ));
  const withEv = parseChallengesFile(mk('counterexample', [ev('reasoned')]), {});
  assert.ok(withEv.ok, issues(withEv));
  // missing_evidence legitimately carries none — never force fabrication.
  assert.ok(parseChallengesFile(mk('missing_evidence', []), {}).ok);
});

test('parseChallengeEnvelope carries runner-stamped provenance and omittedCount', () => {
  const env = {
    schemaVersion: 1, runId: RUN, phase: 'author_response', round: 1, recipientId: 'rev1',
    omittedCount: 2,
    assignments: [{
      claimId: 'c1', findingId: 'f1',
      claim: { claimId: 'c1', title: 't', kind: 'defect', severity: 'high', evidence: [ev('reasoned')], counterEvidence: [] },
      challenges: [{
        challengeId: 'ch-r1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        claimId: 'c1', kind: 'other', argument: 'why', evidence: [],
        localChallengeId: 'C-1', challengerPid: 'rev2',
      }],
    }],
    outputPath: 'rounds/1/responses/rev1.json', outputContract: 'ResponsesFile',
  };
  const r = parseResponseEnvelope(env, { runId: RUN, round: 1 });
  assert.ok(r.ok, issues(r));
  assert.equal(r.value.omittedCount, 2);
  const ch = r.value.assignments[0]!.challenges[0]!;
  assert.equal(ch.localChallengeId, 'C-1');
  assert.equal(ch.challengerPid, 'rev2');
});

test('parseResponseEnvelope: malformed omittedCount is a parse issue', () => {
  const env = {
    schemaVersion: 1, runId: RUN, phase: 'author_response', round: 1, recipientId: 'rev1',
    omittedCount: -3, assignments: [],
    outputPath: 'rounds/1/responses/rev1.json', outputContract: 'ResponsesFile',
  };
  assert.ok(hasCode(parseResponseEnvelope(env, {}), 'too_small'));
});

// ─── canonical claim retention fields (via report.json parse) ────────────────

function mkReportWithClaims(claims: unknown[], extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, runId: RUN, generatedAt: '2026-11-18T00:00:00Z', summary: 'done',
    coverage: {
      requestedPerspectives: 10, proposedPerspectives: 10, selectedSeats: 1, partial: false,
      seats: [{
        participantId: 'rev0', perspectiveId: 'p0', seatId: 's0', outcome: 'completed',
        phasesCompleted: ['independent_review'],
      }],
      uncoveredPerspectiveIds: [],
    },
    claims,
    limitations: [],
    ...extra,
  };
}

test('parseReportFile retains claim remedies/openQuestions/assessments/mergedTitles', () => {
  const claim = {
    claimId: 'clm_0001', title: 't', kind: 'defect', grade: 'plausible_risk',
    status: 'revised', severity: 'high', confidence: 0.8,
    evidence: [ev('reasoned')], counterEvidence: [],
    sourceFindings: [{ participantId: 'rev0', findingId: 'f1' }],
    history: [], dissent: [],
    remedies: ['add timeout'],
    openQuestions: ['which SLO?'],
    mergedTitles: ['alt title'],
    assessments: [{ participantId: 'rev0', findingId: 'f1', severity: 'high', confidence: 0.8 }],
  };
  const r = parseReportFile(mkReportWithClaims([claim]), { runId: RUN });
  assert.ok(r.ok, issues(r));
  const c = r.value.claims[0]!;
  assert.deepEqual(c.remedies, ['add timeout']);
  assert.deepEqual(c.openQuestions, ['which SLO?']);
  assert.deepEqual(c.mergedTitles, ['alt title']);
  assert.equal(c.assessments?.length, 1);
  assert.equal(c.assessments![0]!.severity, 'high');
});

test('parseReportFile retains validated dissent evidence; legacy dissent still parses', () => {
  const claim = {
    claimId: 'clm_0001', title: 't', kind: 'defect', grade: 'plausible_risk',
    status: 'challenged', severity: 'high', confidence: 0.8,
    evidence: [ev('reasoned')], counterEvidence: [],
    sourceFindings: [{ participantId: 'rev0', findingId: 'f1' }],
    history: [],
    dissent: [
      { participantId: 'rev1', round: 1, position: 'no evidence', ts: '2026-11-18T00:00:00Z', evidence: [ev('reasoned', { note: 'counter' })] },
      { participantId: 'rev2', round: null, position: 'old-style dissent', ts: '2026-11-18T00:00:00Z' },
    ],
  };
  const r = parseReportFile(mkReportWithClaims([claim]), { runId: RUN });
  assert.ok(r.ok, issues(r));
  const c = r.value.claims[0]!;
  assert.equal(c.dissent[0]!.evidence?.length, 1, 'dissent evidence retained');
  assert.equal(c.dissent[1]!.evidence, undefined, 'legacy record without evidence parses');
});

test('parseReportFile round-trips runnerFacts and limitationSources', () => {
  const extra = {
    runnerFacts: {
      seatsCompleted: 2, seatsSelected: 3, partialCoverage: true,
      uncoveredPerspectiveIds: ['p3'], summarySource: 'runner',
      claims: {
        total: 2, byStatus: { defended: 1, challenged: 1 },
        withDissent: ['clm_0002'], withdrawn: 0, escalated: 1,
      },
    },
    limitationSources: [
      { origin: 'runner', text: 'seat rev3 timed out' },
      { origin: 'scribe', text: 'reproduction not attempted' },
    ],
  };
  const claim = {
    claimId: 'clm_0002', title: 't', kind: 'defect', grade: 'plausible_risk',
    status: 'challenged', severity: 'medium', confidence: 0.5,
    evidence: [ev('reasoned')], counterEvidence: [],
    sourceFindings: [{ participantId: 'rev0', findingId: 'f1' }],
    history: [], dissent: [],
  };
  const r = parseReportFile(mkReportWithClaims([claim], extra), { runId: RUN });
  assert.ok(r.ok, issues(r));
  const rf = r.value.runnerFacts!;
  assert.equal(rf.seatsCompleted, 2);
  assert.equal(rf.partialCoverage, true);
  assert.equal(rf.summarySource, 'runner');
  assert.equal(rf.claims.escalated, 1);
  assert.deepEqual(rf.claims.withDissent, ['clm_0002']);
  assert.deepEqual(
    r.value.limitationSources!.map((l) => l.origin),
    ['runner', 'scribe'],
  );
  // Malformed fact block fails parse, never silently accepted.
  const bad = mkReportWithClaims([claim], { runnerFacts: { seatsCompleted: 'two' } });
  assert.ok(!parseReportFile(bad, { runId: RUN }).ok);
});
