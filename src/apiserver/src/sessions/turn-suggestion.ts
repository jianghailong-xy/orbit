import { AsyncWorkQueue } from '../common/async-work-queue';
import { deepSeekCall } from './naming';

/**
 * The next-message guess for engines without one of their own (docs/prompt-suggestions-design.md
 * §8 P2): every engine but Claude Code has no `--prompt-suggestions`, so after a turn ends the
 * runner asks the server, and the server asks DeepSeek. The input is just this turn — the person's
 * message and the last thing the agent said — never the transcript. Best-effort end to end, like
 * the naming pass this file follows: off the hot path, concurrency-capped, and NEVER throws.
 */

const TURN_SUGGESTION_SYSTEM_PROMPT =
  'You predict what the user will type next in a software-engineering session with a coding ' +
  'agent, from the last exchange alone. Reply with ONLY the predicted message: one short line, ' +
  "an instruction the user would give next, in the user's language. When the next step is not " +
  'obvious, reply with an empty message.';

/** The cap the runner files under (maxPromptSuggestionRunes); a longer answer is dropped, not cut. */
export const MAX_TURN_SUGGESTION_CHARS = 200;

/** What one suggestion pass reads. `assistantText` is empty when the turn answered with no words. */
export interface TurnSuggestionInput {
  userText: string;
  assistantText?: string;
}

/**
 * The model's reply as it is offered: the first line, unquoted (a model that wraps its answer in
 * quotes or backticks means the words without them), capped. Anything else is no suggestion.
 */
export function sanitizeTurnSuggestion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .split('\n')[0]
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!text || [...text].length > MAX_TURN_SUGGESTION_CHARS) return undefined;
  return text;
}

/**
 * A single suggestion attempt on the server's DeepSeek key. Returns the sanitized guess, or
 * undefined on ANY failure — no key, non-200, the timeout firing, or a reply with nothing to
 * offer. NEVER throws. The explicit race is a hard outer bound even when a fetch implementation
 * ignores abort; abort still actively tears down a normal network request. No retry: the guess is
 * worth something only while the person is still looking at the answer it was predicted from, and
 * the next turn asks again.
 */
async function requestTurnSuggestion(input: TurnSuggestionInput, timeoutMs: number): Promise<string | undefined> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return undefined;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const request = (async (): Promise<string | undefined> => {
    const task =
      `The user's message:\n${input.userText}` +
      (input.assistantText ? `\n\nThe agent's reply:\n${input.assistantText}` : '');
    const call = deepSeekCall(apiKey, TURN_SUGGESTION_SYSTEM_PROMPT, task, { json: false, maxTokens: 120 });
    const resp = await fetch(call.url, {
      method: 'POST',
      // The suggestion goes to DeepSeek's own endpoint; follow no redirect off it, like naming.
      redirect: 'manual',
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return sanitizeTurnSuggestion(call.text(await resp.json()));
  })().catch(() => undefined);
  const timedOut = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, Math.max(0, timeoutMs));
  });
  try {
    return await Promise.race([request, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function generateTurnSuggestion(
  input: TurnSuggestionInput,
  opts: { timeoutMs?: number } = {},
): Promise<string | undefined> {
  return requestTurnSuggestion(input, opts.timeoutMs ?? 20_000);
}

// Suggestions are cosmetic and transient. Keep slow or unavailable model calls from turning a
// burst of finished turns into a burst of outbound sockets and timers. The queue is intentionally
// process-local: a restart merely leaves the composer without a guess.
export const TURN_SUGGESTION_CONCURRENCY = 3;
const suggestionQueue = new AsyncWorkQueue(TURN_SUGGESTION_CONCURRENCY);

export function enqueueTurnSuggestion(input: TurnSuggestionInput): Promise<string | undefined> {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) return Promise.resolve(undefined);
  // Do not retain an arbitrarily large turn while earlier requests occupy the queue. The caps are
  // the design's (§8 P2): the person's message at 600 chars, the reply at 2000.
  const boundedInput = {
    userText: input.userText.slice(0, 600),
    assistantText: input.assistantText?.slice(0, 2000),
  };
  return suggestionQueue.run(() => generateTurnSuggestion(boundedInput));
}
