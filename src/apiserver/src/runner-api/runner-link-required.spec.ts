import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ExecutionContext, HttpException, RequestMethod } from '@nestjs/common';
import { INTERCEPTORS_METADATA, METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { lastValueFrom, of } from 'rxjs';
import { markRunnerLinkCall } from '../common/runner-link-call';
import { RunnerApiController } from './runner-api.controller';
import { RunnerApiModule } from './runner-api.module';
import {
  calledByNamedCallers,
  RUNNER_CALLER_HEADER,
  RunnerLinkRequiredInterceptor,
  staysOnHttps,
  UPGRADE_REQUIRED_STATUS,
} from './runner-link-required';

/**
 * The HTTPS door of RunnerApiController (runner-link-required.ts) over doubles: which routes it refuses and what it
 * answers. runner-link-required.pg.spec.ts drives the same over HTTP against the production apiserver.
 */

/**
 * RunnerApiController's routes that are refused over HTTPS: the runner daemon's protocol. 44 on 2026-10-25, which with
 * STAYS_ON_HTTPS are the 49 the design counted (docs/runner-link-design.md §11.3), and 47 since 2026-10-28, when the
 * daemon's three calls that went beside the agent tool API moved here: a Cursor key check's answer, a session's own key
 * check and a background job's alert (§15.9). 48 since 2026-10-31: the directory probe's answer
 * (docs/first-workspace-contract.md §2.4). 47 again since the cleanup after the cut-over (§13), which took
 * `POST /runner/sessions/:id/complete` away. src/runner-go/link_mode.go holds them in linkDaemonRoutes, but for
 * `GET /runner/wake`, which nothing serves any more (RETIRED).
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
  'POST /runner/dir-probe-result',
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
  'POST /runner/sessions/:id/import-result',
  'POST /runner/sessions/worktrees-removable',
  'POST /runner/sessions/:id/merge-result',
  'POST /runner/sessions/:id/commit-result',
  'POST /runner/sessions/:id/diff',
  'GET /runner/sessions/:id/meta',
  'GET /runner/sessions/:id/events',
];

/**
 * Daemon routes whose handler is the refusal alone, on both doors: a runner of 0.1.246 asks for it once as its process
 * starts, and its wake loop ends for the life of the process on a 404 (the route in runner-api.controller.ts).
 */
const RETIRED = ['GET /runner/wake'];

/**
 * The daemon routes that processes other than the daemon also call, naming themselves in X-Orbit-Runner-Caller, over
 * HTTPS: they hold no link of their own (docs/runner-link-design.md §15.9). The routes stay for those requests alone
 * (@CalledByNamedCallers()): the header changes nothing on any other route. Read from src/runner-go: `orbit mcp` asks for approvals, reads them,
 * schedules wakeups and renews its orchestration credential, the Antigravity hook asks for approvals, and the CLI calls
 * `status`, `deregister`, `resume` and a session's transcript.
 */
const CALLED_BY_NAMED_CALLERS = [
  'GET /runner/me',
  'POST /runner/deregister',
  'POST /runner/sessions/:id/approvals',
  'GET /runner/sessions/:id/approvals/:approvalId',
  'POST /runner/sessions/:id/scheduled-wakeup',
  'POST /runner/sessions/:id/orchestration-credential',
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
  // The file an agent keeps with `file_upload`: multipart, like the attachment beside it.
  'POST /runner/sessions/:id/files',
  // The Claude region check (docs/claude-region-check-contract.md §3): it has to leave through Claude's proxy, since 2026-11-01.
  'GET /runner/region-check',
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

const door = () => new RunnerLinkRequiredInterceptor();

test('RunnerApiController has 54 routes: 47 refused over HTTPS, 7 kept on HTTPS (D14); a new one fails here', () => {
  const routes = routesOf(RunnerApiController);
  assert.equal(REFUSED_OVER_HTTPS.length, 47);
  assert.deepEqual(
    sorted(routes.map((r) => r.route)),
    sorted([...REFUSED_OVER_HTTPS, ...STAYS_ON_HTTPS]),
    'a route was added to RunnerApiController or taken from it. Say which it is: the daemon protocol, which is refused '
      + 'over HTTPS (REFUSED_OVER_HTTPS; and src/runner-go/link_mode.go linkDaemonRoutes), or not part of it and marked '
      + '@StaysOnHttps() (STAYS_ON_HTTPS, docs/runner-link-design.md D14)',
  );
  assert.equal(routes.length, 54, 'the 49 counted on 2026-10-25, the three that moved here on 2026-10-28, the directory probe\'s answer, the Claude region check and the file upload of 2026-11-02, less /complete');
  assert.deepEqual(sorted(routes.filter((r) => staysOnHttps(r.handler)).map((r) => r.route)), sorted(STAYS_ON_HTTPS));
  for (const route of [...RETIRED, ...CALLED_BY_NAMED_CALLERS]) {
    assert.ok(REFUSED_OVER_HTTPS.includes(route), `${route} is not one of the daemon's routes`);
  }
  assert.equal(CALLED_BY_NAMED_CALLERS.length, 8);
  assert.deepEqual(
    sorted(routes.filter((r) => calledByNamedCallers(r.handler)).map((r) => r.route)),
    sorted(CALLED_BY_NAMED_CALLERS),
    'a route marked @CalledByNamedCallers() is one that src/runner-go calls with newCallerTransport',
  );
});

test('only RunnerApiController carries the refusal: the agent tool API, the link token, the release and the welcome route do not', () => {
  const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, RunnerApiModule) ?? []) as Array<{ name: string }>;
  const carrying = controllers
    .filter((c) => ((Reflect.getMetadata(INTERCEPTORS_METADATA, c) ?? []) as unknown[]).includes(RunnerLinkRequiredInterceptor))
    .map((c) => c.name);
  assert.deepEqual(carrying, ['RunnerApiController']);
  assert.ok(controllers.some((c) => c.name === 'RunnerLinkWelcomeController'), 'the welcome route is mounted, without the refusal');
  assert.ok(!controllers.some((c) => c.name === 'RunnerLinkRequiredController'), 'nothing switches it any more');
  for (const { handler } of routesOf(RunnerApiController)) {
    assert.equal(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)?.includes(RunnerLinkRequiredInterceptor) ?? false, false);
  }
});

test('an HTTPS call to each refused route is answered 426 UPGRADE_REQUIRED, naming `orbit upgrade`', async () => {
  for (const route of REFUSED_OVER_HTTPS) {
    const answer = await through(door(), http(handlerOf(route), { headers: {} }));
    assert.ok(answer instanceof HttpException, `${route} was served`);
    assert.equal(answer.getStatus(), UPGRADE_REQUIRED_STATUS, route);
    const body = answer.getResponse() as { code: string; message: string; retryable: boolean };
    assert.equal(body.code, 'UPGRADE_REQUIRED', route);
    assert.equal(body.retryable, false);
    assert.match(body.message, /Run `orbit upgrade`/);
  }
});

test('what is never refused: a link call, a call naming its caller, and the routes kept on HTTPS', async () => {
  for (const caller of ['mcp', 'antigravity-hook', 'cli']) {
    for (const route of CALLED_BY_NAMED_CALLERS) {
      assert.equal(await through(door(), http(handlerOf(route), { headers: { [RUNNER_CALLER_HEADER]: caller } })), 'served', `${caller} ${route}`);
    }
  }
  // On any other daemon route the header changes nothing: nobody but the daemon calls those.
  for (const route of REFUSED_OVER_HTTPS.filter((r) => !CALLED_BY_NAMED_CALLERS.includes(r))) {
    const answer = await through(door(), http(handlerOf(route), { headers: { [RUNNER_CALLER_HEADER]: 'mcp' } }));
    assert.ok(answer instanceof HttpException && answer.getStatus() === UPGRADE_REQUIRED_STATUS, `${route} served a named caller`);
  }
  // A header with nothing in it names nobody: the daemon never sends one, so it reads as the daemon.
  const approvals = handlerOf('POST /runner/sessions/:id/approvals');
  for (const empty of ['', '   ']) {
    const answer = await through(door(), http(approvals, { headers: { [RUNNER_CALLER_HEADER]: empty } }));
    assert.ok(answer instanceof HttpException && answer.getStatus() === UPGRADE_REQUIRED_STATUS, `"${empty}"`);
  }
  const linkCall = { headers: {} };
  markRunnerLinkCall(linkCall);
  assert.equal(await through(door(), http(handlerOf('POST /runner/heartbeat'), linkCall)), 'served', 'a call the link gateway forwarded is the link');
  for (const route of STAYS_ON_HTTPS) {
    assert.equal(await through(door(), http(handlerOf(route), { headers: {} })), 'served', route);
  }
});

test('a route that is gone answers the same refusal itself, whoever calls: a 0.1.246 wake loop lives on anything but a 404', () => {
  const controller = Object.create(RunnerApiController.prototype) as RunnerApiController;
  assert.throws(() => controller.wake(), (error: unknown) => {
    assert.ok(error instanceof HttpException);
    assert.equal(error.getStatus(), UPGRADE_REQUIRED_STATUS);
    assert.equal((error.getResponse() as { code: string }).code, 'UPGRADE_REQUIRED');
    return true;
  });
  assert.equal(Reflect.getMetadata('__guards__', handlerOf('GET /runner/wake')), undefined, 'it reads nothing, not even the runner');
});
