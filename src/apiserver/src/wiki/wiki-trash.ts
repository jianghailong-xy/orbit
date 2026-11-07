import { ConflictException, Injectable, Logger, NotFoundException, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIKI_TRASH_RETENTION_DAYS, type WikiTrashRow } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { ControlPlaneLeader } from '../realtime/control-plane-leader';

/**
 * The wiki's Trash (contracts/wiki.contract.json `space.trash`, docs/mocks/wiki-trash, migration 0486).
 *
 * MOVING A WIKI TO TRASH IS ONE SHORT WRITE. Its row is marked and given a due date 365 days on; its slug becomes a
 * placeholder of its own id and its repository NULL, the two kept beside them. So a new wiki can be made under the same
 * name and on the same repository, and nothing that finds a wiki by its name or its repository finds this one — the
 * workspaces on that repository included, which are in a wiki by their URL alone (`wiki-workspaces.ts`). Every door that
 * finds a wiki by its id asks for one in use (`assertWikiSpaceInUse`, `requireSpace`). Work queued or running for it is
 * dropped; its maintenance is turned off and stays off when it is restored, so a restore does not set out to read a
 * year of records at once. Its public link answers as gone while it is in Trash and comes back with it.
 *
 * WHAT IT HOLDS GOES IN THE BACKGROUND, a batch at a time (`purgeDueWikiSpaces`): when its 365 days are up, or as soon
 * as the owner deletes it permanently. Each batch is one statement of its own, so none holds locks or a connection for
 * long, a loaded database only makes the whole slower, and a purge cut off by a deploy goes on where it stopped. A purge
 * holds the wiki by a lease, so two apiserver processes never purge the same wiki side by side.
 */

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;

export const WIKI_TRASH = {
  /** How long a wiki stays in Trash before it is deleted for good (owner, 2026-11-07). */
  retentionDays: WIKI_TRASH_RETENTION_DAYS,
  /** Entries per purge statement, each with the entries it supersedes or is superseded by. */
  entryBatch: 300,
  /** Rows of any other table per purge statement. */
  rowBatch: 1000,
  /** How long a purge holds a due wiki before another may take it over. */
  leaseSeconds: 300,
  /** How long one purge pass works before it yields the rest to the next one. */
  passBudgetMs: 30_000,
  /** How often the process that runs the singleton sweeps looks for a due wiki: a permanent delete waits at most this. */
  intervalMs: 60_000,
} as const;

/** A wiki in use by its id: another account's, one gone and one in Trash are the same plain 404. */
export async function assertWikiSpaceInUse(db: Db, ownerId: string, spaceId: string, message = 'no such wiki space'): Promise<void> {
  const found = await db.wikiSpace.findFirst({ where: { id: spaceId, ownerId, deletedAt: null }, select: { id: true } });
  if (!found) throw new NotFoundException(message);
}

/** The slug a wiki has while it is in Trash: its own id, so it is unique and of a slug's shape. */
export function trashedSlugOf(spaceId: string): string {
  return `trashed-${spaceId.replace(/-/g, '')}`;
}

/**
 * Move a wiki in use to Trash, under its row lock: mark it, give it its due date, set its name and repository aside, turn
 * its maintenance off, and drop the work queued or running for it. A wiki not in use answers 404.
 */
export async function moveWikiSpaceToTrash(tx: Tx, ownerId: string, spaceId: string): Promise<{ deletedAt: Date; purgeAt: Date }> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "wiki_space"
     WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid AND "deleted_at" IS NULL
     FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundException('no such wiki space');
  const moved = await tx.$queryRaw<Array<{ deletedAt: Date; purgeAt: Date }>>`
    UPDATE "wiki_space"
       SET "deleted_at" = now(),
           "purge_at" = now() + ${WIKI_TRASH.retentionDays}::int * interval '1 day',
           "trashed_slug" = "slug",
           "trashed_repo_url_norm" = "repo_url_norm",
           "slug" = ${trashedSlugOf(spaceId)},
           "repo_url_norm" = NULL,
           "settings" = "settings" || jsonb_build_object(
             'maintenance', COALESCE("settings" -> 'maintenance', '{}'::jsonb) || jsonb_build_object('enabled', false)),
           "updated_at" = now()
     WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid
     RETURNING "deleted_at" AS "deletedAt", "purge_at" AS "purgeAt"`;
  // Rows of work, none of what the wiki knows: a running job loses its row, and its next write under its claim ends it.
  await tx.$executeRaw`
    DELETE FROM "wiki_plan_job" WHERE "space_id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid AND "state" <> 'ended'`;
  await tx.$executeRaw`
    DELETE FROM "wiki_job"
     WHERE "space_id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid AND "state" IN ('queued', 'running', 'waiting')`;
  return moved[0];
}

/**
 * Bring a wiki back from Trash, under its row lock: its repository back, unless a wiki in use holds it now (refused, with
 * what to do); its slug back, or the next free one when a wiki in use took it. A wiki in use is answered as it is, so a
 * second press of Restore changes nothing; one gone, or already due to be deleted for good, answers 404.
 */
export async function restoreWikiSpace(tx: Tx, ownerId: string, spaceId: string): Promise<{ restored: boolean }> {
  const rows = await tx.$queryRaw<Array<{ inTrash: boolean; restorable: boolean; slug: string | null; repo: string | null }>>`
    SELECT "deleted_at" IS NOT NULL AS "inTrash", "purge_at" > now() AS "restorable",
           "trashed_slug" AS "slug", "trashed_repo_url_norm" AS "repo"
      FROM "wiki_space"
     WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid
     FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundException('no such wiki space');
  const { inTrash, restorable, slug, repo } = rows[0];
  if (!inTrash) return { restored: false };
  if (!restorable || slug === null) throw new NotFoundException('no such wiki in Trash');
  if (repo !== null) {
    const holder = await tx.wikiSpace.findFirst({ where: { ownerId, repoUrlNorm: repo, deletedAt: null }, select: { id: true } });
    if (holder) throw repositoryTaken(repo);
  }
  const taken = new Set(
    (await tx.wikiSpace.findMany({ where: { ownerId, NOT: { id: spaceId } }, select: { slug: true } })).map((row) => row.slug),
  );
  let candidate = slug;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${slug.slice(0, 60).replace(/-+$/u, '')}-${n}`;
  await tx.$executeRaw`
    UPDATE "wiki_space"
       SET "slug" = ${candidate}, "repo_url_norm" = ${repo},
           "deleted_at" = NULL, "purge_at" = NULL, "purge_lease_until" = NULL,
           "trashed_slug" = NULL, "trashed_repo_url_norm" = NULL, "updated_at" = now()
     WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid`;
  return { restored: true };
}

/** What a restore says when a wiki in use holds the repository the one in Trash was on (owner's pick, 2026-11-07). */
export function repositoryTaken(repo: string): ConflictException {
  return new ConflictException(`A newer wiki for ${repo} is in your wikis now. Move it to Trash first, then restore this one.`);
}

/** Ask for a wiki in Trash to be deleted for good now: it leaves Trash at once, and a purge takes it. False when none. */
export async function requestWikiSpacePurge(prisma: PrismaService, ownerId: string, spaceId: string): Promise<boolean> {
  const marked = await prisma.$executeRaw`
    UPDATE "wiki_space" SET "purge_at" = now(), "updated_at" = now()
     WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid AND "deleted_at" IS NOT NULL AND "purge_at" > now()`;
  return marked > 0;
}

/** The owner's Trash, the newest move first. A wiki whose purge is due is no longer in it. */
export async function listWikiTrash(prisma: PrismaService, ownerId: string): Promise<WikiTrashRow[]> {
  const rows = await prisma.wikiSpace.findMany({
    where: { ownerId, deletedAt: { not: null }, purgeAt: { gt: new Date() } },
    orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
    select: { id: true, title: true, trashedSlug: true, trashedRepoUrlNorm: true, deletedAt: true, purgeAt: true },
  });
  if (rows.length === 0) return [];
  const counts = await prisma.wikiEntry.groupBy({
    by: ['spaceId'],
    where: { ownerId, spaceId: { in: rows.map((row) => row.id) }, status: 'active' },
    _count: { _all: true },
  });
  const entries = new Map(counts.map((row) => [row.spaceId, row._count._all]));
  return rows.map((row) => ({
    id: row.id,
    slug: row.trashedSlug ?? '',
    title: row.title,
    repoUrlNorm: row.trashedRepoUrlNorm,
    deletedAt: row.deletedAt!.toISOString(),
    purgeAt: row.purgeAt!.toISOString(),
    entries: entries.get(row.id) ?? 0,
  }));
}

// ── the purge ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A table with a foreign key to wiki_space, and the column of it that names the wiki. */
interface SpaceChild {
  schema: string;
  table: string;
  column: string;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Every table that names a wiki, read from the catalog, so a table added later is purged with the rest without anyone
 * remembering to. Entries first, since what they hang on is the most; then changesets; then the rest by name. A name
 * this could not quote safely is left to the cascade of the wiki's own row, which takes whatever is left in one go.
 */
async function spaceChildren(prisma: PrismaService): Promise<SpaceChild[]> {
  const rows = await prisma.$queryRaw<SpaceChild[]>`
    SELECT DISTINCT ns.nspname AS "schema", t.relname AS "table", ca.attname AS "column"
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = t.relnamespace
      JOIN LATERAL unnest(c.conkey, c.confkey) AS k(child_att, parent_att) ON true
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.parent_att AND pa.attname = 'id'
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.child_att
     WHERE c.contype = 'f' AND c.confrelid = '"wiki_space"'::regclass AND c.conrelid <> c.confrelid`;
  const rank = (table: string) => (table === 'wiki_entry' ? 0 : table === 'wiki_changeset' ? 1 : 2);
  return rows
    .filter((row) => IDENTIFIER.test(row.schema) && IDENTIFIER.test(row.table) && IDENTIFIER.test(row.column))
    .sort((a, b) => rank(a.table) - rank(b.table) || a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}

/** Take the oldest due wiki that no other purge holds, for WIKI_TRASH.leaseSeconds. */
async function leaseDueSpace(prisma: PrismaService): Promise<string | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "wiki_space" AS s
       SET "purge_lease_until" = now() + ${WIKI_TRASH.leaseSeconds}::int * interval '1 second'
      FROM (SELECT "id" FROM "wiki_space"
             WHERE "deleted_at" IS NOT NULL AND "purge_at" <= now()
               AND ("purge_lease_until" IS NULL OR "purge_lease_until" < now())
             ORDER BY "purge_at", "id"
             LIMIT 1
             FOR UPDATE SKIP LOCKED) AS due
     WHERE s."id" = due."id"
     RETURNING s."id"`;
  return rows[0]?.id ?? null;
}

/** Keep the lease while the purge goes on, or hand it back when the pass yields. */
async function renewPurgeLease(prisma: PrismaService, spaceId: string, keep: boolean): Promise<void> {
  if (keep) {
    await prisma.$executeRaw`
      UPDATE "wiki_space" SET "purge_lease_until" = now() + ${WIKI_TRASH.leaseSeconds}::int * interval '1 second'
       WHERE "id" = ${spaceId}::uuid AND "deleted_at" IS NOT NULL`;
  } else {
    await prisma.$executeRaw`UPDATE "wiki_space" SET "purge_lease_until" = NULL WHERE "id" = ${spaceId}::uuid AND "deleted_at" IS NOT NULL`;
  }
}

/**
 * One batch of a wiki's entries, each with every entry it supersedes or is superseded by, however far that goes: the
 * supersede keys check at the end of the statement that nothing names an entry gone, and a status of superseded needs
 * its superseded_by_id, so the two ends of every link go in one statement.
 */
async function deleteEntryBatch(prisma: PrismaService, spaceId: string): Promise<number> {
  return prisma.$executeRaw`
    WITH RECURSIVE batch("id") AS (
      (SELECT e."id" FROM "wiki_entry" e WHERE e."space_id" = ${spaceId}::uuid ORDER BY e."id" LIMIT ${WIKI_TRASH.entryBatch}::int)
      UNION
      SELECT n."id" FROM batch b
        JOIN "wiki_entry" be ON be."id" = b."id"
        JOIN "wiki_entry" n ON n."space_id" = ${spaceId}::uuid
         AND (n."id" = be."supersedes_id" OR n."id" = be."superseded_by_id" OR n."supersedes_id" = b."id" OR n."superseded_by_id" = b."id")
    )
    DELETE FROM "wiki_entry" WHERE "id" IN (SELECT "id" FROM batch)`;
}

/** One batch of another table's rows that name the wiki. */
async function deleteChildBatch(prisma: PrismaService, child: SpaceChild, spaceId: string): Promise<number> {
  const table = Prisma.raw(`"${child.schema}"."${child.table}"`);
  const column = Prisma.raw(`"${child.column}"`);
  return prisma.$executeRaw`
    DELETE FROM ${table} WHERE ctid = ANY (ARRAY(
      SELECT ctid FROM ${table} WHERE ${column} = ${spaceId}::uuid LIMIT ${WIKI_TRASH.rowBatch}::int))`;
}

/**
 * Delete one due wiki a batch at a time until it is gone or the pass has to stop. True when its row went too; false when
 * the pass yielded, which hands its lease back so the next pass goes on from where this one stopped.
 */
async function purgeSpace(prisma: PrismaService, spaceId: string, stop: () => boolean): Promise<boolean> {
  for (const child of await spaceChildren(prisma)) {
    for (;;) {
      if (stop()) {
        await renewPurgeLease(prisma, spaceId, false);
        return false;
      }
      const gone = child.table === 'wiki_entry' && child.column === 'space_id'
        ? await deleteEntryBatch(prisma, spaceId)
        : await deleteChildBatch(prisma, child, spaceId);
      if (gone === 0) break;
      await renewPurgeLease(prisma, spaceId, true);
    }
  }
  const removed = await prisma.$executeRaw`
    DELETE FROM "wiki_space" WHERE "id" = ${spaceId}::uuid AND "deleted_at" IS NOT NULL AND "purge_at" <= now()`;
  return removed > 0;
}

/**
 * Delete for good the wikis whose purge is due, the oldest first, for at most `budgetMs` or until `stopped` says so.
 * Returns the wikis it finished and the one it was part way through, which the next pass goes on with.
 */
export async function purgeDueWikiSpaces(
  prisma: PrismaService,
  options: { budgetMs?: number; stopped?: () => boolean } = {},
): Promise<{ purged: string[]; partial: string | null }> {
  const deadline = Date.now() + (options.budgetMs ?? WIKI_TRASH.passBudgetMs);
  const stop = () => Date.now() >= deadline || (options.stopped?.() ?? false);
  const purged: string[] = [];
  while (!stop()) {
    const spaceId = await leaseDueSpace(prisma);
    if (spaceId === null) break;
    try {
      if (!(await purgeSpace(prisma, spaceId, stop))) return { purged, partial: spaceId };
    } catch (error) {
      await renewPurgeLease(prisma, spaceId, false).catch(() => undefined);
      throw error;
    }
    purged.push(spaceId);
  }
  return { purged, partial: null };
}

/**
 * The purge's timer, on the process that runs the singleton sweeps (realtime/control-plane-leader.ts): once a minute it
 * looks for a due wiki through `wiki_space_purge_idx` and works on it for up to WIKI_TRASH.passBudgetMs. A shutdown stops
 * it between two batches; what is left is taken up by the next pass, on this process or the one that leads next.
 */
@Injectable()
export class WikiTrashPurge implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('WikiTrash');
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<unknown>;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    /** Which process purges. `@Optional()` for a spec that calls `pass` itself. */
    @Optional() private readonly leader?: ControlPlaneLeader,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), WIKI_TRASH.intervalMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }

  /** The timer's run. What goes wrong is said here, and the next run goes on from where this one stopped. */
  private tick(): void {
    if (this.leader && !this.leader.leads()) return;
    if (this.running || this.stopping) return;
    this.running = this.pass()
      .catch((error) => this.logger.error(`a wiki in Trash was not deleted yet, and the next pass goes on: ${(error as Error).message}`))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One pass, logged when it did anything. */
  async pass(): Promise<void> {
    const { purged, partial } = await purgeDueWikiSpaces(this.prisma, { stopped: () => this.stopping });
    for (const spaceId of purged) this.logger.log(`deleted wiki ${spaceId} for good`);
    if (partial !== null) this.logger.log(`deleting wiki ${partial} for good; the next pass goes on with it`);
  }
}
