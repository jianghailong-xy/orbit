import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PublicIdPipe } from '../common/public-id';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import {
  CreateTaskListDto,
  OpenTaskListConsoleDto,
  RestoreTaskListRevisionDto,
  UpdateTaskListDto,
} from './dto';
import { TaskListsService } from './task-lists.service';

@UseGuards(JwtAuthGuard)
@Controller('task-lists')
export class TaskListsController {
  constructor(private readonly taskLists: TaskListsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskListDto) {
    return this.taskLists.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.taskLists.list(user.userId);
  }

  /**
   * One list. `?tasks=none` drops the embedded tasks — see `getHeader`, and use
   * `GET /tasks/page?listId=…` to read the contents a page at a time.
   */
  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('tasks') tasks?: string,
  ) {
    const mode = tasks?.trim().toLowerCase();
    if (mode !== undefined && mode !== 'none') {
      throw new BadRequestException("tasks must be 'none' when set");
    }
    return mode === 'none'
      ? this.taskLists.getHeader(user.userId, id)
      : this.taskLists.get(user.userId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string, @Body() dto: UpdateTaskListDto) {
    return this.taskLists.update(user.userId, id, dto);
  }

  /**
   * Open (or return) the conversation this list is steered from.
   *
   * POST because it may create a session, and idempotent in the way that matters: calling it
   * twice returns the same conversation rather than opening a second one.
   */
  @Post(':id/console')
  openConsole(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: OpenTaskListConsoleDto,
  ) {
    return this.taskLists.console(user.userId, id, dto?.workspaceId);
  }

  /** This list's dispatch-policy history, newest first. */
  @Get(':id/revisions')
  revisions(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.taskLists.revisions(user.userId, id);
  }

  /**
   * Put the policy back to a recorded revision. POST rather than PUT because the restore is
   * itself recorded as a new revision — it appends to the history, it does not rewind it.
   */
  @Post(':id/revisions/:version/restore')
  restoreRevision(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: RestoreTaskListRevisionDto,
  ) {
    return this.taskLists.restoreRevision(user.userId, id, version, dto?.note);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.taskLists.remove(user.userId, id);
  }
}
