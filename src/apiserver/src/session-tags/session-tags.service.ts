import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionTagDto, UpdateSessionTagDto } from './dto';

// The 7 always-present preset-color tags (positions 0..6), seeded per owner on first use.
// Mirrors the iOS Files palette / Apple system colors so the swatches read as native.
const SYSTEM_TAGS: { name: string; color: string }[] = [
  { name: 'Red', color: '#FF3B30' },
  { name: 'Orange', color: '#FF9500' },
  { name: 'Yellow', color: '#FFCC00' },
  { name: 'Green', color: '#34C759' },
  { name: 'Blue', color: '#007AFF' },
  { name: 'Purple', color: '#AF52DE' },
  { name: 'Gray', color: '#8E8E93' },
];

// The trimmed shape returned to clients — never leaks ownerId/timestamps.
const TAG_SELECT = {
  id: true,
  name: true,
  color: true,
  isSystem: true,
  position: true,
} satisfies Prisma.SessionTagSelect;

// System first, then creation order — the picker + row-dot ordering.
const TAG_ORDER: Prisma.SessionTagOrderByWithRelationInput[] = [
  { isSystem: 'desc' },
  { position: 'asc' },
  { createdAt: 'asc' },
];

@Injectable()
export class SessionTagsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotently create this owner's 7 system tags (no-op once they exist). Keyed on the
   *  (ownerId, name) unique, so it's safe to call on every list/create. */
  private async ensureSystemTags(ownerId: string): Promise<void> {
    await this.prisma.sessionTag.createMany({
      data: SYSTEM_TAGS.map((t, i) => ({ ...t, ownerId, isSystem: true, position: i })),
      skipDuplicates: true,
    });
  }

  /** The owner's full tag library (system tags always included), picker-ordered. */
  async list(ownerId: string) {
    await this.ensureSystemTags(ownerId);
    return this.prisma.sessionTag.findMany({
      where: { ownerId },
      orderBy: TAG_ORDER,
      select: TAG_SELECT,
    });
  }

  async create(ownerId: string, dto: CreateSessionTagDto) {
    await this.ensureSystemTags(ownerId);
    const agg = await this.prisma.sessionTag.aggregate({
      where: { ownerId },
      _max: { position: true },
    });
    const position = (agg._max.position ?? SYSTEM_TAGS.length - 1) + 1;
    try {
      return await this.prisma.sessionTag.create({
        data: { name: dto.name.trim(), color: dto.color, ownerId, isSystem: false, position },
        select: TAG_SELECT,
      });
    } catch (e) {
      throw this.rethrowNameConflict(e);
    }
  }

  async update(ownerId: string, id: string, dto: UpdateSessionTagDto) {
    const tag = await this.getOwned(ownerId, id);
    if (tag.isSystem) {
      throw new ForbiddenException('system tags cannot be renamed or recolored');
    }
    if (dto.name === undefined && dto.color === undefined) {
      throw new BadRequestException('nothing to update');
    }
    try {
      return await this.prisma.sessionTag.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
        },
        select: TAG_SELECT,
      });
    } catch (e) {
      throw this.rethrowNameConflict(e);
    }
  }

  async remove(ownerId: string, id: string) {
    const tag = await this.getOwned(ownerId, id);
    if (tag.isSystem) {
      throw new ForbiddenException('system tags cannot be deleted');
    }
    // Links cascade away at the DB level; the sessions themselves are untouched.
    await this.prisma.sessionTag.delete({ where: { id } });
    return { ok: true };
  }

  /** Replace the full set of tags on a session (picker sends the current selection). Validates
   *  the session and every tag belong to the owner, then swaps the links in one transaction. */
  async setForSession(ownerId: string, sessionId: string, tagIds: string[]) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const ids = [...new Set(tagIds)];
    if (ids.length > 0) {
      const owned = await this.prisma.sessionTag.count({ where: { id: { in: ids }, ownerId } });
      if (owned !== ids.length) throw new BadRequestException('unknown tag');
    }
    await this.prisma.$transaction([
      this.prisma.sessionTagLink.deleteMany({ where: { sessionId } }),
      ...(ids.length
        ? [this.prisma.sessionTagLink.createMany({ data: ids.map((tagId) => ({ sessionId, tagId })) })]
        : []),
    ]);
    return this.tagsForSession(sessionId);
  }

  /** The tags currently applied to a session, picker-ordered. */
  async tagsForSession(sessionId: string) {
    return this.prisma.sessionTag.findMany({
      where: { links: { some: { sessionId } } },
      orderBy: TAG_ORDER,
      select: TAG_SELECT,
    });
  }

  private async getOwned(ownerId: string, id: string) {
    const tag = await this.prisma.sessionTag.findFirst({ where: { id, ownerId } });
    if (!tag) throw new NotFoundException('tag not found');
    return tag;
  }

  private rethrowNameConflict(e: unknown): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException('a tag with that name already exists');
    }
    throw e as Error;
  }
}
