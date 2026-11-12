import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Which door a request came in through (docs/personal-access-token-design.md §6.1): a login — the
 * JWT the Web and App sign in for — one of the user's personal access tokens, or an administrator
 * viewing Orbit as the user, read-only (auth/impersonation.ts). A login names its login session
 * (docs/push-login-session-design.md) unless its JWT was signed before sessions.
 *
 * TERMINAL is `orbit` in a terminal (docs/terminal-session-design.md, "The terminal credential"): a credential the
 * owner approved in the app for one machine's runner, for 30 days. JwtAuthGuard admits it only to the routes that
 * declare @TerminalSelf (auth/terminal-credentials.ts) and refuses it 403 everywhere else.
 *
 * FEISHU is not a request at all: an action a Feishu event asks for (docs/feishu-bot-design.md §7.2), which
 * feishu/feishu-router.ts hands straight to a service on the §7.2 allowlist (feishu/feishu-actions.ts), never
 * through JwtAuthGuard. Its user is always the account the app belongs to; `openId` is who acted in Feishu, and
 * `messageId` the message or card they acted on, when the event names one.
 */
export type AuthCredential =
  | { kind: 'LOGIN'; loginSessionId?: string }
  | { kind: 'PAT'; tokenId: string; scopes: string[]; workspaceIds: string[] }
  | { kind: 'IMPERSONATION'; administratorId: string; expiresAt: number }
  | { kind: 'TERMINAL'; terminalId: string; runnerId: string; machineName: string }
  | { kind: 'FEISHU'; appId: string; openId: string; messageId?: string };

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
