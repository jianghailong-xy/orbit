import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request } from 'express';
import { apiserverLogger, currentRequestId, JsonRequestLogger, requestIdContext } from './request-log';

/** What `write` printed to stdout and stderr while it ran, line by line. */
function captured(write: () => void): string[] {
  const lines: string[] = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const keep = (chunk: unknown) => {
    lines.push(...String(chunk).split('\n').filter((l) => l !== ''));
    return true;
  };
  process.stdout.write = keep as typeof process.stdout.write;
  process.stderr.write = keep as typeof process.stderr.write;
  try {
    write();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return lines;
}

function served(headers: Record<string, unknown>, handler: () => void): void {
  let called = false;
  requestIdContext({ headers } as unknown as Request, {} as never, () => {
    called = true;
    handler();
  });
  assert.ok(called, 'the chain continues whatever the header says');
}

const NGINX_ID = '3f1c9a0b5d7e4f2a8c6b1d0e9f8a7b6c';

test('a line written while a request is served is one JSON object carrying its X-Request-Id', () => {
  const logger = new JsonRequestLogger();
  let lines: string[] = [];
  served({ 'x-request-id': NGINX_ID }, () => {
    lines = captured(() => logger.warn('POST /api/sessions 812ms', 'SlowRequestInterceptor'));
  });
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.requestId, NGINX_ID);
  assert.equal(line.level, 'warn');
  assert.equal(line.context, 'SlowRequestInterceptor');
  assert.equal(line.message, 'POST /api/sessions 812ms');
});

test('the id follows the request across an await', async () => {
  const logger = new JsonRequestLogger();
  let pending: Promise<string[]> = Promise.resolve([]);
  served({ 'x-request-id': NGINX_ID }, () => {
    pending = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return captured(() => logger.log('connected to NATS at nats://nats:4222', 'RunnerHints'));
    })();
  });
  const [line] = await pending;
  assert.equal(JSON.parse(line).requestId, NGINX_ID);
});

test('a line written outside any request, or for one without a usable id, carries none', () => {
  const logger = new JsonRequestLogger();
  const outside = captured(() => logger.log('runner link calls are served on 0.0.0.0:3001', 'RunnerLink'));
  assert.equal(JSON.parse(outside[0]).requestId, undefined);
  for (const header of [undefined, '', 'has space', 'x'.repeat(65), ['a', 'b']]) {
    served({ 'x-request-id': header }, () => {
      assert.equal(currentRequestId(), undefined, `header ${JSON.stringify(header)}`);
      const [line] = captured(() => logger.log('hello'));
      assert.equal(JSON.parse(line).requestId, undefined);
    });
  }
});

test('an error keeps its stack inside the one JSON line', () => {
  const logger = new JsonRequestLogger();
  const lines = captured(() => logger.error('boom', 'Error: boom\n    at here', 'Queue'));
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.level, 'error');
  assert.match(line.stack, /at here/);
});

test('ORBIT_LOG_FORMAT=json picks the JSON logger; anything else keeps Nest default text', () => {
  assert.ok(apiserverLogger({ ORBIT_LOG_FORMAT: 'json' }) instanceof JsonRequestLogger);
  assert.equal(apiserverLogger({}), undefined);
  assert.equal(apiserverLogger({ ORBIT_LOG_FORMAT: 'text' }), undefined);
});
