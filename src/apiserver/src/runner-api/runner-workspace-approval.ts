import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { toUuid } from '@orbit/shared';
import { createHash, randomBytes } from 'node:crypto';

import { orchestrationEnabled } from '../common/orchestration-switch';
import type { PrismaService } from '../prisma/prisma.service';
import { canonicalJson } from '../projects/canonical-json';
import {
  WORKSPACE_CREATE_APPROVAL_TOOL_NAME,
  WORKSPACE_UPDATE_APPROVAL_TOOL_NAME,
} from '../sessions/workspace-write-card-values';
import type { OrchestratorWorkspaceInput } from './runner-agents.controller';

/**
 * What a session may write about a workspace (`agent_create`, `agent_update`, `orbit agent create`,
 * `orbit agent update`), and the account owner's confirmation card over the part of it that decides
 * what the workspace's next session runs and where.
 *
 * A session's write to these fields outlives it and lands on every later session of that workspace,
 * whoever opens it and in whatever mode, and the engine starts under them before any tool call. So
 * no permission mode contains it, and Auto and Bypass ask like every other mode. The runner puts a
 * card in front of the owner and waits; the routes (runner-agents.controller.ts) write only against
 * that card. A request with no session is refused before this, as it always was, and the owner's own
 * clients write through WorkspacesController, which has no session to ask in. The rest of a workspace
 * — its name, its description, the branch its merges default to — is written as before.
 *
 * As for the delete cards (runner-delete-approval.ts), what the card says is the server's: it reads
 * the workspace and the runners by id, and the caller's fields pass the write's own whitelist
 * (`sanitizeWorkspaceWrite`, which the card's caller applies).
 * Beyond the delete cards, two things follow from a write being repeatable where a delete is not:
 *
 *   - THE YES COVERS ONE WRITE, EXACTLY. The card holds a salted digest of everything the write would
 *     send, name and description included, and a write of anything else finds no card.
 *   - IT IS SPENT BY THAT WRITE. A later replay would silently undo whatever the owner has changed
 *     since. A response lost on its way back costs a second question, never a second write.
 *
 * How the card holds a variable's value: sessions/workspace-write-card-values.ts.
 */

/**
 * The fields a session writes only on the owner's card, on the mention: restating a value asks too,
 * since a write that passed without a card when its env matched would tell a session what is stored.
 *
 *   - env, systemPrompt, appendSystemPrompt: what the next session's engine starts under.
 *   - workDir, runnerId: the folder and the machine it runs in.
 *   - enableWorktree: whether it gets a checkout of its own or runs in the shared folder.
 *
 * `defaultMergeTarget` is not one. A session's checkout forks from the folder's HEAD and never from
 * this branch (worktree.go `setupWorktree`); it names where a merge goes when none is named and what
 * "already merged" is judged against, and a session can name any target in its own merge anyway.
 * Neither `name` nor `description` reaches an engine.
 */
export const WORKSPACE_WRITE_CARD_FIELDS = [
  'env',
  'workDir',
  'systemPrompt',
  'appendSystemPrompt',
  'runnerId',
  'enableWorktree',
] as const;

export const WORKSPACE_WRITE_APPROVAL_REQUIRED = 'WORKSPACE_WRITE_APPROVAL_REQUIRED';

interface RunnerFacts {
  id: string;
  name: string;
  displayName: string | null;
}

/** What the owner reads, and what the write is matched against. */
export interface WorkspaceWriteCard {
  /** The workspace it changes; null on a create. */
  agentId: string | null;
  /** Its name as it stands, or the name of the new one. */
  name: string;
  /** Its folder as it stands; null on a create. */
  workDir: string | null;
  /** The runner it is on as it stands, or the one a new workspace goes on. */
  runner: RunnerFacts | null;
  /** The write, field by field, with `runnerId` read into the runner it names. */
  changes: Omit<OrchestratorWorkspaceInput, 'runnerId'> & { runner?: RunnerFacts };
  /** The variables on the workspace that a write of `env`, which replaces the whole map, takes away. */
  envRemoved: string[];
  writeSalt: string;
  writeDigest: string;
}

type Db = Pick<PrismaService, 'workspace' | 'runner' | 'approval' | 'user'>;

/** Whether a write names a field that needs the owner's card. */
export function namesWorkspaceCardField(write: OrchestratorWorkspaceInput): boolean {
  return WORKSPACE_WRITE_CARD_FIELDS.some((field) => write[field] !== undefined);
}

/** A write as one comparable string: which workspace, and exactly these fields, whatever their order. */
export function workspaceWriteDigest(salt: string, workspaceId: string | null, write: OrchestratorWorkspaceInput): string {
  return createHash('sha256').update(salt).update(canonicalJson({ workspaceId, write })).digest('hex');
}

/**
 * The input a workspace write card is stored with, read from the write as the route will read it. A
 * write that is refused whatever the answer — another account's workspace or runner, an account that
 * has turned session orchestration off since this session started — files no card at all, and neither
 * does one that needs none: only this writes a card under these names, so what a card under them says,
 * and the digest it holds, is never the asker's. `agentId` is the id the asker names, on an update.
 */
export async function workspaceWriteCardInput(
  prisma: Db,
  caller: { ownerId: string; runnerId: string },
  toolName: string,
  agentId: unknown,
  write: OrchestratorWorkspaceInput,
): Promise<WorkspaceWriteCard> {
  if (!namesWorkspaceCardField(write)) {
    throw new BadRequestException('this write needs no confirmation card: send it without one');
  }
  // In the authorizer's words, which refuses the write itself for the same reason.
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: caller.ownerId }, select: { preferences: true } });
  if (!orchestrationEnabled(owner)) throw new ForbiddenException('orchestration is not enabled for this session');
  const runner = (id: string) => prisma.runner.findFirst({
    where: { id, ownerId: caller.ownerId },
    select: { id: true, name: true, displayName: true },
  });
  const moved = write.runnerId === undefined ? null : await runner(write.runnerId);
  if (write.runnerId !== undefined && !moved) throw new ForbiddenException('runner not found');
  const { runnerId: _read, ...fields } = write;
  const changes = { ...fields, ...(moved ? { runner: moved } : {}) };
  const writeSalt = randomBytes(16).toString('hex');
  if (toolName === WORKSPACE_CREATE_APPROVAL_TOOL_NAME) {
    if (!write.name) throw new BadRequestException('name is required');
    return {
      agentId: null,
      name: write.name,
      workDir: null,
      // Where a create with no runner of its own goes: the machine the asking session runs on.
      runner: moved ?? await runner(caller.runnerId),
      changes,
      envRemoved: [],
      writeSalt,
      writeDigest: workspaceWriteDigest(writeSalt, null, write),
    };
  }
  const id = workspaceIdOf(agentId);
  const workspace = id === null ? null : await prisma.workspace.findFirst({
    where: { id, ownerId: caller.ownerId, deletedAt: null },
    select: { id: true, name: true, workDir: true, env: true, runner: { select: { id: true, name: true, displayName: true } } },
  });
  if (!workspace) throw new NotFoundException('workspace not found');
  const standing = Object.keys((workspace.env ?? {}) as Record<string, unknown>);
  return {
    agentId: workspace.id,
    name: workspace.name,
    workDir: workspace.workDir,
    runner: workspace.runner,
    changes,
    envRemoved: write.env ? standing.filter((name) => !(name in write.env!)).sort() : [],
    writeSalt,
    writeDigest: workspaceWriteDigest(writeSalt, workspace.id, write),
  };
}

/**
 * Refuse a write that names a card field unless the account owner said yes to exactly it in the asking
 * session: a card of this kind, ALLOWED, answered by a person (a standing rule's allow has no decider),
 * not yet spent, whose digest reproduces the write. The card is spent here, compare-and-set on the row
 * as it was read, so two copies of one write cannot both find it. A write that fails after this has
 * spent its yes and asks again: refused twice, never written twice.
 */
export async function requireWorkspaceWriteApproval(
  prisma: Pick<PrismaService, 'approval'>,
  sessionId: string,
  workspaceId: string | null,
  write: OrchestratorWorkspaceInput,
): Promise<void> {
  if (!namesWorkspaceCardField(write)) return;
  const cards = await prisma.approval.findMany({
    where: {
      sessionId,
      toolName: workspaceId === null ? WORKSPACE_CREATE_APPROVAL_TOOL_NAME : WORKSPACE_UPDATE_APPROVAL_TOOL_NAME,
      status: 'ALLOWED',
      decidedById: { not: null },
    },
    select: { id: true, input: true },
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
  });
  const covering = cards.find(({ input }) => {
    const card = (input ?? {}) as { writeSalt?: unknown; writeDigest?: unknown; usedAt?: unknown };
    return typeof card.writeSalt === 'string' && !card.usedAt
      && card.writeDigest === workspaceWriteDigest(card.writeSalt, workspaceId, write);
  });
  if (covering) {
    const stored = covering.input as Prisma.InputJsonObject;
    const spent = await prisma.approval.updateMany({
      where: { id: covering.id, status: 'ALLOWED', input: { equals: stored } },
      data: { input: { ...stored, usedAt: new Date().toISOString() } },
    });
    if (spent.count === 1) return;
  }
  throw new ForbiddenException({
    code: WORKSPACE_WRITE_APPROVAL_REQUIRED,
    message: 'writing a workspace\'s environment variables, working directory, system prompts, runner or '
      + 'worktree setting needs the account owner\'s yes on a confirmation card in this conversation, and '
      + 'there is no unspent yes for exactly this write. Ask through agent_create or agent_update (orbit '
      + 'agent create, orbit agent update), which puts the card in front of them; nothing was written. A '
      + 'runner too old to raise this card cannot make this write: update the runner, or ask the owner to '
      + 'make the change in the Orbit app.',
  });
}

/** An id as a card spells it — base62 or a uuid — as the uuid it names, or null when it names nothing. */
function workspaceIdOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return toUuid(value.trim());
  } catch {
    return null;
  }
}
