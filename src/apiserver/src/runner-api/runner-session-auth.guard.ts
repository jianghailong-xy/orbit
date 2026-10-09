import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { sha256 } from '../common/crypto.util';
import { authorizeManagedRunnerInstance } from '../managed-runners/managed-runner-instance';
import { PrismaService } from '../prisma/prisma.service';
import { RUNNER_OWNER_STATE, admitRunner } from './runner-auth.guard';
import { ServiceTokenAuthorizer, ServiceTokenGrant } from './service-token.authorizer';

/**
 * Authenticates the session routes with EITHER the machine's runner credential or a service
 * token minted for that machine.
 *
 * Only these routes accept a service token. Every other runner-API route — claim, heartbeat,
 * event reporting — keeps RunnerAuthGuard and the runner credential, so a narrow bridge token
 * can never be used to impersonate the machine itself.
 */
@Injectable()
export class RunnerSessionAuthGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly serviceTokens: ServiceTokenAuthorizer,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token =
      header && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : (req.headers['x-runner-token'] as string | undefined);

    if (!token) throw new UnauthorizedException('missing runner token');

    const runner = await this.prisma.runner.findFirst({ where: { tokenHash: sha256(token) }, include: RUNNER_OWNER_STATE });
    if (runner) {
      // As on RunnerAuthGuard's routes: a disabled account's runner is refused first, then a managed
      // runner's machine credential is bound to its authorized instance.
      const admitted = admitRunner(runner);
      req.managedRunnerInstance = await authorizeManagedRunnerInstance(this.prisma, admitted.id, req.headers);
      req.runner = admitted;
      return true;
    }

    const grant = await this.serviceTokens.verify(token);
    if (!grant) throw new UnauthorizedException('invalid runner token');
    req.runner = grant.runner;
    req.serviceGrant = grant;
    return true;
  }
}

/** The service-token grant behind this request, or undefined when a runner credential was used. */
export const CurrentServiceGrant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ServiceTokenGrant | undefined =>
    ctx.switchToHttp().getRequest().serviceGrant,
);
