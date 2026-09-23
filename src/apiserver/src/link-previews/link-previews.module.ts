import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { TasksModule } from '../tasks/tasks.module';
import { LinkPreviewsController } from './link-previews.controller';
import { LinkPreviewsService } from './link-previews.service';

@Module({
  // Imported, never re-provided: both modules export their one instance, and a second TasksService
  // would start a second reconcile timer (see TasksModule's exports).
  imports: [SessionsModule, TasksModule],
  controllers: [LinkPreviewsController],
  providers: [LinkPreviewsService],
})
export class LinkPreviewsModule {}
