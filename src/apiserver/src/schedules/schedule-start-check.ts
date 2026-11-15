/**
 * The checks a run passes before it starts (docs/scheduled-tasks-design.md §6.1). A card is not standing permission
 * for a world that has changed, so each run asks again:
 *
 *   * the owner still owns the workspace, the workspace is not deleted and is enabled;
 *   * the agent, when the schedule names one, exists, is the owner's and is enabled;
 *   * the schedule is inside its envelope;
 *   * its access level has a mode on the engine the run will use (schedule-access.ts), and that mode is no wider
 *     than the account's default mode;
 *   * for OPEN_PR, the workspace still has a repository.
 *
 * The first that fails is the reason the run and its schedule are HELD with. Resuming a HELD schedule runs the same
 * checks first (SchedulesService.resume).
 */
import { PermissionMode } from '@orbit/shared';
import type { Prisma, Schedule } from '@prisma/client';

import { isWiderThanStarter, resolvePermissionMode } from '../common/permission-mode';
import { agentProviderSeed } from '../workspaces/workspace-provider';
import { scheduleRunMode } from './schedule-access';
import { widenedParts, type AccessLevel, type Envelope } from './schedule-envelope';
import { instantOfLocal, offsetAt, parseRule, runsPerWeek } from './schedule-time';

export type ScheduleHeldReason =
  | 'WORKSPACE_NOT_OWNED'
  | 'WORKSPACE_DELETED'
  | 'WORKSPACE_DISABLED'
  | 'AGENT_MISSING'
  | 'AGENT_DISABLED'
  | 'OUTSIDE_ENVELOPE'
  | 'ACCESS_NOT_ENFORCEABLE'
  | 'MODE_WIDER_THAN_ACCOUNT_DEFAULT'
  | 'NO_REPOSITORY';

/** What a run that passed starts with: its mode, and the engine and credential it runs on (null: the workspace's). */
export interface StartPlan {
  mode: PermissionMode;
  engine: string | null;
  provider: string | null;
}

export type StartCheck = { ok: true; plan: StartPlan } | { ok: false; reason: ScheduleHeldReason };

type Db = Prisma.TransactionClient;

/**
 * Where a run runs: on the engine and credential of the session that created the schedule when it is still there,
 * else on what the workspace last ran (the default sessions.create derives itself).
 */
async function engineOf(db: Db, schedule: Schedule): Promise<{ engine: string | null; provider: string | null; judged: string | null }> {
  if (schedule.createdFromSessionId) {
    const origin = await db.session.findUnique({
      where: { id: schedule.createdFromSessionId },
      select: { engine: true, provider: true, workspaceId: true, deletedAt: true },
    });
    // "While that session exists" (§6.1): one moved to Trash no longer decides where the run runs.
    if (origin?.engine && origin.workspaceId === schedule.workspaceId && origin.deletedAt === null) {
      return { engine: origin.engine, provider: origin.provider, judged: origin.engine };
    }
  }
  const seed = await agentProviderSeed(db, schedule.workspaceId);
  return { engine: null, provider: null, judged: seed.engine ?? null };
}

export async function scheduleStartCheck(db: Db, schedule: Schedule): Promise<StartCheck> {
  const workspace = await db.workspace.findUnique({
    where: { id: schedule.workspaceId },
    select: { ownerId: true, deletedAt: true, enabled: true, repoUrl: true, workDirIsGit: true },
  });
  if (!workspace || workspace.ownerId !== schedule.ownerId) return { ok: false, reason: 'WORKSPACE_NOT_OWNED' };
  if (workspace.deletedAt) return { ok: false, reason: 'WORKSPACE_DELETED' };
  if (workspace.enabled === false) return { ok: false, reason: 'WORKSPACE_DISABLED' };

  if (schedule.agentId) {
    const agent = await db.agent.findUnique({
      where: { id: schedule.agentId },
      select: { ownerId: true, deletedAt: true, enabled: true },
    });
    if (!agent || agent.ownerId !== schedule.ownerId || agent.deletedAt) return { ok: false, reason: 'AGENT_MISSING' };
    if (!agent.enabled) return { ok: false, reason: 'AGENT_DISABLED' };
  }

  const envelope: Envelope = {
    workspaceId: schedule.envelopeWorkspaceId,
    accessLevel: schedule.envelopeAccessLevel,
    runsPerWeek: schedule.envelopeRunsPerWeek,
    runLimitMinutes: schedule.envelopeRunLimitMinutes,
  };
  const need: Envelope = {
    workspaceId: schedule.workspaceId,
    accessLevel: schedule.accessLevel,
    runsPerWeek: runsPerWeek(parseRule(schedule.rule)),
    runLimitMinutes: schedule.runLimitMinutes,
  };
  if (widenedParts(envelope, need).length > 0) return { ok: false, reason: 'OUTSIDE_ENVELOPE' };

  const { engine, provider, judged } = await engineOf(db, schedule);
  const mode = scheduleRunMode(schedule.accessLevel as AccessLevel, judged);
  if (!mode) return { ok: false, reason: 'ACCESS_NOT_ENFORCEABLE' };

  const owner = await db.user.findUnique({ where: { id: schedule.ownerId }, select: { preferences: true } });
  const accountMode = resolvePermissionMode(null, owner);
  if (isWiderThanStarter({ mode: accountMode, engine: judged }, mode, judged)) {
    return { ok: false, reason: 'MODE_WIDER_THAN_ACCOUNT_DEFAULT' };
  }

  if (schedule.accessLevel === 'OPEN_PR' && !workspace.repoUrl && workspace.workDirIsGit !== true) {
    return { ok: false, reason: 'NO_REPOSITORY' };
  }
  return { ok: true, plan: { mode, engine, provider } };
}

/** The weekly budget's window: the 7 days before a slot, as the schedule's clock reads them. */
const BUDGET_DAYS_MS = 7 * 24 * 60 * 60_000;

/**
 * Where the budget's window opens for a slot planned at `plannedAt`: the same local wall-clock time 7 days earlier in
 * the schedule's time zone. Not `plannedAt − 7×24 h`: across a daylight-saving change a week of a DAILY rule is 167
 * or 169 hours, and the slot a week back would sit on the wrong side of the edge.
 */
export function scheduleBudgetWindowStart(plannedAt: Date, timezone: string): Date {
  const wall = plannedAt.getTime() + offsetAt(plannedAt.getTime(), timezone);
  return new Date(instantOfLocal(wall - BUDGET_DAYS_MS, timezone));
}

/**
 * Whether a slot planned at `plannedAt` is over the envelope's runs per week (§4): the runs that actually started (a
 * session was opened) whose own planned slot lies in the 7 days before it, of every trigger, against
 * `envelopeRunsPerWeek`. Windowed on planned slots, not start times, so a start's latency (the worker's pass, a runner
 * back after an outage) never moves a run into or out of the window: the slots of a rule inside its envelope are never
 * closer than the envelope allows, and a rule moved to "a few minutes from now" still gives each run its own slot. A
 * MANUAL run's slot is when it was asked for. A retry of a start that never reached its engine is the same row with
 * `startedAt` cleared (§7.2), so its attempts are one start. Read under the schedule lock the start takes.
 */
export async function scheduleOverBudget(db: Db, schedule: Schedule, plannedAt: Date): Promise<boolean> {
  const started = await db.scheduleRun.count({
    where: {
      scheduleId: schedule.id,
      startedAt: { not: null },
      plannedAt: { gt: scheduleBudgetWindowStart(plannedAt, schedule.timezone) },
    },
  });
  return started >= schedule.envelopeRunsPerWeek;
}
