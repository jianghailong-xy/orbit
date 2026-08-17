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
import { CreateProjectDto, UpdateProjectDto } from './dto';
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
