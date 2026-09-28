import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FALLBACK_PRICE, openAIPriceOf, responseCostMicros } from './openai-prices';
import { duration, forwardedHeaders, gatewayTarget, rateLimitWait, spentUntil } from './pool-gateway.service';
import { ResponsesStreamTap } from './responses-stream-tap';

/**
 * The parts of the shared pools' gateway that decide something without a database: what it reads off an
 * answer as it passes, what an answer cost, how long a rate limit is waited out, until when a spent key
 * stays spent, and what of codex's request goes on to OpenAI. The gateway end to end, on PostgreSQL and a
 * recorded codex request, is pool-gateway.pg.spec.ts.
 */

const sse = (events: Array<Record<string, unknown>>) =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');

const USAGE = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 7 };

test('the tap reads the usage, model and tier off the event that ends the stream, however the bytes are cut', () => {
  const text =
    sse([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.1-codex', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: 'café — done' },
    ]) +
    sse([{ type: 'response.completed', response: { id: 'r', model: 'gpt-5.1-codex', service_tier: 'priority', usage: USAGE } }]);
  const bytes = Buffer.from(text, 'utf8');
  // Cut into three-byte pieces: events and multi-byte characters both straddle chunks.
  const tap = new ResponsesStreamTap();
  for (let at = 0; at < bytes.length; at += 3) tap.push(bytes.subarray(at, at + 3));
  tap.end();
  assert.deepEqual(tap.outcome, { model: 'gpt-5.1-codex', serviceTier: 'priority', usage: USAGE });
});

test('the tap reads why a stream failed, from response.failed and from a stream-level error, and a last event with no blank line', () => {
  const failed = new ResponsesStreamTap();
  failed.push(Buffer.from(sse([{ type: 'response.failed', response: { status: 'failed', error: { code: 'insufficient_quota', message: 'x' } } }])));
  failed.end();
  assert.equal(failed.outcome.errorCode, 'insufficient_quota');

  const error = new ResponsesStreamTap();
  error.push(Buffer.from('event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"slow down"}'));
  error.end();
  assert.equal(error.outcome.errorCode, 'rate_limit_exceeded');

  // No `event:` lines at all: the data's own type is what is read.
  const bare = new ResponsesStreamTap();
  bare.push(Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-5', usage: USAGE } })}\r\n\r\n`));
  bare.end();
  assert.deepEqual(bare.outcome.usage, USAGE);
});

test('an answer costs its tokens at the model\'s price: cached input apart, reasoning as output, priority twice over', () => {
  // gpt-5.1-codex: $1.25 in, $0.125 cached, $10 out per million — so a token costs that many micro-dollars.
  assert.equal(responseCostMicros('gpt-5.1-codex', 'default', USAGE), Math.round(200 * 1.25 + 1000 * 0.125 + 7 * 10));
  assert.equal(responseCostMicros('gpt-5.1-codex', 'priority', USAGE), Math.round((200 * 1.25 + 1000 * 0.125 + 7 * 10) * 2));
  assert.equal(responseCostMicros('gpt-5.1-codex-mini', undefined, USAGE), Math.round(200 * 0.25 + 1000 * 0.025 + 7 * 2));
  // A dated snapshot is its model's price; a model with no listed price is charged the fallback.
  assert.deepEqual(openAIPriceOf('gpt-5-2025-08-07'), openAIPriceOf('gpt-5'));
  assert.deepEqual(openAIPriceOf('gpt-5.6-sol'), { price: FALLBACK_PRICE, known: false });
  assert.equal(openAIPriceOf('gpt-5-pro').price.output, 120, 'the pro model is not the base model\'s price');
  // Nonsense counts cost nothing rather than a negative or NaN.
  assert.equal(responseCostMicros('gpt-5', undefined, { input_tokens: -5, output_tokens: Number.NaN }), 0);
});

test("a rate limit's wait is what OpenAI says, in the order it says it best", () => {
  const body = Buffer.from('{"error":{"message":"Rate limit reached … Please try again in 2.4s.","code":"rate_limit_exceeded"}}');
  assert.equal(rateLimitWait({ 'retry-after-ms': '1500', 'retry-after': '9' }, body, 1), 1500);
  assert.equal(rateLimitWait({ 'retry-after': '3' }, body, 1), 3000);
  assert.equal(rateLimitWait({ 'x-ratelimit-reset-requests': '20ms', 'x-ratelimit-reset-tokens': '6m0s' }, body, 1), 360_000);
  assert.equal(rateLimitWait({}, body, 1), 2400);
  assert.equal(rateLimitWait({}, undefined, 3), 4000, 'with nothing said: 1s, 2s, 4s');
  assert.equal(rateLimitWait({ 'retry-after-ms': '1' }, undefined, 1), 250, 'never under a quarter of a second');
  assert.equal(duration('1h2m3.5s'), 3_723_500);
  assert.equal(duration('soon'), null);
});

test('a key out of budget stays out until the reset OpenAI names, else the first of next month (UTC)', () => {
  const now = new Date('2026-09-28T10:00:00.000Z');
  assert.deepEqual(spentUntil({}, now), new Date('2026-10-01T00:00:00.000Z'));
  assert.deepEqual(spentUntil({ 'retry-after': '3600' }, now), new Date('2026-09-28T11:00:00.000Z'));
  assert.deepEqual(spentUntil({ 'retry-after': 'Thu, 01 Oct 2026 06:00:00 GMT' }, now), new Date('2026-10-01T06:00:00.000Z'));
  assert.deepEqual(spentUntil({ 'retry-after': '-5' }, now), new Date('2026-10-01T00:00:00.000Z'), 'a reset in the past says nothing');
});

test("what goes to OpenAI is codex's request with its credential replaced — no hop-by-hop header and nothing the edge added", () => {
  const incoming = {
    authorization: 'Bearer orbit-gw-token',
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'session-id': 's-1',
    'x-codex-turn-metadata': '{"a":1}',
    'user-agent': 'orbit/0.158.0',
    host: 'orbit.example',
    connection: 'keep-alive',
    'content-length': '12',
    'x-forwarded-for': '203.0.113.9',
    'x-real-ip': '203.0.113.9',
    'x-forwarded-proto': 'https',
    'x-orbit-gateway': '1',
    'cf-connecting-ip': '203.0.113.9',
    'cf-ray': 'abc',
    'accept-encoding': 'gzip, br',
  };
  assert.deepEqual(forwardedHeaders(incoming, 'sk-proj-secret', 99), {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'session-id': 's-1',
    'x-codex-turn-metadata': '{"a":1}',
    'user-agent': 'orbit/0.158.0',
    authorization: 'Bearer sk-proj-secret',
    'content-length': '99',
  });
  assert.deepEqual(gatewayTarget('/api/gw/codex/responses'), { path: '/responses', query: '' });
  assert.deepEqual(gatewayTarget('/api/gw/codex/responses/compact?x=1'), { path: '/responses/compact', query: '?x=1' });
  assert.deepEqual(gatewayTarget('/api/gw/codex'), { path: '/', query: '' });
});
