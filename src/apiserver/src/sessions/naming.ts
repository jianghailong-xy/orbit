import { randomUUID } from 'crypto';
import { AsyncWorkQueue } from '../common/async-work-queue';

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

const DEEPSEEK_SYSTEM_PROMPT =
  'You name a software-engineering session. Reply with ONLY a JSON object ' +
  '{"title": string}. "title": a concise summary, at most 6 words ' +
  '(or ~16 characters for languages without spaces), no trailing punctuation, written ' +
  "in the SAME language as the user's request — a Chinese request gets a Chinese title, " +
  'an English request an English one. No other text.';

/**
 * A single DeepSeek naming attempt (an OpenAI-compatible chat call). Returns the parsed
 * `{ title? }`, or null on ANY failure — no key configured, non-200, the per-attempt
 * timeout firing, or a body that isn't the expected JSON. NEVER throws. The explicit race is a
 * hard outer bound even when a fetch implementation ignores abort; abort still actively tears
 * down a normal network request.
 */
async function requestNaming(
  input: { prompt: string; title?: string },
  timeoutMs: number,
): Promise<{ title?: string } | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = (async (): Promise<{ title?: string } | null> => {
    const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
    const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    const task = [input.title, input.prompt].filter(Boolean).join('\n').slice(0, 600);
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT },
          { role: 'user', content: task },
        ],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // We do not inspect provider error payloads. Cancel the body so undici can promptly release
      // the response resources instead of retaining them across retries.
      await resp.body?.cancel().catch(() => undefined);
      return null;
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const parsed = JSON.parse(content) as { title?: unknown };
    const title =
      typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 80) : undefined;
    return { title };
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
 * Off the hot path: ask DeepSeek for a cleaner display title. Session creation always uses its
 * synchronous fallback first; this helper can afford a generous timeout and retries. Returns a
 * clean title, or undefined when there's no key or every attempt failed. NEVER throws.
 */
export async function beautifyTitle(
  input: { prompt: string; title?: string },
  opts: { timeoutMs?: number; retries?: number; backoffMs?: number } = {},
): Promise<string | undefined> {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) return undefined;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1_000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await requestNaming(input, timeoutMs);
    if (res?.title) return res.title;
    if (attempt < retries) await sleep(backoffMs * (attempt + 1));
  }
  return undefined;
}

// Naming is cosmetic. Keep slow or unavailable DeepSeek calls from turning a burst of session
// creates into a burst of outbound sockets and timers. The queue is intentionally process-local:
// a restart merely leaves the already-persisted fallback title in place.
export const TITLE_BEAUTIFY_CONCURRENCY = 3;
const beautifyQueue = new AsyncWorkQueue(TITLE_BEAUTIFY_CONCURRENCY);

export function enqueueBeautifyTitle(
  input: { prompt: string; title?: string },
  opts: { timeoutMs?: number; retries?: number; backoffMs?: number } = {},
): Promise<string | undefined> {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) return Promise.resolve(undefined);
  // Do not retain an arbitrarily large compose prompt while earlier requests occupy the queue.
  const boundedInput = { prompt: input.prompt.slice(0, 600), title: input.title?.slice(0, 80) };
  return beautifyQueue.run(() => beautifyTitle(boundedInput, opts));
}
