import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CHAT_REASONING_SIGNATURE,
  ChatStreamConverter,
  assembleMessage,
  toChatCompletionsRequest,
  type MessagesEvent,
} from './anthropic-gateway';
import { chatFirstWord, gatewayFailure } from './anthropic-gateway.service';

/**
 * The Anthropic ⇄ Chat Completions translator of the gateway, for OpenAI-compatible keys
 * (docs/claude-engine-openai-gateway-design.md §10). Requests are the ones claude 2.1.322 really sent
 * (fixtures/claude-cli-2.1.322/); answers are Chat Completions streams recorded from a real OpenAI-compatible
 * server, Moonshot's Kimi coding endpoint (fixtures/chat-completions/), and hand-built chunks in the shapes other
 * servers are documented to send where no recording exists (OpenAI's and DeepSeek's cache counts, parallel and
 * whole tool calls, errors inside a stream).
 */

type Json = Record<string, unknown>;

const SRC = path.resolve(__dirname, '../../src/providers');
const CLI = path.join(SRC, 'fixtures/claude-cli-2.1.322');
const CHAT = path.join(SRC, 'fixtures/chat-completions');

interface Recording {
  requests: Array<{ role: string; method: string; path: string; body?: Json }>;
}
interface ChatRecording {
  request: Json;
  response: { status: number; contentType: string; body: string };
}

const basicTools = (JSON.parse(readFileSync(path.join(CLI, 'basic.json'), 'utf8')) as Recording).requests.find((r) => r.role === 'main')!.body!.tools;
function posts(name: string, role = 'main'): Json[] {
  const rec = JSON.parse(readFileSync(path.join(CLI, `${name}.json`), 'utf8')) as Recording;
  return rec.requests
    .filter((r) => r.method === 'POST' && r.role === role)
    .map((r) => (r.body!.tools === '$basic.tools' ? { ...r.body!, tools: basicTools } : r.body!));
}
const chat = (name: string) => JSON.parse(readFileSync(path.join(CHAT, `${name}.json`), 'utf8')) as ChatRecording;

const CTX = { sessionModel: 'kimi-for-coding', smallModel: 'kimi-for-coding-highspeed' };
const msgs = (req: Json) => req.messages as Json[];

function convert(body: string | Buffer, chunkSize?: number): { events: MessagesEvent[]; converter: ChatStreamConverter } {
  const converter = new ChatStreamConverter({ model: 'claude-sonnet-4-5', contextWindow: 262_144, inputTokensEstimate: 1000 });
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const events: MessagesEvent[] = [];
  const step = chunkSize ?? bytes.length;
  for (let at = 0; at < bytes.length; at += step) events.push(...converter.push(bytes.subarray(at, at + step)));
  events.push(...converter.end());
  return { events, converter };
}
const sse = (chunks: Json[], done = true) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');
const chunk = (delta: Json, extra: Json = {}) => ({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const finish = (reason: string, extra: Json = {}) => ({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: reason }], ...extra });

// ── requests: Anthropic Messages → Chat Completions ───────────────────────────────────────────────

test('basic.json: one leading system message, the CLI\'s system-role message folded into it, a plain user turn, functions, streamed with usage', () => {
  const [body] = posts('basic');
  const { request, droppedServerTools } = toChatCompletionsRequest(body, CTX);
  assert.equal(request.model, body.model, 'the session model the CLI names goes as it is');
  assert.equal(toChatCompletionsRequest({ ...body, model: 'claude-sonnet-4-5' }, CTX).request.model, 'kimi-for-coding', 'a Claude id is never sent on');
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.equal(request.max_tokens, 32000);
  // Nothing of Anthropic's effort or thinking, and none of the Responses fields.
  for (const field of ['reasoning', 'reasoning_effort', 'thinking', 'output_config', 'input', 'instructions', 'store', 'include', 'metadata']) {
    assert.ok(!(field in request), `${field} is not sent`);
  }
  const messages = msgs(request);
  assert.equal(messages[0].role, 'system');
  const system = messages[0].content as string;
  assert.ok(!system.includes('x-anthropic-billing-header'), 'the billing block is not an instruction');
  assert.ok(system.startsWith("You are a Claude agent, built on Anthropic's Claude Agent SDK."));
  assert.ok(system.includes('# Environment'), 'the system-role message of messages[1] is part of the leading system message');
  assert.equal(messages.filter((m) => m.role === 'system').length, 1, 'one system message, first');
  assert.equal(messages[1].role, 'user');
  assert.equal(typeof messages[1].content, 'string', 'text alone goes as a string');
  assert.ok((messages[1].content as string).endsWith('Say hello.'));
  assert.equal(messages.length, 2);
  const tools = request.tools as Json[];
  assert.ok(tools.every((t) => t.type === 'function' && typeof (t.function as Json).name === 'string' && (t.function as Json).parameters));
  const names = tools.map((t) => (t.function as Json).name);
  assert.ok(names.includes('Bash') && names.includes('Read'));
  assert.ok(!names.includes('DeferredToolPlaceholder'), 'the placeholder is never declared');
  assert.ok(!('tool_choice' in request) && !('parallel_tool_calls' in request), 'auto and parallel are the defaults, not sent');
  assert.deepEqual(droppedServerTools, []);
});

test('parallel.json: the assistant\'s two calls are tool_calls, their results tool messages in call order, an error result marked', () => {
  const last = posts('parallel').at(-1)!;
  const messages = msgs(toChatCompletionsRequest(last, CTX).request);
  const assistant = messages.find((m) => m.role === 'assistant')!;
  const calls = assistant.tool_calls as Json[];
  assert.deepEqual(calls.map((c) => c.id), ['toolu_par1', 'toolu_par2']);
  for (const call of calls) {
    assert.equal(call.type, 'function');
    assert.doesNotThrow(() => JSON.parse((call.function as Json).arguments as string), 'arguments are a JSON string');
  }
  const after = messages.slice(messages.indexOf(assistant) + 1);
  assert.deepEqual(after, [
    { role: 'tool', tool_call_id: 'toolu_par1', content: 'one' },
    { role: 'tool', tool_call_id: 'toolu_par2', content: 'Error: Exit code 3' },
  ]);
});

test('tool results the CLI lists out of call order are put back in it, right after the call', () => {
  const body = {
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }, { type: 'tool_use', id: 'b', name: 'Bash', input: {} }] },
      { role: 'user', content: [
        { type: 'text', text: 'before' },
        { type: 'tool_result', tool_use_id: 'b', content: 'B' },
        { type: 'tool_result', tool_use_id: 'a', content: 'A' },
        { type: 'text', text: 'after' },
      ] },
    ],
  };
  assert.deepEqual(msgs(toChatCompletionsRequest(body, CTX).request).slice(2), [
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'tool', tool_call_id: 'b', content: 'B' },
    // Text around the results follows them: a tool message must come right after the call.
    { role: 'user', content: 'before\n\nafter' },
  ]);
});

test('image-r2.json: an image a tool result carries goes in a user message after the tool message, as a data URL', () => {
  const last = posts('image-r2').at(-1)!;
  const messages = msgs(toChatCompletionsRequest(last, CTX).request);
  const at = messages.findIndex((m) => m.role === 'tool');
  assert.deepEqual(messages[at], { role: 'tool', tool_call_id: 'toolu_img1', content: '(The image is in the next message.)' });
  const image = (messages[at + 1].content as Json[])[0];
  assert.equal(messages[at + 1].role, 'user');
  assert.equal(image.type, 'image_url');
  assert.match((image.image_url as Json).url as string, /^data:image\/png;base64,iVBORw0KGgo/);
});

test('toolsearch-r2.json: a tool_reference names the tool loaded, and the deferred tool is declared from then on', () => {
  const [first, , last] = posts('toolsearch-r2');
  const declared = (req: Json) => (req.tools as Json[]).map((t) => (t.function as Json).name);
  assert.ok(!declared(toChatCompletionsRequest(first, CTX).request).includes('WebFetch'), 'not before ToolSearch loaded it');
  const request = toChatCompletionsRequest(last, CTX).request;
  assert.ok(declared(request).includes('WebFetch'));
  assert.ok(msgs(request).some((m) => m.role === 'tool' && m.content === 'Tool loaded: WebFetch'));
});

test('websearch.json: Anthropic\'s web search server tool has no Chat Completions equal, and is dropped and reported', () => {
  const [search] = posts('websearch', 'websearch');
  const { request, droppedServerTools } = toChatCompletionsRequest(search, CTX);
  assert.deepEqual(droppedServerTools, ['web_search']);
  assert.ok(!('tools' in request) && !('tool_choice' in request), 'no tools left, so no tool_choice');
});

test('thinkturns.json: a Responses reasoning envelope cannot be carried and is dropped; the text of the turn is kept', () => {
  const last = posts('thinkturns').at(-1)!;
  const messages = msgs(toChatCompletionsRequest(last, CTX).request);
  const assistants = messages.filter((m) => m.role === 'assistant');
  assert.ok(assistants.length >= 2);
  for (const a of assistants) assert.ok(!('reasoning_content' in a), 'an orbit1. envelope is encrypted, for OpenAI alone');
  assert.ok(assistants.some((a) => a.content === 'turn 2'));
});

test('tool_choice, parallel calls, stop sequences and sampling are mapped; the haiku slot gets the small model', () => {
  const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
  const base = { messages: [{ role: 'user', content: 'x' }], tools };
  const choice = (tool_choice: unknown) => toChatCompletionsRequest({ ...base, tool_choice }, CTX).request;
  assert.equal(choice({ type: 'any' }).tool_choice, 'required');
  assert.equal(choice({ type: 'none' }).tool_choice, 'none');
  assert.deepEqual(choice({ type: 'tool', name: 'Bash' }).tool_choice, { type: 'function', function: { name: 'Bash' } });
  assert.equal(choice({ type: 'auto', disable_parallel_tool_use: true }).parallel_tool_calls, false);
  const r = toChatCompletionsRequest({ ...base, model: 'claude-haiku-4-5', stop_sequences: ['a', 'b', 'c', 'd', 'e'], temperature: 0.2, top_p: 0.9, top_k: 5 }, CTX).request;
  assert.equal(r.model, 'kimi-for-coding-highspeed');
  assert.deepEqual(r.stop, ['a', 'b', 'c', 'd'], 'at most four');
  assert.equal(r.temperature, 0.2);
  assert.equal(r.top_p, 0.9);
  assert.ok(!('top_k' in r));
});

// ── streams: Chat Completions → Anthropic Messages ────────────────────────────────────────────────

test('kimi-tool-call: reasoning becomes a thinking block, the streamed call a tool_use block, usage from the last chunk', () => {
  const { events, converter } = convert(chat('kimi-tool-call').response.body);
  assert.deepEqual(events.map((e) => e.type).filter((t, i, all) => t !== all[i - 1]), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  assert.equal((events[0].message as Json).id, 'msg_chatcmpl-QiOtsp80DqsWSDtrpi459tWX');
  assert.equal((events[0].message as Json).model, 'claude-sonnet-4-5', 'the model the CLI asked for');
  const tool = events.find((e) => e.type === 'content_block_start' && (e.content_block as Json).type === 'tool_use')!;
  assert.deepEqual(tool.content_block, { type: 'tool_use', id: 'tool_qA7BBUA5qKEuJOWNQY88URNC', name: 'Bash', input: {} });
  const fragments = events.filter((e) => e.index === tool.index && (e.delta as Json | undefined)?.type === 'input_json_delta');
  assert.ok(fragments.length > 1, 'the arguments stream as they came');
  const delta = events.find((e) => e.type === 'message_delta')!;
  assert.deepEqual(delta.delta, { stop_reason: 'tool_use', stop_sequence: null });
  assert.deepEqual(delta.usage, { input_tokens: 202, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 108 });
  assert.deepEqual(converter.outcome, {
    model: 'kimi-for-coding',
    usage: { input_tokens: 202, input_tokens_details: { cached_tokens: 0 }, output_tokens: 108, output_tokens_details: { reasoning_tokens: 56 } },
  });
  assert.equal(converter.failure, undefined);

  const whole = assembleMessage(events);
  assert.ok('message' in whole);
  const [thinking, call] = whole.message.content as Json[];
  assert.equal(thinking.type, 'thinking');
  assert.equal(thinking.signature, CHAT_REASONING_SIGNATURE);
  assert.match(thinking.thinking as string, /^The user wants one short sentence/);
  assert.deepEqual(call.input, { command: 'echo hi' });
  assert.equal(whole.message.stop_reason, 'tool_use');
});

test('the same recording fed a few bytes at a time converts to the same events', () => {
  const body = chat('kimi-tool-call').response.body;
  assert.deepEqual(convert(body, 7).events, convert(body).events);
});

test('the round trip: the recorded answer, sent back as the CLI keeps it, is the request the server then answered (kimi-tool-result-with-reasoning)', () => {
  const first = chat('kimi-tool-call');
  const next = chat('kimi-tool-result-with-reasoning');
  const whole = assembleMessage(convert(first.response.body).events);
  assert.ok('message' in whole);
  const sent = first.request as { messages: Json[]; tools: Array<{ function: Json }>; max_tokens: number };
  // The conversation as Claude Code holds it: the recorded request's turns, the answer, the command's output.
  const anthropic = {
    model: 'kimi-for-coding',
    max_tokens: sent.max_tokens,
    system: sent.messages[0].content,
    tools: sent.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters })),
    messages: [
      { role: 'user', content: sent.messages[1].content },
      { role: 'assistant', content: whole.message.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_qA7BBUA5qKEuJOWNQY88URNC', content: 'hi' }] },
    ],
  };
  const { request } = toChatCompletionsRequest(anthropic, CTX);
  assert.deepEqual(request.messages, next.request.messages, 'the reasoning goes back as reasoning_content, the call as tool_calls');
  assert.deepEqual(request.tools, next.request.tools);

  const { events } = convert(next.response.body);
  const answer = assembleMessage(events);
  assert.ok('message' in answer);
  const text = (answer.message.content as Json[]).find((b) => b.type === 'text')!;
  assert.equal(text.text, 'The command completed successfully.');
  assert.equal(answer.message.stop_reason, 'end_turn');
});

test('kimi-length: a cut answer stops for max_tokens', () => {
  const delta = convert(chat('kimi-length').response.body).events.find((e) => e.type === 'message_delta')!;
  assert.equal((delta.delta as Json).stop_reason, 'max_tokens');
  assert.equal((delta.usage as Json).output_tokens, 12);
});

test('kimi-invalid-key: a 401 names the endpoint\'s host, not OpenAI, and marks the key invalid', () => {
  const rec = chat('kimi-invalid-key');
  const error = (JSON.parse(rec.response.body) as { error: { type: string; message: string } }).error;
  const failure = gatewayFailure(rec.response.status, error.type, error.message, {
    keyLabel: 'Kimi relay', upstream: 'api.kimi.ai', model: 'kimi-for-coding', spentUntil: new Date(),
  });
  assert.equal(failure.status, 401);
  assert.equal(failure.effect, 'key_invalid');
  assert.match(failure.message, /^api\.kimi\.ai refused the key "Kimi relay": The API Key appears to be invalid/);
  const spent = gatewayFailure(429, 'insufficient_quota', '', { keyLabel: 'Kimi relay', upstream: 'api.kimi.ai', model: 'm', spentUntil: new Date('2026-12-01T00:00:00Z') });
  assert.equal(spent.message, 'You hit your usage limit on the key "Kimi relay" · resets Dec 1, 12:00am (UTC)');
});

test('OpenAI\'s and DeepSeek\'s cache counts are read off a usage-only last chunk', () => {
  const body = (usage: Json) => sse([chunk({ role: 'assistant', content: 'hi' }), finish('stop'), { id: 'chatcmpl-x', choices: [], usage }]);
  const openai = convert(body({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } }));
  assert.deepEqual(openai.events.find((e) => e.type === 'message_delta')!.usage, { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 800, output_tokens: 20 });
  assert.equal(openai.converter.outcome.usage!.input_tokens_details!.cached_tokens, 800);
  const deepseek = convert(body({ prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }));
  assert.equal((deepseek.events.find((e) => e.type === 'message_delta')!.usage as Json).cache_read_input_tokens, 600);
});

test('parallel calls streamed one after the other, a call sent whole in one chunk, and a new id at the same index are each their own block', () => {
  const body = sse([
    chunk({ content: 'Two calls.' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"file_path":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"/a"}' } }] }),
    chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/b"}' } }] }),
    // A server that numbers every call 0 and tells them apart by id.
    chunk({ tool_calls: [{ index: 1, id: 'call_c', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }),
    // A late fragment of a call already written cannot be added any more.
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'junk' } }] }),
    finish('tool_calls', { usage: { prompt_tokens: 5, completion_tokens: 5 } }),
  ]);
  const whole = assembleMessage(convert(body).events);
  assert.ok('message' in whole);
  assert.deepEqual(whole.message.content, [
    { type: 'text', text: 'Two calls.' },
    { type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: '/a' } },
    { type: 'tool_use', id: 'call_b', name: 'Read', input: { file_path: '/b' } },
    { type: 'tool_use', id: 'call_c', name: 'Bash', input: { command: 'ls' } },
  ]);
  assert.equal(whole.message.stop_reason, 'tool_use');
});

test('an error inside the stream ends it as an error event and is kept as the failure; one with no finish is an error too', () => {
  const failed = convert(sse([chunk({ content: 'par' }), { error: { message: 'Rate limit reached', type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' } }], false));
  assert.deepEqual(failed.converter.failure, { code: 'rate_limit_exceeded', message: 'Rate limit reached' });
  assert.deepEqual(failed.events.at(-1), { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit reached' } });
  const overflow = convert(sse([{ error: { message: 'too long', code: 'context_length_exceeded' } }], false));
  assert.deepEqual(overflow.events.at(-1), { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 262145 tokens > 262144 maximum' } });
  const cut = convert(sse([chunk({ content: 'par' })], false));
  assert.deepEqual(cut.events.at(-1), { type: 'error', error: { type: 'api_error', message: 'The upstream stream ended before the response was complete.' } });
  // A finish_reason without the closing [DONE] is a whole answer.
  const noDone = convert(sse([chunk({ content: 'ok' }), finish('stop')], false));
  assert.equal(noDone.events.at(-1)!.type, 'message_stop');
  // [DONE] before anything is no answer.
  assert.equal(convert('data: [DONE]\n\n').events.at(-1)!.type, 'error');
});

test('a server that ignored stream: true and answered one chat.completion object is read as that answer', () => {
  const body = JSON.stringify({
    id: 'chatcmpl-whole', object: 'chat.completion', model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'whole', tool_calls: [{ id: 'call_w', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 9, completion_tokens: 3 },
  });
  const { events, converter } = convert(body);
  const whole = assembleMessage(events);
  assert.ok('message' in whole);
  assert.deepEqual(whole.message.content, [{ type: 'text', text: 'whole' }, { type: 'tool_use', id: 'call_w', name: 'Bash', input: { command: 'pwd' } }]);
  assert.equal(converter.outcome.usage!.output_tokens, 3);
});

test('chatFirstWord: a chunk carrying an error is a failure before output; any other first chunk begins the answer', () => {
  assert.deepEqual(chatFirstWord({ error: { code: 'insufficient_quota', message: 'spent' } }), { code: 'insufficient_quota', message: 'spent' });
  assert.deepEqual(chatFirstWord({ error: { type: 'server_error', message: 'x' } }), { code: 'server_error', message: 'x' });
  assert.equal(chatFirstWord(chunk({ role: 'assistant', content: '' })), null);
  assert.equal(chatFirstWord(undefined), null, '[DONE] is not JSON');
});
