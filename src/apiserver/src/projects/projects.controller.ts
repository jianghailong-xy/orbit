import {
  BadRequestException,
  Body,
  ConflictException,
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
import {
  CreateProjectDto,
  DecideProjectHandoffDto,
  ReopenProjectDto,
  FinalizeAcceptanceRunDto,
  OpenAcceptanceRunDto,
  OpenProjectCoordinatorDto,
  RebindProjectCoordinatorDto,
  RecordMergeEvidenceDto,
  RecordTaskCheckpointDto,
  UpdateProjectDto,
} from './dto';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectsService } from './projects.service';
import { HANDOFF_STORED_STATES, type HandoffStoredState } from './project-handoff';

const PROJECT_STATUSES = Object.values(ProjectStatus);

@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly acceptance: ProjectAcceptanceService,
    private readonly handoffs: ProjectHandoffService,
    private readonly attempts: SessionAttemptService,
    private readonly checkpoints: TaskCheckpointService,
  ) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projects.create(user.userId, dto);
  }

  /** The owner's projects, newest first. `?status=OPEN|DONE|CANCELLED` narrows; absent means all. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.projects.list(user.userId, this.parseStatus(status));
  }

  /** Project-level acceptance evidence versions awaiting a complete, criterion-by-criterion answer. */
  @Get('acceptance/pending')
  pendingAcceptance(
    @CurrentUser() user: AuthUser,
    @Query('limit') limit?: string,
  ) {
    return this.acceptance.pendingInbox(
      user.userId,
      limit === undefined ? 100 : Number(limit),
    );
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.get(user.userId, id);
  }

  /**
   * Where this project's work stands, and what shape its dependency graph is (one read).
   *
   * `buckets` splits the OPEN tally `GET :id` reports into `ready` (nothing owed to it — it could
   * start now) and `blocked` (waiting on a prerequisite), which is the distinction the page needs
   * and the combined count cannot express. `shape` says whether the graph is worth drawing as a
   * node-link diagram or reads as a chain. No ids, so nothing here needs Base62 rewriting.
   */
  @Get(':id/panorama')
  panorama(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.panorama(user.userId, id);
  }

  /**
   * Unblocking which task would release the most of this project — most first, `?limit=` rows.
   *
   * Ranked by transitive downstream count, so the head of a chain outranks the links behind it
   * rather than tying with them. `remainingCount` comes back beside the ranking as the project's
   * whole unfinished total: it is the denominator a bar length needs to mean anything, and the
   * one number a client cannot derive from the rows it was sent. `taskId` is an address like any
   * other and is rendered Base62 by the response interceptor.
   */
  @Get(':id/panorama/blocking')
  panoramaBlocking(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.projects.panoramaBlocking(user.userId, id, { limit });
  }

  /**
   * Tasks in this project that are running, can start now, or need a paused list resumed first.
   *
   * This is deliberately not a client-side filter over the blocking leaderboard: runnable leaves
   * block zero tasks and therefore do not appear there, while blocked roots must not receive a Run
   * button. Active work stays in the response as QUEUED/RUNNING so a successful Run changes its
   * row instead of removing it. A PAUSED row passes every other Run gate and carries the owning
   * list plus its release scope. IDs are rendered in Base62 by the response interceptor.
   */
  @Get(':id/panorama/ready')
  panoramaReady(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    return this.projects.panoramaReady(user.userId, id, { limit });
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
   * This project's dependency graph, whole and folded: `marks` and the edges between them, where
   * a mark is one task, a folded run of tasks, or one stage of a motif the project repeats.
   *
   * Unpaged and unparameterised on purpose. It is not a page of a tree — a graph served in pieces
   * is not a graph — and it is bounded by folding rather than by cutting: every task in the
   * project is behind exactly one mark, however many tasks the project has. `truncated` is left
   * for the two cases folding cannot save, both far above anything seen here: a project past the
   * read ceiling, and a fold still too large to carry.
   */
  @Get(':id/dependency-graph')
  dependencyGraph(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.dependencyGraph(user.userId, id);
  }

  /**
   * `[K6]` §7: record a checkpoint on this task — the door the whole unit exists behind.
   *
   * The caller says what it MEASURED and never what kind of point that makes: §7's first row is a
   * fact about the measurement, not a claim about the work, and a caller that could name its own
   * kind could call a red tree `ACCEPTED`. Green evidence on the checkpointed tree makes it
   * `ACCEPTED`; anything else makes it `WIP_RED` and CP2 then requires an artifact another machine
   * can fetch — a stash is refused by name, because "the work is in a stash on runner-7" is the
   * state that costs the most, being neither lost nor reachable.
   *
   * Recording the same content twice returns the original with `duplicate: true` and writes
   * nothing (CP1). Like a repeat finding, that is not an error: a caller that retried a request it
   * never saw the answer to must be able to ask again and learn what happened.
   */
  @Post(':id/tasks/:taskId/checkpoints')
  async recordCheckpoint(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: RecordTaskCheckpointDto,
  ) {
    await this.projects.assertTaskInProject(user.userId, id, taskId);
    const result = await this.checkpoints.record({
      ownerId: user.userId,
      taskId,
      scopeRevision: dto.scopeRevision,
      commit: {
        branch: dto.branch,
        commitSha: dto.commitSha,
        treeSha: dto.treeSha,
        baseSha: dto.baseSha,
      },
      evidence: dto.evidence ?? null,
      artifact: (dto.artifact as never) ?? null,
      recordedBy: 'USER',
      attemptId: dto.attemptId ?? null,
    });
    // §7's record refusals are answers, not crashes — each one names the mistake rather than a
    // column, which is the difference between "artifact_ref is null" and "a stash is a place".
    if (typeof result === 'string') throw new ConflictException(result);
    return result;
  }

  /** Every checkpoint on this task, newest first, and the one a later task may start from. */
  @Get(':id/tasks/:taskId/checkpoints')
  async taskCheckpoints(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('taskId', PublicIdPipe) taskId: string,
  ) {
    await this.projects.assertTaskInProject(user.userId, id, taskId);
    const checkpoints = await this.checkpoints.list(user.userId, taskId);
    const baseline = checkpoints.find((c) => c.kind === 'ACCEPTED') ?? null;
    return {
      taskId,
      checkpoints,
      // Stated rather than left for a client to re-derive: §7 CP6's rule is "the LATEST accepted
      // one", and a client that filtered this list itself would be re-implementing the ordering
      // that makes the rule mean anything.
      baselineCheckpointId: baseline?.id ?? null,
      baselineAbsentReason: baseline ? null : ('NO_ACCEPTED_CHECKPOINT' as const),
    };
  }

  /**
   * How much of this TASK's current attempt is left, per dimension (`[K3]`, attempt budget §1).
   *
   * `.../convergence` answers "how many more tries does this task get"; this answers the other
   * half — "how much is left of the try that is running". Both are needed and neither implies the
   * other: a task with plenty of attempts left can be one turn from the end of the one in flight.
   *
   * Every dimension reports its own reading rather than a single boolean, because BD3's four states
   * are not interchangeable: `UNMEASURED` (the runner has not reported a context window yet) is not
   * `WITHIN` and is not `UNBOUNDED`, and collapsing them is how a budget silently stops applying.
   * The live attempt is re-measured against the request's clock so the wall clock is current; a
   * closed one reports the spend it was last measured at rather than one that kept running after
   * the work stopped.
   */
  @Get(':id/tasks/:taskId/attempts')
  async taskAttempts(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('taskId', PublicIdPipe) taskId: string,
  ) {
    await this.projects.assertTaskInProject(user.userId, id, taskId);
    return this.attempts.describe(user.userId, taskId, new Date());
  }

  /**
   * This project's acceptance standing (contract §13.4 / AC12), in one read.
   *
   * The stated criteria as the parser decomposes them, the digest of the facts a DONE would be
   * checked against, every evidence version with its derived criteria and conclusion events, the newest
   * merge observation per requirement, the append-only audit — and `doneGate`, which is the same
   * decision the write path makes, evaluated as a read so a client can say what is missing before
   * anybody presses a button. Ids are Base62.
   *
   * A read holds no lock and grants nothing: the gate that DECIDES runs inside the transaction that
   * writes DONE, under `FOR UPDATE` (§13.4 AE7).
   */
  @Get(':id/acceptance')
  acceptanceOverview(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    return this.acceptance.overview(
      user.userId, id, Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20,
    );
  }

  /** Confirm once that the complete current standard set expresses the project goal. */
  @Post(':id/acceptance/criteria-confirmation')
  confirmAcceptanceCriteria(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
  ) {
    return this.acceptance.confirmCriteriaSet(user.userId, id, {
      actorType: 'USER',
      actorId: user.userId,
    });
  }

  /**
   * Evaluate the current acceptance evidence version. The project lock plus a partial unique index
   * makes this idempotent: concurrent evaluators of the same facts receive the same row.
   */
  @Post(':id/acceptance/runs')
  openAcceptanceRun(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: OpenAcceptanceRunDto,
  ) {
    return this.acceptance.openRun(user.userId, id, { ...dto, decidedBy: dto.decidedBy ?? 'USER' });
  }

  /**
   * Append conclusion events against an evidence version: one verdict per stated criterion.
   *
   * The current verdict is derived from the event projection — all PASS is PASS, any FAIL is FAIL, the
   * rest is INCONCLUSIVE — and cannot be supplied, which is the difference between this and writing
   * "all green" in a comment.
   */
  @Post(':id/acceptance/runs/:runId/verdict')
  finalizeAcceptanceRun(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('runId', PublicIdPipe) runId: string,
    @Body() dto: FinalizeAcceptanceRunDto,
  ) {
    return this.acceptance.finalizeRun(user.userId, id, runId, dto.criteria);
  }

  /**
   * Unit L4: what has been asked and answered about work crossing into or out of this project.
   *
   * Both directions. The people on the target project are the ones being asked to take work; the
   * people on the source are the ones waiting on the answer, and a list that showed one direction
   * would leave one of them looking at a queue that never mentions what they are blocked on.
   */
  @Get(':id/handoffs')
  listHandoffs(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('state') state?: string,
    @Query('limit') limit?: string,
  ) {
    if (state !== undefined && !HANDOFF_STORED_STATES.includes(state as HandoffStoredState)) {
      throw new BadRequestException(
        `state must be one of ${HANDOFF_STORED_STATES.join(', ')}`,
      );
    }
    return this.handoffs.listForProject(user.userId, id, {
      state: state as HandoffStoredState | undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  /**
   * Unit L4: answer one declared crossing.
   *
   * The person, and only the person — §7 RB2. Approving a live yes writes nothing and returns the
   * same row: it is a stable read-back rather than a second decision, so clicking approve twice
   * cannot extend an authorization's own deadline. Denying is final for that crossing; if you change
   * your mind, file the work yourself, which is an ordinary write under your own authority (R1).
   */
  @Post(':id/handoffs/:handoffId/decision')
  async decideHandoff(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('handoffId', PublicIdPipe) handoffId: string,
    @Body() dto: DecideProjectHandoffDto,
  ) {
    // The project in the path is not decoration: it is what makes this URL answerable by somebody
    // looking at one project, and it is checked rather than trusted — an answer given from the
    // wrong project's page would be an answer about a crossing this page never showed.
    const answer = await this.handoffs.get(user.userId, handoffId, new Date());
    if (answer.row.fromProjectId !== id && answer.row.toProjectId !== id) {
      throw new BadRequestException('that crossing does not touch this project');
    }
    // Unit L7: the second confirmation, when the caller offered one. The id in the path picks the
    // ROW; the crossing key identifies the MOVE — the two ends and the subject — so a client that
    // echoes it is saying which crossing it read, not merely which row it clicked. A queue that
    // reordered between the render and the click is the case this catches, and it is answered with
    // L1's existing code for an approval that names another move rather than a new one.
    if (
      dto.acknowledgedCrossingKey !== undefined
      && dto.acknowledgedCrossingKey !== answer.row.crossingKey
    ) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'APPROVAL_TARGET_MISMATCH',
        message:
          'that answer names a different crossing than the one at this id — re-read the queue and '
          + 'answer what it says now',
        owner: 'USER',
        requiredAction: 'AWAIT_HANDOFF_APPROVAL',
        crossingKey: answer.row.crossingKey,
      });
    }
    return this.handoffs.decide(user.userId, user.userId, handoffId, dto.decision, new Date());
  }

  /**
   * Record what a target branch was observed to contain (§13.4 AE9-b) — the only supported way a
   * `contentHash` enters the database.
   *
   * Same content as the newest observation ⇒ only the observation time moves. Different content ⇒ a
   * new row one generation up and an automatically advanced evidence version. Current acceptance
   * is re-evaluated from conclusion events; no caller reopens an attempt.
   */
  @Post(':id/acceptance/merge-evidence')
  recordMergeEvidence(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RecordMergeEvidenceDto,
  ) {
    return this.acceptance.recordMergeEvidence(user.userId, id, dto);
  }

  /**
   * Unit L7: what reopening this project would cost, before anybody spends it.
   *
   * Which epoch it is in, which one a reopen would start, how many acceptance attempts stop being
   * current, and the `acknowledgement` the write below has to echo back. Read it and show it: a
   * confirmation dialog that says "are you sure" asks about a feeling, and this says what happens.
   */
  @Get(':id/reopen')
  reopenPreview(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.reopenPreview(user.userId, id);
  }

  /**
   * Unit L7: reopen a settled project, having named the epoch that decision was made against.
   *
   * `PATCH :id` with `status: OPEN` still reopens and still may — an older client, a repair script
   * and the coordinator's own paths keep what they have always had (§8 CM1). This door differs in
   * one way and it is the point of it: `acknowledgedAcceptanceEpoch` is REQUIRED, so the only way
   * to reach it is to have read what the reopen costs. The response carries `reopened`, with the
   * epoch it came from, the one it landed in and how many acceptance attempts were retired.
   */
  @Post(':id/reopen')
  reopen(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: ReopenProjectDto,
  ) {
    return this.projects.reopen(user.userId, id, dto);
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

  /**
   * What this project's coordination is, and what the button above would do if pressed right now.
   *
   * A GET beside the POST it predicts, and a read in the strict sense: no body, no lock, no write.
   * The card needs to know whether a coordinator exists, whether the conversation is alive, whether
   * it is in Trash and whether the press would refuse — all four BEFORE the press, which is the one
   * thing pressing it can never tell you.
   */
  @Get(':id/coordinator/status')
  coordinatorStatus(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.coordinatorStatus(user.userId, id);
  }

  /**
   * Move this project's coordination workspace — the action the 409 above tells the owner to take.
   *
   * Every `COORDINATOR_UNAVAILABLE` ends in the same instruction ("rebind this project's
   * coordination workspace, then open the coordinator again") and names `USER` as the one who can
   * carry it out. This is what it names. A route of its own rather than a field on `PATCH :id`, on
   * purpose: moving a coordinator is a decision with a conversation attached to it, and it should
   * not be reachable by a request that meant to rename something.
   *
   * `workspaceId` is required and has no `null` spelling — clearing a landing is how a project
   * REACHES the state this endpoint exists to leave (see `RebindProjectCoordinatorDto`).
   */
  @Post(':id/coordinator/rebind')
  rebindCoordinator(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: RebindProjectCoordinatorDto,
  ) {
    return this.projects.rebindCoordinator(user.userId, id, dto.workspaceId);
  }
}
