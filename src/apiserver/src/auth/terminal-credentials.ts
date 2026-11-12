import { ForbiddenException, Injectable, Optional, SetMetadata } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
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
 * request, then admits it only to a route that declares @TerminalSelf — the terminal reading or revoking itself — and
 * refuses it 403 TERMINAL_ROUTE_NOT_ALLOWED on every other route behind the guard. It never falls through to the
 * login's authorization: a TERMINAL credential is not a JWT, and the guard decides it before it reads one.
 */
export const TERMINAL_PREFIX = 'orbit_term_';
/** How long a terminal is remembered: 30 days from the owner's approval (D7 = B). */
export const TERMINAL_LIFETIME_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_USED_THROTTLE_MS = 60_000;

/** The metadata @TerminalSelf sets. */
export const TERMINAL_SELF = 'terminalSelf';

/**
 * A TERMINAL credential reaches this route: the terminal acting on itself (reading what it is, revoking itself).
 * On a handler, never on a controller; `pat-route-coverage.spec.ts` holds the list exactly.
 */
export const TerminalSelf = (): MethodDecorator => SetMetadata(TERMINAL_SELF, true);

/** Whether a route admits a TERMINAL credential. */
export function terminalAdmitted(reflector: Reflector, handler: Function): boolean {
  return reflector.get<boolean | undefined>(TERMINAL_SELF, handler) === true;
}

/** The 403 every other route answers a TERMINAL credential with. */
export function terminalRouteRefusal(): ForbiddenException {
  return new ForbiddenException({
    code: 'TERMINAL_ROUTE_NOT_ALLOWED',
    credentialKind: 'TERMINAL',
    message: 'A terminal credential cannot call this route; do this in the Orbit app',
  });
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

  /** The throttled `last_used_at` write: at most one a minute, whichever request makes it. */
  private recordUse(id: string, now: Date) {
    return this.prisma.terminalCredential.updateMany({
      where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lte: new Date(now.getTime() - LAST_USED_THROTTLE_MS) } }] },
      data: { lastUsedAt: now },
    });
  }
}
