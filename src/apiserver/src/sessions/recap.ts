import { RunEventType, type KeyDialect } from '@orbit/shared';
import type { Prisma } from '@prisma/client';
import { AsyncWorkQueue } from '../common/async-work-queue';
import { sessionHeldKey, type HeldKey } from '../providers/held-key';
import { deepSeekCall, heldKeyCall } from './naming';
import { truncatePayload } from './truncate-payload';

/**
 * The rolling session recap (Session.recapText): the sentence or two the session list shows in
 * place of the last raw reply.
 *
 * It is written off the settle path. Turn completion and finalization ask for a pass and never
 * wait on one (enqueueRecap), the pass folds the events since the previous pass's cursor
 * (recapEventSeq) together with the recap that came before, and a compare-and-set write advances
 * the cursor — so a long session costs one small call per settle rather than a re-read of the
 * whole transcript. Everything that can go wrong is a silent skip: no key, a provider answer
 * that fails or times out, a session with too little to say. Nothing here throws, and nothing
 * here may ever delay the turn it is describing.
 */

/** What the model is asked to write, and the longest recap that is stored: one list line. */
export const RECAP_MAX_CHARS = 80;

/** No second pass within this long of the previous one, unless the session is finalizing. */
export const RECAP_MIN_INTERVAL_MS = 2 * 60_000;

/** Fewer events than this is a session that has barely started — there is nothing to recap yet. */
export const RECAP_MIN_EVENTS = 4;

/** Hard ceiling on one pass's input, in estimated tokens, the instruction included. */
export const RECAP_INPUT_TOKEN_BUDGET = 8_000;

/** Room for a sentence or two in a wide script, or for a reasoning model to think before it writes. */
const RECAP_MAX_TOKENS = 1_024;

/** One rendered event is clipped here before the token budget is applied. */
export const RECAP_EVENT_CHARS = 800;

/** The most events one pass reads: the budget binds long before this on any realistic session. */
const RECAP_MAX_EVENTS = 200;

export const RECAP_TIMEOUT_MS = 30_000;
export const RECAP_RETRIES = 3;
const RECAP_BACKOFF_MS = 1_000;
export const RECAP_CONCURRENCY = 3;

/** The events a recap is written from: what the owner and the agent said, and the tools it ran. */
const RECAP_EVENT_TYPES: readonly RunEventType[] = [
  RunEventType.USER,
  RunEventType.ASSISTANT,
  RunEventType.TOOL_USE,
];

/** A run_event row as one recap pass reads it. */
export interface RecapEventRow {
  seq: number;
  type: string;
  payload: unknown;
}

/** One recap request: which session, and whether this settle is its last. */
export interface RecapInput {
  db: Prisma.TransactionClient;
  sessionId: string;
  /**
   * A finalize — the session is over and this recap is the one it keeps. It ignores the throttle
   * window; every other settle obeys it.
   */
  finalize?: boolean;
  /**
   * A pass a person asked for — POST /sessions/:id/recap. It ignores the throttle window exactly
   * as a finalize does, and says nothing about the session being over. It obeys every other gate:
   * the kill switch, the minimum event count, and a provider that may simply have no key.
   */
  force?: boolean;
}

export interface RecapOptions {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  /** The clock the throttle window is measured against. */
  now?: Date;
}

/** Why a pass did not write, or what it wrote. */
export type RecapOutcome =
  | { written: true; recapText: string; recapEventSeq: number }
  | { written: false; reason: RecapSkipReason };

export type RecapSkipReason =
  | 'disabled'
  | 'no-session'
  | 'throttled'
  | 'too-few-events'
  | 'no-events'
  | 'no-key'
  | 'llm-failed'
  | 'cas-lost'
  | 'error';

/**
 * A deliberately pessimistic token estimate: one token per non-ASCII character — CJK tokenizers
 * split those close to 1:1, and an emoji costs more than the two units it is stored as — and one
 * per four ASCII characters. Enough to hold a hard input ceiling without shipping a tokenizer for
 * every dialect we might be asking.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) wide += 1;
  }
  return Math.ceil(wide + (text.length - wide) / 4);
}

/**
 * A model's answer as it is stored: one line — the session list draws it beside a title — trimmed
 * to the length the prompt asked for. An overlong answer is cut rather than rejected, with an
 * ellipsis so a clipped sentence does not read as the model's own.
 */
export function sanitizeRecap(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length <= RECAP_MAX_CHARS) return text;
  return `${text.slice(0, RECAP_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * The recap out of a model's reply: the answer itself, or its `recap` field when the model wrapped
 * it in a JSON object — the DeepSeek call asks for plain text here, but a held key's model may
 * answer in whatever shape its vendor prefers.
 */
export function parseRecap(content: string): string | undefined {
  const text = content.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { recap?: unknown };
      const fromJson = sanitizeRecap(parsed.recap);
      if (fromJson) return fromJson;
    } catch {
      // Not JSON — the answer is the recap itself.
    }
  }
  return sanitizeRecap(text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, ''));
}

/** `value` as one line of JSON, or nothing when it cannot be serialised. */
function jsonish(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function clipLine(line: string): string {
  return line.length <= RECAP_EVENT_CHARS ? line : `${line.slice(0, RECAP_EVENT_CHARS - 1)}…`;
}

/**
 * One event as the model reads it — a labelled, clipped line — or null for an event with nothing
 * to say (an empty assistant stretch, a tool_use the runner recorded without a name). A tool_use
 * carries its input through truncatePayload first, so a Write's whole file body is clipped before
 * it is ever serialised.
 */
function renderEvent(event: RecapEventRow): string | null {
  const payload = (event.payload ?? {}) as {
    text?: unknown;
    content?: unknown;
    name?: unknown;
    input?: unknown;
  };
  if (event.type === RunEventType.TOOL_USE) {
    const name = typeof payload.name === 'string' ? payload.name.replace(/\s+/g, ' ').trim() : '';
    if (!name) return null;
    const clipped = truncatePayload(event.type, event.payload, RECAP_EVENT_CHARS).payload as { input?: unknown };
    return clipLine(`TOOL ${name} ${jsonish(clipped.input)}`.trim());
  }
  // A user event is the runner's echo of the delivered input, so `text` or its legacy `content`.
  const said = typeof payload.text === 'string' && payload.text.trim()
    ? payload.text
    : typeof payload.content === 'string' && payload.content.trim()
      ? payload.content
      : '';
  if (!said) return null;
  const label = event.type === RunEventType.USER ? 'USER' : 'ASSISTANT';
  return clipLine(`${label}: ${said.replace(/\s+/g, ' ').trim()}`);
}

/** The newest events that fit `budgetTokens`, in the order the model should read them. */
export interface RecapActivity {
  /** The rendered activity, oldest first; empty when nothing fitted or nothing had text. */
  text: string;
  /** The seq of the newest event the activity covers, for the cursor; null when it covers none. */
  lastSeq: number | null;
}

/**
 * Walk the events backwards from the newest — the settle just happened, so the tail is what the
 * recap has to be about — and keep as many lines as the budget pays for. The oldest events fall
 * out first when a pass has more new activity than the ceiling allows; they are covered by the
 * previous recap's account of the session so far, and the next pass starts from wherever this one
 * left the cursor.
 */
export function fitRecapActivity(events: readonly RecapEventRow[], budgetTokens: number): RecapActivity {
  const kept: string[] = [];
  let used = 0;
  let lastSeq: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const line = renderEvent(events[i]);
    if (line === null) continue;
    const cost = estimateTokens(line) + 1; // the newline that joins it to the rest
    // A single line is clipped to RECAP_EVENT_CHARS, so it is always under the whole budget.
    if (used + cost > budgetTokens) break;
    kept.push(line);
    used += cost;
    lastSeq ??= events[i].seq;
  }
  kept.reverse();
  return { text: kept.join('\n'), lastSeq };
}

/** The user half of the request: the previous recap, when there is one, then the new activity. */
export function buildRecapTask(previous: string | null, activity: string): string {
  const parts: string[] = [];
  if (previous) parts.push(`Previous recap:\n${previous}`);
  parts.push(`New activity:\n${activity}`);
  return parts.join('\n\n');
}

/**
 * What the model is asked for, word for word. English, like every word the server writes: the
 * recap itself comes back in the conversation's own language, which the last sentence says.
 */
const RECAP_SYSTEM_PROMPT =
  'You write the one-line recap shown for a coding session in its owner\'s session list. Fold ' +
  'the previous recap, when there is one, and the NEW activity after it into a single up-to-date ' +
  'recap of the whole session: what was done, how it was verified, and what comes next. ' +
  `At most ${RECAP_MAX_CHARS} characters, one or two short sentences, plain text on a single ` +
  'line: no markdown, no quotes, no bullet points. Write it from the owner\'s point of view and in ' +
  'the SAME language as the conversation. Reply with the recap and nothing else.';

/** The deployment's kill switch: ORBIT_RECAP_ENABLED=0 turns every pass off. */
export function recapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORBIT_RECAP_ENABLED !== '0';
}

/**
 * Whether a settle at `now` may spend on a recap, read off the values a caller already has: the
 * switch, the two-minute window (which a finalize does not obey), and the minimum event count that
 * keeps one-shot sessions out of the model's queue. `finalize` is any pass that ignores the window
 * — a session's last settle, or a person's refresh — and the callers below map their own flags
 * onto it. Null is "go ahead".
 */
export function recapSkipReason(
  session: { recapAt: Date | null },
  eventCount: number,
  opts: { finalize?: boolean; now: Date },
): RecapSkipReason | null {
  if (!recapEnabled()) return 'disabled';
  if (
    !opts.finalize
    && session.recapAt !== null
    && opts.now.getTime() - session.recapAt.getTime() < RECAP_MIN_INTERVAL_MS
  ) {
    return 'throttled';
  }
  return eventCount < RECAP_MIN_EVENTS ? 'too-few-events' : null;
}

/** What a pass reads of the session: the recap and its cursor, and what a held key needs. */
const RECAP_SESSION_SELECT = {
  recapText: true,
  recapEventSeq: true,
  recapAt: true,
  provider: true,
  providerBuiltin: true,
  ownerId: true,
  model: true,
} satisfies Prisma.SessionSelect;

/** The session's own event count against RECAP_MIN_EVENTS — one indexed aggregate. */
function countRecapEvents(db: Prisma.TransactionClient, sessionId: string): Promise<number> {
  return db.runEvent.count({ where: { sessionId, type: { in: [...RECAP_EVENT_TYPES] } } });
}

/**
 * The events a pass feeds the model: the recap-eligible ones after the cursor, read newest first —
 * a session with a large backlog must not be read whole — and handed back oldest first.
 */
async function loadRecapEvents(
  db: Prisma.TransactionClient,
  sessionId: string,
  cursor: number | null,
): Promise<RecapEventRow[]> {
  const rows = await db.runEvent.findMany({
    where: { sessionId, seq: { gt: cursor ?? 0 }, type: { in: [...RECAP_EVENT_TYPES] } },
    orderBy: { seq: 'desc' },
    take: RECAP_MAX_EVENTS,
    select: { seq: true, type: true, payload: true },
  });
  return rows.reverse();
}

/**
 * The model a held key is spent on: fixed per dialect and chosen cheap — Anthropic's Haiku tier
 * for an Anthropic endpoint. Never the session's own model, which may be an Opus or a Sonnet at
 * ten to sixty times the price. An endpoint that does not serve the fixed model fails, and the
 * pass degrades to lastAssistantText in silence, which is the whole point of the ceiling.
 */
const RECAP_HELD_KEY_MODELS: Record<KeyDialect, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-5.1-mini',
  'openai-compatible': 'kimi-k2.6',
  gemini: 'gemini-3.6-flash',
};

export function recapHeldKeyModel(dialect: KeyDialect): string {
  return RECAP_HELD_KEY_MODELS[dialect];
}

/** One recap request: where it goes, how it is signed, and where the reply's text sits. */
type RecapCall = ReturnType<typeof deepSeekCall>;

/**
 * Where a recap request goes, in the order the project settled on: the server's own DeepSeek key
 * first, the session's provider key second, and nothing at all when neither exists — the caller
 * treats that as no key and stops.
 */
function recapCall(system: string, task: string, heldKey: HeldKey | null): RecapCall | null {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (apiKey) return deepSeekCall(apiKey, system, task, { json: false, maxTokens: RECAP_MAX_TOKENS });
  if (heldKey) return heldKeyCall({ ...heldKey, model: recapHeldKeyModel(heldKey.dialect) }, system, task);
  return null;
}

/**
 * One attempt, bounded by an explicit race so a fetch implementation that ignores abort cannot hang
 * the pass. Returns the parsed recap, or null on ANY failure: a non-200, the timeout firing, a body
 * without text, or an answer that parses to nothing. Never throws.
 */
async function requestRecap(call: RecapCall, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = (async (): Promise<string | null> => {
    const resp = await fetch(call.url, {
      method: 'POST',
      // A session's key points wherever its owner typed: a redirect is not followed off it.
      redirect: 'manual',
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // We do not inspect provider error payloads; release the body so undici can promptly free
      // the response instead of retaining it across retries.
      await resp.body?.cancel().catch(() => undefined);
      return null;
    }
    const content = call.text(await resp.json());
    return typeof content === 'string' ? (parseRecap(content) ?? null) : null;
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
 * One recap pass, start to finish: gate, read the new events, ask a model, and — only on a parsed
 * answer — compare-and-set the three fields the recap lives in. Writes nothing when the model
 * failed, and concedes silently when another pass advanced the cursor first. NEVER throws; every
 * ending is a RecapOutcome the caller may ignore.
 */
export async function generateRecap(input: RecapInput, opts: RecapOptions = {}): Promise<RecapOutcome> {
  try {
    const now = opts.now ?? new Date();
    const session = await input.db.session.findFirst({
      where: { id: input.sessionId },
      select: RECAP_SESSION_SELECT,
    });
    if (!session) return { written: false, reason: 'no-session' };
    const skip = recapSkipReason(session, await countRecapEvents(input.db, input.sessionId), {
      finalize: input.finalize || input.force,
      now,
    });
    if (skip) return { written: false, reason: skip };
    // The ceiling covers the whole request: the instruction, the previous recap, and the activity.
    const budget = RECAP_INPUT_TOKEN_BUDGET
      - estimateTokens(RECAP_SYSTEM_PROMPT)
      - estimateTokens(buildRecapTask(session.recapText, ''));
    const events = await loadRecapEvents(input.db, input.sessionId, session.recapEventSeq);
    const activity = fitRecapActivity(events, Math.max(0, budget));
    if (!activity.text || activity.lastSeq === null) return { written: false, reason: 'no-events' };
    // Only a pass that has something to send pays for the held-key lookup, and the server's own
    // key skips it entirely.
    const heldKey = process.env.DEEPSEEK_API_KEY?.trim() ? null : await sessionHeldKey(input.db, session);
    const call = recapCall(RECAP_SYSTEM_PROMPT, buildRecapTask(session.recapText, activity.text), heldKey);
    if (!call) return { written: false, reason: 'no-key' };
    const timeoutMs = opts.timeoutMs ?? RECAP_TIMEOUT_MS;
    const retries = opts.retries ?? RECAP_RETRIES;
    const backoffMs = opts.backoffMs ?? RECAP_BACKOFF_MS;
    for (let attempt = 0; ; attempt++) {
      const recap = await requestRecap(call, timeoutMs);
      if (recap) {
        // Compare-and-set on the cursor the read produced: a pass that raced this one changed it,
        // and this recap is then stale by construction — the newer pass's recap stands.
        const updated = await input.db.session.updateMany({
          where: { id: input.sessionId, recapEventSeq: session.recapEventSeq },
          data: { recapText: recap, recapAt: now, recapEventSeq: activity.lastSeq },
        });
        if (updated.count === 0) return { written: false, reason: 'cas-lost' };
        return { written: true, recapText: recap, recapEventSeq: activity.lastSeq };
      }
      if (attempt >= retries) return { written: false, reason: 'llm-failed' };
      await sleep(backoffMs * (attempt + 1));
    }
  } catch {
    return { written: false, reason: 'error' };
  }
}

/**
 * The settle hooks' gate, before anything is queued: whether this settlement is worth a pass at
 * all. One indexed read of the session row plus one aggregate over its events — never the whole
 * transcript, and never an LLM call. A pass re-checks both on its own, so a hook may skip this and
 * a race cannot produce two recaps from one cursor.
 */
export async function recapDue(input: RecapInput, opts: { now?: Date } = {}): Promise<boolean> {
  try {
    if (!recapEnabled()) return false;
    const session = await input.db.session.findFirst({
      where: { id: input.sessionId },
      select: { recapAt: true },
    });
    if (!session) return false;
    const skip = recapSkipReason(session, await countRecapEvents(input.db, input.sessionId), {
      finalize: input.finalize || input.force,
      now: opts.now ?? new Date(),
    });
    return skip === null;
  } catch {
    return false;
  }
}

// Recaps are cosmetic next to the work they describe, and settles arrive in bursts — a fan-out of
// sub-sessions finishing together. The queue is process-local, like naming's: a restart merely
// leaves the previous recap standing until the next settle.
const recapQueue = new AsyncWorkQueue(RECAP_CONCURRENCY);

/**
 * Ask for a recap of one session, off the settle path. Resolves with what the pass did and NEVER
 * rejects, so a caller may fire it and forget it — which is exactly what the settle hooks do:
 * nothing here may delay the turn being settled.
 */
export function enqueueRecap(input: RecapInput, opts: RecapOptions = {}): Promise<RecapOutcome> {
  if (!recapEnabled()) return Promise.resolve({ written: false, reason: 'disabled' });
  return recapQueue.run(() => generateRecap(input, opts));
}
