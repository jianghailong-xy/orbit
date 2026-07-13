import { Module } from '@nestjs/common';
import { SessionTagsController } from './session-tags.controller';
import { SessionTagsService } from './session-tags.service';

@Module({
  controllers: [SessionTagsController],
  providers: [SessionTagsService],
  exports: [SessionTagsService],
})
export class SessionTagsModule {}
