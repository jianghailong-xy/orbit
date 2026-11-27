import { Controller, Get, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { PrismaService } from '../prisma/prisma.service';
import { AccountHealthService } from './account-health.service';
import { accountRowLine } from './account-health-copy';
import { accountSubjectNames } from './account-health-subject';

/** One blocked account as the owner surface reads it (docs/routing-account-health-design.md §8, item 2). */
export interface AccountHealthBlockView {
  /** The row's public id: what `POST /account-health/:id/check` takes, and what the push carries as `accountHealthID`. */
  id: string;
  /** `runner:<runnerId>:<engine>:<account>`, `provider:<providerId>` or `pool-login:<poolId>:<accountId>`. */
  subjectKey: string;
  /** The parts of the key; null where the subject has none. `account` is the sign-in's id on the runner (`default`). */
  runnerId: string | null;
  engine: string | null;
  account: string | null;
  providerId: string | null;
  poolId: string | null;
  /** '' for the whole account, else the one model the block is about. */
  scopeModel: string;
  /** A classified `RunFailureKind` (the provider said so), or `UNCLASSIFIED_ADMISSION` (Orbit's guess). */
  kind: string;
  /** The provider's own words; null for the breaker's guess. */
  said: string | null;
  trips: number;
  /** When the streak began, and when the account is tried again (ISO-8601). */
  since: string;
  nextTrialAt: string | null;
  /** A trial run is under way on the account now. */
  trialRunning: boolean;
  /** The sentence the row shows, without the times: `Needs action · Cursor said "…"`. */
  line: string;
}

/**
 * The owner's view of blocked accounts and the one thing they do about it (§8): read them, and press Check again.
 * Cool-downs and suspect accounts show nothing (§8, item 2), so they are not listed.
 */
@UseGuards(JwtAuthGuard)
@Controller('account-health')
export class AccountHealthController {
  constructor(private readonly health: AccountHealthService, private readonly prisma: PrismaService) {}

  @PatScope('workspaces:read', { workspaceConfinable: false })
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<{ blocks: AccountHealthBlockView[] }> {
    const entries = (await this.health.live(user.userId)).filter((e) => e.state === 'BLOCKED');
    const rows = entries.length
      ? await this.prisma.accountHealth.findMany({
        where: { id: { in: entries.map((e) => e.id) } },
        select: { id: true, runnerId: true, engine: true, account: true, providerId: true, poolId: true },
      })
      : [];
    const parts = new Map(rows.map((r) => [r.id, r]));
    const blocks: AccountHealthBlockView[] = [];
    for (const entry of entries) {
      const row = parts.get(entry.id);
      const names = await accountSubjectNames(this.prisma, user.userId, entry.subjectKey);
      blocks.push({
        id: entry.id,
        subjectKey: entry.subjectKey,
        runnerId: row?.runnerId ?? null,
        engine: row?.engine ?? null,
        account: row?.account ?? null,
        providerId: row?.providerId ?? null,
        poolId: row?.poolId ?? null,
        scopeModel: entry.scopeModel,
        kind: entry.kind,
        said: entry.said,
        trips: entry.trips,
        since: entry.firstAt.toISOString(),
        nextTrialAt: entry.blockedUntil?.toISOString() ?? null,
        trialRunning: entry.view === 'trial-running',
        line: accountRowLine({ product: names.product, kind: entry.kind, said: entry.said, trips: entry.trips }),
      });
    }
    return { blocks };
  }

  /**
   * Check again: the owner says the account is fixed. The block is cleared and the ladder reset, so the next routed run
   * uses the account as a healthy one, and a refusal after it is trip 1 of a new streak. 404 when the row is not the
   * owner's or was already cleared (by a success, or an earlier press): the answer is the same either way.
   */
  @PatScope('workspaces:write', { workspaceConfinable: false })
  @Post(':id/check')
  async check(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string): Promise<{ cleared: number }> {
    const cleared = await this.health.checkAgain(user.userId, id);
    if (cleared === 0) throw new NotFoundException('That account is not blocked.');
    return { cleared };
  }
}
