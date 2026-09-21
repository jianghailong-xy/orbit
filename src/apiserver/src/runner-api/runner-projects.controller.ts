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
  AskOwnerDto,
  CreateProjectDto,
  RecordMergeEvidenceDto,
  ResolveOpenItemDto,
  ResolveProjectBlockerDto,
  UpdateProjectDto,
} from '../projects/dto';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { HANDOFF_STORED_STATES, type HandoffStoredState } from '../projects/project-handoff';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectsService } from '../projects/projects.service';
import { CurrentRunner } from './current-runner.decorator';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

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
    private readonly orchestration: RunnerOrchestrationAuthorizer,
    // Only `askOwner` needs it. Defaulted for the reason `ProjectsService`'s own late parameters
    // are: Nest injects by type rather than by position, while the specs that build this controller
    // by hand to exercise one route would each have to stub a service they never reach.
    private readonly openItems: ProjectOpenItemService = undefined as unknown as ProjectOpenItemService,
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
   * knows none of it. `sessionId` is deliberately not a body field — it is a fact about where the
   * request came from that only the server can establish (`createInSession` resolves it under this
   * runner and this owner, and refuses anything else).
   *
   * No orchestration credential is asked for BY THAT PATH. Writing a project is authority
   * `project_create` already has; the header settles which conversation the project's own
   * coordinator IS, and grants nothing — the session it names is the caller's own. The
   * empty-string check is not cosmetic: a headless caller must reach `create`, and `''` would
   * otherwise be looked up as a session and refused.
   *
   * `workspaceId` IS a body field, and it is the exception the paragraph above describes rather
   * than a hole in it. It names a workspace the caller chose, so it is exactly the authority
   * `session_create` asks for — a live acting session whose workspace has orchestration enabled —
   * and it is refused without one, because the alternative is a machine credential that can open a
   * conversation in any workspace this account owns. The acting session proves who is asking; the
   * field says where, and the two are different questions. There is no service token to refuse
   * here: `RunnerAuthGuard` takes the machine's own credential and nothing else — a minted token
   * reaches the session routes and only those.
   */
  @Post('projects')
  async createProject(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Headers('x-orbit-session-token') orchestrationToken: string | undefined,
    @Body() dto: CreateProjectDto,
  ) {
    RunnerProjectsController.refuseGovernance(dto);
    const inSession = sessionId?.trim();
    if (dto.workspaceId) {
      if (!inSession) {
        // Nothing to check the choice against. A headless caller IS the owner operating this
        // machine, and the door that lets them name a workspace without borrowing a session's
        // authority is the user API's own POST /projects.
        throw new ForbiddenException(
          'naming a workspaceId here needs an acting session — send X-Orbit-Session-Id with an ' +
            'orchestration credential, or create the project through the user API',
        );
      }
      await this.orchestration.assert(runner, inSession, orchestrationToken);
      // The named workspace WINS over the acting session's own, which is the whole point of
      // sending it: the caller is saying this project is coordinated somewhere else. The session
      // is spent proving the caller may say so, not deciding where.
      return this.projects.createInWorkspace(
        runner.ownerId,
        dto,
        dto.workspaceId,
        { type: 'RUNNER', id: runner.id },
        inSession,
      );
    }
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

  /**
   * Record what a target branch was observed to contain.
   *
   * The runner is the side that can actually look: it has the checkout. `contentHash` is a digest
   * of the CONTENT, never `git branch --contains` — a squash makes that a guaranteed false
   * negative. Since 0229 nothing reads these rows to decide anything.
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
   * The one write acceptance criteria reach — and the one write that may decline to perform
   * itself, which nothing about a 200 on this route would tell a caller that had not been told.
   *
   * `acceptanceCriteriaItems` is classified before it is written. An edit that plainly tightens
   * the ruler replaces the criteria where the call is made. An edit that drops a criterion, or
   * whose direction cannot be read at all, is NOT written: it is held for the account owner to
   * decide, and the criteria this route returns are the ones that were already there — the
   * standard the caller is still judged against.
   *
   * `acceptanceCriteriaHold` on the response body is the field that says which of the two
   * happened. Present is held, and carries the intentId, actionDigest and baselineSeal the
   * owner's decision is answered with; absent is applied. The header below does not decide the
   * fork — it decides whether a hold is attributed to an AGENT or to the OWNER, and an owner
   * writing their own project is held on the same terms — so a caller that reads its criteria
   * back and finds them unmoved is looking at a hold rather than at a lost write.
   */
  @Patch('projects/:id')
  updateProject(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    // The session this edit is being made from, read for the acceptance-criteria HUMAN_ONLY
    // decision. A header rather than a body field makes the ordinary session-aware path
    // attributable; omitting it preserves the intentional headless path and does not establish
    // that the caller is human.
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Body() dto: UpdateProjectDto,
  ) {
    RunnerProjectsController.refuseGovernance(dto);
    return this.projects.update(runner.ownerId, id, dto, sessionId);
  }

  /**
   * End one of this project's blockers, saying why it no longer blocks.
   *
   * The read half has always been here — `GET projects/:id` carries the open blockers — and until
   * this route the write half existed only behind a user JWT, so an agent could see what had stopped
   * its project and had no door to act through: the only way out was to tell the owner to go and
   * click it. That is not a boundary being enforced, it is a boundary with nothing behind it; the
   * work still stops, and it stops on a person who was told about it in prose.
   *
   * The boundary that IS enforced sits one layer up, in the runner: `project_blocker_resolve` puts
   * the blocker and the reason on a confirmation card and blocks until the account owner answers, so
   * nothing here is written without their yes. This is the same shape as `task_create` — the agent
   * proposes, the owner decides, the runner performs — and the reason it is not ALSO checked here is
   * the reason it is not checked there: this door takes the machine's own credential, which is the
   * owner's, so a server-side check would be the owner asking themselves for permission. What the
   * server does keep is the provenance: an agent's resolution records `resolved_by = COORDINATOR`
   * and names no user, because the sentence on the row is the agent's own.
   *
   * Contrast `GET projects/:id/handoffs` above, which is read-only on purpose. A cross-project
   * crossing is one PROJECT signing for another, and no card makes an agent the other project's
   * owner. A blocker is this project's own wait, and its owner is the person this card reaches.
   */
  @Post('projects/:id/blockers/:blockerId/resolve')
  resolveBlocker(
    @CurrentRunner() runner: Runner,
    @Param('id', PublicIdPipe) id: string,
    @Param('blockerId', PublicIdPipe) blockerId: string,
    @Body() dto: ResolveProjectBlockerDto,
  ) {
    return this.projects.resolveBlocker(runner.ownerId, id, blockerId, dto.reason, 'COORDINATOR');
  }

  /**
   * A coordinator putting a question to the account owner (contract §5.2 R7–R9).
   *
   * The question is filed and the call returns: it does not block the turn, and the answer comes
   * back later as a turn of its own, addressed to whichever conversation coordinates the project
   * then. So a coordinator that hits something it may not decide — which task goes first, whether a
   * branch is worth keeping — neither stalls nor decides it anyway.
   *
   * X-Orbit-Session-Id is what makes this askable at all, and it is checked by the service against
   * the project's own coordinator pointer: the question goes to the owner in the project's name, so
   * the session asking has to be the one the project points at. No orchestration credential: asking
   * a question grants nothing and starts nothing, and the refusal for the wrong session is the whole
   * authority check.
   */
  @Post('projects/:id/owner-questions')
  askOwner(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: AskOwnerDto,
  ) {
    return this.openItems.askOwner(runner.ownerId, id, sessionId?.trim(), dto);
  }

  /**
   * A coordinator closing an item it has carried (contract §4.7's "标记已处理").
   *
   * The item is the coordinator's because a landing of its project did not go through, and the one
   * ending the platform cannot produce for itself is work that landed by hand: the branch tip stops
   * being an ancestor of anything once the replay is pushed, so no job will ever report a landing for
   * it and the item would stay open for ever. Its assignee is the only one who knows, so the
   * conversation the project is coordinated from is given the press — and the reason is required,
   * because a hand-closed item is one the platform could not verify.
   *
   * The acting session is the authority here, exactly as it is for a question: the service checks it
   * against the project's own coordinator pointer. A header that is missing or blank is NOT read as
   * the account owner — the owner's press is the user API's, and a machine credential reaching it by
   * omitting a header is the one confusion this route must not have.
   */
  @Post('projects/:id/open-items/:itemId/resolve')
  resolveOpenItem(
    @CurrentRunner() runner: Runner,
    @Headers('x-orbit-session-id') sessionId: string | undefined,
    @Param('id', PublicIdPipe) id: string,
    @Param('itemId', PublicIdPipe) itemId: string,
    @Body() dto: ResolveOpenItemDto,
  ) {
    return this.openItems.resolveOpenItem(runner.ownerId, id, itemId, dto, {
      kind: 'SESSION',
      sessionId: sessionId?.trim() ?? '',
    });
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
