import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { DriveActivityGroup, DriveActivityLine, DriveActivityOp, DriveActivityPage } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DRIVE_CURSOR_INVALID, drivePathsOf } from './drive.service';

/**
 * The owner's drive work, grouped by session and by day (`GET /drive/activity`; board frame 5, the Today / Yesterday
 * part). Read from what each kind of change already records about who made it:
 *
 *   - WROTE: drive_version, by its writer, each file once in the folder it is in now, with its newest version's size;
 *   - DELETED: drive_trash_group (DELETE), by its actor, one line a group, with the group to restore;
 *   - MOVED / RENAMED: drive_move (1780), by its actor;
 *   - SYNCED: drive_sync, by the session that started it: the files it sent to its destination. The versions it wrote
 *     are its own and not counted again as WROTE: a version the sync's session wrote while the sync ran is the sync's;
 *   - a Drive chat's work: drive_chat_change, by the chat, one line per change group with the group to undo while it can
 *     be undone, and the changes it holds for the owner's Apply as `held` lines. The versions, Trash groups and moves the
 *     chat's writes also left are not counted again, nor the Trash groups its owner's Apply made.
 *
 * An agent's write whose session was not kept (no session named, or one that is not the owner's on the runner it came
 * through) is nobody's and is left out; the owner's own writes are the group whose `sessionId` is null. Every read is by
 * the owner's id, and a session's title is read only for a session of the owner's.
 *
 * Paged by whole days of the client's `tz`: a page is the newest days before `before` until it holds `GROUPS_PER_PAGE`
 * groups, so a group is never split across pages.
 */

/** A page stops adding days once it holds this many groups. */
const GROUPS_PER_PAGE = 20;
/** The most days with changes one page looks at: one that reaches it answers what it found and where to go on. */
const DAYS_PER_PAGE = 60;

const refusal = (message: string) => new HttpException({ code: DRIVE_CURSOR_INVALID, message }, HttpStatus.BAD_REQUEST);

interface LineRow {
  session_id: string | null;
  op: DriveActivityOp;
  folder_id: string | null;
  folder_path: string | null;
  n: number;
  bytes: bigint | null;
  at: Date;
  undo_kind: 'CHANGE_GROUP' | 'TRASH_GROUP' | null;
  undo_id: string | null;
  held: boolean;
}

@Injectable()
export class DriveActivity {
  constructor(private readonly prisma: PrismaService) {}

  async page(ownerId: string, options: { before?: string; tz?: string } = {}): Promise<DriveActivityPage> {
    const tz = timeZoneOf(options.tz);
    let to = options.before === undefined ? null : beforeOf(options.before);
    const groups: DriveActivityGroup[] = [];
    for (let days = 0; ; days += 1) {
      const upper = to ?? new Date(Date.now() + 60_000);
      const newest = await this.newest(ownerId, upper);
      if (!newest) return { groups, nextBefore: null };
      if (to && (groups.length >= GROUPS_PER_PAGE || days >= DAYS_PER_PAGE)) return { groups, nextBefore: to.toISOString() };
      const [{ start }] = await this.prisma.$queryRaw<Array<{ start: Date }>>`
        SELECT (date_trunc('day', ${newest}::timestamptz AT TIME ZONE ${tz}::text) AT TIME ZONE ${tz}::text) AS "start"`;
      groups.push(...await this.day(ownerId, start, upper));
      to = start;
    }
  }

  /** The time of the newest change of any kind before `to`, or null: each by its own (owner, time) index. */
  private async newest(ownerId: string, to: Date): Promise<Date | null> {
    const [row] = await this.prisma.$queryRaw<Array<{ at: Date | null }>>`
      SELECT GREATEST(
        (SELECT max("created_at") FROM "drive_version" WHERE "owner_id" = ${ownerId}::uuid AND "created_at" < ${to}),
        (SELECT max("created_at") FROM "drive_trash_group"
          WHERE "owner_id" = ${ownerId}::uuid AND "created_at" < ${to} AND "kind" = 'DELETE'),
        (SELECT max("at") FROM "drive_move" WHERE "owner_id" = ${ownerId}::uuid AND "at" < ${to}),
        (SELECT max("started_at") FROM "drive_sync" WHERE "owner_id" = ${ownerId}::uuid AND "started_at" < ${to}),
        (SELECT max("created_at") FROM "drive_chat_change" WHERE "owner_id" = ${ownerId}::uuid AND "created_at" < ${to}),
        (SELECT max(h."created_at") FROM "drive_chat_held_change" h
           JOIN "drive_chat_change_group" g ON g."id" = h."group_id"
          WHERE g."session_id" IN (SELECT "id" FROM "session" WHERE "owner_id" = ${ownerId}::uuid AND "opened_by" = 'DRIVE_CHAT')
            AND g."status" IN ('PENDING', 'APPLYING') AND h."owner_id" = ${ownerId}::uuid AND h."created_at" < ${to})
      ) AS "at"`;
    return row?.at ?? null;
  }

  /** The groups of the changes made in [from, to), newest first. */
  private async day(ownerId: string, from: Date, to: Date): Promise<DriveActivityGroup[]> {
    const rows = await this.prisma.$queryRaw<LineRow[]>`
      WITH "chat" AS (
        SELECT "id" FROM "session" WHERE "owner_id" = ${ownerId}::uuid AND "opened_by" = 'DRIVE_CHAT'
      ), "sync" AS (
        SELECT "session_id", "started_at", COALESCE("ended_at", 'infinity'::timestamptz) AS "ended_at" FROM "drive_sync"
         WHERE "owner_id" = ${ownerId}::uuid AND "session_id" IS NOT NULL
           AND "started_at" < ${to} AND COALESCE("ended_at", 'infinity'::timestamptz) >= ${from}
      ), "written" AS (
        SELECT DISTINCT ON (v."writer_session_id", v."entry_id")
               v."writer_session_id" AS "session_id", e."parent_id" AS "folder_id", v."size_bytes", v."created_at" AS "at"
          FROM "drive_version" v
          JOIN "drive_entry" e ON e."id" = v."entry_id" AND e."owner_id" = v."owner_id"
         WHERE v."owner_id" = ${ownerId}::uuid AND v."created_at" >= ${from} AND v."created_at" < ${to}
           AND (v."writer_kind" = 'OWNER' OR v."writer_session_id" IS NOT NULL)
           AND (v."writer_session_id" IS NULL OR v."writer_session_id" NOT IN (SELECT "id" FROM "chat"))
           AND NOT EXISTS (
             SELECT 1 FROM "sync" s
              WHERE s."session_id" = v."writer_session_id" AND v."created_at" BETWEEN s."started_at" AND s."ended_at")
         ORDER BY v."writer_session_id", v."entry_id", v."created_at" DESC
      )
      SELECT "session_id", 'WROTE' AS "op", "folder_id", NULL::text AS "folder_path", count(*)::int AS "n",
             sum("size_bytes")::bigint AS "bytes", max("at") AS "at", NULL AS "undo_kind", NULL::uuid AS "undo_id", false AS "held"
        FROM "written" GROUP BY "session_id", "folder_id"
      UNION ALL
      SELECT g."actor_session_id", 'DELETED', g."folder_id", g."folder_path", g."item_count", g."size_bytes", g."created_at",
             'TRASH_GROUP', g."id", false
        FROM "drive_trash_group" g
       WHERE g."owner_id" = ${ownerId}::uuid AND g."kind" = 'DELETE' AND g."created_at" >= ${from} AND g."created_at" < ${to}
         AND g."item_count" > 0
         AND (g."actor_kind" = 'OWNER' OR g."actor_session_id" IS NOT NULL)
         AND (g."actor_session_id" IS NULL OR g."actor_session_id" NOT IN (SELECT "id" FROM "chat"))
         AND NOT EXISTS (SELECT 1 FROM "drive_chat_change" c WHERE c."owner_id" = ${ownerId}::uuid AND c."trash_group_id" = g."id")
      UNION ALL
      SELECT m."actor_session_id", CASE m."kind" WHEN 'MOVE' THEN 'MOVED' ELSE 'RENAMED' END, m."folder_id", NULL,
             count(DISTINCT m."entry_id")::int, NULL, max(m."at"), NULL, NULL, false
        FROM "drive_move" m
       WHERE m."owner_id" = ${ownerId}::uuid AND m."at" >= ${from} AND m."at" < ${to}
         AND (m."actor_kind" = 'OWNER' OR m."actor_session_id" IS NOT NULL)
         AND (m."actor_session_id" IS NULL OR m."actor_session_id" NOT IN (SELECT "id" FROM "chat"))
       GROUP BY m."actor_session_id", m."kind", m."folder_id"
      UNION ALL
      SELECT s."session_id", 'SYNCED', s."dest_entry_id", s."dest_path", s."files_done", s."bytes_sent", s."started_at",
             NULL, NULL, false
        FROM "drive_sync" s
       WHERE s."owner_id" = ${ownerId}::uuid AND s."session_id" IS NOT NULL AND s."files_done" > 0
         AND s."started_at" >= ${from} AND s."started_at" < ${to}
      UNION ALL
      SELECT g."session_id",
             CASE c."kind" WHEN 'MOVE' THEN 'MOVED' WHEN 'RENAME' THEN 'RENAMED' WHEN 'TRASH' THEN 'DELETED' ELSE 'WROTE' END,
             CASE c."kind" WHEN 'TRASH' THEN c."before_parent_id" ELSE c."after_parent_id" END, NULL,
             count(DISTINCT c."entry_id")::int, sum(v."size_bytes")::bigint, max(c."created_at"),
             CASE WHEN g."status" = 'DONE' THEN 'CHANGE_GROUP' END, CASE WHEN g."status" = 'DONE' THEN g."id" END, false
        FROM "drive_chat_change" c
        JOIN "drive_chat_change_group" g ON g."id" = c."group_id" AND g."owner_id" = c."owner_id"
        LEFT JOIN "drive_version" v ON v."id" = c."version_id" AND v."owner_id" = c."owner_id"
       WHERE c."owner_id" = ${ownerId}::uuid AND c."created_at" >= ${from} AND c."created_at" < ${to}
         AND c."state" IN ('DONE', 'SKIPPED') AND c."kind" <> 'NEW_FOLDER'
       GROUP BY g."session_id", g."id", g."status", 2, 3
      UNION ALL
      SELECT g."session_id", CASE h."kind" WHEN 'MOVE' THEN 'MOVED' WHEN 'RENAME' THEN 'RENAMED' ELSE 'DELETED' END, NULL,
             COALESCE(NULLIF(regexp_replace(CASE h."kind" WHEN 'TRASH' THEN h."from_path" ELSE h."to_path" END, '/[^/]*$', ''), ''), '/'),
             count(*)::int, NULL, max(h."created_at"), NULL, NULL, true
        FROM "drive_chat_held_change" h
        JOIN "drive_chat_change_group" g ON g."id" = h."group_id"
       WHERE g."session_id" IN (SELECT "id" FROM "chat") AND g."status" IN ('PENDING', 'APPLYING')
         AND h."owner_id" = ${ownerId}::uuid AND h."state" = 'PENDING' AND h."kind" <> 'NEW_FOLDER'
         AND h."created_at" >= ${from} AND h."created_at" < ${to}
       GROUP BY g."session_id", 2, 4`;
    if (!rows.length) return [];

    const folderIds = [...new Set(rows.filter((r) => r.folder_path === null && r.folder_id).map((r) => r.folder_id!))];
    const paths = await drivePathsOf(this.prisma, ownerId, folderIds);
    const sessionIds = [...new Set(rows.map((r) => r.session_id).filter((id): id is string => id !== null))];
    const sessions = sessionIds.length
      ? await this.prisma.session.findMany({ where: { ownerId, id: { in: sessionIds } }, select: { id: true, title: true, openedBy: true } })
      : [];
    const sessionOf = new Map(sessions.map((s) => [s.id, s]));

    const byGroup = new Map<string | null, Map<string, DriveActivityLine>>();
    for (const row of rows) {
      const folderPath = row.folder_path ?? (row.folder_id ? paths.get(row.folder_id) ?? null : null);
      const lines = byGroup.get(row.session_id) ?? new Map<string, DriveActivityLine>();
      byGroup.set(row.session_id, lines);
      const key = [row.op, folderPath, row.undo_kind, row.undo_id, row.held].join('\u0000');
      const at = row.at.toISOString();
      const bytes = row.bytes === null ? undefined : Number(row.bytes);
      const line = lines.get(key);
      if (line) {
        line.count += row.n;
        if (bytes !== undefined) line.bytes = (line.bytes ?? 0) + bytes;
        if (at > line.at) line.at = at;
        continue;
      }
      lines.set(key, {
        op: row.op,
        count: row.n,
        folderPath,
        ...(bytes === undefined || row.op === 'MOVED' || row.op === 'RENAMED' ? {} : { bytes }),
        ...(row.undo_kind && row.undo_id ? { undo: { kind: row.undo_kind, id: row.undo_id } } : {}),
        ...(row.held ? { held: true as const } : {}),
        at,
      });
    }
    const groups: DriveActivityGroup[] = [...byGroup].map(([sessionId, lines]) => {
      const sorted = [...lines.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      const session = sessionId ? sessionOf.get(sessionId) : undefined;
      return {
        sessionId,
        sessionTitle: session?.title ?? null,
        isDriveChat: session?.openedBy === 'DRIVE_CHAT',
        at: sorted[0].at,
        lines: sorted,
      };
    });
    return groups.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (a.sessionId ?? '').localeCompare(b.sessionId ?? '')));
  }
}

/** `tz`: an IANA time zone the client's days are in; UTC when not given. */
function timeZoneOf(tz: string | undefined): string {
  if (tz === undefined || tz === '') return 'UTC';
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) throw refusal('tz is not a time zone.');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw refusal('tz is not a time zone.');
  }
}

/** `before`: the `nextBefore` of the page before. */
function beforeOf(before: string): Date {
  const at = new Date(before);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(before) || Number.isNaN(at.getTime())) throw refusal('before is not a cursor this route answered.');
  return at;
}
