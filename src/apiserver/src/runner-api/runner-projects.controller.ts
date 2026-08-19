import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import { CreateProjectDto, UpdateProjectDto } from '../projects/dto';
import { ProjectsService } from '../projects/projects.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';

/**
 * A project's durable context, read and written by `orbit project` and the `project_*` MCP tools
 * with the machine's runner token. Tenant scope is the runner's owner, exactly as the task routes
 * have it.
 *
 * It exists because `/projects` is behind JwtAuthGuard and a runner holds no user JWT — its
 * credential is an opaque token hashed in the runner row — so a coordinator session had no way to
 * read the goal, acceptance criteria and instructions it is supposed to be working from, nor to
 * record one it was asked to set up. Same service, same DTOs, same owner scoping, second door:
 * these routes hold no query, ownership rule or DTO of their own — the bodies they take are the
 * canonical ones, forwarded untouched — so the two can never disagree about what a project is,
 * who may see it, or what a valid write looks like.
 *
 * An agent may state what a body of work is for and settle where it stands, which is why create
 * and update are here: a coordinator handed "plan this out" had nowhere to put the goal it worked
 * out, and a project whose work is finished could not be marked DONE by the thing that finished
 * it. The fields are not owner-only prose any more.
 *
 * Listing, deletion and opening a coordinator are still not here. Nor are the project's tasks —
 * `ProjectsService.get` returns tallies rather than rows, and the runner already reaches the work
 * through the task routes.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  /**
   * Record a new project. The body is the same CreateProjectDto the user-facing POST /projects
   * takes, forwarded untouched, so the length bounds and the blank-is-null rule are decided in one
   * place rather than twice.
   *
   * X-Orbit-Session-Id is the one thing this door adds, and it is CONTEXT rather than a field:
   * a project created from inside a session is bound, in the insert that creates it, to that
   * session as its coordinator and to that session's workspace. So opening the coordinator comes
   * back to the conversation the project was planned in, rather than starting a second one that
   * knows none of it. It is deliberately not a body field — `sessionId` or `workspaceId` on the
   * DTO would be caller-chosen, and this is a fact about where the request came from that only the
   * server can establish (`createInSession` resolves it under this runner and this owner, and
   * refuses anything else).
   *
   * No orchestration credential is asked for. Writing a project is authority `project_create`
   * already has; the header settles which conversation the project's own coordinator IS, and
   * grants nothing — the session it names is the caller's own. The empty-string check is not
   * cosmetic: a headless caller must reach `create`, and `''` would otherwise be looked up as a
   * session and refused.
   */
  @Post('projects')
  createProject(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: CreateProjectDto,
  ) {
    const inSession = sessionId?.trim();
    return inSession
      ? this.projects.createInSession(runner.ownerId, runner.id, inSession, dto)
      : this.projects.create(runner.ownerId, dto);
  }

  @Get('projects/:id')
  getProject(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.projects.get(runner.ownerId, id);
  }

  /**
   * Change a project's title, goal, acceptance criteria, instructions or status.
   *
   * Partial by construction: `ProjectsService.update` writes only the fields the body carries, so
   * an agent settling a project's status cannot blank the prose that says what it was for. `null`
   * on one of the prose fields clears it — the DTO's own rule, and the reason the runner door must
   * not reshape the body on its way through.
   *
   * A project belonging to somebody else is the service's 404, decided by the same `assertOwned`
   * the user door goes through; nothing here checks ownership separately.
   */
  @Patch('projects/:id')
  updateProject(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    RunnerProjectsController.refuseGovernance(dto);
    return this.projects.update(runner.ownerId, id, dto);
  }

  /**
   * The five fields this door does not carry: what the coordinator is allowed to do, and who the
   * coordinator IS.
   *
   * Everything else on this DTO is a statement about the work, which an agent may make. These are
   * statements about the agent's own authority — how far it may act, how much it may spend, and
   * which identity gets to decide — and an agent that could write them would be granting itself
   * whatever it was refused. Those stay with the account owner, through the door a person signs in
   * to.
   *
   * Refused rather than dropped. A silently ignored field reads to the caller as a write that
   * happened, and the caller here is a model that will go on to act as though it did.
   */
  private static refuseGovernance(dto: UpdateProjectDto): void {
    const named = [...ProjectsService.AUTHORIZATION_FIELDS, 'coordinatorAgentId' as const].filter(
      (field) => dto[field] !== undefined,
    );
    if (named.length === 0) return;
    throw new ForbiddenException(
      `${named.join(', ')} ${named.length === 1 ? 'is' : 'are'} the account owner’s to set, not ` +
        'this session’s — change it from the Orbit web app or the user API',
    );
  }
}
