import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RequestMethod, type DynamicModule } from '@nestjs/common';
import {
  CONTROLLER_WATERMARK,
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { AppModule } from '../app.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  PAT_FORBIDDEN_REASONS,
  PAT_SCOPE,
  type PatDeclaration,
  type PatForbiddenReason,
  patDeclaration,
} from './pat-scope.decorator';
import { PAT_SCOPES } from './pat.service';

// The personal-access-token census (docs/personal-access-token-design.md §6.2). A token is the user
// on every route behind JwtAuthGuard, so each of those routes has to say what a token may do there:
// @PatScope (the scope it needs) or @PatForbidden (no token, and why). One that says neither is closed
// to tokens by the guard — fail-closed — and red here, which is where its author makes the decision.
//
// The routes are read the way the app mounts them — AppModule's imports followed all the way down —
// and every declaration through `patDeclaration`, the function JwtAuthGuard itself decides with, so
// what this file reports is what a token meets. Paths are the controllers' own, under /api.

type Controller = new (...args: never[]) => unknown;

interface Route {
  /** `POST /tasks/:taskId/owner-confirmation` */
  route: string;
  path: string;
  at: string;
  declared: PatDeclaration;
}

const reflector = new Reflector();

/** Every controller the production app mounts. */
async function mountedControllers(): Promise<Set<Controller>> {
  const seen = new Set<unknown>();
  const controllers = new Set<Controller>();
  const visit = async (entry: unknown): Promise<void> => {
    // `ConfigModule.forRoot()` is a promise of its module; `forwardRef(() => X)` names one lazily.
    let node = await entry;
    if (node && typeof node === 'object' && 'forwardRef' in node) node = (node as { forwardRef: () => unknown }).forwardRef();
    if (!node || seen.has(node)) return;
    seen.add(node);
    const dynamic = typeof node === 'object' ? (node as DynamicModule) : undefined;
    const declared = (key: string) => (Reflect.getMetadata(key, dynamic ? dynamic.module : (node as object)) ?? []) as unknown[];
    for (const c of [...declared(MODULE_METADATA.CONTROLLERS), ...(dynamic?.controllers ?? [])]) controllers.add(c as Controller);
    for (const i of [...declared(MODULE_METADATA.IMPORTS), ...(dynamic?.imports ?? [])]) await visit(i);
  };
  await visit(AppModule);
  return controllers;
}

const isJwtAuthGuard = (guard: unknown) => guard === JwtAuthGuard || guard instanceof JwtAuthGuard;
const guardsOf = (target: object) => (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];

/** A controller's handlers, inherited ones included, as Nest's route explorer finds them. */
function handlersOf(controller: Controller): Array<[string, (...args: unknown[]) => unknown]> {
  const found = new Map<string, (...args: unknown[]) => unknown>();
  for (let proto = controller.prototype as object; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const value = Object.getOwnPropertyDescriptor(proto, name)?.value;
      if (name === 'constructor' || found.has(name) || typeof value !== 'function') continue;
      if (Reflect.getMetadata(METHOD_METADATA, value) === undefined) continue;
      found.set(name, value);
    }
  }
  return [...found];
}

const join = (...parts: string[]) => '/' + parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/** The routes behind JwtAuthGuard: one row per method and path a handler answers. */
function jwtRoutesOf(controller: Controller): Route[] {
  const prefixes = [Reflect.getMetadata(PATH_METADATA, controller) ?? ''].flat() as string[];
  const classGuarded = guardsOf(controller).some(isJwtAuthGuard);
  const routes: Route[] = [];
  for (const [name, handler] of handlersOf(controller)) {
    if (!classGuarded && !guardsOf(handler).some(isJwtAuthGuard)) continue;
    const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
    const declared = patDeclaration(reflector, handler, controller);
    for (const prefix of prefixes) {
      for (const sub of [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat() as string[]) {
        const routePath = join(prefix, sub);
        routes.push({ route: `${method} ${routePath}`, path: routePath, at: `${controller.name}.${name}`, declared });
      }
    }
  }
  return routes;
}

const describe = (d: PatDeclaration) =>
  d.kind === 'FORBIDDEN' ? `@PatForbidden('${d.reason}')` : d.kind === 'SCOPE' ? `@PatScope('${d.scope}')` : 'nothing';

const census = (async () => {
  const controllers = await mountedControllers();
  const routes = [...controllers].flatMap(jwtRoutesOf);
  return { controllers, routes };
})();

// ── §4: never grantable ─────────────────────────────────────────────────────────────────────────
// By path, so a route added to one of these families later is held to it without being listed.
const NEVER_GRANTABLE: ReadonlyArray<{
  rule: string;
  reason: PatForbiddenReason;
  matches: (path: string) => boolean;
  /** Set only for a family that has no route yet: the rule waits for the routes it will hold. */
  noRouteYet?: string;
}> = [
  { rule: 'auth/*', reason: 'AUTH', matches: (p) => p.startsWith('/auth/') },
  { rule: 'admin/*', reason: 'ADMIN', matches: (p) => p.startsWith('/admin/') },
  {
    rule: 'the access tokens themselves (§6.5)',
    reason: 'TOKEN_MANAGEMENT',
    matches: (p) => /^\/access-tokens(\/|$)/.test(p),
    noRouteYet: 'issuing, listing and revoking land with the settings page (§10 step 4)',
  },
  // Runner registration approval, and the enrollment tokens that are its other door: a machine they
  // admit receives the account's work.
  { rule: 'admitting a runner', reason: 'RUNNER_CREDENTIALS', matches: (p) => /^\/runners\/(device\/|enrollment-tokens$)/.test(p) },
  { rule: "rotating a runner's token", reason: 'RUNNER_CREDENTIALS', matches: (p) => p === '/runners/:id/rotate-token' },
  { rule: 'share links', reason: 'SHARE_LINK', matches: (p) => /\/share(-links)?(\/|$)/.test(p) },
];

// ── §5: the owner channel ───────────────────────────────────────────────────────────────────────
// Exact both ways: a route refused as the owner's own decision is listed here, and a route listed
// here is refused. The next task holds each of them to a spec of its own.
const OWNER_INTERACTIVE = [
  // The design's list.
  'POST /tasks/:taskId/owner-confirmation',
  'POST /tasks/:taskId/evidence/decision',
  'POST /sessions/:id/approvals/:approvalId/decision',
  'POST /projects/:id/acceptance/confirmation',
  'POST /projects/:id/acceptance/criteria-decisions/:intentId',
  'POST /projects/:projectId/promotions/:promotionId/confirm',
  'POST /projects/:projectId/promotions/:promotionId/decline',
  'POST /projects/:projectId/promotions/:promotionId/cancel',
  'POST /projects/:id/handoffs/:handoffId/decision',
  // The same rule where the design names no door: the owner's own decisions the code already keeps
  // from agents. These refuse a request that carries an agent session — starting a project seals its
  // criteria, the standard-set confirmation by another door.
  'POST /projects/:id/start',
  'POST /projects/:id/done',
  'POST /projects/:id/pause',
  'POST /projects/:id/resume',
  'POST /projects/:id/done-requests/:itemId/decline',
  // These answer what was put to the owner, on a door no agent has: the commitToken that decides a
  // held criteria change, the fuse that stopped a coordinator, the items escalated to the owner.
  'GET /projects/:id/acceptance/criteria-decisions/pending',
  'POST /projects/:id/fuse/:episodeId/resume',
  'POST /projects/:id/open-items/:itemId/answer',
  'POST /projects/:id/open-items/:itemId/return-to-coordinator',
  'POST /projects/:id/open-items/:itemId/resolve',
  // The wiki's owner channel: each refuses an agent session WIKI_OWNER_CHANNEL_ONLY.
  'POST /wiki/entries/:id/reject',
  'POST /wiki/entries/:id/confirm',
  'POST /wiki/changesets/:id/decide',
  'POST /wiki/changesets/:id/revert',
  'POST /wiki/spaces/:id/verifications/reopen',
  'GET /wiki/changesets/:id',
  'GET /wiki/spaces/:id/plan',
  'GET /wiki/spaces/:id/plan/versions',
  'GET /wiki/spaces/:id/plan/versions/:version',
  'POST /wiki/spaces/:id/plan/edits',
  'POST /wiki/spaces/:id/plan/versions/:version/confirm',
  'POST /wiki/spaces/:id/plan/redraft',
  'POST /wiki/plan-proposals/:id/decide',
];

test('the census reads every controller the production app mounts, and every one that uses JwtAuthGuard', async () => {
  const { controllers, routes } = await census;
  assert.ok(controllers.size > 50, `found ${controllers.size} controllers — the module walk broke, not the app`);
  assert.ok(routes.length > 250, `found ${routes.length} JwtAuthGuard routes — the metadata shape changed, not the routes`);

  // Every compiled controller that names JwtAuthGuard is one the walk reached: a module edge it
  // could not follow would otherwise take that controller's routes out of the census unseen.
  const unreached: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.controller.js')) {
        for (const value of Object.values(require(full) as Record<string, unknown>)) {
          if (typeof value !== 'function' || !Reflect.getMetadata(CONTROLLER_WATERMARK, value)) continue;
          const guarded = guardsOf(value).some(isJwtAuthGuard)
            || handlersOf(value as Controller).some(([, handler]) => guardsOf(handler).some(isJwtAuthGuard));
          if (guarded && !controllers.has(value as Controller)) unreached.push(`${path.relative(dir, full)}: ${value.name}`);
        }
      }
    }
  };
  walk(path.resolve(__dirname, '..'));
  assert.deepEqual(unreached, []);
});

test('every route behind JwtAuthGuard declares what a personal access token may do there', async (t) => {
  const { routes } = await census;
  const undeclared = routes.filter((r) => r.declared.kind === 'UNDECLARED').map((r) => `${r.route} (${r.at})`);
  assert.deepEqual(
    undeclared,
    [],
    'declare @PatScope(<scope>) on the handler, or @PatForbidden(<reason>) on it or its controller ' +
      '(docs/personal-access-token-design.md §4, §6.2): a route that declares neither is 403 to every token',
  );
  const scoped = routes.filter((r) => r.declared.kind === 'SCOPE').length;
  t.diagnostic(`${routes.length} JwtAuthGuard routes: ${scoped} open to a token with their scope, ${routes.length - scoped} refused to every token`);
});

test('§4: auth/*, admin/*, the token routes, admitting a runner, rotating its token and share links are refused to every token', async () => {
  const { routes } = await census;
  for (const { rule, reason, matches, noRouteYet } of NEVER_GRANTABLE) {
    const held = routes.filter((r) => matches(r.path));
    if (!noRouteYet) assert.ok(held.length > 0, `${rule}: matches no route — the rule went stale`);
    const wrong = held
      .filter((r) => !(r.declared.kind === 'FORBIDDEN' && r.declared.reason === reason))
      .map((r) => `${r.route} (${r.at}) declares ${describe(r.declared)}`);
    assert.deepEqual(wrong, [], `${rule} must be @PatForbidden('${reason}')`);
  }
});

test("§5: the owner channel's doors are refused to every token, and are exactly the listed ones", async () => {
  const { routes } = await census;
  const byRoute = new Map(routes.map((r) => [r.route, r]));
  const notRefused = OWNER_INTERACTIVE.filter((route) => {
    const declared = byRoute.get(route)?.declared;
    return !(declared?.kind === 'FORBIDDEN' && declared.reason === 'OWNER_INTERACTIVE');
  }).map((route) => `${route}: ${byRoute.has(route) ? describe(byRoute.get(route)!.declared) : 'no such JwtAuthGuard route'}`);
  assert.deepEqual(notRefused, [], "must be @PatForbidden('OWNER_INTERACTIVE')");
  const unlisted = routes
    .filter((r) => r.declared.kind === 'FORBIDDEN' && r.declared.reason === 'OWNER_INTERACTIVE')
    .map((r) => r.route)
    .filter((route) => !OWNER_INTERACTIVE.includes(route));
  assert.deepEqual(unlisted, [], 'refused as the owner channel but not in OWNER_INTERACTIVE above');
});

test('declarations name scopes and reasons that exist, a scope sits on a handler only, and every scope opens a route', async () => {
  const { controllers, routes } = await census;
  const scopes = new Set<string>(PAT_SCOPES);
  const unknown = routes
    .filter((r) => (r.declared.kind === 'SCOPE' && !scopes.has(r.declared.scope))
      || (r.declared.kind === 'FORBIDDEN' && !(r.declared.reason in PAT_FORBIDDEN_REASONS)))
    .map((r) => `${r.route}: ${describe(r.declared)}`);
  assert.deepEqual(unknown, []);
  // The guard reads a scope off the handler and nowhere else; one on a controller would open nothing.
  assert.deepEqual([...controllers].filter((c) => Reflect.getMetadata(PAT_SCOPE, c) !== undefined).map((c) => c.name), []);
  // A scope no route declares is a box in the settings page that grants nothing.
  const used = new Set(routes.flatMap((r) => (r.declared.kind === 'SCOPE' ? [r.declared.scope] : [])));
  assert.deepEqual(PAT_SCOPES.filter((scope) => !used.has(scope)), []);
});
