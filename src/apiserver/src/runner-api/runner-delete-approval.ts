import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { toUuid } from '@orbit/shared';

import { refuseManagedRunnerDeletion } from '../managed-runners/managed-runner-delete';
import type { PrismaService } from '../prisma/prisma.service';
import { RUNNER_BEATS, runnerIsOnline, runnerLastBeatAt } from '../runners/runner-presence';

/**
 * The confirmation cards a session deletes one of the account's runners or workspaces through
 * (`orbit runner delete`, `orbit agent delete`, MCP runner_delete / agent_delete), and the server's
 * half of them.
 *
 * Deleting is the account owner's decision, made in the conversation that asks for it: the runner
 * puts a card in front of them and waits, and the delete route (runner-delete.controller.ts) goes
 * through only against that card. Two things make the card worth reading rather than a formality,
 * and both are on this side of the wire:
 *
 *   - WHAT IT SAYS IS THE SERVER'S. The asker sends only the id; the name, whether the machine is
 *     online and which workspaces go with it are read here when the card is filed
 *     ({@link deleteCardInput}). A card whose words came from the caller could name one machine and
 *     carry the id of another.
 *   - THE DELETE NEEDS IT. The route looks for an ALLOWED card that a person answered, filed by the
 *     asking session, about exactly this runner or workspace ({@link requireDeleteApproval}). A
 *     caller that skips the card — a script with the runner token, an engine calling the route
 *     directly — is refused, and so is a card a standing rule allowed: nobody was asked.
 */

/** The tool names the runner files the two cards under. The server matches on them, so both ends spell them alike. */
export const RUNNER_DELETE_APPROVAL_TOOL_NAME = 'orbit_runner_delete';
export const WORKSPACE_DELETE_APPROVAL_TOOL_NAME = 'orbit_agent_delete';

/** Neither card is answered by a workspace's "always allow": each delete is its own question. */
export const DELETE_APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  RUNNER_DELETE_APPROVAL_TOOL_NAME,
  WORKSPACE_DELETE_APPROVAL_TOOL_NAME,
]);

/** The field of each card's input that names what it deletes: the parameter of the MCP tool that raises it. */
const TARGET_FIELD: Readonly<Record<string, string>> = {
  [RUNNER_DELETE_APPROVAL_TOOL_NAME]: 'runnerId',
  [WORKSPACE_DELETE_APPROVAL_TOOL_NAME]: 'agentId',
};

export const DELETE_APPROVAL_REQUIRED = 'DELETE_APPROVAL_REQUIRED';
export const RUNNER_DELETE_SELF = 'RUNNER_DELETE_SELF';
export const WORKSPACE_DELETE_SELF = 'WORKSPACE_DELETE_SELF';

/** A runner as its delete card shows it, and as the delete answers with it. */
export interface RunnerDeleteFacts {
  runnerId: string;
  name: string;
  displayName: string | null;
  online: boolean;
  lastHeartbeatAt: string | null;
  /** The account's workspaces bound to it, which are deleted with it. */
  workspaces: Array<{ id: string; name: string; workDir: string | null }>;
}

/** A workspace as its delete card shows it, and as the delete answers with it. */
export interface WorkspaceDeleteFacts {
  agentId: string;
  name: string;
  workDir: string | null;
  runner: { id: string; name: string; displayName: string | null } | null;
}

type Db = Pick<PrismaService, 'runner' | 'workspace' | 'session' | 'approval' | 'managedRunner'>;

/**
 * The runner `runnerId` names, read for its card or its delete. Not found unless it is the account's,
 * and refused when it is the machine the asking session runs on — deleting it would end that session,
 * and every other session there, partway through the call that asked — or a managed runner, which the
 * delete itself refuses (RunnersService.removeRunner), so that no owner is asked about one.
 */
export async function runnerToDelete(
  prisma: Db,
  caller: { ownerId: string; runnerId: string },
  runnerId: string,
): Promise<RunnerDeleteFacts> {
  const runner = await prisma.runner.findFirst({
    where: { id: runnerId, ownerId: caller.ownerId },
    select: {
      id: true,
      name: true,
      displayName: true,
      status: true,
      ...RUNNER_BEATS,
      workspaces: {
        where: { ownerId: caller.ownerId, deletedAt: null },
        select: { id: true, name: true, workDir: true },
        orderBy: [{ position: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
      },
    },
  });
  if (!runner) throw new NotFoundException('runner not found');
  if (runner.id === caller.runnerId) {
    throw new ConflictException({
      code: RUNNER_DELETE_SELF,
      message: 'this session runs on that runner, and deleting it would end this session and every other one '
        + 'running there. Delete it from a session on another runner, or from the runner\'s page in the Orbit app.',
    });
  }
  await refuseManagedRunnerDeletion(prisma, runner.id);
  return {
    runnerId: runner.id,
    name: runner.name,
    displayName: runner.displayName,
    online: runnerIsOnline(runner, Date.now()),
    lastHeartbeatAt: runnerLastBeatAt(runner)?.toISOString() ?? null,
    workspaces: runner.workspaces,
  };
}

/**
 * The workspace `workspaceId` names, read for its card or its delete. Not found unless it is the
 * account's and not deleted, and refused when it is the workspace the asking session runs in.
 */
export async function workspaceToDelete(
  prisma: Db,
  caller: { ownerId: string; sessionId: string },
  workspaceId: string,
): Promise<WorkspaceDeleteFacts> {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, ownerId: caller.ownerId, deletedAt: null },
    select: { id: true, name: true, workDir: true, runner: { select: { id: true, name: true, displayName: true } } },
  });
  if (!workspace) throw new NotFoundException('workspace not found');
  const asking = await prisma.session.findUnique({ where: { id: caller.sessionId }, select: { workspaceId: true } });
  if (asking?.workspaceId === workspace.id) {
    throw new ConflictException({
      code: WORKSPACE_DELETE_SELF,
      message: 'this session runs in that workspace. Delete it from a session in another workspace, or from its '
        + 'runner\'s page in the Orbit app.',
    });
  }
  return { agentId: workspace.id, name: workspace.name, workDir: workspace.workDir, runner: workspace.runner };
}

/**
 * The input a delete card is stored with — the server's reading of what it deletes — or null for
 * every other card. The caller's input is read for the id alone; a target that is not the account's,
 * or that is the asking session's own, files no card at all, since a yes to it could not be acted on.
 */
export async function deleteCardInput(
  prisma: Db,
  caller: { ownerId: string; runnerId: string; sessionId: string },
  toolName: string,
  input: Record<string, unknown>,
): Promise<RunnerDeleteFacts | WorkspaceDeleteFacts | null> {
  const field = TARGET_FIELD[toolName];
  if (!field) return null;
  const id = targetId(input[field]);
  if (!id) throw new NotFoundException(`${toolName === RUNNER_DELETE_APPROVAL_TOOL_NAME ? 'runner' : 'workspace'} not found`);
  return toolName === RUNNER_DELETE_APPROVAL_TOOL_NAME
    ? runnerToDelete(prisma, caller, id)
    : workspaceToDelete(prisma, caller, id);
}

/**
 * Refuse the delete unless the account owner said yes to it in the asking session: a card filed
 * under `toolName`, ALLOWED, answered by a person (a standing rule's allow has no decider), naming
 * `id`. Newest first, so the card a later reader is pointed at is the one answered last. The card is
 * not consumed — repeating a delete the owner already approved is a retry, and the second one finds
 * nothing left to delete.
 */
export async function requireDeleteApproval(
  prisma: Db,
  sessionId: string,
  toolName: string,
  id: string,
): Promise<string> {
  const field = TARGET_FIELD[toolName];
  const wanted = targetId(id);
  const cards = await prisma.approval.findMany({
    where: { sessionId, toolName, status: 'ALLOWED', decidedById: { not: null } },
    select: { id: true, input: true },
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
  });
  const covering = wanted === null
    ? undefined
    : cards.find((card) => targetId((card.input as Record<string, unknown> | null)?.[field]) === wanted);
  if (covering) return covering.id;
  throw new ForbiddenException({
    code: DELETE_APPROVAL_REQUIRED,
    message: `deleting ${toolName === RUNNER_DELETE_APPROVAL_TOOL_NAME ? 'a runner' : 'a workspace'} needs the account `
      + 'owner\'s yes on a confirmation card in this conversation, and they have not given one for this one. '
      + `Ask through ${toolName === RUNNER_DELETE_APPROVAL_TOOL_NAME ? 'runner_delete (orbit runner delete)' : 'agent_delete (orbit agent delete)'}, `
      + 'which puts the card in front of them; nothing was deleted.',
  });
}

/** An id as a card spells it — base62 or a uuid — as the uuid it names, or null when it names nothing. */
function targetId(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return toUuid(value.trim());
  } catch {
    return null;
  }
}
