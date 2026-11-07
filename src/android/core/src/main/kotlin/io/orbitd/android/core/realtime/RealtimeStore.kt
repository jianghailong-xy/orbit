package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionChanged
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.Wire
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.flow.updateAndGet
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** One per application. Auth owns credentials and disk namespaces; this store owns foreground
 * connections, bounded transcript/cache state, and authority refreshes. UI must match state.handle
 * by identity with its captured AuthState handle. Neither background execution nor a live-only
 * event is needed to recover pending cards on the next foreground connection. [background] is where the cache records are
 * encoded and decoded and directory lists are decoded; the application's store runs on the main thread and passes a background
 * dispatcher. [witness] is told what the streams and pages brought in, for a measurement. */
class RealtimeStore(
    private val auth: AuthSession,
    scope: CoroutineScope,
    private val background: CoroutineContext = EmptyCoroutineContext,
    private val witness: RealtimeWitness? = null,
) : AutoCloseable {
    private data class Network(val available: Boolean = false, val identity: String? = null)
    private data class Selection(val id: String?, val revision: Long, val handle: SessionHandle? = null)
    private class Resync : Exception()
    private val job = SupervisorJob(scope.coroutineContext[Job])
    private val owner = CoroutineScope(scope.coroutineContext + job)
    private val foreground = MutableStateFlow(false)
    private val network = MutableStateFlow(Network())
    private val selection = MutableStateFlow(Selection(null, 0))
    private val directoryRevision = MutableStateFlow(0L)
    /** Moved by every [refreshDirectory] and [rereadDirectory]: someone changed something. What a list the store does not read
     * (Completed, Trash) reads itself again behind. */
    val directoryAsks: StateFlow<Long> = directoryRevision.asStateFlow()
    /** The revision the last directory read that landed left at: what [rereadDirectory] waits on. */
    private val directoryLanded = MutableStateFlow(0L)
    private val sessionRevision = MutableStateFlow(0L)
    private val mutableState = MutableStateFlow(RealtimeState())
    val state: StateFlow<RealtimeState> = mutableState.asStateFlow()
    private val rest = RealtimeRest(auth, background)

    init {
        owner.launch {
            auth.state.map { (it as? AuthState.SignedIn)?.handle }.distinctUntilChanged().collectLatest { handle ->
                mutableState.value = RealtimeState(handle = handle)
                if (handle != null) account(handle) else selection.update {
                    // Preserve a pending-login deep link; retire only a spent account's choice.
                    if (it.handle != null && !current(it.handle)) Selection(null, 0) else it
                }
            }
        }
    }

    fun setForeground(value: Boolean) { foreground.value = value }
    fun setNetwork(available: Boolean, identity: String? = null) { network.value = Network(available, identity) }
    fun selectSession(id: String?) {
        val handle = (auth.state.value as? AuthState.SignedIn)?.handle
        selection.update {
            if (it.revision != 0L && it.id == id && it.handle === handle) it
            else Selection(id, it.revision + 1, handle)
        }
    }
    fun refreshDirectory() { directoryRevision.update { it + 1 } }
    /** Reads the directory again and returns once a read that left after this call has landed — one that saw a write the
     * caller already had answered. A read still on the wire from before is not it: the revision this bumps makes the loop
     * drop that answer and read again. Offline or in the background it waits for the next connection's read. */
    suspend fun rereadDirectory() {
        val asked = directoryRevision.updateAndGet { it + 1 }
        directoryLanded.first { it >= asked }
    }
    fun refreshSession() { sessionRevision.update { it + 1 } }
    /** Mutations check the live inputs too: collectors may not yet have withdrawn `fresh`. */
    fun canAct(handle: SessionHandle, sessionId: String): Boolean {
        val focus = selection.value
        val live = state.value
        return current(handle) && foreground.value && network.value.available &&
            focus.handle === handle && focus.id == sessionId && live.handle === handle &&
            live.session?.let { it.id == sessionId && it.fresh && !it.accessDenied && it.snapshot != null } == true
    }
    /** A reader's REST denial is authority too; invalidate pending snapshots and live content. */
    suspend fun reportReadDenial(handle: SessionHandle, id: String, error: ApiError) {
        require(error.status == 403 || error.status == 404)
        if (!current(handle)) return
        val focus = selection.value
        if (focus.handle === handle && focus.id == id) {
            updateSession(handle, focus) { it.copy(accessDenied = true, fresh = false, snapshot = null,
                transcript = Transcript(), error = RealtimeError.from(error), seededFromCache = false) }
            refreshSession()
        }
        // A route can disappear before its UI collector runs. The store persists this decision
        // independently, and a new process/route must read it before restoring any transcript.
        withContext(NonCancellable) { ReadingCache(auth, handle, id).revoke() }
    }
    override fun close() { owner.cancel() }

    private fun current(handle: SessionHandle) = (auth.state.value as? AuthState.SignedIn)?.handle === handle
    private fun publish(handle: SessionHandle, change: (RealtimeState) -> RealtimeState) {
        mutableState.update { if (current(handle) && it.handle === handle) change(it) else it }
    }

    private suspend fun account(handle: SessionHandle) = coroutineScope {
        // The rows first: the first frame wants them, and only this account's transcripts come after.
        val restored = try { SavedDirectory.read(auth, handle, background) } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            publish(handle) { it.copy(directoryError = RealtimeError.from(error)) }
            null
        }
        if (!current(handle)) throw SessionChanged()
        publish(handle) { it.copy(directory = restored, directoryCached = restored != null, directoryRestored = true) }
        val loaded = try { RealtimeCache.read(auth, handle, background) } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            publish(handle) { it.copy(directoryError = RealtimeError.from(error)) }
            RealtimeCache()
        }
        if (!current(handle)) throw SessionChanged()
        val cache = MutableStateFlow(loaded)
        val writes = Channel<Unit>(Channel.CONFLATED)
        // Explicit navigation (including selecting the directory) wins over cold-start restoration.
        selection.update {
            // StateFlow may conflate SignedOut during a fast login. Selection ownership, not
            // observing that intermediate value, decides whether this account may inherit it.
            if (it.revision != 0L && (it.handle == null || it.handle === handle)) it.copy(handle = handle)
            else Selection(loaded.lastSessionId, 1, handle)
        }
        launch {
            for (ignored in writes) {
                delay(100) // Coalesce a durable burst, never serialize every animation delta.
                try { RealtimeCache.write(auth, handle, cache.value, background) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { publish(handle) { it.copy(directoryError = RealtimeError.from(error)) } }
            }
        }
        launch {
            state.map { it.session?.takeIf { s -> s.accessDenied }?.id }.distinctUntilChanged().collect { id ->
                if (id != null) { cache.update { it.copy(sessions = it.sessions - id) }; writes.trySend(Unit) }
            }
        }
        launch {
            // Once, as the app leaves the foreground (iOS `persistLaunchSnapshot`), and only what a read of this run brought: a run
            // that never reached the server leaves the copy it started from. A failed write costs the next launch newer rows, no more.
            var kept = restored
            foreground.collect { visible ->
                val snapshot = state.value.directory
                if (visible || snapshot == null || state.value.directoryCached || !current(handle)) return@collect
                if (withContext(background) { snapshot == kept }) return@collect
                try { SavedDirectory.write(auth, handle, snapshot, background); kept = snapshot }
                catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { }
            }
        }
        launch {
            combine(foreground, network) { visible, path -> visible to path }.collectLatest { (visible, path) ->
                if (visible && path.available) control(handle, path)
                else publish(handle) { it.copy(controlConnection = ConnectionState.STOPPED,
                    directoryFresh = false, directoryRefreshing = false) }
            }
        }
        selection.collectLatest { focus ->
            if (focus.handle !== handle) return@collectLatest
            cache.update { it.copy(lastSessionId = focus.id) }
            writes.trySend(Unit)
            val denied = focus.id?.let { ReadingCache(auth, handle, it).permission().denied } == true
            publish(handle) { it.copy(session = focus.id?.let { id ->
                val saved = if (denied) Transcript() else cache.value.sessions[id]?.withoutLive() ?: Transcript()
                SessionState(id, saved, accessDenied = denied, seededFromCache = saved.seeded)
            }) }
            if (focus.id == null) return@collectLatest
            combine(foreground, network) { visible, path -> visible to path }.collectLatest { (visible, path) ->
                if (visible && path.available) session(handle, focus, path, cache, writes)
                else updateSession(handle, focus) { it.copy(connection = ConnectionState.STOPPED, fresh = false,
                    transcript = it.transcript.withoutLive()) }
            }
        }
    }

    private fun active(handle: SessionHandle, path: Network): Boolean =
        current(handle) && foreground.value && network.value == path

    private suspend fun control(handle: SessionHandle, path: Network) = coroutineScope {
        val refresh = Channel<Unit>(Channel.CONFLATED)
        // The lists the next read brings besides an ask's: every one for a connect, which replays nothing, and for an account event
        // only those it moved (R5). The loop below is the only reader, so no list is read twice at once.
        val wanted = MutableStateFlow<Set<DirectoryList>>(emptySet())
        fun want(lists: Set<DirectoryList>) { if (lists.isNotEmpty()) { wanted.update { it + lists }; refresh.trySend(Unit) } }
        // The account events of the window open now, by type: a burst is one read of what it moved, [EVENT_WINDOW_MS] after its first
        // event (R1), and one invalidation of what the pages read.
        val held = MutableStateFlow<Set<String>>(emptySet())
        val window = Channel<Unit>(Channel.CONFLATED)
        launch {
            for (ignored in window) {
                delay(EVENT_WINDOW_MS)
                window.tryReceive() // The burst's later events are this window's.
                val types = held.getAndUpdate { emptySet() }
                if (types.isEmpty()) continue
                want(types.flatMapTo(mutableSetOf(), ::directoryListsMovedBy))
                if (types.any { it in INVALIDATING_EVENTS }) invalidate(handle)
            }
        }
        launch { directoryRevision.collect { refresh.trySend(Unit) } }
        launch {
            val retry = ReconnectPolicy()
            var asked: Long? = null
            for (ignored in refresh) {
                val revision = directoryRevision.value
                val connects = state.value.controlConnects
                // An ask — Retry, or a write's re-read — reads every list; so does the first read of a connection.
                val lists = wanted.getAndUpdate { emptySet() } + if (revision != asked) DirectoryList.ALL else emptySet()
                if (lists.isEmpty()) continue
                // An account with work running is never quiet for as long as its lists take to read, so an event costs neither
                // the read on the wire nor the rows on screen: the read lands and this loop reads again behind it. Only an ask
                // outranks a read, which may have left before the write the ask follows.
                if (revision != asked || !state.value.directoryFresh) publish(handle) { it.copy(directoryRefreshing = true, directoryFresh = false) }
                asked = revision
                try {
                    // Rows the published directory already holds are kept, not read into a second tree beside it; a list this read
                    // does not bring is the published one.
                    val snapshot = rest.directory(handle, state.value.directory, lists)
                    currentCoroutineContext().ensureActive()
                    if (!active(handle, path)) return@launch
                    if (directoryRevision.value != revision) { refresh.trySend(Unit); continue }
                    // A read that left before the stream opened may lack what happened with no stream: its rows are the newest
                    // there are, and the connection's own read is still to come.
                    publish(handle) {
                        val current = it.controlConnects == connects
                        it.copy(directory = snapshot, directoryCached = false, directoryRefreshing = !current,
                            directoryFresh = current, directoryError = null)
                    }
                    directoryLanded.update { maxOf(it, revision) }
                    retry.healthy()
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    wanted.update { it + lists }
                    publish(handle) { it.copy(directoryRefreshing = false, directoryFresh = false,
                        directoryError = RealtimeError.from(error)) }
                    // Someone asking (a press of Retry, a write) is read for now, not after the backoff.
                    withTimeoutOrNull(retry.delayMs(true)) { directoryRevision.first { it != revision } }
                    refresh.trySend(Unit)
                }
            }
        }
        val policy = ReconnectPolicy()
        while (isActive) {
            publish(handle) { it.copy(controlConnection = ConnectionState.CONNECTING) }
            var failed = false
            try {
                auth.stream(handle, ApiRequest(listOf("events")), onOpen = {
                    if (!active(handle, path)) throw CancellationException()
                    publish(handle) { it.copy(controlConnects = it.controlConnects + 1, directoryFresh = false) }
                    // Nothing is replayed: every list is read now, which also answers whatever the open window held.
                    held.value = emptySet()
                    want(DirectoryList.ALL)
                    invalidate(handle)
                    publish(handle) { it.copy(controlConnection = ConnectionState.CONNECTED, controlError = null) }
                }, onFrame = { frame ->
                    if (!active(handle, path)) throw CancellationException()
                    val event = Wire.decode(frame.data.encodeToByteArray(), ControlEvent.serializer())
                    policy.healthy()
                    if (event.type != "ping") {
                        publish(handle) { it.copy(accountEvents = it.accountEvents + (event.type to (it.accountEvents[event.type] ?: 0L) + 1)) }
                        if (witness?.enabled == true) witness.account(event.type, event.sessionId)
                        held.update { it + event.type }
                        window.trySend(Unit)
                    }
                })
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                failed = true
                publish(handle) { it.copy(controlError = RealtimeError.from(error)) }
            }
            publish(handle) { it.copy(controlConnection = ConnectionState.BACKOFF, directoryFresh = false) }
            delay(policy.delayMs(failed))
        }
    }

    /** The pages and the open conversation's cards read again: after a connect, and once for a window of account events. */
    private fun invalidate(handle: SessionHandle) {
        publish(handle) { it.copy(invalidationRevision = it.invalidationRevision + 1, session = it.session?.copy(fresh = false)) }
        refreshSession()
    }

    private fun updateSession(handle: SessionHandle, focus: Selection, change: (SessionState) -> SessionState) {
        publish(handle) { old ->
            if (selection.value == focus && old.session != null && old.session.id == focus.id) old.copy(session = change(old.session)) else old
        }
    }

    private suspend fun session(handle: SessionHandle, focus: Selection, path: Network,
        cache: MutableStateFlow<RealtimeCache>, writes: Channel<Unit>) = coroutineScope {
        val id = focus.id!!
        fun check() { if (!active(handle, path) || selection.value != focus) throw CancellationException() }
        fun save() {
            check()
            if (state.value.session?.accessDenied == true) return
            val transcript = state.value.session?.transcript ?: return
            cache.update { it.remember(id, transcript) }
            writes.trySend(Unit)
        }
        // A page's durable events for the witness, once they are in the window: whether it held each already ([before]).
        fun witnessed(before: Transcript?, page: EventPage, via: String) {
            if (witness?.enabled != true) return
            val after = state.value.session?.takeUnless { it.accessDenied }?.transcript
            if (after == null || after === before) return
            for (event in page.events) if (event.durable) witness.durable(id, event.seq, via == "page" && before?.holds(event.seq) == true, via)
        }
        val refresh = Channel<Unit>(Channel.CONFLATED)
        launch { sessionRevision.collect { refresh.trySend(Unit) } }
        launch {
            val policy = ReconnectPolicy()
            for (ignored in refresh) {
                val revision = sessionRevision.value
                updateSession(handle, focus) { it.copy(fresh = false) }
                try {
                    val snapshot = rest.session(handle, id)
                    currentCoroutineContext().ensureActive()
                    check()
                    if (revision != sessionRevision.value) { refresh.trySend(Unit); continue }
                    val wasDenied = state.value.session?.accessDenied == true
                    updateSession(handle, focus) { it.copy(snapshot = snapshot, fresh = true, error = null, accessDenied = false) }
                    if (wasDenied) {
                        val tail = rest.page(handle, id)
                        check()
                        val before = state.value.session?.transcript
                        updateSession(handle, focus) { it.copy(transcript = it.transcript.tail(tail), seededFromCache = false) }
                        witnessed(before, tail, "tail")
                        save()
                    }
                    policy.healthy()
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    val denied = error is ApiError && error.status in setOf(403, 404)
                    updateSession(handle, focus) { it.copy(fresh = false, error = RealtimeError.from(error),
                        accessDenied = it.accessDenied || denied,
                        snapshot = if (denied) null else it.snapshot,
                        transcript = if (denied) Transcript() else it.transcript, seededFromCache = it.seededFromCache && !denied) }
                    if (denied) {
                        withContext(NonCancellable) { ReadingCache(auth, handle, id).revoke() }
                        cache.update { it.copy(sessions = it.sessions - id) }; writes.trySend(Unit)
                    }
                    delay(policy.delayMs(true))
                    refresh.trySend(Unit)
                }
            }
        }
        // Standing review deadlines can expire without a push. This refresh exists only while
        // the session is foregrounded; reconnect always performs its own unthrottled read.
        launch { while (isActive) { delay(30_000); refreshSession() } }
        fun land(page: EventPage) {
            check()
            val before = state.value.session?.transcript
            updateSession(handle, focus) { if (it.accessDenied) it else it.copy(transcript = it.transcript.page(page)) }
            witnessed(before, page, "page")
            save()
        }
        // Close the gap over REST pages before the stream opens. The gateway gzips JSON but never
        // text/event-stream, and a replay is all-or-nothing: a drop mid-replay re-sends the whole gap.
        // Each landed page moves the frontier. A failed page is not retried here; the stream attempt
        // right after it is the retry, from the advanced frontier. Past the server's own budget the
        // window is re-seeded from the tail, as the server's resync would have ordered.
        suspend fun catchUp() {
            var after = state.value.session!!.transcript.resumeSeq
            repeat(CATCH_UP_PAGES) {
                val page = try { rest.page(handle, id, after) } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { return }
                land(page)
                val next = page.after ?: return
                if (next <= after) throw Resync()
                after = next
            }
            throw Resync()
        }
        val policy = ReconnectPolicy()
        var reseed = false
        while (isActive) {
            check()
            updateSession(handle, focus) { it.copy(connection = ConnectionState.CONNECTING,
                transcript = it.transcript.withoutLive(), fresh = false) }
            var failed = false
            try {
                if (reseed || state.value.session?.transcript?.seeded != true) {
                    val tail = rest.page(handle, id)
                    check()
                    val before = state.value.session?.transcript
                    updateSession(handle, focus) { if (it.accessDenied) it else it.copy(transcript = it.transcript.tail(tail), seededFromCache = false) }
                    witnessed(before, tail, "tail")
                    save()
                    reseed = false
                } else {
                    // Live frames never move the frontier, so a window seeded before this attempt (restored
                    // from the cache, or carried over a drop or a clean close) is behind by all they carried.
                    catchUp()
                }
                val cursor = state.value.session!!.transcript.resumeSeq
                auth.stream(handle, ApiRequest(listOf("sessions", id, "events"),
                    query = listOf("sinceSeq" to "$cursor", "maxPayload" to "2048")), onOpen = {
                    check()
                    refreshSession()
                    // One REST page verifies the frontier where the stream began, while SSE already
                    // buffers the replay/live seam on the server. Future live events cannot move this
                    // frontier. Never a loop: the gap was closed before connecting, and the replay
                    // carries whatever is newer than this page.
                    land(rest.page(handle, id, cursor))
                    updateSession(handle, focus) { it.copy(connection = ConnectionState.CONNECTED) }
                }, onFrame = { frame ->
                    check()
                    val event = RunEvent.decode(frame)
                    if (event.type == "resync") throw Resync()
                    // An opening heartbeat alone does not prove that the replay window works.
                    if (event.type != "ping") policy.healthy()
                    val before = state.value.session?.transcript
                    updateSession(handle, focus) { if (it.accessDenied) it else it.copy(transcript = it.transcript.apply(event)) }
                    // A durable frame the window kept as it was is one it held already (or one older than the trimmed window).
                    if (event.durable && witness?.enabled == true && state.value.session?.accessDenied == false)
                        witness.durable(id, event.seq, state.value.session?.transcript === before, "sse")
                    if (event.durable) save()
                    if (event.type in SNAPSHOT_EVENTS) refreshSession()
                })
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Resync) {
                reseed = true
                failed = true // Repeated resyncs must back off, even if each socket opens cleanly.
                updateSession(handle, focus) { it.copy(transcript = Transcript(), fresh = false, seededFromCache = false) }
                save()
            } catch (error: Exception) {
                failed = true
                if (error is ApiError && error.status in setOf(403, 404)) reportReadDenial(handle, id, error)
                updateSession(handle, focus) { it.copy(error = RealtimeError.from(error), fresh = false) }
            }
            updateSession(handle, focus) { it.copy(connection = ConnectionState.BACKOFF, fresh = false,
                transcript = it.transcript.withoutLive()) }
            delay(policy.delayMs(failed))
        }
    }

    /** The window is sorted by sequence. */
    private fun Transcript.holds(seq: Long) = events.binarySearchBy(seq) { it.seq } >= 0

    companion object {
        /** How long a burst of account events is gathered for, from its first event, before the lists it moved are read once
         * (docs/list-freshness-design.md §4 R1). */
        const val EVENT_WINDOW_MS = 500L
        /** Five 200-event pages: the server's SSE_GAP_CAP, past which it answers a cursor with resync. */
        private const val CATCH_UP_PAGES = 5
        private val SNAPSHOT_EVENTS = setOf("approval_request", "approval_resolved", "queued_turns_changed",
            "background_task", "user", "user_delivery", "turn_end", "status", "result", "interrupt")
    }
}
