import { decodeReasoningSignature } from './envelope';
import { upstreamModel, type ModelContext } from './models';

/**
 * An Anthropic Messages request as Claude Code sends it, turned into an OpenAI Responses request
 * (docs/claude-engine-openai-gateway-design.md §4.3). Pure: no I/O, no clock, no state between calls.
 * Every shape handled here was recorded from the CLI (fixtures/claude-cli-2.1.322/).
 */

type Json = Record<string, unknown>;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh'];

export interface TranslateContext extends ModelContext {
  /** Sent as `prompt_cache_key`, so OpenAI keeps one cached prefix per session. */
  promptCacheKey?: string;
  /** The effort levels the model takes, lowest first; a request above the top one is held to it. */
  efforts?: readonly Effort[];
}

export interface TranslatedRequest {
  request: Json;
  /** Anthropic server tools (`web_search_*`, …) that were dropped: decision D5. */
  droppedServerTools: string[];
}

/** The system block the CLI adds for Anthropic's billing (basic.json `system[0]`); not an instruction. */
const BILLING_HEADER = 'x-anthropic-billing-header:';
/** The tool the CLI declares only to keep deferred loading on; it is never to be called (basic.json). */
const DEFERRED_PLACEHOLDER = 'DeferredToolPlaceholder';

export function toResponsesRequest(body: Json, ctx: TranslateContext): TranslatedRequest {
  const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
  const { tools, droppedServerTools } = translateTools(body.tools, referencedTools(messages));
  const request: Json = {
    model: upstreamModel(body.model, ctx),
    input: translateMessages(messages),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };
  const instructions = translateSystem(body.system);
  if (instructions !== '') request.instructions = instructions;
  if (tools.length > 0) {
    request.tools = tools;
    const choice = translateToolChoice(body.tool_choice);
    if (choice !== undefined) request.tool_choice = choice;
    const disableParallel = (body.tool_choice as Json | undefined)?.disable_parallel_tool_use === true;
    request.parallel_tool_calls = !disableParallel;
  }
  if (typeof body.max_tokens === 'number') request.max_output_tokens = body.max_tokens;
  const effort = translateEffort(body, ctx.efforts);
  if (effort !== undefined) request.reasoning = { effort, summary: 'auto' };
  if (ctx.promptCacheKey) request.prompt_cache_key = ctx.promptCacheKey;
  return { request, droppedServerTools };
}

/**
 * The body for OpenAI's input-token count (design §4.6): the same input, instructions and tools, none of
 * the generation fields. The CLI's own count_tokens body carries only model, messages and tools
 * (context-x.json). `/context` sends 23 of them: the prompt's sections, the tool set, and each deferred tool
 * alone without its `defer_loading` flag.
 */
export function toInputTokensRequest(body: Json, ctx: TranslateContext): Json {
  const { request } = toResponsesRequest(body, ctx);
  const out: Json = { model: request.model, input: request.input };
  if (request.instructions !== undefined) out.instructions = request.instructions;
  if (request.tools !== undefined) out.tools = request.tools;
  return out;
}

/** Characters ÷ 4 over everything a request carries: the fallback count of §4.6. */
export function estimateInputTokens(body: Json): number {
  const { messages, system, tools } = body;
  return Math.ceil(JSON.stringify({ messages, system, tools }).length / 4);
}

function translateSystem(system: unknown): string {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return (system as Json[])
    .filter((b) => b.type === 'text' && typeof b.text === 'string' && !(b.text as string).startsWith(BILLING_HEADER))
    .map((b) => b.text as string)
    .join('\n\n');
}

function translateMessages(messages: Json[]): Json[] {
  const input: Json[] = [];
  let callOrder: string[] = [];
  for (const message of messages) {
    const blocks: Json[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? (message.content as Json[])
          : [];
    if (message.role === 'assistant') {
      translateAssistant(blocks, input);
      callOrder = blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.id ?? ''));
    } else {
      translateUserOrSystem(message.role === 'system' ? 'developer' : 'user', inCallOrder(blocks, callOrder), input);
    }
  }
  return input;
}

/**
 * The CLI lists parallel tool_results in the order they completed, not the order they were called; OpenAI
 * models read outputs by position as well as by call_id and misattribute them. Results answering a call of
 * the preceding assistant turn are put in that turn's call order, in the slots such results already held;
 * every other block (text, results for any other call) keeps its place.
 */
function inCallOrder(blocks: Json[], callOrder: string[]): Json[] {
  const rank = (b: Json) => (b.type === 'tool_result' ? callOrder.indexOf(String(b.tool_use_id ?? '')) : -1);
  const answered = blocks.filter((b) => rank(b) >= 0);
  if (answered.length < 2) return blocks;
  const sorted = [...answered].sort((a, b) => rank(a) - rank(b));
  let next = 0;
  return blocks.map((b) => (rank(b) >= 0 ? sorted[next++] : b));
}

/** User turns, and the `role: "system"` messages the CLI puts between them (basic.json `messages[1]`). */
function translateUserOrSystem(role: 'user' | 'developer', blocks: Json[], input: Json[]): void {
  let content: Json[] = [];
  const flush = () => {
    if (content.length > 0) input.push({ type: 'message', role, content });
    content = [];
  };
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      // A function_call_output is an item of its own; text around it stays in order.
      flush();
      input.push(translateToolResult(block));
      continue;
    }
    const part = inputPart(block);
    if (part) content.push(part);
  }
  flush();
}

function inputPart(block: Json): Json | null {
  if (block.type === 'text') {
    return typeof block.text === 'string' && block.text !== '' ? { type: 'input_text', text: block.text } : null;
  }
  if (block.type === 'image') {
    const url = imageUrl(block.source as Json | undefined);
    return url ? { type: 'input_image', image_url: url, detail: 'auto' } : null;
  }
  if (block.type === 'document') {
    const source = block.source as Json | undefined;
    if (source?.type === 'base64' && typeof source.data === 'string') {
      const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/pdf';
      return { type: 'input_file', filename: typeof block.title === 'string' ? block.title : 'document.pdf', file_data: `data:${mediaType};base64,${source.data}` };
    }
    if (source?.type === 'text' && typeof source.data === 'string') return { type: 'input_text', text: source.data };
    return null;
  }
  return null;
}

function imageUrl(source: Json | undefined): string | null {
  if (!source) return null;
  if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  return null;
}

/**
 * `tool_result` → `function_call_output`. Text-only results go as a string; a result with images (Read on a
 * PNG, image-r2.json) goes as a list of input parts. `tool_reference` blocks (ToolSearch's answer,
 * toolsearch-r2.json) become a line naming the tool, which translateTools then declares.
 */
function translateToolResult(block: Json): Json {
  const parts: Json[] = [];
  const content = block.content;
  if (typeof content === 'string') {
    if (content !== '') parts.push({ type: 'input_text', text: content });
  } else if (Array.isArray(content)) {
    for (const item of content as Json[]) {
      if (item.type === 'tool_reference' && typeof item.tool_name === 'string') {
        parts.push({ type: 'input_text', text: `Tool loaded: ${item.tool_name}` });
        continue;
      }
      const part = inputPart(item);
      if (part) parts.push(part);
    }
  }
  if (block.is_error === true) {
    const first = parts[0];
    if (first?.type === 'input_text') first.text = `Error: ${first.text as string}`;
    else parts.unshift({ type: 'input_text', text: 'Error' });
  }
  const textOnly = parts.every((p) => p.type === 'input_text');
  const output = textOnly ? parts.map((p) => p.text as string).join('\n') : parts;
  return { type: 'function_call_output', call_id: String(block.tool_use_id ?? ''), output };
}

/**
 * Assistant turns, in block order: `thinking` carrying our envelope → `reasoning`, text → an assistant
 * message, `tool_use` → `function_call`. Thinking without our envelope (an earlier Anthropic or DeepSeek
 * turn) and `redacted_thinking` are dropped. Neither the reasoning nor the function call is sent with its
 * `id`: with `store: false` OpenAI has no item to look an id up against, and Codex sends them without one.
 */
function translateAssistant(blocks: Json[], input: Json[]): void {
  let text: Json[] = [];
  const flush = () => {
    if (text.length > 0) input.push({ type: 'message', role: 'assistant', content: text });
    text = [];
  };
  for (const block of blocks) {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text !== '') text.push({ type: 'output_text', text: block.text });
      continue;
    }
    if (block.type === 'thinking') {
      const envelope = decodeReasoningSignature(block.signature);
      if (!envelope?.encrypted_content) continue;
      flush();
      const thought = typeof block.thinking === 'string' ? block.thinking : '';
      input.push({
        type: 'reasoning',
        summary: thought === '' ? [] : [{ type: 'summary_text', text: thought }],
        encrypted_content: envelope.encrypted_content,
      });
      continue;
    }
    if (block.type === 'tool_use') {
      flush();
      input.push({
        type: 'function_call',
        call_id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  flush();
}

/** The deferred tools a ToolSearch result has loaded: they are declared from then on. */
function referencedTools(messages: Json[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Json[]) {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      for (const item of block.content as Json[]) {
        if (item.type === 'tool_reference' && typeof item.tool_name === 'string') names.add(item.tool_name);
      }
    }
  }
  return names;
}

/**
 * Custom tools → functions. A `defer_loading` tool is declared only once a ToolSearch result has named it,
 * which is what Anthropic's server does with the same request; the placeholder never is. Server tools
 * (they carry a `type` such as `web_search_20250305`) are dropped and reported (D5).
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
    const fn: Json = { type: 'function', name, parameters: tool.input_schema ?? { type: 'object', properties: {} }, strict: false };
    if (typeof tool.description === 'string') fn.description = tool.description;
    out.push(fn);
  }
  return { tools: out, droppedServerTools };
}

function translateToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return undefined;
  const c = choice as Json;
  if (c.type === 'auto') return 'auto';
  if (c.type === 'any') return 'required';
  if (c.type === 'none') return 'none';
  if (c.type === 'tool' && typeof c.name === 'string') return { type: 'function', name: c.name };
  return undefined;
}

/**
 * The effort the CLI asked for. For a non-Claude id it sends `output_config.effort` at every --effort
 * level verbatim, `high` with no flag, beside `thinking: {type: "adaptive"}` (effort-*.json); `max` has no
 * OpenAI equal and goes as `xhigh`. A `thinking` budget is read only when no effort is given. No effort and
 * no thinking (CLAUDE_CODE_EFFORT_LEVEL=unset) sends none, and OpenAI uses the model's default.
 */
function translateEffort(body: Json, supported?: readonly Effort[]): Effort | undefined {
  const raw = (body.output_config as Json | undefined)?.effort;
  let effort: Effort | undefined;
  if (raw === 'max') effort = 'xhigh';
  else if (typeof raw === 'string' && (EFFORT_ORDER as readonly string[]).includes(raw)) effort = raw as Effort;
  else {
    const thinking = body.thinking as Json | undefined;
    if (thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number') {
      effort = thinking.budget_tokens < 4096 ? 'low' : thinking.budget_tokens < 16384 ? 'medium' : 'high';
    }
  }
  if (effort === undefined || !supported || supported.length === 0 || supported.includes(effort)) return effort;
  const below = supported.filter((e) => EFFORT_ORDER.indexOf(e) <= EFFORT_ORDER.indexOf(effort));
  return below.length > 0 ? below[below.length - 1] : supported[0];
}
