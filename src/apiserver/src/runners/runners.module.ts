import { Module } from '@nestjs/common';
import { CodexRateLimitResetController } from './codex-rate-limit-reset.controller';
import { CodexRateLimitResetRepository } from './codex-rate-limit-reset.repository';
import { CodexRateLimitResetService } from './codex-rate-limit-reset.service';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

@Module({
  controllers: [RunnersController, CodexRateLimitResetController],
  providers: [RunnersService, CodexRateLimitResetService, CodexRateLimitResetRepository],
})
export class RunnersModule {}
