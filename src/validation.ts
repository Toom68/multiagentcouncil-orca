/**
 * Runtime parsers and validators for every serializable contract in
 * src/contracts.ts. Pure, synchronous, dependency-free (node:crypto only).
 *
 * All parsers return ParseResult<T> with structured ValidationIssue entries —
 * never throw on bad input. Workers' output files, stored artifacts and user
 * config are all untrusted at parse time.
 */

import { createHash } from 'node:crypto';
import type {
  AgentChoice,
  ApprovalBinding,
  ApprovalRecord,
  ApprovedRoster,
  AuthorResponse,
  Challenge,
  ChallengeAssignment,
  ChallengeEnvelope,
  ChallengesFile,
  ChallengeKind,
  Claim,
  ClaimEvent,
  ClaimId,
  ClaimView,
  CouncilConfig,
  CouncilError,
  CouncilErrorCode,
  CouncilReport,
  CouncilState,
  DissentRecord,
  Evidence,
  EvidenceGrade,
  EvidenceKind,
  Finding,
  FindingsFile,
  JournalEvent,
  JournalEventType,
  Participant,
  ParseResult,
  Perspective,
  PhaseAttempt,
  PhaseDeadlines,
  ProposedRoster,
  ReportCoverage,
  ResponseAssignment,
  ResponseDisposition,
  ResponseEnvelope,
  ResponsesFile,
  ScribeNotesFile,
  SeatAssignment,
  Severity,
  SourceSnapshot,
  ValidationIssue,
  ClaimStatus,
  CouncilStaff,
  ExecutionConfig,
  FindingKind,
  ParticipantStatus,
  AttemptStatus,
  RunStatus,
  DiscussionStage,
} from './contracts.js';
import { SCHEMA_VERSION } from './contracts.js';

// ─── Error/issue helpers ─────────────────────────────────────────────────────

export function fail(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export function parseFail(issues: ValidationIssue[]): ParseResult<never> {
  return { ok: false, issues };
}

export function err(
  code: CouncilErrorCode,
  message: string,
  extra?: { issues?: ValidationIssue[]; details?: Record<string, unknown> },
): CouncilError {
  const e: CouncilError = { code, message };
  if (extra?.issues) e.issues = extra.issues;
  if (extra?.details) e.details = extra.details;
  return e;
}

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

// ─── Primitive guards ────────────────────────────────────────────────────────

const isObj = (u: unknown): u is Record<string, unknown> =>
  typeof u === 'object' && u !== null && !Array.isArray(u);
const isStr = (u: unknown): u is string => typeof u === 'string';
const isNum = (u: unknown): u is number => typeof u === 'number' && Number.isFinite(u);
const isInt = (u: unknown): u is number => Number.isInteger(u);
const isBool = (u: unknown): u is boolean => typeof u === 'boolean';
const isArr = (u: unknown): u is unknown[] => Array.isArray(u);

function reqObj(u: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | null {
  if (!isObj(u)) {
    issues.push(fail(path, 'type', 'expected object'));
    return null;
  }
  return u;
}

function reqStr(
  u: unknown,
  path: string,
  issues: ValidationIssue[],
  opts: { max: number; min?: number },
): string | null {
  if (!isStr(u)) {
    issues.push(fail(path, 'type', 'expected string'));
    return null;
  }
  const min = opts.min ?? 1;
  if (u.length < min) {
    issues.push(fail(path, 'too_short', `must be at least ${min} characters`));
    return null;
  }
  if (u.length > opts.max) {
    issues.push(fail(path, 'too_long', `exceeds ${opts.max} characters`));
    return null;
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(u)) {
    issues.push(fail(path, 'bad_chars', 'contains control characters'));
    return null;
  }
  return u;
}

function optStr(
  u: unknown,
  path: string,
  issues: ValidationIssue[],
  opts: { max: number },
): string | undefined {
  if (u === undefined || u === null) return undefined;
  const s = reqStr(u, path, issues, { max: opts.max });
  return s === null ? undefined : s;
}

function reqInt(
  u: unknown,
  path: string,
  issues: ValidationIssue[],
  opts: { min?: number; max?: number },
): number | null {
  if (!isNum(u) || !isInt(u)) {
    issues.push(fail(path, 'type', 'expected integer'));
    return null;
  }
  if (opts.min !== undefined && u < opts.min) {
    issues.push(fail(path, 'too_small', `must be >= ${opts.min}`));
    return null;
  }
  if (opts.max !== undefined && u > opts.max) {
    issues.push(fail(path, 'too_large', `must be <= ${opts.max}`));
    return null;
  }
  return u;
}

function reqNum(
  u: unknown,
  path: string,
  issues: ValidationIssue[],
  opts: { min?: number; max?: number; exclusiveMin?: boolean },
): number | null {
  if (!isNum(u)) {
    issues.push(fail(path, 'type', 'expected number'));
    return null;
  }
  if (opts.min !== undefined && (opts.exclusiveMin ? u <= opts.min : u < opts.min)) {
    issues.push(fail(path, 'too_small', `must be ${opts.exclusiveMin ? '>' : '>='} ${opts.min}`));
    return null;
  }
  if (opts.max !== undefined && u > opts.max) {
    issues.push(fail(path, 'too_large', `must be <= ${opts.max}`));
    return null;
  }
  return u;
}

function reqEnum<T extends string>(
  u: unknown,
  allowed: readonly T[],
  path: string,
  issues: ValidationIssue[],
): T | null {
  if (!isStr(u) || !allowed.includes(u as T)) {
    issues.push(fail(path, 'bad_enum', `expected one of: ${allowed.join(', ')}`));
    return null;
  }
  return u as T;
}

function reqStrArr(
  u: unknown,
  path: string,
  issues: ValidationIssue[],
  opts: { maxItems: number; maxItemLen: number; required?: boolean },
): string[] {
  if (u === undefined && !opts.required) return [];
  if (!isArr(u)) {
    issues.push(fail(path, 'type', 'expected array'));
    return [];
  }
  if (u.length > opts.maxItems) {
    issues.push(fail(path, 'too_many', `at most ${opts.maxItems} items`));
    return [];
  }
  const out: string[] = [];
  u.forEach((item, i) => {
    const s = reqStr(item, `${path}[${i}]`, issues, { max: opts.maxItemLen });
    if (s !== null) out.push(s);
  });
  return out;
}

function reqVersion(u: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (u !== SCHEMA_VERSION) {
    issues.push(fail(path, 'bad_version', `expected schemaVersion ${SCHEMA_VERSION}`));
    return false;
  }
  return true;
}

// ─── Token and id validation ─────────────────────────────────────────────────

/**
 * Tokens destined for argv or shell-text command construction: strict
 * allowlist, no whitespace or shell metacharacters. Covers agent ids ("devin"),
 * model ids ("swe-2-max", "provider/model:level", "@worker") and permission
 * mode tokens ("bypass").
 */
export const TOKEN_RE = /^[@A-Za-z0-9][@A-Za-z0-9._:/+-]{0,127}$/;

/** Internal ids (perspectives, seats, participants, claims, findings…). */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function reqToken(u: unknown, path: string, issues: ValidationIssue[]): string | null {
  const s = reqStr(u, path, issues, { max: 128 });
  if (s === null) return null;
  if (!TOKEN_RE.test(s)) {
    issues.push(fail(path, 'bad_token', 'must match /^[@A-Za-z0-9][@A-Za-z0-9._:/+-]{0,127}$/'));
    return null;
  }
  return s;
}

function reqId(u: unknown, path: string, issues: ValidationIssue[]): string | null {
  const s = reqStr(u, path, issues, { max: 128 });
  if (s === null) return null;
  if (!ID_RE.test(s)) {
    issues.push(fail(path, 'bad_id', 'must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/'));
    return null;
  }
  return s;
}

function optId(u: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (u === undefined || u === null) return undefined;
  return reqId(u, path, issues) ?? undefined;
}

/**
 * Safe relative path for artifacts and evidence citations. Rejects absolute
 * paths, drive letters, backslashes, dot-dot traversal, empty segments and
 * control/unsafe characters. Returns the normalized posix path on success.
 */
export function assertSafeRelativePath(u: unknown): ParseResult<string> {
  const issues: ValidationIssue[] = [];
  const p = 'path';
  if (!isStr(u) || u.length === 0) {
    issues.push(fail(p, 'unsafe_path', 'expected non-empty relative path'));
    return parseFail(issues);
  }
  if (u.length > 240) {
    issues.push(fail(p, 'too_long', 'path exceeds 240 characters'));
    return parseFail(issues);
  }
  if (u.includes('\\')) issues.push(fail(p, 'unsafe_path', 'backslash not allowed'));
  if (/^[A-Za-z]:/.test(u) || u.includes(':')) issues.push(fail(p, 'unsafe_path', 'drive/URI syntax not allowed'));
  if (u.startsWith('/')) issues.push(fail(p, 'unsafe_path', 'absolute path not allowed'));
  if (!/^[A-Za-z0-9._/+-]+$/.test(u)) issues.push(fail(p, 'unsafe_path', 'contains disallowed characters'));
  const segments = u.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    issues.push(fail(p, 'unsafe_path', 'empty, "." or ".." segments not allowed'));
  }
  if (issues.length) return parseFail(issues);
  return ok(u);
}

// ─── Enumerations (runtime, completeness-checked at compile time) ────────────

const EVIDENCE_KINDS = ['code_location', 'repro', 'scenario', 'reasoned', 'speculative'] as const;
const FINDING_KINDS = ['defect', 'risk', 'suggestion', 'question'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const EVIDENCE_GRADES = ['verified_defect', 'plausible_risk', 'speculative', 'unsupported'] as const;
const CHALLENGE_KINDS = ['missing_evidence', 'counterexample', 'overstated', 'duplicate', 'scope', 'other'] as const;
const RESPONSE_DISPOSITIONS = ['defend', 'revise', 'withdraw', 'escalate'] as const;
const CLAIM_STATUSES = ['proposed', 'challenged', 'defended', 'revised', 'escalated', 'confirmed', 'resolved', 'withdrawn'] as const;
const PHASE_KINDS = ['organiser', 'independent_review', 'scribe_notes', 'challenge', 'author_response', 'scribe_synthesis'] as const;
const ATTEMPT_STATUSES = ['planned', 'intent_recorded', 'dispatched', 'working', 'settled_ok', 'settled_failed', 'unknown', 'timed_out', 'stopped'] as const;
const PARTICIPANT_STATUSES = ['planned', 'active', 'settled', 'failed', 'timed_out', 'stopped'] as const;
const PARTICIPANT_ROLES = ['organiser', 'reviewer', 'scribe'] as const;
const RUN_STATUSES = ['initialized', 'organising', 'awaiting_approval', 'independent_review', 'scribe_notes', 'discussing', 'synthesising', 'reported', 'failed', 'cancelled'] as const;
const DISCUSSION_STAGES = ['challenges', 'responses'] as const;
const CLAIM_EVENT_TYPES = ['admitted', 'challenged', 'defended', 'revised', 'withdrawn', 'escalated', 'confirmed', 'resolved', 'regraded', 'merged'] as const;
const SEAT_OUTCOMES = ['completed', 'partial', 'failed', 'timed_out', 'not_launched'] as const;
const JOURNAL_EVENT_TYPES = [
  'run.initialized', 'phase.entered', 'barrier.refused', 'task.created',
  'launch.intent', 'worker.started', 'worker.settled', 'worker.unknown',
  'worker.timed_out', 'worker.stop_requested', 'worker.stopped', 'worker.released',
  'mail.sent', 'mail.observed', 'roster.proposed', 'approval.granted',
  'approval.invalidated', 'artifact.written', 'artifact.admitted',
  'artifact.rejected', 'envelope.built', 'deadline.hit', 'snapshot.drift',
  'claim.updated', 'report.written', 'error', 'run.finished',
] as const;

// Compile-time exhaustiveness: fails to compile if a union member is missing.
type AssertCover<A extends readonly string[], U> =
  U extends A[number] ? (A[number] extends U ? true : never) : never;
const _cover: true[] = [
  null as unknown as AssertCover<typeof EVIDENCE_KINDS, EvidenceKind>,
  null as unknown as AssertCover<typeof FINDING_KINDS, FindingKind>,
  null as unknown as AssertCover<typeof SEVERITIES, Severity>,
  null as unknown as AssertCover<typeof EVIDENCE_GRADES, EvidenceGrade>,
  null as unknown as AssertCover<typeof CHALLENGE_KINDS, ChallengeKind>,
  null as unknown as AssertCover<typeof RESPONSE_DISPOSITIONS, ResponseDisposition>,
  null as unknown as AssertCover<typeof CLAIM_STATUSES, ClaimStatus>,
  null as unknown as AssertCover<typeof PHASE_KINDS, import('./contracts.js').PhaseKind>,
  null as unknown as AssertCover<typeof ATTEMPT_STATUSES, AttemptStatus>,
  null as unknown as AssertCover<typeof PARTICIPANT_STATUSES, ParticipantStatus>,
  null as unknown as AssertCover<typeof RUN_STATUSES, RunStatus>,
  null as unknown as AssertCover<typeof DISCUSSION_STAGES, DiscussionStage>,
  null as unknown as AssertCover<typeof CLAIM_EVENT_TYPES, ClaimEvent['type']>,
  null as unknown as AssertCover<typeof JOURNAL_EVENT_TYPES, JournalEventType>,
];
void _cover;

// ─── Config ──────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: CouncilConfig = {
  schemaVersion: SCHEMA_VERSION,
  requestedPerspectives: 15,
  participants: 15,
  concurrency: 5,
  rounds: 1,
  quorumRatio: 0.67,
  maxLaunches: 56, // minViable(15,1)=48 + 8 retry slack; resolveConfig recomputes
  maxFindingsPerSeat: 7,
  maxChallengesPerSeatPerRound: 3,
  maxResponsesPerSeatPerRound: 3,
  envelopeBytes: 8192,
  maxMailPerParticipant: 6,
  maxTextChars: 4000,
  deadlines: {
    organiserMs: 30 * 60_000,
    independentMs: 4 * 3_600_000,
    scribeNotesMs: 60 * 60_000,
    challengeMs: 2 * 3_600_000,
    responseMs: 2 * 3_600_000,
    synthesisMs: 2 * 3_600_000,
    runMs: 24 * 3_600_000,
    graceMs: 30 * 60_000,
  },
};

/**
 * Minimum launches the configured workflow needs before any retry:
 * organiser(1) + independent seats + scribeNotes(1) + challenges + responses
 * (seats each per round) + scribeSynthesis(1).
 */
export function minViableLaunches(config: Pick<CouncilConfig, 'participants' | 'rounds'>): number {
  return config.participants + 2 * config.participants * config.rounds + 3;
}

/**
 * Resolve a raw partial config object into a validated CouncilConfig.
 * Unknown keys are ignored; present keys must validate. `maxLaunches` defaults
 * to minViable + 8 slack and is refused when set below the workflow minimum.
 */
export function resolveConfig(raw: unknown): ParseResult<CouncilConfig> {
  const issues: ValidationIssue[] = [];
  const r = raw === undefined || raw === null ? {} : reqObj(raw, 'config', issues);
  if (r === null) return parseFail(issues);

  const num = (key: keyof CouncilConfig & string, def: number, min: number, max: number): number => {
    const v = (r as Record<string, unknown>)[key];
    if (v === undefined) return def;
    return reqInt(v, `config.${key}`, issues, { min, max }) ?? def;
  };

  const requestedPerspectives = num('requestedPerspectives', DEFAULT_CONFIG.requestedPerspectives, 10, 25);
  const participants = num('participants', DEFAULT_CONFIG.participants, 1, 25);
  const concurrency = num('concurrency', DEFAULT_CONFIG.concurrency, 1, 50);
  const rounds = num('rounds', DEFAULT_CONFIG.rounds, 1, 3);

  if (participants > requestedPerspectives) {
    issues.push(fail('config.participants', 'too_large', 'participants cannot exceed requestedPerspectives'));
  }

  const quorumRatio = (() => {
    const v = (r as Record<string, unknown>).quorumRatio;
    if (v === undefined) return DEFAULT_CONFIG.quorumRatio;
    return reqNum(v, 'config.quorumRatio', issues, { min: 0, max: 1, exclusiveMin: true }) ?? DEFAULT_CONFIG.quorumRatio;
  })();

  const minViable = minViableLaunches({ participants, rounds });
  const maxLaunchesRaw = (r as Record<string, unknown>).maxLaunches;
  const maxLaunches =
    maxLaunchesRaw === undefined
      ? minViable + 8
      : reqInt(maxLaunchesRaw, 'config.maxLaunches', issues, { min: minViable, max: 10_000 }) ?? minViable + 8;
  if (maxLaunchesRaw !== undefined && isInt(maxLaunchesRaw) && maxLaunchesRaw < minViable) {
    issues.push(
      fail('config.maxLaunches', 'too_small', `below workflow minimum ${minViable} for participants=${participants}, rounds=${rounds}`),
    );
  }

  const maxFindingsPerSeat = num('maxFindingsPerSeat', DEFAULT_CONFIG.maxFindingsPerSeat, 1, 50);
  const maxChallengesPerSeatPerRound = num('maxChallengesPerSeatPerRound', DEFAULT_CONFIG.maxChallengesPerSeatPerRound, 1, 20);
  const maxResponsesPerSeatPerRound = num('maxResponsesPerSeatPerRound', DEFAULT_CONFIG.maxResponsesPerSeatPerRound, 1, 20);
  const envelopeBytes = num('envelopeBytes', DEFAULT_CONFIG.envelopeBytes, 256, 65_536);
  const maxMailPerParticipant = num('maxMailPerParticipant', DEFAULT_CONFIG.maxMailPerParticipant, 1, 50);
  const maxTextChars = num('maxTextChars', DEFAULT_CONFIG.maxTextChars, 256, 50_000);

  const dlRaw = (r as Record<string, unknown>).deadlines;
  let deadlines = { ...DEFAULT_CONFIG.deadlines };
  if (dlRaw !== undefined) {
    const d = reqObj(dlRaw, 'config.deadlines', issues);
    if (d !== null) {
      const dNum = (key: keyof PhaseDeadlines, def: number): number => {
        const v = d[key];
        if (v === undefined) return def;
        return reqInt(v, `config.deadlines.${key}`, issues, { min: 1_000, max: 7 * 24 * 3_600_000 }) ?? def;
      };
      deadlines = {
        organiserMs: dNum('organiserMs', DEFAULT_CONFIG.deadlines.organiserMs),
        independentMs: dNum('independentMs', DEFAULT_CONFIG.deadlines.independentMs),
        scribeNotesMs: dNum('scribeNotesMs', DEFAULT_CONFIG.deadlines.scribeNotesMs),
        challengeMs: dNum('challengeMs', DEFAULT_CONFIG.deadlines.challengeMs),
        responseMs: dNum('responseMs', DEFAULT_CONFIG.deadlines.responseMs),
        synthesisMs: dNum('synthesisMs', DEFAULT_CONFIG.deadlines.synthesisMs),
        runMs: dNum('runMs', DEFAULT_CONFIG.deadlines.runMs),
        graceMs: dNum('graceMs', DEFAULT_CONFIG.deadlines.graceMs),
      };
    }
  }

  // Optional PUBLIC-USE fields. Presence is preserved exactly — absent stays
  // absent so legacy configs/approvals keep their canonical hash — while a
  // present field must fully validate: `staff` requires ALL THREE roles as
  // explicit AgentChoices (a partial staff object is a config error), and
  // `execution` requires both fingerprint members.
  const staffRaw = (r as Record<string, unknown>).staff;
  let staff: CouncilStaff | undefined;
  if (staffRaw !== undefined) {
    const s = reqObj(staffRaw, 'config.staff', issues);
    if (s !== null) {
      const organiser = parseAgentChoice(s.organiser, 'config.staff.organiser', issues);
      const scribe = parseAgentChoice(s.scribe, 'config.staff.scribe', issues);
      const supervisor = parseAgentChoice(s.supervisor, 'config.staff.supervisor', issues);
      if (organiser !== null && scribe !== null && supervisor !== null) {
        staff = { organiser, scribe, supervisor };
      }
    }
  }

  const execRaw = (r as Record<string, unknown>).execution;
  let execution: ExecutionConfig | undefined;
  if (execRaw !== undefined) {
    const e = reqObj(execRaw, 'config.execution', issues);
    if (e !== null) {
      const catalogVersion = reqStr(e.catalogVersion, 'config.execution.catalogVersion', issues, { max: 64 });
      const policyHash = reqSha256(e.policyHash, 'config.execution.policyHash', issues);
      if (catalogVersion !== null && policyHash !== null) {
        execution = { catalogVersion, policyHash };
      }
    }
  }

  const schemaVersion = (r as Record<string, unknown>).schemaVersion;
  if (schemaVersion !== undefined && !reqVersion(schemaVersion, 'config.schemaVersion', issues)) {
    // issue already recorded
  }

  if (issues.length) return parseFail(issues);
  return ok({
    schemaVersion: SCHEMA_VERSION,
    requestedPerspectives,
    participants,
    concurrency,
    rounds,
    quorumRatio,
    maxLaunches,
    maxFindingsPerSeat,
    maxChallengesPerSeatPerRound,
    maxResponsesPerSeatPerRound,
    envelopeBytes,
    maxMailPerParticipant,
    maxTextChars,
    deadlines,
    ...(staff !== undefined ? { staff } : {}),
    ...(execution !== undefined ? { execution } : {}),
  });
}

// ─── AgentChoice ─────────────────────────────────────────────────────────────

function parseAgentChoice(u: unknown, path: string, issues: ValidationIssue[]): AgentChoice | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const agent = reqToken(o.agent, `${path}.agent`, issues);
  const model = reqToken(o.model, `${path}.model`, issues);
  const permissionMode = reqToken(o.permissionMode, `${path}.permissionMode`, issues);
  let effort: string | undefined;
  if (o.effort !== undefined && o.effort !== null) {
    effort = reqToken(o.effort, `${path}.effort`, issues) ?? undefined;
  }
  let profile: string | undefined;
  if (o.profile !== undefined && o.profile !== null) {
    profile = reqToken(o.profile, `${path}.profile`, issues) ?? undefined;
  }
  if (agent === null || model === null || permissionMode === null) return null;
  const out: AgentChoice = { agent, model, permissionMode };
  if (effort !== undefined) out.effort = effort;
  if (profile !== undefined) out.profile = profile;
  return out;
}

// ─── Roster ──────────────────────────────────────────────────────────────────

function parsePerspective(u: unknown, path: string, issues: ValidationIssue[]): Perspective | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const perspectiveId = reqId(o.perspectiveId, `${path}.perspectiveId`, issues);
  const name = reqStr(o.name, `${path}.name`, issues, { max: 120 });
  const c = reqObj(o.charter, `${path}.charter`, issues);
  let charter: Perspective['charter'] | null = null;
  if (c !== null) {
    const incentives = reqStr(c.incentives, `${path}.charter.incentives`, issues, { max: 2000 });
    const expertise = reqStr(c.expertise, `${path}.charter.expertise`, issues, { max: 2000 });
    const method = reqStr(c.method, `${path}.charter.method`, issues, { max: 2000 });
    const blindSpots = reqStr(c.blindSpots, `${path}.charter.blindSpots`, issues, { max: 2000 });
    const reviewQuestions = reqStrArr(c.reviewQuestions, `${path}.charter.reviewQuestions`, issues, {
      maxItems: 10,
      maxItemLen: 500,
      required: true,
    });
    if (incentives !== null && expertise !== null && method !== null && blindSpots !== null && reviewQuestions.length > 0) {
      charter = { incentives, expertise, method, blindSpots, reviewQuestions };
    }
  }
  const tags = reqStrArr(o.tags, `${path}.tags`, issues, { maxItems: 8, maxItemLen: 40 });
  if (perspectiveId === null || name === null || charter === null) return null;
  return { perspectiveId, name, charter, tags };
}

export function parseProposedRoster(
  raw: unknown,
  ctx: { runId?: string; requestedPerspectives: number },
): ParseResult<ProposedRoster> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'roster', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'roster.schemaVersion', issues);
  const runId = reqId(o.runId, 'roster.runId', issues);
  if (runId !== null && ctx.runId !== undefined && runId !== ctx.runId) {
    issues.push(fail('roster.runId', 'mismatch', `expected ${ctx.runId}`));
  }
  if (!isInt(ctx.requestedPerspectives) || ctx.requestedPerspectives < 10 || ctx.requestedPerspectives > 25) {
    issues.push(fail('ctx.requestedPerspectives', 'bad_param', 'requestedPerspectives must be 10-25'));
  }
  if (!isArr(o.perspectives)) {
    issues.push(fail('roster.perspectives', 'type', 'expected array'));
    return parseFail(issues);
  }
  if (o.perspectives.length !== ctx.requestedPerspectives) {
    issues.push(
      fail('roster.perspectives', 'bad_count', `expected exactly ${ctx.requestedPerspectives} perspectives, got ${o.perspectives.length}`),
    );
  }
  const seen = new Set<string>();
  const perspectives: Perspective[] = [];
  o.perspectives.forEach((p, i) => {
    const parsed = parsePerspective(p, `roster.perspectives[${i}]`, issues);
    if (parsed !== null) {
      if (seen.has(parsed.perspectiveId)) {
        issues.push(fail(`roster.perspectives[${i}].perspectiveId`, 'duplicate', `duplicate perspectiveId ${parsed.perspectiveId}`));
      } else {
        seen.add(parsed.perspectiveId);
        perspectives.push(parsed);
      }
    }
  });
  if (issues.length) return parseFail(issues);
  const out: ProposedRoster = { schemaVersion: SCHEMA_VERSION, runId: runId!, perspectives };
  if (isObj(o.producedBy)) {
    const pb = o.producedBy;
    const participantId = optId(pb.participantId, 'roster.producedBy.participantId', issues);
    const dispatchId = optId(pb.dispatchId, 'roster.producedBy.dispatchId', issues);
    if (issues.length) return parseFail(issues);
    if (participantId !== undefined) {
      out.producedBy = { participantId };
      if (dispatchId !== undefined) out.producedBy.dispatchId = dispatchId;
    }
  }
  return ok(out);
}

function parseSeat(u: unknown, path: string, issues: ValidationIssue[]): SeatAssignment | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const seatId = reqId(o.seatId, `${path}.seatId`, issues);
  const perspectiveId = reqId(o.perspectiveId, `${path}.perspectiveId`, issues);
  const participantId = reqId(o.participantId, `${path}.participantId`, issues);
  const agent = parseAgentChoice(o.agent, `${path}.agent`, issues);
  if (seatId === null || perspectiveId === null || participantId === null || agent === null) return null;
  return { seatId, perspectiveId, participantId, agent };
}

export function parseApprovedRoster(
  raw: unknown,
  ctx: { runId?: string; proposed: ProposedRoster; config: Pick<CouncilConfig, 'participants'> },
): ParseResult<import('./contracts.js').ApprovedRoster> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'roster', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'roster.schemaVersion', issues);
  const runId = reqId(o.runId, 'roster.runId', issues);
  if (runId !== null && ctx.runId !== undefined && runId !== ctx.runId) {
    issues.push(fail('roster.runId', 'mismatch', `expected ${ctx.runId}`));
  }
  if (!isArr(o.seats)) {
    issues.push(fail('roster.seats', 'type', 'expected array'));
    return parseFail(issues);
  }
  if (o.seats.length !== ctx.config.participants) {
    issues.push(fail('roster.seats', 'bad_count', `expected exactly ${ctx.config.participants} seats, got ${o.seats.length}`));
  }
  const proposedIds = new Set(ctx.proposed.perspectives.map((p) => p.perspectiveId));
  const seatIds = new Set<string>();
  const perspectiveIds = new Set<string>();
  const participantIds = new Set<string>();
  const seats: SeatAssignment[] = [];
  o.seats.forEach((s, i) => {
    const parsed = parseSeat(s, `roster.seats[${i}]`, issues);
    if (parsed === null) return;
    if (seatIds.has(parsed.seatId)) issues.push(fail(`roster.seats[${i}].seatId`, 'duplicate', `duplicate seatId ${parsed.seatId}`));
    if (perspectiveIds.has(parsed.perspectiveId))
      issues.push(fail(`roster.seats[${i}].perspectiveId`, 'duplicate', `perspective ${parsed.perspectiveId} assigned to two seats`));
    if (participantIds.has(parsed.participantId))
      issues.push(fail(`roster.seats[${i}].participantId`, 'duplicate', `duplicate participantId ${parsed.participantId}`));
    if (!proposedIds.has(parsed.perspectiveId))
      issues.push(fail(`roster.seats[${i}].perspectiveId`, 'unknown', `perspectiveId ${parsed.perspectiveId} not in proposed roster`));
    seatIds.add(parsed.seatId);
    perspectiveIds.add(parsed.perspectiveId);
    participantIds.add(parsed.participantId);
    seats.push(parsed);
  });
  if (issues.length) return parseFail(issues);
  return ok({ schemaVersion: SCHEMA_VERSION, runId: runId!, seats });
}

// ─── Evidence / findings ─────────────────────────────────────────────────────

function parseEvidence(u: unknown, path: string, issues: ValidationIssue[]): Evidence | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const kind = reqEnum(o.kind, EVIDENCE_KINDS, `${path}.kind`, issues);
  const note = reqStr(o.note, `${path}.note`, issues, { max: 2000 });
  let pathOk = true;
  let relPath: string | undefined;
  if (o.path !== undefined && o.path !== null) {
    const pr = assertSafeRelativePath(o.path);
    if (pr.ok) relPath = pr.value;
    else {
      issues.push(...pr.issues.map((i) => ({ ...i, path: `${path}.path` })));
      pathOk = false;
    }
  }
  let startLine: number | undefined;
  let endLine: number | undefined;
  if (o.startLine !== undefined && o.startLine !== null) {
    const v = reqInt(o.startLine, `${path}.startLine`, issues, { min: 1 });
    if (v === null) pathOk = false;
    else startLine = v;
  }
  if (o.endLine !== undefined && o.endLine !== null) {
    const v = reqInt(o.endLine, `${path}.endLine`, issues, { min: 1 });
    if (v === null) pathOk = false;
    else endLine = v;
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    issues.push(fail(`${path}.endLine`, 'range', 'endLine must be >= startLine'));
    pathOk = false;
  }
  const snippet = optStr(o.snippet, `${path}.snippet`, issues, { max: 1000 });
  const steps = optStr(o.steps, `${path}.steps`, issues, { max: 4000 });
  const observed = optStr(o.observed, `${path}.observed`, issues, { max: 4000 });

  if (kind === 'code_location') {
    if (relPath === undefined) issues.push(fail(`${path}.path`, 'required', 'code_location evidence requires path'));
    if (startLine === undefined) issues.push(fail(`${path}.startLine`, 'required', 'code_location evidence requires startLine'));
  }
  if (kind === 'repro') {
    if (steps === undefined) issues.push(fail(`${path}.steps`, 'required', 'repro evidence requires steps'));
    if (observed === undefined) issues.push(fail(`${path}.observed`, 'required', 'repro evidence requires observed result'));
  }
  if (kind === null || note === null || !pathOk) return null;
  if (kind === 'code_location' && (relPath === undefined || startLine === undefined)) return null;
  if (kind === 'repro' && (steps === undefined || observed === undefined)) return null;

  const out: Evidence = { kind, note };
  if (relPath !== undefined) out.path = relPath;
  if (startLine !== undefined) out.startLine = startLine;
  if (endLine !== undefined) out.endLine = endLine;
  if (snippet !== undefined) out.snippet = snippet;
  if (steps !== undefined) out.steps = steps;
  if (observed !== undefined) out.observed = observed;
  return out;
}

function parseEvidenceArr(
  u: unknown,
  path: string,
  issues: ValidationIssue[],
  opts: { maxItems: number; required?: boolean },
): Evidence[] {
  if (u === undefined && !opts.required) return [];
  if (!isArr(u)) {
    issues.push(fail(path, 'type', 'expected array'));
    return [];
  }
  if (u.length > opts.maxItems) {
    issues.push(fail(path, 'too_many', `at most ${opts.maxItems} evidence items`));
    return [];
  }
  const out: Evidence[] = [];
  u.forEach((item, i) => {
    const e = parseEvidence(item, `${path}[${i}]`, issues);
    if (e !== null) out.push(e);
  });
  return out;
}

function parseFinding(u: unknown, path: string, issues: ValidationIssue[]): Finding | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const findingId = reqId(o.findingId, `${path}.findingId`, issues);
  const title = reqStr(o.title, `${path}.title`, issues, { max: 200 });
  const kind = reqEnum(o.kind, FINDING_KINDS, `${path}.kind`, issues);
  const severity = reqEnum(o.severity, SEVERITIES, `${path}.severity`, issues);
  const confidence = reqNum(o.confidence, `${path}.confidence`, issues, { min: 0, max: 1 });
  let assertedGrade: EvidenceGrade | undefined;
  if (o.assertedGrade !== undefined && o.assertedGrade !== null) {
    assertedGrade = reqEnum(o.assertedGrade, EVIDENCE_GRADES, `${path}.assertedGrade`, issues) ?? undefined;
  }
  const evidence = parseEvidenceArr(o.evidence, `${path}.evidence`, issues, { maxItems: 20, required: true });
  const counterEvidence = parseEvidenceArr(o.counterEvidence, `${path}.counterEvidence`, issues, { maxItems: 20 });
  const remedies = reqStrArr(o.remedies, `${path}.remedies`, issues, { maxItems: 10, maxItemLen: 500 });
  const openQuestions = reqStrArr(o.openQuestions, `${path}.openQuestions`, issues, { maxItems: 10, maxItemLen: 500 });
  if (evidence.length === 0) issues.push(fail(`${path}.evidence`, 'required', 'a finding requires at least one evidence item'));
  if (findingId === null || title === null || kind === null || severity === null || confidence === null || evidence.length === 0)
    return null;
  const out: Finding = { findingId, title, kind, severity, confidence, evidence };
  if (assertedGrade !== undefined) out.assertedGrade = assertedGrade;
  if (counterEvidence.length > 0) out.counterEvidence = counterEvidence;
  if (remedies.length > 0) out.remedies = remedies;
  if (openQuestions.length > 0) out.openQuestions = openQuestions;
  return out;
}

export function parseFindingsFile(
  raw: unknown,
  ctx: { runId?: string; participantId?: string; perspectiveId?: string; maxFindings?: number },
): ParseResult<FindingsFile> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'file', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'file.schemaVersion', issues);
  const runId = reqId(o.runId, 'file.runId', issues);
  const participantId = reqId(o.participantId, 'file.participantId', issues);
  const perspectiveId = reqId(o.perspectiveId, 'file.perspectiveId', issues);
  if (runId !== null && ctx.runId !== undefined && runId !== ctx.runId)
    issues.push(fail('file.runId', 'mismatch', `expected ${ctx.runId}`));
  if (participantId !== null && ctx.participantId !== undefined && participantId !== ctx.participantId)
    issues.push(fail('file.participantId', 'mismatch', `expected ${ctx.participantId}`));
  if (perspectiveId !== null && ctx.perspectiveId !== undefined && perspectiveId !== ctx.perspectiveId)
    issues.push(fail('file.perspectiveId', 'mismatch', `expected ${ctx.perspectiveId}`));
  const max = ctx.maxFindings ?? DEFAULT_CONFIG.maxFindingsPerSeat;
  if (!isArr(o.findings)) {
    issues.push(fail('file.findings', 'type', 'expected array'));
    return parseFail(issues);
  }
  if (o.findings.length > max) {
    issues.push(fail('file.findings', 'too_many', `at most ${max} findings`));
    return parseFail(issues);
  }
  const findings: Finding[] = [];
  o.findings.forEach((f, i) => {
    const parsed = parseFinding(f, `file.findings[${i}]`, issues);
    if (parsed !== null) findings.push(parsed);
  });
  const notes = optStr(o.notes, 'file.notes', issues, { max: 4000 });
  if (issues.length || runId === null || participantId === null || perspectiveId === null) return parseFail(issues);
  const out: FindingsFile = { schemaVersion: SCHEMA_VERSION, runId, participantId, perspectiveId, findings };
  if (notes !== undefined) out.notes = notes;
  return ok(out);
}

// ─── Challenges / responses ──────────────────────────────────────────────────

function parseChallenge(u: unknown, path: string, issues: ValidationIssue[]): Challenge | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const challengeId = reqId(o.challengeId, `${path}.challengeId`, issues);
  const claimId = reqId(o.claimId, `${path}.claimId`, issues);
  const kind = reqEnum(o.kind, CHALLENGE_KINDS, `${path}.kind`, issues);
  const argument = reqStr(o.argument, `${path}.argument`, issues, { max: 4000 });
  const evidence = parseEvidenceArr(o.evidence, `${path}.evidence`, issues, { maxItems: 10 });
  if (challengeId === null || claimId === null || kind === null || argument === null) return null;
  return { challengeId, claimId, kind, argument, evidence };
}

export function parseChallengesFile(
  raw: unknown,
  ctx: { runId?: string; round?: number; participantId?: string; max?: number },
): ParseResult<ChallengesFile> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'file', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'file.schemaVersion', issues);
  const runId = reqId(o.runId, 'file.runId', issues);
  const round = reqInt(o.round, 'file.round', issues, { min: 1, max: 3 });
  const participantId = reqId(o.participantId, 'file.participantId', issues);
  if (runId !== null && ctx.runId !== undefined && runId !== ctx.runId)
    issues.push(fail('file.runId', 'mismatch', `expected ${ctx.runId}`));
  if (round !== null && ctx.round !== undefined && round !== ctx.round)
    issues.push(fail('file.round', 'mismatch', `expected round ${ctx.round}`));
  if (participantId !== null && ctx.participantId !== undefined && participantId !== ctx.participantId)
    issues.push(fail('file.participantId', 'mismatch', `expected ${ctx.participantId}`));
  const max = ctx.max ?? DEFAULT_CONFIG.maxChallengesPerSeatPerRound;
  if (!isArr(o.challenges)) {
    issues.push(fail('file.challenges', 'type', 'expected array'));
    return parseFail(issues);
  }
  if (o.challenges.length > max) {
    issues.push(fail('file.challenges', 'too_many', `at most ${max} challenges`));
    return parseFail(issues);
  }
  const challenges: Challenge[] = [];
  o.challenges.forEach((c, i) => {
    const parsed = parseChallenge(c, `file.challenges[${i}]`, issues);
    if (parsed !== null) challenges.push(parsed);
  });
  if (issues.length || runId === null || round === null || participantId === null) return parseFail(issues);
  return ok({ schemaVersion: SCHEMA_VERSION, runId, round, participantId, challenges });
}

function parseAuthorResponse(u: unknown, path: string, issues: ValidationIssue[]): AuthorResponse | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const claimId = reqId(o.claimId, `${path}.claimId`, issues);
  const challengeId = reqId(o.challengeId, `${path}.challengeId`, issues);
  const disposition = reqEnum(o.disposition, RESPONSE_DISPOSITIONS, `${path}.disposition`, issues);
  const argument = reqStr(o.argument, `${path}.argument`, issues, { max: 4000 });
  const evidence = parseEvidenceArr(o.evidence, `${path}.evidence`, issues, { maxItems: 10 });
  let revisedFinding: Finding | undefined;
  if (o.revisedFinding !== undefined && o.revisedFinding !== null) {
    revisedFinding = parseFinding(o.revisedFinding, `${path}.revisedFinding`, issues) ?? undefined;
  }
  if (disposition === 'revise' && revisedFinding === undefined) {
    issues.push(fail(`${path}.revisedFinding`, 'required', 'disposition "revise" requires revisedFinding'));
  }
  if (claimId === null || challengeId === null || disposition === null || argument === null) return null;
  if (disposition === 'revise' && revisedFinding === undefined) return null;
  const out: AuthorResponse = { claimId, challengeId, disposition, argument, evidence };
  if (revisedFinding !== undefined) out.revisedFinding = revisedFinding;
  return out;
}

export function parseResponsesFile(
  raw: unknown,
  ctx: { runId?: string; round?: number; participantId?: string; max?: number },
): ParseResult<ResponsesFile> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'file', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'file.schemaVersion', issues);
  const runId = reqId(o.runId, 'file.runId', issues);
  const round = reqInt(o.round, 'file.round', issues, { min: 1, max: 3 });
  const participantId = reqId(o.participantId, 'file.participantId', issues);
  if (runId !== null && ctx.runId !== undefined && runId !== ctx.runId)
    issues.push(fail('file.runId', 'mismatch', `expected ${ctx.runId}`));
  if (round !== null && ctx.round !== undefined && round !== ctx.round)
    issues.push(fail('file.round', 'mismatch', `expected round ${ctx.round}`));
  if (participantId !== null && ctx.participantId !== undefined && participantId !== ctx.participantId)
    issues.push(fail('file.participantId', 'mismatch', `expected ${ctx.participantId}`));
  const max = ctx.max ?? DEFAULT_CONFIG.maxResponsesPerSeatPerRound;
  if (!isArr(o.responses)) {
    issues.push(fail('file.responses', 'type', 'expected array'));
    return parseFail(issues);
  }
  if (o.responses.length > max) {
    issues.push(fail('file.responses', 'too_many', `at most ${max} responses`));
    return parseFail(issues);
  }
  const responses: AuthorResponse[] = [];
  o.responses.forEach((r2, i) => {
    const parsed = parseAuthorResponse(r2, `file.responses[${i}]`, issues);
    if (parsed !== null) responses.push(parsed);
  });
  if (issues.length || runId === null || round === null || participantId === null) return parseFail(issues);
  return ok({ schemaVersion: SCHEMA_VERSION, runId, round, participantId, responses });
}

// ─── Envelopes ───────────────────────────────────────────────────────────────

function parseClaimView(u: unknown, path: string, issues: ValidationIssue[]): ClaimView | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const claimId = reqId(o.claimId, `${path}.claimId`, issues);
  const title = reqStr(o.title, `${path}.title`, issues, { max: 200 });
  const kind = reqEnum(o.kind, FINDING_KINDS, `${path}.kind`, issues);
  const severity = reqEnum(o.severity, SEVERITIES, `${path}.severity`, issues);
  const evidence = parseEvidenceArr(o.evidence, `${path}.evidence`, issues, { maxItems: 20, required: true });
  const counterEvidence = parseEvidenceArr(o.counterEvidence, `${path}.counterEvidence`, issues, { maxItems: 20 });
  if (claimId === null || title === null || kind === null || severity === null) return null;
  return { claimId, title, kind, severity, evidence, counterEvidence };
}

function parseEnvelopeBase(
  raw: unknown,
  ctx: { runId?: string; phase?: string; round?: number; maxAssignments?: number },
  issues: ValidationIssue[],
): { runId: string; round: number | null; recipientId: string; outputPath: string; outputContract: string } | null {
  const o = reqObj(raw, 'envelope', issues);
  if (o === null) return null;
  reqVersion(o.schemaVersion, 'envelope.schemaVersion', issues);
  const runId = reqId(o.runId, 'envelope.runId', issues);
  if (runId !== null && ctx.runId !== undefined && runId !== ctx.runId)
    issues.push(fail('envelope.runId', 'mismatch', `expected ${ctx.runId}`));
  if (o.phase !== undefined && ctx.phase !== undefined && o.phase !== ctx.phase)
    issues.push(fail('envelope.phase', 'mismatch', `expected ${ctx.phase}`));
  const round = o.round === null || o.round === undefined ? null : reqInt(o.round, 'envelope.round', issues, { min: 1, max: 3 });
  if (round !== null && ctx.round !== undefined && round !== ctx.round)
    issues.push(fail('envelope.round', 'mismatch', `expected round ${ctx.round}`));
  const recipientId = reqId(o.recipientId, 'envelope.recipientId', issues);
  const outputPath = (() => {
    const pr = assertSafeRelativePath(o.outputPath);
    if (pr.ok) return pr.value;
    issues.push(...pr.issues.map((i) => ({ ...i, path: 'envelope.outputPath' })));
    return null;
  })();
  const outputContract = reqEnum(
    o.outputContract,
    ['FindingsFile', 'ChallengesFile', 'ResponsesFile', 'ScribeNotesFile', 'ReportFile'] as const,
    'envelope.outputContract',
    issues,
  );
  if (!isArr(o.assignments)) {
    issues.push(fail('envelope.assignments', 'type', 'expected array'));
    return null;
  }
  const maxA = ctx.maxAssignments ?? 10;
  if (o.assignments.length > maxA) {
    issues.push(fail('envelope.assignments', 'too_many', `at most ${maxA} assignments`));
    return null;
  }
  if (runId === null || recipientId === null || outputPath === null || outputContract === null || round === undefined) return null;
  return { runId, round, recipientId, outputPath, outputContract };
}

export function parseChallengeEnvelope(
  raw: unknown,
  ctx: { runId?: string; round?: number; maxAssignments?: number },
): ParseResult<ChallengeEnvelope> {
  const issues: ValidationIssue[] = [];
  const base = parseEnvelopeBase(raw, { ...ctx, phase: 'challenge' }, issues);
  if (base === null) return parseFail(issues);
  const o = raw as Record<string, unknown>;
  const assignments: ChallengeAssignment[] = [];
  (o.assignments as unknown[]).forEach((a, i) => {
    const p = `envelope.assignments[${i}]`;
    const obj = reqObj(a, p, issues);
    if (obj === null) return;
    const assignmentId = reqId(obj.assignmentId, `${p}.assignmentId`, issues);
    const claimId = reqId(obj.claimId, `${p}.claimId`, issues);
    const claim = parseClaimView(obj.claim, `${p}.claim`, issues);
    const question = reqStr(obj.question, `${p}.question`, issues, { max: 2000 });
    if (assignmentId !== null && claimId !== null && claim !== null && question !== null) {
      assignments.push({ assignmentId, claimId, claim, question });
    }
  });
  if (issues.length) return parseFail(issues);
  return ok({
    schemaVersion: SCHEMA_VERSION,
    runId: base.runId,
    phase: 'challenge',
    round: base.round,
    recipientId: base.recipientId,
    assignments,
    outputPath: base.outputPath,
    outputContract: 'ChallengesFile',
  });
}

export function parseResponseEnvelope(
  raw: unknown,
  ctx: { runId?: string; round?: number; maxAssignments?: number },
): ParseResult<ResponseEnvelope> {
  const issues: ValidationIssue[] = [];
  const base = parseEnvelopeBase(raw, { ...ctx, phase: 'author_response' }, issues);
  if (base === null) return parseFail(issues);
  const o = raw as Record<string, unknown>;
  const assignments: ResponseAssignment[] = [];
  (o.assignments as unknown[]).forEach((a, i) => {
    const p = `envelope.assignments[${i}]`;
    const obj = reqObj(a, p, issues);
    if (obj === null) return;
    const claimId = reqId(obj.claimId, `${p}.claimId`, issues);
    const findingId = reqId(obj.findingId, `${p}.findingId`, issues);
    const claim = parseClaimView(obj.claim, `${p}.claim`, issues);
    const challenges: Challenge[] = [];
    if (!isArr(obj.challenges)) issues.push(fail(`${p}.challenges`, 'type', 'expected array'));
    else
      obj.challenges.forEach((c, j) => {
        const parsed = parseChallenge(c, `${p}.challenges[${j}]`, issues);
        if (parsed !== null) challenges.push(parsed);
      });
    if (claimId !== null && findingId !== null && claim !== null) {
      assignments.push({ claimId, findingId, claim, challenges });
    }
  });
  if (issues.length) return parseFail(issues);
  return ok({
    schemaVersion: SCHEMA_VERSION,
    runId: base.runId,
    phase: 'author_response',
    round: base.round,
    recipientId: base.recipientId,
    assignments,
    outputPath: base.outputPath,
    outputContract: 'ResponsesFile',
  });
}

// ─── Scribe notes / report / claims ──────────────────────────────────────────

export function parseScribeNotesFile(
  raw: unknown,
  ctx: { runId?: string; participantId?: string },
): ParseResult<ScribeNotesFile> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'file', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'file.schemaVersion', issues);
  const runId = reqId(o.runId, 'file.runId', issues);
  const participantId = reqId(o.participantId, 'file.participantId', issues);
  if (runId !== null && ctx.runId !== undefined && runId !== ctx.runId)
    issues.push(fail('file.runId', 'mismatch', `expected ${ctx.runId}`));
  if (participantId !== null && ctx.participantId !== undefined && participantId !== ctx.participantId)
    issues.push(fail('file.participantId', 'mismatch', `expected ${ctx.participantId}`));
  const summaries: ScribeNotesFile['claimSummaries'] = [];
  if (!isArr(o.claimSummaries)) {
    issues.push(fail('file.claimSummaries', 'type', 'expected array'));
    return parseFail(issues);
  }
  if (o.claimSummaries.length > 200) issues.push(fail('file.claimSummaries', 'too_many', 'at most 200 summaries'));
  o.claimSummaries.forEach((s, i) => {
    const p = `file.claimSummaries[${i}]`;
    const obj = reqObj(s, p, issues);
    if (obj === null) return;
    const claimId = reqId(obj.claimId, `${p}.claimId`, issues);
    const summary = reqStr(obj.summary, `${p}.summary`, issues, { max: 2000 });
    const possibleDuplicates = reqStrArr(obj.possibleDuplicates, `${p}.possibleDuplicates`, issues, {
      maxItems: 10,
      maxItemLen: 128,
    });
    const openQuestions = reqStrArr(obj.openQuestions, `${p}.openQuestions`, issues, { maxItems: 10, maxItemLen: 500 });
    if (claimId !== null && summary !== null) summaries.push({ claimId, summary, possibleDuplicates, openQuestions });
  });
  const observations = optStr(o.observations, 'file.observations', issues, { max: 4000 });
  if (issues.length || runId === null || participantId === null) return parseFail(issues);
  const out: ScribeNotesFile = { schemaVersion: SCHEMA_VERSION, runId, participantId, claimSummaries: summaries };
  if (observations !== undefined) out.observations = observations;
  return ok(out);
}

function parseClaimEvent(u: unknown, path: string, issues: ValidationIssue[]): ClaimEvent | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const ts = reqStr(o.ts, `${path}.ts`, issues, { max: 40 });
  const type = reqEnum(o.type, CLAIM_EVENT_TYPES, `${path}.type`, issues);
  const actor = reqStr(o.actor, `${path}.actor`, issues, { max: 128 });
  const round = o.round === null || o.round === undefined ? null : reqInt(o.round, `${path}.round`, issues, { min: 1, max: 3 });
  const detail = optStr(o.detail, `${path}.detail`, issues, { max: 2000 });
  const refId = optId(o.refId, `${path}.refId`, issues);
  if (ts === null || type === null || actor === null || round === undefined) return null;
  const out: ClaimEvent = { ts, type, actor, round };
  if (detail !== undefined) out.detail = detail;
  if (refId !== undefined) out.refId = refId;
  return out;
}

function parseClaim(u: unknown, path: string, issues: ValidationIssue[]): Claim | null {
  const o = reqObj(u, path, issues);
  if (o === null) return null;
  const claimId = reqId(o.claimId, `${path}.claimId`, issues);
  const title = reqStr(o.title, `${path}.title`, issues, { max: 200 });
  const kind = reqEnum(o.kind, FINDING_KINDS, `${path}.kind`, issues);
  const grade = reqEnum(o.grade, EVIDENCE_GRADES, `${path}.grade`, issues);
  const status = reqEnum(o.status, CLAIM_STATUSES, `${path}.status`, issues);
  const severity = reqEnum(o.severity, SEVERITIES, `${path}.severity`, issues);
  const confidence = reqNum(o.confidence, `${path}.confidence`, issues, { min: 0, max: 1 });
  const evidence = parseEvidenceArr(o.evidence, `${path}.evidence`, issues, { maxItems: 20, required: true });
  const counterEvidence = parseEvidenceArr(o.counterEvidence, `${path}.counterEvidence`, issues, { maxItems: 20 });
  const sourceFindings: Claim['sourceFindings'] = [];
  if (!isArr(o.sourceFindings) || o.sourceFindings.length === 0) {
    issues.push(fail(`${path}.sourceFindings`, 'required', 'claim requires >=1 source finding'));
  } else {
    o.sourceFindings.forEach((s, i) => {
      const p = `${path}.sourceFindings[${i}]`;
      const obj = reqObj(s, p, issues);
      if (obj === null) return;
      const participantId = reqId(obj.participantId, `${p}.participantId`, issues);
      const findingId = reqId(obj.findingId, `${p}.findingId`, issues);
      if (participantId !== null && findingId !== null) sourceFindings.push({ participantId, findingId });
    });
  }
  const history: ClaimEvent[] = [];
  if (!isArr(o.history)) issues.push(fail(`${path}.history`, 'type', 'expected array'));
  else if (o.history.length > 200) issues.push(fail(`${path}.history`, 'too_many', 'at most 200 history events'));
  else
    o.history.forEach((h, i) => {
      const e = parseClaimEvent(h, `${path}.history[${i}]`, issues);
      if (e !== null) history.push(e);
    });
  const dissent: DissentRecord[] = [];
  if (o.dissent !== undefined) {
    if (!isArr(o.dissent)) issues.push(fail(`${path}.dissent`, 'type', 'expected array'));
    else
      o.dissent.forEach((d, i) => {
        const p = `${path}.dissent[${i}]`;
        const obj = reqObj(d, p, issues);
        if (obj === null) return;
        const participantId = reqId(obj.participantId, `${p}.participantId`, issues);
        const position = reqStr(obj.position, `${p}.position`, issues, { max: 2000 });
        const ts = reqStr(obj.ts, `${p}.ts`, issues, { max: 40 });
        const round = obj.round === null || obj.round === undefined ? null : reqInt(obj.round, `${p}.round`, issues, { min: 1, max: 3 });
        if (participantId !== null && position !== null && ts !== null && round !== undefined)
          dissent.push({ participantId, position, ts, round });
      });
  }
  if (
    claimId === null || title === null || kind === null || grade === null || status === null ||
    severity === null || confidence === null || sourceFindings.length === 0
  )
    return null;
  return { claimId, title, kind, grade, status, severity, confidence, evidence, counterEvidence, sourceFindings, history, dissent };
}

export function parseReportFile(raw: unknown, ctx: { runId?: string }): ParseResult<CouncilReport> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'file', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'file.schemaVersion', issues);
  const runId = reqId(o.runId, 'file.runId', issues);
  if (runId !== null && ctx.runId !== undefined && runId !== ctx.runId)
    issues.push(fail('file.runId', 'mismatch', `expected ${ctx.runId}`));
  const generatedAt = reqStr(o.generatedAt, 'file.generatedAt', issues, { max: 40 });
  const summary = reqStr(o.summary, 'file.summary', issues, { max: 8000 });
  const cov = reqObj(o.coverage, 'file.coverage', issues);
  let coverage: ReportCoverage | null = null;
  if (cov !== null) {
    const requestedPerspectives = reqInt(cov.requestedPerspectives, 'file.coverage.requestedPerspectives', issues, { min: 10, max: 25 });
    const proposedPerspectives = reqInt(cov.proposedPerspectives, 'file.coverage.proposedPerspectives', issues, { min: 10, max: 25 });
    const selectedSeats = reqInt(cov.selectedSeats, 'file.coverage.selectedSeats', issues, { min: 1, max: 25 });
    const partial = isBool(cov.partial) ? cov.partial : (issues.push(fail('file.coverage.partial', 'type', 'expected boolean')), null);
    const seats: ReportCoverage['seats'] = [];
    if (!isArr(cov.seats)) issues.push(fail('file.coverage.seats', 'type', 'expected array'));
    else
      cov.seats.forEach((s, i) => {
        const p = `file.coverage.seats[${i}]`;
        const obj = reqObj(s, p, issues);
        if (obj === null) return;
        const participantId = reqId(obj.participantId, `${p}.participantId`, issues);
        const perspectiveId = reqId(obj.perspectiveId, `${p}.perspectiveId`, issues);
        const seatId = reqId(obj.seatId, `${p}.seatId`, issues);
        const outcome = reqEnum(obj.outcome, SEAT_OUTCOMES, `${p}.outcome`, issues);
        const phasesCompleted = isArr(obj.phasesCompleted)
          ? (obj.phasesCompleted
              .map((ph, j) => reqEnum(ph, PHASE_KINDS, `${p}.phasesCompleted[${j}]`, issues))
              .filter((x): x is NonNullable<typeof x> => x !== null) as typeof obj.phasesCompleted extends never[] ? never : import('./contracts.js').PhaseKind[])
          : (issues.push(fail(`${p}.phasesCompleted`, 'type', 'expected array')), []);
        const detail = optStr(obj.detail, `${p}.detail`, issues, { max: 1000 });
        if (participantId !== null && perspectiveId !== null && seatId !== null && outcome !== null) {
          const so: ReportCoverage['seats'][number] = { participantId, perspectiveId, seatId, outcome, phasesCompleted };
          if (detail !== undefined) so.detail = detail;
          seats.push(so);
        }
      });
    const uncoveredPerspectiveIds = reqStrArr(cov.uncoveredPerspectiveIds, 'file.coverage.uncoveredPerspectiveIds', issues, {
      maxItems: 25,
      maxItemLen: 128,
    });
    if (requestedPerspectives !== null && proposedPerspectives !== null && selectedSeats !== null && partial !== null) {
      coverage = { requestedPerspectives, proposedPerspectives, selectedSeats, seats, uncoveredPerspectiveIds, partial };
    }
  }
  const claims: Claim[] = [];
  if (!isArr(o.claims)) issues.push(fail('file.claims', 'type', 'expected array'));
  else if (o.claims.length > 500) issues.push(fail('file.claims', 'too_many', 'at most 500 claims'));
  else
    o.claims.forEach((c, i) => {
      const parsed = parseClaim(c, `file.claims[${i}]`, issues);
      if (parsed !== null) claims.push(parsed);
    });
  const limitations = reqStrArr(o.limitations, 'file.limitations', issues, { maxItems: 20, maxItemLen: 1000 });
  if (issues.length || runId === null || generatedAt === null || summary === null || coverage === null) return parseFail(issues);
  return ok({ schemaVersion: SCHEMA_VERSION, runId, generatedAt, summary, coverage, claims, limitations });
}

// ─── Snapshot / approval ─────────────────────────────────────────────────────

const SHA256_RE = /^[0-9a-f]{64}$/;

function reqSha256(u: unknown, path: string, issues: ValidationIssue[]): string | null {
  const s = reqStr(u, path, issues, { max: 64 });
  if (s === null) return null;
  if (!SHA256_RE.test(s)) {
    issues.push(fail(path, 'bad_hash', 'expected 64-char lowercase hex sha256'));
    return null;
  }
  return s;
}

export function parseSourceSnapshot(raw: unknown): ParseResult<SourceSnapshot> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'snapshot', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'snapshot.schemaVersion', issues);
  const snapshotId = reqId(o.snapshotId, 'snapshot.snapshotId', issues);
  const targetRoot = reqStr(o.targetRoot, 'snapshot.targetRoot', issues, { max: 500 });
  let gitHead: string | null = null;
  if (o.gitHead !== null && o.gitHead !== undefined) {
    gitHead = reqStr(o.gitHead, 'snapshot.gitHead', issues, { max: 128 });
  }
  const takenAt = reqStr(o.takenAt, 'snapshot.takenAt', issues, { max: 40 });
  const headHash = reqSha256(o.headHash, 'snapshot.headHash', issues);
  const files: SourceSnapshot['files'] = {};
  if (!isObj(o.files)) {
    issues.push(fail('snapshot.files', 'type', 'expected object map'));
  } else {
    const entries = Object.entries(o.files);
    if (entries.length > 100_000) issues.push(fail('snapshot.files', 'too_many', 'at most 100000 file entries'));
    for (const [k, v] of entries) {
      const pr = assertSafeRelativePath(k);
      if (!pr.ok) {
        issues.push(...pr.issues.map((i) => ({ ...i, path: `snapshot.files key ${JSON.stringify(k)}` })));
        continue;
      }
      const p = `snapshot.files[${JSON.stringify(k)}]`;
      const obj = reqObj(v, p, issues);
      if (obj === null) continue;
      const sha256 = reqSha256(obj.sha256, `${p}.sha256`, issues);
      const size = reqInt(obj.size, `${p}.size`, issues, { min: 0 });
      if (sha256 !== null && size !== null) files[pr.value] = { sha256, size };
    }
  }
  if (issues.length || snapshotId === null || targetRoot === null || takenAt === null || headHash === null || gitHead === undefined)
    return parseFail(issues);
  return ok({ schemaVersion: SCHEMA_VERSION, snapshotId, targetRoot, gitHead, takenAt, headHash, files });
}

export function parseApprovalBinding(raw: unknown): ParseResult<ApprovalBinding> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'binding', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'binding.schemaVersion', issues);
  const runId = reqId(o.runId, 'binding.runId', issues);
  const objective = reqStr(o.objective, 'binding.objective', issues, { max: 8000 });
  const seats: SeatAssignment[] = [];
  if (!isArr(o.seats)) issues.push(fail('binding.seats', 'type', 'expected array'));
  else
    o.seats.forEach((s, i) => {
      const parsed = parseSeat(s, `binding.seats[${i}]`, issues);
      if (parsed !== null) seats.push(parsed);
    });
  const cfg = resolveConfig(o.config);
  let config: CouncilConfig | null = null;
  if (cfg.ok) config = cfg.value;
  else issues.push(...cfg.issues.map((i) => ({ ...i, path: `binding.${i.path}` })));
  const snapshotId = reqId(o.snapshotId, 'binding.snapshotId', issues);
  const snapshotHeadHash = reqSha256(o.snapshotHeadHash, 'binding.snapshotHeadHash', issues);
  const proposedRosterHash = reqSha256(o.proposedRosterHash, 'binding.proposedRosterHash', issues);
  if (
    issues.length || runId === null || objective === null || config === null ||
    snapshotId === null || snapshotHeadHash === null || proposedRosterHash === null
  )
    return parseFail(issues);
  return ok({ schemaVersion: SCHEMA_VERSION, runId, objective, seats, proposedRosterHash, config, snapshotId, snapshotHeadHash });
}

export function parseApprovalRecord(raw: unknown): ParseResult<ApprovalRecord> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'approval', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'approval.schemaVersion', issues);
  const approvalId = reqId(o.approvalId, 'approval.approvalId', issues);
  const hash = reqSha256(o.hash, 'approval.hash', issues);
  const approver = reqStr(o.approver, 'approval.approver', issues, { max: 128 });
  const createdAt = reqStr(o.createdAt, 'approval.createdAt', issues, { max: 40 });
  if (issues.length || approvalId === null || hash === null || approver === null || createdAt === null)
    return parseFail(issues);
  return ok({ schemaVersion: SCHEMA_VERSION, approvalId, hash, approver, createdAt });
}

/** Deterministic canonical JSON: recursively sorted object keys, undefined dropped. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

function sha256Canonical(v: unknown): string {
  return createHash('sha256').update(canonicalJson(v), 'utf8').digest('hex');
}

/**
 * Deterministic SHA-256 of an ApprovalBinding. Any byte change to a bound
 * field — objective, seats, config, snapshot ids/hashes, or the
 * proposedRosterHash — changes the hash.
 */
export function canonicalApprovalHash(binding: ApprovalBinding): string {
  return sha256Canonical(binding);
}

/**
 * Construct the canonical ApprovalBinding payload for a run. Single source of
 * truth shared by the engine (approve/revalidate) and the CLI `verify` path —
 * the exact field set the approval hash covers, byte-compatible with the
 * payload the engine built inline before this helper existed.
 */
export function buildApprovalBinding(
  state: CouncilState,
  roster: ApprovedRoster,
  proposed: ProposedRoster,
  snapshot: SourceSnapshot,
): ApprovalBinding {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: state.runId,
    objective: state.objective,
    seats: roster.seats,
    proposedRosterHash: canonicalRosterHash(proposed),
    config: state.config,
    snapshotId: snapshot.snapshotId,
    snapshotHeadHash: snapshot.headHash,
  };
}

/**
 * Canonical SHA-256 of a full ProposedRoster. This is the value stored in
 * ApprovalBinding.proposedRosterHash: editing any charter (incentives,
 * expertise, method, blindSpots, reviewQuestions) or the proposal invalidates
 * every approval bound to it.
 */
export function canonicalRosterHash(roster: ProposedRoster): string {
  return sha256Canonical(roster);
}

// ─── State / participants / journal ──────────────────────────────────────────

export function parsePhaseAttempt(raw: unknown): ParseResult<PhaseAttempt> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'attempt', issues);
  if (o === null) return parseFail(issues);
  const attemptId = reqId(o.attemptId, 'attempt.attemptId', issues);
  const participantId = reqId(o.participantId, 'attempt.participantId', issues);
  const phase = reqEnum(o.phase, PHASE_KINDS, 'attempt.phase', issues);
  const round = o.round === null || o.round === undefined ? null : reqInt(o.round, 'attempt.round', issues, { min: 1, max: 3 });
  const optOrNullId = (v: unknown, p: string): string | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    return reqId(v, p, issues);
  };
  const taskId = optOrNullId(o.taskId, 'attempt.taskId');
  const dispatchId = optOrNullId(o.dispatchId, 'attempt.dispatchId');
  const terminalHandle = optOrNullId(o.terminalHandle, 'attempt.terminalHandle');
  const launchIntentId = reqId(o.launchIntentId, 'attempt.launchIntentId', issues);
  const requestId = o.requestId === undefined || o.requestId === null ? undefined : (reqStr(o.requestId, 'attempt.requestId', issues, { max: 128 }) ?? undefined);
  const status = reqEnum(o.status, ATTEMPT_STATUSES, 'attempt.status', issues);
  const createdAt = reqStr(o.createdAt, 'attempt.createdAt', issues, { max: 40 });
  const settledAt = optStr(o.settledAt, 'attempt.settledAt', issues, { max: 40 });
  const artifacts: string[] = [];
  if (!isArr(o.artifacts)) issues.push(fail('attempt.artifacts', 'type', 'expected array'));
  else
    o.artifacts.forEach((a, i) => {
      const pr = assertSafeRelativePath(a);
      if (pr.ok) artifacts.push(pr.value);
      else issues.push(...pr.issues.map((x) => ({ ...x, path: `attempt.artifacts[${i}]` })));
    });
  if (
    issues.length || attemptId === null || participantId === null || phase === null ||
    round === undefined || taskId === undefined || dispatchId === undefined ||
    terminalHandle === undefined || launchIntentId === null || status === null || createdAt === null
  )
    return parseFail(issues);
  const out: PhaseAttempt = {
    attemptId, participantId, phase, round, taskId, dispatchId, terminalHandle,
    launchIntentId, status, createdAt, artifacts,
  };
  if (requestId !== undefined) out.requestId = requestId;
  if (settledAt !== undefined) out.settledAt = settledAt;
  return ok(out);
}

export function parseParticipant(raw: unknown): ParseResult<Participant> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'participant', issues);
  if (o === null) return parseFail(issues);
  const participantId = reqId(o.participantId, 'participant.participantId', issues);
  const role = reqEnum(o.role, PARTICIPANT_ROLES, 'participant.role', issues);
  const seatId = o.seatId === null || o.seatId === undefined ? null : reqId(o.seatId, 'participant.seatId', issues);
  const perspectiveId = o.perspectiveId === null || o.perspectiveId === undefined ? null : reqId(o.perspectiveId, 'participant.perspectiveId', issues);
  const agent = parseAgentChoice(o.agent, 'participant.agent', issues);
  const retainedTerminal = o.retainedTerminal === null || o.retainedTerminal === undefined ? null : reqId(o.retainedTerminal, 'participant.retainedTerminal', issues);
  const status = reqEnum(o.status, PARTICIPANT_STATUSES, 'participant.status', issues);
  const attempts: PhaseAttempt[] = [];
  if (!isArr(o.attempts)) issues.push(fail('participant.attempts', 'type', 'expected array'));
  else
    o.attempts.forEach((a, i) => {
      const r = parsePhaseAttempt(a);
      if (r.ok) attempts.push(r.value);
      else issues.push(...r.issues.map((x) => ({ ...x, path: `participant.attempts[${i}]${x.path ? '.' + x.path.replace(/^attempt\.?/, '') : ''}` })));
    });
  if (issues.length || participantId === null || role === null || seatId === undefined ||
    perspectiveId === undefined || agent === null || retainedTerminal === undefined || status === null)
    return parseFail(issues);
  return ok({ participantId, role, seatId, perspectiveId, agent, retainedTerminal, attempts, status });
}

export function parseCouncilState(raw: unknown): ParseResult<CouncilState> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'state', issues);
  if (o === null) return parseFail(issues);
  reqVersion(o.schemaVersion, 'state.schemaVersion', issues);
  const runId = reqId(o.runId, 'state.runId', issues);
  const orcaRunId = o.orcaRunId === null || o.orcaRunId === undefined ? null : reqId(o.orcaRunId, 'state.orcaRunId', issues);
  const status = reqEnum(o.status, RUN_STATUSES, 'state.status', issues);
  const targetRoot = reqStr(o.targetRoot, 'state.targetRoot', issues, { max: 500 });
  const objective = reqStr(o.objective, 'state.objective', issues, { max: 8000 });
  const cfg = resolveConfig(o.config);
  let config: CouncilConfig | null = null;
  if (cfg.ok) config = cfg.value;
  else issues.push(...cfg.issues.map((i) => ({ ...i, path: `state.${i.path}` })));
  const snapshotId = o.snapshotId === null || o.snapshotId === undefined ? null : reqId(o.snapshotId, 'state.snapshotId', issues);
  const approvalHash = o.approvalHash === null || o.approvalHash === undefined ? null : reqSha256(o.approvalHash, 'state.approvalHash', issues);
  const participants: Participant[] = [];
  if (!isArr(o.participants)) issues.push(fail('state.participants', 'type', 'expected array'));
  else
    o.participants.forEach((p, i) => {
      const r = parseParticipant(p);
      if (r.ok) participants.push(r.value);
      else issues.push(...r.issues.map((x) => ({ ...x, path: `state.participants[${i}]` })));
    });
  let discussion: CouncilState['discussion'] = null;
  if (o.discussion !== null && o.discussion !== undefined) {
    const d = reqObj(o.discussion, 'state.discussion', issues);
    if (d !== null) {
      const round = reqInt(d.round, 'state.discussion.round', issues, { min: 1, max: 3 });
      const stage = reqEnum(d.stage, DISCUSSION_STAGES, 'state.discussion.stage', issues);
      if (round !== null && stage !== null) discussion = { round, stage };
    }
  }
  let supervisor: CouncilState['supervisor'] = null;
  if (o.supervisor !== null && o.supervisor !== undefined) {
    const s = reqObj(o.supervisor, 'state.supervisor', issues);
    if (s !== null) {
      const terminalHandle = reqId(s.terminalHandle, 'state.supervisor.terminalHandle', issues);
      const dispatchId = s.dispatchId === null || s.dispatchId === undefined ? null : reqId(s.dispatchId, 'state.supervisor.dispatchId', issues);
      if (terminalHandle !== null && dispatchId !== undefined) supervisor = { terminalHandle, dispatchId };
    }
  }
  const cons = reqObj(o.consumption, 'state.consumption', issues);
  let consumption = { launches: 0, mailSent: 0 };
  if (cons !== null) {
    const launches = reqInt(cons.launches, 'state.consumption.launches', issues, { min: 0 });
    const mailSent = reqInt(cons.mailSent, 'state.consumption.mailSent', issues, { min: 0 });
    if (launches !== null && mailSent !== null) consumption = { launches, mailSent };
  }
  const phaseEnteredAt = reqStr(o.phaseEnteredAt, 'state.phaseEnteredAt', issues, { max: 40 });
  const createdAt = reqStr(o.createdAt, 'state.createdAt', issues, { max: 40 });
  if (
    issues.length || runId === null || orcaRunId === undefined || status === null ||
    targetRoot === null || objective === null || config === null || snapshotId === undefined ||
    approvalHash === undefined || phaseEnteredAt === null || createdAt === null
  )
    return parseFail(issues);
  return ok({
    schemaVersion: SCHEMA_VERSION, runId, orcaRunId, status, targetRoot, objective,
    config, snapshotId, approvalHash, participants, discussion, supervisor,
    consumption, phaseEnteredAt, createdAt,
  });
}

export function parseJournalEvent(raw: unknown): ParseResult<JournalEvent> {
  const issues: ValidationIssue[] = [];
  const o = reqObj(raw, 'event', issues);
  if (o === null) return parseFail(issues);
  const seq = reqInt(o.seq, 'event.seq', issues, { min: 0 });
  const ts = reqStr(o.ts, 'event.ts', issues, { max: 40 });
  const type = reqEnum(o.type, JOURNAL_EVENT_TYPES, 'event.type', issues);
  const actor = reqStr(o.actor, 'event.actor', issues, { max: 128 });
  const phase = o.phase === undefined ? undefined : (reqEnum(o.phase, PHASE_KINDS, 'event.phase', issues) ?? undefined);
  const round = o.round === null || o.round === undefined ? undefined : (reqInt(o.round, 'event.round', issues, { min: 1, max: 3 }) ?? undefined);
  const participantId = o.participantId === undefined ? undefined : optId(o.participantId, 'event.participantId', issues);
  const payload = o.payload === undefined ? undefined : (isObj(o.payload) ? (o.payload as Record<string, unknown>) : undefined);
  if (o.payload !== undefined && payload === undefined) issues.push(fail('event.payload', 'type', 'expected object'));
  const prevHash = o.prevHash === undefined ? undefined : (reqSha256(o.prevHash, 'event.prevHash', issues) ?? undefined);
  if (issues.length || seq === null || ts === null || type === null || actor === null) return parseFail(issues);
  const out: JournalEvent = { seq, ts, type, actor };
  if (phase !== undefined) out.phase = phase;
  if (round !== undefined) out.round = round;
  if (participantId !== undefined) out.participantId = participantId;
  if (payload !== undefined) out.payload = payload;
  if (prevHash !== undefined) out.prevHash = prevHash;
  return ok(out);
}

// ─── Honest grading path ─────────────────────────────────────────────────────

/**
 * Evidence-grade ceiling for a claim. Deterministic and conservative:
 * - `verified_defect` requires at least one `repro` evidence item AND
 *   `opts.independentlyValidated === true` (a validated contradiction or
 *   reproduced result recorded by the claims layer). A reviewer's own
 *   assertedGrade can never reach verified_defect.
 * - `plausible_risk` is the ceiling for cited, reproduced-but-unvalidated, or
 *   reasoned evidence.
 * - `speculative` when the strongest evidence is speculative.
 * - `unsupported` when there is no usable evidence (the claims layer marks
 *   claims whose citations fail verification unsupported separately).
 */
export function maxClaimGrade(
  evidence: readonly Pick<Evidence, 'kind'>[],
  opts?: { independentlyValidated?: boolean },
): EvidenceGrade {
  if (evidence.length === 0) return 'unsupported';
  const kinds = new Set(evidence.map((e) => e.kind));
  if (kinds.has('repro')) {
    return opts?.independentlyValidated === true ? 'verified_defect' : 'plausible_risk';
  }
  if (kinds.has('code_location') || kinds.has('scenario') || kinds.has('reasoned')) {
    return 'plausible_risk';
  }
  return 'speculative';
}
