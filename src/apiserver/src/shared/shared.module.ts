import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SharedRateLimiter } from './public-surface.guard';
import { SharedController } from './shared.controller';

// Hosts the public (unauthenticated) share routes. It reuses SessionsService and
// AttachmentsService from their modules (both export the service); its one provider of its own
// is the per-visitor budget PublicSurfaceGuard spends — one per process, at SHARED_RATE_LIMIT.
@Module({
  imports: [SessionsModule, AttachmentsModule],
  controllers: [SharedController],
  providers: [{ provide: SharedRateLimiter, useValue: new SharedRateLimiter() }],
})
export class SharedModule {}
