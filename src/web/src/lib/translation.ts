// Settings › Translation on the web (board docs/mocks/session-translation/01-board.png). The server
// owns the feature (@orbit/shared translation.ts); everything here only reads the fields it writes.
import {
  DEFAULT_AGENT_LANGUAGE,
  DEFAULT_TRANSLATION_LANGUAGE,
  isTranslationFailureReason,
  isTranslationLanguage,
  TRANSLATION_FAILED_CODE,
  TRANSLATION_LANGUAGE_NAMES,
  type ApprovalTranslation,
  type ReplyTranslation,
  type TranslationEventPayload,
  type TranslationFailureReason,
  type TranslationLanguage,
  type TurnTranslation,
  TRANSLATION_UNAVAILABLE_TAG,
  type ProjectTextTranslation,
} from '@orbit/shared';
import { useEffect, useState } from 'react';
import type { Me } from './queries';

/** The copy every client shows, kept identical across Web, iOS/macOS and Android. */
export const TRANSLATION_COPY = {
  translated: 'Translated',
  showOriginal: 'Show original',
  hideOriginal: 'Hide original',
  // Not "Show original": that one swaps the translation for the original.
  showBoth: 'Show both',
  showTranslation: 'Show translation',
  original: 'Original',
  translating: 'Translating…',
  sendFailed: "Couldn't translate, so it wasn't sent",
  retry: 'Retry',
  sendAsWritten: 'Send as written',
  cancel: 'Cancel',
  replyPending: 'Translates when the reply is done',
  replyFailed: "Couldn't translate this reply",
  // "Show both languages" (docs/mocks/session-translation/02-bilingual.png).
  sentToAgent: 'Sent to the agent in',
  show: 'Show',
  lines: 'lines',
} as const;

/** Under the owner's bilingual message: "Sent to the agent in English", naming the agent language. */
export function sentToAgentLabel(agentLang: TranslationLanguage): string {
  return `${TRANSLATION_COPY.sentToAgent} ${TRANSLATION_LANGUAGE_NAMES[agentLang]}`;
}

/** The collapsed original's press (board frame 3): "Show English · 9 lines", naming the agent language. */
export function showEnglishLabel(lines: number, agentLang: TranslationLanguage): string {
  return `${TRANSLATION_COPY.show} ${TRANSLATION_LANGUAGE_NAMES[agentLang]} · ${lines} ${TRANSLATION_COPY.lines}`;
}

/** The language the account writes and reads in, absent = the default pick. */
export function translationLanguageOf(me: Me | undefined): TranslationLanguage {
  const lang = me?.preferences?.translationLanguage;
  return isTranslationLanguage(lang) ? lang : DEFAULT_TRANSLATION_LANGUAGE;
}

/** The language agents work in ("Agents work in"), absent = English. */
export function agentLanguageOf(me: Me | undefined): TranslationLanguage {
  const lang = me?.preferences?.translationAgentLanguage;
  return isTranslationLanguage(lang) ? lang : DEFAULT_AGENT_LANGUAGE;
}

/** An owner card's `translation` when it is in the owner's language and translation is switched on;
 *  undefined when there is none, it failed, or it is in a language the owner no longer reads. */
export function ownerLanguageTranslation<T extends { lang: TranslationLanguage; failed?: true }>(
  translation: T | null | undefined,
  me: Me | undefined,
): T | undefined {
  if (!translation || translation.failed || me?.preferences?.translationEnabled !== true) return undefined;
  return translation.lang === translationLanguageOf(me) ? translation : undefined;
}

/** A criterion's text from the project's `translation` (ProjectTextTranslation, already picked for the
 *  reader), matched by id; the original when it holds none for that criterion. */
export function criterionTextIn(translation: ProjectTextTranslation | undefined, id: string, original: string): string {
  return translation?.criteria?.find((criterion) => criterion.id === id)?.text || original;
}

/** An owner card's answer door refused the owner's words 422 TRANSLATION_FAILED: nothing was recorded,
 *  and the card offers Retry and Send as written. Read off the error's fields, so a card need not
 *  import the api module's class to ask. */
export function answerRefusedUntranslated(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null;
  return !!e && typeof e === 'object' && e.status === 422 && e.code === TRANSLATION_FAILED_CODE;
}

/** Why a 422 TRANSLATION_FAILED refused the owner's words (TranslationFailedBody), read off the error's body; empty
 *  when it says none (an older server), which draws the generic line. */
export function refusalReasonOf(err: unknown): { failureReason?: TranslationFailureReason; httpStatus?: number } {
  const body = (err as { body?: { failureReason?: unknown; httpStatus?: unknown } } | null)?.body;
  if (!body || !isTranslationFailureReason(body.failureReason)) return {};
  return {
    failureReason: body.failureReason,
    ...(typeof body.httpStatus === 'number' ? { httpStatus: body.httpStatus } : {}),
  };
}

/** Whether translation is unavailable now (frame 6): /users/me's `translationUnavailableUntil` is in the future. */
export function translationUnavailableAt(me: Me | undefined, now: number): boolean {
  const until = me?.translationUnavailableUntil ? Date.parse(me.translationUnavailableUntil) : NaN;
  return Number.isFinite(until) && until > now;
}

/** `translationUnavailableAt` now, turning false by itself when `translationUnavailableUntil` passes: the server
 *  announces nothing then (the breaker closes on the next call), so a timer, not a refetch, ends it. */
export function useTranslationUnavailable(me: Me | undefined): boolean {
  const until = me?.translationUnavailableUntil ?? null;
  const [, expire] = useState(0);
  const unavailable = translationUnavailableAt(me, Date.now());
  useEffect(() => {
    if (!unavailable || !until) return;
    const timer = setTimeout(() => expire((n) => n + 1), Math.max(0, Date.parse(until) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [unavailable, until]);
  return unavailable;
}

/** The composer tag while translation is unavailable (frame 6): "Chinese → English · unavailable, messages will wait". */
export function unavailableTranslationTag(lang: TranslationLanguage, agentLang: TranslationLanguage = DEFAULT_AGENT_LANGUAGE): string {
  return `${translationTag(lang, agentLang)} · ${TRANSLATION_UNAVAILABLE_TAG}`;
}

/** Whether the owner's messages are being translated now: switched on, and the server able to. */
export function translationOn(me: Me | undefined): boolean {
  return me?.preferences?.translationEnabled === true && me.translationAvailable === true;
}

/** Whether translated messages also show the agent-language text the agent read or wrote ("Show both
 *  languages"): the account's switch, drawn only while translation itself is switched on. */
export function bilingualOn(me: Me | undefined): boolean {
  return me?.preferences?.translationEnabled === true && me.preferences.translationBilingual === true;
}

/** A language's name without its parenthesis: "Chinese (Simplified)" → "Chinese". */
function shortLanguageName(lang: TranslationLanguage): string {
  return TRANSLATION_LANGUAGE_NAMES[lang].replace(/\s*\(.*\)$/, '');
}

/** The composer tag (6A): "<Language> → <Agent language>", both without their parenthesis. */
export function translationTag(lang: TranslationLanguage, agentLang: TranslationLanguage = DEFAULT_AGENT_LANGUAGE): string {
  return `${shortLanguageName(lang)} → ${shortLanguageName(agentLang)}`;
}

/** A `user` event's or a turn row's `translation`, when it is one. */
export function turnTranslationOf(value: unknown): TurnTranslation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Partial<TurnTranslation>;
  if (typeof t.original !== 'string' || !isTranslationLanguage(t.from)) return undefined;
  if (t.state !== 'TRANSLATING' && t.state !== 'FAILED' && t.state !== 'DONE' && t.state !== 'SENT_AS_WRITTEN') {
    return undefined;
  }
  return {
    state: t.state,
    from: t.from,
    original: t.original,
    ...(t.state === 'FAILED' && isTranslationFailureReason(t.failureReason) ? { failureReason: t.failureReason } : {}),
    ...(t.state === 'FAILED' && typeof t.httpStatus === 'number' ? { httpStatus: t.httpStatus } : {}),
  };
}

/** A translated `assistant` / `prompt_suggestion` payload's `translation`, when it is one. */
export function replyTranslationOf(value: unknown): ReplyTranslation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Partial<ReplyTranslation>;
  if (!isTranslationLanguage(t.lang)) return undefined;
  if (typeof t.text === 'string') return { lang: t.lang, text: t.text };
  if (t.failed === true) return { lang: t.lang, failed: true };
  return undefined;
}

/** Whether a reply's translation came back as the reply itself: the agent already wrote in the
 *  owner's language. Such a reply is drawn as it is, with no foot and no "Translated". */
export function translationUnchanged(translation: ReplyTranslation | undefined, original: string): boolean {
  return translation?.text !== undefined && translation.text.trim() === original.trim();
}

/** Whether a held message is still waiting on its translation (not delivered to the engine). */
export function heldForTranslation(translation: TurnTranslation | undefined): boolean {
  return translation?.state === 'TRANSLATING' || translation?.state === 'FAILED';
}

interface EventLike {
  seq: number;
  payload: any;
}

/**
 * Fold a live `translation` event into the event it translates, exactly as a replay would have
 * delivered it: under that event's payload as `translation`. The same array when no loaded event
 * has that seq (it is outside the window, and its replay will carry it).
 */
export function foldTranslationEvent<T extends EventLike>(events: readonly T[], payload: unknown): T[] | null {
  const p = payload as Partial<TranslationEventPayload> | null;
  if (!p || typeof p.of !== 'number') return null;
  const translation = replyTranslationOf(p);
  if (!translation) return null;
  const at = events.findIndex((event) => event.seq === p.of);
  if (at < 0) return null;
  const next = events.slice();
  next[at] = { ...events[at], payload: { ...events[at].payload, translation } };
  return next;
}

interface QuestionLike {
  question?: string;
  header?: string | null;
  options?: Array<{ label?: string; description?: string | null }>;
}

/**
 * An AskUserQuestion's questions as the card shows them: translated, index for index, where the
 * server has translated them (3A). Answers are keyed by what is shown; the server maps a translated
 * question and label back to the original before the engine reads them.
 */
export function shownQuestions<Q extends QuestionLike>(questions: readonly Q[], translation: ApprovalTranslation | undefined): Q[] {
  const translated = translation && !translation.failed ? translation.questions : undefined;
  if (!translated) return questions.slice();
  return questions.map((q, i) => {
    const t = translated[i];
    if (!t) return q;
    return {
      ...q,
      question: t.question || q.question,
      ...(q.header != null ? { header: t.header || q.header } : {}),
      ...(q.options
        ? {
            options: q.options.map((o, j) => {
              const to = t.options?.[j];
              if (!to) return o;
              return {
                ...o,
                label: to.label || o.label,
                ...(o.description != null ? { description: to.description || o.description } : {}),
              };
            }),
          }
        : {}),
    };
  });
}
