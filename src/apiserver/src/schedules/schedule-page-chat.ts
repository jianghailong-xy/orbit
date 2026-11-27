import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, ScheduleState } from '@prisma/client';
import {
  schedulePageChatOpening,
  type SchedulePageChatCounts,
  type SchedulePageChatNext,
  type SchedulePageChatOpenAnswer,
  type SchedulePageChatOpening,
  type SchedulePageChatResponse,
} from '@orbit/shared';

import type { AuthUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { workspaceNames } from './schedule-views';

type Tx = Prisma.TransactionClient;

/**
 * The Scheduled page's chat (docs/scheduled-chat-design.md §4.1, §4.3; board docs/mocks/scheduled-chat/): one
 * conversation for all of the account's schedules, docked on the page. It is an ordinary MANUAL session of the
 * workspace the person picked, marked by `session.schedule_chat_at` (migration 1740), the way `wiki_chat_space_id`
 * marks a Wiki chat, and listed in that workspace's sessions with a From Scheduled tag. It has no run source of its
 * own and no powers a session started any other way lacks: it acts through the schedule tools and their envelope.
 *
 * As with Change… (schedule-change-conversation.ts), nothing is written until the person speaks: `GET` draws Orbit's
 * opening from the account's schedules and starts no engine, and `POST` opens the session with the first words.
 */
@Injectable()
export class SchedulePageChats {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /** The account's open page chat, if any, and the opening a new one starts with. Writes nothing. */
  async read(ownerId: string): Promise<SchedulePageChatResponse> {
    const [open, opening] = await Promise.all([
      openPageChat(this.prisma, ownerId),
      schedulePageChatOpeningOf(this.prisma, ownerId, new Date()),
    ]);
    return { sessionId: open, opening };
  }

  /**
   * Opens the page chat in `workspaceId` with the person's first words, or, when that workspace already has one open
   * (another device or tab opened it meanwhile), says the words there and answers it with `created: false`. The
   * workspace is read under this owner by `SessionsService.create`, which refuses one that is not theirs.
   */
  async open(user: AuthUser, workspaceId: string, text: string): Promise<SchedulePageChatOpenAnswer> {
    const words = text.trim();
    if (words === '') throw new BadRequestException("text is the person's first message, and it has to say something");
    const open = await openPageChat(this.prisma, user.userId, workspaceId);
    if (open) {
      await this.sessions.createTurn(user.userId, open, { clientTurnId: randomUUID(), content: words }, { translate: true });
      return { sessionId: open, created: false };
    }
    const session = await this.sessions.create(
      user.userId,
      { workspaceId, prompt: words },
      { credential: user.credential, scheduleChat: true, translate: true },
    );
    return { sessionId: (session as { id: string }).id, created: true };
  }
}

/** The owner's newest page chat that is still open (not completed, archived or deleted), in `workspaceId` if named. */
export async function openPageChat(tx: Tx, ownerId: string, workspaceId?: string): Promise<string | null> {
  const row = await tx.session.findFirst({
    where: {
      ownerId,
      scheduleChatAt: { not: null },
      ...(workspaceId ? { workspaceId } : {}),
      completedAt: null,
      archivedAt: null,
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Orbit's opening (§4.1), from the account's schedules as they are at `now`: the counts of every schedule that has not
 * ended, and the soonest next run of an ACTIVE one with the workspace it runs on.
 */
export async function schedulePageChatOpeningOf(tx: Tx, ownerId: string, now: Date): Promise<SchedulePageChatOpening> {
  const schedules = await tx.schedule.findMany({
    where: { ownerId, state: { not: ScheduleState.ENDED } },
    select: {
      id: true, title: true, state: true, consecutiveFailures: true, nextDueAt: true, timezone: true, workspaceId: true,
    },
  });
  const counts: SchedulePageChatCounts = { total: schedules.length, active: 0, paused: 0, held: 0, failing: 0 };
  let soonest: (typeof schedules)[number] | null = null;
  for (const s of schedules) {
    if (s.state === ScheduleState.ACTIVE) {
      counts.active += 1;
      if (s.consecutiveFailures > 0) counts.failing += 1;
      if (s.nextDueAt && (!soonest || s.nextDueAt < soonest.nextDueAt!)) soonest = s;
    } else if (s.state === ScheduleState.PAUSED) {
      counts.paused += 1;
    } else if (s.state === ScheduleState.HELD) {
      counts.held += 1;
    }
  }
  let next: SchedulePageChatNext | null = null;
  if (soonest) {
    const names = await workspaceNames(tx, ownerId, [soonest.workspaceId]);
    next = {
      scheduleId: soonest.id,
      title: soonest.title,
      at: soonest.nextDueAt!.toISOString(),
      timezone: soonest.timezone,
      workspaceId: soonest.workspaceId,
      workspaceName: names.get(soonest.workspaceId) ?? null,
    };
  }
  return schedulePageChatOpening({ counts, next, now });
}
