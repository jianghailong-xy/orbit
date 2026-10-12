import { randomUUID } from 'node:crypto';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AgentProvider,
  credentialEngines,
  isEngineCompatible,
  WIKI_CURSOR_FACT_KINDS,
  WIKI_MAINTENANCE_LIST_TITLE,
  wikiMaintenanceEndpointIsLocal,
  wikiMaintenanceSettings,
  type WikiMaintenanceSettings,
} from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { adminOnlyProviderRefusal, isBuiltinProvider, keyCredential, usableProviderScope } from '../providers/custom-provider';
import { currentWikiExecutorSwitch, wikiExecutorServes } from './wiki-executor-switch';
import type { FactPosition } from './wiki-maintenance';

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

// ── Which provider a maintenance run may be pinned to ───────────────────────────────────────────

/** Why a provider cannot carry a maintenance run. */
export interface WikiMaintenanceProviderProblem {
  why: string;
  /**
   * Nothing the owner can run holds the slug now — no provider has it, or the one that has it is turned
   * off. The claim refuses it like any other problem; the settings door takes it, a name the owner may
   * configure next.
   */
  unavailable: boolean;
}

/** Why `slug` cannot carry a maintenance run of `ownerId`'s, or null when it can. */
export async function wikiMaintenanceProviderProblem(
  db: Pick<Prisma.TransactionClient, 'modelProvider' | 'providerPool' | 'user'>,
  ownerId: string,
  slug: string,
): Promise<WikiMaintenanceProviderProblem | null> {
  const offRuntime = (runtime: string): WikiMaintenanceProviderProblem => ({
    why: `'${slug}' runs on the ${runtime} runtime, and a Wiki maintenance run takes a provider on the Claude Code `
      + 'runtime only: its clean start and its disallowedTools hold there, and the codex path ignores disallowedTools '
      + '(design §8.2)',
    unavailable: false,
  });
  if (isBuiltinProvider(slug)) {
    if (slug !== AgentProvider.CLAUDE) return offRuntime(slug);
    return {
      why: "'claude' is this machine's own Claude Code sign-in, which a clean start cannot use: it reads no login, only "
        + "the key of a configured provider's endpoint. Pin a configured provider on the Claude Code runtime",
      unavailable: false,
    };
  }
  const row = await db.modelProvider.findFirst({
    where: { slug, ...(await usableProviderScope(db, ownerId)) },
    select: { runtime: true, presetSlug: true, baseUrl: true, apiKeyEnc: true, defaultModel: true, enabled: true },
  });
  if (row) {
    if (!row.enabled) {
      return { why: `the provider '${slug}' is turned off, and a Wiki maintenance run falls back to no other`, unavailable: true };
    }
    // The run's engine is Claude Code, whatever key it spends (docs/provider-engine-contract.md §3.5): a key
    // is one it takes when Claude Code can run it (the shared compatibility table), and is named by the
    // engine it runs on otherwise.
    const credential = keyCredential(row);
    return isEngineCompatible(AgentProvider.CLAUDE, credential)
      ? null
      : offRuntime(credentialEngines(credential)[0] ?? row.runtime);
  }
  if (await db.providerPool.findFirst({ where: { slug, ownerId }, select: { id: true } })) {
    return {
      why: `'${slug}' is an account pool: its members are Claude Code sign-ins, which a clean start cannot use, and a `
        + "pool with none free runs on the runner's own. Pin one configured provider on the Claude Code runtime",
      unavailable: false,
    };
  }
  // A shared provider is there, and runs an admin's sessions only (usableProviderScope): refused where it is named.
  const adminOnly = await adminOnlyProviderRefusal(db, ownerId, slug);
  if (adminOnly) return { why: adminOnly, unavailable: false };
  return { why: `no provider of this account is called '${slug}', and a Wiki maintenance run falls back to no other`, unavailable: true };
}

/**
 * Whether the provider `slug` names for `ownerId` is a local endpoint (contract `maintenance.job.catchUp.localEndpoint`):
 * a configured provider made from no vendor preset — a preset is its vendor's API, which bills — whose base URL's
 * host is this machine or a private network (`wikiMaintenanceEndpointIsLocal`). A built-in engine, an account pool
 * or a name no provider has is not.
 */
export async function wikiMaintenanceProviderIsLocal(
  db: Pick<Prisma.TransactionClient, 'modelProvider' | 'user'>,
  ownerId: string,
  slug: string,
): Promise<boolean> {
  if (isBuiltinProvider(slug)) return false;
  const row = await db.modelProvider.findFirst({
    where: { slug, ...(await usableProviderScope(db, ownerId)) },
    select: { baseUrl: true, presetSlug: true },
  });
  return row !== null && row.presetSlug === null && wikiMaintenanceEndpointIsLocal(row.baseUrl);
}

// ── The owner's maintenance settings ────────────────────────────────────────────────────────────

/** What a request may set of a space's maintenance (contract `space.settings.maintenance.channel`). */
export interface WikiMaintenanceInput {
  enabled?: boolean;
  workspaceId?: string | null;
  provider?: string;
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
 * Write the owner's maintenance settings, merged over what the space has, and make the space's hidden
 * «Wiki maintenance» list the first time maintenance is turned on (contract `maintenance.list`).
 *
 * The door has already refused a request with a session header (WIKI_OWNER_CHANNEL_ONLY): this is
 * the owner's alone. Only the `maintenance` key of the settings is written, merged in SQL, so a
 * concurrent write of another setting survives it; and the list is written before the space row is
 * locked — the user row's key (rank 10) and the list (20) before the wiki row (60) — so the
 * transaction takes its locks in the order docs/postgres-lock-order.md gives them. A list made by the
 * loser of two concurrent first enables is deleted again before it commits.
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
 * `space.settings.maintenance.channel`): a workspace of the owner's, and — named or turned on — a
 * provider a maintenance run could start on. The same refusals `setWikiMaintenance` answers.
 *
 * NO PROVIDER IS ASKED OF AN ACCOUNT THE SERVER EXECUTES (contract `maintenance.job.server`, P8): the
 * server's run calls the deployment's System model, so the provider a space pins is not consulted, and a
 * space whose account holds no provider row at all can be turned on. Under `runner` the check is what it
 * always was, word for word.
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
  if (wikiMaintenanceAsksProvider(ownerId) && (input.provider !== undefined || asked.enabled)) {
    const problem = await wikiMaintenanceProviderProblem(prisma, ownerId, asked.provider);
    if (problem && !problem.unavailable) throw new BadRequestException(`maintenance.provider: ${problem.why}`);
  }
}

/** Whether a space's maintenance settings are still a provider's to keep: false where the server runs its wiki. */
function wikiMaintenanceAsksProvider(ownerId: string): boolean {
  return !wikiExecutorServes(currentWikiExecutorSwitch(), ownerId);
}

/**
 * The space's hidden «Wiki maintenance» list, made now when the space has none (contract
 * `maintenance.list`): what a plan job needs to be made in, whether or not maintenance was ever turned on
 * (contract `plan.jobs.task`). Answers the list the space's settings name, or null for a space that is
 * gone. The list is made before the space row is locked, as `setWikiMaintenance` makes it, and deleted
 * again when the locked row names one already.
 */
export function ensureWikiMaintenanceList(prisma: PrismaService, ownerId: string, spaceId: string): Promise<string | null> {
  return new MaintenanceSettingsWriter(prisma).ensureList(ownerId, spaceId);
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
    const asked = merged(storedMaintenance(before.settings), input);
    needsWorkspace(asked);
    // A provider no maintenance run could start on is refused here, where the owner names it. One that is
    // merely not there (yet) is taken: the claim refuses the run that finds it still missing. An account the
    // server executes asks no provider at all (P8): its runs call the System model.
    if (wikiMaintenanceAsksProvider(ownerId) && (input.provider !== undefined || asked.enabled)) {
      const problem = await wikiMaintenanceProviderProblem(this.prisma, ownerId, asked.provider);
      if (problem && !problem.unavailable) throw new BadRequestException(`maintenance.provider: ${problem.why}`);
    }
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
        const was = storedMaintenance(locked.settings);
        const next = merged(was, input);
        needsWorkspace(next);
        if (next.enabled && !next.listId && made) next.listId = made.id;
        else if (made) await tx.taskList.delete({ where: { id: made.id } });
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

  async ensureList(ownerId: string, spaceId: string): Promise<string | null> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const made = await tx.taskList.create({
          data: { ownerId, title: WIKI_MAINTENANCE_LIST_TITLE, hidden: true, maxConcurrent: 1 },
          select: { id: true },
        });
        const [locked] = await tx.$queryRaw<Array<{ settings: unknown }>>`
          SELECT "settings" FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`;
        const current = locked ? storedMaintenance(locked.settings) : null;
        if (!current || current.listId) {
          await tx.taskList.delete({ where: { id: made.id } });
          return current?.listId ?? null;
        }
        const change = JSON.stringify({ maintenance: { ...current, listId: made.id } });
        await tx.$executeRaw`
          UPDATE "wiki_space" SET "settings" = "settings" || ${change}::jsonb, "updated_at" = now()
           WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid`;
        return made.id;
      },
      loggedRetry(this.logger, 'wiki.ensureMaintenanceList'),
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
    dailyRunLimit: input.dailyRunLimit ?? current.dailyRunLimit,
    lookbackDays: input.lookbackDays === undefined ? current.lookbackDays : input.lookbackDays,
    listId: current.listId,
  };
}

