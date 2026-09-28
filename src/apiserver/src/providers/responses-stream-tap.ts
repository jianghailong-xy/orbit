import { StringDecoder } from 'node:string_decoder';
import type { ResponsesUsage } from './openai-prices';

/**
 * What the pool gateway learns from a Responses API answer on its way to codex: what it used, and — when
 * it ended in an error — which one. Read off a copy of the bytes as they pass (`push`), never off the
 * bytes codex gets, which the gateway forwards untouched.
 */
export interface ResponsesOutcome {
  /** The model that answered, as the answer names it. */
  model?: string;
  /** The tier it was served on (`default`, `priority`, `flex`), which prices it. */
  serviceTier?: string;
  /** The token counts of the response, from the event that ended it. */
  usage?: ResponsesUsage;
  /** The error code the answer ended with — `insufficient_quota`, `rate_limit_exceeded`, … */
  errorCode?: string;
}

/** The events that end a response and carry it whole, usage included. */
const FINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed']);

/**
 * A server-sent event stream of the Responses API, parsed only as far as the gateway needs: the one
 * event that ends the response (`response.completed`, `.incomplete` or `.failed`) and a stream-level
 * `error`. Every other event — the deltas are nearly all of them — is recognised by its `event:` line or
 * its `"type"` and skipped without being parsed, so reading along costs next to nothing.
 *
 * Holds at most one event's text at a time.
 */
export class ResponsesStreamTap {
  readonly outcome: ResponsesOutcome = {};
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let boundary = eventBoundary(this.buffer);
    while (boundary) {
      this.read(this.buffer.slice(0, boundary.at));
      this.buffer = this.buffer.slice(boundary.at + boundary.length);
      boundary = eventBoundary(this.buffer);
    }
  }

  /** The stream ended: an event it did not close with a blank line still counts. */
  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.trim() !== '') this.read(this.buffer);
    this.buffer = '';
  }

  private read(block: string): void {
    let name = '';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    }
    if (data.length === 0) return;
    const text = data.join('\n');
    if (name !== '' && !FINAL_EVENTS.has(name) && name !== 'error') return;
    if (name === '' && !/"type"\s*:\s*"(?:response\.(?:completed|incomplete|failed)|error)"/.test(text)) return;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    readResponsesEvent(event, this.outcome);
  }
}

/** Where the first event of `text` ends: a blank line, in any of the three spellings SSE allows. */
function eventBoundary(text: string): { at: number; length: number } | null {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(text);
  return match ? { at: match.index, length: match[0].length } : null;
}

/**
 * What one parsed Responses API event says about the outcome: the final `response` object of a
 * completed, incomplete or failed response, or a stream-level `error`. Also what a non-streamed JSON
 * answer is read with — a whole `response` object, or an `{ "error": … }` body.
 */
export function readResponsesEvent(event: unknown, into: ResponsesOutcome): void {
  if (!event || typeof event !== 'object') return;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (FINAL_EVENTS.has(type) && record.response && typeof record.response === 'object') {
    readResponse(record.response as Record<string, unknown>, into);
    return;
  }
  if (type === 'error') {
    const code = stringOf(record.code) ?? stringOf((record.error as Record<string, unknown> | undefined)?.code);
    if (code) into.errorCode = code;
    return;
  }
  if (record.object === 'response') {
    readResponse(record, into);
    return;
  }
  const error = record.error as Record<string, unknown> | null | undefined;
  if (error && typeof error === 'object') {
    const code = stringOf(error.code) ?? stringOf(error.type);
    if (code) into.errorCode = code;
  }
}

function readResponse(response: Record<string, unknown>, into: ResponsesOutcome): void {
  const model = stringOf(response.model);
  if (model) into.model = model;
  const tier = stringOf(response.service_tier);
  if (tier) into.serviceTier = tier;
  if (response.usage && typeof response.usage === 'object') into.usage = response.usage as ResponsesUsage;
  const error = response.error as Record<string, unknown> | null | undefined;
  if (error && typeof error === 'object') {
    const code = stringOf(error.code) ?? stringOf(error.type);
    if (code) into.errorCode = code;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
