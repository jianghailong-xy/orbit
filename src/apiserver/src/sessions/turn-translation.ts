import {
  DEFAULT_AGENT_LANGUAGE,
  DEFAULT_TRANSLATION_LANGUAGE,
  isTranslationLanguage,
  type TranslationLanguage,
  type TurnTranslation,
  type TurnTranslationState,
} from '@orbit/shared';
import { BadRequestException } from '@nestjs/common';
import { AsyncWorkQueue } from '../common/async-work-queue';
import { translationAvailable } from './translation';

/**
 * The owner's messages under Settings › Translation (@orbit/shared translation.ts, migration 0532).
 *
 * A message sent while the owner has translation on is written HELD: `content` and `display_prompt`
 * both hold what they typed, `translation_state` is TRANSLATING, and status 'HELD' keeps it out of
 * every claim, inbox lease and queue count, which all read PENDING / IN_FLIGHT. The translation runs
 * after the send has answered (SessionsService.translateHeldTurn); success RELEASES the turn — the
 * translation into the account's agent language becomes `content`, status PENDING, and the session is
 * woken exactly as a send would have woken it — and failure or the 20 s timeout leaves it HELD and FAILED, delivered to nobody (1A),
 * until the owner presses Retry or Send as written. A new session's opening message, and a revived
 * session's, are held the same way; the claim does not hand out a PENDING session whose only work is
 * held (queue.service trySessionClaim).
 */

/** The status of a turn that must not be delivered: being translated, or its translation failed. */
export const HELD_TURN_STATUS = 'HELD';

/**
 * What a drain that answers every turn of an ending session leaves alone: the answered turns, and a turn HELD for its
 * translation. A held turn is never leased, so "nothing can be leased after the session ends" holds without it, and
 * conversation_turn_translation_chk refuses ANSWERED beside TRANSLATING or FAILED: answering it failed the whole
 * transaction, and the runner re-posted it every 2 s (production, 2026-11-15 from 22:57Z, a message whose translation
 * had failed). Left HELD, it keeps Retry, Send as written and withdraw.
 */
export const DRAIN_SKIPS_HELD: string[] = ['ANSWERED', HELD_TURN_STATUS];

type PreferencesDb = {
  user: { findUnique(args: { where: { id: string }; select: { preferences: true } }): PromiseLike<{ preferences: unknown } | null> };
};

type TranslationPreferenceKeys = { translationEnabled?: unknown; translationLanguage?: unknown; translationAgentLanguage?: unknown };

/** The two sides of a translation: the owner's language ("Your language") and the agent's ("Agents work in"). */
export interface TranslationLanguages {
  owner: TranslationLanguage;
  agent: TranslationLanguage;
}

async function preferencesOf(db: PreferencesDb, ownerId: string): Promise<TranslationPreferenceKeys | null> {
  const user = await db.user.findUnique({ where: { id: ownerId }, select: { preferences: true } });
  return (user?.preferences ?? null) as TranslationPreferenceKeys | null;
}

function agentLanguageOf(preferences: TranslationPreferenceKeys | null): TranslationLanguage {
  return isTranslationLanguage(preferences?.translationAgentLanguage)
    ? preferences.translationAgentLanguage
    : DEFAULT_AGENT_LANGUAGE;
}

/**
 * The languages the owner's next message is translated between, read on every send, or null when nothing
 * is translated: the server holds no DeepSeek key, the owner's account-wide switch is off (absent = off), or
 * the owner's language is the agent's — there is nothing to translate then, exactly as with the switch off.
 * An absent agent language is English (DEFAULT_AGENT_LANGUAGE), as every account had before it could be chosen.
 */
export async function translationLanguages(db: PreferencesDb, ownerId: string): Promise<TranslationLanguages | null> {
  if (!translationAvailable()) return null;
  const preferences = await preferencesOf(db, ownerId);
  if (preferences?.translationEnabled !== true) return null;
  const owner = isTranslationLanguage(preferences.translationLanguage)
    ? preferences.translationLanguage
    : DEFAULT_TRANSLATION_LANGUAGE;
  const agent = agentLanguageOf(preferences);
  return owner === agent ? null : { owner, agent };
}

/** The account's agent language alone, whatever the switch says: what a held message is translated into
 *  when its translation runs (a held turn records only the language it was written in). */
export async function accountAgentLanguage(db: PreferencesDb, ownerId: string): Promise<TranslationLanguage> {
  return agentLanguageOf(await preferencesOf(db, ownerId));
}

/** The longest `optimizedTranslation` a send may carry. */
export const OPTIMIZED_TRANSLATION_MAX_CHARS = 64_000;

/**
 * A send's `optimizedTranslation` (prompt optimizer D2, @orbit/shared prompt-optimizer.ts): the optimizer's prompt
 * in the agent language, sent beside the owner-language text Use put in the box. The message is held as any
 * translated message is, and released with this text instead of a translator call. Null when absent or blank;
 * anything but a string, or a longer one than OPTIMIZED_TRANSLATION_MAX_CHARS, is a 400.
 */
export function readOptimizedTranslation(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException('optimizedTranslation must be a string');
  if (value.length > OPTIMIZED_TRANSLATION_MAX_CHARS) {
    throw new BadRequestException(`optimizedTranslation must be at most ${OPTIMIZED_TRANSLATION_MAX_CHARS} characters`);
  }
  return value.trim() ? value : null;
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
