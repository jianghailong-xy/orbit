import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Which door a request came in through (docs/personal-access-token-design.md §6.1): a login — the
 * JWT the Web and App sign in for — one of the user's personal access tokens, or an administrator
 * viewing Orbit as the user, read-only (auth/impersonation.ts). A login names its login session
 * (docs/push-login-session-design.md) unless its JWT was signed before sessions.
 */
export type AuthCredential =
  | { kind: 'LOGIN'; loginSessionId?: string }
  | { kind: 'PAT'; tokenId: string; scopes: string[]; workspaceIds: string[] }
  | { kind: 'IMPERSONATION'; administratorId: string; expiresAt: number };

export interface AuthUser {
  userId: string;
  email: string;
  /** Set by JwtAuthGuard. Optional, so code that reads only `userId` is unaffected. */
  credential?: AuthCredential;
}

/** Reads the user injected by JwtAuthGuard onto the request. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthUser;
  },
);
