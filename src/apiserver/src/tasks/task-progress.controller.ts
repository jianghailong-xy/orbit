import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { ReportTaskProgressDto } from './dto';
import { TaskProgressService } from './task-progress.service';

/** A Task's structured progress: read it, or report a change to it (docs/watch-contract.md §12). */
@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TaskProgressController {
  constructor(private readonly progress: TaskProgressService) {}

  @Get(':id/progress')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.progress.get(user.userId, id);
  }

  /** Each field named replaces that field and `null` clears it; `expectedRevision` makes the report a compare-and-set. */
  @Post(':id/progress')
  @HttpCode(HttpStatus.OK)
  report(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: ReportTaskProgressDto) {
    return this.progress.report(user.userId, id, dto);
  }
}
