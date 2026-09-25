import { Module } from '@nestjs/common';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';

// Public links: the owner's routes here, the public door in SharedModule — which imports this
// module for the one service both halves resolve links through.
@Module({
  controllers: [ShareLinksController],
  providers: [ShareLinksService],
  exports: [ShareLinksService],
})
export class ShareLinksModule {}
