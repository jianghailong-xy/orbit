import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { test } from 'node:test';

import {
  askWikiSystemModel,
  probeWikiSystemModel,
  WikiModelError,
  type WikiModelCall,
  type WikiModelEndpoint,
} from './wiki-model-client';

/**
 * The System model's client (wiki-model-client.ts, contract `systemModel.request` and `.health`) against a System
 * model played by a local Node http server: what a call sends, how the event stream is read — usage included — and how
 * each way a call can end is classed. Timeouts are shortened to a few hundred milliseconds; nothing here waits the
 * contract's five minutes.
 */

const KEY = 'sk-wiki-spec-key-0123456789abcdef';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Handler = (request: IncomingMessage, response: ServerResponse, received: Received) => void | Promise<void>;

/** A System model on 127.0.0.1 answering every request with `handle`, and keeping what it was sent. */
async function fakeModel(handle: Handler): Promise<{ endpoint: WikiModelEndpoint; received: Received[]; connections: () => number; close: () => Promise<void> }> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const seen = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body };
      received.push(seen);
      void handle(request, response, seen);
    });
  });
  server.on('connection', (socket: Socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: { baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY, model: 'spec-model' },
    received,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** One event as the Messages API writes it: its name, and its data with the same `type`. */
function sse(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const START = sse('message_start', {
  message: { id: 'msg_spec', type: 'message', role: 'assistant', model: 'spec-model-as-served', content: [], usage: { input_tokens: 42, output_tokens: 1 } },
});
const delta = (text: string) => sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
const END = [
  sse('content_block_stop', { index: 0 }),
  sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 17 } }),
  sse('message_stop'),
];

/** A whole answer: start, a text block of `parts`, the usage and the stop. */
function answer(parts: string[]): string[] {
  return [START, sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), sse('ping'), ...parts.map(delta), ...END];
}

function streamHead(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
}

/** Writes each piece in turn, a little apart, as a server streaming tokens does. */
async function writeSlowly(response: ServerResponse, pieces: string[], gapMs = 5): Promise<void> {
  for (const piece of pieces) {
    if (response.destroyed) return;
    response.write(piece);
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
}

const CALL: Omit<WikiModelCall, 'onPartial'> = { system: 'You extract wiki entries.', prompt: 'The dossier.', maxTokens: 1234, timeoutMs: 5_000 };

/** The WikiModelError a call rejected with. */
async function failureOf(call: Promise<unknown>): Promise<WikiModelError> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof WikiModelError, `the call failed with something else: ${String(error)}`);
    return error;
  }
  assert.fail('the call succeeded');
}

/** Neither the key nor where the model answers is in `text`. */
function assertNamesNoSecret(text: string, endpoint: WikiModelEndpoint): void {
  const url = new URL(endpoint.baseUrl);
  for (const secret of [KEY, endpoint.baseUrl, url.host, url.hostname]) {
    assert.equal(text.includes(secret), false, `${JSON.stringify(text)} names ${secret}`);
  }
}

test('a call is POST /v1/messages, streamed: one user message, the key as a Bearer, the version pinned, its own max_tokens, no tools and no thinking', async (t) => {
  const model = await fakeModel(async (_request, response) => {
    streamHead(response);
    await writeSlowly(response, answer(['Hello', ', ', 'world']));
    response.end();
  });
  t.after(() => model.close());
  const partials: string[] = [];
  const result = await askWikiSystemModel(model.endpoint, { ...CALL, onPartial: (text) => partials.push(text) });

  assert.deepEqual(result, {
    text: 'Hello, world',
    stopReason: 'end_turn',
    model: 'spec-model-as-served',
    // message_start said 42 in and 1 out; message_delta's 17 is the later count of what came out.
    usage: { inputTokens: 42, outputTokens: 17 },
  });
  // The text so far, after every delta: what the queue keeps as the request's partial.
  assert.deepEqual(partials, ['Hello', 'Hello, ', 'Hello, world']);

  assert.equal(model.received.length, 1);
  const [sent] = model.received;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/v1/messages');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.equal(sent.headers['x-api-key'], undefined, 'the key goes as a Bearer, and only as one');
  // Exactly these keys: the system prompt, one user message, max_tokens as the call gave it — no tools, no thinking.
  assert.deepEqual(JSON.parse(sent.body), {
    model: 'spec-model',
    max_tokens: 1234,
    system: 'You extract wiki entries.',
    messages: [{ role: 'user', content: 'The dossier.' }],
    stream: true,
  });
});

test('the stream is read the same cut anywhere, with CRLF line ends, comments, a [DONE] and events nobody named', async (t) => {
  const stream = [
    ': a comment the server keeps the line open with\n\n',
    ...answer(['né', 'e ', '✓ done']).slice(0, -1),
    'event: mystery\ndata: {"type":"mystery","worth":0}\n\n',
    'data: [DONE]\n\n',
    // message_delta again, carrying input_tokens too, as later versions of the API do: the last count wins.
    sse('message_delta', { delta: { stop_reason: 'max_tokens' }, usage: { input_tokens: 43, output_tokens: 18 } }),
    sse('message_stop'),
  ].join('').replace(/\n/g, '\r\n');
  const bytes = Buffer.from(stream, 'utf8');
  const model = await fakeModel(async (_request, response) => {
    streamHead(response);
    // Seven bytes at a time: CR and LF land in different chunks, and so do the bytes of one character.
    const pieces: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 7) pieces.push(bytes.subarray(at, at + 7));
    for (const piece of pieces) {
      response.write(piece);
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  });
  t.after(() => model.close());
  const result = await askWikiSystemModel(model.endpoint, CALL);
  assert.equal(result.text, 'née ✓ done');
  assert.equal(result.stopReason, 'max_tokens');
  assert.deepEqual(result.usage, { inputTokens: 43, outputTokens: 18 });
});

test('calls in a row reuse kept-alive connections: the stream is read to its end, not cut off at message_stop', async (t) => {
  const model = await fakeModel((_request, response) => {
    streamHead(response);
    response.write(answer(['again']).join(''));
    // The end of the response comes apart from message_stop, as it does over a real network: a client that
    // stopped reading at message_stop would throw the connection away with it.
    setTimeout(() => response.end(), 20);
  });
  t.after(() => model.close());
  for (let call = 0; call < 5; call += 1) assert.equal((await askWikiSystemModel(model.endpoint, CALL)).text, 'again');
  assert.equal(model.received.length, 5);
  // The pool may open a second connection while the first is being handed back; it reuses them from then on.
  assert.ok(model.connections() <= 2, `five calls opened ${model.connections()} connections`);
});

test('a server that keeps the stream open after message_stop still answers, a moment later', async (t) => {
  const model = await fakeModel((_request, response) => {
    streamHead(response);
    response.write(answer(['whole']).join(''));
    // …and never ends the response.
  });
  t.after(() => model.close());
  const started = Date.now();
  const result = await askWikiSystemModel(model.endpoint, { ...CALL, idleTimeoutMs: 60_000 });
  assert.equal(result.text, 'whole');
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(Date.now() - started < 5_000, 'the answer waited on a stream that was never going to end');
});

test('a call that runs past its own budget ends as other/timeout, carrying what had arrived', async (t) => {
  const model = await fakeModel(async (_request, response) => {
    streamHead(response);
    response.write(START + delta('half an answer'));
    // Bytes keep coming, so it is never idle: only the budget can end it.
    const keepAlive = setInterval(() => response.write(': still thinking\n\n'), 20);
    response.on('close', () => clearInterval(keepAlive));
  });
  t.after(() => model.close());
  const started = Date.now();
  const failure = await failureOf(askWikiSystemModel(model.endpoint, { ...CALL, timeoutMs: 300, idleTimeoutMs: 5_000 }));
  assert.equal(failure.kind, 'other');
  assert.equal(failure.failure, 'timeout');
  assert.equal(failure.partial, 'half an answer');
  assert.equal(failure.status, 200);
  assert.ok(Date.now() - started < 3_000, 'the budget did not end the call');
});

test('a call that hears nothing for the idle time is disconnected, and that is retryable', async (t) => {
  let disconnected!: () => void;
  const gone = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const model = await fakeModel((_request, response) => {
    streamHead(response);
    response.write(START + delta('so far'));
    response.on('close', disconnected);
    // …and then nothing at all.
  });
  t.after(() => model.close());
  const failure = await failureOf(askWikiSystemModel(model.endpoint, { ...CALL, timeoutMs: 10_000, idleTimeoutMs: 300 }));
  assert.equal(failure.kind, 'retryable');
  assert.equal(failure.failure, 'idle');
  assert.equal(failure.partial, 'so far');
  // Disconnected for real: the server sees its side close.
  await gone;
});

test('the idle clock runs before the answer starts too: a server that never answers is disconnected', async (t) => {
  const model = await fakeModel(() => {
    // Never writes a header.
  });
  t.after(() => model.close());
  const failure = await failureOf(askWikiSystemModel(model.endpoint, { ...CALL, timeoutMs: 10_000, idleTimeoutMs: 300 }));
  assert.equal(failure.kind, 'retryable');
  assert.equal(failure.failure, 'idle');
  assert.equal(failure.status, null);
  assert.equal(failure.partial, '');
});

test('the caller\'s cancel ends a call as other/cancelled, carrying what had arrived; a call cancelled before it starts sends nothing', async (t) => {
  const model = await fakeModel((_request, response) => {
    streamHead(response);
    response.write(START + delta('before the cancel'));
  });
  t.after(() => model.close());
  const cancel = new AbortController();
  const failure = await failureOf(askWikiSystemModel(model.endpoint, {
    ...CALL,
    signal: cancel.signal,
    onPartial: () => cancel.abort(),
  }));
  assert.equal(failure.kind, 'other');
  assert.equal(failure.failure, 'cancelled');
  assert.equal(failure.partial, 'before the cancel');

  const already = new AbortController();
  already.abort();
  const before = model.received.length;
  const early = await failureOf(askWikiSystemModel(model.endpoint, { ...CALL, signal: already.signal }));
  assert.equal(early.failure, 'cancelled');
  assert.equal(model.received.length, before, 'a cancelled call still reached the model');
});

test('statuses are classed — 5xx and 429 retryable, 401 unauthorized, any other other — in words that name neither the address nor the key', async (t) => {
  let status = 0;
  const model = await fakeModel((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    // An endpoint that echoes the key and its own address back, as a misconfigured proxy might.
    response.end(JSON.stringify({
      type: 'error',
      error: { type: 'spec_error', message: `refused ${KEY} at ${model.endpoint.baseUrl}/v1/messages (${new URL(model.endpoint.baseUrl).host})` },
    }));
  });
  t.after(() => model.close());
  for (const [answered, kind] of [
    [500, 'retryable'],
    [502, 'retryable'],
    [503, 'retryable'],
    [529, 'retryable'],
    [429, 'retryable'],
    [401, 'unauthorized'],
    [400, 'other'],
    [403, 'other'],
    [404, 'other'],
    [413, 'other'],
  ] as const) {
    status = answered;
    const failure = await failureOf(askWikiSystemModel(model.endpoint, CALL));
    assert.equal(failure.kind, kind, `HTTP ${answered}`);
    assert.equal(failure.failure, 'http');
    assert.equal(failure.status, answered);
    assert.match(failure.message, new RegExp(`^HTTP ${answered} spec_error: refused `));
    assertNamesNoSecret(failure.message, model.endpoint);
  }
});

test('a connection that fails, or drops before message_stop, is retryable', async (t) => {
  // Nothing listens: the connection is refused, and the error says so by its code, not by the address.
  const vacant = await fakeModel(() => undefined);
  const refusedAt = vacant.endpoint;
  await vacant.close();
  const refused = await failureOf(askWikiSystemModel(refusedAt, CALL));
  assert.equal(refused.kind, 'retryable');
  assert.equal(refused.failure, 'connection');
  assert.match(refused.message, /ECONNREFUSED/);
  assertNamesNoSecret(refused.message, refusedAt);

  // The answer ends cleanly, but before message_stop.
  const ended = await fakeModel(async (_request, response) => {
    streamHead(response);
    await writeSlowly(response, [START, delta('cut off')]);
    response.end();
  });
  t.after(() => ended.close());
  const short = await failureOf(askWikiSystemModel(ended.endpoint, CALL));
  assert.equal(short.kind, 'retryable');
  assert.equal(short.failure, 'connection');
  assert.equal(short.partial, 'cut off');

  // The socket is torn down mid-stream.
  const torn = await fakeModel(async (_request, response) => {
    streamHead(response);
    await writeSlowly(response, [START, delta('torn')]);
    response.socket?.destroy();
  });
  t.after(() => torn.close());
  const dropped = await failureOf(askWikiSystemModel(torn.endpoint, CALL));
  assert.equal(dropped.kind, 'retryable');
  assert.equal(dropped.failure, 'connection');
  assert.equal(dropped.partial, 'torn');
});

test('an error event in the stream is classed by its type, and carries what had arrived', async (t) => {
  let type = '';
  const model = await fakeModel(async (_request, response) => {
    streamHead(response);
    await writeSlowly(response, [START, delta('until the error'), sse('error', { error: { type, message: `upstream ${KEY}` } })]);
    response.end();
  });
  t.after(() => model.close());
  for (const [errorType, kind] of [
    ['overloaded_error', 'retryable'],
    ['api_error', 'retryable'],
    ['rate_limit_error', 'retryable'],
    ['authentication_error', 'unauthorized'],
    ['invalid_request_error', 'other'],
  ] as const) {
    type = errorType;
    const failure = await failureOf(askWikiSystemModel(model.endpoint, CALL));
    assert.equal(failure.kind, kind, errorType);
    assert.equal(failure.failure, 'stream');
    assert.equal(failure.partial, 'until the error');
    assert.match(failure.message, new RegExp(`^stream error ${errorType}`));
    assertNamesNoSecret(failure.message, model.endpoint);
  }
});

test('an answer that is not an event stream is other/protocol', async (t) => {
  const model = await fakeModel((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'not streamed' }] }));
  });
  t.after(() => model.close());
  const failure = await failureOf(askWikiSystemModel(model.endpoint, CALL));
  assert.equal(failure.kind, 'other');
  assert.equal(failure.failure, 'protocol');
  assert.equal(failure.status, 200);
});

test('the probe: GET /health with the key, 200 and 404 up, 401 auth_failed, anything else, no answer or no connection down', async (t) => {
  let status = 200;
  let answer = true;
  const model = await fakeModel((_request, response) => {
    if (!answer) return;
    response.writeHead(status, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  t.after(() => model.close());

  assert.deepEqual(await probeWikiSystemModel(model.endpoint), { state: 'up', error: null });
  const [sent] = model.received;
  assert.equal(sent.method, 'GET');
  assert.equal(sent.url, '/health');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');

  status = 404;
  assert.deepEqual(await probeWikiSystemModel(model.endpoint), { state: 'up', error: null });
  status = 401;
  assert.deepEqual(await probeWikiSystemModel(model.endpoint), { state: 'auth_failed', error: 'the key was refused: /health answered HTTP 401' });
  status = 503;
  assert.deepEqual(await probeWikiSystemModel(model.endpoint), { state: 'down', error: '/health answered HTTP 503' });
  status = 403;
  assert.equal((await probeWikiSystemModel(model.endpoint)).state, 'down');

  answer = false;
  assert.deepEqual(await probeWikiSystemModel(model.endpoint, 1_000), { state: 'down', error: '/health did not answer within 1 s' });

  const vacant = await fakeModel(() => undefined);
  await vacant.close();
  const refused = await probeWikiSystemModel(vacant.endpoint);
  assert.equal(refused.state, 'down');
  assert.match(refused.error ?? '', /^\/health could not be reached \(ECONNREFUSED\)$/);
  assertNamesNoSecret(refused.error ?? '', vacant.endpoint);
});
