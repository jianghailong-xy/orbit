import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIKI_MAINTENANCE_LIST_TITLE, wikiMaintenanceSettings, type WikiMaintenanceSettings } from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Who a Wiki maintenance session is, and the owner's maintenance settings of a space (design §8.2,
 * contracts/wiki.contract.json `space.settings.maintenance` and `maintenance.session`).
 *
 * A MAINTENANCE SESSION is a session whose task is in its space's hidden «Wiki maintenance» list, and
 * `isWikiMaintenanceSession` below is the one test of it: the dossier route and the cursor, and the
 * anchor re-verification, article generation, maintenance job and clean start that come after them,
 * all ask it rather than deciding for themselves. It reads nothing but the session, its task's list and
 * the spaces' settings, so it can be asked from any module without a service injected.
 */

// ── Who a maintenance session is ────────────────────────────────────────────────────────────────

/** Reads the maintenance tests need: the session, its task's list, and the space that list is. */
type MaintenanceReader = Pick<Prisma.TransactionClient, 'session' | 'wikiSpace'>;

/**
 * The space a session maintains, or null: the session's task is in that space's maintenance list
 * (`settings.maintenance.listId`). A deleted session, a session with no task, or a task in any other
 * list maintains nothing.
 */
export async function wikiMaintenanceSpaceOf(
  reader: MaintenanceReader,
  sessionId: string,
): Promise<{ spaceId: string; ownerId: string } | null> {
  const session = await reader.session.findFirst({
    where: { id: sessionId, deletedAt: null },
    select: { ownerId: true, task: { select: { listId: true, ownerId: true } } },
  });
  const listId = session?.task?.listId;
  if (!session || !listId || session.task?.ownerId !== session.ownerId) return null;
  const space = await reader.wikiSpace.findFirst({
    where: { ownerId: session.ownerId, settings: { path: ['maintenance', 'listId'], equals: listId } },
    select: { id: true },
  });
  return space ? { spaceId: space.id, ownerId: session.ownerId } : null;
}

/** Is this session a maintenance run of this space, for this owner? The one test every maintenance-only door asks. */
export async function isWikiMaintenanceSession(
  reader: MaintenanceReader,
  input: { ownerId: string; sessionId: string; spaceId: string },
): Promise<boolean> {
  const maintained = await wikiMaintenanceSpaceOf(reader, input.sessionId);
  return maintained !== null && maintained.ownerId === input.ownerId && maintained.spaceId === input.spaceId;
}

// ── The owner's maintenance settings ────────────────────────────────────────────────────────────

/** What a request may set of a space's maintenance (contract `space.settings.maintenance.channel`). */
export interface WikiMaintenanceInput {
  enabled?: boolean;
  workspaceId?: string | null;
  provider?: string;
  dailyTokenBudget?: number;
}

/**
 * Write the owner's maintenance settings, merged over what the space has, and make the space's hidden
 * «Wiki maintenance» list the first time maintenance is turned on (contract `maintenance.list`).
 *
 * The door has already refused a request with a session header (WIKI_OWNER_CHANNEL_ONLY): this is
 * the owner's alone. Only the `maintenance` key of the settings is written, merged in SQL, so a
 * concurrent write of another setting survives it; and the list is written before the space row is
 * locked — the user row's key (rank 10) and the list (20) before the wiki row (60) — so the
 * transaction takes its locks in the order docs/postgres-lock-order.md gives them. A list made by the
 * loser of two concurrent first enables is deleted again before it commits.
 */
export function setWikiMaintenance(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  input: WikiMaintenanceInput,
): Promise<WikiMaintenanceSettings> {
  return new MaintenanceSettingsWriter(prisma).setWikiMaintenance(ownerId, spaceId, input);
}

/** The one writer of `settings.maintenance`: a class only so that its retry is labelled like every other. */
class MaintenanceSettingsWriter {
  private readonly logger = new Logger('WikiMaintenance');

  constructor(private readonly prisma: PrismaService) {}

  async setWikiMaintenance(ownerId: string, spaceId: string, input: WikiMaintenanceInput): Promise<WikiMaintenanceSettings> {
    if (input.workspaceId) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: input.workspaceId, ownerId, deletedAt: null },
        select: { id: true },
      });
      if (!workspace) throw new NotFoundException('no such workspace');
    }
    const before = await this.prisma.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { settings: true } });
    if (!before) throw new NotFoundException('no such wiki space');
    const needsWorkspace = (settings: WikiMaintenanceSettings) => {
      if (settings.enabled && !settings.workspaceId) {
        throw new BadRequestException(
          'maintenance.workspaceId is required to turn maintenance on: the workspace its runs take place in',
        );
      }
    };
    needsWorkspace(merged(storedMaintenance(before.settings), input));
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const unlocked = merged(storedMaintenance(before.settings), input);
        const made = unlocked.enabled && !unlocked.listId
          ? await tx.taskList.create({
            data: { ownerId, title: WIKI_MAINTENANCE_LIST_TITLE, hidden: true, maxConcurrent: 1 },
            select: { id: true },
          })
          : null;
        const [locked] = await tx.$queryRaw<Array<{ settings: unknown }>>`
          SELECT "settings" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
        if (!locked) throw new NotFoundException('no such wiki space');
        const next = merged(storedMaintenance(locked.settings), input);
        needsWorkspace(next);
        if (next.enabled && !next.listId && made) next.listId = made.id;
        else if (made) await tx.taskList.delete({ where: { id: made.id } });
        const change = JSON.stringify({ maintenance: next });
        await tx.$executeRaw`
          UPDATE "wiki_space" SET "settings" = "settings" || ${change}::jsonb, "updated_at" = now()
           WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid`;
        return next;
      },
      loggedRetry(this.logger, 'wiki.setMaintenance'),
    );
  }
}

function storedMaintenance(settings: unknown): WikiMaintenanceSettings {
  const raw = settings !== null && typeof settings === 'object' && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).maintenance
    : undefined;
  return wikiMaintenanceSettings(raw);
}

function merged(current: WikiMaintenanceSettings, input: WikiMaintenanceInput): WikiMaintenanceSettings {
  return {
    enabled: input.enabled ?? current.enabled,
    workspaceId: input.workspaceId === undefined ? current.workspaceId : input.workspaceId,
    provider: input.provider?.trim() || current.provider,
    dailyTokenBudget: input.dailyTokenBudget ?? current.dailyTokenBudget,
    listId: current.listId,
  };
}

