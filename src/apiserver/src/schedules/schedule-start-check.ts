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
import { scheduleRunMode, scheduleRunPermissionMode } from './schedule-access';
import { widenedParts, type AccessLevel, type Envelope } from './schedule-envelope';
import { instantOfLocal, offsetAt, parseRule, ruleCommandHash, runsPerWeek } from './schedule-time';

export type ScheduleHeldReason =
  | 'WORKSPACE_NOT_OWNED'
  | 'WORKSPACE_DELETED'
  | 'WORKSPACE_DISABLED'
  | 'AGENT_MISSING'
  | 'AGENT_DISABLED'
  | 'OUTSIDE_ENVELOPE'
  | 'ACCESS_NOT_ENFORCEABLE'
  | 'MODE_WIDER_THAN_ACCOUNT_DEFAULT'
  | 'NO_REPOSITORY'
  | 'WORKTREE_DISABLED';

/**
 * What a run that passed starts with: its session's mode, and the engine and credential it runs on (null: the
 * workspace's). The mode is the one the claim runs it in (Auto on Claude Code, schedule-access.ts), so the session
 * shows the mode it really runs in.
 */
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
    select: { ownerId: true, deletedAt: true, enabled: true, repoUrl: true, workDirIsGit: true, enableWorktree: true },
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
    commandHash: schedule.envelopeCommandHash,
  };
  const rule = parseRule(schedule.rule);
  const need: Envelope = {
    workspaceId: schedule.workspaceId,
    accessLevel: schedule.accessLevel,
    runsPerWeek: runsPerWeek(rule),
    runLimitMinutes: schedule.runLimitMinutes,
    commandHash: ruleCommandHash(rule),
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

  if (schedule.accessLevel !== 'CHECK_ONLY' && !workspace.repoUrl && workspace.workDirIsGit !== true) {
    return { ok: false, reason: 'NO_REPOSITORY' };
  }
  if (schedule.accessLevel === 'LAND' && !workspace.enableWorktree) {
    return { ok: false, reason: 'WORKTREE_DISABLED' };
  }
  const runMode = scheduleRunPermissionMode(mode, schedule.accessLevel as AccessLevel, judged);
  return { ok: true, plan: { mode: runMode, engine, provider } };
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
 * Whether an automatic slot planned at `plannedAt` is over the envelope's runs per week (§4): the automatic runs (every
 * trigger but MANUAL, SCHEDULE_RUN_AUTOMATIC) that actually started (a session was opened) and were delivered to their
 * engine or are still live (SCHEDULE_RUN_COUNTS_TOWARD_BUDGET), whose own planned slot lies in the 7 days before it,
 * against `envelopeRunsPerWeek`. A Run now never takes an automatic slot's place: the rhythm the owner approved always
 * runs. Windowed on planned slots, not start times, so a start's latency (the worker's pass, a runner back after an
 * outage) never moves a run into or out of the window: the slots of a rule inside its envelope are never closer than
 * the envelope allows, and a rule moved to "a few minutes from now" still gives each run its own slot. A retry of a
 * start that never reached its engine is the same row with `startedAt` cleared (§7.2), so its attempts are one start.
 * Read under the schedule lock the start takes.
 */
export async function scheduleOverBudget(db: Db, schedule: Schedule, plannedAt: Date): Promise<boolean> {
  return (await scheduleBudgetStarts(db, schedule, plannedAt)) >= schedule.envelopeRunsPerWeek;
}

/** The automatic runs that count against the budget for a slot planned at `plannedAt`, as scheduleOverBudget reads them. */
export async function scheduleBudgetStarts(db: Db, schedule: Schedule, plannedAt: Date): Promise<number> {
  return scheduleBudgetCount(db, schedule, plannedAt, SCHEDULE_RUN_AUTOMATIC);
}

/**
 * The Run now presses of sessions and personal access tokens that count against their own budget at `at` (§8.4): the
 * same window and the same delivered-or-live rule, against the same `envelopeRunsPerWeek`, kept apart from the
 * automatic runs. The owner's own presses count toward neither.
 */
export async function scheduleAgentPressStarts(db: Db, schedule: Schedule, at: Date): Promise<number> {
  return scheduleBudgetCount(db, schedule, at, SCHEDULE_RUN_AGENT_PRESS);
}

function scheduleBudgetCount(db: Db, schedule: Schedule, plannedAt: Date, which: Prisma.ScheduleRunWhereInput): Promise<number> {
  return db.scheduleRun.count({
    where: {
      scheduleId: schedule.id,
      ...which,
      ...SCHEDULE_RUN_COUNTS_TOWARD_BUDGET,
      plannedAt: { gt: scheduleBudgetWindowStart(plannedAt, schedule.timezone) },
    },
  });
}

/** A run the rule started: a slot, a catch-up or a condition's firing, never a Run now. */
const SCHEDULE_RUN_AUTOMATIC = { trigger: { not: 'MANUAL' } } as const satisfies Prisma.ScheduleRunWhereInput;

/** A Run now that a session or a personal access token pressed, not the owner. */
const SCHEDULE_RUN_AGENT_PRESS = { trigger: 'MANUAL', byOwner: false } as const satisfies Prisma.ScheduleRunWhereInput;

/**
 * A run that costs budget (§4): it started (a session was opened) and either still holds its place (QUEUED, RUNNING
 * or AWAITING_APPROVAL with a start, so two quick starts cannot overshoot) or its first turn reached the engine
 * (`delivered_at`). A run that ended without ever being delivered (MISSED, CANCELLED or FAILED with
 * RUNNER_UNAVAILABLE, QUOTA or ENGINE_CRASHED_BEFORE_START) did nothing and counts 0.
 */
export const SCHEDULE_RUN_COUNTS_TOWARD_BUDGET = {
  startedAt: { not: null },
  OR: [
    { state: { in: ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'] } },
    { sessions: { some: { turns: { some: { deliveredAt: { not: null } } } } } },
  ],
} as const satisfies Prisma.ScheduleRunWhereInput;

/**
 * A run that started, as the budget counts starts: a session was opened for it, and a retry of a start that never
 * reached its engine cleared `startedAt` again, so its attempts are one start.
 */
export const SCHEDULE_RUN_STARTED = { startedAt: { not: null } } as const satisfies Prisma.ScheduleRunWhereInput;

/**
 * The runs a schedule has started in all (§8.5), counted as the budget counts them, over the schedule's whole life:
 * what a planned end by count (`maxRuns`) is measured against. Read under the schedule lock where it decides a start.
 */
export function scheduleRunsStarted(db: Db, scheduleId: string): Promise<number> {
  return db.scheduleRun.count({ where: { scheduleId, ...SCHEDULE_RUN_STARTED } });
}

/**
 * The SCHEDULE_OVER_BUDGET refusal of a Run now that is not the owner's own press (§8.4): the presses of sessions and
 * tokens that count in the window (scheduleAgentPressStarts), then the number the owner allowed.
 */
export function scheduleOverBudgetMessage(started: number, allowed: number): string {
  return `Run now by a session or a token has started ${started} ${started === 1 ? 'run' : 'runs'} of this schedule in the past 7 days; ` +
    `its owner allowed ${allowed} a week. Only the owner can run it now.`;
}
