import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Runner } from '@prisma/client';

export const CurrentRunner = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Runner => {
    return ctx.switchToHttp().getRequest().runner as Runner;
  },
);
