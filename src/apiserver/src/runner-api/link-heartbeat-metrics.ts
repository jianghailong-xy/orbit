import type { HeartbeatFactKind, LinkReconcileReason } from './link-heartbeat';

/**
 * What each link heartbeat ended in, served at GET /api/metrics (docs/self-hosting.md, "Monitoring").
 *
 *   orbit_link_heartbeat_outcomes_total{outcome}        one per beat: quiet, report or full.
 *   orbit_link_heartbeat_reports_total{kind}            each fact kind a REPORT beat wrote.
 *   orbit_link_heartbeat_full_reconciles_total{reason}  why a full beat reconciled: the verdict's reason, `managed`
 *                                                       (a managed runner always does) or `report_unwritable` (a
 *                                                       report one statement could not write).
 *
 * Labels come from the closed sets below, never from a row or a beat.
 */

export const LINK_HEARTBEAT_OUTCOMES = ['quiet', 'report', 'full'] as const;
export const LINK_FULL_REASONS = ['no_record', 'lease', 'changed', 'inputs', 'period', 'managed', 'report_unwritable'] as const;

export type LinkHeartbeatOutcome = (typeof LINK_HEARTBEAT_OUTCOMES)[number];
export type LinkFullReason = (typeof LINK_FULL_REASONS)[number];

const outcomes = new Map<string, number>();
const reports = new Map<string, number>();
const fulls = new Map<string, number>();

function bump(target: Map<string, number>, key: string): void {
  target.set(key, (target.get(key) ?? 0) + 1);
}

/** `reason` as its label: the verdict's reasons in lower case; the two this file adds are named as they are. */
export function linkFullReasonLabel(reason: LinkReconcileReason | 'MANAGED' | 'REPORT_UNWRITABLE'): LinkFullReason {
  const label = reason.toLowerCase();
  return (LINK_FULL_REASONS as readonly string[]).includes(label) ? (label as LinkFullReason) : 'inputs';
}

export function countLinkHeartbeatQuiet(): void {
  bump(outcomes, 'quiet');
}

/** A beat answered after its changed reports were written, one count per kind. */
export function countLinkHeartbeatReport(kinds: readonly HeartbeatFactKind[]): void {
  bump(outcomes, 'report');
  for (const kind of kinds) bump(reports, kind);
}

export function countLinkHeartbeatFull(reason: LinkReconcileReason | 'MANAGED' | 'REPORT_UNWRITABLE'): void {
  bump(outcomes, 'full');
  bump(fulls, linkFullReasonLabel(reason));
}

function render(name: string, help: string, label: string, preset: readonly string[], values: Map<string, number>): string[] {
  const keys = [...new Set([...preset, ...values.keys()])];
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} counter`,
    ...keys.map((key) => `${name}{${label}="${key}"} ${values.get(key) ?? 0}`),
  ];
}

export function renderLinkHeartbeatMetrics(): string {
  return `${[
    ...render('orbit_link_heartbeat_outcomes_total', 'Link heartbeats by how they were answered: quiet, report (changed facts written) or full (reconciled in full).', 'outcome', LINK_HEARTBEAT_OUTCOMES, outcomes),
    ...render('orbit_link_heartbeat_reports_total', 'Fact kinds written by report beats.', 'kind', [], reports),
    ...render('orbit_link_heartbeat_full_reconciles_total', 'Full link heartbeats by why they reconciled: no_record, lease, changed, inputs, period, managed, report_unwritable.', 'reason', LINK_FULL_REASONS, fulls),
  ].join('\n')}\n`;
}

/** Empty every counter. For tests. */
export function resetLinkHeartbeatMetrics(): void {
  outcomes.clear();
  reports.clear();
  fulls.clear();
}
