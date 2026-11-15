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
 *
 * WHAT THE AGENT SAYS (task A2, decisions 2A and 3A)
 * ==================================================
 *  - Agent replies. Once the runner has stored an `assistant` text block whole (never its
 *    `text_delta`s), an owner with translation on gets it translated into their language in the
 *    background. Only the workspace's own prose is translated: an `assistant` event carrying
 *    `parentToolUseId` (a sub-agent's report to its caller) is left alone, and `tool_use`,
 *    `tool_result`, `thinking`, `tool_output` and every other type never are. The same goes for a
 *    `prompt_suggestion` (Suggested replies, engine or Orbit source alike).
 *  - Where it is kept. run_event seq is the runner's, so the server writes no event of its own:
 *    the result is written into the translated event's OWN payload under the key `translation`
 *    (ReplyTranslation) — `{ lang, text }`, or `{ lang, failed: true }`. Every replay carries it
 *    with the event: `GET /sessions/:id/events/page` (tail, before, after, around), the SSE
 *    catch-up after `sinceSeq`, and `GET /sessions/:id/events/:seq/full`. An event without the
 *    key was never translated (translation off, or sent before it was on): draw it as it is.
 *  - Live. When the key is written, the session's stream gets a live-only RunEventType.TRANSLATION
 *    at seq 0 (handle it before the seq dedup, as approval_request): payload
 *    TranslationEventPayload, `of` the seq of the event it belongs to. Fold it into that event's
 *    payload as `translation`, exactly as a replay would have delivered it.
 *  - The streaming reply (2A): between the first `text_delta` and the TRANSLATION for its block,
 *    the English is what there is; the client greys it with "Translates when the reply is done".
 *  - Failure (2A): `{ failed: true }` draws "Couldn't translate this reply · Retry". Retry is
 *    `POST /sessions/:id/events/:seq/translation/retry` (no body), answered at once with
 *    ReplyTranslationRetryResponse; the result arrives as another TRANSLATION. A 409 means
 *    translation is off for this account (or the server has no key); a 404, no translatable event.
 *  - Question cards and approvals (3A). An approval card (`GET /sessions/:id/approvals`, ApprovalInfo,
 *    and the live `approval_request`) gains `translation` (ApprovalTranslation) once the server has
 *    translated what it shows the owner: the questions of an AskUserQuestion — question, header,
 *    each option's label and description, index for index with `input.questions` — and a tool
 *    card's `input.description` and `input.plan`. It is written after the card is first published,
 *    so a SECOND `approval_request` with the same id follows, carrying it: replace the card's
 *    display text, nothing else about it. `input` itself is never changed.
 *  - Answering (3A). `POST /sessions/:id/approvals/:approvalId/decision` takes `answers` keyed by the
 *    question as shown and the option labels as shown — the original or the translated, either one;
 *    the server maps a translated question and a translated label back to the original before the
 *    engine reads it. Any other answer (the owner's own words) and the decision's `message` are
 *    translated into English like a message. If that translation fails the decision is NOT
 *    recorded (1A): 422 with `code: 'TRANSLATION_FAILED'`; the client offers Retry (send it again)
 *    and Send as written (send it again with `sendAsWritten: true`).
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

/**
 * The `translation` key of a translated `assistant` or `prompt_suggestion` run event's payload,
 * written by the server once the event is translated. Exactly one of `text` and `failed`.
 */
export interface ReplyTranslation {
  /** The owner's language it was (or was to be) translated into. */
  lang: TranslationLanguage;
  /** The translation. Draw it by default; "Show original" flips to the event's own `text`. */
  text?: string;
  /** The translation failed or took longer than 20 s: "Couldn't translate this reply · Retry". */
  failed?: true;
}

/** RunEventType.TRANSLATION's payload (live-only, seq 0). */
export interface TranslationEventPayload extends ReplyTranslation {
  /** The seq of the event this translates. */
  of: number;
}

/** The answer to `POST /sessions/:id/events/:seq/translation/retry`: the translation is under way,
 *  and its result comes as a RunEventType.TRANSLATION for `of`. */
export interface ReplyTranslationRetryResponse {
  of: number;
  lang: TranslationLanguage;
}

/** One AskUserQuestion question as shown in the owner's language, index for index with
 *  `input.questions[i]`; a field the original lacks is absent here too. */
export interface TranslatedQuestion {
  question: string;
  header?: string;
  /** Index for index with `input.questions[i].options`. */
  options: Array<{ label: string; description?: string }>;
}

/** ApprovalInfo.translation (and the `approval_request` payload's): what the card shows, in the
 *  owner's language. Absent until it is translated, and on every card translation is off for. */
export interface ApprovalTranslation {
  lang: TranslationLanguage;
  /** The card could not be translated: draw it in English. Nothing else is set. */
  failed?: true;
  /** `input.description` translated (a tool card's one-line "what this does"). */
  description?: string;
  /** `input.plan` translated (ExitPlanMode). */
  plan?: string;
  /** `input.questions` translated (AskUserQuestion). */
  questions?: TranslatedQuestion[];
}

/** The 422 a decision whose words could not be translated is refused with: nothing was recorded. */
export const TRANSLATION_FAILED_CODE = 'TRANSLATION_FAILED' as const;
