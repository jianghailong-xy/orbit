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
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import {
  OWNER_REQUEST_EXPIRED,
  OWNER_REQUEST_NOT_ASKER,
  OWNER_REQUEST_NOT_PENDING,
  OwnerRequestNotFileable,
  normalizeOwnerRequest,
  type OwnerRequestFiling,
  type OwnerRequestOption,
  type OwnerRequestState,
} from './owner-request';

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
  expiresAt: true,
  clientRequestId: true,
  askedBySessionId: true,
  projectId: true,
  resolvedAt: true,
  resolvedByUserId: true,
  resolvedBySessionId: true,
  resolutionNote: true,
  answer: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OwnerRequestSelect;

/** A JSON column's value, or SQL NULL when there is none. */
function json(value: object | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
}

export type OwnerRequestView = Prisma.OwnerRequestGetPayload<{ select: typeof VIEW }>;

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
    /** Optional so a build or spec without PushModule files requests exactly the same. */
    @Optional() private readonly push?: PushService,
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
   * the request it already filed, in whatever state it is now, and the owner is told once.
   */
  async file(ownerId: string, askingSessionId: string, filing: OwnerRequestFiling): Promise<OwnerRequestView> {
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
      select: { id: true },
    });
    if (!session) throw new NotFoundException('the asking session is not one of this account’s');
    const blocks = request.blocksTaskIds ?? [];
    if (blocks.length > 0) {
      const own = await this.prisma.task.count({ where: { id: { in: blocks }, ownerId } });
      if (own !== blocks.length) throw new NotFoundException('blocksTaskIds names a task this account does not have');
    }
    if (request.projectId) {
      const project = await this.prisma.project.count({ where: { id: request.projectId, ownerId } });
      if (project === 0) throw new NotFoundException('projectId names a project this account does not have');
    }
    if (request.secretSpec) {
      const runner = await this.prisma.runner.count({ where: { id: request.secretSpec.runnerId, ownerId } });
      if (runner === 0) throw new NotFoundException('secretSpec.runnerId names a runner this account does not have');
    }

    const [created] = await this.prisma.ownerRequest.createManyAndReturn({
      data: [{
        ownerId,
        askedBySessionId: askingSessionId,
        projectId: request.projectId ?? null,
        kind: request.kind,
        state: 'PENDING',
        title: request.title,
        why: request.why,
        blocksTaskIds: blocks,
        ifUnanswered: request.ifUnanswered ?? null,
        options: json(request.options),
        recommendedOption: request.recommendedOption ?? null,
        steps: json(request.steps),
        secretSpec: json(request.secretSpec),
        verifyHint: request.verifyHint ?? null,
        expiresAt: request.expiresAtDate,
        clientRequestId: request.clientRequestId ?? null,
      }],
      skipDuplicates: true,
      select: VIEW,
    });
    if (created) {
      // Told after the row is committed, and never awaited: the request is the fact, the banner a reader of it.
      void this.push?.notifyOwnerRequest(created.id);
      return created;
    }
    // Only a duplicate key reaches here: this session already filed under this clientRequestId.
    const already = await this.prisma.ownerRequest.findFirst({
      where: { ownerId, askedBySessionId: askingSessionId, clientRequestId: request.clientRequestId },
      select: VIEW,
    });
    if (!already) throw new ConflictException('the request under this clientRequestId could not be read back; try again');
    return already;
  }

  /** The owner's requests in one list (`open` unless named), newest first. */
  async list(ownerId: string, filter: string | undefined): Promise<{ requests: OwnerRequestView[] }> {
    const key = filter ?? 'open';
    if (!(key in OWNER_REQUEST_LIST_FILTERS)) {
      throw new BadRequestException(`state is one of ${Object.keys(OWNER_REQUEST_LIST_FILTERS).join(', ')}`);
    }
    const state = OWNER_REQUEST_LIST_FILTERS[key];
    const requests = await this.prisma.ownerRequest.findMany({
      where: { ownerId, ...(state ? { state } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
      select: VIEW,
    });
    return { requests };
  }

  async get(ownerId: string, id: string): Promise<OwnerRequestView> {
    const request = await this.prisma.ownerRequest.findFirst({ where: { id, ownerId }, select: VIEW });
    if (!request) throw new NotFoundException('owner request not found');
    return request;
  }

  /** The owner did what was asked. A DECISION records the option chosen or the owner's words. */
  async complete(ownerId: string, id: string, given: { option?: number; text?: string }): Promise<OwnerRequestView> {
    const request = await this.get(ownerId, id);
    const text = given.text?.trim();
    const option = given.option ?? undefined;
    if (option !== undefined) {
      const options = (request.options ?? []) as unknown as OwnerRequestOption[];
      if (request.kind !== 'DECISION') throw new BadRequestException('only a DECISION request takes an option');
      if (!Number.isInteger(option) || option < 0 || option >= options.length) {
        throw new BadRequestException('option must name one of the options this request offered');
      }
    }
    if (request.kind === 'DECISION' && option === undefined && !text) {
      throw new BadRequestException('a decision needs an option or some text');
    }
    const answer = option !== undefined || text
      ? { ...(option !== undefined ? { option } : {}), ...(text ? { text } : {}) }
      : null;
    return this.settle(ownerId, id, 'DONE', {
      resolvedByUserId: ownerId,
      answer: json(answer),
    });
  }

  /** The owner refuses the request. The reason is what the asking session reads. */
  async decline(ownerId: string, id: string, reason: string): Promise<OwnerRequestView> {
    const note = reason?.trim();
    if (!note) throw new BadRequestException('reason is required: say why, so the session asking can act on it');
    await this.get(ownerId, id);
    return this.settle(ownerId, id, 'DECLINED', { resolvedByUserId: ownerId, resolutionNote: note });
  }

  /** The asking session no longer needs it. Only the session that filed a request may withdraw it. */
  async withdraw(ownerId: string, sessionId: string, id: string, reason: string | undefined): Promise<OwnerRequestView> {
    const request = await this.get(ownerId, id);
    if (request.askedBySessionId !== sessionId) {
      throw new ForbiddenException({
        code: OWNER_REQUEST_NOT_ASKER,
        message: 'only the session that filed this request may withdraw it',
      });
    }
    return this.settle(ownerId, id, 'WITHDRAWN', {
      resolvedBySessionId: sessionId,
      resolutionNote: reason?.trim() || null,
    });
  }

  /**
   * Every PENDING request whose deadline has passed, moved to EXPIRED in one statement. Its own
   * compare-and-set: two replicas sweeping at once expire each request once between them.
   */
  async expireDue(now: Date): Promise<string[]> {
    const expired = await this.prisma.ownerRequest.updateManyAndReturn({
      where: { state: 'PENDING', expiresAt: { lte: now } },
      data: { state: 'EXPIRED', resolvedAt: now },
      select: { id: true },
    });
    return expired.map((row) => row.id);
  }

  /**
   * One ending, written only while the request is still PENDING and not past its deadline. When
   * nothing matched, the request is read again to say why: already ended, or expired.
   */
  private async settle(
    ownerId: string,
    id: string,
    to: Exclude<OwnerRequestState, 'PENDING' | 'EXPIRED'>,
    data: Prisma.OwnerRequestUpdateManyMutationInput,
  ): Promise<OwnerRequestView> {
    const now = new Date();
    const settled = await this.prisma.ownerRequest.updateMany({
      where: { id, ownerId, state: 'PENDING', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      data: { ...data, state: to, resolvedAt: now },
    });
    const request = await this.get(ownerId, id);
    if (settled.count === 1) return request;
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
