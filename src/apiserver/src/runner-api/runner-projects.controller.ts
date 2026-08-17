import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { ProjectsService } from '../projects/projects.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * A project's durable context, read by `orbit project get` and the `project_get` MCP tool with the
 * machine's runner token. Tenant scope is the runner's owner, exactly as the task routes have it.
 *
 * It exists because `GET /projects/:id` is behind JwtAuthGuard and a runner holds no user JWT — its
 * credential is an opaque token hashed in the runner row — so a coordinator session had no way to
 * read the goal, acceptance criteria and instructions it is supposed to be working from. Same
 * service, same owner scoping, second door: no query, no ownership rule and no payload of its own,
 * so the two can never disagree about what a project is or who may see it.
 *
 * Read-only on purpose, and only this one route. A project's fields are written by a human deciding
 * what the work is for; a coordinator that could rewrite its own acceptance criteria could settle
 * itself. Its tasks are not here either — `ProjectsService.get` returns tallies rather than rows,
 * and the runner already reaches the work through the task routes.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('projects/:id')
  getProject(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.projects.get(runner.ownerId, id);
  }
}
