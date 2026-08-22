"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var SessionTagsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionTagsService = exports.SESSION_TAG_PALETTE = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const shared_1 = require("@orbit/shared");
const lock_order_1 = require("../common/lock-order");
const transaction_retry_1 = require("../common/transaction-retry");
const prisma_service_1 = require("../prisma/prisma.service");
const realtime_service_1 = require("../realtime/realtime.service");
// The 7 always-present preset-color tags (positions 0..6), seeded per owner on first use.
// Mirrors the iOS Files palette / Apple system colors so the swatches read as native.
const SYSTEM_TAGS = [
    { name: 'Red', color: '#FF3B30' },
    { name: 'Orange', color: '#FF9500' },
    { name: 'Yellow', color: '#FFCC00' },
    { name: 'Green', color: '#34C759' },
    { name: 'Blue', color: '#007AFF' },
    { name: 'Purple', color: '#AF52DE' },
    { name: 'Gray', color: '#8E8E93' },
];
/** The swatches a tag may wear, in picker order. A custom tag created without a person choosing
 *  a color (auto-tagging on session create) cycles this by position, so a grown-up library reads
 *  as distinguishable dots rather than a column of one color. Length doubles as the count of
 *  system tags, which is where custom `position` values start. */
exports.SESSION_TAG_PALETTE = SYSTEM_TAGS.map((t) => t.color);
// The trimmed shape returned to clients — never leaks ownerId/timestamps.
const TAG_SELECT = {
    id: true,
    name: true,
    color: true,
    isSystem: true,
    position: true,
};
// System first, then creation order — the picker + row-dot ordering.
const TAG_ORDER = [
    { isSystem: 'desc' },
    { position: 'asc' },
    { createdAt: 'asc' },
];
let SessionTagsService = SessionTagsService_1 = class SessionTagsService {
    prisma;
    realtime;
    logger = new common_1.Logger(SessionTagsService_1.name);
    constructor(prisma, 
    // @Global RealtimeModule. The tag library belongs to the owner, not to a session, so library
    // edits push user-scoped; applying tags to a session refreshes that session's list row.
    realtime) {
        this.prisma = prisma;
        this.realtime = realtime;
    }
    /** Idempotently create this owner's 7 system tags (no-op once they exist). Keyed on the
     *  (ownerId, name) unique, so it's safe to call on every list/create. */
    async ensureSystemTags(ownerId) {
        await this.prisma.sessionTag.createMany({
            data: SYSTEM_TAGS.map((t, i) => ({ ...t, ownerId, isSystem: true, position: i })),
            skipDuplicates: true,
        });
    }
    /** The owner's full tag library (system tags always included), picker-ordered. */
    async list(ownerId) {
        await this.ensureSystemTags(ownerId);
        return this.prisma.sessionTag.findMany({
            where: { ownerId },
            orderBy: TAG_ORDER,
            select: TAG_SELECT,
        });
    }
    async create(ownerId, dto) {
        await this.ensureSystemTags(ownerId);
        const agg = await this.prisma.sessionTag.aggregate({
            where: { ownerId },
            _max: { position: true },
        });
        const position = (agg._max.position ?? SYSTEM_TAGS.length - 1) + 1;
        try {
            const tag = await this.prisma.sessionTag.create({
                data: { name: dto.name.trim(), color: dto.color, ownerId, isSystem: false, position },
                select: TAG_SELECT,
            });
            this.realtime.publishForUser(ownerId, shared_1.RunEventType.TAG_CHANGED, tag.id);
            return tag;
        }
        catch (e) {
            throw this.rethrowNameConflict(e);
        }
    }
    async update(ownerId, id, dto) {
        const tag = await this.getOwned(ownerId, id);
        if (tag.isSystem) {
            throw new common_1.ForbiddenException('system tags cannot be renamed or recolored');
        }
        if (dto.name === undefined && dto.color === undefined) {
            throw new common_1.BadRequestException('nothing to update');
        }
        try {
            const updated = await this.prisma.sessionTag.update({
                where: { id },
                data: {
                    ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
                    ...(dto.color !== undefined ? { color: dto.color } : {}),
                },
                select: TAG_SELECT,
            });
            this.realtime.publishForUser(ownerId, shared_1.RunEventType.TAG_CHANGED, id);
            return updated;
        }
        catch (e) {
            throw this.rethrowNameConflict(e);
        }
    }
    async remove(ownerId, id) {
        const tag = await this.getOwned(ownerId, id);
        if (tag.isSystem) {
            throw new common_1.ForbiddenException('system tags cannot be deleted');
        }
        // Links cascade away at the DB level; the sessions themselves are untouched.
        await this.prisma.sessionTag.delete({ where: { id } });
        this.realtime.publishForUser(ownerId, shared_1.RunEventType.TAG_CHANGED, id);
        return { ok: true };
    }
    /** Replace the full set of tags on a session (picker sends the current selection). Validates
     *  the session and every tag belong to the owner, then swaps the links in one transaction. */
    async setForSession(ownerId, sessionId, tagIds) {
        const session = await this.prisma.session.findFirst({
            where: { id: sessionId, ownerId },
            select: { id: true },
        });
        if (!session)
            throw new common_1.NotFoundException('session not found');
        const ids = [...new Set(tagIds)];
        if (ids.length > 0) {
            const owned = await this.prisma.sessionTag.count({ where: { id: { in: ids }, ownerId } });
            if (owned !== ids.length)
                throw new common_1.BadRequestException('unknown tag');
        }
        // Sorted, and retried whole. The INSERT takes `FOR KEY SHARE` on each tag row through
        // `session_tag_link_tag_id_fkey`, in whatever order the picker happened to send — so two
        // people re-tagging two different sessions with the same tags in opposite orders were taking
        // the same rows backwards. FOR KEY SHARE does not conflict with itself, so that pair alone
        // could not cycle; a concurrent tag rename or delete (FOR UPDATE) is the other half that
        // could. Ordering costs nothing and removes the question (common/lock-order.ts, `orderedIds`).
        //
        // Every attempt re-runs both statements against a snapshot where neither has happened, and
        // `ids` is computed above, outside the closure — so a retry rewrites the same link set rather
        // than a different one.
        const linkIds = (0, lock_order_1.orderedIds)(ids);
        await (0, transaction_retry_1.withTransactionRetry)(this.prisma, async (tx) => {
            await tx.sessionTagLink.deleteMany({ where: { sessionId } });
            if (linkIds.length > 0) {
                await tx.sessionTagLink.createMany({ data: linkIds.map((tagId) => ({ sessionId, tagId })) });
            }
        }, (0, transaction_retry_1.loggedRetry)(this.logger, 'sessionTags.setForSession'));
        // The list row shows a session's tag dots, so refresh that row on the other clients too.
        this.realtime.publishSessionUpdated(sessionId);
        return this.tagsForSession(sessionId);
    }
    /** The tags currently applied to a session, picker-ordered. */
    async tagsForSession(sessionId) {
        return this.prisma.sessionTag.findMany({
            where: { links: { some: { sessionId } } },
            orderBy: TAG_ORDER,
            select: TAG_SELECT,
        });
    }
    async getOwned(ownerId, id) {
        const tag = await this.prisma.sessionTag.findFirst({ where: { id, ownerId } });
        if (!tag)
            throw new common_1.NotFoundException('tag not found');
        return tag;
    }
    rethrowNameConflict(e) {
        if (e instanceof client_1.Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new common_1.ConflictException('a tag with that name already exists');
        }
        throw e;
    }
};
exports.SessionTagsService = SessionTagsService;
exports.SessionTagsService = SessionTagsService = SessionTagsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, realtime_service_1.RealtimeService])
], SessionTagsService);
//# sourceMappingURL=session-tags.service.js.map