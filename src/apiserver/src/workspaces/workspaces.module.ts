import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { MainCheckoutService } from './main-checkout.service';

@Module({
  // Deleting a workspace ends the coordinator conversations that ran in it (`WorkspacesService.remove`).
  imports: [SessionsModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, MainCheckoutService],
})
export class WorkspacesModule {}
