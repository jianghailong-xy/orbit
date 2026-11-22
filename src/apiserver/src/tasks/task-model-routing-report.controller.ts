import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatScope } from '../auth/pat-scope.decorator';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { SubagentRoutingReportService } from './subagent-routing-report.service';
import { TaskModelRoutingReportService } from './task-model-routing-report.service';

@UseGuards(JwtAuthGuard)
@Controller('tasks/model-routing')
export class TaskModelRoutingReportController {
  constructor(
    private readonly report: TaskModelRoutingReportService,
    private readonly subagents: SubagentRoutingReportService,
  ) {}

  @PatScope('tasks:read', { workspaceConfinable: false })
  @Get('report')
  read(
    @CurrentUser() user: AuthUser,
    @Query('since') since?: string,
    @Query('agentId', PublicIdPipe) agentId?: string,
  ) {
    return this.report.read(user.userId, since, agentId);
  }

  // The report's SubAgents and Workflows views (docs/subagent-design.md §7, board docs/mocks/subagent-workflow/08-report.html).
  @PatScope('tasks:read', { workspaceConfinable: false })
  @Get('report/subagents')
  readSubagents(
    @CurrentUser() user: AuthUser,
    @Query('since') since?: string,
    @Query('agentId', PublicIdPipe) agentId?: string,
  ) {
    return this.subagents.read(user.userId, since, agentId);
  }
}
