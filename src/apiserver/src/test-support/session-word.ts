/**
 * The word a session row answers with, for specs that asserted the stored `session.status`. The field left the Prisma
 * model in deploy D3 and the column was dropped in D4 (docs/session-status-retirement-plan.md §4.3, tasks T14 and T15):
 * the word is the projector's over the row's facts (sessions/session-legacy-words.ts).
 * Select the facts with WORD_SELECT; a full row has them. A released LANDING container reads its project_landing
 * settlement: pass it, or read the word with sessionWord.
 */
import type { Prisma } from '@prisma/client';
import { SessionEndReason, type RunStatus } from '@orbit/shared';

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

/**
 * SQL text for the word of the `session` row a raw query names `row` (a constant, never input): the projector's SQL
 * twin over the row's facts, a LANDING container's settlement included. What the specs' raw reads of the word ask.
 */
export const wordSql = (row = 'session'): string =>
  `session_legacy_status(${row}.finished_at, ${row}.turn_state, ${row}.end_reason, ${row}.last_turn_outcome, `
  + `${row}.started_at, ${row}.import_source_cwd, ${row}.kind, `
  + `(SELECT l.settled_as FROM project_landing l WHERE l.session_id = ${row}.id))`;

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

const RELEASED_WORDS: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/**
 * A session helper's `data` with its fixture word (`status`) turned into the facts a writer stores for it, and the
 * word taken out: the turn state of a held word; for a released one the release (`finishedAt`), for SUCCEEDED the
 * `task_done` end its writers ask (a finalize with none reads CANCELLED, plan §3.4 C5) on a run that started (P4),
 * and for FAILED with no end
 * asked the failed turn that records it (every failure writer does, design §12.1). What `data` names itself wins.
 * Data with no word is returned as it is.
 */
export function fixtureFacts<T extends object>(data: T): Omit<T, 'status'> {
  const { status, ...rest } = data as T & { status?: unknown };
  if (status === undefined || status === null) return rest as Omit<T, 'status'>;
  const word = String(status);
  const named = rest as Record<string, unknown>;
  return {
    turnState: turnStateOfWord(word),
    ...(RELEASED_WORDS.has(word) && named.finishedAt === undefined ? { finishedAt: new Date() } : {}),
    ...(word === 'SUCCEEDED' && named.endReason === undefined ? { endReason: SessionEndReason.TASK_DONE } : {}),
    ...(word === 'SUCCEEDED' && named.startedAt === undefined ? { startedAt: new Date() } : {}),
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
