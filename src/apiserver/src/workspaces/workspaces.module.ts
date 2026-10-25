import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  // Deleting a workspace ends the coordinator conversations that ran in it (`WorkspacesService.remove`).
  imports: [SessionsModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
})
export class WorkspacesModule {}
