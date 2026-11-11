/**
 * Session translation (Settings › Translation, board docs/mocks/session-translation/01-board.png):
 * the wire shapes every client builds on. The server owns the whole feature — it translates with its
 * own DeepSeek key (DEEPSEEK_API_KEY) — so a client only reads and writes the fields below.
 *
 * WHAT A CLIENT READS AND WRITES
 * ==============================
 *  - `GET /users/me` → `preferences.translationEnabled` / `preferences.translationLanguage`
 *    (TranslationPreferences) and `translationAvailable` (MeTranslation). Absent
 *    `translationEnabled` is OFF. `translationAvailable: false` is board frame 2: the switch is
 *    drawn disabled with the DEEPSEEK_API_KEY notice, and nothing is translated whatever the
 *    preference says.
 *  - `PATCH /users/me/preferences` with `{ translationEnabled?, translationLanguage? }`. A
 *    `translationLanguage` outside TRANSLATION_LANGUAGES is a 400. The answer is the same shape as
 *    `/users/me`.
 *  - The owner's message, once translated, travels as a turn whose `content` is the English the
 *    engine receives and whose `translation.original` is what the owner typed (TurnTranslation).
 *    It is on:
 *      · the queued/active turn list, `GET /sessions/:id/turns[?view=active]` — every row may carry
 *        `translation`; rows still TRANSLATING or FAILED are listed there too (placement `queued`),
 *        and so is a new session's opening message while it is held;
 *      · the answer to every send (`POST /sessions/:id/turns`, `/turns/current-work-routing`,
 *        `/resume`, `/interrupt` with a follow-up): `translation` with state TRANSLATING when the
 *        message is being translated, absent when translation was not involved;
 *      · the transcript: the runner's `user` run event for that turn carries `translation`
 *        (state DONE or SENT_AS_WRITTEN) beside its `text`, which is the English delivered.
 *  - Every change of a held turn's state (TRANSLATING → DONE / FAILED, Retry, Send as written) is
 *    announced on the session's event stream with the existing QUEUED_TURNS_CHANGED run event
 *    (RunEventType.QUEUED_TURNS_CHANGED, RealtimeService.publishQueuedTurnsChanged);
 *    a client refetches the turn list on it, exactly as it already does for its queue.
 *  - Retry: `POST /sessions/:id/turns/:turnId/translation/retry` (FAILED → TRANSLATING).
 *    Send as written: `POST /sessions/:id/turns/:turnId/translation/send-as-written` — delivers the
 *    original untranslated (state SENT_AS_WRITTEN). Both answer TranslationActionResponse. Withdrawing
 *    a held turn is the ordinary `DELETE /sessions/:id/turns/:turnId`.
 */

/** "Your language": the seven the owner may write and read in (board decision 5A). "Agents work in"
 *  is fixed to English and is not a field. */
export const TRANSLATION_LANGUAGES = ['zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de'] as const;
export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number];

/** What a preference without a language means: the board's default pick. */
export const DEFAULT_TRANSLATION_LANGUAGE: TranslationLanguage = 'zh-Hans';

/** The language every engine is spoken to in. Read-only on every client ("Agents work in"). */
export const AGENT_LANGUAGE = 'en' as const;

/** Each language's English name, as Settings lists it and the composer tag reads it (6A:
 *  "<Language> → English", where the tag drops the parenthesis: "Chinese → English"). */
export const TRANSLATION_LANGUAGE_NAMES: Readonly<Record<TranslationLanguage, string>> = {
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
};

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && (TRANSLATION_LANGUAGES as readonly string[]).includes(value);
}

/** The two keys of `User.preferences` (UserPreferences) this feature owns. Account-wide, no
 *  per-session switch; read on every send, so a change applies from the next message. */
export interface TranslationPreferences {
  /** Absent = off. */
  translationEnabled?: boolean;
  /** Absent = DEFAULT_TRANSLATION_LANGUAGE. */
  translationLanguage?: TranslationLanguage;
}

/** Added to `GET /users/me` (and every answer shaped like it). */
export interface MeTranslation {
  /** The server holds a DeepSeek key and so can translate. False: Settings shows the switch
   *  disabled with the board frame 2 notice, and no message is translated. */
  translationAvailable: boolean;
}

/**
 * Where one of the owner's messages is in translation.
 *  - TRANSLATING: being translated; not delivered to the engine yet (chip "Translating…").
 *  - FAILED: translation failed or took longer than 20 s; NOT delivered (decision 1A). The client
 *    shows "Couldn't translate, so it wasn't sent · Retry · Send as written".
 *  - DONE: delivered in English; `original` is what the owner wrote.
 *  - SENT_AS_WRITTEN: the owner chose Send as written; delivered untranslated, so `content` and
 *    `original` are the same words.
 */
export type TurnTranslationState = 'TRANSLATING' | 'FAILED' | 'DONE' | 'SENT_AS_WRITTEN';

/** The `translation` field of a translated turn (queued list, send answer, `user` run event).
 *  Absent on every message translation was not involved in. */
export interface TurnTranslation {
  state: TurnTranslationState;
  /** The language the owner wrote in. The target is always AGENT_LANGUAGE. */
  from: TranslationLanguage;
  /** What the owner typed, as typed. Draw this in the bubble by default; "Show original" on a DONE
   *  message flips to the turn's `content` / the event's `text` (the English the agent got). */
  original: string;
}

/** The answer to Retry and to Send as written. */
export interface TranslationActionResponse {
  turnId: string;
  translation: TurnTranslation;
}

/** How long one translation may take before it counts as failed (decision 4A). */
export const TRANSLATION_TIMEOUT_MS = 20_000;
