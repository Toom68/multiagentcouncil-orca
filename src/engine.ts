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
  type Participant,
  type ParticipantId,
  type Perspective,
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
  type TaskListRow,
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
  parseFindingsFile,
  parseProposedRoster,
  parseReportFile,
  parseResponsesFile,
  parseScribeNotesFile,
} from './validation.js';
import * as validationNs from './validation.js';
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
   * Operation-stage chronology (journal-derived, last-write-wins): the most
   * recent durable entry for each host mutation. 'issued' ⇒ the op ran and
   * its outcome is uncertain; 'refused' ⇒ a definitive no-effect refusal was
   * receipted; absent ⇒ see intentProtocol (v2+ proves never-issued, legacy
   * intents cannot).
   */
  taskCreateStage: Map<AttemptId, 'issued' | 'refused'>;
  workerLaunchStage: Map<AttemptId, 'issued' | 'refused'>;
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
}

/** Corrective-attempt context handed to the spec builders (RepairContext). */
interface RepairSpec {
  /** The rejected attempt this repair corrects (journaled lineage). */
  repairOf: AttemptId;
  contract: string;
  diagnostics: string[];
  previousArtifactPath?: string;
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
          diagnostics: rs.diagnostics,
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
  ): Promise<{ kind: 'proceed' } | { kind: 'adopted' } | { kind: 'blocked'; outcome: LaunchOutcome }> => {
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
    // Resume of a persisted intent: the host mutation may have landed after
    // the intent flush but before its receipt — resolve by OBSERVATION first.
    if (attempt.status === 'intent_recorded') {
      const resolved = await resolveRecordedIntent(ctx, p, attempt);
      if (resolved.kind === 'blocked') return resolved.outcome;
      if (resolved.kind === 'adopted') return { kind: 'launched' };
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
    const w = await store.writeArtifact(specRel, built.spec);
    if (!w.ok) return { kind: 'task_error', error: w.error };
    emit(ctx, 'artifact.written', { path: specRel, kind: 'spec' }, { participantId: p.participantId, phase: attempt.phase });

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
    });
    if (!launch.ok) {
      emit(ctx, 'error', {
        op: 'worker-launch',
        attemptId: attempt.attemptId,
        code: launch.error.code,
        message: launch.error.message,
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
      return { kind: 'launched' };
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
      emit(ctx, 'worker.settled', {
        attemptId: attempt.attemptId,
        outcome: 'failed',
        detail: `retained-terminal launch failed (${res.detail ?? 'no detail'}); falling back to a fresh session`,
      }, { participantId: p.participantId, phase: attempt.phase });
      const fallback = addPlannedAttempt(p, attempt.phase, attempt.round);
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

  const readJson = async (rel: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> => {
    const r = await store.readArtifact(rel);
    if (!r.ok) return { ok: false, reason: `missing/unreadable: ${r.error.message}` };
    try {
      return { ok: true, value: JSON.parse(r.value) };
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
    const w = await store.writeArtifact(rel, existing.value);
    if (!w.ok) {
      emit(ctx, 'error', {
        op: 'rejected-preserve',
        attemptId: attempt.attemptId,
        detail: `failed to archive rejected artifact to ${rel}: ${w.error.message}`,
      }, { participantId: attempt.participantId, phase: attempt.phase });
      return undefined;
    }
    emit(ctx, 'artifact.written', { path: rel, kind: 'rejected-archive', supersedes: outRel }, {
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
    const payload: Record<string, unknown> = { attemptId: attempt.attemptId, path: outRel, issues };
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
        diagnostics: diagnosticsFor(issues),
        ...(preserved !== undefined ? { previousArtifactPath: abs(preserved) } : {}),
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

  const admit = (ctx: StepCtx, attempt: PhaseAttempt, path: string): void => {
    attempt.artifacts.push(path);
    ctx.artifacts.push(path);
    emit(ctx, 'artifact.admitted', { attemptId: attempt.attemptId, path }, {
      participantId: attempt.participantId,
      phase: attempt.phase,
      ...(attempt.round !== null ? { round: attempt.round } : {}),
    });
  };

  /** Claim ids this attempt was assigned (from the envelope we wrote). */
  const assignedClaimIds = async (path: string): Promise<Set<string>> => {
    const r = await readJson(path);
    if (!r.ok) return new Set();
    const assignments = (r.value as { assignments?: { claimId?: string }[] }).assignments ?? [];
    return new Set(assignments.map((a) => a.claimId).filter((x): x is string => typeof x === 'string'));
  };

  /** Challenge ids assigned to this author (flattened over its assignments). */
  const assignedChallengeIds = async (path: string): Promise<Set<string>> => {
    const r = await readJson(path);
    if (!r.ok) return new Set();
    const assignments = (r.value as { assignments?: { challenges?: { challengeId?: string }[] }[] }).assignments ?? [];
    const out = new Set<string>();
    for (const a of assignments) for (const c of a.challenges ?? []) {
      if (typeof c.challengeId === 'string') out.add(c.challengeId);
    }
    return out;
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
            admit(ctx, attempt, outPath);
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
            admit(ctx, attempt, outPath);
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
            admit(ctx, attempt, outPath);
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
            const allowed = await assignedClaimIds(paths.challengeEnv(p.participantId, attempt.round ?? 1));
            const bad = parsed.value.challenges.filter((c) => !allowed.has(c.claimId));
            const ids = parsed.value.challenges.map((c) => c.challengeId);
            const dup = ids.length !== new Set(ids).size;
            if (bad.length > 0 || dup) {
              await rejectOutput(ctx, p, attempt, outPath, {
                unassignedClaimIds: bad.map((c) => c.claimId),
                duplicateChallengeIds: dup,
              });
              break;
            }
            admit(ctx, attempt, outPath);
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
            const allowed = await assignedChallengeIds(paths.responseEnv(p.participantId, attempt.round ?? 1));
            const bad = parsed.value.responses.filter((r) => !allowed.has(r.challengeId));
            if (bad.length > 0) {
              await rejectOutput(ctx, p, attempt, outPath, {
                unassignedChallengeIds: bad.map((r) => r.challengeId),
              });
              break;
            }
            admit(ctx, attempt, outPath);
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
            admit(ctx, attempt, outPath);
            break;
          }
        }
      }
    }
    return ok(undefined);
  };

  /** Read back every admitted file of a phase (trusted, engine-admitted). */
  const admittedFiles = async <T>(
    state: CouncilState,
    phase: PhaseKind,
    round: number | null,
  ): Promise<{ participantId: ParticipantId; file: T }[]> => {
    const out: { participantId: ParticipantId; file: T }[] = [];
    for (const p of state.participants) {
      for (const a of attemptsFor(p, phase, round)) {
        for (const rel of a.artifacts) {
          const raw = await readJson(rel);
          if (raw.ok) out.push({ participantId: p.participantId, file: raw.value as T });
        }
      }
    }
    return out;
  };

  const readLedger = async (state: CouncilState): Promise<ClaimLedger | null> => {
    const raw = await readJson(paths.ledger);
    return raw.ok ? (raw.value as ClaimLedger) : null;
  };

  const writeLedger = async (ctx: StepCtx, ledger: ClaimLedger): Promise<Result<void>> => {
    const w = await store.writeArtifact(paths.ledger, JSON.stringify(ledger, null, 2));
    if (!w.ok) return w;
    emit(ctx, 'claim.updated', { claims: ledger.claims.length });
    return ok(undefined);
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
        emit(ctx, 'error', { op: 'run-create', code: run.error.code, message: run.error.message });
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
    const organiser = makeParticipant(ORGANISER_PID, 'organiser', staffAgent(state, 'organiser'), null, null);
    state.participants.push(organiser);
    addPlannedAttempt(organiser, 'organiser', null);
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
    const attempt = attemptsFor(p, 'organiser', null).at(-1)!;
    await reconcileAttempts(ctx);
    if (await enforceDeadlines(ctx)) {
      return advanceResult('finished', state.status, undefined, { outcome: 'failed' });
    }
    const adm = await admitPhaseOutputs(ctx);
    if (!adm.ok) return { kind: 'error', error: adm.error };
    const statusAfter: RunStatus = ctx.state.status;
    if (statusAfter === 'awaiting_approval') {
      return advanceResult('needs_approval', statusAfter, 'roster proposed — approve the exact seats/agents/config to launch reviewers');
    }
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

    const all = due.map((d) => d.attempt);
    const done = all.every((a) => isBarrierDone(a, deadlineExpired));
    if (!done) {
      return advanceResult(
        launched.launched > 0 ? 'progress' : 'wait',
        state.status,
        launched.launched > 0 ? `launched ${launched.launched} reviewer(s)` : 'reviewers active',
      );
    }

    // Barrier: phase closed. Build the canonical ledger from admitted findings.
    const admittedFindings = await admittedFiles<FindingsFile>(state, 'independent_review', null);
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
    emit(ctx, 'artifact.written', { path: paths.ledger, claims: build.ledger.claims.length });

    // Enter scribe-notes phase with a fresh, distinct scribe participant.
    const scribe = makeParticipant(SCRIBE_PID, 'scribe', staffAgent(state, 'scribe'), null, null);
    state.participants.push(scribe);
    addPlannedAttempt(scribe, 'scribe_notes', null);
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
      const admitted = await admittedFiles<FindingsFile>(state, 'independent_review', null);
      ctx.admittedFindingsPaths = admitted.map((f) => abs(paths.findingsOut(f.file.participantId)));
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
    const ledger = await readLedger(state);
    if (ledger === null) return { kind: 'error', error: err('invalid_transition', 'claims.json missing at discussion entry') };
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
    for (const [pid, assignments] of plan.assignments) {
      if (assignments.length === 0) continue;
      const p = findParticipant(state, pid)!;
      const base = makeEnvelopeBase<ChallengeAssignment>({
        runId: state.runId,
        phase: 'challenge',
        round,
        recipientId: pid,
        outputPath: paths.challengeOut(pid, round),
        outputContract: 'ChallengesFile',
      });
      const fit = fitEnvelope(base, assignments, state.config.envelopeBytes);
      const envRel = paths.challengeEnv(pid, round);
      const w = await store.writeArtifact(envRel, JSON.stringify(fit.envelope, null, 2));
      if (!w.ok) return { kind: 'error', error: w.error };
      emit(ctx, 'envelope.built', {
        path: envRel,
        recipientId: pid,
        round,
        assigned: fit.envelope.assignments.length,
        omitted: [...fit.omitted.map((a) => a.claimId), ...plan.unassigned.map((u) => u.claimId)],
        bytes: fit.bytes,
      }, { participantId: pid, phase: 'challenge', round });
      addPlannedAttempt(p, 'challenge', round);
      total += fit.envelope.assignments.length;
    }
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

    const all = due.map((d) => d.attempt);
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
    const ledger = await readLedger(state);
    if (ledger === null) {
      return { kind: 'error', error: err('invalid_transition', 'claims.json missing at response fold') };
    }
    const admittedResponses = await admittedFiles<ResponsesFile>(state, 'author_response', round);
    if (admittedResponses.length === 0) return null;
    const admittedChallenges = await admittedFiles<ChallengesFile>(state, 'challenge', round);
    const challengeIndex = indexAdmittedChallenges(
      admittedChallenges.map((a) => ({ participantId: a.participantId, file: a.file })),
    );
    let snapshot = ctx.snapshot;
    if (snapshot === undefined) {
      const snapR = await store.readSnapshot();
      if (!snapR.ok) return { kind: 'error', error: snapR.error };
      snapshot = snapR.value;
    }
    const applied = applyResponsesToLedger(
      ledger,
      admittedResponses.map((a) => ({ participantId: a.participantId, file: a.file })),
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
    const ledger = await readLedger(state);
    if (ledger === null) return { kind: 'error', error: err('invalid_transition', 'claims.json missing at response stage') };

    const admittedChallenges = await admittedFiles<ChallengesFile>(state, 'challenge', round);
    let snapshot = ctx.snapshot;
    if (snapshot === undefined) {
      const snapR = await store.readSnapshot();
      if (!snapR.ok) return { kind: 'error', error: snapR.error };
      snapshot = snapR.value;
    }
    const applied = applyChallengesToLedger(
      ledger,
      admittedChallenges.map((a) => ({ participantId: a.participantId, file: a.file })),
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
      admittedChallenges.map((a) => ({ participantId: a.participantId, file: a.file })),
    );
    const plan = assignResponses({
      challenges: challengeIndex,
      claimsById: claimsById(ledger),
      maxPerSeat: state.config.maxResponsesPerSeatPerRound,
    });
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

    let total = 0;
    for (const [pid, assignments] of plan.assignments) {
      if (assignments.length === 0) continue;
      const p = findParticipant(state, pid);
      if (p === undefined) continue;
      const base = makeEnvelopeBase<ResponseAssignment>({
        runId: state.runId,
        phase: 'author_response',
        round,
        recipientId: pid,
        outputPath: paths.responseOut(pid, round),
        outputContract: 'ResponsesFile',
      });
      const fit = fitEnvelope(base, assignments, state.config.envelopeBytes);
      const envRel = paths.responseEnv(pid, round);
      const wr = await store.writeArtifact(envRel, JSON.stringify(fit.envelope, null, 2));
      if (!wr.ok) return { kind: 'error', error: wr.error };
      emit(ctx, 'envelope.built', {
        path: envRel,
        recipientId: pid,
        round,
        assigned: fit.envelope.assignments.length,
        omitted: fit.omitted.map((a) => a.claimId),
        bytes: fit.bytes,
      }, { participantId: pid, phase: 'author_response', round });
      addPlannedAttempt(p, 'author_response', round);
      total += fit.envelope.assignments.length;
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
    addPlannedAttempt(scribe, 'scribe_synthesis', null);
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
    const [proposedR, approvedR, ledger] = await Promise.all([
      store.readProposedRoster(),
      store.readApprovedRoster(),
      readLedger(state),
    ]);
    if (!proposedR.ok || !approvedR.ok || ledger === null) {
      return {
        kind: 'error',
        error: err('invalid_transition', 'cannot finalize: roster or ledger artifacts missing'),
      };
    }

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
    // ReportFile artifact (both carry summary + limitations).
    let scribe: ScribeNarrative | undefined;
    const rawReport = await readJson(paths.scribeReportJson);
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
      const w = await store.writeArtifact(rel, content);
      if (!w.ok) return { kind: 'error', error: w.error };
      emit(ctx, 'report.written', { path: rel });
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
      const r = await host.releaseWorker({ dispatchId: last.dispatchId! });
      emit(ctx, 'worker.released', {
        participantId: p.participantId,
        dispatchId: last.dispatchId,
        released: r.ok ? r.value.released : false,
        ...(r.ok ? {} : { error: r.error.message }),
      });
    }
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
    const note = await host.sendNotification(input);
    emit(ctx, 'mail.sent', {
      to: input.to,
      outcome: note.ok ? note.value.outcome : 'error',
      ...(note.ok && note.value.requestId !== undefined ? { requestId: note.value.requestId } : {}),
      ...(note.ok && note.value.messageId !== undefined ? { messageId: note.value.messageId } : {}),
      ...(note.ok ? {} : { error: note.error.message }),
      kind,
    });
    if (note.ok && (note.value.outcome === 'sent' || note.value.outcome === 'unknown')) {
      ctx.mailSentByTarget.set(input.to, sent + 1);
      if (note.value.outcome === 'sent') ctx.state.consumption.mailSent += 1;
    }
  };

  // ── Advance dispatch ───────────────────────────────────────────────────────

  const buildCtx = async (state: CouncilState): Promise<StepCtx> => {
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
      taskCreateStage: new Map(),
      workerLaunchStage: new Map(),
      intentProtocol: new Map(),
    };
    const journal = await store.readJournal();
    if (journal.ok) {
      let runOk = false;
      const attemptOverlay = new Map<AttemptId, {
        journaledStatus?: AttemptStatus;
        taskId?: string;
        dispatchId?: string;
        terminalHandle?: string;
        requestId?: string;
      }>();
      for (const e of journal.value) {
        if (e.type === 'launch.intent' && e.payload?.scope === 'run') ctx.runCreateUnresolved = true;
        if (e.type === 'task.created' && e.payload?.scope === 'run') runOk = true;
        if (e.type === 'artifact.rejected' && typeof e.payload?.attemptId === 'string') {
          ctx.rejectedAttempts.add(e.payload.attemptId);
          // A repair tuple is consumed when the corrective attempt is created —
          // journaled on the rejected event so a restart cannot mint another.
          if (typeof e.payload?.repairTuple === 'string') ctx.repairedKeys.add(e.payload.repairTuple);
          const repair = e.payload?.repair as { repairOf?: unknown; contract?: unknown; diagnostics?: unknown; previousArtifactPath?: unknown } | undefined;
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
          } else {
            const v = typeof e.payload?.v === 'number' ? e.payload.v : 1;
            ctx.intentProtocol.set(aid, Math.max(ctx.intentProtocol.get(aid) ?? 1, v));
          }
        }
        if (e.type === 'error' && e.payload?.op === 'task-create' && typeof e.payload?.attemptId === 'string') {
          ctx.taskCreateFailed.add(e.payload.attemptId);
          ctx.taskCreateStage.set(e.payload.attemptId, 'refused');
        }
        if (e.type === 'error' && e.payload?.op === 'worker-launch' && typeof e.payload?.attemptId === 'string') {
          const id = e.payload.attemptId;
          ctx.workerLaunchFailures.set(id, (ctx.workerLaunchFailures.get(id) ?? 0) + 1);
          ctx.workerLaunchStage.set(id, 'refused');
        }
        if (
          e.type === 'mail.sent' &&
          typeof e.payload?.to === 'string' &&
          (e.payload?.outcome === 'sent' || e.payload?.outcome === 'unknown')
        ) {
          const to = e.payload.to as string;
          ctx.mailSentByTarget.set(to, (ctx.mailSentByTarget.get(to) ?? 0) + 1);
        }
        if (e.type === 'worker.stop_requested' && typeof e.payload?.attemptId === 'string') {
          ctx.stopRequestedAttempts.add(e.payload.attemptId);
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
              break;
            case 'worker.timed_out': ov.journaledStatus = 'timed_out'; break;
            case 'worker.stopped': ov.journaledStatus = 'stopped'; break;
            default: break;
          }
        }
      }
      if (runOk) ctx.runCreateUnresolved = false;
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
          if (a.requestId === undefined && ov.requestId !== undefined) a.requestId = ov.requestId;
          const js = ov.journaledStatus;
          if (js !== undefined && (STATUS_RANK[js] ?? 0) > (STATUS_RANK[a.status] ?? 0)) {
            a.status = js;
          }
        }
      }
    }
    const snap = await store.readSnapshot();
    if (snap.ok) ctx.snapshot = snap.value;
    return ctx;
  };

  const advance = async (): Promise<Result<AdvanceResult>> => {
    try {
      return await store.withLock(async () => {
        const st = await store.loadState();
        if (!st.ok) return st;
        const ctx = await buildCtx(st.value);
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
        const f = await flush(ctx);
        if (!f.ok) return f;
        return ok(step.result);
      });
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
      return await store.withLock(async () => {
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
        const ctx = await buildCtx(state);
        const wr = await store.writeApprovedRoster(roster);
        if (!wr.ok) return wr;
        const wa = await store.writeApproval(record, binding);
        if (!wa.ok) return wa;
        state.approvalHash = hash;
        emit(ctx, 'approval.granted', { hash, approvalId: record.approvalId, approver: input.approver, seats: roster.seats.length, reApproval: reapproval });
        if (fresh) {
          for (const seat of roster.seats) {
            const p = makeParticipant(seat.participantId, 'reviewer', seat.agent, seat.seatId, seat.perspectiveId);
            state.participants.push(p);
            addPlannedAttempt(p, 'independent_review', null);
          }
          state.status = 'independent_review';
          state.phaseEnteredAt = ctx.now.toISOString();
          emit(ctx, 'phase.entered', { status: 'independent_review', seats: roster.seats.length });
        }
        const f = await flush(ctx);
        if (!f.ok) return f;

        // Explicit wake: writing approval files alone does not wake Orca.
        // The send respects the per-recipient mail budget (journaled counts).
        const to = state.orcaRunId !== null
          ? `run:${state.orcaRunId}`
          : state.supervisor?.terminalHandle;
        if (to !== undefined) {
          await sendBoundedMail(ctx, {
            to,
            subject: `council ${state.runId}: approval granted`,
            body: `Approval ${record.approvalId} bound (hash ${hash.slice(0, 16)}…). Advance the run.`,
            ...(state.supervisor?.dispatchId !== null && state.supervisor?.dispatchId !== undefined
              ? { dispatchId: state.supervisor.dispatchId }
              : {}),
          }, 'approval-wake');
        } else {
          emit(ctx, 'mail.sent', { kind: 'approval-wake', outcome: 'skipped', reason: 'no supervisor identity or run bound' });
        }
        const f2 = await flush(ctx);
        if (!f2.ok) return f2;
        return ok({ approvalId: record.approvalId, hash });
      });
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
    return ok({
      status: state.status,
      discussion: state.discussion,
      participants: state.participants.map((p) => ({
        participantId: p.participantId,
        role: p.role,
        status: p.status,
        activeAttempt: p.attempts.find((a) => ACTIVE_ATTEMPT.has(a.status) || a.status === 'intent_recorded')?.attemptId ?? null,
      })),
      consumption: { ...state.consumption },
      approvalHash: state.approvalHash,
      pendingDecisions: pending,
    });
  };

  const cancel = async (input: { reason: string }): Promise<Result<void>> => {
    try {
      return await store.withLock(async () => {
        const st = await store.loadState();
        if (!st.ok) return st;
        const ctx = await buildCtx(st.value);
        const { state } = ctx;
        if (state.status === 'reported' || state.status === 'failed' || state.status === 'cancelled') {
          return failRes(err('invalid_transition', `run already terminal (${state.status})`));
        }
        for (const p of state.participants) {
          for (const a of p.attempts) {
            // timed_out workers may still be physically running — a deadline
            // mark is not proof of death — so they get a stop request too.
            if ((!ACTIVE_ATTEMPT.has(a.status) && a.status !== 'timed_out') || a.dispatchId === null) continue;
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
        const f = await flush(ctx);
        if (!f.ok) return f;
        return ok(undefined);
      });
    } catch (e) {
      return failRes(err('io_error', `cancel crashed: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  return { advance, approve, status, cancel };
}
