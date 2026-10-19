import { WIKI_SYSTEM_MODEL, type WikiSystemModelErrorKind } from '@orbit/shared';

/**
 * The System model's client (contract `systemModel.request` and `.health`, design §4.5 and §6): what
 * Claude Code did implicitly for the runner's `claude -p --bare`, done here explicitly.
 *
 *   - One call is `POST {base}/v1/messages` with the key as a Bearer and `anthropic-version: 2023-06-01`:
 *     a system prompt and one user message, `stream: true`, the call's own `max_tokens`, no tools and no
 *     thinking. The answer is read as it streams, with Node's own fetch, and its server-sent events are
 *     parsed here: message_start, content_block_delta, message_delta (with the usage), message_stop, error.
 *   - Three things end a call early, all through one AbortController: its own budget, five minutes without
 *     a byte (idle), and the caller's signal (cancel). The text received so far is handed to the caller
 *     after every delta, and carried by the error of a call that fails — the partial the queue keeps.
 *   - A failure is classed `retryable` (5xx, 429, a connection that failed, dropped or went idle),
 *     `unauthorized` (401: the key was refused) or `other`, and its message names neither the endpoint's
 *     address nor its key, so it can be stored and shown as it is.
 *   - The probe is `GET {base}/health`: 200 and 404 are up, 401 is the key refused, anything else down.
 *
 * Connections are fetch's: kept alive and reused, with no per-origin limit below the queue's concurrency.
 */

/** Where the System model answers, and as whom: the worker's configuration (wiki-system-model.ts). */
export interface WikiModelEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** One call: a system prompt, one user message, and the call's own limits. */
export interface WikiModelCall {
  system: string;
  prompt: string;
  /** Sent as max_tokens. Every call names its own; there is no default. */
  maxTokens: number;
  /** The call's whole budget, in milliseconds: its step's limit. */
  timeoutMs: number;
  /** The most milliseconds without a byte before the call is disconnected; the contract's 5 minutes by default. */
  idleTimeoutMs?: number;
  /** The caller's cancel. */
  signal?: AbortSignal;
  /** Handed the text received so far, after every delta. */
  onPartial?: (text: string) => void;
}

export interface WikiModelAnswer {
  text: string;
  /** message_delta's stop_reason (end_turn, max_tokens, …); null when the stream never gave one. */
  stopReason: string | null;
  /** The model message_start names, which an endpoint may spell differently from the one asked for. */
  model: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

/** How a call failed, beside the class the contract gives it. */
export type WikiModelFailure = 'http' | 'connection' | 'idle' | 'timeout' | 'cancelled' | 'stream' | 'protocol';

export class WikiModelError extends Error {
  constructor(
    readonly kind: WikiSystemModelErrorKind,
    readonly failure: WikiModelFailure,
    message: string,
    /** The HTTP status the endpoint answered, when it answered one. */
    readonly status: number | null,
    /** The text received before the call failed. */
    readonly partial: string,
  ) {
    super(message);
    this.name = 'WikiModelError';
  }
}

/** The headers both the call and the probe send. */
function headersFor(endpoint: WikiModelEndpoint): Record<string, string> {
  return { authorization: `Bearer ${endpoint.apiKey}`, 'anthropic-version': WIKI_SYSTEM_MODEL.anthropicVersion };
}

/** `text` with the endpoint's key, URL and host taken out, cut to `max` characters: words safe to store and show. */
function scrub(text: string, endpoint: WikiModelEndpoint, max = 300): string {
  const url = new URL(endpoint.baseUrl);
  let out = text;
  for (const secret of [endpoint.apiKey, endpoint.baseUrl, url.host, url.hostname]) {
    if (secret.length >= 4) out = out.split(secret).join('…');
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** What a connection error says about itself without its message, which names the address it tried. */
function connectionCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; name?: unknown } } | null)?.cause;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof cause?.name === 'string') return cause.name;
  return 'no connection';
}

/** Whether `error` is fetch's own failure to connect or to keep the connection: `fetch failed`, `terminated`. */
function isConnectionError(error: unknown): boolean {
  return error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated');
}

const ENDED_BY = { timeout: 'timeout', idle: 'idle', cancelled: 'cancelled' } as const;
type EndedBy = keyof typeof ENDED_BY;

/**
 * How long the end of the stream is waited for once message_stop has arrived. Read to its end, the connection goes
 * back to fetch's pool for the next call; a server that keeps it open past this is let go, the answer being whole.
 */
const STREAM_END_GRACE_MS = 1_000;

/** The classes of the SSE error event's types (contract `systemModel.request.errors`). */
function streamErrorKind(type: string): WikiSystemModelErrorKind {
  if (type === 'authentication_error') return 'unauthorized';
  return ['overloaded_error', 'api_error', 'rate_limit_error'].includes(type) ? 'retryable' : 'other';
}

function statusKind(status: number): WikiSystemModelErrorKind {
  if (status === 401) return 'unauthorized';
  return status === 429 || status >= 500 ? 'retryable' : 'other';
}

/** The error a non-2xx answer becomes: its status, and the endpoint's own error type and message if it gave them. */
async function httpError(response: Response, endpoint: WikiModelEndpoint, partial: string): Promise<WikiModelError> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 4096);
  } catch {
    // The status is the answer; a body that does not arrive adds nothing to it.
  }
  let type: string | null = null;
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const error = parsed.error as { type?: unknown; message?: unknown } | string | undefined;
    if (error && typeof error === 'object') {
      type = typeof error.type === 'string' ? error.type : null;
      detail = typeof error.message === 'string' ? error.message : '';
    } else if (typeof error === 'string') {
      detail = error;
    } else if (typeof parsed.message === 'string') {
      detail = parsed.message;
    }
  } catch {
    // Not JSON: the body itself, scrubbed below, is the detail.
  }
  const said = scrub(detail, endpoint);
  const message = `HTTP ${response.status}${type ? ` ${type}` : ''}${said ? `: ${said}` : ''}`;
  return new WikiModelError(statusKind(response.status), 'http', message, response.status, partial);
}

/**
 * Server-sent events, a line at a time (the WHATWG rules the Messages API streams by): `event:` names the
 * event, `data:` lines are joined with newlines, a blank line dispatches, a line starting `:` is a comment.
 * A CR at the end of one chunk is held back, since its LF may be the first byte of the next.
 */
class EventStream {
  private buffer = '';
  private name = '';
  private data: string[] = [];

  constructor(private readonly dispatch: (name: string, data: string) => void) {}

  push(chunk: string): void {
    let text = this.buffer + chunk;
    let held = '';
    if (text.endsWith('\r')) {
      held = '\r';
      text = text.slice(0, -1);
    }
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    this.buffer = (lines.pop() ?? '') + held;
    for (const line of lines) this.line(line);
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.dispatch(this.name || 'message', this.data.join('\n'));
      this.name = '';
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.name = value;
    else if (field === 'data') this.data.push(value);
  }
}

interface StreamUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
}

/**
 * One call to the System model, streamed. Resolves with the whole answer once message_stop arrives; rejects
 * with a WikiModelError whose `partial` is what had arrived. An error thrown by `onPartial` is the caller's
 * own and is passed through as it is.
 */
export async function askWikiSystemModel(endpoint: WikiModelEndpoint, call: WikiModelCall): Promise<WikiModelAnswer> {
  const controller = new AbortController();
  const end = (why: EndedBy) => controller.abort(ENDED_BY[why]);
  const idleMs = call.idleTimeoutMs ?? WIKI_SYSTEM_MODEL.idleTimeoutSeconds * 1000;
  let idle: NodeJS.Timeout | undefined;
  /** A byte arrived (or the request is about to go out): the idle clock starts over — briefly, after message_stop. */
  const heard = () => {
    clearTimeout(idle);
    idle = setTimeout(() => end('idle'), stopped ? STREAM_END_GRACE_MS : idleMs);
  };
  const budget = setTimeout(() => end('timeout'), call.timeoutMs);
  const cancel = () => end('cancelled');
  if (call.signal?.aborted) cancel();
  else call.signal?.addEventListener('abort', cancel, { once: true });

  let text = '';
  let status: number | null = null;
  let stopReason: string | null = null;
  let answeredBy: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopped = false;
  const answer = (): WikiModelAnswer => ({ text, stopReason, model: answeredBy, usage: { inputTokens, outputTokens } });
  const counted = (usage: StreamUsage | undefined) => {
    if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens;
    if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
  };
  const onEvent = (name: string, data: string) => {
    if (stopped) return;
    let event: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(data);
      event = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      event = null;
    }
    const type = typeof event?.type === 'string' ? event.type : name;
    if (type === 'error') {
      const error = (event?.error ?? {}) as { type?: unknown; message?: unknown };
      const kind = typeof error.type === 'string' ? error.type : 'error';
      const said = typeof error.message === 'string' ? scrub(error.message, endpoint) : '';
      throw new WikiModelError(streamErrorKind(kind), 'stream', `stream error ${kind}${said ? `: ${said}` : ''}`, status, text);
    }
    // Data that is not an event object — a `[DONE]` some servers end with — names nothing to act on.
    if (!event) return;
    if (type === 'message_start') {
      const message = (event.message ?? {}) as { model?: unknown; usage?: StreamUsage };
      if (typeof message.model === 'string') answeredBy = message.model;
      counted(message.usage);
    } else if (type === 'content_block_delta') {
      const delta = (event.delta ?? {}) as { type?: unknown; text?: unknown };
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        text += delta.text;
        call.onPartial?.(text);
      }
    } else if (type === 'message_delta') {
      const delta = (event.delta ?? {}) as { stop_reason?: unknown };
      if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
      counted(event.usage as StreamUsage | undefined);
    } else if (type === 'message_stop') {
      stopped = true;
    }
    // ping, content_block_start, content_block_stop and events this client does not know are read past.
  };

  try {
    heard();
    const response = await fetch(`${endpoint.baseUrl}${WIKI_SYSTEM_MODEL.messagesPath}`, {
      method: 'POST',
      headers: { ...headersFor(endpoint), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        model: endpoint.model,
        max_tokens: call.maxTokens,
        system: call.system,
        messages: [{ role: 'user', content: call.prompt }],
        stream: true,
      }),
      signal: controller.signal,
    });
    status = response.status;
    heard();
    if (!response.ok) throw await httpError(response, endpoint, text);
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.body || !/^text\/event-stream\b/i.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new WikiModelError('other', 'protocol', `HTTP ${status} answered ${contentType || 'no content type'}, not an event stream`, status, text);
    }
    const events = new EventStream(onEvent);
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      events.push(decoder.decode(chunk, { stream: true }));
      heard();
    }
    if (!stopped) {
      throw new WikiModelError('retryable', 'connection', 'the stream closed before message_stop', status, text);
    }
    return answer();
  } catch (error) {
    if (error instanceof WikiModelError) throw error;
    // message_stop arrived and the stream was not closed soon after it: the answer is whole all the same.
    if (stopped) return answer();
    const reason = controller.signal.reason as unknown;
    if (controller.signal.aborted && reason === ENDED_BY.idle) {
      throw new WikiModelError('retryable', 'idle', `no byte arrived for ${Math.round(idleMs / 1000)} s: disconnected`, status, text);
    }
    if (controller.signal.aborted && reason === ENDED_BY.timeout) {
      throw new WikiModelError('other', 'timeout', `the call ran out of its ${Math.round(call.timeoutMs / 1000)} s`, status, text);
    }
    if (controller.signal.aborted && reason === ENDED_BY.cancelled) {
      throw new WikiModelError('other', 'cancelled', 'the call was cancelled', status, text);
    }
    if (isConnectionError(error)) {
      throw new WikiModelError('retryable', 'connection', `the connection failed (${connectionCode(error)})`, status, text);
    }
    throw error;
  } finally {
    clearTimeout(budget);
    clearTimeout(idle);
    call.signal?.removeEventListener('abort', cancel);
  }
}

/** What one probe found, and why it is not up in words that name neither the address nor the key. */
export interface WikiModelHealth {
  state: 'up' | 'down' | 'auth_failed';
  error: string | null;
}

/** `GET {base}/health` once (contract `systemModel.health`). Never throws: a probe that fails is `down`. */
export async function probeWikiSystemModel(
  endpoint: WikiModelEndpoint,
  timeoutMs: number = WIKI_SYSTEM_MODEL.probeTimeoutSeconds * 1000,
): Promise<WikiModelHealth> {
  const path = WIKI_SYSTEM_MODEL.healthPath;
  try {
    const response = await fetch(`${endpoint.baseUrl}${path}`, {
      headers: headersFor(endpoint),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only the status is read; the body is let go of rather than waited for.
    await response.body?.cancel().catch(() => undefined);
    if ((WIKI_SYSTEM_MODEL.healthUpStatuses as readonly number[]).includes(response.status)) return { state: 'up', error: null };
    if (response.status === 401) return { state: 'auth_failed', error: `the key was refused: ${path} answered HTTP 401` };
    return { state: 'down', error: `${path} answered HTTP ${response.status}` };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return { state: 'down', error: `${path} did not answer within ${Math.round(timeoutMs / 1000)} s` };
    }
    return { state: 'down', error: `${path} could not be reached (${connectionCode(error)})` };
  }
}
