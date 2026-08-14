import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Serve `workspace*` and `agent*` as the same field, in both directions, on every JSON response.
 *
 * The entity was renamed Agent → Workspace (migration 0094), but the shipped clients were not:
 * a TestFlight build from last month, a browser tab nobody reloaded, a runner that has not
 * self-updated yet all still read `agentId` / `agent`. Meanwhile the renamed Prisma models now
 * hand those same rows out under `workspaceId` / `workspace` wherever a handler returns a record
 * straight from the query.
 *
 * Rather than track down which of the two names each of ~40 handlers happens to emit — and get one
 * wrong, silently, in a payload no test asserts on — every response carries both. New clients read
 * the new name, old clients keep reading the old one, and neither has to know the other exists.
 *
 * DELETE THIS once every client in the field speaks `workspace*`. It is a migration aid with an
 * expiry date, not a permanent part of the contract; leaving it forever means the old name never
 * actually goes away.
 */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['workspaceId', 'agentId'],
  ['workspace', 'agent'],
  ['workspaceName', 'agentName'],
  ['workspaceIds', 'agentIds'],
];

/** Depth cap: real payloads nest a handful deep, and a cycle or a pathological body must not be
 *  able to turn one response into an unbounded walk. */
const MAX_DEPTH = 8;

function mirror(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) mirror(item, depth + 1);
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) mirror(obj[key], depth + 1);
  for (const [next, legacy] of PAIRS) {
    // Only ever ADD the missing half. A handler that deliberately set both (or set one to null to
    // mean "absent") keeps exactly what it wrote.
    if (next in obj && !(legacy in obj)) obj[legacy] = obj[next];
    else if (legacy in obj && !(next in obj)) obj[next] = obj[legacy];
  }
  return obj;
}

@Injectable()
export class WorkspaceAliasInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => mirror(body)));
  }
}
