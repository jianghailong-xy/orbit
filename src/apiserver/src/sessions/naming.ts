import { randomUUID } from 'crypto';

/**
 * Turn a human title into a git-branch-safe slug: lowercase, non-alphanumerics → '-',
 * trimmed and capped. CJK and punctuation collapse to empty, so a non-ASCII title (e.g.
 * a Chinese task title) yields '' — the caller then falls back to a session-id stub.
 * Phase 2 layers an optional DeepSeek call on top to produce a clean English slug for
 * such titles; this is the no-LLM fallback that always works.
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
 * A display title derived from a raw prompt, for when there's no better source (no explicit
 * dto.title and DeepSeek is unavailable/failed). Takes the first non-blank line — never the
 * whole prompt — so a multi-line request doesn't become a multi-line "title" that then leaks
 * into the session list, the shared page, and its exported HTML's <title>. Capped at 80 chars.
 */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? prompt.trim();
  return line.slice(0, 80);
}

export interface NamingResult {
  /** A clean human title from DeepSeek. Undefined → the caller keeps its own title. */
  title?: string;
  /** The git branch to use for this session's worktree. */
  branch: string;
}

const DEEPSEEK_SYSTEM_PROMPT =
  'You name a software-engineering session. Reply with ONLY a JSON object ' +
  '{"title": string, "slug": string}. "title": a concise summary, at most 6 words ' +
  '(or ~16 characters for languages without spaces), no trailing punctuation, written ' +
  "in the SAME language as the user's request — a Chinese request gets a Chinese title, " +
  'an English request an English one. "slug": a git-branch-safe kebab-case form — ' +
  'lowercase ASCII letters, digits and hyphens only, at most 5 words, ALWAYS in English ' +
  'regardless of the title language. No other text.';

/**
 * A single DeepSeek naming attempt (an OpenAI-compatible chat call). Returns the parsed
 * `{ title?, slug? }`, or null on ANY failure — no key configured, non-200, the per-attempt
 * timeout firing, or a body that isn't the expected JSON. NEVER throws. `timeoutMs` bounds this
 * one attempt; callers layer their own fallback (generateNaming) or retry (beautifyTitle) on top.
 */
async function requestNaming(
  input: { prompt: string; title?: string },
  timeoutMs: number,
): Promise<{ title?: string; slug?: string } | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  try {
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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const parsed = JSON.parse(content) as { title?: unknown; slug?: unknown };
    const title =
      typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 80) : undefined;
    const slug = typeof parsed.slug === 'string' ? slugify(parsed.slug) : '';
    return { title, slug: slug || undefined };
  } catch {
    return null;
  }
}

/**
 * Produce a session's title + worktree branch on the session-creation hot path. When
 * DEEPSEEK_API_KEY is set, ask DeepSeek for a concise title in the user's own language plus an
 * always-English branch slug — so a Chinese request yields a Chinese title yet still a readable
 * `orbit/fix-login-500` branch instead of the `orbit/session-<hash>` slug fallback. A SINGLE
 * short attempt (4s): session creation must stay fast and never block on the LLM, so any miss
 * falls back to a deterministic slug of the caller's title/prompt and returns no title (the
 * caller keeps its own, then beautifies asynchronously via beautifyTitle). NEVER throws.
 */
export async function generateNaming(input: { prompt: string; title?: string }): Promise<NamingResult> {
  const fallback = (): NamingResult => ({ branch: makeBranchName(input.title ?? input.prompt.slice(0, 80)) });
  const res = await requestNaming(input, 4000);
  if (!res) return fallback();
  // Build the branch from the clean slug; if DeepSeek's slug was unusable, slug the title it
  // returned, then the caller's title/prompt — makeBranchName re-slugs defensively.
  return {
    title: res.title,
    branch: makeBranchName(res.slug || res.title || input.title || input.prompt.slice(0, 80)),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Off the hot path: re-attempt the DeepSeek title for a session whose creation-time call missed
 * (DeepSeek briefly slow past the 4s cap, or a transient error), so its list entry still lands a
 * clean title once the service recovers. Runs in the background and blocks nothing, so it can
 * afford a generous per-attempt timeout and a few retries — unlike generateNaming's single fast
 * attempt. Returns a clean title, or undefined when there's no key or every attempt failed.
 * NEVER throws.
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
