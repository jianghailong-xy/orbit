package io.orbitd.android.reader

import android.view.View
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.layout
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.perf.OrbitPerf
import io.orbitd.android.perf.WindowFrames

/**
 * D09 P02 (a01-decisions-v1: a long session's last page, from the tap to its text with a usable composer) on [OrbitPerf]'s lines,
 * as A15 fixed them (A06g comment 34mPWCRYn3Shl96g3IQwZ). Opening a session at its last page writes
 * `p02_start sid8=… via=list|search|link|push inputMono=<the tap's MotionEvent time, ns>|na`, and the reader that shows it writes
 * `p02_ready sid8=… source=cache|network tailSeq=…` once ([LastPageMark]). A route that opens a session at a record is not such an
 * entry; going back to a page and opening the session again is a new one. Off, an entry is neither recorded nor watched.
 */
internal object LastPageMarks {
    const val NO_TOUCH = Long.MIN_VALUE
    /** The ACTION_UP MainActivity is dispatching, in ns of CLOCK_MONOTONIC: a session opened during its dispatch was opened by it. */
    var touchNanos = NO_TOUCH
    /** The last link Android delivered, and whether a notification's tap delivered it (its intent carries the notification's tag). */
    private var delivered: String? = null
    private var fromNotification = false
    private val pending = HashMap<String, LastPageMark>()

    /** A session opened from a page of the app; its route's origin says from which. */
    fun opened(route: OrbitRoute) {
        if (route.destination == Destination.SESSION) start(route, when (route.origin) { Origin.LIST -> "list"; Origin.SEARCH -> "search"; else -> "link" })
    }
    /** An intent's link, as MainActivity receives it. */
    fun delivered(link: String, notification: Boolean) { delivered = link; fromNotification = notification }
    /** The route of the link [raw] the shell has just parsed. */
    fun arrived(route: OrbitRoute, raw: String) {
        if (route.destination == Destination.SESSION) start(route, if (fromNotification && raw == delivered) "push" else "link")
    }

    private fun start(route: OrbitRoute, via: String) {
        val id = route.id
        if (id == null || route.recordId != null || !OrbitPerf.enabled) return
        val sid8 = OrbitPerf.sid8(id)
        OrbitPerf.emit("p02_start", "sid8=$sid8 via=$via inputMono=${if (touchNanos == NO_TOUCH) "na" else "$touchNanos"}")
        pending[ObjectId.canonical(id) ?: id] = LastPageMark(sid8)
        WindowFrames.arm()
    }

    /** The reader opening [route] takes its entry's mark, once; null when nothing started one. */
    fun claim(route: OrbitRoute): LastPageMark? {
        if (pending.isEmpty() || route.recordId != null) return null
        return route.id?.let { pending.remove(ObjectId.canonical(it) ?: it) }
    }
}

/**
 * One entry's `p02_ready`: written once, in the frame that first draws both halves of the condition — the newest durable row of a
 * window at the live tail laid out on screen (not the loading line, an empty window or a page of history), and the composer's input
 * enabled, given room and in a window that has the focus (no dialog or sheet over it). Each half is told to the mark where that frame
 * produces it: the reader's composition ([composed]) and the transcript list's measure ([measured]); [OrbitPerf.emitOnFrame] then
 * reports that frame. `source` is where the window's first content came from ([ReadingSource]); `tailSeq` the newest seq the row holds.
 */
internal class LastPageMark(private val sid8: String) {
    private var done = false
    /** The newest durable row's key and the newest seq it holds, while the window is seeded, at the live tail and readable. */
    private var tail: Pair<String, Long>? = null
    private var tailShown = false
    private var composerUsable = false
    private var source: ReadingSource? = null

    fun composed(view: View, tail: Pair<String, Long>?, source: ReadingSource?, composerUsable: Boolean) {
        if (done) return
        // Another row became the newest: its own layout has to show it.
        if (tail?.first != this.tail?.first) tailShown = false
        this.tail = tail; this.source = source; this.composerUsable = composerUsable
        check(view)
    }

    fun measured(view: View, layout: LazyListLayoutInfo) {
        if (done) return
        val key = tail?.first ?: return
        tailShown = layout.visibleItemsInfo.any {
            it.key == key && it.offset < layout.viewportEndOffset && it.offset + it.size > layout.viewportStartOffset
        }
        check(view)
    }

    private fun check(view: View) {
        val seq = tail?.second ?: return
        val source = source ?: return
        if (!tailShown || !composerUsable) return
        done = true
        OrbitPerf.emitOnFrame(view, "p02_ready", "sid8=$sid8 source=${source.wire} tailSeq=$seq")
    }
}

/** The newest event a row draws: its own, its result's, a folded block's or a child's. */
internal val TranscriptRow.newestSeq: Long get() = maxOf(event.seq, result?.seq ?: 0,
    folded.maxOfOrNull { it.seq } ?: 0, children.maxOfOrNull { it.newestSeq } ?: 0)

/**
 * Tells [mark] after each measure of the transcript list, in the frame being laid out — the list's layout info is written during
 * that measure, so a read of it would only see the change a frame later. The read is unobserved and never remeasures the list.
 */
internal fun Modifier.lastPageProbe(mark: LastPageMark?, list: LazyListState, view: View): Modifier = if (mark == null) this
    else layout { measurable, constraints ->
        val placeable = measurable.measure(constraints)
        Snapshot.withoutReadObservation { mark.measured(view, list.layoutInfo) }
        layout(placeable.width, placeable.height) { placeable.place(0, 0) }
    }
