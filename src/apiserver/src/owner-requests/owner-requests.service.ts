import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { returnSessionsToOpen } from '../sessions/return-to-open';
import { WatchDeliveryService } from '../watches/watch-delivery.service';
import type { AuthCredential } from '../common/current-user.decorator';
import { WikiRefusalError, WikiService, normalizeRepoUrl } from '../wiki/wiki.service';
import { isScheduleItemKind } from '../schedules/schedule-attention';
import { OWNER_REQUEST_FIELDS, PROJECT_REOPEN_FIELDS, queueOwnerCardTranslation, translatedInto } from '../sessions/card-translation';
import { translationLanguages, type TranslationLanguages } from '../sessions/turn-translation';
import { ownerWordsForAgent } from '../sessions/reply-translation';
import { isConditionItemKind } from '../conditions/condition-attention';
import { answerStillWaiting } from '../conditions/condition-still-waiting';
import {
  CONDITION_STILL_WAITING_KIND,
  OWNER_REQUEST_CHANGE_NOOP,
  OWNER_REQUEST_CHANGE_REPLACED_NOTE,
  toUuid,
  type OwnerRequestChangeAnswer,
  type OwnerRequestChangeFiling,
  type OwnerRequestChangeSpec,
  PROJECT_ALREADY_OPEN,
  PROJECT_REOPEN_NOTES,
  REOPEN_OWNER_CHANNEL_ONLY,
  REOPEN_REQUEST_DECLINED,
  RunEventType,
  projectReopenTitle,
  type ProjectReopenAskerView,
  type ProjectReopenSettledStatus,
} from '@orbit/shared';
import { NO_DONE_RECORD, reopenRecordOfPress } from '../projects/project-done-derived';
import { tellCoordinatorProjectReopened } from '../projects/project-started';
import { SessionsService } from '../sessions/sessions.service';
import {
  declinedSinceSettled,
  newProjectReopenPayload,
  projectReopenAskers,
  projectReopenDeclinedMessage,
  projectReopenText,
  projectSettledAt,
  settlePendingProjectReopens,
} from './project-reopen';
import { runnerSettingsData } from '../runners/runner-settings';
import { endUndeliveredGrants, enqueueResolutions } from './owner-request-endings';
import { OwnerSecretsService, type OwnerSecretGrantView } from './owner-secrets.service';
import { settingOwnerOnlyBody, settingsChangeTitle } from '@orbit/shared';
import { normalizeDefaultModels } from '../providers/engine-provider';
import { applySettingsChanges } from './settings-apply';
import {
  SettingsProposalInvalid,
  sameSettingsChanges,
  settingsChangeDeclinedMessage,
  settingsChangeEntries,
  validateSettingsChanges,
  wideningKeys,
  type SettingsChangePayload,
} from './settings-change';
import {
  BROWSER_SIGN_IN_KIND,
  OWNER_REQUEST_EXPIRED,
  OWNER_REQUEST_NOT_ASKER,
  OWNER_REQUEST_NOT_PENDING,
  OwnerRequestNotFileable,
  PROJECT_REOPEN,
  SETTINGS_ALREADY_SET,
  SETTINGS_CHANGE,
  SETTINGS_CHANGE_DECLINED,
  SETTINGS_OWNER_CHANNEL_ONLY,
  WIKI_CREATE_DAILY_RUN_LIMIT,
  browserSignInSite,
  browserSignInTitle,
  WIKI_CREATE_DECLINED,
  WIKI_CREATE_LOOKBACK_DAYS,
  WIKI_CREATE_NO_REPOSITORY,
  normalizeOwnerRequest,
  wikiCreateDeclinedMessage,
  wikiCreateTitle,
  wikiRepositoryName,
  type OwnerRequestFiling,
  type OwnerRequestOption,
  type OwnerRequestState,
} from './owner-request';

/** The longest reason a BROWSER_SIGN_IN may carry: the card quotes it whole. */
const MAX_BROWSER_SIGN_IN_REASON = 1_000;

/** How often the expiry sweep runs. A deadline is honoured to the minute. */
const EXPIRY_TICK_MS = 60_000;

/** The most rows one list read returns, newest first. */
const LIST_LIMIT = 200;

/** The owner's list filters, and the state each one reads. */
export const OWNER_REQUEST_LIST_FILTERS: Readonly<Record<string, OwnerRequestState | null>> = {
  open: 'PENDING',
  done: 'DONE',
  declined: 'DECLINED',
  expired: 'EXPIRED',
  withdrawn: 'WITHDRAWN',
  all: null,
};

/** Every column but the owner, which is the caller. */
const VIEW = {
  id: true,
  kind: true,
  state: true,
  title: true,
  why: true,
  blocksTaskIds: true,
  ifUnanswered: true,
  options: true,
  recommendedOption: true,
  steps: true,
  secretSpec: true,
  verifyHint: true,
  repoUrlNorm: true,
  workspaceId: true,
  // SCHEDULE_* items (migration 0840, schedules/schedule-attention.ts): what they are about and what answers them.
  scheduleId: true,
  scheduleRunId: true,
  approvalId: true,
  scheduleChangeRequestId: true,
  // CONDITION_* items (migration 1030, conditions/condition-attention.ts): the condition a can't-read card or the
  // 30-day question is about, which a client reads to name its schedule or task.
  conditionId: true,
  // SETTINGS_CHANGE (migration 1273): `{ changes: [{ key, from, to, tier }] }`, which the card draws.
  payload: true,
  // BROWSER_SIGN_IN (migration 1393): the site the agent named and the Orbit Cloud runner whose browser it is.
  browserSite: true,
  browserRunnerId: true,
  // CHANGE (migration 1538): `{ runnerId, field, requested, before }`, which the card draws beside the live value.
  changeSpec: true,
  expiresAt: true,
  clientRequestId: true,
  askedBySessionId: true,
  projectId: true,
  resolvedAt: true,
  resolvedByUserId: true,
  resolvedBySessionId: true,
  resolvedClient: true,
  resolutionNote: true,
  answer: true,
  // Settings › Translation (migration 1070): the agent-written fields in the owner's language, or null.
  translation: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OwnerRequestSelect;

/** The clients an owner ends a request from, as `resolved_client` stores them. */
export type OwnerRequestClient = 'web' | 'ios' | 'macos' | 'android';
const CLIENTS: ReadonlySet<string> = new Set<OwnerRequestClient>(['web', 'ios', 'macos', 'android']);

/** The client kind of an `X-Orbit-Client: <kind>/<version>` header (`ios/1.0` is `ios`), or null for anything else. */
export function ownerRequestClient(header: string | string[] | undefined): OwnerRequestClient | null {
  const slash = typeof header === 'string' ? header.indexOf('/') : -1;
  if (slash < 0) return null;
  const kind = (header as string).slice(0, slash);
  return CLIENTS.has(kind) ? (kind as OwnerRequestClient) : null;
}

/** A JSON column's value, or SQL NULL when there is none. */
function json(value: object | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
}

export type OwnerRequestView = Prisma.OwnerRequestGetPayload<{ select: typeof VIEW }> & {
  /** SECRET: the latest grant of the owner's key (design §2), or null before one was entered. Never the value. */
  secretGrant?: OwnerSecretGrantView | null;
  /** SECRET: what ends the key (§6.1) — its task (TASK_ENDED) or, for a session with no task, the session. */
  secretScope?: 'TASK' | 'SESSION';
  /** BROWSER_SIGN_IN and PROJECT_REOPEN: the asking session's title, which the card names ("From session …"); null
   *  when it has none. */
  askedBySessionTitle?: string | null;
  /** PROJECT_REOPEN: every session that asked, oldest first, with its title ("Also asked by …"). */
  askers?: ProjectReopenAskerView[];
};

/** What browser_request_sign_in files (POST /runner/browser/sign-in-requests). */
export interface BrowserSignInFiling {
  site?: string;
  reason?: string;
  clientRequestId?: string;
}

/**
 * Owner requests: filed by any session of the account, answered by the owner (migration 0503).
 *
 * Every ending is one compare-and-set on `state = 'PENDING'` (`settle`), so the first ending wins
 * and every later one is refused with the state the request is already in: terminal states are
 * final. A request whose deadline has passed is EXPIRED whether or not the sweep has reached it
 * yet — `settle` refuses it as expired, and the sweep writes it so.
 */
@Injectable()
export class OwnerRequestsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OwnerRequestsService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: OwnerSecretsService,
    /** Optional so a build or spec without PushModule files requests exactly the same. */
    @Optional() private readonly push?: PushService,
    /**
     * Only asked to start a pass now: the ending's delivery row is already committed, and the worker's own poll
     * finds it without this. Optional for the same reason as `push`.
     */
    @Optional() private readonly delivery?: WatchDeliveryService,
    /** Tells the asking session's row that what waits on the owner there changed (its
     *  `pendingApprovals`, `waitingKind` and `ownerRequests`). Optional for the same reason as `push`. */
    @Optional() private readonly realtime?: RealtimeService,
    /** What the owner's Create wiki on a WIKI_CREATE card makes the wiki through (`createWiki`). */
    @Optional() private readonly wiki?: WikiService,
    /** What tells a project's coordinator that the owner reopened it from a PROJECT_REOPEN card (`reopenProject`). */
    @Optional() private readonly sessions?: SessionsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.expireDue(new Date()).catch((e) => this.logger.error(`expiry sweep failed: ${(e as Error).message}`));
    }, EXPIRY_TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * A session files a request. Any session of the account may — not only a coordinator.
   *
   * Idempotent on `(asking session, clientRequestId)`: a call retried after a lost response gets
   * the request it already filed, in whatever state it is now, and the owner is told once. `created` says which.
   *
   * A WIKI_CREATE (docs/wiki-explicit-creation-design.md §3.6) is for the asking session's workspace's repository, read
   * here with its title: refused when the workspace has no repository, when the repository has a wiki in use
   * (WIKI_SPACE_EXISTS) or when the owner declined a wiki for it before (WIKI_CREATE_DECLINED). One card waits per
   * repository (`owner_request_wiki_create_pending_key`): filing again, from any session, answers that one, untold.
   */
  async file(
    ownerId: string,
    askingSessionId: string,
    filing: OwnerRequestFiling,
  ): Promise<OwnerRequestView & { created: boolean }> {
    const now = new Date();
    let request: ReturnType<typeof normalizeOwnerRequest>;
    try {
      request = normalizeOwnerRequest(filing, now);
    } catch (error) {
      if (error instanceof OwnerRequestNotFileable) throw new BadRequestException(error.message);
      throw error;
    }
    const session = await this.prisma.session.findFirst({
      where: { id: askingSessionId, ownerId, deletedAt: null },
      select: { id: true, workspaceId: true },
    });
    if (!session) throw new NotFoundException('the asking session is not one of this account’s');
    if (request.clientRequestId) {
      const filed = await this.prisma.ownerRequest.findFirst({
        where: { ownerId, askedBySessionId: askingSessionId, clientRequestId: request.clientRequestId },
        select: { kind: true },
      });
      // A WIKI_CREATE retried after it was answered is that answer, not a refusal of the repository it now has a wiki for;
      // a CHANGE retried after it was applied is that request, not a refusal of a value that is now the runner's own.
      if (filed?.kind === 'WIKI_CREATE' || filed?.kind === 'CHANGE') {
        return this.filedBefore(ownerId, askingSessionId, request.clientRequestId);
      }
    }
    const wikiCreate = request.kind === 'WIKI_CREATE' ? await this.wikiCreateFiling(ownerId, session.workspaceId) : null;
    const blocks = request.blocksTaskIds ?? [];
    if (blocks.length > 0) {
      const own = await this.prisma.task.count({ where: { id: { in: blocks }, ownerId } });
      if (own !== blocks.length) throw new NotFoundException('blocksTaskIds names a task this account does not have');
    }
    if (request.projectId) {
      const project = await this.prisma.project.count({ where: { id: request.projectId, ownerId } });
      if (project === 0) throw new NotFoundException('projectId names a project this account does not have');
    }
    // The secret goes to the runner this session runs on, never one the caller names (design §4.1).
    const secretSpec = request.secretSpec
      ? { ...request.secretSpec, runnerId: await this.secrets.runnerForFiling(ownerId, askingSessionId, request.secretSpec.runnerId) }
      : undefined;
    const changeSpec = request.kind === 'CHANGE' ? await this.changeFiling(ownerId, request.change!) : undefined;

    const data = {
      ownerId,
      askedBySessionId: askingSessionId,
      projectId: request.projectId ?? null,
      kind: request.kind,
      state: 'PENDING',
      title: wikiCreate?.title ?? request.title!,
      why: request.why,
      blocksTaskIds: blocks,
      ifUnanswered: request.ifUnanswered ?? null,
      options: json(request.options),
      recommendedOption: request.recommendedOption ?? null,
      steps: json(request.steps),
      secretSpec: json(secretSpec),
      verifyHint: request.verifyHint ?? null,
      repoUrlNorm: wikiCreate?.repoUrlNorm ?? null,
      workspaceId: wikiCreate?.workspaceId ?? null,
      changeSpec: json(changeSpec),
      expiresAt: request.expiresAtDate,
      clientRequestId: request.clientRequestId ?? null,
    } satisfies Prisma.OwnerRequestCreateManyInput;
    const [created] = changeSpec
      ? await this.insertChange(data, changeSpec)
      : await this.prisma.ownerRequest.createManyAndReturn({ data: [data], skipDuplicates: true, select: VIEW });
    if (created) {
      // The asking session is now waiting on its owner: its row moves to the top of their list (session.listed_at,
      // sessions/session-listed-at.ts), before the summary below is published.
      await this.prisma.session.updateMany({ where: { id: created.askedBySessionId }, data: { listedAt: new Date() } });
      // The request's card is drawn in the session that asked, and only an Open row lights: one the
      // owner had filed in Completed comes back (a Trash one cannot file, above). After the commit,
      // and never a reason for the filing to fail.
      const reopened = await returnSessionsToOpen(this.prisma, ownerId, [askingSessionId], this.logger)
        .catch((error: unknown) => {
          this.logger.warn(`could not bring session ${askingSessionId} back to Open: ${(error as Error).message}`);
          return [] as string[];
        });
      for (const sessionId of reopened) this.realtime?.publishSessionCreated(sessionId);
      // Told after the row is committed, and never awaited: the request is the fact, the banner a reader of it.
      void this.push?.notifyOwnerRequest(created.id);
      this.realtime?.publishOwnerSignalChanged(ownerId, [askingSessionId]);
      // And translated for the owner in the background, when their translation is on (decision 1A).
      void translationLanguages(this.prisma, ownerId)
        .then((langs) => { if (langs) this.queueTranslation(ownerId, created, langs); })
        .catch((error: Error) => this.logger.warn(`translating request ${created.id} failed to queue: ${error.message}`));
      return { ...created, created: true };
    }
    // A WIKI_CREATE meeting the card already waiting for its repository answers that card, and the owner is not told again.
    if (wikiCreate) {
      const open = await this.prisma.ownerRequest.findFirst({
        where: { ownerId, kind: 'WIKI_CREATE', state: 'PENDING', repoUrlNorm: wikiCreate.repoUrlNorm },
        select: VIEW,
      });
      if (open) return { ...open, created: false };
    }
    // Otherwise only a duplicate key reaches here: this session already filed under this clientRequestId.
    return this.filedBefore(ownerId, askingSessionId, request.clientRequestId);
  }

  /** The request this session already filed under this clientRequestId, in whatever state it is now. */
  private async filedBefore(
    ownerId: string,
    askingSessionId: string,
    clientRequestId: string | undefined,
  ): Promise<OwnerRequestView & { created: boolean }> {
    const already = clientRequestId
      ? await this.prisma.ownerRequest.findFirst({
        where: { ownerId, askedBySessionId: askingSessionId, clientRequestId },
        select: { id: true },
      })
      : null;
    if (!already) throw new ConflictException('the request under this clientRequestId could not be read back; try again');
    return { ...(await this.get(ownerId, already.id)), created: false };
  }

  /**
   * What a CHANGE is for, or why it may not be filed (docs/design/owner-request-change.md §2): one of the owner's runners,
   * whose setting does not already have the value asked for. Any runner that is not the owner's is not found, the answer
   * `GET /runners/:id` gives. `before` is read here, never taken from the caller.
   */
  private async changeFiling(ownerId: string, change: OwnerRequestChangeFiling): Promise<OwnerRequestChangeSpec> {
    let runnerId: string;
    try {
      runnerId = toUuid(change.runnerId);
    } catch {
      throw new NotFoundException('runner not found');
    }
    const runner = await this.prisma.runner.findFirst({ where: { id: runnerId, ownerId }, select: { maxConcurrent: true } });
    if (!runner) throw new NotFoundException('runner not found');
    if (runner.maxConcurrent === change.maxConcurrent) {
      throw new ConflictException({
        code: OWNER_REQUEST_CHANGE_NOOP,
        message: `This runner's Max Concurrent is already ${runner.maxConcurrent}; nothing was filed.`,
      });
    }
    return { runnerId, field: 'maxConcurrent', requested: change.maxConcurrent, before: runner.maxConcurrent };
  }

  /**
   * A CHANGE's insert (design §2, "one pending change per runner setting"): in one transaction, every PENDING CHANGE of
   * the owner for the same runner and field ends WITHDRAWN with the note `Replaced by a newer request`, each with its
   * delivery to the session that asked, and the new request is inserted. `owner_request_change_pending_key` holds the
   * rest: two filings that race cannot both stay pending — the second's INSERT waits for the first and is refused on the
   * key once it commits, and is filed again (at most three times), when its UPDATE withdraws the first.
   *
   * A filing retried under a clientRequestId this session already used inserts nothing and withdraws nothing: the caller
   * reads back the request filed before. Answers the row it inserted, or none.
   */
  private async insertChange(
    data: Prisma.OwnerRequestCreateManyInput,
    spec: OwnerRequestChangeSpec,
  ): Promise<OwnerRequestView[]> {
    const fileOnce = () => withTransactionRetry(this.prisma, async (tx) => {
      if (data.clientRequestId) {
        const filed = await tx.ownerRequest.findFirst({
          where: { askedBySessionId: data.askedBySessionId, clientRequestId: data.clientRequestId },
          select: { id: true },
        });
        if (filed) return { created: [], replaced: [] };
      }
      const now = new Date();
      const replaced = await tx.ownerRequest.updateManyAndReturn({
        where: {
          ownerId: data.ownerId,
          kind: 'CHANGE',
          state: 'PENDING',
          AND: [
            { changeSpec: { path: ['runnerId'], equals: spec.runnerId } },
            { changeSpec: { path: ['field'], equals: spec.field } },
          ],
        },
        data: {
          state: 'WITHDRAWN',
          resolvedAt: now,
          resolvedBySessionId: data.askedBySessionId,
          resolutionNote: OWNER_REQUEST_CHANGE_REPLACED_NOTE,
        },
        select: { id: true, askedBySessionId: true },
      });
      await enqueueResolutions(tx, replaced.map((row) => row.id));
      const created = await tx.ownerRequest.create({ data, select: VIEW });
      return { created: [created], replaced };
    }, loggedRetry(this.logger, 'ownerRequests.insertChange'));
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { created, replaced } = await fileOnce();
        if (replaced.length > 0) this.delivery?.kick();
        for (const sessionId of new Set(replaced.map((row) => row.askedBySessionId))) {
          this.realtime?.publishSessionUpdated(sessionId);
        }
        return created;
      } catch (error) {
        const pendingTaken = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!pendingTaken || attempt >= 3) throw error;
      }
    }
  }

  /**
   * A session proposes a change to the owner's own Settings (docs/settings-from-conversation-design.md §5.1), filed as
   * a SETTINGS_CHANGE card the owner approves or declines. Nothing here writes a preference.
   *
   *   1. every key is in the tier table and every value passes the PATCH's rules (400), `defaultModels` normalised;
   *   2. each key's value in force is recorded beside its new value, and a change to what is already in force is
   *      dropped: with nothing left, 409 SETTINGS_ALREADY_SET;
   *   3. any change that widens agent reach refuses the whole proposal, 403 SETTING_OWNER_ONLY (§6);
   *   4. a change this session's card was declined for is refused, 409 SETTINGS_CHANGE_DECLINED;
   *   5. this session's previous PENDING card is WITHDRAWN in the transaction that files the new one, so the owner never
   *      answers a stale card (`owner_request_settings_change_pending_key` holds a session to one). The session is not
   *      woken for it: it is told here, in `withdrawnRequestIds`;
   *   6. the card is filed with the server's title, "Change N setting(s)?", and `{ changes }` as its payload.
   */
  async proposeSettings(
    ownerId: string,
    askingSessionId: string,
    proposal: { changes: Record<string, unknown>; why: string },
  ): Promise<OwnerRequestView & { created: true; withdrawnRequestIds: string[] }> {
    const why = proposal.why?.trim();
    if (!why) throw new BadRequestException('why is required: say what the person asked for');
    let proposed: Awaited<ReturnType<typeof validateSettingsChanges>>;
    try {
      proposed = await validateSettingsChanges(proposal.changes ?? {});
    } catch (error) {
      if (error instanceof SettingsProposalInvalid) throw new BadRequestException(error.message);
      throw error;
    }
    const session = await this.prisma.session.findFirst({
      where: { id: askingSessionId, ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('the asking session is not one of this account’s');
    if (proposed.defaultModels !== undefined) {
      proposed.defaultModels = await normalizeDefaultModels(this.prisma, ownerId, proposed.defaultModels as Record<string, string>);
    }
    const user = await this.prisma.user.findUnique({ where: { id: ownerId }, select: { preferences: true } });
    const changes = settingsChangeEntries((user?.preferences ?? {}) as Record<string, unknown>, proposed);
    if (changes.length === 0) {
      throw new ConflictException({
        code: SETTINGS_ALREADY_SET,
        message: 'Every setting proposed already has that value; nothing was filed.',
      });
    }
    const widening = wideningKeys(changes);
    if (widening.length > 0) throw new ForbiddenException(settingOwnerOnlyBody(widening));
    const declined = await this.prisma.ownerRequest.findMany({
      where: { ownerId, askedBySessionId: askingSessionId, kind: SETTINGS_CHANGE, state: 'DECLINED' },
      orderBy: { resolvedAt: 'desc' },
      select: { id: true, payload: true, resolvedAt: true, resolutionNote: true },
    });
    const refused = declined.find((request) => sameSettingsChanges(request.payload, changes));
    if (refused) {
      throw new ConflictException({
        code: SETTINGS_CHANGE_DECLINED,
        message: settingsChangeDeclinedMessage(refused.resolvedAt!, refused.resolutionNote),
        requestId: refused.id,
        declinedAt: refused.resolvedAt!.toISOString(),
        reason: refused.resolutionNote,
      });
    }

    const payload: SettingsChangePayload = { changes };
    // Two filings of one session at once: the second's insert waits on the pending key and fails once the first
    // commits. Filed again, it withdraws the first, as filing after it would have.
    const fileOnce = () => withTransactionRetry(this.prisma, async (tx) => {
      const now = new Date();
      const withdrawn = await tx.ownerRequest.updateManyAndReturn({
        where: { ownerId, askedBySessionId: askingSessionId, kind: SETTINGS_CHANGE, state: 'PENDING' },
        data: {
          state: 'WITHDRAWN',
          resolvedAt: now,
          resolvedBySessionId: askingSessionId,
          resolutionNote: 'Replaced by a newer settings proposal from the same session.',
        },
        select: { id: true },
      });
      const created = await tx.ownerRequest.create({
        data: {
          ownerId,
          askedBySessionId: askingSessionId,
          kind: SETTINGS_CHANGE,
          state: 'PENDING',
          title: settingsChangeTitle(changes.length),
          why,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
        select: VIEW,
      });
      return { created, withdrawn: withdrawn.map((row) => row.id) };
    }, loggedRetry(this.logger, 'ownerRequests.proposeSettings'));
    let filed: Awaited<ReturnType<typeof fileOnce>>;
    for (let attempt = 1; ; attempt += 1) {
      try {
        filed = await fileOnce();
        break;
      } catch (error) {
        const pendingTaken = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!pendingTaken || attempt >= 3) throw error;
      }
    }
    const { created, withdrawn } = filed;
    void this.push?.notifyOwnerRequest(created.id);
    this.realtime?.publishSessionUpdated(created.askedBySessionId);
    void translationLanguages(this.prisma, ownerId)
      .then((langs) => { if (langs) this.queueTranslation(ownerId, created, langs); })
      .catch((error: Error) => this.logger.warn(`translating request ${created.id} failed to queue: ${error.message}`));
    return { ...created, created: true, withdrawnRequestIds: withdrawn };
  }

  /**
   * A session asks the owner to reopen a DONE or CANCELLED project (docs/project-reopen-request-design.md §4.1), filed
   * as a PROJECT_REOPEN card the owner answers Reopen or declines. Nothing here writes the project.
   *
   *   1. the project is read under the owner (404); an OPEN one is 409 PROJECT_ALREADY_OPEN, nothing filed;
   *   2. `why` and `plannedWork` are each trimmed, non-empty and at most 2,000 characters (400);
   *   3. a DECLINED PROJECT_REOPEN this session asked over the settlement the project still stands in is 409
   *      REOPEN_REQUEST_DECLINED, with the decline's date and reason;
   *   4. one card waits per project (`owner_request_project_reopen_pending_key`): a session asking while one is PENDING
   *      joins its `askers`, so its ending reaches it too, and gets it back with `alreadyOpen: true`;
   *   5. otherwise the card is filed with the server's title, "Reopen project “<title>”?", and
   *      `{ projectId, statusAtAsk, settledAt, plannedWork, askers }` as its payload.
   */
  async fileProjectReopen(
    ownerId: string,
    caller: { runnerId: string; sessionHeader: string | undefined },
    projectId: string,
    filing: { why?: unknown; plannedWork?: unknown },
  ): Promise<OwnerRequestView & { created: boolean; alreadyOpen: boolean }> {
    const askingSessionId = await this.hostedSession(ownerId, caller.runnerId, caller.sessionHeader);
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true, title: true, status: true, doneAt: true, updatedAt: true },
    });
    if (!project) throw new NotFoundException('project not found');
    if (project.status === 'OPEN') {
      throw new ConflictException({
        code: PROJECT_ALREADY_OPEN,
        message: `Project “${project.title}” is OPEN; nothing was filed. Retry the write that was refused.`,
        projectId,
      });
    }
    const text = projectReopenText(filing);
    if ('error' in text) throw new BadRequestException(text.error);
    const declined = await this.prisma.ownerRequest.findMany({
      where: { ownerId, projectId, kind: PROJECT_REOPEN, state: 'DECLINED' },
      orderBy: { resolvedAt: 'desc' },
      select: { id: true, askedBySessionId: true, payload: true, resolvedAt: true, resolutionNote: true },
    });
    const refused = declined.find((request) =>
      (request.askedBySessionId === askingSessionId
        || projectReopenAskers(request.payload).some((asker) => asker.sessionId === askingSessionId))
      && declinedSinceSettled(request.payload, project));
    if (refused) {
      throw new ConflictException({
        code: REOPEN_REQUEST_DECLINED,
        message: projectReopenDeclinedMessage(refused.resolvedAt!, refused.resolutionNote),
        requestId: refused.id,
        projectId,
        declinedAt: refused.resolvedAt!.toISOString(),
        reason: refused.resolutionNote,
      });
    }

    // Two sessions asking at once: the second's insert waits on the pending key and fails once the first commits.
    // Filed again, it finds that card and joins it, as asking after it would have.
    const fileOnce = () => withTransactionRetry(this.prisma, async (tx) => {
      const now = new Date();
      // The project row shared-locked, as every reopen locks it to write: a card is never filed beside a reopen that
      // committed after the read above, which would leave it waiting on an OPEN project.
      const [locked] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT "status"::text AS "status" FROM "project"
         WHERE "id" = ${projectId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR SHARE`;
      if (!locked) throw new NotFoundException('project not found');
      if (locked.status === 'OPEN') {
        throw new ConflictException({
          code: PROJECT_ALREADY_OPEN,
          message: `Project “${project.title}” was reopened just now; nothing was filed. Retry the write that was refused.`,
          projectId,
        });
      }
      const [pending] = await tx.$queryRaw<Array<{ id: string; askedBySessionId: string; payload: Prisma.JsonValue }>>`
        SELECT "id", "asked_by_session_id" AS "askedBySessionId", "payload"
          FROM "owner_request"
         WHERE "owner_id" = ${ownerId}::uuid AND "project_id" = ${projectId}::uuid
           AND "kind" = ${PROJECT_REOPEN} AND "state" = 'PENDING'
           FOR UPDATE`;
      if (pending) {
        const askers = projectReopenAskers(pending.payload);
        const asked = pending.askedBySessionId === askingSessionId || askers.some((a) => a.sessionId === askingSessionId);
        if (!asked) {
          const payload = { ...(pending.payload as object), askers: [...askers, { sessionId: askingSessionId, askedAt: now.toISOString() }] };
          await tx.ownerRequest.update({
            where: { id: pending.id },
            data: { payload: payload as unknown as Prisma.InputJsonValue },
            select: { id: true },
          });
        }
        return { id: pending.id, created: false, joined: !asked };
      }
      const created = await tx.ownerRequest.create({
        data: {
          ownerId,
          askedBySessionId: askingSessionId,
          projectId,
          kind: PROJECT_REOPEN,
          state: 'PENDING',
          title: projectReopenTitle(project.title),
          why: text.why,
          payload: newProjectReopenPayload({
            projectId,
            statusAtAsk: project.status as ProjectReopenSettledStatus,
            settledAt: projectSettledAt(project),
            plannedWork: text.plannedWork,
            sessionId: askingSessionId,
            now,
          }) as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { id: created.id, created: true, joined: false };
    }, loggedRetry(this.logger, 'ownerRequests.fileProjectReopen'));
    let filed: Awaited<ReturnType<typeof fileOnce>>;
    for (let attempt = 1; ; attempt += 1) {
      try {
        filed = await fileOnce();
        break;
      } catch (error) {
        const pendingTaken = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!pendingTaken || attempt >= 3) throw error;
      }
    }
    const view = await this.get(ownerId, filed.id);
    if (filed.created || filed.joined) {
      // The asking session is now waiting on its owner: its row moves to the top of their list, as any filing's does.
      await this.prisma.session.updateMany({ where: { id: askingSessionId }, data: { listedAt: new Date() } });
      this.realtime?.publishOwnerSignalChanged(ownerId, [askingSessionId]);
    }
    if (filed.created) {
      void this.push?.notifyOwnerRequest(view.id);
      void translationLanguages(this.prisma, ownerId)
        .then((langs) => { if (langs) this.queueTranslation(ownerId, view, langs); })
        .catch((error: Error) => this.logger.warn(`translating request ${view.id} failed to queue: ${error.message}`));
    }
    return { ...view, created: filed.created, alreadyOpen: !filed.created };
  }

  /** The session a runner route names in X-Orbit-Session-Id, checked to be one this runner hosts. */
  private async hostedSession(ownerId: string, runnerId: string, header: string | undefined): Promise<string> {
    const named = header?.trim();
    if (!named) {
      throw new BadRequestException('missing session context: a reopen request is always some session’s, so this door needs X-Orbit-Session-Id');
    }
    let id: string;
    try {
      id = toUuid(named);
    } catch {
      throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    }
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId, assignedRunnerId: runnerId, deletedAt: null },
      select: { id: true },
    });
    if (!session) throw new ForbiddenException('X-Orbit-Session-Id names no session this runner hosts');
    return session.id;
  }

  /**
   * The owner's Reopen on a PROJECT_REOPEN card (docs/project-reopen-request-design.md §4.2), in one transaction under
   * the project row's lock: a project already OPEN (the owner pressed Reopen on the project page meanwhile) is left as
   * it is and the card settles DONE "Already reopened"; otherwise the project is written OPEN with exactly the record
   * the page's press writes (`reopenRecordOfPress`, migration 0469), so the projection leaves it standing. Either way
   * every PENDING PROJECT_REOPEN of the project settles DONE, each with its delivery to every session that asked it.
   * After the commit the project's coordinator is told, unless it asked (its ending says so). The owner's own login
   * only: a request carrying an acting session is refused REOPEN_OWNER_CHANNEL_ONLY before anything is read, and a
   * personal access token never reaches this door (@PatForbidden('OWNER_INTERACTIVE')).
   */
  async reopenProject(
    ownerId: string,
    id: string,
    actingSessionId: string | null,
    client: OwnerRequestClient | null = null,
  ): Promise<OwnerRequestView> {
    if (actingSessionId !== null) {
      throw new ForbiddenException({
        code: REOPEN_OWNER_CHANNEL_ONLY,
        message: 'a project is reopened by the account owner, signed in, with no acting session: the owner presses Reopen on the card.',
      });
    }
    const request = await this.get(ownerId, id);
    if (request.kind !== PROJECT_REOPEN) throw new BadRequestException('only a PROJECT_REOPEN request reopens a project');
    const notPending = (state: string) => new ConflictException({
      code: OWNER_REQUEST_NOT_PENDING,
      state,
      message: `this request is already ${state}; an ended request is final and nothing was written`,
    });
    if (request.state !== 'PENDING') throw notPending(request.state);
    const projectId = request.projectId!;
    const answered = await withTransactionRetry(this.prisma, async (tx) => {
      const now = new Date();
      const [project] = await tx.$queryRaw<Array<{ status: string; doneAt: Date | null; updatedAt: Date; coordinatorSessionId: string | null }>>`
        SELECT "status"::text AS "status", "done_at" AS "doneAt", "updated_at" AS "updatedAt",
               "coordinator_session_id" AS "coordinatorSessionId"
          FROM "project"
         WHERE "id" = ${projectId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR NO KEY UPDATE`;
      if (!project) throw new NotFoundException('project not found');
      const alreadyOpen = project.status === 'OPEN';
      if (!alreadyOpen) {
        const reopen = await reopenRecordOfPress(tx, ownerId, projectId);
        await tx.project.update({
          where: { id: projectId },
          data: { status: 'OPEN', ...NO_DONE_RECORD, ...reopen },
          select: { id: true },
        });
      }
      const settled = await settlePendingProjectReopens(tx, ownerId, projectId, 'DONE', {
        resolvedByUserId: ownerId,
        resolvedClient: client,
        resolutionNote: alreadyOpen ? PROJECT_REOPEN_NOTES.alreadyReopened : null,
      }, now);
      // The card this answer was pressed on ended meanwhile (declined, withdrawn, or the project deleted): the press
      // rolls back whole.
      if (!settled.some((row) => row.id === id)) throw notPending((await tx.ownerRequest.findUnique({ where: { id }, select: { state: true } }))?.state ?? 'gone');
      return { settled, alreadyOpen, settledAt: projectSettledAt(project), coordinatorSessionId: project.coordinatorSessionId };
    }, loggedRetry(this.logger, 'ownerRequests.reopenProject'));
    this.delivery?.kick();
    const askers = [...new Set(answered.settled.flatMap((row) => row.askers))];
    this.realtime?.publishOwnerSignalChanged(ownerId, askers);
    this.realtime?.publishForUser(ownerId, RunEventType.PROJECT_CHANGED, projectId);
    if (!answered.alreadyOpen && this.sessions
      && !(answered.coordinatorSessionId && askers.includes(answered.coordinatorSessionId))) {
      const plannedWork = (request.payload as { plannedWork?: string } | null)?.plannedWork ?? '';
      await tellCoordinatorProjectReopened(this.prisma, this.sessions, {
        ownerId,
        projectId,
        doneAt: answered.settledAt,
        reason: { kind: 'OWNER_REOPENED_ON_REQUEST', requestId: id, plannedWork },
      }).catch((e) =>
        this.logger.warn(`coordinator not told project ${projectId} was reopened: ${(e as { message?: string })?.message ?? String(e)}`));
    }
    return this.get(ownerId, id);
  }

  /**
   * A session leaving a PROJECT_REOPEN card others asked too (design §5): it is taken off `askers`, and the card waits
   * on for the rest; the asking session's place passes to the next asker when it was the first. Null when this session
   * is its only asker — the card is withdrawn as any request is — or not an asker at all.
   */
  private async leaveProjectReopen(ownerId: string, sessionId: string, id: string): Promise<OwnerRequestView | null> {
    const left = await withTransactionRetry(this.prisma, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ askedBySessionId: string; payload: Prisma.JsonValue }>>`
        SELECT "asked_by_session_id" AS "askedBySessionId", "payload"
          FROM "owner_request"
         WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid AND "state" = 'PENDING'
           FOR UPDATE`;
      if (!row) return false;
      const askers = projectReopenAskers(row.payload);
      const rest = askers.filter((a) => a.sessionId !== sessionId);
      if (rest.length === askers.length || rest.length === 0) return false;
      await tx.ownerRequest.update({
        where: { id },
        data: {
          askedBySessionId: row.askedBySessionId === sessionId ? rest[0].sessionId : row.askedBySessionId,
          payload: { ...(row.payload as object), askers: rest } as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return true;
    }, loggedRetry(this.logger, 'ownerRequests.leaveProjectReopen'));
    if (!left) return null;
    this.realtime?.publishOwnerSignalChanged(ownerId, [sessionId]);
    return this.get(ownerId, id);
  }

  /**
   * What a WIKI_CREATE is for, or why it may not be filed (design §3.6): the asking session's workspace's repository,
   * which has no wiki in use and was never declined one. Asked before anything is written.
   */
  private async wikiCreateFiling(
    ownerId: string,
    workspaceId: string | null,
  ): Promise<{ repoUrlNorm: string; workspaceId: string; title: string }> {
    const workspace = workspaceId
      ? await this.prisma.workspace.findFirst({ where: { id: workspaceId, ownerId }, select: { id: true, repoUrl: true } })
      : null;
    const repoUrlNorm = workspace?.repoUrl ? normalizeRepoUrl(workspace.repoUrl) : null;
    if (!workspace || repoUrlNorm === null) {
      throw new ConflictException({
        code: WIKI_CREATE_NO_REPOSITORY,
        message: 'This session\'s workspace has no repository, so there is no wiki to ask for.',
      });
    }
    const inUse = await this.prisma.wikiSpace.count({ where: { ownerId, repoUrlNorm, deletedAt: null } });
    if (inUse > 0) {
      throw new ConflictException({ code: 'WIKI_SPACE_EXISTS', message: 'This repository already has a wiki.' });
    }
    const declined = await this.prisma.ownerRequest.findFirst({
      where: { ownerId, kind: 'WIKI_CREATE', state: 'DECLINED', repoUrlNorm },
      orderBy: { resolvedAt: 'asc' },
      select: { resolvedAt: true },
    });
    if (declined) {
      throw new ConflictException({ code: WIKI_CREATE_DECLINED, message: wikiCreateDeclinedMessage(declined.resolvedAt!) });
    }
    return { repoUrlNorm, workspaceId: workspace.id, title: wikiCreateTitle(repoUrlNorm) };
  }

  /**
   * browser_request_sign_in (board docs/mocks/runner-browser/03-agent-tools.html ①): the asking session, on the account's
   * Orbit Cloud runner `runnerId` (the caller checked both), asks the owner to sign in to `site` in that runner's
   * browser. A BROWSER_SIGN_IN card: Orbit writes its title from the site, the agent's reason is its `why`, and it is
   * told to the owner like every other card (push, web, Mac). Only the site is stored of the browser: no page, cookie or
   * login state. Idempotent on (asking session, clientRequestId), as `file` is.
   */
  async fileBrowserSignIn(
    ownerId: string,
    askingSessionId: string,
    runnerId: string,
    filing: BrowserSignInFiling,
  ): Promise<OwnerRequestView & { created: boolean }> {
    const site = browserSignInSite(filing.site);
    if (!site) throw new BadRequestException('site is the host to sign in to, such as github.com');
    const why = filing.reason?.trim();
    if (!why) throw new BadRequestException('reason is required: say what the sign-in is for, so the owner can decide');
    if (why.length > MAX_BROWSER_SIGN_IN_REASON) {
      throw new BadRequestException(`reason is at most ${MAX_BROWSER_SIGN_IN_REASON} characters`);
    }
    const clientRequestId = filing.clientRequestId?.trim() || null;
    const [created] = await this.prisma.ownerRequest.createManyAndReturn({
      data: [{
        ownerId,
        askedBySessionId: askingSessionId,
        kind: BROWSER_SIGN_IN_KIND,
        state: 'PENDING',
        title: browserSignInTitle(site),
        why,
        browserSite: site,
        browserRunnerId: runnerId,
        clientRequestId,
      }],
      skipDuplicates: true,
      select: VIEW,
    });
    if (created) {
      void this.push?.notifyOwnerRequest(created.id);
      this.realtime?.publishSessionUpdated(created.askedBySessionId);
      void translationLanguages(this.prisma, ownerId)
        .then((langs) => { if (langs) this.queueTranslation(ownerId, created, langs); })
        .catch((error: Error) => this.logger.warn(`translating request ${created.id} failed to queue: ${error.message}`));
      const [view] = await this.withSessionTitles(ownerId, [created]);
      return { ...view, created: true };
    }
    return this.filedBefore(ownerId, askingSessionId, clientRequestId ?? undefined);
  }

  /**
   * Each BROWSER_SIGN_IN and PROJECT_REOPEN request with its asking session's title, which its card names, and each
   * PROJECT_REOPEN with every session that asked it.
   */
  private async withSessionTitles(ownerId: string, requests: OwnerRequestView[]): Promise<OwnerRequestView[]> {
    const named = (r: OwnerRequestView) => r.kind === BROWSER_SIGN_IN_KIND || r.kind === PROJECT_REOPEN;
    const askers = [...new Set(requests.filter(named).flatMap((r) => [
      r.askedBySessionId,
      ...(r.kind === PROJECT_REOPEN ? projectReopenAskers(r.payload).map((a) => a.sessionId) : []),
    ]))];
    if (askers.length === 0) return requests;
    const sessions = await this.prisma.session.findMany({ where: { id: { in: askers }, ownerId }, select: { id: true, title: true } });
    const titleOf = new Map(sessions.map((s) => [s.id, s.title]));
    return requests.map((r) => {
      if (!named(r)) return r;
      const view = { ...r, askedBySessionTitle: titleOf.get(r.askedBySessionId) ?? null };
      if (r.kind !== PROJECT_REOPEN) return view;
      return { ...view, askers: projectReopenAskers(r.payload).map((a) => ({ ...a, title: titleOf.get(a.sessionId) ?? null })) };
    });
  }

  /** The owner's requests in one list (`open` unless named), newest first. */
  async list(ownerId: string, filter: string | undefined): Promise<{ requests: OwnerRequestView[] }> {
    const key = filter ?? 'open';
    if (!(key in OWNER_REQUEST_LIST_FILTERS)) {
      throw new BadRequestException(`state is one of ${Object.keys(OWNER_REQUEST_LIST_FILTERS).join(', ')}`);
    }
    const state = OWNER_REQUEST_LIST_FILTERS[key];
    await this.settleMadeWikis(ownerId);
    const requests = await this.prisma.ownerRequest.findMany({
      where: { ownerId, ...(state ? { state } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
      select: VIEW,
    });
    await this.translateUntranslated(ownerId, requests).catch((error: Error) =>
      this.logger.warn(`queueing request translations failed: ${error.message}`));
    return { requests: await this.withSessionTitles(ownerId, await this.withGrants(ownerId, requests)) };
  }

  /**
   * Queue the translation of one request's card into the owner's language (sessions/card-translation.ts): stored
   * in `translation` while the request is still PENDING, and the asking session's row announced (`session.updated`,
   * as filing it is) so clients read it again. A SCHEDULE_* item is Orbit's own words, not an agent's, and is not
   * translated. Returns at once: true when it queued one.
   */
  queueTranslation(
    ownerId: string,
    request: { id: string; kind: string; askedBySessionId: string },
    langs: TranslationLanguages,
  ): boolean {
    if (isScheduleItemKind(request.kind)) return false;
    return queueOwnerCardTranslation({
      key: `owner-request:${request.id}`,
      read: async () => {
        const row = await this.prisma.ownerRequest.findFirst({
          where: { id: request.id, ownerId, state: 'PENDING' },
          select: {
            kind: true, title: true, why: true, ifUnanswered: true, options: true, steps: true, verifyHint: true,
            payload: true, translation: true,
          },
        });
        if (!row) return null;
        // A PROJECT_REOPEN's planned work is the agent's words too (design §4.1 step 6); its other payload fields are
        // Orbit's.
        if (row.kind === PROJECT_REOPEN) {
          const plannedWork = (row.payload as { plannedWork?: unknown } | null)?.plannedWork;
          return { source: { ...row, plannedWork }, fields: PROJECT_REOPEN_FIELDS, translation: row.translation };
        }
        return { source: row, fields: OWNER_REQUEST_FIELDS, translation: row.translation };
      },
      write: async (translation) => (await this.prisma.ownerRequest.updateMany({
        where: { id: request.id, ownerId, state: 'PENDING' },
        data: { translation: translation as unknown as Prisma.InputJsonValue },
      })).count > 0,
      published: () => this.realtime?.publishSessionUpdated(request.askedBySessionId),
    }, langs);
  }

  /**
   * Decision 1A: a PENDING request with no translation in the owner's current language — translation was turned on
   * after it was filed, or the language changed — gets one queued as the list is read; one already tried in this
   * language, failed or not, is left, and one queued or running is not queued again.
   */
  private async translateUntranslated(
    ownerId: string,
    requests: ReadonlyArray<{ id: string; kind: string; state: string; askedBySessionId: string; translation: unknown }>,
  ): Promise<void> {
    const pending = requests.filter((r) => r.state === 'PENDING' && !isScheduleItemKind(r.kind));
    if (pending.length === 0) return;
    const langs = await translationLanguages(this.prisma, ownerId);
    if (!langs) return;
    for (const request of pending) {
      if (!translatedInto(request.translation, langs)) this.queueTranslation(ownerId, request, langs);
    }
  }

  async get(ownerId: string, id: string): Promise<OwnerRequestView> {
    let request = await this.prisma.ownerRequest.findFirst({ where: { id, ownerId }, select: VIEW });
    if (!request) throw new NotFoundException('owner request not found');
    if (request.kind === 'WIKI_CREATE' && request.state === 'PENDING' && (await this.settleMadeWikis(ownerId)).includes(id)) {
      request = (await this.prisma.ownerRequest.findFirst({ where: { id, ownerId }, select: VIEW }))!;
    }
    const [view] = await this.withSessionTitles(ownerId, await this.withGrants(ownerId, [request]));
    return view;
  }

  /** Each SECRET request with what its card shows of its key's grant. */
  private async withGrants(ownerId: string, requests: OwnerRequestView[]): Promise<OwnerRequestView[]> {
    const secretIds = requests.filter((r) => r.kind === 'SECRET').map((r) => r.id);
    if (secretIds.length === 0) return requests;
    const grants = await this.secrets.grantViews(ownerId, secretIds);
    const askers = [...new Set(requests.filter((r) => r.kind === 'SECRET').map((r) => r.askedBySessionId))];
    const sessions = await this.prisma.session.findMany({
      where: { id: { in: askers }, ownerId },
      select: { id: true, taskId: true },
    });
    const taskOf = new Map(sessions.map((s) => [s.id, s.taskId]));
    return requests.map((r) => {
      if (r.kind !== 'SECRET') return r;
      const grant = grants.get(r.id) ?? null;
      // The grant's own scope once there is one (it was fixed at submit); before that, the asking session's.
      const scoped = grant ? grant.taskScoped : Boolean(taskOf.get(r.askedBySessionId));
      return { ...r, secretGrant: grant, secretScope: scoped ? 'TASK' : 'SESSION' };
    });
  }

  /**
   * A scheduled task's items close when what they point at is settled (schedules/schedule-attention.ts): the card, the
   * change request or the hold has one door of its own, and ending the item here would leave that one PENDING behind an
   * item that can never be filed again. Only a failure is the owner's to dismiss (done or declined) here.
   */
  private refuseAnsweredElsewhere(kind: string): void {
    if (kind === 'SCHEDULE_APPROVAL') {
      throw new BadRequestException('a SCHEDULE_APPROVAL item is answered on its approval card: POST /sessions/:id/approvals/:approvalId');
    }
    if (kind === 'SCHEDULE_WIDEN') {
      throw new BadRequestException("a SCHEDULE_WIDEN item is answered with the scheduled task's Allow or Decline");
    }
    if (kind === 'SCHEDULE_HELD') {
      throw new BadRequestException('a SCHEDULE_HELD item closes when the scheduled task is resumed or deleted');
    }
  }

  /** The owner did what was asked. A DECISION records the option chosen or the owner's words. */
  async complete(
    ownerId: string,
    id: string,
    given: { option?: number; text?: string; sendAsWritten?: boolean },
    client: OwnerRequestClient | null = null,
  ): Promise<OwnerRequestView> {
    const request = await this.get(ownerId, id);
    if (request.kind === 'SECRET') {
      throw new BadRequestException('a SECRET request is done when the runner has the key: enter it with POST /owner-requests/:id/secret');
    }
    if (request.kind === 'WIKI_CREATE') {
      throw new BadRequestException('a WIKI_CREATE request is done when its repository has a wiki: create it with POST /owner-requests/:id/create-wiki');
    }
    if (request.kind === SETTINGS_CHANGE) {
      throw new BadRequestException('a SETTINGS_CHANGE request is done when the owner saves its changes, which writes them; it is not marked done by hand');
    }
    if (request.kind === PROJECT_REOPEN) {
      throw new BadRequestException('a PROJECT_REOPEN request is done when the owner reopens its project: POST /owner-requests/:id/reopen-project');
    }
    if (request.kind === 'CHANGE') {
      throw new BadRequestException('a CHANGE request is done when the owner applies it, which writes the setting: POST /owner-requests/:id/apply');
    }
    this.refuseAnsweredElsewhere(request.kind);
    const text = given.text?.trim();
    const option = given.option ?? undefined;
    // The 30-day question of a task's condition (conditions/condition-still-waiting.ts): Keep waiting or Stop.
    const stillWaiting = request.kind === CONDITION_STILL_WAITING_KIND;
    if (stillWaiting && option === undefined) {
      throw new BadRequestException(`a ${CONDITION_STILL_WAITING_KIND} item is answered with option 0 (Keep waiting) or 1 (Stop)`);
    }
    if (option !== undefined) {
      const options = (request.options ?? []) as unknown as OwnerRequestOption[];
      if (request.kind !== 'DECISION' && !stillWaiting) {
        throw new BadRequestException('only a DECISION request takes an option');
      }
      if (!Number.isInteger(option) || option < 0 || option >= options.length) {
        throw new BadRequestException('option must name one of the options this request offered');
      }
    }
    if (request.kind === 'DECISION' && option === undefined && !text) {
      throw new BadRequestException('a decision needs an option or some text');
    }
    // Settings › Translation: the owner's words reach the asking session in the agent language, or the answer is
    // refused whole (422 TRANSLATION_FAILED) before anything is written. The option goes by index either way.
    const translation = text
      ? await ownerWordsForAgent(text, await translationLanguages(this.prisma, ownerId), given.sendAsWritten)
      : null;
    const answer = option !== undefined || text
      ? { ...(option !== undefined ? { option } : {}), ...(text ? { text } : {}), ...(translation ? { translation } : {}) }
      : null;
    return this.settle(ownerId, id, 'DONE', {
      resolvedByUserId: ownerId,
      resolvedClient: client,
      answer: json(answer),
    }, stillWaiting
      ? async (tx, now) => {
        const item = await tx.ownerRequest.findUnique({ where: { id }, select: { conditionId: true } });
        await answerStillWaiting(tx, item?.conditionId ?? null, option, now);
      }
      : undefined);
  }

  /**
   * The owner's Create wiki on a WIKI_CREATE card (design §3.6): the wiki for the card's repository, made through
   * `WikiService.createSpace` as the Create wiki form makes one — maintenance on, reading the asking session's workspace,
   * 8 runs a day over the last 14 days, and the plan's first draft asked for — and then the card settled DONE with the
   * wiki it made. The owner's own login only: a request carrying an acting session is refused WIKI_OWNER_CHANNEL_ONLY
   * before anything is read, and a personal access token never reaches this door (@PatForbidden('OWNER_INTERACTIVE')).
   */
  async createWiki(
    ownerId: string,
    id: string,
    actingSessionId: string | null,
    client: OwnerRequestClient | null = null,
    credential?: AuthCredential,
  ): Promise<OwnerRequestView> {
    if (actingSessionId) {
      throw new WikiRefusalError({
        code: 'WIKI_OWNER_CHANNEL_ONLY',
        message: 'creating a wiki is the account owner\'s to do, signed in, with no acting session: '
          + 'the owner presses Create wiki on the card.',
      });
    }
    if (!this.wiki) throw new Error('OwnerRequestsService.createWiki needs WikiService');
    const request = await this.get(ownerId, id);
    if (request.kind !== 'WIKI_CREATE') throw new BadRequestException('only a WIKI_CREATE request creates a wiki');
    if (request.state !== 'PENDING') {
      throw new ConflictException({
        code: OWNER_REQUEST_NOT_PENDING,
        state: request.state,
        message: `this request is already ${request.state}; an ended request is final and nothing was written`,
      });
    }
    const repository = request.repoUrlNorm!;
    const space = await this.wiki.createSpace(
      ownerId,
      {
        title: wikiRepositoryName(repository),
        repoUrl: `https://${repository}`,
        maintenance: {
          enabled: true,
          workspaceId: request.workspaceId!,
          dailyRunLimit: WIKI_CREATE_DAILY_RUN_LIMIT,
          lookbackDays: WIKI_CREATE_LOOKBACK_DAYS,
        },
      },
      null,
      credential,
    );
    try {
      return await this.settle(ownerId, id, 'DONE', {
        resolvedByUserId: ownerId,
        resolvedClient: client,
        answer: json({ spaceId: space.id, name: space.title }),
      });
    } catch (error) {
      // A read between the wiki and this settle already found the wiki made and settled the card DONE with it.
      const now = await this.get(ownerId, id);
      if (now.state === 'DONE') return now;
      throw error;
    }
  }

  /**
   * The owner's Save changes on a SETTINGS_CHANGE card (docs/settings-from-conversation-design.md §5.2), in the
   * transaction that settles the card DONE: the account's preferences re-read under the user row's lock; any key whose
   * value in force is no longer the card's `from` answers 409 SETTINGS_STALE and the whole transaction rolls back, so
   * nothing is written and the card stays PENDING; otherwise each `to` is merged as the owner's PATCH merges it, and each
   * key written is marked `changedBy[key] = { sessionId, requestId, at, from }` (§5.3). The ending reaches the asking
   * session as every owner request's does (`settle`). The owner's own login only: a request carrying an acting session
   * is refused SETTINGS_OWNER_CHANNEL_ONLY before anything is read, and a personal access token never reaches this door
   * (@PatForbidden('OWNER_INTERACTIVE')).
   */
  async applySettings(
    ownerId: string,
    id: string,
    actingSessionId: string | null,
    client: OwnerRequestClient | null = null,
  ): Promise<OwnerRequestView> {
    if (actingSessionId !== null) {
      throw new ForbiddenException({
        code: SETTINGS_OWNER_CHANNEL_ONLY,
        message: 'a settings change is saved by the account owner, signed in, with no acting session: the owner presses Save changes on the card.',
      });
    }
    const request = await this.get(ownerId, id);
    if (request.kind !== SETTINGS_CHANGE) throw new BadRequestException('only a SETTINGS_CHANGE request applies settings');
    if (request.state !== 'PENDING') {
      throw new ConflictException({
        code: OWNER_REQUEST_NOT_PENDING,
        state: request.state,
        message: `this request is already ${request.state}; an ended request is final and nothing was written`,
      });
    }
    const { changes } = request.payload as unknown as SettingsChangePayload;
    return this.settle(ownerId, id, 'DONE', { resolvedByUserId: ownerId, resolvedClient: client }, (tx, now) =>
      applySettingsChanges(tx, { ownerId, requestId: id, askedBySessionId: request.askedBySessionId, changes }, now));
  }

  /**
   * The owner's Apply on a CHANGE card (docs/design/owner-request-change.md §4): in one transaction, the request locked
   * FOR UPDATE and refused unless it is PENDING and before its deadline; its runner locked FOR UPDATE, 404 when it is
   * gone (the owner can still decline); the runner's value read as `actualBefore` and `maxConcurrent` written through
   * the rules `PATCH /runners/:id` writes it with (runnerSettingsData); the request ended DONE with
   * `answer = { applied, actualBefore }`, and its delivery to the asking session written. The value is the owner's: the
   * requested one or one they typed (decision 1), and it is written even when the runner's value moved since the request
   * was filed (decision 3) — `actualBefore` says so. The owner's own sign-in only: the door is @PatForbidden('RUNNER_CONTROL').
   */
  async applyChange(
    ownerId: string,
    id: string,
    maxConcurrent: number,
    client: OwnerRequestClient | null = null,
  ): Promise<OwnerRequestView> {
    const askedBySessionId = await withTransactionRetry(this.prisma, async (tx) => {
      const now = new Date();
      const [request] = await tx.$queryRaw<Array<{
        kind: string; state: string; expiresAt: Date | null; changeSpec: unknown; askedBySessionId: string;
      }>>`
        SELECT "kind", "state", "expires_at" AS "expiresAt", "change_spec" AS "changeSpec",
               "asked_by_session_id" AS "askedBySessionId"
          FROM "owner_request"
         WHERE "id" = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR UPDATE`;
      if (!request) throw new NotFoundException('owner request not found');
      if (request.kind !== 'CHANGE') throw new BadRequestException('only a CHANGE request is applied');
      if (request.state !== 'PENDING') {
        throw new ConflictException({
          code: OWNER_REQUEST_NOT_PENDING,
          state: request.state,
          message: `this request is already ${request.state}; an ended request is final and nothing was written`,
        });
      }
      if (request.expiresAt && request.expiresAt.getTime() <= now.getTime()) {
        throw new ConflictException({
          code: OWNER_REQUEST_EXPIRED,
          message: 'this request passed its deadline and has expired; nothing was written',
        });
      }
      const spec = request.changeSpec as OwnerRequestChangeSpec;
      const [runner] = await tx.$queryRaw<Array<{ maxConcurrent: number }>>`
        SELECT "max_concurrent" AS "maxConcurrent"
          FROM "runner"
         WHERE "id" = ${spec.runnerId}::uuid AND "owner_id" = ${ownerId}::uuid
           FOR UPDATE`;
      if (!runner) {
        throw new NotFoundException('runner not found: it was removed after this request was filed; decline the request instead');
      }
      await tx.runner.update({ where: { id: spec.runnerId }, data: runnerSettingsData({ maxConcurrent }), select: { id: true } });
      const answer: OwnerRequestChangeAnswer = { applied: maxConcurrent, actualBefore: runner.maxConcurrent };
      await tx.ownerRequest.update({
        where: { id },
        data: {
          state: 'DONE',
          resolvedAt: now,
          resolvedByUserId: ownerId,
          resolvedClient: client,
          answer: answer as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await enqueueResolutions(tx, [id]);
      return request.askedBySessionId;
    }, loggedRetry(this.logger, 'ownerRequests.applyChange'));
    this.delivery?.kick();
    this.realtime?.publishSessionUpdated(askedBySessionId);
    return this.get(ownerId, id);
  }

  /**
   * Every PENDING WIKI_CREATE whose repository now has a wiki in use, however it was made, settled DONE with that wiki
   * (design §3.6: "the card reads DONE once the repository has an in-use space"), each with its delivery to the asking
   * session — the owner's list and reads and the expiry sweep call it, so a card whose wiki came from the Create wiki
   * form never reads PENDING and never expires. One compare-and-set on PENDING, so concurrent calls settle each card once.
   */
  async settleMadeWikis(ownerId: string | null): Promise<string[]> {
    const settled = await withTransactionRetry(this.prisma, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; askedBySessionId: string }>>`
        UPDATE "owner_request" AS r
           SET "state" = 'DONE', "resolved_at" = now(), "updated_at" = now(),
               "answer" = jsonb_build_object('spaceId', s."id", 'name', s."title")
          FROM "wiki_space" AS s
         WHERE r."kind" = 'WIKI_CREATE' AND r."state" = 'PENDING'
           AND (${ownerId}::uuid IS NULL OR r."owner_id" = ${ownerId}::uuid)
           AND s."owner_id" = r."owner_id" AND s."repo_url_norm" = r."repo_url_norm" AND s."deleted_at" IS NULL
        RETURNING r."id", r."asked_by_session_id" AS "askedBySessionId"`;
      await enqueueResolutions(tx, rows.map((row) => row.id));
      return rows;
    }, loggedRetry(this.logger, 'ownerRequests.settleMadeWikis'));
    if (settled.length > 0) this.delivery?.kick();
    for (const sessionId of new Set(settled.map((row) => row.askedBySessionId))) {
      this.realtime?.publishSessionUpdated(sessionId);
    }
    return settled.map((row) => row.id);
  }

  /** The owner refuses the request. The reason is what the asking session reads. */
  async decline(
    ownerId: string,
    id: string,
    reason: string,
    client: OwnerRequestClient | null = null,
    sendAsWritten?: boolean,
  ): Promise<OwnerRequestView> {
    const note = reason?.trim();
    if (!note) throw new BadRequestException('reason is required: say why, so the session asking can act on it');
    const request = await this.get(ownerId, id);
    this.refuseAnsweredElsewhere(request.kind);
    // Settings › Translation: the reason reaches the asking session in the agent language, kept in `answer` beside
    // the owner's own words in resolution_note, or the decline is refused whole (422 TRANSLATION_FAILED).
    const translation = await ownerWordsForAgent(note, await translationLanguages(this.prisma, ownerId), sendAsWritten);
    return this.settle(ownerId, id, 'DECLINED', {
      resolvedByUserId: ownerId,
      resolvedClient: client,
      resolutionNote: note,
      ...(translation ? { answer: json({ translation }) } : {}),
    });
  }

  /** The asking session no longer needs it. Only the session that filed a request may withdraw it. */
  async withdraw(ownerId: string, sessionId: string, id: string, reason: string | undefined): Promise<OwnerRequestView> {
    const request = await this.get(ownerId, id);
    if (request.kind === PROJECT_REOPEN && request.state === 'PENDING') {
      const left = await this.leaveProjectReopen(ownerId, sessionId, id);
      if (left) return left;
    }
    if (request.askedBySessionId !== sessionId || isScheduleItemKind(request.kind) || isConditionItemKind(request.kind)) {
      throw new ForbiddenException({
        code: OWNER_REQUEST_NOT_ASKER,
        message: 'only the session that filed this request may withdraw it',
      });
    }
    // A delivered key the session no longer needs (design §6.1 WITHDRAWN): the request stays DONE, the key goes.
    if (request.kind === 'SECRET' && request.state === 'DONE' && await this.secrets.release(ownerId, sessionId, id)) {
      return this.get(ownerId, id);
    }
    return this.settle(ownerId, id, 'WITHDRAWN', {
      resolvedBySessionId: sessionId,
      resolutionNote: reason?.trim() || null,
    });
  }

  /**
   * Every PENDING request whose deadline has passed, moved to EXPIRED in one statement. Its own
   * compare-and-set: two replicas sweeping at once expire each request once between them. Each
   * expiry's delivery to its asking session commits with it.
   */
  async expireDue(now: Date): Promise<string[]> {
    // A card whose wiki was made meanwhile is DONE, not expired.
    await this.settleMadeWikis(null);
    const expired = await withTransactionRetry(this.prisma, async (tx) => {
      const rows = await tx.ownerRequest.updateManyAndReturn({
        where: { state: 'PENDING', expiresAt: { lte: now } },
        data: { state: 'EXPIRED', resolvedAt: now },
        select: { id: true, ownerId: true, askedBySessionId: true },
      });
      const ids = rows.map((row) => row.id);
      await enqueueResolutions(tx, ids);
      await endUndeliveredGrants(tx, ids, 'EXPIRED');
      return rows;
    }, loggedRetry(this.logger, 'ownerRequests.expireDue'));
    if (expired.length > 0) this.delivery?.kick();
    const byOwner = new Map<string, string[]>();
    for (const row of expired) byOwner.set(row.ownerId, [...(byOwner.get(row.ownerId) ?? []), row.askedBySessionId]);
    for (const [owner, sessions] of byOwner) this.realtime?.publishOwnerSignalChanged(owner, sessions);
    return expired.map((row) => row.id);
  }

  /**
   * One ending, written only while the request is still PENDING and not past its deadline, together
   * with its delivery to the asking session. When nothing matched, the request is read again to say
   * why: already ended, or expired.
   */
  private async settle(
    ownerId: string,
    id: string,
    to: Exclude<OwnerRequestState, 'PENDING' | 'EXPIRED'>,
    data: Prisma.OwnerRequestUpdateManyMutationInput,
    /** What the answer does, in the transaction that settles the item: only when this call settled it. */
    effect?: (tx: Prisma.TransactionClient, now: Date) => Promise<void>,
  ): Promise<OwnerRequestView> {
    const now = new Date();
    const settled = await withTransactionRetry(this.prisma, async (tx) => {
      const written = await tx.ownerRequest.updateMany({
        where: { id, ownerId, state: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        data: { ...data, state: to, resolvedAt: now },
      });
      if (written.count === 1) {
        if (effect) await effect(tx, now);
        // A scheduled task's item was written by the schedule, and a condition's by the condition, not asked by a
        // session: nobody is waiting to hear. A BROWSER_SIGN_IN's asker is waiting in the call that filed it
        // (browser_request_sign_in reads the answer and returns it), so a turn saying the same would be a second answer.
        const kind = await tx.ownerRequest.findUnique({ where: { id }, select: { kind: true } });
        if (!kind || !(isScheduleItemKind(kind.kind) || isConditionItemKind(kind.kind) || kind.kind === BROWSER_SIGN_IN_KIND)) {
          await enqueueResolutions(tx, [id]);
        }
        await endUndeliveredGrants(tx, [id], to === 'WITHDRAWN' ? 'WITHDRAWN' : 'REVOKED');
      }
      return written;
    }, loggedRetry(this.logger, 'ownerRequests.settle'));
    if (settled.count === 1) this.delivery?.kick();
    const request = await this.get(ownerId, id);
    if (settled.count === 1) {
      this.realtime?.publishOwnerSignalChanged(ownerId, request.askers?.map((asker) => asker.sessionId) ?? [request.askedBySessionId]);
      return request;
    }
    if (request.state === 'PENDING') {
      throw new ConflictException({
        code: OWNER_REQUEST_EXPIRED,
        message: 'this request passed its deadline and has expired; nothing was written',
      });
    }
    throw new ConflictException({
      code: OWNER_REQUEST_NOT_PENDING,
      state: request.state,
      message: `this request is already ${request.state}; an ended request is final and nothing was written`,
    });
  }
}
