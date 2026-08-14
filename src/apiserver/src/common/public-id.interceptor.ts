import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PUBLIC_ID_FIELDS, uuidToBase62 } from '@orbit/shared';

/**
 * Serve every public id in both spellings: alongside `sessionId` (the UUID the columns key by),
 * emit `sessionPublicId` (the base62 short form the URLs carry).
 *
 * Phase 1 of docs/public-id-migration-design.md. The end state is that base62 IS the id above the
 * API line; this is the step that lets clients start reading it without a flag day. Shipped
 * clients keep reading the UUID field they always have; new ones read the twin; neither has to
 * know the other exists. `WorkspaceAliasInterceptor` next to this one does the same trick for the
 * Agent → Workspace rename, and this deliberately copies its shape.
 *
 * DELETE the UUID half — not this file — once `client_version` says nothing in the field still
 * reads it. That table exists precisely so this decision is a query and not a guess; a shim with
 * no measurable expiry is a permanent one.
 *
 * WHY AN ALLOWLIST, and why it is the same list the input side decodes: the wire is full of
 * uuid-shaped values that are not addresses. Lease and fence tokens (`leaseOwner`, `operationId`,
 * `generation`) are `@db.Uuid` columns the runner echoes back byte-for-byte into raw SQL casts —
 * translate one on the way out without decoding it on the way back in and the fence stops
 * matching, silently, forever. `PUBLIC_ID_FIELDS` is the single classification both directions
 * read, and `public-id-coverage.spec.ts` fails the build when a new column joins neither set.
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
 *  opaque third-party JSON — a `tool_use` block's `id` is `toolu_01…`, not an address — and an
 *  interceptor that throws turns a working endpoint into a 500. */
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

function addTwins(value: unknown, replaceSource: boolean, depth = 0): unknown {
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
 * Phase 3's opt-in. A client that can read base62 in `id` asks for it per request; everything
 * else keeps getting the UUID it has always got.
 *
 * WHY THE CLIENT DECLARES IT rather than the server inferring it from `X-Orbit-Client`: a version
 * threshold has to be configured, parsed and compared, and every one of those is a way to guess
 * wrong about a build nobody can recall — a browser tab open since last month upgrades when its
 * owner reloads, not when a config says so. The client is the only party that knows what it can
 * parse, so it is the party that says. `client_version` then answers the *other* question — when
 * the UUID path can be deleted — which is what it was built for.
 */
const FORMAT_HEADER = 'x-orbit-id-format';

function wantsPublicIds(request: { headers?: Record<string, unknown> } | undefined): boolean {
  return request?.headers?.[FORMAT_HEADER] === 'public';
}

@Injectable()
export class PublicIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const replaceSource = wantsPublicIds(context.switchToHttp().getRequest());
    return next.handle().pipe(map((body) => addTwins(body, replaceSource)));
  }
}
