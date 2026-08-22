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
var ProjectEventsService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectEventsService = exports.PROJECT_EVENT_SOURCE_TYPES = void 0;
exports.projectEventRetryDelayMs = projectEventRetryDelayMs;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const pg_1 = require("pg");
const prisma_service_1 = require("../prisma/prisma.service");
const transaction_retry_1 = require("../common/transaction-retry");
exports.PROJECT_EVENT_SOURCE_TYPES = [
    'TASK',
    'SESSION',
    'RUNNER',
    'PROVIDER',
    'MERGE',
    'USER',
    'TIMER',
];
/**
 * `project_event.id` is a UUID column and these are JavaScript strings. The Prisma driver binds a
 * bare string parameter as text, and PostgreSQL has no `uuid = text` operator — so an uncast list
 * fails the whole delivery with 42883 and every event in it retries until it is DEAD. The `pg`
 * shim the isolated harnesses use sends parameters untyped, where the server infers uuid, which is
 * why this only appears on the real client.
 */
function uuidList(ids) {
    return client_1.Prisma.join(ids.map((id) => client_1.Prisma.sql `${id}::uuid`));
}
const EVENT_CHANNEL = 'project_event';
const LISTENER_RECONNECT_MS = 2_000;
const MAX_PROJECTS_PER_DRAIN = 25;
const MAX_EVENTS_PER_PROJECT = 100;
const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Exponential retry for delivery failures. Attempt one waits 1s; the ceiling is five minutes. */
function projectEventRetryDelayMs(attempt) {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new RangeError('attempt must be a positive integer');
    }
    return Math.min(2 ** Math.min(attempt - 1, 30) * 1_000, MAX_BACKOFF_MS);
}
/**
 * Transactional Project outbox and its in-process delivery pump.
 *
 * Producers call `enqueue(tx, ...)` with the transaction that owns their business write. The pump
 * has a durable polling path plus a PostgreSQL LISTEN/NOTIFY accelerator; it deliberately does no
 * work until the reconcile unit registers its single transaction-only handler.
 */
let ProjectEventsService = ProjectEventsService_1 = class ProjectEventsService {
    prisma;
    log = new common_1.Logger(ProjectEventsService_1.name);
    handler;
    listener;
    connecting = false;
    started = false;
    stopped = false;
    reconnectTimer;
    draining = false;
    drainRequested = false;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async onModuleInit() {
        this.started = true;
        this.stopped = false;
        await this.startListener();
        // A handler may have registered before Nest initialized this provider. LISTEN accelerates new
        // commits; this immediate drain covers rows that were already durable at process start.
        this.requestDrain();
    }
    onModuleDestroy() {
        this.started = false;
        this.stopped = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.listener?.removeAllListeners('error');
        this.listener?.end().catch(() => undefined);
        this.listener = undefined;
    }
    /**
     * Install the sole Project reconcile consumer. Returning an unregister function makes isolated
     * tests and module shutdown explicit; replacing a live handler is rejected because two semantic
     * consumers would make ownership of a Project ambiguous even though row locks serialize them.
     */
    registerHandler(handler) {
        if (this.handler && this.handler !== handler) {
            throw new Error('a Project event handler is already registered');
        }
        this.handler = handler;
        this.requestDrain();
        return () => {
            if (this.handler === handler)
                this.handler = undefined;
        };
    }
    /**
     * Insert or coalesce one dirty signal. This method never opens its own transaction: accepting
     * only a TransactionClient is the API-level reminder that the authoritative write and outbox
     * row live or roll back together.
     */
    async enqueue(tx, input) {
        const v = input.v ?? 1;
        if (!Number.isSafeInteger(v) || v < 1)
            throw new RangeError('project event v must be positive');
        if (!input.kind.trim())
            throw new RangeError('project event kind must not be empty');
        if (!input.dedupeKey.trim())
            throw new RangeError('project event dedupeKey must not be empty');
        const id = (0, node_crypto_1.randomUUID)();
        const occurredAt = input.occurredAt ?? new Date();
        const payload = JSON.stringify(input.payload ?? {});
        const rows = await tx.$queryRaw(client_1.Prisma.sql `
      INSERT INTO "project_event" (
        "id", "project_id", "v", "kind", "occurred_at", "source_type", "source_id",
        "dedupe_key", "payload", "last_at"
      ) VALUES (
        ${id}::uuid, ${input.projectId}::uuid, ${v}, ${input.kind}, ${occurredAt},
        ${input.source.type}, ${input.source.id}::uuid, ${input.dedupeKey},
        ${payload}::jsonb, ${occurredAt}
      )
      ON CONFLICT ("project_id", "dedupe_key") WHERE "consumed_at" IS NULL
      DO UPDATE SET
        "occurrences" = "project_event"."occurrences" + 1,
        "last_at" = GREATEST("project_event"."last_at", EXCLUDED."occurred_at"),
        "v" = CASE WHEN EXCLUDED."occurred_at" >= "project_event"."last_at"
                   THEN EXCLUDED."v" ELSE "project_event"."v" END,
        "kind" = CASE WHEN EXCLUDED."occurred_at" >= "project_event"."last_at"
                      THEN EXCLUDED."kind" ELSE "project_event"."kind" END,
        "source_type" = CASE WHEN EXCLUDED."occurred_at" >= "project_event"."last_at"
                             THEN EXCLUDED."source_type" ELSE "project_event"."source_type" END,
        "source_id" = CASE WHEN EXCLUDED."occurred_at" >= "project_event"."last_at"
                           THEN EXCLUDED."source_id" ELSE "project_event"."source_id" END,
        "payload" = CASE WHEN EXCLUDED."occurred_at" >= "project_event"."last_at"
                         THEN EXCLUDED."payload" ELSE "project_event"."payload" END
      RETURNING "id", "project_id" AS "projectId", "v", "kind",
        "occurred_at" AS "occurredAt", "source_type" AS "sourceType",
        "source_id" AS "sourceId", "dedupe_key" AS "dedupeKey", "payload",
        "occurrences", "last_at" AS "lastAt", "attempts",
        "next_attempt_at" AS "nextAttemptAt"
    `);
        return envelope(rows[0]);
    }
    /** Process at most one Project. Public so database/fault tests can drive a deterministic tick. */
    async drainOnce(now = new Date()) {
        const result = await this.deliverOnce(now);
        if (result.status !== 'NO_HANDLER')
            await this.handler?.afterCommit?.(result);
        return result;
    }
    async deliverOnce(now) {
        const handler = this.handler;
        if (!handler)
            return { status: 'NO_HANDLER' };
        // Retried whole, and this is where RepeatableRead makes it necessary rather than merely safe:
        // a snapshot invalidated by a concurrent writer arrives as 40001, which the loop below is the
        // only correct answer to. Safe because the handler contract forbids touching anything outside
        // the database inside this transaction — `afterCommit` (called by `drainOnce`, outside) is where
        // that goes — so a re-run re-reads the pending events and re-runs `handle` against the snapshot
        // that actually commits, and nothing has been told about the attempt that did not.
        return (0, transaction_retry_1.withTransactionRetry)(this.prisma, async (tx) => {
            const projects = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT p."id" AS "projectId"
          FROM "project" p
         WHERE EXISTS (
           SELECT 1
             FROM "project_event" e
            WHERE e."project_id" = p."id"
              AND e."consumed_at" IS NULL
              AND (e."next_attempt_at" IS NULL OR e."next_attempt_at" <= ${now})
         )
         ORDER BY (
           SELECT MIN(COALESCE(e."next_attempt_at", e."occurred_at"))
             FROM "project_event" e
            WHERE e."project_id" = p."id" AND e."consumed_at" IS NULL
         ), p."id"
         LIMIT 1
         FOR NO KEY UPDATE OF p SKIP LOCKED
      `);
            const projectId = projects[0]?.projectId;
            if (!projectId)
                return { status: 'IDLE' };
            const rows = await tx.$queryRaw(client_1.Prisma.sql `
        SELECT "id", "project_id" AS "projectId", "v", "kind",
               "occurred_at" AS "occurredAt", "source_type" AS "sourceType",
               "source_id" AS "sourceId", "dedupe_key" AS "dedupeKey", "payload",
               "occurrences", "last_at" AS "lastAt", "attempts",
               "next_attempt_at" AS "nextAttemptAt"
          FROM "project_event"
         WHERE "project_id" = ${projectId}::uuid
           AND "consumed_at" IS NULL
           AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${now})
         ORDER BY "occurred_at", "id"
         LIMIT ${MAX_EVENTS_PER_PROJECT}
         FOR UPDATE
      `);
            if (rows.length === 0)
                return { status: 'IDLE' };
            const events = rows.map(envelope);
            // A handler may have written several rows before it discovers a conflict. The savepoint
            // rolls those writes back while preserving the outer transaction and the row locks, so the
            // retry schedule is committed by the same legal claimant instead of racing a second worker.
            await tx.$executeRawUnsafe('SAVEPOINT project_event_delivery');
            try {
                const handled = await handler.handle(tx, projectId, events);
                if (handled?.deferUntil) {
                    const deferUntil = handled.deferUntil > now
                        ? handled.deferUntil
                        : new Date(now.getTime() + 1_000);
                    const ids = events.map((event) => event.id);
                    await tx.$executeRaw(client_1.Prisma.sql `
            UPDATE "project_event"
               SET "next_attempt_at" = ${deferUntil}
             WHERE "id" IN (${uuidList(ids)}) AND "consumed_at" IS NULL
          `);
                    await tx.$executeRawUnsafe('RELEASE SAVEPOINT project_event_delivery');
                    return {
                        status: 'DEFERRED', projectId, eventIds: ids, nextAttemptAt: deferUntil,
                    };
                }
                const ids = events.map((event) => event.id);
                const disposition = handled?.disposition ?? 'RECONCILED';
                const holdIds = new Set(handled?.hold?.eventIds ?? []);
                const consumedIds = [...new Set([
                        ...ids.filter((id) => !holdIds.has(id)),
                        ...(handled?.answered ?? []),
                    ])];
                if (consumedIds.length > 0) {
                    await tx.$executeRaw(client_1.Prisma.sql `
            UPDATE "project_event"
               SET "consumed_at" = ${now}, "next_attempt_at" = NULL,
                   "disposition" = ${disposition}
             WHERE "id" IN (${uuidList(consumedIds)}) AND "consumed_at" IS NULL
          `);
                }
                // TR2-b ②③, in one statement: still unconsumed, `attempts` untouched, and pointed at the
                // instant the handler says it may be answered.
                if (holdIds.size > 0 && handled?.hold) {
                    // Never in the past, for the reason `deferUntil` above is not either: this pump drains
                    // in a loop, and a retry instant that has already arrived is a spin rather than a
                    // schedule. A held signal is re-decided by the wake the same pass wrote.
                    const retryAt = handled.hold.nextAttemptAt > now
                        ? handled.hold.nextAttemptAt
                        : new Date(now.getTime() + 1_000);
                    await tx.$executeRaw(client_1.Prisma.sql `
            UPDATE "project_event"
               SET "next_attempt_at" = ${retryAt}
             WHERE "id" IN (${uuidList([...holdIds])}) AND "consumed_at" IS NULL
          `);
                }
                await tx.$executeRawUnsafe('RELEASE SAVEPOINT project_event_delivery');
                return {
                    status: disposition === 'RECONCILED' ? 'CONSUMED' : 'DISCARDED',
                    projectId,
                    // What this delivery actually settled. A held signal is still pending, and reporting it
                    // as consumed here is exactly the lie TR2-c exists to stop.
                    eventIds: consumedIds,
                };
            }
            catch (cause) {
                await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT project_event_delivery');
                const error = errorText(cause);
                const dead = events.filter((event) => event.attempts + 1 >= MAX_ATTEMPTS);
                const retry = events.filter((event) => event.attempts + 1 < MAX_ATTEMPTS);
                if (dead.length > 0) {
                    // If fail-closed persistence fails, this transaction fails too: no event can become DEAD
                    // without the durable UNKNOWN_FAILURE record required of the registered handler.
                    await handler.deadLetter(tx, projectId, dead, error);
                    await tx.$executeRaw(client_1.Prisma.sql `
            UPDATE "project_event"
               SET "attempts" = "attempts" + 1,
                   "next_attempt_at" = NULL,
                   "consumed_at" = ${now},
                   "disposition" = 'DEAD'
             WHERE "id" IN (${uuidList(dead.map((event) => event.id))})
               AND "consumed_at" IS NULL
          `);
                }
                for (const event of retry) {
                    const attempt = event.attempts + 1;
                    const nextAttemptAt = new Date(now.getTime() + projectEventRetryDelayMs(attempt));
                    await tx.$executeRaw(client_1.Prisma.sql `
            UPDATE "project_event"
               SET "attempts" = "attempts" + 1,
                   "next_attempt_at" = ${nextAttemptAt}
             WHERE "id" = ${event.id}::uuid AND "consumed_at" IS NULL
          `);
                }
                this.log.warn(`Project event delivery failed for ${projectId}; retry=${retry.length} dead=${dead.length}: ${error}`);
                return dead.length > 0
                    ? { status: 'DEAD', projectId, eventIds: dead.map((event) => event.id) }
                    : { status: 'RETRY_SCHEDULED', projectId, eventIds: retry.map((event) => event.id) };
            }
        }, (0, transaction_retry_1.loggedRetry)(this.log, 'projectEvents.deliverOnce', { transaction: { isolationLevel: client_1.Prisma.TransactionIsolationLevel.RepeatableRead } }));
    }
    requestDrain() {
        if (!this.started || this.stopped || !this.handler)
            return;
        this.drainRequested = true;
        if (!this.draining)
            void this.drain();
    }
    /** Durable poll entrypoint used by the orchestration service's sole recovery timer. */
    async drainAvailable(limit = MAX_PROJECTS_PER_DRAIN) {
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new RangeError('limit must be positive');
        if (this.draining) {
            this.drainRequested = true;
            return 0;
        }
        this.draining = true;
        let total = 0;
        try {
            do {
                this.drainRequested = false;
                let processed = 0;
                while (!this.stopped && this.handler && total < limit) {
                    const result = await this.drainOnce();
                    if (result.status === 'IDLE' || result.status === 'NO_HANDLER')
                        break;
                    processed += 1;
                    total += 1;
                }
                if (processed > 0 && total === limit)
                    this.drainRequested = true;
            } while (this.drainRequested && total < limit && !this.stopped && this.handler);
        }
        catch (cause) {
            // A transaction-level failure (lost connection, serialization failure) changed no event.
            // The durable poll will retry; do not turn infrastructure availability into a DEAD event.
            this.log.error(`Project event drain failed: ${errorText(cause)}`);
        }
        finally {
            this.draining = false;
            if (this.drainRequested)
                this.requestDrain();
        }
        return total;
    }
    async drain() {
        await this.drainAvailable();
    }
    async startListener() {
        if (this.stopped || this.connecting || this.listener)
            return;
        this.connecting = true;
        const url = (process.env.DATABASE_URL ?? '').split('?')[0];
        const client = new pg_1.Client({ connectionString: url });
        client.on('error', (error) => {
            this.log.error(`Project event listener error: ${error.message}`);
            this.reconnectListener();
        });
        client.on('notification', (message) => {
            if (message.channel === EVENT_CHANNEL)
                this.requestDrain();
        });
        try {
            await client.connect();
            await client.query(`LISTEN ${EVENT_CHANNEL}`);
            this.listener = client;
        }
        catch (cause) {
            this.log.error(`Project event LISTEN failed: ${errorText(cause)}`);
            client.removeAllListeners('error');
            await client.end().catch(() => undefined);
            this.scheduleListenerReconnect();
        }
        finally {
            this.connecting = false;
        }
    }
    reconnectListener() {
        if (this.stopped)
            return;
        const old = this.listener;
        this.listener = undefined;
        if (old) {
            old.removeAllListeners('error');
            old.end().catch(() => undefined);
        }
        this.scheduleListenerReconnect();
    }
    scheduleListenerReconnect() {
        if (this.stopped || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.startListener();
        }, LISTENER_RECONNECT_MS);
        this.reconnectTimer.unref();
    }
};
exports.ProjectEventsService = ProjectEventsService;
exports.ProjectEventsService = ProjectEventsService = ProjectEventsService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProjectEventsService);
function envelope(row) {
    return {
        v: row.v,
        id: row.id,
        projectId: row.projectId,
        kind: row.kind,
        occurredAt: row.occurredAt,
        source: { type: row.sourceType, id: row.sourceId },
        dedupeKey: row.dedupeKey,
        payload: row.payload,
        occurrences: row.occurrences,
        lastAt: row.lastAt,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
    };
}
function errorText(cause) {
    const text = cause instanceof Error ? cause.message : String(cause);
    return text.slice(0, 2_000);
}
//# sourceMappingURL=project-events.service.js.map