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
var RealtimeService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeService = void 0;
const common_1 = require("@nestjs/common");
const events_1 = require("events");
const crypto_1 = require("crypto");
const pg_1 = require("pg");
const shared_1 = require("@orbit/shared");
const rxjs_1 = require("rxjs");
const prisma_service_1 = require("../prisma/prisma.service");
const push_service_1 = require("../push/push.service");
const session_state_1 = require("../sessions/session-state");
const session_scheduling_1 = require("../common/session-scheduling");
const session_generating_1 = require("../common/session-generating");
const session_inbox_fence_1 = require("../common/session-inbox-fence");
const control_events_1 = require("./control-events");
const EVENT_CHANNEL = 'orbit_event';
const INBOX_CHANNEL = 'orbit_inbox';
const MAX_NOTIFY_BYTES = 7000; // Postgres NOTIFY payload limit is 8000 bytes; stay under.
const CANCEL_MAX_AGE_MS = 60 * 60_000; // stop redelivering a cancel after an hour
/** Reconstruct lifecycle fields for the legacy session.ended wire event. */
function endedSessionStates(status, endReason, explicitLifecycleState) {
    const lifecycleState = explicitLifecycleState ??
        (endReason === shared_1.SessionEndReason.COMPLETED
            ? shared_1.SessionLifecycleState.COMPLETED
            : endReason === shared_1.SessionEndReason.DELETED
                ? shared_1.SessionLifecycleState.TRASH
                : shared_1.SessionLifecycleState.OPEN);
    const input = {
        status,
        endReason,
        completedAt: lifecycleState === shared_1.SessionLifecycleState.COMPLETED ? 'completed' : null,
        deletedAt: lifecycleState === shared_1.SessionLifecycleState.TRASH ? 'deleted' : null,
    };
    return {
        sessionState: (0, shared_1.deriveSessionState)(input),
        runState: (0, shared_1.deriveSessionRunState)(input),
        lifecycleState,
        filingState: (0, shared_1.deriveSessionFilingState)(input),
    };
}
/**
 * Realtime fan-out. Within a process it uses an in-memory RxJS hub (events) and an
 * EventEmitter (inbox wakeups) — zero latency. Across replicas it bridges those over
 * Postgres LISTEN/NOTIFY: every publish/notifyInbox also NOTIFYs (tagged with this
 * instance id), and a dedicated listener connection re-emits notifications from OTHER
 * instances into the local hub/inbox. The own-instance tag means single-replica
 * behaviour is unchanged (a process ignores its own notifications; clients also dedup
 * by seq as a backstop).
 *
 * Cancellation is durable on TaskRun.cancelRequestedAt and drained from the DB on
 * heartbeat, so it also works across replicas and survives a restart.
 */
let RealtimeService = class RealtimeService {
    static { RealtimeService_1 = this; }
    prisma;
    push;
    log = new common_1.Logger('Realtime');
    instanceId = (0, crypto_1.randomUUID)();
    hub = new rxjs_1.Subject();
    inbox = new events_1.EventEmitter(); // event name = runId
    listener;
    connecting = false;
    reconnectTimer;
    stopped = false;
    /** sessionId → {ownerId, workspaceId}, for scoping the user-stream (GET /api/events) without a
     *  DB hit per event. Bounded LRU; the control subset is low-volume so it's near-100% hits. */
    ownerCache = new Map();
    static OWNER_CACHE_MAX = 10_000;
    /** Hub key prefix for user-scoped events (see publishForUser). Session ids are UUIDs, so this
     *  namespace can never collide with one. */
    static USER_SCOPE = 'user:';
    /** The "every user" owner id inside that namespace (see publishForAllUsers). */
    static USER_SCOPE_ALL = '*';
    // Events that can lower an owner's "needs you" badge (an increment is already covered by the
    // approval-create alert push). On any of these, nudge PushService to reconcile and silently sync
    // the badge to the owner's other devices, incl. backgrounded iOS. See docs/cross-platform-badge-sync.md.
    static BADGE_EVENTS = new Set([
        shared_1.RunEventType.APPROVAL_RESOLVED,
        shared_1.RunEventType.STATUS,
        shared_1.RunEventType.SESSION_ENDED,
    ]);
    constructor(prisma, push) {
        this.prisma = prisma;
        this.push = push;
        this.inbox.setMaxListeners(0);
    }
    async onModuleInit() {
        await this.startListener();
    }
    onModuleDestroy() {
        this.stopped = true;
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.listener?.removeAllListeners('error');
        this.listener?.end().catch(() => undefined);
    }
    // ── cross-replica listener ──────────────────────────────────────────────
    async startListener() {
        if (this.stopped || this.connecting || this.listener)
            return; // never run two listeners
        this.connecting = true;
        // pg can't parse Prisma's `?schema=` query param; strip it (LISTEN/NOTIFY
        // channels are database-global, not schema-scoped).
        const url = (process.env.DATABASE_URL ?? '').split('?')[0];
        const client = new pg_1.Client({ connectionString: url });
        client.on('error', (e) => {
            this.log.error('listener connection error: ' + e.message);
            this.reconnect();
        });
        client.on('notification', (msg) => this.onNotify(msg.channel, msg.payload));
        try {
            await client.connect();
            await client.query(`LISTEN ${EVENT_CHANNEL}`);
            await client.query(`LISTEN ${INBOX_CHANNEL}`);
            this.listener = client;
            this.log.log(`LISTEN/NOTIFY active (instance ${this.instanceId.slice(0, 8)})`);
        }
        catch (e) {
            this.log.error('listener connect failed: ' + e.message);
            client.removeAllListeners('error');
            await client.end().catch(() => undefined);
            this.scheduleReconnect();
        }
        finally {
            this.connecting = false;
        }
    }
    reconnect() {
        if (this.stopped)
            return;
        const old = this.listener;
        this.listener = undefined;
        if (old) {
            old.removeAllListeners('error'); // don't let the dead client re-trigger us
            old.end().catch(() => undefined);
        }
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.stopped || this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.startListener();
        }, 2000);
    }
    onNotify(channel, payload) {
        if (!payload)
            return;
        let m;
        try {
            m = JSON.parse(payload);
        }
        catch {
            return;
        }
        if (m.i === this.instanceId)
            return; // our own write — already emitted locally
        if (channel === INBOX_CHANNEL) {
            this.inbox.emit(m.r);
            return;
        }
        if (channel === EVENT_CHANNEL) {
            if (m.e) {
                this.hub.next({ runId: m.r, event: m.e });
            }
            else if (typeof m.s === 'number') {
                // Oversized event was sent as a signal — fetch it from the durable log.
                this.prisma.runEvent
                    .findUnique({ where: { sessionId_seq: { sessionId: m.r, seq: m.s } } })
                    .then((row) => {
                    if (row) {
                        this.hub.next({
                            runId: m.r,
                            event: {
                                seq: row.seq,
                                type: row.type,
                                payload: row.payload,
                                turnId: row.turnId ?? undefined,
                                ts: row.createdAt.toISOString(),
                            },
                        });
                    }
                })
                    .catch(() => undefined);
            }
        }
    }
    notifyRaw(channel, payload) {
        // executeRaw (not queryRaw): pg_notify returns void, which Prisma's queryRaw
        // can't deserialize ("Failed to deserialize column of type 'void'"). executeRaw
        // runs the statement — firing the NOTIFY — and returns an affected-row count
        // instead of reading result columns.
        this.prisma
            .$executeRawUnsafe('SELECT pg_notify($1, $2)', channel, payload)
            .catch((e) => this.log.warn('pg_notify failed: ' + e.message));
    }
    // ── inbox (interactive turn delivery) ───────────────────────────────────
    /** Wake a runner parked in GET /runner/runs/:id/inbox after a turn is enqueued. */
    notifyInbox(runId) {
        this.inbox.emit(runId); // same replica
        this.notifyRaw(INBOX_CHANNEL, JSON.stringify({ i: this.instanceId, r: runId })); // others
    }
    /** Park until a turn is enqueued for this run, or the timeout elapses. */
    waitForInbox(runId, timeoutMs) {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                this.inbox.off(runId, done);
                resolve();
            };
            const timer = setTimeout(done, timeoutMs);
            this.inbox.once(runId, done);
        });
    }
    // ── run events (SSE) ────────────────────────────────────────────────────
    publish(runId, event) {
        this.hub.next({ runId, event }); // same replica
        const payload = JSON.stringify({ i: this.instanceId, r: runId, e: event });
        // NOTE: NOTIFY's limit is 8000 BYTES — measure UTF-8 bytes, not string length
        // (a multibyte CJK/emoji event can be < 7000 chars but > 8000 bytes).
        if (Buffer.byteLength(payload, 'utf8') <= MAX_NOTIFY_BYTES) {
            this.notifyRaw(EVENT_CHANNEL, payload);
        }
        else {
            // Too big for a NOTIFY payload — signal by seq; other replicas fetch the
            // (already-persisted) RunEvent row.
            this.notifyRaw(EVENT_CHANNEL, JSON.stringify({ i: this.instanceId, r: runId, s: event.seq }));
        }
        // Locally-originated only — NOTIFY-bridged events from other replicas arrive via onNotify →
        // hub, not here — so the owner's badge is reconciled and synced exactly once, on the origin.
        if (RealtimeService_1.BADGE_EVENTS.has(event.type)) {
            void this.resolveOwner(runId)
                .then((meta) => meta && this.push.scheduleBadgeSync(meta.ownerId))
                .catch(() => undefined);
        }
        // `final` marks the STATUS that a finalization actually applied — /turn-complete's failure,
        // the runner's /finalize, and the reaper's forceFinalize each publish exactly one, and only
        // when their own conditional write won. That makes it the one signal per settlement, so the
        // owner's phone is told once. PushService decides whether this particular ending is worth an
        // interruption; a session id is all it needs. Locally-originated only, like the badge sync.
        //
        // `retryAt` on that same payload takes it back: the turn is over (which is what `final`
        // tells the clients) but the server has already armed a re-send of the same message, so
        // nothing has settled yet and announcing it would report a failure the user never had.
        // The announcement moves to whoever ends the wait — AutoRetryService.disarm when the
        // retries are spent, or the next finalization if the retry runs and fails on its own.
        const status = event.payload;
        if (event.type === shared_1.RunEventType.STATUS && status.final && !status.retryAt) {
            void this.push.notifySessionSettled(runId);
        }
    }
    streamForRun(runId) {
        return this.hub.asObservable().pipe(
        // Lifecycle signals (session_created/ended) are control-plane-internal: they ride the hub
        // for the NOTIFY bridge but must never leak into a per-session transcript stream.
        (0, rxjs_1.filter)((m) => m.runId === runId && !(0, shared_1.isLifecycleType)(m.event.type)), (0, rxjs_1.map)((m) => m.event));
    }
    // ── synthesized lifecycle signals (control plane only) ──────────────────
    //
    // session.created / session.ended have no natural RunEvent — complete/restore/create don't emit
    // STATUS — so the state-changing call sites publish these synthetic signals through the same
    // hub (seq 0, never persisted; ingest owns durable seq assignment). streamForRun filters them
    // out above; streamForUser maps them to ControlEventType.SESSION_CREATED / SESSION_ENDED.
    /** A session entered the owner's Open list (created, restored, or resumed from Completed). */
    publishSessionCreated(sessionId) {
        this.publish(sessionId, {
            seq: 0,
            type: shared_1.RunEventType.SESSION_CREATED,
            ts: new Date().toISOString(),
            payload: {},
        });
    }
    /** A session left Open (moved to Completed or Trash). Terminal
     *  RUN statuses are NOT signalled here — they already flow as STATUS → session.updated.
     *  Ordinary graceful recycling stays in Open and does not use this signal; the task_done
     *  path is the exception because a successful task execution is filed in Completed. */
    publishSessionLifecycleChanged(sessionId, status, endReason, lifecycleState) {
        const states = endedSessionStates(status, endReason, lifecycleState);
        this.publish(sessionId, {
            seq: 0,
            type: shared_1.RunEventType.SESSION_ENDED,
            ts: new Date().toISOString(),
            payload: {
                status,
                runStatus: status,
                sessionState: states.sessionState,
                runState: states.runState,
                lifecycleState: states.lifecycleState,
                filingState: states.filingState,
                endReason,
            },
        });
    }
    /** A task (work item) the owner can see changed — created or updated, almost always via MCP.
     *  Published on the task's creator session so it rides the same hub + NOTIFY bridge and resolves
     *  to that owner; streamForUser maps it to ControlEventType.TASK_CHANGED. Best-effort like the
     *  session signals: a task with no owned creator session simply doesn't push (the client's
     *  interval poll still catches it). */
    publishTaskChanged(sessionId, taskId) {
        this.publish(sessionId, {
            seq: 0,
            type: shared_1.RunEventType.TASK_CHANGED,
            ts: new Date().toISOString(),
            payload: { taskId },
        });
    }
    /** A workspace the owner can see was created or updated via MCP. Published on the calling
     *  (orchestrator) session — the only session context that path has — so it rides the same hub
     *  and resolves to that owner; streamForUser maps it to ControlEventType.AGENT_CHANGED. */
    publishWorkspaceChanged(sessionId, workspaceId) {
        this.publish(sessionId, {
            seq: 0,
            type: shared_1.RunEventType.AGENT_CHANGED,
            ts: new Date().toISOString(),
            payload: { workspaceId },
        });
    }
    /** A session's list-visible fields changed with no turn behind it — a rename, a tag edit. Rides
     *  the session.updated path, so the client refreshes the same list row it already upserts on a
     *  status change (no new client-side handling needed). */
    publishSessionUpdated(sessionId) {
        this.publish(sessionId, {
            seq: 0,
            type: shared_1.RunEventType.SESSION_UPDATED,
            ts: new Date().toISOString(),
            payload: {},
        });
    }
    /** A still-PENDING user turn was added or withdrawn. Queued turns have no durable transcript
     * event until the runner leases them, so focused clients need this live-only nudge to re-fetch
     * GET /sessions/:id/turns and keep a queue created on another device visible. */
    publishQueuedTurnsChanged(sessionId) {
        this.publish(sessionId, {
            seq: 0,
            type: shared_1.RunEventType.QUEUED_TURNS_CHANGED,
            ts: new Date().toISOString(),
            payload: {},
        });
    }
    /**
     * Publish an event that belongs to a USER rather than to one session — the owner's task lists,
     * session tags, and configured providers, none of which have a session to hang off.
     *
     * The hub is keyed by session id, so these ride a reserved `user:<ownerId>` key: it can never
     * collide with a real session id (a UUID), `streamForRun` therefore never matches it, and
     * `toControlEvent` recognizes the prefix and routes by owner without a DB lookup. Same NOTIFY
     * bridge, same coalescing on the client — only the scoping differs.
     */
    publishForUser(ownerId, type, id) {
        this.publish(`${RealtimeService_1.USER_SCOPE}${ownerId}`, {
            seq: 0,
            type,
            ts: new Date().toISOString(),
            payload: { id },
        });
    }
    /** Same, but for a deployment-wide change every user sees — today only the shared (admin-owned)
     *  model providers. Reaches every connected stream; keep it to genuinely global, low-rate edits. */
    publishForAllUsers(type, id) {
        this.publish(`${RealtimeService_1.USER_SCOPE}${RealtimeService_1.USER_SCOPE_ALL}`, {
            seq: 0,
            type,
            ts: new Date().toISOString(),
            payload: { id },
        });
    }
    // ── user-scoped control plane (SSE: GET /api/events) ────────────────────
    //
    // One per-user stream multiplexes lifecycle/status/approval/background events across ALL of
    // the user's sessions, so a client opens it once to drive its list, badges, and
    // notifications — replacing per-list polling. Derived from the same hub as streamForRun, but
    // filtered to the coarse control subset and scoped to the user's sessions. Transcript bodies
    // never enter (the sync controlTypeFor() filter drops them before owner resolution).
    // See docs/realtime-control-plane-stream.md.
    streamForUser(userId) {
        return this.hub.asObservable().pipe((0, rxjs_1.filter)((m) => (0, control_events_1.controlTypeFor)(m.event.type) !== null), (0, rxjs_1.mergeMap)((m) => this.toControlEvent(userId, m.runId, m.event)), (0, rxjs_1.filter)((e) => e !== null));
    }
    /** Map a hub run event to a control event for `userId`, or null if it isn't this user's
     *  session or carries nothing the control plane forwards. */
    async toControlEvent(userId, sessionId, ev) {
        const type = (0, control_events_1.controlTypeFor)(ev.type);
        if (!type)
            return null;
        // User-scoped library events (publishForUser) are keyed `user:<ownerId>`, not by a session:
        // route them by that id and ship an empty sessionId — no owner lookup, nothing to summarize.
        // Most user-keyed events are libraries (tags/lists/providers), but task dependency edits
        // also have no reliable creator-session anchor: a workspace may edit a task the web created.
        // Task/workspace change nudges are therefore allowed too; session-derived event families remain
        // on the normal owner-resolution path below.
        const userKeyed = sessionId.startsWith(RealtimeService_1.USER_SCOPE);
        if (userKeyed) {
            // Only event families with a self-contained id payload may use the owner key. Session
            // lifecycle/approval events require DB-derived session context and must never bypass it.
            if (!(0, control_events_1.isUserScopedType)(type) &&
                type !== shared_1.ControlEventType.TASK_CHANGED &&
                type !== shared_1.ControlEventType.AGENT_CHANGED) {
                return null;
            }
            const owner = sessionId.slice(RealtimeService_1.USER_SCOPE.length);
            if (owner !== userId && owner !== RealtimeService_1.USER_SCOPE_ALL)
                return null;
            const id = String(ev.payload.id ?? '');
            const data = type === shared_1.ControlEventType.TASK_CHANGED
                ? { taskId: id }
                : type === shared_1.ControlEventType.AGENT_CHANGED
                    ? { agentId: id }
                    : { id };
            return {
                type,
                sessionId: '',
                agentId: null,
                ts: ev.ts ?? new Date().toISOString(),
                data,
            };
        }
        // Library events are meaningful only on the reserved owner/global key.
        if ((0, control_events_1.isUserScopedType)(type))
            return null;
        const meta = await this.resolveOwner(sessionId);
        if (!meta || meta.ownerId !== userId)
            return null;
        let data;
        switch (type) {
            case shared_1.ControlEventType.SESSION_CREATED:
            case shared_1.ControlEventType.SESSION_UPDATED: {
                const summary = await this.buildSessionSummary(sessionId);
                if (!summary)
                    return null; // session vanished mid-flight
                data = summary;
                break;
            }
            case shared_1.ControlEventType.SESSION_ENDED:
                // Decision Q4: the session left Open — no more events will follow, so drop
                // its owner mapping now instead of waiting for LRU pressure.
                this.ownerCache.delete(sessionId);
                {
                    const runStatus = String(ev.payload.runStatus ?? ev.payload.status);
                    const endReason = ev.payload.endReason == null
                        ? null
                        : String(ev.payload.endReason);
                    const payloadLifecycleState = ev.payload.lifecycleState ??
                        (ev.payload.filingState === shared_1.SessionFilingState.ARCHIVED
                            ? shared_1.SessionLifecycleState.COMPLETED
                            : ev.payload.filingState === shared_1.SessionFilingState.TRASH
                                ? shared_1.SessionLifecycleState.TRASH
                                : ev.payload.filingState === shared_1.SessionFilingState.OPEN
                                    ? shared_1.SessionLifecycleState.OPEN
                                    : undefined);
                    const derived = endedSessionStates(runStatus, endReason, payloadLifecycleState);
                    const sessionState = ev.payload.sessionState ?? derived.sessionState;
                    const runState = ev.payload.runState ?? derived.runState;
                    const lifecycleState = ev.payload.lifecycleState ??
                        derived.lifecycleState;
                    const filingState = ev.payload.filingState ?? derived.filingState;
                    data = {
                        status: runStatus,
                        runStatus,
                        sessionState,
                        runState,
                        lifecycleState,
                        filingState,
                        endReason,
                    };
                }
                break;
            case shared_1.ControlEventType.SESSION_ERROR:
                data = (0, control_events_1.errorPayloadOf)(ev.payload);
                break;
            case shared_1.ControlEventType.BACKGROUND_TASK:
                data = (0, control_events_1.backgroundPayloadOf)(ev.payload);
                break;
            case shared_1.ControlEventType.TASK_CHANGED:
                // A pure nudge to refetch the owner's task list — no DB augmentation needed; the id
                // travels straight through from publishTaskChanged.
                data = { taskId: String(ev.payload.taskId ?? '') };
                break;
            case shared_1.ControlEventType.AGENT_CHANGED:
                // Same: a nudge to refetch the owner's workspace list. The id here is the CHANGED workspace —
                // the envelope's `agentId` stays the calling session's workspace.
                data = { agentId: String(ev.payload.workspaceId ?? '') };
                break;
            case shared_1.ControlEventType.APPROVAL_REQUESTED:
            case shared_1.ControlEventType.APPROVAL_RESOLVED:
                data = {
                    approvalId: (0, control_events_1.approvalIdOf)(ev.payload),
                    pendingApprovals: await this.countPendingApprovals(sessionId),
                };
                break;
            default:
                return null;
        }
        return { type, sessionId, agentId: meta.workspaceId, ts: ev.ts ?? new Date().toISOString(), data };
    }
    /** Resolve (and cache) a session's owner + workspace. Bounded LRU; a miss is one indexed lookup. */
    async resolveOwner(sessionId) {
        const hit = this.ownerCache.get(sessionId);
        if (hit) {
            this.ownerCache.delete(sessionId); // re-insert to mark most-recently-used
            this.ownerCache.set(sessionId, hit);
            return hit;
        }
        const row = await this.prisma.session.findUnique({
            where: { id: sessionId },
            select: { ownerId: true, workspaceId: true },
        });
        if (!row)
            return null;
        const meta = { ownerId: row.ownerId, workspaceId: row.workspaceId ?? null };
        this.ownerCache.set(sessionId, meta);
        if (this.ownerCache.size > RealtimeService_1.OWNER_CACHE_MAX) {
            const oldest = this.ownerCache.keys().next().value; // Map iterates in insertion order
            if (oldest !== undefined)
                this.ownerCache.delete(oldest);
        }
        return meta;
    }
    /** The slim session summary the client upserts into its list (decision Q2: full, not a delta).
     *  Shape mirrors `ControlSessionSummary` / the `GET /sessions` list row. */
    async buildSessionSummary(sessionId) {
        const s = await this.prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                title: true,
                status: true,
                engineTurnActive: true,
                endReason: true,
                completedAt: true,
                archivedAt: true,
                deletedAt: true,
                cancelRequestedAt: true,
                startedAt: true,
                numTurns: true,
                retryAt: true,
                runtimeSessionId: true,
                assignedRunnerId: true,
                assignedRunner: {
                    select: { id: true, status: true, lastHeartbeatAt: true },
                },
                workspaceId: true,
                lastTurnAt: true,
                workspace: { select: { id: true, name: true, model: true, effort: true } },
            },
        });
        if (!s)
            return null;
        const sessionState = (0, shared_1.deriveSessionState)(s);
        const runState = (0, shared_1.deriveSessionRunState)(s);
        const lifecycleState = (0, shared_1.deriveSessionLifecycleState)(s);
        const filingState = (0, shared_1.deriveSessionFilingState)(s);
        const capabilities = (0, session_state_1.deriveSessionCapabilities)(s);
        // A blocked permission keeps a session generating, so only a generating session can hold a
        // live approval — skip the count otherwise (mirrors the list endpoint). A self-driven turn
        // counts: it stays at AWAITING_INPUT while it runs, and its prompt still blocks it.
        const pendingApprovals = (0, session_generating_1.isSessionGenerating)(s) ? await this.countPendingApprovals(sessionId) : 0;
        return {
            id: s.id,
            title: s.title ?? null,
            status: s.status,
            runStatus: s.status,
            sessionState,
            runState,
            lifecycleState,
            filingState,
            capabilities,
            agentId: s.workspaceId ?? null,
            agent: s.workspace
                ? {
                    id: s.workspace.id,
                    name: s.workspace.name ?? null,
                    model: s.workspace.model ?? null,
                    effort: s.workspace.effort ?? null,
                }
                : null,
            pendingApprovals,
            lastTurnAt: s.lastTurnAt ? s.lastTurnAt.toISOString() : null,
            // Read fresh with the status it qualifies: the same summary has to be able to say both
            // "failed, retrying at 12:04" and, once the retries are spent, "failed, nothing coming".
            retryAt: s.retryAt ? s.retryAt.toISOString() : null,
        };
    }
    countPendingApprovals(sessionId) {
        return this.prisma.approval.count({ where: { sessionId, status: 'PENDING' } });
    }
    // ── cancellation (durable, cross-replica) ───────────────────────────────
    /**
     * No-op: cancellation intent is persisted on TaskRun.cancelRequestedAt by the
     * caller and drained from the DB on heartbeat, so it works across replicas and
     * survives a restart. Kept for call-site compatibility.
     */
    requestCancel(_runnerId, _runId) {
        // intentionally empty
    }
    /**
     * Runs this runner should interrupt: cancel requested (within the last hour, so a
     * never-honored cancel doesn't redeliver forever), and not yet finalized — or
     * finalized very recently, to catch a runner recovering from a partition. This is
     * an at-least-once signal; the runner ignores ids it no longer has running.
     */
    async drainCancellations(runnerId) {
        const now = Date.now();
        const recentlyRequested = new Date(now - CANCEL_MAX_AGE_MS);
        const recentlyFinished = new Date(now - 5 * 60_000);
        const sessions = await this.prisma.session.findMany({
            where: {
                assignedRunnerId: runnerId,
                cancelRequestedAt: { gt: recentlyRequested },
                OR: [{ finishedAt: null }, { finishedAt: { gt: recentlyFinished } }],
            },
            select: { id: true },
        });
        return sessions.map((s) => s.id);
    }
    /**
     * Fail claimed merge/commit requests whose owning process is provably gone. The operation
     * owner is a process epoch and this heartbeat's leaseOwner is the runner's only live
     * process, so a pending operation claimed by a different epoch has no process left to
     * execute it or report a result — redelivery excludes foreign owners by design (a
     * half-executed git operation must never rerun under a new process). Left alone, such a
     * row fences takeover/messages/resume forever, which livelocks the runner's reclaim loop
     * ("Waiting for a free slot" for every queued session) and pins the UI on Merging….
     * The staleness margin covers a restart overlap in which the old process could still be
     * finishing: inside it the row keeps fencing, past it the operation fails visibly so the
     * user can request it again.
     */
    async failAbandonedWorktreeOperations(runnerId, leaseOwner) {
        const staleBefore = new Date(Date.now() - session_inbox_fence_1.WORKTREE_OPERATION_STALE_MS);
        const abandoned = 'the runner process that claimed this operation stopped before reporting a result — request it again';
        await this.prisma.session.updateMany({
            where: {
                assignedRunnerId: runnerId,
                mergeStatus: 'pending',
                mergeOperationOwner: { not: null },
                NOT: { mergeOperationOwner: leaseOwner },
                mergeRequestedAt: { lt: staleBefore },
            },
            data: { mergeStatus: 'error', mergeError: abandoned },
        });
        await this.prisma.session.updateMany({
            where: {
                assignedRunnerId: runnerId,
                commitStatus: 'pending',
                commitOperationOwner: { not: null },
                NOT: { commitOperationOwner: leaseOwner },
                commitRequestedAt: { lt: staleBefore },
            },
            data: { commitStatus: 'error', commitError: abandoned },
        });
    }
    /**
     * Branch merges this runner should perform: sessions it ran (assignedRunnerId) that the
     * user asked to merge into main (mergeStatus='pending'). At-least-once — redelivered each
     * heartbeat until the runner reports an outcome that flips mergeStatus off 'pending'. The
     * workDir comes from the session's workspace; the runner resolves the repo root from it.
     */
    async drainMergeRequests(runnerId, leaseOwner) {
        const sessions = await this.prisma.session.findMany({
            where: {
                assignedRunnerId: runnerId,
                mergeStatus: 'pending',
                mergeOperationId: { not: null },
                branch: { not: null },
                AND: [
                    {
                        OR: [{ mergeOperationOwner: null }, { mergeOperationOwner: leaseOwner }],
                    },
                    {
                        // Open sessions remain tied to their current supervisor process.
                        // Terminal sessions have no supervisor and may be claimed directly
                        // by this runner's current heartbeat process.
                        OR: [
                            { status: { notIn: session_scheduling_1.OPEN_SESSION_STATUSES } },
                            { status: { in: session_scheduling_1.OPEN_SESSION_STATUSES }, inboxLeaseOwner: leaseOwner },
                        ],
                    },
                ],
            },
            select: {
                id: true,
                branch: true,
                baseSha: true,
                mergeTarget: true,
                mergeOperationId: true,
                mergeOperationOwner: true,
                status: true,
                workspace: { select: { workDir: true } },
            },
        });
        const claimed = await Promise.all(sessions
            .filter((s) => s.branch && s.workspace?.workDir && s.mergeOperationId)
            .map(async (s) => {
            const claim = await this.prisma.session.updateMany({
                where: {
                    id: s.id,
                    assignedRunnerId: runnerId,
                    mergeStatus: 'pending',
                    mergeOperationId: s.mergeOperationId,
                    OR: [{ mergeOperationOwner: null }, { mergeOperationOwner: leaseOwner }],
                    ...(session_scheduling_1.OPEN_SESSION_STATUSES.includes(s.status)
                        ? { status: { in: session_scheduling_1.OPEN_SESSION_STATUSES }, inboxLeaseOwner: leaseOwner }
                        : { status: { notIn: session_scheduling_1.OPEN_SESSION_STATUSES } }),
                },
                // Redelivery restamps requestedAt each heartbeat, so the staleness clock in
                // pendingWorktreeOperationMayBeExecuting measures time since the owning process
                // last showed up rather than time since the user clicked.
                data: { mergeOperationOwner: leaseOwner, mergeRequestedAt: new Date() },
            });
            if (claim.count === 0)
                return null;
            return {
                sessionId: s.id,
                operationId: s.mergeOperationId,
                leaseOwner,
                branch: s.branch,
                workDir: s.workspace.workDir,
                ...(s.mergeTarget ? { targetBranch: s.mergeTarget } : {}),
                // The fork point, so the merge replays only this session's commits. The runner's own
                // copy of it dies with the checkout (removeWorktree drops the base ref), and a merge
                // is usually requested after that, so send ours.
                ...(s.baseSha ? { baseSha: s.baseSha } : {}),
            };
        }));
        return claimed.filter((command) => command !== null);
    }
    /**
     * Worktree commits this runner should perform: live sessions it runs (assignedRunnerId)
     * that the user asked to commit (commitStatus='pending'). At-least-once — redelivered each
     * heartbeat until the runner reports an outcome that flips commitStatus off 'pending'. The
     * runner locates the per-session checkout from the session id; branch is for logging.
     */
    async drainCommitRequests(runnerId, leaseOwner) {
        const sessions = await this.prisma.session.findMany({
            where: {
                assignedRunnerId: runnerId,
                commitStatus: 'pending',
                commitOperationId: { not: null },
                branch: { not: null },
                OR: [
                    {
                        // Same idle predicate the commit request was queued under (see
                        // SessionsService.commitWorktree): the parent turn and sub-workspaces write the
                        // checkout, background shells (dev servers, watchers) don't gate it.
                        inboxLeaseOwner: leaseOwner,
                        status: shared_1.RunStatus.AWAITING_INPUT,
                        cancelRequestedAt: null,
                        runningSubagents: { isEmpty: true },
                        OR: [{ commitOperationOwner: null }, { commitOperationOwner: leaseOwner }],
                    },
                    {
                        // A finalized row may still need the same process to retry a
                        // cached receipt. Never claim an unowned terminal commit: its
                        // checkout may already have been finalized or removed.
                        status: { notIn: session_scheduling_1.OPEN_SESSION_STATUSES },
                        commitOperationOwner: leaseOwner,
                    },
                ],
            },
            select: { id: true, branch: true, commitOperationId: true, status: true },
        });
        const claimed = await Promise.all(sessions
            .filter((s) => s.branch && s.commitOperationId)
            .map(async (s) => {
            const claim = await this.prisma.session.updateMany({
                where: {
                    id: s.id,
                    assignedRunnerId: runnerId,
                    commitStatus: 'pending',
                    commitOperationId: s.commitOperationId,
                    ...(session_scheduling_1.OPEN_SESSION_STATUSES.includes(s.status)
                        ? {
                            inboxLeaseOwner: leaseOwner,
                            status: shared_1.RunStatus.AWAITING_INPUT,
                            cancelRequestedAt: null,
                            runningSubagents: { isEmpty: true },
                            OR: [
                                { commitOperationOwner: null },
                                { commitOperationOwner: leaseOwner },
                            ],
                        }
                        : {
                            status: { notIn: session_scheduling_1.OPEN_SESSION_STATUSES },
                            commitOperationOwner: leaseOwner,
                        }),
                },
                // Same restamp as the merge claim: keep the staleness clock a liveness signal.
                data: { commitOperationOwner: leaseOwner, commitRequestedAt: new Date() },
            });
            if (claim.count === 0)
                return null;
            return {
                sessionId: s.id,
                operationId: s.commitOperationId,
                leaseOwner,
                branch: s.branch,
            };
        }));
        return claimed.filter((command) => command !== null);
    }
    async drainArtifactRequests(runnerId) {
        const turns = await this.prisma.conversationTurn.findMany({
            where: {
                kind: 'artifact',
                status: 'PENDING',
                session: { assignedRunnerId: runnerId },
            },
            select: { id: true, sessionId: true, content: true },
            orderBy: { createdAt: 'asc' },
            take: 20,
        });
        return turns
            .filter((t) => t.content)
            .map((t) => ({ requestId: t.id, sessionId: t.sessionId, path: t.content }));
    }
};
exports.RealtimeService = RealtimeService;
exports.RealtimeService = RealtimeService = RealtimeService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, push_service_1.PushService])
], RealtimeService);
//# sourceMappingURL=realtime.service.js.map