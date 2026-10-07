import { ForbiddenException, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How soon a disable written anywhere reaches JwtAuthGuard on every server (docs/google-sign-in-design.md
 * §5.5): "within half a minute".
 */
export const DISABLED_ACCOUNTS_WITHIN_MS = 30_000;

/**
 * How often JwtAuthGuard's view of the disabled accounts is read again: short of DISABLED_ACCOUNTS_WITHIN_MS
 * by the read's own query and the timer's lateness, so a disable written just after one read is in the
 * next within the 30 seconds promised, not 30 seconds and a query later.
 */
export const DISABLED_ACCOUNTS_RELOAD_MS = 25_000;

/** The code a disabled account is refused with, at every door but an access token's. */
export const ACCOUNT_DISABLED = 'ACCOUNT_DISABLED';

/**
 * A disabled account at a door that answers it 403 (§5.5): the password login, the Google exchange,
 * the refresh, a personal access token, a runner credential and a service token. Never a 401: a
 * client answers a 401 by refreshing and dropping the body, and the Apple clients would then tell the
 * person their password is wrong.
 */
export const accountDisabled = () =>
  new ForbiddenException({
    code: ACCOUNT_DISABLED,
    message: 'This Orbit account is disabled. Ask an administrator to enable it again.',
  });

/**
 * The accounts an administrator has disabled, as JwtAuthGuard reads them on every request (§5.5):
 * held in memory and read again from the database every DISABLED_ACCOUNTS_RELOAD_MS, so a disable
 * reaches every access token and personal access token within half a minute without a query per
 * request. The administrator's own change reads them again at once, so on the server that made it,
 * it applies immediately.
 */
@Injectable()
export class DisabledAccounts implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DisabledAccounts.name);
  private ids: ReadonlySet<string> = new Set();
  private timer?: ReturnType<typeof setInterval>;
  /** Reads run one after another, so the last one asked for is the last one applied. */
  private reading: Promise<void> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload(), DISABLED_ACCOUNTS_RELOAD_MS);
    // Not a reason on its own to keep a process alive.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Whether `userId` was disabled when the accounts were last read. */
  has(userId: string): boolean {
    return this.ids.has(userId);
  }

  /**
   * Read the disabled accounts again. Queued behind a read already out, so a change committed before
   * this is called is in the set once it resolves. A read that fails keeps what was read before.
   */
  reload(): Promise<void> {
    this.reading = this.reading.then(async () => {
      try {
        const rows = await this.prisma.user.findMany({ where: { disabledAt: { not: null } }, select: { id: true } });
        this.ids = new Set(rows.map((row) => row.id));
      } catch (error) {
        this.log.warn(
          `could not read the disabled accounts; the ${this.ids.size} read before still apply: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    return this.reading;
  }
}
