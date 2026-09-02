import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Runner } from '@prisma/client';
import { PublicIdPipe } from '../common/public-id';
import {
  CreateProjectDto,
  FinalizeAcceptanceRunDto,
  OpenAcceptanceRunDto,
  RecordMergeEvidenceDto,
  UpdateProjectDto,
} from '../projects/dto';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { HANDOFF_STORED_STATES, type HandoffStoredState } from '../projects/project-handoff';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectsService } from '../projects/projects.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { OutcomeSurfaceService } from '../outcome-reconciler/outcome-surface.service';

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
 * An agent may state what a body of work is for and cancel/reopen it, which is why create and
 * update are here: a coordinator handed "plan this out" had nowhere to put the goal it worked out,
 * and the headless CLI is also an intentional owner-operated path. A missing acting-session header
 * therefore means NON_JUDGMENT, not "the server proved this is a person". The HUMAN_ONLY labels add
 * judgment-role separation and action-specific traceability; they are not a hard human boundary
 * when the credential can be borrowed or minted. DONE is evaluator-derived; criteria,
 * confirmations, conclusions, and automatic settlement retain different provenance fields. See
 * `docs/human-only-authority.md` for the exact matrix.
 *
 * Listing and opening a coordinator are still not here. Deletion mirrors the user door and keeps
 * its destructive guard: `ProjectsService.remove` only removes an empty project. The project's
 * tasks are not returned here either — `ProjectsService.get` returns tallies rather than rows, and
 * the runner already reaches the work through the task routes.
 */
@UseGuards(RunnerAuthGuard)
@Controller('runner')
export class RunnerProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly acceptance: ProjectAcceptanceService,
    private readonly handoffs: ProjectHandoffService,
    // Keep direct constructions in older focused controller specs source-compatible. Nest still
    // injects the typed service in production; only tests that never reach an outcome route use
    // the default, matching the compatibility defaults on ProjectsService itself.
    private readonly outcomeSurfaces: OutcomeSurfaceService = undefined as unknown as OutcomeSurfaceService,
  ) {}

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
    RunnerProjectsController.refuseLegacyAcceptanceCriteria(dto);
    RunnerProjectsController.refuseGovernance(dto);
    const inSession = sessionId?.trim();
    return inSession
      ? this.projects.createInSession(runner.ownerId, runner.id, inSession, dto)
      : this.projects.create(
          runner.ownerId,
          dto,
          undefined,
          { type: 'RUNNER', id: runner.id },
        );
  }

  @Get('projects/:id')
  getProject(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.projects.get(runner.ownerId, id);
  }

  /** The canonical obligation surface this door served was removed with the obligation algebra;
   *  `orbit project obligations` / MCP `project_obligations` went with it. Failure Continuations
   *  never came from that projection and keep their own door below. */
  @Get('projects/:id/failure-coordination')
  projectFailureCoordination(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Query('surface') requestedSurface = 'AGENT_QUEUE',
  ) {
    return this.outcomeSurfaces.readFailureProjectSurface(
      runner.ownerId,
      id,
      this.outcomeSurfaces.parseFailureSurface(requestedSurface),
    );
  }

  @Get('projects/:id/acceptance')
  projectAcceptance(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.acceptance.overview(runner.ownerId, id);
  }

  @Post('projects/:id/acceptance/runs')
  openAcceptanceRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    // Attribution is transport context, not a caller-authored body field. The runner puts this
    // header on every MCP call made from the one-shot judgment session.
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: OpenAcceptanceRunDto,
  ) {
    // Who concluded is a fact about which door the request came through, not a field the caller
    // fills in: this one is a machine credential, so the run is the coordinator agent's. The user
    // door takes the claim explicitly, and an agent cannot make it about a person.
    return this.acceptance.openRun(runner.ownerId, id, {
      ...dto,
      decidedBy: 'COORDINATOR_AGENT',
      // Override (and, headless, discard) the body claim. A run cannot choose which conversation
      // history it belongs to; the same rule already governs project creation at this door.
      coordinatorSessionId: sessionId?.trim() || undefined,
    });
  }

  @Post('projects/:id/acceptance/runs/:runId/verdict')
  finalizeAcceptanceRun(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Param('runId', PublicIdPipe) runId: string,
    // Same header, same reason as the PATCH below: a PASS recorded here is what a project's DONE
    // is bound to. A judgment session may still open a run and conclude FAIL or INCONCLUSIVE on
    // every criterion. Headless calls retain runner provenance through the fallback machine id;
    // owner-channel provenance is an audit fact, not proof of human presence.
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: FinalizeAcceptanceRunDto,
  ) {
    return this.acceptance.finalizeRun(
      runner.ownerId, id, runId, dto.criteria, sessionId, runner.id,
    );
  }

  /**
   * Record what a target branch was observed to contain (§13.4 AE9-b).
   *
   * The runner is the side that can actually look: it has the checkout. `contentHash` is a digest
   * of the CONTENT, never `git branch --contains` — a squash makes that a guaranteed false
   * negative, which is the lesson §13.4 clause 6 exists to carry.
   */
  @Post('projects/:id/acceptance/merge-evidence')
  recordMergeEvidence(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RecordMergeEvidenceDto,
  ) {
    return this.acceptance.recordMergeEvidence(runner.ownerId, id, dto);
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
  /**
   * Unit L7: what has been asked and answered about work crossing into or out of this project,
   * both directions, with each end named as well as identified.
   *
   * READ ONLY, and the omission is the point. §7 RB2 is explicit that the approver of a
   * cross-project crossing is the USER — the target project's coordinator is not, because an agent
   * signing for another agent is the original incident with one more actor in it. So this door
   * carries the question and never the answer: a coordinator can see that it is waiting on a
   * person, and can say so, and cannot resolve it for them (PCC §9.3, never act on their behalf).
   */
  @Get('projects/:id/handoffs')
  listProjectHandoffs(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Query('state') state?: string,
    @Query('limit') limit?: string,
  ) {
    if (state !== undefined && !HANDOFF_STORED_STATES.includes(state as HandoffStoredState)) {
      throw new BadRequestException(`state must be one of ${HANDOFF_STORED_STATES.join(', ')}`);
    }
    return this.handoffs.listForProject(runner.ownerId, id, {
      state: state as HandoffStoredState | undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Unit L7: what reopening this project would cost — the epoch it is in, the one a reopen would
   * start, how many acceptance attempts stop being current, and whether its DONE rests on the
   * legacy stamp.
   *
   * Also read only, and for the same reason: §7 says a settled project is reopened by the USER and
   * that a coordinator does not reopen one on its own. What an agent is entitled to is to KNOW
   * that its write was refused `PROJECT_REOPEN_REQUIRED` and what asking a person for would cost
   * them — which is exactly this, and is not a door onto the write.
   */
  @Get('projects/:id/reopen')
  getProjectReopenImpact(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.projects.reopenPreview(runner.ownerId, id);
  }

  @Patch('projects/:id')
  updateProject(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    // The session this edit is being made from, read for the acceptance-criteria HUMAN_ONLY
    // decision. DONE is uniformly automatic-only before this role check. A header rather than a
    // body field makes the ordinary session-aware path attributable; omitting it preserves the
    // intentional headless path and does not establish that the caller is human.
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: UpdateProjectDto,
  ) {
    RunnerProjectsController.refuseLegacyAcceptanceCriteria(dto);
    RunnerProjectsController.refuseGovernance(dto);
    return this.projects.update(runner.ownerId, id, dto, sessionId);
  }

  /**
   * Permanently remove an empty project through the same guarded service as the user door.
   * ProjectsService owns both tenant scoping and the atomic no-tasks check, so this route cannot
   * turn deletion into an implicit task delete or detach.
   */
  @Delete('projects/:id')
  removeProject(@CurrentRunner() runner: Runner, @Param('id', PublicIdPipe) id: string) {
    return this.projects.remove(runner.ownerId, id);
  }

  /**
   * The legacy prose authoring shape has no place to declare how each assertion is decided. The
   * project service therefore has to backfill HUMAN_SIGNOFF when an old user client sends it. That
   * remains a necessary compatibility path on the JWT/user API and for reading existing projects,
   * but it is not a safe default for an agent: a stale CLI would otherwise silently turn every
   * mechanically decidable outcome into work only a person can close.
   *
   * Keep this check at the runner boundary rather than in ProjectsService. That makes old and
   * drifted runner clients fail loudly while leaving the user API and stored legacy rows intact.
   * Presence, not truthiness, is what matters: `null` on update is also the legacy authoring shape;
   * an agent clears the structured set explicitly with `acceptanceCriteriaItems: []`.
   */
  private static refuseLegacyAcceptanceCriteria(
    dto: Pick<CreateProjectDto | UpdateProjectDto, 'acceptanceCriteria'>,
  ): void {
    if (dto.acceptanceCriteria === undefined) return;
    throw new BadRequestException(
      'Runner project writes do not accept legacy acceptanceCriteria because it implicitly ' +
        'creates HUMAN_SIGNOFF criteria. Send acceptanceCriteriaItems and explicitly set ' +
        'verificationMethod and completionCriterion on every item; send [] to clear the set. ' +
        'Legacy acceptanceCriteria remains a user-API and existing-data compatibility shape.',
    );
  }

  /**
   * The five fields this door does not carry: what the coordinator is allowed to do, and who the
   * coordinator IS.
   *
   * Everything else on this DTO is a statement about the work, which an agent may make. These are
   * statements about the agent's own authority — how far it may act, how much it may spend, and
   * which identity gets to decide — and an agent that could write them would be granting itself
   * whatever it was refused. Those stay with the account-owner channel. That channel is a tenancy
   * and audit boundary, not a human-presence attestation when its credential is accessible to an
   * agent.
   *
   * Refused rather than dropped. A silently ignored field reads to the caller as a write that
   * happened, and the caller here is a model that will go on to act as though it did.
   */
  private static refuseGovernance(dto: CreateProjectDto | UpdateProjectDto): void {
    // `expectedConfigRevision` is NOT one of them, and deliberately: it grants nothing, it only
    // refuses. An agent stating the revision it read is an agent that will be told when the owner
    // changed something underneath it, which is the opposite of widening its own authority.
    const named = [
      ...ProjectsService.AUTHORIZATION_FIELDS,
      ...('coordinatorAgentId' in dto ? ['coordinatorAgentId' as const] : []),
    ].filter((field) => (dto as unknown as Record<string, unknown>)[field] !== undefined);
    if (named.length === 0) return;
    throw new ForbiddenException(
      `${named.join(', ')} ${named.length === 1 ? 'is' : 'are'} the account owner’s to set, not ` +
        'this session’s — change it from the Orbit web app or the user API',
    );
  }
}
