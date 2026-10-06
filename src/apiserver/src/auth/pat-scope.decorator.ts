import { SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { PatScopeName } from './pat.service';

/**
 * What a personal access token may do on a route (docs/personal-access-token-design.md §4, §6.2).
 *
 * JwtAuthGuard reads these only for a request that came with a token (credential PAT); a login never
 * meets them. Every route behind JwtAuthGuard declares one or the other, and
 * `pat-route-coverage.spec.ts` fails on a route that declares neither. The guard answers such a route
 * 403 PAT_ROUTE_UNDECLARED all the same: a route nobody decided about is closed to tokens, not open.
 */
export const PAT_SCOPE = 'patScope';
export const PAT_FORBIDDEN = 'patForbidden';

/**
 * A token reaches this route only when it was granted `scope`. On a handler, never on a controller:
 * a scope is granted route by route, so a route added to a controller later is a decision of its own
 * rather than an inheritance — the census fails until its author makes it.
 */
export const PatScope = (scope: PatScopeName): MethodDecorator => SetMetadata(PAT_SCOPE, scope);

/**
 * Why a route is closed to every token, whatever it was granted. Each answers 403 with `code`
 * PAT_FORBIDDEN and the reason — OWNER_INTERACTIVE answers OWNER_INTERACTIVE_CREDENTIAL_REQUIRED (§5)
 * — and requiredAction OPEN_ORBIT: every one of them is done signed in to Orbit.
 */
export const PAT_FORBIDDEN_REASONS = {
  // §4, never grantable.
  /** auth/*: the account's password and sign-in. */
  AUTH: "The account's password and sign-in are changed in the Orbit app, never with an access token",
  /** admin/*: user and provider administration. */
  ADMIN: 'Administration is never open to an access token',
  /** The access tokens themselves (§6.5): a token cannot make or unmake tokens. */
  TOKEN_MANAGEMENT: 'An access token cannot issue, list or revoke access tokens; manage them in the Orbit app',
  /** Admitting a machine as a runner and rotating a runner's token: a leaked token must not take over a machine. */
  RUNNER_CREDENTIALS: "Admitting a machine as a runner and rotating a runner's token are done in the Orbit app, never with an access token",
  /** Share links publish what they show outside Orbit. */
  SHARE_LINK: 'Share links publish what they show outside Orbit; they are managed in the Orbit app, never with an access token',
  // §5.
  /**
   * The account owner's own decision: a route the owner channel keeps for the person signed in to
   * Orbit — one that refuses a request carrying an agent session, or that answers what was put to
   * the owner (cards, approvals, evidence, criteria, promotions, handoffs).
   */
  OWNER_INTERACTIVE: "This is the account owner's own decision, made signed in to Orbit; an access token cannot make it",
  // Outside every scope §4 defines.
  /** The account itself: profile, photo, preferences and push devices. */
  ACCOUNT: 'Your account (profile, photo, preferences, push devices) is changed in the Orbit app, not with an access token',
  /** runners:read is the only runner scope: a runner is changed or driven only from the app. */
  RUNNER_CONTROL: 'An access token can read runners (runners:read) but not change or drive them; do that in the Orbit app',
  /** A stored secret shown in the clear. */
  SECRET_REVEAL: 'A stored key is shown in the clear only in the Orbit app',
  /** A route no scope covers. */
  NO_SCOPE: 'No access token scope covers this route',
} as const;
export type PatForbiddenReason = keyof typeof PAT_FORBIDDEN_REASONS;

/** No token reaches this route, for `reason`. On a handler, or on a controller to close every route it has and will have. */
export const PatForbidden = (reason: PatForbiddenReason) => SetMetadata(PAT_FORBIDDEN, reason);

/** What a route declares for tokens. */
export type PatDeclaration =
  | { kind: 'FORBIDDEN'; reason: PatForbiddenReason }
  | { kind: 'SCOPE'; scope: PatScopeName }
  | { kind: 'UNDECLARED' };

/**
 * A route's declaration, read the one way JwtAuthGuard and the census both read it: a refusal on the
 * handler or its controller wins over everything; otherwise the handler's own scope; otherwise none.
 */
export function patDeclaration(reflector: Reflector, handler: Function, controller: Function): PatDeclaration {
  const reason = reflector.getAllAndOverride<PatForbiddenReason | undefined>(PAT_FORBIDDEN, [handler, controller]);
  if (reason) return { kind: 'FORBIDDEN', reason };
  const scope = reflector.get<PatScopeName | undefined>(PAT_SCOPE, handler);
  if (scope) return { kind: 'SCOPE', scope };
  return { kind: 'UNDECLARED' };
}

/** The 403 a forbidden route answers a token with. */
export function patForbiddenBody(reason: PatForbiddenReason) {
  return {
    code: reason === 'OWNER_INTERACTIVE' ? 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED' : 'PAT_FORBIDDEN',
    reason,
    requiredAction: 'OPEN_ORBIT',
    message: PAT_FORBIDDEN_REASONS[reason],
  };
}
