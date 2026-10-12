import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { ServerResponse } from 'node:http';
import { finished } from 'node:stream';
import { catchError, type Observable, throwError } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { PatRefusal } from './pat-scope.decorator';
import type { PatGrant } from './pat.service';

/**
 * What every write a personal access token makes leaves behind (docs/personal-access-token-design.md
 * §6.4): one `activity` row per request, the user's, with credential PAT and the token's id.
 *
 * - `pat.request`: a request JwtAuthGuard let through. The payload is its method, its route template
 *   (`/tasks/:id`), the status it was answered and the ids its path names, as public ids.
 * - `pat.request.denied`: a request refused for what the token may not do (a `PatRefusal`): a scope
 *   it was not granted, a route closed to every token, a workspace it is not confined to, or a field
 *   only the owner sets. The payload adds the refusal's code, and its reason, scope and fields where
 *   it names them.
 *
 * Writes only (POST, PUT, PATCH, DELETE), and only once a token has resolved: an unknown, revoked or
 * expired token is a 401 before anything knows whose it is. The request body is never read, so what
 * a write carried (a prompt, a key) stays out of the record. A task the request creates keeps its own
 * `task.created` row, written inside the creating transaction; this one is about the request.
 *
 * The record is not part of the request. It is written once the answer has gone out, in a statement
 * of its own, so it can neither delay the answer nor change it: a record that cannot be written is
 * logged, not retried.
 */

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** main.ts's global prefix. A route is recorded as its controller spells it, as the census does. */
const GLOBAL_PREFIX = /^\/api(?=\/|$)/;
/** Path params that name a row (`:id`, `:taskId`, `:commentId`), never a `:token`, `:slug` or `:userCode`. */
const ID_PARAM = /^id$|Id$/;

/** A refusal as recorded: its code, and what it names besides, never its prose. */
interface Refusal {
  code: string;
  reason?: string;
  scope?: string;
  fields?: string[];
}

const refusals = new WeakMap<object, Refusal>();

/**
 * Note that `req` was refused as a PatRefusal, for the record its answer leaves. JwtAuthGuard notes
 * its own refusals and PatRefusalInterceptor those thrown past it; any other error is not a refusal.
 */
export function noteRefusal(req: object, error: unknown): void {
  if (!(error instanceof PatRefusal)) return;
  const { code, reason, scope, fields } = error.getResponse() as Partial<Refusal>;
  refusals.set(req, {
    code: String(code),
    ...(reason !== undefined && { reason }),
    ...(scope !== undefined && { scope }),
    ...(fields !== undefined && { fields }),
  });
}

/**
 * Notes the PatRefusal a route throws once JwtAuthGuard has let a token through: a field only the
 * owner sets (§5). Nothing the guard refuses reaches an interceptor, so the guard notes its own.
 */
@Injectable()
export class PatRefusalInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<object>();
    return next.handle().pipe(
      catchError((error: unknown) => {
        noteRefusal(req, error);
        return throwError(() => error);
      }),
    );
  }
}

interface AuditedRequest {
  method: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
}

@Injectable()
export class PatRequestAudit {
  private readonly log = new Logger(PatRequestAudit.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * JwtAuthGuard calls this as soon as a token has resolved, before it judges the route, so a write
   * it refuses is recorded as surely as one it lets through. Recorded once the answer has gone out,
   * or once the caller has gone away without waiting for it — `status` null — so that leaving early
   * does not leave a write unrecorded.
   */
  watch(req: AuditedRequest, res: ServerResponse, grant: Pick<PatGrant, 'userId' | 'tokenId'>): void {
    if (!WRITE_METHODS.has(req.method)) return;
    finished(res, () => void this.record(req, res, grant));
  }

  private async record(req: AuditedRequest, res: ServerResponse, grant: Pick<PatGrant, 'userId' | 'tokenId'>): Promise<void> {
    const route = typeof req.route?.path === 'string' ? req.route.path.replace(GLOBAL_PREFIX, '') : null;
    try {
      const refusal = refusals.get(req);
      await this.prisma.activity.create({
        data: {
          actorId: grant.userId,
          type: refusal ? 'pat.request.denied' : 'pat.request',
          payload: {
            method: req.method,
            route,
            status: res.headersSent ? res.statusCode : null,
            params: idsOf(req.params),
            ...refusal,
          },
          credentialKind: 'PAT',
          credentialId: grant.tokenId,
        },
      });
    } catch (error) {
      this.log.warn(
        `could not record ${req.method} ${route} by access token ${grant.tokenId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** The rows a request's path names, each as its public id; a value that is no id names none. */
function idsOf(params: Record<string, unknown> | undefined): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (!ID_PARAM.test(name) || typeof value !== 'string') continue;
    try {
      ids[name] = uuidToBase62(toUuid(value));
    } catch {
      // Neither a uuid nor a public id: the route answers it 400.
    }
  }
  return ids;
}
