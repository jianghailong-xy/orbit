import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { RunnerAttentionFixController } from './runner-attention-fix.controller';
import { RunnerAttentionFixService } from './runner-attention-fix.service';

/**
 * Fix with an agent's door: a module of its own because it makes sessions through SessionsService.create,
 * and RunnersModule injects nothing from Sessions. GET /runners reads the same answer (attention-fix.ts)
 * through Prisma alone.
 */
@Module({
  imports: [SessionsModule],
  controllers: [RunnerAttentionFixController],
  providers: [RunnerAttentionFixService],
})
export class RunnerAttentionFixModule {}
