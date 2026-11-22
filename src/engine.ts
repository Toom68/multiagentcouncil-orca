/**
 * Council protocol engine — the deterministic state machine that drives a run.
 *
 * Responsibilities:
 * - Own every legal RunStatus transition and the approval gate between them.
 * - Persist launch intent BEFORE any host mutation; resume idempotently after
 *   a crash (attempt records + journal are the durable truth).
 * - Launch every later phase as a FRESH supervised Task, reusing a retained
 *   terminal only for a participant whose previous dispatch is proven settled.
 * - Charge every launch, enforce concurrency/launch caps and on-advance
 *   deadlines, and never poll, sleep, or consume mail.
 * - Admit only worker output that belongs to the correct settled
 *   phase/run/participant/round and the assignments it was given; everything
 *   else is rejected visibly in the journal.
 * - Revalidate the approval binding and source snapshot before every launch;
 *   drift invalidates approval and blocks further work.
 * - Never relaunch on a missing receipt: unknown outcomes block with the
 *   retained requestId until an observation proves the dispatch settled.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SCHEMA_VERSION,
  type AdvanceResult,
  type AgentChoice,
  type ApprovalBinding,
  type ApprovalRecord,
  type ApprovedRoster,
  type AttemptId,
  type AttemptStatus,
  type ChallengeAssignment,
  type ChallengesFile,
  type ClaimLedger,
  type CouncilError,
  type CouncilState,
  type Engine,
  type EngineDeps,
  type EngineStatus,
  type ExecutionPolicy,
  type FindingsFile,
  type JournalEvent,
  type JournalEventType,
  type LeanEnvCleanupReport,
  type LeanEnvFileRecord,
  type LeanEnvRecord,
  type Participant,
  type ParticipantId,
  type Perspective,
  type PerspectiveId,
  type PhaseAttempt,
  type PhaseKind,
  type ProposedRoster,
  type ResponseAssignment,
  type ResponsesFile,
  type Result,
  type RunStatus,
  type SnapshotDrift,
  type SourceSnapshot,
  type Store,
  type SupervisorCleanupCustody,
  type TaskListRow,
  type TerminalCleanupEntry,
  type TerminalCleanupReport,
  type TerminalCreateIntent,
  type TerminalCreateReceipt,
  type WorkerListRow,
} from './contracts.js';
import {
  assertSafeRelativePath,
  buildApprovalBinding,
  canonicalApprovalHash,
  canonicalRosterHash,
  err,
  parseApprovedRoster,
  parseChallengesFile,
  parseClaimLedger,
  parseFindingsFile,
  parseProposedRoster,
  parseReportFile,
  parseResponsesFile,
  parseScribeNotesFile,
} from './validation.js';
import * as validationNs from './validation.js';
import {
  collectReceipts,
  INTEGRITY_POLICY,
  integrityPolicy,
  journalHasPolicyMarker,
  noteReceipt,
  readVerifiedArtifact,
  receiptJournalFields,
  recordManagedWrite,
  resolveIntegrityPolicy,
  type ArtifactReceipt,
  type IntegrityPolicy,
  type ReceiptCategory,
} from './artifacts.js';
import { createProgressNotifier, type ProgressEvent } from './progress.js';
import {
  applyLeanPlan,
  ensureGitExclude,
  LEAN_BACKUP_DIR,
  planLeanWrites,
  restoreLeanFiles,
} from './host/devin-lean.js';
import {
  applyChallengesToLedger,
  applyResponsesToLedger,
  assignChallenges,
  assignResponses,
  buildClaimLedger,
  claimAuthors,
  claimsById,
  fitEnvelope,
  indexAdmittedChallenges,
  makeEnvelopeBase,
  recordChallengeRouting,
  recordResponseRouting,
  type AdmittedFinding,
  type SourceAccess,
} from './claims.js';
import {
  buildCouncilReport,
  renderReportMarkdown,
  renderSummaryMarkdown,
  type ScribeNarrative,
} from './report.js';

// ─── Fixed paths and defaults ────────────────────────────────────────────────

const ORGANISER_PID = 'organiser';
const SCRIBE_PID = 'scribe';

/**
 * Engine-minted attempt ids: `att_<pid>_<phase>_r<round>_<<idx>` where pids may
 * themselves contain underscores — the phase segment anchors the parse.
 */
const ATTEMPT_ID_RE = /^att_(.+)_(organiser|independent_review|scribe_notes|challenge|author_response|scribe_synthesis)_r(\d+)_(\d+)$/;

/** Organiser/scribe run as ordinary Devin workers; seat agents are approval-bound. */
const COUNCIL_STAFF_AGENT: AgentChoice = {
  agent: 'devin',
  model: 'swe-2-max',
  permissionMode: 'bypass',
};

const paths = {
  organiserOut: 'organiser/roster.proposed.json',
  findingsOut: (pid: string) => `findings/${pid}.json`,
  scribeNotesOut: 'scribe/notes.json',
  challengeEnv: (pid: string, r: number) => `rounds/${r}/envelopes/challenge/${pid}.json`,
  challengeOut: (pid: string, r: number) => `rounds/${r}/challenges/${pid}.json`,
  responseEnv: (pid: string, r: number) => `rounds/${r}/envelopes/response/${pid}.json`,
  responseOut: (pid: string, r: number) => `rounds/${r}/responses/${pid}.json`,
  scribeReportJson: 'scribe/report.json',
  scribeReportMd: 'scribe/report.md',
  scribeSummary: 'scribe/summary.md',
  ledger: 'claims.json',
  reportJson: 'report.json',
  reportMd: 'report.md',
  summaryMd: 'summary.md',
  spec: (attemptId: string) => `specs/${attemptId}.md`,
};

const TERMINAL_ATTEMPT = new Set(['settled_ok', 'settled_failed', 'timed_out', 'stopped']);
const ACTIVE_ATTEMPT = new Set(['dispatched', 'working', 'unknown']);
/** Bounded retries for provably no-effect worker-launch errors. */
const MAX_WORKER_LAUNCH_ERRORS = 2;
/**
 * Attempts whose worker may physically still be running — or whose launch
 * outcome was never disproven. Each holds a concurrency slot until
 * observation or a confirmed stop proves it settled/dead. `timed_out`
 * stays here: a deadline mark is not proof of death.
 */
const SLOT_HOLDING_ATTEMPT = new Set(['intent_recorded', 'dispatched', 'working', 'unknown', 'timed_out']);

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = (error: CouncilError): Result<never> => ({ ok: false, error });

// ─── Execution policy boundary (PUBLIC-USE) ──────────────────────────────────
// A run whose config binds an execution fingerprint MUST be driven by an
// injected ExecutionPolicy whose hash matches the approved fingerprint —
// enforced synchronously before every host mutation on every entry path
// (run-create, approval, launch). Stops/observes/releases stay ungated so a
// blocked run can never strand live workers. Runs without config.execution
// keep the legacy path: no policy required, no validation added, identical
// approval hashes. The engine never loads a catalog and knows nothing of Orca.

// ─── Per-step working context ────────────────────────────────────────────────

interface StepCtx {
  state: CouncilState;
  now: Date;
  /** Journal events accumulated during this step (flushed with state). */
  events: Omit<JournalEvent, 'seq'>[];
  /** Artifacts admitted or produced during this step (surfaced in AdvanceResult). */
  artifacts: string[];
  /** Attempt ids whose output was already rejected (journal-derived, durable). */
  rejectedAttempts: Set<AttemptId>;
  /** Attempt ids whose task-create already failed (journal-derived, durable). */
  taskCreateFailed: Set<AttemptId>;
  /**
   * Journaled worker-launch error counts per attempt (durable). A journaled
   * error is provably no-effect (uncertainty arrives as outcome 'unknown'),
   * so a bounded retry is safe — but a deterministic failure must not
   * livelock: after MAX_WORKER_LAUNCH_ERRORS the seat fails visibly.
   */
  workerLaunchFailures: Map<AttemptId, number>;
  /**
   * Corrective repair context per attempt id — journaled on the rejection
   * event so a restart rebuilds the exact spec context before relaunch.
   */
  repairByAttempt: Map<AttemptId, RepairSpec>;
  /** "pid|phase|round" tuples that already consumed their one corrective attempt. */
  repairedKeys: Set<string>;
  /** Per-recipient runner mail counts (journal-derived, durable). */
  mailSentByTarget: Map<string, number>;
  /** True when a prior run-create intent exists without a recorded success. */
  runCreateUnresolved: boolean;
  /** Attempt ids with a stop already requested (journal-derived, durable). */
  stopRequestedAttempts: Set<AttemptId>;
  /**
   * Dispatch ids whose release intent is journaled (durable custody). A
   * release intent without a receipt means the call may have landed — never
   * blind-reissue; reconcile through documented host reads instead.
   */
  releaseRequested: Set<string>;
  /**
   * Operation-stage chronology (journal-derived, last-write-wins): the most
   * recent durable entry for each host mutation. 'issued' ⇒ the op ran and
   * its outcome is uncertain; 'refused' ⇒ a definitive no-effect refusal was
   * receipted; absent ⇒ see intentProtocol (v2+ proves never-issued, legacy
   * intents cannot).
   */
  taskCreateStage: Map<AttemptId, 'issued' | 'refused'>;
  workerLaunchStage: Map<AttemptId, 'issued' | 'refused'>;
  /**
   * Same durable chronology for the terminal-create INSIDE launchWorker —
   * journaled by the adapter's custody callbacks, so a crash mid-launch
   * leaves the pre-attach resource visible and never licenses a blind
   * second create. 'issued' ⇒ intent journaled or outcome uncertain;
   * 'refused' ⇒ a definitive no-effect refusal was receipted.
   */
  terminalCreateStage: Map<AttemptId, 'issued' | 'refused'>;
  /**
   * Journaled terminal identities retained per attempt (pre-attach custody).
   * `dispatchMarker` records the adapter's promise to journal a worker-start
   * marker before any worker-start onto that terminal.
   */
  terminalCustody: Map<AttemptId, { handle: string; requestId?: string; dispatchMarker?: boolean }>;
  /** Attempts whose worker-start marker is journaled (dispatch may have been issued). */
  workerStartMarkers: Set<AttemptId>;
  /**
   * Journaled pre-dispatch failures per "pid|phase|round" tuple (attempt
   * ids). The first earns exactly one fresh relaunch; the second fails the seat.
   */
  preDispatchFailures: Map<string, Set<AttemptId>>;
  /** Terminals orphaned by a pre-dispatch failure — never reused. */
  preDispatchOrphans: Set<string>;
  /**
   * Journaled terminal-close custody per handle: an intent without an
   * outcome may be retried (closing a closed terminal is harmless); an
   * outcome means the engine is done with it.
   */
  terminalCloses: Map<string, { outcome?: 'closed' | 'already_gone' | 'failed' }>;
  /** "handle|reason" close skips already journaled (dedupe). */
  terminalCloseSkips: Set<string>;
  /**
   * Attempts with a journaled first-turn bare-Enter nudge intent (durable).
   * At most one nudge per attempt: an intent — receipted or not — forbids
   * another; an unreceipted one is surfaced, never retried.
   */
  submitNudgeIntents: Set<AttemptId>;
  /**
   * Launch-protocol version per attempt (max `v` on attempt-level
   * launch.intent events). v≥2 intents participate in the stage-marker
   * scheme; absent/lower means the attempt was journaled by a runner without
   * markers — its markerless stages are 'uncertain', never 'never-issued'.
   */
  intentProtocol: Map<AttemptId, number>;
  /** Perspective catalog from the admitted proposal (reviewer spec inputs). */
  perspectives?: Map<string, Perspective>;
  /** Admitted findings paths handed to the scribe-notes prompt. */
  admittedFindingsPaths?: string[];
  /** Snapshot resolved once per step (prompt ctx + evidence validation). */
  snapshot?: SourceSnapshot;
  /** Approved roster verified by this step's revalidation (bound seat agents). */
  approvedRoster?: ApprovedRoster;
  /** Drift verdict cached once per advance — never re-scans per launch. */
  driftResult?: Result<SnapshotDrift>;
  /**
   * Resolved artifact-integrity policy for this run (marker agreement across
   * council.json + journal). 'receipts-v1' runs mint/verify exact-byte
   * receipts; 'legacy' runs stay honest and untracked — never retro-minted.
   */
  integrity: IntegrityPolicy;
  /**
   * Journal-authoritative receipt map (collectReceipts over events.jsonl).
   * Updated in-step from the exact bytes held at mint/write time — never
   * re-read from disk. An index-only orphan is invisible here, which is the
   * point: only journaled receipts authorize anything.
   */
  receipts: Map<string, ArtifactReceipt>;
  /**
   * Envelope authorization, journal-derived: path → the claim/challenge ids
   * the runner assigned when the envelope was built. NEVER re-derived from
   * the worker-editable envelope file.
   */
  envelopeAssigned: Map<string, string[]>;
  /** Envelope.built events that predate assignedIds journaling (legacy). */
  legacyEnvelopes: Set<string>;
  /** Journal-error details already emitted (anomaly dedupe across rebuilds). */
  journaledErrors: Set<string>;
  /**
   * Durable lifecycle records from events.jsonl — phase.entered /
   * approval.granted / run.finished / lifecycle.blocked error markers — in
   * journal order. This is the P-D4 wake catch-up source: a stage whose
   * progress intent was lost (crash or pre-intent failure between the state
   * flush and the outbox write) is recovered by replaying these entries with
   * their ORIGINAL dedupe identity, never guessed state.
   */
  lifecycleJournal: JournalEvent[];
  /**
   * Durable lean-env record (journal-derived, last lean.env generate/restore
   * receipt wins). 'active' files are in place; 'skipped' means generation
   * was declined once and is never retried this run.
   */
  leanEnv?: LeanEnvRecord;
  /**
   * Journaled lean.env generation intent without a receipt (crash between
   * them): its names bound which stubs a partial write could have left, so
   * regeneration can tell our own output from a user file.
   */
  leanEnvIntent?: { worktreeRoot?: string; names: string[] };
}

/**
 * A terminal that can never again host a retained session: orphaned by a
 * pre-dispatch failure, or carrying a journaled close (closed, already gone,
 * or an intent whose outcome is unproven — it may be closed).
 */
function retiredTerminal(ctx: StepCtx, handle: string): boolean {
  if (ctx.preDispatchOrphans.has(handle)) return true;
  const c = ctx.terminalCloses.get(handle);
  return c !== undefined && c.outcome !== 'failed';
}

/** Corrective-attempt context handed to the spec builders (RepairContext). */
interface RepairSpec {
  /** The rejected attempt this repair corrects (journaled lineage). */
  repairOf: AttemptId;
  contract: string;
  diagnostics: string[];
  previousArtifactPath?: string;
  /** Run-artifact path holding the FULL exact diagnostics (bounded excerpt in `diagnostics`). */
  diagnosticsRef?: string;
}

type StepResult =
  | { kind: 'advance'; result: AdvanceResult }
  | { kind: 'error'; error: CouncilError };

function advanceResult(
  action: AdvanceResult['action'],
  status: RunStatus,
  note?: string,
  extra?: Partial<AdvanceResult>,
): StepResult {
  const result: AdvanceResult = { action, status };
  if (note !== undefined) result.note = note;
  Object.assign(result, extra);
  return { kind: 'advance', result };
}

function blocked(status: RunStatus, note: string): StepResult {
  return advanceResult('blocked', status, note);
}

// ─── Engine factory ──────────────────────────────────────────────────────────

export function createEngine(deps: EngineDeps): Engine {
  const { store, host, prompts } = deps;
  const now = () => deps.now?.() ?? new Date();

  const emit = (
    ctx: StepCtx,
    type: JournalEventType,
    payload?: Record<string, unknown>,
    extra?: { phase?: PhaseKind; round?: number; participantId?: ParticipantId; actor?: string },
  ): void => {
    const ev: Omit<JournalEvent, 'seq'> = {
      ts: ctx.now.toISOString(),
      type,
      actor: extra?.actor ?? 'engine',
    };
    if (extra?.phase !== undefined) ev.phase = extra.phase;
    if (extra?.round !== undefined) ev.round = extra.round;
    if (extra?.participantId !== undefined) ev.participantId = extra.participantId;
    if (payload !== undefined) ev.payload = payload;
    ctx.events.push(ev);
  };

  /**
   * Persist pending journal events, then state. Called before every host
   * mutation. Journal FIRST: it is the durable record of issued intents and
   * observed effects; state.json is a reconcilable projection — a crash after
   * the append but before saveState is recovered by observation, while the
   * reverse order could orphan unjournaled state mutations. Events are
   * drained only after a successful append so a failed flush never silently
   * drops the guard events they carry.
   */
  const flush = async (ctx: StepCtx): Promise<Result<void>> => {
    if (ctx.events.length > 0) {
      const j = await store.appendJournal(ctx.events);
      if (!j.ok) return j;
      ctx.events.splice(0);
    }
    const s = await store.saveState(ctx.state);
    if (!s.ok) return s;
    return ok(undefined);
  };

  const abs = (rel: string): string => join(store.runDir, rel);

  // ── Managed-artifact integrity (receipts-v1) ───────────────────────────────
  //
  // Write order for every managed write: bytes → integrity index → journal
  // event carrying receiptJournalFields → flush (journal + state). The
  // journal is authoritative; the index is its projection. A crash between
  // index record and flush leaves an index-only orphan — invisible to the
  // journal-authoritative ctx.receipts map — which idempotent replay heals
  // (identical bytes re-record to the same receipt).

  /**
   * Runner-managed write with an exact-byte receipt on v1; plain write on
   * legacy runs (they stay honestly untracked). Returns the minted receipt
   * so the caller can merge receiptJournalFields into its journal event.
   */
  const mintedWrite = async (
    ctx: StepCtx,
    rel: string,
    bytes: string,
    category: ReceiptCategory,
  ): Promise<Result<{ receipt?: ArtifactReceipt }>> => {
    if (ctx.integrity !== 'receipts-v1') {
      const w = await store.writeArtifact(rel, bytes);
      if (!w.ok) return w as Result<never>;
      return ok({});
    }
    const r = await recordManagedWrite(store, rel, bytes, category, {
      prior: ctx.receipts,
      now: ctx.now,
    });
    if (!r.ok) return r as Result<never>;
    // Fold the returned receipt into the working journal-authoritative map
    // from the bytes at hand — never a re-read (no read/write race).
    ctx.receipts.set(rel, r.value.receipt);
    if (r.value.indexAnomaly !== undefined) {
      emit(ctx, 'error', { op: 'integrity-index', detail: r.value.indexAnomaly });
    }
    return ok({ receipt: r.value.receipt });
  };

  /**
   * Read a managed artifact and verify exact bytes against the
   * journal-authoritative receipt map. 'ok' or legacy-'untracked' pass;
   * 'mismatch'/'missing'/v1-'untracked' are visible integrity violations —
   * the caller journals + fails closed, never silently downgrades.
   */
  const verifiedRead = async (
    ctx: StepCtx,
    rel: string,
  ): Promise<Result<{ text: string; verdict: 'ok' | 'mismatch' | 'missing' | 'untracked' }>> => {
    const v = await readVerifiedArtifact(store, rel, { receipts: ctx.receipts });
    if (!v.ok) return v as Result<never>;
    const status = v.value.verdict.status;
    if (
      status === 'ok' ||
      (status === 'untracked' && ctx.integrity !== 'receipts-v1')
    ) {
      return ok({ text: v.value.text, verdict: status });
    }
    return failRes(
      err('untrusted_output', `integrity verification failed for ${rel}: ${status}`, {
        details: {
          reason: 'integrity_violation',
          path: rel,
          verdict: status,
          ...(v.value.verdict.actualSha256 !== undefined ? { actualSha256: v.value.verdict.actualSha256 } : {}),
          ...(v.value.verdict.receipt !== undefined ? { recordedSha256: v.value.verdict.receipt.sha256 } : {}),
        },
      }),
    );
  };

  const integrityViolation = (ctx: StepCtx, rel: string, e: CouncilError): void => {
    emit(ctx, 'error', {
      op: 'integrity-verify',
      path: rel,
      detail: e.message,
      ...(typeof e.details?.verdict === 'string' ? { verdict: e.details.verdict } : {}),
    });
  };

  /**
   * Envelope authorization — journaled assignedIds only (never worker-
   * editable envelope bytes). A journaled envelope.built without assignedIds
   * is a legacy artifact: verify its bytes on v1, pass through on legacy.
   * Absent envelope ⇒ nothing was ever assigned ⇒ empty set.
   */
  const envelopeAssignedIds = async (ctx: StepCtx, envRel: string): Promise<Result<Set<string>>> => {
    const journaled = ctx.envelopeAssigned.get(envRel);
    if (journaled !== undefined) return ok(new Set(journaled));
    if (ctx.legacyEnvelopes.has(envRel)) {
      const v = await verifiedRead(ctx, envRel);
      if (!v.ok) return v as Result<never>;
      let raw: unknown;
      try {
        raw = JSON.parse(v.value.text);
      } catch {
        return failRes(err('untrusted_output', `legacy envelope ${envRel} is not valid JSON`));
      }
      const assignments = (raw as { assignments?: unknown[] }).assignments ?? [];
      const out = new Set<string>();
      for (const a of assignments) {
        const o = a as { claimId?: unknown; challenges?: { challengeId?: unknown }[] };
        if (typeof o.claimId === 'string') out.add(o.claimId);
        for (const c of o.challenges ?? []) {
          if (typeof c.challengeId === 'string') out.add(c.challengeId);
        }
      }
      return ok(out);
    }
    return ok(new Set());
  };

  // ── Participant / attempt helpers ──────────────────────────────────────────

  const findParticipant = (state: CouncilState, pid: ParticipantId): Participant | undefined =>
    state.participants.find((p) => p.participantId === pid);

  const reviewers = (state: CouncilState): Participant[] =>
    state.participants.filter((p) => p.role === 'reviewer');

  const attemptsFor = (p: Participant, phase: PhaseKind, round: number | null = null): PhaseAttempt[] =>
    p.attempts.filter((a) => a.phase === phase && a.round === round);

  const makeParticipant = (
    pid: ParticipantId,
    role: Participant['role'],
    agent: AgentChoice,
    seatId: string | null,
    perspectiveId: string | null,
  ): Participant => ({
    participantId: pid,
    role,
    seatId,
    perspectiveId,
    agent,
    retainedTerminal: null,
    attempts: [],
    status: 'planned',
  });

  const addPlannedAttempt = (p: Participant, phase: PhaseKind, round: number | null): PhaseAttempt => {
    const idx = attemptsFor(p, phase, round).length;
    // ID_RE-safe: only [A-Za-z0-9._-]; also keeps derived spec filenames legal
    // on every filesystem (no ':').
    const attemptId = `att_${p.participantId}_${phase}_r${round ?? 0}_${idx}`;
    const attempt: PhaseAttempt = {
      attemptId,
      participantId: p.participantId,
      phase,
      round,
      taskId: null,
      dispatchId: null,
      terminalHandle: null,
      launchIntentId: `li_${attemptId}`,
      status: 'planned',
      createdAt: now().toISOString(),
      artifacts: [],
    };
    p.attempts.push(attempt);
    return attempt;
  };

  /**
   * Idempotent stage-entry mints (clm_0007): every phase-entry seed site
   * creates exactly ONE base participant/attempt per id/tuple — but after an
   * append-ok/save-fail the journal overlay has already re-materialized them.
   * Pushing a second participant object or minting a second base attempt is
   * the exact defect the council reproduced (duplicate task+launch per seat).
   * Repair/fallback mints stay the ONLY legitimate extra attempts per tuple
   * and never go through these helpers.
   */
  const ensureParticipant = (
    state: CouncilState,
    pid: ParticipantId,
    role: Participant['role'],
    agent: AgentChoice,
    seatId: string | null,
    perspectiveId: string | null,
  ): Participant => {
    const existing = findParticipant(state, pid);
    if (existing !== undefined) return existing;
    const p = makeParticipant(pid, role, agent, seatId, perspectiveId);
    state.participants.push(p);
    return p;
  };

  const ensureStageAttempt = (p: Participant, phase: PhaseKind, round: number | null): PhaseAttempt =>
    attemptsFor(p, phase, round)[0] ?? addPlannedAttempt(p, phase, round);

  /**
   * Attempts occupying a concurrency slot: any whose worker might still be
   * physically running (dispatched/working/timed_out) or whose launch was
   * never disproven (intent_recorded/unknown). A slot is released only when
   * observation or a confirmed stop proves the worker settled/dead.
   */
  const slotHoldingAttempts = (state: CouncilState): PhaseAttempt[] =>
    state.participants.flatMap((p) => p.attempts.filter((a) => SLOT_HOLDING_ATTEMPT.has(a.status)));

  const expectedOutputPath = (attempt: PhaseAttempt): string => {
    const pid = attempt.participantId;
    switch (attempt.phase) {
      case 'organiser':
        return paths.organiserOut;
      case 'independent_review':
        return paths.findingsOut(pid);
      case 'scribe_notes':
        return paths.scribeNotesOut;
      case 'challenge':
        return paths.challengeOut(pid, attempt.round ?? 1);
      case 'author_response':
        return paths.responseOut(pid, attempt.round ?? 1);
      case 'scribe_synthesis':
        return paths.scribeReportJson;
    }
  };

  // ── Observation ────────────────────────────────────────────────────────────

  /**
   * Recover custody of an 'unknown' launch that has no dispatchId. First
   * probe the retained requestId via requestShow (journaled as evidence);
   * then scan the host worker-list for exactly one worker bound to this
   * attempt's task. A unique match is adopted — its dispatch becomes
   * observable like any launched attempt. Zero or ambiguous matches stay
   * 'unknown'; nothing here ever mutates the host.
   */
  const adoptUnknownDispatch = async (
    ctx: StepCtx,
    p: Participant,
    attempt: PhaseAttempt,
  ): Promise<void> => {
    if (attempt.taskId === null) return;
    if (attempt.requestId !== undefined && typeof host.requestShow === 'function') {
      const req = await host.requestShow({ requestId: attempt.requestId });
      emit(ctx, 'mail.observed', {
        attemptId: attempt.attemptId,
        scope: 'request-show',
        requestId: attempt.requestId,
        observation: req.ok ? req.value.state : 'error',
        ...(req.ok ? {} : { error: req.error.message }),
      }, { participantId: p.participantId, phase: attempt.phase });
    }
    if (typeof host.listWorkers !== 'function') return;
    const listed = await host.listWorkers({ runId: ctx.state.orcaRunId! });
    if (!listed.ok) {
      emit(ctx, 'mail.observed', {
        attemptId: attempt.attemptId,
        scope: 'worker-list',
        observation: 'error',
        error: listed.error.message,
      }, { participantId: p.participantId, phase: attempt.phase });
      return;
    }
    const rowTask = (w: WorkerListRow): unknown => w.taskId ?? w.task ?? w.task_id;
    const matches = listed.value.workers.filter((w) => rowTask(w) === attempt.taskId);
    if (matches.length !== 1) return; // zero or ambiguous — stays 'unknown'
    const row = matches[0];
    attempt.dispatchId = row.dispatchId;
    const th = row.terminalHandle ?? row.terminal;
    if (typeof th === 'string' && th.length > 0) {
      attempt.terminalHandle = th;
      if (p.retainedTerminal === null) p.retainedTerminal = th;
    }
    emit(ctx, 'launch.resume', {
      attemptId: attempt.attemptId,
      resolution: 'adopted-dispatch',
      dispatchId: attempt.dispatchId,
      taskId: attempt.taskId,
    }, { participantId: p.participantId, phase: attempt.phase });
  };

  /**
   * Observe every launched attempt once; updates attempt status in place.
   * Timed-out attempts keep being observed: their workers may still be
   * running, and a proven finish is what releases their concurrency slot.
   */
  const reconcileAttempts = async (ctx: StepCtx): Promise<void> => {
    for (const p of ctx.state.participants) {
      for (const attempt of p.attempts) {
        const observable = ACTIVE_ATTEMPT.has(attempt.status) || attempt.status === 'timed_out';
        if (!observable) continue;
        if (attempt.dispatchId === null) {
          // 'unknown' without a dispatch: the launch receipt never arrived —
          // but the worker may have landed. Recover custody through the
          // documented READ APIs only (requestShow evidence + worker-list
          // adoption). A unique match is adopted as an ordinary dispatch;
          // anything else stays unknown — never relaunched blind.
          if (attempt.status === 'unknown') await adoptUnknownDispatch(ctx, p, attempt);
          if (attempt.dispatchId === null) continue;
        }
        const obs = await host.observeWorker({ dispatchId: attempt.dispatchId });
        if (!obs.ok) {
          emit(ctx, 'mail.observed', {
            attemptId: attempt.attemptId,
            dispatchId: attempt.dispatchId,
            observation: 'error',
            error: obs.error.message,
          });
          continue;
        }
        const o = obs.value;
        if (o.liveness === 'finished') {
          const taskStatus = (o.taskStatus ?? '').toLowerCase();
          const failed = /fail|error|cancel|stop|abandon/.test(taskStatus);
          attempt.status = failed ? 'settled_failed' : 'settled_ok';
          attempt.settledAt = ctx.now.toISOString();
          emit(ctx, 'worker.settled', {
            attemptId: attempt.attemptId,
            dispatchId: attempt.dispatchId,
            outcome: failed ? 'failed' : 'settled_ok',
            taskStatus: o.taskStatus,
          }, { participantId: p.participantId, phase: attempt.phase, ...(attempt.round !== null ? { round: attempt.round } : {}) });
          if (attempt.status === 'settled_failed') p.status = 'failed';
        } else if (o.liveness === 'working' || o.liveness === 'waiting_human') {
          if (attempt.status === 'timed_out') {
            // Past-deadline worker confirmed alive — keep the timed_out mark
            // and the held slot; the observation itself is the evidence.
            emit(ctx, 'mail.observed', {
              attemptId: attempt.attemptId,
              dispatchId: attempt.dispatchId,
              observation: 'alive',
              liveness: o.liveness,
              detail: 'worker still running past phase deadline — slot held',
            }, { participantId: p.participantId, phase: attempt.phase });
          } else if (attempt.status !== 'working') {
            attempt.status = 'working';
            emit(ctx, 'worker.started', {
              attemptId: attempt.attemptId,
              dispatchId: attempt.dispatchId,
              liveness: o.liveness,
            }, { participantId: p.participantId, phase: attempt.phase });
          }
        } else if (o.liveness === 'unverifiable') {
          emit(ctx, 'mail.observed', {
            attemptId: attempt.attemptId,
            dispatchId: attempt.dispatchId,
            observation: 'unverifiable',
            detail: o.detail,
          });
        }
        // 'idle' / 'finished'-less states leave the attempt as dispatched.
      }
      // Participant aggregate status.
      const allTerminal = p.attempts.length > 0 && p.attempts.every((a) => TERMINAL_ATTEMPT.has(a.status));
      if (allTerminal && p.status !== 'failed' && p.status !== 'timed_out' && p.status !== 'stopped') {
        p.status = p.attempts.some((a) => a.status === 'timed_out')
          ? 'timed_out'
          : p.attempts.some((a) => a.status === 'settled_ok')
            ? 'settled'
            : 'failed';
      }
    }
  };

  // ── Deadlines (checked on advance only) ────────────────────────────────────

  const phaseDeadlineMs = (state: CouncilState): number | undefined => {
    const d = state.config.deadlines;
    switch (state.status) {
      case 'organising': return d.organiserMs;
      case 'independent_review': return d.independentMs;
      case 'scribe_notes': return d.scribeNotesMs;
      case 'discussing':
        return state.discussion?.stage === 'responses' ? d.responseMs : d.challengeMs;
      case 'synthesising': return d.synthesisMs;
      default: return undefined;
    }
  };

  /**
   * Best-effort stop for an attempt whose worker may still be running. The
   * request is journaled with its honest outcome — a confirmed stop upgrades
   * the attempt to 'stopped' and frees its slot; anything less leaves the
   * status untouched and the slot held. One request per attempt per run
   * (durable via the journal), never claimed as proof unless confirmed.
   */
  const requestDeadlineStop = async (
    ctx: StepCtx,
    p: Participant,
    a: PhaseAttempt,
    scope: 'run' | 'phase',
  ): Promise<void> => {
    if (a.dispatchId === null || ctx.stopRequestedAttempts.has(a.attemptId)) return;
    ctx.stopRequestedAttempts.add(a.attemptId);
    // RA-008 mutation custody: the intent must be durable BEFORE the host
    // call — a crash between issue and outcome journal would otherwise
    // re-issue the stop blind on the next advance.
    emit(ctx, 'worker.stop_requested', {
      attemptId: a.attemptId,
      dispatchId: a.dispatchId,
      outcome: 'intent',
      scope: `${scope}_deadline`,
      reason: `${scope} deadline exceeded`,
    }, { participantId: p.participantId, phase: a.phase });
    const fi = await flush(ctx);
    if (!fi.ok) {
      emit(ctx, 'error', {
        op: 'stop-request',
        attemptId: a.attemptId,
        detail: `stop intent could not be journaled (${fi.error.message}); not issuing requestStop without custody`,
      }, { participantId: p.participantId, phase: a.phase });
      return;
    }
    const r = await host.requestStop({ dispatchId: a.dispatchId, reason: `${scope} deadline exceeded` });
    const outcome = r.ok ? r.value.outcome : 'error';
    emit(ctx, 'worker.stop_requested', {
      attemptId: a.attemptId,
      dispatchId: a.dispatchId,
      outcome,
      scope: `${scope}_deadline`,
      note: 'best-effort stop after deadline — not claimed proof of exit',
      ...(r.ok ? {} : { error: r.error.message }),
    }, { participantId: p.participantId, phase: a.phase });
    if (outcome === 'stopped') {
      a.status = 'stopped';
      a.settledAt = ctx.now.toISOString();
      emit(ctx, 'worker.stopped', { attemptId: a.attemptId, dispatchId: a.dispatchId },
        { participantId: p.participantId, phase: a.phase });
    }
  };

  /** Mark overdue work timed_out and stop it best-effort; true on run death. */
  const enforceDeadlines = async (ctx: StepCtx): Promise<boolean> => {
    const { state } = ctx;
    const elapsedRun = ctx.now.getTime() - Date.parse(state.createdAt);
    if (elapsedRun > state.config.deadlines.runMs) {
      for (const p of state.participants) {
        for (const a of p.attempts) {
          if (a.status === 'dispatched' || a.status === 'working') {
            a.status = 'timed_out';
            a.settledAt = ctx.now.toISOString();
            await requestDeadlineStop(ctx, p, a, 'run');
          } else if (a.status === 'unknown') {
            // Launch outcome never resolved — keep 'unknown', ask for a stop.
            await requestDeadlineStop(ctx, p, a, 'run');
          } else if (a.status === 'planned' || a.status === 'intent_recorded') {
            a.status = 'timed_out';
            a.settledAt = ctx.now.toISOString();
          }
        }
      }
      state.status = 'failed';
      emit(ctx, 'deadline.hit', { scope: 'run', elapsedMs: elapsedRun });
      emit(ctx, 'run.finished', { outcome: 'failed', reason: 'run deadline exceeded' });
      return true;
    }
    const phaseMs = phaseDeadlineMs(state);
    if (phaseMs === undefined) return false;
    const elapsed = ctx.now.getTime() - Date.parse(state.phaseEnteredAt);
    if (elapsed <= phaseMs + state.config.deadlines.graceMs) return false;
    let hit = false;
    for (const p of state.participants) {
      for (const a of p.attempts) {
        if (a.status === 'dispatched' || a.status === 'working') {
          a.status = 'timed_out';
          a.settledAt = ctx.now.toISOString();
          p.status = 'timed_out';
          emit(ctx, 'worker.timed_out', {
            attemptId: a.attemptId,
            dispatchId: a.dispatchId,
            elapsedMs: elapsed,
          }, { participantId: p.participantId, phase: a.phase });
          await requestDeadlineStop(ctx, p, a, 'phase');
          hit = true;
        } else if (a.status === 'planned' || a.status === 'intent_recorded') {
          a.status = 'timed_out';
          a.settledAt = ctx.now.toISOString();
          p.status = 'timed_out';
          emit(ctx, 'worker.timed_out', {
            attemptId: a.attemptId,
            dispatchId: a.dispatchId,
            elapsedMs: elapsed,
          }, { participantId: p.participantId, phase: a.phase });
          hit = true;
        } else if (a.status === 'unknown' && a.dispatchId !== null) {
          // Outcome still unresolved: request an honest stop; the attempt
          // stays 'unknown' (slot held) unless the host confirms the stop.
          await requestDeadlineStop(ctx, p, a, 'phase');
          hit = true;
        }
      }
    }
    if (hit) {
      emit(ctx, 'deadline.hit', {
        scope: 'phase',
        status: state.status,
        stage: ctx.state.discussion?.stage,
        elapsedMs: elapsed,
        deadlineMs: phaseMs,
      });
    }
    return false;
  };

  // ── Execution policy gate (see module-level boundary note) ─────────────────

  /**
   * Returns the injected policy when the run binds a fingerprint, `null` on
   * the legacy path, or an error that MUST stop the caller before any host
   * mutation.
   */
  const executionPolicy = (state: CouncilState): Result<ExecutionPolicy | null> => {
    if (state.config.execution === undefined) return ok(null);
    const pol = deps.execution;
    if (pol === undefined) {
      return failRes(
        err('config_invalid', 'config binds an execution fingerprint but no EngineDeps.execution was injected — refusing all host mutations'),
      );
    }
    if (pol.policyHash !== state.config.execution.policyHash) {
      return failRes(
        err('config_invalid', `execution policy hash mismatch: config binds ${state.config.execution.policyHash}, injected policy is ${pol.policyHash} — refusing all host mutations`),
      );
    }
    return ok(pol);
  };

  /** The effective staff AgentChoice for a role — explicit staff, else the legacy Devin pin. */
  const staffAgent = (state: CouncilState, role: 'organiser' | 'scribe' | 'supervisor'): AgentChoice =>
    state.config.staff?.[role] ?? COUNCIL_STAFF_AGENT;

  /** Every staff role's effective choice must be policy-launchable before any host mutation. */
  const validateStaff = (state: CouncilState, pol: ExecutionPolicy): Result<void> => {
    for (const role of ['organiser', 'scribe', 'supervisor'] as const) {
      const v = pol.validateChoice(staffAgent(state, role));
      if (!v.ok) {
        return failRes(err('config_invalid', `staff.${role} rejected by execution policy: ${v.error.message}`));
      }
    }
    return ok(undefined);
  };

  // ── Approval revalidation (before every launch past the gate) ─────────────

  /**
   * Rebuild the approval binding from *current* persisted artifacts and
   * compare with the stored hash, then check live source drift.
   * Binding mismatch → approval invalidated, hash cleared, re-approval allowed.
   * Snapshot drift → blocked until a new snapshot exists; hash retained.
   */
  const revalidateApproval = async (ctx: StepCtx): Promise<Result<void>> => {
    const { state } = ctx;
    if (state.approvalHash === null) {
      return failRes(err('approval_required', 'no approval bound to this run'));
    }
    const [appr, rosterR, proposedR, snapR] = await Promise.all([
      store.readApproval(),
      store.readApprovedRoster(),
      store.readProposedRoster(),
      store.readSnapshot(),
    ]);
    if (!appr.ok || !rosterR.ok || !proposedR.ok || !snapR.ok) {
      return failRes(
        err('approval_stale', 'approval artifacts unreadable; cannot revalidate', {
          details: {
            approval: appr.ok ? 'ok' : appr.error.message,
            roster: rosterR.ok ? 'ok' : rosterR.error.message,
            proposed: proposedR.ok ? 'ok' : proposedR.error.message,
            snapshot: snapR.ok ? 'ok' : snapR.error.message,
          },
        }),
      );
    }
    const binding = buildApprovalBinding(state, rosterR.value, proposedR.value, snapR.value);
    const recomputed = canonicalApprovalHash(binding);
    if (recomputed !== state.approvalHash || recomputed !== appr.value.record.hash) {
      state.approvalHash = null;
      emit(ctx, 'approval.invalidated', {
        reason: 'binding_mismatch',
        approvalId: appr.value.record.approvalId,
        expected: appr.value.record.hash,
        recomputed,
      });
      return failRes(
        err('approval_stale', 'approval binding no longer matches persisted artifacts; re-approval required'),
      );
    }
    ctx.approvedRoster = rosterR.value;
    // One drift verdict per advance — launches and finalize share it rather
    // than re-scanning the live tree for every attempt.
    if (ctx.driftResult === undefined) ctx.driftResult = await store.verifySourceSnapshot();
    const drift = ctx.driftResult;
    if (!drift.ok) {
      return failRes(
        err('snapshot_drift', `source snapshot verification failed: ${drift.error.message}`),
      );
    }
    if (drift.value.drift) {
      // Approval binds the snapshot manifest. Changed/deleted pinned files
      // invalidate the review corpus → block. Files merely added under the
      // target after the snapshot are not part of the bound corpus — reviewers
      // cannot cite them (evidence validation rejects non-manifest paths) —
      // so they are journaled as visible growth, not a launch blocker.
      const pinned = new Set(Object.keys(snapR.value.files));
      const manifestChanged = drift.value.changed.filter((p) => pinned.has(p));
      const added = drift.value.changed.filter((p) => !pinned.has(p));
      if (added.length > 0) {
        emit(ctx, 'snapshot.drift', { scope: 'added', added, blocking: false });
      }
      if (manifestChanged.length > 0) {
        emit(ctx, 'snapshot.drift', { scope: 'manifest', changed: manifestChanged, blocking: true });
        return failRes(
          err('snapshot_drift', 'reviewed source changed since approval; pinned snapshots are immutable — create a new run to review the new state', {
            details: { changed: manifestChanged, added },
          }),
        );
      }
    }
    return ok(undefined);
  };

  /**
   * Full AgentChoice equality — the launch-time bound-choice check (clm_0002 /
   * rev-04): `profile` is compared, unlike the legacy staff/supervisor gate.
   */
  const agentChoiceEqual = (a: AgentChoice, b: AgentChoice): boolean =>
    a.agent === b.agent &&
    a.model === b.model &&
    (a.effort ?? null) === (b.effort ?? null) &&
    (a.permissionMode ?? null) === (b.permissionMode ?? null) &&
    (a.profile ?? null) === (b.profile ?? null);

  /**
   * The AgentChoice a participant is bound to: reviewers → their approved
   * seat choice from the verified roster; staff → the approved config's
   * staff choice. 'unbound' means a reviewer without a matching seat —
   * a launch blocker. undefined means "no binding applies" (organiser).
   */
  const boundAgentChoice = (ctx: StepCtx, p: Participant): AgentChoice | 'unbound' | undefined => {
    if (p.role === 'reviewer') {
      const seat = ctx.approvedRoster?.seats.find((s) => s.participantId === p.participantId);
      return seat === undefined ? 'unbound' : seat.agent;
    }
    if (p.role === 'scribe') return staffAgent(ctx.state, 'scribe');
    return undefined; // organiser — staff choice comes from the same config
  };

  /**
   * RA-006: adapter errors carry custody evidence in `details` — the Orca
   * requestId (for `council reconcile` / request-show) and `uncertain` (the
   * mutation may have landed). Forward both onto journaled error events so
   * the replay can stage them truthfully: uncertain ⇒ 'issued', never a
   * proven no-effect refusal.
   */
  const adapterEvidence = (e: CouncilError): Record<string, unknown> => {
    const d = (e.details ?? {}) as Record<string, unknown>;
    return {
      ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
      ...(d.uncertain === true ? { uncertain: true } : {}),
    };
  };

  // ── Launch machinery ───────────────────────────────────────────────────────

  const specFor = (ctx: StepCtx, p: Participant, attempt: PhaseAttempt): { spec: string; outRel: string } | null => {
    const { state } = ctx;
    const promptCtx = {
      runId: state.runId,
      runDir: store.runDir,
      targetRoot: state.targetRoot,
      objective: state.objective,
      snapshotId: state.snapshotId ?? ctx.snapshot?.snapshotId ?? '',
      config: state.config,
    };
    const outRel = expectedOutputPath(attempt);
    const outAbs = abs(outRel);
    // Corrective-attempt context (bounded validator diagnostics + archived
    // rejected artifact path), journaled at rejection time so a restart
    // rebuilds the identical spec. Passed through to all six spec builders
    // as the optional `repair` input — never present on first attempts.
    const rs = ctx.repairByAttempt.get(attempt.attemptId);
    const repair = rs !== undefined
      ? {
          contract: rs.contract,
          diagnostics: rs.diagnosticsRef !== undefined
            ? [...rs.diagnostics, `full diagnostics archived at: ${rs.diagnosticsRef}`]
            : rs.diagnostics,
          ...(rs.previousArtifactPath !== undefined ? { previousArtifactPath: rs.previousArtifactPath } : {}),
        }
      : undefined;
    const withRepair = <T extends object>(input: T): T & { repair?: typeof repair } => {
      if (repair !== undefined) (input as { repair?: typeof repair }).repair = repair;
      return input as T & { repair?: typeof repair };
    };
    switch (attempt.phase) {
      case 'organiser':
        return { spec: prompts.organiser(promptCtx, withRepair({ participantId: p.participantId, outputPath: outAbs })), outRel };
      case 'independent_review': {
        const perspective = ctx.perspectives?.get(p.perspectiveId ?? '');
        if (perspective === undefined) return null;
        return {
          spec: prompts.reviewerIndependent(promptCtx, withRepair({
            participantId: p.participantId,
            perspective,
            outputPath: outAbs,
          })),
          outRel,
        };
      }
      case 'scribe_notes':
        return {
          spec: prompts.scribeNotes(promptCtx, withRepair({
            participantId: p.participantId,
            admittedFindingsPaths: ctx.admittedFindingsPaths ?? [],
            outputPath: outAbs,
          })),
          outRel,
        };
      case 'challenge':
        return {
          spec: prompts.challenge(promptCtx, withRepair({
            participantId: p.participantId,
            envelopePath: abs(paths.challengeEnv(p.participantId, attempt.round ?? 1)),
            outputPath: outAbs,
          })),
          outRel,
        };
      case 'author_response':
        return {
          spec: prompts.authorResponse(promptCtx, withRepair({
            participantId: p.participantId,
            envelopePath: abs(paths.responseEnv(p.participantId, attempt.round ?? 1)),
            outputPath: outAbs,
          })),
          outRel,
        };
      case 'scribe_synthesis': {
        const input = withRepair({
          participantId: p.participantId,
          ledgerPath: abs(paths.ledger),
          journalPath: abs('events.jsonl'),
          reportJsonPath: abs(paths.scribeReportJson),
          reportMdPath: abs(paths.scribeReportMd),
          summaryPath: abs(paths.scribeSummary),
        });
        // Admitted scribe notes become EXPLICIT synthesis input (clm_0021):
        // narrative context only — never authoritative claims or consensus.
        (input as { notesPath?: string }).notesPath = abs(paths.scribeNotesOut);
        return {
          spec: prompts.scribeSynthesis(promptCtx, input),
          outRel,
        };
      }
    }
  };

  interface LaunchOutcome {
    kind: 'launched' | 'failed' | 'unknown' | 'task_error' | 'budget' | 'approval' | 'concurrency' | 'policy';
    error?: CouncilError;
    note?: string;
  }

  /**
   * Crash-window resolution for an attempt whose launch.intent is persisted
   * but whose receipts never reached the journal/state. The durable stage
   * chronology decides whether the host is even consulted:
   *  - 'never' (v2 intent, no marker) or 'refused' (journaled definitive
   *    refusal) → proceed without any host read;
   *  - 'uncertain' (issued but unreceipted, or a legacy pre-marker intent) →
   *    OBSERVATION ONLY through the documented read APIs: exactly one
   *    EXACT-identity host record → ADOPT it; zero / ambiguous / malformed /
   *    unobservable → the attempt becomes 'unknown' and blocks — a listing
   *    can never prove no-effects, so a blind retry could duplicate a
   *    landed mutation.
   */
  const resolveRecordedIntent = async (
    ctx: StepCtx,
    p: Participant,
    attempt: PhaseAttempt,
  ): Promise<{ kind: 'proceed' } | { kind: 'adopted' } | { kind: 'predispatch'; handle: string } | { kind: 'blocked'; outcome: LaunchOutcome }> => {
    const block = (reason: string, detail: Record<string, unknown>): { kind: 'blocked'; outcome: LaunchOutcome } => {
      attempt.status = 'unknown';
      emit(ctx, 'worker.unknown', {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        requestId: attempt.requestId,
        detail: reason,
      }, { participantId: p.participantId, phase: attempt.phase });
      emit(ctx, 'launch.resume', {
        attemptId: attempt.attemptId,
        resolution: 'blocked',
        reason,
        ...detail,
      }, { participantId: p.participantId, phase: attempt.phase });
      return {
        kind: 'blocked',
        outcome: {
          kind: 'unknown',
          error: err('launch_unknown', `${reason} — reconcile before continuing; never relaunch`, {
            details: { attemptId: attempt.attemptId, taskId: attempt.taskId, requestId: attempt.requestId, ...detail },
          }),
        },
      };
    };
    const resumeOk = async (resolution: string, detail: Record<string, unknown>): Promise<{ kind: 'proceed' } | { kind: 'blocked'; outcome: LaunchOutcome }> => {
      emit(ctx, 'launch.resume', { attemptId: attempt.attemptId, resolution, ...detail },
        { participantId: p.participantId, phase: attempt.phase });
      const f = await flush(ctx);
      if (!f.ok) return { kind: 'blocked', outcome: { kind: 'task_error', error: f.error } };
      return { kind: 'proceed' };
    };

    /**
     * Durable chronology for one host mutation: 'uncertain' when the last
     * journaled stage entry is an issue marker with no outcome, 'refused'
     * when a definitive no-effect refusal was receipted most recently, and
     * 'never' only when a v2+ launch intent proves the marker scheme was in
     * force yet no marker exists — a legacy (pre-marker) intent_recorded
     * attempt can have invoked the host, so its absent marker proves nothing.
     */
    const opStage = (op: 'task-create' | 'worker-launch'): 'uncertain' | 'refused' | 'never' => {
      const stage = (op === 'task-create' ? ctx.taskCreateStage : ctx.workerLaunchStage).get(attempt.attemptId);
      if (stage === 'issued') return 'uncertain';
      if (stage === 'refused') return 'refused';
      return (ctx.intentProtocol.get(attempt.attemptId) ?? 1) >= 2 ? 'never' : 'uncertain';
    };

    if (attempt.taskId === null) {
      const st = opStage('task-create');
      if (st !== 'uncertain') {
        return resumeOk('no-issue-marker', { op: 'task-create', detail: st === 'never' ? 'v2 intent proves createTask was never issued' : 'journaled definitive refusal resolves createTask outcome' });
      }
      // Issued with no journaled outcome — UNCERTAIN. A zero listing can
      // never prove no-effects (host ledgers prune / lag), so it stays
      // blocked; only a unique EXACT-spec task with a valid id is adopted.
      if (typeof host.listTasks !== 'function') {
        return block('task-create outcome unobservable (adapter lacks listTasks)', { op: 'task-create' });
      }
      const specAbs = abs(paths.spec(attempt.attemptId));
      const listed = await host.listTasks({ runId: ctx.state.orcaRunId! });
      if (!listed.ok) {
        return block(`task-create outcome unobservable: ${listed.error.message}`, { op: 'task-create' });
      }
      const rowSpec = (t: TaskListRow): unknown => t.specFile ?? t.specFilePath ?? t.spec;
      // An unidentifiable row could BE the landed task — the read cannot
      // prove a zero-match, so it cannot authorize anything.
      if (listed.value.tasks.some((t) => rowSpec(t) === undefined || rowSpec(t) === null)) {
        return block('task-create outcome unobservable: task-list rows lack spec identity', { op: 'task-create' });
      }
      // Exact identity only: never title-only or suffix-only alias identity.
      const matches = listed.value.tasks.filter((t) => rowSpec(t) === specAbs);
      if (matches.length === 0) {
        return block('task-create issued but no host record found — outcome uncertain; reconcile via documented reads or council reconcile', { op: 'task-create' });
      }
      if (matches.length > 1) {
        return block('task-create outcome ambiguous: multiple host tasks share this attempt spec', {
          op: 'task-create',
          matches: matches.length,
        });
      }
      const taskId = matches[0].taskId ?? matches[0].id;
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return block('task-create adoption blocked: matched host task has no usable taskId', { op: 'task-create' });
      }
      attempt.taskId = taskId;
      emit(ctx, 'task.created', {
        attemptId: attempt.attemptId,
        taskId,
        scope: 'task',
        reconciled: 'adopted',
      }, { participantId: p.participantId, phase: attempt.phase });
      emit(ctx, 'launch.resume', { attemptId: attempt.attemptId, resolution: 'adopted-task', taskId },
        { participantId: p.participantId, phase: attempt.phase });
      const f = await flush(ctx);
      if (!f.ok) return { kind: 'blocked', outcome: { kind: 'task_error', error: f.error } };
      // Fall through — a task adoption does NOT prove the worker stage is
      // safe to issue; it must be resolved by the same stage chronology.
    }

    if (attempt.taskId !== null && attempt.dispatchId === null) {
      // Same stage-chronology rule for worker-start: only the MOST RECENT
      // durable stage entry counts — an older refusal cannot authorize a
      // retry whose newer issue marker lost its receipt.
      const st = opStage('worker-launch');
      if (st !== 'uncertain') {
        return resumeOk('no-issue-marker', { op: 'worker-launch', detail: st === 'never' ? 'v2 intent proves launchWorker was never issued' : 'journaled definitive refusal resolves launch outcome' });
      }
      // Terminal-create custody refinement (journaled BEFORE the mutation by
      // the adapter callback): a refused create proves the launch produced
      // no worker and no pre-attach resource — re-issuing is not a blind
      // duplicate. A created/uncertain receipt means the terminal may be
      // live: its handle is durable evidence, adopted into custody below,
      // and a missing dispatch keeps the attempt blocked — never re-create.
      const tcStage = ctx.terminalCreateStage.get(attempt.attemptId);
      if (tcStage === 'refused') {
        return resumeOk('terminal-create-refused', {
          op: 'worker-launch',
          detail: 'journaled terminal-create refusal proves no worker and no terminal landed — safe to re-issue launchWorker',
        });
      }
      const custody = ctx.terminalCustody.get(attempt.attemptId);
      // Dispatch-marker refinement: the journaled terminal-create receipt
      // carries the adapter's promise to journal a worker-start marker
      // BEFORE any worker-start onto that terminal. Receipt present + no
      // marker ⇒ worker-start was provably never issued (crash between
      // create and dispatch) — a definitive pre-dispatch failure, never a
      // blind relaunch. A marker without a receipt stays uncertain below.
      if (custody !== undefined && custody.dispatchMarker === true && !ctx.workerStartMarkers.has(attempt.attemptId)) {
        emit(ctx, 'launch.resume', {
          attemptId: attempt.attemptId,
          resolution: 'pre-dispatch-proven',
          terminalHandle: custody.handle,
          detail: 'terminal-create receipt journaled with a dispatch-marker promise and no worker-start marker — worker-start was never issued',
        }, { participantId: p.participantId, phase: attempt.phase });
        return { kind: 'predispatch', handle: custody.handle };
      }
      if (custody !== undefined && attempt.terminalHandle === null) {
        attempt.terminalHandle = custody.handle;
        if (p.retainedTerminal === null) p.retainedTerminal = custody.handle;
        if (attempt.requestId === undefined && custody.requestId !== undefined) {
          attempt.requestId = custody.requestId;
        }
      }
      if (typeof host.listWorkers !== 'function') {
        return block('worker-launch outcome unobservable (adapter lacks listWorkers)', { op: 'worker-launch' });
      }
      const listed = await host.listWorkers({ runId: ctx.state.orcaRunId! });
      if (!listed.ok) {
        return block(`worker-launch outcome unobservable: ${listed.error.message}`, { op: 'worker-launch' });
      }
      const rowTask = (w: WorkerListRow): unknown => w.taskId ?? w.task ?? w.task_id;
      if (listed.value.workers.some((w) => rowTask(w) === undefined || rowTask(w) === null)) {
        return block('worker-launch outcome unobservable: worker-list rows lack task ids', { op: 'worker-launch' });
      }
      const matches = listed.value.workers.filter((w) => rowTask(w) === attempt.taskId);
      if (matches.length === 0) {
        return block('worker-launch issued but no host record found — outcome uncertain; reconcile via documented reads or council reconcile', { op: 'worker-launch' });
      }
      if (matches.length > 1) {
        return block('worker-launch outcome ambiguous: multiple dispatches for this task', {
          op: 'worker-launch',
          matches: matches.length,
        });
      }
      const row = matches[0];
      if (typeof row.dispatchId !== 'string' || row.dispatchId.length === 0) {
        return block('worker-launch adoption blocked: matched worker has no usable dispatchId', { op: 'worker-launch' });
      }
      attempt.dispatchId = row.dispatchId;
      const th = row.terminalHandle ?? row.terminal;
      if (typeof th === 'string' && th.length > 0) {
        attempt.terminalHandle = th;
        if (p.retainedTerminal === null) p.retainedTerminal = th;
      }
      attempt.status = 'dispatched';
      ctx.state.consumption.launches += 1; // the launch landed — charge it once
      p.status = 'active';
      emit(ctx, 'worker.started', {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        dispatchId: attempt.dispatchId,
        terminalHandle: attempt.terminalHandle,
        agent: p.agent,
        reconciled: 'adopted',
      }, { participantId: p.participantId, phase: attempt.phase });
      emit(ctx, 'launch.resume', {
        attemptId: attempt.attemptId,
        resolution: 'adopted-dispatch',
        dispatchId: attempt.dispatchId,
      }, { participantId: p.participantId, phase: attempt.phase });
      const f = await flush(ctx);
      if (!f.ok) return { kind: 'blocked', outcome: { kind: 'task_error', error: f.error } };
      return { kind: 'adopted' };
    }
    // Both identities already recorded — the launch is live, nothing to
    // re-issue. Mark it dispatched so normal observation reconciles it.
    attempt.status = 'dispatched';
    emit(ctx, 'launch.resume', { attemptId: attempt.attemptId, resolution: 'already-dispatched', taskId: attempt.taskId, dispatchId: attempt.dispatchId },
      { participantId: p.participantId, phase: attempt.phase });
    const f = await flush(ctx);
    if (!f.ok) return { kind: 'blocked', outcome: { kind: 'task_error', error: f.error } };
    return { kind: 'adopted' };
  };

  /**
   * Bounded first-turn submission check after a FRESH launch whose
   * worker-start receipt did not observe turn start (Devin reports only
   * input_accepted). Only `unsubmitted` earns the single journaled
   * bare-Enter nudge; anything unresolved becomes a visible
   * launch.submit_unconfirmed warning — never a block or a failure.
   */
  const checkFirstTurnSubmission = async (
    ctx: StepCtx,
    p: Participant,
    attempt: PhaseAttempt,
    launch: { terminalHandle?: string; dispatchId?: string; turnStart?: string },
  ): Promise<void> => {
    const handle = launch.terminalHandle;
    const probeFn = host.probeSubmission?.bind(host);
    if (probeFn === undefined || handle === undefined || launch.turnStart === undefined || launch.turnStart === 'observed') {
      return;
    }
    const where = { participantId: p.participantId, phase: attempt.phase };
    const base = {
      attemptId: attempt.attemptId,
      terminalHandle: handle,
      ...(launch.dispatchId !== undefined ? { dispatchId: launch.dispatchId } : {}),
    };
    const probe = async (check: number): Promise<{ state: string; evidence: string }> => {
      const r = await probeFn({
        terminalHandle: handle,
        ...(launch.dispatchId !== undefined ? { dispatchId: launch.dispatchId } : {}),
      });
      const v = r.ok
        ? r.value
        : { state: 'inconclusive' as const, evidence: `probe_error:${r.error.code}`, samples: 0, elapsedMs: 0 };
      emit(ctx, 'launch.submit_check', {
        ...base,
        check,
        turnStart: launch.turnStart,
        state: v.state,
        evidence: v.evidence,
        samples: v.samples,
        elapsedMs: v.elapsedMs,
        ...(r.ok && r.value.signals !== undefined ? { signals: r.value.signals } : {}),
      }, where);
      return v;
    };
    const warn = (reason: string, v: { state: string; evidence: string }): void => {
      emit(ctx, 'launch.submit_unconfirmed', { ...base, reason, state: v.state, evidence: v.evidence }, where);
    };

    const first = await probe(1);
    if (first.state === 'started') {
      await flush(ctx);
      return;
    }
    if (first.state !== 'unsubmitted') warn('first_check_inconclusive', first);
    else if (ctx.submitNudgeIntents.has(attempt.attemptId)) warn('nudge_already_attempted', first);
    else if (host.submitPendingInput === undefined) warn('nudge_unsupported', first);
    else {
      const nudgeId = `sn_${crypto.randomUUID().slice(0, 12)}`;
      emit(ctx, 'launch.submit_nudge', { ...base, stage: 'intent', nudgeId }, where);
      const fi = await flush(ctx);
      if (!fi.ok) {
        warn('nudge_intent_unjournaled', first);
        return;
      }
      ctx.submitNudgeIntents.add(attempt.attemptId);
      const sent = await host.submitPendingInput({ terminalHandle: handle });
      emit(ctx, 'launch.submit_nudge', {
        ...base,
        stage: 'receipt',
        nudgeId,
        outcome: sent.ok ? sent.value.outcome : 'error',
        ...(sent.ok && sent.value.requestId !== undefined ? { requestId: sent.value.requestId } : {}),
        ...(sent.ok
          ? sent.value.detail !== undefined ? { detail: sent.value.detail.slice(0, 512) } : {}
          : { detail: sent.error.message.slice(0, 512) }),
      }, where);
      const second = await probe(2);
      if (second.state !== 'started') warn('still_unconfirmed_after_nudge', second);
    }
    await flush(ctx);
  };

  /**
   * Definitive pre-dispatch failure (worker-start provably never issued onto
   * a terminal this attempt created and journaled). The attempt is settled
   * failed with the orphan handle journaled, the orphan is closed under the
   * same journaled custody as terminal-state cleanup, and the seat earns
   * exactly ONE fresh relaunch per phase tuple — charged against maxLaunches
   * and bounded by the phase deadline like any launch. A second pre-dispatch
   * failure fails the seat; the run continues under its quorum rules.
   */
  const handlePreDispatchFailure = async (
    ctx: StepCtx,
    p: Participant,
    attempt: PhaseAttempt,
    info: { handle: string; stage: string; detail: string },
  ): Promise<LaunchOutcome> => {
    const where = { participantId: p.participantId, phase: attempt.phase };
    const tuple = repairKey(p.participantId, attempt.phase, attempt.round);
    const prior = new Set(ctx.preDispatchFailures.get(tuple) ?? []);
    prior.delete(attempt.attemptId);
    const retryAllowed = prior.size === 0;
    attempt.status = 'settled_failed';
    attempt.settledAt = ctx.now.toISOString();
    attempt.terminalHandle = info.handle;
    if (p.retainedTerminal === info.handle) p.retainedTerminal = null;
    ctx.preDispatchOrphans.add(info.handle);
    ctx.preDispatchFailures.set(tuple, new Set([...prior, attempt.attemptId]));
    const retry = retryAllowed ? addPlannedAttempt(p, attempt.phase, attempt.round) : undefined;
    if (retry !== undefined) {
      attempt.supersededBy = retry.attemptId;
      attempt.supersededReason = 'pre_dispatch';
    }
    const repairSpec = ctx.repairByAttempt.get(attempt.attemptId);
    if (retry !== undefined && repairSpec !== undefined) ctx.repairByAttempt.set(retry.attemptId, repairSpec);
    if (retry === undefined) p.status = 'failed';
    emit(ctx, 'worker.settled', {
      attemptId: attempt.attemptId,
      outcome: 'failed',
      preDispatch: true,
      workerStartIssued: false,
      stage: info.stage,
      terminalHandle: info.handle,
      tuple,
      relaunch: retry !== undefined ? 'allowed' : 'exhausted',
      ...(retry !== undefined ? { retryAttemptId: retry.attemptId, supersededReason: 'pre_dispatch' } : {}),
      ...(retry !== undefined && repairSpec !== undefined ? { repair: { ...repairSpec } } : {}),
      detail: (retry !== undefined
        ? `terminal failed before dispatch (${info.detail}); orphan terminal closed, one fresh relaunch allowed`
        : `terminal failed before dispatch again (${info.detail}); relaunch allowance spent — participant marked failed`).slice(0, 1000),
    }, where);
    const f = await flush(ctx);
    if (!f.ok) return { kind: 'task_error', error: f.error };
    await closeTerminalWithCustody(ctx, {
      handle: info.handle,
      owner: 'participant',
      participantId: p.participantId,
      attemptId: attempt.attemptId,
      reason: 'pre_dispatch_orphan',
    }, 'engine');
    const fc = await flush(ctx);
    if (!fc.ok) return { kind: 'task_error', error: fc.error };
    if (retry === undefined) return { kind: 'failed' };
    return launchAttempt(ctx, p, retry, { isFreshFallback: true });
  };

  /**
   * Persist intent → write spec → createTask (resumed when taskId already
   * exists) → launchWorker. Fresh Task per phase; reuseTerminal only when the
   * participant's previous dispatch is proven settled. An 'intent_recorded'
   * resume NEVER replays a mutation blind — resolveRecordedIntent observes
   * the host first and adopts or blocks.
   */
  const launchAttempt = async (
    ctx: StepCtx,
    p: Participant,
    attempt: PhaseAttempt,
    opts: { isFreshFallback?: boolean } = {},
  ): Promise<LaunchOutcome> => {
    const { state } = ctx;
    // Execution-policy gate precedes EVERY host mutation: the fingerprinted
    // policy must be present, hash-matched, and must accept this exact
    // participant's approved AgentChoice before intent is even recorded.
    const gate = executionPolicy(state);
    if (!gate.ok) return { kind: 'policy', error: gate.error };
    if (gate.value !== null) {
      const v = gate.value.validateChoice(p.agent);
      if (!v.ok) return { kind: 'policy', error: v.error };
    }
    if (state.consumption.launches >= state.config.maxLaunches) {
      return {
        kind: 'budget',
        error: err('budget_exceeded', `launch cap ${state.config.maxLaunches} reached`),
      };
    }
    // The approval gate binds every post-organiser launch.
    if (attempt.phase !== 'organiser') {
      const ap = await revalidateApproval(ctx);
      if (!ap.ok) return { kind: 'approval', error: ap.error };
      // Bound-choice check (clm_0002 / rev-04): the participant's AgentChoice
      // must equal the choice the approval actually binds — state.json is
      // mutable and its participant records are NOT inside the approval hash,
      // so a divergent choice here means tampering or a profile-blind
      // re-approval; never launch it. Full field equality, profile included.
      const bound = boundAgentChoice(ctx, p);
      if (bound === 'unbound' || (bound !== undefined && !agentChoiceEqual(bound, p.agent))) {
        emit(ctx, 'error', {
          op: 'agent-choice',
          attemptId: attempt.attemptId,
          detail: 'participant AgentChoice diverges from the approved binding — refusing launch',
          participant: p.agent,
          approved: bound === 'unbound' ? null : bound,
        }, { participantId: p.participantId, phase: attempt.phase });
        return {
          kind: 'approval',
          error: err('roster_invalid', bound === 'unbound'
            ? `participant ${p.participantId} is not in the approved roster — refusing launch`
            : `participant ${p.participantId} AgentChoice does not equal the approved ${p.role === 'reviewer' ? 'seat' : 'staff'} choice — refusing launch; restore the approved roster or re-approve`),
        };
      }
    }
    // Concurrency: every attempt whose worker may still be alive holds a
    // slot — dispatched/working, timed_out (deadline is not proof of death),
    // and launch-outcome-unknown alike. A 'planned' attempt launching for the
    // first time must wait for a slot; an 'intent_recorded' resume already
    // notionally holds one and proceeds so the launch can be resolved.
    if (
      attempt.status === 'planned' &&
      slotHoldingAttempts(state).filter((a) => a.attemptId !== attempt.attemptId).length >=
        state.config.concurrency
    ) {
      return { kind: 'concurrency' };
    }
    // Opt-in lean-MCP env: the worktree .devin stubs must exist before the
    // FIRST Devin-lane host mutation of the run (a resumed intent's worker
    // may also still be starting — generation leads every launch). Journaled
    // once; a journaled record (generated or skipped) makes this a no-op.
    const lean = await ensureLeanEnv(ctx, p);
    if (!lean.ok) return { kind: 'task_error', error: lean.error };
    // Resume of a persisted intent: the host mutation may have landed after
    // the intent flush but before its receipt — resolve by OBSERVATION first.
    if (attempt.status === 'intent_recorded') {
      const resolved = await resolveRecordedIntent(ctx, p, attempt);
      if (resolved.kind === 'blocked') return resolved.outcome;
      if (resolved.kind === 'adopted') return { kind: 'launched' };
      if (resolved.kind === 'predispatch') {
        return handlePreDispatchFailure(ctx, p, attempt, {
          handle: resolved.handle,
          stage: 'resume-no-dispatch-marker',
          detail: 'resumed after a crash between terminal create and worker-start; no worker-start marker is journaled',
        });
      }
      // 'proceed': host confirmed nothing landed (or records were adopted).
    }
    const reuseAllowed =
      !opts.isFreshFallback &&
      p.retainedTerminal !== null &&
      p.attempts.every(
        (a) => a === attempt || (a.status === 'settled_ok' || a.status === 'settled_failed'),
      );
    const reuse = reuseAllowed ? p.retainedTerminal! : undefined;
    // Explicit, charged fallback: the participant holds a retained terminal
    // that cannot be reused safely — this is a fresh session, journaled as such.
    const freshFallback =
      opts.isFreshFallback === true || (p.retainedTerminal !== null && !reuseAllowed);

    const repairSpec = ctx.repairByAttempt.get(attempt.attemptId);
    attempt.status = 'intent_recorded';
    if (opts.isFreshFallback !== true) attempt.createdAt = ctx.now.toISOString();
    emit(ctx, 'launch.intent', {
      attemptId: attempt.attemptId,
      launchIntentId: attempt.launchIntentId,
      v: 2, // launch protocol: per-op stage markers govern this attempt's resume
      phase: attempt.phase,
      round: attempt.round,
      reuseTerminal: reuse,
      freshSessionFallback: freshFallback,
      agent: p.agent,
      ...(repairSpec !== undefined
        ? { repairOf: repairSpec.repairOf, repairTuple: `${p.participantId}|${attempt.phase}|${attempt.round ?? 'null'}` }
        : {}),
    }, { participantId: p.participantId, phase: attempt.phase });
    let f = await flush(ctx);
    if (!f.ok) return { kind: 'task_error', error: f.error };

    const built = specFor(ctx, p, attempt);
    if (built === null) {
      return {
        kind: 'task_error',
        error: err('invalid_transition', `cannot build spec for ${p.participantId}/${attempt.phase} (missing perspective)`),
      };
    }
    const specRel = paths.spec(attempt.attemptId);
    const w = await mintedWrite(ctx, specRel, built.spec, 'runner');
    if (!w.ok) return { kind: 'task_error', error: w.error };
    emit(ctx, 'artifact.written', {
      path: specRel,
      kind: 'spec',
      ...(w.value.receipt !== undefined ? receiptJournalFields(w.value.receipt) : {}),
    }, { participantId: p.participantId, phase: attempt.phase });

    if (attempt.taskId === null) {
      if (ctx.taskCreateFailed.has(attempt.attemptId)) {
        return {
          kind: 'task_error',
          error: err('adapter_error', `task-create for attempt ${attempt.attemptId} already failed; reconcile before retry`),
        };
      }
      // Operation-stage marker: durable proof createTask WAS issued — on a
      // later resume its presence makes the outcome 'uncertain' (reconcile
      // by observation) and its absence proves the op never ran.
      emit(ctx, 'launch.intent', { attemptId: attempt.attemptId, stage: 'task-create' },
        { participantId: p.participantId, phase: attempt.phase });
      const fm = await flush(ctx);
      if (!fm.ok) return { kind: 'task_error', error: fm.error };
      const task = await host.createTask({
        runId: state.orcaRunId!,
        specFilePath: abs(specRel),
        title: `council ${attempt.phase}${attempt.round !== null ? ` r${attempt.round}` : ''} ${p.participantId}`,
      });
      if (!task.ok) {
        emit(ctx, 'error', {
          op: 'task-create',
          attemptId: attempt.attemptId,
          code: task.error.code,
          message: task.error.message,
          ...adapterEvidence(task.error),
        });
        const f2 = await flush(ctx);
        if (!f2.ok) return { kind: 'task_error', error: f2.error };
        return { kind: 'task_error', error: task.error };
      }
      attempt.taskId = task.value.taskId;
      emit(ctx, 'task.created', {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        scope: 'task',
        ...(task.value.requestId !== undefined ? { requestId: task.value.requestId } : {}),
      }, { participantId: p.participantId, phase: attempt.phase });
      f = await flush(ctx);
      if (!f.ok) return { kind: 'task_error', error: f.error };
    }

    // A journaled worker-launch error is a DEFINITIVE no-effect failure —
    // retrying cannot duplicate anything (uncertainty would have returned
    // outcome 'unknown'). But a deterministic failure must not livelock:
    // bound the retries and fail the seat visibly after the cap.
    const priorLaunchErrors = ctx.workerLaunchFailures.get(attempt.attemptId) ?? 0;
    if (priorLaunchErrors >= MAX_WORKER_LAUNCH_ERRORS) {
      attempt.status = 'settled_failed';
      attempt.settledAt = ctx.now.toISOString();
      p.status = 'failed';
      emit(ctx, 'worker.settled', {
        attemptId: attempt.attemptId,
        outcome: 'failed',
        detail: `worker-launch failed ${priorLaunchErrors}× (journaled); bounded retry exhausted — seat marked failed, run continues partial`,
      }, { participantId: p.participantId, phase: attempt.phase });
      const fx = await flush(ctx);
      if (!fx.ok) return { kind: 'task_error', error: fx.error };
      return { kind: 'failed' };
    }

    // Operation-stage marker for worker-start — same durable-proof rule as
    // task-create: issued ⇒ reconcile on resume, absent ⇒ provably never ran.
    emit(ctx, 'launch.intent', { attemptId: attempt.attemptId, stage: 'worker-launch' },
      { participantId: p.participantId, phase: attempt.phase });
    const fm = await flush(ctx);
    if (!fm.ok) return { kind: 'task_error', error: fm.error };
    const launch = await host.launchWorker({
      participantId: p.participantId,
      phase: attempt.phase,
      round: attempt.round,
      runId: state.orcaRunId!,
      taskId: attempt.taskId,
      specFilePath: abs(specRel),
      taskTitle: `council ${attempt.phase}${attempt.round !== null ? ` r${attempt.round}` : ''} ${p.participantId}`,
      worktree: 'current',
      agent: p.agent,
      retainTerminal: true,
      ...(reuse !== undefined ? { reuseTerminal: reuse } : {}),
      custody: {
        // Durable stages around the terminal-create INSIDE this launch —
        // intent flushes before the mutation, the returned/refused/uncertain
        // identity flushes after. A mid-launch crash leaves pre-attach
        // custody visible and never authorizes a blind second create.
        beforeTerminalCreate: async (intent) => {
          emit(ctx, 'launch.intent', {
            attemptId: attempt.attemptId,
            stage: 'terminal-create',
            intentId: intent.intentId,
            title: intent.title,
            worktree: intent.worktree,
            command: intent.command,
          }, { participantId: p.participantId, phase: attempt.phase });
          ctx.terminalCreateStage.set(attempt.attemptId, 'issued');
          return await flush(ctx);
        },
        afterTerminalCreate: async (receipt) => {
          if (receipt.outcome === 'created' && receipt.terminalHandle !== undefined) {
            ctx.terminalCustody.set(attempt.attemptId, {
              handle: receipt.terminalHandle,
              ...(receipt.requestId !== undefined ? { requestId: receipt.requestId } : {}),
              ...(receipt.dispatchMarker === true ? { dispatchMarker: true } : {}),
            });
            attempt.terminalHandle = receipt.terminalHandle;
            if (p.retainedTerminal === null) p.retainedTerminal = receipt.terminalHandle;
            emit(ctx, 'task.created', {
              attemptId: attempt.attemptId,
              scope: 'terminal',
              terminalHandle: receipt.terminalHandle,
              intentId: receipt.intentId,
              taskId: receipt.taskId,
              ...(receipt.requestId !== undefined ? { requestId: receipt.requestId } : {}),
              ...(receipt.dispatchMarker === true ? { dispatchMarker: true } : {}),
            }, { participantId: p.participantId, phase: attempt.phase });
          } else {
            const uncertain = receipt.outcome !== 'refused';
            ctx.terminalCreateStage.set(attempt.attemptId, uncertain ? 'issued' : 'refused');
            if (receipt.terminalHandle !== undefined) {
              ctx.terminalCustody.set(attempt.attemptId, {
                handle: receipt.terminalHandle,
                ...(receipt.requestId !== undefined ? { requestId: receipt.requestId } : {}),
              });
              attempt.terminalHandle = receipt.terminalHandle;
              if (p.retainedTerminal === null) p.retainedTerminal = receipt.terminalHandle;
            }
            emit(ctx, 'error', {
              op: 'terminal-create',
              attemptId: attempt.attemptId,
              uncertain,
              intentId: receipt.intentId,
              detail: receipt.detail ?? `terminal create ${receipt.outcome}`,
              ...(receipt.requestId !== undefined ? { requestId: receipt.requestId } : {}),
              ...(receipt.terminalHandle !== undefined ? { terminalHandle: receipt.terminalHandle } : {}),
            }, { participantId: p.participantId, phase: attempt.phase });
          }
          return await flush(ctx);
        },
        // Dispatch marker, flushed immediately BEFORE worker-start onto the
        // terminal this launch created: on resume, a created terminal with
        // no marker provably has no worker; a marker without a receipt
        // stays uncertain and blocks as before.
        beforeWorkerStart: async (marker) => {
          emit(ctx, 'launch.intent', {
            attemptId: attempt.attemptId,
            stage: 'worker-start',
            intentId: marker.intentId,
            terminalHandle: marker.terminalHandle,
          }, { participantId: p.participantId, phase: attempt.phase });
          ctx.workerStartMarkers.add(attempt.attemptId);
          return await flush(ctx);
        },
      },
    });
    if (!launch.ok) {
      emit(ctx, 'error', {
        op: 'worker-launch',
        attemptId: attempt.attemptId,
        code: launch.error.code,
        message: launch.error.message,
        ...adapterEvidence(launch.error),
      });
      const f2 = await flush(ctx);
      if (!f2.ok) return { kind: 'task_error', error: f2.error };
      return { kind: 'task_error', error: launch.error };
    }
    const res = launch.value;
    if (res.outcome === 'started') {
      attempt.status = 'dispatched';
      attempt.dispatchId = res.dispatchId ?? null;
      attempt.terminalHandle = res.terminalHandle ?? null;
      if (res.requestId !== undefined) attempt.requestId = res.requestId;
      if (p.retainedTerminal === null && res.terminalHandle !== undefined) {
        p.retainedTerminal = res.terminalHandle;
      }
      p.status = 'active';
      state.consumption.launches += 1;
      emit(ctx, 'worker.started', {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        dispatchId: attempt.dispatchId,
        terminalHandle: attempt.terminalHandle,
        reuseTerminal: reuse,
        freshSessionFallback: freshFallback,
        agent: p.agent,
      }, { participantId: p.participantId, phase: attempt.phase });
      const f2 = await flush(ctx);
      if (!f2.ok) return { kind: 'task_error', error: f2.error };
      if (reuse === undefined) await checkFirstTurnSubmission(ctx, p, attempt, res);
      return { kind: 'launched' };
    }
    // Definitive pre-dispatch failure: the adapter proves worker-start was
    // never issued onto a terminal THIS attempt created and journaled. No
    // worker can exist, so this is not launch_unknown — the orphan terminal
    // is closed and the seat earns one fresh relaunch. Anything less proven
    // (no explicit flag, reuse path, unjournaled handle) falls through to
    // the existing conservative handling.
    if (
      res.workerStartIssued === false &&
      res.terminalCreated === true &&
      reuse === undefined &&
      res.terminalHandle !== undefined &&
      ctx.terminalCustody.get(attempt.attemptId)?.handle === res.terminalHandle
    ) {
      return handlePreDispatchFailure(ctx, p, attempt, {
        handle: res.terminalHandle,
        stage: res.failedStage ?? 'pre-dispatch',
        detail: res.detail ?? `launch ${res.outcome} before worker-start`,
      });
    }
    if (res.outcome === 'unknown') {
      attempt.status = 'unknown';
      if (res.requestId !== undefined) attempt.requestId = res.requestId;
      if (res.dispatchId !== undefined) attempt.dispatchId = res.dispatchId;
      if (res.terminalHandle !== undefined) {
        attempt.terminalHandle = res.terminalHandle;
        if (p.retainedTerminal === null) p.retainedTerminal = res.terminalHandle;
      }
      // The worker may have started — charge the possible launch honestly.
      state.consumption.launches += 1;
      emit(ctx, 'worker.unknown', {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        requestId: res.requestId,
        dispatchId: res.dispatchId,
        terminalHandle: res.terminalHandle,
        detail: res.detail,
      }, { participantId: p.participantId, phase: attempt.phase });
      const f2 = await flush(ctx);
      if (!f2.ok) return { kind: 'task_error', error: f2.error };
      return {
        kind: 'unknown',
        error: err('launch_unknown', `launch outcome unknown for ${p.participantId}/${attempt.phase}; reconcile requestId ${res.requestId ?? '(none)'} — never relaunch`, {
          details: { attemptId: attempt.attemptId, requestId: res.requestId },
        }),
      };
    }
    // res.outcome === 'failed' — a receipted failure, not uncertainty.
    if (reuse !== undefined) {
      // The retained session may be gone: retry ONCE as a fresh session,
      // explicitly journalled and charged like any launch.
      attempt.status = 'settled_failed';
      attempt.settledAt = ctx.now.toISOString();
      const fallback = addPlannedAttempt(p, attempt.phase, attempt.round);
      attempt.supersededBy = fallback.attemptId;
      attempt.supersededReason = 'fresh_fallback';
      emit(ctx, 'worker.settled', {
        attemptId: attempt.attemptId,
        outcome: 'failed',
        retryAttemptId: fallback.attemptId,
        supersededReason: 'fresh_fallback',
        detail: `retained-terminal launch failed (${res.detail ?? 'no detail'}); falling back to a fresh session`,
      }, { participantId: p.participantId, phase: attempt.phase });
      const retry = await launchAttempt(ctx, p, fallback, { isFreshFallback: true });
      return retry;
    }
    attempt.status = 'settled_failed';
    attempt.settledAt = ctx.now.toISOString();
    p.status = 'failed';
    emit(ctx, 'worker.settled', {
      attemptId: attempt.attemptId,
      outcome: 'failed',
      detail: res.detail,
    }, { participantId: p.participantId, phase: attempt.phase });
    const f2 = await flush(ctx);
    if (!f2.ok) return { kind: 'task_error', error: f2.error };
    return { kind: 'failed' };
  };

  // ── Artifact admission ─────────────────────────────────────────────────────

  const readJson = async (rel: string): Promise<{ ok: true; value: unknown; text: string } | { ok: false; reason: string }> => {
    const r = await store.readArtifact(rel);
    if (!r.ok) return { ok: false, reason: `missing/unreadable: ${r.error.message}` };
    try {
      return { ok: true, value: JSON.parse(r.value), text: r.value };
    } catch (e) {
      return { ok: false, reason: `malformed JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  /** Contract name per phase output — carried into RepairContext. */
  const OUTPUT_CONTRACT: Record<PhaseKind, string> = {
    organiser: 'ProposedRoster',
    independent_review: 'FindingsFile',
    scribe_notes: 'ScribeNotesFile',
    challenge: 'ChallengesFile',
    author_response: 'ResponsesFile',
    scribe_synthesis: 'SynthesisFile',
  };

  const repairKey = (pid: ParticipantId, phase: PhaseKind, round: number | null): string =>
    `${pid}|${phase}|${round ?? 'null'}`;

  /** Validator issues → bounded untrusted-diagnostic lines for the repair spec. */
  const diagnosticsFor = (issues: unknown): string[] => {
    const lines: string[] = [];
    const push = (s: string): void => {
      if (lines.length < 50) lines.push(s.slice(0, 500));
    };
    if (typeof issues === 'string') {
      push(issues);
    } else if (Array.isArray(issues)) {
      for (const i of issues) {
        if (typeof i === 'object' && i !== null) {
          const o = i as { path?: unknown; code?: unknown; message?: unknown };
          push(
            `${typeof o.path === 'string' ? `${o.path} ` : ''}${
              typeof o.code === 'string' ? `[${o.code}] ` : ''
            }${typeof o.message === 'string' ? o.message : JSON.stringify(i)}`.trim(),
          );
        } else {
          push(JSON.stringify(i));
        }
      }
    } else {
      push(JSON.stringify(issues));
    }
    return lines;
  };

  /**
   * Copy the rejected artifact to a distinct archive path BEFORE any
   * corrective attempt can rewrite the canonical output path. Copy (not
   * move): the canonical path keeps the rejected bytes until the repair
   * worker's own write replaces them.
   */
  const preserveRejected = async (
    ctx: StepCtx,
    attempt: PhaseAttempt,
    outRel: string,
  ): Promise<string | undefined> => {
    const existing = await store.readArtifact(outRel);
    if (!existing.ok) {
      emit(ctx, 'error', {
        op: 'rejected-preserve',
        attemptId: attempt.attemptId,
        detail: `rejected artifact ${outRel} unreadable; nothing to archive: ${existing.error.message}`,
      }, { participantId: attempt.participantId, phase: attempt.phase });
      return undefined;
    }
    const rel = `rejected/${attempt.attemptId}__${outRel.split('/').pop()}`;
    const w = await mintedWrite(ctx, rel, existing.value, 'archive');
    if (!w.ok) {
      emit(ctx, 'error', {
        op: 'rejected-preserve',
        attemptId: attempt.attemptId,
        detail: `failed to archive rejected artifact to ${rel}: ${w.error.message}`,
      }, { participantId: attempt.participantId, phase: attempt.phase });
      return undefined;
    }
    emit(ctx, 'artifact.written', {
      path: rel,
      kind: 'rejected-archive',
      supersedes: outRel,
      ...(w.value.receipt !== undefined ? receiptJournalFields(w.value.receipt) : {}),
    }, {
      participantId: attempt.participantId,
      phase: attempt.phase,
    });
    return rel;
  };

  /**
   * Reject an attempt's output: mark it, journal the rejection, and — when
   * eligible — mint exactly ONE corrective repair attempt per
   * (participant, phase, round). Eligibility and the repair context are
   * journaled on this event so a restart rebuilds both; a repair attempt's
   * own rejection never spawns another (max one fresh attempt per tuple).
   */
  const rejectOutput = async (
    ctx: StepCtx,
    p: Participant,
    attempt: PhaseAttempt,
    outRel: string,
    issues: unknown,
  ): Promise<void> => {
    ctx.rejectedAttempts.add(attempt.attemptId);
    // RA-007: the raw issues array is unbounded — journaling it verbatim can
    // overflow MAX_EVENT_LINE_BYTES, which makes the append fail, which makes
    // the SAME invalid output re-reject every advance (a livelock on the 32KB
    // line cap). Persist the full exact diagnostics in an artifact; journal a
    // bounded excerpt + the artifact reference + hash/count.
    const diag = diagnosticsFor(issues);
    const diagRel = `rejected/${attempt.attemptId}__diagnostics.json`;
    const diagJson = JSON.stringify({
      attemptId: attempt.attemptId,
      path: outRel,
      issues,
      diagnostics: diag,
    }, null, 2);
    const dw = await mintedWrite(ctx, diagRel, diagJson, 'archive');
    const issuesRef = dw.ok ? diagRel : undefined;
    if (dw.ok) {
      emit(ctx, 'artifact.written', {
        path: diagRel,
        kind: 'rejection-diagnostics',
        supersedes: outRel,
        ...(dw.value.receipt !== undefined ? receiptJournalFields(dw.value.receipt) : {}),
      }, {
        participantId: attempt.participantId,
        phase: attempt.phase,
      });
    } else {
      emit(ctx, 'error', {
        op: 'rejection-diagnostics',
        attemptId: attempt.attemptId,
        detail: `failed to archive diagnostics to ${diagRel}: ${dw.error.message}`,
      }, { participantId: attempt.participantId, phase: attempt.phase });
    }
    const payload: Record<string, unknown> = {
      attemptId: attempt.attemptId,
      path: outRel,
      issueCount: Array.isArray(issues) ? issues.length : (issues === undefined ? 0 : 1),
      issuesHash: createHash('sha256').update(diagJson, 'utf8').digest('hex'),
      issuesExcerpt: diag.slice(0, 8), // bounded preview; full text at issuesRef
      ...(issuesRef !== undefined ? { issuesRef } : {}),
    };
    const tuple = repairKey(p.participantId, attempt.phase, attempt.round);
    const eligible =
      !ctx.repairedKeys.has(tuple) &&
      !ctx.repairByAttempt.has(attempt.attemptId) &&
      !phaseDeadlineExpired(ctx);
    if (eligible) {
      const preserved = await preserveRejected(ctx, attempt, outRel);
      const repairAttempt = addPlannedAttempt(p, attempt.phase, attempt.round);
      const spec: RepairSpec = {
        repairOf: attempt.attemptId,
        contract: OUTPUT_CONTRACT[attempt.phase],
        // Bounded excerpt rides the journal + prompt context; the artifact
        // reference points at the full exact diagnostics.
        diagnostics: diag.slice(0, 20),
        ...(preserved !== undefined ? { previousArtifactPath: abs(preserved) } : {}),
        ...(issuesRef !== undefined ? { diagnosticsRef: abs(issuesRef) } : {}),
      };
      ctx.repairByAttempt.set(repairAttempt.attemptId, spec);
      ctx.repairedKeys.add(tuple);
      payload.repairAttemptId = repairAttempt.attemptId;
      payload.repairTuple = tuple;
      payload.repair = spec;
      if (preserved !== undefined) payload.preservedAs = preserved;
    }
    emit(ctx, 'artifact.rejected', payload, {
      participantId: attempt.participantId,
      phase: attempt.phase,
      ...(attempt.round !== null ? { round: attempt.round } : {}),
    });
  };

  /**
   * Admit a validated worker output: on v1, receipt the EXACT text bytes
   * just parsed (never a re-read) so every later consumption verifies
   * against the journaled hash. The receipt rides the artifact.admitted
   * event — journal-authoritative, like every other durable fact.
   */
  const admit = async (
    ctx: StepCtx,
    attempt: PhaseAttempt,
    path: string,
    rawText: string,
  ): Promise<Result<void>> => {
    let receipt: ArtifactReceipt | undefined;
    if (ctx.integrity === 'receipts-v1') {
      const r = await noteReceipt(store, path, rawText, 'worker_output', {
        prior: ctx.receipts,
        now: ctx.now,
      });
      if (!r.ok) return r as Result<never>;
      receipt = r.value.receipt;
      ctx.receipts.set(path, receipt);
      if (r.value.indexAnomaly !== undefined) {
        emit(ctx, 'error', { op: 'integrity-index', detail: r.value.indexAnomaly });
      }
    }
    attempt.artifacts.push(path);
    ctx.artifacts.push(path);
    emit(ctx, 'artifact.admitted', {
      attemptId: attempt.attemptId,
      path,
      ...(receipt !== undefined ? receiptJournalFields(receipt) : {}),
    }, {
      participantId: attempt.participantId,
      phase: attempt.phase,
      ...(attempt.round !== null ? { round: attempt.round } : {}),
    });
    return ok(undefined);
  };

  /**
   * Admit outputs from every settled_ok attempt that has not already been
   * admitted or rejected. Validates run/participant/round binding and, for
   * discussion phases, that every item refers to its assigned ids.
   */
  const admitPhaseOutputs = async (ctx: StepCtx): Promise<Result<void>> => {
    const { state } = ctx;
    for (const p of state.participants) {
      for (const attempt of p.attempts) {
        if (attempt.status !== 'settled_ok' || attempt.artifacts.length > 0) continue;
        if (ctx.rejectedAttempts.has(attempt.attemptId)) continue;
        const outPath = expectedOutputPath(attempt);
        const raw = await readJson(outPath);
        if (!raw.ok) {
          await rejectOutput(ctx, p, attempt, outPath, raw.reason);
          continue;
        }
        switch (attempt.phase) {
          case 'organiser': {
            const parsed = parseProposedRoster(raw.value, {
              runId: state.runId,
              requestedPerspectives: state.config.requestedPerspectives,
            });
            if (!parsed.ok) {
              await rejectOutput(ctx, p, attempt, outPath, parsed.issues);
              break;
            }
            const roster = parsed.value;
            roster.producedBy = {
              participantId: p.participantId,
              ...(attempt.dispatchId !== null ? { dispatchId: attempt.dispatchId } : {}),
            };
            const w = await store.writeProposedRoster(roster);
            if (!w.ok) return w;
            const a0 = await admit(ctx, attempt, outPath, raw.text);
            if (!a0.ok) return a0;
            emit(ctx, 'roster.proposed', { perspectives: roster.perspectives.length });
            state.status = 'awaiting_approval';
            state.phaseEnteredAt = ctx.now.toISOString();
            emit(ctx, 'phase.entered', { status: 'awaiting_approval' });
            break;
          }
          case 'independent_review': {
            const parsed = parseFindingsFile(raw.value, {
              runId: state.runId,
              participantId: p.participantId,
              perspectiveId: p.perspectiveId ?? undefined,
              maxFindings: state.config.maxFindingsPerSeat,
            });
            if (!parsed.ok) {
              await rejectOutput(ctx, p, attempt, outPath, parsed.issues);
              break;
            }
            const a1 = await admit(ctx, attempt, outPath, raw.text);
            if (!a1.ok) return a1;
            break;
          }
          case 'scribe_notes': {
            const parsed = parseScribeNotesFile(raw.value, {
              runId: state.runId,
              participantId: p.participantId,
            });
            if (!parsed.ok) {
              await rejectOutput(ctx, p, attempt, outPath, parsed.issues);
              break;
            }
            const a2 = await admit(ctx, attempt, outPath, raw.text);
            if (!a2.ok) return a2;
            break;
          }
          case 'challenge': {
            const parsed = parseChallengesFile(raw.value, {
              runId: state.runId,
              round: attempt.round ?? undefined,
              participantId: p.participantId,
              max: state.config.maxChallengesPerSeatPerRound,
            });
            if (!parsed.ok) {
              await rejectOutput(ctx, p, attempt, outPath, parsed.issues);
              break;
            }
            // Authorization is journal-derived (journaled assignedIds from
            // envelope.built) — never the worker-editable envelope bytes.
            const allowed = await envelopeAssignedIds(ctx, paths.challengeEnv(p.participantId, attempt.round ?? 1));
            if (!allowed.ok) {
              integrityViolation(ctx, paths.challengeEnv(p.participantId, attempt.round ?? 1), allowed.error);
              return allowed as Result<never>;
            }
            const bad = parsed.value.challenges.filter((c) => !allowed.value.has(c.claimId));
            const ids = parsed.value.challenges.map((c) => c.challengeId);
            const dup = ids.length !== new Set(ids).size;
            if (bad.length > 0 || dup) {
              await rejectOutput(ctx, p, attempt, outPath, {
                unassignedClaimIds: bad.map((c) => c.claimId),
                duplicateChallengeIds: dup,
              });
              break;
            }
            const a3 = await admit(ctx, attempt, outPath, raw.text);
            if (!a3.ok) return a3;
            break;
          }
          case 'author_response': {
            const parsed = parseResponsesFile(raw.value, {
              runId: state.runId,
              round: attempt.round ?? undefined,
              participantId: p.participantId,
              max: state.config.maxResponsesPerSeatPerRound,
            });
            if (!parsed.ok) {
              await rejectOutput(ctx, p, attempt, outPath, parsed.issues);
              break;
            }
            const allowed = await envelopeAssignedIds(ctx, paths.responseEnv(p.participantId, attempt.round ?? 1));
            if (!allowed.ok) {
              integrityViolation(ctx, paths.responseEnv(p.participantId, attempt.round ?? 1), allowed.error);
              return allowed as Result<never>;
            }
            const bad = parsed.value.responses.filter((r) => !allowed.value.has(r.challengeId));
            if (bad.length > 0) {
              await rejectOutput(ctx, p, attempt, outPath, {
                unassignedChallengeIds: bad.map((r) => r.challengeId),
              });
              break;
            }
            const a4 = await admit(ctx, attempt, outPath, raw.text);
            if (!a4.ok) return a4;
            break;
          }
          case 'scribe_synthesis': {
            // SynthesisFile (narrative contract) first, full ReportFile
            // fallback for legacy artifacts — both are admissible scribe
            // output; schemas are never relaxed.
            const synParse = (validationNs as {
              parseSynthesisFile?: (
                v: unknown,
                o: { runId: string; participantId?: string },
              ) => { ok: true; value: unknown } | { ok: false; issues?: unknown[] };
            }).parseSynthesisFile?.(raw.value, {
              runId: state.runId,
              participantId: p.participantId,
            });
            const parsed = synParse !== undefined && synParse.ok
              ? { ok: true as const, value: synParse.value }
              : parseReportFile(raw.value, { runId: state.runId });
            if (!parsed.ok) {
              const issues = synParse !== undefined && !synParse.ok && 'issues' in synParse
                ? [...(synParse.issues ?? []), ...((parsed as { issues?: unknown[] }).issues ?? [])]
                : (parsed as { issues?: unknown[] }).issues;
              await rejectOutput(ctx, p, attempt, outPath, issues);
              break;
            }
            const a5 = await admit(ctx, attempt, outPath, raw.text);
            if (!a5.ok) return a5;
            break;
          }
        }
      }
    }
    return ok(undefined);
  };

  /**
   * Typed re-parse of an admitted artifact — never an unchecked cast. Same
   * parser/options admission used, so a file that no longer parses is a
   * visible corruption, not silent data loss.
   */
  const reparseAdmitted = (
    state: CouncilState,
    p: Participant,
    a: PhaseAttempt,
    raw: unknown,
  ): Result<unknown> => {
    switch (a.phase) {
      case 'organiser':
        return parseProposedRoster(raw, {
          runId: state.runId,
          requestedPerspectives: state.config.requestedPerspectives,
        }) as Result<unknown>;
      case 'independent_review':
        return parseFindingsFile(raw, {
          runId: state.runId,
          participantId: p.participantId,
          perspectiveId: p.perspectiveId ?? undefined,
          maxFindings: state.config.maxFindingsPerSeat,
        }) as Result<unknown>;
      case 'scribe_notes':
        return parseScribeNotesFile(raw, { runId: state.runId, participantId: p.participantId }) as Result<unknown>;
      case 'challenge':
        return parseChallengesFile(raw, {
          runId: state.runId,
          round: a.round ?? undefined,
          participantId: p.participantId,
          max: state.config.maxChallengesPerSeatPerRound,
        }) as Result<unknown>;
      case 'author_response':
        return parseResponsesFile(raw, {
          runId: state.runId,
          round: a.round ?? undefined,
          participantId: p.participantId,
          max: state.config.maxResponsesPerSeatPerRound,
        }) as Result<unknown>;
      case 'scribe_synthesis': {
        const syn = (validationNs as {
          parseSynthesisFile?: (
            v: unknown,
            o: { runId: string; participantId?: string },
          ) => { ok: true; value: unknown } | { ok: false; issues?: unknown[] };
        }).parseSynthesisFile?.(raw, { runId: state.runId, participantId: p.participantId });
        if (syn !== undefined && syn.ok) return ok(syn.value);
        return parseReportFile(raw, { runId: state.runId }) as Result<unknown>;
      }
    }
  };

  /**
   * Read back every admitted file of a phase, verifying exact bytes against
   * the journaled receipts (v1) and re-parsing typed — a file that verifies
   * clean but no longer parses is corruption, both fail visibly.
   */
  const admittedFiles = async <T>(
    ctx: StepCtx,
    phase: PhaseKind,
    round: number | null,
  ): Promise<Result<{ participantId: ParticipantId; perspectiveId: PerspectiveId | undefined; file: T }[]>> => {
    const { state } = ctx;
    const out: { participantId: ParticipantId; perspectiveId: PerspectiveId | undefined; file: T }[] = [];
    for (const p of state.participants) {
      for (const a of attemptsFor(p, phase, round)) {
        for (const rel of a.artifacts) {
          const v = await verifiedRead(ctx, rel);
          if (!v.ok) {
            integrityViolation(ctx, rel, v.error);
            return v as Result<never>;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(v.value.text);
          } catch (e) {
            return failRes(err('io_error', `admitted artifact ${rel} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`));
          }
          const parsed = reparseAdmitted(state, p, a, raw);
          if (!parsed.ok) {
            emit(ctx, 'error', {
              op: 'admitted-reparse',
              path: rel,
              attemptId: a.attemptId,
              detail: `admitted artifact ${rel} failed re-parse — corruption between admission and consumption`,
            }, { participantId: p.participantId, phase: a.phase });
            return failRes(
              err('untrusted_output', `admitted artifact ${rel} failed typed re-parse`, {
                details: { reason: 'admitted_reparse_failed', path: rel, attemptId: a.attemptId },
              }),
            );
          }
          out.push({ participantId: p.participantId, perspectiveId: p.perspectiveId ?? undefined, file: parsed.value as T });
        }
      }
    }
    return ok(out);
  };

  /**
   * The canonical ledger is a managed artifact: verified bytes (v1) plus
   * typed re-parse — null only when claims.json was never written.
   */
  const readLedger = async (ctx: StepCtx): Promise<Result<ClaimLedger | null>> => {
    const exists = await store.artifactExists(paths.ledger);
    if (!exists.ok) return exists as Result<never>;
    if (!exists.value) return ok(null);
    const v = await verifiedRead(ctx, paths.ledger);
    if (!v.ok) {
      integrityViolation(ctx, paths.ledger, v.error);
      return v as Result<never>;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(v.value.text);
    } catch (e) {
      return failRes(err('io_error', `claims.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`));
    }
    const parsed = parseClaimLedger(raw, { runId: ctx.state.runId });
    if (!parsed.ok) {
      return failRes(
        err('schema_invalid', 'claims.json failed typed re-parse', {
          issues: parsed.issues,
          details: { reason: 'ledger_reparse_failed', path: paths.ledger },
        }),
      );
    }
    return ok(parsed.value);
  };

  const writeLedger = async (ctx: StepCtx, ledger: ClaimLedger): Promise<Result<{ receipt?: ArtifactReceipt }>> => {
    const w = await mintedWrite(ctx, paths.ledger, JSON.stringify(ledger, null, 2), 'ledger');
    if (!w.ok) return w as Result<never>;
    emit(ctx, 'claim.updated', {
      claims: ledger.claims.length,
      path: paths.ledger,
      ...(w.value.receipt !== undefined ? receiptJournalFields(w.value.receipt) : {}),
    });
    return ok({ receipt: w.value.receipt });
  };

  const sourceAccess = (state: CouncilState, snapshot: SourceSnapshot): SourceAccess => ({
    snapshot,
    readFile: (rel: string) => {
      const safe = assertSafeRelativePath(rel);
      if (!safe.ok) return undefined;
      try {
        return readFileSync(join(state.targetRoot, safe.value), 'utf8');
      } catch {
        return undefined;
      }
    },
  });

  // ── Barrier helpers ────────────────────────────────────────────────────────

  /** Attempt is finished for barrier purposes (unknown counts only after deadline). */
  const isBarrierDone = (a: PhaseAttempt, deadlineExpired: boolean): boolean =>
    TERMINAL_ATTEMPT.has(a.status) || (deadlineExpired && a.status === 'unknown');

  const unresolvedUnknown = (state: CouncilState, phase: PhaseKind, round: number | null): PhaseAttempt[] =>
    state.participants.flatMap((p) =>
      attemptsFor(p, phase, round).filter(
        (a) => a.status === 'unknown' && a.dispatchId === null,
      ),
    );

  const phaseDeadlineExpired = (ctx: StepCtx): boolean => {
    const ms = phaseDeadlineMs(ctx.state);
    if (ms === undefined) return false;
    return ctx.now.getTime() - Date.parse(ctx.state.phaseEnteredAt) > ms + ctx.state.config.deadlines.graceMs;
  };

  const launchErrorResult = (ctx: StepCtx, lo: LaunchOutcome): StepResult => {
    if (lo.kind === 'unknown') {
      return blocked(ctx.state.status, lo.error?.message ?? 'launch outcome unknown; reconcile before continuing');
    }
    if (lo.kind === 'task_error') {
      return blocked(
        ctx.state.status,
        `host operation failed: ${lo.error?.message ?? 'unknown'} — intent is persisted; reconcile journal before retry`,
      );
    }
    if (lo.kind === 'budget') {
      return blocked(ctx.state.status, lo.error?.message ?? 'launch budget exceeded');
    }
    if (lo.kind === 'concurrency') {
      return advanceResult('wait', ctx.state.status, 'concurrency slots held by unresolved workers');
    }
    if (lo.kind === 'policy') {
      return blocked(ctx.state.status, lo.error?.message ?? 'execution policy refused the launch');
    }
    if (lo.kind === 'approval') {
      const stale = lo.error?.code === 'approval_stale' || lo.error?.code === 'snapshot_drift';
      return stale
        ? advanceResult(ctx.state.approvalHash === null ? 'needs_approval' : 'blocked', ctx.state.status, lo.error?.message)
        : blocked(ctx.state.status, lo.error?.message ?? 'approval required');
    }
    return blocked(ctx.state.status, `launch failed for ${ctx.state.status}`);
  };

  // ── Phase steps ────────────────────────────────────────────────────────────

  const stepInitialized = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    // Fingerprint-bound runs must prove the injected policy before the very
    // first host mutation (run-create) — and every staff role's choice must
    // be policy-launchable. Nothing is created, launched, or persisted on
    // failure.
    const gate = executionPolicy(state);
    if (!gate.ok) return blocked(state.status, gate.error.message);
    if (gate.value !== null) {
      const sv = validateStaff(state, gate.value);
      if (!sv.ok) return blocked(state.status, sv.error.message);
    }
    if (state.orcaRunId === null) {
      if (ctx.runCreateUnresolved) {
        return blocked(state.status, 'run-create was attempted but its outcome was never confirmed; reconcile the retained intent (see journal launch.intent scope=run) before retrying — never auto-retry a missing receipt');
      }
      emit(ctx, 'launch.intent', { scope: 'run', objective: state.objective });
      const f = await flush(ctx);
      if (!f.ok) return { kind: 'error', error: f.error };
      const run = await host.createRun({ objective: state.objective });
      if (!run.ok) {
        emit(ctx, 'error', { op: 'run-create', code: run.error.code, message: run.error.message, ...adapterEvidence(run.error) });
        const f2 = await flush(ctx);
        if (!f2.ok) return { kind: 'error', error: f2.error };
        return blocked(state.status, `run-create failed: ${run.error.message}. The intent is persisted; reconcile before retry.`);
      }
      state.orcaRunId = run.value.runId;
      emit(ctx, 'task.created', {
        scope: 'run',
        orcaRunId: run.value.runId,
        ...(run.value.requestId !== undefined ? { requestId: run.value.requestId } : {}),
      });
    }
    const organiser = ensureParticipant(state, ORGANISER_PID, 'organiser', staffAgent(state, 'organiser'), null, null);
    ensureStageAttempt(organiser, 'organiser', null);
    state.status = 'organising';
    state.phaseEnteredAt = ctx.now.toISOString();
    emit(ctx, 'phase.entered', { status: 'organising' });
    return stepOrganising(ctx);
  };

  const stepOrganising = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    if (state.status === 'awaiting_approval') {
      return advanceResult('needs_approval', state.status, 'roster proposed — approve the exact seats/agents/config to launch reviewers');
    }
    const p = findParticipant(state, ORGANISER_PID);
    if (p === undefined) return { kind: 'error', error: err('invalid_transition', 'organiser participant missing') };
    await reconcileAttempts(ctx);
    if (await enforceDeadlines(ctx)) {
      return advanceResult('finished', state.status, undefined, { outcome: 'failed' });
    }
    const adm = await admitPhaseOutputs(ctx);
    if (!adm.ok) return { kind: 'error', error: adm.error };
    const statusAfter: RunStatus = ctx.state.status;
    if (statusAfter === 'awaiting_approval') {
      // The organiser's roster is admitted and no later phase reuses its
      // session: release-then-close its engine-created terminal now
      // instead of leaving an idle agent through the whole run.
      for (const rec of recordedParticipantTerminals(ctx)) {
        if (rec.p.participantId === ORGANISER_PID) await cleanupParticipantTerminal(ctx, rec, 'organiser_roster_admitted', 'engine');
      }
      return advanceResult('needs_approval', statusAfter, 'roster proposed — approve the exact seats/agents/config to launch reviewers');
    }
    // Re-derive AFTER admission (clm_0020): a rejection this pass may have
    // minted the corrective repair attempt — following the stale rejected
    // reference would block on 'settled_ok' instead of launching the repair.
    const attempt = attemptsFor(p, 'organiser', null).at(-1)!;
    switch (attempt.status) {
      case 'planned':
      case 'intent_recorded': {
        const lo = await launchAttempt(ctx, p, attempt);
        if (lo.kind === 'launched') return advanceResult('progress', state.status, 'organiser launched');
        if (lo.kind === 'failed') return blocked(state.status, `organiser launch failed; cancel the run or reconcile`);
        if (lo.kind === 'concurrency') return advanceResult('wait', state.status, 'concurrency slots held by unresolved workers');
        return launchErrorResult(ctx, lo);
      }
      case 'dispatched':
      case 'working':
        return advanceResult('wait', state.status, 'organiser working');
      case 'unknown':
        return blocked(state.status, `organiser launch outcome unknown; reconcile requestId ${attempt.requestId ?? '(none)'} — never relaunch`);
      case 'settled_ok':
        // Admission ran above and did not transition: output was rejected.
        return blocked(state.status, `organiser output rejected — see journal artifact.rejected for ${attempt.attemptId}; cancel and restart`);
      case 'settled_failed':
        return blocked(state.status, 'organiser task failed; cancel and restart the run');
      case 'timed_out':
        return blocked(state.status, 'organiser deadline exceeded; cancel and restart the run');
      case 'stopped':
        return blocked(state.status, 'organiser stopped');
    }
  };

  /** Launch every due attempt in the current phase up to concurrency. */
  const launchDue = async (
    ctx: StepCtx,
    due: { p: Participant; attempt: PhaseAttempt }[],
  ): Promise<{ launched: number } | { error: StepResult }> => {
    let launched = 0;
    for (const { p, attempt } of due) {
      if (attempt.status !== 'planned' && attempt.status !== 'intent_recorded') continue;
      const lo = await launchAttempt(ctx, p, attempt);
      if (lo.kind === 'launched') {
        launched += 1;
        continue;
      }
      if (lo.kind === 'failed') continue; // seat marked failed; keep launching others
      if (lo.kind === 'concurrency') break; // slots held by unresolved workers — retry next advance
      return { error: launchErrorResult(ctx, lo) };
    }
    return { launched };
  };

  const stepIndependent = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    await reconcileAttempts(ctx);
    if (await enforceDeadlines(ctx)) {
      return advanceResult('finished', state.status, undefined, { outcome: 'failed' });
    }
    const adm = await admitPhaseOutputs(ctx);
    if (!adm.ok) return { kind: 'error', error: adm.error };

    const unknownNoDispatch = unresolvedUnknown(state, 'independent_review', null);
    if (unknownNoDispatch.length > 0 && !phaseDeadlineExpired(ctx)) {
      const a = unknownNoDispatch[0];
      return blocked(state.status, `launch outcome unknown for ${a.participantId} (requestId ${a.requestId ?? 'none'}); reconcile before continuing — never relaunch`);
    }

    const deadlineExpired = phaseDeadlineExpired(ctx);
    const due = reviewers(state).flatMap((p) =>
      attemptsFor(p, 'independent_review', null).map((attempt) => ({ p, attempt })),
    );
    const launched = deadlineExpired ? { launched: 0 } : await launchDue(ctx, due);
    if ('error' in launched) return launched.error;

    // Re-derived AFTER launching: a fallback/pre-dispatch relaunch minted
    // during launchDue must hold the barrier open too.
    const all = reviewers(state).flatMap((p) => attemptsFor(p, 'independent_review', null));
    const done = all.every((a) => isBarrierDone(a, deadlineExpired));
    if (!done) {
      return advanceResult(
        launched.launched > 0 ? 'progress' : 'wait',
        state.status,
        launched.launched > 0 ? `launched ${launched.launched} reviewer(s)` : 'reviewers active',
      );
    }

    // Barrier: phase closed. Build the canonical ledger from admitted findings.
    const af = await admittedFiles<FindingsFile>(ctx, 'independent_review', null);
    if (!af.ok) return { kind: 'error', error: af.error };
    const admittedFindings = af.value;
    const rejected = all.filter((a) => ctx.rejectedAttempts.has(a.attemptId) || a.status === 'settled_failed' || a.status === 'timed_out' || a.status === 'unknown');
    const lingering = all.filter((a) => a.status === 'unknown');
    for (const a of lingering) {
      emit(ctx, 'worker.unknown', {
        attemptId: a.attemptId,
        dispatchId: a.dispatchId,
        note: 'phase closed at deadline with launch outcome unresolved; worker may linger — terminal reuse blocked',
      }, { participantId: a.participantId });
    }
    if (admittedFindings.length === 0) {
      state.status = 'failed';
      emit(ctx, 'run.finished', {
        outcome: 'failed',
        reason: `no successful reviewers (${rejected.length} failed/rejected seat(s))`,
      });
      const fz = await flush(ctx);
      if (!fz.ok) return { kind: 'error', error: fz.error };
      return advanceResult('finished', state.status, 'no reviewer produced admissible findings', { outcome: 'failed' });
    }
    let snapshot = ctx.snapshot;
    if (snapshot === undefined) {
      const snapR = await store.readSnapshot();
      if (!snapR.ok) return { kind: 'error', error: snapR.error };
      snapshot = snapR.value;
    }
    const build = buildClaimLedger(state.runId, admittedFindings as AdmittedFinding[], sourceAccess(state, snapshot), ctx.now);
    const w = await writeLedger(ctx, build.ledger);
    if (!w.ok) return { kind: 'error', error: w.error };
    for (const rej of build.evidenceRejections) {
      emit(ctx, 'artifact.rejected', {
        kind: 'evidence',
        participantId: rej.participantId,
        findingId: rej.findingId,
        reason: rej.reason,
      });
    }
    // Strengths carry the same evidence/citation rules as findings — a
    // strength whose whole evidence list fails is dropped visibly, never
    // admitted as bare praise.
    for (const rej of build.strengthRejections) {
      emit(ctx, 'artifact.rejected', {
        kind: 'strength',
        participantId: rej.participantId,
        perspectiveId: rej.perspectiveId,
        strengthId: rej.strengthId,
        reason: rej.reason,
      });
    }
    emit(ctx, 'artifact.written', {
      path: paths.ledger,
      claims: build.ledger.claims.length,
      ...(build.ledger.strengths !== undefined ? { strengths: build.ledger.strengths.length } : {}),
      ...(w.value.receipt !== undefined ? receiptJournalFields(w.value.receipt) : {}),
    });

    // Enter scribe-notes phase with a fresh, distinct scribe participant —
    // reusing the overlay-minted one after append-ok/save-fail (clm_0007).
    const scribe = ensureParticipant(state, SCRIBE_PID, 'scribe', staffAgent(state, 'scribe'), null, null);
    ensureStageAttempt(scribe, 'scribe_notes', null);
    state.status = 'scribe_notes';
    state.phaseEnteredAt = ctx.now.toISOString();
    emit(ctx, 'phase.entered', { status: 'scribe_notes' });
    const fp = await flush(ctx);
    if (!fp.ok) return { kind: 'error', error: fp.error };
    return advanceResult('progress', state.status, `independent review closed: ${admittedFindings.length} findings file(s) admitted, ${rejected.length} seat(s) failed`);
  };

  const stepScribeNotes = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    await reconcileAttempts(ctx);
    if (await enforceDeadlines(ctx)) {
      return advanceResult('finished', state.status, undefined, { outcome: 'failed' });
    }
    const adm = await admitPhaseOutputs(ctx);
    if (!adm.ok) return { kind: 'error', error: adm.error };

    const p = findParticipant(state, SCRIBE_PID);
    if (p === undefined) return { kind: 'error', error: err('invalid_transition', 'scribe participant missing') };
    const attempt = attemptsFor(p, 'scribe_notes', null).at(-1)!;
    if (attempt.status === 'planned' || attempt.status === 'intent_recorded') {
      const admitted = await admittedFiles<FindingsFile>(ctx, 'independent_review', null);
      if (!admitted.ok) return { kind: 'error', error: admitted.error };
      ctx.admittedFindingsPaths = admitted.value.map((f) => abs(paths.findingsOut(f.file.participantId)));
      const lo = await launchAttempt(ctx, p, attempt);
      if (lo.kind === 'launched') return advanceResult('progress', state.status, 'scribe notes launched');
      if (lo.kind === 'failed') return blocked(state.status, 'scribe notes launch failed; reconcile');
      if (lo.kind === 'concurrency') return advanceResult('wait', state.status, 'concurrency slots held by unresolved workers — scribe notes deferred');
      return launchErrorResult(ctx, lo);
    }
    if (ACTIVE_ATTEMPT.has(attempt.status)) {
      return attempt.status === 'unknown' && attempt.dispatchId === null
        ? blocked(state.status, `scribe notes launch unknown; reconcile requestId ${attempt.requestId ?? 'none'}`)
        : advanceResult('wait', state.status, 'scribe notes working');
    }
    if (attempt.status !== 'settled_ok' || ctx.rejectedAttempts.has(attempt.attemptId) || attempt.artifacts.length === 0) {
      return blocked(state.status, `scribe notes ${ctx.rejectedAttempts.has(attempt.attemptId) ? 'output rejected' : `ended ${attempt.status}`}; orchestrator must decide (cancel or restart)`);
    }

    // Notes admitted → open discussion round 1, challenge stage.
    return enterChallengeStage(ctx, 1);
  };

  const enterChallengeStage = async (ctx: StepCtx, round: number): Promise<StepResult> => {
    const { state } = ctx;
    const ledgerR = await readLedger(ctx);
    if (!ledgerR.ok) return { kind: 'error', error: ledgerR.error };
    if (ledgerR.value === null) return { kind: 'error', error: err('invalid_transition', 'claims.json missing at discussion entry') };
    const ledger = ledgerR.value;
    const proposedR = await store.readProposedRoster();
    const perspectives = new Map<string, Perspective>(
      (proposedR.ok ? proposedR.value.perspectives : []).map((p) => [p.perspectiveId, p]),
    );
    const seatOf = new Map<string, string>();
    for (const p of reviewers(state)) if (p.perspectiveId !== null) seatOf.set(p.participantId, p.perspectiveId);

    const challengerIds = reviewers(state)
      .filter((p) => p.status === 'settled' || (p.status === 'active' && attemptsFor(p, 'independent_review').some((a) => a.status === 'settled_ok')))
      .map((p) => p.participantId);
    const plan = assignChallenges({
      claims: ledger.claims,
      challengerIds,
      claimAuthors: (cid) => claimAuthors(ledger, cid),
      perspectiveOf: (pid) => {
        const perspId = seatOf.get(pid);
        return perspId !== undefined ? perspectives.get(perspId) : undefined;
      },
      maxPerSeat: state.config.maxChallengesPerSeatPerRound,
    });

    let total = 0;
    const routedClaimIds: string[] = [];
    const byteDroppedClaimIds: string[] = [];
    for (const [pid, assignments] of plan.assignments) {
      if (assignments.length === 0) continue;
      const p = findParticipant(state, pid)!;
      const envRel = paths.challengeEnv(pid, round);
      const alreadyBuilt = ctx.envelopeAssigned.has(envRel);
      if (alreadyBuilt) {
        // Replay: the journaled envelope.built is the durable plan. Never
        // rewrite — on v1 verify the file against its journaled receipt
        // (tamper/deletion is visible, not silently healed).
        const v = await verifiedRead(ctx, envRel);
        if (!v.ok) {
          integrityViolation(ctx, envRel, v.error);
          return { kind: 'error', error: v.error };
        }
        routedClaimIds.push(...ctx.envelopeAssigned.get(envRel)!);
      } else {
        const base = makeEnvelopeBase<ChallengeAssignment>({
          runId: state.runId,
          phase: 'challenge',
          round,
          recipientId: pid,
          outputPath: paths.challengeOut(pid, round),
          outputContract: 'ChallengesFile',
        });
        const fit = fitEnvelope(base, assignments, state.config.envelopeBytes);
        const assignedIds = fit.envelope.assignments.map((a) => a.claimId);
        const w = await mintedWrite(ctx, envRel, JSON.stringify(fit.envelope, null, 2), 'envelope');
        if (!w.ok) return { kind: 'error', error: w.error };
        emit(ctx, 'envelope.built', {
          path: envRel,
          recipientId: pid,
          round,
          assigned: fit.envelope.assignments.length,
          assignedIds,
          omitted: fit.omitted.map((a) => a.claimId),
          bytes: fit.bytes,
          ...(w.value.receipt !== undefined ? receiptJournalFields(w.value.receipt) : {}),
        }, { participantId: pid, phase: 'challenge', round });
        ctx.envelopeAssigned.set(envRel, assignedIds);
        routedClaimIds.push(...assignedIds);
        byteDroppedClaimIds.push(...fit.omitted.map((a) => a.claimId));
      }
      ensureStageAttempt(p, 'challenge', round);
      total += ctx.envelopeAssigned.get(envRel)!.length;
    }
    // Routing record ONCE per stage — routed/byte-dropped/unassigned are
    // disjoint families; persisted into the ledger so the report can
    // distinguish never-routed from examined claims (clm_0016).
    recordChallengeRouting(ledger, round, {
      routedClaimIds: [...new Set(routedClaimIds)],
      byteDroppedClaimIds: [...new Set(byteDroppedClaimIds)],
      unassigned: plan.unassigned.map((u) => ({ claimId: u.claimId, reason: u.reason })),
    });
    const wl = await writeLedger(ctx, ledger);
    if (!wl.ok) return { kind: 'error', error: wl.error };
    if (total === 0) {
      emit(ctx, 'envelope.built', {
        round,
        assigned: 0,
        reason: 'no challenge assignments possible (all claims self-authored, withdrawn, or capped) — skipping to synthesis',
      });
      return enterSynthesis(ctx);
    }
    state.status = 'discussing';
    state.discussion = { round, stage: 'challenges' };
    state.phaseEnteredAt = ctx.now.toISOString();
    emit(ctx, 'phase.entered', { status: 'discussing', round, stage: 'challenges' });
    const f = await flush(ctx);
    if (!f.ok) return { kind: 'error', error: f.error };
    return stepDiscussing(ctx);
  };

  const stepDiscussing = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    const cursor = state.discussion;
    if (cursor === null) return { kind: 'error', error: err('invalid_transition', 'discussing without cursor') };
    const phase: PhaseKind = cursor.stage === 'challenges' ? 'challenge' : 'author_response';
    await reconcileAttempts(ctx);
    if (await enforceDeadlines(ctx)) {
      return advanceResult('finished', state.status, undefined, { outcome: 'failed' });
    }
    const adm = await admitPhaseOutputs(ctx);
    if (!adm.ok) return { kind: 'error', error: adm.error };

    const unknownNoDispatch = unresolvedUnknown(state, phase, cursor.round);
    if (unknownNoDispatch.length > 0 && !phaseDeadlineExpired(ctx)) {
      const a = unknownNoDispatch[0];
      return blocked(state.status, `launch outcome unknown for ${a.participantId} (requestId ${a.requestId ?? 'none'}); reconcile before continuing — never relaunch`);
    }

    const deadlineExpired = phaseDeadlineExpired(ctx);
    const due = reviewers(state).flatMap((p) =>
      attemptsFor(p, phase, cursor.round).map((attempt) => ({ p, attempt })),
    );
    const launched = deadlineExpired ? { launched: 0 } : await launchDue(ctx, due);
    if ('error' in launched) return launched.error;

    // Re-derived AFTER launching (relaunches minted during launchDue count).
    const all = reviewers(state).flatMap((p) => attemptsFor(p, phase, cursor.round));
    const done = all.every((a) => isBarrierDone(a, deadlineExpired));
    if (!done) {
      return advanceResult(
        launched.launched > 0 ? 'progress' : 'wait',
        state.status,
        launched.launched > 0 ? `launched ${launched.launched} ${phase} worker(s)` : `${phase} round ${cursor.round} active`,
      );
    }

    if (cursor.stage === 'challenges') {
      return enterResponseStage(ctx, cursor.round);
    }
    // Responses done → fold them into the canonical ledger, then next round
    // or synthesis.
    const folded = await foldResponses(ctx, cursor.round);
    if (folded !== null) return folded;
    if (cursor.round < state.config.rounds) {
      return enterChallengeStage(ctx, cursor.round + 1);
    }
    return enterSynthesis(ctx);
  };

  /**
   * Fold the round's admitted ResponsesFiles into the canonical ledger:
   * defend/revise/withdraw/escalate dispositions update claim status, grades
   * are re-derived from re-validated evidence, and every skipped response is
   * journaled visibly. Only responses whose challengeId was actually assigned
   * to that author reach here — admission already verified the envelope.
   */
  const foldResponses = async (ctx: StepCtx, round: number): Promise<StepResult | null> => {
    const { state } = ctx;
    const ledgerR = await readLedger(ctx);
    if (!ledgerR.ok) return { kind: 'error', error: ledgerR.error };
    if (ledgerR.value === null) {
      return { kind: 'error', error: err('invalid_transition', 'claims.json missing at response fold') };
    }
    const ledger = ledgerR.value;
    const admittedResponses = await admittedFiles<ResponsesFile>(ctx, 'author_response', round);
    if (!admittedResponses.ok) return { kind: 'error', error: admittedResponses.error };
    if (admittedResponses.value.length === 0) return null;
    const admittedChallenges = await admittedFiles<ChallengesFile>(ctx, 'challenge', round);
    if (!admittedChallenges.ok) return { kind: 'error', error: admittedChallenges.error };
    const challengeIndex = indexAdmittedChallenges(
      admittedChallenges.value.map((a) => ({ participantId: a.participantId, file: a.file })),
    );
    let snapshot = ctx.snapshot;
    if (snapshot === undefined) {
      const snapR = await store.readSnapshot();
      if (!snapR.ok) return { kind: 'error', error: snapR.error };
      snapshot = snapR.value;
    }
    const applied = applyResponsesToLedger(
      ledger,
      admittedResponses.value.map((a) => ({ participantId: a.participantId, file: a.file })),
      challengeIndex,
      sourceAccess(state, snapshot),
      ctx.now,
    );
    const w = await writeLedger(ctx, ledger);
    if (!w.ok) return { kind: 'error', error: w.error };
    for (const s of applied.skipped) {
      emit(ctx, 'artifact.rejected', { kind: 'response', refId: s.refId, reason: s.reason }, { round });
    }
    for (const rej of applied.evidenceRejections) {
      emit(ctx, 'artifact.rejected', {
        kind: 'response-evidence',
        refId: rej.refId,
        participantId: rej.participantId,
        reason: rej.reason,
      }, { round: rej.round ?? round });
    }
    emit(ctx, 'claim.updated', { kind: 'responses', round, applied: applied.applied, skipped: applied.skipped.length }, { round });
    return null;
  };

  const enterResponseStage = async (ctx: StepCtx, round: number): Promise<StepResult> => {
    const { state } = ctx;
    const ledgerR = await readLedger(ctx);
    if (!ledgerR.ok) return { kind: 'error', error: ledgerR.error };
    if (ledgerR.value === null) return { kind: 'error', error: err('invalid_transition', 'claims.json missing at response stage') };
    const ledger = ledgerR.value;

    const admittedChallenges = await admittedFiles<ChallengesFile>(ctx, 'challenge', round);
    if (!admittedChallenges.ok) return { kind: 'error', error: admittedChallenges.error };
    let snapshot = ctx.snapshot;
    if (snapshot === undefined) {
      const snapR = await store.readSnapshot();
      if (!snapR.ok) return { kind: 'error', error: snapR.error };
      snapshot = snapR.value;
    }
    const applied = applyChallengesToLedger(
      ledger,
      admittedChallenges.value.map((a) => ({ participantId: a.participantId, file: a.file })),
      sourceAccess(state, snapshot),
      ctx.now,
    );
    const w = await writeLedger(ctx, ledger);
    if (!w.ok) return { kind: 'error', error: w.error };
    for (const s of applied.skipped) {
      emit(ctx, 'artifact.rejected', { kind: 'challenge', refId: s.refId, reason: s.reason });
    }
    // Challenger evidence the ledger could not admit is journaled with the
    // qualified challenge id — never silently dropped from the record.
    for (const rej of applied.evidenceRejections) {
      emit(ctx, 'artifact.rejected', {
        kind: 'challenge-evidence',
        refId: rej.refId,
        participantId: rej.participantId,
        reason: rej.reason,
      }, { round: rej.round ?? round });
    }

    const challengeIndex = indexAdmittedChallenges(
      admittedChallenges.value.map((a) => ({ participantId: a.participantId, file: a.file })),
    );
    const plan = assignResponses({
      challenges: challengeIndex,
      claimsById: claimsById(ledger),
      maxPerSeat: state.config.maxResponsesPerSeatPerRound,
    });
    const routedChallengeIds: string[] = [];
    const byteDropped: { claimId: string; authorPid: ParticipantId }[] = [];
    let total = 0;
    for (const [pid, assignments] of plan.assignments) {
      if (assignments.length === 0) continue;
      const p = findParticipant(state, pid);
      if (p === undefined) continue;
      const envRel = paths.responseEnv(pid, round);
      if (ctx.envelopeAssigned.has(envRel)) {
        // Replay: journaled qualified challengeIds are the durable plan —
        // verify bytes on v1, never rewrite.
        const v = await verifiedRead(ctx, envRel);
        if (!v.ok) {
          integrityViolation(ctx, envRel, v.error);
          return { kind: 'error', error: v.error };
        }
        routedChallengeIds.push(...ctx.envelopeAssigned.get(envRel)!);
      } else {
        const base = makeEnvelopeBase<ResponseAssignment>({
          runId: state.runId,
          phase: 'author_response',
          round,
          recipientId: pid,
          outputPath: paths.responseOut(pid, round),
          outputContract: 'ResponsesFile',
        });
        const fit = fitEnvelope(base, assignments, state.config.envelopeBytes);
        // Authorization units are the qualified challengeIds inside kept
        // assignments — the ids admission checks responses against.
        const assignedIds = fit.envelope.assignments.flatMap((a) =>
          a.challenges.map((c) => c.challengeId),
        );
        const w = await mintedWrite(ctx, envRel, JSON.stringify(fit.envelope, null, 2), 'envelope');
        if (!w.ok) return { kind: 'error', error: w.error };
        emit(ctx, 'envelope.built', {
          path: envRel,
          recipientId: pid,
          round,
          assigned: fit.envelope.assignments.length,
          assignedIds,
          omitted: fit.omitted.map((a) => a.claimId),
          bytes: fit.bytes,
          ...(w.value.receipt !== undefined ? receiptJournalFields(w.value.receipt) : {}),
        }, { participantId: pid, phase: 'author_response', round });
        ctx.envelopeAssigned.set(envRel, assignedIds);
        routedChallengeIds.push(...assignedIds);
        for (const o of fit.omitted) byteDropped.push({ claimId: o.claimId, authorPid: pid });
      }
      ensureStageAttempt(p, 'author_response', round);
      total += ctx.envelopeAssigned.get(envRel)!.length;
    }
    // Response routing ONCE per stage: routed qualified ids + byte-dropped
    // claim-level assignments + per-seat cap omissions + unroutables —
    // persisted to the ledger alongside the round's challenge record.
    recordResponseRouting(ledger, round, {
      routedChallengeIds: [...new Set(routedChallengeIds)],
      byteDropped,
      capOmitted: plan.omitted.map((o) => ({ challengeId: o.challengeId, claimId: o.claimId, authorPid: o.authorPid })),
      unroutable: plan.unroutable.map((u) => ({ challengeId: u.challengeId, claimId: u.claimId, reason: u.reason })),
    });
    const wl2 = await writeLedger(ctx, ledger);
    if (!wl2.ok) return { kind: 'error', error: wl2.error };
    for (const u of plan.unroutable) {
      emit(ctx, 'envelope.built', {
        kind: 'response-unroutable',
        challengeId: u.challengeId,
        claimId: u.claimId,
        reason: u.reason,
      }, { round });
    }
    for (const o of plan.omitted) {
      emit(ctx, 'envelope.built', {
        kind: 'response-omitted',
        challengeId: o.challengeId,
        claimId: o.claimId,
        authorPid: o.authorPid,
        reason: 'author at cap',
      }, { round });
    }

    if (total === 0) {
      emit(ctx, 'envelope.built', {
        round,
        assigned: 0,
        reason: 'no routable challenges to authors — skipping response stage',
      });
      if (round < state.config.rounds) return enterChallengeStage(ctx, round + 1);
      return enterSynthesis(ctx);
    }
    state.discussion = { round, stage: 'responses' };
    state.phaseEnteredAt = ctx.now.toISOString();
    emit(ctx, 'phase.entered', { status: 'discussing', round, stage: 'responses' });
    const f = await flush(ctx);
    if (!f.ok) return { kind: 'error', error: f.error };
    return stepDiscussing(ctx);
  };

  const enterSynthesis = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    const scribe = findParticipant(state, SCRIBE_PID);
    if (scribe === undefined) return { kind: 'error', error: err('invalid_transition', 'scribe participant missing') };
    ensureStageAttempt(scribe, 'scribe_synthesis', null);
    state.status = 'synthesising';
    state.discussion = null;
    state.phaseEnteredAt = ctx.now.toISOString();
    emit(ctx, 'phase.entered', { status: 'synthesising' });
    const f = await flush(ctx);
    if (!f.ok) return { kind: 'error', error: f.error };
    return stepSynthesising(ctx);
  };

  const stepSynthesising = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    await reconcileAttempts(ctx);
    if (await enforceDeadlines(ctx)) {
      return advanceResult('finished', state.status, undefined, { outcome: 'failed' });
    }
    const adm = await admitPhaseOutputs(ctx);
    if (!adm.ok) return { kind: 'error', error: adm.error };

    const p = findParticipant(state, SCRIBE_PID);
    if (p === undefined) return { kind: 'error', error: err('invalid_transition', 'scribe participant missing') };
    const attempt = attemptsFor(p, 'scribe_synthesis', null).at(-1)!;
    if (attempt.status === 'planned' || attempt.status === 'intent_recorded') {
      const lo = await launchAttempt(ctx, p, attempt);
      if (lo.kind === 'launched') return advanceResult('progress', state.status, 'scribe synthesis launched');
      if (lo.kind === 'failed') return blocked(state.status, 'scribe synthesis launch failed; reconcile');
      if (lo.kind === 'concurrency') return advanceResult('wait', state.status, 'concurrency slots held by unresolved workers — scribe synthesis deferred');
      return launchErrorResult(ctx, lo);
    }
    if (ACTIVE_ATTEMPT.has(attempt.status)) {
      return attempt.status === 'unknown' && attempt.dispatchId === null
        ? blocked(state.status, `scribe synthesis launch unknown; reconcile requestId ${attempt.requestId ?? 'none'}`)
        : advanceResult('wait', state.status, 'scribe synthesis working');
    }
    if (ctx.rejectedAttempts.has(attempt.attemptId) || attempt.status === 'timed_out') {
      // Scribe output unusable: the runner still owns canonical claims and
      // coverage, so degrade to a runner-only report with the limitation noted.
      emit(ctx, 'error', { note: 'scribe synthesis unavailable; rendering runner-canonical report without scribe narrative' });
    }

    return finalizeReport(ctx);
  };

  const runnerLimitations = async (ctx: StepCtx): Promise<string[]> => {
    const { state } = ctx;
    const out: string[] = [];
    const seats = reviewers(state);
    const completed = seats.filter((p) =>
      attemptsFor(p, 'independent_review').some((a) => a.artifacts.length > 0),
    ).length;
    const quorum = Math.ceil(state.config.quorumRatio * Math.max(1, seats.length));
    if (completed < quorum) {
      out.push(`quorum not met: ${completed}/${seats.length} seats completed (quorum ${quorum})`);
    }
    const failedSeats = seats.filter((p) =>
      attemptsFor(p, 'independent_review').every((a) => a.artifacts.length === 0),
    );
    if (failedSeats.length > 0) {
      out.push(`seats with no admitted findings: ${failedSeats.map((p) => p.participantId).join(', ')}`);
    }
    const lingering = state.participants.flatMap((p) =>
      p.attempts.filter((a) => a.status === 'unknown').map((a) => `${a.participantId}/${a.attemptId} (dispatch ${a.dispatchId ?? 'unknown'}, requestId ${a.requestId ?? 'none'})`),
    );
    if (lingering.length > 0) {
      out.push(`worker outcome(s) never resolved — may still be running; terminal reuse blocked: ${lingering.join('; ')}`);
    }
    const journal = await store.readJournal();
    if (journal.ok) {
      const rejections = journal.value.filter((e) => e.type === 'artifact.rejected').length;
      if (rejections > 0) out.push(`${rejections} artifact/evidence rejection(s); see events.jsonl`);
      const omitted = journal.value
        .filter((e) => e.type === 'envelope.built')
        .flatMap((e) => (Array.isArray(e.payload?.omitted) ? (e.payload!.omitted as unknown[]) : []))
        .length;
      if (omitted > 0) out.push(`${omitted} envelope assignment(s) omitted by size/cap bounds; see events.jsonl`);
    }
    const synth = findParticipant(state, SCRIBE_PID);
    if (synth !== undefined) {
      const s = attemptsFor(synth, 'scribe_synthesis').at(-1);
      if (s !== undefined && (s.status !== 'settled_ok' || s.artifacts.length === 0)) {
        out.push('scribe synthesis did not produce a validated report; runner rendered report.md deterministically');
      }
    }
    return out;
  };

  const finalizeReport = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    const [proposedR, approvedR, ledgerR] = await Promise.all([
      store.readProposedRoster(),
      store.readApprovedRoster(),
      readLedger(ctx),
    ]);
    if (!proposedR.ok || !approvedR.ok || !ledgerR.ok || ledgerR.value === null) {
      return {
        kind: 'error',
        error: !ledgerR.ok
          ? ledgerR.error
          : err('invalid_transition', 'cannot finalize: roster or ledger artifacts missing'),
      };
    }
    const ledger = ledgerR.value;

    // Final drift check — detect, never claim prevention. Approval/snapshot
    // revalidation gates launches only; the tree may have drifted since the
    // synthesis launch. The run still closes and the report is still written,
    // but the drift is journaled and marked visibly in the emitted report.
    const runnerLims = await runnerLimitations(ctx);
    let driftBlocksFullCoverage = false;
    if (ctx.driftResult === undefined) ctx.driftResult = await store.verifySourceSnapshot();
    const drift = ctx.driftResult;
    if (!drift.ok) {
      emit(ctx, 'snapshot.drift', {
        scope: 'pre-report',
        verifiable: false,
        error: drift.error.message,
      });
      runnerLims.push(
        `source snapshot verification failed before report (${drift.error.message}) — drift status unverifiable; coverage marked partial`,
      );
      driftBlocksFullCoverage = true;
    } else if (drift.value.drift) {
      const snapR = ctx.snapshot !== undefined ? { ok: true as const, value: ctx.snapshot } : await store.readSnapshot();
      const pinned = new Set(Object.keys(snapR.ok ? snapR.value.files : {}));
      const manifestChanged = drift.value.changed.filter((p) => pinned.has(p));
      const added = drift.value.changed.filter((p) => !pinned.has(p));
      emit(ctx, 'snapshot.drift', {
        scope: 'pre-report',
        changed: drift.value.changed,
        manifestChanged,
        added,
        blocking: false,
      });
      if (manifestChanged.length > 0) {
        driftBlocksFullCoverage = true;
        runnerLims.push(
          `source drift after approval: ${manifestChanged.length} pinned file(s) changed/removed (${manifestChanged.slice(0, 10).join(', ')}) — report reflects the approved snapshot, not the live tree`,
        );
      }
      if (added.length > 0) {
        runnerLims.push(
          `${added.length} file(s) added to the reviewed tree after the approved snapshot — outside the reviewed corpus`,
        );
      }
    }

    // Scribe narrative only — its claims/coverage are never trusted. Prefer
    // the narrative SynthesisFile contract; fall back to a legacy full
    // ReportFile artifact (both carry summary + limitations). The artifact
    // is an admitted worker output: verify exact bytes on v1 — tampered or
    // unadmitted bytes degrade to the runner-rendered narrative WITH a
    // visible journal entry, never silently trusted.
    let scribe: ScribeNarrative | undefined;
    let rawReport: { ok: true; value: unknown } | { ok: false } = { ok: false };
    const reportExists = await store.artifactExists(paths.scribeReportJson);
    if (reportExists.ok && reportExists.value) {
      const v = await verifiedRead(ctx, paths.scribeReportJson);
      if (v.ok) {
        try {
          rawReport = { ok: true, value: JSON.parse(v.value.text) };
        } catch {
          emit(ctx, 'error', { op: 'scribe-narrative', path: paths.scribeReportJson, detail: 'verified scribe report is not valid JSON' });
        }
      } else {
        integrityViolation(ctx, paths.scribeReportJson, v.error);
        runnerLims.push(`scribe report failed integrity verification (${v.error.message}) — runner-rendered narrative used`);
      }
    }
    if (rawReport.ok) {
      const synParse = (validationNs as {
        parseSynthesisFile?: (
          v: unknown,
          o: { runId: string; participantId?: string },
        ) => { ok: true; value: { summary: string; limitations: string[] } } | { ok: false; issues?: unknown[] };
      }).parseSynthesisFile?.(rawReport.value, { runId: state.runId });
      if (synParse !== undefined && synParse.ok) {
        scribe = { summary: synParse.value.summary, limitations: synParse.value.limitations };
      } else {
        const parsed = parseReportFile(rawReport.value, { runId: state.runId });
        if (parsed.ok) {
          scribe = { summary: parsed.value.summary, limitations: parsed.value.limitations };
        }
      }
    }
    const snapForProvenance = ctx.snapshot !== undefined
      ? { ok: true as const, value: ctx.snapshot }
      : await store.readSnapshot();
    const report = buildCouncilReport({
      runId: state.runId,
      generatedAt: ctx.now.toISOString(),
      config: state.config,
      proposed: proposedR.value,
      approved: approvedR.value,
      participants: state.participants,
      ledger,
      scribe,
      runnerLimitations: runnerLims,
      ...(snapForProvenance.ok
        ? {
            provenance: {
              snapshotId: snapForProvenance.value.snapshotId,
              gitHead: snapForProvenance.value.gitHead,
              targetRoot: snapForProvenance.value.targetRoot,
              objective: state.objective,
            },
          }
        : {}),
    });
    // Drift detected after approval means the emitted report cannot claim
    // full coverage of the reviewed corpus — mark it visibly partial.
    if (driftBlocksFullCoverage) report.coverage.partial = true;
    // Quorum counts seats with an ADMITTED independent-review artifact —
    // never process success. Below quorum the report is an explicitly
    // partial diagnostic, not a full-coverage claim (clm_0007).
    const admittedSeats = reviewers(state).filter((p) =>
      attemptsFor(p, 'independent_review').some((a) => a.artifacts.length > 0),
    ).length;
    const quorum = Math.ceil(state.config.quorumRatio * Math.max(1, reviewers(state).length));
    const belowQuorum = admittedSeats < quorum;
    if (belowQuorum) report.coverage.partial = true;
    const writes: [string, string][] = [
      [paths.reportJson, JSON.stringify(report, null, 2)],
      [paths.reportMd, renderReportMarkdown(report)],
      [paths.summaryMd, renderSummaryMarkdown(report)],
    ];
    for (const [rel, content] of writes) {
      const w = await mintedWrite(ctx, rel, content, 'report');
      if (!w.ok) return { kind: 'error', error: w.error };
      emit(ctx, 'report.written', {
        path: rel,
        ...(w.value.receipt !== undefined ? receiptJournalFields(w.value.receipt) : {}),
      });
      ctx.artifacts.push(rel);
    }
    state.status = 'reported';
    emit(ctx, 'run.finished', {
      outcome: 'succeeded',
      partial: report.coverage.partial,
      ...(belowQuorum ? { belowQuorum: true, admittedSeats, quorum } : {}),
    });
    await releaseRetainedWorkers(ctx);
    const f = await flush(ctx);
    if (!f.ok) return { kind: 'error', error: f.error };
    const finishNote = belowQuorum
      ? `run complete (PARTIAL coverage — ${admittedSeats}/${quorum} quorum; diagnostic report only)`
      : report.coverage.partial
        ? 'run complete (PARTIAL coverage)'
        : 'run complete';
    return advanceResult('finished', state.status, finishNote, {
      outcome: 'succeeded',
      reportPaths: writes.map(([rel]) => rel),
    });
  };

  /**
   * Release retained sessions only when every launch is known settled. A
   * timed-out or outcome-unknown worker may still be alive — its terminal is
   * preserved and the lingering uncertainty stays on the record.
   */
  const releaseRetainedWorkers = async (ctx: StepCtx): Promise<void> => {
    const KNOWN_SETTLED = new Set(['settled_ok', 'settled_failed', 'stopped']);
    for (const p of ctx.state.participants) {
      if (p.retainedTerminal === null) continue;
      const settled = p.attempts.filter((a) => a.dispatchId !== null && KNOWN_SETTLED.has(a.status));
      const uncertain = p.attempts.filter(
        (a) => ACTIVE_ATTEMPT.has(a.status) || a.status === 'timed_out',
      );
      if (uncertain.length > 0) {
        emit(ctx, 'worker.released', {
          participantId: p.participantId,
          released: false,
          reason: 'attempts unresolved or possibly lingering; release refused — terminal preserved',
        });
        continue;
      }
      const last = settled.at(-1);
      if (last === undefined) continue;
      // RA-008 mutation custody: if the journal already holds a release
      // intent/outcome for this dispatch the call may have landed — never
      // blind-reissue; reconcile through documented reads instead.
      if (ctx.releaseRequested.has(last.dispatchId!)) {
        emit(ctx, 'worker.released', {
          participantId: p.participantId,
          dispatchId: last.dispatchId,
          released: false,
          outcome: 'skipped',
          reason: 'release already journaled for this dispatch; outcome unconfirmed — reconcile, never blind-reissue',
        });
        continue;
      }
      await releaseDispatch(ctx, p.participantId, last.dispatchId!);
    }
  };

  /**
   * One journaled worker-release (intent → host call → receipt). Callers
   * check `releaseRequested` first: a journaled release is never re-issued.
   * The receipt echoes the host state (e.g. 'retained' — Orca keeps
   * pre-existing terminals, which is why close follows release).
   */
  const releaseDispatch = async (
    ctx: StepCtx,
    participantId: string,
    dispatchId: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    ctx.releaseRequested.add(dispatchId);
    emit(ctx, 'worker.released', {
      participantId,
      dispatchId,
      released: false,
      outcome: 'intent',
      ...extra,
    });
    const fi = await flush(ctx);
    if (!fi.ok) {
      emit(ctx, 'error', {
        op: 'worker-release',
        dispatchId,
        detail: `release intent could not be journaled (${fi.error.message}); not issuing releaseWorker without custody`,
      });
      return;
    }
    const r = await host.releaseWorker({ dispatchId });
    emit(ctx, 'worker.released', {
      participantId,
      dispatchId,
      released: r.ok ? r.value.released : false,
      outcome: r.ok ? (r.value.released ? 'released' : 'refused') : 'error',
      ...(r.ok && r.value.state !== undefined ? { hostState: r.value.state } : {}),
      ...(r.ok ? {} : { error: r.error.message }),
      ...extra,
    });
  };

  // ── Terminal custody cleanup ──────────────────────────────────────────────
  //
  // Custody rule: only a terminal this run CREATED and JOURNALED is ever
  // closed — an argv-lane terminal-create receipt for one of its attempts, or
  // the supervisor startup record handed in by the CLI. Retained terminals
  // adopted from host listings, reused terminals of other runs, and anything
  // unrecorded are never touched. Closing uses only the documented
  // `terminal show` / `terminal close` surface through the adapter.

  /** Attempt statuses that prove no worker can still be running. */
  const CLOSE_SETTLED = new Set<AttemptStatus>(['settled_ok', 'settled_failed', 'stopped']);

  /** Journal a close skip once per (handle, reason). */
  const skipClose = (
    ctx: StepCtx,
    t: { handle: string; owner: 'participant' | 'supervisor'; participantId?: string },
    reason: string,
    source: 'engine' | 'cleanup',
  ): TerminalCleanupEntry => {
    const key = `${t.handle}|${reason}`;
    if (!ctx.terminalCloseSkips.has(key)) {
      ctx.terminalCloseSkips.add(key);
      emit(ctx, 'terminal.close', { stage: 'skipped', terminalHandle: t.handle, owner: t.owner, reason, source },
        t.participantId !== undefined ? { participantId: t.participantId } : undefined);
    }
    return {
      terminalHandle: t.handle,
      owner: t.owner,
      ...(t.participantId !== undefined ? { participantId: t.participantId } : {}),
      outcome: 'skipped',
      reason,
    };
  };

  /**
   * Journaled close of one custody-proven terminal: intent flushed BEFORE the
   * host call, receipt after. A receipt means done for the engine (a failed
   * close is retried only by `council cleanup`); an intent without a receipt
   * may be retried — closing an already-closed terminal is harmless — and is
   * reported as such. Failures are journaled and never change run state.
   */
  const closeTerminalWithCustody = async (
    ctx: StepCtx,
    t: { handle: string; owner: 'participant' | 'supervisor'; participantId?: string; attemptId?: string; reason: string },
    source: 'engine' | 'cleanup',
  ): Promise<TerminalCleanupEntry> => {
    const base = {
      terminalHandle: t.handle,
      owner: t.owner,
      ...(t.participantId !== undefined ? { participantId: t.participantId } : {}),
    };
    const where = t.participantId !== undefined ? { participantId: t.participantId } : undefined;
    const prior = ctx.terminalCloses.get(t.handle);
    if (prior?.outcome === 'closed' || prior?.outcome === 'already_gone') {
      return { ...base, outcome: 'skipped', reason: `already ${prior.outcome === 'closed' ? 'closed' : 'gone'} (journaled receipt)` };
    }
    if (prior?.outcome === 'failed' && source === 'engine') {
      return { ...base, outcome: 'skipped', reason: 'an earlier close failed (journaled receipt) — retry with council cleanup' };
    }
    if (typeof host.closeTerminal !== 'function') {
      return skipClose(ctx, t, 'host adapter cannot close terminals', source);
    }
    const retriedIntent = prior !== undefined && prior.outcome === undefined;
    const closeId = `tc_${crypto.randomUUID().slice(0, 12)}`;
    emit(ctx, 'terminal.close', {
      stage: 'intent',
      closeId,
      terminalHandle: t.handle,
      owner: t.owner,
      ...(t.attemptId !== undefined ? { attemptId: t.attemptId } : {}),
      reason: t.reason,
      source,
      ...(retriedIntent ? { retriedIntent: true } : {}),
    }, where);
    ctx.terminalCloses.set(t.handle, {});
    const fi = await flush(ctx);
    if (!fi.ok) {
      emit(ctx, 'error', {
        op: 'terminal-close',
        terminalHandle: t.handle,
        detail: `close intent could not be journaled (${fi.error.message}); not closing without custody`,
      });
      return { ...base, outcome: 'failed', code: 'custody_journal_failed', reason: 'close intent could not be journaled' };
    }
    const r = await host.closeTerminal({ terminalHandle: t.handle });
    const outcome = r.ok ? r.value.outcome : 'failed';
    const code = r.ok ? r.value.code : r.error.code;
    const detail = r.ok ? r.value.detail : r.error.message;
    emit(ctx, 'terminal.close', {
      stage: 'receipt',
      closeId,
      terminalHandle: t.handle,
      owner: t.owner,
      ...(t.attemptId !== undefined ? { attemptId: t.attemptId } : {}),
      outcome,
      ...(code !== undefined ? { code } : {}),
      ...(detail !== undefined ? { detail: detail.slice(0, 512) } : {}),
      ...(r.ok && r.value.requestId !== undefined ? { requestId: r.value.requestId } : {}),
      source,
    }, where);
    ctx.terminalCloses.set(t.handle, { outcome });
    return {
      ...base,
      outcome,
      ...(code !== undefined ? { code } : {}),
      ...(outcome === 'failed' && detail !== undefined ? { reason: detail.slice(0, 256) } : {}),
      ...(retriedIntent ? { retriedIntent: true } : {}),
    };
  };

  /** Engine-created participant terminals: one entry per journaled handle. */
  const recordedParticipantTerminals = (ctx: StepCtx): { handle: string; p: Participant; creator: AttemptId; dispatchMarker: boolean }[] => {
    const out = new Map<string, { handle: string; p: Participant; creator: AttemptId; dispatchMarker: boolean }>();
    for (const [aid, c] of ctx.terminalCustody) {
      if (out.has(c.handle)) continue;
      const p = ctx.state.participants.find((pp) => pp.attempts.some((a) => a.attemptId === aid));
      if (p === undefined) continue; // unattributable custody — never touched
      out.set(c.handle, { handle: c.handle, p, creator: aid, dispatchMarker: c.dispatchMarker === true });
    }
    return [...out.values()];
  };

  /**
   * Release-then-close one participant terminal when every attempt that ran
   * on it is proven finished. Engine mode trusts persisted attempt status
   * only; cleanup mode may additionally OBSERVE an unsettled dispatch and
   * treat a host verdict (settled/fenced/lost) as finished.
   */
  const cleanupParticipantTerminal = async (
    ctx: StepCtx,
    rec: { handle: string; p: Participant; creator: AttemptId; dispatchMarker: boolean },
    reason: string,
    source: 'engine' | 'cleanup',
  ): Promise<TerminalCleanupEntry> => {
    const { handle, p } = rec;
    const t = { handle, owner: 'participant' as const, participantId: p.participantId };
    const prior = ctx.terminalCloses.get(handle);
    if (prior?.outcome === 'closed' || prior?.outcome === 'already_gone') {
      return { terminalHandle: handle, owner: 'participant', participantId: p.participantId, outcome: 'skipped', reason: `already ${prior.outcome === 'closed' ? 'closed' : 'gone'} (journaled receipt)` };
    }
    const users = p.attempts.filter((a) => a.terminalHandle === handle || a.attemptId === rec.creator);
    for (const a of users) {
      if (CLOSE_SETTLED.has(a.status)) continue;
      // Never dispatched: terminal-create receipt promised a marker and no
      // worker-start marker exists — no worker can be on this terminal.
      if (
        a.dispatchId === null && a.attemptId === rec.creator && rec.dispatchMarker &&
        !ctx.workerStartMarkers.has(a.attemptId)
      ) continue;
      if (source === 'cleanup' && a.dispatchId !== null) {
        const obs = await host.observeWorker({ dispatchId: a.dispatchId });
        if (obs.ok && obs.value.liveness === 'finished') continue;
        return skipClose(ctx, t, `dispatch ${a.dispatchId} (${a.attemptId}) is not proven settled (${obs.ok ? obs.value.liveness : `observe failed: ${obs.error.code}`})`, source);
      }
      return skipClose(ctx, t, `attempt ${a.attemptId} is ${a.status} — its worker may still be live or reuse this terminal`, source);
    }
    const last = users.filter((a) => a.dispatchId !== null).at(-1);
    if (last !== undefined && !ctx.releaseRequested.has(last.dispatchId!)) {
      await releaseDispatch(ctx, p.participantId, last.dispatchId!, { terminalHandle: handle });
    }
    const entry = await closeTerminalWithCustody(ctx, { ...t, attemptId: rec.creator, reason }, source);
    if (p.retainedTerminal === handle && entry.outcome !== 'failed') p.retainedTerminal = null;
    return entry;
  };

  /**
   * Terminal-state cleanup (reported / failed / cancelled): every
   * engine-created participant terminal whose dispatches are settled,
   * fenced or never issued is released (worker-release, as before) and then
   * closed — Orca reports these argv-lane terminals 'retained' and would
   * otherwise leave them as idle agent sessions. Idempotent: journaled
   * receipts mean done; skips are journaled once. Never changes run state.
   */
  const finalizeRunTerminals = async (
    ctx: StepCtx,
    source: 'engine' | 'cleanup',
    callerHandle?: string,
  ): Promise<TerminalCleanupEntry[]> => {
    const out: TerminalCleanupEntry[] = [];
    for (const rec of recordedParticipantTerminals(ctx)) {
      out.push(
        callerHandle !== undefined && rec.handle === callerHandle
          ? skipClose(ctx, { handle: rec.handle, owner: 'participant', participantId: rec.p.participantId }, 'this is the calling terminal — a terminal never closes itself', source)
          : await cleanupParticipantTerminal(ctx, rec, `run_${ctx.state.status}`, source),
      );
    }
    return out;
  };

  /** Supervisor terminal (cleanup only): custody comes from its startup record. */
  const cleanupSupervisorTerminal = async (
    ctx: StepCtx,
    sup: SupervisorCleanupCustody,
    callerHandle: string | undefined,
  ): Promise<TerminalCleanupEntry> => {
    const t = { handle: sup.terminalHandle, owner: 'supervisor' as const };
    const prior = ctx.terminalCloses.get(sup.terminalHandle);
    if (prior?.outcome === 'closed' || prior?.outcome === 'already_gone') {
      return { terminalHandle: sup.terminalHandle, owner: 'supervisor', outcome: 'skipped', reason: `already ${prior.outcome === 'closed' ? 'closed' : 'gone'} (journaled receipt)` };
    }
    if (callerHandle !== undefined && callerHandle === sup.terminalHandle) {
      return skipClose(ctx, t, 'this is the calling terminal — a terminal never closes itself; run cleanup from another terminal', 'cleanup');
    }
    const recorded = ctx.state.supervisor;
    if (recorded !== null && recorded.terminalHandle !== sup.terminalHandle) {
      return skipClose(ctx, t, `startup record terminal differs from the recorded supervisor ${recorded.terminalHandle} — custody unproven`, 'cleanup');
    }
    const dispatchId = sup.dispatchId ?? recorded?.dispatchId ?? null;
    if (sup.startupStatus === 'attached') {
      if (dispatchId === null) return skipClose(ctx, t, 'attached supervisor has no recorded dispatch — custody unproven', 'cleanup');
      const obs = await host.observeWorker({ dispatchId });
      // Settled (worker_done / fenced) → release, then close. Idle without a
      // verdict on a TERMINAL run → nothing is left for it to drive (a
      // cancelled run never prompts worker_done, and Orca cannot stop an
      // external terminal): close it, journaling exactly why. Working,
      // waiting on a human, unverifiable or unobservable → keep refusing.
      if (obs.ok && obs.value.liveness === 'idle' && TERMINAL_STATUS.has(ctx.state.status)) {
        const entry = await closeTerminalWithCustody(ctx, {
          ...t,
          reason: `terminal run (${ctx.state.status}); supervisor idle without worker_done — dispatch ${dispatchId} unsettled, nothing left to drive`,
        }, 'cleanup');
        return entry.outcome === 'closed' || entry.outcome === 'already_gone'
          ? { ...entry, reason: 'terminal run; supervisor idle without worker_done' }
          : entry;
      }
      if (!obs.ok || obs.value.liveness !== 'finished') {
        return skipClose(ctx, t, `supervisor dispatch ${dispatchId} is not proven settled (${obs.ok ? obs.value.liveness : `observe failed: ${obs.error.code}`})`, 'cleanup');
      }
      if (!ctx.releaseRequested.has(dispatchId)) {
        await releaseDispatch(ctx, 'supervisor', dispatchId, { scope: 'supervisor', terminalHandle: sup.terminalHandle });
      }
    } else if (sup.startupStatus !== 'terminal_created' && sup.startupStatus !== 'paused') {
      // intent/task_created carry no terminal; start_issued may own a worker.
      return skipClose(ctx, t, `supervisor startup is ${sup.startupStatus} — worker-start may have been issued; reconcile first`, 'cleanup');
    } else if (sup.pausedCode === 'terminal_owned' || sup.pausedCode === 'custody_unproven') {
      // A resume found (or could not rule out) a dispatch on this terminal.
      return skipClose(ctx, t, `supervisor startup paused with ${sup.pausedCode} — a dispatch may own this terminal; reconcile first`, 'cleanup');
    }
    return closeTerminalWithCustody(ctx, { ...t, reason: 'supervisor_after_run' }, 'cleanup');
  };

  // ── Opt-in lean-MCP environment (config.leanMcp) ──────────────────────────
  //
  // `.devin` project-local stubs at the worker worktree root suppress the
  // user-scope MCP helpers a Devin session would otherwise spawn (verified
  // mechanism — .council-dev/reports/lean-devin.md). Generated ONCE per run
  // before the first Devin-lane launch (the user's server list drifts between
  // runs, so this is never an init-time artifact); the journaled record is
  // what terminal cleanup restores from. Everything is best-effort:
  // generation or restore problems are journaled warnings, never launch or
  // run failures. Server NAMES are the only thing enumerated — command/URL
  // lines carry credentials and never enter the journal, state, or artifacts.

  /**
   * Generate the lean env before a Devin-lane launch, once per run. The
   * journal leads every write: probe → plan (reads only) → journaled intent →
   * back up + write → journaled receipt → smoke check. A `skipped` receipt is
   * the durable "declined" marker — deterministic, never retried this run.
   */
  const ensureLeanEnv = async (ctx: StepCtx, p: Participant): Promise<Result<void>> => {
    if (ctx.state.config.leanMcp !== true) return ok(undefined);
    if (ctx.leanEnv !== undefined) return ok(undefined); // journaled already
    if (p.agent.agent !== 'devin') return ok(undefined); // only Devin lanes read .devin
    const skip = async (reason: string, extra?: Record<string, unknown>): Promise<Result<void>> => {
      ctx.leanEnv = { status: 'skipped', reason };
      emit(ctx, 'lean.env', { stage: 'receipt', op: 'generate', outcome: 'skipped', reason, ...extra });
      return await flush(ctx);
    };
    const probe = deps.leanEnv;
    if (probe === undefined) {
      return skip('no lean-env probe configured — this runner cannot enumerate the worktree/MCP state');
    }
    const root = await probe.worktreeRoot();
    if (!root.ok) {
      return skip(`worktree root unresolved: ${root.error.message}`);
    }
    const worktreeRoot = root.value;
    const listed = await probe.listEnabledMcpNames({ worktreeRoot });
    if (!listed.ok) {
      return skip(`cannot enumerate enabled MCP names: ${listed.error.message}`, { worktreeRoot });
    }
    const names = listed.value;
    const planR = await planLeanWrites({
      worktreeRoot,
      names,
      ...(ctx.leanEnvIntent !== undefined ? { oursNames: ctx.leanEnvIntent.names } : {}),
    });
    if (!planR.ok) return skip(`plan failed: ${planR.error.message}`, { worktreeRoot });
    const plan = planR.value;
    // Journal the exact plan BEFORE any write — a crash mid-generation
    // leaves the intent durable so regeneration can identify our files.
    emit(ctx, 'lean.env', {
      stage: 'intent',
      op: 'generate',
      worktreeRoot,
      names,
      files: plan.files.map((f) => ({ path: f.rel, action: f.action })),
      ...(plan.warnings.length > 0 ? { planWarnings: plan.warnings.slice(0, 8) } : {}),
    });
    const fi = await flush(ctx);
    if (!fi.ok) return fi;
    const applied = await applyLeanPlan({
      plan,
      backupExists: async (backupRel) => {
        const e = await store.artifactExists(backupRel);
        return e.ok === true && e.value === true;
      },
      writeBackup: async (backupRel, bytes) => await store.writeArtifact(backupRel, bytes),
    });
    const gitExclude = await ensureGitExclude(worktreeRoot);
    const warnings = applied.warnings.slice(0, 16);
    ctx.leanEnv = {
      status: 'active',
      worktreeRoot,
      names,
      files: applied.files,
      generatedAt: ctx.now.toISOString(),
    };
    emit(ctx, 'lean.env', {
      stage: 'receipt',
      op: 'generate',
      outcome: 'generated',
      worktreeRoot,
      names,
      files: applied.files,
      generatedAt: ctx.now.toISOString(),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(applied.failures.length > 0 ? { failures: applied.failures.slice(0, 8) } : {}),
      gitExclude: {
        applied: gitExclude.applied,
        ...(gitExclude.excludePath !== undefined ? { path: gitExclude.excludePath } : {}),
        ...(gitExclude.added !== undefined ? { added: gitExclude.added } : {}),
        ...(gitExclude.warning !== undefined ? { warning: gitExclude.warning } : {}),
      },
    });
    const fr = await flush(ctx);
    if (!fr.ok) return fr;
    // Launch-gate smoke check: enabled names we expected to stub but which
    // still enumerate = lean silently degraded. Journaled, never blocking.
    if (applied.files.length > 0) {
      const smoke = await probe.listEnabledMcpNames({ worktreeRoot });
      if (!smoke.ok) {
        emit(ctx, 'lean.env', {
          stage: 'warning',
          op: 'smoke',
          worktreeRoot,
          reason: `smoke check could not re-enumerate MCP names: ${smoke.error.message}`,
        });
      } else {
        const residual = smoke.value.filter((n) => names.includes(n));
        if (residual.length > 0) {
          emit(ctx, 'lean.env', {
            stage: 'warning',
            op: 'smoke',
            worktreeRoot,
            residual,
            reason: `${residual.length} enabled MCP name(s) survived stubbing — lean env is degraded for these servers`,
          });
        }
      }
      if (ctx.events.length > 0) {
        const fw = await flush(ctx);
        if (!fw.ok) return fw;
      }
    }
    return ok(undefined);
  };

  /**
   * Restore the worktree at terminal-run cleanup. 'merged' files get their
   * backed-up bytes restored exactly; 'created' files are deleted (or kept
   * minus our keys when outside content appeared). Idempotent, journaled,
   * and NEVER fails the run or the cleanup pass — every failure is a
   * journaled warning in the report.
   */
  const restoreLeanEnv = async (
    ctx: StepCtx,
    source: 'engine' | 'cleanup',
  ): Promise<LeanEnvCleanupReport | undefined> => {
    const rec = ctx.leanEnv;
    if (rec === undefined || rec.status !== 'active' || rec.files === undefined || rec.files.length === 0) {
      return undefined;
    }
    const worktreeRoot = rec.worktreeRoot;
    if (worktreeRoot === undefined) {
      emit(ctx, 'lean.env', {
        stage: 'warning', op: 'restore', source,
        reason: 'lean env record has no worktreeRoot — cannot restore; inspect the worktree manually',
      });
      return { status: 'skipped', files: [], warnings: ['lean env record missing worktreeRoot'] };
    }
    emit(ctx, 'lean.env', { stage: 'intent', op: 'restore', source, worktreeRoot });
    const fi = await flush(ctx);
    if (!fi.ok) {
      // Restore must not be attempted without its journaled intent — but a
      // cleanup pass must still report, never fail the run's outcome.
      emit(ctx, 'error', {
        op: 'lean-restore',
        detail: `restore intent could not be journaled (${fi.error.message}); files left in place — retry council cleanup`,
      });
      return { status: 'failed', files: [], warnings: [`restore intent unjournaled: ${fi.error.message}`] };
    }
    const result = await restoreLeanFiles({
      worktreeRoot,
      files: rec.files,
      readBackup: async (backupRel) => await store.readArtifact(backupRel),
    });
    const outcome: LeanEnvCleanupReport['status'] = result.allClean ? 'restored' : 'failed';
    ctx.leanEnv = { ...rec, status: 'restored', restoredAt: ctx.now.toISOString() };
    emit(ctx, 'lean.env', {
      stage: 'receipt',
      op: 'restore',
      outcome,
      source,
      worktreeRoot,
      files: result.entries,
      restoredAt: ctx.now.toISOString(),
      ...(result.warnings.length > 0 ? { warnings: result.warnings.slice(0, 16) } : {}),
    });
    // Best-effort flush — cleanup reporting must never crash on it.
    await flush(ctx);
    return {
      status: outcome,
      files: result.entries,
      warnings: result.warnings,
    };
  };

  /**
   * Runner-originated mail with the advertised per-recipient budget actually
   * enforced (clm_0003): every recipient target may receive at most
   * config.maxMailPerParticipant runner sends, counted from the journal so a
   * restart cannot reset the budget. 'unknown' outcomes charge the budget —
   * the mail may have landed. Refusals are journaled, never silent.
   */
  const sendBoundedMail = async (
    ctx: StepCtx,
    input: {
      to: string;
      subject: string;
      body: string;
      taskId?: string;
      dispatchId?: string;
    },
    kind: string,
  ): Promise<void> => {
    const cap = ctx.state.config.maxMailPerParticipant;
    const sent = ctx.mailSentByTarget.get(input.to) ?? 0;
    if (sent >= cap) {
      emit(ctx, 'mail.sent', {
        to: input.to,
        kind,
        outcome: 'budget_refused',
        sent,
        cap,
        subject: input.subject,
      });
      return;
    }
    // RA-008 mutation custody: journal the send intent (and charge the cap)
    // BEFORE the host call — a crash between issue and receipt must leave
    // the send charged, never resent blind.
    const mailIntentId = `mi_${crypto.randomUUID().slice(0, 12)}`;
    emit(ctx, 'mail.sent', {
      to: input.to,
      kind,
      outcome: 'intent',
      mailIntentId,
      subject: input.subject,
    });
    const fi = await flush(ctx);
    if (!fi.ok) {
      emit(ctx, 'error', {
        op: 'mail-send',
        detail: `mail intent could not be journaled (${fi.error.message}); not issuing sendNotification without custody`,
      });
      return;
    }
    ctx.mailSentByTarget.set(input.to, sent + 1); // intent persisted ⇒ possibly-landed ⇒ charged
    const note = await host.sendNotification(input);
    // Host diagnostics: an uncertain send carries the Orca error code and a
    // bounded message on its 'unknown' receipt; a failure carries them on the error.
    const errorCode: unknown = note.ok ? note.value.errorCode : note.error.details?.adapterCode ?? note.error.code;
    const errorText: unknown = note.ok ? note.value.error : note.error.message;
    emit(ctx, 'mail.sent', {
      to: input.to,
      outcome: note.ok ? note.value.outcome : 'error',
      mailIntentId,
      ...(note.ok && note.value.requestId !== undefined ? { requestId: note.value.requestId } : {}),
      ...(note.ok && note.value.messageId !== undefined ? { messageId: note.value.messageId } : {}),
      ...(typeof errorCode === 'string' ? { errorCode: errorCode.slice(0, 128) } : {}),
      ...(typeof errorText === 'string' ? { error: errorText.slice(0, 512) } : {}),
      kind,
    });
    if (note.ok && note.value.outcome === 'sent') ctx.state.consumption.mailSent += 1;
  };

  // ── Lifecycle wakes: durable backlog + bounded post-lock drain ─────────────

  const TERMINAL_STATUS: ReadonlySet<RunStatus> = new Set(['reported', 'failed', 'cancelled']);
  const TERMINAL_OUTCOME: Record<string, 'succeeded' | 'failed' | 'cancelled'> = {
    reported: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
  };

  /**
   * P-D4 wake events — the lifecycle subset of ProgressEvent. `cursor` pins a
   * discussion wake to its durable round/stage instead of whatever
   * facts.discussion happens to hold at send time; `approvalHash` pins the
   * approval intent to the bound hash; `historical` labels a journal-replayed
   * catch-up — it never changes the dedupe key, budget charge, or custody.
   */
  type WakeEvent =
    | Extract<ProgressEvent, { kind: 'stage' }>
    | Extract<ProgressEvent, { kind: 'blocked' }>
    | Extract<ProgressEvent, { kind: 'finished' }>
    | Extract<ProgressEvent, { kind: 'approval' }>;
  interface WakePlan {
    events: WakeEvent[];
    /** Terminal transition — the last wake opportunity: every pending catch-up must drain, never stranded. */
    terminal: boolean;
  }

  const wakeSha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

  /**
   * The dedupe identity progress.intentFor derives — kept here ONLY to
   * prefer a fresh (unmarked) event over its historical replay copy when
   * both exist in one plan. It is never used to decide whether to send.
   */
  const wakeKeyOf = (e: WakeEvent, state: CouncilState): string => {
    switch (e.kind) {
      case 'stage': {
        if (TERMINAL_STATUS.has(e.status)) return `finished:${TERMINAL_OUTCOME[e.status]}`;
        if (e.status === 'discussing') {
          const c = e.cursor ?? state.discussion;
          return c !== null && c !== undefined ? `stage:discussing:r${c.round}:${c.stage}` : 'stage:discussing';
        }
        return `stage:${e.status}`;
      }
      case 'blocked': return `blocked:${wakeSha8(e.reason)}`;
      case 'approval': return `approval:${(e.approvalHash ?? state.approvalHash ?? 'unknown').slice(0, 8)}`;
      case 'finished': return `finished:${e.outcome}`;
    }
  };

  /**
   * Historical catch-up backlog (P-D4): replay durable lifecycle records —
   * the journal read at buildCtx plus this step's own emissions — into wake
   * events carrying their ORIGINAL identity. A stage whose outbox intent was
   * lost between the state flush and the send (crash or pre-intent fs/lock
   * failure) is recomputed here on every later advance; the module's durable
   * dedupe makes replays of already-sent intents free, and 'sending' /
   * 'unknown' / 'refused' custody is never blindly retried.
   */
  const backlogWakes = (ctx: StepCtx): WakeEvent[] => {
    const out: WakeEvent[] = [];
    const map = (e: Omit<JournalEvent, 'seq'> | JournalEvent): void => {
      const p = e.payload ?? {};
      if (e.type === 'run.initialized') {
        out.push({ kind: 'stage', status: 'initialized', historical: true });
      } else if (e.type === 'phase.entered') {
        const s = p.status;
        if (s === 'discussing') {
          if (typeof p.round === 'number' && typeof p.stage === 'string') {
            out.push({ kind: 'stage', status: 'discussing', cursor: { round: p.round, stage: p.stage }, historical: true });
          }
        } else if (typeof s === 'string') {
          // Terminal statuses normalise to the finished intent inside the
          // module — the replay stays honest either way.
          out.push({ kind: 'stage', status: s as RunStatus, historical: true });
        }
      } else if (e.type === 'approval.granted') {
        out.push({
          kind: 'approval',
          ...(typeof p.approver === 'string' ? { approver: p.approver } : {}),
          ...(typeof p.hash === 'string' ? { approvalHash: p.hash } : {}),
          historical: true,
        });
      } else if (e.type === 'run.finished') {
        const o = p.outcome;
        out.push({
          kind: 'finished',
          outcome: o === 'succeeded' || o === 'cancelled' ? o : 'failed',
          ...(Array.isArray(p.reportPaths) ? { reportPaths: p.reportPaths as string[] } : {}),
          historical: true,
        });
      } else if (e.type === 'error' && p.op === 'lifecycle.blocked' && typeof p.reason === 'string') {
        out.push({ kind: 'blocked', reason: p.reason, historical: true });
      }
    };
    for (const e of ctx.lifecycleJournal) map(e);
    for (const e of ctx.events) map(e);
    return out;
  };

  /**
   * Order the drain: the CURRENT timely transition first — above all the
   * finished wake, which must be attempted before any catch-up so terminal
   * feedback can never sit behind up-to-64 replays × send timeout or a held
   * progress lock — then the durable backlog in journal order. A fresh event
   * wins over a historical replay copy of the same intent so timely wakes
   * are never labelled 'late'.
   */
  const planWakes = (ctx: StepCtx, current: WakeEvent[], terminal: boolean): WakePlan => {
    const curKeys = new Set(current.map((e) => wakeKeyOf(e, ctx.state)));
    const backlog = backlogWakes(ctx).filter((e) => !curKeys.has(wakeKeyOf(e, ctx.state)));
    return { events: [...current, ...backlog], terminal };
  };

  /**
   * Drain bounds. Current events drain first, historical backlog after.
   * Non-terminal calls cap NEW host sends and wall-clock — skipped events
   * stay pending (they hold no outbox record yet) and are recomputed from
   * the journal next advance. Terminal calls are the last wake opportunity:
   * every computed event is attempted so catch-up is never stranded; each
   * send stays individually bounded. The finished wake is always attempted
   * inside WAKE_DRAIN_MAX_EVENTS.
   */
  const WAKE_SEND_TIMEOUT_MS = 15_000;
  const WAKE_LOCK_WAIT_MS = 5_000;
  const WAKE_DRAIN_SEND_CAP = 8;
  const WAKE_DRAIN_DEADLINE_MS = 45_000;
  const WAKE_DRAIN_MAX_EVENTS = 64;
  const SEND_ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set(['sent', 'unknown', 'refused', 'refused_final']);

  /**
   * Persist wake-drain diagnostics on a FRESH store lock — journal-only,
   * never a saveState. The drained ctx.state is a pre-send snapshot;
   * persisting it could overwrite a concurrent advance.
   */
  const journalWakeFailures = async (failures: string[]): Promise<void> => {
    try {
      await store.withLock(async () =>
        store.appendJournal(failures.map((detail) => ({
          ts: now().toISOString(),
          type: 'error' as const,
          actor: 'engine',
          payload: { op: 'progress.drain', detail: detail.slice(0, 400) },
        }))),
      );
    } catch {
      /* diagnostics are best-effort — the outbox retains the outcomes */
    }
  };

  /**
   * Lifecycle wake to the initiating orchestrator (progress module v1).
   *
   * Runs OUTSIDE the store lock after the transition is durable: the plan is
   * computed inside the lock from persisted records, then each event flows
   * intent → send through progress/outbox.json. A hung send can no longer
   * serialize council mutations. Facts in the body come from a fresh
   * state.json read per event — catch-up mail reports CURRENT persisted
   * counts, never fabricated historical ones. Repeat sends dedupe durably;
   * a missing recipient.json is an honest no_recipient outcome, and module
   * errors are journaled as progress.drain diagnostics — wake delivery must
   * NEVER fail a council step.
   */
  const drainWakes = async (plan: WakePlan): Promise<void> => {
    if (plan.events.length === 0) return;
    const notifier = createProgressNotifier({
      runDir: store.runDir,
      sendMail: (input) => host.sendNotification(input),
      readState: () => store.loadState(),
      sendTimeoutMs: WAKE_SEND_TIMEOUT_MS,
      lockWaitMs: WAKE_LOCK_WAIT_MS,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    const failures: string[] = [];
    let sends = 0;
    let processed = 0;
    let lockBreak = false;
    const deadline = now().getTime() + WAKE_DRAIN_DEADLINE_MS;
    for (const event of plan.events) {
      const isFinished = event.kind === 'finished' || (event.kind === 'stage' && TERMINAL_STATUS.has(event.status));
      if (processed >= WAKE_DRAIN_MAX_EVENTS && !isFinished) continue;
      if (!plan.terminal && !isFinished && (sends >= WAKE_DRAIN_SEND_CAP || now().getTime() > deadline)) continue;
      processed += 1;
      let r;
      try {
        r = await notifier.notify(event);
      } catch (e) {
        failures.push(`notify threw for ${event.kind} wake: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!r.ok) {
        failures.push(`${event.kind}: ${r.error.code}: ${r.error.message}`);
        // A held progress lock persists across events — stop burning wait
        // time; the backlog is recomputed on the next advance.
        if (r.error.details?.reason === 'progress_lock_timeout') {
          lockBreak = true;
          break;
        }
        continue;
      }
      if (SEND_ATTEMPT_OUTCOMES.has(r.value.outcome)) sends += 1;
    }
    if (lockBreak && processed < plan.events.length) {
      // Never silently strand pending wakes: the count left un-attempted is
      // part of the same diagnostic record.
      failures.push(
        `${plan.events.length - processed} pending wake event(s) left deferred behind the held progress lock — they stay pending and are recomputed from the journal on the next call`,
      );
    }
    if (failures.length > 0) await journalWakeFailures(failures);
  };

  /** Current-transition events for an advance step (unmarked — the timely copy). */
  const currentStepWakes = (ctx: StepCtx, step: StepResult): WakeEvent[] => {
    const s = ctx.state.status;
    const events: WakeEvent[] = [];
    if (TERMINAL_STATUS.has(s)) {
      events.push({
        kind: 'finished',
        outcome: TERMINAL_OUTCOME[s],
        ...(step.kind === 'advance' && step.result.reportPaths !== undefined ? { reportPaths: step.result.reportPaths } : {}),
      });
    } else {
      events.push({
        kind: 'stage',
        status: s,
        ...(s === 'discussing' && ctx.state.discussion !== null
          ? { cursor: { round: ctx.state.discussion.round, stage: ctx.state.discussion.stage } }
          : {}),
      });
    }
    if (step.kind === 'advance' && step.result.action === 'blocked') {
      events.push({ kind: 'blocked', reason: step.result.note ?? 'advance blocked — see status/journal' });
    }
    return events;
  };

  /**
   * Make the blocked wake durable: the step result's action is transient,
   * so the reason is journaled as a lifecycle.blocked error marker before
   * the flush — P-D4 catch-up replays it like any other lifecycle record.
   * Deduped on the exact detail so a stuck run doesn't spam the journal.
   */
  const journalBlockedMarker = (ctx: StepCtx, step: StepResult): void => {
    if (step.kind !== 'advance' || step.result.action !== 'blocked') return;
    const reason = step.result.note ?? 'advance blocked — see status/journal';
    const detail = `lifecycle.blocked: ${reason}`;
    if (ctx.journaledErrors.has(detail)) return;
    ctx.journaledErrors.add(detail);
    emit(ctx, 'error', { op: 'lifecycle.blocked', reason, detail });
  };

  // ── Advance dispatch ───────────────────────────────────────────────────────

  /**
   * Reconstruct the step context from state.json + journal. The journal is
   * authoritative — it leads state.json by design (appends fsync before
   * saveState) — so an unreadable journal HALTS the step: every durable
   * guard (stage chronology, repair lineage, mail budgets, dedupe sets,
   * consumption counters) is journal-derived and proceeding without them
   * would replay host mutations blind. Fails closed, per
   * JOURNAL_RECOVERY_GUIDANCE.
   */
  const buildCtx = async (state: CouncilState): Promise<Result<StepCtx>> => {
    const ctx: StepCtx = {
      state,
      now: now(),
      events: [],
      artifacts: [],
      rejectedAttempts: new Set(),
      taskCreateFailed: new Set(),
      workerLaunchFailures: new Map(),
      repairByAttempt: new Map(),
      repairedKeys: new Set(),
      mailSentByTarget: new Map(),
      runCreateUnresolved: false,
      stopRequestedAttempts: new Set(),
      releaseRequested: new Set(),
      taskCreateStage: new Map(),
      workerLaunchStage: new Map(),
      terminalCreateStage: new Map(),
      terminalCustody: new Map(),
      workerStartMarkers: new Set(),
      preDispatchFailures: new Map(),
      preDispatchOrphans: new Set(),
      terminalCloses: new Map(),
      terminalCloseSkips: new Set(),
      submitNudgeIntents: new Set(),
      intentProtocol: new Map(),
      integrity: 'legacy',
      receipts: new Map(),
      envelopeAssigned: new Map(),
      legacyEnvelopes: new Set(),
      journaledErrors: new Set(),
      lifecycleJournal: [],
    };
    const journal = await store.readJournal();
    if (!journal.ok) return journal as Result<never>;

    let runOk = false;
    const attemptOverlay = new Map<AttemptId, {
      journaledStatus?: AttemptStatus;
      taskId?: string;
      dispatchId?: string;
      terminalHandle?: string;
      requestId?: string;
      supersededBy?: string;
      supersededReason?: 'pre_dispatch' | 'fresh_fallback';
    }>();
    // State-side mints journaled as events but possibly lost to a
    // saveState failure: attempt ids referenced by journaled events, phase
    // transitions implying participant seeding, and launch/mail charges.
    const journaledAttempts = new Map<AttemptId, { ts: string }>();
    let seedOrganiser = false;
    let seedReviewers = false;
    let seedScribeNotes = false;
    let seedSynthesis = false;
    const launchedAttempts = new Set<AttemptId>();
    const chargedMail = new Set<string>();
    let journaledMailSent = 0;
    const noteAttempt = (raw: unknown, ts: string): void => {
      if (typeof raw === 'string' && ATTEMPT_ID_RE.test(raw) && !journaledAttempts.has(raw)) {
        journaledAttempts.set(raw, { ts });
      }
    };
    for (const e of journal.value) {
      if (e.type === 'launch.intent' && e.payload?.scope === 'run') ctx.runCreateUnresolved = true;
      if (e.type === 'task.created' && e.payload?.scope === 'run') {
        runOk = true;
        // RA-002: the receipt carries the run identity — restore it when a
        // lost saveState dropped it, or stepInitialized would createRun a
        // second time and orphan the landed run.
        if (typeof e.payload?.orcaRunId === 'string' && e.payload.orcaRunId.length > 0 && state.orcaRunId === null) {
          state.orcaRunId = e.payload.orcaRunId;
        }
      }
      noteAttempt(e.payload?.attemptId, e.ts);
      noteAttempt(e.payload?.repairAttemptId, e.ts);
      noteAttempt(e.payload?.retryAttemptId, e.ts);
      // Envelope-linked attempts are minted right after envelope.built —
      // a lost saveState erases them while the journal proves they exist.
      if (
        e.type === 'envelope.built' &&
        typeof e.participantId === 'string' &&
        (e.phase === 'challenge' || e.phase === 'author_response') &&
        typeof e.payload?.assigned === 'number' &&
        e.payload.assigned > 0
      ) {
        noteAttempt(`att_${e.participantId}_${e.phase}_r${e.round ?? 1}_0`, e.ts);
      }
      // Envelope authorization is journal-derived, NEVER file-derived: the
      // assignedIds the runner journaled at build time are the only claim/
      // challenge ids that worker output may legitimately reference.
      if (e.type === 'envelope.built' && typeof e.payload?.path === 'string') {
        const ids = e.payload?.assignedIds;
        if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) {
          ctx.envelopeAssigned.set(e.payload.path, ids as string[]);
        } else {
          ctx.legacyEnvelopes.add(e.payload.path);
        }
      }
      // Dedupe keys for journaled anomaly/error lines so a rebuild never
      // re-emits the same durable evidence.
      if (e.type === 'error' && typeof e.payload?.detail === 'string') {
        ctx.journaledErrors.add(e.payload.detail as string);
      }
      if (e.type === 'phase.entered') {
        if (e.payload?.status === 'organising') seedOrganiser = true;
        if (e.payload?.status === 'independent_review') seedReviewers = true;
        if (e.payload?.status === 'scribe_notes') seedScribeNotes = true;
        if (e.payload?.status === 'synthesising') seedSynthesis = true;
      }
      if (
        e.type === 'run.initialized' ||
        e.type === 'phase.entered' ||
        e.type === 'approval.granted' ||
        e.type === 'run.finished' ||
        (e.type === 'error' && e.payload?.op === 'lifecycle.blocked')
      ) {
        ctx.lifecycleJournal.push(e);
      }
      if (e.type === 'approval.granted') seedReviewers = true;
      // RA-004: journaled launch charges — the worker.started RECEIPT shape
      // (carries taskId) or a worker.unknown (launch may have landed).
      // Deduped by attempt: one physical launch per attempt id.
      if (
        typeof e.payload?.attemptId === 'string' &&
        ((e.type === 'worker.started' && typeof e.payload?.taskId === 'string') || e.type === 'worker.unknown')
      ) {
        launchedAttempts.add(e.payload.attemptId);
      }
      if (e.type === 'artifact.rejected' && typeof e.payload?.attemptId === 'string') {
        ctx.rejectedAttempts.add(e.payload.attemptId);
        // A repair tuple is consumed when the corrective attempt is created —
        // journaled on the rejected event so a restart cannot mint another.
        if (typeof e.payload?.repairTuple === 'string') ctx.repairedKeys.add(e.payload.repairTuple);
        const repair = e.payload?.repair as { repairOf?: unknown; contract?: unknown; diagnostics?: unknown; previousArtifactPath?: unknown; diagnosticsRef?: unknown } | undefined;
        if (
          typeof e.payload?.repairAttemptId === 'string' &&
          repair !== undefined &&
          typeof repair === 'object' &&
          typeof repair.repairOf === 'string' &&
          typeof repair.contract === 'string' &&
          Array.isArray(repair.diagnostics)
        ) {
          ctx.repairByAttempt.set(e.payload.repairAttemptId, {
            repairOf: repair.repairOf,
            contract: repair.contract,
            diagnostics: repair.diagnostics.filter((d): d is string => typeof d === 'string'),
            ...(typeof repair.previousArtifactPath === 'string' ? { previousArtifactPath: repair.previousArtifactPath } : {}),
            ...(typeof repair.diagnosticsRef === 'string' ? { diagnosticsRef: repair.diagnosticsRef } : {}),
          });
        }
      }
      if (e.type === 'launch.intent' && typeof e.payload?.repairTuple === 'string') {
        ctx.repairedKeys.add(e.payload.repairTuple);
      }
      if (e.type === 'launch.intent' && typeof e.payload?.attemptId === 'string') {
        const aid = e.payload.attemptId;
        if (e.payload?.stage === 'task-create') {
          ctx.taskCreateStage.set(aid, 'issued'); // chronological last-wins
        } else if (e.payload?.stage === 'worker-launch') {
          ctx.workerLaunchStage.set(aid, 'issued');
        } else if (e.payload?.stage === 'terminal-create') {
          ctx.terminalCreateStage.set(aid, 'issued');
        } else if (e.payload?.stage === 'worker-start') {
          ctx.workerStartMarkers.add(aid);
        } else {
          const v = typeof e.payload?.v === 'number' ? e.payload.v : 1;
          ctx.intentProtocol.set(aid, Math.max(ctx.intentProtocol.get(aid) ?? 1, v));
        }
      }
      // Terminal-create custody receipts — journaled by the adapter's
      // afterTerminalCreate callback, so a mid-launch crash keeps the
      // created/refused/uncertain outcome and any landed handle visible.
      if (e.type === 'error' && e.payload?.op === 'terminal-create' && typeof e.payload?.attemptId === 'string') {
        const aid = e.payload.attemptId;
        ctx.terminalCreateStage.set(aid, e.payload?.uncertain === true ? 'issued' : 'refused');
        if (typeof e.payload?.terminalHandle === 'string' && e.payload.terminalHandle.length > 0) {
          ctx.terminalCustody.set(aid, {
            handle: e.payload.terminalHandle,
            ...(typeof e.payload?.requestId === 'string' ? { requestId: e.payload.requestId } : {}),
          });
        }
      }
      if (e.type === 'task.created' && e.payload?.scope === 'terminal' && typeof e.payload?.attemptId === 'string') {
        const h = e.payload?.terminalHandle;
        if (typeof h === 'string' && h.length > 0) {
          ctx.terminalCustody.set(e.payload.attemptId, {
            handle: h,
            ...(typeof e.payload?.requestId === 'string' ? { requestId: e.payload.requestId } : {}),
            ...(e.payload?.dispatchMarker === true ? { dispatchMarker: true } : {}),
          });
        }
      }
      // Pre-dispatch failures (worker-start provably never issued): the
      // tuple's single relaunch allowance and the orphaned terminal.
      if (e.type === 'worker.settled' && e.payload?.preDispatch === true && typeof e.payload?.attemptId === 'string') {
        const tuple = typeof e.payload?.tuple === 'string' ? e.payload.tuple : undefined;
        if (tuple !== undefined) {
          const set = ctx.preDispatchFailures.get(tuple) ?? new Set<AttemptId>();
          set.add(e.payload.attemptId);
          ctx.preDispatchFailures.set(tuple, set);
        }
        if (typeof e.payload?.terminalHandle === 'string') ctx.preDispatchOrphans.add(e.payload.terminalHandle);
        const repair = e.payload?.repair as { repairOf?: unknown; contract?: unknown; diagnostics?: unknown; previousArtifactPath?: unknown; diagnosticsRef?: unknown } | undefined;
        if (
          typeof e.payload?.retryAttemptId === 'string' &&
          repair !== undefined && typeof repair === 'object' &&
          typeof repair.repairOf === 'string' && typeof repair.contract === 'string' && Array.isArray(repair.diagnostics)
        ) {
          ctx.repairByAttempt.set(e.payload.retryAttemptId, {
            repairOf: repair.repairOf,
            contract: repair.contract,
            diagnostics: repair.diagnostics.filter((d): d is string => typeof d === 'string'),
            ...(typeof repair.previousArtifactPath === 'string' ? { previousArtifactPath: repair.previousArtifactPath } : {}),
            ...(typeof repair.diagnosticsRef === 'string' ? { diagnosticsRef: repair.diagnosticsRef } : {}),
          });
        }
      }
      if (e.type === 'terminal.close' && typeof e.payload?.terminalHandle === 'string') {
        const h = e.payload.terminalHandle;
        if (e.payload?.stage === 'intent') {
          ctx.terminalCloses.set(h, {}); // chronological last-wins: a newer intent reopens custody
        } else if (e.payload?.stage === 'receipt') {
          const o = e.payload?.outcome;
          if (o === 'closed' || o === 'already_gone' || o === 'failed') ctx.terminalCloses.set(h, { outcome: o });
        } else if (e.payload?.stage === 'skipped' && typeof e.payload?.reason === 'string') {
          ctx.terminalCloseSkips.add(`${h}|${e.payload.reason}`);
        }
      }
      // Lean-env durable record — the journal IS the run record for which
      // worktree files were created vs merged, so a crash mid-generation or
      // mid-restore is reconciled from here, never guessed.
      if (e.type === 'lean.env') {
        const p = e.payload ?? {};
        const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
        const strArr = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        if (p.stage === 'intent' && p.op === 'generate') {
          ctx.leanEnvIntent = {
            ...(str(p.worktreeRoot) !== undefined ? { worktreeRoot: p.worktreeRoot as string } : {}),
            names: strArr(p.names),
          };
        } else if (p.stage === 'receipt' && p.op === 'generate') {
          ctx.leanEnvIntent = undefined;
          const files: LeanEnvFileRecord[] = [];
          if (Array.isArray(p.files)) {
            for (const f of p.files) {
              if (typeof f !== 'object' || f === null || Array.isArray(f) || typeof f.path !== 'string') continue;
              const rec: LeanEnvFileRecord = {
                path: f.path,
                action: f.action === 'merged' ? 'merged' : 'created',
                ...(str(f.backup) !== undefined ? { backup: f.backup as string } : {}),
                ...(str(f.backupSha256) !== undefined ? { backupSha256: f.backupSha256 as string } : {}),
              };
              const sn = strArr(f.stubbedNames);
              if (sn.length > 0) rec.stubbedNames = sn;
              const ck = strArr(f.configKeys);
              if (ck.length > 0) rec.configKeys = ck;
              files.push(rec);
            }
          }
          ctx.leanEnv = {
            status: p.outcome === 'skipped' ? 'skipped' : 'active',
            ...(str(p.worktreeRoot) !== undefined ? { worktreeRoot: p.worktreeRoot as string } : {}),
            names: strArr(p.names),
            ...(files.length > 0 ? { files } : {}),
            ...(str(p.reason) !== undefined ? { reason: p.reason as string } : {}),
            ...(str(p.generatedAt) !== undefined ? { generatedAt: p.generatedAt as string } : {}),
          };
        } else if (p.stage === 'receipt' && p.op === 'restore' && ctx.leanEnv !== undefined) {
          ctx.leanEnv = {
            ...ctx.leanEnv,
            status: 'restored',
            ...(str(p.restoredAt) !== undefined ? { restoredAt: p.restoredAt as string } : {}),
          };
        }
      }
      // RA-006: an error carrying `uncertain:true` is an issued mutation
      // whose receipt was lost — reconcile by observation, never a proven
      // no-effect refusal. Only definitive errors close the stage.
      if (e.type === 'error' && e.payload?.op === 'task-create' && typeof e.payload?.attemptId === 'string') {
        if (e.payload?.uncertain === true) {
          ctx.taskCreateStage.set(e.payload.attemptId, 'issued');
        } else {
          ctx.taskCreateFailed.add(e.payload.attemptId);
          ctx.taskCreateStage.set(e.payload.attemptId, 'refused');
        }
      }
      if (e.type === 'error' && e.payload?.op === 'worker-launch' && typeof e.payload?.attemptId === 'string') {
        const id = e.payload.attemptId;
        if (e.payload?.uncertain === true) {
          ctx.workerLaunchStage.set(id, 'issued');
        } else {
          ctx.workerLaunchFailures.set(id, (ctx.workerLaunchFailures.get(id) ?? 0) + 1);
          ctx.workerLaunchStage.set(id, 'refused');
        }
      }
      // RA-004/RA-008: per-recipient mail budget — dedupe by mailIntentId so
      // a pre-send intent and its outcome receipt charge ONE possibly-landed
      // send; the intent alone still charges (the send may have landed).
      if (e.type === 'mail.sent' && typeof e.payload?.to === 'string') {
        const to = e.payload.to as string;
        const outcome = e.payload?.outcome;
        const mid = typeof e.payload?.mailIntentId === 'string' ? e.payload.mailIntentId : `seq:${e.seq}`;
        if (outcome === 'sent' || outcome === 'unknown' || outcome === 'intent') {
          const key = `${to}${mid}`;
          if (!chargedMail.has(key)) {
            chargedMail.add(key);
            ctx.mailSentByTarget.set(to, (ctx.mailSentByTarget.get(to) ?? 0) + 1);
          }
        }
        if (outcome === 'sent' && !chargedMail.has(`ok:${mid}`)) {
          chargedMail.add(`ok:${mid}`);
          journaledMailSent += 1;
        }
      }
      if (e.type === 'worker.stop_requested' && typeof e.payload?.attemptId === 'string') {
        ctx.stopRequestedAttempts.add(e.payload.attemptId);
      }
      if (e.type === 'launch.submit_nudge' && e.payload?.stage === 'intent' && typeof e.payload?.attemptId === 'string') {
        ctx.submitNudgeIntents.add(e.payload.attemptId);
      }
      if (e.type === 'worker.released' && typeof e.payload?.dispatchId === 'string') {
        ctx.releaseRequested.add(e.payload.dispatchId);
      }
      // Durable attempt facts — the journal leads state.json (journal
      // appends fsync before saveState), so a stale state is repaired by
      // projecting journaled effect markers over it. The journal is NEVER
      // ahead by less than the state it protects.
      if (typeof e.payload?.attemptId === 'string') {
        const aid = e.payload.attemptId;
        let ov = attemptOverlay.get(aid);
        if (ov === undefined) { ov = {}; attemptOverlay.set(aid, ov); }
        switch (e.type) {
          case 'launch.intent':
            ov.journaledStatus = 'intent_recorded';
            break;
          case 'task.created':
            if (typeof e.payload?.taskId === 'string' && e.payload.taskId.length > 0) ov.taskId = e.payload.taskId;
            if (e.payload?.scope === 'terminal' && typeof e.payload?.terminalHandle === 'string' && e.payload.terminalHandle.length > 0) {
              ov.terminalHandle = e.payload.terminalHandle;
            }
            break;
          case 'worker.started':
            ov.journaledStatus = 'dispatched';
            if (typeof e.payload?.dispatchId === 'string') ov.dispatchId = e.payload.dispatchId;
            if (typeof e.payload?.terminalHandle === 'string') ov.terminalHandle = e.payload.terminalHandle;
            break;
          case 'worker.unknown':
            ov.journaledStatus = 'unknown';
            if (typeof e.payload?.dispatchId === 'string') ov.dispatchId = e.payload.dispatchId;
            if (typeof e.payload?.terminalHandle === 'string') ov.terminalHandle = e.payload.terminalHandle;
            if (typeof e.payload?.requestId === 'string') ov.requestId = e.payload.requestId;
            break;
          case 'worker.settled':
            ov.journaledStatus = e.payload?.outcome === 'failed' ? 'settled_failed' : 'settled_ok';
            if (
              typeof e.payload?.retryAttemptId === 'string' &&
              (e.payload?.supersededReason === 'pre_dispatch' || e.payload?.supersededReason === 'fresh_fallback')
            ) {
              ov.supersededBy = e.payload.retryAttemptId;
              ov.supersededReason = e.payload.supersededReason;
            }
            break;
          case 'worker.timed_out': ov.journaledStatus = 'timed_out'; break;
          case 'worker.stopped': ov.journaledStatus = 'stopped'; break;
          default: break;
        }
      }
    }
    if (runOk) ctx.runCreateUnresolved = false;

    // ── Integrity policy + journal-authoritative receipts ────────────────
    // Marker agreement across council.json + journal (artifacts lane):
    // 'receipts-v1' mints/verifies exact-byte receipts; 'legacy' stays
    // honestly untracked; a marker CONFLICT fails closed, never downgrades.
    const { receipts: collectedReceipts, anomalies: receiptAnomalies } = collectReceipts(journal.value);
    ctx.receipts = collectedReceipts;
    const policySignals = await integrityPolicy(store);
    if (!policySignals.ok) return policySignals as Result<never>;
    // The journal marker is durable evidence of the run's policy. Primary
    // architecture: FileStore.initialize writes the receipts-v1
    // run.initialized marker as seq 1 for new runs, so the journal is marked
    // before ANY supervisor/engine event. buildCtx only re-declares it into
    // an EMPTY journal (a pre-marker run or a lost journal — nothing exists
    // that could launder a stripped marker). A non-empty unmarked journal
    // under a v1 marker is a policy conflict: never silently blessed.
    let journalMarked = journalHasPolicyMarker(journal.value);
    if (policySignals.value.metaPolicy === INTEGRITY_POLICY && journalMarked === null) {
      emit(ctx, 'run.initialized', {
        runId: state.runId,
        integrity: INTEGRITY_POLICY,
        snapshotId: state.snapshotId,
      });
      journalMarked = true;
    }
    const resolved = resolveIntegrityPolicy({
      metaPolicy: policySignals.value.metaPolicy,
      journalHasMarker: journalMarked,
      indexPresent: policySignals.value.indexPresent,
    });
    if (!resolved.ok) return resolved as Result<never>;
    ctx.integrity = resolved.value.policy;
    for (const anomaly of receiptAnomalies) {
      const detail = `receipt anomaly: ${anomaly}`;
      if (ctx.journaledErrors.has(detail)) continue;
      ctx.journaledErrors.add(detail);
      emit(ctx, 'error', { op: 'integrity-receipts', detail });
    }

    // ── Re-materialize state-side mints the journal proves existed ──────
    // RA-003: participant seeding and addPlannedAttempt are state-only;
    // append-ok/save-fail erases them while journaled intent/effect events
    // survive. Without this the promised repair attempt (and organiser /
    // reviewer / scribe seeds) silently never run.
    let approvedRosterCache: ApprovedRoster | undefined | null;
    const approvedRosterFor = async (): Promise<ApprovedRoster | undefined> => {
      if (approvedRosterCache === undefined) {
        const ar = await store.readApprovedRoster();
        approvedRosterCache = ar.ok ? ar.value : null;
      }
      return approvedRosterCache ?? undefined;
    };
    const mintedParticipants = new Set<ParticipantId>();
    const findOrMintParticipant = async (pid: ParticipantId): Promise<Participant | undefined> => {
      const existing = findParticipant(state, pid);
      if (existing !== undefined) return existing;
      if (mintedParticipants.has(pid)) return findParticipant(state, pid);
      let p: Participant | undefined;
      if (pid === ORGANISER_PID) {
        p = makeParticipant(ORGANISER_PID, 'organiser', staffAgent(state, 'organiser'), null, null);
      } else if (pid === SCRIBE_PID) {
        p = makeParticipant(SCRIBE_PID, 'scribe', staffAgent(state, 'scribe'), null, null);
      } else {
        const roster = await approvedRosterFor();
        const seat = roster?.seats.find((s) => s.participantId === pid);
        if (seat === undefined) return undefined; // no durable identity — cannot re-mint honestly
        p = makeParticipant(pid, 'reviewer', seat.agent, seat.seatId, seat.perspectiveId);
      }
      state.participants.push(p);
      mintedParticipants.add(pid);
      emit(ctx, 'error', {
        op: 'journal-overlay',
        participantId: pid,
        detail: `participant ${pid} re-materialized from journaled events — state.json lost the seed (append-ok/save-fail)`,
      });
      return p;
    };
    const mintAttempt = (p: Participant, phase: PhaseKind, round: number | null, attemptId: AttemptId, ts: string): PhaseAttempt => {
      const attempt: PhaseAttempt = {
        attemptId,
        participantId: p.participantId,
        phase,
        round,
        taskId: null,
        dispatchId: null,
        terminalHandle: null,
        launchIntentId: `li_${attemptId}`,
        status: 'planned',
        createdAt: ts,
        artifacts: [],
      };
      p.attempts.push(attempt);
      return attempt;
    };
    const attemptExists = (aid: AttemptId): boolean =>
      state.participants.some((p) => p.attempts.some((a) => a.attemptId === aid));
    // Phase-transition seeding (mirrors the step code that journaled the
    // transition): organiser seed, approved reviewer seats, scribe seats.
    if (seedOrganiser && findParticipant(state, ORGANISER_PID) === undefined) {
      const p = await findOrMintParticipant(ORGANISER_PID);
      if (p !== undefined && attemptsFor(p, 'organiser', null).length === 0) {
        mintAttempt(p, 'organiser', null, `att_${ORGANISER_PID}_organiser_r0_0`, ctx.now.toISOString());
      }
    }
    if (seedReviewers) {
      const roster = await approvedRosterFor();
      if (roster !== undefined) {
        for (const seat of roster.seats) {
          const p = await findOrMintParticipant(seat.participantId);
          if (p !== undefined && attemptsFor(p, 'independent_review', null).length === 0) {
            mintAttempt(p, 'independent_review', null, `att_${seat.participantId}_independent_review_r0_0`, ctx.now.toISOString());
          }
        }
      }
    }
    if (seedScribeNotes || seedSynthesis) {
      const p = await findOrMintParticipant(SCRIBE_PID);
      if (p !== undefined) {
        if (seedScribeNotes && attemptsFor(p, 'scribe_notes', null).length === 0) {
          mintAttempt(p, 'scribe_notes', null, `att_${SCRIBE_PID}_scribe_notes_r0_0`, ctx.now.toISOString());
        }
        if (seedSynthesis && attemptsFor(p, 'scribe_synthesis', null).length === 0) {
          mintAttempt(p, 'scribe_synthesis', null, `att_${SCRIBE_PID}_scribe_synthesis_r0_0`, ctx.now.toISOString());
        }
      }
    }
    // Journaled attempt ids (intents, effects, rejections, envelope mints,
    // repair lineage) whose state-side PhaseAttempt was lost.
    for (const [aid, meta] of journaledAttempts) {
      if (attemptExists(aid)) continue;
      const m = ATTEMPT_ID_RE.exec(aid);
      if (m === null) continue; // foreign id shape — cannot re-mint honestly
      const pid = m[1] as ParticipantId;
      const phase = m[2] as PhaseKind;
      const rn = Number(m[3]);
      const p = await findOrMintParticipant(pid);
      if (p === undefined) {
        emit(ctx, 'error', {
          op: 'journal-overlay',
          attemptId: aid,
          detail: `journaled attempt ${aid} has no resolvable participant seat — cannot re-materialize; reconcile the run manually`,
        });
        continue;
      }
      mintAttempt(p, phase, rn === 0 ? null : rn, aid, meta.ts);
      emit(ctx, 'error', {
        op: 'journal-overlay',
        attemptId: aid,
        detail: `attempt ${aid} re-materialized from journaled events (state.json lost it — append-ok/save-fail); status/facts restored by the overlay`,
      });
    }
    // Project durable journal facts over possibly-stale state: a crash
    // between appendJournal and saveState leaves state.json behind, and
    // without this overlay the engine would re-issue a journaled mutation.
    const STATUS_RANK: Record<string, number> = {
      planned: 0, intent_recorded: 1, dispatched: 2, working: 2, unknown: 3,
      timed_out: 4, stopped: 4, settled_failed: 5, settled_ok: 5,
    };
    for (const p of ctx.state.participants) {
      for (const a of p.attempts) {
        const ov = attemptOverlay.get(a.attemptId);
        if (ov === undefined) continue;
        if (a.taskId === null && ov.taskId !== undefined) a.taskId = ov.taskId;
        if (a.dispatchId === null && ov.dispatchId !== undefined) a.dispatchId = ov.dispatchId;
        if (a.terminalHandle === null && ov.terminalHandle !== undefined) a.terminalHandle = ov.terminalHandle;
        // Pre-attach custody: a journaled terminal identity restores the
        // retained handle so the resource stays visible for reuse/release —
        // never orphaned into a second create.
        // Retained-session custody is journal-derived: the NEWEST journaled
        // handle is the live session (a later fresh-fallback attempt on a
        // different terminal supersedes an earlier one, never vice versa).
        // A pre-dispatch orphan or a journaled-closed terminal is never a
        // live retained session.
        if (a.terminalHandle !== null && !retiredTerminal(ctx, a.terminalHandle)) p.retainedTerminal = a.terminalHandle;
        if (a.requestId === undefined && ov.requestId !== undefined) a.requestId = ov.requestId;
        if (a.supersededBy === undefined && ov.supersededBy !== undefined && ov.supersededReason !== undefined) {
          a.supersededBy = ov.supersededBy;
          a.supersededReason = ov.supersededReason;
        }
        const js = ov.journaledStatus;
        if (js !== undefined && (STATUS_RANK[js] ?? 0) > (STATUS_RANK[a.status] ?? 0)) {
          a.status = js;
        }
      }
      if (p.retainedTerminal !== null && retiredTerminal(ctx, p.retainedTerminal)) p.retainedTerminal = null;
    }
    // RA-004: journal-derived consumption — never refund a charge that made
    // it to disk; keep the in-memory count when it is ahead (pending events).
    state.consumption.launches = Math.max(state.consumption.launches, launchedAttempts.size);
    state.consumption.mailSent = Math.max(state.consumption.mailSent, journaledMailSent);

    // clm_0007 invariant: replay reconstruction must never leave two
    // participant objects sharing one participantId nor two attempts sharing
    // one attemptId. Seed sites are idempotent now; this sweep is the
    // belt-and-suspenders proof that a stale/crafted state.json cannot
    // smuggle a duplicate past the overlay.
    {
      const seenPids = new Set<ParticipantId>();
      state.participants = state.participants.filter((p) => {
        if (seenPids.has(p.participantId)) return false;
        seenPids.add(p.participantId);
        const seenAids = new Set<AttemptId>();
        p.attempts = p.attempts.filter((a) => {
          if (seenAids.has(a.attemptId)) return false;
          seenAids.add(a.attemptId);
          return true;
        });
        return true;
      });
    }

    const snap = await store.readSnapshot();
    if (snap.ok) ctx.snapshot = snap.value;
    return ok(ctx);
  };

  const advance = async (): Promise<Result<AdvanceResult>> => {
    try {
      let plan: WakePlan | null = null;
      const inner = await store.withLock(async () => {
        const st = await store.loadState();
        if (!st.ok) return st;
        const bc = await buildCtx(st.value);
        if (!bc.ok) return bc;
        const ctx = bc.value;
        // Reviewer spec building needs the perspective catalog.
        const proposedR = await store.readProposedRoster();
        if (proposedR.ok) {
          ctx.perspectives = new Map(proposedR.value.perspectives.map((p) => [p.perspectiveId, p]));
        }
        let step: StepResult;
        switch (ctx.state.status) {
          case 'initialized': step = await stepInitialized(ctx); break;
          case 'organising': step = await stepOrganising(ctx); break;
          case 'awaiting_approval':
            step = advanceResult('needs_approval', ctx.state.status, 'waiting for orchestrator approval of the proposed roster');
            break;
          case 'independent_review': step = await stepIndependent(ctx); break;
          case 'scribe_notes': step = await stepScribeNotes(ctx); break;
          case 'discussing': step = await stepDiscussing(ctx); break;
          case 'synthesising': step = await stepSynthesising(ctx); break;
          case 'reported':
          case 'failed':
          case 'cancelled': {
            const outcome = ctx.state.status === 'reported' ? 'succeeded' : ctx.state.status === 'failed' ? 'failed' : 'cancelled';
            step = advanceResult('finished', ctx.state.status, undefined, { outcome });
            break;
          }
        }
        if (step.kind === 'error') {
          // Journaled evidence (artifact.rejected, error, mail.observed)
          // accumulated during the failed step must still be persisted —
          // silently discarding it can drop the record of a landed mutation.
          const fe = await flush(ctx);
          if (!fe.ok) return fe;
          return failRes(step.error);
        }
        if (step.result.artifacts === undefined && ctx.artifacts.length > 0) {
          step.result.artifacts = ctx.artifacts;
        }
        // Terminal run: release-then-close every engine-created participant
        // terminal (idempotent; also completes a crash-interrupted pass on
        // a later advance). Never changes the run's terminal state.
        if (TERMINAL_STATUS.has(ctx.state.status)) {
          await finalizeRunTerminals(ctx, 'engine');
          // Lean env outlives retained terminals exactly as long as they do.
          await restoreLeanEnv(ctx, 'engine');
        }
        // Durable first: the blocked reason is journaled before the flush so
        // P-D4 catch-up can replay it; the wake plan is computed in-lock
        // from persisted records and DRAINED after the lock releases.
        journalBlockedMarker(ctx, step);
        const f = await flush(ctx);
        if (!f.ok) return f;
        plan = planWakes(ctx, currentStepWakes(ctx, step), TERMINAL_STATUS.has(ctx.state.status));
        return ok(step.result);
      });
      if (plan !== null) await drainWakes(plan);
      return inner;
    } catch (e) {
      return failRes(
        err('io_error', `advance crashed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  };

  // ── approve / status / cancel ─────────────────────────────────────────────

  const seatsMatchLaunchedReviewers = (state: CouncilState, roster: ApprovedRoster): boolean => {
    const existing = reviewers(state);
    if (existing.length === 0) return true;
    if (existing.length !== roster.seats.length) return false;
    const norm = (s: { seatId: string; perspectiveId: string; participantId: string; agent: AgentChoice }) =>
      JSON.stringify([s.seatId, s.perspectiveId, s.participantId, s.agent.agent, s.agent.model, s.agent.effort ?? null, s.agent.permissionMode ?? null, s.agent.profile ?? null]);
    const want = new Set(roster.seats.map(norm));
    return existing.every((p) =>
      want.has(norm({ seatId: p.seatId!, perspectiveId: p.perspectiveId!, participantId: p.participantId, agent: p.agent })),
    );
  };

  const approve = async (input: {
    roster: ApprovedRoster;
    approver: string;
  }): Promise<Result<{ approvalId: string; hash: string }>> => {
    try {
      let plan: WakePlan | null = null;
      const inner = await store.withLock(async () => {
        const st = await store.loadState();
        if (!st.ok) return st;
        const state = st.value;
        const fresh = state.status === 'awaiting_approval' && state.approvalHash === null;
        const reapproval =
          state.approvalHash === null &&
          ['independent_review', 'scribe_notes', 'discussing', 'synthesising'].includes(state.status);
        if (!fresh && !reapproval) {
          return failRes(
            err('invalid_transition', `cannot approve in status ${state.status}${state.approvalHash !== null ? ' (already approved)' : ''}`),
          );
        }
        // Execution-policy gate precedes roster admission AND the approval
        // write/wake — a fingerprint-bound run cannot be approved under a
        // missing or mismatched policy, and every admitted seat + staff
        // choice must be policy-launchable before anything is persisted.
        const gate = executionPolicy(state);
        if (!gate.ok) return failRes(gate.error);
        const proposedR = await store.readProposedRoster();
        if (!proposedR.ok) {
          return failRes(err('approval_required', 'no proposed roster on record; organiser must finish first'));
        }
        const parsed = parseApprovedRoster(input.roster, {
          runId: state.runId,
          proposed: proposedR.value,
          config: { participants: state.config.participants },
        });
        if (!parsed.ok) {
          return failRes(err('roster_invalid', 'approved roster failed validation', { issues: parsed.issues }));
        }
        const roster = parsed.value;
        if (gate.value !== null) {
          const sv = validateStaff(state, gate.value);
          if (!sv.ok) return failRes(sv.error);
          for (const seat of roster.seats) {
            const v = gate.value.validateChoice(seat.agent);
            if (!v.ok) {
              return failRes(
                err('roster_invalid', `seat ${seat.participantId} agent rejected by execution policy: ${v.error.message}`),
              );
            }
          }
        }
        if (reapproval && !seatsMatchLaunchedReviewers(state, roster)) {
          return failRes(
            err('roster_invalid', 're-approval must reproduce the exact launched seats/agents; start a new run to change the roster'),
          );
        }
        // leanMcp with no devin lane anywhere is almost certainly a config
        // mistake — warn (never refuse); the flag is already approval-bound
        // via state.config so the warning is an operator hint, not a gate.
        const warnings: string[] = [];
        if (state.config.leanMcp === true) {
          const staff = state.config.staff;
          const devinBound =
            roster.seats.some((s) => s.agent.agent === 'devin') ||
            (staff !== undefined &&
              [staff.organiser, staff.scribe, staff.supervisor].some((a) => a.agent === 'devin'));
          if (!devinBound) {
            warnings.push(
              'leanMcp is enabled but the approved roster+staff contain no devin-lane worker — no .devin stubs will be generated and the flag has no effect',
            );
          }
        }
        const snapR = await store.readSnapshot();
        if (!snapR.ok) return failRes(snapR.error);
        const binding = buildApprovalBinding(state, roster, proposedR.value, snapR.value);
        const hash = canonicalApprovalHash(binding);
        const record: ApprovalRecord = {
          schemaVersion: SCHEMA_VERSION,
          approvalId: `appr_${crypto.randomUUID().slice(0, 12)}`,
          hash,
          approver: input.approver,
          createdAt: now().toISOString(),
        };
        const bc = await buildCtx(state);
        if (!bc.ok) return bc;
        const ctx = bc.value;
        const wr = await store.writeApprovedRoster(roster);
        if (!wr.ok) return wr;
        const wa = await store.writeApproval(record, binding);
        if (!wa.ok) return wa;
        state.approvalHash = hash;
        emit(ctx, 'approval.granted', { hash, approvalId: record.approvalId, approver: input.approver, seats: roster.seats.length, reApproval: reapproval });
        for (const w of warnings) {
          emit(ctx, 'lean.env', { stage: 'warning', op: 'approve', reason: w });
        }
        if (fresh) {
          for (const seat of roster.seats) {
            // Idempotent (clm_0007): a retried approve after append-ok/
            // save-fail finds the overlay-minted seat — never a second
            // participant object nor a duplicate attempt id.
            const p = ensureParticipant(state, seat.participantId, 'reviewer', seat.agent, seat.seatId, seat.perspectiveId);
            ensureStageAttempt(p, 'independent_review', null);
          }
          state.status = 'independent_review';
          state.phaseEnteredAt = ctx.now.toISOString();
          emit(ctx, 'phase.entered', { status: 'independent_review', seats: roster.seats.length });
        }
        const f = await flush(ctx);
        if (!f.ok) return f;

        // Explicit wake: writing approval files alone does not wake Orca.
        // The send respects the per-recipient mail budget (journaled counts).
        // Address the supervisor Dispatch when recorded: it lives in the
        // caller's Run, so Orca refuses `run:<child>` + `--dispatch-id` with
        // dispatch_run_mismatch, and redirects dispatch mail to the mailbox
        // the supervisor terminal reads.
        const supDispatch = state.supervisor?.dispatchId ?? null;
        const to = supDispatch !== null
          ? `dispatch:${supDispatch}`
          : state.orcaRunId !== null
            ? `run:${state.orcaRunId}`
            : state.supervisor?.terminalHandle;
        if (to !== undefined) {
          await sendBoundedMail(ctx, {
            to,
            subject: `council ${state.runId}: approval granted`,
            body: `Approval ${record.approvalId} bound (hash ${hash.slice(0, 16)}…). Advance the run.`,
          }, 'approval-wake');
        } else {
          emit(ctx, 'mail.sent', { kind: 'approval-wake', outcome: 'skipped', reason: 'no supervisor identity or run bound' });
        }
        const f2 = await flush(ctx);
        if (!f2.ok) return f2;
        // Approval is durable + the supervisor is woken — now wake the
        // initiating orchestrator (approval, then the newly entered stage).
        // The plan drains AFTER the store lock releases; the approvalHash is
        // pinned so a later re-approval can't relabel this intent's key.
        const wakes: WakeEvent[] = [{ kind: 'approval', approver: input.approver, approvalHash: hash }];
        if (fresh) wakes.push({ kind: 'stage', status: 'independent_review' });
        plan = planWakes(ctx, wakes, false);
        return ok({ approvalId: record.approvalId, hash, ...(warnings.length > 0 ? { warnings } : {}) });
      });
      if (plan !== null) await drainWakes(plan);
      return inner;
    } catch (e) {
      return failRes(err('io_error', `approve crashed: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  const status = async (): Promise<Result<EngineStatus>> => {
    const st = await store.loadState();
    if (!st.ok) return st;
    const state = st.value;
    const pending: string[] = [];
    if (state.status === 'awaiting_approval') {
      pending.push('approve the proposed roster (exact seats/agents/config) to launch reviewers');
    }
    if (
      state.approvalHash === null &&
      ['independent_review', 'scribe_notes', 'discussing', 'synthesising'].includes(state.status)
    ) {
      pending.push('approval invalidated — re-approve the exact same roster to resume');
    }
    for (const p of state.participants) {
      for (const a of p.attempts) {
        if (a.status === 'unknown') {
          pending.push(
            `reconcile unknown outcome for ${a.participantId}/${a.phase} dispatch ${a.dispatchId ?? 'none'} requestId ${a.requestId ?? 'none'} — never relaunch`,
          );
        } else if (
          state.status === 'cancelled' &&
          (a.status === 'dispatched' || a.status === 'working' || a.status === 'timed_out')
        ) {
          pending.push(`dispatch ${a.dispatchId} may still be running; stop was refused/unconfirmed`);
        }
      }
    }
    // Read-only timing facts — persisted state + journal tail only; nothing
    // here probes host liveness or mutates the run (operator contract).
    const at = now().getTime();
    const dl = state.config.deadlines;
    const phaseDeadline = phaseDeadlineMs(state);
    const phaseElapsedMs = Math.max(0, at - Date.parse(state.phaseEnteredAt));
    const runElapsedMs = Math.max(0, at - Date.parse(state.createdAt));
    // lastActivity is the newest durable journal event — a fact about the
    // RECORD, never a heartbeat. An unreadable journal degrades the field
    // honestly rather than failing the whole read.
    let lastActivity: EngineStatus['lastActivity'];
    const journal = await store.readJournal();
    if (journal.ok && journal.value.length > 0) {
      const tail = journal.value[journal.value.length - 1];
      lastActivity = { ts: tail.ts, seq: tail.seq, type: tail.type };
    }
    return ok({
      status: state.status,
      discussion: state.discussion,
      participants: state.participants.map((p) => {
        const active = p.attempts.find((a) => ACTIVE_ATTEMPT.has(a.status) || a.status === 'intent_recorded');
        return {
          participantId: p.participantId,
          role: p.role,
          status: p.status,
          activeAttempt: active?.attemptId ?? null,
          ...(active !== undefined
            ? {
                activeAttemptDetail: {
                  attemptId: active.attemptId,
                  phase: active.phase,
                  round: active.round,
                  status: active.status,
                  taskId: active.taskId,
                  dispatchId: active.dispatchId,
                  terminalHandle: active.terminalHandle,
                  ...(active.requestId !== undefined ? { requestId: active.requestId } : {}),
                },
              }
            : {}),
        };
      }),
      consumption: { ...state.consumption },
      approvalHash: state.approvalHash,
      pendingDecisions: pending,
      phaseTiming: {
        enteredAt: state.phaseEnteredAt,
        elapsedMs: phaseElapsedMs,
        ...(phaseDeadline !== undefined
          ? { deadlineMs: phaseDeadline, graceMs: dl.graceMs, remainingMs: phaseDeadline - phaseElapsedMs }
          : {}),
      },
      runTiming: {
        createdAt: state.createdAt,
        elapsedMs: runElapsedMs,
        deadlineMs: dl.runMs,
        remainingMs: dl.runMs - runElapsedMs,
      },
      ...(lastActivity !== undefined ? { lastActivity } : {}),
      supervisor: state.supervisor === null ? null : { ...state.supervisor },
    });
  };

  const cancel = async (input: { reason: string }): Promise<Result<void>> => {
    try {
      let plan: WakePlan | null = null;
      const inner = await store.withLock(async () => {
        const st = await store.loadState();
        if (!st.ok) return st;
        const bc = await buildCtx(st.value);
        if (!bc.ok) return bc;
        const ctx = bc.value;
        const { state } = ctx;
        if (state.status === 'reported' || state.status === 'failed' || state.status === 'cancelled') {
          return failRes(err('invalid_transition', `run already terminal (${state.status})`));
        }
        for (const p of state.participants) {
          for (const a of p.attempts) {
            // timed_out workers may still be physically running — a deadline
            // mark is not proof of death — so they get a stop request too.
            if ((!ACTIVE_ATTEMPT.has(a.status) && a.status !== 'timed_out') || a.dispatchId === null) continue;
            if (ctx.stopRequestedAttempts.has(a.attemptId)) continue; // RA-008: intent/outcome already journaled — never blind-reissue
            ctx.stopRequestedAttempts.add(a.attemptId);
            emit(ctx, 'worker.stop_requested', {
              attemptId: a.attemptId,
              dispatchId: a.dispatchId,
              outcome: 'intent',
              scope: 'cancel',
              reason: input.reason,
            }, { participantId: p.participantId });
            const fi = await flush(ctx);
            if (!fi.ok) {
              emit(ctx, 'error', {
                op: 'stop-request',
                attemptId: a.attemptId,
                detail: `stop intent could not be journaled (${fi.error.message}); not issuing requestStop without custody`,
              }, { participantId: p.participantId });
              continue;
            }
            const r = await host.requestStop({ dispatchId: a.dispatchId, reason: input.reason });
            if (!r.ok) {
              emit(ctx, 'worker.stop_requested', {
                attemptId: a.attemptId,
                dispatchId: a.dispatchId,
                outcome: 'error',
                error: r.error.message,
              }, { participantId: p.participantId });
              continue;
            }
            const outcome = r.value.outcome;
            emit(ctx, 'worker.stop_requested', {
              attemptId: a.attemptId,
              dispatchId: a.dispatchId,
              outcome,
            }, { participantId: p.participantId });
            if (outcome === 'stopped') {
              a.status = 'stopped';
              a.settledAt = ctx.now.toISOString();
              emit(ctx, 'worker.stopped', { attemptId: a.attemptId, dispatchId: a.dispatchId }, { participantId: p.participantId });
            } else if (outcome === 'unknown') {
              a.status = 'unknown';
            }
            // 'refused' leaves the attempt exactly as observed — unresolved.
          }
          const allTerminal = p.attempts.length > 0 && p.attempts.every((x) => TERMINAL_ATTEMPT.has(x.status));
          if (allTerminal) p.status = 'stopped';
        }
        await releaseRetainedWorkers(ctx);
        state.status = 'cancelled';
        emit(ctx, 'run.finished', { outcome: 'cancelled', reason: input.reason });
        await finalizeRunTerminals(ctx, 'engine');
        await restoreLeanEnv(ctx, 'engine');
        await noticeSupervisorCancelled(ctx, input.reason);
        const f = await flush(ctx);
        if (!f.ok) return f;
        // Terminal call: drain the full pending catch-up — there is no later
        // advance to recompute it.
        plan = planWakes(ctx, [{ kind: 'finished', outcome: 'cancelled', note: input.reason }], true);
        return ok(undefined);
      });
      if (plan !== null) await drainWakes(plan);
      return inner;
    } catch (e) {
      return failRes(err('io_error', `cancel crashed: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  /**
   * After `cancel`: one bounded notice to the recorded supervisor Dispatch
   * so it advances once (seeing `finished/cancelled`) and sends worker_done —
   * otherwise nothing ever tells it the run ended and its terminal can never
   * be released. Same bounded-mail custody as the approval wake (journaled
   * intent, per-recipient cap, never resent blind). Sent ONLY when the
   * dispatch is observed live/idle: mail to a settled Dispatch would reopen
   * it as new work, and an unobservable one is not guessed at.
   */
  const noticeSupervisorCancelled = async (ctx: StepCtx, reason: string): Promise<void> => {
    const dispatchId = ctx.state.supervisor?.dispatchId ?? null;
    if (dispatchId === null) {
      emit(ctx, 'mail.sent', { kind: 'cancel-notice', outcome: 'skipped', reason: 'no supervisor dispatch recorded' });
      return;
    }
    const obs = await host.observeWorker({ dispatchId });
    const liveness = obs.ok ? obs.value.liveness : undefined;
    if (liveness !== 'idle' && liveness !== 'working' && liveness !== 'waiting_human') {
      emit(ctx, 'mail.sent', {
        kind: 'cancel-notice',
        outcome: 'skipped',
        dispatchId,
        reason: liveness === 'finished'
          ? 'supervisor dispatch already settled — a notice would reopen it as new work'
          : `supervisor dispatch state unproven (${obs.ok ? liveness : `observe failed: ${obs.error.code}`}) — not notified`,
      });
      return;
    }
    await sendBoundedMail(ctx, {
      to: `dispatch:${dispatchId}`,
      subject: `council ${ctx.state.runId}: run cancelled`,
      body:
        `The council run ${ctx.state.runId} was cancelled (${reason.slice(0, 200)}). ` +
        `Run \`council supervise --run ${store.runDir} --advance --as-supervisor\` once — it reports finished/cancelled — ` +
        `then send worker_done reporting that printed outcome. Start no other work.`,
    }, 'cancel-notice');
  };

  /**
   * `council cleanup`: on a terminal run only, release-then-close every
   * terminal this run recorded (engine-created participant terminals plus
   * the supervisor proven by its startup record) whose dispatch is settled,
   * fenced, lost or never issued. Unsettled attempts are OBSERVED (read
   * only) — a host verdict counts as settled. Earlier failed closes and
   * receipt-less intents are retried; closed/already-gone receipts are not.
   * Unrecorded terminals are never touched; the run state never changes.
   */
  const cleanup = async (input: {
    supervisor?: SupervisorCleanupCustody;
    callerHandle?: string;
  } = {}): Promise<Result<TerminalCleanupReport>> => {
    try {
      return await store.withLock(async () => {
        const st = await store.loadState();
        if (!st.ok) return st;
        if (!TERMINAL_STATUS.has(st.value.status)) {
          return failRes(err('invalid_transition', `cleanup refuses a non-terminal run (status ${st.value.status}) — terminals may still be in use; finish or cancel the run first`));
        }
        const bc = await buildCtx(st.value);
        if (!bc.ok) return bc;
        const ctx = bc.value;
        const terminals = await finalizeRunTerminals(ctx, 'cleanup', input.callerHandle);
        if (input.supervisor !== undefined && !terminals.some((t) => t.terminalHandle === input.supervisor!.terminalHandle)) {
          terminals.push(await cleanupSupervisorTerminal(ctx, input.supervisor, input.callerHandle));
        }
        // Lean restore finishes whatever a crash left mid-restore; failures
        // are journaled warnings in the report, never cleanup errors.
        const lean = await restoreLeanEnv(ctx, 'cleanup');
        const f = await flush(ctx);
        if (!f.ok) return f;
        return ok({ status: ctx.state.status, terminals, ...(lean !== undefined ? { lean } : {}) });
      });
    } catch (e) {
      return failRes(err('io_error', `cleanup crashed: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  return { advance, approve, status, cancel, cleanup };
}
