/**
 * Canonical claim-ledger operations for the council protocol engine.
 *
 * Owns everything that turns untrusted reviewer/scribe output into canonical
 * state: evidence validation against the source snapshot, honest grade
 * derivation (reviewer-asserted grades never pass through), deterministic
 * dedup with provenance, deterministic challenge/author-response assignment,
 * byte-capped per-recipient envelopes, and ledger mutation for admitted
 * challenges and responses.
 *
 * Determinism: every ordering that affects output is derived from stable ids
 * (participantId, findingId, claimId, challengeId), never from Map insertion
 * order of untrusted input or from wall-clock randomness.
 */

import {
  SCHEMA_VERSION,
  type Challenge,
  type ChallengeAssignment,
  type Claim,
  type ClaimEvent,
  type ClaimId,
  type ClaimLedger,
  type ClaimView,
  type DissentRecord,
  type Evidence,
  type EvidenceGrade,
  type Finding,
  type FindingId,
  type FindingsFile,
  type ChallengesFile,
  type ResponsesFile,
  type ParticipantId,
  type Perspective,
  type PerspectiveId,
  type ResponseAssignment,
  type CouncilRunId,
  type Severity,
  type SourceSnapshot,
  type WorkEnvelope,
  type PhaseKind,
} from './contracts.js';
import { assertSafeRelativePath, maxClaimGrade } from './validation.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Reviewer-produced evidence can never reach independently-verified status in v1. */
const REVIEWER_GRADE_CEILING: EvidenceGrade = 'plausible_risk';
/** Bound for free-text fields copied into ledger history/dissent. */
const HISTORY_DETAIL_CHARS = 400;
const DISSENT_POSITION_CHARS = 1000;

const GRADE_ORDER: Record<EvidenceGrade, number> = {
  unsupported: 0,
  speculative: 1,
  plausible_risk: 2,
  verified_defect: 3,
};

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** History event types produced by author-response folds. */
const RESPONSE_EVENT_TYPES: ReadonlySet<ClaimEvent['type']> = new Set([
  'defended',
  'revised',
  'withdrawn',
  'escalated',
]);

// ─── Small helpers ───────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function gradeRank(grade: EvidenceGrade): number {
  return GRADE_ORDER[grade];
}

export function severityRank(sev: Severity): number {
  return SEVERITY_ORDER[sev];
}

/** Lower of two grades — used to cap reviewer-derived grades. */
export function minGrade(a: EvidenceGrade, b: EvidenceGrade): EvidenceGrade {
  return GRADE_ORDER[a] <= GRADE_ORDER[b] ? a : b;
}

/** Deterministic dedup key for findings claiming the same thing. */
export function dedupeKey(f: Pick<Finding, 'title' | 'kind'>): string {
  const norm = f.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${f.kind}|${norm}`;
}

// ─── Evidence validation against the snapshot/current source ────────────────

/**
 * Read-only access to the reviewed source used to check code_location
 * citations. `readFile` may be omitted (structure-only checks) but then line
 * and snippet claims stay unverifiable and cannot raise a grade.
 */
export interface SourceAccess {
  snapshot: SourceSnapshot;
  /** Return current file text for a snapshot-relative path, or undefined. */
  readFile?: (relPath: string) => string | undefined;
}

export interface InvalidEvidence {
  evidence: Evidence;
  reason: string;
}

export interface EvidenceCheck {
  valid: Evidence[];
  invalid: InvalidEvidence[];
}

function normalizeSnippet(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function checkCodeLocation(ev: Evidence, src: SourceAccess): string | null {
  if (ev.path === undefined) return 'code_location missing path';
  const safe = assertSafeRelativePath(ev.path);
  if (!safe.ok) return `unsafe path: ${ev.path}`;
  const rel = safe.value;
  const entry = src.snapshot.files[rel];
  if (entry === undefined) return `path not in snapshot: ${rel}`;
  if (ev.startLine === undefined || !Number.isInteger(ev.startLine) || ev.startLine < 1) {
    return `missing/invalid startLine`;
  }
  if (ev.endLine !== undefined && (!Number.isInteger(ev.endLine) || ev.endLine < ev.startLine)) {
    return `endLine ${ev.endLine} before startLine ${ev.startLine}`;
  }
  const text = src.readFile?.(rel);
  if (text === undefined) {
    // Path exists in the snapshot; line/snippet contents are unverifiable.
    return null;
  }
  const lines = text.split('\n');
  if (ev.startLine > lines.length) {
    return `startLine ${ev.startLine} beyond file length ${lines.length}`;
  }
  if (ev.endLine !== undefined && ev.endLine > lines.length) {
    return `endLine ${ev.endLine} beyond file length ${lines.length}`;
  }
  if (ev.snippet !== undefined) {
    const cited = normalizeSnippet(
      lines.slice(ev.startLine - 1, ev.endLine ?? ev.startLine).join(' '),
    );
    const want = normalizeSnippet(ev.snippet);
    if (want.length > 0 && !cited.includes(want) && !normalizeSnippet(text).includes(want)) {
      return `snippet not found in cited source`;
    }
  }
  return null;
}

/**
 * Split evidence into admissible and rejected pieces. Invalid pieces are
 * returned with a reason so the caller can journal them; they are never
 * admitted into the canonical claim.
 */
export function validateEvidenceList(evs: Evidence[], src: SourceAccess): EvidenceCheck {
  const valid: Evidence[] = [];
  const invalid: InvalidEvidence[] = [];
  for (const ev of evs) {
    if (ev.kind === 'code_location') {
      const reason = checkCodeLocation(ev, src);
      if (reason !== null) {
        invalid.push({ evidence: ev, reason });
        continue;
      }
    }
    if (ev.kind === 'repro' && (ev.steps === undefined || ev.observed === undefined)) {
      invalid.push({ evidence: ev, reason: 'repro missing steps/observed' });
      continue;
    }
    valid.push(ev);
  }
  return { valid, invalid };
}

/**
 * Derive the honest grade for a claim from its *validated* evidence.
 * maxClaimGrade is the contracts-owned ceiling; we additionally cap at
 * REVIEWER_GRADE_CEILING because unaudited reviewer output — including
 * asserted reproductions — is never independently verified in v1.
 */
export function deriveGrade(evidence: Evidence[]): EvidenceGrade {
  if (evidence.length === 0) return 'unsupported';
  const ceiling = maxClaimGrade(evidence);
  return minGrade(ceiling, REVIEWER_GRADE_CEILING);
}

// ─── Ledger construction (independent findings → canonical claims) ──────────

export interface AdmittedFinding {
  participantId: ParticipantId;
  perspectiveId: PerspectiveId;
  file: FindingsFile;
}

export interface LedgerRejection {
  participantId: ParticipantId;
  findingId: FindingId;
  reason: string;
}

export interface LedgerBuild {
  ledger: ClaimLedger;
  /** Evidence pieces that failed validation (the claim itself is kept, downgraded). */
  evidenceRejections: (InvalidEvidence & { participantId: ParticipantId; findingId: FindingId })[];
}

function event(
  now: Date,
  round: number | null,
  actor: string,
  type: ClaimEvent['type'],
  detail?: string,
  refId?: string,
): ClaimEvent {
  const e: ClaimEvent = { ts: now.toISOString(), round, actor: actor as ClaimEvent['actor'], type };
  if (detail !== undefined) e.detail = truncate(detail, HISTORY_DETAIL_CHARS);
  if (refId !== undefined) e.refId = refId;
  return e;
}

function evidenceKey(ev: Evidence): string {
  return JSON.stringify(ev);
}

function unionEvidence(into: Evidence[], extra: Evidence[]): void {
  const seen = new Set(into.map(evidenceKey));
  for (const ev of extra) {
    const k = evidenceKey(ev);
    if (!seen.has(k)) {
      seen.add(k);
      into.push(ev);
    }
  }
}

/**
 * Merge admitted independent findings into the canonical ledger.
 *
 * Input is sorted by (participantId, findingId) so dedup output is identical
 * regardless of the order artifacts arrived. Same (kind, normalized title)
 * merges into one claim; provenance is retained in sourceFindings/provenance,
 * every merge is a history event, and disagreeing severities/confidences are
 * kept as dissent rather than silently averaged.
 */
export function buildClaimLedger(
  runId: CouncilRunId,
  admitted: AdmittedFinding[],
  src: SourceAccess,
  now: Date,
): LedgerBuild {
  const claims: Claim[] = [];
  const byKey = new Map<string, Claim>();
  const provenance: Record<ClaimId, ParticipantId[]> = {};
  const evidenceRejections: LedgerBuild['evidenceRejections'] = [];

  const flat: { participantId: ParticipantId; perspectiveId: PerspectiveId; finding: Finding }[] = [];
  for (const a of admitted) {
    for (const finding of a.file.findings) {
      flat.push({ participantId: a.participantId, perspectiveId: a.perspectiveId, finding });
    }
  }
  flat.sort((x, y) =>
    x.participantId === y.participantId
      ? x.finding.findingId.localeCompare(y.finding.findingId)
      : x.participantId.localeCompare(y.participantId),
  );

  for (const { participantId, finding } of flat) {
    const check = validateEvidenceList(finding.evidence, src);
    for (const bad of check.invalid) {
      evidenceRejections.push({ ...bad, participantId, findingId: finding.findingId });
    }
    const counterCheck = validateEvidenceList(finding.counterEvidence ?? [], src);
    for (const bad of counterCheck.invalid) {
      evidenceRejections.push({ ...bad, participantId, findingId: finding.findingId });
    }

    const key = dedupeKey(finding);
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.sourceFindings.push({ participantId, findingId: finding.findingId });
      provenance[existing.claimId].push(participantId);
      unionEvidence(existing.evidence, check.valid);
      unionEvidence(existing.counterEvidence, counterCheck.valid);
      existing.history.push(
        event(now, null, participantId, 'merged', `merged into ${existing.claimId} from ${participantId}/${finding.findingId}`, finding.findingId),
      );
      if (finding.severity !== existing.severity || finding.confidence !== existing.confidence) {
        existing.dissent.push({
          participantId,
          round: null,
          position: truncate(
            `rated severity=${finding.severity} confidence=${finding.confidence} on merged finding ${finding.findingId}`,
            DISSENT_POSITION_CHARS,
          ),
          ts: now.toISOString(),
        });
      }
      continue;
    }

    const claimId = `clm_${String(claims.length + 1).padStart(4, '0')}`;
    const claim: Claim = {
      claimId,
      title: finding.title,
      kind: finding.kind,
      grade: 'unsupported', // re-derived after evidence merge below
      status: 'proposed',
      severity: finding.severity,
      confidence: finding.confidence,
      evidence: [...check.valid],
      counterEvidence: [...counterCheck.valid],
      sourceFindings: [{ participantId, findingId: finding.findingId }],
      history: [event(now, null, participantId, 'admitted', `from ${participantId}/${finding.findingId}`, finding.findingId)],
      dissent: [],
    };
    byKey.set(key, claim);
    claims.push(claim);
    provenance[claimId] = [participantId];
  }

  // Grade over the merged, validated evidence — never from assertedGrade.
  for (const claim of claims) {
    claim.grade = deriveGrade(claim.evidence);
  }

  return {
    ledger: { schemaVersion: SCHEMA_VERSION, runId, claims, provenance },
    evidenceRejections,
  };
}

// ─── Claim projection and challenge assignment ───────────────────────────────

/** Sanitized claim projection — the only claim view a challenger ever sees. */
export function projectClaimView(claim: Claim): ClaimView {
  return {
    claimId: claim.claimId,
    title: claim.title,
    kind: claim.kind,
    severity: claim.severity,
    evidence: claim.evidence,
    counterEvidence: claim.counterEvidence,
  };
}

export interface ChallengePlan {
  /** Deterministic per-recipient assignment lists (insertion order = pid sort). */
  assignments: Map<ParticipantId, ChallengeAssignment[]>;
  /** Claims that got no challenger because every eligible seat was at cap. */
  unassigned: { claimId: ClaimId; reason: string }[];
}

/**
 * Deterministically distribute claims to challengers.
 * - No self-challenges: a claim's author (any provenance participant) never sees it.
 * - Each claim goes to the eligible reviewer with the fewest assignments;
 *   ties break on lowest participantId. Fully deterministic.
 * - Claims are processed strongest-first (severity, grade, claimId) so caps
 *   drop the weakest claims, visibly.
 */
export function assignChallenges(input: {
  claims: Claim[];
  challengerIds: ParticipantId[];
  claimAuthors: (claimId: ClaimId) => ParticipantId[];
  perspectiveOf: (pid: ParticipantId) => Perspective | undefined;
  maxPerSeat: number;
}): ChallengePlan {
  const { claims, challengerIds, claimAuthors, perspectiveOf, maxPerSeat } = input;
  const eligible = [...challengerIds].sort();
  const assignments = new Map<ParticipantId, ChallengeAssignment[]>(
    eligible.map((pid) => [pid, []]),
  );
  const unassigned: ChallengePlan['unassigned'] = [];

  const ordered = [...claims]
    .filter((c) => c.status !== 'withdrawn')
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        gradeRank(b.grade) - gradeRank(a.grade) ||
        a.claimId.localeCompare(b.claimId),
    );

  for (const claim of ordered) {
    const authors = new Set(claimAuthors(claim.claimId));
    const candidates = eligible.filter((pid) => !authors.has(pid));
    if (candidates.length === 0) {
      unassigned.push({ claimId: claim.claimId, reason: 'no eligible challenger (all seats authored this claim)' });
      continue;
    }
    candidates.sort((a, b) => {
      const da = assignments.get(a)!.length;
      const db = assignments.get(b)!.length;
      return da - db || a.localeCompare(b);
    });
    const target = candidates[0];
    const list = assignments.get(target)!;
    if (list.length >= maxPerSeat) {
      // Try the next-least-loaded eligible seat before giving up.
      const fallback = candidates.find((pid) => assignments.get(pid)!.length < maxPerSeat);
      if (fallback === undefined) {
        unassigned.push({ claimId: claim.claimId, reason: 'all eligible challengers at cap' });
        continue;
      }
      assignTo(fallback, claim, perspectiveOf, assignments);
      continue;
    }
    assignTo(target, claim, perspectiveOf, assignments);
  }
  return { assignments, unassigned };
}

function assignTo(
  pid: ParticipantId,
  claim: Claim,
  perspectiveOf: (pid: ParticipantId) => Perspective | undefined,
  assignments: Map<ParticipantId, ChallengeAssignment[]>,
): void {
  const list = assignments.get(pid)!;
  const perspective = perspectiveOf(pid);
  const questions = perspective?.charter.reviewQuestions ?? [];
  const question =
    questions.length > 0
      ? questions[list.length % questions.length]
      : `Challenge this claim from your perspective: ${truncate(claim.title, 120)}`;
  list.push({
    assignmentId: `asg_${claim.claimId}_${pid}`,
    claimId: claim.claimId,
    claim: projectClaimView(claim),
    question,
  });
}

// ─── Response assignment routing ────────────────────────────────────────────

export interface AdmittedChallenge {
  challenge: Challenge;
  challengerPid: ParticipantId;
  round: number;
}

/** Index admitted challenges by challengeId for response routing. */
export function indexAdmittedChallenges(
  files: { participantId: ParticipantId; file: ChallengesFile }[],
): Map<string, AdmittedChallenge> {
  const out = new Map<string, AdmittedChallenge>();
  for (const { participantId, file } of files) {
    for (const challenge of file.challenges) {
      out.set(challenge.challengeId, { challenge, challengerPid: participantId, round: file.round });
    }
  }
  return out;
}

export interface ResponsePlan {
  assignments: Map<ParticipantId, ResponseAssignment[]>;
  /** Admitted challenges with no routable author (seat failed/gone). */
  unroutable: { challengeId: string; claimId: ClaimId; reason: string }[];
  /** Challenges dropped because the author was already at cap. */
  omitted: { challengeId: string; claimId: ClaimId; authorPid: ParticipantId }[];
}

/**
 * Route admitted challenges to claim authors. Each author only ever sees
 * challenges against claims they authored, capped per seat per round.
 */
export function assignResponses(input: {
  challenges: Map<string, AdmittedChallenge>;
  claimsById: Map<ClaimId, Claim>;
  maxPerSeat: number;
}): ResponsePlan {
  const { challenges, claimsById, maxPerSeat } = input;
  const assignments = new Map<ParticipantId, ResponseAssignment[]>();
  const unroutable: ResponsePlan['unroutable'] = [];
  const omitted: ResponsePlan['omitted'] = [];

  const sorted = [...challenges.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [challengeId, { challenge, challengerPid }] of sorted) {
    const claim = claimsById.get(challenge.claimId);
    if (claim === undefined || claim.status === 'withdrawn') {
      unroutable.push({
        challengeId,
        claimId: challenge.claimId,
        reason: claim === undefined ? 'claim not in ledger' : 'claim withdrawn',
      });
      continue;
    }
    const authorPid = claim.sourceFindings[0]?.participantId;
    if (authorPid === undefined || authorPid === challengerPid) {
      unroutable.push({ challengeId, claimId: claim.claimId, reason: 'no distinct author to respond' });
      continue;
    }
    let list = assignments.get(authorPid);
    if (list === undefined) {
      list = [];
      assignments.set(authorPid, list);
    }
    const existing = list.find((a) => a.claimId === claim.claimId);
    const total = list.reduce((n, a) => n + a.challenges.length, 0);
    if (total >= maxPerSeat) {
      omitted.push({ challengeId, claimId: claim.claimId, authorPid });
      continue;
    }
    if (existing !== undefined) {
      existing.challenges.push(challenge);
    } else {
      list.push({
        claimId: claim.claimId,
        findingId: claim.sourceFindings[0].findingId,
        claim: projectClaimView(claim),
        challenges: [challenge],
      });
    }
  }
  return { assignments, unroutable, omitted };
}

// ─── Envelope sizing (cap by whole entries, never truncated JSON) ───────────

export interface EnvelopeFit<T> {
  envelope: WorkEnvelope<T>;
  omitted: T[];
  bytes: number;
}

/**
 * Serialize an envelope, appending whole assignments in the given (already
 * deterministic) order until the next entry would exceed byteCap. Omitted
 * entries are returned so the caller can journal them visibly. The cap is
 * measured against the exact artifact serialization (two-space JSON) that
 * callers persist — never a different representation.
 */
export function fitEnvelope<T>(
  base: Omit<WorkEnvelope<T>, 'assignments'>,
  ordered: T[],
  byteCap: number,
): EnvelopeFit<T> {
  const serialize = (e: WorkEnvelope<T>): number =>
    Buffer.byteLength(JSON.stringify(e, null, 2), 'utf8');
  const kept: T[] = [];
  const omitted: T[] = [];
  let envelope: WorkEnvelope<T> = { ...base, assignments: kept };
  for (const item of ordered) {
    kept.push(item);
    if (serialize(envelope) > byteCap) {
      kept.pop();
      omitted.push(item);
    } else {
      envelope = { ...base, assignments: kept };
    }
  }
  return { envelope, omitted, bytes: serialize(envelope) };
}

// ─── Ledger mutation: admitted challenges and author responses ──────────────

export interface ChallengeAdmission {
  participantId: ParticipantId;
  file: ChallengesFile;
}

export interface ApplyResult {
  applied: number;
  skipped: { refId: string; reason: string }[];
}

/** Fold admitted challenges into the ledger: status, history, dissent. */
export function applyChallengesToLedger(
  ledger: ClaimLedger,
  admitted: ChallengeAdmission[],
  now: Date,
): ApplyResult {
  const byId = new Map(ledger.claims.map((c) => [c.claimId, c]));
  const applied: Claim[] = [];
  const skipped: ApplyResult['skipped'] = [];

  for (const { participantId, file } of admitted) {
    for (const ch of file.challenges) {
      const claim = byId.get(ch.claimId);
      if (claim === undefined) {
        skipped.push({ refId: ch.challengeId, reason: `unknown claimId ${ch.claimId}` });
        continue;
      }
      // Idempotent under crash-replay: the fold persists before the stage
      // cursor, so a crash mid-transition may re-run it. A challenge already
      // recorded by the same actor for the same round must not duplicate
      // history or dissent.
      const already = claim.history.some(
        (h) =>
          h.type === 'challenged' &&
          h.refId === ch.challengeId &&
          h.round === file.round &&
          h.actor === participantId,
      );
      if (already) {
        skipped.push({ refId: ch.challengeId, reason: 'already applied — duplicate fold' });
        continue;
      }
      claim.history.push(
        event(now, file.round, participantId, 'challenged', ch.argument, ch.challengeId),
      );
      claim.dissent.push({
        participantId,
        round: file.round,
        position: truncate(`challenge (${ch.kind}): ${ch.argument}`, DISSENT_POSITION_CHARS),
        ts: now.toISOString(),
      });
      if (claim.status !== 'withdrawn' && claim.status !== 'challenged') {
        claim.status = 'challenged';
      }
      applied.push(claim);
    }
  }
  return { applied: applied.length, skipped };
}

export interface ResponseAdmission {
  participantId: ParticipantId;
  file: ResponsesFile;
}

/**
 * Fold admitted author responses into the ledger. `src` is used to
 * re-validate any evidence introduced by a revision or a defence.
 */
export function applyResponsesToLedger(
  ledger: ClaimLedger,
  admitted: ResponseAdmission[],
  challengeIndex: Map<string, AdmittedChallenge>,
  src: SourceAccess,
  now: Date,
): ApplyResult & { evidenceRejections: InvalidEvidence[] } {
  const byId = new Map(ledger.claims.map((c) => [c.claimId, c]));
  const skipped: ApplyResult['skipped'] = [];
  const evidenceRejections: InvalidEvidence[] = [];
  let applied = 0;

  for (const { participantId, file } of admitted) {
    for (const res of file.responses) {
      const claim = byId.get(res.claimId);
      if (claim === undefined) {
        skipped.push({ refId: res.challengeId, reason: `unknown claimId ${res.claimId}` });
        continue;
      }
      const authored = claim.sourceFindings.some((f) => f.participantId === participantId);
      if (!authored) {
        skipped.push({ refId: res.challengeId, reason: `${participantId} is not an author of ${res.claimId}` });
        continue;
      }
      const admittedCh = challengeIndex.get(res.challengeId);
      if (admittedCh === undefined) {
        skipped.push({ refId: res.challengeId, reason: `response to unadmitted challenge ${res.challengeId}` });
        continue;
      }
      // Idempotent under crash-replay (see applyChallengesToLedger).
      const already = claim.history.some(
        (h) =>
          RESPONSE_EVENT_TYPES.has(h.type) &&
          h.refId === res.challengeId &&
          h.round === file.round &&
          h.actor === participantId,
      );
      if (already) {
        skipped.push({ refId: res.challengeId, reason: 'already applied — duplicate fold' });
        continue;
      }

      const check = validateEvidenceList(res.evidence ?? [], src);
      evidenceRejections.push(...check.invalid);

      switch (res.disposition) {
        case 'defend': {
          unionEvidence(claim.evidence, check.valid);
          claim.status = 'defended';
          claim.history.push(event(now, file.round, participantId, 'defended', res.argument, res.challengeId));
          break;
        }
        case 'revise': {
          const revised = res.revisedFinding;
          if (revised === undefined) {
            skipped.push({ refId: res.challengeId, reason: 'revise without revisedFinding' });
            continue;
          }
          const revCheck = validateEvidenceList(revised.evidence, src);
          evidenceRejections.push(...revCheck.invalid);
          const revCounter = validateEvidenceList(revised.counterEvidence ?? [], src);
          evidenceRejections.push(...revCounter.invalid);
          claim.title = revised.title;
          claim.kind = revised.kind;
          claim.severity = revised.severity;
          claim.confidence = revised.confidence;
          claim.evidence = revCheck.valid;
          unionEvidence(claim.counterEvidence, revCounter.valid);
          claim.grade = deriveGrade(claim.evidence);
          claim.status = 'revised';
          claim.history.push(event(now, file.round, participantId, 'revised', res.argument, res.challengeId));
          break;
        }
        case 'withdraw': {
          claim.status = 'withdrawn';
          claim.history.push(event(now, file.round, participantId, 'withdrawn', res.argument, res.challengeId));
          break;
        }
        case 'escalate': {
          claim.status = 'escalated';
          claim.history.push(event(now, file.round, participantId, 'escalated', res.argument, res.challengeId));
          break;
        }
      }
      applied += 1;
    }
  }
  return { applied, skipped, evidenceRejections };
}

// ─── Ledger queries used by the engine ──────────────────────────────────────

export function claimsById(ledger: ClaimLedger): Map<ClaimId, Claim> {
  return new Map(ledger.claims.map((c) => [c.claimId, c]));
}

/** All participant ids that authored a source finding on this claim. */
export function claimAuthors(ledger: ClaimLedger, claimId: ClaimId): ParticipantId[] {
  return ledger.provenance[claimId] ?? [];
}

/** Deterministic claim ordering for reports: severity, grade, then id. */
export function orderedClaims(ledger: ClaimLedger): Claim[] {
  return [...ledger.claims].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      gradeRank(b.grade) - gradeRank(a.grade) ||
      a.claimId.localeCompare(b.claimId),
  );
}

export function makeEnvelopeBase<T>(input: {
  runId: CouncilRunId;
  phase: PhaseKind;
  round: number | null;
  recipientId: ParticipantId;
  outputPath: string;
  outputContract: string;
}): Omit<WorkEnvelope<T>, 'assignments'> {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    phase: input.phase,
    round: input.round,
    recipientId: input.recipientId,
    outputPath: input.outputPath,
    outputContract: input.outputContract,
  };
}
