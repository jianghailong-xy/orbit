// Settings › Translation on the web (board docs/mocks/session-translation/01-board.png). The server
// owns the feature (@orbit/shared translation.ts); everything here only reads the fields it writes.
import {
  DEFAULT_TRANSLATION_LANGUAGE,
  isTranslationLanguage,
  TRANSLATION_LANGUAGE_NAMES,
  type ApprovalTranslation,
  type ReplyTranslation,
  type TranslationEventPayload,
  type TranslationLanguage,
  type TurnTranslation,
} from '@orbit/shared';
import type { Me } from './queries';

/** The copy every client shows, kept identical across Web, iOS/macOS and Android. */
export const TRANSLATION_COPY = {
  translated: 'Translated',
  showOriginal: 'Show original',
  showTranslation: 'Show translation',
  sentInEnglish: 'Sent to the agent in English',
  original: 'Original',
  translating: 'Translating…',
  sendFailed: "Couldn't translate, so it wasn't sent",
  retry: 'Retry',
  sendAsWritten: 'Send as written',
  replyPending: 'Translates when the reply is done',
  replyFailed: "Couldn't translate this reply",
} as const;

/** The language the account writes and reads in, absent = the default pick. */
export function translationLanguageOf(me: Me | undefined): TranslationLanguage {
  const lang = me?.preferences?.translationLanguage;
  return isTranslationLanguage(lang) ? lang : DEFAULT_TRANSLATION_LANGUAGE;
}

/** Whether the owner's messages are being translated now: switched on, and the server able to. */
export function translationOn(me: Me | undefined): boolean {
  return me?.preferences?.translationEnabled === true && me.translationAvailable === true;
}

/** The composer tag (6A): "<Language> → English", the language without its parenthesis. */
export function translationTag(lang: TranslationLanguage): string {
  return `${TRANSLATION_LANGUAGE_NAMES[lang].replace(/\s*\(.*\)$/, '')} → English`;
}

/** A `user` event's or a turn row's `translation`, when it is one. */
export function turnTranslationOf(value: unknown): TurnTranslation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Partial<TurnTranslation>;
  if (typeof t.original !== 'string' || !isTranslationLanguage(t.from)) return undefined;
  if (t.state !== 'TRANSLATING' && t.state !== 'FAILED' && t.state !== 'DONE' && t.state !== 'SENT_AS_WRITTEN') {
    return undefined;
  }
  return { state: t.state, from: t.from, original: t.original };
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
  header?: string;
  options?: Array<{ label?: string; description?: string }>;
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
      ...(q.header !== undefined ? { header: t.header || q.header } : {}),
      ...(q.options
        ? {
            options: q.options.map((o, j) => {
              const to = t.options?.[j];
              if (!to) return o;
              return {
                ...o,
                label: to.label || o.label,
                ...(o.description !== undefined ? { description: to.description || o.description } : {}),
              };
            }),
          }
        : {}),
    };
  });
}
