import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma, Runner } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { generateToken, sha256 } from '../common/crypto.util';
import type { AuthCredential } from '../common/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TerminalCredentials } from '../auth/terminal-credentials';

/** How long a terminal waits for the owner's tap, and how often the CLI asks: the device flows' ten minutes and three seconds. */
export const TERMINAL_LOGIN_TTL_MS = 10 * 60 * 1000;
export const TERMINAL_LOGIN_POLL_INTERVAL_S = 3;
/** Requests one runner may hold open at once: enough for a person retrying, not for a loop ringing the owner's phone. */
export const TERMINAL_LOGIN_OPEN_MAX = 3;

/** What the CLI hears while it polls. `approved` is the one answer that carries the credential. */
export type TerminalLoginPollStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'delivered';

type Row = Prisma.TerminalLoginGetPayload<object>;

// The terminal's short code (`7KQ-4MZ`): the device flows' alphabet, without the glyphs that are easy to confuse. It
// is only compared by eye, the terminal's with the card's — nothing looks a request up by it — so six symbols do.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function terminalUserCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

/**
 * The terminal sign-in (docs/terminal-session-design.md, "The terminal credential"), in the shape of `orbit login`'s
 * device flow (auth/pat-device-login.service.ts):
 *
 *   - the CLI starts a request with the machine's RUNNER credential, so the request is bound to that runner and to
 *     its owner from the start, and polls for its credential with the device code only it holds (and the same runner
 *     credential);
 *   - the account's owner approves or denies it in the app — an owner-channel act, closed to a personal access token,
 *     a runner credential and a TERMINAL credential alike (TerminalsController);
 *   - approving mints nothing yet: the CLI's next poll mints the TERMINAL credential, bound to the account and the
 *     runner and ending 30 days after the approval, and that answer is the only place the credential ever appears.
 *
 * The owner learns of a request by a push (PushService.notifyTerminalLogin) and `terminals.changed` on the control
 * stream; the card reads `GET /terminals/requests`.
 */
@Injectable()
export class TerminalLoginService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
    @Optional() private readonly push?: PushService,
  ) {}

  /**
   * Open a request for the runner's machine. Its name is the runner's as the app shows it — never what the CLI says —
   * so the card names the machine the owner knows. A runner already holding TERMINAL_LOGIN_OPEN_MAX open requests is
   * refused 429.
   */
  async start(runner: Pick<Runner, 'id' | 'ownerId' | 'name' | 'displayName'>) {
    const now = new Date();
    const open = await this.prisma.terminalLogin.count({
      where: { runnerId: runner.id, status: 'PENDING', expiresAt: { gt: now } },
    });
    if (open >= TERMINAL_LOGIN_OPEN_MAX) {
      throw new HttpException({
        code: 'TERMINAL_LOGIN_TOO_MANY',
        message: 'This machine already has terminal sign-ins waiting for approval; approve or deny them in the Orbit app first',
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const deviceCode = generateToken(32);
    const machineName = runner.displayName?.trim() || runner.name;
    const row = await this.create({ deviceCode, runner, machineName, expiresAt: new Date(now.getTime() + TERMINAL_LOGIN_TTL_MS) });
    this.realtime?.publishTerminalsChanged(runner.ownerId, row.id);
    void this.push?.notifyTerminalLogin(row.id);
    return {
      deviceCode,
      userCode: row.userCode,
      machineName,
      interval: TERMINAL_LOGIN_POLL_INTERVAL_S,
      expiresIn: TERMINAL_LOGIN_TTL_MS / 1000,
    };
  }

  /**
   * The CLI's poll, made with the same runner's credential. Approved and not yet collected, it mints the TERMINAL
   * credential — ending 30 days after the approval — and answers it, once: the row is claimed DELIVERED first, so a
   * second poll racing this one, or retrying a lost answer, is told `delivered` and mints nothing.
   */
  async poll(runner: Pick<Runner, 'id'>, deviceCode: string) {
    const row = await this.prisma.terminalLogin.findUnique({ where: { deviceCodeHash: sha256(deviceCode) } });
    if (!row || row.runnerId !== runner.id) throw new NotFoundException('unknown device code');
    const status = pollStatusOf(row);
    if (status !== 'approved') return { status };
    const claimed = await this.prisma.terminalLogin.updateMany({
      where: { id: row.id, status: 'APPROVED' },
      data: { status: 'DELIVERED' },
    });
    if (claimed.count === 0) return { status: 'delivered' as const };
    try {
      const minted = await this.mint(row);
      this.realtime?.publishTerminalsChanged(row.ownerId, minted.id);
      return { status, token: minted.token, terminalId: minted.id, machineName: row.machineName, expiresAt: minted.expiresAt };
    } catch (error) {
      await this.release(row.id);
      throw error;
    }
  }

  /** The owner's open requests, newest first: what the approve card shows. */
  async pending(userId: string) {
    const rows = await this.prisma.terminalLogin.findMany({
      where: { ownerId: userId, status: 'PENDING', expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, userCode: true, machineName: true, runnerId: true, createdAt: true, expiresAt: true },
    });
    return { requests: rows };
  }

  /**
   * Approve or deny one of the owner's requests. A request of another account, or past its ten minutes, is 404.
   * Deciding it the same way again answers it as it stands; deciding it the other way is 409.
   */
  async decide(userId: string, id: string, decision: 'APPROVED' | 'DENIED') {
    const row = await this.open(userId, id);
    if (row.status === 'PENDING') {
      const now = new Date();
      const decided = await this.prisma.terminalLogin.updateMany({
        where: { id: row.id, ownerId: userId, status: 'PENDING', expiresAt: { gt: now } },
        data: { status: decision, decidedAt: now },
      });
      if (decided.count === 1) {
        this.realtime?.publishTerminalsChanged(userId, row.id);
        return this.decisionOf({ ...row, status: decision, decidedAt: now });
      }
      return this.decidedAlready(await this.open(userId, id), decision);
    }
    return this.decidedAlready(row, decision);
  }

  /** The owner's live terminals — not revoked, not expired — newest first: Settings → Terminals. */
  async list(userId: string) {
    const rows = await this.prisma.terminalCredential.findMany({
      where: { ownerId: userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: TERMINAL_VIEW,
    });
    return { terminals: rows };
  }

  /** Revoke one of the owner's terminals at once: its next request is 401. Revoking it again answers it as it stands. */
  async revoke(userId: string, id: string) {
    const now = new Date();
    await this.prisma.terminalCredential.updateMany({
      where: { id, ownerId: userId, revokedAt: null },
      data: { revokedAt: now },
    });
    const row = await this.prisma.terminalCredential.findFirst({ where: { id, ownerId: userId }, select: { ...TERMINAL_VIEW, revokedAt: true } });
    if (!row) throw new NotFoundException('terminal not found');
    this.realtime?.publishTerminalsChanged(userId, id);
    return row;
  }

  /** The terminal reading itself (`orbit` saying what it is signed in as). */
  async self(userId: string, credential: AuthCredential | undefined) {
    const terminalId = terminalIdOf(credential);
    const row = await this.prisma.terminalCredential.findFirst({
      where: { id: terminalId, ownerId: userId },
      select: { ...TERMINAL_VIEW, owner: { select: { email: true } } },
    });
    if (!row) throw new NotFoundException('terminal not found');
    const { owner, ...terminal } = row;
    return { email: owner.email, terminal };
  }

  /** The terminal revoking itself (`orbit logout` in a terminal). */
  revokeSelf(userId: string, credential: AuthCredential | undefined) {
    return this.revoke(userId, terminalIdOf(credential));
  }

  /** Insert a request. Its code is not unique: nothing looks it up, the owner compares it by eye. */
  private create(input: {
    deviceCode: string;
    runner: Pick<Runner, 'id' | 'ownerId'>;
    machineName: string;
    expiresAt: Date;
  }) {
    return this.prisma.terminalLogin.create({
      data: {
        deviceCodeHash: sha256(input.deviceCode),
        userCode: terminalUserCode(),
        ownerId: input.runner.ownerId,
        runnerId: input.runner.id,
        machineName: input.machineName,
        expiresAt: input.expiresAt,
      },
      select: { id: true, userCode: true },
    });
  }

  /** Mint the credential a claimed request asked for, bound to its account and runner, ending 30 days after the approval. */
  private async mint(row: Row) {
    const { token, tokenHash } = TerminalCredentials.newSecret();
    const approvedAt = row.decidedAt!;
    const created = await this.prisma.terminalCredential.create({
      data: {
        tokenHash,
        ownerId: row.ownerId,
        runnerId: row.runnerId,
        machineName: row.machineName,
        approvedAt,
        expiresAt: TerminalCredentials.expiryOf(approvedAt),
      },
      select: { id: true, expiresAt: true },
    });
    return { token, ...created };
  }

  /** Put back a claim whose credential could not be minted, so the request reads APPROVED again. */
  private release(id: string) {
    return this.prisma.terminalLogin.updateMany({
      where: { id, status: 'DELIVERED' },
      data: { status: 'APPROVED' },
    });
  }

  /** One of the owner's requests still within its ten minutes, or 404 — another account's answers as a missing one. */
  private async open(userId: string, id: string): Promise<Row> {
    const row = await this.prisma.terminalLogin.findFirst({ where: { id, ownerId: userId } });
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException('terminal sign-in not found or expired — run `orbit` in the terminal again');
    }
    return row;
  }

  private decisionOf(row: Pick<Row, 'id' | 'status' | 'machineName' | 'userCode' | 'decidedAt'>) {
    const status = row.status === 'DENIED' ? 'DENIED' : 'APPROVED';
    return { id: row.id, status, machineName: row.machineName, userCode: row.userCode, decidedAt: row.decidedAt };
  }

  private decidedAlready(row: Row, wanted: 'APPROVED' | 'DENIED') {
    const decision = row.status === 'DENIED' ? 'DENIED' : 'APPROVED';
    if (decision === wanted) return this.decisionOf(row);
    throw new ConflictException({
      code: 'TERMINAL_LOGIN_DECIDED',
      message: decision === 'DENIED'
        ? 'This terminal sign-in was already denied — run `orbit` in the terminal again'
        : 'This terminal sign-in was already approved',
    });
  }
}

/** What a terminal's row shows: never its hash. */
const TERMINAL_VIEW = {
  id: true,
  machineName: true,
  runnerId: true,
  createdAt: true,
  approvedAt: true,
  lastUsedAt: true,
  expiresAt: true,
} as const;

/** The terminal a @TerminalSelf request came with; JwtAuthGuard admits no other credential to those routes as a terminal. */
function terminalIdOf(credential: AuthCredential | undefined): string {
  if (credential?.kind !== 'TERMINAL') {
    throw new ForbiddenException({
      code: 'TERMINAL_CREDENTIAL_REQUIRED',
      message: 'This route answers a terminal about itself; call it with the terminal credential `orbit` signed in with',
    });
  }
  return credential.terminalId;
}

/** Where a request stands for the CLI. A decided one says so past its ten minutes; an approval not collected within them is collected no more. */
function pollStatusOf(row: Row): TerminalLoginPollStatus {
  if (row.status === 'DELIVERED') return 'delivered';
  if (row.status === 'DENIED') return 'denied';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return row.status === 'APPROVED' ? 'approved' : 'pending';
}
