import { RunEventType } from '@orbit/shared';

type EventLike = { type: string; turnId?: string | null; payload?: unknown };

/**
 * Whether a durable event batch should advance the session's activity clock.
 *
 * Runtime lifecycle events emitted outside a turn are not user-visible activity. In
 * particular, every reclaimed session emits a fresh system init/resumed event when a
 * runner restarts; treating that handshake as activity makes all idle sessions appear
 * equally recent. System events attributed to a turn still count as liveness, as do
 * session-level background-task events.
 */
export function hasSessionActivity(events: EventLike[]): boolean {
  return events.some((e) => e.type !== RunEventType.SYSTEM || !!e.turnId);
}
