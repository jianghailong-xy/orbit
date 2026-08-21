import { ArgumentsHost } from '@nestjs/common';
import { PUBLIC_ID_FIELDS, uuidToBase62 } from '@orbit/shared';

/**
 * How a public id is spelled in a response body, for every exit that has one.
 *
 * Serve every public id in both spellings: alongside `sessionId` (the UUID the columns key by),
 * emit `sessionPublicId` (the base62 short form the URLs carry).
 *
 * Phase 1 of docs/public-id-migration-design.md. The end state is that base62 IS the id above the
 * API line; this is the step that lets clients start reading it without a flag day. Shipped
 * clients keep reading the UUID field they always have; new ones read the twin; neither has to
 * know the other exists. `WorkspaceAliasInterceptor` does the same trick for the Agent → Workspace
 * rename, and this deliberately copies its shape.
 *
 * DELETE the UUID half — not this file — once `client_version` says nothing in the field still
 * reads it. That table exists precisely so this decision is a query and not a guess; a shim with
 * no measurable expiry is a permanent one.
 *
 * WHY AN ALLOWLIST, and why it is the same list the input side decodes: the wire is full of
 * uuid-shaped values that are not addresses. Lease and fence tokens (`leaseOwner`, `operationId`,
 * `generation`) are `@db.Uuid` columns the runner echoes back byte-for-byte into raw SQL casts —
 * they are in `NEVER_PUBLIC_ID_FIELDS`, so no fence is reachable from here whatever the boundary
 * below decides —
 * translate one on the way out without decoding it on the way back in and the fence stops
 * matching, silently, forever. `PUBLIC_ID_FIELDS` is the single classification both directions
 * read, and `public-id-coverage.spec.ts` fails the build when a new column joins neither set.
 *
 * WHY IT LIVES HERE and not in the interceptor that used to own it: a response body is not the
 * only body a request produces. `PublicIdInterceptor` maps the value a handler RETURNS;
 * `PublicIdExceptionFilter` maps the one it THROWS. Two exits, one rule — and the rule is written
 * once so the next exit is a call rather than a re-derivation.
 */

/** `sessionId` → `sessionPublicId`, `taskIds` → `taskPublicIds`. Two names carry no `Id` suffix
 *  to rewrite, so they say what they become. */
const IRREGULAR: Readonly<Record<string, string>> = { id: 'publicId', mentions: 'mentionPublicIds' };

const TWIN: ReadonlyMap<string, string> = new Map(
  [...PUBLIC_ID_FIELDS].map((field) => [
    field,
    IRREGULAR[field] ?? field.replace(/Ids$/, 'PublicIds').replace(/Id$/, 'PublicId'),
  ]),
);

/** Same cap, and the same reason, as WorkspaceAliasInterceptor: a cycle or a pathological body
 *  must not turn one response into an unbounded walk. */
const MAX_DEPTH = 8;

/** Anything that isn't a canonical UUID is left alone rather than rejected. Response bodies carry
 *  opaque third-party JSON — a `tool_use` block's `id` is `toolu_01…`, not an address — and a
 *  mapper that throws turns a working endpoint into a 500. */
function encode(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'string') {
    try {
      return uuidToBase62(value);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') return undefined;
      try {
        out.push(uuidToBase62(item));
      } catch {
        // A half-encoded array is worse than none: the caller cannot tell which half is which.
        return undefined;
      }
    }
    return out;
  }
  return undefined;
}

/**
 * Add — and, above the machine protocol, replace — every allowlisted id in `value`, in place.
 *
 * Idempotent, which is what lets both exits run over the same object without coordinating: a
 * second pass finds the twin already written, and finds a `runId` that no longer decodes as a
 * UUID because the first pass already made it base62.
 */
export function addTwins(value: unknown, replaceSource: boolean, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) addTwins(item, replaceSource, depth + 1);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) addTwins(obj[key], replaceSource, depth + 1);
  for (const [field, twinName] of TWIN) {
    if (!(field in obj)) continue;
    const encoded = encode(obj[field]);
    if (encoded === undefined) continue;
    // Only ever ADD, and never over a name the handler chose itself — same rule as the alias
    // interceptor, so a route that already computes its own public id keeps what it wrote.
    if (!(twinName in obj)) obj[twinName] = encoded;
    // Phase 3: for a client that asked for it, `id` IS the public id. Guarded on a successful
    // encode, so a field holding something that isn't a UUID (`id: "toolu_01…"`) is never
    // rewritten into something the caller didn't send.
    if (replaceSource && encoded !== null) obj[field] = encoded;
  }
  return obj;
}

/**
 * Which side of the machine-protocol boundary this request is on, parked on the request itself.
 *
 * The failure path needs the same answer the success path got, and cannot work it out for itself:
 * Nest builds an exception filter's host as `new ExecutionContextHost([req, res, next])` with no
 * constructorRef, so `getClass()` there is `null` — the controller class, which IS the boundary,
 * is only knowable at a stage that still holds an `ExecutionContext`. So the interceptor, which
 * has one, writes the decision down and the filter reads it back. One decision, two exits; a
 * filter that re-derived it from the path would be re-deriving it from the thing the marker exists
 * to stop being the test (see `machine-protocol.ts`).
 */
const BOUNDARY = Symbol('orbit:public-id:replace-source');

export function rememberBoundary(host: ArgumentsHost, replaceSource: boolean): void {
  // A global enhancer is not promised an HTTP context, and specs drive `intercept` with a bare
  // `{ getClass }` stub. Nothing to park it on, and nothing downstream that could read it.
  if (host.getType?.() !== 'http') return;
  (host.switchToHttp().getRequest() as Record<symbol, unknown>)[BOUNDARY] = replaceSource;
}

/**
 * False when nothing wrote it — a guard, a 404, or any other refusal decided before the
 * interceptor ran. Unknown resolves to the conservative half of the boundary: ADD the twin, never
 * rewrite the source, because the failure that follows an unwanted rewrite is the silent kind.
 */
export function boundaryOf(host: ArgumentsHost): boolean {
  if (host.getType?.() !== 'http') return false;
  return (host.switchToHttp().getRequest() as Record<symbol, unknown>)[BOUNDARY] === true;
}
