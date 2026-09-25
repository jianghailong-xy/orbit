import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { withSessionState } from '../sessions/session-state';
import type { PutShareLinkDto } from './dto';
import {
  linkNotFound,
  linkState,
  mergeInclude,
  resolveInclude,
  type ShareInclude,
  type ShareLinkState,
  type ShareLinkStateReason,
  type ShareRootKind,
} from './share-link';

/** The column a root of each kind is named by, as a `where`/`data` fragment. */
function rootColumn(kind: ShareRootKind, id: string): { sessionId: string } | { taskId: string } | { projectId: string } {
  if (kind === 'SESSION') return { sessionId: id };
  if (kind === 'TASK') return { taskId: id };
  return { projectId: id };
}

/** Every read of a link takes the row and its root's minimal projection, in one query. */
const LINK_SELECT = {
  id: true,
  token: true,
  sessionId: true,
  taskId: true,
  projectId: true,
  include: true,
  expiresAt: true,
  revokedAt: true,
  revokedReason: true,
  viewCount: true,
  lastViewedAt: true,
  createdAt: true,
  updatedAt: true,
  session: {
    select: {
      id: true, title: true, status: true, endReason: true, completedAt: true, archivedAt: true, deletedAt: true,
    },
  },
  task: { select: { id: true, title: true, status: true } },
  project: { select: { id: true, title: true, status: true } },
} satisfies Prisma.ShareLinkSelect;

type LinkRow = Prisma.ShareLinkGetPayload<{ select: typeof LINK_SELECT }>;

/** A token is 32 characters; anything much longer is not one, and is not worth an index probe. */
const MAX_TOKEN_LENGTH = 256;
/** How many times opening a link re-reads after losing a race for the root's one open slot. */
const OPEN_ATTEMPTS = 3;

/** A root as the owner's list and the dialog show it — enough to name it and say where it stands. */
export type ShareRootSummary =
  | { id: string; title: string; status: string; lifecycleState: string; completedAt: Date | string | null }
  | { id: string; title: string; status: string };

/** How much a session link's two layers hold: Messages, and Tool calls and output. */
export interface SessionShareCounts {
  messages: number;
  toolCalls: number;
}

/** One link as its owner sees it (contract §5). */
export interface ShareLinkView {
  id: string;
  kind: ShareRootKind;
  token: string;
  include: Required<ShareInclude>;
  expiresAt: Date | null;
  revokedAt: Date | null;
  viewCount: number;
  lastViewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  state: ShareLinkState;
  stateReason: ShareLinkStateReason | null;
  root: ShareRootSummary;
}

/** What a token opens, once the public door has decided it opens anything. */
export interface OpenLink {
  id: string;
  kind: ShareRootKind;
  include: Required<ShareInclude>;
  sharedAt: Date;
  /** Set for a session root: the transcript the link serves. */
  sessionId: string | null;
  /** Set for a task or a project root (T6/T7 project it further). */
  root: { id: string; title: string; status: string } | null;
}

function kindOf(row: { sessionId: string | null; taskId: string | null }): ShareRootKind {
  if (row.sessionId) return 'SESSION';
  if (row.taskId) return 'TASK';
  return 'PROJECT';
}

/** Whether two sets of stored choices say the same thing, whatever order their keys are in. */
function sameChoices(left: ShareInclude, right: ShareInclude): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof ShareInclude)[]);
  return [...keys].every((key) => left[key] === right[key]);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Public links: one row per link in `share_link` (migration 0306), one root per row — a session, a
 * task or a project. The owner's half opens, changes, lists and ends them; the public half turns a
 * token into what it opens, or into the one 404 a dead link answers with. docs/share-links-design.md
 * §3–§5 is the contract.
 *
 * Every write is its own statement (db-write-inventory STATEMENT_UNITS). What would otherwise need a
 * transaction — two requests opening the same root at once — is settled by the partial unique index
 * over each root's open link: the INSERT that loses it re-reads and finds the winner.
 */
@Injectable()
export class ShareLinksService {
  constructor(private readonly prisma: PrismaService) {}

  // ── the owner's half ───────────────────────────────────────────────────────────────────────

  /** The root's link that has not ended — ACTIVE, PAUSED, or past its expiry and not yet settled —
   *  or null when it has none. A session root also says how much each of its layers holds, so the
   *  dialog can show what a link exposes before anyone opens it (contract §1). */
  async current(
    ownerId: string,
    kind: ShareRootKind,
    rootId: string,
  ): Promise<{ link: ShareLinkView | null; counts?: SessionShareCounts }> {
    await this.ownedRoot(ownerId, kind, rootId);
    const row = await this.openRow(ownerId, kind, rootId);
    const link = row ? this.view(row, new Date()) : null;
    if (kind !== 'SESSION') return { link };
    return { link, counts: await this.sessionCounts(rootId) };
  }

  /** The session's Messages layer is what you and the agent wrote (its `user` and `assistant`
   *  events), and its Tool output layer is one call per `tool_use` — counted in the database, over
   *  the whole transcript, not over whatever page a client happens to hold. */
  private async sessionCounts(sessionId: string): Promise<SessionShareCounts> {
    const groups = await this.prisma.runEvent.groupBy({
      by: ['type'],
      where: { sessionId, type: { in: [RunEventType.USER, RunEventType.ASSISTANT, RunEventType.TOOL_USE] } },
      _count: { _all: true },
    });
    const of = (type: RunEventType) => groups.find((group) => group.type === type)?._count._all ?? 0;
    return { messages: of(RunEventType.USER) + of(RunEventType.ASSISTANT), toolCalls: of(RunEventType.TOOL_USE) };
  }

  /**
   * Open the root's link, or change the one that is open: `include` and `expiresAt` as given, each
   * left alone when left out. Idempotent — the same PUT twice changes nothing the second time and
   * answers the same link. A link that has ended does not come back: past its expiry, it is settled
   * EXPIRED and a new link, with a new token, is opened in its place. A session in the trash cannot
   * be shared (its link, if it has one, stays paused as it is).
   */
  async put(ownerId: string, kind: ShareRootKind, rootId: string, dto: PutShareLinkDto): Promise<ShareLinkView> {
    const root = await this.ownedRoot(ownerId, kind, rootId);
    if (root.inTrash) {
      throw new ConflictException('this session is in the trash — restore it before sharing it');
    }
    const expiresAt = this.expiryFrom(dto.expiresAt);
    mergeInclude(kind, {}, dto.include); // refuses a layer the root does not have, before anything is read
    for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
      const now = new Date();
      const open = await this.openRow(ownerId, kind, rootId);
      if (open && linkState(open, false, now).state !== 'ENDED') {
        const include = mergeInclude(kind, open.include, dto.include);
        const nextExpiry = expiresAt === undefined ? open.expiresAt : expiresAt;
        const unchanged = sameChoices(include, mergeInclude(kind, open.include, undefined))
          && (nextExpiry?.getTime() ?? null) === (open.expiresAt?.getTime() ?? null);
        if (unchanged) return this.view(open, now);
        if (await this.change(open.id, include, nextExpiry, now)) {
          return this.view(await this.rowById(open.id), now);
        }
        continue; // it ended between the read and the write: read again
      }
      if (open) await this.end({ id: open.id }, now); // past its expiry: settle it EXPIRED first
      const created = await this.insert(ownerId, kind, rootId, mergeInclude(kind, {}, dto.include), expiresAt ?? null);
      if (created) return this.view(await this.rowById(created), now);
    }
    throw new ConflictException('this link changed while it was being opened — nothing was changed; try again');
  }

  /**
   * `POST /sessions/:id/share`, for the clients that still send it: open the session's link with
   * the defaults if it has none, change nothing if it has one, and answer in the old shape.
   */
  async enableLegacy(ownerId: string, sessionId: string): Promise<{ shareToken: string; sharedAt: Date }> {
    const link = await this.put(ownerId, 'SESSION', sessionId, {});
    return { shareToken: link.token, sharedAt: link.createdAt };
  }

  /** Access → Only you: end the root's link. Nothing to end is not an error. */
  async turnOff(ownerId: string, kind: ShareRootKind, rootId: string): Promise<void> {
    await this.ownedRoot(ownerId, kind, rootId);
    await this.end({ ownerId, ...rootColumn(kind, rootId) }, new Date());
  }

  /** Every link the caller has made, ended ones included, newest first (Settings → Shared links). */
  async list(ownerId: string): Promise<{ links: ShareLinkView[] }> {
    const rows = await this.prisma.shareLink.findMany({
      where: { ownerId },
      select: LINK_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const now = new Date();
    return { links: rows.map((row) => this.view(row, now)) };
  }

  /** End one link by its own id. Another account's link is not found; an ended one stays as it is. */
  async turnOffById(ownerId: string, id: string): Promise<void> {
    const row = await this.prisma.shareLink.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!row) throw new NotFoundException('share link not found');
    await this.end({ id, ownerId }, new Date());
  }

  /** End every listed link that is the caller's and still open; `count` is how many were turned off. */
  async turnOffMany(ownerId: string, ids: string[]): Promise<{ count: number }> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return { count: 0 };
    return { count: await this.end({ id: { in: unique }, ownerId }, new Date()) };
  }

  // ── the public half ────────────────────────────────────────────────────────────────────────

  /**
   * What `token` opens, or the one 404 (share-link.ts LINK_NOT_FOUND) — for a token never issued, a
   * link turned off or past its expiry, and a session root in the trash alike. No owner: the token
   * is the capability.
   */
  async resolve(token: string): Promise<OpenLink> {
    if (!token || token.length > MAX_TOKEN_LENGTH) throw linkNotFound();
    const row = await this.prisma.shareLink.findUnique({ where: { token }, select: LINK_SELECT });
    if (!row) throw linkNotFound();
    if (linkState(row, row.session?.deletedAt != null, new Date()).state !== 'ACTIVE') throw linkNotFound();
    const kind = kindOf(row);
    const root = row.task ?? row.project;
    return {
      id: row.id,
      kind,
      include: resolveInclude(kind, row.include),
      sharedAt: row.createdAt,
      sessionId: row.sessionId,
      root: kind === 'SESSION' || !root ? null : { id: root.id, title: root.title, status: root.status },
    };
  }

  /** One more open of the link's root page, and when. Pages, attachments and nested pages do not
   *  call this (contract §4). */
  async recordView(id: string): Promise<void> {
    await this.prisma.shareLink.updateMany({
      where: { id },
      data: { viewCount: { increment: 1 }, lastViewedAt: new Date() },
    });
  }

  // ── rows ───────────────────────────────────────────────────────────────────────────────────

  /** The caller's root, or its kind's 404 — another account's root is not found, exactly as a
   *  missing one is. Says whether a session root is in the trash. */
  private async ownedRoot(ownerId: string, kind: ShareRootKind, id: string): Promise<{ inTrash: boolean }> {
    if (kind === 'SESSION') {
      const session = await this.prisma.session.findFirst({ where: { id, ownerId }, select: { deletedAt: true } });
      if (!session) throw new NotFoundException('session not found');
      return { inTrash: session.deletedAt != null };
    }
    if (kind === 'TASK') {
      const task = await this.prisma.task.findFirst({ where: { id, ownerId }, select: { id: true } });
      if (!task) throw new NotFoundException('task not found');
      return { inTrash: false };
    }
    const project = await this.prisma.project.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!project) throw new NotFoundException('project not found');
    return { inTrash: false };
  }

  private openRow(ownerId: string, kind: ShareRootKind, rootId: string): Promise<LinkRow | null> {
    return this.prisma.shareLink.findFirst({
      where: { ownerId, ...rootColumn(kind, rootId), revokedAt: null },
      select: LINK_SELECT,
    });
  }

  private rowById(id: string): Promise<LinkRow> {
    return this.prisma.shareLink.findUniqueOrThrow({ where: { id }, select: LINK_SELECT });
  }

  /** `undefined` leaves the expiry as it is, `null` is Never; anything else must be a future instant. */
  private expiryFrom(raw: string | null | undefined): Date | null | undefined {
    if (raw === undefined || raw === null) return raw;
    const at = new Date(raw);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be a future instant');
    }
    return at;
  }

  /** A new link with a fresh token, or null when another request opened this root's link first
   *  (the partial unique index over its open link) — the caller reads again and finds it. */
  private async insert(
    ownerId: string,
    kind: ShareRootKind,
    rootId: string,
    include: ShareInclude,
    expiresAt: Date | null,
  ): Promise<string | null> {
    try {
      const row = await this.prisma.shareLink.create({
        data: {
          ownerId,
          token: randomBytes(24).toString('base64url'),
          ...rootColumn(kind, rootId),
          include: include as Prisma.InputJsonObject,
          expiresAt,
        },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** New layers and expiry on a link that is still open; false when it ended in the meantime. */
  private async change(id: string, include: ShareInclude, expiresAt: Date | null, now: Date): Promise<boolean> {
    const written = await this.prisma.shareLink.updateMany({
      where: { id, revokedAt: null },
      data: { include: include as Prisma.InputJsonObject, expiresAt, updatedAt: now },
    });
    return written.count === 1;
  }

  /**
   * End the open links `where` names. One already past its expiry ended by expiring, and is
   * recorded EXPIRED; the rest are TURNED_OFF. Answers how many were turned off.
   */
  private async end(where: Prisma.ShareLinkWhereInput, now: Date): Promise<number> {
    await this.prisma.shareLink.updateMany({
      where: { ...where, revokedAt: null, expiresAt: { lte: now } },
      data: { revokedAt: now, revokedReason: 'EXPIRED', updatedAt: now },
    });
    const turnedOff = await this.prisma.shareLink.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'TURNED_OFF', updatedAt: now },
    });
    return turnedOff.count;
  }

  private view(row: LinkRow, now: Date): ShareLinkView {
    const kind = kindOf(row);
    const { state, reason } = linkState(row, row.session?.deletedAt != null, now);
    return {
      id: row.id,
      kind,
      token: row.token,
      include: resolveInclude(kind, row.include),
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      viewCount: row.viewCount,
      lastViewedAt: row.lastViewedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      state,
      stateReason: reason,
      root: this.rootSummary(row),
    };
  }

  private rootSummary(row: LinkRow): ShareRootSummary {
    if (row.session) {
      const session = withSessionState(row.session);
      return {
        id: session.id,
        title: session.title,
        status: session.status,
        lifecycleState: session.lifecycleState,
        completedAt: session.completedAt,
      };
    }
    const root = (row.task ?? row.project)!;
    return { id: root.id, title: root.title, status: root.status };
  }
}
