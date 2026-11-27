/**
 * The agent's Run now offer in a Scheduled page chat (docs/scheduled-chat-design.md §4.6). The agent never presses Run
 * now as a session; it answers with a link `[Run now](orbit-run-now:<schedule id>)`, and the client draws the button
 * where it said so. The press goes through the owner channel (`POST /api/schedules/:id/run`), so it is the person's and
 * counts toward no budget.
 */
import { api } from '../api';
import type { ScheduleRunView } from '@orbit/shared';

const OFFER = /orbit-run-now:([A-Za-z0-9_-]+)/g;

export interface RunNowOffer {
  scheduleId: string;
  seq: number;
  at: string;
}

/** Each schedule an assistant message offered to run, once per message, in the order said. */
export function runNowOffers(
  events: ReadonlyArray<{ seq: number; type?: string; ts?: string; payload?: unknown }>,
): RunNowOffer[] {
  const out: RunNowOffer[] = [];
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const text = (event.payload as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string') continue;
    const seen = new Set<string>();
    for (const match of text.matchAll(OFFER)) {
      if (seen.has(match[1]!)) continue;
      seen.add(match[1]!);
      out.push({ scheduleId: match[1]!, seq: event.seq, at: event.ts ?? '' });
    }
  }
  return out;
}

/** `POST /api/schedules/:id/run`: the person's own press, from the owner (never the session). */
export const pressRunNow = (scheduleId: string): Promise<{ run: ScheduleRunView }> =>
  api<{ run: ScheduleRunView }>(`/schedules/${encodeURIComponent(scheduleId)}/run`, { method: 'POST' });
