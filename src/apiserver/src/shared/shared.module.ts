import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ShareLinksModule } from '../share-links/share-links.module';
import { SharedRateLimiter } from './public-surface.guard';
import { SharedController } from './shared.controller';

// Hosts the public (unauthenticated) share routes. A token is resolved by ShareLinksService (from
// its module), and what it opens is read through SessionsService and AttachmentsService (both
// exported by theirs); its one provider of its own is the per-visitor budget PublicSurfaceGuard
// spends — one per process, at SHARED_RATE_LIMIT.
@Module({
  imports: [ShareLinksModule, SessionsModule, AttachmentsModule],
  controllers: [SharedController],
  providers: [{ provide: SharedRateLimiter, useValue: new SharedRateLimiter() }],
})
export class SharedModule {}
