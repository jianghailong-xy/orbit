import {
  DEFAULT_TRANSLATION_LANGUAGE,
  isTranslationLanguage,
  type TranslationLanguage,
  type TurnTranslation,
  type TurnTranslationState,
} from '@orbit/shared';
import { AsyncWorkQueue } from '../common/async-work-queue';
import { translationAvailable } from './translation';

/**
 * The owner's messages under Settings › Translation (@orbit/shared translation.ts, migration 0531).
 *
 * A message sent while the owner has translation on is written HELD: `content` and `display_prompt`
 * both hold what they typed, `translation_state` is TRANSLATING, and status 'HELD' keeps it out of
 * every claim, inbox lease and queue count, which all read PENDING / IN_FLIGHT. The translation runs
 * after the send has answered (SessionsService.translateHeldTurn); success RELEASES the turn — the
 * English becomes `content`, status PENDING, and the session is woken exactly as a send would have
 * woken it — and failure or the 20 s timeout leaves it HELD and FAILED, delivered to nobody (1A),
 * until the owner presses Retry or Send as written. A new session's opening message, and a revived
 * session's, are held the same way; the claim does not hand out a PENDING session whose only work is
 * held (queue.service trySessionClaim).
 */

/** The status of a turn that must not be delivered: being translated, or its translation failed. */
export const HELD_TURN_STATUS = 'HELD';

/**
 * The language the owner's next message is translated from, or null when it is not translated: the
 * server holds no DeepSeek key, or the owner's account-wide switch is off (absent = off).
 */
export async function ownerTranslationLanguage(
  db: { user: { findUnique(args: { where: { id: string }; select: { preferences: true } }): PromiseLike<{ preferences: unknown } | null> } },
  ownerId: string,
): Promise<TranslationLanguage | null> {
  if (!translationAvailable()) return null;
  const user = await db.user.findUnique({ where: { id: ownerId }, select: { preferences: true } });
  const preferences = (user?.preferences ?? null) as { translationEnabled?: unknown; translationLanguage?: unknown } | null;
  if (preferences?.translationEnabled !== true) return null;
  return isTranslationLanguage(preferences.translationLanguage)
    ? preferences.translationLanguage
    : DEFAULT_TRANSLATION_LANGUAGE;
}

/** The columns a held message is written with. */
export function heldTurnColumns(content: string, from: TranslationLanguage) {
  return {
    status: HELD_TURN_STATUS,
    displayPrompt: content,
    translationState: 'TRANSLATING' as TurnTranslationState,
    translationLang: from,
  };
}

/** A turn row's `translation` as the wire carries it, or undefined when translation was not involved. */
export function turnTranslationOf(turn: {
  displayPrompt?: string | null;
  translationState?: string | null;
  translationLang?: string | null;
}): TurnTranslation | undefined {
  if (turn.displayPrompt == null || !turn.translationState || !isTranslationLanguage(turn.translationLang)) return undefined;
  return {
    state: turn.translationState as TurnTranslationState,
    from: turn.translationLang,
    original: turn.displayPrompt,
  };
}

/** How many translations run at once on one apiserver; the rest wait their turn in memory. */
export const TURN_TRANSLATION_CONCURRENCY = 4;
export const turnTranslationQueue = new AsyncWorkQueue(TURN_TRANSLATION_CONCURRENCY);
