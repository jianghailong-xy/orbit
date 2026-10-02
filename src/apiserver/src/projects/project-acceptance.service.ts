import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, ProjectStatus } from '@prisma/client';
import {
  type DoneRequest,
  type ProjectDoneBy,
  type ProjectDoneRecord,
  type ProjectDoneRequestBody,
  type ProjectStartRecord,
  type ProjectStartRequest,
  type ProjectStartSettings,
  type StartProjectRequestBody,
  type StartProjectResponse,
  differingStartSettings,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  ConfirmedCriterionVersion,
  RecordedStandardSetConfirmation,
  StandardSetConfirmationStanding,
  StandardSetConfirmationView,
  StandardSetVersion,
  StatedAcceptanceCriterion,
  criteriaChangesSinceConfirmed,
  criteriaFromDefinitions,
  standardSetConfirmationStanding,
  standardSetVersion,
} from './project-acceptance';
import {
  refuseProjectStatusWrite,
  refuseSessionAuthoredConfirmation,
} from './coordinator-authority';
import { VERIFICATION_METHOD_RUNGS } from './criteria-edit-classification';
import { storeDerivedProjectStatus } from './project-done-derived';
import { defaultStartLine, startProjectLine } from './project-integration-line';
import { tellCoordinatorProjectStarted } from './project-started';
import { START_REQUEST_KIND, answerStartRequests } from './project-start-request';
import { DONE_REQUEST_KIND, answerDoneRequests } from './project-done-request';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';

/** One stated criterion, as every read surface reports it. */
export interface AcceptanceCriterionStanding {
  id: string;
  key: string;
  text: string;
  ordinal: number;
}

/** The criteria tally a project detail read embeds: what this project says it is for, next to the
 *  task tally's process measure. */
export interface ProjectAcceptanceCriteriaSummary {
  total: number;
  criteria: AcceptanceCriterionStanding[];
}

export interface RecordMergeEvidenceInput {
  requirementId: string;
  targetBranch: string;
  contentHash: string;
  source?: string;
  detail?: Record<string, unknown>;
}

/** What one start wrote, for its answer and for the two edges after its commit. */
interface ProjectStartOutcome {
  confirmationId: string;
  at: Date;
  version: StandardSetVersion;
  record: ProjectStartRecord;
  lineLocked: boolean;
}

/** The 409 a start gets on a project that has been started already, before anything is written. */
function projectAlreadyStarted(startedAt: Date | null): ConflictException {
  return new ConflictException({
    code: 'PROJECT_ALREADY_STARTED',
    startedAt: startedAt?.toISOString() ?? null,
    message:
      'This project has already been started, and a project is started once: nothing was written. '
      + 'Change how it runs from its settings instead.',
  });
}

function isProjectAlreadyStarted(error: unknown): boolean {
  return error instanceof ConflictException
    && (error.getResponse() as { code?: unknown }).code === 'PROJECT_ALREADY_STARTED';
}

/** The 409 a confirmation or a start gets when the criteria moved after the caller read them. */
function criteriaVersionMoved(currentDigest: string): ConflictException {
  return new ConflictException({
    code: 'PROJECT_CRITERIA_CONFIRMATION_VERSION_MOVED',
    currentDigest,
    message:
      'The acceptance criteria changed after the version being confirmed was read. Read them '
      + 'again and confirm the set that stands now: a confirmation carried over an edit would '
      + 'say a person approved wording they never saw.',
  });
}

/** The 409 an owner's DONE gets when the criteria moved after the card showed them. */
function projectDoneCriteriaMoved(currentDigest: string): ConflictException {
  return new ConflictException({
    code: 'PROJECT_DONE_CRITERIA_VERSION_MOVED',
    currentDigest,
    message:
      'The acceptance criteria changed after the version being recorded done was read. Read them '
      + 'again: nothing was written.',
  });
}

/** The 409 an owner's DONE gets when the request it answers is no longer the one standing: it was
 *  answered, superseded or withdrawn, or it was made about criteria that have changed since. */
function projectDoneRequestStale(why: string): ConflictException {
  return new ConflictException({
    code: 'PROJECT_DONE_REQUEST_STALE',
    message: `The request to record this project done ${why}: nothing was written.`,
  });
}

/**
 * A project's acceptance CRITERIA — the authored declaration, and nothing that judges it.
 *
 * Migration 0229 removed the judging half of this service on the account owner's instruction:
 * acceptance runs, per-run criterion verdicts, conclusion events, the audit ledger, the DONE gate
 * and the accepted-run pointer are all gone, along with the four triggers on `project` that
 * enforced them. What is left is what the owner asked to keep — a project states its criteria
 * precisely, they are readable and editable, and NOTHING in Orbit decides whether they hold. That
 * is the same position an EXECUTABLE task has been in since 0228: declared, unimplemented.
 */
@Injectable()
export class ProjectAcceptanceService {
  private readonly logger = new Logger(ProjectAcceptanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    /** Tells the coordinator conversation that the project was started (`project-started.ts`).
     *  `@Optional()` because telling is never a condition of starting: every spec that builds this
     *  service by hand from a client alone confirms and starts exactly as before, and tells nobody. */
    @Optional() private readonly sessions?: SessionsService,
  ) {}

  /** Read the authored criteria. The delegate check is for unit-test doubles that stub Prisma with
   * only the tables the case is about; production schema always has it. */
  private static async statedCriteria(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<StatedAcceptanceCriterion[]> {
    const delegate = (tx as unknown as {
      projectAcceptanceCriterionDefinition?: {
        findMany(args: unknown): Promise<Array<{
          id: string;
          ordinal: number;
          text: string;
          verificationMethod: string;
          completionCriterionOverrideReason: string | null;
          revision: number;
          contentHash: string;
        }>>;
      };
    }).projectAcceptanceCriterionDefinition;
    if (!delegate) return [];
    const definitions = await delegate.findMany({
      where: { projectId },
      orderBy: { ordinal: 'asc' },
      select: {
        id: true,
        ordinal: true,
        text: true,
        verificationMethod: true,
        completionCriterionOverrideReason: true,
        revision: true,
        contentHash: true,
      },
    });
    return criteriaFromDefinitions(definitions);
  }

  /**
   * The criteria a project detail read embeds.
   *
   * There is deliberately no verdict, no pass count and no last-judged time on this shape any more.
   * Reporting one would mean inventing the evaluator 0229 removed; reporting a constant would be a
   * projection that always says the same thing. A criterion is stated, and that is the whole fact.
   */
  async criteriaSummary(projectId: string): Promise<ProjectAcceptanceCriteriaSummary> {
    const stated = await ProjectAcceptanceService.statedCriteria(
      this.prisma as unknown as Prisma.TransactionClient,
      projectId,
    );
    return {
      total: stated.length,
      criteria: stated.map((criterion) => ({
        id: criterion.definitionId,
        key: criterion.key,
        text: criterion.text,
        ordinal: criterion.ordinal,
      })),
    };
  }

  /**
   * Where this project stands on owner confirmation of its acceptance standard set.
   *
   * Two reads and a comparison, and no third stored fact between them: the criteria as they are
   * now, the newest confirmation on record, and whether the second names the first. That is the
   * whole of "a confirmation stops counting once the criteria move" — there is no flag an edit
   * has to remember to clear, so there is no way for an edit to forget.
   *
   * What changed since that confirmation is taken from the same two reads (`confirmationView`), so
   * a CONFIRMED standing never has a change beside it.
   */
  async standardSetConfirmation(
    ownerId: string,
    projectId: string,
  ): Promise<StandardSetConfirmationView> {
    await this.assertProject(ownerId, projectId);
    const stated = await ProjectAcceptanceService.statedCriteria(
      this.prisma as unknown as Prisma.TransactionClient,
      projectId,
    );
    return this.confirmationView(stated, standardSetConfirmationStanding(
      standardSetVersion(stated),
      await this.latestConfirmation(projectId),
    ));
  }

  /**
   * `CONFIRM_ACCEPTANCE_CRITERIA`: the account owner says this exact version of the standard set
   * expresses the goal — the older card's "Start the project". The one door this HUMAN_ONLY action
   * has besides `startProject`; the only other writer of its rows is
   * `ProjectsService.decideCriteriaChange`, carrying a confirmation over an edit the owner approved
   * there.
   *
   * Two rules, in the order a caller can act on them.
   *
   * 1. NO ACTING SESSION. `refuseSessionAuthoredConfirmation` is the whole of the authority check
   *    and it lives here rather than at a controller, so the runner door, the user door and a
   *    direct call all meet it — §2 of `coordinator-authority.ts`, and the reason a rule enforced
   *    at one door is not a boundary.
   * 2. THE CALLER NAMES THE VERSION IT IS CONFIRMING. Without that, "confirm the criteria" means
   *    "confirm whatever they say when this request lands", and an edit that arrives between the
   *    render and the click would be confirmed by somebody who never read it. That is precisely
   *    the move this tier exists to refuse, so a digest that is no longer current is a 409 telling
   *    the caller to read the set again — not a confirmation of something else.
   *
   * What the press does after that depends on whether the project has been started.
   *
   * NOT STARTED: it starts it, as `startProject` would with the settings the start card offers when
   * nobody chose any — the line the project is already on or the owner already chose, else the
   * default rule over its tasks and dependencies as they stand; Automatic on; the concurrency limit
   * and merge check it already has. The card this door was built for never showed a setting, and a
   * press on it has always started the project, so it goes on doing that; what it starts with is now
   * written down like any other start's.
   *
   * STARTED: it confirms and does nothing else. One INSERT, deliberately not in a transaction and
   * taking no project lock: an edit landing between the comparison and the INSERT can only make the
   * row it writes non-current, which the read already reports honestly — the row says which version
   * was confirmed, and it is the read, never the write, that decides whether that version is the one
   * standing. It no longer turns Automatic on: that is a setting of how the project runs, and
   * re-confirming criteria after an edit is not a decision about it.
   */
  async confirmStandardSet(
    ownerId: string,
    projectId: string,
    input: { criteriaDigest: string },
    actingSessionId?: string,
  ): Promise<StandardSetConfirmationView> {
    const refusal = refuseSessionAuthoredConfirmation(actingSessionId);
    if (refusal) throw new ForbiddenException(refusal);
    const { startedAt } = await this.assertProject(ownerId, projectId);

    const stated = await ProjectAcceptanceService.statedCriteria(
      this.prisma as unknown as Prisma.TransactionClient,
      projectId,
    );
    const currentVersion = standardSetVersion(stated);
    if (input.criteriaDigest !== currentVersion.digest) {
      throw criteriaVersionMoved(currentVersion.digest);
    }

    if (!startedAt) {
      const started = await this.start(
        ownerId,
        projectId,
        input.criteriaDigest,
        async (tx, project) => ({
          ...(await defaultStartLine(tx, ownerId, projectId)),
          automatic: true,
          maxConcurrentTasks: project.maxConcurrentTasks,
        }),
      ).catch((error: unknown) => {
        // Started by another press between the read above and the start's lock: this one is then a
        // press on a started project, and confirms like one.
        if (isProjectAlreadyStarted(error)) return null;
        throw error;
      });
      if (started) {
        await this.afterStart(ownerId, projectId, started);
        return this.confirmationView(stated, standardSetConfirmationStanding(
          currentVersion,
          await this.latestConfirmation(projectId),
        ));
      }
    }

    await this.prisma.projectStandardSetConfirmation.create({
      data: {
        projectId,
        // The credentialed actor. On the owner door this is the same row as `ownerId` — the
        // controller passes the authenticated user as both — and it is stored separately because
        // it records WHO acted, not whose project it is.
        ownerId,
        confirmedById: ownerId,
        criteriaDigest: currentVersion.digest,
        // Prisma types a JSON column as an object-or-scalar union; the array shape is the one
        // the CHECK constraint on the column requires, so the cast is the type system catching up
        // with the database rather than a widening.
        criteriaMaterial: currentVersion.material as unknown as Prisma.InputJsonValue,
      },
    });

    // The confirmation is one of the two inputs `project-done-derived.ts` projects `status` from,
    // and it is the one that changes here — so the projection is recomputed on the spot rather
    // than waiting for the project's next task write. Deliberately after the INSERT and outside
    // any transaction: it reads committed rows, it decides nothing about whether this
    // confirmation was allowed, and a projection that could not be recomputed must not undo a
    // confirmation that was.
    await storeDerivedProjectStatus(this.prisma, ownerId, projectId, {
      sessions: this.sessions,
    }).catch((error) =>
      this.logger.warn(`derived project status not re-projected after confirmation: ${
        (error as { message?: string })?.message ?? String(error)}`),
    );

    // The same document the read answers, because the web writes this answer straight into the
    // read's cache: a confirmation answered with less would take the card's changes away until the
    // next poll.
    return this.confirmationView(stated, standardSetConfirmationStanding(
      currentVersion,
      await this.latestConfirmation(projectId),
    ));
  }

  /**
   * `POST /projects/:id/done`: the account owner records the project done, on the "Is this project
   * done?" card or on the project page, in one write.
   *
   * Refused whole for a request carrying an acting session, before anything is read — by
   * `refuseProjectStatusWrite`, the rule every session-authored write of `status` meets: a
   * coordinator asks for this (`DONE_REQUEST`), it does not record it.
   *
   * One transaction, in the canonical lock order (docs/postgres-lock-order.md):
   *
   *   1. The project row, FOR NO KEY UPDATE (rank 40). A cancelled project is refused here, and so
   *      is a seal that is not the one standing now, read under that lock so no criteria edit can
   *      land between the comparison and the write.
   *   2. The request the press answers, when it answers one (`requestId`), FOR UPDATE (rank 60): it
   *      must still be OPEN and about that same seal, or the press is a 409.
   *   3. The project: DONE, `done_by = 'OWNER'`, the instant, the seal and the accepted gaps, in one
   *      statement.
   *   4. The open request, if any, resolved APPROVED by the owner at that instant with the gaps they
   *      accepted (`answerDoneRequests`).
   *
   * Every refusal comes before the first write, so a 409 writes nothing. What the record buys is
   * `storeDerivedProjectStatus`'s rule: an ordinary task write, merge receipt or confirmation leaves
   * it alone, and only the criteria changing or a task serving one being reopened reopens it.
   */
  async recordProjectDone(
    ownerId: string,
    projectId: string,
    input: ProjectDoneRequestBody,
    actingSessionId?: string,
  ): Promise<ProjectDoneRecord> {
    const refusal = refuseProjectStatusWrite(ProjectStatus.DONE, actingSessionId);
    if (refusal) throw new ForbiddenException(refusal);
    const unanchored = input.acceptedGaps.findIndex((gap) =>
      typeof gap.criterionKey !== 'string' || gap.criterionKey.trim() === '');
    if (unanchored >= 0) {
      throw new BadRequestException(
        `acceptedGaps[${unanchored}] names no criterionKey: a gap is accepted for one criterion`,
      );
    }
    const requestId = input.requestId ?? null;
    return withTransactionRetry(this.prisma, async (tx) => {
      const [project] = await tx.$queryRaw<Array<{ status: ProjectStatus }>>(Prisma.sql`
        SELECT "status"
          FROM "project"
         WHERE "id" = ${projectId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`);
      if (!project) throw new NotFoundException('project not found');
      if (project.status === ProjectStatus.CANCELLED) {
        throw new ConflictException({
          code: 'PROJECT_CANCELLED',
          message: 'This project was cancelled, so it cannot be recorded done: nothing was written. '
            + 'Reopen it first.',
        });
      }
      const version = standardSetVersion(
        await ProjectAcceptanceService.statedCriteria(tx, projectId),
      );
      if (input.criteriaDigest !== version.digest) throw projectDoneCriteriaMoved(version.digest);

      if (requestId !== null) {
        const [request] = await tx.$queryRaw<Array<{ state: string; payload: Prisma.JsonValue }>>(
          Prisma.sql`
            SELECT "state", "payload"
              FROM "project_open_item"
             WHERE "id" = ${requestId}::uuid AND "project_id" = ${projectId}::uuid
               AND "owner_id" = ${ownerId}::uuid AND "kind" = ${DONE_REQUEST_KIND}
               FOR UPDATE`);
        if (!request) throw new NotFoundException('done request not found');
        if (request.state !== 'OPEN') throw projectDoneRequestStale('is no longer open');
        const asked = request.payload as unknown as Partial<DoneRequest> | null;
        if (asked?.criteriaDigest !== version.digest) {
          throw projectDoneRequestStale('was made about criteria that have changed since');
        }
      }

      const at = new Date();
      await tx.project.update({
        where: { id: projectId },
        data: {
          status: ProjectStatus.DONE,
          doneBy: 'OWNER' satisfies ProjectDoneBy,
          doneAt: at,
          doneCriteriaDigest: version.digest,
          acceptedGaps: input.acceptedGaps as unknown as Prisma.InputJsonValue,
        },
      });
      await answerDoneRequests(tx, {
        ownerId,
        projectId,
        requestId,
        at,
        acceptedGaps: input.acceptedGaps,
      });
      return {
        projectId,
        status: ProjectStatus.DONE,
        doneBy: 'OWNER',
        doneAt: at.toISOString(),
        criteriaDigest: version.digest,
        acceptedGaps: input.acceptedGaps,
        requestId,
      };
    }, loggedRetry(this.logger, 'projectAcceptance.recordProjectDone'));
  }

  /**
   * `POST /projects/:id/start`: the account owner starts the project, on the "Start this project?"
   * card, in one write.
   *
   * The same authority as `confirmStandardSet`, because a start IS a confirmation — of the criteria
   * the card showed, named by their seal — and of how the project is to run besides: its integration
   * line, Automatic, its concurrency limit and its merge check. Refused whole for a request carrying
   * an acting session, before anything is read; a seal that is not the current one is a 409 and
   * nothing is written; so is a project that has been started already, which is what makes a second
   * press, or a re-sent request, a refusal instead of a second start.
   *
   * `requestId` names the coordinator's start request the card was drawn from, when there was one
   * (`project-start-request.ts`): the settings it suggested are then what the start records as asked
   * for, so the receipt and the coordinator's "Project started" card mark every setting the owner
   * changed on the card. Without one, what was asked for is what the owner sent. Either way the start
   * answers whichever request is open — a started project has nothing left to ask.
   */
  async startProject(
    ownerId: string,
    projectId: string,
    input: StartProjectRequestBody,
    actingSessionId?: string,
  ): Promise<StartProjectResponse> {
    const refusal = refuseSessionAuthoredConfirmation(actingSessionId);
    if (refusal) throw new ForbiddenException(refusal);
    if (input.line === 'MAIN' && input.projectBranchName !== undefined) {
      throw new BadRequestException(
        'a project that lands directly into main has no project branch to name',
      );
    }
    await this.assertProject(ownerId, projectId);

    const asked: ProjectStartSettings = {
      line: input.line,
      ...(input.projectBranchName !== undefined ? { projectBranchName: input.projectBranchName } : {}),
      automatic: input.automatic,
      maxConcurrentTasks: input.maxConcurrentTasks,
      mergeCheckCommand: input.mergeCheckCommand ?? null,
    };
    const started = await this.start(
      ownerId,
      projectId,
      input.criteriaDigest,
      async () => asked,
      input.requestId ?? null,
    );
    await this.afterStart(ownerId, projectId, started);
    return {
      projectId,
      startedAt: started.at.toISOString(),
      criteriaDigest: started.version.digest,
      criteriaCount: started.version.material.length,
      lineLocked: started.lineLocked,
      settings: started.record.settings,
      differsFromRequest: started.record.differsFromRequest,
    };
  }

  /**
   * The start itself: one transaction, in the canonical lock order (docs/postgres-lock-order.md).
   *
   *   1. The project row, FOR NO KEY UPDATE (rank 40) — the lock `ProjectsService.update` takes
   *      before it writes the same columns. A project that has a `started_at` is refused here,
   *      409 `PROJECT_ALREADY_STARTED`, and so is a seal that is not the one standing now, read
   *      under that lock so no criteria edit can land between the comparison and the writes.
   *   2. The line and the merge check, under the binding's lock (rank 55): written as the owner's
   *      choice, unless the line has started integrating — then it is left where it is, and the
   *      answer says so (`startProjectLine`).
   *   3. Automatic and the concurrency limit — `coordinator_enabled` and `max_concurrent_tasks`,
   *      written only where they change, with the one `configRevision` bump every write of
   *      `ProjectsService.AUTHORIZATION_FIELDS` owes — and `started_at`, in the same statement, as a
   *      compare-and-set on its still being null.
   *   4. The confirmation (rank 60), naming the version confirmed and carrying what the start left
   *      the project with and which of that is not what it was asked for (`started_with`), at the
   *      same instant as `started_at`. What it was asked for is the coordinator's request when the
   *      start names one (`requestId`), and otherwise the settings the start was given.
   *   5. The open start request, if any (rank 60), resolved APPROVED at that instant
   *      (`answerStartRequests`).
   *
   * Every refusal comes before the first write, so a refused start writes nothing, and a retried
   * attempt re-reads every one of those facts under its own locks.
   */
  private async start(
    ownerId: string,
    projectId: string,
    criteriaDigest: string,
    settingsFor: (
      tx: Prisma.TransactionClient,
      project: { maxConcurrentTasks: number },
    ) => Promise<ProjectStartSettings>,
    requestId: string | null = null,
  ): Promise<ProjectStartOutcome> {
    return withTransactionRetry(this.prisma, async (tx) => {
      const [project] = await tx.$queryRaw<Array<{
        startedAt: Date | null;
        coordinatorEnabled: boolean;
        maxConcurrentTasks: number;
      }>>(Prisma.sql`
        SELECT "started_at" AS "startedAt", "coordinator_enabled" AS "coordinatorEnabled",
               "max_concurrent_tasks" AS "maxConcurrentTasks"
          FROM "project"
         WHERE "id" = ${projectId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`);
      if (!project) throw new NotFoundException('project not found');
      if (project.startedAt) throw projectAlreadyStarted(project.startedAt);
      const version = standardSetVersion(
        await ProjectAcceptanceService.statedCriteria(tx, projectId),
      );
      if (criteriaDigest !== version.digest) throw criteriaVersionMoved(version.digest);
      // The request the card was drawn from, whatever has become of it since: its settings are
      // what the card showed as suggested, which is what the owner's changes are measured against.
      const request = requestId === null ? null : await tx.projectOpenItem.findFirst({
        where: { id: requestId, projectId, kind: START_REQUEST_KIND },
        select: { payload: true },
      });
      if (requestId !== null && !request) throw new NotFoundException('start request not found');

      const asked = await settingsFor(tx, project);
      const line = await startProjectLine(tx, { ownerId, projectId, settings: asked });
      const settings: ProjectStartSettings = {
        line: line.line,
        ...(line.projectBranchName !== undefined ? { projectBranchName: line.projectBranchName } : {}),
        automatic: asked.automatic,
        maxConcurrentTasks: asked.maxConcurrentTasks,
        mergeCheckCommand: line.mergeCheckCommand,
      };

      const at = new Date();
      const authorization = {
        ...(asked.automatic !== project.coordinatorEnabled
          ? { coordinatorEnabled: asked.automatic }
          : {}),
        ...(asked.maxConcurrentTasks !== project.maxConcurrentTasks
          ? { maxConcurrentTasks: asked.maxConcurrentTasks }
          : {}),
      };
      const written = await tx.project.updateMany({
        where: { id: projectId, ownerId, startedAt: null },
        data: {
          ...authorization,
          ...(Object.keys(authorization).length > 0 ? { configRevision: { increment: 1 } } : {}),
          startedAt: at,
        },
      });
      if (written.count !== 1) throw projectAlreadyStarted(null);

      const suggested = (request?.payload as unknown as ProjectStartRequest | undefined)?.settings;
      const record: ProjectStartRecord = {
        settings,
        differsFromRequest: differingStartSettings(suggested ?? asked, settings),
      };
      const confirmation = await tx.projectStandardSetConfirmation.create({
        data: {
          projectId,
          ownerId,
          confirmedById: ownerId,
          criteriaDigest: version.digest,
          criteriaMaterial: version.material as unknown as Prisma.InputJsonValue,
          confirmedAt: at,
          startedWith: record as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await answerStartRequests(tx, { ownerId, projectId, at });
      return { confirmationId: confirmation.id, at, version, record, lineLocked: line.locked };
    }, loggedRetry(this.logger, 'projectAcceptance.start'));
  }

  /**
   * What follows a start's commit, outside it, and never at the cost of the start: the coordinator
   * conversation is told, with the settings the start left — its tasks opted into auto-run start by
   * themselves from now on, and the ones it filed to start by hand wait on it — and then `status`
   * is re-projected, the confirmation being one of the two inputs `project-done-derived.ts` reads.
   */
  private async afterStart(
    ownerId: string,
    projectId: string,
    started: ProjectStartOutcome,
  ): Promise<void> {
    if (this.sessions) {
      await tellCoordinatorProjectStarted(this.prisma, this.sessions, {
        ownerId,
        projectId,
        start: {
          by: 'CONFIRMATION',
          confirmationId: started.confirmationId,
          criteriaCount: started.version.material.length,
          at: started.at,
          record: started.record,
          lineLocked: started.lineLocked,
        },
      }).catch((error) =>
        this.logger.warn(`coordinator not told project ${projectId} was started: ${
          (error as { message?: string })?.message ?? String(error)}`),
      );
    }
    await storeDerivedProjectStatus(this.prisma, ownerId, projectId, {
      sessions: this.sessions,
    }).catch((error) =>
      this.logger.warn(`derived project status not re-projected after the start: ${
        (error as { message?: string })?.message ?? String(error)}`),
    );
  }

  /** This project, or a 404 — and whether it has been started. Tenancy, before either half of the
   *  confirmation path reads anything. */
  private async assertProject(
    ownerId: string,
    projectId: string,
  ): Promise<{ startedAt: Date | null }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { startedAt: true },
    });
    if (!project) throw new NotFoundException('project not found');
    return project;
  }

  /** The newest confirmation on record — current or not; deciding which is the caller's read. */
  private async latestConfirmation(
    projectId: string,
  ): Promise<RecordedStandardSetConfirmation | null> {
    const row = await this.prisma.projectStandardSetConfirmation.findFirst({
      where: { projectId },
      // `id` is uuid(7), so it breaks a tie inside one stored millisecond in the order the rows
      // were written rather than arbitrarily.
      orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
      select: {
        criteriaDigest: true,
        criteriaMaterial: true,
        confirmedAt: true,
        confirmedById: true,
        startedWith: true,
      },
    });
    return row === null ? null : {
      criteriaDigest: row.criteriaDigest,
      criteriaMaterial: row.criteriaMaterial as unknown as RecordedStandardSetConfirmation['criteriaMaterial'],
      confirmedAt: row.confirmedAt,
      confirmedById: row.confirmedById,
      // What a start left the project with, for the receipt of it; null on a confirmation that
      // started nothing, which is how a receipt tells the two apart.
      startedWith: (row.startedWith as unknown as ProjectStartRecord | null) ?? null,
    };
  }

  /** A standing, with what changed since the confirmation it names: `stated` against that
   *  confirmation's stored material (`criteriaChangesSinceConfirmed`). */
  private async confirmationView(
    stated: StatedAcceptanceCriterion[],
    standing: StandardSetConfirmationStanding,
  ): Promise<StandardSetConfirmationView> {
    if (standing.confirmation === null) {
      return {
        ...standing,
        changesSinceConfirmed: null,
        changesSinceConfirmedAbsentReason: 'NEVER_CONFIRMED',
      };
    }
    const confirmed = standing.confirmation.criteriaMaterial;
    return {
      ...standing,
      changesSinceConfirmed: criteriaChangesSinceConfirmed(
        stated,
        confirmed,
        await this.confirmedVerificationMethods(stated, confirmed),
      ),
      changesSinceConfirmedAbsentReason: null,
    };
  }

  /**
   * For each criterion whose content moved since the confirmation, the verification method it was
   * confirmed with — when its words are the ones it has now and that method was a rung of the
   * ladder, the only shape a tightening that landed on its own can have.
   *
   * Asked of PostgreSQL because the content hash is PostgreSQL's: the definition trigger writes it
   * with `project_acceptance_definition_content_hash` over the words AND the method, the
   * confirmation stored it, and nothing in TypeScript reproduces it. So the question is put the
   * other way round — which rung, beside the words stored on the row, hashes to what was confirmed
   * — and a criterion whose words moved, or whose confirmed method was prose, gets no answer.
   */
  private async confirmedVerificationMethods(
    stated: StatedAcceptanceCriterion[],
    confirmed: ConfirmedCriterionVersion[],
  ): Promise<Map<string, string>> {
    const current = new Map(stated.map((criterion) => [criterion.definitionId, criterion.contentHash]));
    const moved = confirmed.filter((item) =>
      current.has(item.definitionId) && current.get(item.definitionId) !== item.contentHash);
    if (moved.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{
      definitionId: string;
      verificationMethod: string;
    }>>(Prisma.sql`
      SELECT d."id"::text AS "definitionId", ladder."rung" AS "verificationMethod"
        FROM unnest(
               ${moved.map((item) => item.definitionId)}::uuid[],
               ${moved.map((item) => item.contentHash)}::text[]
             ) AS confirmed("definitionId", "contentHash")
        JOIN "project_acceptance_criterion_definition" d ON d."id" = confirmed."definitionId"
       CROSS JOIN unnest(${[...VERIFICATION_METHOD_RUNGS]}::text[]) AS ladder("rung")
       WHERE project_acceptance_definition_content_hash(d."text", ladder."rung")
             = confirmed."contentHash"`);
    return new Map(rows.map((row) => [row.definitionId, row.verificationMethod]));
  }

  /** Refresh the two digest lanes of `project_completion_contract` under the database's Project-row
   *  serialization point. That contract is a digest of what the project DECLARES — its goal, its
   *  operating settings, its members and its criterion definitions — and none of its inputs were
   *  removed by 0229. */
  async refreshCompletionContract(
    tx: Prisma.TransactionClient | PrismaService,
    projectId: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await tx.$queryRaw<Array<{ state: Prisma.JsonValue }>>(Prisma.sql`
      SELECT project_refresh_completion_contract(
        ${projectId}::uuid, ${reason}
      ) AS state
    `);
    if (!row?.state || typeof row.state !== 'object' || Array.isArray(row.state)) {
      throw new Error('completion contract refresh returned no state');
    }
    return row.state as Record<string, unknown>;
  }

  /**
   * The project row lock a merge-evidence write takes.
   *
   * `FOR NO KEY UPDATE` conflicts with another writer of the same row and not with the
   * `FOR KEY SHARE` a foreign key takes, which is the ordering §8.6 LO2 asks for.
   */
  private static async lockProject(
    tx: Prisma.TransactionClient,
    projectId: string,
    ownerId: string,
  ): Promise<{ id: string; status: ProjectStatus }> {
    const [row] = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT p."id", p."status"::text AS "status"
        FROM "project" p
       WHERE p."id" = ${projectId}::uuid AND p."owner_id" = ${ownerId}::uuid
       FOR NO KEY UPDATE`);
    if (!row) throw new NotFoundException('project not found');
    return { id: row.id, status: row.status as ProjectStatus };
  }

  private static mergeRow(row: {
    id: string; projectId: string; requirementId: string; targetBranch: string;
    contentHash: string; refGeneration: bigint; source: string; detail: unknown;
    observedAt: Date; lastSeenAt: Date;
  }) {
    return {
      id: row.id,
      projectId: row.projectId,
      requirementId: row.requirementId,
      targetBranch: row.targetBranch,
      contentHash: row.contentHash,
      refGeneration: String(row.refGeneration),
      source: row.source,
      detail: row.detail,
      observedAt: row.observedAt,
      lastSeenAt: row.lastSeenAt,
    };
  }

  /**
   * Record what a target branch was observed to contain.
   *
   * This survives 0229 because it is an OBSERVATION about a git ref, not a verdict about a
   * project: `contentHash` is taken by content, never from `git branch --contains`, which is a
   * guaranteed false negative after a squash. Nothing reads it to decide anything any more —
   * acceptance runs were its only consumer — so it is a record kept for a reader.
   */
  async recordMergeEvidence(ownerId: string, projectId: string, input: RecordMergeEvidenceInput) {
    const requirementId = (input.requirementId ?? '').trim();
    const targetBranch = (input.targetBranch ?? '').trim();
    const contentHash = (input.contentHash ?? '').trim().toLowerCase();
    if (requirementId === '' || targetBranch === '') {
      throw new BadRequestException('requirementId and targetBranch are required');
    }
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new BadRequestException(
        'contentHash must be a sha256 hex digest of the observed CONTENT — a commit SHA or a ' +
          '`git branch --contains` boolean is a guaranteed false negative after a squash',
      );
    }
    // Retried whole. The evidence row is keyed by the merge it records, so a re-run writes the same
    // row rather than a second one.
    return withTransactionRetry(this.prisma, async (tx) => {
      await ProjectAcceptanceService.lockProject(tx, projectId, ownerId);
      const [latest] = await tx.$queryRaw<Array<{
        id: string; contentHash: string; refGeneration: bigint;
      }>>(Prisma.sql`
        SELECT m."id", m."content_hash" AS "contentHash", m."ref_generation" AS "refGeneration"
          FROM "project_merge_evidence" m
         WHERE m."project_id" = ${projectId}::uuid
           AND m."requirement_id" = ${requirementId}
           AND m."target_branch" = ${targetBranch}
         ORDER BY m."ref_generation" DESC
         LIMIT 1`);

      if (latest && latest.contentHash === contentHash) {
        const row = await tx.projectMergeEvidence.update({
          where: { id: latest.id },
          data: { lastSeenAt: new Date() },
        });
        return { ...ProjectAcceptanceService.mergeRow(row), changed: false };
      }

      const row = await tx.projectMergeEvidence.create({
        data: {
          projectId,
          requirementId,
          targetBranch,
          contentHash,
          refGeneration: (latest?.refGeneration ?? 0n) + 1n,
          source: input.source ?? 'MERGE_EVIDENCE_WRITER',
          detail: (input.detail ?? {}) as Prisma.InputJsonValue,
        },
      });
      return { ...ProjectAcceptanceService.mergeRow(row), changed: true };
    }, loggedRetry(this.logger, 'projectAcceptance.recordMergeEvidence'));
  }
}
