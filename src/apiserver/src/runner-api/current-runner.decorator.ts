import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Runner } from '@prisma/client';
import type { ManagedRunnerInstance } from '../managed-runners/managed-runner-instance';

export const CurrentRunner = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Runner => {
    return ctx.switchToHttp().getRequest().runner as Runner;
  },
);

/** The managed runner instance the runner guard authorized, or undefined for a self-managed runner. */
export const CurrentManagedRunnerInstance = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ManagedRunnerInstance | undefined =>
    ctx.switchToHttp().getRequest().managedRunnerInstance as ManagedRunnerInstance | undefined,
);
