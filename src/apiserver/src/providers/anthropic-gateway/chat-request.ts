import { CHAT_REASONING_SIGNATURE } from './envelope';
import { upstreamModel, type ModelContext } from './models';
import { DEFERRED_PLACEHOLDER, imageUrl, inCallOrder, referencedTools, translateSystem } from './request';

/**
 * An Anthropic Messages request as Claude Code sends it, turned into an OpenAI Chat Completions request for a key
 * whose endpoint serves only POST /chat/completions (docs/claude-engine-openai-gateway-design.md §10.2). Pure: no
 * I/O, no clock, no state between calls. The Responses translator (request.ts) is the reference; this one keeps
 * its rules for the system prompt, deferred tools and tool-result order, and differs where Chat Completions has
 * no equal:
 *  - no encrypted reasoning: a `thinking` block of the Responses path is dropped, and only one this path wrote
 *    (CHAT_REASONING_SIGNATURE) goes back, as plain `reasoning_content`;
 *  - no effort and no server tools: `output_config.effort` and `thinking` are not sent (a self-hosted server
 *    passes an unknown effort to its chat template, which may refuse it), and web search is dropped and reported;
 *  - every system text leads: the `system` field and the CLI's `role: "system"` messages are one system message,
 *    since many chat templates refuse a system message anywhere but first.
 */

type Json = Record<string, unknown>;

export interface ChatTranslatedRequest {
  request: Json;
  /** Anthropic server tools (web search among them) that were dropped: Chat Completions has none. */
  droppedServerTools: string[];
}

/** OpenAI's Chat Completions takes at most four stop sequences. */
const MAX_STOP = 4;

export function toChatCompletionsRequest(body: Json, ctx: ModelContext): ChatTranslatedRequest {
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  const { tools, droppedServerTools } = translateTools(body.tools, referencedTools(messages));
  const system = [translateSystem(body.system)];
  const out: Json[] = [];
  let callOrder: string[] = [];
  for (const message of messages) {
    const blocks: Json[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? (message.content as Json[])
          : [];
    if (message.role === 'system') {
      system.push(translateSystem(blocks));
    } else if (message.role === 'assistant') {
      const assistant = translateAssistant(blocks);
      if (assistant) out.push(assistant);
      callOrder = blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.id ?? ''));
    } else {
      translateUser(inCallOrder(blocks, callOrder), out);
    }
  }
  const instructions = system.filter((s) => s !== '').join('\n\n');
  const request: Json = {
    model: upstreamModel(body.model, ctx),
    messages: instructions === '' ? out : [{ role: 'system', content: instructions }, ...out],
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof body.max_tokens === 'number') request.max_tokens = body.max_tokens;
  if (Array.isArray(body.stop_sequences)) {
    const stop = body.stop_sequences.filter((s): s is string => typeof s === 'string' && s !== '').slice(0, MAX_STOP);
    if (stop.length > 0) request.stop = stop;
  }
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  if (tools.length > 0) {
    request.tools = tools;
    const choice = translateToolChoice(body.tool_choice);
    if (choice !== undefined) request.tool_choice = choice;
    // Sent only to turn parallel calls off: some compatible servers refuse the field, and on is their default.
    if ((body.tool_choice as Json | undefined)?.disable_parallel_tool_use === true) request.parallel_tool_calls = false;
  }
  return { request, droppedServerTools };
}

/**
 * A user turn: its `tool_result` blocks first, each a `tool` message (Chat Completions wants them right after the
 * assistant message that called them), then one user message with everything else in it — the turn's text and
 * images, and the images a tool result carried, which a `tool` message cannot.
 */
function translateUser(blocks: Json[], out: Json[]): void {
  const parts: Json[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const { message, images } = translateToolResult(block);
      out.push(message);
      parts.push(...images);
      continue;
    }
    const part = contentPart(block);
    if (part) parts.push(part);
  }
  if (parts.length === 0) return;
  const textOnly = parts.every((p) => p.type === 'text');
  out.push({ role: 'user', content: textOnly ? parts.map((p) => p.text as string).join('\n\n') : parts });
}

function contentPart(block: Json): Json | null {
  if (block.type === 'text') {
    return typeof block.text === 'string' && block.text !== '' ? { type: 'text', text: block.text } : null;
  }
  if (block.type === 'image') {
    const url = imageUrl(block.source as Json | undefined);
    return url ? { type: 'image_url', image_url: { url } } : null;
  }
  if (block.type === 'document') {
    const source = block.source as Json | undefined;
    if (source?.type === 'base64' && typeof source.data === 'string') {
      const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/pdf';
      const filename = typeof block.title === 'string' ? block.title : 'document.pdf';
      return { type: 'file', file: { filename, file_data: `data:${mediaType};base64,${source.data}` } };
    }
    if (source?.type === 'text' && typeof source.data === 'string') return { type: 'text', text: source.data };
    return null;
  }
  return null;
}

/**
 * `tool_result` → a `tool` message, whose content is text alone. An image in the result (Read on a PNG,
 * image-r2.json) is named there and goes in the user message that follows. `tool_reference` blocks (ToolSearch's
 * answer) become a line naming the tool, which translateTools then declares.
 */
function translateToolResult(block: Json): { message: Json; images: Json[] } {
  const text: string[] = [];
  const images: Json[] = [];
  const content = block.content;
  if (typeof content === 'string') {
    if (content !== '') text.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content as Json[]) {
      if (item.type === 'tool_reference' && typeof item.tool_name === 'string') {
        text.push(`Tool loaded: ${item.tool_name}`);
        continue;
      }
      const part = contentPart(item);
      if (part?.type === 'text') text.push(part.text as string);
      else if (part) images.push(part);
    }
  }
  if (images.length > 0) text.push(images.length === 1 ? '(The image is in the next message.)' : `(The ${images.length} images are in the next message.)`);
  let output = text.join('\n');
  if (block.is_error === true) output = output === '' ? 'Error' : `Error: ${output}`;
  return { message: { role: 'tool', tool_call_id: String(block.tool_use_id ?? ''), content: output }, images };
}

/**
 * An assistant turn → one assistant message: its text, its `tool_use` blocks as `tool_calls`, and the reasoning of
 * a `thinking` block this path wrote as `reasoning_content`. Any other thinking (a Responses envelope, Anthropic's
 * or DeepSeek's own signature) and `redacted_thinking` are dropped. Null for a turn with none of these.
 */
function translateAssistant(blocks: Json[]): Json | null {
  const text: string[] = [];
  const reasoning: string[] = [];
  const calls: Json[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') text.push(block.text);
    else if (block.type === 'thinking' && block.signature === CHAT_REASONING_SIGNATURE && typeof block.thinking === 'string' && block.thinking !== '') {
      reasoning.push(block.thinking);
    } else if (block.type === 'tool_use') {
      calls.push({
        id: String(block.id ?? ''),
        type: 'function',
        function: { name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  if (text.length === 0 && calls.length === 0) return null;
  const message: Json = { role: 'assistant', content: text.length > 0 ? text.join('') : null };
  if (reasoning.length > 0) message.reasoning_content = reasoning.join('\n\n');
  if (calls.length > 0) message.tool_calls = calls;
  return message;
}

/**
 * Custom tools → functions, by the Responses translator's rules: a `defer_loading` tool only once a ToolSearch
 * result named it, never the placeholder. Every server tool (it carries a `type`, `web_search_20250305` among
 * them) is dropped and reported.
 */
function translateTools(tools: unknown, loaded: Set<string>): { tools: Json[]; droppedServerTools: string[] } {
  const out: Json[] = [];
  const droppedServerTools: string[] = [];
  if (!Array.isArray(tools)) return { tools: out, droppedServerTools };
  for (const tool of tools as Json[]) {
    const name = String(tool.name ?? '');
    if (typeof tool.type === 'string' && tool.type !== 'custom') {
      droppedServerTools.push(name || tool.type);
      continue;
    }
    if (name === DEFERRED_PLACEHOLDER) continue;
    if (tool.defer_loading === true && !loaded.has(name)) continue;
    const fn: Json = { name, parameters: tool.input_schema ?? { type: 'object', properties: {} } };
    if (typeof tool.description === 'string') fn.description = tool.description;
    out.push({ type: 'function', function: fn });
  }
  return { tools: out, droppedServerTools };
}

function translateToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return undefined;
  const c = choice as Json;
  if (c.type === 'auto') return 'auto';
  if (c.type === 'any') return 'required';
  if (c.type === 'none') return 'none';
  if (c.type === 'tool' && typeof c.name === 'string') return { type: 'function', function: { name: c.name } };
  return undefined;
}
