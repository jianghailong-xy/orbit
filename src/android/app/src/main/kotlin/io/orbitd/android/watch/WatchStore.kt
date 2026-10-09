package io.orbitd.android.watch

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

/** OrbitKit `ListLoadState`: in flight, answered at least once, and whether the latest answer failed. */
internal data class WatchLoadState(val loading: Boolean = false, val hasLoaded: Boolean = false, val lastLoadFailed: Boolean = false) {
    fun begin() = copy(loading = true)
    fun succeed() = WatchLoadState(loading = false, hasLoaded = true, lastLoadFailed = false)
    fun fail() = copy(loading = false, lastLoadFailed = true)
}

/** OrbitKit `LoadFailureLogic.presentation`: never "empty" before an answer, never a stale empty after a failure. */
internal enum class WatchListPresentation { LOADING, FAILED, EMPTY, CONTENT }

internal fun watchListPresentation(state: WatchLoadState, isEmpty: Boolean): WatchListPresentation = when {
    !isEmpty -> WatchListPresentation.CONTENT
    state.lastLoadFailed -> if (state.loading) WatchListPresentation.LOADING else WatchListPresentation.FAILED
    state.hasLoaded -> WatchListPresentation.EMPTY
    else -> WatchListPresentation.LOADING
}

/** The account's watches, behind Following, a watch's detail and the session's Watching strip (iOS `WatchesModel`).
 * One per signed-in handle.
 *
 * The control plane has no watch event, so the list is refetched: when the stream connects, on a short coalesced
 * nudge after an event that can move a target, on a 30s floor while a watch surface is on screen, and after each
 * control. What the server answered is always what's drawn. */
internal class WatchStore(private val auth: AuthSession, val handle: SessionHandle, private val scope: CoroutineScope,
    private val client: WatchClient = WatchClient(auth, handle), private val clock: () -> Instant = Instant::now) {

    data class State(
        /** Newest first: the live states, the newest of every state and those that need attention, each once. */
        val watches: List<Watch> = emptyList(),
        /** Observed session → its live watches, rebuilt with the list. */
        val summaries: Map<String, WatchSessionSummary> = emptyMap(),
        val loadState: WatchLoadState = WatchLoadState(),
        /** The list answered 404: the server predates watches, so there is nothing to show or retry. */
        val unsupported: Boolean = false,
    )

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()
    private val current get() = mutable.value

    /** The latest list read started; an older one landing after it is dropped. */
    private var loads = 0L
    /** A control's answer, kept over a list read that started before it landed (key → the read it outlives). */
    private val answered = mutableMapOf<String, Pair<Long, Watch>>()
    private var nudgeJob: Job? = null
    private var notBefore: Instant = Instant.MIN
    private var connected: Boolean? = null

    /** Whether this store still speaks for the signed-in account; another account's watches are never drawn. */
    fun live() = (auth.state.value as? AuthState.SignedIn)?.handle === handle

    /** By either spelling of its id: a push names the UUID. */
    fun watch(id: String): Watch? = WatchIndex.find(id, current.watches)

    fun summary(sessionId: String): WatchSessionSummary? = current.summaries[watchKey(sessionId)]

    /** Read the list again. Runs on the store's scope, so leaving the screen doesn't strand a read half-done. */
    suspend fun load() { scope.launch { read() }.join() }

    private suspend fun read() {
        if (current.unsupported) return
        val ticket = ++loads
        notBefore = clock().plus(REFRESH_INTERVAL)
        mutable.update { it.copy(loadState = it.loadState.begin()) }
        try {
            var list = client.followedWatches()
            if (ticket != loads) return
            answered.entries.removeAll { it.value.first < ticket }
            answered.values.forEach { (_, watch) -> if (WatchIndex.find(watch.id, list) != null) list = WatchIndex.replacing(watch, list) }
            adopt(list)
            mutable.update { it.copy(loadState = it.loadState.succeed()) }
        } catch (cancel: CancellationException) {
            if (ticket == loads) mutable.update { it.copy(loadState = it.loadState.copy(loading = false)) }
            throw cancel
        } catch (error: Exception) {
            if (ticket != loads) return
            if (error is ApiError && error.status == 404) mutable.update { it.copy(unsupported = true, loadState = it.loadState.succeed()) }
            else mutable.update { it.copy(loadState = it.loadState.fail()) }
        }
    }

    /** One watch the list doesn't hold — a deep link or a push for an older one. A failure leaves it unfound. */
    suspend fun fetch(id: String) {
        scope.launch {
            val fetched = try { client.watch(id) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return@launch }
            adopt(WatchIndex.replacing(fetched, current.watches))
        }.join()
    }

    /** A session or task moved, and a target with it maybe: refetch shortly, once for a burst. Skipped while nothing
     * is live, when no target can move; a new watch is left to the floor. */
    fun nudge() {
        if (nudgeJob?.isActive == true || current.watches.none { WatchStateMachine.isLive(it.state) }) return
        nudgeJob = scope.launch {
            delay(NUDGE_DELAY_MS)
            nudgeJob = null
            if (live()) read()
        }
    }

    /** The list's floor while a watch surface is on screen: no event names a watch, so this is what brings in one
     * an agent just created, and the evaluator's newer looks behind every "Last evaluated". */
    suspend fun refreshIfDue() { if (!clock().isBefore(notBefore)) load() }

    /** The account stream's connection: a reconnect re-reads the list the stream can't replay. */
    fun connection(up: Boolean) {
        val before = connected
        connected = up
        if (up && before == false) scope.launch { read() }
    }

    /** Pause, resume or stop. Null when it went through; otherwise the sentence to show by the controls. A refusal
     * usually means the watch moved on (it matched, or somebody else stopped it), so the list is read again before
     * answering. */
    suspend fun perform(control: WatchControl, watch: Watch): String? = scope.async {
        try {
            val updated = when (control) {
                WatchControl.PAUSE -> client.pauseWatch(watch.id)
                WatchControl.RESUME -> client.resumeWatch(watch.id)
                WatchControl.STOP -> client.cancelWatch(watch.id)
                WatchControl.VIEW, WatchControl.EDIT -> return@async null
            }
            answer(updated)
            null
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            read()
            WatchProjection.failureMessage(error, control.raw)
        }
    }.await()

    private fun answer(watch: Watch) {
        answered[watchKey(watch.id)] = loads to watch
        adopt(WatchIndex.replacing(watch, current.watches))
    }

    /** The one writer of `watches` and `summaries`. An identical list writes nothing. */
    private fun adopt(list: List<Watch>) {
        if (list == current.watches) return
        mutable.update { it.copy(watches = list, summaries = WatchIndex.summariesByObserver(list)) }
    }

    companion object {
        val REFRESH_INTERVAL: Duration = Duration.ofSeconds(30)
        const val NUDGE_DELAY_MS = 2_000L
        private var shared: WatchStore? = null

        /** One store per signed-in handle; another account's store is dropped with its handle. */
        fun of(auth: AuthSession, handle: SessionHandle, scope: CoroutineScope): WatchStore {
            shared?.takeIf { it.handle === handle }?.let { return it }
            return WatchStore(auth, handle, scope).also { shared = it }
        }
    }
}
