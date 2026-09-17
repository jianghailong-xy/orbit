import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { CoordinatorSpend, CoordinatorSpendReason } from './coordinator-convergence';
import type { WakeAuthorization, WakeAuthorizer } from './coordinator-wake.service';

/**
 * A crossed spend fuse, as a thing rather than a silence
 * (`docs/project-integration-line-contract.md` §6.2–§6.5).
 *
 * WHAT A PAUSE IS
 * ===============
 * `coordinator-convergence.ts` §3 decides WHETHER a coordinator has spent more than it may on its
 * own. This module is what that conclusion becomes: an episode row saying what was read and when,
 * a card the account owner can act on, a place to keep what the coordinator tried to start
 * meanwhile, and the one refusal a pause is allowed to make. The durable half is
 * `project-fuse.service.ts`; what is here is the vocabulary, the copy and the two readings that
 * have to be made in places that must not depend on a service.
 *
 * WHAT A PAUSE IS NOT
 * ===================
 * It is not a stop on the project. Tasks keep running and landing, and every external fact — a
 * task's status, a merge receipt, an answer from the owner — is delivered or recorded exactly as it
 * would be otherwise (§6.4 F6). A pause holds what the AGENT starts, and refuses exactly one thing:
 * spending a new judgment session on a fact while the conversation that would judge it is over its
 * budget (F-T3). That refusal releases the fact's key and records nothing keyed to the fact, which
 * is the whole difference from the breaker it replaces — that one committed a judgment against the
 * project's scope, so the same fact was answered the same way for ever.
 *
 * AND IT CANNOT HOLD EVERYTHING
 * =============================
 * An engine that decides to start a turn by itself does so inside its own process; Orbit learns
 * about it when the turn's events arrive. So those turns are COUNTED and not held (§6.4 F8), and
 * the card says so in as many words. A card that implied otherwise would be offering the owner a
 * recovery path the platform does not have.
 */

/** Which kind of autonomous spend crossed. The fuse's own reasons, not a second set. */
export type FuseDimension = CoordinatorSpendReason;

/**
 * What a pause may hold (§6.4 F7): the things a coordinator conversation STARTS. Only
 * `SESSION_CREATE` has a door that holds today; the rest are their own tasks' to wire, and are
 * named here because the column's CHECK names them.
 */
export const FUSE_HELD_ACTION_KINDS = [
  'SESSION_CREATE',
  'TASK_START',
  'SESSION_SEND',
  'TASK_SUCCESSOR',
  'SELF_WAKE',
] as const;
export type FuseHeldActionKind = (typeof FUSE_HELD_ACTION_KINDS)[number];

/** Held, put back through its door, or refused by that door the second time (§6.5 F9). */
export const FUSE_HELD_ACTION_STATES = ['HELD', 'REPLAYED', 'DROPPED'] as const;
export type FuseHeldActionState = (typeof FUSE_HELD_ACTION_STATES)[number];

/**
 * The one refusal a pause makes, and the code both halves of it are found by: the wake row it
 * writes, and the re-derivation that reads those rows back after the resume (§6.5 F10).
 */
export const PROJECT_FUSE_PAUSED = 'PROJECT_FUSE_PAUSED';

/** Only the account owner resumes: a session holding their credential is not them (§6.3 F-T4). */
export const FUSE_RESUME_OWNER_ONLY = 'FUSE_RESUME_OWNER_ONLY';

/** §4.2's key for the card. Per EPISODE, which is what makes the next pause a new card. */
export function fusePausedDedupeKey(episodeId: string): string {
  return `FP:${episodeId}`;
}

/** §4.2's title, from the effect drawing. Written once and never recomputed. */
export const FUSE_PAUSED_TITLE = 'The coordinator paused itself';

/** §4.2's payload for a `FUSE_PAUSED` item. */
export interface FusePausedPayload {
  dimension: FuseDimension;
  observed: number;
  limit: number;
  /** All three kinds at the reading, so the card says what the day cost and not only what crossed. */
  spendToday: CoordinatorSpend;
  /** How many of the coordinator's own actions this pause is holding, as of now. */
  heldCount: number;
}

/** Which spend crossed, in the words the owner reads it in. */
function why(payload: FusePausedPayload): string {
  const { observed, limit } = payload;
  switch (payload.dimension) {
    case 'SELF_STARTED_TURNS':
      return `It started ${observed} turns on its own today — the limit is ${limit}`;
    case 'SESSIONS_OPENED':
      return `It opened ${observed} sessions today — the limit is ${limit}`;
    case 'SUCCESSOR_RETRIES':
      return `It retried one piece of work ${observed} times — the limit is ${limit}`;
    default:
      return `It spent ${observed} of the ${limit} it may spend on its own today`;
  }
}

/** What the pause is holding, when it is holding anything. */
function onHold(held: number): string {
  if (held <= 0) return 'Nothing it would have started is on hold';
  return held === 1
    ? '1 thing it would have started is on hold, and goes out as soon as you resume'
    : `${held} things it would have started are on hold, and they go out as soon as you resume`;
}

/**
 * The line under the card's title (§4.8): why it paused, what the day cost, what is still running,
 * what is waiting for the owner — and the one thing resuming does not buy.
 *
 * English, because it is the copy a person reads. Every clause is a fact from the payload or a
 * property of the pause itself; the last one is there because it is the limit of what a pause can
 * promise, and a card that left it out would be describing a stronger platform than this one.
 */
export function fusePausedDetailLine(payload: FusePausedPayload): string {
  const spend = payload.spendToday;
  return `${why(payload)}. `
    + `Spent today: ${spend.selfStartedTurns} self-started turns · `
    + `${spend.sessionsOpened} sessions opened · ${spend.successorRetries} retries on one chain. `
    + 'Tasks keep running and landing; task results, merges and your answers still reach it. '
    + `${onHold(payload.heldCount)}. `
    + 'What it starts inside its own engine cannot be held: those turns are counted, not held.';
}

/**
 * The project's open pause, or null. Read rather than injected, so the two callers that must not
 * depend on the fuse service — the unit that decides what an authorized wake is spent on, and the
 * door an agent knocks on — can ask without acquiring it.
 */
export async function openFuseEpisodeId(
  db: PrismaService | Prisma.TransactionClient,
  projectId: string,
): Promise<string | null> {
  const [row] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "project_fuse_episode"
     WHERE "project_id" = ${projectId}::uuid AND "resumed_at" IS NULL
  `);
  return row?.id ?? null;
}

/**
 * The pause's one refusal (§6.3 F-T3), wrapped around the authorizer whose fact it is.
 *
 * It runs BEFORE the authorizer it wraps, and that order is the point: the last thing every
 * producer's authorizer does is record a judgment in the convergence ledger, keyed by the project's
 * scope and the fact's own key. A refusal recorded after that would leave a committed judgment for
 * a fact nobody acted on, and the next delivery of the same fact — after the resume, with the same
 * scope and the same key — would read that judgment back instead of taking one. The wake row this
 * refusal leaves is outside 0174's partial unique index, so the key is released and the fact can be
 * claimed again; nothing else about it is written down.
 */
export function refusingWhileFusePaused(
  authorize: WakeAuthorizer,
  pausedEpisodeId: () => Promise<string | null>,
): WakeAuthorizer {
  return async (fact, claim): Promise<WakeAuthorization> => {
    if (await pausedEpisodeId()) return { allowed: false, refusalCode: PROJECT_FUSE_PAUSED };
    return authorize(fact, claim);
  };
}
