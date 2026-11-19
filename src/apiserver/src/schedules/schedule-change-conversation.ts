import { randomUUID } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SessionRunSource, type Schedule } from '@prisma/client';
import {
  SCHEDULE_COPY,
  scheduleCostsText,
  scheduleRuleText as sharedRuleText,
  scheduleRunsInText,
  uuidToBase62,
  type ScheduleChangeConversationResponse,
  type ScheduleChangeOpening,
  type ScheduleRule as SharedRule,
} from '@orbit/shared';

import type { AuthUser } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import type { ScheduleRule } from './schedule-time';
import { scheduleMayText, scheduleReadBack, scheduleViewNames, workspaceNames } from './schedule-views';

type Tx = Prisma.TransactionClient;

/**
 * A schedule's change conversation (docs/scheduled-tasks-design.md §8.2, owner 2026-11-19, board 03-change): Change…
 * opens a session bound to the schedule, whose opening is Orbit's — the schedule as it is, and what can change at
 * once or needs the owner's Allow — and whose engine starts only with the person's first words. Until then nothing is
 * written: the client draws the opening from `GET`, and `POST` opens the session with the words.
 */
@Injectable()
export class ScheduleChangeConversations {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /** The schedule's open change conversation, if any, and the opening a new one would start with. */
  async read(ownerId: string, scheduleId: string): Promise<ScheduleChangeConversationResponse> {
    const schedule = await this.schedule(ownerId, scheduleId);
    const [open, opening] = await Promise.all([
      openChangeConversation(this.prisma, ownerId, scheduleId),
      scheduleChangeOpening(this.prisma, schedule),
    ]);
    return { sessionId: open, opening };
  }

  /**
   * Opens the schedule's change conversation with the person's first words, or, when one is still open (another
   * device opened it meanwhile), says the words there and answers it with `created: false`.
   */
  async open(user: AuthUser, scheduleId: string, text: string): Promise<{ sessionId: string; created: boolean }> {
    const schedule = await this.schedule(user.userId, scheduleId);
    const open = await openChangeConversation(this.prisma, user.userId, scheduleId);
    if (open) {
      await this.sessions.createTurn(user.userId, open, { clientTurnId: randomUUID(), content: text.trim() }, { translate: true });
      return { sessionId: open, created: false };
    }
    const opening = await scheduleChangeOpening(this.prisma, schedule);
    const session = await this.sessions.create(
      user.userId,
      {
        workspaceId: schedule.workspaceId,
        title: SCHEDULE_COPY.changeConversation.title.replace('{title}', schedule.title),
        prompt: text.trim(),
      },
      {
        credential: user.credential,
        runSource: SessionRunSource.SCHEDULE_CHANGE,
        changeSchedule: { scheduleId: schedule.id, opening },
      },
    );
    return { sessionId: (session as { id: string }).id, created: true };
  }

  private async schedule(ownerId: string, scheduleId: string): Promise<Schedule> {
    const schedule = await this.prisma.schedule.findFirst({ where: { id: scheduleId, ownerId } });
    if (!schedule) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: 'No such schedule.' });
    return schedule;
  }
}

/** The newest change conversation of the schedule that is still open (not completed, archived or deleted). */
export async function openChangeConversation(tx: Tx, ownerId: string, scheduleId: string): Promise<string | null> {
  const row = await tx.session.findFirst({
    where: { ownerId, changeScheduleId: scheduleId, completedAt: null, archivedAt: null, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** "Every day at 09:00 · Asia/Shanghai"; a WHEN rule has no time, so its zone says nothing. */
function whenText(schedule: Pick<Schedule, 'rule' | 'timezone'>): string {
  const rule = schedule.rule as unknown as ScheduleRule;
  if (rule.kind === 'WHEN') return sharedRuleText(rule as SharedRule, 'long');
  const when = rule.kind === 'ONCE' ? rule.at.replace('T', ' ') : sharedRuleText(rule as SharedRule, 'long');
  return [when, schedule.timezone].join(SCHEDULE_COPY.separator);
}

/** Orbit's opening, from the schedule as it is now. */
export async function scheduleChangeOpening(tx: Tx, schedule: Schedule): Promise<ScheduleChangeOpening> {
  const [names, viewNames] = await Promise.all([
    workspaceNames(tx, schedule.ownerId, [schedule.workspaceId]),
    scheduleViewNames(tx, schedule.ownerId, [schedule]),
  ]);
  const engine = (schedule.createdFromSessionId && viewNames.engines.get(schedule.createdFromSessionId)) || null;
  return {
    scheduleId: schedule.id,
    title: schedule.title,
    revision: schedule.revision,
    does: scheduleReadBack(schedule),
    when: whenText(schedule),
    runsIn: scheduleRunsInText(names.get(schedule.workspaceId) ?? 'a deleted workspace', engine),
    may: scheduleMayText(schedule.accessLevel),
    costs: scheduleCostsText(schedule.envelopeRunsPerWeek, schedule.envelopeRunLimitMinutes),
  };
}

/**
 * What delivery appends to every message of a change conversation, after the person's words (recorded as the
 * control plane's note, runner-api/control-plane-note.ts): which schedule this conversation changes, as it is at
 * this delivery, and how to change it. Read now, so a message after a change sees the schedule it left.
 */
export async function appendScheduleChangeNote(
  tx: Tx,
  input: { ownerId: string; scheduleId: string },
  content: string | undefined,
): Promise<string | undefined> {
  const schedule = await tx.schedule.findFirst({ where: { id: input.scheduleId, ownerId: input.ownerId } });
  if (!schedule) return content;
  const now = await scheduleChangeOpening(tx, schedule);
  const id = uuidToBase62(schedule.id);
  const block = [
    `<orbit_schedule_change schedule_id="${id}" revision="${schedule.revision}" state="${schedule.state}">`,
    `This conversation changes the scheduled task "${schedule.title}". The person's words above say what to change.`,
    `Now: ${now.when}. Runs in ${now.runsIn}. May: ${now.may}. Costs: ${now.costs}.`,
    `What it does: ${now.does}`,
    `What was asked when it was created: ${schedule.intent}`,
    `Change it with mcp__orbit__schedule_update (scheduleId "${id}"), or pause, resume or end it with the schedule tools. `
      + 'A change inside what the person allowed applies at once and can be undone; one that needs more runs, longer '
      + 'runs, more access or another workspace becomes a card the person allows. Change only this schedule, and ask '
      + 'back only for what only the person can decide.',
    '</orbit_schedule_change>',
  ].join('\n');
  return [content ?? '', block].join('\n\n');
}
