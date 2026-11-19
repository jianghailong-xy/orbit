import type { TranslationLanguage } from './translation';

/**
 * Prompt optimizer (Settings › General › Composer, design docs/prompt-optimizer-design.md, board
 * docs/mocks/prompt-optimizer/01-board.png): DeepSeek improves the owner's draft in the composer
 * before it is sent. The server owns the whole feature — it calls DeepSeek with its own key
 * (DEEPSEEK_API_KEY), never a session's — so a client only reads and writes the fields below.
 *
 * WHAT A CLIENT READS AND WRITES
 * ==============================
 *  - `GET /users/me` → `preferences.promptOptimizer` (PromptOptimizerPreferences) and
 *    `promptOptimizerAvailable` (MePromptOptimizer). Absent `promptOptimizer` is ON;
 *    only an explicit `false` turns it off (owner's decision of 2026-11-16).
 *    `promptOptimizerAvailable: false` is board frame 1b: the switch is drawn disabled with the
 *    DEEPSEEK_API_KEY notice, and the composer shows no ✦ Optimize button.
 *  - `PATCH /users/me/preferences` with `{ promptOptimizer? }`. The answer is the same shape as
 *    `/users/me`.
 *  - `POST /prompt-optimizations` with PromptOptimizationRequest, answered 200 with
 *    PromptOptimization. One DeepSeek call per press; the result is a card above the composer
 *    (frame 4), and the input box changes only when the owner presses Use or Edit, then use.
 *    Refusals:
 *      · 409 `{ code: 'PROMPT_OPTIMIZER_OFF' }` — the switch is off or the server has no key;
 *      · 404 — a session, workspace or project the caller does not own;
 *      · 400 — an empty draft, or one over PROMPT_OPTIMIZER_MAX_DRAFT_CHARS;
 *      · 422 `{ code: 'PROMPT_OPTIMIZATION_FAILED', reason }` (PromptOptimizationFailedReason) —
 *        frame 6, "Couldn't optimize this draft · Try again".
 *  - Sends. `POST /sessions/:id/turns`, a new session's opening message (`POST /sessions`) and a
 *    revive (`POST /sessions/:id/resume`) accept `optimizedTranslation?: string` and
 *    `skipTranslation?: boolean` (D2). With a `gloss`, Use inserts the gloss, and a send whose text is
 *    still exactly it carries `optimizedTranslation: text`: the turn is held as any translated message
 *    and released with that text, with no translator call. Without a gloss, Use inserts `text`, and an
 *    unedited send carries `skipTranslation: true`: never held, no `translation`. Once the owner edits
 *    the text, send neither.
 *
 * CONTEXT (D1 A)
 * ==============
 *  The server reads only what it already holds: the session's recap, its last turns (fitted to the
 *  recap's input budget), the workspace name, the Orbit project's goal and acceptance criteria, and
 *  up to three wiki entries the wiki search finds for the draft. `contextUsed` lists exactly the
 *  sources that contributed, which the card draws as "Used: …" chips. A draft answering a card also
 *  carries what it answers (`replyingTo`), which the client holds and the server does not; it is
 *  not one of the chips, since the card it came from is on screen.
 *
 * LANGUAGE (D2 A)
 * ===============
 *  With the owner's Translation on, the optimized prompt is in the account's agent language
 *  (`preferences.translationAgentLanguage`, English by default; `language` is that code) and `gloss`
 *  is the same prompt in the owner's language: the card opens on it, "Show in <language>" flips to `text`, and
 *  Use inserts it. Otherwise — Translation
 *  off, or the owner's language the agent's — the prompt is in the draft's own language and there is no gloss.
 */

/** The key of `User.preferences` (UserPreferences) this feature owns. Account-wide. */
export interface PromptOptimizerPreferences {
  /** Absent = off. */
  promptOptimizer?: boolean;
}

/** Added to `GET /users/me` (and every answer shaped like it). */
export interface MePromptOptimizer {
  /** The server holds a DeepSeek key and so can optimize. False: Settings shows the switch disabled
   *  with the board frame 1b notice. */
  promptOptimizerAvailable: boolean;
}

/** The longest draft `POST /prompt-optimizations` takes, in characters; a longer one is a 400. */
export const PROMPT_OPTIMIZER_MAX_DRAFT_CHARS = 8_000;

/** How long one optimization may take before it fails with reason TIMEOUT (as a translation). */
export const PROMPT_OPTIMIZER_TIMEOUT_MS = 20_000;

/** The body of `POST /prompt-optimizations`. A session supplies its own workspace and project; a
 *  brand-new draft has no session yet, so it names the workspace (and project) the composer picked. */
export interface PromptOptimizationRequest {
  draft: string;
  sessionId?: string;
  workspaceId?: string;
  projectId?: string;
  /** Set while the draft answers a card through its "Chat about this": what it answers, as the card
   *  shows it — the agent's question with its options, or the card's subject and the facts it carries.
   *  The optimizer keeps the draft a reply to it. The server reads at most
   *  PROMPT_OPTIMIZER_MAX_REPLYING_TO_CHARS of it. */
  replyingTo?: string;
}

/** How much of `replyingTo` the server reads; the rest is dropped, not refused. */
export const PROMPT_OPTIMIZER_MAX_REPLYING_TO_CHARS = 4_000;

/** One run of the optimized prompt. `added` marks text drawn from context, which the card tints. */
export interface PromptOptimizationSegment {
  text: string;
  added: boolean;
}

/** One source of context the optimization read: a "Used: …" chip. */
export type PromptOptimizationContextUsed =
  | { kind: 'TURNS'; count: number }
  | { kind: 'RECAP' }
  | { kind: 'PROJECT'; title: string }
  | { kind: 'WIKI'; count: number }
  | { kind: 'WORKSPACE'; name: string };

/** The 200 answer of `POST /prompt-optimizations`. */
export interface PromptOptimization {
  /** Concatenated, they are the optimized prompt. */
  segments: PromptOptimizationSegment[];
  /** The concatenation of `segments`, for clients that do not tint. */
  text: string;
  /** The account's agent language when the owner's Translation is on; otherwise the draft's own language. */
  language: TranslationLanguage;
  /** Present only when Translation is on: the same prompt in the owner's language, for reading. */
  gloss?: string;
  /** Exactly the sources that contributed, in the order the card draws them. */
  contextUsed: PromptOptimizationContextUsed[];
}

/** The 409 code: the switch is off for this account, or the server has no DeepSeek key. */
export const PROMPT_OPTIMIZER_OFF_CODE = 'PROMPT_OPTIMIZER_OFF' as const;

/** The 422 code: DeepSeek did not produce a usable optimization. */
export const PROMPT_OPTIMIZATION_FAILED_CODE = 'PROMPT_OPTIMIZATION_FAILED' as const;

/** Why an optimization failed (the 422's `reason`). */
export const PROMPT_OPTIMIZATION_FAILED_REASONS = ['TIMEOUT', 'HTTP', 'NETWORK', 'EMPTY', 'TRUNCATED', 'MALFORMED'] as const;
export type PromptOptimizationFailedReason = (typeof PROMPT_OPTIMIZATION_FAILED_REASONS)[number];

/** The 422 body. */
export interface PromptOptimizationFailedBody {
  code: typeof PROMPT_OPTIMIZATION_FAILED_CODE;
  reason: PromptOptimizationFailedReason;
  message: string;
}
