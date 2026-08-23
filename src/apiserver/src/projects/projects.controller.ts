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
  RecordMergeEvidenceDto,
  RecordTaskCheckpointDto,
  TriggerProjectCoordinatorDto,
  SubmitVerificationFindingDto,
  UpdateProjectDto,
} from './dto';
import { ConvergenceLedgerService } from './convergence-ledger.service';
import { VerificationFindingService } from './verification-finding.service';
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
    private readonly convergence: ConvergenceLedgerService,
    private readonly findings: VerificationFindingService,
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
   * This project's dependency graph, whole: every task in it plus every in-project dependency
   * edge, in the same `nodes` / `edges` vocabulary `GET /tasks/:id/dependency-graph` answers in.
   *
   * Unpaged and unparameterised on purpose. It is not a page of a tree — a graph served in pieces
   * is not a graph — and it is bounded instead by a server-side node cap that reports itself as
   * `truncated` when it bites.
   */
  @Get(':id/dependency-graph')
  dependencyGraph(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.dependencyGraph(user.userId, id);
  }

  /**
   * Why this TASK is or is not still being attempted (`[K2]`, convergence contract §1/§4/§8).
   *
   * `/coordinator/status` answers the same question for the project; this is the per-task half, and
   * the one that can distinguish the two things a stopped task looks identical from the outside:
   * a task that is converging slowly, and a task whose breaker tripped and is waiting for a person.
   *
   * It serves the RESOLVED thresholds rather than the project's override columns — a caller asking
   * why a task stopped needs the limit that applied, not a null that means "the default did". Every
   * scope revision is returned, superseded ones included: the old rows are the audit that says what
   * the task was asking for while the attempts charged to that revision were being spent.
   *
   * Ids leave as Base62, including the ones buried inside the two machine keys, which the
   * interceptor cannot see into.
   */
  @Get(':id/tasks/:taskId/convergence')
  async convergenceLedger(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('taskId', PublicIdPipe) taskId: string,
  ) {
    await this.projects.assertTaskInProject(user.userId, id, taskId);
    return this.convergence.describe(user.userId, taskId);
  }

  /**
   * `[K5]` §6: submit a finding about this task, and get back the ONE thing it produced.
   *
   * The user door. A person reporting a finding is a `USER` reporter, which §3's `谁能定` column
   * makes the only actor who may put a failure in any of the six classes — an agent's door is
   * narrower, and deliberately: `TRANSIENT` and `ENVIRONMENT` are read from system evidence, so an
   * agent that could write them could buy itself another attempt for ever without spending a budget
   * that charges neither (CL1). That is §0's incident with a nicer name on it.
   *
   * A repeat submission of the same failure returns the original finding with `duplicate: true` and
   * writes nothing (FD1). It is not an error: a reporter that retried a request it never saw the
   * answer to must be able to ask again and learn what happened, and the alternative — a refusal —
   * is what makes a caller file the same defect under a different fingerprint.
   */
  @Post(':id/tasks/:taskId/findings')
  async submitFinding(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('taskId', PublicIdPipe) taskId: string,
    @Body() dto: SubmitVerificationFindingDto,
  ) {
    await this.projects.assertTaskInProject(user.userId, id, taskId);
    return this.findings.submit({
      ownerId: user.userId,
      subjectTaskId: taskId,
      reporter: 'USER',
      scopeRevision: dto.scopeRevision,
      reporterTaskId: dto.reporterTaskId ?? null,
      decidedBy: 'USER',
      finding: {
        severity: dto.severity,
        violatedInvariant: dto.violatedInvariant,
        minimalRepro: dto.minimalRepro,
        failureFingerprint: dto.failureFingerprint,
        scopeClassification: dto.scopeClassification as never,
        evidence: dto.evidence,
        verdict: dto.verdict,
      },
    });
  }

  /** Every finding on this task, newest first: what was found, and which Task or row it became. */
  @Get(':id/tasks/:taskId/findings')
  async taskFindings(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Param('taskId', PublicIdPipe) taskId: string,
  ) {
    await this.projects.assertTaskInProject(user.userId, id, taskId);
    return this.findings.describe(user.userId, taskId);
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
   * What the control loop has been doing, newest first — `?limit=` (default 20) and `?cursor=`.
   *
   * The outbox, the decision audit and the action ledger as ONE stream: `kind` is the closed
   * vocabulary all three map into rather than any of their raw enums, `outcome` is the four values
   * a row's colour is chosen from, and `subjectTaskId` is the task to open when the row is about
   * one. The cursor is `(timestamp, id)`, because a pass writes its decision and its actions in
   * one transaction and a page boundary lands inside such a group routinely. Ids are Base62.
   */
  @Get(':id/panorama/activity')
  activity(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.projects.activity(user.userId, id, { limit, cursor });
  }

  /**
   * What is currently stopping this project (contract §11), newest episode first.
   *
   * `?history=1` also returns the resolved ones — they are never deleted, so this is where "what
   * was blocking this yesterday and what ended it" is answered. Ids are served in both spellings.
   */
  @Get(':id/blockers')
  blockers(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('history') history?: string,
  ) {
    return this.projects.blockers(user.userId, id, history === '1' || history === 'true');
  }

  /**
   * Why ready tasks are not running, over `?windowHours=` (default 24, half-open `[now - h, now)`).
   *
   * The dispatch ledger's two terminal outcomes for the window, the PAC §12 refusal codes behind
   * the refused ones ranked by how often each fired, and the blockers open against this project
   * right now. A refusal with no code is counted under `UNSPECIFIED` rather than dropped.
   */
  @Get(':id/panorama/dispatch-health')
  dispatchHealth(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Query('windowHours') windowHours?: string,
  ) {
    return this.projects.dispatchHealth(user.userId, id, windowHours);
  }

  /**
   * Everything the control loop knows about this project, in one read (contract AC10).
   *
   * The endpoint that answers "why is this project not moving": lifecycle and run state, who
   * coordinates it and where, the coordination session and which generation it is, the automation
   * policy and whether it is switched on at all, the concurrency and budget it is spending against,
   * the last few decisions with the actions and idempotency keys they produced, what is claimed and
   * unpublished right now, what is blocking it and what would clear that, when it next wakes and
   * which candidates lost, and the acceptance evidence — verdict tallies and per-branch merge
   * state. Every id is Base62 and every absent fact is `null` beside a closed-set `absentReason`.
   *
   * A read, and only a read: nothing here triggers a pass. `POST …/coordinator/trigger` does that.
   */
  @Get(':id/coordinator/status')
  coordinatorStatus(@CurrentUser() user: AuthUser, @Param('id', PublicIdPipe) id: string) {
    return this.projects.coordinatorStatus(user.userId, id);
  }

  /**
   * Ask this project's coordinator to look now.
   *
   * It commits one durable signal and returns; the pass happens after, under exactly the gates it
   * would have run under anyway, so this grants no authority and skips no check. It is on the user
   * door alone and deliberately not on the runner one: an agent that could enqueue a signal
   * attributed to USER would be driving its own coordinator, which is precisely what MANUAL means
   * it may not do.
   *
   * Both body fields are optional and both are about pressing the button twice safely —
   * `expectedConfigRevision` refuses a request composed against settings that have since changed
   * (409 `STALE_CONFIG_REVISION`, nothing written), and `triggerId` makes a retry the same request
   * rather than a second run.
   */
  @Post(':id/coordinator/trigger')
  triggerCoordinator(
    @CurrentUser() user: AuthUser,
    @Param('id', PublicIdPipe) id: string,
    @Body() dto: TriggerProjectCoordinatorDto,
  ) {
    return this.projects.triggerCoordinator(user.userId, id, dto ?? {});
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
   * This project's acceptance standing (contract §13.4 / AC12), in one read.
   *
   * The stated criteria as the parser decomposes them, the digest of the facts a DONE would be
   * checked against, every attempt with its per-criterion conclusions and evidence, the newest
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

  /**
   * Open an acceptance attempt: freeze the criteria, claim the epoch (§13.4 AE11), and create the
   * empty per-criterion checklist the conclusion has to fill.
   *
   * Opening one supersedes any earlier live attempt — two usable runs would let a caller choose the
   * conclusion they prefer.
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
   * Conclude an attempt: one verdict per stated criterion, with its evidence.
   *
   * The run's own verdict is derived from the criteria — all PASS is PASS, any FAIL is FAIL, the
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
   * new row one generation up, and if this project was DONE against the old content it is reopened
   * in the same transaction (AE9-c).
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
}
