import { Module } from '@nestjs/common';
import { DriveModule } from '../drive/drive.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { SessionsModule } from '../sessions/sessions.module';
import { ShareLinksModule } from '../share-links/share-links.module';
import { SharedRateLimiter } from './public-surface.guard';
import { SharedController } from './shared.controller';
import { SharedStreamGuard } from './shared-stream.guard';

// Hosts the public (unauthenticated) share routes. A token is resolved by ShareLinksService (from
// its module), and what it opens is read through SessionsService and AttachmentsService (both
// exported by theirs); its one provider of its own is the per-visitor budget PublicSurfaceGuard
// spends — one per process, at SHARED_RATE_LIMIT.
@Module({
  imports: [ShareLinksModule, SessionsModule, AttachmentsModule, DriveModule],
  controllers: [SharedController],
  providers: [{ provide: SharedRateLimiter, useValue: new SharedRateLimiter() }, SharedStreamGuard],
})
export class SharedModule {}
