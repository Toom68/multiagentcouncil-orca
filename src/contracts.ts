/**
 * Shared contracts for Multiagent Council.
 *
 * Single source of truth for every module boundary: config, roster, approval,
 * snapshot, findings, challenges, responses, scribe output, claim ledger,
 * participants/attempts, state, journal, report, and the HostAdapter / Store /
 * Engine / PromptBuilder callable surfaces.
 *
 * Everything here must be JSON-serializable (no functions on data types).
 * Parse untrusted input only through src/validation.ts parsers.
 */

// ─── Result and structured errors ────────────────────────────────────────────

export interface ValidationIssue {
  /** JSON-pointer-ish path of the offending field, e.g. "seats[2].agent.model". */
  path: string;
  /** Stable machine-readable reason, e.g. "too_long", "bad_enum", "unsafe_path". */
  code: string;
  message: string;
}

/** Parse result for untrusted (worker- or user-produced) JSON. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export type CouncilErrorCode =
  | 'schema_invalid'
  | 'config_invalid'
  | 'roster_invalid'
  | 'approval_required'
  | 'approval_stale'
  | 'invalid_transition'
  | 'barrier_refused'
  | 'budget_exceeded'
  | 'deadline_exceeded'
  | 'untrusted_output'
  | 'snapshot_drift'
  | 'adapter_error'
  | 'launch_unknown'
  | 'io_error'
  | 'cancelled'
  | 'unsupported';

export interface CouncilError {
  code: CouncilErrorCode;
  message: string;
  /** Optional field-level issues when code is a validation failure. */
  issues?: ValidationIssue[];
  /** Extra machine-readable context (ids, paths, counts). */
  details?: Record<string, unknown>;
}

/** Async/operation result for host, store and engine calls. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CouncilError };

// ─── Identifiers ─────────────────────────────────────────────────────────────

export type CouncilRunId = string; // "crun_<ulid>"
export type OrcaRunId = string; // orca orchestration run id
export type TaskId = string;
export type DispatchId = string;
export type TerminalHandle = string; // "term_…"
export type MessageId = string;
export type PerspectiveId = string;
export type ParticipantId = string;
export type SeatId = string;
export type FindingId = string;
export type ClaimId = string;
export type ChallengeId = string;
export type AttemptId = string;
export type SnapshotId = string;
export type ApprovalId = string;

export const SCHEMA_VERSION = 1 as const;

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Council configuration. This is the *resolved* shape (all defaults applied);
 * validation.ts resolves a raw partial object into this.
 *
 * Approved defaults: requestedPerspectives 15, participants 15, concurrency 5,
 * rounds 1 (max 3), maxFindingsPerSeat 7, maxChallengesPerSeatPerRound 3,
 * envelopeBytes 8192, quorumRatio 0.67, maxLaunches 56 (= minViableLaunches
 * for the default 15 seats/1 round, 48, plus 8 retry slack).
 */
export interface CouncilConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Number of perspectives the organiser must propose. Range 10–25. */
  requestedPerspectives: number;
  /** Number of reviewer seats selected from the proposal. 1..requestedPerspectives. */
  participants: number;
  /** Max workers live at once. */
  concurrency: number;
  /** Bounded discussion rounds (challenge+response cycles). Range 1–3. */
  rounds: number;
  /** Fraction of seats that must settle for a phase to close with partial coverage. (0,1]. */
  quorumRatio: number;
  /**
   * Hard cap on total worker launches for the whole run. Charged per fresh
   * orchestration Task — a full default workflow is organiser(1) +
   * independent(participants) + scribeNotes(1) + challenges +
   * authorResponses (participants each per round) + scribeSynthesis(1), i.e.
   * participants + 2*participants*rounds + 3 launches before retries.
   * resolveConfig defaults this to that minimum plus slack and refuses an
   * explicit value below the minimum (see minViableLaunches).
   */
  maxLaunches: number;
  /** Max findings a reviewer may emit. */
  maxFindingsPerSeat: number;
  /** Max challenges a reviewer may be assigned / emit per round. */
  maxChallengesPerSeatPerRound: number;
  /** Max author responses per seat per round. */
  maxResponsesPerSeatPerRound: number;
  /** Byte cap for a single per-recipient work envelope. */
  envelopeBytes: number;
  /** Max runner-originated mails per participant. */
  maxMailPerParticipant: number;
  /** Max chars for any single free-text field in worker output. */
  maxTextChars: number;
  /** Per-phase wall-clock deadlines (ms). Checked on advance, not in real time. */
  deadlines: PhaseDeadlines;
  /**
   * Optional explicit staff choices (PUBLIC-USE.md): when present, ALL three
   * roles carry an AgentChoice — partial staff objects are rejected. Absent
   * on legacy runs, which retain their original behavior. Included in the
   * approval hash through `config`.
   */
  staff?: CouncilStaff;
  /**
   * Optional launch-catalog fingerprint captured at init: the shipped
   * catalog version and policy hash. Absent on legacy runs. Included in the
   * approval hash through `config`.
   */
  execution?: ExecutionConfig;
}

/** Explicit staff choices — organiser, scribe and supervisor roles. */
export interface CouncilStaff {
  organiser: AgentChoice;
  scribe: AgentChoice;
  supervisor: AgentChoice;
}

/**
 * Launch-catalog fingerprint captured at run init. A later catalog change
 * (version/hash drift) must block launches until re-approval — policy edits
 * must not silently change an approved launch.
 */
export interface ExecutionConfig {
  /** Shipped catalog version string (src/catalog.ts CATALOG_VERSION). */
  catalogVersion: string;
  /** sha256 hex fingerprint of the shipped launch policy templates. */
  policyHash: string;
}

export interface PhaseDeadlines {
  organiserMs: number;
  independentMs: number;
  scribeNotesMs: number;
  /** Per round-stage deadline inside discussion. */
  challengeMs: number;
  responseMs: number;
  synthesisMs: number;
  /** Whole-run cap from launch to report. */
  runMs: number;
  /** Extra grace after a soft deadline before the hard rule applies. */
  graceMs: number;
}

/**
 * Explicit agent/model/permission selection for one seat. Every field is
 * approval-bound. `permissionMode` is a token the host adapter validates
 * (e.g. "bypass"); the product never picks a paid model or a looser
 * permission posture silently.
 */
export interface AgentChoice {
  /** Orca agent id, e.g. "devin", "claude", "codex". Token charset only. */
  agent: string;
  /** Explicit provider/CLI model id, e.g. "swe-2-max". No fallback allowed. */
  model: string;
  /** Optional reasoning-effort token for agents that support it. */
  effort?: string;
  /** Approved permission posture token, e.g. "bypass". */
  permissionMode: string;
  /**
   * Optional named CLI profile token (e.g. Codex `--profile`). Honored only
   * where the launch catalog documents a named-profile selector; never a
   * config-file path. Approval-bound like every other field.
   */
  profile?: string;
}

// ─── Perspectives and roster ─────────────────────────────────────────────────

export interface Perspective {
  perspectiveId: PerspectiveId;
  name: string;
  /** Structural diversity: incentives/expertise/method/blind spots, not adjectives. */
  charter: {
    incentives: string;
    expertise: string;
    method: string;
    blindSpots: string;
    reviewQuestions: string[];
  };
  tags: string[];
}

/** roster.proposed.json — organiser output. */
export interface ProposedRoster {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  /** Exactly config.requestedPerspectives entries (validated 10–25), unique ids. */
  perspectives: Perspective[];
  /** Dispatch/attempt that produced this, for provenance. */
  producedBy?: { participantId: ParticipantId; dispatchId?: DispatchId };
}

/** One approved seat: one perspective, one explicit agent choice. */
export interface SeatAssignment {
  seatId: SeatId;
  perspectiveId: PerspectiveId; // must exist in the proposed roster
  participantId: ParticipantId; // stable worker identity for the seat
  agent: AgentChoice;
}

/** roster.approved.json — the primary orchestrator's selection. */
export interface ApprovedRoster {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  /** Exactly config.participants seats; unique seat and perspective ids. */
  seats: SeatAssignment[];
}

// ─── Source snapshot ─────────────────────────────────────────────────────────

/** snapshot.json — pins the reviewed tree so citations and drift are checkable. */
export interface SourceSnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  snapshotId: SnapshotId;
  targetRoot: string;
  /** Git HEAD at snapshot time, null when the target is not a git checkout. */
  gitHead: string | null;
  takenAt: string; // ISO-8601
  /** sha256 over the sorted "path:sha256" lines — the approval/drift key. */
  headHash: string;
  /** path (posix, relative to targetRoot) → content hash. */
  files: Record<string, { sha256: string; size: number }>;
}

export interface SnapshotDrift {
  drift: boolean;
  changed: string[]; // paths that differ from the snapshot (added/removed/modified)
}

// ─── Approval ────────────────────────────────────────────────────────────────

/**
 * The canonical payload that is SHA-256 hashed into approval.hash. Any change
 * to a member invalidates the approval. This is a workflow gate/drift check,
 * not a defense against a hostile local process.
 */
export interface ApprovalBinding {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  objective: string;
  seats: SeatAssignment[];
  /**
   * Canonical sha256 of the entire ProposedRoster (see canonicalRosterHash).
   * Binds the approved charters — mandates, methods, blind spots, questions —
   * and the proposal itself: editing either invalidates the approval.
   */
  proposedRosterHash: string;
  config: CouncilConfig;
  snapshotId: SnapshotId;
  snapshotHeadHash: string;
}

/** approval.json — persisted approval record. */
export interface ApprovalRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  approvalId: ApprovalId;
  /** sha256 hex of canonicalJSON(ApprovalBinding). */
  hash: string;
  /** Who approved (e.g. "primary-orchestrator", a terminal handle, or user label). */
  approver: string;
  createdAt: string; // ISO-8601
}

// ─── Findings and evidence (worker outputs) ──────────────────────────────────

export type EvidenceKind =
  | 'code_location'
  | 'repro'
  | 'scenario'
  | 'reasoned'
  | 'speculative';

export interface Evidence {
  kind: EvidenceKind;
  /** Short explanation of what the evidence shows. */
  note: string;
  /** Safe relative path inside the target (required for code_location). */
  path?: string;
  /** 1-based inclusive line range (code_location requires startLine). */
  startLine?: number;
  endLine?: number;
  /** Optional quoted snippet, bounded length. */
  snippet?: string;
  /** kind "repro": captured reproduction steps and observed result. */
  steps?: string;
  observed?: string;
}

export type FindingKind = 'defect' | 'risk' | 'suggestion' | 'question';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** Canonical evidence grade — computed by claim validation, never trusted from a reviewer. */
export type EvidenceGrade =
  | 'verified_defect'
  | 'plausible_risk'
  | 'speculative'
  | 'unsupported';

export interface Finding {
  findingId: FindingId;
  title: string;
  kind: FindingKind;
  severity: Severity;
  /** 0..1 reviewer self-assessed confidence. */
  confidence: number;
  /**
   * Reviewer-asserted grade. UNTRUSTED INPUT: downstream claim validation
   * must re-derive `Claim.grade` via maxClaimGrade(); an asserted
   * "verified_defect" alone must never surface as an independently verified defect.
   */
  assertedGrade?: EvidenceGrade;
  evidence: Evidence[];
  counterEvidence?: Evidence[];
  remedies?: string[];
  openQuestions?: string[];
}

/**
 * Optional worker-asserted strength — a specific, useful thing that already
 * exists. Bounded and praise-is-never-required: zero strengths is a fully
 * valid file, and strengths are never routed for challenge, graded, or used
 * to upgrade certainty. `evidence` follows the exact same kind/citation
 * rules as Finding.evidence; a strength whose entire evidence list fails
 * citation validation is dropped with a journaled rejection rather than
 * admitted as bare praise.
 */
export interface Strength {
  /** Worker-minted local id ("S-1" style), unique within the file. */
  strengthId: string;
  /** The specific existing feature/behavior that works. */
  feature: string;
  /** Concrete benefit to this seat's persona/role — never generic praise. */
  benefit: string;
  /** What must not be lost in future changes — preservation guidance. */
  preserve: string;
  /** Supporting evidence, same kinds/citation rules as Finding.evidence. */
  evidence: Evidence[];
}

/**
 * Fixed per-file strength cap — a constant, not a config key, so the
 * approval binding stays byte-stable and the praise surface stays small
 * beside prioritized criticism.
 */
export const MAX_STRENGTHS_PER_FILE = 3;

/**
 * Canonical strength on the ledger/report: the worker's record plus
 * RUNNER-STAMPED provenance. Participants never stamp their own
 * participant/perspective ids — the runner assigns them at admission.
 */
export interface CanonicalStrength extends Strength {
  participantId: ParticipantId;
  perspectiveId: PerspectiveId;
}

/** findings/<participantId>.json — independent-phase reviewer output. */
export interface FindingsFile {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  participantId: ParticipantId;
  perspectiveId: PerspectiveId;
  findings: Finding[]; // <= config.maxFindingsPerSeat
  /** Optional bounded strengths — absent or [] are both valid. */
  strengths?: Strength[]; // <= MAX_STRENGTHS_PER_FILE
  notes?: string;
}

// ─── Discussion: typed challenges and author responses ───────────────────────

/** Phase a worker attempt belongs to. */
export type PhaseKind =
  | 'organiser'
  | 'independent_review'
  | 'scribe_notes'
  | 'challenge'
  | 'author_response'
  | 'scribe_synthesis';

export type ChallengeKind =
  | 'missing_evidence'
  | 'counterexample'
  | 'overstated'
  | 'duplicate'
  | 'scope'
  | 'other';

/**
 * A challenge written by a reviewer about exactly one claim.
 *
 * Identity: workers mint a LOCAL `challengeId` (e.g. "C-1"). Before routing,
 * the ledger qualifies it to `ch-r<round>-<sha256(JSON.stringify(
 * [challengerPid, localId])).slice(0,32)>` — globally unique per
 * challenger/round, so two seats' local "C-1" can never collide. On copies
 * routed to authors (ResponseAssignment.challenges) `challengeId` carries the
 * qualified id verbatim and `localChallengeId`/`challengerPid` preserve the
 * minted id and its author as provenance.
 */
export interface Challenge {
  challengeId: ChallengeId;
  claimId: ClaimId;
  kind: ChallengeKind;
  argument: string;
  evidence: Evidence[];
  /** Runner-stamped provenance: the worker-minted id before qualification. */
  localChallengeId?: string;
  /** Runner-stamped provenance: the participant that filed the challenge. */
  challengerPid?: ParticipantId;
}

/** rounds/<n>/challenges/<participantId>.json — challenger output. */
export interface ChallengesFile {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  round: number;
  participantId: ParticipantId;
  challenges: Challenge[]; // <= config.maxChallengesPerSeatPerRound
}

export type ResponseDisposition = 'defend' | 'revise' | 'withdraw' | 'escalate';

/** The finding author's response to one admitted challenge. */
export interface AuthorResponse {
  claimId: ClaimId;
  challengeId: ChallengeId;
  disposition: ResponseDisposition;
  argument: string;
  evidence: Evidence[];
  /** Required when disposition === "revise": the amended finding. */
  revisedFinding?: Finding;
}

/** rounds/<n>/responses/<participantId>.json — author output. */
export interface ResponsesFile {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  round: number;
  participantId: ParticipantId;
  responses: AuthorResponse[]; // <= config.maxResponsesPerSeatPerRound
}

// ─── Work envelopes (single-recipient worker inputs) ────────────────────────

/**
 * The only channel by which a reviewer ever sees peer output: an envelope
 * built by the runner for exactly one recipient, carrying only the assigned
 * items — never the transcript, never other reviewers' envelopes.
 */
export interface WorkEnvelope<TAssignment> {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  phase: PhaseKind;
  round: number | null;
  recipientId: ParticipantId;
  /** Bounded by the matching config cap. */
  assignments: TAssignment[];
  /**
   * Whole assignments dropped by the byte cap — the envelope self-declares
   * omissions so a bound never silently loses assigned work. Absent on
   * envelopes produced before this field existed.
   */
  omittedCount?: number;
  /** Exact file the worker must write (safe relative path inside the run dir). */
  outputPath: string;
  /** Name of the file contract to write: "ChallengesFile" | "ResponsesFile" | "FindingsFile" | "ScribeNotesFile" | "SynthesisFile" | "ReportFile" (legacy). */
  outputContract: string;
  /** Total serialized size must be <= config.envelopeBytes at dispatch. */
}

/** One challenge assignment: challenge this claim, from this question. */
export interface ChallengeAssignment {
  assignmentId: string;
  claimId: ClaimId;
  /** Sanitized claim projection — no ledger, no other claims, no transcript. */
  claim: ClaimView;
  question: string;
}

/** One author-response assignment: answer these admitted challenges to your claim. */
export interface ResponseAssignment {
  claimId: ClaimId;
  findingId: FindingId;
  claim: ClaimView;
  challenges: Challenge[];
}

export type ChallengeEnvelope = WorkEnvelope<ChallengeAssignment>;
export type ResponseEnvelope = WorkEnvelope<ResponseAssignment>;

// ─── Canonical claim ledger ──────────────────────────────────────────────────

/** Canonical claim process status (methodology-frozen enum). */
export type ClaimStatus =
  | 'proposed'
  | 'challenged'
  | 'defended'
  | 'revised'
  | 'escalated'
  | 'confirmed'
  | 'resolved'
  | 'withdrawn';

/** What a challenge envelope exposes about a claim — no history, no transcript. */
export interface ClaimView {
  claimId: ClaimId;
  title: string;
  kind: FindingKind;
  severity: Severity;
  evidence: Evidence[];
  counterEvidence: Evidence[];
}

export interface ClaimEvent {
  ts: string; // ISO-8601
  round: number | null;
  actor: ParticipantId | 'runner' | 'scribe';
  type:
    | 'admitted'
    | 'challenged'
    | 'defended'
    | 'revised'
    | 'withdrawn'
    | 'escalated'
    | 'confirmed'
    | 'resolved'
    | 'regraded'
    | 'merged';
  detail?: string;
  refId?: string; // challengeId / responseId / merged claimId
}

/** A minority position preserved against the ledger's current disposition. */
export interface DissentRecord {
  participantId: ParticipantId;
  round: number | null;
  position: string; // bounded text
  ts: string;
  /**
   * Challenger-authored evidence behind this position, already validated
   * against the snapshot by the ledger fold. Absent when the dissenter filed
   * none; never carries unvalidated items. Added after the run's first
   * reports — legacy records lack it.
   */
  evidence?: Evidence[];
  /**
   * The QUALIFIED challenge id (`ch-r<round>-<32hex>`) this dissent record
   * was created by, letting a consumer join a position to its lifecycle
   * without replaying claim history. Absent on merge-time rating-divergence
   * dissent (which has no challenge) and on legacy records.
   */
  challengeId?: ChallengeId;
}

/**
 * One admitted challenge's lifecycle on its claim — qualified identity only.
 *
 * `answered` records only that an admitted author response referenced this
 * challenge — a fact, never a verdict. ANSWERED IS NOT RESOLVED: a 'defend'
 * reply keeps the disagreement live, a 'revise'/'withdraw' adopts or moots
 * it without proving either side right, and 'escalate' hands it to the
 * orchestrator. No disposition erases the dissent record or upgrades
 * certainty — votes and revisions never establish truth.
 */
export interface ClaimChallenge {
  /** Globally unique qualified id assigned by the ledger before routing. */
  challengeId: ChallengeId;
  round: number;
  challengerPid: ParticipantId;
  kind: ChallengeKind;
  /** True once an admitted author response referenced this challenge. */
  answered: boolean;
  /** Present once answered: which author responded and how. */
  response?: {
    participantId: ParticipantId;
    disposition: ResponseDisposition;
  };
}

/**
 * One source finding's author assessment — the rating that participant filed.
 * Kept on merged claims so the canonical severity/confidence never hides the
 * spread of individual votes.
 */
export interface ClaimAssessment {
  participantId: ParticipantId;
  findingId: FindingId;
  severity: Severity;
  confidence: number;
}

/**
 * Canonical claim — the unit the ledger, report and scribe work from.
 *
 * Merge/aggregation policy (documented, deterministic):
 * - Findings dedupe only when kind + normalized title match AND their
 *   VERIFIED citation ranges overlap on the same path (or both hold no
 *   verified citation). A shared file alone is not identity — same title on
 *   different lines of one file stays two claims, and rejected evidence
 *   never drives a merge. Conservative: a false non-merge is recoverable by
 *   the scribe, a false merge is not.
 * - The canonical title/kind/severity/confidence come from the first
 *   (participantId, findingId)-sorted finding; every other author's rating is
 *   preserved verbatim in `assessments`, in `mergedTitles`, and — when it
 *   diverges — as a dissent line. Nothing is averaged away.
 * - `remedies`/`openQuestions` are the deduped union across merged findings
 *   (bounded; overflow is journaled on the claim history, never silent).
 */
export interface Claim {
  claimId: ClaimId;
  title: string;
  kind: FindingKind;
  /** Derived grade — see maxClaimGrade; never taken from a reviewer assertion. */
  grade: EvidenceGrade;
  status: ClaimStatus;
  severity: Severity;
  confidence: number;
  evidence: Evidence[];
  counterEvidence: Evidence[];
  /** Provenance: every reviewer finding merged into this claim. */
  sourceFindings: { participantId: ParticipantId; findingId: FindingId }[];
  history: ClaimEvent[];
  dissent: DissentRecord[];
  /** Deduped union of reviewer-proposed remedies from merged findings. */
  remedies?: string[];
  /** Deduped union of reviewer open questions from merged findings. */
  openQuestions?: string[];
  /** Per-source-finding author ratings — one entry per finding ever folded in. */
  assessments?: ClaimAssessment[];
  /** Source-finding titles that differ from the canonical title (deduped). */
  mergedTitles?: string[];
  /**
   * Admitted challenges filed against this claim, by qualified id, with
   * answered/unanswered linkage — so retained dissent can be told apart
   * from genuinely unanswered disputes without replaying history.
   * Absent on ledgers built before discussion accounting existed.
   */
  challenges?: ClaimChallenge[];
  /**
   * The deterministic dedupe key (kind|normalized title) this claim was
   * merged under — emitted so downstream consumers can correlate the same
   * defect across reruns without reimplementing normalization.
   */
  dedupeKey?: string;
  /**
   * Count of evidence items (across findings/challenges/responses folded
   * into this claim) that FAILED citation validation. Distinguishes
   * 'unsupported because nothing was filed' from 'unsupported because
   * citations were rejected' — provenance for triage, never a grade input.
   */
  rejectedEvidence?: number;
}

/** What happened to claims at challenge-routing time for one round. */
export interface ChallengeRoutingRecord {
  /** Claim ids placed into at least one built challenge envelope. */
  routedClaimIds: ClaimId[];
  /**
   * Assigned claims dropped from every envelope by the byte cap — distinct
   * from `unassigned`, which never got a challenger at all.
   */
  byteDroppedClaimIds: ClaimId[];
  /** Claims never assigned: reason distinguishes no-eligible vs at-cap. */
  unassigned: { claimId: ClaimId; reason: string }[];
}

/** What happened to challenges at response-routing time for one round. */
export interface ResponseRoutingRecord {
  /** Qualified challenge ids routed into at least one response envelope. */
  routedChallengeIds: ChallengeId[];
  /** Whole response assignments dropped by the byte cap (claim-level). */
  byteDropped: { claimId: ClaimId; authorPid: ParticipantId }[];
  /** Challenges dropped because the author was already at cap. */
  capOmitted: { challengeId: ChallengeId; claimId: ClaimId; authorPid: ParticipantId }[];
  /** Admitted challenges with no routable author. */
  unroutable: { challengeId: ChallengeId; claimId: ClaimId; reason: string }[];
}

/** Per-round routing records — the durable home of routed-vs-never-routed. */
export interface RoundRoutingRecord {
  round: number;
  challenges: ChallengeRoutingRecord;
  /** Stamped when the round's response envelopes were built. */
  responses?: ResponseRoutingRecord;
}

/**
 * claims.json — the ledger artifact.
 *
 * `discussion` holds the runner-stamped routing records that let a report
 * separate routed/examined claims from never-routed ones and byte-cap drops
 * from plan-level unassigned — counts the journal alone could only
 * approximate. `strengths` are canonical, runner-provenanced and never
 * challenged or graded. Both optional: legacy ledgers lack them.
 */
export interface ClaimLedger {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  claims: Claim[];
  /** claimId → participantIds who authored a source finding (dedupe key support). */
  provenance: Record<ClaimId, ParticipantId[]>;
  /** Canonical strengths collected from admitted findings, runner-provenanced. */
  strengths?: CanonicalStrength[];
  /** Per-round routing records for discussion accounting. */
  discussion?: { rounds: RoundRoutingRecord[] };
}

// ─── Scribe artifacts ────────────────────────────────────────────────────────

/** scribe-notes.json — initial scribe pass over admitted independent findings. */
export interface ScribeNotesFile {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  participantId: ParticipantId;
  claimSummaries: {
    claimId: ClaimId;
    summary: string;
    possibleDuplicates: ClaimId[];
    openQuestions: string[];
  }[];
  observations?: string;
}

/**
 * scribe/report.json — the scribe's NARRATIVE-ONLY synthesis contract.
 * The runner canonicalises claims/coverage and renders report.md/summary.md
 * deterministically; the scribe contributes only what it actually authored:
 * a summary and limitation notes. (Legacy artifacts that carried a full
 * CouncilReport are still accepted by parseReportFile — the engine falls
 * back to it when this parser rejects the file.)
 */
export interface SynthesisFile {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  participantId: ParticipantId;
  generatedAt?: string; // ISO-8601
  summary: string;
  limitations: string[];
}

// ─── Final report ────────────────────────────────────────────────────────────

export interface SeatOutcome {
  participantId: ParticipantId;
  perspectiveId: PerspectiveId;
  seatId: SeatId;
  outcome: 'completed' | 'partial' | 'failed' | 'timed_out' | 'not_launched';
  phasesCompleted: PhaseKind[];
  detail?: string;
}

export interface ReportCoverage {
  requestedPerspectives: number;
  proposedPerspectives: number;
  selectedSeats: number;
  seats: SeatOutcome[];
  /** Proposed perspectives that received no completed review. */
  uncoveredPerspectiveIds: PerspectiveId[];
  /** True when any selected seat did not complete — must be visibly marked. */
  partial: boolean;
}

/**
 * Deterministic facts the runner computes from the ledger and participant
 * state — never scribe-authored. Rendered prominently beside (never merged
 * into) the scribe narrative so partial coverage and unresolved disputes are
 * structurally impossible to hide behind prose.
 */
export interface RunnerFacts {
  seatsCompleted: number;
  seatsSelected: number;
  partialCoverage: boolean;
  uncoveredPerspectiveIds: PerspectiveId[];
  /** Whether the narrative summary is scribe-authored or the deterministic fallback. */
  summarySource: 'scribe' | 'runner';
  claims: {
    total: number;
    /** status → count, only statuses actually present. */
    byStatus: Record<string, number>;
    /**
     * Claims carrying at least one dissent record — RETAINED dissent
     * including answered challenges (an answer never erases the record).
     */
    withDissent: ClaimId[];
    /**
     * Claims with at least one genuinely UNANSWERED admitted challenge —
     * the honest open-dispute subset withDissent used to conflate. Optional:
     * absent on runner-facts blocks computed before discussion accounting.
     */
    unansweredChallenges?: ClaimId[];
    withdrawn: number;
    escalated: number;
  };
  /** Canonical strengths admitted this run (0 is valid — no praise quota). */
  strengths?: number;
  /**
   * Per-round discussion accounting derived from the ledger's routing
   * records: filed/answered/unanswered challenges plus the
   * routed / routed-no-challenge / never-routed claim split. Absent when
   * the ledger carries no routing records (legacy or pre-discussion report).
   */
  discussion?: DiscussionRoundFacts[];
}

/** Discussion accounting for one round — counts, never verdicts. */
export interface DiscussionRoundFacts {
  round: number;
  /** Admitted challenges filed this round. */
  challengesFiled: number;
  /** Challenges that received an admitted author response. */
  challengesAnswered: number;
  /** Admitted challenges no response ever resolved. */
  challengesUnanswered: number;
  /** Claims placed into at least one challenge envelope. */
  claimsRouted: number;
  /** Routed claims no challenge was filed against (examined, declined). */
  claimsRoutedNoChallenge: number;
  /** Claims never routed: unassigned ∪ byte-dropped. */
  claimsNeverRouted: number;
  /** …of which: no eligible challenger (self-authored/at-cap plan-level). */
  claimsUnassigned: number;
  /** …of which: assigned but dropped by the envelope byte cap. */
  claimsByteDropped: number;
  /** Challenge→author response routing outcomes for the round. */
  responsesRouted: number;
  responsesByteDropped: number;
  responsesCapOmitted: number;
  responsesUnroutable: number;
}

/** A report limitation with its origin — runner-derived or scribe-authored. */
export interface LimitationSource {
  origin: 'runner' | 'scribe';
  text: string;
}

/**
 * What was reviewed — binds the exported report to the exact source it
 * covers so citations keep meaning once the artifact leaves the run dir.
 */
export interface ReportProvenance {
  snapshotId: SnapshotId;
  /** Git HEAD at snapshot time, or null on non-git targets. */
  gitHead: string | null;
  targetRoot: string;
  objective: string;
}

/** report.json — canonical runner-built report (narrative may be scribe-authored). */
export interface CouncilReport {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  generatedAt: string;
  /** What was reviewed — absent on legacy reports. */
  provenance?: ReportProvenance;
  summary: string;
  coverage: ReportCoverage;
  claims: Claim[];
  limitations: string[];
  /**
   * Deterministic runner-computed facts disclosed beside the narrative.
   * Absent on reports produced before this field existed (legacy loads).
   */
  runnerFacts?: RunnerFacts;
  /**
   * Canonical strengths admitted this run — concrete persona benefits with
   * preservation guidance, rendered below prioritized criticism. Absent on
   * legacy reports and never a substitute for findings.
   */
  strengths?: CanonicalStrength[];
  /**
   * Provenance-tagged limitations in emission order (runner first). When
   * present, renderers should prefer it over the flat `limitations` list so
   * scribe-authored notes stay distinguishable from runner-derived ones.
   */
  limitationSources?: LimitationSource[];
  /**
   * A wholly failed review must not produce a successful signal: engine emits
   * no report.json at all on hard failure; any report with coverage.partial
   * is visibly partial.
   */
}

// ─── Participants, attempts, state ───────────────────────────────────────────

export type AttemptStatus =
  | 'planned'
  | 'intent_recorded' // launch intent persisted before mutation
  | 'dispatched'
  | 'working'
  | 'settled_ok'
  | 'settled_failed'
  | 'unknown' // launch/observation outcome uncertain — reconcile, never relaunch
  | 'timed_out'
  | 'stopped';

/** One supervised worker attempt for one (participant, phase, round). */
export interface PhaseAttempt {
  attemptId: AttemptId;
  participantId: ParticipantId;
  phase: PhaseKind;
  /** Discussion round for challenge/author_response, else null. */
  round: number | null;
  /** Fresh orchestration Task for EVERY phase, even on a retained session. */
  taskId: TaskId | null;
  dispatchId: DispatchId | null;
  terminalHandle: TerminalHandle | null;
  /** Persisted intent id + host request id for uncertain-outcome recovery. */
  launchIntentId: string;
  requestId?: string;
  status: AttemptStatus;
  createdAt: string;
  settledAt?: string;
  /** Artifact paths the attempt produced (validated before admission). */
  artifacts: string[];
}

export type ParticipantStatus =
  | 'planned'
  | 'active'
  | 'settled'
  | 'failed'
  | 'timed_out'
  | 'stopped';

export type ParticipantRole = 'organiser' | 'reviewer' | 'scribe';

export interface Participant {
  participantId: ParticipantId;
  role: ParticipantRole;
  /** Reviewer seats bind a perspective; organiser/scribe use fixed role ids. */
  seatId: SeatId | null;
  perspectiveId: PerspectiveId | null;
  agent: AgentChoice;
  /**
   * Terminal kept open across phases so a later phase launches a FRESH Task on
   * the same agent session (documented retained-session reuse). Null until the
   * first launch with retainTerminal.
   */
  retainedTerminal: TerminalHandle | null;
  attempts: PhaseAttempt[];
  status: ParticipantStatus;
}

export type DiscussionStage = 'challenges' | 'responses';

export interface DiscussionCursor {
  round: number; // 1..config.rounds
  stage: DiscussionStage;
}

/** Run lifecycle status. Engine owns all transitions; illegal ones are refused. */
export type RunStatus =
  | 'initialized'
  | 'organising'
  | 'awaiting_approval'
  | 'independent_review'
  | 'scribe_notes'
  | 'discussing'
  | 'synthesising'
  | 'reported'
  | 'failed'
  | 'cancelled';

/** state.json — durable run state. */
export interface CouncilState {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: CouncilRunId;
  orcaRunId: OrcaRunId | null;
  status: RunStatus;
  targetRoot: string;
  objective: string;
  config: CouncilConfig;
  snapshotId: SnapshotId | null;
  approvalHash: string | null;
  participants: Participant[];
  discussion: DiscussionCursor | null;
  /**
   * The council supervisor worker's durable identity, so an external
   * `council approve` (run by the primary orchestrator) can send it an exact
   * wake notification — writing approval files alone does not wake the agent.
   */
  supervisor: {
    terminalHandle: TerminalHandle;
    dispatchId: DispatchId | null;
  } | null;
  consumption: {
    launches: number;
    mailSent: number;
  };
  phaseEnteredAt: string; // ISO-8601 — deadline checks are evaluated on advance
  createdAt: string;
}

// ─── Journal ─────────────────────────────────────────────────────────────────

export type JournalEventType =
  | 'run.initialized'
  | 'phase.entered'
  | 'barrier.refused'
  | 'task.created'
  | 'launch.intent'
  | 'launch.resume'
  | 'worker.started'
  | 'worker.settled'
  | 'worker.unknown'
  | 'worker.timed_out'
  | 'worker.stop_requested'
  | 'worker.stopped'
  | 'worker.released'
  | 'mail.sent'
  | 'mail.observed'
  | 'roster.proposed'
  | 'approval.granted'
  | 'approval.invalidated'
  | 'artifact.written'
  | 'artifact.admitted'
  | 'artifact.rejected'
  | 'envelope.built'
  | 'deadline.hit'
  | 'snapshot.drift'
  | 'claim.updated'
  | 'report.written'
  | 'supervisor.retired'
  | 'launch.submit_check'
  | 'launch.submit_nudge'
  | 'launch.submit_unconfirmed'
  | 'terminal.close'
  | 'error'
  | 'run.finished';

export interface JournalEvent {
  seq: number;
  ts: string; // ISO-8601
  type: JournalEventType;
  actor: string; // participantId | 'engine' | 'orchestrator' | 'store'
  phase?: PhaseKind;
  round?: number;
  participantId?: ParticipantId;
  payload?: Record<string, unknown>;
  /** sha256 of the previous event's canonical form — cheap tamper evidence. */
  prevHash?: string;
}

// ─── HostAdapter (implemented by src/host/orca.ts) ──────────────────────────

/**
 * Journal-before intent recorded BEFORE a terminal-create host call, so a
 * pre-attach resource is visible to recovery even when the create's outcome
 * or returned identity is lost. The intent id is the durable join key —
 * derived from the launch requestKey, never carried on argv.
 */
export interface TerminalCreateIntent {
  /** Durable local id derived from the launch requestKey — never on argv. */
  intentId: string;
  /** Optional link back to the participant the terminal will serve. */
  participantId?: ParticipantId;
  taskId: TaskId;
  runId: OrcaRunId;
  worktree: string;
  title: string;
  /** Exact validated --command text — forensic journal evidence. */
  command: string;
  /** Optional — the engine's journal ts is authoritative; adapter won't mint. */
  createdAt?: string;
}

/**
 * After-create custody record: the identity the host returned for a prior
 * intent. `refused` is a definite no-effects answer; `uncertain` means the
 * outcome cannot be resolved and NEVER authorizes a repeat create —
 * ambiguity stays visible for reconciliation, it does not license another
 * mutation.
 */
export interface TerminalCreateReceipt {
  /** Matches the journaled TerminalCreateIntent. */
  intentId: string;
  taskId: TaskId;
  outcome: 'created' | 'refused' | 'uncertain';
  terminalHandle?: TerminalHandle;
  /** Host envelope request/operation id — never a --retry-request value. */
  requestId?: string;
  detail?: string;
  /** Optional — the engine's journal ts is authoritative; adapter won't mint. */
  observedAt?: string;
  /**
   * True when the adapter promises to invoke `beforeWorkerStart` (and wait
   * for it to persist) before any worker-start onto this terminal. Only then
   * does a missing worker-start marker prove no dispatch was issued.
   */
  dispatchMarker?: boolean;
}

/**
 * Marker the adapter hands to `beforeWorkerStart` immediately before it
 * issues worker-start onto a terminal THIS launch created.
 */
export interface WorkerStartMarker {
  /** Durable local id derived from the launch requestKey — never on argv. */
  intentId: string;
  taskId: TaskId;
  terminalHandle: TerminalHandle;
  observedAt?: string;
}

/**
 * Custody callbacks the engine supplies on WorkerLaunchSpec.custody and the
 * adapter MUST invoke around every terminal create:
 * `beforeTerminalCreate` persists the intent — a non-ok result aborts
 * BEFORE any mutation; `afterTerminalCreate` records the returned
 * identity/uncertainty — a non-ok result stops all further mutation with
 * outcome 'uncertain' rather than losing custody of a live terminal.
 * `beforeWorkerStart` (optional) persists the dispatch marker — a non-ok
 * result aborts BEFORE worker-start, so the terminal provably has no worker.
 */
export interface TerminalCustodyHooks {
  beforeTerminalCreate(intent: TerminalCreateIntent): Promise<Result<void>>;
  afterTerminalCreate(receipt: TerminalCreateReceipt): Promise<Result<void>>;
  beforeWorkerStart?(marker: WorkerStartMarker): Promise<Result<void>>;
}

/**
 * Boundary to the host execution environment (Orca on v1). Implementations use
 * documented CLI commands only and must NEVER run a consuming `check`/`--ack` —
 * the caller agent owns its own mail. Observation is by worker records and
 * bounded `inbox`/artifact reads.
 *
 * Every mutation returns durable ids and honest outcomes: an uncertain result
 * is `outcome: "unknown"` with the retained request/operation id, never a
 * silent duplicate launch.
 */
export interface WorkerLaunchSpec {
  participantId: ParticipantId;
  phase: PhaseKind;
  round: number | null;
  /** Council child Run the worker is launched under — explicit, never inferred
   *  from the caller's current binding (which may be lost on resume). */
  runId: OrcaRunId;
  /** orchestration Task id this attempt launches under (fresh per phase). */
  taskId: TaskId;
  /** Absolute path to the generated spec file for --spec-file. */
  specFilePath: string;
  taskTitle: string;
  worktree: string; // selector, e.g. "current"
  agent: AgentChoice;
  /** Keep the terminal open so later phases reuse the session (fresh Task each). */
  retainTerminal: boolean;
  /** Reuse this retained terminal for the new Task instead of a new agent launch. */
  reuseTerminal?: TerminalHandle;
  /**
   * Terminal-create custody callbacks (see TerminalCustodyHooks). The
   * adapter invokes them around any terminal create this launch performs —
   * absent on legacy launches, which keep their prior behavior.
   */
  custody?: TerminalCustodyHooks;
}

export type LaunchOutcome = 'started' | 'failed' | 'unknown';

export interface LaunchResult {
  outcome: LaunchOutcome;
  taskId?: TaskId;
  dispatchId?: DispatchId;
  terminalHandle?: TerminalHandle;
  /** Retry-request / operation id retained for uncertain-outcome recovery. */
  requestId?: string;
  detail?: string;
  /**
   * Turn-start evidence from the worker-start receipt: 'observed' when the
   * host proved the agent's turn began; otherwise the host's own value
   * (e.g. 'unsupported'). Absent when the receipt carries no such field.
   */
  turnStart?: string;
  /**
   * On a failed/unknown launch: false only when the adapter PROVES it never
   * issued worker-start (it returned before that mutation). Absent means
   * worker-start may have been issued.
   */
  workerStartIssued?: boolean;
  /** True when THIS launch created the terminal it returns (argv lane). */
  terminalCreated?: boolean;
  /** Adapter stage that stopped a failed/unknown launch, when known. */
  failedStage?: string;
}

/** Result of closing one exact terminal through the documented host CLI. */
export interface TerminalCloseResult {
  outcome: 'closed' | 'already_gone' | 'failed';
  /** Host error/observation code (e.g. terminal_handle_stale). */
  code?: string;
  detail?: string;
  requestId?: string;
}

/** One recorded terminal in a cleanup pass. */
export interface TerminalCleanupEntry {
  terminalHandle: TerminalHandle;
  owner: 'participant' | 'supervisor';
  participantId?: ParticipantId;
  outcome: 'closed' | 'already_gone' | 'skipped' | 'failed';
  reason?: string;
  code?: string;
  /** A prior close intent had no receipt; this pass retried it. */
  retriedIntent?: boolean;
}

export interface TerminalCleanupReport {
  status: RunStatus;
  terminals: TerminalCleanupEntry[];
}

/** Supervisor custody proven by the CLI's startup record (start-supervisor). */
export interface SupervisorCleanupCustody {
  terminalHandle: TerminalHandle;
  dispatchId: DispatchId | null;
  /** startup.json status, e.g. 'attached' | 'paused' | 'terminal_created'. */
  startupStatus: string;
  /** startup.json paused.code when paused (e.g. 'agent_not_ready', 'terminal_owned'). */
  pausedCode?: string;
}

/** Outcome of the bounded first-turn submission check. */
export type SubmissionCheckState = 'started' | 'unsubmitted' | 'inconclusive';

export interface SubmissionCheck {
  state: SubmissionCheckState;
  /** Short machine-readable evidence class, e.g. 'input_holds_brief_idle'. */
  evidence: string;
  samples: number;
  elapsedMs: number;
  /** Bounded copy of the last observed signals (never trusted as proof alone). */
  signals?: Record<string, unknown>;
}

export interface SubmitInputResult {
  outcome: 'sent' | 'unknown' | 'refused';
  requestId?: string;
  detail?: string;
}

/**
 * Tolerant host-listing rows for crash-resume reconciliation. The adapter
 * maps whatever the host CLI returns into these shapes; unknown fields are
 * preserved, never required.
 */
export interface TaskListRow {
  taskId?: string;
  id?: string;
  specFile?: string;
  specFilePath?: string;
  title?: string;
  taskTitle?: string;
  spec?: string;
  [k: string]: unknown;
}

export interface WorkerListRow {
  dispatchId: string;
  taskId?: string;
  state?: string;
  outcome?: string;
  liveness?: string;
  terminal?: string;
  terminalHandle?: string;
  [k: string]: unknown;
}

/** Observed state of a previously recorded launch request id. */
export type LaunchRequestState = 'completed' | 'pending' | 'absent' | 'unknown';

export type WorkerLiveness =
  | 'working'
  | 'waiting_human' // parked on a prompt only a human can answer — healthy, not failed
  | 'idle'
  | 'finished'
  | 'unverifiable';

export interface WorkerObservation {
  dispatchId: DispatchId;
  taskStatus?: string;
  terminalState?:
    | 'active'
    | 'reclaimable'
    | 'retained'
    | 'release_pending'
    | 'release_unknown'
    | 'released';
  liveness: WorkerLiveness;
  detail?: string;
}

export type StopOutcome = 'stopped' | 'unknown' | 'refused';

export interface HostAdapter {
  /** Create and bind the council child Run under the caller's identity. */
  createRun(input: { objective: string }): Promise<Result<{ runId: OrcaRunId; requestId?: string }>>;
  /** Create one orchestration Task in the council Run (fresh Task per phase). */
  createTask(input: {
    runId: OrcaRunId;
    specFilePath: string;
    title: string;
    deps?: TaskId[];
  }): Promise<Result<{ taskId: TaskId; requestId?: string }>>;
  /** Start one supervised worker attempt. See WorkerLaunchSpec docs. */
  launchWorker(input: WorkerLaunchSpec): Promise<Result<LaunchResult>>;
  /** Observe one dispatch without consuming mail. */
  observeWorker(input: { dispatchId: DispatchId }): Promise<Result<WorkerObservation>>;
  /** Send one bounded notification (doorbell only — content lives in artifacts). */
  sendNotification(input: {
    to: string; // "dispatch:<id>" | "run:<id>" | explicit handle
    subject: string;
    body: string;
    taskId?: TaskId;
    dispatchId?: DispatchId;
  }): Promise<
    Result<{
      outcome: 'sent' | 'unknown';
      requestId?: string;
      messageId?: MessageId;
      /** Host error code carried on an 'unknown' receipt. */
      errorCode?: string;
      /** Bounded host error message carried on an 'unknown' receipt. */
      error?: string;
    }>
  >;
  /** Guarded stop — only for explicit cancellation per the recovery reference. */
  requestStop(input: { dispatchId: DispatchId; reason: string }): Promise<Result<{ outcome: StopOutcome }>>;
  /**
   * Release a settled/reclaimable worker terminal (e.g. end of retained
   * session). `state` echoes the host's receipt state (e.g. 'retained').
   */
  releaseWorker(input: { dispatchId: DispatchId }): Promise<Result<{ released: boolean; state?: string }>>;
  /**
   * OPTIONAL: close one exact terminal (`terminal close --terminal`). The
   * engine calls it only for terminals the run itself created and journaled.
   */
  closeTerminal?(input: { terminalHandle: TerminalHandle }): Promise<Result<TerminalCloseResult>>;
  /**
   * OPTIONAL crash-resume reconciliation: observe the state of a previously
   * recorded request id WITHOUT mutating anything. `absent` means the host
   * has no record of it. Never used to authorize a blind relaunch.
   */
  requestShow?(input: { requestId: string }): Promise<Result<{ state: LaunchRequestState; raw: unknown }>>;
  /** OPTIONAL crash-resume reconciliation: list the host's task records for a Run. */
  listTasks?(input: { runId: OrcaRunId }): Promise<Result<{ tasks: TaskListRow[] }>>;
  /** OPTIONAL crash-resume reconciliation: list the host's worker records for a Run. */
  listWorkers?(input: { runId: OrcaRunId }): Promise<Result<{ workers: WorkerListRow[] }>>;
  /**
   * OPTIONAL bounded first-turn submission check, read-only: classifies a
   * freshly dispatched terminal as started / unsubmitted / inconclusive.
   */
  probeSubmission?(input: {
    terminalHandle: TerminalHandle;
    dispatchId?: DispatchId;
  }): Promise<Result<SubmissionCheck>>;
  /**
   * OPTIONAL: send exactly one bare Enter (no text) to submit a dispatched
   * prompt the host pasted but never submitted. Never resends content.
   */
  submitPendingInput?(input: { terminalHandle: TerminalHandle }): Promise<Result<SubmitInputResult>>;
}

// ─── Store (implemented by src/store.ts, backed by src/snapshot.ts) ─────────

/** Options for openRun/createRun — the run directory is the unit of durability. */
export interface StoreOpenOptions {
  /** Directory holding the run (…/.council/runs/<crun_id>). */
  runDir: string;
}

/**
 * Durable artifact + state store for one council run. All writes are atomic;
 * journal is append-only; mutations go through withLock. Errors are
 * machine-readable Result values, not throws.
 */
export interface Store {
  readonly runDir: string;

  /** Create the run directory with council.json, state.json, empty journal. */
  initialize(input: {
    runId: CouncilRunId;
    targetRoot: string;
    objective: string;
    config: CouncilConfig;
    snapshot: SourceSnapshot;
  }): Promise<Result<void>>;

  loadState(): Promise<Result<CouncilState>>;
  saveState(state: CouncilState): Promise<Result<void>>;

  /** Serialize a state mutation against other advance calls. */
  withLock<T>(fn: () => Promise<Result<T>>): Promise<Result<T>>;

  /** Atomic artifact IO. Paths are safe-relative inside the run dir. */
  writeArtifact(relPath: string, data: string | Uint8Array): Promise<Result<void>>;
  readArtifact(relPath: string): Promise<Result<string>>;
  artifactExists(relPath: string): Promise<Result<boolean>>;
  listArtifacts(prefix: string): Promise<Result<string[]>>;

  /** Journal append/read. seq is assigned in stored order. */
  appendJournal(events: Omit<JournalEvent, 'seq'>[]): Promise<Result<JournalEvent[]>>;
  readJournal(): Promise<Result<JournalEvent[]>>;

  /** Persist roster.proposed / roster.approved (validated upstream). */
  writeProposedRoster(roster: ProposedRoster): Promise<Result<void>>;
  readProposedRoster(): Promise<Result<ProposedRoster>>;
  writeApprovedRoster(roster: ApprovedRoster): Promise<Result<void>>;
  readApprovedRoster(): Promise<Result<ApprovedRoster>>;

  /** Persist an approval bound to the given payload; returns its hash. */
  writeApproval(record: ApprovalRecord, binding: ApprovalBinding): Promise<Result<void>>;
  readApproval(): Promise<Result<{ record: ApprovalRecord; binding: ApprovalBinding }>>;

  /** Source snapshot persistence + drift check against the live target. */
  readSnapshot(): Promise<Result<SourceSnapshot>>;
  verifySourceSnapshot(): Promise<Result<SnapshotDrift>>;
}

/**
 * Factory signature. Implemented and exported from `src/store.ts` (storage
 * developer): `export function createStore(options: StoreOpenOptions): Store`.
 */
export type CreateStore = (options: StoreOpenOptions) => Store;

// ─── PromptBuilder (implemented by src/prompts.ts) ──────────────────────────

export interface PromptContext {
  runId: CouncilRunId;
  /** Absolute path of the run directory (for exact artifact paths in specs). */
  runDir: string;
  targetRoot: string;
  objective: string;
  snapshotId: SnapshotId;
  config: CouncilConfig;
}

/**
 * Corrective-attempt context the engine hands a builder when a worker's
 * output was rejected and is being retried once. `diagnostics` are exact
 * validation issues (untrusted validator data — delimited, bounded, never
 * instructions); `previousArtifactPath` is the archived rejected output the
 * worker may inspect. Absent on first attempts.
 */
export interface RepairContext {
  /** Name of the output contract the worker must satisfy. */
  contract: string;
  /** Exact validation diagnostics from the rejection (bounded strings). */
  diagnostics: string[];
  /** Archived path of the rejected artifact, when preserved. */
  previousArtifactPath?: string;
}

/**
 * Spec-file builders. Each returns the full markdown spec for one worker and
 * names the exact writable output paths, the JSON output contract, budgets,
 * and the untrusted-content boundary (target/peer text is data, never
 * instructions; no further agents; edits forbidden).
 *
 * Every worker `input` may carry an optional `repair` — the corrective-attempt
 * context above. Builders must render it as untrusted validator data.
 */
export interface PromptBuilder {
  /** Organiser worker: propose config.requestedPerspectives perspectives. */
  organiser(
    ctx: PromptContext,
    input: { participantId: ParticipantId; outputPath: string; repair?: RepairContext },
  ): string;
  /** Independent reviewer: must NEVER receive peer findings or envelopes. */
  reviewerIndependent(
    ctx: PromptContext,
    input: {
      participantId: ParticipantId;
      perspective: Perspective;
      outputPath: string;
      repair?: RepairContext;
    },
  ): string;
  /** Initial scribe pass over admitted independent findings. */
  scribeNotes(
    ctx: PromptContext,
    input: {
      participantId: ParticipantId;
      admittedFindingsPaths: string[];
      outputPath: string;
      repair?: RepairContext;
    },
  ): string;
  /** Challenger: sees only the claims inside its own envelope. */
  challenge(
    ctx: PromptContext,
    input: {
      participantId: ParticipantId;
      envelopePath: string;
      outputPath: string;
      repair?: RepairContext;
    },
  ): string;
  /** Finding author: sees only challenges admitted against its own claims. */
  authorResponse(
    ctx: PromptContext,
    input: {
      participantId: ParticipantId;
      envelopePath: string;
      outputPath: string;
      repair?: RepairContext;
    },
  ): string;
  /**
   * Final scribe synthesis into scribe/report.json (SynthesisFile narrative).
   * `notesPath` points at the admitted scribe/notes.json when one exists —
   * the scribe's own earlier observations, never authoritative claims.
   */
  scribeSynthesis(
    ctx: PromptContext,
    input: {
      participantId: ParticipantId;
      ledgerPath: string;
      journalPath: string;
      reportJsonPath: string;
      reportMdPath: string;
      summaryPath: string;
      notesPath?: string;
      repair?: RepairContext;
    },
  ): string;
  /** Supervisor agent spec: drive `council supervise --advance`, end turn on wait. */
  supervisor(ctx: PromptContext, input: { advanceCommand: string }): string;
}

/**
 * Factory signature. Implemented and exported from `src/prompts.ts` (prompt
 * developer): `export function createPromptBuilder(): PromptBuilder`.
 */
export type CreatePromptBuilder = () => PromptBuilder;

// ─── Engine (implemented by src/engine.ts) ──────────────────────────────────

/**
 * Machine-readable result of one advance step — the supervisor prints this.
 *
 * `progress` means the step completed internal work and there may be more to
 * do without any external event: the caller MAY invoke advance() again in the
 * same turn (bounded — e.g. cap consecutive progress calls and stop on the
 * first non-progress action). A caller that only advances once per wake can
 * deadlock purely internal transitions.
 */
export interface AdvanceResult {
  action: 'wait' | 'needs_approval' | 'progress' | 'finished' | 'blocked';
  status: RunStatus;
  /** Human/agent-facing note, e.g. what to do next or why it is blocked. */
  note?: string;
  /** Newly relevant artifact paths produced/admitted this step. */
  artifacts?: string[];
  /** Terminal outcome when action === "finished". */
  outcome?: 'succeeded' | 'failed' | 'cancelled';
  /** Report artifact paths when finished successfully. */
  reportPaths?: string[];
}

export interface EngineStatus {
  status: RunStatus;
  discussion: DiscussionCursor | null;
  participants: {
    participantId: ParticipantId;
    role: ParticipantRole;
    status: ParticipantStatus;
    activeAttempt: AttemptId | null;
    /** Detail of the active attempt when one exists — additive, diagnostic. */
    activeAttemptDetail?: {
      attemptId: AttemptId;
      phase: PhaseKind;
      round: number | null;
      status: AttemptStatus;
      taskId: TaskId | null;
      dispatchId: DispatchId | null;
      terminalHandle: TerminalHandle | null;
      requestId?: string;
    };
  }[];
  consumption: { launches: number; mailSent: number };
  approvalHash: string | null;
  pendingDecisions: string[]; // e.g. "approve roster via: council approve --run <dir>"
  /**
   * Read-only timing facts for the current phase (evaluated at status call
   * time — never fabricated liveness). Deadline fields absent when the phase
   * has no configured bound.
   */
  phaseTiming?: {
    enteredAt: string;
    elapsedMs: number;
    deadlineMs?: number;
    graceMs?: number;
    remainingMs?: number;
  };
  /** Whole-run timing facts from state.createdAt + deadlines.runMs. */
  runTiming?: {
    createdAt: string;
    elapsedMs: number;
    deadlineMs?: number;
    remainingMs?: number;
  };
  /** Newest journal event as an activity marker — a fact, not a heartbeat. */
  lastActivity?: { ts: string; seq: number; type?: JournalEventType };
  /** Recorded supervisor identity echo, when bound. */
  supervisor?: { terminalHandle: TerminalHandle; dispatchId: DispatchId | null } | null;
}

export interface Engine {
  /**
   * One bounded reconciliation step: ingest observed worker outcomes, validate
   * and admit new artifacts, enforce barriers/budgets/deadlines, launch due
   * work, and persist everything. Idempotent — safe to call on every wake and
   * to re-run after a crash.
   */
  advance(): Promise<Result<AdvanceResult>>;
  /** Record the orchestrator's approval of an exact approved roster + config. */
  approve(input: {
    roster: ApprovedRoster;
    approver: string;
  }): Promise<Result<{ approvalId: ApprovalId; hash: string }>>;
  status(): Promise<Result<EngineStatus>>;
  /** Explicit cancellation: guarded stop of live workers, then mark cancelled. */
  cancel(input: { reason: string }): Promise<Result<void>>;
  /**
   * Terminal-run cleanup: release-then-close every terminal this run created
   * and journaled whose Dispatch is settled, fenced, lost or never issued.
   * Refuses on a non-terminal run; never touches unrecorded terminals.
   */
  cleanup?(input?: {
    supervisor?: SupervisorCleanupCustody;
    /** Calling terminal — never closed by its own cleanup. */
    callerHandle?: TerminalHandle;
  }): Promise<Result<TerminalCleanupReport>>;
}

/**
 * Optional execution-policy dependency (PUBLIC-USE.md): the loaded launch
 * catalog's fingerprint plus a synchronous validator for one AgentChoice.
 * Pure — the engine core holds no Orca or catalog-file knowledge; the CLI
 * and host adapter inject the concrete implementation from src/catalog.ts.
 * Runs whose resolved config carries `execution` require this dependency;
 * legacy runs without it never consult it.
 */
export interface ExecutionPolicy {
  /** Fingerprint of the shipped launch policy (catalog LAUNCH_POLICY_HASH). */
  policyHash: string;
  /** Synchronously validate one explicit choice against the shipped catalog. */
  validateChoice: (choice: AgentChoice) => Result<void>;
}

export interface EngineDeps {
  store: Store;
  host: HostAdapter;
  prompts: PromptBuilder;
  now?: () => Date;
  /** Optional execution policy; required by runs whose config.execution exists. */
  execution?: ExecutionPolicy;
}

/**
 * Factory signature. Implemented and exported from `src/engine.ts` (protocol
 * developer): `export function createEngine(deps: EngineDeps): Engine`.
 */
export type CreateEngine = (deps: EngineDeps) => Engine;
