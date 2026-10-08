import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { accountDisabled } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';

/** What the runner a credential names is read with: whether its owner's account is disabled, too. */
export const RUNNER_OWNER_STATE = { owner: { select: { disabledAt: true } } } as const;

/**
 * The runner a credential named, read with RUNNER_OWNER_STATE, once its owner's account is known not
 * to be disabled (docs/google-sign-in-design.md §5.5). A disabled account's runner is refused 403
 * ACCOUNT_DISABLED rather than 401: the credential is not wrong, and it works again once the account
 * is enabled.
 */
export function admitRunner({ owner, ...runner }: Runner & { owner: { disabledAt: Date | null } }): Runner {
  if (owner.disabledAt) throw accountDisabled();
  return runner;
}

@Injectable()
export class RunnerAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token =
      header && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : (req.headers['x-runner-token'] as string | undefined);

    if (!token) throw new UnauthorizedException('missing runner token');

    const runner = await this.prisma.runner.findFirst({
      where: { tokenHash: sha256(token) },
      include: RUNNER_OWNER_STATE,
    });
    if (!runner) throw new UnauthorizedException('invalid runner token');

    req.runner = admitRunner(runner);
    return true;
  }
}
