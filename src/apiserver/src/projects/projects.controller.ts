import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProjectStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/current-user.decorator';
import { PublicIdPipe } from '../common/public-id';
import { CreateProjectDto, OpenProjectCoordinatorDto, UpdateProjectDto } from './dto';
import { ProjectsService } from './projects.service';

const PROJECT_STATUSES = Object.values(ProjectStatus);

@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.userId, dto);
  }

  /** The owner's projects, newest first. `?status=OPEN|DONE|CANCELLED` narrows; absent means all. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.projects.list(user.userId, this.parseStatus(status));
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.get(user.userId, id);
  }

  /**
   * One level of this project's task tree: its top-level tasks, or — with `?parentId=` — the
   * direct children of one of them. Cursor-paged, newest first.
   *
   * `parentId` is an address like any other, so it goes through PublicIdPipe: clients hold the
   * base62 short form (that is what `parentTaskId` is encoded as on the way out), and a value
   * that decodes to nothing must be a 400 here rather than a 500 from a `::uuid` cast.
   */
  @Get(':id/tasks/page')
  taskPage(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('parentId', PublicIdPipe) parentId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.projects.taskPage(user.userId, id, { parentId, cursor, limit, status });
  }

  /**
   * What every verification in this project concluded, and what is still blocked by one (§13.2).
   *
   * The audit face for verdicts: each check's current conclusion and its `verdictRevision`, every
   * non-PASS conclusion's defect subtask and the action that raised it, and the exact list of
   * tasks the dispatch guard is currently holding back — with the reason. Ids are Base62.
   */
  @Get(':id/verifications')
  verifications(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.verifications(user.userId, id);
  }

  /**
   * Open (or return) the session this project is coordinated from.
   *
   * POST because it may create one, and idempotent in the way that matters: calling it twice
   * returns the same conversation with `created: false` rather than opening a second one. A body
   * is optional — `workspaceId` decides where a FIRST coordinator opens, and on a project that
   * already has one a different value is a 409 rather than a move.
   */
  @Post(':id/coordinator')
  openCoordinator(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: OpenProjectCoordinatorDto,
  ) {
    return this.projects.coordinator(user.userId, id, dto?.workspaceId);
  }

  /** Also how a project is settled: `{ "status": "DONE" }` / `{ "status": "CANCELLED" }`. */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projects.update(user.userId, id, dto);
  }

  /** Removes an EMPTY project. One that still holds tasks is a 409 naming how many — a task's
   *  project is what the task is for, so it cannot be taken away as a side effect. */
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.remove(user.userId, id);
  }

  /**
   * An unknown status is a 400 that names the accepted values, not a silently ignored filter:
   * a typo that quietly returns everything reads as "this project is still active" to whoever
   * asked which ones were.
   */
  private parseStatus(status?: string): ProjectStatus | undefined {
    if (status === undefined || status.trim() === '') return undefined;
    const value = status.trim().toUpperCase();
    if (!PROJECT_STATUSES.includes(value as ProjectStatus)) {
      throw new BadRequestException(`status must be one of ${PROJECT_STATUSES.join(', ')}`);
    }
    return value as ProjectStatus;
  }
}
