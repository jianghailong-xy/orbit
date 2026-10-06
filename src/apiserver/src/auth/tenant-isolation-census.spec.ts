import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Body, Param, Query, RequestMethod, type DynamicModule } from '@nestjs/common';
import {
  CONTROLLER_WATERMARK,
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { getMetadataStorage } from 'class-validator';
import { AppModule } from '../app.module';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  TENANT_ISOLATION_BY_HAND,
  TENANT_ISOLATION_CASES,
  TENANT_ISOLATION_FIELDS_BY_HAND,
  TENANT_ISOLATION_FIELD_CASES,
  paramsOf,
  type Tenant,
  type TenantRequest,
} from './tenant-isolation-cases';

// class-transformer keeps a nested DTO's class where class-validator does not: a list of DTOs
// (`@Type(() => X) items: X[]`) reflects as Array, and only `@Type` says what is in it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultMetadataStorage } = require('class-transformer/cjs/storage') as {
  defaultMetadataStorage: { findTypeMetadata(target: Function, property: string): { typeFunction?: () => unknown } | undefined };
};

// The tenant isolation census's roster (docs/google-sign-in-design.md §11 T1), held to the routes the
// production app mounts, both ways: every route behind JwtAuthGuard whose path names something has a
// case in TENANT_ISOLATION_CASES — which `tenant-isolation.pg.spec.ts` sends across accounts — or a
// reading in TENANT_ISOLATION_BY_HAND, and nothing is listed that the app does not mount. A route added
// with a path parameter and no line there is red here, in the merge check, before it ships.
//
// The routes are read the way `pat-route-coverage.spec.ts` reads them: AppModule's imports followed
// all the way down, a controller's inherited handlers included. Paths are the controllers' own, under /api.

type Controller = new (...args: never[]) => unknown;

/** Every controller the production app mounts. */
async function mountedControllers(): Promise<Set<Controller>> {
  const seen = new Set<unknown>();
  const controllers = new Set<Controller>();
  const visit = async (entry: unknown): Promise<void> => {
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
function handlersOf(controller: Controller): Array<[string, object]> {
  const found = new Map<string, object>();
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

interface Route {
  /** `GET /tasks/:id` */
  route: string;
  at: string;
  controller: Controller;
  method: string;
}

/** The routes behind JwtAuthGuard: one per method and path a handler answers. */
function jwtRoutesOf(controller: Controller): Route[] {
  const prefixes = [Reflect.getMetadata(PATH_METADATA, controller) ?? ''].flat() as string[];
  const classGuarded = guardsOf(controller).some(isJwtAuthGuard);
  const routes: Route[] = [];
  for (const [name, handler] of handlersOf(controller)) {
    if (!classGuarded && !guardsOf(handler).some(isJwtAuthGuard)) continue;
    const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
    for (const prefix of prefixes) {
      for (const sub of [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat() as string[]) {
        routes.push({ route: `${method} ${join(prefix, sub)}`, at: `${controller.name}.${name}`, controller, method: name });
      }
    }
  }
  return routes;
}

// Nest records each decorated argument under `__routeArguments__`, keyed `paramtype:index`. The
// paramtype numbers are not public API, so they are read off a probe, as pat-route-coverage.spec does.
class Probe {
  probe(@Param('p') _p: string, @Query('q') _q: string, @Body() _b: unknown) {}
}
const [QUERY, BODY] = (() => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'probe') as Record<string, { index: number }>;
  const kindAt = (index: number) => Number(Object.entries(args).find(([, a]) => a.index === index)![0].split(':')[0]);
  return [kindAt(1), kindAt(2)];
})();

/** The fields a body DTO class decodes as ids (`@IsPublicId`), as `a.b` and `items[].id`. */
function idFieldsOf(dto: Function, prefix = '', seen = new Set<Function>()): string[] {
  if (seen.has(dto)) return [];
  seen.add(dto);
  return getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false).flatMap((m) => {
    if (m.name === 'isUuid') return [`${prefix}${m.propertyName}${m.each ? '[]' : ''}`];
    if (m.type !== 'nestedValidation') return [];
    let nested: unknown = Reflect.getMetadata('design:type', dto.prototype, m.propertyName);
    let list = '';
    if (nested === Array || nested === Object || nested === undefined) {
      nested = defaultMetadataStorage.findTypeMetadata(dto, m.propertyName)?.typeFunction?.();
      list = '[]';
    }
    return typeof nested === 'function' && nested !== Object && nested !== Array
      ? idFieldsOf(nested, `${prefix}${m.propertyName}${list}.`, seen)
      : [];
  });
}

/**
 * Every id a route's request carries outside its path, as Nest decodes one: a query param through
 * PublicIdPipe, a body field through `PublicIdPipe.forFields` or its DTO's `@IsPublicId` — `body
 * workspaceId`, `query projectId`, `body tasks[].listId`.
 */
function fieldsCarriedBy(r: Route): string[] {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, r.controller, r.method) ?? {}) as Record<
    string,
    { index: number; data?: unknown; pipes?: unknown[] }
  >;
  const types = (Reflect.getMetadata('design:paramtypes', r.controller.prototype as object, r.method) ?? []) as unknown[];
  const decoders = (pipes: unknown[] = []) => pipes.filter((p) => p === PublicIdPipe || p instanceof PublicIdPipe);
  const carried = new Set<string>();
  for (const [key, arg] of Object.entries(args)) {
    const kind = Number(key.split(':')[0]);
    if (kind === QUERY && typeof arg.data === 'string' && decoders(arg.pipes).length > 0) carried.add(`query ${arg.data}`);
    if (kind !== BODY) continue;
    for (const pipe of decoders(arg.pipes)) {
      for (const name of (pipe as { fields?: readonly string[] }).fields ?? []) carried.add(`body ${name}`);
    }
    const dto = types[arg.index];
    if (typeof dto === 'function' && dto !== Object) for (const name of idFieldsOf(dto)) carried.add(`body ${name}`);
  }
  return [...carried];
}

/** Every leaf of a request, at the place a field key names it: `params id`, `body tasks[].listId`. */
function leavesOf(request: TenantRequest): Array<[string, unknown]> {
  const walk = (value: unknown, at: string): Array<[string, unknown]> =>
    Array.isArray(value)
      ? value.flatMap((item) => walk(item, `${at}[]`))
      : value && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, child]) => walk(child, at.endsWith(' ') ? `${at}${key}` : `${at}.${key}`))
        : [[at, value]];
  return [...walk(request.params, 'params '), ...walk(request.query ?? {}, 'query '), ...walk(request.body ?? {}, 'body ')];
}

const census = (async () => {
  const controllers = await mountedControllers();
  const routes = [...controllers].flatMap(jwtRoutesOf);
  const fields = routes.flatMap((r) => fieldsCarriedBy(r).map((field) => ({ key: `${r.route} ${field}`, at: r.at })));
  return { controllers, routes, named: routes.filter((r) => paramsOf(r.route).length > 0), fields };
})();

/** A tenant whose every object is spelled by its own name, to read what a case puts where. */
const spelled = (prefix: string): Tenant =>
  new Proxy({} as Tenant, {
    get: (_, key) => (key === 'spare' ? spelled(`${prefix}spare.`) : key === 'runnerAccount' ? { engine: 'engine', account: 'account' } : `${prefix}${String(key)}`),
  });

test('the census reads every controller the production app mounts, and every one that uses JwtAuthGuard', async () => {
  const { controllers, routes, named } = await census;
  assert.ok(controllers.size > 50, `found ${controllers.size} controllers — the module walk broke, not the app`);
  assert.ok(routes.length > 250, `found ${routes.length} JwtAuthGuard routes — the metadata shape changed, not the routes`);
  assert.ok(named.length > 200, `found ${named.length} JwtAuthGuard routes naming something — the metadata shape changed, not the routes`);

  // A module edge the walk could not follow would take that controller's routes out of the census unseen.
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

test('every route behind JwtAuthGuard that names something by its path has a cross-account case or a reading by hand', async (t) => {
  const { named } = await census;
  const listed = (route: string) => route in TENANT_ISOLATION_CASES || route in TENANT_ISOLATION_BY_HAND;
  assert.deepEqual(
    named.filter((r) => !listed(r.route)).map((r) => `${r.route} (${r.at})`),
    [],
    'a route whose path names something is one a stranger can aim at another account: give it a case in '
      + 'TENANT_ISOLATION_CASES (src/apiserver/src/auth/tenant-isolation-cases.ts) — B on A\'s object, 404 or 403 and '
      + 'nothing written — or, when it cannot be stood up, a reading in TENANT_ISOLATION_BY_HAND',
  );
  t.diagnostic(
    `${named.length} JwtAuthGuard routes name something by path: ${Object.keys(TENANT_ISOLATION_CASES).length} sent `
      + `across accounts, ${Object.keys(TENANT_ISOLATION_BY_HAND).length} read by hand`,
  );
});

test('the census lists only routes the app mounts, each once, and a reading by hand says why and where', async () => {
  const { named } = await census;
  const mounted = new Set(named.map((r) => r.route));
  const listed = [...Object.keys(TENANT_ISOLATION_CASES), ...Object.keys(TENANT_ISOLATION_BY_HAND)];
  assert.deepEqual(listed.filter((route) => !mounted.has(route)), [], 'listed, but no JwtAuthGuard route naming something by path');
  assert.deepEqual(
    Object.keys(TENANT_ISOLATION_BY_HAND).filter((route) => route in TENANT_ISOLATION_CASES),
    [],
    'both sent and read by hand',
  );
  // A reading names the code that scopes the lookup, so whoever doubts it can go and look.
  assert.deepEqual(
    Object.entries(TENANT_ISOLATION_BY_HAND).filter(([, reading]) => !/\.ts:\d+/.test(reading)).map(([route]) => route),
    [],
    'a reading by hand cites the file and line that scopes the lookup to the caller',
  );
});

test("every case fills exactly its route's path parameters, and nests only ones it has", () => {
  const wrong: string[] = [];
  for (const [route, kase] of Object.entries(TENANT_ISOLATION_CASES)) {
    const params = paramsOf(route).sort();
    const filled = Object.keys(kase.request(spelled('a.'), spelled('b.')).params).sort();
    if (filled.join() !== params.join()) wrong.push(`${route}: fills ${filled.join(', ') || 'nothing'}`);
    for (const nested of kase.nested ?? []) if (!params.includes(nested)) wrong.push(`${route}: nests :${nested}, which it does not have`);
    if (kase.nested && params.length < 2) wrong.push(`${route}: nests a param in a path with no other`);
  }
  assert.deepEqual(wrong, []);
});

test('every id a route behind JwtAuthGuard carries in its body or query has a case naming another account\'s object there, or a reading by hand', async (t) => {
  const { fields } = await census;
  assert.ok(fields.length > 100, `found ${fields.length} ids carried in bodies and queries — the metadata shape changed, not the routes`);
  const listed = (key: string) => key in TENANT_ISOLATION_FIELD_CASES || key in TENANT_ISOLATION_FIELDS_BY_HAND;
  assert.deepEqual(
    fields.filter((f) => !listed(f.key)).map((f) => `${f.key} (${f.at})`),
    [],
    'an id a request carries is one a stranger can fill with another account\'s: give it a case in '
      + 'TENANT_ISOLATION_FIELD_CASES — B\'s own request with A\'s object in that field, answered as for an id that '
      + 'names nothing and writing nothing of A\'s — or, when it names nothing of anybody\'s, a reading in '
      + 'TENANT_ISOLATION_FIELDS_BY_HAND',
  );
  const carried = new Set(fields.map((f) => f.key));
  const extra = [...Object.keys(TENANT_ISOLATION_FIELD_CASES), ...Object.keys(TENANT_ISOLATION_FIELDS_BY_HAND)].filter((key) => !carried.has(key));
  assert.deepEqual(extra, [], 'listed, but no JwtAuthGuard route carries that id');
  assert.deepEqual(
    Object.keys(TENANT_ISOLATION_FIELDS_BY_HAND).filter((key) => key in TENANT_ISOLATION_FIELD_CASES),
    [],
    'both sent and read by hand',
  );
  assert.deepEqual(
    Object.entries(TENANT_ISOLATION_FIELDS_BY_HAND).filter(([, reading]) => !/\.ts:\d+/.test(reading)).map(([key]) => key),
    [],
    'a reading by hand cites the file and line that keeps the id to the caller',
  );
  t.diagnostic(
    `${fields.length} ids carried in bodies and queries: ${Object.keys(TENANT_ISOLATION_FIELD_CASES).length} sent with `
      + `another account's object in them, ${Object.keys(TENANT_ISOLATION_FIELDS_BY_HAND).length} read by hand`,
  );
});

test('every field case is B\'s own request with A\'s object in its field — and nowhere else it does not have to be', () => {
  const wrong: string[] = [];
  for (const [key, kase] of Object.entries(TENANT_ISOLATION_FIELD_CASES)) {
    const [method, route, where, field] = key.split(' ');
    const request = kase.request(spelled('a.'), spelled('b.'));
    const filled = Object.keys(request.params).sort().join();
    if (filled !== paramsOf(`${method} ${route}`).sort().join()) wrong.push(`${key}: fills ${filled || 'no'} path params`);
    // A list's items sit at `ids[]`; a field PublicIdPipe decodes knows no more than its name.
    const bare = (at: string) => at.replace(/\[\]$/, '');
    const allowed = new Set([field, ...(kase.alongside ?? [])].map((at) => bare(`${where} ${at}`)));
    const leaves = leavesOf(request);
    const isA = (value: unknown) => typeof value === 'string' && value.startsWith('a.');
    if (!leaves.some(([at, value]) => bare(at) === bare(`${where} ${field}`) && isA(value))) wrong.push(`${key}: A's object is not in ${where} ${field}`);
    for (const [at, value] of leaves) if (isA(value) && !allowed.has(bare(at))) wrong.push(`${key}: A's ${String(value).slice(2)} is in ${at} too`);
  }
  assert.deepEqual(wrong, []);
});
