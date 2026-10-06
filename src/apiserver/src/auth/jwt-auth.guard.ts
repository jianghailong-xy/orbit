import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PUBLIC_ID_FIELDS, toUuid } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { visitorAddress } from '../shared/public-surface.guard';
import { ALLOW_QUERY_TOKEN } from './allow-query-token.decorator';
import { PatRequestAudit, noteRefusal } from './pat-request-audit';
import {
  type PatDeclaration,
  PatRefusal,
  type PatWorkspaceConfinable,
  type PatWorkspaceObject,
  patDeclaration,
  patForbiddenBody,
} from './pat-scope.decorator';
import { PAT_PREFIX, type PatGrant, PatService } from './pat.service';

/** How deep a request is searched for the ids it names. Past it, what it names is unknown and refused. */
const MAX_ID_DEPTH = 32;
const TOO_DEEP = '(nested too deep to read)';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    // AuthModule provides it everywhere. A module that does not (a test harness) has no personal
    // access tokens: every one is answered 401, as an unknown token is.
    @Optional() private readonly pats?: PatService,
    // Provided alongside PatService. Without it a token's writes go unrecorded, and nothing else changes.
    @Optional() private readonly audit?: PatRequestAudit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];

    let token: string | undefined;
    let fromQuery = false;
    if (header && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length);
    } else if (typeof req.query?.access_token === 'string') {
      // EventSource (SSE) cannot set headers — accept a query-param token, but
      // ONLY on routes that opt in via @AllowQueryToken (the SSE stream). Other
      // routes require the header so bearer tokens don't leak into access logs.
      const allowQuery = this.reflector.getAllAndOverride<boolean>(ALLOW_QUERY_TOKEN, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (allowQuery) {
        token = req.query.access_token;
        fromQuery = true;
      }
    }
    if (!token) throw new UnauthorizedException('missing bearer token');

    if (token.startsWith(PAT_PREFIX)) {
      // A personal access token lives for months, so it is never taken from a URL, where access
      // logs would keep it (§6.1). It is not looked up either: the answer is an unknown token's.
      if (fromQuery) throw new UnauthorizedException('invalid token');
      const grant = await this.pats?.verify(token, {
        ip: visitorAddress(req),
        userAgent: req.headers['user-agent'],
      });
      if (!grant) throw new UnauthorizedException('invalid token');
      const user: AuthUser = {
        userId: grant.userId,
        email: grant.email,
        credential: {
          kind: 'PAT',
          tokenId: grant.tokenId,
          scopes: grant.scopes,
          workspaceIds: grant.workspaceIds,
        },
      };
      req.user = user;
      // Every write a token makes is recorded once it is answered, the ones refused here included (§6.4).
      this.audit?.watch(req, context.switchToHttp().getResponse(), grant);
      try {
        const admitted = this.admitToken(context, grant.scopes);
        if (grant.workspaceIds.length > 0 && admitted.kind === 'SCOPE') {
          await this.confine(req, admitted.workspaceConfinable, grant);
        }
      } catch (error) {
        noteRefusal(req, error);
        throw error;
      }
      return true;
    }

    try {
      const payload = await this.jwt.verifyAsync(token);
      const user: AuthUser = { userId: payload.sub, email: payload.email, credential: { kind: 'LOGIN' } };
      req.user = user;
      return true;
    } catch {
      throw new UnauthorizedException('invalid token');
    }
  }

  /**
   * Whether this route is open to a verified token (§6.2), from what the route declares: a refusal
   * (@PatForbidden) is a 403 whatever the token holds; a scope (@PatScope) must be one it was granted;
   * the token reading itself (@PatSelf) is open to every token, needing no scope and no workspace;
   * and a route that declares none of them is a 403 as well — fail-closed, so a route added without
   * a decision is closed to tokens rather than open to them. Answers the declaration that admitted
   * the token, a scope's with what it declares for a token confined to workspaces.
   */
  private admitToken(context: ExecutionContext, scopes: string[]): Extract<PatDeclaration, { kind: 'SCOPE' | 'SELF' }> {
    const declared = patDeclaration(this.reflector, context.getHandler(), context.getClass());
    if (declared.kind === 'FORBIDDEN') throw new PatRefusal(patForbiddenBody(declared.reason));
    if (declared.kind === 'UNDECLARED') {
      throw new PatRefusal({
        code: 'PAT_ROUTE_UNDECLARED',
        message: 'This route declares no access token scope, so a personal access token cannot call it',
      });
    }
    if (declared.kind === 'SELF') return declared;
    if (!scopes.includes(declared.scope)) {
      throw new PatRefusal({
        code: 'PAT_SCOPE_MISSING',
        scope: declared.scope,
        message: `This access token was not granted the ${declared.scope} scope this route needs`,
      });
    }
    return declared;
  }

  /**
   * Whether a token confined to workspaces reaches what this request names (§6.3 v1), once its scope
   * has admitted it to the route. A route that cannot be told by workspace refuses it outright, and a
   * list is narrowed by its handler. Otherwise every task, session and workspace the request names —
   * in its path, and by id anywhere in its body or query — must sit in one of the token's workspaces,
   * and a request naming anything else by id is refused, since nothing vouches for it. Something the
   * user does not have is no more inside those workspaces than something outside them: both are this
   * 403, so a confined token learns nothing about what exists elsewhere.
   */
  private async confine(
    req: { params?: Record<string, unknown>; body?: unknown; query?: unknown },
    confinable: PatWorkspaceConfinable | undefined,
    grant: PatGrant,
  ): Promise<void> {
    if (confinable === 'LIST') return;
    // A declaration that names nothing (only the census keeps one from being written) judges nothing.
    if (!confinable || (!confinable.params && !confinable.requires)) {
      throw new PatRefusal({
        code: 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE',
        message:
          'This access token is confined to workspaces, and this route cannot be confined to one; '
          + 'call it with a token that is not confined to workspaces',
      });
    }
    const named: Array<{ field: string; kind: PatWorkspaceObject; value: unknown }> = Object.entries(
      confinable.params ?? {},
    ).map(([param, kind]) => ({ field: `:${param}`, kind, value: req.params?.[param] }));
    const outside = new Set<string>();
    const judged = (field: string) => confinable.body !== undefined && Object.hasOwn(confinable.body, field);
    const isId = (field: string) => PUBLIC_ID_FIELDS.has(field) || judged(field);
    for (const [field, value] of [...idFields(req.body, isId), ...idFields(req.query, isId)]) {
      if (judged(field)) named.push({ field, kind: confinable.body![field], value });
      else outside.add(field);
    }
    for (const path of confinable.requires ?? []) if (lacks(req.body, path)) outside.add(path);

    const asked: Record<'task' | 'session', Array<{ field: string; id: string }>> = { task: [], session: [] };
    for (const { field, kind, value } of named) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === null && kind !== 'workspace') continue;
        const id = asUuid(item);
        if (!id) outside.add(field);
        else if (kind !== 'workspace') asked[kind].push({ field, id });
        else if (!grant.workspaceIds.includes(id)) outside.add(field);
      }
    }
    for (const kind of ['task', 'session'] as const) {
      if (outside.size > 0 || asked[kind].length === 0) continue;
      const sits = await this.pats!.workspacesOf(grant.userId, kind, [...new Set(asked[kind].map((a) => a.id))]);
      for (const { field, id } of asked[kind]) {
        const workspaceId = sits.get(id);
        if (!workspaceId || !grant.workspaceIds.includes(workspaceId)) outside.add(field);
      }
    }
    if (outside.size > 0) {
      const fields = [...outside];
      throw new PatRefusal({
        code: 'PAT_WORKSPACE_OUT_OF_SCOPE',
        fields,
        message:
          `This access token is confined to its workspaces, and ${fields.join(', ')} `
          + `${fields.length === 1 ? 'names' : 'name'} something outside them`,
      });
    }
  }
}

/** Every field of a request body or query that names something by id (`isId`), at any depth. */
function idFields(value: unknown, isId: (field: string) => boolean, depth = 0): Array<[string, unknown]> {
  if (!value || typeof value !== 'object') return [];
  if (depth > MAX_ID_DEPTH) return [[TOO_DEEP, value]];
  if (Array.isArray(value)) return value.flatMap((item) => idFields(item, isId, depth + 1));
  return Object.entries(value).flatMap(([key, child]): Array<[string, unknown]> =>
    isId(key) ? [[key, child]] : idFields(child, isId, depth + 1));
}

/** Whether `body` lacks the field at `path`: `a.b` only when the body has `a`. Null is lacking. */
function lacks(body: unknown, path: string): boolean {
  const keys = path.split('.');
  const field = keys.pop()!;
  let node = body as Record<string, unknown> | null | undefined;
  for (const key of keys) {
    const next = node?.[key];
    if (next === undefined || next === null) return false;
    node = next as Record<string, unknown>;
  }
  const value = typeof node === 'object' ? node?.[field] : undefined;
  return value === undefined || value === null;
}

/** The uuid a public id or uuid names, or undefined for anything that is neither. */
function asUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return toUuid(value);
  } catch {
    return undefined;
  }
}
