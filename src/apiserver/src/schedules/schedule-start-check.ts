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
import { parseRule, runsPerWeek } from './schedule-time';

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
      select: { engine: true, provider: true, workspaceId: true },
    });
    if (origin?.engine && origin.workspaceId === schedule.workspaceId) {
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
