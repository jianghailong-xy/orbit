import { RunEventType } from '@orbit/shared';

type EventLike = { type: string; payload?: unknown };

/**
 * The runtime session id a runtime reports in its `system` init/resumed event, or
 * null if this batch carries none. Codex, OpenCode and Antigravity (unlike Claude, whose id is
 * seeded at session creation) surface their runtime thread/session id here, so this is how the
 * server learns the runtime actually came up — letting the reaper's startup watchdog
 * distinguish a live-but-slow first turn from a runtime that never initialized. agy's
 * conversation id is the `sessionId` of the init event the runner makes of agy's own `init`
 * (docs/antigravity-runtime-contract.md §2.2).
 */
export function runtimeInitSessionId(events: EventLike[]): string | null {
  for (const e of events) {
    if (e.type !== RunEventType.SYSTEM) continue;
    const p = e.payload as { subtype?: unknown; sessionId?: unknown } | null;
    if (
      p &&
      (p.subtype === 'init' || p.subtype === 'resumed') &&
      typeof p.sessionId === 'string' &&
      p.sessionId.length > 0
    ) {
      return p.sessionId;
    }
  }
  return null;
}
