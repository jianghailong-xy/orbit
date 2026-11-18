/**
 * The 30-day question (docs/condition-triggers-design.md §6.2, P3): a task's condition that has not fired 30 days after
 * it was created, or after the owner's last Keep waiting, files one CONDITION_STILL_WAITING item in Waiting on you:
 * "Still waiting for <text>. Keep waiting?". Keep waiting asks again 30 days later; Stop ends the condition and leaves
 * the task OPEN, its pointer kept, so nothing starts it but a person.
 *
 * Once per span: the item's key is the condition and the instant its 30 days are counted from, so a sweep on every
 * replica, a replay, or an item the owner dismissed files nothing more until a Keep waiting moves that instant.
 */
import { BadRequestException } from '@nestjs/common';
import {
  CONDITION_STILL_WAITING_DAYS,
  CONDITION_STILL_WAITING_KIND,
  CONDITION_STILL_WAITING_OPTIONS,
} from '@orbit/shared';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;

/** What the 30 days are counted from. */
export function stillWaitingSince(c: { createdAt: Date; keepWaitingSince: Date | null }): Date {
  return c.keepWaitingSince ?? c.createdAt;
}

/** Whether a task's condition is due to ask: not fired, not ended, and 30 days past its count's start. */
export function stillWaitingDue(
  c: { taskId: string | null; state: string; firedAt: Date | null; createdAt: Date; keepWaitingSince: Date | null },
  now: Date,
): boolean {
  if (!c.taskId || c.state === 'ENDED' || c.firedAt !== null) return false;
  return now.getTime() - stillWaitingSince(c).getTime() >= CONDITION_STILL_WAITING_DAYS * DAY_MS;
}

export function stillWaitingKey(conditionId: string, since: Date): string {
  return `condition-still-waiting:${conditionId}:${since.toISOString()}`;
}

function line(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export function stillWaitingCopy(text: string): { title: string; why: string; body: string } {
  return {
    title: line(`Still waiting for ${text}. Keep waiting?`, 120),
    body: line(`It has not held in ${CONDITION_STILL_WAITING_DAYS} days.`, 180),
    why: line(
      `This task starts when ${text}, and that has not held in ${CONDITION_STILL_WAITING_DAYS} days. `
      + `Keep waiting asks again in ${CONDITION_STILL_WAITING_DAYS} days. Stop ends the check; the task stays open, `
      + 'and you can start it yourself.',
      1_000,
    ),
  };
}

export const STILL_WAITING_OPTIONS = [
  { label: CONDITION_STILL_WAITING_OPTIONS[0], description: `Ask again in ${CONDITION_STILL_WAITING_DAYS} days.` },
  { label: CONDITION_STILL_WAITING_OPTIONS[1], description: 'End the check. The task stays open.' },
];

/** File the question; null when its key was already filed, so the owner is asked once per span. */
export async function fileStillWaitingItem(
  tx: Tx,
  filing: { ownerId: string; askedBySessionId: string; conditionId: string; workspaceId: string; key: string; title: string; why: string },
): Promise<string | null> {
  const [row] = await tx.ownerRequest.createManyAndReturn({
    data: [{
      ownerId: filing.ownerId,
      askedBySessionId: filing.askedBySessionId,
      kind: CONDITION_STILL_WAITING_KIND,
      state: 'PENDING',
      title: filing.title,
      why: filing.why,
      options: STILL_WAITING_OPTIONS,
      recommendedOption: 0,
      conditionId: filing.conditionId,
      workspaceId: filing.workspaceId,
      clientRequestId: filing.key,
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * The owner's answer, in the transaction that settles the item: 0 is Keep waiting (the next question is 30 days from
 * now), 1 is Stop (the condition ends; the task keeps its pointer, so it stays OPEN and no scan starts it).
 */
export async function answerStillWaiting(tx: Tx, conditionId: string | null, option: number | undefined, now: Date): Promise<void> {
  if (!conditionId) return;
  if (option === 0) {
    await tx.condition.updateMany({ where: { id: conditionId, state: { not: 'ENDED' } }, data: { keepWaitingSince: now } });
    return;
  }
  if (option === 1) {
    await tx.condition.updateMany({ where: { id: conditionId, state: { not: 'ENDED' } }, data: { state: 'ENDED', endedAt: now } });
    return;
  }
  throw new BadRequestException(`answer a ${CONDITION_STILL_WAITING_KIND} item with option 0 (Keep waiting) or 1 (Stop)`);
}
