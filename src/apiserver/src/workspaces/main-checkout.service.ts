import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Prisma, ProjectStatus } from '@prisma/client';
import {
  MAIN_CHECKOUT_ACTION_KINDS,
  MAIN_CHECKOUT_ACTION_TIMEOUT_SECONDS,
  MAIN_CHECKOUT_DIFF_PATHS_MAX,
  MAIN_CHECKOUT_GIT_CAPABILITY,
  MAIN_CHECKOUT_NOTICE_KINDS,
  MAIN_CHECKOUT_REFUSAL_CODES,
  MAIN_CHECKOUT_SNAPSHOT_WAIT_SECONDS,
  MAIN_CHECKOUT_UNSUPPORTED_CODE,
  RunEventType,
  mainCheckoutResultLine,
  type MainCheckoutActionAnswer,
  type MainCheckoutActionCommand,
  type MainCheckoutActionKind,
  type MainCheckoutActionPost,
  type MainCheckoutActionResult,
  type MainCheckoutManagedBranch,
  type MainCheckoutRefusalCode,
  type MainCheckoutRepoHealth,
  type MainCheckoutResultNotice,
  type MainCheckoutRunnerRequest,
  type MainCheckoutSnapshot,
  type MainCheckoutSnapshotAnswer,
  type MainCheckoutView,
  type NormalizedRunEvent,
} from '@orbit/shared';
import { readRunnerRepoHealth, repoHealthForWorkspace } from '../common/runner-repo-health';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RUNNER_BEATS, runnerIsOnline, runnerLastBeatAt } from '../runners/runner-presence';

/**
 * The main checkout's read and its four actions (docs/main-checkout-git-contract.md §2, §5–§7, §10).
 *
 * The repo-cleanup relay, generalized: a request is a `main_checkout_request` row, handed out ONCE on the runner's
 * heartbeat (pending → claimed, a compare-and-set, so two replicas never hand one to two processes) and finished by
 * the runner's answer or by the timeout, whichever comes first. Nothing here touches Git: the runner does, and refuses
 * on any difference from what the person looked at.
 *
 * An action's outcome — the runner's, or one of the four the control plane decides (ACTION_IN_FLIGHT,
 * RUNNER_OFFLINE, TIMEOUT, CANCELLED) — is written as one system line into the session the person pressed it in
 * (§7). It never writes a merge receipt or a task landing: a commit in the main checkout is not a session merge.
 */

/** The control plane's own codes: a runner never reports them. */
const CONTROL_PLANE_CODES: ReadonlySet<string> = new Set(['ACTION_IN_FLIGHT', 'CHECKOUT_NOT_REPORTED', 'RUNNER_OFFLINE', 'TIMEOUT', 'CANCELLED']);
const PATH_MAX = 4096;
const MESSAGE_MAX = 64 * 1024;
const REQUEST_ID_MAX = 200;
/** How often the timeout sweep runs on its own, besides on every read, action and heartbeat. */
const SWEEP_EVERY_MS = 30_000;
/** The conversation_turn key a result line rides on for a live session (`notice` turns), per request and occasion. */
export const MAIN_CHECKOUT_NOTICE_TURN_PREFIX = 'main-checkout:v1:';
/** What a waiter parks on until the runner answers a snapshot read. */
export function mainCheckoutAnswerKey(id: string): string {
  return `main-checkout:${id}`;
}

type Db = Prisma.TransactionClient | PrismaService;

interface RequestRow {
  id: string;
  ownerId: string;
  workspaceId: string;
  runnerId: string;
  root: string;
  op: string;
  requestId: string | null;
  kind: string | null;
  input: Prisma.JsonValue;
  initiatedFromSessionId: string | null;
  state: string;
  result: Prisma.JsonValue | null;
  lateResult: Prisma.JsonValue | null;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
}

/** Why a result line was written: the request's own outcome, the waiting note before it, or a result after it. */
type LineOccasion = 'result' | 'waiting' | 'late';

@Injectable()
export class MainCheckoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MainCheckoutService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    /** Optional so specs can build this without the realtime fan-out; nothing is woken or published then. */
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  onModuleInit(): void {
    // A request whose runner never beats again is finished by this, not by a heartbeat that will not come.
    this.sweepTimer = setInterval(() => {
      void this.expire().catch((error) => this.logger.warn(`main checkout sweep failed: ${(error as Error).message}`));
    }, SWEEP_EVERY_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ── the person's side ─────────────────────────────────────────────────────────────────────────────

  /** GET /workspaces/:id/main-checkout: a fresh snapshot from the runner, with the patches of `diffPaths`. */
  async read(ownerId: string, workspaceId: string, diffPaths: string[] = []): Promise<MainCheckoutView> {
    const paths = validDiffPaths(diffPaths);
    const { workspace, health, actionsSupported } = await this.checkout(ownerId, workspaceId);
    if (!health) throw new NotFoundException(NOT_REPORTED);
    const runner = workspace.runner!;
    const managedBranch = await this.managedBranch(ownerId, workspaceId, health.branch);
    await this.expire({ runnerId: runner.id });
    const inFlight = await this.inFlight(runner.id, health.root);
    // A runner without the capability cannot read the checkout on demand; what its heartbeat said is all there is.
    if (!actionsSupported) {
      return { snapshot: heartbeatSnapshot(health), actionsSupported, managedBranch, inFlight };
    }
    if (!runnerIsOnline(runner)) {
      throw new HttpException('The runner is offline. Try again when it is online.', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const now = new Date();
    const row = await this.prisma.mainCheckoutRequest.create({
      data: {
        ownerId,
        workspaceId,
        runnerId: runner.id,
        root: health.root,
        op: 'snapshot',
        input: { root: health.root, ...(paths.length ? { diffPaths: paths } : {}) },
        expiresAt: new Date(now.getTime() + MAIN_CHECKOUT_SNAPSHOT_WAIT_SECONDS * 1000),
      },
      select: { id: true, expiresAt: true },
    });
    this.realtime?.notifyRunnerWake(runner.id);
    const answer = await this.waitForSnapshot(row.id, row.expiresAt);
    if (!answer.snapshot) {
      throw new HttpException(
        answer.error ? `The runner could not read the main checkout: ${answer.error}` : 'The runner could not read the main checkout.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return {
      snapshot: answer.snapshot,
      ...(answer.diffs ? { diffs: answer.diffs } : {}),
      actionsSupported,
      managedBranch: await this.managedBranch(ownerId, workspaceId, answer.snapshot.branch),
      inFlight,
    };
  }

  /** POST /workspaces/:id/main-checkout/actions. */
  async act(ownerId: string, workspaceId: string, body: MainCheckoutActionPost): Promise<MainCheckoutActionAnswer> {
    const request = validAction(body);
    // A repeat of a requestId is answered with the first request, whatever has changed since.
    const first = await this.prisma.mainCheckoutRequest.findUnique({
      where: { ownerId_requestId: { ownerId, requestId: request.requestId } },
    });
    if (first) return answerFor(first, workspaceId);

    // A checkout the runner has not reported yet is not a 404 here: the card that asked comes from a turn that just
    // ended, so the person gets a refusal line in the conversation (board 03), not a toast.
    const { workspace, health, actionsSupported } = await this.checkout(ownerId, workspaceId);
    const runner = workspace.runner!;
    if (!actionsSupported) {
      throw new ConflictException({
        code: MAIN_CHECKOUT_UNSUPPORTED_CODE,
        message: `${runner.displayName ?? runner.name} runs an Orbit runner too old to change the main checkout. Update it, then try again.`,
      });
    }
    if (health && request.root !== health.root) {
      throw new BadRequestException(`root ${request.root} is not this workspace's main checkout (${health.root})`);
    }
    const initiatedFrom = request.initiatedFromSessionId
      ? await this.sessionOf(ownerId, workspaceId, request.initiatedFromSessionId, 'initiatedFromSessionId')
      : null;
    let targetBranch: string | undefined;
    if (request.kind === 'move') {
      const target = await this.sessionOf(ownerId, workspaceId, request.targetSessionId!, 'targetSessionId');
      if (target.assignedRunnerId && target.assignedRunnerId !== runner.id) {
        throw new BadRequestException('targetSessionId runs on another runner than this main checkout');
      }
      if (target.isolationStatus !== 'worktree' || !target.branch) {
        throw new BadRequestException('targetSessionId has no worktree to move the files into');
      }
      targetBranch = target.branch;
    }

    const root = health?.root ?? request.root;
    await this.expire({ runnerId: runner.id });
    const requestedAt = new Date();
    const expiresAt = new Date(requestedAt.getTime() + MAIN_CHECKOUT_ACTION_TIMEOUT_SECONDS * 1000);
    const command: MainCheckoutActionCommand = {
      kind: request.kind,
      root: request.root,
      fingerprint: request.fingerprint,
      ...(request.files ? { files: request.files } : {}),
      ...(request.message !== undefined ? { message: request.message } : {}),
      ...(request.targetSessionId ? { targetSessionId: request.targetSessionId } : {}),
      requestId: request.requestId,
      ...(targetBranch ? { targetBranch } : {}),
      requestedAt: requestedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const data = {
      ownerId,
      workspaceId,
      runnerId: runner.id,
      root,
      op: 'action',
      requestId: request.requestId,
      kind: request.kind,
      input: command as unknown as Prisma.InputJsonValue,
      initiatedFromSessionId: initiatedFrom?.id ?? null,
      expiresAt,
    };
    if (!health) {
      const refusal: MainCheckoutActionResult = {
        ...this.controlPlaneResult(request.kind, request.requestId, root, 'CHECKOUT_NOT_REPORTED'),
        runnerName: runner.displayName ?? runner.name,
      };
      if (await this.finishNew(data, refusal)) return { requestId: request.requestId, status: 'finished', result: refusal };
      // Only its requestId can collide (the row is born finished, outside the in-flight index): answer the first.
      const raced = await this.prisma.mainCheckoutRequest.findUniqueOrThrow({
        where: { ownerId_requestId: { ownerId, requestId: request.requestId } },
      });
      return answerFor(raced, workspaceId);
    }
    let created: { id: string };
    try {
      created = await this.prisma.mainCheckoutRequest.create({ data, select: { id: true } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.mainCheckoutRequest.findUnique({
        where: { ownerId_requestId: { ownerId, requestId: request.requestId } },
      });
      if (raced) return answerFor(raced, workspaceId);
      // Not the requestId, so the other index: an action on this checkout is still in flight. Refused, and the
      // refusal is this request's outcome — a repeat of its requestId answers the same.
      const refusal = this.controlPlaneResult(request.kind, request.requestId, health.root, 'ACTION_IN_FLIGHT', health.branch);
      const refused = await this.finishNew(data, refusal);
      if (!refused) {
        const again = await this.prisma.mainCheckoutRequest.findUnique({
          where: { ownerId_requestId: { ownerId, requestId: request.requestId } },
        });
        if (again) return answerFor(again, workspaceId);
        throw error;
      }
      return { requestId: request.requestId, status: 'finished', result: refusal };
    }
    // Queued. The runner's heartbeat hands it over; have it beat now, the person is watching.
    this.realtime?.notifyRunnerWake(runner.id);
    // Said at once when the runner has gone quiet: nothing has run, and it runs when the runner is back.
    if (!runnerIsOnline(runner) && initiatedFrom) {
      const beat = runnerLastBeatAt(runner);
      const minutes = beat ? Math.max(1, Math.round((Date.now() - beat.getTime()) / 60_000)) : 0;
      const waiting: MainCheckoutActionResult = {
        ...this.controlPlaneResult(request.kind, request.requestId, health.root, 'RUNNER_OFFLINE', health.branch),
        status: 'waiting',
        runnerName: runner.displayName ?? runner.name,
        minutes,
      };
      const published = await withTransactionRetry(
        this.prisma,
        (tx) => this.writeLine(tx, initiatedFrom.id, created.id, waiting, 'waiting'),
        loggedRetry(this.logger, 'mainCheckout.waitingLine'),
      );
      this.afterLine(published);
    }
    return { requestId: request.requestId, status: 'pending' };
  }

  /** POST /workspaces/:id/main-checkout/actions/:requestId/cancel: only before the runner was handed it. */
  async cancel(ownerId: string, workspaceId: string, requestId: string): Promise<MainCheckoutActionAnswer> {
    const row = await this.prisma.mainCheckoutRequest.findUnique({
      where: { ownerId_requestId: { ownerId, requestId } },
    });
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundException('main checkout request not found');
    if (row.state === 'claimed') {
      throw new ConflictException('The runner has already started this action; its result will appear when it finishes.');
    }
    if (row.state === 'pending') {
      const result = this.controlPlaneResult(row.kind as MainCheckoutActionKind, requestId, row.root, 'CANCELLED');
      await this.finish(row.id, ['pending'], result);
    }
    return answerFor(
      (await this.prisma.mainCheckoutRequest.findUniqueOrThrow({ where: { id: row.id } })) as RequestRow,
      workspaceId,
    );
  }

  // ── the runner's side ─────────────────────────────────────────────────────────────────────────────

  /**
   * What this beat hands the runner: its pending reads and actions, each claimed once (pending → claimed). Nothing
   * for a runner without the capability, nor for a process that is draining — the one replacing it claims them.
   */
  async dispatch(input: { runnerId: string; capabilities?: readonly string[]; draining?: boolean }): Promise<MainCheckoutRunnerRequest[]> {
    await this.expire({ runnerId: input.runnerId });
    if (input.draining || !input.capabilities?.includes(MAIN_CHECKOUT_GIT_CAPABILITY)) return [];
    const claimed = await this.prisma.$queryRaw<Array<{ id: string; op: string; root: string; input: Prisma.JsonValue; createdAt: Date; expiresAt: Date }>>`
      UPDATE "main_checkout_request"
         SET "state" = 'claimed', "claimed_at" = now()
       WHERE "runner_id" = ${input.runnerId}::uuid
         AND "state" = 'pending'
         AND "expires_at" > now()
      RETURNING "id", "op", "root", "input", "created_at" AS "createdAt", "expires_at" AS "expiresAt"
    `;
    return claimed
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((row): MainCheckoutRunnerRequest => {
        const body = (row.input ?? {}) as Record<string, unknown>;
        if (row.op === 'action') return { id: row.id, op: 'action', command: body as unknown as MainCheckoutActionCommand };
        const diffPaths = Array.isArray(body.diffPaths) ? (body.diffPaths as string[]) : undefined;
        return {
          id: row.id,
          op: 'snapshot',
          root: row.root,
          ...(diffPaths?.length ? { diffPaths } : {}),
          requestedAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        };
      });
  }

  /** POST /runner/main-checkout/:id/snapshot. Idempotent: an answer to a read already finished is not stored. */
  async snapshotAnswer(runnerId: string, id: string, body: MainCheckoutSnapshotAnswer): Promise<{ accepted: boolean }> {
    const row = await this.prisma.mainCheckoutRequest.findFirst({ where: { id, runnerId, op: 'snapshot' }, select: { id: true } });
    if (!row) throw new NotFoundException('main checkout read not found');
    const answer = validSnapshotAnswer(body);
    const done = await this.prisma.mainCheckoutRequest.updateMany({
      where: { id, runnerId, op: 'snapshot', state: { not: 'finished' } },
      data: { state: 'finished', finishedAt: new Date(), result: answer as unknown as Prisma.InputJsonValue },
    });
    this.realtime?.notifyWaiters(mainCheckoutAnswerKey(id));
    return { accepted: done.count === 1 };
  }

  /**
   * POST /runner/main-checkout/:id/result. The first result finishes the request and writes its line. One after the
   * control plane already finished it (TIMEOUT, CANCELLED) never replaces that outcome: it is kept on the row and
   * written once as a line of its own, as the TIMEOUT line promises. Every later copy is accepted and ignored.
   */
  async actionResult(runnerId: string, id: string, body: MainCheckoutActionResult): Promise<{ accepted: boolean }> {
    const row = await this.prisma.mainCheckoutRequest.findFirst({ where: { id, runnerId, op: 'action' } });
    if (!row) throw new NotFoundException('main checkout action not found');
    const result = validRunnerResult(body, row as RequestRow);
    if (await this.finish(row.id, ['pending', 'claimed'], result)) return { accepted: true };
    const late = await withTransactionRetry(this.prisma, async (tx) => {
      // Only after an outcome the control plane decided: a second copy of the runner's own result is the same result.
      const current = await tx.mainCheckoutRequest.findUniqueOrThrow({ where: { id: row.id }, select: { result: true } });
      const decidedHere = CONTROL_PLANE_CODES.has(String((current.result as Record<string, unknown> | null)?.code ?? ''));
      if (!decidedHere) return null;
      const kept = await tx.mainCheckoutRequest.updateMany({
        where: { id: row.id, state: 'finished', lateResult: { equals: Prisma.AnyNull } },
        data: { lateResult: result as unknown as Prisma.InputJsonValue },
      });
      if (kept.count === 0) return null;
      return row.initiatedFromSessionId ? this.writeLine(tx, row.initiatedFromSessionId, row.id, result, 'late') : null;
    }, loggedRetry(this.logger, 'mainCheckout.lateResult'));
    this.afterLine(late);
    return { accepted: false };
  }

  // ── the timeout ───────────────────────────────────────────────────────────────────────────────────

  /**
   * Finish what has outlived its deadline: an action with TIMEOUT (and its line), a read with an error its waiter
   * reads. Runs on every read, action and heartbeat, and on its own every SWEEP_EVERY_MS, so a request is never left
   * pending by a runner that does not come back. `now` is for the specs.
   */
  async expire(scope: { runnerId?: string; now?: Date } = {}): Promise<number> {
    const now = scope.now ?? new Date();
    const due = await this.prisma.mainCheckoutRequest.findMany({
      where: { state: { not: 'finished' }, expiresAt: { lte: now }, ...(scope.runnerId ? { runnerId: scope.runnerId } : {}) },
      select: { id: true, op: true, kind: true, requestId: true, root: true, runnerId: true, createdAt: true },
      take: 100,
    });
    let finished = 0;
    for (const row of due) {
      if (row.op === 'snapshot') {
        const done = await this.prisma.mainCheckoutRequest.updateMany({
          where: { id: row.id, state: { not: 'finished' } },
          data: { state: 'finished', finishedAt: now, result: { error: 'timeout' } },
        });
        finished += done.count;
        this.realtime?.notifyWaiters(mainCheckoutAnswerKey(row.id));
        continue;
      }
      const runner = await this.prisma.runner.findUnique({ where: { id: row.runnerId }, select: { name: true, displayName: true } });
      const result: MainCheckoutActionResult = {
        ...this.controlPlaneResult(row.kind as MainCheckoutActionKind, row.requestId!, row.root, 'TIMEOUT', undefined, now),
        runnerName: runner?.displayName ?? runner?.name ?? undefined,
        minutes: Math.max(1, Math.round((now.getTime() - row.createdAt.getTime()) / 60_000)),
      };
      if (await this.finish(row.id, ['pending', 'claimed'], result, now)) finished++;
    }
    return finished;
  }

  // ── the line ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Finish a request with `result` if it is still in one of `from`, and write its line in the same transaction: the
   * compare-and-set decides who writes it, so it is written once however many answers race.
   */
  private async finish(
    id: string,
    from: string[],
    result: MainCheckoutActionResult,
    at: Date = new Date(),
  ): Promise<boolean> {
    let won = false;
    const published = await withTransactionRetry(this.prisma, async (tx) => {
      won = false;
      const done = await tx.mainCheckoutRequest.updateMany({
        where: { id, state: { in: from } },
        data: { state: 'finished', finishedAt: at, result: result as unknown as Prisma.InputJsonValue },
      });
      if (done.count === 0) return null;
      won = true;
      const row = await tx.mainCheckoutRequest.findUniqueOrThrow({ where: { id }, select: { initiatedFromSessionId: true } });
      return row.initiatedFromSessionId ? this.writeLine(tx, row.initiatedFromSessionId, id, result, 'result') : null;
    }, loggedRetry(this.logger, 'mainCheckout.finish'));
    this.afterLine(published);
    return won;
  }

  /** Record a request that is refused before it was ever queued (ACTION_IN_FLIGHT, CHECKOUT_NOT_REPORTED), with its line. Null when its
   *  requestId was taken meanwhile. */
  private async finishNew(
    data: Omit<Prisma.MainCheckoutRequestUncheckedCreateInput, 'state' | 'result' | 'finishedAt'>,
    result: MainCheckoutActionResult,
  ): Promise<boolean> {
    try {
      const published = await withTransactionRetry(this.prisma, async (tx) => {
        const row = await tx.mainCheckoutRequest.create({
          data: { ...data, state: 'finished', finishedAt: new Date(), result: result as unknown as Prisma.InputJsonValue },
          select: { id: true },
        });
        return data.initiatedFromSessionId ? this.writeLine(tx, data.initiatedFromSessionId, row.id, result, 'result') : null;
      }, loggedRetry(this.logger, 'mainCheckout.refuse'));
      this.afterLine(published);
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /**
   * Write one result line into `sessionId` as a system event (contract §7, §10.3), inside the caller's transaction.
   *
   * The runner numbers a live session's events itself and keeps the counter in memory, so a row written here at
   * max(seq)+1 would take the seq its next event is about to use, and the runner's would be dropped. So:
   *   - a live session on a runner with the capability gets a `notice` turn; the runner writes the event under its own
   *     numbering, and the inbox answers the turn as it hands it out (it never reaches the agent nor opens a turn);
   *   - any other session gets the event here, at max(seq)+1 under the session's row lock: the next claim reads the
   *     maximum afresh, and a claim that comes first finds the lock held.
   * Returns the event to publish after commit, if one was written here.
   */
  private async writeLine(
    tx: Prisma.TransactionClient,
    sessionId: string,
    requestRowId: string,
    result: MainCheckoutActionResult,
    occasion: LineOccasion,
  ): Promise<{ sessionId: string; event?: NormalizedRunEvent; inbox?: boolean } | null> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
    if (locked.length === 0) return null; // the session is gone; the outcome stays on the request
    const session = await tx.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        status: true,
        isolationStatus: true,
        assignedRunnerId: true,
        assignedRunner: { select: { capabilities: true } },
      },
    });
    const targetTitle =
      result.targetSessionId && result.targetSessionId !== sessionId
        ? (await tx.session.findUnique({ where: { id: result.targetSessionId }, select: { title: true } }))?.title ?? undefined
        : undefined;
    const line = mainCheckoutResultLine(result, {
      sessionId,
      ...(targetTitle ? { targetTitle } : {}),
      isolated: session.isolationStatus === 'worktree',
    });
    const payload: MainCheckoutResultNotice = { noticeKind: MAIN_CHECKOUT_NOTICE_KINDS.result, notice: line.text, result };
    const live =
      LIVE_STATUSES.has(session.status) &&
      !!session.assignedRunnerId &&
      !!session.assignedRunner?.capabilities.includes(MAIN_CHECKOUT_GIT_CAPABILITY);
    if (live) {
      const clientTurnId = `${MAIN_CHECKOUT_NOTICE_TURN_PREFIX}${requestRowId}:${occasion}`;
      const existing = await tx.conversationTurn.findUnique({
        where: { sessionId_clientTurnId: { sessionId, clientTurnId } },
        select: { id: true },
      });
      if (existing) return null;
      const last = await tx.conversationTurn.findFirst({ where: { sessionId }, orderBy: { seq: 'desc' }, select: { seq: true } });
      await tx.conversationTurn.create({
        data: { sessionId, seq: (last?.seq ?? 0) + 1, clientTurnId, kind: 'notice', content: JSON.stringify(payload), status: 'PENDING' },
      });
      return { sessionId, inbox: true };
    }
    const [max] = await tx.$queryRaw<Array<{ max: number }>>`
      SELECT coalesce(max("seq"), 0) AS "max" FROM "run_event" WHERE "session_id" = ${sessionId}::uuid
    `;
    const seq = Number(max?.max ?? 0) + 1;
    const createdAt = new Date();
    await tx.runEvent.create({
      data: { sessionId, seq, type: RunEventType.SYSTEM, payload: payload as unknown as Prisma.InputJsonValue, createdAt },
    });
    return {
      sessionId,
      event: { seq, type: RunEventType.SYSTEM, ts: createdAt.toISOString(), payload: payload as unknown as Record<string, unknown> },
    };
  }

  /** After commit: show the line written here, or hint the runner that a `notice` turn waits in the inbox. */
  private afterLine(written: { sessionId: string; event?: NormalizedRunEvent; inbox?: boolean } | null): void {
    if (!written) return;
    if (written.event) this.realtime?.publish(written.sessionId, written.event);
    if (written.inbox) this.realtime?.notifyInbox(written.sessionId);
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────

  /** The workspace (the owner's), its runner and the checkout the runner reported for it: null until it has. */
  private async checkout(ownerId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, ownerId, deletedAt: null },
      select: {
        id: true,
        runnerId: true,
        runner: {
          select: { id: true, name: true, displayName: true, status: true, capabilities: true, repoHealth: true, ...RUNNER_BEATS },
        },
      },
    });
    if (!workspace) throw new NotFoundException('workspace not found');
    if (!workspace.runner) throw new BadRequestException('this workspace is not bound to a runner');
    const health = repoHealthForWorkspace(readRunnerRepoHealth(workspace.runner.repoHealth), workspace.id);
    const actionsSupported = workspace.runner.capabilities.includes(MAIN_CHECKOUT_GIT_CAPABILITY);
    return { workspace, health, actionsSupported };
  }

  /** A session of the owner's in this workspace, or a 400 naming the field. */
  private async sessionOf(ownerId: string, workspaceId: string, id: string, field: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId, deletedAt: null },
      select: { id: true, workspaceId: true, assignedRunnerId: true, isolationStatus: true, branch: true },
    });
    if (!session) throw new NotFoundException(`${field}: session not found`);
    if (session.workspaceId !== workspaceId) throw new BadRequestException(`${field} is not a session of this workspace`);
    return session;
  }

  private async inFlight(runnerId: string, root: string): Promise<MainCheckoutView['inFlight']> {
    const row = await this.prisma.mainCheckoutRequest.findFirst({
      where: { runnerId, root, op: 'action', state: { not: 'finished' } },
      select: { requestId: true, kind: true },
    });
    return row ? { requestId: row.requestId!, kind: row.kind as MainCheckoutActionKind } : null;
  }

  /**
   * Whether `branch` is one a project lands on (§5's warning): an open project tied to this workspace — it
   * coordinates there, it is a member, or a task of it is assigned there — whose primary line is that branch
   * (integration-line) or is promoted into it (landing-target). The warning informs; nothing here blocks.
   */
  async managedBranch(ownerId: string, workspaceId: string, branch: string | undefined): Promise<MainCheckoutManagedBranch | null> {
    if (!branch) return null;
    const refs = [branch, `refs/heads/${branch}`];
    const projects = await this.prisma.project.findMany({
      where: {
        ownerId,
        status: ProjectStatus.OPEN,
        OR: [
          { coordinatorWorkspaceId: workspaceId },
          { members: { some: { agentId: workspaceId } } },
          { tasks: { some: { assigneeId: workspaceId } } },
        ],
        codebases: { some: { slot: 'primary', OR: [{ integrationRef: { in: refs } }, { upstreamRef: { in: refs } }] } },
      },
      select: { id: true, title: true, codebases: { where: { slot: 'primary' }, select: { integrationRef: true, upstreamRef: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    let landing: MainCheckoutManagedBranch | null = null;
    for (const project of projects) {
      const line = project.codebases[0];
      if (!line) continue;
      if (refs.includes(line.integrationRef) && line.integrationRef !== line.upstreamRef) {
        return { projectId: project.id, projectTitle: project.title, role: 'integration-line' };
      }
      landing ??= { projectId: project.id, projectTitle: project.title, role: 'landing-target' };
    }
    return landing;
  }

  private async waitForSnapshot(id: string, expiresAt: Date): Promise<MainCheckoutSnapshotAnswer> {
    while (true) {
      const row = await this.prisma.mainCheckoutRequest.findUnique({ where: { id }, select: { state: true, result: true } });
      if (row?.state === 'finished') {
        const answer = (row.result ?? {}) as MainCheckoutSnapshotAnswer & { error?: string };
        if (answer.error === 'timeout' && !answer.snapshot) {
          throw new GatewayTimeoutException('The runner did not answer in time. Try again.');
        }
        return answer;
      }
      if (Date.now() >= expiresAt.getTime()) {
        await this.expire({ now: new Date(Math.max(Date.now(), expiresAt.getTime())) });
        continue;
      }
      if (this.realtime) await this.realtime.waitForNotice(mainCheckoutAnswerKey(id), 1_000);
      else await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** A result the control plane decides itself (§8's "apiserver" rows). */
  private controlPlaneResult(
    kind: MainCheckoutActionKind,
    requestId: string,
    root: string,
    code: MainCheckoutRefusalCode,
    branch?: string,
    at: Date = new Date(),
  ): MainCheckoutActionResult {
    return { requestId, kind, root, status: 'refused', code, ...(branch ? { branch } : {}), finishedAt: at.toISOString() };
  }
}

const NOT_REPORTED = "This workspace's runner hasn't reported its main checkout yet. Try again in a minute.";

const LIVE_STATUSES: ReadonlySet<string> = new Set(['RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']);

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function answerFor(row: RequestRow, workspaceId: string): MainCheckoutActionAnswer {
  if (row.workspaceId !== workspaceId) {
    throw new ConflictException('requestId was already used for another workspace');
  }
  return row.state === 'finished'
    ? { requestId: row.requestId!, status: 'finished', ...(row.result ? { result: row.result as unknown as MainCheckoutActionResult } : {}) }
    : { requestId: row.requestId!, status: 'pending' };
}

/** A snapshot made of what the heartbeat said, for a runner that cannot be asked for one (no capability). */
function heartbeatSnapshot(health: MainCheckoutRepoHealth): MainCheckoutSnapshot {
  return {
    root: health.root,
    ...(health.branch ? { branch: health.branch } : {}),
    ...(health.head ? { head: health.head } : {}),
    state: health.state,
    ...(health.upstream ? { upstream: health.upstream } : {}),
    ...(health.ahead !== undefined ? { ahead: health.ahead } : {}),
    ...(health.behind !== undefined ? { behind: health.behind } : {}),
    files: [],
    fileCount: health.fileCount ?? health.paths?.length ?? 0,
    truncated: health.truncated ?? false,
    fingerprint: health.fingerprint ?? '',
    checkedAt: new Date().toISOString(),
  };
}

function isPathString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PATH_MAX && !value.includes('\0');
}

function validDiffPaths(value: unknown): string[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (list.length > MAIN_CHECKOUT_DIFF_PATHS_MAX) {
    throw new BadRequestException(`at most ${MAIN_CHECKOUT_DIFF_PATHS_MAX} diff paths per read`);
  }
  if (!list.every(isPathString)) throw new BadRequestException('diff: each path must be a non-empty string');
  return [...new Set(list as string[])];
}

/** The request, held to its kind's fields (§5's table). A malformed one is a 400 and writes nothing. */
function validAction(body: unknown): MainCheckoutActionPost {
  if (!body || typeof body !== 'object') throw new BadRequestException('body must be an object');
  const b = body as Record<string, unknown>;
  const kind = b.kind;
  if (typeof kind !== 'string' || !(MAIN_CHECKOUT_ACTION_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException(`kind must be one of ${MAIN_CHECKOUT_ACTION_KINDS.join(', ')}`);
  }
  const requestId = b.requestId;
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > REQUEST_ID_MAX) {
    throw new BadRequestException('requestId must be a non-empty string');
  }
  if (typeof b.root !== 'string' || !b.root) throw new BadRequestException('root is required');
  if (typeof b.fingerprint !== 'string' || !b.fingerprint.startsWith('mc1:')) {
    throw new BadRequestException('fingerprint must be the snapshot fingerprint (mc1:…)');
  }
  const takesFiles = kind === 'move' || kind === 'commit';
  if (takesFiles) {
    if (!Array.isArray(b.files) || b.files.length === 0 || !b.files.every(isPathString)) {
      throw new BadRequestException(`${kind} needs files: one or more paths from the snapshot`);
    }
  } else if (b.files !== undefined) {
    throw new BadRequestException(`${kind} takes no files`);
  }
  if (kind === 'commit') {
    if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > MESSAGE_MAX) {
      throw new BadRequestException('commit needs a non-blank message');
    }
  } else if (b.message !== undefined) {
    throw new BadRequestException(`${kind} takes no message`);
  }
  if (kind === 'move') {
    if (typeof b.targetSessionId !== 'string' || !b.targetSessionId) throw new BadRequestException('move needs targetSessionId');
  } else if (b.targetSessionId !== undefined) {
    throw new BadRequestException(`${kind} takes no targetSessionId`);
  }
  if (b.initiatedFromSessionId !== undefined && typeof b.initiatedFromSessionId !== 'string') {
    throw new BadRequestException('initiatedFromSessionId must be a session id');
  }
  return {
    kind: kind as MainCheckoutActionKind,
    root: b.root,
    fingerprint: b.fingerprint,
    ...(takesFiles ? { files: [...new Set(b.files as string[])] } : {}),
    ...(kind === 'commit' ? { message: b.message as string } : {}),
    ...(kind === 'move' ? { targetSessionId: b.targetSessionId as string } : {}),
    requestId,
    ...(typeof b.initiatedFromSessionId === 'string' ? { initiatedFromSessionId: b.initiatedFromSessionId } : {}),
  };
}

const RESULT_STRINGS = [
  'branch', 'rescueBranch', 'head', 'subject', 'upstream', 'remoteBefore', 'remoteAfter', 'targetSessionId', 'targetBranch',
  'state', 'gitMessage', 'runnerName',
] as const;
const RESULT_COUNTS = ['fileCount', 'remaining', 'ahead', 'behind', 'minutes'] as const;

/** A runner's result, re-read field by field: it crosses the runner boundary and is rendered as a sentence. */
function validRunnerResult(body: unknown, row: RequestRow): MainCheckoutActionResult {
  if (!body || typeof body !== 'object') throw new BadRequestException('result must be an object');
  const b = body as Record<string, unknown>;
  if (b.requestId !== row.requestId) throw new BadRequestException('requestId does not match this action');
  if (b.kind !== row.kind) throw new BadRequestException('kind does not match this action');
  const status = b.status;
  if (status !== 'done' && status !== 'partial' && status !== 'refused') {
    throw new BadRequestException('status must be done, partial or refused');
  }
  const code = b.code;
  if (status !== 'done') {
    if (typeof code !== 'string' || !(MAIN_CHECKOUT_REFUSAL_CODES as readonly string[]).includes(code) || CONTROL_PLANE_CODES.has(code)) {
      throw new BadRequestException('code must be one of the runner refusal codes');
    }
  }
  const out: MainCheckoutActionResult = {
    requestId: row.requestId!,
    kind: row.kind as MainCheckoutActionKind,
    root: row.root,
    status,
    ...(status !== 'done' ? { code: code as MainCheckoutRefusalCode } : {}),
    finishedAt: typeof b.finishedAt === 'string' && !Number.isNaN(Date.parse(b.finishedAt)) ? b.finishedAt : new Date().toISOString(),
  };
  const record = out as unknown as Record<string, unknown>;
  for (const key of RESULT_STRINGS) {
    const v = b[key];
    if (typeof v === 'string' && v) record[key] = v.slice(0, key === 'gitMessage' || key === 'subject' ? 500 : PATH_MAX);
  }
  for (const key of RESULT_COUNTS) {
    const v = b[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) record[key] = v;
  }
  if (Array.isArray(b.paths)) out.paths = b.paths.filter(isPathString).slice(0, 50);
  return out;
}

/** A runner's snapshot answer, kept to its shape and bounds. */
function validSnapshotAnswer(body: unknown): MainCheckoutSnapshotAnswer {
  if (!body || typeof body !== 'object') throw new BadRequestException('answer must be an object');
  const b = body as Record<string, unknown>;
  if (typeof b.error === 'string' && b.error) return { error: b.error.slice(0, 500) };
  const s = b.snapshot as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object' || typeof s.root !== 'string' || typeof s.state !== 'string' || !Array.isArray(s.files)
    || typeof s.fingerprint !== 'string' || typeof s.fileCount !== 'number') {
    throw new BadRequestException('snapshot is missing or malformed');
  }
  const answer: MainCheckoutSnapshotAnswer = { snapshot: s as unknown as MainCheckoutSnapshot };
  if (Array.isArray(b.diffs)) answer.diffs = (b.diffs as MainCheckoutSnapshotAnswer['diffs'])!.slice(0, MAIN_CHECKOUT_DIFF_PATHS_MAX);
  return answer;
}
