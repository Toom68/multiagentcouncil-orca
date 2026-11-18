/**
 * Deterministic final-report construction and rendering.
 *
 * The runner owns canonical truth: claims come from the ledger, coverage is
 * computed from participant/attempt state — never from the scribe's claims.
 * The scribe may contribute only its validated narrative (summary text and
 * limitation notes). A wholly failed run produces no report at all; partial
 * coverage is always visibly marked.
 */

import {
  SCHEMA_VERSION,
  type ApprovedRoster,
  type Claim,
  type ClaimLedger,
  type CouncilConfig,
  type CouncilReport,
  type CouncilRunId,
  type Evidence,
  type Participant,
  type PerspectiveId,
  type PhaseKind,
  type ProposedRoster,
  type ReportCoverage,
  type SeatOutcome,
} from './contracts.js';
import { orderedClaims, severityRank, gradeRank } from './claims.js';

// ─── Seat outcomes and coverage ──────────────────────────────────────────────

/** Phases a reviewer can complete (organiser/scribe roles are not seats). */
const REVIEWER_PHASES: readonly PhaseKind[] = [
  'independent_review',
  'challenge',
  'author_response',
];

function attemptWasAdmitted(p: Participant, phase: PhaseKind): boolean {
  return p.attempts.some((a) => a.phase === phase && a.artifacts.length > 0);
}

function lastAttempt(p: Participant, phase: PhaseKind) {
  const list = p.attempts.filter((a) => a.phase === phase);
  return list.length === 0 ? undefined : list[list.length - 1];
}

/**
 * Derive a seat's outcome from its attempts.
 * - completed: independent findings were admitted and nothing is left in an
 *   unresolved (unknown/still-active) state.
 * - partial:   findings admitted but a later phase failed/was timed out.
 * - failed:    findings never admitted (settled failure, rejection, unknown).
 * - timed_out: the independent attempt hit its deadline.
 * - not_launched: no independent attempt ever reached the host.
 */
export function seatOutcomeOf(p: Participant): SeatOutcome {
  const phasesCompleted = REVIEWER_PHASES.filter((ph) => attemptWasAdmitted(p, ph));
  const base = {
    participantId: p.participantId,
    perspectiveId: p.perspectiveId ?? 'unknown',
    seatId: p.seatId ?? 'unknown',
    phasesCompleted,
  };
  const independent = lastAttempt(p, 'independent_review');
  if (independent === undefined || independent.status === 'planned' || independent.status === 'intent_recorded') {
    return { ...base, outcome: 'not_launched', detail: 'independent phase never launched' };
  }
  if (independent.status === 'timed_out' || p.status === 'timed_out') {
    return { ...base, outcome: 'timed_out', detail: 'independent phase deadline exceeded' };
  }
  const findingsAdmitted = attemptWasAdmitted(p, 'independent_review');
  if (!findingsAdmitted) {
    const detail =
      independent.status === 'unknown'
        ? 'launch outcome unknown; no admitted output'
        : independent.status === 'settled_failed'
          ? 'worker task failed'
          : 'output missing or rejected';
    return { ...base, outcome: 'failed', detail };
  }
  const unresolved = p.attempts.some(
    (a) =>
      a.status === 'unknown' ||
      a.status === 'dispatched' ||
      a.status === 'working' ||
      a.status === 'intent_recorded',
  );
  const laterFailed = p.attempts.some(
    (a) => a.phase !== 'independent_review' && (a.status === 'settled_failed' || a.status === 'timed_out'),
  );
  if (unresolved) {
    return { ...base, outcome: 'partial', detail: 'admitted findings but left unresolved attempts' };
  }
  if (laterFailed) {
    return { ...base, outcome: 'partial', detail: 'admitted findings; a later phase failed' };
  }
  return { ...base, outcome: 'completed' };
}

/**
 * Coverage for the report: seat-by-seat outcomes, uncovered perspectives
 * (proposed but no completed seat, including unselected ones), and the
 * visible `partial` flag.
 */
export function buildCoverage(input: {
  config: CouncilConfig;
  proposed: ProposedRoster;
  approved: ApprovedRoster;
  participants: Participant[];
}): ReportCoverage {
  const { config, proposed, approved, participants } = input;
  const byId = new Map(participants.map((p) => [p.participantId, p]));
  const seats: SeatOutcome[] = approved.seats.map((seat) => {
    const p = byId.get(seat.participantId);
    if (p === undefined) {
      return {
        participantId: seat.participantId,
        perspectiveId: seat.perspectiveId,
        seatId: seat.seatId,
        outcome: 'not_launched' as const,
        phasesCompleted: [],
        detail: 'participant record missing',
      };
    }
    return seatOutcomeOf(p);
  });
  const coveredPerspectives = new Set(
    seats.filter((s) => s.outcome === 'completed').map((s) => s.perspectiveId),
  );
  const uncoveredPerspectiveIds: PerspectiveId[] = proposed.perspectives
    .map((p) => p.perspectiveId)
    .filter((id) => !coveredPerspectives.has(id))
    .sort();
  const partial = seats.some((s) => s.outcome !== 'completed');
  return {
    requestedPerspectives: config.requestedPerspectives,
    proposedPerspectives: proposed.perspectives.length,
    selectedSeats: approved.seats.length,
    seats,
    uncoveredPerspectiveIds,
    partial,
  };
}

// ─── Canonical report assembly ───────────────────────────────────────────────

export interface ScribeNarrative {
  /** Validated scribe-authored summary text. Claims/coverage are ignored. */
  summary?: string;
  limitations?: string[];
}

function deterministicSummary(report: Pick<CouncilReport, 'claims' | 'coverage'>): string {
  const total = report.claims.length;
  const byStatus = new Map<string, number>();
  for (const c of report.claims) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  const completed = report.coverage.seats.filter((s) => s.outcome === 'completed').length;
  const parts = [
    `Council review: ${total} canonical claim${total === 1 ? '' : '' !== '' ? 's' : ''}`,
    `across ${completed}/${report.coverage.selectedSeats} completed seats`,
  ];
  const statusBits = [...byStatus.entries()].sort().map(([k, v]) => `${k}: ${v}`);
  if (statusBits.length > 0) parts.push(`(${statusBits.join(', ')})`);
  if (report.coverage.partial) parts.push('— PARTIAL COVERAGE');
  return parts.join(' ');
}

/**
 * Assemble the runner-canonical report. Claims come from the ledger only;
 * the scribe supplies narrative text when its artifact validated.
 */
export function buildCouncilReport(input: {
  runId: CouncilRunId;
  generatedAt: string;
  config: CouncilConfig;
  proposed: ProposedRoster;
  approved: ApprovedRoster;
  participants: Participant[];
  ledger: ClaimLedger;
  scribe?: ScribeNarrative;
  runnerLimitations: string[];
}): CouncilReport {
  const coverage = buildCoverage(input);
  const claims = orderedClaims(input.ledger);
  const limitations: string[] = [];
  const seen = new Set<string>();
  for (const l of [...input.runnerLimitations, ...(input.scribe?.limitations ?? [])]) {
    const t = l.trim();
    if (t.length === 0 || seen.has(t) || limitations.length >= 20) continue;
    seen.add(t);
    limitations.push(t.length > 1000 ? t.slice(0, 999) + '…' : t);
  }
  const partial: Pick<CouncilReport, 'claims' | 'coverage'> = { claims, coverage };
  const summary =
    input.scribe?.summary !== undefined && input.scribe.summary.trim().length > 0
      ? input.scribe.summary
      : deterministicSummary(partial);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    generatedAt: input.generatedAt,
    summary,
    coverage,
    claims,
    limitations,
  };
}

// ─── Deterministic markdown rendering ────────────────────────────────────────

function fmtEvidence(ev: Evidence, lines: string[]): void {
  let line = `- **${ev.kind}** — ${ev.note}`;
  if (ev.path !== undefined) {
    line += ` (\`${ev.path}\``;
    if (ev.startLine !== undefined) {
      line += `:${ev.startLine}`;
      if (ev.endLine !== undefined && ev.endLine !== ev.startLine) line += `-${ev.endLine}`;
    }
    line += ')';
  }
  lines.push(line);
  if (ev.snippet !== undefined) lines.push(`  > ${ev.snippet}`);
  if (ev.steps !== undefined) lines.push(`  - steps: ${ev.steps}`);
  if (ev.observed !== undefined) lines.push(`  - observed: ${ev.observed}`);
}

function renderClaim(c: Claim, lines: string[]): void {
  lines.push(
    `### ${c.claimId}: ${c.title}`,
    '',
    `- kind: ${c.kind} | severity: ${c.severity} | grade: ${c.grade} | status: ${c.status} | confidence: ${c.confidence}`,
    `- source findings: ${c.sourceFindings.map((f) => `${f.participantId}/${f.findingId}`).join(', ')}`,
    '',
  );
  if (c.evidence.length > 0) {
    lines.push('Evidence:');
    for (const ev of c.evidence) fmtEvidence(ev, lines);
    lines.push('');
  }
  if (c.counterEvidence.length > 0) {
    lines.push('Counter-evidence:');
    for (const ev of c.counterEvidence) fmtEvidence(ev, lines);
    lines.push('');
  }
  if (c.dissent.length > 0) {
    lines.push('Dissent:');
    for (const d of c.dissent) {
      lines.push(`- ${d.participantId}${d.round !== null ? ` (round ${d.round})` : ''}: ${d.position}`);
    }
    lines.push('');
  }
  if (c.history.length > 0) {
    lines.push('History:');
    for (const h of c.history) {
      const ref = h.refId !== undefined ? ` [${h.refId}]` : '';
      const det = h.detail !== undefined ? ` — ${h.detail}` : '';
      lines.push(`- ${h.ts} ${h.actor} ${h.type}${ref}${det}`);
    }
    lines.push('');
  }
}

/** Render the canonical report deterministically — same input, same bytes. */
export function renderReportMarkdown(report: CouncilReport): string {
  const lines: string[] = [
    `# Council report — ${report.runId}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    report.summary,
    '',
    '## Coverage',
    '',
    `- requested perspectives: ${report.coverage.requestedPerspectives}`,
    `- proposed perspectives: ${report.coverage.proposedPerspectives}`,
    `- selected seats: ${report.coverage.selectedSeats}`,
    `- **partial coverage: ${report.coverage.partial ? 'YES' : 'no'}**`,
    '',
    '| seat | perspective | participant | outcome | phases completed | detail |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of report.coverage.seats) {
    lines.push(
      `| ${s.seatId} | ${s.perspectiveId} | ${s.participantId} | ${s.outcome} | ${s.phasesCompleted.join(',') || '—'} | ${s.detail ?? ''} |`,
    );
  }
  lines.push('');
  if (report.coverage.uncoveredPerspectiveIds.length > 0) {
    lines.push(
      `Uncovered perspectives: ${report.coverage.uncoveredPerspectiveIds.join(', ')}`,
      '',
    );
  }
  lines.push('## Claims', '');
  if (report.claims.length === 0) lines.push('No claims were admitted.', '');
  const sorted = [...report.claims].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      gradeRank(b.grade) - gradeRank(a.grade) ||
      a.claimId.localeCompare(b.claimId),
  );
  for (const c of sorted) renderClaim(c, lines);
  if (report.limitations.length > 0) {
    lines.push('## Limitations', '');
    for (const l of report.limitations) lines.push(`- ${l}`);
    lines.push('');
  }
  lines.push('---', 'Machine-readable form: `report.json` (CouncilReport).', '');
  return lines.join('\n');
}

/** Short fallback summary.md when no scribe narrative was admitted. */
export function renderSummaryMarkdown(report: CouncilReport): string {
  const completed = report.coverage.seats.filter((s) => s.outcome === 'completed').length;
  const lines = [
    `# Council summary — ${report.runId}`,
    '',
    report.summary,
    '',
    `- ${report.claims.length} claims; ${completed}/${report.coverage.selectedSeats} seats completed`,
    `- partial coverage: ${report.coverage.partial ? 'YES' : 'no'}`,
  ];
  if (report.coverage.uncoveredPerspectiveIds.length > 0) {
    lines.push(`- uncovered perspectives: ${report.coverage.uncoveredPerspectiveIds.join(', ')}`);
  }
  const top = [...report.claims]
    .filter((c) => c.status !== 'withdrawn')
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.claimId.localeCompare(b.claimId))
    .slice(0, 10);
  if (top.length > 0) {
    lines.push('', 'Top claims:');
    for (const c of top) lines.push(`- [${c.severity}/${c.grade}/${c.status}] ${c.title}`);
  }
  lines.push('');
  return lines.join('\n');
}
