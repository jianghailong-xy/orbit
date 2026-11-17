/**
 * What a condition that cannot be read tells the owner (docs/condition-triggers-design.md §5.3): entering UNKNOWN
 * notifies once and files one CONDITION_UNKNOWN item in Waiting on you, with the last reading, its age and why. A
 * runner asleep (RUNNER_ASLEEP) is shown on the condition and neither notified nor filed (§4.2). A sample that reads
 * again closes the item, WITHDRAWN, by itself.
 *
 * The item is written by the condition's own code, not asked by a session: owner-requests.service.ts delivers its
 * ending to nobody, as it does for the SCHEDULE_* kinds.
 */
import { CONDITION_STILL_WAITING_KIND, CONDITION_WAITING_KIND, type ConditionUnknownReason } from '@orbit/shared';
import type { Prisma } from '@prisma/client';

import { CONDITION_FAILURES_TO_UNKNOWN } from './condition-evaluation';

/** One push. */
export interface ConditionAlert {
  ownerId: string;
  conditionId: string;
  sessionId: string | null;
  ownerRequestId: string | null;
  title: string;
  body: string;
  collapseId: string;
}

export interface ConditionNotifier {
  notify(alert: ConditionAlert): Promise<void>;
}

export const CONDITION_NOTIFIER = Symbol('CONDITION_NOTIFIER');

/** A condition's own items: the can't-read card (§5.3) and the 30-day question (§6.2, condition-still-waiting.ts). */
export function isConditionItemKind(kind: string): boolean {
  return kind === CONDITION_WAITING_KIND || kind === CONDITION_STILL_WAITING_KIND;
}

/** Whether entering UNKNOWN for this reason is told to the owner. */
export function unknownIsNotified(reason: ConditionUnknownReason): boolean {
  return reason !== 'RUNNER_ASLEEP';
}

function line(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** "4 minutes", "2 hours", "3 days": how long ago, rounded down, at least a minute. */
export function ageText(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** A reading as the card shows it: "87%", "2 in", "412 GiB". */
export function readingText(value: number, unit: string | null): string {
  const shown = Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  if (!unit) return shown;
  return unit === '%' ? `${shown}%` : `${shown} ${unit}`;
}

function reasonText(reason: ConditionUnknownReason, silentMs: number): string {
  switch (reason) {
    case 'TIMEOUT': return `The check timed out ${CONDITION_FAILURES_TO_UNKNOWN} times in a row.`;
    case 'ERROR': return `The check failed ${CONDITION_FAILURES_TO_UNKNOWN} times in a row.`;
    case 'RUNNER_OFFLINE': return `No reading has arrived for ${ageText(silentMs)}: its runner may be offline.`;
    case 'RUNNER_ASLEEP': return 'Its runner is asleep, so nothing is checking it.';
  }
}

/** The item and its push: "Can't read: 3 or more OSDs are in" / why, the last reading and its age. */
export function unknownCopy(input: {
  text: string;
  unit: string | null;
  reason: ConditionUnknownReason;
  lastValue: number | null;
  lastReadAt: Date | null;
  /** The newest sample, or the approval when there is none: what the silence is counted from. */
  lastSampleAt: Date | null;
  approvedAt: Date;
  now: Date;
}): { title: string; body: string; why: string } {
  const silentMs = input.now.getTime() - (input.lastSampleAt ?? input.approvedAt).getTime();
  const last = input.lastValue !== null && input.lastReadAt
    ? `The last reading was ${readingText(input.lastValue, input.unit)}, ${ageText(input.now.getTime() - input.lastReadAt.getTime())} ago.`
    : 'It has not been read yet.';
  const reason = reasonText(input.reason, silentMs);
  return {
    title: line(`Can't read: ${input.text}`, 120),
    body: line(`${reason} ${last}`, 180),
    why: line(
      `${reason} ${last} It does not fire while it cannot be read, and its hold starts over. `
      + 'This closes by itself when a check reads again.',
      1_000,
    ),
  };
}

type Tx = Prisma.TransactionClient;

/** The key one UNKNOWN spell files its item under: a replay of the same entry files nothing more. */
export function unknownItemKey(conditionId: string, unknownSince: Date): string {
  return `condition-unknown:${conditionId}:${unknownSince.toISOString()}`;
}

/** File the item; null when its key was already filed (a replay), so the owner is told once. */
export async function fileUnknownItem(
  tx: Tx,
  filing: { ownerId: string; askedBySessionId: string; conditionId: string; workspaceId: string; key: string; title: string; why: string },
): Promise<string | null> {
  const [row] = await tx.ownerRequest.createManyAndReturn({
    data: [{
      ownerId: filing.ownerId,
      askedBySessionId: filing.askedBySessionId,
      kind: CONDITION_WAITING_KIND,
      state: 'PENDING',
      title: filing.title,
      why: filing.why,
      conditionId: filing.conditionId,
      workspaceId: filing.workspaceId,
      clientRequestId: filing.key,
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  return row?.id ?? null;
}

/** Close the condition's PENDING can't-read items, WITHDRAWN: the matter settled by itself. */
export async function closeUnknownItems(tx: Tx, conditionId: string, now: Date): Promise<number> {
  const closed = await tx.ownerRequest.updateMany({
    where: { conditionId, kind: CONDITION_WAITING_KIND, state: 'PENDING' },
    data: { state: 'WITHDRAWN', resolvedAt: now, resolutionNote: 'The condition reads again.' },
  });
  return closed.count;
}
