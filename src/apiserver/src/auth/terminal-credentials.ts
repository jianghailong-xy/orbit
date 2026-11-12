import { ForbiddenException, Injectable, Optional, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { toUuid } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { generateToken, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import { accountDisabled, DisabledAccounts } from './disabled-accounts';

/**
 * The TERMINAL credential (docs/terminal-session-design.md, "The terminal credential"): what `orbit` in a terminal
 * acts with. Minted only when the account's owner approves a terminal sign-in in the app (terminals/
 * terminal-login.service.ts), bound to the account and to the runner the sign-in was started with, and ending 30 days
 * after that approval. Only its sha256 is kept (`terminal_credential.token_hash`).
 *
 * DENY BY DEFAULT. JwtAuthGuard verifies it here and puts `credential_kind` TERMINAL and the machine's name on the
 * request, then admits it only to a route that declares @TerminalRoute (below) — creating and driving this machine's
 * sessions, listing its workspaces, the terminal reading or revoking itself — judges what the request names against
 * the credential's runner, and refuses it 403 TERMINAL_ROUTE_NOT_ALLOWED on every other route behind the guard. It
 * never falls through to the login's authorization: a TERMINAL credential is not a JWT, and the guard decides it
 * before it reads one.
 */
export const TERMINAL_PREFIX = 'orbit_term_';
/** How long a terminal is remembered: 30 days from the owner's approval (D7 = B). */
export const TERMINAL_LIFETIME_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_USED_THROTTLE_MS = 60_000;

/** The metadata a terminal route declaration sets (@TerminalRoute, @TerminalSelf). */
export const TERMINAL_ROUTE = 'terminalRoute';

/**
 * What a TERMINAL credential may do on a route, and what the guard judges before it does (T2's allowlist,
 * docs/terminal-session-design.md "The terminal credential"). Every one of them is held to the credential's own
 * runner, and the guard refuses anything else 403 TERMINAL_RUNNER_OUT_OF_SCOPE:
 *
 *   SELF            the terminal acting on itself (reading what it is, revoking itself); nothing to judge.
 *   SESSION         `:id` names a session of the account whose assigned runner is the credential's.
 *   CREATE_SESSION  POST /sessions: the runner it names (`assignedRunnerId`) is the credential's, the workspace it
 *                   names (`workspaceId`, or the pre-rename `agentId`) lives on that runner, and it names at least one
 *                   of the two. A new workspace (`newWorkspace`) needs `assignedRunnerId` already. It may not name a
 *                   task: a terminal opens conversations, and starting a task's work stays in the app.
 *   SESSION_UPLOAD  POST /attachments: `?sessionId` names a session of the account on the credential's runner; with
 *                   none, or with `?taskId` (a task's input), it is refused.
 *   WORKSPACE_LIST  a list its handler narrows to the workspaces on the credential's runner (`terminalRunnerOf`).
 *   RUNNER_LIST     a list its handler narrows to the credential's runner alone: the engines installed on this machine.
 *   PROVIDER_LIST   the account's model providers as every client's picker reads them, keyless and endpointless
 *                   (ProvidersService.listPublic); it names nothing on a runner, so there is nothing to judge.
 */
export type TerminalRouteKind =
  | 'SELF' | 'SESSION' | 'CREATE_SESSION' | 'SESSION_UPLOAD' | 'WORKSPACE_LIST' | 'RUNNER_LIST' | 'PROVIDER_LIST';
export const TERMINAL_ROUTE_KINDS: readonly TerminalRouteKind[] = [
  'SELF', 'SESSION', 'CREATE_SESSION', 'SESSION_UPLOAD', 'WORKSPACE_LIST', 'RUNNER_LIST', 'PROVIDER_LIST',
];

/**
 * A TERMINAL credential reaches this route, judged as `kind` says. On a handler, never on a controller;
 * `terminal-route-coverage.spec.ts` holds the list exactly.
 */
export const TerminalRoute = (kind: TerminalRouteKind): MethodDecorator => SetMetadata(TERMINAL_ROUTE, kind);

/** The terminal acting on itself: reading what it is, revoking itself. */
export const TerminalSelf = (): MethodDecorator => TerminalRoute('SELF');

/** What a route admits a TERMINAL credential to, or undefined: refused. */
export function terminalRouteOf(reflector: Reflector, handler: Function): TerminalRouteKind | undefined {
  const kind = reflector.get<unknown>(TERMINAL_ROUTE, handler);
  return TERMINAL_ROUTE_KINDS.includes(kind as TerminalRouteKind) ? (kind as TerminalRouteKind) : undefined;
}

/** The 403 every other route answers a TERMINAL credential with. */
export function terminalRouteRefusal(): ForbiddenException {
  return new ForbiddenException({
    code: 'TERMINAL_ROUTE_NOT_ALLOWED',
    credentialKind: 'TERMINAL',
    message: 'A terminal credential cannot call this route; do this in the Orbit app',
  });
}

/**
 * The 403 an admitted route answers when what the request names is not on the credential's runner — or does not
 * exist, or is not the account's: the same answer, so a terminal learns nothing about what is elsewhere.
 */
export function terminalRunnerRefusal(fields: string[]): ForbiddenException {
  return new ForbiddenException({
    code: 'TERMINAL_RUNNER_OUT_OF_SCOPE',
    credentialKind: 'TERMINAL',
    fields,
    message: `A terminal credential reaches only this machine's sessions and workspaces, and ${fields.join(', ')} `
      + `${fields.length === 1 ? 'names' : 'name'} something that is not on it`,
  });
}

/** The runner a TERMINAL credential is bound to, or undefined for every other credential. */
export function terminalRunnerOf(user: AuthUser | undefined): string | undefined {
  return user?.credential?.kind === 'TERMINAL' ? user.credential.runnerId : undefined;
}

/** A verified TERMINAL credential: whose it is, and which machine it is bound to. */
export interface TerminalGrant {
  terminalId: string;
  userId: string;
  email: string;
  runnerId: string;
  machineName: string;
  expiresAt: Date;
}

@Injectable()
export class TerminalCredentials {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly disabled?: DisabledAccounts,
  ) {}

  /** A new credential's secret and the hash kept of it. */
  static newSecret(): { token: string; tokenHash: string } {
    const token = `${TERMINAL_PREFIX}${generateToken(32)}`;
    return { token, tokenHash: sha256(token) };
  }

  /** When a credential approved at `approvedAt` ends. */
  static expiryOf(approvedAt: Date): Date {
    return new Date(approvedAt.getTime() + TERMINAL_LIFETIME_DAYS * DAY_MS);
  }

  /**
   * The grant a TERMINAL credential carries, or null — answered 401 — when it names no credential, was revoked, has
   * expired, or its runner is gone (the row goes with it). A disabled account's credential is refused 403
   * ACCOUNT_DISABLED, as a personal access token is.
   */
  async verify(token: string): Promise<TerminalGrant | null> {
    if (!token.startsWith(TERMINAL_PREFIX)) return null;
    const row = await this.prisma.terminalCredential.findUnique({
      where: { tokenHash: sha256(token) },
      include: { owner: { select: { email: true } } },
    });
    const now = new Date();
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) return null;
    if (this.disabled?.has(row.ownerId)) throw accountDisabled();
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS) {
      void this.recordUse(row.id, now).catch(() => undefined);
    }
    return {
      terminalId: row.id,
      userId: row.ownerId,
      email: row.owner.email,
      runnerId: row.runnerId,
      machineName: row.machineName,
      expiresAt: row.expiresAt,
    };
  }

  /**
   * Whether what an admitted request names is on the credential's runner (TerminalRouteKind says what each kind
   * judges). Read before the route's pipes, so ids arrive as the caller sent them, base62 or uuid; one that is
   * neither names nothing on the runner and is refused with the rest.
   */
  async confine(
    req: { params?: Record<string, unknown>; query?: unknown; body?: unknown },
    kind: TerminalRouteKind,
    grant: Pick<TerminalGrant, 'userId' | 'runnerId'>,
  ): Promise<void> {
    if (kind === 'SELF' || kind === 'WORKSPACE_LIST' || kind === 'RUNNER_LIST' || kind === 'PROVIDER_LIST') return;
    const onRunner = async (value: unknown) => {
      const id = asUuid(value);
      const session = id
        ? await this.prisma.session.findFirst({ where: { id, ownerId: grant.userId }, select: { assignedRunnerId: true } })
        : null;
      return session?.assignedRunnerId === grant.runnerId;
    };
    if (kind === 'SESSION') {
      if (!(await onRunner(req.params?.id))) throw terminalRunnerRefusal([':id']);
      return;
    }
    if (kind === 'SESSION_UPLOAD') {
      const query = (req.query && typeof req.query === 'object' ? req.query : {}) as Record<string, unknown>;
      const outside: string[] = [];
      if (query.taskId !== undefined) outside.push('taskId');
      if (!(await onRunner(query.sessionId))) outside.push('sessionId');
      if (outside.length > 0) throw terminalRunnerRefusal(outside);
      return;
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const outside: string[] = [];
    if (body.taskId != null) outside.push('taskId');
    const named = (field: string) => body[field] !== undefined && body[field] !== null;
    if (named('assignedRunnerId') && asUuid(body.assignedRunnerId) !== grant.runnerId) outside.push('assignedRunnerId');
    for (const field of ['workspaceId', 'agentId']) {
      if (!named(field)) continue;
      const id = asUuid(body[field]);
      const workspace = id
        ? await this.prisma.workspace.findFirst({ where: { id, ownerId: grant.userId, deletedAt: null }, select: { runnerId: true } })
        : null;
      if (workspace?.runnerId !== grant.runnerId) outside.push(field);
    }
    // Neither named: the session would go wherever the account's routing sends it, which may be another machine.
    if (!named('assignedRunnerId') && !named('workspaceId') && !named('agentId')) outside.push('assignedRunnerId');
    if (outside.length > 0) throw terminalRunnerRefusal(outside);
  }

  /** The throttled `last_used_at` write: at most one a minute, whichever request makes it. */
  private recordUse(id: string, now: Date) {
    return this.prisma.terminalCredential.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: new Date(now.getTime() - LAST_USED_THROTTLE_MS) } }] },
      data: { lastUsedAt: now },
    });
  }
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
