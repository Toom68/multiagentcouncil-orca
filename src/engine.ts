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
  type ChallengeAssignment,
  type ChallengesFile,
  type ClaimLedger,
  type CouncilError,
  type CouncilState,
  type Engine,
  type EngineDeps,
  type EngineStatus,
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
  type SourceSnapshot,
} from './contracts.js';
import {
  assertSafeRelativePath,
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

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const failRes = (error: CouncilError): Result<never> => ({ ok: false, error });

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
  /** True when a prior run-create intent exists without a recorded success. */
  runCreateUnresolved: boolean;
  /** Perspective catalog from the admitted proposal (reviewer spec inputs). */
  perspectives?: Map<string, Perspective>;
  /** Admitted findings paths handed to the scribe-notes prompt. */
  admittedFindingsPaths?: string[];
  /** Snapshot resolved once per step (prompt ctx + evidence validation). */
  snapshot?: SourceSnapshot;
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

  /** Persist state + pending journal events. Called before every host mutation. */
  const flush = async (ctx: StepCtx): Promise<Result<void>> => {
    const s = await store.saveState(ctx.state);
    if (!s.ok) return s;
    if (ctx.events.length > 0) {
      const j = await store.appendJournal(ctx.events.splice(0));
      if (!j.ok) return j;
    }
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

  const activeAttempts = (state: CouncilState): PhaseAttempt[] =>
    state.participants.flatMap((p) => p.attempts.filter((a) => ACTIVE_ATTEMPT.has(a.status)));

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

  /** Observe every launched attempt once; updates attempt status in place. */
  const reconcileAttempts = async (ctx: StepCtx): Promise<void> => {
    for (const p of ctx.state.participants) {
      for (const attempt of p.attempts) {
        if (!ACTIVE_ATTEMPT.has(attempt.status) || attempt.dispatchId === null) continue;
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
          if (attempt.status !== 'working') {
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

  /** Mark overdue active attempts timed_out; returns true when the run died. */
  const enforceDeadlines = (ctx: StepCtx): boolean => {
    const { state } = ctx;
    const elapsedRun = ctx.now.getTime() - Date.parse(state.createdAt);
    if (elapsedRun > state.config.deadlines.runMs) {
      for (const a of activeAttempts(state)) {
        a.status = 'timed_out';
        a.settledAt = ctx.now.toISOString();
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
        if (
          a.status === 'dispatched' ||
          a.status === 'working' ||
          a.status === 'planned' ||
          a.status === 'intent_recorded'
        ) {
          a.status = 'timed_out';
          a.settledAt = ctx.now.toISOString();
          p.status = 'timed_out';
          emit(ctx, 'worker.timed_out', {
            attemptId: a.attemptId,
            dispatchId: a.dispatchId,
            elapsedMs: elapsed,
          }, { participantId: p.participantId, phase: a.phase });
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
    const binding = buildBinding(state, rosterR.value, proposedR.value, snapR.value);
    const recomputed = canonicalApprovalHash(binding);
    if (recomputed !== state.approvalHash || recomputed !== appr.value.record.hash) {
      state.approvalHash = null;
      emit(ctx, 'approval.invalidated', {
        reason: 'binding_mismatch',
        expected: appr.value.record.hash,
        recomputed,
      });
      return failRes(
        err('approval_stale', 'approval binding no longer matches persisted artifacts; re-approval required'),
      );
    }
    const drift = await store.verifySourceSnapshot();
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
          err('snapshot_drift', 'reviewed source changed since approval; re-snapshot and re-approve', {
            details: { changed: manifestChanged, added },
          }),
        );
      }
    }
    return ok(undefined);
  };

  const buildBinding = (
    state: CouncilState,
    roster: ApprovedRoster,
    proposed: ProposedRoster,
    snapshot: SourceSnapshot,
  ): ApprovalBinding => ({
    schemaVersion: SCHEMA_VERSION,
    runId: state.runId,
    objective: state.objective,
    seats: roster.seats,
    proposedRosterHash: canonicalRosterHash(proposed),
    config: state.config,
    snapshotId: snapshot.snapshotId,
    snapshotHeadHash: snapshot.headHash,
  });

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
    switch (attempt.phase) {
      case 'organiser':
        return { spec: prompts.organiser(promptCtx, { participantId: p.participantId, outputPath: outAbs }), outRel };
      case 'independent_review': {
        const perspective = ctx.perspectives?.get(p.perspectiveId ?? '');
        if (perspective === undefined) return null;
        return {
          spec: prompts.reviewerIndependent(promptCtx, {
            participantId: p.participantId,
            perspective,
            outputPath: outAbs,
          }),
          outRel,
        };
      }
      case 'scribe_notes':
        return {
          spec: prompts.scribeNotes(promptCtx, {
            participantId: p.participantId,
            admittedFindingsPaths: ctx.admittedFindingsPaths ?? [],
            outputPath: outAbs,
          }),
          outRel,
        };
      case 'challenge':
        return {
          spec: prompts.challenge(promptCtx, {
            participantId: p.participantId,
            envelopePath: abs(paths.challengeEnv(p.participantId, attempt.round ?? 1)),
            outputPath: outAbs,
          }),
          outRel,
        };
      case 'author_response':
        return {
          spec: prompts.authorResponse(promptCtx, {
            participantId: p.participantId,
            envelopePath: abs(paths.responseEnv(p.participantId, attempt.round ?? 1)),
            outputPath: outAbs,
          }),
          outRel,
        };
      case 'scribe_synthesis':
        return {
          spec: prompts.scribeSynthesis(promptCtx, {
            participantId: p.participantId,
            ledgerPath: abs(paths.ledger),
            journalPath: abs('events.jsonl'),
            reportJsonPath: abs(paths.scribeReportJson),
            reportMdPath: abs(paths.scribeReportMd),
            summaryPath: abs(paths.scribeSummary),
          }),
          outRel,
        };
    }
  };

  interface LaunchOutcome {
    kind: 'launched' | 'failed' | 'unknown' | 'task_error' | 'budget' | 'approval';
    error?: CouncilError;
    note?: string;
  }

  /**
   * Persist intent → write spec → createTask (resumed when taskId already
   * exists) → launchWorker. Fresh Task per phase; reuseTerminal only when the
   * participant's previous dispatch is proven settled.
   */
  const launchAttempt = async (
    ctx: StepCtx,
    p: Participant,
    attempt: PhaseAttempt,
    opts: { isFreshFallback?: boolean } = {},
  ): Promise<LaunchOutcome> => {
    const { state } = ctx;
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

    attempt.status = 'intent_recorded';
    if (opts.isFreshFallback !== true) attempt.createdAt = ctx.now.toISOString();
    emit(ctx, 'launch.intent', {
      attemptId: attempt.attemptId,
      launchIntentId: attempt.launchIntentId,
      phase: attempt.phase,
      round: attempt.round,
      reuseTerminal: reuse,
      freshSessionFallback: freshFallback,
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
        await flush(ctx);
        return { kind: 'task_error', error: task.error };
      }
      attempt.taskId = task.value.taskId;
      emit(ctx, 'task.created', {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        scope: 'task',
      }, { participantId: p.participantId, phase: attempt.phase });
      f = await flush(ctx);
      if (!f.ok) return { kind: 'task_error', error: f.error };
    }

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
      await flush(ctx);
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
      }, { participantId: p.participantId, phase: attempt.phase });
      await flush(ctx);
      return { kind: 'launched' };
    }
    if (res.outcome === 'unknown') {
      attempt.status = 'unknown';
      if (res.requestId !== undefined) attempt.requestId = res.requestId;
      // The worker may have started — charge the possible launch honestly.
      state.consumption.launches += 1;
      emit(ctx, 'worker.unknown', {
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        requestId: res.requestId,
        detail: res.detail,
      }, { participantId: p.participantId, phase: attempt.phase });
      await flush(ctx);
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
    await flush(ctx);
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

  const reject = (ctx: StepCtx, attempt: PhaseAttempt, path: string, issues: unknown): void => {
    ctx.rejectedAttempts.add(attempt.attemptId);
    emit(ctx, 'artifact.rejected', { attemptId: attempt.attemptId, path, issues }, {
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
          reject(ctx, attempt, outPath, raw.reason);
          continue;
        }
        switch (attempt.phase) {
          case 'organiser': {
            const parsed = parseProposedRoster(raw.value, {
              runId: state.runId,
              requestedPerspectives: state.config.requestedPerspectives,
            });
            if (!parsed.ok) {
              reject(ctx, attempt, outPath, parsed.issues);
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
              reject(ctx, attempt, outPath, parsed.issues);
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
              reject(ctx, attempt, outPath, parsed.issues);
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
              reject(ctx, attempt, outPath, parsed.issues);
              break;
            }
            const allowed = await assignedClaimIds(paths.challengeEnv(p.participantId, attempt.round ?? 1));
            const bad = parsed.value.challenges.filter((c) => !allowed.has(c.claimId));
            const ids = parsed.value.challenges.map((c) => c.challengeId);
            const dup = ids.length !== new Set(ids).size;
            if (bad.length > 0 || dup) {
              reject(ctx, attempt, outPath, {
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
              reject(ctx, attempt, outPath, parsed.issues);
              break;
            }
            const allowed = await assignedChallengeIds(paths.responseEnv(p.participantId, attempt.round ?? 1));
            const bad = parsed.value.responses.filter((r) => !allowed.has(r.challengeId));
            if (bad.length > 0) {
              reject(ctx, attempt, outPath, {
                unassignedChallengeIds: bad.map((r) => r.challengeId),
              });
              break;
            }
            admit(ctx, attempt, outPath);
            break;
          }
          case 'scribe_synthesis': {
            const parsed = parseReportFile(raw.value, { runId: state.runId });
            if (!parsed.ok) {
              reject(ctx, attempt, outPath, parsed.issues);
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
        await flush(ctx);
        return blocked(state.status, `run-create failed: ${run.error.message}. The intent is persisted; reconcile before retry.`);
      }
      state.orcaRunId = run.value.runId;
      emit(ctx, 'task.created', { scope: 'run', orcaRunId: run.value.runId });
    }
    const organiser = makeParticipant(ORGANISER_PID, 'organiser', COUNCIL_STAFF_AGENT, null, null);
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
    if (enforceDeadlines(ctx)) {
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
      const active = activeAttempts(ctx.state).length;
      if (active >= ctx.state.config.concurrency) break;
      const lo = await launchAttempt(ctx, p, attempt);
      if (lo.kind === 'launched') {
        launched += 1;
        continue;
      }
      if (lo.kind === 'failed') continue; // seat marked failed; keep launching others
      return { error: launchErrorResult(ctx, lo) };
    }
    return { launched };
  };

  const stepIndependent = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    await reconcileAttempts(ctx);
    if (enforceDeadlines(ctx)) {
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
      await flush(ctx);
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
    const scribe = makeParticipant(SCRIBE_PID, 'scribe', COUNCIL_STAFF_AGENT, null, null);
    state.participants.push(scribe);
    addPlannedAttempt(scribe, 'scribe_notes', null);
    state.status = 'scribe_notes';
    state.phaseEnteredAt = ctx.now.toISOString();
    emit(ctx, 'phase.entered', { status: 'scribe_notes' });
    await flush(ctx);
    return advanceResult('progress', state.status, `independent review closed: ${admittedFindings.length} findings file(s) admitted, ${rejected.length} seat(s) failed`);
  };

  const stepScribeNotes = async (ctx: StepCtx): Promise<StepResult> => {
    const { state } = ctx;
    await reconcileAttempts(ctx);
    if (enforceDeadlines(ctx)) {
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
    if (enforceDeadlines(ctx)) {
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
    emit(ctx, 'claim.updated', { kind: 'responses', round, applied: applied.applied, skipped: applied.skipped.length }, { round });
    return null;
  };

  const enterResponseStage = async (ctx: StepCtx, round: number): Promise<StepResult> => {
    const { state } = ctx;
    const ledger = await readLedger(state);
    if (ledger === null) return { kind: 'error', error: err('invalid_transition', 'claims.json missing at response stage') };

    const admittedChallenges = await admittedFiles<ChallengesFile>(state, 'challenge', round);
    const applied = applyChallengesToLedger(
      ledger,
      admittedChallenges.map((a) => ({ participantId: a.participantId, file: a.file })),
      ctx.now,
    );
    const w = await writeLedger(ctx, ledger);
    if (!w.ok) return { kind: 'error', error: w.error };
    for (const s of applied.skipped) {
      emit(ctx, 'artifact.rejected', { kind: 'challenge', refId: s.refId, reason: s.reason });
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
    if (enforceDeadlines(ctx)) {
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
    // Scribe narrative only — its claims/coverage are never trusted.
    let scribe: ScribeNarrative | undefined;
    const rawReport = await readJson(paths.scribeReportJson);
    if (rawReport.ok) {
      const parsed = parseReportFile(rawReport.value, { runId: state.runId });
      if (parsed.ok) {
        scribe = { summary: parsed.value.summary, limitations: parsed.value.limitations };
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
      runnerLimitations: await runnerLimitations(ctx),
    });
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
    emit(ctx, 'run.finished', { outcome: 'succeeded', partial: report.coverage.partial });
    await releaseRetainedWorkers(ctx);
    const f = await flush(ctx);
    if (!f.ok) return { kind: 'error', error: f.error };
    return advanceResult('finished', state.status, report.coverage.partial ? 'run complete (PARTIAL coverage)' : 'run complete', {
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

  // ── Advance dispatch ───────────────────────────────────────────────────────

  const buildCtx = async (state: CouncilState): Promise<StepCtx> => {
    const ctx: StepCtx = {
      state,
      now: now(),
      events: [],
      artifacts: [],
      rejectedAttempts: new Set(),
      taskCreateFailed: new Set(),
      runCreateUnresolved: false,
    };
    const journal = await store.readJournal();
    if (journal.ok) {
      let runOk = false;
      for (const e of journal.value) {
        if (e.type === 'launch.intent' && e.payload?.scope === 'run') ctx.runCreateUnresolved = true;
        if (e.type === 'task.created' && e.payload?.scope === 'run') runOk = true;
        if (e.type === 'artifact.rejected' && typeof e.payload?.attemptId === 'string') {
          ctx.rejectedAttempts.add(e.payload.attemptId);
        }
        if (e.type === 'error' && e.payload?.op === 'task-create' && typeof e.payload?.attemptId === 'string') {
          ctx.taskCreateFailed.add(e.payload.attemptId);
        }
      }
      if (runOk) ctx.runCreateUnresolved = false;
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
        if (step.kind === 'error') return failRes(step.error);
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
      JSON.stringify([s.seatId, s.perspectiveId, s.participantId, s.agent.agent, s.agent.model, s.agent.effort ?? null, s.agent.permissionMode]);
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
        if (reapproval && !seatsMatchLaunchedReviewers(state, roster)) {
          return failRes(
            err('roster_invalid', 're-approval must reproduce the exact launched seats/agents; start a new run to change the roster'),
          );
        }
        const snapR = await store.readSnapshot();
        if (!snapR.ok) return failRes(snapR.error);
        const binding = buildBinding(state, roster, proposedR.value, snapR.value);
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
        emit(ctx, 'approval.granted', { hash, approver: input.approver, seats: roster.seats.length, reApproval: reapproval });
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
        const to = state.orcaRunId !== null
          ? `run:${state.orcaRunId}`
          : state.supervisor?.terminalHandle;
        if (to !== undefined) {
          const note = await host.sendNotification({
            to,
            subject: `council ${state.runId}: approval granted`,
            body: `Approval ${record.approvalId} bound (hash ${hash.slice(0, 16)}…). Advance the run.`,
            ...(state.supervisor?.dispatchId !== null && state.supervisor?.dispatchId !== undefined
              ? { dispatchId: state.supervisor.dispatchId }
              : {}),
          });
          const mailCtx = await buildCtx(state);
          emit(mailCtx, 'mail.sent', {
            to,
            outcome: note.ok ? note.value.outcome : 'error',
            ...(note.ok && note.value.requestId !== undefined ? { requestId: note.value.requestId } : {}),
            ...(note.ok ? {} : { error: note.error.message }),
            kind: 'approval-wake',
          });
          if (note.ok && note.value.outcome === 'sent') state.consumption.mailSent += 1;
          await flush(mailCtx);
        } else {
          const mailCtx = await buildCtx(state);
          emit(mailCtx, 'mail.sent', { kind: 'approval-wake', outcome: 'skipped', reason: 'no supervisor identity or run bound' });
          await flush(mailCtx);
        }
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
        }
        if (state.status === 'cancelled' && (a.status === 'dispatched' || a.status === 'working')) {
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
            if (!ACTIVE_ATTEMPT.has(a.status) || a.dispatchId === null) continue;
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
