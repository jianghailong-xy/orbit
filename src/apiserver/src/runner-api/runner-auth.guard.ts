import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { Runner } from '@prisma/client';
import { accountDisabled } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import { MACHINE_PROTOCOL } from '../common/machine-protocol';
import { isRunnerLinkCall } from '../common/runner-link-call';
import { authorizeManagedRunnerInstance } from '../managed-runners/managed-runner-instance';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertAfterSeqStored,
  parseRunnerLinkGatewayId,
  parseRunnerLinkRequest,
  RUNNER_LINK_TOKEN_HEADER,
  type RunnerLinkContext,
} from './runner-link-call';
import {
  RUNNER_LINK,
  runnerLinkCredential,
  runnerLinkNotConfigured,
  RunnerLinkTokenRefused,
  verifyRunnerLinkToken,
  type RunnerLinkState,
} from './runner-link-token';

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
  constructor(
    private readonly prisma: PrismaService,
    /**
     * The runner link (runner-link-token.ts), which says who a link call's runner is. Optional for the
     * specs that build this guard by hand: they make no link calls, and a link call without it is
     * refused as the link being off.
     */
    @Optional() @Inject(RUNNER_LINK) private readonly link?: RunnerLinkState,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    if (isRunnerLinkCall(req)) return this.admitLinkCall(context, req);
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

    // A disabled account's runner first: 403 ACCOUNT_DISABLED, whichever instance asks. Then a managed
    // runner's credential is accepted only from the instance the manager authorized
    // (managed-runner-instance.ts); a self-managed runner is not asked.
    const admitted = admitRunner(runner);
    req.managedRunnerInstance = await authorizeManagedRunnerInstance(this.prisma, admitted.id, req.headers);
    req.runner = admitted;
    return true;
  }

  /**
   * A call the link gateway forwarded (runner-link-call.ts). The internal listener has already taken the
   * gateway's secret; the runner is the one the link token names, read by its id, and only while it still
   * holds the credential the token was minted with — the revocation the gateway learns of by polling is
   * exact here, since the row is read anyway. Then the same account and managed-instance checks as a
   * runner token's, and the events the call waits for.
   *
   * Only the daemon protocol (`@MachineProtocol()`, RunnerApiController) is served over the link: the
   * agent tool API under /api/runner stays on HTTPS (docs/runner-link-design.md D14).
   */
  private async admitLinkCall(
    context: ExecutionContext,
    req: { headers: Record<string, string | string[] | undefined> } & Record<string, unknown>,
  ): Promise<boolean> {
    const config = this.link?.config;
    if (!config) throw runnerLinkNotConfigured();
    if (Reflect.getMetadata(MACHINE_PROTOCOL, context.getClass()) !== true) {
      throw new NotFoundException({
        code: 'RUNNER_LINK_ROUTE_NOT_ON_LINK',
        message: 'This route is not part of the runner link; runners call it over HTTPS.',
      });
    }
    const token = req.headers[RUNNER_LINK_TOKEN_HEADER];
    let claims;
    try {
      claims = verifyRunnerLinkToken(typeof token === 'string' ? token : '', config.publicKey, new Date());
    } catch (error) {
      if (!(error instanceof RunnerLinkTokenRefused)) throw error;
      throw new UnauthorizedException({
        code: 'RUNNER_LINK_TOKEN_REFUSED',
        message: `The runner's link token was refused (${error.reason}).`,
      });
    }
    const runner = await this.prisma.runner.findUnique({
      where: { id: claims.runnerId },
      include: RUNNER_OWNER_STATE,
    });
    if (!runner || runnerLinkCredential(runner.tokenHash) !== claims.credential) {
      throw new UnauthorizedException({
        code: 'RUNNER_LINK_TOKEN_REVOKED',
        message: 'The runner credential this link token was minted with was revoked.',
      });
    }
    const admitted = admitRunner(runner);
    const { requestId, afterSeq } = parseRunnerLinkRequest(req.headers);
    req.managedRunnerInstance = await authorizeManagedRunnerInstance(this.prisma, admitted.id, req.headers);
    req.runner = admitted;
    req.runnerLink = {
      leaseOwner: claims.leaseOwner,
      requestId,
      afterSeq,
      gatewayId: parseRunnerLinkGatewayId(req.headers),
    } satisfies RunnerLinkContext;
    if (afterSeq) await assertAfterSeqStored(this.prisma, admitted.id, afterSeq);
    return true;
  }
}
