import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Body, Headers, Param, Query, Req, RequestMethod, UploadedFile, type DynamicModule } from '@nestjs/common';
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
import { ID_HEADERS } from '../common/public-id-headers';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerSessionAuthGuard } from '../runner-api/runner-session-auth.guard';
import { PublicSurfaceGuard } from '../shared/public-surface.guard';
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
import {
  PUBLIC_ROUTES,
  RUNNER_ISOLATION_BY_HAND,
  RUNNER_ISOLATION_CASES,
  RUNNER_ISOLATION_FIELDS_BY_HAND,
  RUNNER_ISOLATION_FIELD_CASES,
  RUNNER_OPAQUE_BODIES,
  SHARED_BY_HAND,
  SHARED_ISOLATION_CASES,
  type RunnerTenant,
} from './tenant-isolation-runner-cases';

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
// Its second half (§11 T2, tenant-isolation-runner-cases.ts) is held the same way: the routes behind
// the runner gate — RunnerAuthGuard, RunnerSessionAuthGuard — and every route behind no account
// guard at all, the share links' doors among them. Past the gate the ids a request carries are read
// wherever they are: decoded or not (the machine protocol sends raw UUIDs that nothing decodes), in
// the query, the session-context headers or the body, and in a body declared only by a TypeScript
// type, from its declaration in the source — see `bodyTypeOf`, further down.
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
const isRunnerGuard = (guard: unknown) =>
  [RunnerAuthGuard, RunnerSessionAuthGuard].some((g) => guard === g || guard instanceof g);
const isSharedGuard = (guard: unknown) => guard === PublicSurfaceGuard || guard instanceof PublicSurfaceGuard;
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

/**
 * Which door a route is behind: a person's sign-in (JwtAuthGuard — the first half), a runner's
 * credential (RunnerAuthGuard, RunnerSessionAuthGuard), or none at all.
 */
type Door = 'jwt' | 'runner' | 'public';

interface Route {
  /** `GET /tasks/:id` */
  route: string;
  at: string;
  controller: Controller;
  method: string;
  door: Door;
  /** Behind PublicSurfaceGuard: one of the share links' doors. */
  shared: boolean;
}

/** Every route a controller answers: one per method and path a handler answers, with its door. */
function routesOf(controller: Controller): Route[] {
  const prefixes = [Reflect.getMetadata(PATH_METADATA, controller) ?? ''].flat() as string[];
  const routes: Route[] = [];
  for (const [name, handler] of handlersOf(controller)) {
    const guards = [...guardsOf(controller), ...guardsOf(handler)];
    const door: Door = guards.some(isJwtAuthGuard) ? 'jwt' : guards.some(isRunnerGuard) ? 'runner' : 'public';
    const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
    for (const prefix of prefixes) {
      for (const sub of [Reflect.getMetadata(PATH_METADATA, handler) ?? ''].flat() as string[]) {
        routes.push({
          route: `${method} ${join(prefix, sub)}`,
          at: `${controller.name}.${name}`,
          controller,
          method: name,
          door,
          shared: guards.some(isSharedGuard),
        });
      }
    }
  }
  return routes;
}

// Nest records each decorated argument under `__routeArguments__`, keyed `paramtype:index`. The
// paramtype numbers are not public API, so they are read off a probe, as pat-route-coverage.spec does.
class Probe {
  probe(
    @Param('p') _p: string,
    @Query('q') _q: string,
    @Body() _b: unknown,
    @Headers('h') _h: string,
    @Req() _r: unknown,
    @UploadedFile() _f: unknown,
  ) {}
}
const [QUERY, BODY, HEADERS, REQUEST, FILE] = (() => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'probe') as Record<string, { index: number }>;
  const kindAt = (index: number) => Number(Object.entries(args).find(([, a]) => a.index === index)![0].split(':')[0]);
  return [kindAt(1), kindAt(2), kindAt(3), kindAt(4), kindAt(5)];
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

type RouteArgs = Record<string, { index: number; data?: unknown; pipes?: unknown[] }>;
const argsOf = (r: Route) => (Reflect.getMetadata(ROUTE_ARGS_METADATA, r.controller, r.method) ?? {}) as RouteArgs;
const paramTypesOf = (r: Route) =>
  (Reflect.getMetadata('design:paramtypes', r.controller.prototype as object, r.method) ?? []) as unknown[];
const decoders = (pipes: unknown[] = []) => pipes.filter((p) => p === PublicIdPipe || p instanceof PublicIdPipe);

/**
 * Every id a route's request carries outside its path, as Nest decodes one: a query param through
 * PublicIdPipe, a body field through `PublicIdPipe.forFields` or its DTO's `@IsPublicId` — `body
 * workspaceId`, `query projectId`, `body tasks[].listId`.
 */
function fieldsCarriedBy(r: Route): string[] {
  const args = argsOf(r);
  const types = paramTypesOf(r);
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
  return [
    ...walk(request.params, 'params '),
    ...walk(request.query ?? {}, 'query '),
    ...walk(request.headers ?? {}, 'header '),
    ...walk(request.body ?? {}, 'body '),
  ];
}

const census = (async () => {
  const controllers = await mountedControllers();
  const all = [...controllers].flatMap(routesOf);
  const routes = all.filter((r) => r.door === 'jwt');
  const fields = routes.flatMap((r) => fieldsCarriedBy(r).map((field) => ({ key: `${r.route} ${field}`, at: r.at })));
  return { controllers, all, routes, named: routes.filter((r) => paramsOf(r.route).length > 0), fields };
})();

/** The second half's: the runner gate's routes and what their requests carry, and the routes nothing guards. */
const gateCensus = (async () => {
  const { controllers, all } = await census;
  const gate = all.filter((r) => r.door === 'runner');
  const carried = gate.flatMap((r) => {
    const { fields, opaque } = idsCarriedAtTheGate(r);
    return [
      ...fields.map((field) => ({ key: `${r.route} ${field}`, at: r.at, opaque: false })),
      ...opaque.map((where) => ({ key: `${r.route} ${where}`, at: r.at, opaque: true })),
    ];
  });
  return {
    controllers,
    gate,
    gateNamed: gate.filter((r) => paramsOf(r.route).length > 0),
    gateFields: carried.filter((f) => !f.opaque),
    gateOpaque: carried.filter((f) => f.opaque),
    unguarded: all.filter((r) => r.door === 'public'),
  };
})();
// A reader that throws fails the second half's tests, each with the reason, and leaves the first half's alone.
gateCensus.catch(() => undefined);

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

// ── The runner gate and the doors nothing guards (§11 T2) ────────────────────────────────────────

/** A field's name says it holds an id: `id`, `ids`, `sessionId`, `supervisedSessionIds`. */
const ID_NAME = /^(?:id|ids)$|[a-z\d](?:Id|Ids)$/;
const ID_HEADER = new Set<string>(ID_HEADERS);

/** The fields a DTO class holds that are ids by decoder or by name, as `a.b` and `items[].id`. */
function namedIdFieldsOf(dto: Function, prefix = '', seen = new Set<Function>()): string[] {
  if (seen.has(dto)) return [];
  seen.add(dto);
  const metas = getMetadataStorage().getTargetValidationMetadatas(dto, '', true, false);
  const listed = (property: string) => metas.some((m) => m.propertyName === property && (m.each || m.name === 'isArray'));
  return metas.flatMap((m) => {
    if (m.type === 'nestedValidation') {
      let nested: unknown = Reflect.getMetadata('design:type', dto.prototype, m.propertyName);
      let list = '';
      if (nested === Array || nested === Object || nested === undefined) {
        nested = defaultMetadataStorage.findTypeMetadata(dto, m.propertyName)?.typeFunction?.();
        list = '[]';
      }
      return typeof nested === 'function' && nested !== Object && nested !== Array
        ? namedIdFieldsOf(nested, `${prefix}${m.propertyName}${list}.`, seen)
        : [];
    }
    return m.name === 'isUuid' || ID_NAME.test(m.propertyName) ? [`${prefix}${m.propertyName}${listed(m.propertyName) ? '[]' : ''}`] : [];
  });
}

/**
 * Every id a runner-gate route's request carries outside its path — `query jobId`, `header
 * x-orbit-session-id`, `body sessions[].sessionId` — and every part of it the census cannot read
 * (`body events[].payload`), which RUNNER_OPAQUE_BODIES then has to account for by hand.
 */
function idsCarriedAtTheGate(r: Route): { fields: string[]; opaque: string[] } {
  const args = argsOf(r);
  const types = paramTypesOf(r);
  const fields = new Set<string>();
  const opaque = new Set<string>();
  const fromClass = (dto: unknown, where: string) => {
    if (typeof dto === 'function' && dto !== Object && dto !== String && dto !== Array) {
      for (const name of namedIdFieldsOf(dto)) fields.add(`${where} ${name}`);
      return true;
    }
    return false;
  };
  for (const [key, arg] of Object.entries(args)) {
    const kind = Number(key.split(':')[0]);
    const named = typeof arg.data === 'string' ? arg.data : undefined;
    if (kind === HEADERS && named && ID_HEADER.has(named.toLowerCase())) fields.add(`header ${named.toLowerCase()}`);
    if (kind === REQUEST) opaque.add('request');
    if (kind !== QUERY && kind !== BODY) continue;
    const where = kind === QUERY ? 'query' : 'body';
    if (named) {
      if (decoders(arg.pipes).length > 0 || ID_NAME.test(named)) fields.add(`${where} ${named}`);
      continue;
    }
    for (const pipe of decoders(arg.pipes)) {
      for (const name of (pipe as { fields?: readonly string[] }).fields ?? []) fields.add(`${where} ${name}`);
    }
    if (fromClass(types[arg.index], where)) continue;
    // Declared by an interface, an inline type or a type alias: nothing of it is left at run time.
    const read = bodyTypeOf(r, arg.index);
    for (const field of read.fields) fields.add(`${where} ${field}`);
    for (const part of read.opaque) opaque.add(`${where} ${part}`);
  }
  return { fields: [...fields], opaque: [...opaque] };
}

// ── Reading a type from the source ───────────────────────────────────────────────────────────────
//
// The runner protocol's bodies are TypeScript interfaces (src/shared/src/dto.ts), and several doors
// declare theirs inline: none of it exists at run time. So the census reads the handler's `@Body()`
// parameter from its controller's source, and every type that names, from its declaration in the
// apiserver's or @orbit/shared's sources, all the way down. A type it cannot find or cannot read is
// red, not skipped: a field nobody listed is exactly what the census is for.

const SOURCE_ROOTS = [path.resolve(__dirname, '../../src'), path.resolve(__dirname, '../../../shared/src')];

const sourceFiles: string[] = (() => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.ts$/.test(entry.name) && !/\.(spec|d)\.ts$/.test(entry.name)) files.push(full);
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  return files;
})();
const sourceTexts = new Map<string, string>();
const textOf = (file: string) => {
  if (!sourceTexts.has(file)) sourceTexts.set(file, readFileSync(file, 'utf8'));
  return sourceTexts.get(file)!;
};

/** TypeScript as tokens: words, strings, numbers, single punctuation, and `=>` / `...` whole. Comments go. */
function tokensOf(text: string): string[] {
  const out: string[] = [];
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d[\w.]*|=>|\.\.\.|\S/gy;
  for (let m = re.exec(text); m && m[0] !== ''; m = re.exec(text)) {
    if (!/^(?:\s|\/\/|\/\*)/.test(m[0])) out.push(m[0]);
  }
  return out;
}

/** The index of the bracket that closes the one at `open`, counting only `pairs`. */
function closer(toks: readonly string[], open: number, pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' }): number {
  const want: string[] = [];
  for (let i = open; i < toks.length; i++) {
    if (Object.hasOwn(pairs, toks[i])) want.push(pairs[toks[i]]);
    else if (toks[i] === want[want.length - 1]) {
      want.pop();
      if (want.length === 0) return i;
    }
  }
  throw new Error(`no ${pairs[toks[open]]} closes the ${toks[open]} at token ${open}`);
}

type TypeNode =
  | { kind: 'object'; members: Array<{ name: string; type: TypeNode }> }
  | { kind: 'name'; name: string; args: TypeNode[] }
  | { kind: 'array'; of: TypeNode }
  /** A union, an intersection, an interface with what it extends: each part reaches what it reaches. */
  | { kind: 'parts'; of: TypeNode[] }
  | { kind: 'leaf'; text: string };

const KEYWORDS = new Set(['string', 'number', 'boolean', 'null', 'undefined', 'unknown', 'any', 'never', 'object', 'void', 'bigint', 'symbol', 'true', 'false']);

/** Reads type expressions off tokens, from `at`; refuses what it does not know rather than guess. */
class TypeReader {
  constructor(private readonly toks: readonly string[], public at: number, private readonly where: string) {}

  private peek(ahead = 0) {
    return this.toks[this.at + ahead];
  }

  private take(expected?: string) {
    const token = this.toks[this.at++];
    if (expected !== undefined && token !== expected) throw new Error(`${this.where}: read ${token ?? 'the end'} where ${expected} belongs`);
    return token;
  }

  type(): TypeNode {
    if (this.peek() === '|' || this.peek() === '&') this.take();
    const parts = [this.postfix()];
    while (this.peek() === '|' || this.peek() === '&') {
      this.take();
      parts.push(this.postfix());
    }
    return parts.length === 1 ? parts[0] : { kind: 'parts', of: parts };
  }

  private postfix(): TypeNode {
    let node = this.primary();
    while (this.peek() === '[' && this.peek(1) === ']') {
      this.take();
      this.take();
      node = { kind: 'array', of: node };
    }
    return node;
  }

  private primary(): TypeNode {
    const token = this.take();
    if (token === undefined) throw new Error(`${this.where}: the type ends early`);
    if (token === '{') return { kind: 'object', members: this.members('}') };
    if (token === '(') {
      const inner = this.type();
      this.take(')');
      if (this.peek() === '=>') throw new Error(`${this.where}: a function type`);
      return inner;
    }
    if (token === '[') {
      const of: TypeNode[] = [];
      while (this.peek() !== ']') {
        of.push(this.type());
        if (this.peek() === ',') this.take();
      }
      this.take(']');
      return { kind: 'array', of: { kind: 'parts', of } };
    }
    if (token === '-') return { kind: 'leaf', text: `-${this.take()}` };
    if (token === 'typeof' || token === 'keyof') {
      this.postfix();
      return { kind: 'leaf', text: token };
    }
    if (token === 'readonly') return this.postfix();
    if (token === 'import') {
      this.take('(');
      this.take();
      this.take(')');
      this.take('.');
      return this.named(this.take());
    }
    if (/^['"`\d]/.test(token) || KEYWORDS.has(token)) return { kind: 'leaf', text: token };
    if (/^[A-Za-z_$]/.test(token)) {
      let name = token;
      while (this.peek() === '.') {
        this.take();
        name += `.${this.take()}`;
      }
      return this.named(name);
    }
    throw new Error(`${this.where}: cannot read a type at ${token}`);
  }

  private named(name: string): TypeNode {
    const args: TypeNode[] = [];
    if (this.peek() === '<') {
      this.take();
      for (;;) {
        args.push(this.type());
        if (this.peek() !== ',') break;
        this.take();
      }
      this.take('>');
    }
    return { kind: 'name', name, args };
  }

  /** An object type's members, up to `close`: `name?: type`, `[key: string]: type`, `readonly` ones. */
  members(close: string): Array<{ name: string; type: TypeNode }> {
    const members: Array<{ name: string; type: TypeNode }> = [];
    while (this.peek() !== close) {
      if (this.peek() === undefined) throw new Error(`${this.where}: an object type is never closed`);
      if (this.peek() === 'readonly' && this.peek(1) !== ':' && this.peek(1) !== '?') this.take();
      let name: string;
      if (this.peek() === '[') {
        this.take();
        this.take();
        this.take(':');
        this.type();
        this.take(']');
        name = '*';
      } else {
        name = this.take().replace(/^['"]|['"]$/g, '');
      }
      if (this.peek() === '?') this.take();
      if (this.peek() === '(' || this.peek() === '<') throw new Error(`${this.where}: a method, ${name}, in a request body's type`);
      this.take(':');
      members.push({ name, type: this.type() });
      if (this.peek() === ';' || this.peek() === ',') this.take();
    }
    this.take(close);
    return members;
  }
}

interface Declaration {
  where: string;
  kind: 'interface' | 'type' | 'enum' | 'class';
  params: string[];
  node?: TypeNode;
}

const declarationCache = new Map<string, Declaration[]>();

/** Every declaration of `name` in the apiserver's and @orbit/shared's sources. */
function declarationsOf(name: string): Declaration[] {
  if (declarationCache.has(name)) return declarationCache.get(name)!;
  const found: Declaration[] = [];
  // A declaration, not an import's `type X,`: what follows the name opens one.
  const pattern = new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?(?:declare[ \\t]+)?(?:abstract[ \\t]+)?(interface|type|enum|class)[ \\t]+${name.replace(/\$/g, '\\$')}\\b(?=\\s*(?:<|=|\\{|extends\\b|implements\\b))`,
    'gm',
  );
  for (const file of sourceFiles) {
    const text = textOf(file);
    if (!text.includes(name)) continue;
    for (const match of text.matchAll(pattern)) {
      const kind = match[1] as Declaration['kind'];
      const line = text.slice(0, match.index).split('\n').length;
      const where = `${path.relative(path.resolve(__dirname, '../../..'), file)}:${line}`;
      if (kind === 'enum' || kind === 'class') {
        found.push({ where, kind, params: [] });
        continue;
      }
      const toks = tokensOf(text.slice(match.index! + match[0].length - name.length));
      let at = 1;
      const params: string[] = [];
      if (toks[at] === '<') {
        const end = closer(toks, at, { '<': '>' });
        for (let i = at + 1; i < end; i++) if (i === at + 1 || toks[i - 1] === ',') params.push(toks[i]);
        at = end + 1;
      }
      const reader = new TypeReader(toks, at, where);
      if (kind === 'type') {
        reader.at = at + 1;
        if (toks[at] !== '=') throw new Error(`${where}: type ${name} without =`);
        found.push({ where, kind, params, node: reader.type() });
        continue;
      }
      const parts: TypeNode[] = [];
      if (toks[reader.at] === 'extends') {
        reader.at++;
        for (;;) {
          parts.push(reader.type());
          if (toks[reader.at] !== ',') break;
          reader.at++;
        }
      }
      if (toks[reader.at] !== '{') throw new Error(`${where}: interface ${name} has no body`);
      reader.at++;
      parts.unshift({ kind: 'object', members: reader.members('}') });
      found.push({ where, kind, params, node: { kind: 'parts', of: parts } });
    }
  }
  declarationCache.set(name, found);
  return found;
}

const SCALAR_NAMES = new Set(['Date', 'Buffer', 'Uint8Array', 'RegExp', 'String', 'Number', 'Boolean']);
const WRAPPERS = new Set(['Partial', 'Required', 'Readonly', 'NonNullable', 'Pick', 'Omit', 'Exclude', 'Extract', 'Promise']);
const OPAQUE = new Set(['unknown', 'any', 'object', 'Object']);

/** What a type holds, as far as ids go: the id fields under it, and the parts of it that say nothing. */
class TypeReach {
  readonly fields = new Set<string>();
  readonly opaque = new Set<string>();
  private readonly resolving: string[] = [];

  constructor(private readonly where: string) {}

  /** Whether `node` can hold an object — a field that cannot, and is named like one, is an id. */
  private holdsObjects(node: TypeNode, bound: Map<string, TypeNode>): boolean {
    switch (node.kind) {
      case 'object':
        return true;
      case 'array':
        return this.holdsObjects(node.of, bound);
      case 'parts':
        return node.of.some((part) => this.holdsObjects(part, bound));
      case 'leaf':
        return OPAQUE.has(node.text);
      case 'name': {
        if (bound.has(node.name)) return this.holdsObjects(bound.get(node.name)!, bound);
        if (node.name === 'Array' || node.name === 'ReadonlyArray' || WRAPPERS.has(node.name)) return node.args.some((a) => this.holdsObjects(a, bound));
        if (node.name === 'Record' || node.name.startsWith('Prisma.') || OPAQUE.has(node.name)) return true;
        if (SCALAR_NAMES.has(node.name)) return false;
        if (this.resolving.includes(node.name)) return true;
        this.resolving.push(node.name);
        try {
          return this.declared(node.name).some((d) => d.kind !== 'enum' && this.holdsObjects(d.node!, this.bind(d, node.args)));
        } finally {
          this.resolving.pop();
        }
      }
    }
  }

  private declared(name: string): Declaration[] {
    const found = declarationsOf(name);
    if (found.length === 0) throw new Error(`${this.where}: the census cannot find the type ${name} in the apiserver's or @orbit/shared's sources`);
    const classes = found.filter((d) => d.kind === 'class');
    if (classes.length > 0) throw new Error(`${this.where}: a body type names the class ${name} (${classes[0].where}); give the body a DTO class, whose validators the census reads, or a type`);
    return found;
  }

  private bind(declaration: Declaration, args: TypeNode[]): Map<string, TypeNode> {
    return new Map(declaration.params.map((param, i) => [param, args[i] ?? { kind: 'leaf', text: 'unknown' }]));
  }

  /** Every id field under `node`, keyed from `at` (`sessions[].`), and every part that says nothing. */
  reach(node: TypeNode, at: string, bound: Map<string, TypeNode> = new Map()): void {
    switch (node.kind) {
      case 'leaf':
        if (OPAQUE.has(node.text)) this.opaque.add(at.replace(/\.$/, '') || '(the body)');
        return;
      case 'array':
        return this.reach(node.of, at.endsWith('.') ? `${at.slice(0, -1)}[].` : `${at}[].`, bound);
      case 'parts':
        for (const part of node.of) this.reach(part, at, bound);
        return;
      case 'object':
        for (const member of node.members) {
          let type = member.type;
          let list = '';
          for (;;) {
            if (type.kind === 'array') {
              list += '[]';
              type = type.of;
            } else if (type.kind === 'name' && (type.name === 'Array' || type.name === 'ReadonlyArray') && type.args[0]) {
              list += '[]';
              type = type.args[0];
            } else break;
          }
          const key = `${at}${member.name}${list}`;
          if (ID_NAME.test(member.name) && !this.holdsObjects(type, bound)) this.fields.add(key);
          else this.reach(type, `${key}.`, bound);
        }
        return;
      case 'name': {
        if (bound.has(node.name)) return this.reach(bound.get(node.name)!, at, bound);
        if (node.name === 'Array' || node.name === 'ReadonlyArray') return this.reach({ kind: 'array', of: node.args[0] }, at, bound);
        if (node.name === 'Record') return this.reach({ kind: 'object', members: [{ name: '*', type: node.args[1] }] }, at, bound);
        if (WRAPPERS.has(node.name)) return this.reach(node.args[0], at, bound);
        if (SCALAR_NAMES.has(node.name)) return;
        if (OPAQUE.has(node.name) || node.name.startsWith('Prisma.')) {
          this.opaque.add(at.replace(/\.$/, '') || '(the body)');
          return;
        }
        if (this.resolving.includes(node.name)) return;
        this.resolving.push(node.name);
        try {
          for (const declaration of this.declared(node.name)) {
            if (declaration.kind !== 'enum') this.reach(declaration.node!, at, this.bind(declaration, node.args));
          }
        } finally {
          this.resolving.pop();
        }
      }
    }
  }
}

/** Where a controller class is declared, among the apiserver's sources. */
function sourceOf(controller: Controller): string {
  const pattern = new RegExp(`\\bclass[ \\t]+${controller.name}\\b`);
  const files = sourceFiles.filter((file) => file.endsWith('.controller.ts') && pattern.test(textOf(file)));
  if (files.length !== 1) throw new Error(`${controller.name} is declared in ${files.length} controller sources`);
  return files[0];
}

/** The id fields of the type a handler's argument at `index` is declared with, read from the source. */
function bodyTypeOf(r: Route, index: number): { fields: string[]; opaque: string[] } {
  const file = sourceOf(r.controller);
  const toks = tokensOf(textOf(file));
  const where = `${path.basename(file)} ${r.at}`;
  const classAt = toks.findIndex((token, i) => token === 'class' && toks[i + 1] === r.controller.name);
  const open = toks.indexOf('{', classAt);
  const end = closer(toks, open);
  let paramsAt = -1;
  for (let i = open + 1, depth = 0; i < end && paramsAt < 0; i++) {
    if (depth === 0 && toks[i] === r.method && toks[i + 1] === '(' && toks[i - 1] !== '.' && toks[i - 1] !== '=') paramsAt = i + 1;
    else if (toks[i] === '(' || toks[i] === '[' || toks[i] === '{') depth++;
    else if (toks[i] === ')' || toks[i] === ']' || toks[i] === '}') depth--;
  }
  if (paramsAt < 0) throw new Error(`${where}: the handler is not in its controller's source`);
  const paramsEnd = closer(toks, paramsAt);
  // Split the parameters at the commas outside any bracket, generics' included.
  const params: Array<[number, number]> = [];
  for (let i = paramsAt + 1, from = i, depth = 0; i <= paramsEnd; i++) {
    const token = toks[i];
    if (i === paramsEnd || (depth === 0 && token === ',')) {
      if (i > from) params.push([from, i]);
      from = i + 1;
    } else if (token === '(' || token === '[' || token === '{' || token === '<') depth++;
    else if (token === ')' || token === ']' || token === '}' || token === '>') depth--;
  }
  const [from, to] = params[index] ?? [];
  if (from === undefined) throw new Error(`${where}: no parameter ${index}`);
  let i = from;
  while (toks[i] === '@') {
    i += 2;
    while (toks[i] === '.') i += 2;
    if (toks[i] === '(') i = closer(toks, i) + 1;
  }
  i++;
  if (toks[i] === '?') i++;
  if (toks[i] !== ':') throw new Error(`${where}: parameter ${index} declares no type`);
  const reader = new TypeReader(toks.slice(0, to), i + 1, where);
  const node = reader.type();
  if (reader.at < to && toks[reader.at] !== '=') throw new Error(`${where}: could not read parameter ${index}'s type to its end`);
  const reach = new TypeReach(where);
  reach.reach(node, '');
  return { fields: [...reach.fields], opaque: [...reach.opaque] };
}

/** A runner tenant whose every object is spelled by its own name, nested ones included. */
const spelledRunner = (prefix: string): RunnerTenant =>
  new Proxy({} as RunnerTenant, {
    get: (_, key) =>
      key === 'spare' || key === 'runner'
        ? spelledRunner(`${prefix}${String(key)}.`)
        : key === 'runnerAccount'
          ? { engine: 'engine', account: 'account' }
          : `${prefix}${String(key)}`,
  });

test('the runner gate: the census reads every route behind RunnerAuthGuard or RunnerSessionAuthGuard, and every controller that has one is mounted', async () => {
  const { controllers, gate, gateNamed, gateFields, unguarded } = await gateCensus;
  assert.ok(gate.length > 140, `found ${gate.length} runner-gate routes — the metadata shape changed, not the routes`);
  assert.ok(gateNamed.length > 100, `found ${gateNamed.length} runner-gate routes naming something — the metadata shape changed, not the routes`);
  assert.ok(gateFields.length > 100, `found ${gateFields.length} ids carried past the runner gate — the metadata shape changed, not the routes`);
  assert.ok(unguarded.some((r) => r.shared), 'found none of the share links\' doors — the guard metadata changed, not the routes');
  const unreached: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.controller.js')) {
        for (const value of Object.values(require(full) as Record<string, unknown>)) {
          if (typeof value !== 'function' || !Reflect.getMetadata(CONTROLLER_WATERMARK, value)) continue;
          if (!controllers.has(value as Controller)) unreached.push(`${path.relative(dir, full)}: ${value.name}`);
        }
      }
    }
  };
  walk(path.resolve(__dirname, '..'));
  assert.deepEqual(unreached, [], 'a controller the module walk did not reach takes its routes out of the census unseen');
});

test('every runner-gate route that names something by its path has a cross-account case or a reading by hand', async (t) => {
  const { gateNamed } = await gateCensus;
  const listed = (route: string) => route in RUNNER_ISOLATION_CASES || route in RUNNER_ISOLATION_BY_HAND;
  assert.deepEqual(
    gateNamed.filter((r) => !listed(r.route)).map((r) => `${r.route} (${r.at})`),
    [],
    'a runner-gate route whose path names something is one a stranger\'s own machine can aim at another account: '
      + 'give it a case in RUNNER_ISOLATION_CASES (src/apiserver/src/auth/tenant-isolation-runner-cases.ts) — B\'s '
      + 'credential on A\'s object, answered as for an id that names nothing and writing nothing of A\'s — or, when '
      + 'it cannot be stood up, a reading in RUNNER_ISOLATION_BY_HAND',
  );
  t.diagnostic(
    `${gateNamed.length} runner-gate routes name something by path: ${Object.keys(RUNNER_ISOLATION_CASES).length} sent `
      + `across accounts, ${Object.keys(RUNNER_ISOLATION_BY_HAND).length} read by hand`,
  );
});

test('the runner census lists only runner-gate routes the app mounts, each once, and a reading by hand says why and where', async () => {
  const { gateNamed } = await gateCensus;
  const mounted = new Set(gateNamed.map((r) => r.route));
  const listed = [...Object.keys(RUNNER_ISOLATION_CASES), ...Object.keys(RUNNER_ISOLATION_BY_HAND)];
  assert.deepEqual(listed.filter((route) => !mounted.has(route)), [], 'listed, but no runner-gate route naming something by path');
  assert.deepEqual(Object.keys(RUNNER_ISOLATION_BY_HAND).filter((route) => route in RUNNER_ISOLATION_CASES), [], 'both sent and read by hand');
  assert.deepEqual(
    Object.entries(RUNNER_ISOLATION_BY_HAND).filter(([, reading]) => !/\.ts:\d+/.test(reading)).map(([route]) => route),
    [],
    'a reading by hand cites the file and line that scopes the lookup to the caller',
  );
});

test("every runner case fills exactly its route's path parameters, nests only ones it has, and is sent with some credential", () => {
  const wrong: string[] = [];
  for (const [route, kase] of Object.entries(RUNNER_ISOLATION_CASES)) {
    const params = paramsOf(route).sort();
    const filled = Object.keys(kase.request(spelledRunner('a.'), spelledRunner('b.')).params).sort();
    if (filled.join() !== params.join()) wrong.push(`${route}: fills ${filled.join(', ') || 'nothing'}`);
    for (const nested of kase.nested ?? []) if (!params.includes(nested)) wrong.push(`${route}: nests :${nested}, which it does not have`);
    if (kase.nested && params.length < 2) wrong.push(`${route}: nests a param in a path with no other`);
    if (kase.as.length === 0) wrong.push(`${route}: sent with no credential`);
  }
  assert.deepEqual(wrong, []);
});

test('every id a runner-gate request carries — in its query, its headers or its body, decoded or not — has a case or a reading by hand', async (t) => {
  const { gateFields } = await gateCensus;
  const listed = (key: string) => key in RUNNER_ISOLATION_FIELD_CASES || key in RUNNER_ISOLATION_FIELDS_BY_HAND;
  const declared = new Set(Object.entries(RUNNER_OPAQUE_BODIES).flatMap(([at, body]) => body.reads.map((field) => `${at.split(' ').slice(0, 2).join(' ')} ${field}`)));
  const carried = [...gateFields.map((f) => f.key), ...declared];
  assert.deepEqual(
    [...new Set(carried)].filter((key) => !listed(key)).map((key) => `${key} (${gateFields.find((f) => f.key === key)?.at ?? 'RUNNER_OPAQUE_BODIES'})`),
    [],
    'an id a runner-gate request carries is one a stranger\'s own machine can fill with another account\'s: give it a '
      + 'case in RUNNER_ISOLATION_FIELD_CASES — B\'s own request with A\'s object in that field, answered as for an id '
      + 'that names nothing and writing nothing of A\'s — or, when it names nothing of anybody\'s, a reading in '
      + 'RUNNER_ISOLATION_FIELDS_BY_HAND',
  );
  const known = new Set(carried);
  const extra = [...Object.keys(RUNNER_ISOLATION_FIELD_CASES), ...Object.keys(RUNNER_ISOLATION_FIELDS_BY_HAND)].filter((key) => !known.has(key));
  assert.deepEqual(extra, [], 'listed, but no runner-gate route carries that id');
  assert.deepEqual(
    Object.keys(RUNNER_ISOLATION_FIELDS_BY_HAND).filter((key) => key in RUNNER_ISOLATION_FIELD_CASES),
    [],
    'both sent and read by hand',
  );
  assert.deepEqual(
    Object.entries(RUNNER_ISOLATION_FIELDS_BY_HAND).filter(([, reading]) => !/\.ts:\d+/.test(reading)).map(([key]) => key),
    [],
    'a reading by hand cites the file and line that keeps the id to the caller',
  );
  t.diagnostic(
    `${known.size} ids carried past the runner gate: ${Object.keys(RUNNER_ISOLATION_FIELD_CASES).length} sent with another `
      + `account's object in them, ${Object.keys(RUNNER_ISOLATION_FIELDS_BY_HAND).length} read by hand`,
  );
});

test('a runner-gate body the census cannot read says by hand which ids it reads, and where', async () => {
  const { gateOpaque } = await gateCensus;
  assert.deepEqual(
    gateOpaque.filter((f) => !(f.key in RUNNER_OPAQUE_BODIES)).map((f) => `${f.key} (${f.at})`),
    [],
    'part of a request whose type says nothing of what is in it: list it in RUNNER_OPAQUE_BODIES with every id the '
      + 'code reads there and where it reads them',
  );
  const opaque = new Set(gateOpaque.map((f) => f.key));
  assert.deepEqual(Object.keys(RUNNER_OPAQUE_BODIES).filter((key) => !opaque.has(key)), [], 'listed as unreadable, but the census reads it');
  assert.deepEqual(
    Object.entries(RUNNER_OPAQUE_BODIES).filter(([, body]) => !/\.ts:\d+/.test(body.reading)).map(([key]) => key),
    [],
    'a body read by hand cites the file and line that reads it',
  );
});

test('every runner field case is B\'s own request with A\'s object in its field — and nowhere else it does not have to be', () => {
  const wrong: string[] = [];
  for (const [key, kase] of Object.entries(RUNNER_ISOLATION_FIELD_CASES)) {
    const [method, route, where, field] = key.split(' ');
    const request = kase.request(spelledRunner('a.'), spelledRunner('b.'));
    const filled = Object.keys(request.params).sort().join();
    if (filled !== paramsOf(`${method} ${route}`).sort().join()) wrong.push(`${key}: fills ${filled || 'no'} path params`);
    if (kase.as.length === 0) wrong.push(`${key}: sent with no credential`);
    const bare = (at: string) => at.replace(/\[\]$/, '');
    const allowed = new Set([field, ...(kase.alongside ?? [])].map((at) => bare(`${where} ${at}`)));
    const leaves = leavesOf(request);
    // An id of A's on its own, or spelled inside a key the way the platform spells one (`open-item:v1:<id>:1`).
    const isA = (value: unknown) => typeof value === 'string' && /(?:^|[^\w.])a\.\w/.test(value);
    if (!leaves.some(([at, value]) => bare(at) === bare(`${where} ${field}`) && isA(value))) wrong.push(`${key}: A's object is not in ${where} ${field}`);
    for (const [at, value] of leaves) if (isA(value) && !allowed.has(bare(at))) wrong.push(`${key}: A's ${String(value)} is in ${at} too`);
    if (kase.heldRow && !isA(kase.heldRow(spelledRunner('a.'))[1])) wrong.push(`${key}: holds no row of A's`);
  }
  assert.deepEqual(wrong, []);
});

test('every route behind no account guard is one of the share links\' doors, with its cases, or is listed with why it reaches no account\'s object', async (t) => {
  const { unguarded } = await gateCensus;
  const shared = unguarded.filter((r) => r.shared);
  const other = unguarded.filter((r) => !r.shared);
  assert.deepEqual(
    shared.filter((r) => !(r.route in SHARED_ISOLATION_CASES || r.route in SHARED_BY_HAND)).map((r) => `${r.route} (${r.at})`),
    [],
    'a share link\'s door: give it a case in SHARED_ISOLATION_CASES — another link\'s token with A\'s object in it, '
      + 'answered as for an id that names nothing — or, when it names nothing but its link, a reading in SHARED_BY_HAND',
  );
  assert.deepEqual(
    other.filter((r) => !(r.route in PUBLIC_ROUTES)).map((r) => `${r.route} (${r.at})`),
    [],
    'a route behind no guard at all: list it in PUBLIC_ROUTES with why it reaches no account\'s object',
  );
  const mountedShared = new Set(shared.map((r) => r.route));
  const sharedKeys = [...Object.keys(SHARED_ISOLATION_CASES), ...Object.keys(SHARED_BY_HAND)];
  // A reading of the share doors may name one of a route's query fields: `GET /shared/:token/artifacts query path`.
  assert.deepEqual(sharedKeys.filter((key) => !mountedShared.has(key.split(' ').slice(0, 2).join(' '))), [], 'listed, but not a share link\'s door');
  assert.deepEqual(Object.keys(SHARED_BY_HAND).filter((key) => key in SHARED_ISOLATION_CASES), [], 'both sent and read by hand');
  const mountedOther = new Set(other.map((r) => r.route));
  assert.deepEqual(Object.keys(PUBLIC_ROUTES).filter((route) => !mountedOther.has(route)), [], 'listed, but not a route behind no guard');
  assert.deepEqual(
    [...Object.entries(SHARED_BY_HAND), ...Object.entries(PUBLIC_ROUTES)].filter(([, reading]) => !/\.ts:\d+/.test(reading)).map(([key]) => key),
    [],
    'a reading by hand cites the file and line it rests on',
  );
  t.diagnostic(
    `${unguarded.length} routes behind no account guard: ${shared.length} share links' doors (${Object.keys(SHARED_ISOLATION_CASES).length} `
      + `sent through another link), ${other.length} others, each listed with why it reaches no account's object`,
  );
});

test('every share door case goes through some link, fills its route\'s params with that link\'s token, and puts A\'s object where it says', () => {
  const wrong: string[] = [];
  for (const [route, kase] of Object.entries(SHARED_ISOLATION_CASES)) {
    const through = Object.entries(kase.through);
    if (through.length === 0) wrong.push(`${route}: through no link`);
    if (kase.under.length === 0) wrong.push(`${route}: names nothing under its link`);
    for (const [kind, sent] of through) {
      const request = sent!(spelledRunner('a.'), 'the-token');
      const filled = Object.keys(request.params).sort();
      if (filled.join() !== paramsOf(route).sort().join()) wrong.push(`${route} through a ${kind} link: fills ${filled.join(', ') || 'nothing'}`);
      if (request.params.token !== 'the-token') wrong.push(`${route} through a ${kind} link: the link's token is not its :token`);
      for (const under of kase.under) {
        const [where, field] = under.includes(' ') ? under.split(' ') : ['params', under];
        if (!leavesOf(request).some(([at, value]) => at === `${where} ${field}` && typeof value === 'string' && value.includes('a.'))) {
          wrong.push(`${route} through a ${kind} link: A's object is not in ${where} ${field}`);
        }
      }
    }
  }
  assert.deepEqual(wrong, []);
});
