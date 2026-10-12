import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { SlowRequestInterceptor } from './slow-request.interceptor';

/**
 * What the slow-request line says, and the two ways it must stay quiet.
 *
 * The threshold itself is not asserted against a literal — that number lives in the interceptor
 * and this file reads it through the clock instead: a request is timed by mocking `Date`, ticking
 * past 500 ms, and reading the line back. What IS asserted is the shape of the line (method, route
 * TEMPLATE, elapsed) and that the routes which hold by design never produce one, since a log full
 * of the 25 s runner polls is the failure mode that would make the whole thing worth deleting.
 */

/** Captures the lines, so the assertion is about what a reader sees rather than a call count. */
function captureWarnings() {
  const warnings: string[] = [];
  const original = Logger.prototype.warn;
  Logger.prototype.warn = function (message: unknown) {
    warnings.push(String(message));
  } as never;
  return { warnings, restore: () => (Logger.prototype.warn = original) };
}

function context(route: string | undefined, method = 'GET') {
  // Shaped like Express's request as the interceptor sees it: `route` is present only once a
  // handler matched, and its `path` is the registered pattern, global prefix included.
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, route: route === undefined ? {} : { path: route } }) }),
  };
}

test('a request slower than the threshold is logged with its route template and elapsed time', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { warnings, restore } = captureWarnings();
  try {
    const interceptor = new SlowRequestInterceptor();
    // Not subscribed yet: `intercept` reads the clock when it is called, and the response is
    // read when the handler's stream finishes — the gap the mock clock moves.
    const handled = interceptor.intercept(
      context('/api/projects') as never, { handle: () => of('body') } as never);
    t.mock.timers.tick(600);
    await new Promise((resolve) => handled.subscribe(resolve));
    assert.deepEqual(warnings, ['GET /api/projects 600ms']);
  } finally {
    restore();
  }
});

test('a request under the threshold is not logged', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { warnings, restore } = captureWarnings();
  try {
    const interceptor = new SlowRequestInterceptor();
    const handled = interceptor.intercept(
      context('/api/sessions') as never, { handle: () => of('body') } as never);
    t.mock.timers.tick(499);
    await new Promise((resolve) => handled.subscribe(resolve));
    assert.deepEqual(warnings, []);
  } finally {
    restore();
  }
});

test('a route that is supposed to hold is never timed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { warnings, restore } = captureWarnings();
  try {
    const held = [
      '/api/runner/sessions/claim',
      '/api/runner/wake',
      '/api/runner/sessions/:id/inbox',
      '/api/runner/sessions/:id/approvals/:approvalId',
      '/api/events',
      '/api/sessions/:id/events',
    ];
    for (const route of held) {
      const interceptor = new SlowRequestInterceptor();
      const handled = interceptor.intercept(context(route) as never, { handle: () => of('body') } as never);
      t.mock.timers.tick(25_000);
      await new Promise((resolve) => handled.subscribe(resolve));
    }
    assert.deepEqual(warnings, []);
  } finally {
    restore();
  }
});

test('a request the client abandoned is still logged, because it is the one worth having', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { warnings, restore } = captureWarnings();
  try {
    const interceptor = new SlowRequestInterceptor();
    // A handler whose stream never ends on its own: the client hangs up, the framework
    // unsubscribes, and `finalize` is the only hook that runs.
    const handled = interceptor.intercept(
      context('/api/sessions') as never, { handle: () => new Observable(() => {}) } as never);
    const subscription = handled.subscribe();
    t.mock.timers.tick(4_000);
    subscription.unsubscribe();
    assert.deepEqual(warnings, ['GET /api/sessions 4000ms']);
  } finally {
    restore();
  }
});

test('a request that matched no route is not logged', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { warnings, restore } = captureWarnings();
  try {
    const interceptor = new SlowRequestInterceptor();
    const handled = interceptor.intercept(
      context(undefined) as never, { handle: () => of('body') } as never);
    t.mock.timers.tick(5_000);
    await new Promise((resolve) => handled.subscribe(resolve));
    assert.deepEqual(warnings, []);
  } finally {
    restore();
  }
});
