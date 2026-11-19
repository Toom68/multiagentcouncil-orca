/**
 * Unit tests for the canonical claim-ledger operations.
 * Exercises grading honesty, evidence validation against the snapshot,
 * deterministic dedup/assignment, envelope caps, and ledger mutation —
 * never by echoing the implementation back at itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  SCHEMA_VERSION,
  type Challenge,
  type Claim,
  type ClaimLedger,
  type Evidence,
  type FindingsFile,
  type Perspective,
  type SourceSnapshot,
} from '../src/contracts.js';
import {
  applyChallengesToLedger,
  applyResponsesToLedger,
  assignChallenges,
  assignResponses,
  buildClaimLedger,
  buildDiscussionAccounting,
  claimAuthors,
  claimsById,
  deriveGrade,
  fitEnvelope,
  indexAdmittedChallenges,
  makeEnvelopeBase,
  projectClaimView,
  qualifiedChallengeId,
  recordChallengeRouting,
  recordResponseRouting,
  validateEvidenceList,
  type AdmittedChallenge,
  type SourceAccess,
} from '../src/claims.js';

const RUN = 'crun_test';
const NOW = new Date('2026-01-01T00:00:00.000Z');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FILE_TEXT = ['line one', 'const x = dangerous();', 'line three', 'line four'].join('\n');

function sha(p: string): string {
  return createHash('sha256').update(p, 'utf8').digest('hex');
}

function makeSnapshot(): SourceSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    snapshotId: 'snap_1',
    targetRoot: '/target',
    gitHead: null,
    takenAt: NOW.toISOString(),
    headHash: 'a'.repeat(64),
    files: {
      'src/app.js': { sha256: sha(FILE_TEXT), size: Buffer.byteLength(FILE_TEXT, 'utf8') },
      'src/util.js': { sha256: sha('util'), size: 4 },
    },
  };
}

function src(files: Record<string, string> = { 'src/app.js': FILE_TEXT }): SourceAccess {
  return { snapshot: makeSnapshot(), readFile: (rel) => files[rel] };
}

function findingsFile(pid: string, findings: Partial<FindingsFile['findings'][number]>[]): FindingsFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: RUN,
    participantId: pid,
    perspectiveId: `persp_${pid}`,
    findings: findings.map((f, i) => ({
      findingId: f.findingId ?? `f_${pid}_${i}`,
      title: f.title ?? `finding ${i}`,
      kind: f.kind ?? 'defect',
      severity: f.severity ?? 'medium',
      confidence: f.confidence ?? 0.7,
      evidence: f.evidence ?? [],
      ...(f.assertedGrade !== undefined ? { assertedGrade: f.assertedGrade } : {}),
      ...(f.counterEvidence !== undefined ? { counterEvidence: f.counterEvidence } : {}),
      ...(f.remedies !== undefined ? { remedies: f.remedies } : {}),
      ...(f.openQuestions !== undefined ? { openQuestions: f.openQuestions } : {}),
    })),
  };
}

// ─── deriveGrade ─────────────────────────────────────────────────────────────

test('deriveGrade: reviewer evidence can never reach verified_defect', () => {
  const repro: Evidence = { kind: 'repro', note: 'crashed it', steps: 'run x', observed: 'boom' };
  assert.equal(deriveGrade([repro]), 'plausible_risk');
  assert.equal(deriveGrade([{ kind: 'code_location', note: 'see', path: 'src/app.js', startLine: 1 }]), 'plausible_risk');
  assert.equal(deriveGrade([{ kind: 'reasoned', note: 'argued' }]), 'plausible_risk');
  assert.equal(deriveGrade([{ kind: 'speculative', note: 'maybe' }]), 'speculative');
  assert.equal(deriveGrade([]), 'unsupported');
});

// ─── validateEvidenceList ────────────────────────────────────────────────────

test('validateEvidenceList: code_location checked against snapshot and file', () => {
  const s = src();
  const good: Evidence = {
    kind: 'code_location',
    note: 'the dangerous call',
    path: 'src/app.js',
    startLine: 2,
    endLine: 2,
    snippet: 'const x = dangerous();',
  };
  assert.deepEqual(validateEvidenceList([good], s).invalid, []);
  assert.equal(validateEvidenceList([good], s).valid.length, 1);

  const cases: [Evidence, RegExp][] = [
    [{ kind: 'code_location', note: 'x', path: 'src/missing.js', startLine: 1 }, /not in snapshot/],
    [{ kind: 'code_location', note: 'x', path: '../escape.js', startLine: 1 }, /unsafe path/],
    [{ kind: 'code_location', note: 'x', path: 'src/app.js', startLine: 999 }, /beyond file length/],
    [{ kind: 'code_location', note: 'x', path: 'src/app.js', startLine: 3, endLine: 2 }, /endLine/],
    [{ kind: 'code_location', note: 'x', path: 'src/app.js', startLine: 1, snippet: 'not in the file at all' }, /snippet/],
    [{ kind: 'code_location', note: 'x' }, /missing path/],
  ];
  for (const [ev, re] of cases) {
    const r = validateEvidenceList([ev], s);
    assert.equal(r.valid.length, 0, JSON.stringify(ev));
    assert.equal(r.invalid.length, 1);
    assert.match(r.invalid[0].reason, re);
  }
});

test('validateEvidenceList: repro requires steps+observed', () => {
  const r = validateEvidenceList([{ kind: 'repro', note: 'tried' }], src());
  assert.equal(r.invalid.length, 1);
  assert.match(r.invalid[0].reason, /steps\/observed/);
});

test('validateEvidenceList: cited bytes must match manifest sha256/size — drift fails closed', () => {
  // Live-tree read returns content that differs from what the snapshot hashed.
  const drifted = FILE_TEXT.replace('dangerous()', 'safeCall()');
  assert.notEqual(drifted, FILE_TEXT);
  const ev: Evidence = {
    kind: 'code_location',
    note: 'cited',
    path: 'src/app.js',
    startLine: 2,
    endLine: 2,
    snippet: 'dangerous()',
  };
  const r = validateEvidenceList([ev], src({ 'src/app.js': drifted }));
  assert.equal(r.valid.length, 0);
  assert.equal(r.invalid.length, 1);
  assert.match(r.invalid[0].reason, /drifted/);
});

test('validateEvidenceList: unreadable and absent readFile fail closed', () => {
  const ev: Evidence = {
    kind: 'code_location',
    note: 'cited',
    path: 'src/app.js',
    startLine: 1,
  };
  // readFile returns nothing for a manifest-listed path.
  const r = validateEvidenceList([ev], src({}));
  assert.equal(r.valid.length, 0);
  assert.match(r.invalid[0].reason, /unreadable|missing|could not/i);
  // No readFile callback at all — still fail closed, never pass-by-default.
  const r2 = validateEvidenceList([ev], { snapshot: makeSnapshot() });
  assert.equal(r2.valid.length, 0);
});

test('validateEvidenceList: snippet must occur inside the cited line range', () => {
  // 'line one' exists in the file but NOT on lines 3-4.
  const ev: Evidence = {
    kind: 'code_location',
    note: 'cited',
    path: 'src/app.js',
    startLine: 3,
    endLine: 4,
    snippet: 'line one',
  };
  const r = validateEvidenceList([ev], src());
  assert.equal(r.valid.length, 0);
  assert.match(r.invalid[0].reason, /snippet/);
});

test('validateEvidenceList: whitespace-only and missing snippets are invalid for code_location', () => {
  const blank: Evidence = {
    kind: 'code_location',
    note: 'cited',
    path: 'src/app.js',
    startLine: 1,
    endLine: 1,
    snippet: '   \n\t  ',
  };
  const r = validateEvidenceList([blank], src());
  assert.equal(r.valid.length, 0);
  assert.match(r.invalid[0].reason, /snippet/);
});

test('validateEvidenceList: citation-shaped fields on non-code kinds are validated too', () => {
  // A 'reasoned' evidence item carrying path/lines must pass the same check —
  // or be rejected explicitly, never silently bypass citation validation.
  const shaped: Evidence = {
    kind: 'reasoned',
    note: 'argued',
    path: 'src/nope.js',
    startLine: 5,
  };
  const r = validateEvidenceList([shaped], src());
  assert.equal(r.valid.length, 0);
  assert.equal(r.invalid.length, 1);

  // A 'reasoned' item with no citation fields stays honest text.
  const plain = validateEvidenceList([{ kind: 'reasoned', note: 'argued well' }], src());
  assert.equal(plain.valid.length, 1);
});

// ─── buildClaimLedger ────────────────────────────────────────────────────────

test('buildClaimLedger: asserted verified_defect never survives into the claim', () => {
  const admitted = [
    {
      participantId: 'rev_1',
      perspectiveId: 'p1',
      file: findingsFile('rev_1', [
        {
          findingId: 'f1',
          title: 'Auth bypass',
          kind: 'defect',
          assertedGrade: 'verified_defect',
          evidence: [{ kind: 'repro', note: 'ran it', steps: 'curl', observed: '200' }],
        },
      ]),
    },
  ];
  const { ledger } = buildClaimLedger(RUN, admitted, src(), NOW);
  assert.equal(ledger.claims.length, 1);
  assert.equal(ledger.claims[0].grade, 'plausible_risk');
});

test('buildClaimLedger: deterministic dedup retains provenance and dissent', () => {
  const mk = (pid: string, sev: 'high' | 'medium', conf: number) => ({
    participantId: pid,
    perspectiveId: `persp_${pid}`,
    file: findingsFile(pid, [
      {
        findingId: `f_${pid}`,
        title: 'SQL  Injection   Risk!!',
        kind: 'risk',
        severity: sev,
        confidence: conf,
        evidence: [{ kind: 'reasoned', note: `because ${pid}` }],
      },
    ]),
  });
  const { ledger } = buildClaimLedger(RUN, [mk('rev_b', 'medium', 0.5), mk('rev_a', 'high', 0.9)], src(), NOW);
  assert.equal(ledger.claims.length, 1);
  const c = ledger.claims[0];
  // rev_a sorts first → canonical; rev_b merged.
  assert.deepEqual(
    c.sourceFindings.map((s) => s.participantId),
    ['rev_a', 'rev_b'],
  );
  assert.deepEqual(ledger.provenance[c.claimId], ['rev_a', 'rev_b']);
  assert.equal(c.severity, 'high');
  assert.ok(c.history.some((h) => h.type === 'merged'));
  // The differing severity/confidence is preserved as dissent, not averaged away.
  assert.ok(c.dissent.some((d) => d.participantId === 'rev_b' && d.position.includes('medium')));
});

test('buildClaimLedger: invalid code_location drops to unsupported and is recorded', () => {
  const admitted = [
    {
      participantId: 'rev_1',
      perspectiveId: 'p1',
      file: findingsFile('rev_1', [
        {
          findingId: 'f1',
          title: 'phantom defect',
          kind: 'defect',
          assertedGrade: 'verified_defect',
          evidence: [
            { kind: 'code_location', note: 'cited', path: 'src/nope.js', startLine: 1 },
          ],
        },
      ]),
    },
  ];
  const { ledger, evidenceRejections } = buildClaimLedger(RUN, admitted, src(), NOW);
  assert.equal(ledger.claims[0].grade, 'unsupported');
  assert.equal(evidenceRejections.length, 1);
  assert.match(evidenceRejections[0].reason, /not in snapshot/);
});

test('buildClaimLedger: same title/kind citing different paths stays two claims', () => {
  // Conservative dedupe: 'SQL injection' in app.js and 'SQL injection' in
  // util.js are distinct defects — a false merge would destroy one.
  const mk = (pid: string, path: string) => ({
    participantId: pid,
    perspectiveId: `persp_${pid}`,
    file: findingsFile(pid, [
      {
        findingId: `f_${pid}`,
        title: 'SQL injection risk',
        kind: 'defect',
        evidence: [{ kind: 'reasoned', note: 'argued', path, startLine: 1 }],
      },
    ]),
  });
  const s: SourceAccess = {
    snapshot: {
      ...makeSnapshot(),
      files: {
        'src/app.js': { sha256: sha(FILE_TEXT), size: Buffer.byteLength(FILE_TEXT, 'utf8') },
        'src/util.js': { sha256: sha('util'), size: 4 },
      },
    },
    readFile: (rel) => (rel === 'src/app.js' ? FILE_TEXT : rel === 'src/util.js' ? 'util' : undefined),
  };
  const { ledger } = buildClaimLedger(RUN, [mk('rev_a', 'src/app.js'), mk('rev_b', 'src/util.js')], s, NOW);
  assert.equal(ledger.claims.length, 2, 'non-overlapping cited paths must not merge');
});

test('buildClaimLedger: same title/kind with overlapping paths merges', () => {
  const mk = (pid: string, extraPath?: string) => ({
    participantId: pid,
    perspectiveId: `persp_${pid}`,
    file: findingsFile(pid, [
      {
        findingId: `f_${pid}`,
        title: 'SQL injection risk',
        kind: 'defect',
        evidence: [
          { kind: 'reasoned', note: 'argued', path: 'src/app.js', startLine: 2, endLine: 2, snippet: 'dangerous()' },
          ...(extraPath !== undefined
            ? [{ kind: 'reasoned' as const, note: 'more', path: extraPath, startLine: 1 }]
            : []),
        ],
      },
    ]),
  });
  const s: SourceAccess = {
    snapshot: makeSnapshot(),
    readFile: (rel) => (rel === 'src/app.js' ? FILE_TEXT : rel === 'src/util.js' ? 'util' : undefined),
  };
  const { ledger } = buildClaimLedger(
    RUN,
    [mk('rev_a'), mk('rev_b', 'src/util.js')],
    s,
    NOW,
  );
  assert.equal(ledger.claims.length, 1, 'shared src/app.js citation merges');
  assert.deepEqual(
    ledger.claims[0].sourceFindings.map((s) => s.participantId),
    ['rev_a', 'rev_b'],
  );
});

test('buildClaimLedger: same file but disjoint cited lines stays two claims', () => {
  // The coordinator's case: same title+kind in ONE file, different lines —
  // distinct defects, a shared filename alone is not merge identity.
  const mk = (pid: string, startLine: number, endLine: number) => ({
    participantId: pid,
    perspectiveId: `persp_${pid}`,
    file: findingsFile(pid, [
      {
        findingId: `f_${pid}`,
        title: 'SQL injection risk',
        kind: 'defect',
        evidence: [
          { kind: 'code_location', note: 'cited', path: 'src/app.js', startLine, endLine },
        ],
      },
    ]),
  });
  const { ledger } = buildClaimLedger(RUN, [mk('rev_a', 1, 2), mk('rev_b', 3, 4)], src(), NOW);
  assert.equal(ledger.claims.length, 2, 'disjoint ranges in one file must not merge');
});

test('buildClaimLedger: partially overlapping cited ranges merge', () => {
  const mk = (pid: string, startLine: number, endLine: number) => ({
    participantId: pid,
    perspectiveId: `persp_${pid}`,
    file: findingsFile(pid, [
      {
        findingId: `f_${pid}`,
        title: 'SQL injection risk',
        kind: 'defect',
        evidence: [
          { kind: 'code_location', note: 'cited', path: 'src/app.js', startLine, endLine },
        ],
      },
    ]),
  });
  const { ledger } = buildClaimLedger(RUN, [mk('rev_a', 1, 3), mk('rev_b', 2, 4)], src(), NOW);
  assert.equal(ledger.claims.length, 1, 'overlapping ranges in one file merge');
});

test('buildClaimLedger: rejected citations never drive merge identity', () => {
  // Both findings cite src/nope.js — but that citation fails validation.
  // rev_b ALSO cites src/util.js (valid). Under path-set identity the shared
  // (invalid) src/nope.js would merge them; under verified-range identity
  // rev_a holds zero verified ranges and rev_b holds util.js — no merge.
  const mk = (pid: string, evidence: Evidence[]) => ({
    participantId: pid,
    perspectiveId: `persp_${pid}`,
    file: findingsFile(pid, [
      { findingId: `f_${pid}`, title: 'SQL injection risk', kind: 'defect', evidence },
    ]),
  });
  const s: SourceAccess = {
    snapshot: makeSnapshot(),
    readFile: (rel) => (rel === 'src/util.js' ? 'util' : undefined),
  };
  const { ledger, evidenceRejections } = buildClaimLedger(
    RUN,
    [
      mk('rev_a', [{ kind: 'code_location', note: 'x', path: 'src/nope.js', startLine: 1 }]),
      mk('rev_b', [
        { kind: 'code_location', note: 'x', path: 'src/nope.js', startLine: 3 },
        { kind: 'code_location', note: 'y', path: 'src/util.js', startLine: 1 },
      ]),
    ],
    s,
    NOW,
  );
  assert.equal(ledger.claims.length, 2, 'an invalid shared citation must not merge');
  assert.equal(evidenceRejections.length, 2, 'both phantom citations journaled');
});

test('buildClaimLedger: remedies, openQuestions, and per-author assessments survive the merge', () => {
  const mk = (pid: string, remedies: string[], openQuestions: string[]) => ({
    participantId: pid,
    perspectiveId: `persp_${pid}`,
    file: findingsFile(pid, [
      {
        findingId: `f_${pid}`,
        title: 'Missing timeout',
        kind: 'defect',
        severity: pid === 'rev_a' ? 'high' : 'medium',
        confidence: pid === 'rev_a' ? 0.9 : 0.6,
        evidence: [{ kind: 'reasoned', note: `argued by ${pid}` }],
        remedies,
        openQuestions,
      },
    ]),
  });
  const { ledger } = buildClaimLedger(
    RUN,
    [
      mk('rev_b', ['add deadline'], ['what is the SLO?']),
      mk('rev_a', ['add timeout', 'add deadline'], ['why no timeout?']),
    ],
    src(),
    NOW,
  );
  assert.equal(ledger.claims.length, 1);
  const c = ledger.claims[0];
  assert.deepEqual(c.remedies, ['add timeout', 'add deadline'], 'remedies unioned in author order');
  assert.deepEqual(c.openQuestions, ['why no timeout?', 'what is the SLO?']);
  // Every author's rating retained — canonical claim keeps first-sorted values.
  assert.equal(c.assessments?.length, 2);
  const aAssess = c.assessments!.find((a) => a.participantId === 'rev_a')!;
  assert.equal(aAssess.severity, 'high');
  assert.equal(aAssess.confidence, 0.9);
  const bAssess = c.assessments!.find((a) => a.participantId === 'rev_b')!;
  assert.equal(bAssess.severity, 'medium');
});

// ─── assignChallenges ────────────────────────────────────────────────────────

function mkClaim(claimId: string, authors: string[], sev: Claim['severity'] = 'medium'): Claim {
  return {
    claimId,
    title: `claim ${claimId}`,
    kind: 'defect',
    grade: 'plausible_risk',
    status: 'proposed',
    severity: sev,
    confidence: 0.7,
    evidence: [],
    counterEvidence: [],
    sourceFindings: authors.map((a, i) => ({ participantId: a, findingId: `f_${a}_${i}` })),
    history: [],
    dissent: [],
  };
}

function mkPerspective(pid: string): Perspective {
  return {
    perspectiveId: `persp_${pid}`,
    name: `perspective ${pid}`,
    charter: {
      incentives: 'i',
      expertise: 'e',
      method: 'm',
      blindSpots: 'b',
      reviewQuestions: [`q1-${pid}`, `q2-${pid}`],
    },
    tags: [],
  };
}

test('assignChallenges: deterministic, never self-assigned, respects cap', () => {
  const claims = [
    mkClaim('clm_1', ['rev_a'], 'critical'),
    mkClaim('clm_2', ['rev_a'], 'high'),
    mkClaim('clm_3', ['rev_b'], 'medium'),
    mkClaim('clm_4', ['rev_c'], 'low'),
  ];
  const input = {
    claims,
    challengerIds: ['rev_a', 'rev_b', 'rev_c'],
    claimAuthors: (cid: string) => claims.find((c) => c.claimId === cid)!.sourceFindings.map((s) => s.participantId),
    perspectiveOf: (pid: string) => mkPerspective(pid),
    maxPerSeat: 2,
  };
  const a = assignChallenges(input);
  const b = assignChallenges(input);
  assert.deepEqual(
    [...a.assignments.entries()].map(([k, v]) => [k, v.map((x) => x.claimId)]),
    [...b.assignments.entries()].map(([k, v]) => [k, v.map((x) => x.claimId)]),
  );
  const seen = new Set<string>();
  for (const [pid, list] of a.assignments) {
    assert.ok(list.length <= 2, `${pid} over cap`);
    for (const asg of list) {
      const authors = input.claimAuthors(asg.claimId);
      assert.ok(!authors.includes(pid), `${pid} self-challenged ${asg.claimId}`);
      assert.ok(!seen.has(asg.claimId), `claim ${asg.claimId} assigned twice`);
      seen.add(asg.claimId);
      assert.equal(asg.claim.claimId, asg.claimId, 'ClaimView mismatched');
      assert.ok(!('history' in asg.claim) && !('dissent' in asg.claim), 'ClaimView leaks ledger internals');
    }
  }
  // Strongest claims assigned first; every claim got a challenger here.
  assert.equal(seen.size, 4);
});

test('assignChallenges: all-self-authored claims reported unassigned', () => {
  const claims = [mkClaim('clm_1', ['rev_a', 'rev_b'])];
  const plan = assignChallenges({
    claims,
    challengerIds: ['rev_a', 'rev_b'],
    claimAuthors: () => ['rev_a', 'rev_b'],
    perspectiveOf: (pid) => mkPerspective(pid),
    maxPerSeat: 3,
  });
  assert.equal(plan.unassigned.length, 1);
  assert.match(plan.unassigned[0].reason, /no eligible challenger/);
});

// ─── assignResponses ─────────────────────────────────────────────────────────

function mkAdmitted(ch: Challenge, challengerPid: string, round = 1): AdmittedChallenge {
  return {
    challenge: ch,
    challengerPid,
    round,
    qualifiedId: qualifiedChallengeId(round, challengerPid, ch.challengeId),
  };
}

test('assignResponses: routes to author, caps per seat, withdrawn unroutable', () => {
  const claim = mkClaim('clm_1', ['rev_a']);
  const withdrawn = { ...mkClaim('clm_2', ['rev_a']), status: 'withdrawn' as const };
  const challenges = new Map<string, AdmittedChallenge>();
  for (let i = 0; i < 5; i++) {
    const ac = mkAdmitted(
      { challengeId: `ch_${i}`, claimId: 'clm_1', kind: 'missing_evidence', argument: `why ${i}`, evidence: [] },
      'rev_b',
    );
    challenges.set(ac.qualifiedId, ac);
  }
  const acW = mkAdmitted(
    { challengeId: 'ch_w', claimId: 'clm_2', kind: 'other', argument: 'moot', evidence: [] },
    'rev_b',
  );
  challenges.set(acW.qualifiedId, acW);
  const claimsByIdMap = new Map<string, Claim>([
    ['clm_1', claim],
    ['clm_2', withdrawn],
  ]);
  const plan = assignResponses({ challenges, claimsById: claimsByIdMap, maxPerSeat: 3 });
  const list = plan.assignments.get('rev_a')!;
  const routed = list.flatMap((a) => a.challenges.map((c) => c.challengeId));
  assert.equal(routed.length, 3, 'cap applied');
  assert.ok(list.every((a) => a.claimId === 'clm_1'));
  // Routed copies carry the qualified id plus local/provenance fields.
  assert.ok(routed.every((id) => id.startsWith('ch-r1-')));
  const routedCh = list[0].challenges[0];
  assert.equal(routedCh.challengerPid, 'rev_b');
  assert.ok(routedCh.localChallengeId !== undefined);
  assert.ok(plan.omitted.length === 2, 'two challenges over cap omitted');
  assert.ok(
    plan.unroutable.some((u) => u.challengeId === acW.qualifiedId),
    'withdrawn claim unroutable (qualified id)',
  );
  // The challenger is never asked to respond to its own challenge.
  assert.ok(!plan.assignments.has('rev_b'));
});

test('assignResponses: one challenge routes to EVERY merged co-author', () => {
  // clm_1 merged findings from rev_a and rev_c; rev_b challenges it once.
  const claim = mkClaim('clm_1', ['rev_a', 'rev_c']);
  const ac = mkAdmitted(
    { challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence', argument: 'prove it', evidence: [] },
    'rev_b',
  );
  const plan = assignResponses({
    challenges: new Map([[ac.qualifiedId, ac]]),
    claimsById: new Map([['clm_1', claim]]),
    maxPerSeat: 10,
  });
  const toA = plan.assignments.get('rev_a');
  const toC = plan.assignments.get('rev_c');
  assert.ok(toA !== undefined && toC !== undefined, 'both co-authors must receive the challenge');
  assert.equal(toA[0].challenges[0].challengeId, ac.qualifiedId);
  assert.equal(toC[0].challenges[0].challengeId, ac.qualifiedId);
  // Each author assignment points at that author's own finding.
  assert.equal(toA[0].findingId, 'f_rev_a_0');
  assert.equal(toC[0].findingId, 'f_rev_c_1');
});

test('assignResponses: challenger who co-authored is excluded from routing', () => {
  const claim = mkClaim('clm_1', ['rev_a', 'rev_b']);
  const ac = mkAdmitted(
    { challengeId: 'C-1', claimId: 'clm_1', kind: 'other', argument: 'x', evidence: [] },
    'rev_b',
  );
  const plan = assignResponses({
    challenges: new Map([[ac.qualifiedId, ac]]),
    claimsById: new Map([['clm_1', claim]]),
    maxPerSeat: 10,
  });
  assert.ok(plan.assignments.has('rev_a'));
  assert.ok(!plan.assignments.has('rev_b'), 'challenger never responds to itself');
});

// ─── fitEnvelope ─────────────────────────────────────────────────────────────

test('fitEnvelope: caps by whole entries, output stays valid JSON', () => {
  const base = makeEnvelopeBase<{ claimId: string; pad: string }>({
    runId: RUN,
    phase: 'challenge',
    round: 1,
    recipientId: 'rev_b',
    outputPath: 'rounds/1/challenges/rev_b.json',
    outputContract: 'ChallengesFile',
  });
  const items = Array.from({ length: 10 }, (_, i) => ({ claimId: `clm_${i}`, pad: 'x'.repeat(1000) }));
  const fit = fitEnvelope(base, items, 8192);
  assert.ok(fit.bytes <= 8192);
  assert.ok(fit.envelope.assignments.length < 10);
  assert.equal(fit.envelope.assignments.length + fit.omitted.length, 10);
  const reparsed = JSON.parse(JSON.stringify(fit.envelope));
  assert.equal(reparsed.recipientId, 'rev_b');
  // Omissions are declared inside the artifact — never silently dropped.
  assert.equal(reparsed.omittedCount, fit.omitted.length);
  assert.ok(reparsed.omittedCount > 0);
  // Omissions are whole trailing entries, never partial JSON.
  assert.deepEqual(
    fit.omitted.map((o) => o.claimId),
    items.slice(fit.envelope.assignments.length).map((i) => i.claimId),
  );
});

test('fitEnvelope: nothing kept still declares omittedCount; no omissions omits the field', () => {
  const base = makeEnvelopeBase<{ claimId: string; pad: string }>({
    runId: RUN,
    phase: 'challenge',
    round: 1,
    recipientId: 'rev_b',
    outputPath: 'rounds/1/challenges/rev_b.json',
    outputContract: 'ChallengesFile',
  });
  // A single entry bigger than the cap: kept empties but the declaration survives.
  const big = [{ claimId: 'clm_huge', pad: 'x'.repeat(20000) }];
  const fit = fitEnvelope(base, big, 8192);
  assert.equal(fit.envelope.assignments.length, 0);
  assert.equal(fit.envelope.omittedCount, 1);
  assert.equal(fit.omitted.length, 1);
  assert.ok(fit.bytes <= 8192, 'empty envelope with declaration fits');
  // Nothing omitted → field absent, old readers unaffected.
  const small = fitEnvelope(base, [{ claimId: 'c', pad: 'x' }], 8192);
  assert.equal(small.envelope.omittedCount, undefined);
});

// ─── applyChallenges / applyResponses ────────────────────────────────────────

function mkLedger(claims: Claim[]): ClaimLedger {
  const provenance: ClaimLedger['provenance'] = {};
  for (const c of claims) provenance[c.claimId] = c.sourceFindings.map((s) => s.participantId);
  return { schemaVersion: SCHEMA_VERSION, runId: RUN, claims, provenance };
}

test('applyChallengesToLedger: marks status, history and dissent; rejects strangers', () => {
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  const res = applyChallengesToLedger(
    ledger,
    [
      {
        participantId: 'rev_b',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_b',
          challenges: [
            { challengeId: 'ch_1', claimId: 'clm_1', kind: 'missing_evidence', argument: 'prove it', evidence: [] },
            { challengeId: 'ch_2', claimId: 'clm_ghost', kind: 'other', argument: 'who?', evidence: [] },
          ],
        },
      },
    ],
    src(),
    NOW,
  );
  const c = ledger.claims[0];
  const qid = qualifiedChallengeId(1, 'rev_b', 'ch_1');
  assert.equal(c.status, 'challenged');
  assert.ok(c.history.some((h) => h.type === 'challenged' && h.refId === qid));
  assert.ok(c.dissent.some((d) => d.participantId === 'rev_b' && d.position.includes('prove it')));
  assert.equal(res.applied, 1);
  assert.equal(res.skipped.length, 1);
});

test('applyChallengesToLedger: two challengers minting local C-1 never collide', () => {
  // The exact live-run failure: ten seats all minted "C-1" and nine vanished.
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  const mk = (pid: string, argument: string) => ({
    participantId: pid,
    file: {
      schemaVersion: SCHEMA_VERSION,
      runId: RUN,
      round: 1,
      participantId: pid,
      challenges: [
        { challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence' as const, argument, evidence: [] },
      ],
    },
  });
  const res = applyChallengesToLedger(ledger, [mk('rev_b', 'b says why'), mk('rev_c', 'c says why'), mk('rev_d', 'd says why')], src(), NOW);
  const c = ledger.claims[0];
  assert.equal(res.applied, 3, 'all three local C-1s applied');
  const challengedEvents = c.history.filter((h) => h.type === 'challenged');
  assert.equal(challengedEvents.length, 3);
  const refIds = new Set(challengedEvents.map((h) => h.refId));
  assert.equal(refIds.size, 3, 'qualified ids are distinct');
  assert.equal(c.dissent.length, 3);
  assert.ok(c.dissent.some((d) => d.participantId === 'rev_d'));
});

test('applyChallengesToLedger: same challenger in different rounds never collides', () => {
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  const mk = (round: number) => ({
    participantId: 'rev_b',
    file: {
      schemaVersion: SCHEMA_VERSION,
      runId: RUN,
      round,
      participantId: 'rev_b',
      challenges: [
        { challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence' as const, argument: `round ${round}`, evidence: [] },
      ],
    },
  });
  applyChallengesToLedger(ledger, [mk(1)], src(), NOW);
  applyChallengesToLedger(ledger, [mk(2)], src(), NOW);
  const challenged = ledger.claims[0].history.filter((h) => h.type === 'challenged');
  assert.equal(challenged.length, 2);
  assert.notEqual(challenged[0].refId, challenged[1].refId, 'round qualifies identity');
});

test('applyChallengesToLedger: challenger evidence validated, retained on dissent and counterEvidence', () => {
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  const good: Evidence = {
    kind: 'code_location',
    note: 'the cited line exists',
    path: 'src/app.js',
    startLine: 2,
    endLine: 2,
    snippet: 'dangerous()',
  };
  const bad: Evidence = {
    kind: 'code_location',
    note: 'phantom',
    path: 'src/nope.js',
    startLine: 1,
  };
  const res = applyChallengesToLedger(
    ledger,
    [
      {
        participantId: 'rev_b',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_b',
          challenges: [
            { challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence', argument: 'see code', evidence: [good, bad] },
          ],
        },
      },
    ],
    src(),
    NOW,
  );
  const c = ledger.claims[0];
  const qid = qualifiedChallengeId(1, 'rev_b', 'C-1');
  // Valid challenger evidence lands in counterEvidence AND on the dissent record.
  assert.equal(c.counterEvidence.length, 1);
  assert.equal(c.counterEvidence[0].path, 'src/app.js');
  assert.ok(c.dissent.some((d) => d.participantId === 'rev_b' && d.evidence?.length === 1));
  // The invalid item is surfaced for journaling, with the qualified ref.
  assert.equal(res.evidenceRejections.length, 1);
  assert.equal(res.evidenceRejections[0].refId, qid);
  assert.equal(res.evidenceRejections[0].participantId, 'rev_b');
  assert.match(res.evidenceRejections[0].reason, /not in snapshot/);
});

test('applyResponsesToLedger: all dispositions applied; revise re-validates and re-grades', () => {
  const claims = [
    mkClaim('clm_1', ['rev_a']),
    mkClaim('clm_2', ['rev_a']),
    mkClaim('clm_3', ['rev_a']),
    mkClaim('clm_4', ['rev_a']),
  ];
  const ledger = mkLedger(claims);
  const idx = new Map<string, AdmittedChallenge>();
  for (const cid of ['clm_1', 'clm_2', 'clm_3', 'clm_4']) {
    const ac = mkAdmitted(
      { challengeId: `ch_${cid}`, claimId: cid, kind: 'missing_evidence', argument: 'why', evidence: [] },
      'rev_b',
    );
    idx.set(ac.qualifiedId, ac);
    // Bare local id also resolves here — it is unique within this index.
    idx.set(ac.challenge.challengeId, ac);
  }
  const res = applyResponsesToLedger(
    ledger,
    [
      {
        participantId: 'rev_a',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_a',
          responses: [
            { claimId: 'clm_1', challengeId: 'ch_clm_1', disposition: 'defend', argument: 'still right', evidence: [{ kind: 'reasoned', note: 'more' }] },
            {
              claimId: 'clm_2',
              challengeId: 'ch_clm_2',
              disposition: 'revise',
              argument: 'toned down',
              evidence: [],
              revisedFinding: {
                findingId: 'f_rev',
                title: 'revised claim two',
                kind: 'risk',
                severity: 'low',
                confidence: 0.4,
                evidence: [{ kind: 'speculative', note: 'weaker' }],
              },
            },
            { claimId: 'clm_3', challengeId: 'ch_clm_3', disposition: 'withdraw', argument: 'I was wrong', evidence: [] },
            { claimId: 'clm_4', challengeId: 'ch_clm_4', disposition: 'escalate', argument: 'needs orchestrator', evidence: [] },
          ],
        },
      },
    ],
    idx,
    src(),
    NOW,
  );
  assert.equal(res.applied, 4);
  const byId = claimsById(ledger);
  assert.equal(byId.get('clm_1')!.status, 'defended');
  assert.equal(byId.get('clm_2')!.status, 'revised');
  assert.equal(byId.get('clm_2')!.title, 'revised claim two');
  // Revision unions new evidence over existing; grade re-derived from the union.
  assert.equal(byId.get('clm_2')!.grade, 'speculative', 'revised evidence unions + re-grades');
  assert.equal(byId.get('clm_3')!.status, 'withdrawn');
  assert.equal(byId.get('clm_4')!.status, 'escalated');
  // Responses echoed bare local ids; the ledger records canonical qualified refs.
  const defendedRef = byId.get('clm_1')!.history.find((h) => h.type === 'defended')?.refId;
  assert.equal(defendedRef, qualifiedChallengeId(1, 'rev_b', 'ch_clm_1'));
});

test('applyResponsesToLedger: response from non-author or to unadmitted challenge is skipped', () => {
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  const res = applyResponsesToLedger(
    ledger,
    [
      {
        participantId: 'rev_z', // not an author of clm_1
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_z',
          responses: [
            { claimId: 'clm_1', challengeId: 'ch_ghost', disposition: 'defend', argument: 'mine now', evidence: [] },
          ],
        },
      },
    ],
    new Map(),
    src(),
    NOW,
  );
  assert.equal(res.applied, 0);
  assert.equal(res.skipped.length, 1);
  assert.equal(ledger.claims[0].status, 'proposed');
});

test('applyResponsesToLedger: a valid challenge id on the wrong claim or round fails closed', () => {
  // rev_a co-authored both claims and holds a real challenge id for each.
  // Echoing clm_1's challenge id against clm_2 must not apply — the pair
  // (claimId, round) is the admitted identity, not the id string alone.
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a']), mkClaim('clm_2', ['rev_a'])]);
  const chFor1 = mkAdmitted(
    { challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence', argument: 'why', evidence: [] },
    'rev_b',
    1,
  );
  const chFor2 = mkAdmitted(
    { challengeId: 'C-1', claimId: 'clm_2', kind: 'missing_evidence', argument: 'why', evidence: [] },
    'rev_c',
    1,
  );
  const idx = new Map<string, AdmittedChallenge>([
    [chFor1.qualifiedId, chFor1],
    [chFor2.qualifiedId, chFor2],
  ]);
  const file = (round: number, claimId: string, challengeId: string) => ({
    participantId: 'rev_a',
    file: {
      schemaVersion: SCHEMA_VERSION,
      runId: RUN,
      round,
      participantId: 'rev_a',
      responses: [{ claimId, challengeId, disposition: 'defend' as const, argument: 'slid over', evidence: [] }],
    },
  });
  const wrongClaim = applyResponsesToLedger(ledger, [file(1, 'clm_2', chFor1.qualifiedId)], idx, src(), NOW);
  assert.equal(wrongClaim.applied, 0);
  assert.match(wrongClaim.skipped[0].reason, /targets clm_1@round 1/);
  const wrongRound = applyResponsesToLedger(ledger, [file(2, 'clm_1', chFor1.qualifiedId)], idx, src(), NOW);
  assert.equal(wrongRound.applied, 0);
  assert.match(wrongRound.skipped[0].reason, /targets clm_1@round 1/);
  assert.equal(ledger.claims[0].status, 'proposed');
  assert.equal(ledger.claims[1].status, 'proposed');
});

test('applyResponsesToLedger: defend re-derives grade and records a regraded event', () => {
  // clm_0004-style: defence evidence arrives after the initial grade.
  const claim = mkClaim('clm_1', ['rev_a']);
  claim.grade = 'unsupported';
  const ledger = mkLedger([claim]);
  const ac = mkAdmitted(
    { challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence', argument: 'no evidence', evidence: [] },
    'rev_b',
  );
  const idx = new Map([[ac.qualifiedId, ac]]);
  const res = applyResponsesToLedger(
    ledger,
    [
      {
        participantId: 'rev_a',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_a',
          responses: [
            {
              claimId: 'clm_1',
              challengeId: ac.qualifiedId,
              disposition: 'defend',
              argument: 'here is the code',
              evidence: [{ kind: 'reasoned', note: 'walkthrough' }],
            },
          ],
        },
      },
    ],
    idx,
    src(),
    NOW,
  );
  assert.equal(res.applied, 1);
  const c = ledger.claims[0];
  assert.equal(c.grade, 'plausible_risk', 'defend must re-derive grade from updated evidence');
  assert.ok(c.history.some((h) => h.type === 'regraded' && h.actor === 'runner'), 'regraded event recorded');
});

test('applyResponsesToLedger: revise does not erase co-author evidence', () => {
  // Merged claim: rev_a + rev_c each contributed evidence. rev_a revises with
  // only its own evidence — rev_c's must survive the union.
  const coauthorEv: Evidence = { kind: 'repro', note: 'rev_c ran it', steps: 's', observed: 'o' };
  const authorEv: Evidence = { kind: 'reasoned', note: 'rev_a argued' };
  const claim = mkClaim('clm_1', ['rev_a', 'rev_c']);
  claim.evidence = [authorEv, coauthorEv];
  const ledger = mkLedger([claim]);
  const ac = mkAdmitted(
    { challengeId: 'C-1', claimId: 'clm_1', kind: 'other', argument: 'needs work', evidence: [] },
    'rev_b',
  );
  applyResponsesToLedger(
    ledger,
    [
      {
        participantId: 'rev_a',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_a',
          responses: [
            {
              claimId: 'clm_1',
              challengeId: ac.qualifiedId,
              disposition: 'revise',
              argument: 'narrowing it',
              evidence: [],
              revisedFinding: {
                findingId: 'f_rev',
                title: 'narrowed claim',
                kind: 'defect',
                severity: 'low',
                confidence: 0.4,
                evidence: [authorEv],
              },
            },
          ],
        },
      },
    ],
    new Map([[ac.qualifiedId, ac]]),
    src(),
    NOW,
  );
  const c = ledger.claims[0];
  assert.equal(c.evidence.length, 2, 'co-author evidence survives revision');
  assert.ok(c.evidence.some((e) => e.note === 'rev_c ran it'));
});

test('applyResponsesToLedger: ambiguous bare local id cannot route a response', () => {
  // Two challengers both minted "C-1" — a response echoing bare "C-1" must
  // not silently bind to either; it is skipped as unadmitted.
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  const idx = indexAdmittedChallenges([
    {
      participantId: 'rev_b',
      file: {
        schemaVersion: SCHEMA_VERSION,
        runId: RUN,
        round: 1,
        participantId: 'rev_b',
        challenges: [{ challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence', argument: 'b', evidence: [] }],
      },
    },
    {
      participantId: 'rev_c',
      file: {
        schemaVersion: SCHEMA_VERSION,
        runId: RUN,
        round: 1,
        participantId: 'rev_c',
        challenges: [{ challengeId: 'C-1', claimId: 'clm_1', kind: 'other', argument: 'c', evidence: [] }],
      },
    },
  ]);
  const res = applyResponsesToLedger(
    ledger,
    [
      {
        participantId: 'rev_a',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_a',
          responses: [
            { claimId: 'clm_1', challengeId: 'C-1', disposition: 'defend', argument: 'ambiguous!', evidence: [] },
          ],
        },
      },
    ],
    idx,
    src(),
    NOW,
  );
  assert.equal(res.applied, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /unadmitted/);
});

test('folds are idempotent under crash-replay: re-applying the same files duplicates nothing', () => {
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  const challengeFile = {
    participantId: 'rev_b',
    file: {
      schemaVersion: SCHEMA_VERSION,
      runId: RUN,
      round: 1,
      participantId: 'rev_b',
      challenges: [
        { challengeId: 'ch_1', claimId: 'clm_1', kind: 'missing_evidence' as const, argument: 'prove it', evidence: [] },
      ],
    },
  };
  const first = applyChallengesToLedger(ledger, [challengeFile], src(), NOW);
  const histLen = ledger.claims[0].history.length;
  const dissentLen = ledger.claims[0].dissent.length;
  const replay = applyChallengesToLedger(ledger, [challengeFile], src(), new Date(NOW.getTime() + 5000));
  assert.equal(first.applied, 1);
  assert.equal(replay.applied, 0, 'replayed challenge must not re-apply');
  assert.equal(replay.skipped.length, 1);
  assert.equal(ledger.claims[0].history.length, histLen, 'no duplicated history');
  assert.equal(ledger.claims[0].dissent.length, dissentLen, 'no duplicated dissent');

  const idx = indexAdmittedChallenges([challengeFile]);
  const responseFile = {
    participantId: 'rev_a',
    file: {
      schemaVersion: SCHEMA_VERSION,
      runId: RUN,
      round: 1,
      participantId: 'rev_a',
      responses: [
        { claimId: 'clm_1', challengeId: 'ch_1', disposition: 'withdraw' as const, argument: 'fine, wrong', evidence: [] },
      ],
    },
  };
  const rFirst = applyResponsesToLedger(ledger, [responseFile], idx, src(), NOW);
  const rReplay = applyResponsesToLedger(ledger, [responseFile], idx, src(), new Date(NOW.getTime() + 9000));
  assert.equal(rFirst.applied, 1);
  assert.equal(rReplay.applied, 0, 'replayed response must not re-apply');
  assert.equal(rReplay.skipped.length, 1);
  assert.equal(ledger.claims[0].status, 'withdrawn');
  assert.equal(
    ledger.claims[0].history.filter((h) => h.type === 'withdrawn').length,
    1,
    'exactly one withdrawal recorded',
  );
});

// ─── projectClaimView / indexAdmittedChallenges ─────────────────────────────

test('projectClaimView exposes no history, dissent, or provenance', () => {
  const c = mkClaim('clm_1', ['rev_a']);
  c.history.push({ ts: NOW.toISOString(), round: null, actor: 'rev_b', type: 'challenged' });
  c.dissent.push({ participantId: 'rev_b', round: 1, position: 'no', ts: NOW.toISOString() });
  const v = projectClaimView(c);
  assert.deepEqual(Object.keys(v).sort(), ['claimId', 'counterEvidence', 'evidence', 'kind', 'severity', 'title']);
});

test('indexAdmittedChallenges: qualified ids primary; unique local ids alias; collisions do not', () => {
  const idx = indexAdmittedChallenges([
    {
      participantId: 'rev_b',
      file: {
        schemaVersion: SCHEMA_VERSION,
        runId: RUN,
        round: 1,
        participantId: 'rev_b',
        challenges: [
          { challengeId: 'C-1', claimId: 'clm_1', kind: 'other', argument: 'from b', evidence: [] } as Challenge,
        ],
      },
    },
    {
      participantId: 'rev_c',
      file: {
        schemaVersion: SCHEMA_VERSION,
        runId: RUN,
        round: 1,
        participantId: 'rev_c',
        challenges: [
          { challengeId: 'C-1', claimId: 'clm_1', kind: 'other', argument: 'from c', evidence: [] } as Challenge,
          { challengeId: 'C-2', claimId: 'clm_2', kind: 'other', argument: 'c only', evidence: [] } as Challenge,
        ],
      },
    },
  ]);
  // Both colliding C-1s survive under their qualified ids.
  const qb = qualifiedChallengeId(1, 'rev_b', 'C-1');
  const qc = qualifiedChallengeId(1, 'rev_c', 'C-1');
  assert.equal(idx.get(qb)?.challengerPid, 'rev_b');
  assert.equal(idx.get(qc)?.challengerPid, 'rev_c');
  // Bare 'C-1' is ambiguous → no alias installed.
  assert.equal(idx.get('C-1'), undefined);
  // Unique local id still resolves for backward compatibility.
  assert.equal(idx.get('C-2')?.challengerPid, 'rev_c');
});

// ─── canonical strengths ─────────────────────────────────────────────────────

function findingsWithStrengths(pid: string, strengths: FindingsFile['strengths']): FindingsFile {
  return { ...findingsFile(pid, []), strengths };
}

test('buildClaimLedger: strengths canonicalize with runner-stamped provenance — worker cannot self-attribute', () => {
  const file = findingsWithStrengths('rev_b', [
    {
      strengthId: 'S-2',
      feature: 'hash-bound approval',
      benefit: 'a security seat can diff the approved roster exactly',
      preserve: 'never weaken the binding',
      evidence: [{ kind: 'reasoned', note: 'by design' }],
      // A worker minting participantId/perspectiveId fields has them
      // overwritten by the runner — never trusted.
      ...({ participantId: 'rev_a', perspectiveId: 'persp_rev_a' } as object),
    },
    {
      strengthId: 'S-1',
      feature: 'dissent retention',
      benefit: 'a skeptic seat keeps its objection on record',
      preserve: 'answers must not erase dissent',
      evidence: [{ kind: 'reasoned', note: 'protocol' }],
    },
  ]);
  const { ledger, strengthRejections } = buildClaimLedger(
    RUN,
    [{ participantId: 'rev_b', perspectiveId: 'persp_rev_b', file }],
    src(),
    NOW,
  );
  assert.equal(strengthRejections.length, 0);
  assert.equal(ledger.strengths?.length, 2);
  // Deterministic order: strengthId sort within the seat.
  assert.equal(ledger.strengths![0].strengthId, 'S-1');
  assert.equal(ledger.strengths![1].strengthId, 'S-2');
  for (const s of ledger.strengths!) {
    assert.equal(s.participantId, 'rev_b', 'runner stamps the admitting seat');
    assert.equal(s.perspectiveId, 'persp_rev_b');
  }
});

test('buildClaimLedger: strength with all-invalid evidence is dropped and journaled, never bare praise', () => {
  const file = findingsWithStrengths('rev_a', [
    {
      strengthId: 'S-1',
      feature: 'nice colors',
      benefit: 'feels good',
      preserve: 'keep it',
      evidence: [{ kind: 'code_location', note: 'cited', path: 'src/nope.js', startLine: 1 }],
    },
    {
      strengthId: 'S-2',
      feature: 'real feature',
      benefit: 'real benefit',
      preserve: 'keep it too',
      evidence: [
        { kind: 'code_location', note: 'cited', path: 'src/app.js', startLine: 2, endLine: 2, snippet: 'dangerous()' },
        { kind: 'code_location', note: 'phantom', path: 'src/nope.js', startLine: 1 },
      ],
    },
  ]);
  const { ledger, strengthRejections, evidenceRejections } = buildClaimLedger(
    RUN,
    [{ participantId: 'rev_a', perspectiveId: 'persp_rev_a', file }],
    src(),
    NOW,
  );
  assert.equal(strengthRejections.length, 1);
  assert.equal(strengthRejections[0].strengthId, 'S-1');
  assert.match(strengthRejections[0].reason, /bare praise/);
  // S-2 survives with only its valid evidence; the rejected item is journaled.
  assert.equal(ledger.strengths?.length, 1);
  assert.equal(ledger.strengths![0].evidence.length, 1);
  assert.equal(evidenceRejections.length, 2, 'both rejected strength-evidence items surface');
});

test('buildClaimLedger: absent and empty strengths are both valid — no quota', () => {
  const { ledger } = buildClaimLedger(RUN, [{ participantId: 'rev_a', perspectiveId: 'p', file: findingsFile('rev_a', []) }], src(), NOW);
  assert.equal(ledger.strengths, undefined);
  const { ledger: empty } = buildClaimLedger(
    RUN,
    [{ participantId: 'rev_a', perspectiveId: 'p', file: findingsWithStrengths('rev_a', []) }],
    src(),
    NOW,
  );
  assert.equal(empty.strengths, undefined, 'empty stays absent');
});

// ─── challenge linkage + answered accounting ────────────────────────────────

test('applyChallengesToLedger: stamps ClaimChallenge + qualified dissent linkage', () => {
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  const res = applyChallengesToLedger(
    ledger,
    [
      {
        participantId: 'rev_b',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_b',
          challenges: [
            { challengeId: 'C-1', claimId: 'clm_1', kind: 'overstated', argument: 'too strong', evidence: [] },
          ],
        },
      },
    ],
    src(),
    NOW,
  );
  assert.equal(res.applied, 1);
  const c = ledger.claims[0];
  const qid = qualifiedChallengeId(1, 'rev_b', 'C-1');
  assert.equal(c.challenges?.length, 1);
  assert.equal(c.challenges![0].challengeId, qid);
  assert.equal(c.challenges![0].challengerPid, 'rev_b');
  assert.equal(c.challenges![0].answered, false, 'filed ≠ answered');
  assert.equal(c.dissent[0].challengeId, qid, 'dissent joins to its challenge lifecycle');
});

test('applyResponsesToLedger: marks the challenge answered — never resolved', () => {
  const ledger = mkLedger([mkClaim('clm_1', ['rev_a'])]);
  applyChallengesToLedger(
    ledger,
    [
      {
        participantId: 'rev_b',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_b',
          challenges: [
            { challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence', argument: 'no proof', evidence: [] },
          ],
        },
      },
    ],
    src(),
    NOW,
  );
  const ac = mkAdmitted(
    { challengeId: 'C-1', claimId: 'clm_1', kind: 'missing_evidence', argument: 'no proof', evidence: [] },
    'rev_b',
  );
  const res = applyResponsesToLedger(
    ledger,
    [
      {
        participantId: 'rev_a',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_a',
          responses: [
            { claimId: 'clm_1', challengeId: 'C-1', disposition: 'defend', argument: 'still right', evidence: [] },
          ],
        },
      },
    ],
    new Map([[ac.qualifiedId, ac], ['C-1', ac]]),
    src(),
    NOW,
  );
  assert.equal(res.applied, 1);
  const crec = ledger.claims[0].challenges![0];
  assert.equal(crec.answered, true);
  assert.deepEqual(crec.response, { participantId: 'rev_a', disposition: 'defend' });
  // The dissent record survives the answer — retained, not resolved.
  assert.equal(ledger.claims[0].dissent.length, 1);
});

// ─── routing records + discussion accounting ────────────────────────────────

test('recordChallengeRouting/recordResponseRouting + buildDiscussionAccounting: disjoint omission categories', () => {
  const claims = [
    mkClaim('clm_1', ['rev_a']),
    mkClaim('clm_2', ['rev_a']),
    mkClaim('clm_3', ['rev_b']),
    mkClaim('clm_4', ['rev_c']),
  ];
  const ledger = mkLedger(claims);
  // Round 1: clm_1 + clm_2 routed; clm_1 challenged (answered), clm_2 routed but
  // the challenger filed nothing; clm_3 byte-dropped; clm_4 never assigned.
  applyChallengesToLedger(
    ledger,
    [
      {
        participantId: 'rev_b',
        file: {
          schemaVersion: SCHEMA_VERSION,
          runId: RUN,
          round: 1,
          participantId: 'rev_b',
          challenges: [
            { challengeId: 'C-1', claimId: 'clm_1', kind: 'other', argument: 'q', evidence: [] },
          ],
        },
      },
    ],
    src(),
    NOW,
  );
  recordChallengeRouting(ledger, 1, {
    routedClaimIds: ['clm_1', 'clm_2'],
    byteDroppedClaimIds: ['clm_3'],
    unassigned: [{ claimId: 'clm_4', reason: 'all eligible challengers at cap' }],
  });
  recordResponseRouting(ledger, 1, {
    routedChallengeIds: [qualifiedChallengeId(1, 'rev_b', 'C-1')],
    byteDropped: [{ claimId: 'clm_9', authorPid: 'rev_a' }],
    capOmitted: [],
    unroutable: [],
  });
  const facts = buildDiscussionAccounting(ledger)!;
  assert.equal(facts.length, 1);
  const d = facts[0];
  assert.equal(d.challengesFiled, 1);
  assert.equal(d.challengesAnswered, 0);
  assert.equal(d.challengesUnanswered, 1);
  assert.equal(d.claimsRouted, 2);
  assert.equal(d.claimsRoutedNoChallenge, 1, 'clm_2 routed but unchallenged');
  assert.equal(d.claimsNeverRouted, 2, 'unassigned ∪ byte-dropped');
  assert.equal(d.claimsUnassigned, 1);
  assert.equal(d.claimsByteDropped, 1);
  assert.equal(d.responsesRouted, 1);
  assert.equal(d.responsesByteDropped, 1);
  // Re-recording the same round overwrites (crash-replay idempotent).
  recordChallengeRouting(ledger, 1, {
    routedClaimIds: ['clm_1'],
    byteDroppedClaimIds: [],
    unassigned: [],
  });
  assert.equal(buildDiscussionAccounting(ledger)![0].claimsRouted, 1);
  // No records → absent, never a zero-filled fiction.
  assert.equal(buildDiscussionAccounting(mkLedger([mkClaim('x', ['rev_a'])])), undefined);
});
