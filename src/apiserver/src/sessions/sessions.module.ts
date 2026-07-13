import { Module } from '@nestjs/common';
import { SessionTagsModule } from '../session-tags/session-tags.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [SessionTagsModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
