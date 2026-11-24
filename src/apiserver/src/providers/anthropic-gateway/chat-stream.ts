import { StringDecoder } from 'node:string_decoder';
import { CHAT_REASONING_SIGNATURE } from './envelope';
import { anthropicError, type MessagesEvent, type StreamContext } from './stream';

/**
 * A Chat Completions event stream (`chat.completion.chunk`s, then `data: [DONE]`) turned into Anthropic Messages
 * events (docs/claude-engine-openai-gateway-design.md §10.3). Fed the upstream bytes as they come (`push`), it
 * answers the Messages events they complete. Pure: it holds at most one upstream event's text and the open
 * block, and does no I/O.
 *
 * Blocks are written one at a time, as Anthropic's own stream writes them: the provider's reasoning
 * (`reasoning_content`, or `reasoning` as some servers name it) as a `thinking` block, its text as a `text`
 * block, each tool call as a `tool_use` block whose arguments stream as `input_json_delta`s. A new kind of delta
 * closes the open block. Tool calls are told apart by their `index`, and by a new `id` at the same index, which
 * some servers send instead. A fragment for a call already closed (a server that interleaves parallel calls)
 * cannot be written any more and is dropped.
 *
 * The response ends at `[DONE]`, or at the stream's end once a `finish_reason` came. The usage may come on the
 * chunk with the `finish_reason`, on its choice (Moonshot), or on a last chunk with no choices
 * (`stream_options.include_usage`); the last one seen counts.
 */

type Json = Record<string, unknown>;

interface OpenBlock {
  index: number;
  kind: 'text' | 'thinking' | 'tool_use';
  /** For a tool call: its `index` in the chunks, and its id. */
  call?: number;
  id?: string;
}

/**
 * What the gateway records of a response (AnthropicGatewayService `record`): the usage in the Responses shape
 * openai-prices.ts prices (`ResponsesUsage`, restated here so the module imports nothing outside it).
 */
export interface ChatOutcome {
  model?: string;
  usage?: {
    input_tokens: number;
    input_tokens_details: { cached_tokens: number };
    output_tokens: number;
    output_tokens_details: { reasoning_tokens: number };
  };
}

export class ChatStreamConverter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextIndex = 0;
  private open: OpenBlock | undefined;
  /** The `index`es of the tool calls already written, so a late fragment of one is not taken for a new call. */
  private readonly closedCalls = new Set<number>();
  private started = false;
  private finished = false;
  private sawToolCall = false;
  private finishReason: string | undefined;
  private usage: Json | undefined;
  /** What the response used and which model answered, for the gateway's record. */
  readonly outcome: ChatOutcome = {};
  /** The upstream's own failure, when the stream carried one: its code and message, for the key's side effects. */
  failure: { code: string; message: string } | undefined;

  constructor(private readonly ctx: StreamContext) {}

  push(chunk: Buffer | string): MessagesEvent[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out: MessagesEvent[] = [];
    let match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
    while (match) {
      this.readBlock(this.buffer.slice(0, match.index), out);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer);
    }
    return out;
  }

  /** The upstream ended: complete once a finish_reason came, else an error, never a silent stop. */
  end(): MessagesEvent[] {
    this.buffer += this.decoder.end();
    const out: MessagesEvent[] = [];
    if (this.buffer.trim() !== '') this.readBlock(this.buffer, out);
    this.buffer = '';
    if (!this.finished) {
      if (this.finishReason !== undefined) this.complete(out);
      else {
        this.finished = true;
        out.push(errorEvent('api_error', 'The upstream stream ended before the response was complete.'));
      }
    }
    return out;
  }

  get done(): boolean {
    return this.finished;
  }

  private readBlock(block: string, out: MessagesEvent[]): void {
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    }
    if (this.finished) return;
    if (data.length === 0) {
      this.whole(block, out);
      return;
    }
    const text = data.join('\n').trim();
    if (text === '[DONE]') {
      this.complete(out);
      return;
    }
    let event: Json;
    try {
      event = JSON.parse(text) as Json;
    } catch {
      return;
    }
    this.handle(event, out);
  }

  /**
   * A server that ignored `stream: true` answers one `chat.completion` object (or its error) instead of chunks:
   * read as the one chunk it amounts to, its `message` as the delta, and the response complete.
   */
  private whole(block: string, out: MessagesEvent[]): void {
    let body: Json;
    try {
      body = JSON.parse(block) as Json;
    } catch {
      return;
    }
    if (!body || typeof body !== 'object') return;
    const choices = Array.isArray(body.choices)
      ? (body.choices as Json[]).map((c) => ({ ...c, delta: c.message ?? c.delta }))
      : body.choices;
    this.handle({ ...body, choices }, out);
    if (!this.finished) this.complete(out);
  }

  private handle(event: Json, out: MessagesEvent[]): void {
    if (event.error && typeof event.error === 'object') {
      const error = event.error as Json;
      this.fail(String(error.code ?? error.type ?? 'server_error'), String(error.message ?? ''), out);
      return;
    }
    this.start(event, out);
    if (typeof event.model === 'string' && event.model !== '') this.outcome.model = event.model;
    if (event.usage && typeof event.usage === 'object') this.usage = event.usage as Json;
    const choice = (Array.isArray(event.choices) ? (event.choices as Json[]) : []).find((c) => (c?.index ?? 0) === 0);
    if (!choice) return;
    if (choice.usage && typeof choice.usage === 'object') this.usage = choice.usage as Json;
    const delta = (choice.delta as Json | undefined) ?? {};
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning !== '') {
      this.into({ kind: 'thinking' }, { type: 'thinking', thinking: '', signature: '' }, out);
      out.push({ type: 'content_block_delta', index: this.open!.index, delta: { type: 'thinking_delta', thinking: reasoning } });
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      this.into({ kind: 'text' }, { type: 'text', text: '' }, out);
      out.push({ type: 'content_block_delta', index: this.open!.index, delta: { type: 'text_delta', text: delta.content } });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const [position, call] of (delta.tool_calls as Json[]).entries()) this.toolCall(call, position, out);
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') this.finishReason = choice.finish_reason;
  }

  private toolCall(call: Json, position: number, out: MessagesEvent[]): void {
    const index = typeof call.index === 'number' ? call.index : position;
    const fn = (call.function as Json | undefined) ?? {};
    const id = typeof call.id === 'string' && call.id !== '' ? call.id : undefined;
    const args = typeof fn.arguments === 'string' ? fn.arguments : '';
    const open = this.open;
    const same = open?.kind === 'tool_use' && open.call === index && (id === undefined || id === open.id);
    if (!same) {
      // A fragment of a call already written: it can no longer be added to.
      if (id === undefined && this.closedCalls.has(index)) return;
      const callId = id ?? `toolu_${index}_${this.nextIndex}`;
      this.sawToolCall = true;
      this.into(
        { kind: 'tool_use', call: index, id: callId },
        { type: 'tool_use', id: callId, name: String(fn.name ?? ''), input: {} },
        out,
      );
    }
    if (args !== '') out.push({ type: 'content_block_delta', index: this.open!.index, delta: { type: 'input_json_delta', partial_json: args } });
  }

  /** Make `want` the open block: kept when it already is (a text or thinking block), else the open one closed and it started. */
  private into(want: Omit<OpenBlock, 'index'>, contentBlock: Json, out: MessagesEvent[]): void {
    if (this.open && this.open.kind === want.kind && want.kind !== 'tool_use') return;
    this.close(out);
    this.open = { ...want, index: this.nextIndex++ };
    out.push({ type: 'content_block_start', index: this.open.index, content_block: contentBlock });
  }

  private close(out: MessagesEvent[]): void {
    const block = this.open;
    if (!block) return;
    this.open = undefined;
    if (block.kind === 'thinking') {
      out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'signature_delta', signature: CHAT_REASONING_SIGNATURE } });
    }
    if (block.kind === 'tool_use' && block.call !== undefined) this.closedCalls.add(block.call);
    out.push({ type: 'content_block_stop', index: block.index });
  }

  private start(event: Json, out: MessagesEvent[]): void {
    if (this.started) return;
    this.started = true;
    const id = typeof event.id === 'string' && event.id !== '' ? event.id : 'chatcmpl';
    out.push({
      type: 'message_start',
      message: {
        id: `msg_${id}`,
        type: 'message',
        role: 'assistant',
        model: this.ctx.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  private complete(out: MessagesEvent[]): void {
    if (!this.started) {
      // `[DONE]` with nothing before it: no response at all.
      this.fail('server_error', 'the upstream answered no response', out);
      return;
    }
    this.close(out);
    this.finished = true;
    const usage = responsesUsage(this.usage);
    if (usage) this.outcome.usage = usage;
    out.push({ type: 'message_delta', delta: { stop_reason: stopReason(this.finishReason, this.sawToolCall), stop_sequence: null }, usage: chatMessagesUsage(this.usage) });
    out.push({ type: 'message_stop' });
  }

  private fail(code: string, message: string, out: MessagesEvent[]): void {
    this.finished = true;
    this.failure = { code, message };
    const mapped = anthropicError(code, message, this.ctx);
    out.push(errorEvent(mapped.type, mapped.message));
  }
}

function stopReason(finishReason: string | undefined, sawToolCall: boolean): string {
  if (sawToolCall || finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

/**
 * The prompt tokens served from a cache, as each family of servers names them: OpenAI and vLLM in
 * `prompt_tokens_details.cached_tokens`, Moonshot in `cached_tokens`, DeepSeek in `prompt_cache_hit_tokens`.
 */
function cachedTokens(u: Json): number {
  const details = (u.prompt_tokens_details as Json | undefined)?.cached_tokens;
  return count(details ?? u.cached_tokens ?? u.prompt_cache_hit_tokens);
}

/** A Chat Completions `usage` in Anthropic's terms: uncached input apart from the cache read (design §4.4). */
export function chatMessagesUsage(usage: unknown): Json {
  const u = (usage as Json | undefined) ?? {};
  const input = count(u.prompt_tokens);
  const cached = Math.min(input, cachedTokens(u));
  return { input_tokens: input - cached, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: count(u.completion_tokens) };
}

/** The same usage in the Responses shape the gateway's record and openai-prices.ts read; none when the stream named none. */
function responsesUsage(usage: Json | undefined): ChatOutcome['usage'] {
  if (!usage) return undefined;
  const reasoning = count((usage.completion_tokens_details as Json | undefined)?.reasoning_tokens);
  return {
    input_tokens: count(usage.prompt_tokens),
    input_tokens_details: { cached_tokens: cachedTokens(usage) },
    output_tokens: count(usage.completion_tokens),
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function errorEvent(type: string, message: string): MessagesEvent {
  return { type: 'error', error: { type, message } };
}
