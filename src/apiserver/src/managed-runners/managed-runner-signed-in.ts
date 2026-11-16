import type { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * The signed-in pass (docs/managed-runner-signed-in-accounts-design.md): with the switch on, every
 * eligible account with a live login session has a managed runner. A sign-in creates one at once
 * (ManagedRunnerService.signedIn); this pass gives one to every account that is signed in and was
 * not given one, above all those whose session began before the switch was turned on and has only
 * been refreshed since. A refresh itself still creates nothing, and no read does.
 *
 * ManagedRunnerService runs the pass once when it starts with the switch on and an available
 * environment, then every SIGNED_IN_PASS_SECONDS. Off, or unavailable, it is never constructed.
 */

/** How often the pass runs after the first. */
export const SIGNED_IN_PASS_SECONDS = 300;

/** Accounts read per page; the pass reads every page. */
export const SIGNED_IN_PAGE = 50;

/**
 * One page of the accounts the pass gives a managed runner, by id after `after`: not disabled, at
 * least one refresh token neither revoked nor expired at `now`, and no mapping at all, whatever its
 * state (a deleted one included: its data is not brought back).
 */
export async function signedInWithoutMapping(
  prisma: Pick<PrismaService, 'user'>,
  now: Date,
  after: string | null,
  take: number = SIGNED_IN_PAGE,
): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: {
      disabledAt: null,
      managedRunner: { is: null },
      refreshTokens: { some: { revokedAt: null, expiresAt: { gt: now } } },
      ...(after ? { id: { gt: after } } : {}),
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take,
  });
  return rows.map((row) => row.id);
}

/**
 * A pass run at start and then every `intervalMs`, one at a time. A pass that throws is logged and
 * the next one runs on time. The timer does not hold the process open.
 */
export class SignedInPassTimer {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pass?: Promise<void>;

  constructor(
    private readonly run: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly log: Pick<Logger, 'error'>,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.pass;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pass = this.run()
        .then(() => undefined, (error: unknown) => this.log.error(`managed runners: the signed-in pass failed: ${(error as Error).message}`))
        .finally(() => {
          this.pass = undefined;
          if (this.running) this.schedule(this.intervalMs);
        });
    }, delayMs);
    this.timer.unref?.();
  }
}
