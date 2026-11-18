/**
 * Unit tests for the canonical claim-ledger operations.
 * Exercises grading honesty, evidence validation against the snapshot,
 * deterministic dedup/assignment, envelope caps, and ledger mutation —
 * never by echoing the implementation back at itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  claimAuthors,
  claimsById,
  deriveGrade,
  fitEnvelope,
  indexAdmittedChallenges,
  makeEnvelopeBase,
  projectClaimView,
  validateEvidenceList,
  type AdmittedChallenge,
  type SourceAccess,
} from '../src/claims.js';

const RUN = 'crun_test';
const NOW = new Date('2026-01-01T00:00:00.000Z');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FILE_TEXT = ['line one', 'const x = dangerous();', 'line three', 'line four'].join('\n');

function sha(p: string): string {
  let h = 0;
  for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
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
      'src/app.js': { sha256: sha(FILE_TEXT), size: FILE_TEXT.length },
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

test('assignResponses: routes only to claim author, caps per seat, withdrawn unroutable', () => {
  const claim = mkClaim('clm_1', ['rev_a']);
  const withdrawn = { ...mkClaim('clm_2', ['rev_a']), status: 'withdrawn' as const };
  const challenges = new Map<string, AdmittedChallenge>();
  for (let i = 0; i < 5; i++) {
    challenges.set(`ch_${i}`, {
      challenge: { challengeId: `ch_${i}`, claimId: 'clm_1', kind: 'missing_evidence', argument: `why ${i}`, evidence: [] },
      challengerPid: 'rev_b',
      round: 1,
    });
  }
  challenges.set('ch_w', {
    challenge: { challengeId: 'ch_w', claimId: 'clm_2', kind: 'other', argument: 'moot', evidence: [] },
    challengerPid: 'rev_b',
    round: 1,
  });
  const claimsByIdMap = new Map<string, Claim>([
    ['clm_1', claim],
    ['clm_2', withdrawn],
  ]);
  const plan = assignResponses({ challenges, claimsById: claimsByIdMap, maxPerSeat: 3 });
  const list = plan.assignments.get('rev_a')!;
  const routed = list.flatMap((a) => a.challenges.map((c) => c.challengeId));
  assert.equal(routed.length, 3, 'cap applied');
  assert.ok(list.every((a) => a.claimId === 'clm_1'));
  assert.ok(plan.omitted.length === 2, 'two challenges over cap omitted');
  assert.ok(plan.unroutable.some((u) => u.challengeId === 'ch_w'), 'withdrawn claim unroutable');
  // The challenger is never asked to respond to its own challenge.
  assert.ok(!plan.assignments.has('rev_b'));
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
  // Omissions are whole trailing entries, never partial JSON.
  assert.deepEqual(
    fit.omitted.map((o) => o.claimId),
    items.slice(fit.envelope.assignments.length).map((i) => i.claimId),
  );
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
    NOW,
  );
  const c = ledger.claims[0];
  assert.equal(c.status, 'challenged');
  assert.ok(c.history.some((h) => h.type === 'challenged' && h.refId === 'ch_1'));
  assert.ok(c.dissent.some((d) => d.participantId === 'rev_b' && d.position.includes('prove it')));
  assert.equal(res.applied, 1);
  assert.equal(res.skipped.length, 1);
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
    idx.set(`ch_${cid}`, {
      challenge: { challengeId: `ch_${cid}`, claimId: cid, kind: 'missing_evidence', argument: 'why', evidence: [] },
      challengerPid: 'rev_b',
      round: 1,
    });
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
  assert.equal(byId.get('clm_2')!.grade, 'speculative', 'revised evidence re-graded');
  assert.equal(byId.get('clm_3')!.status, 'withdrawn');
  assert.equal(byId.get('clm_4')!.status, 'escalated');
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
  const first = applyChallengesToLedger(ledger, [challengeFile], NOW);
  const histLen = ledger.claims[0].history.length;
  const dissentLen = ledger.claims[0].dissent.length;
  const replay = applyChallengesToLedger(ledger, [challengeFile], new Date(NOW.getTime() + 5000));
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

test('indexAdmittedChallenges indexes by challengeId with author', () => {
  const idx = indexAdmittedChallenges([
    {
      participantId: 'rev_b',
      file: {
        schemaVersion: SCHEMA_VERSION,
        runId: RUN,
        round: 1,
        participantId: 'rev_b',
        challenges: [
          { challengeId: 'ch_1', claimId: 'clm_1', kind: 'other', argument: 'a', evidence: [] } as Challenge,
        ],
      },
    },
  ]);
  assert.equal(idx.get('ch_1')?.challengerPid, 'rev_b');
});
