// A space's maintenance health (contracts/wiki.contract.json `maintenance.health`, criterion 5): what the
// Wiki home's status line reads — the entries the space holds, and where its maintenance run stands.
// wikiContract.spec.ts holds every constant below to the contract JSON.

import { WIKI_MAINTENANCE_RULES, type WikiCursorOutcome } from './wiki';
import type { WikiMaintenanceHeldReason } from './wikiMaintain';

/**
 * The looks the status line's maintenance part takes, in the order they win: the first that holds is
 * the one the space shows (`wikiMaintenanceLook`).
 */
export const WIKI_MAINTENANCE_LOOKS = ['off', 'failing', 'running', 'behind', 'ok'] as const;
export type WikiMaintenanceLook = (typeof WIKI_MAINTENANCE_LOOKS)[number];

export const WIKI_MAINTENANCE_HEALTH = {
  /** The consecutive failures at which the owner is told, once for the streak (`notify`). */
  notifyAfterFailures: 3,
} as const;

/** A space's maintenance run, as the status line reads it. */
export interface WikiMaintenanceHealth {
  look: WikiMaintenanceLook;
  enabled: boolean;
  /** When a run last succeeded, and when one last reported at all. */
  lastOkAt: string | null;
  lastRunAt: string | null;
  /** Runs reported in a row that did not succeed; a succeeded one sets it back to 0. */
  consecutiveFailures: number;
  /** The facts after the cursor and the oldest of them, counted as the read is made — only while
   *  maintenance is on: a space that is off counts nothing, and reads 0 and null. */
  backlog: number;
  oldestPendingAt: string | null;
  lagSeconds: number;
  /** The space has made `settings.maintenance.dailyRunLimit` maintenance tasks since midnight UTC. */
  dailyLimitReached: boolean;
  /** Why the last fact that found the space due made no task, and when; null once one is made. */
  held: { reason: WikiMaintenanceHeldReason; at: string } | null;
  /** The run under way: started, not ended, its task not ended. */
  running: { sessionId: string | null; startedAt: string } | null;
  /** The run that ended last, and how: what the status line's View run opens. */
  lastRun: { sessionId: string | null; outcome: WikiCursorOutcome | null; endedAt: string } | null;
}

/** `GET /api/wiki/spaces/:id/health`. */
export interface WikiSpaceHealth {
  spaceId: string;
  /** The space's active entries, every one of them — the status line's `N entries`. */
  entries: number;
  maintenance: WikiMaintenanceHealth;
}

/**
 * The look a space's maintenance takes (contract `maintenance.health.look`): off while it is off; failing
 * while the last run reported did not succeed; running while a run is under way; behind while the oldest
 * fact after the cursor is older than `maxPendingAgeHours`; ok otherwise.
 */
export function wikiMaintenanceLook(
  health: Pick<WikiMaintenanceHealth, 'enabled' | 'consecutiveFailures' | 'running' | 'oldestPendingAt'>,
  now: Date,
): WikiMaintenanceLook {
  if (!health.enabled) return 'off';
  if (health.consecutiveFailures > 0) return 'failing';
  if (health.running) return 'running';
  const oldest = health.oldestPendingAt ? Date.parse(health.oldestPendingAt) : Number.NaN;
  if (Number.isFinite(oldest) && now.getTime() - oldest > WIKI_MAINTENANCE_RULES.maxPendingAgeHours * 3_600_000) return 'behind';
  return 'ok';
}
