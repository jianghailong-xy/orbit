import { ForbiddenException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'node:crypto';
import { patDeclaration } from './pat-scope.decorator';

/**
 * An administrator viewing Orbit as another account, to see what it sees while debugging it: the
 * token `POST /admin/users/:id/impersonate` answers. Its `sub` is the account viewed, so every route
 * reads as it reads for that account, and `act.sub` (RFC 8693's actor) is the administrator. It reads
 * only (`impersonationRefusal`), lasts IMPERSONATION_TTL_SECONDS and has no refresh token beside it.
 *
 * A signing domain of its own, as the service token and the orchestration proof have: a key derived
 * from JWT_SECRET, so a server that predates it, or any code that verifies a login, rejects it rather
 * than reading it as the account's own login, writes and all.
 */

const IMPERSONATION_AUDIENCE = 'orbit-impersonation';
const IMPERSONATION_KEY_DERIVATION_DOMAIN = 'orbit:impersonation-jwt:v1';
export const IMPERSONATION_JWT = Symbol('IMPERSONATION_JWT');

/** How long one look at another account lasts. */
export const IMPERSONATION_TTL_SECONDS = 30 * 60;

/** The Activity row of a look started: the administrator's, naming the account viewed and why. */
export const USER_IMPERSONATED_ACTIVITY = 'user.impersonated';

/** A write, while viewing Orbit as another account. */
export const IMPERSONATION_READ_ONLY = 'IMPERSONATION_READ_ONLY';
/** A read an administrator viewing Orbit as another account is not shown: administration, and a stored key. */
export const IMPERSONATION_FORBIDDEN = 'IMPERSONATION_FORBIDDEN';

export function createImpersonationJwt(config: ConfigService): JwtService {
  const rootSecret = config.get<string>('JWT_SECRET');
  if (!rootSecret) throw new Error('JWT_SECRET is required');
  return new JwtService({ secret: createHmac('sha256', rootSecret).update(IMPERSONATION_KEY_DERIVATION_DOMAIN).digest() });
}

/** What a verified impersonation token says. */
export interface ImpersonationGrant {
  /** The account viewed. */
  userId: string;
  email: string;
  /** The administrator viewing it. */
  administratorId: string;
  /** When the token stops working, in seconds since the epoch. */
  expiresAt: number;
}

@Injectable()
export class Impersonation {
  constructor(@Inject(IMPERSONATION_JWT) private readonly jwt: JwtService) {}

  /** A token for `administratorId` to view `user`'s Orbit with, and when it stops working. */
  async issue(administratorId: string, user: { id: string; email: string }): Promise<{ accessToken: string; expiresAt: Date }> {
    const accessToken = await this.jwt.signAsync(
      { email: user.email, act: { sub: administratorId } },
      { audience: IMPERSONATION_AUDIENCE, subject: user.id, expiresIn: IMPERSONATION_TTL_SECONDS },
    );
    const { exp } = this.jwt.decode<{ exp: number }>(accessToken);
    return { accessToken, expiresAt: new Date(exp * 1000) };
  }

  /**
   * The grant `token` carries: undefined when it is no impersonation token at all (a login), null when
   * it is one that does not verify — forged, altered or expired.
   */
  async verify(token: string): Promise<ImpersonationGrant | null | undefined> {
    let claims: { aud?: unknown } | null;
    try {
      claims = this.jwt.decode<{ aud?: unknown } | null>(token);
    } catch {
      // Not a token this can read (a JWT header over a payload that is no JSON): the login's own
      // verification answers it, 401.
      return undefined;
    }
    if (claims?.aud !== IMPERSONATION_AUDIENCE) return undefined;
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: unknown; email?: unknown; act?: { sub?: unknown }; exp: number }>(token, {
        audience: IMPERSONATION_AUDIENCE,
      });
      const administratorId = payload.act?.sub;
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || typeof administratorId !== 'string') return null;
      return { userId: payload.sub, email: payload.email, administratorId, expiresAt: payload.exp };
    } catch {
      return null;
    }
  }
}

const WRITES_NOTHING = 'orbit:writes-nothing';

/** A POST that only reads — it takes its question as a body — so an administrator viewing Orbit as another account sends it too. */
export const WritesNothing = () => SetMetadata(WRITES_NOTHING, true);

const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Why an administrator viewing Orbit as another account is refused this request, or undefined: they
 * read and write nothing, and they are not shown what an access token is never shown either —
 * administration, and a stored key in the clear. A read is a GET, a route whose access token scope is
 * a read scope (`tasks:read` on a POST that takes its question as a body) or one marked @WritesNothing.
 */
export function impersonationRefusal(reflector: Reflector, handler: Function, controller: Function, method: string): ForbiddenException | undefined {
  const declared = patDeclaration(reflector, handler, controller);
  if (declared.kind === 'FORBIDDEN' && declared.reason === 'ADMIN') {
    return new ForbiddenException({
      code: IMPERSONATION_FORBIDDEN,
      message: 'Administration is not available while viewing Orbit as another user',
    });
  }
  if (declared.kind === 'FORBIDDEN' && declared.reason === 'SECRET_REVEAL') {
    return new ForbiddenException({
      code: IMPERSONATION_FORBIDDEN,
      message: 'A stored key is not shown while viewing Orbit as another user',
    });
  }
  const reads =
    READ_METHODS.has(method)
    || (declared.kind === 'SCOPE' && declared.scope.endsWith(':read'))
    || reflector.get<boolean | undefined>(WRITES_NOTHING, handler) === true;
  if (reads) return undefined;
  return new ForbiddenException({
    code: IMPERSONATION_READ_ONLY,
    message: 'You are viewing Orbit as another user, read-only: nothing can be changed',
  });
}
