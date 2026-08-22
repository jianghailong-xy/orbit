"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_KNOWN_TAGS_PROMPTED = exports.TITLE_BEAUTIFY_CONCURRENCY = void 0;
exports.slugify = slugify;
exports.makeBranchName = makeBranchName;
exports.titleFromPrompt = titleFromPrompt;
exports.sanitizeTags = sanitizeTags;
exports.beautifySession = beautifySession;
exports.enqueueBeautifySession = enqueueBeautifySession;
const crypto_1 = require("crypto");
const async_work_queue_1 = require("../common/async-work-queue");
/**
 * Turn a human title into a git-branch-safe slug: lowercase, non-alphanumerics → '-',
 * trimmed and capped. CJK and punctuation collapse to empty, so a non-ASCII title (e.g.
 * a Chinese task title) yields '' — the caller then falls back to a session-id stub.
 * The random session fallback below keeps those titles safe without waiting on an LLM.
 */
function slugify(title) {
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
function makeBranchName(title) {
    const slug = slugify(title);
    const suffix = (0, crypto_1.randomUUID)().replace(/-/g, '').slice(0, 6);
    return slug ? `orbit/${slug}-${suffix}` : `orbit/session-${suffix}`;
}
/**
 * The immediate display-title fallback when no explicit title was supplied. Takes the first
 * non-blank line — never the whole prompt — so a multi-line request doesn't become a multi-line
 * title that leaks into the session list, the shared page, and exported HTML. Capped at 80 chars.
 */
function titleFromPrompt(prompt) {
    const line = prompt.split('\n').map((l) => l.trim()).find(Boolean) ?? prompt.trim();
    return line.slice(0, 80);
}
const DEEPSEEK_SYSTEM_PROMPT = 'You name and label a software-engineering session. Reply with ONLY a JSON object ' +
    '{"title": string, "tags": string[]}. "title": a concise summary, at most 6 words ' +
    '(or ~16 characters for languages without spaces), no trailing punctuation, written ' +
    "in the SAME language as the user's request — a Chinese request gets a Chinese title, " +
    'an English request an English one. "tags": 1-3 short semantic labels the user can later ' +
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
function reusePrompt(knownTags) {
    return (`\n\nThe user's existing tags: ${knownTags.join(', ')}. ` +
        'REUSE any that fit this session instead of coining a near-duplicate. ' +
        "These are a vocabulary, not an example: their language says nothing about this request's " +
        "language. Still write the title, and any NEW tag, in the language of the user's request.");
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
function sanitizeTags(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const tags = [];
    for (const raw of value) {
        if (typeof raw !== 'string')
            continue;
        const name = raw.trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_CHARS).trim();
        if (!name || seen.has(name.toLowerCase()))
            continue;
        seen.add(name.toLowerCase());
        tags.push(name);
        if (tags.length === MAX_SESSION_TAGS)
            break;
    }
    return tags;
}
/**
 * A single DeepSeek naming attempt (an OpenAI-compatible chat call). Returns the parsed
 * `{ title?, tags }`, or null on ANY failure — no key configured, non-200, the per-attempt
 * timeout firing, or a body that isn't the expected JSON. NEVER throws. The explicit race is a
 * hard outer bound even when a fetch implementation ignores abort; abort still actively tears
 * down a normal network request.
 */
async function requestNaming(input, timeoutMs) {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey)
        return null;
    const controller = new AbortController();
    let timeout;
    const request = (async () => {
        const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
        const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
        const task = [input.title, input.prompt].filter(Boolean).join('\n').slice(0, 600);
        // The owner's own vocabulary. Without it every session coins a fresh near-synonym and the tag
        // filter degrades into a list of one-session labels.
        const system = input.knownTags?.length
            ? DEEPSEEK_SYSTEM_PROMPT + reusePrompt(input.knownTags)
            : DEEPSEEK_SYSTEM_PROMPT;
        const resp = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                temperature: 0.2,
                max_tokens: 200,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: system },
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
        const data = (await resp.json());
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string')
            return null;
        const parsed = JSON.parse(content);
        const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 80) : undefined;
        return { title, tags: sanitizeTags(parsed.tags) };
    })().catch(() => null);
    const timedOut = new Promise((resolve) => {
        timeout = setTimeout(() => {
            controller.abort();
            resolve(null);
        }, Math.max(0, timeoutMs));
    });
    try {
        return await Promise.race([request, timedOut]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Off the hot path: ask DeepSeek for a cleaner display title and a few filing tags. Session
 * creation always uses its synchronous fallback first; this helper can afford a generous timeout
 * and retries. Returns an empty result when there's no key or every attempt failed. NEVER throws.
 * A titled answer ends the loop even with no tags — the title is the part a retry is worth paying
 * for, and a re-ask would just as likely return no tags again.
 */
async function beautifySession(input, opts = {}) {
    if (!process.env.DEEPSEEK_API_KEY?.trim())
        return { tags: [] };
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const retries = opts.retries ?? 3;
    const backoffMs = opts.backoffMs ?? 1_000;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await requestNaming(input, timeoutMs);
        if (res?.title)
            return res;
        if (attempt < retries)
            await sleep(backoffMs * (attempt + 1));
    }
    return { tags: [] };
}
// Naming is cosmetic. Keep slow or unavailable DeepSeek calls from turning a burst of session
// creates into a burst of outbound sockets and timers. The queue is intentionally process-local:
// a restart merely leaves the already-persisted fallback title in place.
exports.TITLE_BEAUTIFY_CONCURRENCY = 3;
const beautifyQueue = new async_work_queue_1.AsyncWorkQueue(exports.TITLE_BEAUTIFY_CONCURRENCY);
/**
 * How many of the owner's existing tag names are offered to the model as reuse candidates —
 * and, deliberately the same number, the ceiling on the auto-grown library (see applyAutoTags).
 * They are one constant because a tag the model is never shown is a tag it will coin again under
 * a new name: letting the library outgrow the prompt would manufacture the duplicates the reuse
 * list exists to prevent.
 */
exports.MAX_KNOWN_TAGS_PROMPTED = 60;
function enqueueBeautifySession(input, opts = {}) {
    if (!process.env.DEEPSEEK_API_KEY?.trim())
        return Promise.resolve({ tags: [] });
    // Do not retain an arbitrarily large compose prompt while earlier requests occupy the queue.
    const boundedInput = {
        prompt: input.prompt.slice(0, 600),
        title: input.title?.slice(0, 80),
        knownTags: input.knownTags?.slice(0, exports.MAX_KNOWN_TAGS_PROMPTED),
    };
    return beautifyQueue.run(() => beautifySession(boundedInput, opts));
}
//# sourceMappingURL=naming.js.map