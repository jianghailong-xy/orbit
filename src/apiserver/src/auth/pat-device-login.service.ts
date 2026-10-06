import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { generateToken, generateUserCode, sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  PAT_DEFAULT_EXPIRES_IN_DAYS,
  PAT_SCOPE_PRESETS,
  type PatScopePreset,
  PatService,
  parseScopes,
  patNameOf,
} from './pat.service';

/** How long an `orbit login` waits for the browser, and how often the CLI asks: the runner device flow's. */
export const PAT_DEVICE_TTL_MS = 10 * 60 * 1000;
export const PAT_DEVICE_POLL_INTERVAL_S = 3;
/** Lookups, approvals and denials one user may make in the window: user codes are not to be guessed online. */
const LOOKUP_WINDOW_MS = 5 * 60_000;
const LOOKUP_MAX = 20;

/** What the CLI hears while it polls. `approved` is the one answer that carries the token. */
export type PatDevicePollStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'delivered';

type Row = Prisma.PatDeviceLoginGetPayload<object>;

/**
 * `orbit login` through the browser (docs/personal-access-token-design.md §7.3), in the runner device
 * flow's shape: the CLI starts a request — the token's name, scopes and lifetime, and its host — and
 * polls with the device code only it holds; a person signed in to Orbit approves or denies it at
 * /cli-login?code=<user code>.
 *
 * No token is kept in between, which is where this departs from the runner's flow (that one keeps
 * the runner credential in its row until the CLI collects it). Approving records who approved; the
 * token is issued to them by the CLI's next poll, and its answer is the only place the token ever
 * appears, so `personal_access_token` keeps holding its only trace — the sha256 (§3). A CLI that is
 * gone by then collects nothing, and no token is left behind that nobody holds.
 */
@Injectable()
export class PatDeviceLoginService {
  private readonly lookups = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pats: PatService,
  ) {}

  /**
   * Open a request for a token. Its name, scopes and lifetime are checked here as issuing checks
   * them, so a CLI asking for something no token can hold is told before anyone is sent to approve
   * it. `preset` names a set of scopes in place of listing them; one of the two, not both.
   */
  async start(input: {
    name: string;
    scopes?: string[] | null;
    preset?: PatScopePreset | null;
    expiresInDays?: number | null;
    hostname?: string | null;
  }) {
    const name = patNameOf(input.name);
    if ((input.scopes == null) === (input.preset == null)) {
      throw new BadRequestException(
        `name the token's scopes, or one preset of them (${Object.keys(PAT_SCOPE_PRESETS).join(', ')}) — one of the two`,
      );
    }
    const scopes = input.preset ? [...PAT_SCOPE_PRESETS[input.preset]] : parseScopes(input.scopes!);
    const expiresInDays = input.expiresInDays === undefined ? PAT_DEFAULT_EXPIRES_IN_DAYS : input.expiresInDays;
    const hostname = input.hostname?.trim() || null;
    const deviceCode = generateToken(32);
    const userCode = await this.create({ deviceCode, name, scopes, expiresInDays, hostname });
    return {
      deviceCode,
      userCode,
      interval: PAT_DEVICE_POLL_INTERVAL_S,
      expiresIn: PAT_DEVICE_TTL_MS / 1000,
    };
  }

  /**
   * The CLI's poll. Approved and not yet collected, it issues the token to whoever approved —
   * `created_via = CLI_DEVICE` — and answers with it, once: the row is claimed DELIVERED before the
   * token is issued, so a second poll racing this one, or retrying an answer that was lost, is told
   * `delivered` and issues nothing. An issue that is refused (the name was taken, or the cap reached,
   * since the approval checked) puts the claim back and answers the refusal.
   */
  async poll(deviceCode: string) {
    const row = await this.prisma.patDeviceLogin.findUnique({ where: { deviceCodeHash: sha256(deviceCode) } });
    if (!row) throw new NotFoundException('unknown device code');
    const status = pollStatusOf(row);
    if (status !== 'approved') return { status };
    const claimed = await this.prisma.patDeviceLogin.updateMany({
      where: { id: row.id, status: 'APPROVED' },
      data: { status: 'DELIVERED' },
    });
    if (claimed.count === 0) return { status: 'delivered' as const };
    try {
      const token = await this.pats.issue(row.decidedById!, {
        name: row.name,
        scopes: row.scopes,
        expiresInDays: row.expiresInDays,
        createdVia: 'CLI_DEVICE',
      });
      return { status, ...token };
    } catch (error) {
      await this.release(row.id);
      throw error;
    }
  }

  /**
   * The approval page's read of one request: what the CLI asked for, where it stands, and whether
   * `userId` already has a live token of that name — which approving would be refused for.
   */
  async lookup(userId: string, userCode: string) {
    this.throttle(userId);
    const row = await this.open(userCode);
    return {
      userCode: row.userCode,
      name: row.name,
      scopes: row.scopes,
      expiresInDays: row.expiresInDays,
      hostname: row.hostname,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      nameInUse: await this.pats.nameHeld(userId, row.name),
    };
  }

  /**
   * Approve a request as `userId`, whose token it becomes when the CLI collects it. Refused, with the
   * 409 issuing would answer, when the token could not be issued to them now. Approving one already
   * approved by them answers it as it stands.
   */
  async approve(userId: string, userCode: string) {
    this.throttle(userId);
    const row = await this.open(userCode);
    if (row.status === 'PENDING') {
      await this.pats.assertIssuable(userId, row.name);
      const now = new Date();
      const decided = await this.prisma.patDeviceLogin.updateMany({
        where: { id: row.id, status: 'PENDING', expiresAt: { gt: now } },
        data: { status: 'APPROVED', decidedById: userId, decidedAt: now },
      });
      if (decided.count === 1) return { status: 'APPROVED', name: row.name };
      return this.decidedAlready(userId, await this.open(userCode), 'APPROVED');
    }
    return this.decidedAlready(userId, row, 'APPROVED');
  }

  /** Deny a request: the CLI is told so, and no token is issued for it. Idempotent as `approve` is. */
  async deny(userId: string, userCode: string) {
    this.throttle(userId);
    const row = await this.open(userCode);
    if (row.status === 'PENDING') {
      const now = new Date();
      const decided = await this.prisma.patDeviceLogin.updateMany({
        where: { id: row.id, status: 'PENDING', expiresAt: { gt: now } },
        data: { status: 'DENIED', decidedById: userId, decidedAt: now },
      });
      if (decided.count === 1) return { status: 'DENIED', name: row.name };
      return this.decidedAlready(userId, await this.open(userCode), 'DENIED');
    }
    return this.decidedAlready(userId, row, 'DENIED');
  }

  /** A request still open to a decision or to its page, or 404 — gone, or past its ten minutes. */
  private async open(userCode: string): Promise<Row> {
    const row = await this.prisma.patDeviceLogin.findUnique({ where: { userCode } });
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException('login request not found or expired — run `orbit login` again');
    }
    return row;
  }

  /**
   * The answer to deciding a request someone has decided: the same decision by the same person is
   * answered as it stands; anything else is a 409 that says what it was.
   */
  private decidedAlready(userId: string, row: Row, wanted: 'APPROVED' | 'DENIED') {
    const decision = row.status === 'DENIED' ? 'DENIED' : 'APPROVED';
    if (decision === wanted && row.decidedById === userId) return { status: decision, name: row.name };
    throw new ConflictException({
      code: 'PAT_DEVICE_LOGIN_DECIDED',
      message: decision === 'DENIED'
        ? 'This login request was already denied — run `orbit login` again'
        : row.decidedById === userId
          ? 'This login request was already approved'
          : 'This login request was already approved from another account',
    });
  }

  /** Insert a request, drawing another short code on the rare collision. */
  private async create(input: {
    deviceCode: string;
    name: string;
    scopes: string[];
    expiresInDays: number | null;
    hostname: string | null;
  }): Promise<string> {
    const expiresAt = new Date(Date.now() + PAT_DEVICE_TTL_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = generateUserCode();
      try {
        await this.prisma.patDeviceLogin.create({
          data: {
            deviceCodeHash: sha256(input.deviceCode),
            userCode,
            name: input.name,
            scopes: input.scopes,
            expiresInDays: input.expiresInDays,
            hostname: input.hostname,
            expiresAt,
          },
        });
        return userCode;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new Error('could not allocate a unique user code');
  }

  /** Put back a claim whose token could not be issued, so the request reads APPROVED again. */
  private release(id: string) {
    return this.prisma.patDeviceLogin.updateMany({
      where: { id, status: 'DELIVERED' },
      data: { status: 'APPROVED' },
    });
  }

  /** At most LOOKUP_MAX lookups per user in LOOKUP_WINDOW_MS, as the runner device flow allows. */
  private throttle(userId: string): void {
    const now = Date.now();
    const recent = (this.lookups.get(userId) ?? []).filter((t) => now - t < LOOKUP_WINDOW_MS);
    if (recent.length >= LOOKUP_MAX) {
      throw new HttpException('too many login request lookups, slow down', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.lookups.set(userId, recent);
  }
}

/**
 * Where a request stands for the CLI. A decided one says so even past its ten minutes; an approval
 * not collected within them is collected no more.
 */
function pollStatusOf(row: Row): PatDevicePollStatus {
  if (row.status === 'DELIVERED') return 'delivered';
  if (row.status === 'DENIED') return 'denied';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return row.status === 'APPROVED' ? 'approved' : 'pending';
}
