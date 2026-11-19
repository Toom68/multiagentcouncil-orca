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
  type LimitationSource,
  type Participant,
  type PerspectiveId,
  type PhaseKind,
  type ProposedRoster,
  type ReportCoverage,
  type RunnerFacts,
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

/** Honest English plural: `1 claim`, `2 claims`, `3 disputed claims`. */
function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

function deterministicSummary(report: Pick<CouncilReport, 'claims' | 'coverage'>): string {
  const total = report.claims.length;
  const byStatus = new Map<string, number>();
  for (const c of report.claims) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  const completed = report.coverage.seats.filter((s) => s.outcome === 'completed').length;
  const parts = [
    `Council review: ${plural(total, 'canonical claim')}`,
    `across ${completed}/${report.coverage.selectedSeats} completed seats`,
  ];
  const statusBits = [...byStatus.entries()].sort().map(([k, v]) => `${k}: ${v}`);
  if (statusBits.length > 0) parts.push(`(${statusBits.join(', ')})`);
  const disputed = report.claims.filter((c) => c.dissent.length > 0).length;
  if (disputed > 0) parts.push(`— ${plural(disputed, 'disputed claim')}`);
  if (report.coverage.partial) parts.push('— PARTIAL COVERAGE');
  return parts.join(' ');
}

/**
 * Deterministic, runner-computed facts for the report — the numbers a
 * scribe's prose can never obscure: coverage, status counts, unresolved
 * disputes, and where the narrative summary came from.
 */
export function buildRunnerFacts(
  coverage: ReportCoverage,
  claims: Claim[],
  summarySource: 'scribe' | 'runner',
): RunnerFacts {
  const byStatus: Record<string, number> = {};
  for (const c of claims) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
  return {
    seatsCompleted: coverage.seats.filter((s) => s.outcome === 'completed').length,
    seatsSelected: coverage.selectedSeats,
    partialCoverage: coverage.partial,
    uncoveredPerspectiveIds: coverage.uncoveredPerspectiveIds,
    summarySource,
    claims: {
      total: claims.length,
      byStatus,
      withDissent: claims.filter((c) => c.dissent.length > 0).map((c) => c.claimId),
      withdrawn: byStatus['withdrawn'] ?? 0,
      escalated: byStatus['escalated'] ?? 0,
    },
  };
}

/**
 * Assemble the runner-canonical report. Claims come from the ledger only;
 * the scribe supplies narrative text when its artifact validated. Runner
 * facts disclose coverage and disputes deterministically, and limitations
 * keep their origin (runner-derived vs scribe-authored) in emission order.
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
  const limitationSources: LimitationSource[] = [];
  const seen = new Set<string>();
  const pushLimitation = (origin: 'runner' | 'scribe', text: string): void => {
    const t = text.trim();
    if (t.length === 0 || seen.has(t) || limitations.length >= 20) return;
    seen.add(t);
    limitations.push(t.length > 1000 ? t.slice(0, 999) + '…' : t);
    limitationSources.push({ origin, text: t.length > 1000 ? t.slice(0, 999) + '…' : t });
  };
  for (const l of input.runnerLimitations) pushLimitation('runner', l);
  for (const l of input.scribe?.limitations ?? []) pushLimitation('scribe', l);
  const partial: Pick<CouncilReport, 'claims' | 'coverage'> = { claims, coverage };
  const scribeSummary = input.scribe?.summary;
  const scribeSummaryUsable = scribeSummary !== undefined && scribeSummary.trim().length > 0;
  const summary = scribeSummaryUsable ? scribeSummary : deterministicSummary(partial);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    generatedAt: input.generatedAt,
    summary,
    coverage,
    claims,
    limitations,
    runnerFacts: buildRunnerFacts(coverage, claims, scribeSummaryUsable ? 'scribe' : 'runner'),
    limitationSources,
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
  );
  if (c.mergedTitles !== undefined && c.mergedTitles.length > 0) {
    lines.push(`- merged titles: ${c.mergedTitles.map((t) => `“${t}”`).join(', ')}`);
  }
  if (c.assessments !== undefined && c.assessments.length > 1) {
    lines.push(
      `- author assessments: ${c.assessments
        .map((a) => `${a.participantId} → ${a.severity} @ ${a.confidence}`)
        .join(', ')}`,
    );
  }
  lines.push('');
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
  if (c.remedies !== undefined && c.remedies.length > 0) {
    lines.push('Remedies:');
    for (const r of c.remedies) lines.push(`- ${r}`);
    lines.push('');
  }
  if (c.openQuestions !== undefined && c.openQuestions.length > 0) {
    lines.push('Open questions:');
    for (const q of c.openQuestions) lines.push(`- ${q}`);
    lines.push('');
  }
  if (c.dissent.length > 0) {
    lines.push('Dissent:');
    for (const d of c.dissent) {
      lines.push(`- ${d.participantId}${d.round !== null ? ` (round ${d.round})` : ''}: ${d.position}`);
      if (d.evidence !== undefined) for (const ev of d.evidence) fmtEvidence(ev, lines);
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

/** Render the deterministic facts block — always present, never prose. */
function renderRunnerFacts(report: CouncilReport, lines: string[]): void {
  const rf = report.runnerFacts;
  if (rf === undefined) {
    // Legacy report shape: derive the same facts from coverage + claims so
    // even old artifacts render honest numbers.
    const disputed = report.claims.filter((c) => c.dissent.length > 0);
    lines.push(
      '## Runner facts',
      '',
      `- seats completed: ${report.coverage.seats.filter((s) => s.outcome === 'completed').length}/${report.coverage.selectedSeats}`,
      `- partial coverage: ${report.coverage.partial ? 'YES' : 'no'}`,
      `- claims: ${plural(report.claims.length, 'claim')}; ${plural(disputed.length, 'disputed claim')}`,
      `- narrative summary source: unknown (pre-repair artifact)`,
      '',
    );
    return;
  }
  lines.push(
    '## Runner facts',
    '',
    `- seats completed: ${rf.seatsCompleted}/${rf.seatsSelected}`,
    `- **partial coverage: ${rf.partialCoverage ? 'YES' : 'no'}**`,
    `- narrative summary: ${rf.summarySource === 'scribe' ? 'scribe-authored' : 'deterministic runner fallback'}`,
    `- claims: ${plural(rf.claims.total, 'claim')}`,
  );
  const statusBits = Object.entries(rf.claims.byStatus).sort().map(([k, v]) => `${k}: ${v}`);
  if (statusBits.length > 0) lines.push(`- status counts: ${statusBits.join(', ')}`);
  if (rf.claims.withDissent.length > 0) {
    lines.push(`- **${plural(rf.claims.withDissent.length, 'claim')} with unresolved dissent: ${rf.claims.withDissent.join(', ')}**`);
  }
  if (rf.claims.withdrawn > 0) lines.push(`- withdrawn: ${rf.claims.withdrawn}`);
  if (rf.claims.escalated > 0) lines.push(`- escalated to orchestrator: ${rf.claims.escalated}`);
  if (rf.uncoveredPerspectiveIds.length > 0) {
    lines.push(`- **uncovered perspectives: ${rf.uncoveredPerspectiveIds.join(', ')}**`);
  }
  lines.push('');
}

/** Label a report's narrative by who authored it — never implied. */
function summaryLabel(report: CouncilReport): string {
  if (report.runnerFacts === undefined) return 'unattributed — pre-repair artifact';
  return report.runnerFacts.summarySource === 'scribe'
    ? 'scribe-authored'
    : 'deterministic runner fallback';
}

/** Render the canonical report deterministically — same input, same bytes. */
export function renderReportMarkdown(report: CouncilReport): string {
  const lines: string[] = [
    `# Council report — ${report.runId}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
  ];
  // Deterministic runner facts lead: coverage and disputes are verified
  // numbers and must not sit beneath unverified authored prose.
  renderRunnerFacts(report, lines);
  lines.push(`## Narrative summary — ${summaryLabel(report)}`, '', report.summary, '');
  lines.push(
    '## Coverage',
    '',
    `- requested perspectives: ${report.coverage.requestedPerspectives}`,
    `- proposed perspectives: ${report.coverage.proposedPerspectives}`,
    `- selected seats: ${report.coverage.selectedSeats}`,
    `- **partial coverage: ${report.coverage.partial ? 'YES' : 'no'}**`,
    '',
    '| seat | perspective | participant | outcome | phases completed | detail |',
    '| --- | --- | --- | --- | --- | --- |',
  );
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
  if (report.limitationSources !== undefined && report.limitationSources.length > 0) {
    lines.push('## Limitations', '');
    for (const l of report.limitationSources) lines.push(`- [${l.origin}] ${l.text}`);
    lines.push('');
  } else if (report.limitations.length > 0) {
    lines.push('## Limitations', '');
    for (const l of report.limitations) lines.push(`- ${l}`);
    lines.push('');
  }
  lines.push('---', 'Machine-readable form: `report.json` (CouncilReport).', '');
  return lines.join('\n');
}

/**
 * Short fallback summary.md when no scribe narrative was admitted. Verified
 * facts lead; the narrative text carries an explicit authorship label.
 */
export function renderSummaryMarkdown(report: CouncilReport): string {
  const completed = report.coverage.seats.filter((s) => s.outcome === 'completed').length;
  const disputed = report.claims.filter((c) => c.dissent.length > 0).length;
  const lines = [
    `# Council summary — ${report.runId}`,
    '',
    `- ${plural(report.claims.length, 'claim')}; ${completed}/${report.coverage.selectedSeats} seats completed`,
    `- partial coverage: ${report.coverage.partial ? 'YES' : 'no'}`,
    `- ${plural(disputed, 'disputed claim')}`,
  ];
  if (report.coverage.uncoveredPerspectiveIds.length > 0) {
    lines.push(`- uncovered perspectives: ${report.coverage.uncoveredPerspectiveIds.join(', ')}`);
  }
  lines.push('', `Narrative summary (${summaryLabel(report)}):`, '', report.summary, '');
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
