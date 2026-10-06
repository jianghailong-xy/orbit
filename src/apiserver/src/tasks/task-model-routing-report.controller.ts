import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { TaskModelRoutingReportService } from './task-model-routing-report.service';

@UseGuards(JwtAuthGuard)
@Controller('tasks/model-routing')
export class TaskModelRoutingReportController {
  constructor(private readonly report: TaskModelRoutingReportService) {}

  @PatScope('tasks:read')
  @Get('report')
  read(
    @CurrentUser() user: AuthUser,
    @Query('since') since?: string,
    @Query('agentId', PublicIdPipe) agentId?: string,
  ) {
    return this.report.read(user.userId, since, agentId);
  }
}
