import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ExecutionContext, HttpException, Logger, RequestMethod } from '@nestjs/common';
import { INTERCEPTORS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, of } from 'rxjs';
import { markRunnerLinkCall } from '../common/runner-link-call';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from './runner-api.controller';
import { RunnerApiModule } from './runner-api.module';
import {
  RUNNER_CALLER_HEADER,
  RUNNER_LINK_SWITCH_TTL_MS,
  RunnerLinkRequiredInterceptor,
  RunnerLinkSwitch,
  staysOnHttps,
  UPGRADE_REQUIRED_STATUS,
} from './runner-link-required';

/**
 * RUNNER_LINK_REQUIRED (runner-link-required.ts) over doubles: which routes it answers, what it answers, and how a
 * replica reads it. runner-link-required.pg.spec.ts drives the same over HTTP against the production apiserver.
 */

/**
 * RunnerApiController's routes that the switch refuses over HTTPS: the runner daemon's protocol. 44 on 2026-10-25,
 * which with STAYS_ON_HTTPS are the 49 the design counted (docs/runner-link-design.md §11.3), and 47 since 2026-10-28,
 * when the daemon's three calls that went beside the agent tool API moved here: a Cursor key check's answer, a session's
 * own key check and a background job's alert (§15.9). src/runner-go/link_mode.go holds the same routes in
 * linkDaemonRoutes.
 */
const REFUSED_OVER_HTTPS = [
  'GET /runner/me',
  'POST /runner/deregister',
  'POST /runner/heartbeat',
  'POST /runner/integration-jobs/:jobId/progress',
  'POST /runner/integration-jobs/:jobId/output',
  'POST /runner/integration-jobs/:jobId/release',
  'POST /runner/integration-jobs/:jobId/result',
  'POST /runner/wiki/repo-ops/:id/progress',
  'POST /runner/wiki/repo-ops/:id/fragments',
  'POST /runner/wiki/repo-ops/:id/result',
  'POST /runner/codex-rate-limit-reset-result',
  'POST /runner/repo-cleanup-result',
  'POST /runner/claude-history-result',
  'POST /runner/install-result',
  'POST /runner/codex-account-remove-result',
  'POST /runner/account-remove-result',
  'POST /runner/login-result',
  'POST /runner/cursor-key-check-result',
  'GET /runner/sessions/claim',
  'GET /runner/wake',
  'GET /runner/sessions/reclaim',
  'POST /runner/sessions/:id/source/pin',
  'POST /runner/sessions/:id/takeover-leases',
  'POST /runner/sessions/:id/activate-leases',
  'POST /runner/sessions/:id/release-leases',
  'POST /runner/sessions/:id/orchestration-credential',
  'GET /runner/sessions/:id/inbox',
  'POST /runner/sessions/:id/artifacts/result',
  'POST /runner/sessions/:id/approvals',
  'GET /runner/sessions/:id/approvals/:approvalId',
  'POST /runner/sessions/:id/background-wake',
  'POST /runner/sessions/:id/notify',
  'POST /runner/sessions/:id/scheduled-wakeup',
  'POST /runner/sessions/:id/naming',
  'POST /runner/sessions/:id/cursor-key-check',
  'POST /runner/sessions/:id/turns/:turnId/suggestion',
  'POST /runner/sessions/:id/turn-complete',
  'POST /runner/sessions/:id/events',
  'POST /runner/sessions/:id/finalize',
  'POST /runner/sessions/:id/complete',
  'POST /runner/sessions/:id/import-result',
  'POST /runner/sessions/worktrees-removable',
  'POST /runner/sessions/:id/merge-result',
  'POST /runner/sessions/:id/commit-result',
  'POST /runner/sessions/:id/diff',
  'GET /runner/sessions/:id/meta',
  'GET /runner/sessions/:id/events',
];

/** RunnerApiController's routes that are not the daemon protocol and stay on HTTPS (D14): marked @StaysOnHttps(). */
const STAYS_ON_HTTPS = [
  'POST /runner/register',
  'POST /runner/device/start',
  'POST /runner/device/poll',
  'GET /runner/sessions/:id/attachments/:attId',
  'POST /runner/sessions/:id/attachments',
];

type Handler = (...args: unknown[]) => unknown;

/** A controller's routes as Nest mounts them, each with its handler. */
function routesOf(controller: { prototype: object }): Array<{ route: string; handler: Handler }> {
  const prefix = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  const routes: Array<{ route: string; handler: Handler }> = [];
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    const handler = Object.getOwnPropertyDescriptor(controller.prototype, name)?.value as Handler | undefined;
    if (name === 'constructor' || typeof handler !== 'function') continue;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
    if (method === undefined) continue;
    const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
    routes.push({ route: `${RequestMethod[method]} /${[prefix, sub].filter(Boolean).join('/')}`, handler });
  }
  return routes;
}

const sorted = (values: string[]) => [...values].sort();
const handlerOf = (route: string): Handler => {
  const found = routesOf(RunnerApiController).find((r) => r.route === route);
  assert.ok(found, `no route ${route}`);
  return found.handler;
};

function http(handler: Handler, request: object): ExecutionContext {
  return {
    getType: () => 'http',
    getClass: () => RunnerApiController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Runs the interceptor; 'served' when the route's handler would run, else what it threw. */
async function through(interceptor: RunnerLinkRequiredInterceptor, context: ExecutionContext): Promise<unknown> {
  try {
    return await lastValueFrom(await interceptor.intercept(context, { handle: () => of('served') }));
  } catch (error) {
    return error;
  }
}

const switchedOn = () => new RunnerLinkRequiredInterceptor({ required: async () => true } as unknown as RunnerLinkSwitch);
const switchedOff = () => new RunnerLinkRequiredInterceptor({ required: async () => false } as unknown as RunnerLinkSwitch);

test('RunnerApiController has 52 routes: 47 the switch refuses over HTTPS, 5 kept on HTTPS (D14); a new one fails here', () => {
  const routes = routesOf(RunnerApiController);
  assert.equal(REFUSED_OVER_HTTPS.length, 47);
  assert.deepEqual(
    sorted(routes.map((r) => r.route)),
    sorted([...REFUSED_OVER_HTTPS, ...STAYS_ON_HTTPS]),
    'a route was added to RunnerApiController or taken from it. Say which it is: the daemon protocol, which '
      + 'RUNNER_LINK_REQUIRED refuses over HTTPS (REFUSED_OVER_HTTPS; and src/runner-go/link_mode.go linkDaemonRoutes), '
      + 'or not part of it and marked @StaysOnHttps() (STAYS_ON_HTTPS, docs/runner-link-design.md D14)',
  );
  assert.equal(routes.length, 52, 'the 49 counted on 2026-10-25, and the three that moved here on 2026-10-28');
  assert.deepEqual(sorted(routes.filter((r) => staysOnHttps(r.handler)).map((r) => r.route)), sorted(STAYS_ON_HTTPS));
});

test('only RunnerApiController carries the switch: the agent tool API, the link token, the release and the welcome route do not', () => {
  const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, RunnerApiModule) ?? []) as Array<{ name: string }>;
  const carrying = controllers
    .filter((c) => ((Reflect.getMetadata(INTERCEPTORS_METADATA, c) ?? []) as unknown[]).includes(RunnerLinkRequiredInterceptor))
    .map((c) => c.name);
  assert.deepEqual(carrying, ['RunnerApiController']);
  assert.ok(controllers.some((c) => c.name === 'RunnerLinkWelcomeController'), 'the welcome route is mounted, without the switch');
  for (const { handler } of routesOf(RunnerApiController)) {
    assert.equal(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)?.includes(RunnerLinkRequiredInterceptor) ?? false, false);
  }
});

test('switched on, an HTTPS call to each refused route is answered 426 UPGRADE_REQUIRED, naming `orbit upgrade`', async () => {
  for (const route of REFUSED_OVER_HTTPS) {
    const answer = await through(switchedOn(), http(handlerOf(route), { headers: {} }));
    assert.ok(answer instanceof HttpException, `${route} was served`);
    assert.equal(answer.getStatus(), UPGRADE_REQUIRED_STATUS, route);
    const body = answer.getResponse() as { code: string; message: string; retryable: boolean };
    assert.equal(body.code, 'UPGRADE_REQUIRED', route);
    assert.equal(body.retryable, false);
    assert.match(body.message, /RUNNER_LINK_REQUIRED/);
    assert.match(body.message, /Run `orbit upgrade`/);
  }
});

test('switched on, what is never refused: a link call, a call naming its caller, and the routes kept on HTTPS', async () => {
  const heartbeat = handlerOf('POST /runner/heartbeat');
  const approvals = handlerOf('POST /runner/sessions/:id/approvals');
  for (const caller of ['mcp', 'antigravity-hook', 'cli']) {
    for (const handler of [heartbeat, approvals, handlerOf('GET /runner/me'), handlerOf('GET /runner/sessions/:id/meta')]) {
      assert.equal(await through(switchedOn(), http(handler, { headers: { [RUNNER_CALLER_HEADER]: caller } })), 'served', caller);
    }
  }
  // A header with nothing in it names nobody: the daemon never sends one, so it reads as the daemon.
  for (const empty of ['', '   ']) {
    const answer = await through(switchedOn(), http(approvals, { headers: { [RUNNER_CALLER_HEADER]: empty } }));
    assert.ok(answer instanceof HttpException && answer.getStatus() === UPGRADE_REQUIRED_STATUS, `"${empty}"`);
  }
  const linkCall = { headers: {} };
  markRunnerLinkCall(linkCall);
  assert.equal(await through(switchedOn(), http(heartbeat, linkCall)), 'served', 'a call the link gateway forwarded is the link');
  for (const route of STAYS_ON_HTTPS) {
    assert.equal(await through(switchedOn(), http(handlerOf(route), { headers: {} })), 'served', route);
  }
});

test('switched off, or with no switch at all (the specs that build the controller by hand), nothing is refused', async () => {
  const absent = new RunnerLinkRequiredInterceptor();
  for (const route of [...REFUSED_OVER_HTTPS, ...STAYS_ON_HTTPS]) {
    assert.equal(await through(switchedOff(), http(handlerOf(route), { headers: {} })), 'served', route);
    assert.equal(await through(absent, http(handlerOf(route), { headers: {} })), 'served', route);
  }
});

/** A Prisma double holding the switch row: a function per read, which may throw. */
function prismaReading(reads: Array<() => { required: boolean } | null>) {
  let calls = 0;
  return {
    calls: () => calls,
    prisma: {
      runnerLinkSwitch: {
        findUnique: async () => {
          const read = reads[Math.min(calls, reads.length - 1)];
          calls += 1;
          return read();
        },
      },
    },
  };
}

test('a replica reads the switch at most once a second; a failed read keeps what it read; one that never read serves as before', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const warnings: string[] = [];
  t.mock.method(Logger.prototype, 'warn', (message: string) => {
    warnings.push(message);
  });
  t.mock.method(Logger.prototype, 'log', () => undefined);
  const down = (): never => {
    throw new Error('the database cannot be reached');
  };

  const db = prismaReading([() => ({ required: true }), () => ({ required: true }), down]);
  const linkSwitch = new RunnerLinkSwitch(db.prisma as never);
  assert.equal(await linkSwitch.required(), true);
  assert.equal(await linkSwitch.required(), true);
  assert.equal(db.calls(), 1, 'read again within the interval');
  t.mock.timers.tick(RUNNER_LINK_SWITCH_TTL_MS);
  const [a, b] = await Promise.all([linkSwitch.required(), linkSwitch.required()]);
  assert.deepEqual([a, b, db.calls()], [true, true, 2], 'two calls at once share one read');

  t.mock.timers.tick(RUNNER_LINK_SWITCH_TTL_MS);
  assert.equal(await linkSwitch.required(), true, 'a read that fails switches nothing off');
  assert.equal(db.calls(), 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keeps answering as it last read it \(on\)/);
  assert.equal(await linkSwitch.required(), true);
  assert.equal(db.calls(), 3, 'a failed read is not tried again on every call');
  t.mock.timers.tick(RUNNER_LINK_SWITCH_TTL_MS);
  assert.equal(await linkSwitch.required(), true);
  assert.equal(db.calls(), 4, 'it is tried again after the interval');
  assert.equal(warnings.length, 1, 'and said once a minute, not once a second');

  const never = new RunnerLinkSwitch(prismaReading([down]).prisma as never);
  assert.equal(await never.required(), false, 'a replica that never read the switch serves HTTPS as before');
  const empty = new RunnerLinkSwitch(prismaReading([() => null]).prisma as never);
  assert.equal(await empty.required(), false, 'no row is off');
});

test('the replica that switches it answers by the new state at once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  t.mock.method(Logger.prototype, 'log', () => undefined);
  let row: { required: boolean; updatedAt: Date; updatedById: string } | null = null;
  const statements: string[] = [];
  const prisma = {
    runnerLinkSwitch: { findUnique: async () => row },
    $queryRaw: async (...args: unknown[]) => {
      const { text, values } = renderRawQuery(args);
      statements.push(text);
      row = { required: values[0] as boolean, updatedAt: new Date(), updatedById: values[1] as string };
      return [{ required: row.required }];
    },
  };
  const linkSwitch = new RunnerLinkSwitch(prisma as never);
  assert.equal(await linkSwitch.required(), false);
  const view = await linkSwitch.set('7b0e8a54-61a4-4c43-b2f5-0c2f8f8a3c11', true);
  assert.deepEqual([view.required, view.updatedById], [true, '7b0e8a54-61a4-4c43-b2f5-0c2f8f8a3c11']);
  assert.equal(await linkSwitch.required(), true, 'within the interval, and with no read of its own');
  assert.equal(statements.length, 1);
  assert.match(statements[0], /INSERT INTO "runner_link_switch"/);
  assert.match(statements[0], /ON CONFLICT \("id"\) DO UPDATE/);
  assert.match(statements[0], /IS DISTINCT FROM EXCLUDED\."required"/);
});
