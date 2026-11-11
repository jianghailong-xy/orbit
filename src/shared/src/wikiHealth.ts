// A space's maintenance health (contracts/wiki.contract.json `maintenance.health`, criterion 5): what the
// Wiki home's status line reads — the entries the space holds, and where its maintenance run stands.
// wikiContract.spec.ts holds every constant below to the contract JSON.

import { WIKI_MAINTENANCE_RULES, type WikiCursorOutcome } from './wiki';
import type { WikiMaintenanceFailureKind, WikiMaintenanceHeldReason } from './wikiMaintain';
import type { WikiExecutorView } from './wikiJobs';
import type { WikiRepoLook, WikiRepoTier, WikiRepoTierReason } from './wikiRepoOps';
import type { WikiSystemModelStatus } from './wikiSystemModel';

/**
 * The looks the status line's maintenance part takes, in the order they win: the first that holds is
 * the one the space shows (`wikiMaintenanceLook`).
 */
export const WIKI_MAINTENANCE_LOOKS = ['off', 'failing', 'running', 'behind', 'ok'] as const;
export type WikiMaintenanceLook = (typeof WIKI_MAINTENANCE_LOOKS)[number];

export const WIKI_MAINTENANCE_HEALTH = {
  /** The consecutive failures at which the owner is told, once for the streak (`notify`). */
  notifyAfterFailures: 3,
  /**
   * The runs in a row, and the Claude sessions each read at least, with no write to a memory file among them, at which
   * the owner is told, once for the streak: Claude's memory has probably stopped reaching the session's events
   * (docs/wiki-memory-claims-design.md section 8).
   */
  notifyNoNotesAfterRuns: 3,
  notifyNoNotesMinSessions: 20,
  /**
   * The maintenance runs in a row whose repository was read for a red reason (`WIKI_REPO_ATTENTION_REASONS`) at which the
   * owner is told, once for the streak; a run that reads the repository sets the count back to 0
   * (docs/wiki-repo-tiers-design.md §6, `wiki_cursor.repo_attention_runs`).
   */
  notifyRepositoryAfterRuns: 3,
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
  /**
   * The run under way: started, not ended, its task not ended. `jobId` is the server's job that runs it (P8),
   * null for a run of a maintenance session — and absent from a control plane older than P9.
   */
  running: { sessionId: string | null; jobId?: string | null; startedAt: string } | null;
  /** The run that ended last, and how: what the status line's View run opens — its session, or its job's row on Activity. */
  lastRun: { sessionId: string | null; jobId?: string | null; outcome: WikiCursorOutcome | null; endedAt: string } | null;
  /**
   * Of the runs whose latest attempt failed or was truncated, the one that ended last: whose failure it was
   * (`infra` or `content`, contract `maintenance.job.recovery.failureKinds`) and why, so a client can tell
   * the platform failing from the run failing. Null while no run's latest attempt failed.
   */
  lastFailure: { kind: WikiMaintenanceFailureKind; reason: string | null; at: string; sessionId: string | null; jobId?: string | null } | null;
}

/**
 * What the space's repository steps depend on (contract `maintenance.health.repo`, design §2.2): the steps
 * run on the server, which holds no repository, so they ask the machine the space's workspace runs on — and
 * this is whether that machine can be asked. `look` is the one word the status line needs:
 *
 *   ready            the workspace's runner is there, beating, and reads whole files (`wiki-repo-op-read/v1`);
 *   no_workspace     the space names no workspace, or the one it names is gone or has no working directory;
 *   runner_missing   the workspace is not bound to a machine;
 *   runner_offline   the machine is not beating;
 *   runner_upgrade   the machine is beating but has to be upgraded: without `wiki-repo-op/v1` it cannot be
 *                    handed repository work at all, and with only that (no `wiki-repo-op-read/v1`) it reads the
 *                    old bounded window instead of whole files — the steps still run, cut short. The wire
 *                    carries the one word; which of the two it is, the server reads for itself.
 */
export interface WikiSpaceRepoHealth {
  look: WikiRepoLook;
  workspace: { id: string; workDir: string | null } | null;
  runner: { id: string; name: string; version: string | null; capability: boolean; online: boolean } | null;
  /** The space's repository operations that have not settled — what a reader is waiting on. */
  pending: number;
  /**
   * What the latest maintenance run read of the repository (docs/wiki-repo-tiers-design.md §7.1): `git`, `folder`,
   * `sessions` or `wrong_repository`, null while no run has read it. Absent from a control plane older than that.
   */
  tier?: WikiRepoTier | null;
  /** Why it read less than git (contract `repoOps.reasons`); null on `git` and `folder`. */
  reason?: WikiRepoTierReason | null;
  /**
   * That reason as one English sentence, redacted (`~/work/app was not found on MacBook`), and on `folder` what the
   * folder is (`~/work/app is not a git checkout`, the hint after `Commit anchors are not checked:`); null on `git`.
   */
  detail?: string | null;
  /** When the run read it. */
  checkedAt?: string | null;
}

/** `GET /api/wiki/spaces/:id/health`. */
export interface WikiSpaceHealth {
  spaceId: string;
  /** The space's active entries, every one of them — the status line's `N entries`. */
  entries: number;
  maintenance: WikiMaintenanceHealth;
  /**
   * The repository half of the status line (P2). Absent from a control plane older than that phase, which
   * is the only reason a client sees it missing: this build always fills it, and a space whose steps need
   * no repository reads `ready` with no pending work.
   */
  repo?: WikiSpaceRepoHealth;
  /**
   * Whether the server executes this account's wiki (contract `jobs.executor.read`, P9), and the System model it
   * calls while it does — `GET /api/wiki/system-model`'s state, null under runner. Both are what the status line's
   * server reasons are said from; absent from a control plane older than P9, which reads as runner.
   */
  executor?: WikiExecutorView;
  systemModel?: WikiSystemModelStatus | null;
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
