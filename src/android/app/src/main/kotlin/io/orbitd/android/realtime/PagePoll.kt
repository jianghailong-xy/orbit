package io.orbitd.android.realtime

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.core.realtime.RealtimeState
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.withTimeoutOrNull

/** What a page's poll follows of the account stream: whether it is up, and a count that moves with each connect and with each account
 * event that can move what the page shows. */
internal data class PageSignal(val connected: Boolean, val nudges: Long)

/**
 * How a page's own reads follow the account stream (docs/list-freshness-design.md §4, R1–R3 and R6). While the stream is up the page
 * reads when an event that can move what it shows arrives — once for a burst, [NUDGE_MS] after its first event — and otherwise once a
 * minute, the safety read for whatever no event announces. A connect replays nothing, so it is read like an event (R4). While the
 * stream is down nothing announces anything: the page reads on a backoff of 4, 8, 16 and then every 30 s, with jitter, and at once
 * when the stream comes back. A state no event announces at all — a landing in flight (LS6: LANDING sessions publish nothing) — keeps
 * its own bounded cadence while it lasts ([follow]'s `inFlightMs`). [PagePoll] runs all of it only while the Activity is started.
 */
internal object PagePolls {
    /** R1: the safety read while the stream is up and no event moved anything. */
    const val FALLBACK_MS = 60_000L
    /** One read for a burst of events, this long after its first (iOS `ProjectsModel.nudge`). */
    const val NUDGE_MS = 2_000L

    /** What moves a project: its own events, and its tasks', which move its lanes and its progress. */
    val PROJECT_EVENTS = setOf("project.changed", "project.criteria_decisions.changed", "task.changed", "task.list.changed")

    /** R2: 4, 8, 16, then every 30 s; jitter takes up to a fifth off each. */
    fun backoffMs(attempt: Int, jitter: Double): Long {
        val base = minOf(30_000L, 4_000L shl minOf(attempt, 3))
        return (base * (0.8 + 0.2 * jitter.coerceIn(0.0, 1.0))).toLong()
    }

    fun signal(state: RealtimeState, handle: SessionHandle, events: Set<String>): PageSignal =
        if (state.handle !== handle) PageSignal(false, 0)
        else PageSignal(state.controlConnection == ConnectionState.CONNECTED,
            state.controlConnects + events.sumOf { state.accountEvents[it] ?: 0L })

    /** Reads at once, then again as [PagePolls] says, until cancelled. [inFlightMs], asked after each read, is the bounded cadence of a
     * state no event announces while it is in flight, or null when nothing is. */
    suspend fun follow(signal: StateFlow<PageSignal>, inFlightMs: () -> Long? = { null }, jitter: () -> Double = Math::random,
        read: suspend () -> Unit) {
        var attempt = 0
        var seen = signal.value.nudges
        read()
        while (true) {
            val bounded = inFlightMs()
            when {
                bounded != null -> { attempt = 0; delay(bounded) }
                signal.value.connected -> {
                    attempt = 0
                    val moved = withTimeoutOrNull(FALLBACK_MS) { signal.first { !it.connected || it.nudges != seen } }
                    // The stream dropped: nothing moved, and the backoff decides when to read.
                    if (moved != null && !moved.connected) continue
                    if (moved != null) delay(NUDGE_MS)
                }
                else -> {
                    val back = withTimeoutOrNull(backoffMs(attempt, jitter())) { signal.first { it.connected } }
                    attempt = if (back == null) attempt + 1 else 0
                }
            }
            seen = signal.value.nudges
            read()
        }
    }
}

/** [read] as [PagePolls] schedules it, while this page's Activity is started (R3): a stopped one reads nothing, and one started again
 * reads at once. [keys] start it afresh; [events] are the account event types that can move what [read] reads. */
@Composable
internal fun PagePoll(app: OrbitApplication, handle: SessionHandle, events: Set<String>, vararg keys: Any?,
    inFlightMs: () -> Long? = { null }, read: suspend () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val reads by rememberUpdatedState(read)
    val bounded by rememberUpdatedState(inFlightMs)
    LaunchedEffect(lifecycle, app, handle, events, *keys) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            val signal = app.realtime.state.map { PagePolls.signal(it, handle, events) }.distinctUntilChanged().stateIn(this)
            PagePolls.follow(signal, { bounded() }) { reads() }
        }
    }
}
