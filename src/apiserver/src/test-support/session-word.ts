/**
 * The word a session row answers with, for specs that asserted the stored `session.status`. Since deploy D3 the field
 * is not in the Prisma model (docs/session-status-retirement-plan.md §4.3, task T14): the word is the projector's over
 * the row's facts (sessions/session-legacy-words.ts), which migration 1671's trigger also stores, for rollback only.
 * Select the facts with WORD_SELECT; a full row has them. A released LANDING container reads its project_landing
 * settlement: pass it, or read the word with sessionWord.
 */
import type { Prisma } from '@prisma/client';
import type { RunStatus } from '@orbit/shared';

import {
  LEGACY_STATUS_SELECT,
  legacySessionStatus,
  type LandingSettlement,
  type LegacyStatusFacts,
  readLandingSettlements,
} from '../sessions/session-legacy-words';
import { turnStateOfWord } from '../sessions/session-turn-state';

/** The columns wordOf reads. */
export const WORD_SELECT = LEGACY_STATUS_SELECT;

/** The word of a row read with WORD_SELECT (or whole). */
export function wordOf(row: LegacyStatusFacts, landing?: LandingSettlement | null): `${RunStatus}` {
  return legacySessionStatus(row, landing);
}

/** The word of the session `id`, its landing settlement included; null when there is no such session. */
export async function sessionWord(
  db: Pick<Prisma.TransactionClient, 'session' | 'projectLanding'>,
  id: string,
): Promise<`${RunStatus}` | null> {
  const row = await db.session.findUnique({ where: { id }, select: { id: true, ...WORD_SELECT } });
  if (!row) return null;
  return legacySessionStatus(row, (await readLandingSettlements(db, [row])).get(id));
}

/**
 * What a spec's session helper takes: the row's columns, and `status`, the word it names the session's state by. The
 * helper turns the word into the facts (turnStateOfWord, and the release beside a released word) and never writes it.
 */
export type SessionFixture = Partial<Prisma.SessionUncheckedCreateInput> & { status?: RunStatus | `${RunStatus}` };

/**
 * The word a session write leaves on a row that ran (started, a conversation): what a unit double that recorded the
 * written `status` records now that writers write the facts. `data` is the write's `data`.
 */
export function wordOfWrite(data: Record<string, unknown>): `${RunStatus}` {
  return legacySessionStatus({
    finishedAt: (data.finishedAt as Date | null | undefined) ?? null,
    turnState: (data.turnState as string | null | undefined) ?? null,
    endReason: (data.endReason as string | null | undefined) ?? null,
    lastTurnOutcome: (data.lastTurnOutcome as string | null | undefined) ?? null,
    startedAt: new Date(0),
    importSourceCwd: (data.importSourceCwd as string | null | undefined) ?? null,
    sessionKind: 'CONVERSATION',
  });
}

/** The word a session write sets, or undefined when it names neither the turn state nor the release: wordOfWrite for a
 *  write that moves the session's state. */
export function writtenWord(data: Record<string, unknown> | null | undefined): `${RunStatus}` | undefined {
  if (!data || !('turnState' in data || 'finishedAt' in data)) return undefined;
  return wordOfWrite(data);
}

/**
 * The word in the column session.status, which since deploy D3 only migration 1671's trigger writes, from the facts,
 * for a rollback to deploy-2 code. Read only by the specs that show that trigger keeps it equal to the projector's
 * word; it goes with the column in deploy D4 (task T15).
 */
export async function storedWord(db: Pick<Prisma.TransactionClient, '$queryRaw'>, id: string): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ word: string }>>`SELECT "status"::text AS word FROM "session" WHERE "id" = ${id}::uuid`;
  return rows[0]?.word ?? null;
}

const RELEASED_WORDS: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * A session helper's `data` with its fixture word (`status`) turned into the facts a writer stores for it, and the
 * word taken out: the turn state of a held word; for a released one the release (`finishedAt`), and for FAILED with
 * no end asked the failed turn that records it (every failure writer does, design §12.1). What `data` names itself
 * wins. Data with no word is returned as it is.
 */
export function fixtureFacts<T extends object>(data: T): Omit<T, 'status'> {
  const { status, ...rest } = data as T & { status?: unknown };
  if (status === undefined || status === null) return rest as Omit<T, 'status'>;
  const word = String(status);
  const named = rest as Record<string, unknown>;
  return {
    turnState: turnStateOfWord(word),
    ...(RELEASED_WORDS.has(word) && named.finishedAt === undefined ? { finishedAt: new Date() } : {}),
    ...(word === 'FAILED' && named.lastTurnOutcome === undefined && !named.endReason ? { lastTurnOutcome: 'FAILED' } : {}),
    ...rest,
  } as unknown as Omit<T, 'status'>;
}

/**
 * A row read with WORD_SELECT, shaped as it read when it selected `status`: the word under `status`, and the fact
 * columns WORD_SELECT added taken back out, but for the ones the caller selected itself (`kept`). For the specs that
 * compare a whole row with what they expect of it.
 */
export function withWord<T extends LegacyStatusFacts>(row: T, ...kept: Array<keyof LegacyStatusFacts>): Record<string, unknown> {
  const out: Record<string, unknown> = { status: wordOf(row) };
  for (const [key, value] of Object.entries(row)) {
    if (key in WORD_SELECT && !kept.includes(key as keyof LegacyStatusFacts)) continue;
    out[key] = value;
  }
  return out;
}
