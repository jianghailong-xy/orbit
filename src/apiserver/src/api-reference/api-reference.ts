import { Body, type DynamicModule, Param, Query, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { AppModule } from '../app.module';

/**
 * The external HTTP API reference (docs/api-reference.md), generated from the controllers this
 * application mounts rather than from a hand-kept list.
 *
 * The route set is read the way Nest mounts it — AppModule's imports followed all the way down,
 * as `pat-route-coverage.spec.ts` reads it — and each route's method, path, guards, body type and
 * named query/path parameters come from the metadata the decorators leave behind.
 * `api-reference.spec.ts` fails when the committed document and this renderer disagree, so a
 * controller added, renamed or re-guarded without regenerating the page turns CI red.
 *
 * It deliberately says nothing reflection cannot read: response shapes and status codes belong to
 * the handlers and their DTOs, so the page points at them instead of inventing a schema.
 */

type Controller = new (...args: never[]) => unknown;

/** Who a route admits, in the order the page lists them. */
export const CALLERS = ['public', 'user', 'admin', 'runner', 'channel', 'link gateway'] as const;
export type Caller = (typeof CALLERS)[number];

export const CALLER_LABELS: Record<Caller, string> = {
  public: 'Anyone who can reach the gateway. A share-link route is also rate-limited per visitor.',
  user:
    'A signed-in person’s access token, or a personal access token with the scope the route declares. ' +
    'A personal access token is the user, so the route’s owner checks apply to it unchanged.',
  admin: 'A signed-in administrator. The role is read from the database on every request, so a promotion or demotion applies at once.',
  runner:
    'A runner’s own credential: its machine token, or an orchestration proof minted for one session and task. ' +
    'Runtime logins never leave the runner machine, so no route here carries a model-provider credential.',
  channel: 'A managed-runner channel’s admission credential.',
  'link gateway': 'The runner link gateway, presenting `RUNNER_LINK_GATEWAY_TOKEN`.',
};

/**
 * What each guard says about the caller. Every guard a mounted route uses must appear here, or
 * `collectApiRoutes` throws — a new guard is a decision about who may call, and the page cannot
 * guess it.
 */
const GUARD_CALLERS: Record<string, Caller> = {
  JwtAuthGuard: 'user',
  AdminRoleGuard: 'admin',
  SessionOwnerGuard: 'user',
  WikiRolloutGuard: 'user',
  ManagedRunnerEnabledGuard: 'user',
  RunnerAuthGuard: 'runner',
  RunnerSessionAuthGuard: 'runner',
  ManagedRunnerAdmissionGuard: 'channel',
  RunnerLinkGatewayGuard: 'link gateway',
  RunnerLinkGatewayCallGuard: 'link gateway',
  PublicSurfaceGuard: 'public',
};

const REQUEST_METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.SEARCH]: 'SEARCH',
};

export interface ApiRoute {
  method: string;
  path: string;
  caller: Caller;
  guards: string[];
  body?: string;
  query: string[];
  params: string[];
  handler: string;
}

/** Every controller the production application mounts. */
async function mountedControllers(): Promise<Set<Controller>> {
  const seen = new Set<unknown>();
  const controllers = new Set<Controller>();
  const visit = async (entry: unknown): Promise<void> => {
    // ConfigModule.forRoot() is a promise of its module; forwardRef(() => X) names one lazily.
    let node = await entry;
    if (node && typeof node === 'object' && 'forwardRef' in node) {
      node = (node as { forwardRef: () => unknown }).forwardRef();
    }
    if (!node || seen.has(node)) return;
    seen.add(node);
    const dynamic = typeof node === 'object' ? (node as DynamicModule) : undefined;
    const declared = (key: string) =>
      (Reflect.getMetadata(key, dynamic ? dynamic.module : (node as object)) ?? []) as unknown[];
    for (const c of [...declared(MODULE_METADATA.CONTROLLERS), ...(dynamic?.controllers ?? [])]) {
      controllers.add(c as Controller);
    }
    for (const i of [...declared(MODULE_METADATA.IMPORTS), ...(dynamic?.imports ?? [])]) await visit(i);
  };
  await visit(AppModule);
  return controllers;
}

/**
 * Which decorated argument is the body, the query and the path. RouteParamtypes is not public
 * API, so a probe reads the three numbers Nest records, as `public-id-coverage.spec.ts` does.
 */
function argumentKinds(): { body: number; query: number; param: number } {
  class Probe {
    probe(@Body() _body: unknown, @Query('probeQuery') _query?: string, @Param('probeParam') _param?: string) {}
  }
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'probe') as Record<string, { data?: unknown }>;
  const kindOf = (data: unknown) =>
    Number(Object.entries(args).find(([, entry]) => entry.data === data)![0].split(':')[0]);
  const bodyKey = Object.keys(args).find((key) => key.endsWith(':0'))!;
  return { body: Number(bodyKey.split(':')[0]), query: kindOf('probeQuery'), param: kindOf('probeParam') };
}

function guardNames(target: object): string[] {
  return ((Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[]).map(
    (guard) => (guard as { name?: string }).name ?? String(guard),
  );
}

/** Throws on a guard nobody has classified: the page must not silently guess who may call. */
export function callerOf(guards: string[]): Caller {
  const callers = new Set<Caller>();
  for (const guard of guards) {
    const caller = GUARD_CALLERS[guard];
    if (!caller) {
      throw new Error(
        `The API reference does not know who ${guard} admits. Classify it in GUARD_CALLERS (src/apiserver/src/api-reference/api-reference.ts).`,
      );
    }
    callers.add(caller);
  }
  // A route with no auth guard is public. Where a route carries more than one caller, the most
  // specific one is the one that decides: admin over user, a machine credential over a person's.
  const order: Caller[] = ['link gateway', 'channel', 'runner', 'admin', 'user', 'public'];
  const caller = order.find((entry) => callers.has(entry)) ?? 'public';
  return caller;
}

function joinPath(...parts: string[]): string {
  const path = parts
    .flatMap((part) => part.split('/'))
    .filter((part) => part.length > 0)
    .join('/');
  return path.length ? `/${path}` : '/';
}

/** Nest accepts one path or a list per decorator; each mounted path is a row of its own. */
function pathsOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [''];
  return Array.isArray(value) ? value : [value];
}

/** Every route the application mounts, with what reflection can say about it. */
export async function collectApiRoutes(): Promise<ApiRoute[]> {
  const kinds = argumentKinds();
  const routes: ApiRoute[] = [];
  for (const controller of await mountedControllers()) {
    const basePaths = pathsOf(Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined);
    const classGuards = guardNames(controller);
    const seenMethods = new Set<string>();
    let prototype: object | null = controller.prototype;
    while (prototype && prototype !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        if (name === 'constructor' || seenMethods.has(name)) continue;
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (requestMethod === undefined) continue;
        seenMethods.add(name);
        const methodPaths = pathsOf(Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined);
        const guards = [...classGuards, ...guardNames(handler)];
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<
          string,
          { data?: unknown }
        >;
        const types = (Reflect.getMetadata('design:paramtypes', prototype, name) ?? []) as unknown[];
        let body: string | undefined;
        const query: string[] = [];
        const params: string[] = [];
        for (const [key, entry] of Object.entries(args)) {
          const [kindText, indexText] = key.split(':');
          const kind = Number(kindText);
          const index = Number(indexText);
          if (kind === kinds.body) {
            const type = types[index] as { name?: string } | undefined;
            body = entry.data === undefined ? (type?.name ?? 'unknown') : `${type?.name ?? 'unknown'} (${String(entry.data)})`;
          } else if (kind === kinds.query && typeof entry.data === 'string') {
            query.push(entry.data);
          } else if (kind === kinds.param && typeof entry.data === 'string') {
            params.push(entry.data);
          }
        }
        for (const basePath of basePaths) {
          for (const methodPath of methodPaths) {
            routes.push({
              method: REQUEST_METHODS[requestMethod] ?? `METHOD_${requestMethod}`,
              path: joinPath('api', basePath, methodPath),
              caller: callerOf(guards),
              guards,
              body,
              query: query.sort(),
              params: params.sort(),
              handler: `${controller.name}.${name}`,
            });
          }
        }
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  }
  return routes.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.handler.localeCompare(b.handler),
  );
}

const cell = (text: string): string => text.replace(/\|/g, '\\|');

function requestCell(route: ApiRoute): string {
  const parts: string[] = [];
  if (route.body) parts.push(`body \`${route.body}\``);
  if (route.params.length) parts.push(`path ${route.params.map((name) => `\`${name}\``).join(', ')}`);
  if (route.query.length) parts.push(`query ${route.query.map((name) => `\`${name}\``).join(', ')}`);
  return parts.length ? parts.join('; ') : '—';
}

/** The page, as committed. Deterministic: routes are sorted and nothing carries a timestamp. */
export function renderApiReference(routes: ApiRoute[]): string {
  const lines: string[] = [];
  lines.push('# External HTTP API reference');
  lines.push('');
  lines.push(
    '<!-- Generated by `npm run api:reference` from the controllers the application mounts. Do not edit this file by',
  );
  lines.push(
    '     hand: `api-reference.spec.ts` regenerates it and fails when the committed page and the code disagree. -->',
  );
  lines.push('');
  lines.push(
    'Every route the control plane serves, under the `/api` prefix: the web app, the native clients, the `orbit` CLI,',
  );
  lines.push(
    'runners, and the runner link gateway are all clients of these routes. The page is generated from the NestJS',
  );
  lines.push(
    'controllers and their decorators, so it lists what the server mounts, not what a design note once proposed.',
  );
  lines.push('');
  lines.push('## Who may call a route');
  lines.push('');
  lines.push('| Caller | Meaning |');
  lines.push('| --- | --- |');
  for (const caller of CALLERS) lines.push(`| \`${caller}\` | ${cell(CALLER_LABELS[caller])} |`);
  lines.push('');
  lines.push('## Conventions');
  lines.push('');
  lines.push(
    '- **Base path.** Every path below begins with `/api`. The web bundle and the API share one origin through the',
  );
  lines.push(
    '  gateway, so a browser calls `/api/…` directly; a script calls `${PUBLIC_ORIGIN}/api/…`.',
  );
  lines.push(
    '- **Authentication.** User and runner routes read `Authorization: Bearer <token>`. A user token is an access',
  );
  lines.push(
    '  token from a sign-in, or a personal access token (Settings → Access tokens); a runner token is the long-lived',
  );
  lines.push(
    '  credential `orbit register` stored in the runner’s `config.json`. The link-gateway routes take',
  );
  lines.push('  `RUNNER_LINK_GATEWAY_TOKEN` instead.');
  lines.push(
    '- **Ids.** Every id a caller supplies is either the base62 short form the clients put in URLs or the raw UUID;',
  );
  lines.push(
    '  both resolve to the same record, and anything else is a `400` that names the field. Responses carry the base62',
  );
  lines.push('  form.');
  lines.push(
    '- **Bodies and responses.** JSON. Request bodies are validated by the DTO class named in the table. A refusal',
  );
  lines.push(
    '  answers its HTTP status with a JSON body: Nest’s `{ "statusCode", "message" }` in the ordinary case, and many',
  );
  lines.push(
    '  product refusals add a stable `code` and a `requiredAction` saying what the caller should do instead.',
  );
  lines.push(
    '- **"Public" means no guard refuses at the door.** A route can still answer `401` or `403` from its own handler:',
  );
  lines.push(
    '  the two `/api/gw/…` model gateways validate the session token they are handed, and a paging route can refuse a',
  );
  lines.push('  caller who does not own the record it names.');
  lines.push(
    '- **Paging.** List routes that page state it in their handler and DTO (`cursor`, `limit`, or a `page` route);',
  );
  lines.push('  a route without one returns its whole result.');
  lines.push('');
  const byCaller = new Map<Caller, ApiRoute[]>(CALLERS.map((caller) => [caller, []]));
  for (const route of routes) byCaller.get(route.caller)!.push(route);
  lines.push('## Summary');
  lines.push('');
  lines.push('| Caller | Routes |');
  lines.push('| --- | --- |');
  for (const caller of CALLERS) lines.push(`| \`${caller}\` | ${byCaller.get(caller)!.length} |`);
  lines.push(`| **Total** | **${routes.length}** |`);
  lines.push('');
  for (const caller of CALLERS) {
    const group = byCaller.get(caller)!;
    lines.push(`## ${caller[0].toUpperCase()}${caller.slice(1)} routes`);
    lines.push('');
    if (group.length === 0) {
      lines.push('None.');
      lines.push('');
      continue;
    }
    lines.push('| Method | Path | Request | Handler |');
    lines.push('| --- | --- | --- | --- |');
    for (const route of group) {
      lines.push(
        `| \`${route.method}\` | \`${cell(route.path)}\` | ${cell(requestCell(route))} | \`${route.handler}\` |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
