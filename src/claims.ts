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

import { createHash } from 'node:crypto';

import {
  SCHEMA_VERSION,
  type CanonicalStrength,
  type Challenge,
  type ChallengeAssignment,
  type ChallengeRoutingRecord,
  type Claim,
  type ClaimAssessment,
  type ClaimEvent,
  type ClaimId,
  type ClaimLedger,
  type ClaimView,
  type DiscussionRoundFacts,
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
  type ResponseRoutingRecord,
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
/**
 * Canonical-claim list bounds. Merged findings can carry up to 20 evidence
 * items each, so a claim may legitimately exceed the per-finding cap; 200 is
 * generous and keeps claims.json parseable. Overflow is recorded on the
 * claim's history — bounded, never silently dropped.
 */
const MAX_CLAIM_EVIDENCE = 200;
const MAX_CLAIM_TEXT_ITEMS = 100;

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
 * citations. `readFile` returns the current utf8 text of a manifest-pinned
 * path; the returned bytes are hash-bound to the approved snapshot entry, so
 * citations fail closed on missing, unreadable or drifted files — an
 * unverifiable citation is a rejection, never a silent "structure-only" pass.
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

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Check the citation-shaped fields on one evidence item — invoked for
 * code_location always and for ANY kind carrying path/line fields, so
 * relabeling kind cannot bypass verification.
 *
 * Fails closed: the cited path must be safe, manifest-pinned, readable, and
 * byte-identical (sha256+size) to the approved snapshot entry. A snippet must
 * be non-blank and appear inside the cited line range — the whole-file
 * fallback that made line numbers decorative is gone.
 */
function checkCitation(ev: Evidence, src: SourceAccess): string | null {
  const hasLines = ev.startLine !== undefined || ev.endLine !== undefined;
  if (ev.path === undefined) {
    if (hasLines) return 'citation line fields without path';
    return ev.kind === 'code_location' ? 'code_location missing path' : null;
  }
  const safe = assertSafeRelativePath(ev.path);
  if (!safe.ok) return `unsafe path: ${ev.path}`;
  const rel = safe.value;
  const entry = src.snapshot.files[rel];
  if (entry === undefined) return `path not in snapshot: ${rel}`;
  if (ev.startLine === undefined || !Number.isInteger(ev.startLine) || ev.startLine < 1) {
    return 'missing/invalid startLine';
  }
  if (ev.endLine !== undefined && (!Number.isInteger(ev.endLine) || ev.endLine < ev.startLine)) {
    return `endLine ${ev.endLine} before startLine ${ev.startLine}`;
  }
  const text = src.readFile?.(rel);
  if (text === undefined) {
    return `cited file unreadable — cannot verify against approved snapshot: ${rel}`;
  }
  if (Buffer.byteLength(text, 'utf8') !== entry.size || sha256Hex(text) !== entry.sha256) {
    return `cited file drifted from approved snapshot (sha256/size mismatch): ${rel}`;
  }
  const lines = text.split('\n');
  if (ev.startLine > lines.length) {
    return `startLine ${ev.startLine} beyond file length ${lines.length}`;
  }
  if (ev.endLine !== undefined && ev.endLine > lines.length) {
    return `endLine ${ev.endLine} beyond file length ${lines.length}`;
  }
  if (ev.snippet !== undefined) {
    const want = normalizeSnippet(ev.snippet);
    if (want.length === 0) return 'snippet is empty/whitespace-only';
    const cited = normalizeSnippet(
      lines.slice(ev.startLine - 1, ev.endLine ?? ev.startLine).join(' '),
    );
    if (!cited.includes(want)) return 'snippet not found in cited line range';
  }
  return null;
}

/**
 * Split evidence into admissible and rejected pieces. Citation-shaped fields
 * (path/startLine/endLine) are verified on every evidence kind — an item that
 * carries them must pass the same checks as code_location or is rejected with
 * an explicit reason. Rejected pieces are returned so callers can journal
 * them; they are never admitted into the canonical claim.
 */
export function validateEvidenceList(evs: Evidence[], src: SourceAccess): EvidenceCheck {
  const valid: Evidence[] = [];
  const invalid: InvalidEvidence[] = [];
  for (const ev of evs) {
    const citationShaped =
      ev.kind === 'code_location' ||
      ev.path !== undefined ||
      ev.startLine !== undefined ||
      ev.endLine !== undefined;
    if (citationShaped) {
      const reason = checkCitation(ev, src);
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
  /**
   * Strengths whose ENTIRE evidence list failed citation validation — the
   * strength is dropped (bare praise is never admitted) and the caller
   * journals each rejection visibly. Partial failures keep surviving items.
   */
  strengthRejections: {
    participantId: ParticipantId;
    perspectiveId: PerspectiveId;
    strengthId: string;
    reason: string;
  }[];
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

/**
 * Dedupe-union evidence into a bounded list. Returns the number of items that
 * were distinct but did not fit under `cap` — callers journal that overflow
 * visibly (history event), it is never silent.
 */
function unionEvidenceBounded(into: Evidence[], extra: Evidence[], cap: number): number {
  const seen = new Set(into.map(evidenceKey));
  let dropped = 0;
  for (const ev of extra) {
    const k = evidenceKey(ev);
    if (seen.has(k)) continue;
    if (into.length >= cap) {
      dropped += 1;
      continue;
    }
    seen.add(k);
    into.push(ev);
  }
  return dropped;
}

/** Dedupe-union bounded free-text lists (remedies, openQuestions, titles). */
function unionStrings(into: string[], extra: readonly string[] | undefined, cap: number): number {
  if (extra === undefined) return 0;
  const seen = new Set(into);
  let dropped = 0;
  for (const s of extra) {
    if (seen.has(s)) continue;
    if (into.length >= cap) {
      dropped += 1;
      continue;
    }
    seen.add(s);
    into.push(s);
  }
  return dropped;
}

/**
 * A verified citation span — the concrete identity dedupe merges on. Paths
 * are normalized exactly as the citation checker normalizes them, so
 * "src/a.ts" and "./src/a.ts" identify the same span.
 */
interface CitedRange {
  path: string;
  start: number;
  end: number;
}

/**
 * Verified citation ranges of a finding's ADMITTED evidence — computed from
 * `check.valid`, never from raw finding.evidence, so rejected pieces cannot
 * drive merge identity.
 */
function citedRanges(evs: Evidence[]): CitedRange[] {
  const out: CitedRange[] = [];
  for (const ev of evs) {
    if (ev.path === undefined || ev.startLine === undefined) continue;
    const safe = assertSafeRelativePath(ev.path);
    if (!safe.ok) continue;
    out.push({ path: safe.value, start: ev.startLine, end: ev.endLine ?? ev.startLine });
  }
  return out;
}

/**
 * Conservative merge gate: findings merge only when their VERIFIED citation
 * ranges overlap on the same path — a shared file alone is not identity,
 * since same-title reports of different lines in one file are distinct
 * defects. When BOTH findings hold no verified citation at all, title+kind
 * alone cannot distinguish them and they merge. One side holding verified
 * ranges the other cannot match stays a separate claim — a false non-merge
 * is scribe-recoverable, a false merge destroys a distinct defect's
 * identity.
 */
function mergeCompatible(claimRanges: CitedRange[], findingRanges: CitedRange[]): boolean {
  if (claimRanges.length === 0 || findingRanges.length === 0) {
    return claimRanges.length === 0 && findingRanges.length === 0;
  }
  for (const a of claimRanges) {
    for (const b of findingRanges) {
      if (a.path === b.path && a.start <= b.end && b.start <= a.end) return true;
    }
  }
  return false;
}

/**
 * Merge admitted independent findings into the canonical ledger.
 *
 * Input is sorted by (participantId, findingId) so dedup output is identical
 * regardless of the order artifacts arrived. Findings merge under the
 * conservative policy on Claim: same (kind, normalized title) AND overlapping
 * VERIFIED citation ranges on the same path (or both hold no verified
 * citation). Canonical title/kind/severity/confidence come from the
 * first-sorted finding; every author's rating is preserved in `assessments`,
 * alternate titles in `mergedTitles`, divergent ratings as dissent, and
 * remedies/openQuestions union across all merged findings — bounded, with
 * overflow journaled on the claim history.
 */
export function buildClaimLedger(
  runId: CouncilRunId,
  admitted: AdmittedFinding[],
  src: SourceAccess,
  now: Date,
): LedgerBuild {
  const claims: Claim[] = [];
  const byKey = new Map<string, { claim: Claim; ranges: CitedRange[] }[]>();
  const provenance: Record<ClaimId, ParticipantId[]> = {};
  const evidenceRejections: LedgerBuild['evidenceRejections'] = [];
  const strengthRejections: LedgerBuild['strengthRejections'] = [];

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
    // Identity comes from VERIFIED citations only — rejected evidence above
    // can never make two findings look like the same defect.
    const fRanges = citedRanges(check.valid);
    const bucket = byKey.get(key);
    let existing: Claim | undefined;
    let entryRanges: CitedRange[] | undefined;
    if (bucket !== undefined) {
      for (const e of bucket) {
        if (mergeCompatible(e.ranges, fRanges)) {
          existing = e.claim;
          entryRanges = e.ranges;
          break;
        }
      }
    }
    if (existing !== undefined && entryRanges !== undefined) {
      existing.rejectedEvidence = (existing.rejectedEvidence ?? 0) + check.invalid.length + counterCheck.invalid.length;
      existing.sourceFindings.push({ participantId, findingId: finding.findingId });
      provenance[existing.claimId].push(participantId);
      const seenRange = new Set(entryRanges.map((r) => `${r.path}:${r.start}-${r.end}`));
      for (const r of fRanges) {
        const rk = `${r.path}:${r.start}-${r.end}`;
        if (!seenRange.has(rk)) {
          seenRange.add(rk);
          entryRanges.push(r);
        }
      }
      const evDrop = unionEvidenceBounded(existing.evidence, check.valid, MAX_CLAIM_EVIDENCE);
      const ceDrop = unionEvidenceBounded(existing.counterEvidence, counterCheck.valid, MAX_CLAIM_EVIDENCE);
      const rems = (existing.remedies ??= []);
      const oqs = (existing.openQuestions ??= []);
      const remDrop = unionStrings(rems, finding.remedies, MAX_CLAIM_TEXT_ITEMS);
      const oqDrop = unionStrings(oqs, finding.openQuestions, MAX_CLAIM_TEXT_ITEMS);
      (existing.assessments ??= []).push({
        participantId,
        findingId: finding.findingId,
        severity: finding.severity,
        confidence: finding.confidence,
      });
      if (finding.title !== existing.title) {
        unionStrings((existing.mergedTitles ??= []), [finding.title], MAX_CLAIM_TEXT_ITEMS);
      }
      existing.history.push(
        event(now, null, participantId, 'merged', `merged into ${existing.claimId} from ${participantId}/${finding.findingId}`, finding.findingId),
      );
      const dropped = evDrop + ceDrop + remDrop + oqDrop;
      if (dropped > 0) {
        existing.history.push(
          event(now, null, 'runner', 'merged',
            `union bounded: ${dropped} item(s) over canonical cap retained only in findings/${participantId}.json`),
        );
      }
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
      assessments: [{
        participantId,
        findingId: finding.findingId,
        severity: finding.severity,
        confidence: finding.confidence,
      }],
      dedupeKey: key,
    };
    const rejected = check.invalid.length + counterCheck.invalid.length;
    if (rejected > 0) claim.rejectedEvidence = rejected;
    const remedies: string[] = [];
    const openQuestions: string[] = [];
    unionStrings(remedies, finding.remedies, MAX_CLAIM_TEXT_ITEMS);
    unionStrings(openQuestions, finding.openQuestions, MAX_CLAIM_TEXT_ITEMS);
    if (remedies.length > 0) claim.remedies = remedies;
    if (openQuestions.length > 0) claim.openQuestions = openQuestions;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ claim, ranges: fRanges });
    claims.push(claim);
    provenance[claimId] = [participantId];
  }

  // Grade over the merged, validated evidence — never from assertedGrade.
  for (const claim of claims) {
    claim.grade = deriveGrade(claim.evidence);
  }

  // Canonical strengths: optional, bounded (cap enforced at parse), runner-
  // provenanced. Evidence is re-validated like findings — a strength whose
  // entire evidence list fails citation checks is dropped, not admitted as
  // bare praise; partial failures keep the surviving items.
  const strengths: CanonicalStrength[] = [];
  for (const a of [...admitted].sort((x, y) => x.participantId.localeCompare(y.participantId))) {
    for (const s of [...(a.file.strengths ?? [])].sort((x, y) => x.strengthId.localeCompare(y.strengthId))) {
      const check = validateEvidenceList(s.evidence, src);
      for (const bad of check.invalid) {
        evidenceRejections.push({ ...bad, participantId: a.participantId, findingId: s.strengthId });
      }
      if (check.valid.length === 0) {
        strengthRejections.push({
          participantId: a.participantId,
          perspectiveId: a.perspectiveId,
          strengthId: s.strengthId,
          reason: 'all strength evidence failed citation validation — bare praise is never admitted',
        });
        continue;
      }
      strengths.push({ ...s, evidence: check.valid, participantId: a.participantId, perspectiveId: a.perspectiveId });
    }
  }

  const ledger: ClaimLedger = { schemaVersion: SCHEMA_VERSION, runId, claims, provenance };
  if (strengths.length > 0) ledger.strengths = strengths;
  return { ledger, evidenceRejections, strengthRejections };
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
  /**
   * Globally-unique identity the ledger assigned before routing: responses
   * reference it verbatim, ledger history refId stores it, and the routed
   * Challenge copy carries it as challengeId.
   */
  qualifiedId: string;
}

/**
 * Globally-qualify a worker-minted local challenge id. Workers keep simple
 * ids ("C-1"); the ledger is the only place identity is assigned:
 * `ch-r<round>-<sha256(JSON.stringify([challengerPid, localId])).slice(0,32)>`
 * — deterministic, ID_RE-safe (≤38 chars), and collision-free across
 * challengers and rounds.
 */
export function qualifiedChallengeId(
  round: number,
  challengerPid: ParticipantId,
  localId: string,
): string {
  const h = createHash('sha256')
    .update(JSON.stringify([challengerPid, localId]), 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `ch-r${round}-${h}`;
}

/**
 * Index admitted challenges by QUALIFIED challengeId for response routing.
 * A bare local id additionally resolves only when exactly one admitted
 * challenge minted it — legacy artifacts and unique-id responses keep working,
 * while two seats' identical "C-1" can never silently collapse into one.
 */
export function indexAdmittedChallenges(
  files: { participantId: ParticipantId; file: ChallengesFile }[],
): Map<string, AdmittedChallenge> {
  const out = new Map<string, AdmittedChallenge>();
  const byLocal = new Map<string, AdmittedChallenge[]>();
  for (const { participantId, file } of files) {
    for (const challenge of file.challenges) {
      const qualifiedId = qualifiedChallengeId(file.round, participantId, challenge.challengeId);
      const ac: AdmittedChallenge = { challenge, challengerPid: participantId, round: file.round, qualifiedId };
      out.set(qualifiedId, ac);
      const bucket = byLocal.get(challenge.challengeId);
      if (bucket === undefined) byLocal.set(challenge.challengeId, [ac]);
      else bucket.push(ac);
    }
  }
  for (const [localId, bucket] of byLocal) {
    if (bucket.length === 1 && !out.has(localId)) out.set(localId, bucket[0]);
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
 * Route admitted challenges to claim authors. EVERY merged source author of a
 * claim receives the challenge (except the challenger itself) — a co-author
 * of a merged claim can always defend their contribution. Each author only
 * ever sees challenges against claims they authored, capped per seat per
 * round. Routed Challenge copies carry the qualified challengeId verbatim
 * plus localChallengeId/challengerPid provenance.
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

  // The index may hold both qualified ids and unambiguous local aliases —
  // iterate each admitted challenge exactly once, in qualified-id order.
  const unique = new Map<string, AdmittedChallenge>();
  for (const ac of challenges.values()) unique.set(ac.qualifiedId, ac);
  const sorted = [...unique.values()].sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));

  for (const { challenge, challengerPid, qualifiedId } of sorted) {
    const claim = claimsById.get(challenge.claimId);
    if (claim === undefined || claim.status === 'withdrawn') {
      unroutable.push({
        challengeId: qualifiedId,
        claimId: challenge.claimId,
        reason: claim === undefined ? 'claim not in ledger' : 'claim withdrawn',
      });
      continue;
    }
    const authors = [...new Set(claim.sourceFindings.map((f) => f.participantId))].filter(
      (pid) => pid !== challengerPid,
    );
    if (authors.length === 0) {
      unroutable.push({ challengeId: qualifiedId, claimId: claim.claimId, reason: 'no distinct author to respond' });
      continue;
    }
    const routed: Challenge = {
      ...challenge,
      challengeId: qualifiedId,
      localChallengeId: challenge.challengeId,
      challengerPid,
    };
    for (const authorPid of authors) {
      let list = assignments.get(authorPid);
      if (list === undefined) {
        list = [];
        assignments.set(authorPid, list);
      }
      const existing = list.find((a) => a.claimId === claim.claimId);
      const total = list.reduce((n, a) => n + a.challenges.length, 0);
      if (total >= maxPerSeat) {
        omitted.push({ challengeId: qualifiedId, claimId: claim.claimId, authorPid });
        continue;
      }
      const findingId =
        claim.sourceFindings.find((f) => f.participantId === authorPid)?.findingId ??
        claim.sourceFindings[0].findingId;
      if (existing !== undefined) {
        existing.challenges.push(routed);
      } else {
        list.push({
          claimId: claim.claimId,
          findingId,
          claim: projectClaimView(claim),
          challenges: [routed],
        });
      }
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
 * entries are returned so the caller can journal them visibly AND declared
 * inside the artifact itself as `omittedCount` — the declaration costs bytes,
 * so kept items are popped until the self-describing envelope fits. The cap
 * is measured against the exact artifact serialization (two-space JSON) that
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
  for (const item of ordered) {
    kept.push(item);
    if (serialize({ ...base, assignments: kept }) > byteCap) {
      kept.pop();
      omitted.push(item);
    }
  }
  // Self-describe omissions: the counter consumes bytes too, so pop kept
  // entries until the declared envelope fits. An empty envelope still
  // declares its omissions rather than pretending nothing was assigned.
  let envelope: WorkEnvelope<T>;
  for (;;) {
    envelope = {
      ...base,
      assignments: kept,
      ...(omitted.length > 0 ? { omittedCount: omitted.length } : {}),
    };
    if (serialize(envelope) <= byteCap || kept.length === 0) break;
    const popped = kept.pop();
    if (popped !== undefined) omitted.push(popped);
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

/**
 * One evidence item rejected by the discussion-stage folds. `refId` carries
 * the canonical identity the engine journals (the QUALIFIED challengeId for
 * challenge/response evidence). Round and participant travel with it so the
 * journal keeps full provenance.
 */
export interface EvidenceRejection {
  refId: string;
  participantId: ParticipantId;
  round: number | null;
  evidence: Evidence;
  reason: string;
}

/**
 * Fold admitted challenges into the ledger: qualified identity, status,
 * history, dissent — and the challenger's own evidence, validated against the
 * snapshot like any finding's. Valid items land in claim.counterEvidence and
 * on the DissentRecord itself (provenance); invalid ones are returned for
 * journaling, never silently dropped.
 */
export function applyChallengesToLedger(
  ledger: ClaimLedger,
  admitted: ChallengeAdmission[],
  src: SourceAccess,
  now: Date,
): ApplyResult & { evidenceRejections: EvidenceRejection[] } {
  const byId = new Map(ledger.claims.map((c) => [c.claimId, c]));
  const skipped: ApplyResult['skipped'] = [];
  const evidenceRejections: EvidenceRejection[] = [];
  let applied = 0;

  for (const { participantId, file } of admitted) {
    for (const ch of file.challenges) {
      const qid = qualifiedChallengeId(file.round, participantId, ch.challengeId);
      const claim = byId.get(ch.claimId);
      if (claim === undefined) {
        skipped.push({ refId: qid, reason: `unknown claimId ${ch.claimId}` });
        continue;
      }
      // Idempotent under crash-replay: the fold persists before the stage
      // cursor, so a crash mid-transition may re-run it. A challenge already
      // recorded by the same actor for the same round must not duplicate
      // history or dissent.
      const already = claim.history.some(
        (h) =>
          h.type === 'challenged' &&
          h.refId === qid &&
          h.round === file.round &&
          h.actor === participantId,
      );
      if (already) {
        skipped.push({ refId: qid, reason: 'already applied — duplicate fold' });
        continue;
      }
      const check = validateEvidenceList(ch.evidence, src);
      for (const bad of check.invalid) {
        evidenceRejections.push({
          refId: qid,
          participantId,
          round: file.round,
          evidence: bad.evidence,
          reason: bad.reason,
        });
      }
      const ceDrop = unionEvidenceBounded(claim.counterEvidence, check.valid, MAX_CLAIM_EVIDENCE);
      claim.history.push(
        event(now, file.round, participantId, 'challenged', ch.argument, qid),
      );
      // Qualified linkage every later stage can re-derive: challenge →
      // dissent → response answer state, without trusting worker-local ids.
      (claim.challenges ??= []).push({
        challengeId: qid,
        round: file.round,
        challengerPid: participantId,
        kind: ch.kind,
        answered: false,
      });
      const record: DissentRecord = {
        participantId,
        round: file.round,
        position: truncate(`challenge (${ch.kind}): ${ch.argument}`, DISSENT_POSITION_CHARS),
        ts: now.toISOString(),
        challengeId: qid,
      };
      if (check.valid.length > 0) record.evidence = check.valid;
      claim.dissent.push(record);
      if (check.invalid.length > 0) {
        claim.rejectedEvidence = (claim.rejectedEvidence ?? 0) + check.invalid.length;
      }
      if (ceDrop > 0) {
        claim.history.push(
          event(
            now,
            file.round,
            'runner',
            'merged',
            `counter-evidence union capped at ${MAX_CLAIM_EVIDENCE} — ${ceDrop} item(s) retained only in rounds/${file.round}/challenges/${participantId}.json`,
          ),
        );
      }
      if (claim.status !== 'withdrawn' && claim.status !== 'challenged') {
        claim.status = 'challenged';
      }
      applied += 1;
    }
  }
  return { applied, skipped, evidenceRejections };
}

export interface ResponseAdmission {
  participantId: ParticipantId;
  file: ResponsesFile;
}

/**
 * Re-derive a claim's grade after an evidence mutation and record a
 * `regraded` history event when it actually changed. The event is
 * runner-attributed: grades are derived, never voted or asserted.
 */
function regradeIfChanged(claim: Claim, now: Date, round: number | null): void {
  const next = deriveGrade(claim.evidence);
  if (next === claim.grade) return;
  const prev = claim.grade;
  claim.grade = next;
  claim.history.push(
    event(now, round, 'runner', 'regraded', `grade ${prev} → ${next} after evidence update`),
  );
}

/**
 * Fold admitted author responses into the ledger. `src` re-validates any
 * evidence introduced by a revision or a defence; rejections are returned
 * with the challenged ref for journaling. Defend AND revise both re-derive
 * the grade (a defended claim no longer carries a stale grade); revise UNIONS
 * its evidence so co-author contributions merged earlier are never erased.
 * Responses resolve their challenge by qualified id — or by a bare local id
 * only when the admitted set makes it unambiguous.
 */
export function applyResponsesToLedger(
  ledger: ClaimLedger,
  admitted: ResponseAdmission[],
  challengeIndex: Map<string, AdmittedChallenge>,
  src: SourceAccess,
  now: Date,
): ApplyResult & { evidenceRejections: EvidenceRejection[] } {
  const byId = new Map(ledger.claims.map((c) => [c.claimId, c]));
  const skipped: ApplyResult['skipped'] = [];
  const evidenceRejections: EvidenceRejection[] = [];
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
      // Pair identity, fail closed: a challenge id resolves only for the
      // (claimId, round) it was minted against. A co-author with assignments
      // on several claims cannot echo a valid id onto the wrong claim, and a
      // stale round's id cannot land in a later response file.
      if (admittedCh.challenge.claimId !== res.claimId || admittedCh.round !== file.round) {
        skipped.push({
          refId: res.challengeId,
          reason: `challenge ${admittedCh.qualifiedId} targets ${admittedCh.challenge.claimId}@round ${admittedCh.round}, not ${res.claimId}@round ${file.round}`,
        });
        continue;
      }
      // Canonical identity for this response: the qualified id the routing
      // layer stamped, regardless of what the author echoed back.
      const qid = admittedCh.qualifiedId;
      // Idempotent under crash-replay (see applyChallengesToLedger).
      const already = claim.history.some(
        (h) =>
          RESPONSE_EVENT_TYPES.has(h.type) &&
          h.refId === qid &&
          h.round === file.round &&
          h.actor === participantId,
      );
      if (already) {
        skipped.push({ refId: qid, reason: 'already applied — duplicate fold' });
        continue;
      }

      const check = validateEvidenceList(res.evidence ?? [], src);
      for (const bad of check.invalid) {
        evidenceRejections.push({ refId: qid, participantId, round: file.round, evidence: bad.evidence, reason: bad.reason });
      }
      if (check.invalid.length > 0) {
        claim.rejectedEvidence = (claim.rejectedEvidence ?? 0) + check.invalid.length;
      }
      // A filed response marks the challenge ANSWERED — never resolved. The
      // challenger's dissent record stays live regardless of disposition.
      const crec = claim.challenges?.find((c) => c.challengeId === qid);
      if (crec !== undefined && !crec.answered) {
        crec.answered = true;
        crec.response = { participantId, disposition: res.disposition };
      }

      switch (res.disposition) {
        case 'defend': {
          const drop = unionEvidenceBounded(claim.evidence, check.valid, MAX_CLAIM_EVIDENCE);
          claim.status = 'defended';
          claim.history.push(event(now, file.round, participantId, 'defended', res.argument, qid));
          if (drop > 0) {
            claim.history.push(
              event(now, file.round, 'runner', 'merged',
                `evidence union capped at ${MAX_CLAIM_EVIDENCE} — ${drop} item(s) retained only in rounds/${file.round}/responses/${participantId}.json`),
            );
          }
          regradeIfChanged(claim, now, file.round);
          break;
        }
        case 'revise': {
          const revised = res.revisedFinding;
          if (revised === undefined) {
            skipped.push({ refId: qid, reason: 'revise without revisedFinding' });
            continue;
          }
          const revCheck = validateEvidenceList(revised.evidence, src);
          for (const bad of revCheck.invalid) {
            evidenceRejections.push({ refId: qid, participantId, round: file.round, evidence: bad.evidence, reason: bad.reason });
          }
          const revCounter = validateEvidenceList(revised.counterEvidence ?? [], src);
          for (const bad of revCounter.invalid) {
            evidenceRejections.push({ refId: qid, participantId, round: file.round, evidence: bad.evidence, reason: bad.reason });
          }
          const revRejected = revCheck.invalid.length + revCounter.invalid.length;
          if (revRejected > 0) claim.rejectedEvidence = (claim.rejectedEvidence ?? 0) + revRejected;
          claim.title = revised.title;
          claim.kind = revised.kind;
          claim.severity = revised.severity;
          claim.confidence = revised.confidence;
          // Union — never replace: evidence merged in from co-authors is not
          // the reviser's to delete. (Withdrawal removes a claim, revision
          // amends it.)
          const drop = unionEvidenceBounded(claim.evidence, revCheck.valid, MAX_CLAIM_EVIDENCE);
          const ceDrop = unionEvidenceBounded(claim.counterEvidence, revCounter.valid, MAX_CLAIM_EVIDENCE);
          const rems = (claim.remedies ??= []);
          const oqs = (claim.openQuestions ??= []);
          const remDrop = unionStrings(rems, revised.remedies, MAX_CLAIM_TEXT_ITEMS);
          const oqDrop = unionStrings(oqs, revised.openQuestions, MAX_CLAIM_TEXT_ITEMS);
          (claim.assessments ??= []).push({
            participantId,
            findingId: revised.findingId,
            severity: revised.severity,
            confidence: revised.confidence,
          });
          claim.status = 'revised';
          claim.history.push(event(now, file.round, participantId, 'revised', res.argument, qid));
          const dropped = drop + ceDrop + remDrop + oqDrop;
          if (dropped > 0) {
            claim.history.push(
              event(now, file.round, 'runner', 'merged',
                `union bounded: ${dropped} item(s) over canonical cap retained only in rounds/${file.round}/responses/${participantId}.json`),
            );
          }
          regradeIfChanged(claim, now, file.round);
          break;
        }
        case 'withdraw': {
          claim.status = 'withdrawn';
          claim.history.push(event(now, file.round, participantId, 'withdrawn', res.argument, qid));
          break;
        }
        case 'escalate': {
          claim.status = 'escalated';
          claim.history.push(event(now, file.round, participantId, 'escalated', res.argument, qid));
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

// ─── Discussion routing records + accounting ────────────────────────────────

/**
 * Persist what the engine actually routed for a round's challenge envelopes:
 * claim ids that reached an envelope, claim ids dropped by the byte bound,
 * and claim ids that never got a challenger (no eligible seat / all at cap).
 * Idempotent per round — a crash-replayed routing overwrites, not appends.
 */
export function recordChallengeRouting(
  ledger: ClaimLedger,
  round: number,
  routing: ChallengeRoutingRecord,
): void {
  const discussion = (ledger.discussion ??= { rounds: [] });
  const existing = discussion.rounds.find((r) => r.round === round);
  if (existing === undefined) discussion.rounds.push({ round, challenges: routing });
  else existing.challenges = routing;
}

/**
 * Persist the round's response routing: challenge ids whose response
 * assignment reached an author envelope, ids dropped by the byte bound, ids
 * omitted by the per-seat response cap, and ids no author envelope could
 * take. Creates a stub round when none exists so response omissions are
 * never lost just because the challenge record is absent.
 */
export function recordResponseRouting(
  ledger: ClaimLedger,
  round: number,
  routing: ResponseRoutingRecord,
): void {
  const discussion = (ledger.discussion ??= { rounds: [] });
  let rec = discussion.rounds.find((r) => r.round === round);
  if (rec === undefined) {
    rec = { round, challenges: { routedClaimIds: [], byteDroppedClaimIds: [], unassigned: [] } };
    discussion.rounds.push(rec);
  }
  rec.responses = routing;
}

/**
 * Derive per-round discussion accounting for the report. Filed/answered/
 * unanswered come from Claim.challenges; routed/never-routed/unassigned/
 * byte-dropped/response-side omissions come from the persisted routing
 * records — the four families are disjoint by construction. Answered means
 * only "a response was filed", never "resolved": retained dissent lives in
 * claim.dissent and is NOT subtracted from unresolved disagreement.
 * Returns undefined when no routing records exist (pre-discussion ledgers).
 */
export function buildDiscussionAccounting(ledger: ClaimLedger): DiscussionRoundFacts[] | undefined {
  const records = ledger.discussion?.rounds;
  if (records === undefined || records.length === 0) return undefined;
  const sorted = [...records].sort((a, b) => a.round - b.round);
  return sorted.map((rec) => {
    const filed = ledger.claims.flatMap((c) => (c.challenges ?? []).filter((ch) => ch.round === rec.round));
    const answered = filed.filter((ch) => ch.answered).length;
    const challengedClaims = new Set(
      ledger.claims.filter((c) => (c.challenges ?? []).some((ch) => ch.round === rec.round)).map((c) => c.claimId),
    );
    const routed = new Set(rec.challenges.routedClaimIds);
    const routedNoChallenge = [...routed].filter((id) => !challengedClaims.has(id)).length;
    const unassigned = rec.challenges.unassigned.length;
    const byteDropped = rec.challenges.byteDroppedClaimIds.length;
    const resp = rec.responses;
    return {
      round: rec.round,
      challengesFiled: filed.length,
      challengesAnswered: answered,
      challengesUnanswered: filed.length - answered,
      claimsRouted: routed.size,
      claimsRoutedNoChallenge: routedNoChallenge,
      claimsNeverRouted: unassigned + byteDropped,
      claimsUnassigned: unassigned,
      claimsByteDropped: byteDropped,
      responsesRouted: resp?.routedChallengeIds.length ?? 0,
      responsesByteDropped: resp?.byteDropped.length ?? 0,
      responsesCapOmitted: resp?.capOmitted.length ?? 0,
      responsesUnroutable: resp?.unroutable.length ?? 0,
    };
  });
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
