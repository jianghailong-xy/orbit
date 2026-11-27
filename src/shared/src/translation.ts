/**
 * Session translation (Settings › Translation, board docs/mocks/session-translation/01-board.png):
 * the wire shapes every client builds on. The server owns the whole feature — it translates with its
 * own DeepSeek key (DEEPSEEK_API_KEY) — so a client only reads and writes the fields below.
 *
 * WHAT A CLIENT READS AND WRITES
 * ==============================
 *  - `GET /users/me` → `preferences.translationEnabled` / `preferences.translationLanguage` /
 *    `preferences.translationAgentLanguage` (TranslationPreferences) and `translationAvailable`
 *    (MeTranslation). Absent `translationEnabled` is OFF, absent `translationLanguage` is zh-Hans,
 *    absent `translationAgentLanguage` is English. Both languages come from the one list
 *    TRANSLATION_LANGUAGES ("Your language" and "Agents work in" alike). `translationAvailable: false` is board frame 2: the switch is
 *    drawn disabled with the DEEPSEEK_API_KEY notice, and nothing is translated whatever the
 *    preference says. `translationUnavailableUntil` (MeTranslation) is set while a failing translator
 *    is being skipped (board docs/ux/translation-failure-policy.html, frame 6).
 *    When the two languages are the same, nothing is translated either: messages, replies and
 *    cards go exactly as with translation off (no `translation` on any of them).
 *  - `preferences.translationBilingual` ("Show both languages", board 02-bilingual.png): absent is
 *    OFF. On, every translated message ALSO shows the text in the agent's language (what the agent
 *    read or wrote): a reply block by block, each original under its translation (bilingualPairs),
 *    and the owner's message whole below a dashed divider (bilingualEnglish). Off, the clients
 *    draw exactly what they drew before it existed. Display only: the server translates the same
 *    either way.
 *  - `PATCH /users/me/preferences` with `{ translationEnabled?, translationLanguage?,
 *    translationAgentLanguage?, translationBilingual? }`. Either language outside
 *    TRANSLATION_LANGUAGES is a 400. The answer is the same shape as
 *    `/users/me`.
 *  - The owner's message, once translated, travels as a turn whose `content` is the translation the
 *    engine receives and whose `translation.original` is what the owner typed (TurnTranslation).
 *    It is on:
 *      · the queued/active turn list, `GET /sessions/:id/turns[?view=active]` — every row may carry
 *        `translation`; rows still TRANSLATING or FAILED are listed there too (placement `queued`),
 *        and so is a new session's opening message while it is held;
 *      · the answer to every send (`POST /sessions/:id/turns`, `/turns/current-work-routing`,
 *        `/resume`, `/interrupt` with a follow-up): `translation` with state TRANSLATING when the
 *        message is being translated, absent when translation was not involved;
 *      · the transcript: the runner's `user` run event for that turn carries `translation`
 *        (state DONE or SENT_AS_WRITTEN) beside its `text`, which is the translation delivered.
 *  - Every change of a held turn's state (TRANSLATING → DONE / FAILED, Retry, Send as written) is
 *    announced on the session's event stream with the existing QUEUED_TURNS_CHANGED run event
 *    (RunEventType.QUEUED_TURNS_CHANGED, RealtimeService.publishQueuedTurnsChanged);
 *    a client refetches the turn list on it, exactly as it already does for its queue.
 *  - A FAILED turn's `translation` says why in `failureReason` (TranslationFailureReason) and, for an
 *    HTTP answer, `httpStatus`; both are stored on the held turn and cleared when it leaves FAILED.
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
 *    the agent's own words are what there is; the client greys it with "Translates when the reply is done".
 *  - Failure (2A): `{ failed: true }` draws "Couldn't translate this reply · Retry". Retry is
 *    `POST /sessions/:id/events/:seq/translation/retry` (no body), answered at once with
 *    ReplyTranslationRetryResponse; the result arrives as another TRANSLATION. A 409 means
 *    translation is off for this account (or the server has no key); a 404, no translatable event.
 *  - Question cards and approvals (3A). An approval card (`GET /sessions/:id/approvals`, ApprovalInfo,
 *    and the live `approval_request`) gains `translation` (ApprovalTranslation) once the server has
 *    translated what it shows the owner: the questions of an AskUserQuestion — question, header,
 *    each option's label and description, index for index with `input.questions` — and a tool
 *    card's `input.description` and `input.plan`; on Orbit's create, blocker and DAG-change cards
 *    (TRANSLATED_ORBIT_CARDS) also the title, acceptance criteria, batch tasks, goal, instructions,
 *    criteria items, reason and note. It is written after the card is first published,
 *    so a SECOND `approval_request` with the same id follows, carrying it: replace the card's
 *    display text, nothing else about it. `input` itself is never changed.
 *  - Answering (3A). `POST /sessions/:id/approvals/:approvalId/decision` takes `answers` keyed by the
 *    question as shown and the option labels as shown — the original or the translated, either one;
 *    the server maps a translated question and a translated label back to the original before the
 *    engine reads it. Any other answer (the owner's own words) and the decision's `message` are
 *    translated into the agent language like a message. If that translation fails the decision is NOT
 *    recorded (1A): 422 with `code: 'TRANSLATION_FAILED'` (TranslationFailedBody, which says why in
 *    `failureReason` and `httpStatus`); the client offers Retry (send it again)
 *    and Send as written (send it again with `sendAsWritten: true`).
 */

/** The curated languages DeepSeek translates well (owner decision, 2026-11-15). ONE list for both
 *  pickers, "Your language" and "Agents work in", on every client; the Swift and Kotlin copies
 *  mirror it under parity tests. The first seven codes after English are the ones shipped before
 *  the list grew: never rename them, stored preferences name them. */
export const TRANSLATION_LANGUAGES = [
  'en',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'es',
  'fr',
  'de',
  'ru',
  'pt',
  'it',
  'nl',
  'ar',
  'hi',
  'tr',
  'vi',
  'th',
  'id',
  'pl',
  'uk',
  'he',
  'sv',
  'cs',
  'da',
  'fi',
  'el',
  'hu',
  'ro',
  'ms',
  'bn',
] as const;
export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number];

/** What a preference without an owner language means: the board's default pick. */
export const DEFAULT_TRANSLATION_LANGUAGE: TranslationLanguage = 'zh-Hans';

/** What a preference without an agent language means: English, as every account had before the
 *  agent language could be chosen. */
export const DEFAULT_AGENT_LANGUAGE = 'en' satisfies TranslationLanguage;

/** @deprecated The agent language is now the account's `translationAgentLanguage`; this is only its
 *  default. Kept so code written when it was fixed still compiles. */
export const AGENT_LANGUAGE = DEFAULT_AGENT_LANGUAGE;

/** Each language's English name, as Settings lists it and the composer tag reads it
 *  ("<Language> → <Agent language>", where the tag drops the parenthesis: "Chinese → English"). */
export const TRANSLATION_LANGUAGE_NAMES: Readonly<Record<TranslationLanguage, string>> = {
  en: 'English',
  'zh-Hans': 'Chinese (Simplified)',
  'zh-Hant': 'Chinese (Traditional)',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ru: 'Russian',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  ar: 'Arabic',
  hi: 'Hindi',
  tr: 'Turkish',
  vi: 'Vietnamese',
  th: 'Thai',
  id: 'Indonesian',
  pl: 'Polish',
  uk: 'Ukrainian',
  he: 'Hebrew',
  sv: 'Swedish',
  cs: 'Czech',
  da: 'Danish',
  fi: 'Finnish',
  el: 'Greek',
  hu: 'Hungarian',
  ro: 'Romanian',
  ms: 'Malay',
  bn: 'Bengali',
};

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === 'string' && (TRANSLATION_LANGUAGES as readonly string[]).includes(value);
}

/** The keys of `User.preferences` (UserPreferences) this feature owns. Account-wide, no
 *  per-session switch; read on every send, so a change applies from the next message. */
export interface TranslationPreferences {
  /** Absent = off. */
  translationEnabled?: boolean;
  /** "Your language". Absent = DEFAULT_TRANSLATION_LANGUAGE. */
  translationLanguage?: TranslationLanguage;
  /** "Agents work in": the language engines are spoken to in. Absent = DEFAULT_AGENT_LANGUAGE. */
  translationAgentLanguage?: TranslationLanguage;
  /** "Show both languages": absent = off. Only drawn while translationEnabled is on. */
  translationBilingual?: boolean;
}

/** Added to `GET /users/me` (and every answer shaped like it). */
export interface MeTranslation {
  /** The server holds a DeepSeek key and so can translate. False: Settings shows the switch
   *  disabled with the board frame 2 notice, and no message is translated. */
  translationAvailable: boolean;
  /**
   * Translation is temporarily unavailable (policy board docs/ux/translation-failure-policy.html, frame 6): the
   * translator failed TRANSLATION_BREAKER_THRESHOLD times (network, timeout, or 429/5xx after its retries) within
   * a minute, so until this ISO-8601 instant every owner → agent translation is skipped and fails at once with
   * reason UNAVAILABLE: a message is held FAILED, a card answer is refused 422 TRANSLATION_FAILED. Null while
   * the translator is in use (and absent from an older server: read as null).
   *
   * While it is set and in the future, the composer's language tag reads "unavailable, messages will wait" and
   * Settings › Translation shows the same notice. It is not extended by itself: once the instant passes the
   * client draws the ordinary tag again without being told; the next send is the trial call, which either
   * closes the breaker or sets a new instant. Every change of it (opened, opened again, closed) is announced on
   * the account's control stream as `translation.status_changed` (ControlEventType.TRANSLATION_STATUS_CHANGED):
   * read `GET /users/me` again on it.
   *
   * PER APISERVER PROCESS: each replica keeps its own breaker, so with several replicas the answer depends on
   * which one served the read, and a replica that has seen no failures still asks the translator.
   */
  translationUnavailableUntil: string | null;
}

/** How many transient translator failures within TRANSLATION_BREAKER_WINDOW_MS open the circuit breaker
 *  (MeTranslation.translationUnavailableUntil), and how long it then stays open. */
export const TRANSLATION_BREAKER_THRESHOLD = 3;
export const TRANSLATION_BREAKER_WINDOW_MS = 60_000;
export const TRANSLATION_BREAKER_OPEN_MS = 60_000;

/**
 * Where one of the owner's messages is in translation.
 *  - TRANSLATING: being translated; not delivered to the engine yet (chip "Translating…").
 *  - FAILED: translation failed or took longer than 20 s; NOT delivered (decision 1A). The client
 *    shows "Couldn't translate, so it wasn't sent · Retry · Send as written".
 *  - DONE: delivered in the account's agent language; `original` is what the owner wrote.
 *  - SENT_AS_WRITTEN: the owner chose Send as written; delivered untranslated, so `content` and
 *    `original` are the same words.
 */
export type TurnTranslationState = 'TRANSLATING' | 'FAILED' | 'DONE' | 'SENT_AS_WRITTEN';

/** The `translation` field of a translated turn (queued list, send answer, `user` run event).
 *  Absent on every message translation was not involved in. */
export interface TurnTranslation {
  state: TurnTranslationState;
  /** The language the owner wrote in. The target is the account's agent language (`translationAgentLanguage`). */
  from: TranslationLanguage;
  /** What the owner typed, as typed. Draw this in the bubble by default; "Show original" on a DONE
   *  message flips to the turn's `content` / the event's `text` (what the agent got). */
  original: string;
  /** Why the translation failed: present only while `state` is FAILED, and then always (a turn that
   *  failed before the reason was stored has none: draw the generic failure line). Retry, Send as
   *  written and a successful translation clear it. */
  failureReason?: TranslationFailureReason;
  /** The translator's HTTP status, beside `failureReason: 'HTTP'` only (e.g. 401, 429, 503). */
  httpStatus?: number;
}

/**
 * Why translating the owner's words into the agent language failed (policy board
 * docs/ux/translation-failure-policy.html, option B). Carried by a FAILED TurnTranslation
 * (`failureReason`) and by the 422 TRANSLATION_FAILED answer (TranslationFailedBody).
 *  - TIMEOUT: no answer within TRANSLATION_TIMEOUT_MS (20 s), retries included.
 *  - NETWORK: the translator could not be reached (after the retries).
 *  - HTTP: the translator answered an error; `httpStatus` says which (429 and 5xx after the retries).
 *  - EMPTY: it answered with no text.
 *  - TRUNCATED: the message is too long: the answer was cut off at its token limit.
 *  - MANGLED: the answer lost, invented or repeated code or links the message carried.
 *  - NO_KEY: this server has no translator key.
 *  - UNAVAILABLE: the translator was skipped because it has been failing (circuit breaker).
 * A client meets a value it does not know as no reason: the generic failure line.
 */
export const TRANSLATION_FAILURE_REASONS = [
  'TIMEOUT',
  'NETWORK',
  'HTTP',
  'EMPTY',
  'TRUNCATED',
  'MANGLED',
  'NO_KEY',
  'UNAVAILABLE',
] as const;
export type TranslationFailureReason = (typeof TRANSLATION_FAILURE_REASONS)[number];

export function isTranslationFailureReason(value: unknown): value is TranslationFailureReason {
  return typeof value === 'string' && (TRANSLATION_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * The failure line's first sentence, before " · Retry · Send as written" (policy board
 * docs/ux/translation-failure-policy.html, the B column of frame 7): `message` under a held message (frame 4B),
 * `answer` under a card whose answer was refused 422 TRANSLATION_FAILED (frame 5). The same words on web, Apple and
 * Android: OrbitKit and Android core mirror this table, and all three walk `translation-failure-lines.fixture.json`.
 * GENERIC is today's line, for no reason, NO_KEY (frame 7 has no row for it) or a reason a client does not know.
 */
export const TRANSLATION_FAILURE_LINES = {
  TIMEOUT: {
    message: "The translator didn't answer in time, so it wasn't sent",
    answer: "The translator didn't answer in time, so your answer wasn't sent",
  },
  UNREACHABLE: {
    message: "The translator was unreachable, so it wasn't sent",
    answer: "The translator was unreachable, so your answer wasn't sent",
  },
  REFUSED: {
    message: "The translator refused the message, so it wasn't sent",
    answer: "The translator refused the message, so your answer wasn't sent",
  },
  TRUNCATED: {
    message: "Too long to translate, so it wasn't sent",
    answer: "Too long to translate, so your answer wasn't sent",
  },
  DAMAGED: {
    message: "The translation came back damaged, so it wasn't sent",
    answer: "The translation came back damaged, so your answer wasn't sent",
  },
  UNAVAILABLE: {
    message: "Translation is unavailable right now, so it wasn't sent",
    answer: "Translation is unavailable right now, so your answer wasn't sent",
  },
  GENERIC: {
    message: "Couldn't translate, so it wasn't sent",
    answer: "Couldn't translate, so it wasn't sent",
  },
} as const;
export type TranslationFailureLine = keyof typeof TRANSLATION_FAILURE_LINES;

/** Which row of TRANSLATION_FAILURE_LINES a failure draws. HTTP is "unreachable" for 429 and 5xx (the statuses
 *  that were retried), "refused" for any other 4xx, and GENERIC without a status or with one outside those (frame 7
 *  names no other, so we do not guess why); MANGLED and EMPTY are both "damaged". */
export function translationFailureLineOf(reason: unknown, httpStatus?: number | null): TranslationFailureLine {
  switch (reason) {
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'NETWORK':
      return 'UNREACHABLE';
    case 'HTTP':
      if (typeof httpStatus !== 'number') return 'GENERIC';
      if (httpStatus === 429 || httpStatus >= 500) return 'UNREACHABLE';
      return httpStatus >= 400 && httpStatus < 500 ? 'REFUSED' : 'GENERIC';
    case 'TRUNCATED':
      return 'TRUNCATED';
    case 'MANGLED':
    case 'EMPTY':
      return 'DAMAGED';
    case 'UNAVAILABLE':
      return 'UNAVAILABLE';
    default:
      return 'GENERIC';
  }
}

/** The failure line's first sentence for a held message (`message`) or a refused card answer (`answer`). */
export function translationFailureSentence(
  of: 'message' | 'answer',
  reason: unknown,
  httpStatus?: number | null,
): string {
  return TRANSLATION_FAILURE_LINES[translationFailureLineOf(reason, httpStatus)][of];
}

/** The composer tag's suffix while translation is unavailable (frame 6): "Chinese → English · unavailable, messages
 *  will wait", drawn in the warning style while MeTranslation.translationUnavailableUntil is in the future. */
export const TRANSLATION_UNAVAILABLE_TAG = 'unavailable, messages will wait';

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
  /** The card could not be translated: draw it as the agent wrote it. Nothing else is set. */
  failed?: true;
  /** `input.description` translated (a tool card's one-line "what this does"). */
  description?: string;
  /** `input.plan` translated (ExitPlanMode). */
  plan?: string;
  /** `input.questions` translated (AskUserQuestion). */
  questions?: TranslatedQuestion[];
  // Orbit's own cards (board 04-owner-cards.html, part 2). Each field is the input field of the same
  // name translated, present only when the original has text; arrays go index for index with the
  // input's, and an entry's field the original lacks is absent there too.
  /** `input.title` (orbit_task_create, orbit_project_create). */
  title?: string;
  /** `input.acceptanceCriteria` (orbit_task_create). */
  acceptanceCriteria?: string;
  /** `input.tasks` (orbit_task_batch): index for index, so `tasks[i]` is `input.tasks[i]` and
   *  `input.preview.tasks[i]`. */
  tasks?: TranslatedTaskBody[];
  /** `input.goal` (orbit_project_create). */
  goal?: string;
  /** `input.instructions` (orbit_project_create). */
  instructions?: string;
  /** `input.acceptanceCriteriaItems` (orbit_project_create), index for index. */
  acceptanceCriteriaItems?: Array<{ text?: string; verificationMethod?: string }>;
  /** `input.reason` (orbit_blocker_resolve): the agent's argument that the blocker no longer applies. */
  reason?: string;
  /** `input.note` (orbit_dag_change). */
  note?: string;
}

/** One task of a batch card as shown in the owner's language (ApprovalTranslation.tasks). */
export interface TranslatedTaskBody {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
}

/**
 * An owner card that lives outside a session (board 04-owner-cards.html), in the owner's language: a
 * coordinator's question, start request or done request (`ProjectOpenItemRow.translation`,
 * `ProjectClosedQuestion.translation`), an owner request (`OwnerRequest.translation`), an owner-confirmation
 * review (`review.translation`, `problems.translation` on OwnerConfirmationReviewView), a crossing
 * (`translation` on a `GET /projects/:id/handoffs` row) or a criteria-change proposal (`translation` on a
 * pending criteria decision). Completion evidence has its own shape, EvidenceTranslation. Stored beside the
 * card's own fields, which stay exactly what the agent wrote. Absent until it is translated, and on every
 * card translation is off for.
 *
 * Each field is the card's field of the same name translated, present only when the original has text;
 * arrays go index for index with the card's, and an entry's field the original lacks is absent there too.
 * A step's `command` and `link` are never translated: the card draws them from the original.
 */
export interface OwnerCardTranslation {
  lang: TranslationLanguage;
  /** The card could not be translated: draw it as the agent wrote it. Nothing else is set. */
  failed?: true;
  /** A coordinator question's `question`. */
  question?: string;
  /** A question's or a DECISION request's `options`. */
  options?: Array<{ label?: string; description?: string }>;
  /** A question's or a request's `ifUnanswered`. */
  ifUnanswered?: string;
  /** An open coordinator question's `detailLine` (`ProjectOpenItemRow.detailLine`) built from the translated
   *  `ifUnanswered`: "Blocks N tasks · If you don’t answer: <translated>". Served by the open-items read only,
   *  beside a whole translation in the owner's current language; never stored. Absent from an older server. */
  detailLine?: string;
  /** An owner request's `title`. On an open coordinator question, the open-items row's `title`
   *  (`ProjectOpenItemRow.title`) built from the translated `question`: "Coordinator asks: <translated>".
   *  Served by the open-items read only, beside a whole translation in the owner's current language; never
   *  stored. Absent from an older server, and on a START_REQUEST or DONE_REQUEST, whose titles are Orbit's. */
  title?: string;
  /** An owner request's `why`. */
  why?: string;
  /** An open item's `handoverNote` (`ProjectOpenItemRow.handoverNote`): the coordinator's reason for handing it
   *  to the owner (open_item_hand_over), on an item of any kind. Absent from an older server. */
  handoverNote?: string;
  /** A MANUAL_STEP request's `steps`, the text of each. */
  steps?: Array<{ text?: string }>;
  /** An owner request's `verifyHint`. */
  verifyHint?: string;
  /** A PROJECT_REOPEN request's `payload.plannedWork`. */
  plannedWork?: string;
  /** A START_REQUEST's `why` uses `why` above. A DONE_REQUEST's `judgment`, or an owner-confirmation
   *  review's `judgment`. */
  judgment?: string;
  /** A DONE_REQUEST's `gaps`, index for index; `criterionKey` and `evidenceRefs` are drawn from the original. */
  gaps?: Array<{ title?: string; whyNotProven?: string; coordinatorChecked?: string }>;
  /** An owner-confirmation review's `needsYou`, index for index: each line's `text` and `options`. */
  needsYou?: Array<{ text?: string; options?: Array<{ label?: string; description?: string }> }>;
  /** An owner-confirmation PROBLEMS record's `reason`, or a crossing's `reason`. */
  reason?: string;
  /** An owner-confirmation PROBLEMS record's `problems`, the text of each. */
  problems?: Array<{ text?: string }>;
  /** A criteria-change proposal's `proposed`, index for index: each criterion's `text` and
   *  `verificationMethod`. */
  proposed?: Array<{ text?: string; verificationMethod?: string }>;
}

/**
 * A project's title and its acceptance criteria's text in the owner's language (`translation` on `GET /projects/:id`):
 * what the "Is this project done?" card, the project page's Done when list and the why-not-done card draw. Served only
 * in the owner's current language, while it matches the project's current title and criteria, and with translation
 * on; otherwise absent, and the server queues a new one. Stored in project_text_translation; the project's own fields
 * stay exactly what the agent wrote. A criterion's `verificationMethod` is not translated.
 */
export interface ProjectTextTranslation {
  lang: TranslationLanguage;
  /** The project's words could not be translated: draw them as the agent wrote them. Nothing else is set. */
  failed?: true;
  /** The project's `title`. */
  title?: string;
  /** Each criterion's `text`, keyed by the criterion's `id` (`acceptanceCriteriaItems[].id`), in ordinal order. */
  criteria?: Array<{ id: string; text: string }>;
}

/**
 * A completion-evidence revision's `claim` and `gaps` in the owner's language (`translation` on a
 * pending evidence judgment). `gaps` goes index for index with the envelope's. Absent until it is
 * translated, and on every revision translation is off for.
 */
export interface EvidenceTranslation {
  lang: TranslationLanguage;
  /** The evidence could not be translated: draw it as the agent wrote it. Nothing else is set. */
  failed?: true;
  claim?: string;
  gaps?: string[];
}

/** The Orbit cards whose agent-written fields beyond `description` are translated. */
export const TRANSLATED_ORBIT_CARDS = [
  'orbit_task_create',
  'orbit_task_batch',
  'orbit_project_create',
  'orbit_blocker_resolve',
  'orbit_dag_change',
] as const;

/** The 422 a decision whose words could not be translated is refused with: nothing was recorded. */
export const TRANSLATION_FAILED_CODE = 'TRANSLATION_FAILED' as const;

/** The body of that 422: the same `failureReason` (and `httpStatus`) a FAILED TurnTranslation carries. */
export interface TranslationFailedBody {
  code: typeof TRANSLATION_FAILED_CODE;
  message: string;
  failureReason: TranslationFailureReason;
  /** Beside `failureReason: 'HTTP'` only. */
  httpStatus?: number;
}

/**
 * Words the owner typed on an owner card (an answer to a coordinator's question, an owner request's done text or
 * decline reason, a done request's "Not yet…" note, an owner-confirmation answer), as they were delivered to the
 * agent: translated from the owner's language into the agent's (`lang`). Stored beside the owner's own words, which
 * stay what every card shows; absent when translation was off, or the owner pressed Send as written.
 *
 * Every door that takes such words takes `sendAsWritten: true` to deliver them untranslated, and refuses them whole
 * with a 422 TRANSLATION_FAILED, recording nothing, when they cannot be translated — as an approval answer is.
 */
export interface OwnerWordsTranslation {
  lang: TranslationLanguage;
  text: string;
}

/**
 * "Show both languages" (board 02-bilingual.png, frame 3 option B), for a reply whose blocks do not
 * pair (bilingualPairs answers null) and so is drawn whole: its original (in the account's agent
 * language, English by default) is drawn in full when it runs to at most BILINGUAL_COLLAPSE_LINES
 * lines; longer, it collapses to a two-line faded preview with "Show <agent language> · N lines"
 * ("Show English · N lines"). An interleaved reply never collapses (03-interleaved.png). A line is
 * counted the same way on every client — a source line wraps every BILINGUAL_LINE_CHARS characters,
 * blank lines do not count — so N is the same number on the web, an iPhone and an Android phone.
 */
export const BILINGUAL_COLLAPSE_LINES = 6;
export const BILINGUAL_LINE_CHARS = 60;

/** The English drawn under the owner's translated message, and under a reply whose blocks do not pair
 *  (bilingualPairs answers null): its prose only. A fenced code block is drawn once, in the
 *  translation above it, never again in the English (board mark D). */
export function bilingualEnglish(text: string): string {
  return text
    .replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * "Show both languages", interleaved (board docs/mocks/session-translation/03-interleaved.png): an
 * agent reply is drawn block by block, each paragraph, list item, heading or quote in the owner's
 * language with its original (the agent's words) right under it, smaller and grey.
 *
 * ONE RULE, THREE PORTS. OrbitKit `BilingualPairs.pairs` and Android `Translation.bilingualPairs`
 * are line for line the same, and all three are walked through `bilingual-pairs.fixture.json`.
 *
 *  - Both texts are split into blocks by lines: a fenced code block (``` or ~~~ opening and the same
 *    fence closing, at most 3 spaces in; an unclosed fence is not one), a heading (`#`…`######`), a
 *    list item (`-`, `*`, `+`, `1.`, `1)`) with the lines that continue it, a quote (consecutive `>`
 *    lines), a table (consecutive lines starting with `|`), a thematic break, and otherwise a
 *    paragraph (consecutive non-blank lines up to a line that starts one of the above).
 *  - `depth` is how many list items the block sits inside, by indentation.
 *  - Paragraphs, headings, list items and quotes pair; code, tables, breaks and image-only paragraphs
 *    do not ('other'): they are drawn once, from the translation, and the original's are dropped.
 *  - The two sequences of pairable blocks must match in count, kind and depth, or there is no
 *    pairing (null) and the message is drawn whole, translation over original (board frame 4). A
 *    reply with nothing to pair is null too.
 *
 * Each pair is a block of the translation, in order: `text` is its source with its indentation
 * removed — an item's without its marker (`marker` keeps "-" or "3."), a heading's whole line, a
 * quote's without its `>`s — and `original` the matching block of the original in the same form,
 * except a heading's, which is its words alone. 'other' blocks carry no `original`.
 */
export type BilingualBlockKind = 'paragraph' | 'heading' | 'item' | 'quote' | 'other';

export interface BilingualPair {
  kind: BilingualBlockKind;
  depth: number;
  /** An item's marker as written: "-", "*", "+", "1.", "2)". */
  marker?: string;
  text: string;
  original?: string;
}

interface BilingualBlock {
  kind: BilingualBlockKind;
  depth: number;
  marker?: string;
  /** What `text` / `original` hold, by the rule above. */
  body: string;
  /** A heading's words alone; otherwise the same as body. */
  words: string;
}

const FENCE = /^ *(```|~~~)/;
const HEADING = /^ {0,3}(#{1,6})(?: +|$)(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const BREAK = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const QUOTE = /^ {0,3}>/;
const TABLE = /^ *\|/;
const IMAGES = /^(?:!\[[^\]]*\]\([^)]*\)\s*)+$/;

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, '').length;
}

function dedent(line: string, n: number): string {
  const k = Math.min(n, indentOf(line));
  return line.slice(k);
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || BREAK.test(line) || ITEM.test(line) || QUOTE.test(line) || TABLE.test(line);
}

function bilingualBlocks(text: string): BilingualBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: BilingualBlock[] = [];
  // The content column of each open list item, innermost last.
  const items: number[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const indent = indentOf(line);
    while (items.length > 0 && indent < items[items.length - 1]) items.pop();
    const depth = items.length;
    const push = (kind: BilingualBlockKind, body: string, words = body, marker?: string) =>
      blocks.push({ kind, depth, body, words, marker });
    // A fence opens at most 3 spaces in from the column its block sits at, and closes the same way.
    const base = depth > 0 ? items[depth - 1] : 0;
    const fence = indent - base <= 3 ? /^(```|~~~)/.exec(line.trimStart()) : null;
    if (fence) {
      let close = i + 1;
      while (close < lines.length && !(indentOf(lines[close]) - base <= 3 && lines[close].trimStart().startsWith(fence[1]))) close++;
      if (close < lines.length) {
        push('other', lines.slice(i, close + 1).map((l) => dedent(l, indent)).join('\n'));
        i = close + 1;
        continue;
      }
    }
    const heading = HEADING.exec(line);
    if (heading) {
      push('heading', line.trim(), heading[2].replace(/(?:^| +)#+ *$/, '').trim());
      i++;
      continue;
    }
    if (BREAK.test(line)) {
      push('other', line.trim());
      i++;
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const spaces = item[3].length;
      const column = indent + item[2].length + (spaces >= 1 && spaces <= 4 ? spaces : 1);
      const body = [item[4]];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
        body.push(dedent(lines[i], column));
        i++;
      }
      blocks.push({ kind: 'item', depth, marker: item[2], body: body.join('\n'), words: body.join('\n') });
      items.push(column);
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(/^ {0,3}> ?/, ''));
        i++;
      }
      push('quote', body.join('\n'));
      continue;
    }
    if (TABLE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && TABLE.test(lines[i])) {
        body.push(dedent(lines[i], indent));
        i++;
      }
      push('other', body.join('\n'));
      continue;
    }
    const body = [dedent(line, indent)];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines[i])) {
      body.push(dedent(lines[i], indent));
      i++;
    }
    const joined = body.join('\n');
    push(IMAGES.test(joined.trim()) ? 'other' : 'paragraph', joined);
  }
  return blocks;
}

/** The translation's blocks with the original's matched under them, or null when the two texts do not
 *  split into the same pairable blocks (draw the message whole, as before; board frame 4). */
export function bilingualPairs(translation: string, original: string): BilingualPair[] | null {
  const ours = bilingualBlocks(translation);
  const theirs = bilingualBlocks(original).filter((b) => b.kind !== 'other');
  const pairable = ours.filter((b) => b.kind !== 'other');
  if (pairable.length === 0 || pairable.length !== theirs.length) return null;
  if (pairable.some((b, k) => b.kind !== theirs[k].kind || b.depth !== theirs[k].depth)) return null;
  let k = 0;
  return ours.map((b) => {
    const pair: BilingualPair = { kind: b.kind, depth: b.depth, text: b.body };
    if (b.marker !== undefined) pair.marker = b.marker;
    if (b.kind !== 'other') pair.original = theirs[k++].words;
    return pair;
  });
}

/** How many lines `english` runs to, by the rule above. */
export function bilingualLineCount(english: string): number {
  let lines = 0;
  for (const line of english.split('\n')) {
    const length = [...line.trim()].length;
    if (length > 0) lines += Math.ceil(length / BILINGUAL_LINE_CHARS);
  }
  return lines;
}
