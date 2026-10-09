import { randomUUID } from 'crypto';
import { AgentProvider, type SessionNamingJob } from '@orbit/shared';
import { AsyncWorkQueue } from '../common/async-work-queue';
import { heldKeyOf, type HeldKey, type HeldKeyRow } from '../providers/held-key';

/**
 * Turn a human title into a git-branch-safe slug: lowercase, non-alphanumerics → '-',
 * trimmed and capped. CJK and punctuation collapse to empty, so a non-ASCII title (e.g.
 * a Chinese task title) yields '' — the caller then falls back to a session-id stub.
 * The random session fallback below keeps those titles safe without waiting on an LLM.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/**
 * A unique per-session git branch under the `orbit/` namespace. The short random suffix
 * guarantees uniqueness, so two sessions with the same title — or an empty slug — never
 * collide on a branch (and git never refuses a second worktree on a shared branch name).
 */
export function makeBranchName(title: string): string {
  const slug = slugify(title);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  return slug ? `orbit/${slug}-${suffix}` : `orbit/session-${suffix}`;
}

/**
 * The immediate display-title fallback when no explicit title was supplied. Takes the first
 * non-blank line — never the whole prompt — so a multi-line request doesn't become a multi-line
 * title that leaks into the session list, the shared page, and exported HTML. Capped at 80 chars.
 */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? prompt.trim();
  return line.slice(0, 80);
}

/**
 * The same fallback for a session opened with attachments and no words: what was sent, by file
 * name. An upload without one (a legacy row) leaves only the generic word. Capped like the above.
 */
export function titleFromAttachments(fileNames: readonly (string | null)[]): string {
  return fileNames.filter(Boolean).join(', ').slice(0, 80) || 'Attachment';
}

/** How a title is written, whoever asks for one. */
const TITLE_RULE =
  '"title": a concise summary, at most 6 words ' +
  '(or ~16 characters for languages without spaces), no trailing punctuation, written ' +
  "in the SAME language as the user's request — a Chinese request gets a Chinese title, " +
  'an English request an English one.';

const NAMING_SYSTEM_PROMPT =
  'You name and label a software-engineering session. Reply with ONLY a JSON object ' +
  '{"title": string, "tags": string[]}. ' +
  TITLE_RULE +
  ' "tags": 1-3 short semantic labels the user can later ' +
  'filter sessions by — the area, component, or kind of work — each at most 2 words and in ' +
  "the title's language. A tag must group this session with OTHER sessions, so never restate " +
  'the title and never name a one-off detail. No other text.';

/**
 * The reuse list, appended to the SYSTEM prompt rather than the user message. It belongs with the
 * instructions, not with the request — and keeping it out of the user turn matters: a library of
 * Chinese tags shown next to an English request made the model answer the English request in
 * Chinese, title included. Hence the explicit language disclaimer; it was not enough to state the
 * language rule once above.
 */
function reusePrompt(knownTags: string[]): string {
  return (
    `\n\nThe user's existing tags: ${knownTags.join(', ')}. ` +
    'REUSE any that fit this session instead of coining a near-duplicate. ' +
    "These are a vocabulary, not an example: their language says nothing about this request's " +
    "language. Still write the title, and any NEW tag, in the language of the user's request."
  );
}

/** Tags are a filter, not a description: past a handful they stop narrowing anything. */
const MAX_SESSION_TAGS = 3;
const MAX_TAG_CHARS = 24;

/**
 * Clean the model's `tags` into names safe to store: strings only, whitespace and a leading
 * '#' trimmed, length-capped, deduped case-insensitively (so "Login"/"login" can't become two
 * rows under the (owner, name) unique), and capped in count. Anything unexpected — a bare
 * string, nested objects, 40 tags — degrades to what survives, never throws.
 */
export function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_CHARS).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    tags.push(name);
    if (tags.length === MAX_SESSION_TAGS) break;
  }
  return tags;
}

/** A title as it is stored: on one line, trimmed and capped like the fallback; undefined if empty. */
export function sanitizeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\s+/g, ' ').trim().slice(0, 80).trim() || undefined;
}

/** What one naming pass yields. `tags` is always an array — empty when the model gave none. */
export interface SessionNaming {
  title?: string;
  tags: string[];
}

/**
 * What a naming pass reads: the request, the owner's tags, and the key to ask on. Without `key` it is
 * the server's DeepSeek key (DEEPSEEK_API_KEY); with one, the session's own (sessionHeldKey).
 */
export interface NamingInput {
  prompt: string;
  title?: string;
  knownTags?: string[];
  key?: HeldKey;
}

/**
 * The model's reply read as `{ title?, tags }`. Only DeepSeek is asked for a JSON mode, so another
 * vendor's model may fence the object or say something around it: the outermost braces are the
 * answer. Throws on a reply with no JSON object in it, which the attempt counts as a failure.
 */
function parseNaming(content: string): SessionNaming {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  const parsed = JSON.parse(start >= 0 && end > start ? content.slice(start, end + 1) : content) as {
    title?: unknown;
    tags?: unknown;
  };
  return { title: sanitizeTitle(parsed.title), tags: sanitizeTags(parsed.tags) };
}

/** One naming request: where it goes, how it is signed, and where the reply's text sits. */
interface NamingCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  text: (data: unknown) => unknown;
}

const chatText = (data: unknown): unknown =>
  (data as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;

/** The text of a reply's text blocks, or undefined when it has none. */
function joinText(blocks: { text?: unknown }[] | undefined): string | undefined {
  const texts = (blocks ?? []).map((block) => block.text).filter((t): t is string => typeof t === 'string');
  return texts.length > 0 ? texts.join('') : undefined;
}

/** The server's own DeepSeek key: an OpenAI-compatible chat call in DeepSeek's JSON mode. */
function deepSeekCall(apiKey: string, system: string, task: string): NamingCall {
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  return {
    url: `${base}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: {
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      temperature: 0.2,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: task },
      ],
    },
    text: chatText,
  };
}

/** Room for a reasoning model, which a session may well run, to think before it answers. */
const HELD_KEY_MAX_TOKENS = 2048;

/**
 * The same request on the session's own key, at the endpoint its engine is pointed at and with the
 * auth that engine is handed — what ProvidersService.testConnection probes: Anthropic Messages, the
 * OpenAI Responses API (all Codex speaks), Chat Completions (Kimi), or Gemini's generateContent. No
 * JSON mode: not every vendor behind these serves one, and parseNaming finds the object in plain text.
 */
function heldKeyCall(key: HeldKey, system: string, task: string): NamingCall {
  const base = key.baseUrl.replace(/\/+$/, '');
  const bearer = { 'Content-Type': 'application/json', Authorization: `Bearer ${key.apiKey}` };
  switch (key.dialect) {
    case 'anthropic':
      return {
        url: `${base}/v1/messages`,
        headers: { ...bearer, 'anthropic-version': '2023-06-01' },
        body: { model: key.model, max_tokens: HELD_KEY_MAX_TOKENS, system, messages: [{ role: 'user', content: task }] },
        // A thinking model's thoughts come as blocks of their own.
        text: (data) =>
          joinText(
            (data as { content?: { type?: string; text?: unknown }[] } | null)?.content?.filter(
              (block) => block.type === 'text',
            ),
          ),
      };
    case 'openai':
      return {
        url: `${base}/responses`,
        headers: bearer,
        body: { model: key.model, instructions: system, input: task, max_output_tokens: HELD_KEY_MAX_TOKENS },
        text: (data) =>
          joinText(
            (data as { output?: { type?: string; content?: { type?: string; text?: unknown }[] }[] } | null)?.output
              ?.filter((item) => item.type === 'message')
              .flatMap((item) => item.content ?? [])
              .filter((part) => part.type === 'output_text'),
          ),
      };
    case 'openai-compatible':
      return {
        url: `${base}/chat/completions`,
        headers: bearer,
        body: {
          model: key.model,
          max_tokens: HELD_KEY_MAX_TOKENS,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: task },
          ],
        },
        text: chatText,
      };
  }
  // Gemini: the key rides in a header of its own, and a thinking model's thoughts are parts of their own.
  return {
    url: `${base}/v1beta/models/${encodeURIComponent(key.model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key.apiKey },
    body: {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: task }] }],
      generationConfig: { maxOutputTokens: HELD_KEY_MAX_TOKENS },
    },
    text: (data) =>
      joinText(
        (
          data as { candidates?: { content?: { parts?: { text?: unknown; thought?: boolean }[] } }[] } | null
        )?.candidates?.[0]?.content?.parts?.filter((part) => !part.thought),
      ),
  };
}

/**
 * A single naming attempt, on the session's own key when `input.key` names one and on the server's
 * DeepSeek key otherwise. Returns the parsed `{ title?, tags }`, or null on ANY failure — no key at
 * all, non-200, the per-attempt timeout firing, or a body without the expected JSON. NEVER throws.
 * The explicit race is a hard outer bound even when a fetch implementation ignores abort; abort still
 * actively tears down a normal network request.
 */
async function requestNaming(input: NamingInput, timeoutMs: number): Promise<SessionNaming | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!input.key && !apiKey) return null;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = (async (): Promise<SessionNaming | null> => {
    const task = [input.title, input.prompt].filter(Boolean).join('\n').slice(0, 600);
    // The owner's own vocabulary. Without it every session coins a fresh near-synonym and the tag
    // filter degrades into a list of one-session labels.
    const system = input.knownTags?.length
      ? NAMING_SYSTEM_PROMPT + reusePrompt(input.knownTags)
      : NAMING_SYSTEM_PROMPT;
    const call = input.key ? heldKeyCall(input.key, system, task) : deepSeekCall(apiKey!, system, task);
    const resp = await fetch(call.url, {
      method: 'POST',
      // A session's key points wherever its owner typed: a redirect is not followed off it, as the
      // connection test follows none.
      redirect: 'manual',
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // We do not inspect provider error payloads. Cancel the body so undici can promptly release
      // the response resources instead of retaining them across retries.
      await resp.body?.cancel().catch(() => undefined);
      return null;
    }
    const content = call.text(await resp.json());
    if (typeof content !== 'string') return null;
    return parseNaming(content);
  })().catch(() => null);
  const timedOut = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([request, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Off the hot path: ask a model — DeepSeek on the server's key, or the session's own provider on its
 * key — for a cleaner display title and a few filing tags. Session creation always uses its
 * synchronous fallback first; this helper can afford a generous timeout and retries. Returns an
 * empty result when there's no key or every attempt failed. NEVER throws. A titled answer ends the
 * loop even with no tags — the title is the part a retry is worth paying for, and a re-ask would just
 * as likely return no tags again.
 */
export async function beautifySession(
  input: NamingInput,
  opts: { timeoutMs?: number; retries?: number; backoffMs?: number } = {},
): Promise<SessionNaming> {
  if (!input.key && !process.env.DEEPSEEK_API_KEY?.trim()) return { tags: [] };
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1_000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await requestNaming(input, timeoutMs);
    if (res?.title) return res;
    if (attempt < retries) await sleep(backoffMs * (attempt + 1));
  }
  return { tags: [] };
}

// Naming is cosmetic. Keep slow or unavailable model calls from turning a burst of session
// creates into a burst of outbound sockets and timers. The queue is intentionally process-local:
// a restart merely leaves the already-persisted fallback title in place.
export const TITLE_BEAUTIFY_CONCURRENCY = 3;
const beautifyQueue = new AsyncWorkQueue(TITLE_BEAUTIFY_CONCURRENCY);

/**
 * How many of the owner's existing tag names are offered to the model as reuse candidates —
 * and, deliberately the same number, the ceiling on the auto-grown library (see applyAutoTags).
 * They are one constant because a tag the model is never shown is a tag it will coin again under
 * a new name: letting the library outgrow the prompt would manufacture the duplicates the reuse
 * list exists to prevent.
 */
export const MAX_KNOWN_TAGS_PROMPTED = 60;

export function enqueueBeautifySession(
  input: NamingInput,
  opts: { timeoutMs?: number; retries?: number; backoffMs?: number } = {},
): Promise<SessionNaming> {
  if (!input.key && !process.env.DEEPSEEK_API_KEY?.trim()) return Promise.resolve({ tags: [] });
  // Do not retain an arbitrarily large compose prompt while earlier requests occupy the queue.
  const boundedInput = {
    prompt: input.prompt.slice(0, 600),
    title: input.title?.slice(0, 80),
    knownTags: input.knownTags?.slice(0, MAX_KNOWN_TAGS_PROMPTED),
    key: input.key,
  };
  return beautifyQueue.run(() => beautifySession(boundedInput, opts));
}

/**
 * What a runner names a session under when the engine running it takes a prompt of Orbit's — the
 * Codex side thread (the claim's `naming.instructions`). A title alone: Claude Code's own naming
 * answers nothing else, so a session an engine names is filed under no tags either way.
 */
export const ENGINE_NAMING_INSTRUCTIONS =
  'You name a software-engineering session. Reply with ONLY a JSON object {"title": string}. ' +
  TITLE_RULE +
  ' No other text.';

/**
 * The claim's `naming`: whether the engine about to run a session should name it, from inside the
 * process running it. Only when nothing else will — the server has no DeepSeek key, and the session's
 * provider holds no key the server may spend (`configuredRow` is the configured row the session's
 * provider names, null for a built-in engine or a pool), since either of those named it at creation
 * (SessionsService.beautifySessionLater) — and only on an engine with a way to answer: Claude Code's
 * own generate_session_title, a Codex side thread. A session whose title is not the one cut from its
 * prompt has a real one already — given by a person, a task, a project, or an earlier naming — and so
 * does any session that opened with no words.
 */
export function engineNamingJob(
  session: { title: string; prompt: string; taskId: string | null; titleManagedByProject: boolean; model: string | null },
  runtime: string,
  configuredRow: HeldKeyRow | null,
): SessionNamingJob | undefined {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return undefined;
  if (runtime !== AgentProvider.CLAUDE && runtime !== AgentProvider.CODEX) return undefined;
  if (session.taskId || session.titleManagedByProject) return undefined;
  if (!session.prompt.trim() || session.title !== titleFromPrompt(session.prompt)) return undefined;
  if (configuredRow && heldKeyOf(configuredRow, session.model?.trim() || undefined, true)) return undefined;
  return { description: session.prompt.slice(0, 600), instructions: ENGINE_NAMING_INSTRUCTIONS };
}
