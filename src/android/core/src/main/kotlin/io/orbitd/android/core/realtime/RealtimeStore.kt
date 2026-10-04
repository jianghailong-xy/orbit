package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionChanged
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.Wire
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
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One per application. Auth owns credentials and disk namespaces; this store owns foreground
 * connections, bounded transcript/cache state, and authority refreshes. UI must match state.handle
 * by identity with its captured AuthState handle. Neither background execution nor a live-only
 * event is needed to recover pending cards on the next foreground connection. */
class RealtimeStore(private val auth: AuthSession, scope: CoroutineScope) : AutoCloseable {
    private data class Network(val available: Boolean = false, val identity: String? = null)
    private data class Selection(val id: String?, val revision: Long, val handle: SessionHandle? = null)
    private class Resync : Exception()
    private val job = SupervisorJob(scope.coroutineContext[Job])
    private val owner = CoroutineScope(scope.coroutineContext + job)
    private val foreground = MutableStateFlow(false)
    private val network = MutableStateFlow(Network())
    private val selection = MutableStateFlow(Selection(null, 0))
    private val directoryRevision = MutableStateFlow(0L)
    private val sessionRevision = MutableStateFlow(0L)
    private val mutableState = MutableStateFlow(RealtimeState())
    val state: StateFlow<RealtimeState> = mutableState.asStateFlow()
    private val rest = RealtimeRest(auth)

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
    fun refreshSession() { sessionRevision.update { it + 1 } }
    /** A reader's REST denial is authority too; invalidate pending snapshots and live content. */
    suspend fun reportReadDenial(handle: SessionHandle, id: String, error: ApiError) {
        require(error.status == 403 || error.status == 404)
        if (!current(handle)) return
        val focus = selection.value
        if (focus.handle === handle && focus.id == id) {
            updateSession(handle, focus) { it.copy(accessDenied = true, fresh = false, snapshot = null,
                transcript = Transcript(), error = RealtimeError.from(error)) }
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
        val loaded = try { RealtimeCache.read(auth, handle) } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            publish(handle) { it.copy(directoryError = RealtimeError.from(error)) }
            RealtimeCache()
        }
        if (!current(handle)) throw SessionChanged()
        val cache = MutableStateFlow(loaded)
        val writes = Channel<Unit>(Channel.CONFLATED)
        publish(handle) { it.copy(directory = loaded.directory) }
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
                try { RealtimeCache.write(auth, handle, cache.value) }
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
            combine(foreground, network) { visible, path -> visible to path }.collectLatest { (visible, path) ->
                if (visible && path.available) control(handle, path, cache, writes)
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
                SessionState(id, if (denied) Transcript() else cache.value.sessions[id]?.withoutLive() ?: Transcript(), accessDenied = denied)
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

    private suspend fun control(handle: SessionHandle, path: Network,
        cache: MutableStateFlow<RealtimeCache>, writes: Channel<Unit>) = coroutineScope {
        val refresh = Channel<Unit>(Channel.CONFLATED)
        launch { directoryRevision.collect { refresh.trySend(Unit) } }
        launch {
            val retry = ReconnectPolicy()
            for (ignored in refresh) {
                val revision = directoryRevision.value
                publish(handle) { it.copy(directoryRefreshing = true, directoryFresh = false) }
                try {
                    val snapshot = rest.directory(handle)
                    currentCoroutineContext().ensureActive()
                    if (!active(handle, path)) return@launch
                    if (directoryRevision.value != revision) { refresh.trySend(Unit); continue }
                    publish(handle) { it.copy(directory = snapshot, directoryRefreshing = false,
                        directoryFresh = true, directoryError = null) }
                    cache.update { it.copy(directory = snapshot) }
                    writes.trySend(Unit)
                    retry.healthy()
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    publish(handle) { it.copy(directoryRefreshing = false, directoryFresh = false,
                        directoryError = RealtimeError.from(error)) }
                    delay(retry.delayMs(true))
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
                    invalidate(handle)
                    publish(handle) { it.copy(controlConnection = ConnectionState.CONNECTED, controlError = null) }
                }, onFrame = { frame ->
                    if (!active(handle, path)) throw CancellationException()
                    val event = Wire.decode(frame.data.encodeToByteArray(), ControlEvent.serializer())
                    policy.healthy()
                    if (event.type != "ping") invalidate(handle)
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

    private fun invalidate(handle: SessionHandle) {
        publish(handle) { it.copy(invalidationRevision = it.invalidationRevision + 1, directoryFresh = false,
            session = it.session?.copy(fresh = false)) }
        refreshDirectory()
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
                        updateSession(handle, focus) { it.copy(transcript = it.transcript.tail(tail)) }
                        save()
                    }
                    policy.healthy()
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) {
                    val denied = error is ApiError && error.status in setOf(403, 404)
                    updateSession(handle, focus) { it.copy(fresh = false, error = RealtimeError.from(error),
                        accessDenied = it.accessDenied || denied,
                        snapshot = if (denied) null else it.snapshot,
                        transcript = if (denied) Transcript() else it.transcript) }
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
                    updateSession(handle, focus) { if (it.accessDenied) it else it.copy(transcript = it.transcript.tail(tail)) }
                    save()
                    reseed = false
                }
                val cursor = state.value.session!!.transcript.resumeSeq
                auth.stream(handle, ApiRequest(listOf("sessions", id, "events"),
                    query = listOf("sinceSeq" to "$cursor", "maxPayload" to "2048")), onOpen = {
                    check()
                    refreshSession()
                    // A bounded REST overlap verifies a frontier, while SSE already buffers the
                    // replay/live seam on the server. Future live events cannot move this frontier.
                    var after = cursor
                    var pages = 0
                    do {
                        val page = rest.page(handle, id, after)
                        check()
                        if (++pages > 2) throw Resync()
                        updateSession(handle, focus) { if (it.accessDenied) it else it.copy(transcript = it.transcript.page(page)) }
                        save()
                        val next = page.after ?: break
                        if (next <= after) throw Resync()
                        after = next
                    } while (true)
                    updateSession(handle, focus) { it.copy(connection = ConnectionState.CONNECTED) }
                }, onFrame = { frame ->
                    check()
                    val event = RunEvent.decode(frame)
                    if (event.type == "resync") throw Resync()
                    // An opening heartbeat alone does not prove that the replay window works.
                    if (event.type != "ping") policy.healthy()
                    updateSession(handle, focus) { if (it.accessDenied) it else it.copy(transcript = it.transcript.apply(event)) }
                    if (event.durable) save()
                    if (event.type in SNAPSHOT_EVENTS) refreshSession()
                })
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Resync) {
                reseed = true
                failed = true // Repeated resyncs must back off, even if each socket opens cleanly.
                updateSession(handle, focus) { it.copy(transcript = Transcript(), fresh = false) }
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

    companion object {
        private val SNAPSHOT_EVENTS = setOf("approval_request", "approval_resolved", "queued_turns_changed",
            "background_task", "user", "user_delivery", "turn_end", "status", "result", "interrupt")
    }
}
