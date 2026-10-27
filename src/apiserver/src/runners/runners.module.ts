import { Module } from '@nestjs/common';
import { CodexRateLimitResetController } from './codex-rate-limit-reset.controller';
import { CodexRateLimitResetRepository } from './codex-rate-limit-reset.repository';
import { CodexRateLimitResetService } from './codex-rate-limit-reset.service';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

@Module({
  controllers: [RunnersController, CodexRateLimitResetController],
  providers: [RunnersService, CodexRateLimitResetService, CodexRateLimitResetRepository],
  // The engine relay an in-session agent drives (runner-api/runner-engine-install.controller.ts) is
  // this one service's, so the web's Install and the agent's start and read the same relay.
  exports: [RunnersService],
})
export class RunnersModule {}
