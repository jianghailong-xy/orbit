import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { sessionTurnStateSql } from '../sessions/session-turn-state';
import { feishuDerivedUuid } from './feishu-direct.service';

/**
 * What the bot says to other people while it is open (docs/feishu-bot-design.md §14.6). English, as every word the bot
 * sends (CLAUDE.md §5), and none of it names Orbit: the reader is not the account's owner.
 */
export const FEISHU_OPEN_REPLIES = {
  /** The sender is not in the app's availability, or Feishu could not say (§14.3). */
  notAvailable: "You can't use this bot. Ask its owner to make the app available to you in Feishu.",
  personRunning: (n: number) =>
    n === 1
      ? 'You already have a session running. Wait for it to finish, then send this again.'
      : `You already have ${n} sessions running. Wait for one to finish, then send this again.`,
  personDaily: (n: number) =>
    `You've started ${sessionsWord(n)} today, the most this bot allows one person. Try again after midnight UTC.`,
  totalRunning: (n: number) =>
    `This bot is already running ${sessionsWord(n)}, the most it allows at a time. Try again when one finishes.`,
  totalDaily: (n: number) =>
    `This bot has started ${sessionsWord(n)} today, the most it allows in a day. Try again after midnight UTC.`,
  /** A mention in a group using the settings above that the owner switched off. */
  switchedOff: 'The owner has switched this bot off in this group, so nothing was started.',
} as const;

function sessionsWord(n: number): string {
  return n === 1 ? '1 session' : `${n} sessions`;
}

/** Which of the four limits (§14.4) a request would pass. */
export type FeishuOpenLimit = 'PERSON_RUNNING' | 'PERSON_DAILY' | 'TOTAL_RUNNING' | 'TOTAL_DAILY';

/**
 * What `reserveOpenSlot` answers: the slot is held; or a limit is reached, with the limit's value and the sentence to
 * reply; or the app is no longer open (switched to OWNER_ONLY, removed, or its workspace gone), where the caller answers
 * as it would for a closed bot.
 */
export type FeishuOpenSlot =
  | { ok: true }
  | { ok: false; limit: FeishuOpenLimit; max: number; words: string }
  | { ok: false; limit: 'NOT_OPEN' };

/** The request a slot is held for: the chain its session's replies go to, and who sent it. */
export interface FeishuOpenRequest {
  appId: string;
  /** The account the app is, and the session will be, owned by. */
  ownerId: string;
  /** The direct-message chat or the group, and the message the chain starts from (the request itself). */
  chatId: string;
  rootMessageId: string;
  /** The id the session will be made with: derived from the event, so the same event handled again names it again. */
  sessionId: string;
  /** The non-owner who sent it. */
  openId: string;
}

/**
 * `last_spoken_at` of a chain reserved for a session not made yet: the marker feishu-group.service.ts uses for its
 * topics. `openSlotStarted` stamps it once the session exists.
 */
const RESERVED_AT = '1970-01-01T00:00:00Z';
/** How long a reservation whose session never came (the process died mid-start) still holds a slot. */
const RESERVATION_HOLD = '10 minutes';

/**
 * Hold a slot of the open bot for the session `request.sessionId` about to be made (§14.4), or say which limit stops it.
 * Called by the direct-message (O3) and implicit-group (O4) paths before they make the session, inside a transaction.
 *
 * Under the app row's lock, so two requests arriving together are counted one after the other. The slot is the chain's
 * `feishu_thread` row, written here before the session with `open_access_open_id` = the sender, and it counts as the
 * session from then on. Only such rows count: the owner's chains and connected groups' topics never do.
 *
 *   - at a time: the rows whose session is PENDING or RUNNING (a session waiting for its next message, ended or in Trash
 *     holds none), and those reserved for a session still being made (for RESERVATION_HOLD);
 *   - a day: the rows made since midnight UTC whose session exists or is still being made.
 *
 * One person's rows are checked first, then everyone's. Direct messages and groups count together. A reservation of
 * this very request (the same event handled again) passes as it is and counts once.
 */
export async function reserveOpenSlot(tx: Prisma.TransactionClient, request: FeishuOpenRequest): Promise<FeishuOpenSlot> {
  const { appId, ownerId, chatId, rootMessageId, sessionId, openId } = request;
  const [app] = await tx.$queryRaw<Array<{ open: boolean; perRun: number; perDay: number; allRun: number; allDay: number }>>`
    SELECT (a."access_mode" = 'AVAILABILITY_SCOPE' AND w."id" IS NOT NULL) AS "open",
           a."open_max_running_per_person" AS "perRun", a."open_sessions_per_day_per_person" AS "perDay",
           a."open_max_running_total" AS "allRun", a."open_sessions_per_day_total" AS "allDay"
    FROM "feishu_app" a
    LEFT JOIN "workspace" w ON w."id" = a."open_workspace_id" AND w."owner_id" = a."owner_id" AND w."deleted_at" IS NULL
    WHERE a."app_id" = ${appId} AND a."owner_id" = ${ownerId}::uuid
    FOR UPDATE OF a`;
  if (!app?.open) return { ok: false, limit: 'NOT_OPEN' };
  const [mine] = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS "one" FROM "feishu_thread"
    WHERE "app_id" = ${appId} AND "chat_id" = ${chatId} AND "root_message_id" = ${rootMessageId} AND "session_id" = ${sessionId}::uuid`;
  if (mine) return { ok: true };
  const [held] = await tx.$queryRaw<Array<{ perRun: number; perDay: number; allRun: number; allDay: number }>>`
    WITH counted AS (
      SELECT t."open_access_open_id" = ${openId} AS "theirs",
             ((s."id" IS NULL AND t."created_at" > now() - ${RESERVATION_HOLD}::interval)
               OR (${sessionTurnStateSql('s')} IN ('QUEUED', 'IN_FLIGHT') AND s."deleted_at" IS NULL)) AS "running",
             (t."created_at" >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
               AND (s."id" IS NOT NULL OR t."created_at" > now() - ${RESERVATION_HOLD}::interval)) AS "today"
      FROM "feishu_thread" t
      LEFT JOIN "session" s ON s."id" = t."session_id" AND s."owner_id" = t."owner_id"
      WHERE t."app_id" = ${appId} AND t."owner_id" = ${ownerId}::uuid AND t."open_access_open_id" IS NOT NULL
    )
    SELECT count(*) FILTER (WHERE "theirs" AND "running")::int AS "perRun",
           count(*) FILTER (WHERE "theirs" AND "today")::int AS "perDay",
           count(*) FILTER (WHERE "running")::int AS "allRun",
           count(*) FILTER (WHERE "today")::int AS "allDay"
    FROM counted`;
  if (held!.perRun >= app.perRun) return refused('PERSON_RUNNING', app.perRun, FEISHU_OPEN_REPLIES.personRunning(app.perRun));
  if (held!.perDay >= app.perDay) return refused('PERSON_DAILY', app.perDay, FEISHU_OPEN_REPLIES.personDaily(app.perDay));
  if (held!.allRun >= app.allRun) return refused('TOTAL_RUNNING', app.allRun, FEISHU_OPEN_REPLIES.totalRunning(app.allRun));
  if (held!.allDay >= app.allDay) return refused('TOTAL_DAILY', app.allDay, FEISHU_OPEN_REPLIES.totalDaily(app.allDay));
  await tx.$executeRaw`
    INSERT INTO "feishu_thread" ("id", "owner_id", "app_id", "chat_id", "root_message_id", "session_id", "last_spoken_at", "open_access_open_id")
    VALUES (${feishuDerivedUuid('feishu-thread', appId, chatId, rootMessageId)}::uuid, ${ownerId}::uuid, ${appId}, ${chatId}, ${rootMessageId},
            ${sessionId}::uuid, ${RESERVED_AT}::timestamptz, ${openId})
    ON CONFLICT ("app_id", "chat_id", "root_message_id") DO NOTHING`;
  return { ok: true };
}

function refused(limit: FeishuOpenLimit, max: number, words: string): FeishuOpenSlot {
  return { ok: false, limit, max, words };
}

/** Stamp the reserved chain of a session now made as spoken in; true for the one start that does (record the activity then). */
export async function openSlotStarted(tx: Prisma.TransactionClient, request: Omit<FeishuOpenRequest, 'ownerId' | 'openId'>): Promise<boolean> {
  const stamped = await tx.$executeRaw`
    UPDATE "feishu_thread" SET "last_spoken_at" = now(), "updated_at" = now()
    WHERE "app_id" = ${request.appId} AND "chat_id" = ${request.chatId} AND "root_message_id" = ${request.rootMessageId}
      AND "session_id" = ${request.sessionId}::uuid AND "last_spoken_at" = ${RESERVED_AT}::timestamptz`;
  return stamped > 0;
}

/** Give back the slot of a session refused before it was written: its reservation, never a made session's chain. */
export async function releaseOpenSlot(prisma: PrismaService, request: Omit<FeishuOpenRequest, 'ownerId' | 'openId'>): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "feishu_thread" t
    WHERE t."app_id" = ${request.appId} AND t."chat_id" = ${request.chatId} AND t."root_message_id" = ${request.rootMessageId}
      AND t."session_id" = ${request.sessionId}::uuid AND t."last_spoken_at" = ${RESERVED_AT}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM "session" s WHERE s."id" = t."session_id")`;
}
