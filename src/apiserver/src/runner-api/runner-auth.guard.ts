import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { sha256 } from '../common/crypto.util';
import { authorizeManagedRunnerInstance } from '../managed-runners/managed-runner-instance';
import { PrismaService } from '../prisma/prisma.service';

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
    });
    if (!runner) throw new UnauthorizedException('invalid runner token');

    // A managed runner's credential is accepted only from the instance the manager authorized
    // (managed-runner-instance.ts); a self-managed runner is not asked.
    req.managedRunnerInstance = await authorizeManagedRunnerInstance(this.prisma, runner.id, req.headers);
    req.runner = runner;
    return true;
  }
}
