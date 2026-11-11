import { StringDecoder } from 'node:string_decoder';
import { encodeReasoningSignature } from './envelope';

/**
 * A Responses API event stream turned into Anthropic Messages events (docs/claude-engine-openai-gateway-design.md
 * §4.4). Fed the upstream bytes as they come (`push`), it answers the Messages SSE text to write on. Pure: it
 * holds at most one upstream event's text and the open blocks' indexes, and does no I/O.
 */

type Json = Record<string, unknown>;

export interface MessagesEvent {
  type: string;
  [key: string]: unknown;
}

export interface StreamContext {
  /** The model name to report in `message_start`: the one the CLI asked for. */
  model: string;
  /** For a `context_length_exceeded` failure: the window to name in the "prompt is too long" wording. */
  contextWindow?: number;
  /** For the same: what the request is estimated to hold (request.ts estimateInputTokens). */
  inputTokensEstimate?: number;
}

interface OpenBlock {
  index: number;
  kind: 'text' | 'thinking' | 'tool_use';
  /** A function call whose arguments came in deltas; otherwise they are sent whole at its end. */
  sawArguments?: boolean;
  /** A reasoning item's summary part count, to separate parts. */
  parts?: number;
}

export class MessagesStreamConverter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private nextIndex = 0;
  private readonly open = new Map<number, OpenBlock>();
  private started = false;
  private finished = false;
  private sawFunctionCall = false;
  /** Web searches answered so far, for `usage.server_tool_use.web_search_requests`. */
  private searches = 0;
  /** Searches whose result block waits for the answer's citations: their call listed no sources. */
  private readonly unlisted: string[] = [];
  private lastSearch: string | undefined;
  /** Every URL a result block has listed, and the answer's citations not yet listed, by URL. */
  private readonly listed = new Set<string>();
  private readonly cited = new Map<string, string>();
  /**
   * The upstream's own failure, when the response ended in one (`response.failed`, a stream `error`): its
   * code and message as OpenAI gave them, for the gateway's key side effects (design §5.4).
   */
  failure: { code: string; message: string } | undefined;

  constructor(private readonly ctx: StreamContext) {}

  /** Upstream bytes in, the Messages events they complete out. */
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

  /** The upstream ended. A stream that ended without a final event answers an error, never a silent stop. */
  end(): MessagesEvent[] {
    this.buffer += this.decoder.end();
    const out: MessagesEvent[] = [];
    if (this.buffer.trim() !== '') this.readBlock(this.buffer, out);
    this.buffer = '';
    if (!this.finished) {
      this.finished = true;
      out.push(errorEvent('api_error', 'The upstream stream ended before the response was complete.'));
    }
    return out;
  }

  /** True once the response ended, by a final event or an error. */
  get done(): boolean {
    return this.finished;
  }

  private readBlock(block: string, out: MessagesEvent[]): void {
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    }
    if (data.length === 0) return;
    const text = data.join('\n');
    if (text === '[DONE]') return;
    let event: Json;
    try {
      event = JSON.parse(text) as Json;
    } catch {
      return;
    }
    if (!this.finished) this.handle(event, out);
  }

  private handle(event: Json, out: MessagesEvent[]): void {
    const type = String(event.type ?? '');
    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        this.start((event.response as Json | undefined) ?? {}, out);
        return;
      case 'response.output_item.added':
        this.start({}, out);
        this.itemAdded(Number(event.output_index), (event.item as Json | undefined) ?? {}, out);
        return;
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        this.delta(Number(event.output_index), 'text', { type: 'text_delta', text: String(event.delta ?? '') }, out);
        return;
      case 'response.reasoning_summary_part.added': {
        const block = this.open.get(Number(event.output_index));
        if (block?.kind !== 'thinking') return;
        if ((block.parts = (block.parts ?? 0) + 1) > 1) {
          out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'thinking_delta', thinking: '\n\n' } });
        }
        return;
      }
      case 'response.reasoning_summary_text.delta':
        this.delta(Number(event.output_index), 'thinking', { type: 'thinking_delta', thinking: String(event.delta ?? '') }, out);
        return;
      case 'response.function_call_arguments.delta': {
        const block = this.open.get(Number(event.output_index));
        if (block?.kind !== 'tool_use') return;
        block.sawArguments = true;
        out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: String(event.delta ?? '') } });
        return;
      }
      case 'response.output_text.annotation.added':
        this.cite(event.annotation);
        return;
      case 'response.output_item.done':
        this.itemDone(Number(event.output_index), (event.item as Json | undefined) ?? {}, out);
        return;
      case 'response.completed':
      case 'response.incomplete':
        this.complete((event.response as Json | undefined) ?? {}, out);
        return;
      case 'response.failed': {
        const error = ((event.response as Json | undefined)?.error as Json | undefined) ?? {};
        this.fail(String(error.code ?? 'server_error'), String(error.message ?? ''), out);
        return;
      }
      case 'error': {
        const error = (event.error as Json | undefined) ?? event;
        this.fail(String(error.code ?? error.type ?? 'server_error'), String(error.message ?? ''), out);
        return;
      }
      default:
        return;
    }
  }

  private start(response: Json, out: MessagesEvent[]): void {
    if (this.started) return;
    this.started = true;
    const id = typeof response.id === 'string' ? response.id : 'resp';
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

  private itemAdded(outputIndex: number, item: Json, out: MessagesEvent[]): void {
    let block: OpenBlock;
    let contentBlock: Json;
    if (item.type === 'message') {
      block = { index: this.nextIndex++, kind: 'text' };
      contentBlock = { type: 'text', text: '' };
    } else if (item.type === 'reasoning') {
      block = { index: this.nextIndex++, kind: 'thinking' };
      contentBlock = { type: 'thinking', thinking: '', signature: '' };
    } else if (item.type === 'function_call') {
      this.sawFunctionCall = true;
      block = { index: this.nextIndex++, kind: 'tool_use' };
      contentBlock = { type: 'tool_use', id: String(item.call_id ?? ''), name: String(item.name ?? ''), input: {} };
    } else {
      return; // A web_search_call becomes blocks once it is done and names its query (webSearchDone).
    }
    this.open.set(outputIndex, block);
    out.push({ type: 'content_block_start', index: block.index, content_block: contentBlock });
  }

  private delta(outputIndex: number, kind: OpenBlock['kind'], delta: Json, out: MessagesEvent[]): void {
    const block = this.open.get(outputIndex);
    if (block?.kind !== kind) return;
    out.push({ type: 'content_block_delta', index: block.index, delta });
  }

  private itemDone(outputIndex: number, item: Json, out: MessagesEvent[]): void {
    if (item.type === 'web_search_call') this.webSearchDone(item, out);
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as Json[]) {
        if (Array.isArray(part.annotations)) for (const a of part.annotations as unknown[]) this.cite(a);
      }
    }
    const block = this.open.get(outputIndex);
    if (!block) return;
    this.open.delete(outputIndex);
    if (block.kind === 'thinking') {
      const signature = encodeReasoningSignature({
        id: String(item.id ?? ''),
        ...(typeof item.encrypted_content === 'string' ? { encrypted_content: item.encrypted_content } : {}),
      });
      out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'signature_delta', signature } });
    }
    if (block.kind === 'tool_use' && !block.sawArguments && typeof item.arguments === 'string' && item.arguments !== '') {
      out.push({ type: 'content_block_delta', index: block.index, delta: { type: 'input_json_delta', partial_json: item.arguments } });
    }
    out.push({ type: 'content_block_stop', index: block.index });
  }

  /**
   * A finished `web_search_call` → the `server_tool_use` block Anthropic's server writes for a search, then its
   * `web_search_tool_result` (design §4.7). The CLI's WebSearch tool reads the query from the first and the
   * results' titles and URLs from the second (websearch.json). The results are the call's sources when it
   * lists them; otherwise the answer's url_citations, in a result block written once the answer is done.
   * `open_page` and `find_in_page` actions are not searches and write nothing.
   */
  private webSearchDone(item: Json, out: MessagesEvent[]): void {
    const action = (item.action as Json | undefined) ?? {};
    if (action.type !== undefined && action.type !== 'search') return;
    const queries = Array.isArray(action.queries) ? (action.queries as unknown[]) : [];
    const query = typeof action.query === 'string' ? action.query : typeof queries[0] === 'string' ? queries[0] : '';
    const id = `srvtoolu_${typeof item.id === 'string' && item.id !== '' ? item.id : String(this.searches)}`;
    this.searches += 1;
    this.lastSearch = id;
    const index = this.nextIndex++;
    out.push({ type: 'content_block_start', index, content_block: { type: 'server_tool_use', id, name: 'web_search', input: {} } });
    out.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } });
    out.push({ type: 'content_block_stop', index });
    const sources = (Array.isArray(action.sources) ? (action.sources as Json[]) : [])
      .map((source) => (typeof source?.url === 'string' ? source.url : ''))
      .filter((url) => url !== '' && !this.listed.has(url));
    if (sources.length === 0) {
      this.unlisted.push(id);
      return;
    }
    this.results(id, [...new Set(sources)].map((url) => ({ url, title: url })), out);
  }

  private cite(annotation: unknown): void {
    const a = annotation as Json | undefined;
    if (a?.type !== 'url_citation' || typeof a.url !== 'string' || this.cited.has(a.url)) return;
    this.cited.set(a.url, typeof a.title === 'string' && a.title !== '' ? a.title : a.url);
  }

  private results(id: string, found: Array<{ url: string; title: string }>, out: MessagesEvent[]): void {
    for (const r of found) this.listed.add(r.url);
    const index = this.nextIndex++;
    const content = found.map((r) => ({ type: 'web_search_result', title: r.title, url: r.url, encrypted_content: '', page_age: null }));
    out.push({ type: 'content_block_start', index, content_block: { type: 'web_search_tool_result', tool_use_id: id, content } });
    out.push({ type: 'content_block_stop', index });
  }

  /**
   * Once the answer is done: the searches that listed no sources get their result block, and the answer's
   * citations no result has listed go in the last search's — so a cited page is never missing from the links.
   */
  private resultsFromCitations(out: MessagesEvent[]): void {
    const found = [...this.cited].filter(([url]) => !this.listed.has(url)).map(([url, title]) => ({ url, title }));
    this.unlisted.forEach((id, i) => this.results(id, i < this.unlisted.length - 1 ? [] : found, out));
    if (this.unlisted.length === 0 && found.length > 0 && this.lastSearch) this.results(this.lastSearch, found, out);
    this.unlisted.length = 0;
  }

  private closeOpen(out: MessagesEvent[]): void {
    for (const [outputIndex] of [...this.open.entries()].sort((a, b) => a[1].index - b[1].index)) {
      this.itemDone(outputIndex, {}, out);
    }
  }

  private complete(response: Json, out: MessagesEvent[]): void {
    this.start(response, out);
    this.closeOpen(out);
    this.resultsFromCitations(out);
    this.finished = true;
    const output = Array.isArray(response.output) ? (response.output as Json[]) : [];
    if (output.some((o) => o.type === 'function_call')) this.sawFunctionCall = true;
    const usage = messagesUsage(response.usage);
    if (this.searches > 0) usage.server_tool_use = { web_search_requests: this.searches };
    out.push({ type: 'message_delta', delta: { stop_reason: stopReason(response, this.sawFunctionCall), stop_sequence: null }, usage });
    out.push({ type: 'message_stop' });
  }

  private fail(code: string, message: string, out: MessagesEvent[]): void {
    this.finished = true;
    this.failure = { code, message };
    const mapped = anthropicError(code, message, this.ctx);
    out.push(errorEvent(mapped.type, mapped.message));
  }
}

function stopReason(response: Json, sawFunctionCall: boolean): string {
  if (sawFunctionCall) return 'tool_use';
  if (response.status === 'incomplete') {
    const reason = (response.incomplete_details as Json | undefined)?.reason;
    if (reason === 'max_output_tokens') return 'max_tokens';
    if (reason === 'content_filter') return 'refusal';
  }
  return 'end_turn';
}

/** Design §4.4: Anthropic counts uncached input apart from the cache read; output includes reasoning. */
export function messagesUsage(usage: unknown): Json {
  const u = (usage as Json | undefined) ?? {};
  const input = Number(u.input_tokens ?? 0);
  const cached = Number((u.input_tokens_details as Json | undefined)?.cached_tokens ?? 0);
  return {
    input_tokens: Math.max(0, input - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: Number(u.output_tokens ?? 0),
  };
}

function errorEvent(type: string, message: string): MessagesEvent {
  return { type: 'error', error: { type, message } };
}

/**
 * An upstream error code in Anthropic's terms. The one wording the CLI acts on is the overflow: it compacts
 * and retries only on "prompt is too long" (toolong-r2.json); OpenAI's own wording makes it re-send the same
 * request once and give up (toolong-openai.json). This is the type of an `error` event in a stream that
 * had already begun; every other failure is answered by the gateway's gatewayFailure (design §5.4).
 */
export function anthropicError(code: string, message: string, ctx: Pick<StreamContext, 'contextWindow' | 'inputTokensEstimate'>): { type: string; message: string } {
  if (code === 'context_length_exceeded') {
    const max = ctx.contextWindow;
    if (typeof max === 'number' && max > 0) {
      const actual = Math.max(ctx.inputTokensEstimate ?? 0, max + 1);
      return { type: 'invalid_request_error', message: `prompt is too long: ${actual} tokens > ${max} maximum` };
    }
    return { type: 'invalid_request_error', message: 'prompt is too long' };
  }
  if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') return { type: 'rate_limit_error', message: message || code };
  if (code === 'invalid_prompt' || code === 'invalid_request_error') return { type: 'invalid_request_error', message: message || code };
  return { type: 'overloaded_error', message: message || 'The upstream model is overloaded.' };
}

/** Messages events as the SSE text the CLI reads. */
export function toSse(events: readonly MessagesEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** A keep-alive for a long silent upstream phase (design §4.4). */
export const PING_SSE = toSse([{ type: 'ping' }]);

/**
 * The Messages events of one response put together as the single message a non-streaming request answers
 * with, or the error it ended in.
 */
export function assembleMessage(events: readonly MessagesEvent[]): { message: Json } | { error: { type: string; message: string } } {
  let message: Json | undefined;
  const blocks: Json[] = [];
  const json: string[] = [];
  for (const e of events) {
    if (e.type === 'error') return { error: e.error as { type: string; message: string } };
    if (e.type === 'message_start') message = { ...(e.message as Json), content: blocks };
    else if (e.type === 'content_block_start') {
      blocks[e.index as number] = { ...(e.content_block as Json) };
      json[e.index as number] = '';
    } else if (e.type === 'content_block_delta') {
      const b = blocks[e.index as number];
      const d = e.delta as Json;
      if (d.type === 'text_delta') b.text = String(b.text ?? '') + String(d.text);
      else if (d.type === 'thinking_delta') b.thinking = String(b.thinking ?? '') + String(d.thinking);
      else if (d.type === 'signature_delta') b.signature = d.signature;
      else if (d.type === 'input_json_delta') json[e.index as number] += String(d.partial_json);
    } else if (e.type === 'content_block_stop') {
      const b = blocks[e.index as number];
      if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        const raw = json[e.index as number];
        try {
          b.input = raw ? JSON.parse(raw) : {};
        } catch {
          b.input = {};
        }
      }
    } else if (e.type === 'message_delta' && message) {
      const d = e.delta as Json;
      message.stop_reason = d.stop_reason;
      message.stop_sequence = d.stop_sequence ?? null;
      message.usage = e.usage;
    }
  }
  if (!message) return { error: { type: 'api_error', message: 'The upstream sent no response.' } };
  return { message };
}
