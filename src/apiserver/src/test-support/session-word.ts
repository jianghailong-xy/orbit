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
