import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser } from '../common/current-user.decorator';
import { visitorAddress } from '../shared/public-surface.guard';
import { ALLOW_QUERY_TOKEN } from './allow-query-token.decorator';
import { patDeclaration, patForbiddenBody } from './pat-scope.decorator';
import { PAT_PREFIX, PatService } from './pat.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    // AuthModule provides it everywhere. A module that does not (a test harness) has no personal
    // access tokens: every one is answered 401, as an unknown token is.
    @Optional() private readonly pats?: PatService,
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
      this.admitToken(context, grant.scopes);
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
   * and a route that declares neither is a 403 as well — fail-closed, so a route added without a
   * decision is closed to tokens rather than open to them.
   */
  private admitToken(context: ExecutionContext, scopes: string[]): void {
    const declared = patDeclaration(this.reflector, context.getHandler(), context.getClass());
    if (declared.kind === 'FORBIDDEN') throw new ForbiddenException(patForbiddenBody(declared.reason));
    if (declared.kind === 'UNDECLARED') {
      throw new ForbiddenException({
        code: 'PAT_ROUTE_UNDECLARED',
        message: 'This route declares no access token scope, so a personal access token cannot call it',
      });
    }
    if (!scopes.includes(declared.scope)) {
      throw new ForbiddenException({
        code: 'PAT_SCOPE_MISSING',
        scope: declared.scope,
        message: `This access token was not granted the ${declared.scope} scope this route needs`,
      });
    }
  }
}
