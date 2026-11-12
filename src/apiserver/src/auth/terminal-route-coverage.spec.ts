import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { OWNER_INTERACTIVE_ROUTES } from './pat-owner-channel-routes';
import { type Controller, guardsOf, handlersOf, isJwtAuthGuard, join, mountedControllers } from './route-census';
import { TERMINAL_ROUTE, type TerminalRouteKind, terminalRouteOf } from './terminal-credentials';
import { TERMINAL_REFUSED_ROUTES } from './terminal-refused-routes';

// The TERMINAL credential's census (docs/terminal-session-design.md, "The terminal credential"): `orbit` in a terminal
// acts with a credential the owner approved in the app for one machine. JwtAuthGuard admits it only to a handler that
// declares @TerminalRoute(kind), judges what the request names against the credential's runner, and refuses it 403
// TERMINAL_ROUTE_NOT_ALLOWED everywhere else. Deny by default is the guard's; the DECISION is this file's: every route
// the production app mounts behind JwtAuthGuard is either in TERMINAL_ALLOWED below or in TERMINAL_REFUSED_ROUTES
// (terminal-refused-routes.ts), exact both ways, so a route added without saying what a terminal may do there is red
// here, and so is a route opened to a terminal without being listed.
//
// Routes outside JwtAuthGuard (the runner's, the service bridges', public pages) never read a TERMINAL credential: the
// guards there know only their own. They are enumerated too, and none of them may carry a terminal declaration.

const TERMINAL_ALLOWED: Readonly<Record<string, TerminalRouteKind>> = {
  // A conversation on this machine: create it, open it, send, interrupt, read its events, answer its approval cards.
  'POST /sessions': 'CREATE_SESSION',
  'GET /sessions/:id': 'SESSION',
  'POST /sessions/:id/turns': 'SESSION',
  'POST /sessions/:id/interrupt': 'SESSION',
  'GET /sessions/:id/events/page': 'SESSION',
  'GET /sessions/:id/events': 'SESSION',
  'POST /sessions/:id/approvals/:approvalId/decision': 'SESSION',
  // Which workspace the cwd is in: the workspaces on this machine's runner, and no other.
  'GET /workspaces': 'WORKSPACE_LIST',
  'GET /agents': 'WORKSPACE_LIST',
  // The terminal acting on itself.
  'GET /terminals/self': 'SELF',
  'DELETE /terminals/self': 'SELF',
};

/** The one owner-channel door a terminal reaches: answering an approval card (D7 = B, the owner's accepted risk). */
const OWNER_CHANNEL_ADMITTED = ['POST /sessions/:id/approvals/:approvalId/decision'];

interface Route {
  route: string;
  at: string;
  jwt: boolean;
  /** What the handler declares for a terminal, read through the function JwtAuthGuard decides with. */
  terminal: TerminalRouteKind | undefined;
  /** Whether the handler carries the mark at all, valid or not. */
  marked: boolean;
}

const reflector = new Reflector();

function routesOf(controller: Controller): Route[] {
  const prefixes = [Reflect.getMetadata(PATH_METADATA, controller) ?? ''].flat() as string[];
  const classGuarded = guardsOf(controller).some(isJwtAuthGuard);
  const routes: Route[] = [];
  for (const [name, handler] of handlersOf(controller)) {
    const jwt = classGuarded || guardsOf(handler).some(isJwtAuthGuard);
    const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
    for (const prefix of prefixes) {
      for (const sub of [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat() as string[]) {
        routes.push({
          route: `${method} ${join(prefix, sub)}`,
          at: `${controller.name}.${name}`,
          jwt,
          terminal: terminalRouteOf(reflector, handler),
          marked: Reflect.getMetadata(TERMINAL_ROUTE, handler) !== undefined,
        });
      }
    }
  }
  return routes;
}

const census = (async () => {
  const controllers = await mountedControllers();
  return { controllers, routes: [...controllers].flatMap(routesOf) };
})();

test('the census reads every route the production app mounts', async () => {
  const { controllers, routes } = await census;
  assert.ok(controllers.size > 50, `found ${controllers.size} controllers — the module walk broke, not the app`);
  assert.ok(routes.filter((r) => r.jwt).length > 250, 'the JwtAuthGuard routes — the metadata shape changed, not the routes');
});

test('every JwtAuthGuard route has a TERMINAL decision: allowed (with what it is held to) or refused, exact both ways', async (t) => {
  const { routes } = await census;
  const jwt = routes.filter((r) => r.jwt);
  const known = new Set(jwt.map((r) => r.route));
  const allowed = new Set(Object.keys(TERMINAL_ALLOWED));
  const refused = new Set(TERMINAL_REFUSED_ROUTES);

  const both = [...allowed].filter((route) => refused.has(route));
  assert.deepEqual(both, [], 'listed both as allowed and as refused');
  const undecided = jwt.filter((r) => !allowed.has(r.route) && !refused.has(r.route)).map((r) => `${r.route} (${r.at})`);
  assert.deepEqual(
    undecided,
    [],
    'decide what a TERMINAL credential may do on each new route: add it to TERMINAL_REFUSED_ROUTES '
      + '(terminal-refused-routes.ts), or open it with @TerminalRoute(kind) and list it in TERMINAL_ALLOWED',
  );
  const stale = [...allowed, ...refused].filter((route) => !known.has(route));
  assert.deepEqual(stale, [], 'listed, but no JwtAuthGuard route answers it');
  assert.equal(refused.size, TERMINAL_REFUSED_ROUTES.length, 'TERMINAL_REFUSED_ROUTES lists a route twice');

  // What the guard reads off each handler is what is listed: a refused route declares nothing, an allowed one its kind.
  const wrong = jwt
    .filter((r) => r.terminal !== TERMINAL_ALLOWED[r.route] || (r.marked && !r.terminal))
    .map((r) => `${r.route} (${r.at}): declares ${r.terminal ?? (r.marked ? 'an unknown kind' : 'nothing')}, `
      + `listed ${TERMINAL_ALLOWED[r.route] ?? 'refused'}`);
  assert.deepEqual(wrong, []);

  const table = jwt
    .map((r) => `${r.terminal ? `ALLOWED (${r.terminal})` : 'REFUSED 403'}  ${r.route}`)
    .sort((a, b) => Number(b.startsWith('ALLOWED')) - Number(a.startsWith('ALLOWED')) || a.localeCompare(b));
  t.diagnostic(
    `${jwt.length} JwtAuthGuard routes: ${jwt.filter((r) => r.terminal).length} allowed to a TERMINAL credential, `
      + `${jwt.filter((r) => !r.terminal).length} refused 403\n${table.join('\n')}`,
  );
});

test('no route outside JwtAuthGuard, and no controller, carries a terminal declaration', async (t) => {
  const { controllers, routes } = await census;
  const outside = routes.filter((r) => !r.jwt);
  assert.deepEqual(outside.filter((r) => r.marked).map((r) => `${r.route} (${r.at})`), [], 'a mark JwtAuthGuard never reads');
  assert.deepEqual([...controllers].filter((c) => Reflect.getMetadata(TERMINAL_ROUTE, c) !== undefined).map((c) => c.name), []);
  t.diagnostic(
    `${outside.length} routes outside JwtAuthGuard, where a TERMINAL credential is not a credential:\n`
      + outside.map((r) => `NOT READ  ${r.route}`).sort().join('\n'),
  );
});

test('every owner-channel route but the approval decision refuses a TERMINAL credential', async () => {
  const { routes } = await census;
  const opened = OWNER_INTERACTIVE_ROUTES.filter((route) => routes.some((r) => r.route === route && r.terminal));
  assert.deepEqual(opened.sort(), [...OWNER_CHANNEL_ADMITTED].sort());
  for (const route of OWNER_INTERACTIVE_ROUTES) {
    if (!OWNER_CHANNEL_ADMITTED.includes(route)) assert.ok(TERMINAL_REFUSED_ROUTES.includes(route), `${route} is not listed refused`);
  }
});

test('what each allowed route is held to fits the route: a session in its path, a session made, a list narrowed', async () => {
  const wrong = Object.entries(TERMINAL_ALLOWED).filter(([route, kind]) => {
    const path = route.split(' ')[1];
    if (kind === 'SESSION') return !path.startsWith('/sessions/:id');
    if (kind === 'CREATE_SESSION') return route !== 'POST /sessions';
    if (kind === 'WORKSPACE_LIST') return !route.startsWith('GET ') || path.includes(':');
    return !path.startsWith('/terminals/self');
  });
  assert.deepEqual(wrong, []);
});
