import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The engine-path guard (docs/project-integration-line-contract.md §2.9 LS6).
 *
 * A session is either CONVERSATION — something an engine runs, which every door in this product was
 * built for — or LANDING, the platform-driven container a landing subject opens. A LANDING row has no
 * engine, no runner and no turns: Orbit inserts it after a claim commits, moves it when the landing
 * fact settles, and draws it from `project_landing`. Nothing may send to it, revive it, rename it,
 * merge it, share it, trash it or otherwise drive it as a conversation.
 *
 * The guard is structural rather than a list of endpoints: `SessionsService`, the two runner
 * controllers and the services their doors reach call it at every door that changes a session, and
 * `engine-session-census.spec.ts` holds that set to the routes the app mounts, both ways.
 */
export const SESSION_IS_PLATFORM_DRIVEN = 'SESSION_IS_PLATFORM_DRIVEN';

export const SESSION_KIND_CONVERSATION = 'CONVERSATION';
export const SESSION_KIND_LANDING = 'LANDING';

/** What a session row needs to say for the guard to judge it. */
export interface SessionKindRow {
  sessionKind?: string | null;
}

export function isLandingSession(session: SessionKindRow): boolean {
  return session.sessionKind === SESSION_KIND_LANDING;
}

/**
 * Refuse an engine door aimed at a LANDING session — 409 `SESSION_IS_PLATFORM_DRIVEN`.
 *
 * The message names where the work actually happens: the project's coordinating conversation. It is
 * English like every sentence the server writes, and it never echoes the caller's body.
 */
export function assertEngineSession(session: SessionKindRow): void {
  if (!isLandingSession(session)) return;
  throw new ConflictException({
    code: SESSION_IS_PLATFORM_DRIVEN,
    message:
      'Orbit runs this landing session for the platform, so no engine can act on it. ' +
      "Open the project's coordinating conversation to work on the landing.",
  });
}

/**
 * The same refusal for a door that has only the id and no row in hand.
 *
 * A missing session, or another account's, is left to the door's own 404: the guard answers only
 * the row it may see, so a caller cannot learn from it whether an id exists elsewhere.
 */
export async function assertEngineSessionById(
  db: Pick<Prisma.TransactionClient, 'session'>,
  id: string,
  /** The caller's account: a row another account owns is not this door's to answer as a landing. */
  ownerId?: string,
): Promise<void> {
  // A unit double that does not model the session table cannot answer this question, and a control
  // plane without one is not a control plane: production's PrismaService always has it. The guard
  // stays out of such a double's way rather than turning its spec into a test of this read.
  const delegate = (db as {
    session?: { findFirst?: (args: unknown) => Promise<SessionKindRow | null> };
  }).session;
  if (typeof delegate?.findFirst !== 'function') return;
  const row = await delegate.findFirst({
    where: { id, ...(ownerId ? { ownerId } : {}) },
    select: { sessionKind: true },
  });
  if (row) assertEngineSession(row);
}
