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
import {
  CreateProjectDto,
  FinalizeAcceptanceRunDto,
  OpenAcceptanceRunDto,
  OpenProjectCoordinatorDto,
  RecordMergeEvidenceDto,
  TriggerProjectCoordinatorDto,
  UpdateProjectDto,
} from './dto';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const PROJECT_STATUSES = Object.values(ProjectStatus);

@UseGuards(JwtAuthGuard)
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly acceptance: ProjectAcceptanceService,
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
