import { Module } from '@nestjs/common';
import { WikiModule } from '../wiki/wiki.module';
import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';

// Public links: the owner's routes here, the public door in SharedModule — which imports this
// module for the one service both halves resolve links through. A wiki link's pages are read through
// the wiki's own document reads, which WikiModule exports (WikiDocs).
@Module({
  imports: [WikiModule],
  controllers: [ShareLinksController],
  providers: [ShareLinksService],
  exports: [ShareLinksService],
})
export class ShareLinksModule {}
