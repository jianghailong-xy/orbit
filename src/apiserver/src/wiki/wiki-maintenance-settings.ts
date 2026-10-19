import { randomUUID } from 'node:crypto';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WIKI_CURSOR_FACT_KINDS,
  wikiMaintenanceSettings,
  type WikiMaintenanceSettings,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import type { FactPosition } from './wiki-maintenance';

/**
 * The owner's maintenance settings of a space (design §8.2, contracts/wiki.contract.json
 * `space.settings.maintenance`): whether facts make runs, the workspace whose runner the server reads the
 * repository through, how many runs a UTC day may make, and how far back the first one reads.
 */

// ── The owner's maintenance settings ────────────────────────────────────────────────────────────

/** What a request may set of a space's maintenance (contract `space.settings.maintenance.channel`). */
export interface WikiMaintenanceInput {
  enabled?: boolean;
  workspaceId?: string | null;
  dailyRunLimit?: number;
  /** Null is a value — all of history — and left out is none. */
  lookbackDays?: number | null;
}

/** With a time, the position before every fact at it: the first kind in the order facts are read in, and the nil id. */
const START_KIND = [...WIKI_CURSOR_FACT_KINDS].sort()[0]!;
const START_REF = '00000000-0000-0000-0000-000000000000';

/** In the start's upsert: the row's furthest issued position is behind the start, or there is none. */
const issuedBehind = Prisma.sql`("wiki_cursor"."issued_at" IS NULL
  OR ("wiki_cursor"."issued_at", "wiki_cursor"."issued_kind", "wiki_cursor"."issued_ref")
   < (EXCLUDED."issued_at", EXCLUDED."issued_kind", EXCLUDED."issued_ref"))`;

/**
 * Where a cursor with no position starts when maintenance is turned on (contract `maintenance.cursor.start`):
 * `lookbackDays` days before `now`, as the position before every fact of that moment — so a fact is
 * after it exactly when it is no older — or null for all of history, which reads from the earliest fact.
 */
function wikiCursorStart(lookbackDays: number | null, now: Date): FactPosition | null {
  if (lookbackDays === null) return null;
  return { at: new Date(now.getTime() - lookbackDays * 86_400_000), kind: START_KIND, ref: START_REF };
}

/**
 * Write the owner's maintenance settings, merged over what the space has.
 *
 * The door has already refused a request with a session header (WIKI_OWNER_CHANNEL_ONLY): this is
 * the owner's alone. Only the `maintenance` key of the settings is written, merged in SQL, so a
 * concurrent write of another setting survives it.
 *
 * THE WRITE THAT TURNS MAINTENANCE ON STARTS THE CURSOR, when it has no position yet: `lookbackDays` days
 * back (`wikiCursorStart`), in the same transaction, so no fact finds the space on with its cursor still
 * at the earliest fact. Once — a cursor that has a position is never moved by it, and changing
 * `lookbackDays` alone moves nothing. `now` is for a spec to hold still.
 */
export function setWikiMaintenance(
  prisma: PrismaService,
  ownerId: string,
  spaceId: string,
  input: WikiMaintenanceInput,
  now: Date = new Date(),
): Promise<WikiMaintenanceSettings> {
  return new MaintenanceSettingsWriter(prisma).setWikiMaintenance(ownerId, spaceId, input, now);
}

/**
 * What a request names of a space's maintenance, checked before a space is made with it (contract
 * `space.settings.maintenance.channel`): a workspace of the owner's, which turning maintenance on needs.
 * The same refusals `setWikiMaintenance` answers. No provider is asked: the server's run calls the
 * deployment's System model (contract `maintenance.job.server`).
 */
export async function checkWikiMaintenanceInput(prisma: PrismaService, ownerId: string, input: WikiMaintenanceInput): Promise<void> {
  if (input.workspaceId) {
    const workspace = await prisma.workspace.findFirst({ where: { id: input.workspaceId, ownerId, deletedAt: null }, select: { id: true } });
    if (!workspace) throw new NotFoundException('no such workspace');
  }
  const asked = merged(wikiMaintenanceSettings(undefined), input);
  if (asked.enabled && !asked.workspaceId) {
    throw new BadRequestException('maintenance.workspaceId is required to turn maintenance on: the workspace its runs take place in');
  }
}

/** The one writer of `settings.maintenance`: a class only so that its retry is labelled like every other. */
class MaintenanceSettingsWriter {
  private readonly logger = new Logger('WikiMaintenance');

  constructor(private readonly prisma: PrismaService) {}

  async setWikiMaintenance(ownerId: string, spaceId: string, input: WikiMaintenanceInput, now: Date): Promise<WikiMaintenanceSettings> {
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
        const [locked] = await tx.$queryRaw<Array<{ settings: unknown }>>`
          SELECT "settings" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
        if (!locked) throw new NotFoundException('no such wiki space');
        const was = storedMaintenance(locked.settings);
        const next = merged(was, input);
        needsWorkspace(next);
        const change = JSON.stringify({ maintenance: next });
        await tx.$executeRaw`
          UPDATE "wiki_space" SET "settings" = "settings" || ${change}::jsonb, "updated_at" = now()
           WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid`;
        // Turned on by this write: the cursor starts where the owner's look-back says, if it has no position
        // yet. The furthest issued position is never moved back: it becomes the later of what it was and the start.
        const start = next.enabled && !was.enabled ? wikiCursorStart(next.lookbackDays, now) : null;
        if (start) {
          const at = start.at.toISOString();
          await tx.$executeRaw`
            INSERT INTO "wiki_cursor" ("id", "space_id", "owner_id", "source", "position_at", "position_kind", "position_ref",
                                       "issued_at", "issued_kind", "issued_ref")
            VALUES (${randomUUID()}::uuid, ${spaceId}::uuid, ${ownerId}::uuid, 'facts', ${at}::timestamptz, ${start.kind}, ${start.ref},
                    ${at}::timestamptz, ${start.kind}, ${start.ref})
            ON CONFLICT ("space_id", "source") DO UPDATE
               SET "position_at" = EXCLUDED."position_at", "position_kind" = EXCLUDED."position_kind",
                   "position_ref" = EXCLUDED."position_ref",
                   "issued_at" = CASE WHEN ${issuedBehind} THEN EXCLUDED."issued_at" ELSE "wiki_cursor"."issued_at" END,
                   "issued_kind" = CASE WHEN ${issuedBehind} THEN EXCLUDED."issued_kind" ELSE "wiki_cursor"."issued_kind" END,
                   "issued_ref" = CASE WHEN ${issuedBehind} THEN EXCLUDED."issued_ref" ELSE "wiki_cursor"."issued_ref" END,
                   "updated_at" = now()
             WHERE "wiki_cursor"."position_at" IS NULL`;
        }
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
    // Kept as stored, for the clients that read it (contract `space.settings.maintenance.keys.provider`): nothing runs on it.
    provider: current.provider,
    dailyRunLimit: input.dailyRunLimit ?? current.dailyRunLimit,
    lookbackDays: input.lookbackDays === undefined ? current.lookbackDays : input.lookbackDays,
    listId: current.listId,
  };
}

