import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  MessagesStreamConverter,
  anthropicError,
  assembleMessage,
  decodeReasoningSignature,
  encodeReasoningSignature,
  estimateInputTokens,
  toInputTokensRequest,
  toResponsesRequest,
  toSse,
  upstreamModel,
  PING_SSE,
  type MessagesEvent,
} from './anthropic-gateway';

/**
 * The Anthropic ⇄ Responses translator of the Claude-on-OpenAI gateway (docs/claude-engine-openai-gateway-design.md
 * §4.3–§4.5). Requests are the ones claude 2.1.322 really sent to a recording endpoint
 * (fixtures/claude-cli-2.1.322/, recorded by scripts/claude-gateway-recorder/); streams are codex's recorded
 * Responses stream (fixtures/codex-gateway-recording.json) and hand-built ones for what a recording cannot
 * produce on demand (reasoning, parallel calls, incomplete, failed).
 */

type Json = Record<string, unknown>;

const SRC = path.resolve(__dirname, '../../src/providers');
const FIXTURES = path.join(SRC, 'fixtures/claude-cli-2.1.322');

interface Recording {
  requests: Array<{ role: string; method: string; path: string; headers?: Record<string, string>; body?: Json }>;
  outcome: Json[];
}

const basicTools = (JSON.parse(readFileSync(path.join(FIXTURES, 'basic.json'), 'utf8')) as Recording).requests.find((r) => r.role === 'main')!.body!.tools;

function recording(name: string): Recording {
  const rec = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as Recording;
  for (const r of rec.requests) if (r.body && r.body.tools === '$basic.tools') r.body.tools = basicTools;
  return rec;
}
const posts = (name: string, role?: string) =>
  recording(name).requests.filter((r) => r.method === 'POST' && (role === undefined || r.role === role));

const CTX = { sessionModel: 'gpt-5.5', smallModel: 'gpt-5.5-mini', promptCacheKey: 'session-1' };
const items = (req: Json) => req.input as Json[];
const ofType = (req: Json, type: string) => items(req).filter((i) => i.type === type);

// ── what the CLI sends ────────────────────────────────────────────────────────────────────────────

test('the recorded CLI posts /v1/messages?beta=true with a bearer token, and count_tokens on its own path', () => {
  const [main] = posts('basic');
  assert.equal(main.path, '/v1/messages?beta=true');
  assert.equal(main.headers!.authorization, 'Bearer orbit-gwk-<redacted>');
  assert.match(main.headers!['user-agent'], /^claude-cli\/2\.1\.322 /);
  assert.equal(main.body!.stream, true);
  const counts = posts('context-x').filter((r) => r.path.startsWith('/v1/messages/count_tokens'));
  assert.ok(counts.length > 0);
  assert.equal(counts[0].path, '/v1/messages/count_tokens?beta=true');
  assert.deepEqual(Object.keys(counts[0].body!).sort(), ['messages', 'model', 'tools']);
});

// ── §4.3 request mapping ──────────────────────────────────────────────────────────────────────────

test('§4.3 a recorded first request: instructions, developer messages, user text, tools, limits, storage', () => {
  const body = posts('basic', 'main')[0].body!;
  const { request } = toResponsesRequest(body, CTX);
  assert.equal(request.model, 'gpt-5.5');
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  assert.deepEqual(request.include, ['reasoning.encrypted_content']);
  assert.equal(request.max_output_tokens, 32000);
  assert.equal(request.prompt_cache_key, 'session-1');
  // system blocks joined, the billing header left out, cache_control gone with the blocks.
  assert.equal(typeof request.instructions, 'string');
  assert.doesNotMatch(request.instructions as string, /x-anthropic-billing-header/);
  assert.match(request.instructions as string, /You are a Claude agent/);
  // the CLI's `role: "system"` messages go as developer messages, in place.
  const roles = ofType(request, 'message').map((m) => m.role);
  assert.deepEqual(roles, ['user', 'developer']);
  const user = ofType(request, 'message')[0].content as Json[];
  assert.ok(user.every((p) => p.type === 'input_text'));
  assert.equal(user[user.length - 1].text, 'Say hello.');
  // tools: functions with their schema, not strict; the placeholder and unloaded deferred tools left out.
  const tools = request.tools as Json[];
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('Bash') && names.includes('Agent'));
  assert.ok(!names.includes('DeferredToolPlaceholder'));
  const bash = tools.find((t) => t.name === 'Bash')!;
  assert.equal(bash.type, 'function');
  assert.equal(bash.strict, false);
  assert.deepEqual(bash.parameters, (body.tools as Json[]).find((t) => t.name === 'Bash')!.input_schema);
  assert.equal(request.parallel_tool_calls, true);
  // Anthropic-only fields are not sent.
  for (const field of ['messages', 'system', 'metadata', 'thinking', 'context_management', 'output_config', 'max_tokens']) {
    assert.equal(field in request, false, field);
  }
});

test('§4.3 effort: every recorded --effort level, and none, reaches reasoning.effort; max goes as xhigh', () => {
  const expected: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh', none: 'high' };
  for (const [level, effort] of Object.entries(expected)) {
    const body = posts(`effort-${level}`, 'main')[0].body!;
    assert.deepEqual(toResponsesRequest(body, CTX).request.reasoning, { effort, summary: 'auto' }, level);
  }
  // a model that takes fewer levels is held to the highest it takes at or below the request.
  const max = posts('effort-max', 'main')[0].body!;
  assert.deepEqual(toResponsesRequest(max, { ...CTX, efforts: ['low', 'medium', 'high'] }).request.reasoning, { effort: 'high', summary: 'auto' });
  // a thinking budget without an effort, and neither (CLAUDE_CODE_EFFORT_LEVEL=unset).
  assert.deepEqual(toResponsesRequest({ messages: [], thinking: { type: 'enabled', budget_tokens: 2000 } }, CTX).request.reasoning, { effort: 'low', summary: 'auto' });
  assert.equal('reasoning' in toResponsesRequest({ messages: [] }, CTX).request, false);
});

test('§4.3 thinking with an orbit1. envelope goes back as a reasoning item; tool_use and tool_result pair by call id', () => {
  const second = posts('thinking', 'main')[1].body!;
  const { request } = toResponsesRequest(second, CTX);
  const tail = items(request).filter((i) => i.type !== 'message');
  assert.deepEqual(tail, [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I should run echo.' }], encrypted_content: 'gAAAAB_fake_encrypted_blob' },
    { type: 'function_call', call_id: 'toolu_think1', name: 'Bash', arguments: JSON.stringify({ command: 'echo think-ok', description: 'Echo' }) },
    { type: 'function_call_output', call_id: 'toolu_think1', output: 'think-ok' },
  ]);
});

test('§4.3 reasoning is carried across user turns: the third turn sends both earlier reasoning items', () => {
  const third = posts('thinkturns', 'main')[2].body!;
  const reasoning = ofType(toResponsesRequest(third, CTX).request, 'reasoning');
  assert.deepEqual(reasoning.map((r) => r.encrypted_content), ['enc-turn-1', 'enc-turn-2']);
});

test('§4.3 thinking without our envelope, and redacted_thinking, are dropped', () => {
  const second = structuredClone(posts('thinking', 'main')[1].body!);
  const assistant = (second.messages as Json[]).find((m) => m.role === 'assistant')!;
  const blocks = assistant.content as Json[];
  blocks[0].signature = 'EqQBCkYIBxgCKkDanthropic-signature';
  blocks.unshift({ type: 'redacted_thinking', data: 'opaque' });
  const { request } = toResponsesRequest(second, CTX);
  assert.equal(ofType(request, 'reasoning').length, 0);
  assert.equal(ofType(request, 'function_call').length, 1);
});

test('§4.3 parallel tool calls: both calls and both results, the error flag folded into the text', () => {
  const second = posts('parallel', 'main')[1].body!;
  const { request } = toResponsesRequest(second, CTX);
  assert.deepEqual(ofType(request, 'function_call').map((c) => c.call_id), ['toolu_par1', 'toolu_par2']);
  assert.deepEqual(ofType(request, 'function_call_output'), [
    { type: 'function_call_output', call_id: 'toolu_par1', output: 'one' },
    { type: 'function_call_output', call_id: 'toolu_par2', output: 'Error: Exit code 3' },
  ]);
  // the assistant's text before the calls stays an assistant message.
  const said = ofType(request, 'message').find((m) => m.role === 'assistant')!;
  assert.deepEqual(said.content, [{ type: 'output_text', text: 'Running two.' }]);
});

test('§4.3 a tool_result with an image goes as input parts with a data URL; a user image too', () => {
  const second = posts('image-r2', 'main')[1].body!;
  const [output] = ofType(toResponsesRequest(second, CTX).request, 'function_call_output');
  assert.equal(output.call_id, 'toolu_img1');
  const parts = output.output as Json[];
  assert.equal(parts.length, 1);
  assert.equal(parts[0].type, 'input_image');
  assert.match(parts[0].image_url as string, /^data:image\/png;base64,iVBORw0KGgo/);
  const user = toResponsesRequest(
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }, { type: 'text', text: 'what is it' }] }] },
    CTX,
  ).request;
  assert.deepEqual(items(user)[0].content, [
    { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'auto' },
    { type: 'input_text', text: 'what is it' },
  ]);
});

test('§4.3 a deferred tool is declared once ToolSearch has loaded it; the tool_reference becomes a line', () => {
  const [first, second, , third] = posts('toolsearch-r2');
  assert.ok(!(toResponsesRequest(first.body!, CTX).request.tools as Json[]).some((t) => t.name === 'WebFetch'));
  const after = toResponsesRequest(second.body!, CTX).request;
  assert.ok((after.tools as Json[]).some((t) => t.name === 'WebFetch'));
  assert.deepEqual(ofType(after, 'function_call_output')[0], { type: 'function_call_output', call_id: 'toolu_ts1', output: 'Tool loaded: WebFetch' });
  assert.equal(third.role, 'main');
});

test('§4.3 tool_choice, parallel switch, dropped sampling fields and server tools', () => {
  const base = { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'Bash', input_schema: { type: 'object' } }] };
  const choice = (tool_choice: Json) => toResponsesRequest({ ...base, tool_choice }, CTX).request;
  assert.equal(choice({ type: 'auto' }).tool_choice, 'auto');
  assert.equal(choice({ type: 'any' }).tool_choice, 'required');
  assert.equal(choice({ type: 'none' }).tool_choice, 'none');
  assert.deepEqual(choice({ type: 'tool', name: 'Bash' }).tool_choice, { type: 'function', name: 'Bash' });
  assert.equal(choice({ type: 'auto', disable_parallel_tool_use: true }).parallel_tool_calls, false);
  const { request, droppedServerTools } = toResponsesRequest(
    { ...base, temperature: 1, top_p: 0.9, top_k: 5, stop_sequences: ['x'], tools: [...base.tools, { type: 'web_search_20250305', name: 'web_search' }] },
    CTX,
  );
  for (const field of ['temperature', 'top_p', 'top_k', 'stop_sequences', 'stop']) assert.equal(field in request, false, field);
  assert.deepEqual((request.tools as Json[]).map((t) => t.name), ['Bash']);
  assert.deepEqual(droppedServerTools, ['web_search']);
  assert.deepEqual(items(request), [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
});

test('§4.3 a subagent request and a compaction request translate like any other', () => {
  const sub = posts('subagent-r2', 'subagent')[0].body!;
  const subReq = toResponsesRequest(sub, CTX).request;
  assert.equal(subReq.model, 'gpt-5.5');
  assert.match(JSON.stringify(items(subReq)), /subagent-hi/);
  const compaction = posts('toolong-r2', 'compaction')[0].body!;
  const req = toResponsesRequest(compaction, CTX).request;
  const last = items(req)[items(req).length - 1];
  assert.equal(last.role, 'user');
  assert.match(JSON.stringify(last.content), /"text":"CRITICAL: Respond with TEXT ONLY\. Do NOT call any tools\./);
});

test('§4.6 count_tokens: each recorded /context count as an input-token request, each deferred tool alone, and the ÷4 estimate', () => {
  const counts = posts('context-x').filter((r) => r.path.startsWith('/v1/messages/count_tokens')).map((r) => r.body!);
  assert.equal(counts.length, 23);
  for (const count of counts) {
    const req = toInputTokensRequest(count, CTX);
    assert.equal(req.model, 'gpt-5.5');
    for (const field of ['stream', 'store', 'include', 'max_output_tokens', 'reasoning']) assert.equal(field in req, false, field);
    const sent = (count.tools as Json[]).filter((t) => t.name !== 'DeferredToolPlaceholder').map((t) => t.name);
    assert.deepEqual(((req.tools as Json[] | undefined) ?? []).map((t) => t.name), sent);
    assert.ok(estimateInputTokens(count) > 0);
  }
  // a deferred tool is counted on its own, sent without its defer_loading flag.
  const webFetch = counts.find((c) => (c.tools as Json[]).some((t) => t.name === 'WebFetch'))!;
  assert.equal((webFetch.tools as Json[])[0].defer_loading, undefined);
  assert.deepEqual((toInputTokensRequest(webFetch, CTX).tools as Json[]).map((t) => t.name), ['WebFetch']);
});

// ── §4.5 models ───────────────────────────────────────────────────────────────────────────────────

test('§4.5 the recorded haiku slot carries the configured small model, else the session model; Claude ids are rewritten', () => {
  assert.equal(posts('toolsearch-haikur2', 'background')[0].body!.model, 'gpt-5.5-mini');
  assert.equal(posts('toolsearch-r2', 'background')[0].body!.model, 'gpt-5.5');
  assert.equal(upstreamModel('gpt-5.5-mini', CTX), 'gpt-5.5-mini');
  assert.equal(upstreamModel('claude-haiku-4-5-20251001', CTX), 'gpt-5.5-mini');
  assert.equal(upstreamModel('claude-haiku-4-5', { sessionModel: 'gpt-5.5' }), 'gpt-5.5');
  assert.equal(upstreamModel('claude-opus-5[1m]', CTX), 'gpt-5.5');
  assert.equal(upstreamModel(undefined, CTX), 'gpt-5.5');
});

// ── the orbit1. envelope ──────────────────────────────────────────────────────────────────────────

test('the orbit1. envelope round-trips; anything else is not ours', () => {
  const sig = encodeReasoningSignature({ id: 'rs_1', encrypted_content: 'gAAA+/=' });
  assert.match(sig, /^orbit1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeReasoningSignature(sig), { id: 'rs_1', encrypted_content: 'gAAA+/=' });
  assert.equal(decodeReasoningSignature('EqQBCkYIBxgC'), null);
  assert.equal(decodeReasoningSignature('orbit1.%%%'), null);
  assert.equal(decodeReasoningSignature('orbit1.' + Buffer.from('{"id":3}').toString('base64url')), null);
  assert.equal(decodeReasoningSignature(undefined), null);
});

// ── §4.4 stream mapping ───────────────────────────────────────────────────────────────────────────

const sse = (events: Json[]) => events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');

function convert(text: string, ctx = { model: 'gpt-5.5' }, step = 7): MessagesEvent[] {
  const converter = new MessagesStreamConverter(ctx);
  const bytes = Buffer.from(text, 'utf8');
  const out: MessagesEvent[] = [];
  for (let at = 0; at < bytes.length; at += step) out.push(...converter.push(bytes.subarray(at, at + step)));
  out.push(...converter.end());
  return out;
}
const kinds = (events: MessagesEvent[]) =>
  events.map((e) => (e.type === 'content_block_start' ? `start:${(e.content_block as Json).type}` : e.type === 'content_block_delta' ? `delta:${(e.delta as Json).type}` : e.type));

const USAGE = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 70, output_tokens_details: { reasoning_tokens: 50 } };

test('§4.4 a recorded Responses text stream becomes message_start, one text block, message_delta and message_stop', () => {
  const recorded = JSON.parse(readFileSync(path.join(SRC, 'fixtures/codex-gateway-recording.json'), 'utf8')) as { response: { bodyBase64: string } };
  const text = Buffer.from(recorded.response.bodyBase64, 'base64').toString('utf8');
  const events = convert(text, { model: 'gpt-5.5' }, 3);
  const k = kinds(events);
  assert.equal(k[0], 'message_start');
  assert.equal(k[1], 'start:text');
  assert.deepEqual(k.slice(-3), ['content_block_stop', 'message_delta', 'message_stop']);
  const deltas = events.filter((e) => e.type === 'content_block_delta').map((e) => (e.delta as Json).text).join('');
  const upstream = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Json);
  assert.equal(deltas, upstream.filter((e) => e.type === 'response.output_text.delta').map((e) => e.delta).join(''));
  const delta = events.find((e) => e.type === 'message_delta')!;
  assert.deepEqual(delta.delta, { stop_reason: 'end_turn', stop_sequence: null });
  const done = upstream.find((e) => e.type === 'response.completed')!.response as Json;
  const usage = done.usage as Json;
  const cached = Number((usage.input_tokens_details as Json | undefined)?.cached_tokens ?? 0);
  assert.deepEqual(delta.usage, { input_tokens: Number(usage.input_tokens) - cached, cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: usage.output_tokens });
  const message = (events[0].message as Json);
  assert.equal(message.model, 'gpt-5.5');
  assert.deepEqual(message.usage, { input_tokens: 0, output_tokens: 0 });
});

const REASONING_STREAM = sse([
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_9', summary: [] } },
  { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0 },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Planning ' },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'the edit.' },
  { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 1 },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Then tests.' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_9', encrypted_content: 'gAAAAenc==' } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant' } },
  { type: 'response.output_text.delta', output_index: 1, delta: 'Done — ✓' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'message' } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: USAGE, output: [] } },
]);

test('§4.4 reasoning: a thinking block with summary deltas, then the orbit1. signature, then its stop', () => {
  const events = convert(REASONING_STREAM);
  assert.deepEqual(kinds(events), [
    'message_start',
    'start:thinking', 'delta:thinking_delta', 'delta:thinking_delta', 'delta:thinking_delta', 'delta:thinking_delta', 'delta:signature_delta', 'content_block_stop',
    'start:text', 'delta:text_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ]);
  const assembled = assembleMessage(events);
  assert.ok('message' in assembled);
  const [thinking, text] = assembled.message.content as Json[];
  assert.equal(thinking.thinking, 'Planning the edit.\n\nThen tests.');
  assert.deepEqual(decodeReasoningSignature(thinking.signature), { id: 'rs_9', encrypted_content: 'gAAAAenc==' });
  assert.equal(text.text, 'Done — ✓');
  assert.deepEqual(assembled.message.usage, { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 70 });
});

test('the orbit1. envelope round trip: a streamed reasoning item comes back as the same reasoning input next turn', () => {
  const assembled = assembleMessage(convert(REASONING_STREAM));
  assert.ok('message' in assembled);
  const next = toResponsesRequest(
    { messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: assembled.message.content }, { role: 'user', content: 'again' }] },
    CTX,
  ).request;
  assert.deepEqual(items(next)[1], {
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Planning the edit.\n\nThen tests.' }],
    encrypted_content: 'gAAAAenc==',
  });
});

const PARALLEL_STREAM = sse([
  { type: 'response.created', response: { id: 'resp_2' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_a', name: 'Bash', arguments: '' } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_b', name: 'Read', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"command":' },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"file_path":"/a"}' },
  { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"ls"}' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_a', arguments: '{"command":"ls"}' } },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_b', arguments: '{"file_path":"/a"}' } },
  { type: 'response.completed', response: { id: 'resp_2', status: 'completed', usage: USAGE } },
]);

test('§4.4 parallel function calls: one tool_use block each, input_json_delta to the right block, stop_reason tool_use', () => {
  const events = convert(PARALLEL_STREAM);
  const starts = events.filter((e) => e.type === 'content_block_start').map((e) => e.content_block);
  assert.deepEqual(starts, [
    { type: 'tool_use', id: 'call_a', name: 'Bash', input: {} },
    { type: 'tool_use', id: 'call_b', name: 'Read', input: {} },
  ]);
  const assembled = assembleMessage(events);
  assert.ok('message' in assembled);
  assert.deepEqual((assembled.message.content as Json[]).map((b) => b.input), [{ command: 'ls' }, { file_path: '/a' }]);
  assert.equal(assembled.message.stop_reason, 'tool_use');
});

test('§4.4 a function call whose arguments come only with output_item.done still carries them', () => {
  const events = convert(
    sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_c', name: 'Bash' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_c', arguments: '{"command":"pwd"}' } },
      { type: 'response.completed', response: { status: 'completed', usage: USAGE } },
    ]),
  );
  const assembled = assembleMessage(events);
  assert.ok('message' in assembled);
  assert.deepEqual((assembled.message.content as Json[])[0].input, { command: 'pwd' });
});

test('§4.4 incomplete: max_output_tokens → max_tokens, content_filter → refusal, open blocks closed first', () => {
  const incomplete = (reason: string) =>
    convert(
      sse([
        { type: 'response.created', response: { id: 'resp_3' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
        { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason }, usage: USAGE } },
      ]),
    );
  const cut = incomplete('max_output_tokens');
  assert.deepEqual(kinds(cut), ['message_start', 'start:text', 'delta:text_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal((cut[4].delta as Json).stop_reason, 'max_tokens');
  assert.equal((incomplete('content_filter')[4].delta as Json).stop_reason, 'refusal');
});

test('§4.4 failed and stream error events become an Anthropic error event; overflow uses the wording the CLI compacts on', () => {
  const failed = convert(
    sse([
      { type: 'response.created', response: { id: 'resp_4' } },
      { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'The server had an error.' } } },
    ]),
  );
  assert.deepEqual(failed[failed.length - 1], { type: 'error', error: { type: 'overloaded_error', message: 'The server had an error.' } });
  const overflow = convert(
    sse([{ type: 'response.failed', response: { status: 'failed', error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' } } }]),
    { model: 'gpt-5.5', contextWindow: 350000, inputTokensEstimate: 401000 } as never,
  );
  const error = overflow[overflow.length - 1].error as Json;
  assert.equal(error.type, 'invalid_request_error');
  // The CLI's own matcher (2.1.322): it compacts on this, and reads the two numbers.
  assert.match(error.message as string, /^prompt is too long: \d+ tokens > \d+ maximum$/);
  assert.equal(error.message, 'prompt is too long: 401000 tokens > 350000 maximum');
  const streamError = convert(sse([{ type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached' }]));
  assert.deepEqual(streamError, [{ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit reached' } }]);
  assert.deepEqual(assembleMessage(failed), { error: { type: 'overloaded_error', message: 'The server had an error.' } });
  assert.equal(anthropicError('context_length_exceeded', '', {}).message, 'prompt is too long');
});

test('the recorded CLI compacts on the Anthropic overflow wording and not on OpenAI\'s', () => {
  const anthropic = recording('toolong-r2');
  assert.ok(anthropic.requests.some((r) => r.role === 'compaction'));
  assert.ok(anthropic.outcome.some((o) => o.compact_boundary === 'auto'));
  const openai = recording('toolong-openai');
  assert.ok(!openai.requests.some((r) => r.role === 'compaction'));
});

test('§4.4 a stream that ends without a final event answers an error, never a silent end', () => {
  const events = convert(sse([{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } }]));
  assert.equal(events[events.length - 1].type, 'error');
});

test('SSE out: event and data lines the CLI reads, and a ping for keep-alive', () => {
  assert.equal(toSse([{ type: 'message_stop' }]), 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
  assert.equal(PING_SSE, 'event: ping\ndata: {"type":"ping"}\n\n');
});

test('the translator is pure: its modules import nothing that does I/O', () => {
  const dir = path.join(SRC, 'anthropic-gateway');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) assert.ok(spec.startsWith('./') || spec === 'node:string_decoder', `${file} imports ${spec}`);
    assert.doesNotMatch(source, /\b(fetch|require)\(|process\.env|console\./, file);
  }
});
