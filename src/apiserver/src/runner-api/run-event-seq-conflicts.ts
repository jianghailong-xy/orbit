import type { Prisma } from '@prisma/client';
import { toUuid, type NormalizedRunEvent } from '@orbit/shared';

import { TOMBSTONE_EVENT_TYPE } from '../common/system-noise';

/**
 * An event that arrives at a seq the session already holds a different event at (task 34mumXbJjOvZUwNmDNzmY).
 *
 * The runner numbers a session's events, and the server stores each seq once: over HTTPS `createMany` skips a row
 * whose (session, seq) is taken, and over the runner link the ingest leaves out every seq already stored (ingestEvents).
 * That is what makes a batch sent again harmless. It is also what made a lost event invisible: on 2026-10-27 a runner
 * restarted with ORBIT_LINK_MODE=off numbered its events from the server's last seq while the events an earlier process
 * left in its spool were still unsent, and when they were sent, the 12 whose seqs it had taken were acknowledged as
 * stored without a word. Ticks 6 to 17 of the session were gone, and nothing on either side said so.
 *
 * So an event found at a stored seq is compared with the row there. The same event sent again (a lost answer, the spool
 * sent after a restart) matches it: same type, same turn, same time, the runner's own. One that does not is another
 * event, which nothing will store: it is logged, as an error, and counted (orbit_run_event_seq_conflicts_total, served
 * at GET /api/metrics), and the batch is answered as before.
 *
 * Not refused. Refusing cannot make the event storable, since its seq holds another event; a retryable refusal would
 * hold back every later event of the session behind it; EventAck.rejected says a tombstone holds the seq (§5.8, proto
 * EventAck), which is not so here, and a refused CURRENT_WORK acknowledgement fails the runner's next flushes, which
 * for an event of an earlier process would fail the turns of this one; and HTTPS has no refusal of one event at all.
 * Since the runner never numbers over its spool any more, a conflict is an older runner's doing (a release without the
 * spool, docs/runner-link-design.md §11.4) or a fault, which the log line and the count make visible.
 *
 * The payload is not compared: the ingest rewrites what it stores (a note on a user turn, a pool switch notice, a
 * sanitized byte), so a resend would read as another event. Type, turn and the runner's time tell two events apart.
 */

/** What tells two events at one seq apart. */
export interface RunEventIdentity {
  type: string;
  turnId: string | null;
  /** The runner's time for it, in Unix milliseconds: run_event.created_at. */
  atMs: number;
}

/** An event the session did not store because its seq holds another. */
export interface RunEventSeqConflict {
  seq: number;
  incoming: RunEventIdentity;
  stored: RunEventIdentity;
}

/** Which way the event came. */
export type RunEventDoor = 'https' | 'link';

type StoredRow = { seq: number; type: string; turnId: string | null; createdAt: Date };

/**
 * The events of a batch whose seq the session holds another event at, read inside the ingest's transaction, under the
 * session's lock. `events` are the batch's storable ones (no noise ping, nothing live) at seqs found stored. A batch
 * sent again whole reads every one of its rows back, so payloads are read only of the tombstones among them.
 */
export async function runEventSeqConflicts(
  tx: Pick<Prisma.TransactionClient, 'runEvent'>,
  sessionId: string,
  events: readonly NormalizedRunEvent[],
): Promise<RunEventSeqConflict[]> {
  if (events.length === 0) return [];
  const rows = (await tx.runEvent.findMany({
    where: { sessionId, seq: { in: events.map((e) => e.seq) } },
    select: { seq: true, type: true, turnId: true, createdAt: true },
  })) as StoredRow[];
  const bySeq = new Map(rows.map((row) => [row.seq, row]));
  const tombstoned = rows.filter((row) => row.type === TOMBSTONE_EVENT_TYPE).map((row) => row.seq);
  const refusedTypes = new Map<number, unknown>(tombstoned.length === 0 ? [] : (await tx.runEvent.findMany({
    where: { sessionId, seq: { in: tombstoned } },
    select: { seq: true, payload: true },
  })).map((row) => [row.seq, (row.payload as { type?: unknown } | null)?.type]));
  const conflicts: RunEventSeqConflict[] = [];
  for (const event of events) {
    const row = bySeq.get(event.seq);
    if (!row) continue;
    const incoming: RunEventIdentity = { type: event.type, turnId: turnOf(event.turnId), atMs: new Date(event.ts).getTime() };
    const storedTurn = turnOf(row.turnId);
    if (row.type === TOMBSTONE_EVENT_TYPE) {
      // A tombstone holds a refused event's seq, with the event's type and turn (link-events.ts tombstoneRow); its time
      // is the receive time when the event's was not legible. The same event sent again is refused again.
      if (refusedTypes.get(row.seq) === incoming.type && storedTurn === incoming.turnId) continue;
    } else if (row.type === incoming.type && storedTurn === incoming.turnId && row.createdAt.getTime() === incoming.atMs) {
      continue;
    }
    conflicts.push({ seq: event.seq, incoming, stored: { type: row.type, turnId: storedTurn, atMs: row.createdAt.getTime() } });
  }
  return conflicts;
}

/** A turn id as run_event.turn_id holds it, whichever form it came in; null for none. */
function turnOf(turnId: string | null | undefined): string | null {
  if (!turnId) return null;
  try {
    return toUuid(turnId);
  } catch {
    return turnId;
  }
}

/** The conflicts as a log line's tail: the first ten, each as what came and what the seq holds. */
export function describeRunEventSeqConflicts(conflicts: readonly RunEventSeqConflict[]): string {
  const one = (id: RunEventIdentity) =>
    `${id.type} (${id.turnId ? `turn ${id.turnId}` : 'no turn'}, ${Number.isFinite(id.atMs) ? new Date(id.atMs).toISOString() : 'no time'})`;
  const parts = conflicts.slice(0, 10).map((c) => `seq ${c.seq}: ${one(c.incoming)} where it holds ${one(c.stored)}`);
  if (conflicts.length > parts.length) parts.push('…');
  return parts.join('; ');
}

// ── The count ──────────────────────────────────────────────────────────────────────────────────

const COUNTER = 'orbit_run_event_seq_conflicts_total';
const HELP = 'Events not stored because their seq already held a different event of the session, by the door they came by.';
const DOORS: readonly RunEventDoor[] = ['https', 'link'];
const counts = new Map<RunEventDoor, number>();

/** Counts n conflicts that came by door, and says how many have come by it since this process started. */
export function countRunEventSeqConflicts(door: RunEventDoor, n: number): number {
  const total = (counts.get(door) ?? 0) + n;
  counts.set(door, total);
  return total;
}

/** The counter in Prometheus text exposition format, each door's series there from the start. */
export function renderRunEventSeqConflictMetrics(): string {
  const lines = [`# HELP ${COUNTER} ${HELP}`, `# TYPE ${COUNTER} counter`];
  for (const door of DOORS) lines.push(`${COUNTER}{door="${door}"} ${counts.get(door) ?? 0}`);
  return `${lines.join('\n')}\n`;
}

/** Each door's count. For tests. */
export function runEventSeqConflictsSnapshot(): Record<RunEventDoor, number> {
  return { https: counts.get('https') ?? 0, link: counts.get('link') ?? 0 };
}

/** Zero the count. For tests; nothing in the server calls it. */
export function resetRunEventSeqConflictMetrics(): void {
  counts.clear();
}
