import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

// PrismaModule is @Global, and this service needs nothing else — a project is read and written,
// never dispatched, so neither SessionsService nor QueueService belongs here.
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
