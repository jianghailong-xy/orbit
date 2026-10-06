import { ForbiddenException, SetMetadata, applyDecorators } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AuthCredential, AuthUser } from '../common/current-user.decorator';
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
export const PAT_WORKSPACE = 'patWorkspace';

/** What a request names that a token confined to workspaces is judged on: each must sit in one of them. */
export type PatWorkspaceObject = 'task' | 'session' | 'workspace';

/**
 * Whether a token confined to workspaces (`workspace_ids` not empty, §6.3 v1) reaches a route — the
 * census's `workspaceConfinable`. A task sits in the workspace it is assigned to, a session in its
 * workspace, a workspace in itself; something in none sits in none of the token's.
 *
 * - `false`: what the route reads or writes cannot be told by workspace (a project, the wiki, an
 *   aggregate over everything). A confined token is refused 403 PAT_ROUTE_NOT_WORKSPACE_CONFINABLE.
 * - `'LIST'`: the route answers a list, and its handler narrows it to the token's workspaces
 *   (`workspaceConfinement`).
 * - Otherwise the route acts on the tasks, sessions and workspaces its request names, and JwtAuthGuard
 *   admits a confined token only when every one of them sits in its workspaces — 403
 *   PAT_WORKSPACE_OUT_OF_SCOPE before the handler runs, when one does not or cannot be found.
 */
export type PatWorkspaceConfinable = false | 'LIST' | PatWorkspaceTargets;

export interface PatWorkspaceTargets {
  /** Path params, each naming the task, session or workspace the route reads or writes. */
  readonly params?: Readonly<Record<string, PatWorkspaceObject>>;
  /**
   * Body fields (query fields alike), each naming the workspace a write puts something in, or a task
   * or session it ties to (a list: each of its items). Matched by name at any depth. A request naming
   * anything else by id — a body or query field `PUBLIC_ID_FIELDS` lists and this does not — is
   * refused: the token's workspaces cannot vouch for it. A null workspace is none of them; a null task
   * or session names nothing.
   */
  readonly body?: Readonly<Record<string, PatWorkspaceObject>>;
  /**
   * Body fields a confined token must send: the workspace what the route makes is made in, so that
   * nothing it makes sits outside its workspaces. `a.b` is required whenever the body has `a`.
   */
  readonly requires?: readonly string[];
}

/**
 * A token reaches this route only when it was granted `scope`, and a token confined to workspaces
 * only as `workspaceConfinable` says. On a handler, never on a controller: a scope is granted route by
 * route, so a route added to a controller later is a decision of its own rather than an inheritance —
 * the census fails until its author makes it.
 */
export const PatScope = (
  scope: PatScopeName,
  { workspaceConfinable }: { workspaceConfinable: PatWorkspaceConfinable },
): MethodDecorator => applyDecorators(SetMetadata(PAT_SCOPE, scope), SetMetadata(PAT_WORKSPACE, workspaceConfinable));

/**
 * The workspaces a `'LIST'` route narrows its answer to: those of a token confined to workspaces, and
 * undefined — the whole list, as before — for a login and for a token confined to none.
 */
export function workspaceConfinement(user: AuthUser): readonly string[] | undefined {
  const credential = user.credential;
  return credential?.kind === 'PAT' && credential.workspaceIds.length > 0 ? credential.workspaceIds : undefined;
}

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

/** What a route declares for tokens. `workspaceConfinable` is missing only where @PatScope was bypassed. */
export type PatDeclaration =
  | { kind: 'FORBIDDEN'; reason: PatForbiddenReason }
  | { kind: 'SCOPE'; scope: PatScopeName; workspaceConfinable?: PatWorkspaceConfinable }
  | { kind: 'UNDECLARED' };

/**
 * A route's declaration, read the one way JwtAuthGuard and the census both read it: a refusal on the
 * handler or its controller wins over everything; otherwise the handler's own scope; otherwise none.
 */
export function patDeclaration(reflector: Reflector, handler: Function, controller: Function): PatDeclaration {
  const reason = reflector.getAllAndOverride<PatForbiddenReason | undefined>(PAT_FORBIDDEN, [handler, controller]);
  if (reason) return { kind: 'FORBIDDEN', reason };
  const scope = reflector.get<PatScopeName | undefined>(PAT_SCOPE, handler);
  if (scope) {
    return { kind: 'SCOPE', scope, workspaceConfinable: reflector.get<PatWorkspaceConfinable | undefined>(PAT_WORKSPACE, handler) };
  }
  return { kind: 'UNDECLARED' };
}

/**
 * The 403 that refuses a token something it may not do: everything JwtAuthGuard refuses a verified
 * token, and a field only the owner sets (`refuseOwnerFieldsToToken`). A class of its own so the
 * request audit can tell a token reaching past its grant from every other 403 a route answers, and
 * record it as `pat.request.denied` with its code (§6.4). Its body is the one the caller is shown.
 */
export class PatRefusal extends ForbiddenException {}

/** The 403 a forbidden route answers a token with. */
export function patForbiddenBody(reason: PatForbiddenReason) {
  return {
    code: reason === 'OWNER_INTERACTIVE' ? 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED' : 'PAT_FORBIDDEN',
    reason,
    requiredAction: 'OPEN_ORBIT',
    message: PAT_FORBIDDEN_REASONS[reason],
  };
}

/**
 * §5 field by field. A route a token reaches with its scope can still carry a field that is the
 * account owner's own decision — a project's status, integration line or acceptance criteria, a wiki
 * space's review mode or maintenance, a session's permission mode. The service that writes such a
 * field calls this with the request's credential and those fields, before it writes anything: a token
 * that sent any of them is refused the whole request, with the 403 an OWNER_INTERACTIVE route answers
 * plus the fields it named. A login, and a caller with no credential (the runner door, the server's
 * own callers), is never refused here.
 */
export function refuseOwnerFieldsToToken(credential: AuthCredential | undefined, fields: Record<string, unknown>): void {
  if (credential?.kind !== 'PAT') return;
  const sent = Object.keys(fields).filter((field) => fields[field] !== undefined);
  if (sent.length === 0) return;
  const one = sent.length === 1;
  throw new PatRefusal({
    ...patForbiddenBody('OWNER_INTERACTIVE'),
    message: `${sent.join(', ')} ${one ? 'is' : 'are'} the account owner's own decision, made signed in to Orbit; `
      + `an access token cannot set ${one ? 'it' : 'them'}, and nothing this request carried was written`,
    fields: sent,
  });
}
