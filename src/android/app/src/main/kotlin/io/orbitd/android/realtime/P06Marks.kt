package io.orbitd.android.realtime

import android.net.NetworkCapabilities
import android.os.Process
import android.view.View
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.core.realtime.RealtimeState
import io.orbitd.android.core.realtime.RealtimeWitness
import io.orbitd.android.perf.OrbitPerf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.android.awaitFrame
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/*
 * D09 P06, recovery (a01-errata-v2 §5), as the OrbitPerf lines A15 fixed for its collector (A04d comment 34mPXN4keGOhanKBxrO0A),
 * all off unless `adb shell setprop log.tag.OrbitPerf D`. Each scenario has its own start (t0) and end (t1):
 * - network back: `p06_net_lost`, then `p06_net_validated` (t0) when the default network has INTERNET+VALIDATED again;
 * - process alive, back in front: `p06_start_cb` and `p06_foreground` (t0) from the Activity's onStart and onResume;
 * - process reclaimed, relaunched: `p06_process_start`; the tester's launch intent is t0, and `p06_restored` the 4 s gate's t1.
 * `p06_consistent` is the first two's t1 and the third's reconciliation, reported apart. `rt_durable` lines witness every durable
 * event the store took in. None of it changes what the app does.
 */

/** `p06_process_start`, from Application.onCreate: when this process started, on the `rt` clock. */
internal fun p06ProcessStart() {
    if (OrbitPerf.enabled) OrbitPerf.emit("p06_process_start", "procStartRt=${Process.getStartElapsedRealtime() * 1_000_000}")
}

/**
 * A15's consistency end point, as far as the store can tell: the account stream reconnected and a directory read since then
 * applied (acct); the selected session's stream reconnected, with its gap closed over REST pages or its window reseeded after a
 * resync, and the page verifying its cursor landed (sess); its authority (detail, PENDING approvals, active turns, background
 * jobs, evidence and owner decisions) read again since and applied (snap). The cards and the composer draw that snapshot, so a
 * resolved or expired card is gone from the frame reported (pend). A connected stream or a 200 alone is not it. With no session
 * selected, the account part alone.
 */
internal fun RealtimeState.reconciled(): Boolean {
    if (handle == null || controlConnection != ConnectionState.CONNECTED || !directoryFresh || directoryRefreshing) return false
    val session = session ?: return true
    return !session.accessDenied && session.connection == ConnectionState.CONNECTED && session.fresh && session.snapshot != null
}

internal fun RealtimeState.consistentFields(cause: String): String = session.let { session ->
    if (session == null) "cause=$cause sid8=none acct=1 sess=na snap=na pend=na tailSeq=na"
    else "cause=$cause sid8=${OrbitPerf.sid8(session.id)} acct=1 sess=1 snap=1 pend=1 tailSeq=${session.transcript.maxSeq}"
}

/**
 * The default network's INTERNET+VALIDATED edges, read from the callback's own capabilities: `p06_net_validated` when a network
 * first has both — after a loss, or one the default moved to — and `p06_net_lost` when the one that had them loses either or is
 * lost. Tracked whether or not the lines are on, so turning them on never reports a stale edge.
 */
internal class P06Network {
    private var validated: Any? = null
    private var transport = "none"
    private var seenOne = false

    /** Whether this edge starts a network round: a validation after an earlier one, not the process's first. */
    fun capabilities(network: Any, internet: Boolean, valid: Boolean, transport: String): Boolean {
        val usable = internet && valid
        if (usable && validated != network) {
            if (OrbitPerf.enabled) OrbitPerf.emit("p06_net_validated", "net=$transport netId=$network")
            val round = seenOne
            validated = network; this.transport = transport; seenOne = true
            return round
        }
        if (!usable && validated == network) {
            if (OrbitPerf.enabled) OrbitPerf.emit("p06_net_lost", "net=$transport netId=$network")
            validated = null
        }
        return false
    }

    fun lost(network: Any) {
        if (validated != network) return
        if (OrbitPerf.enabled) OrbitPerf.emit("p06_net_lost", "net=$transport netId=$network")
        validated = null
    }

    companion object {
        fun transport(capabilities: NetworkCapabilities) = when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> "vpn"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
    }
}

/**
 * A round from each recovery trigger to the first frame drawn once the store has reconciled after it, as `p06_consistent` —
 * once per round (A15): the next loss, background or relaunch starts the next. Only while OrbitPerf is on; otherwise nothing
 * is watched. [view] is a view of the Activity in front, whose window the frame is read from.
 */
internal class P06Rounds(private val state: StateFlow<RealtimeState>, private val view: () -> View?) : AutoCloseable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var round: Job? = null
    private var cause: String? = null

    fun start(cause: String) {
        if (!OrbitPerf.enabled) return
        // Offline at a relaunch, its reconciliation is timed from the network's arrival (D09 v2 §5) and stays the relaunch's.
        if (cause == NET && this.cause == RELAUNCH) return
        this.cause = cause
        round?.cancel()
        round = scope.launch {
            val reconciled = state.first { it.reconciled() }
            // The page draws this state through its own collectors, a frame later at most: two frames on, the next one has it.
            awaitFrame(); awaitFrame()
            this@P06Rounds.cause = null
            val fields = reconciled.consistentFields(cause)
            val target = view()
            if (target == null) OrbitPerf.emit("p06_consistent", "$fields frameVsyncMono=na frameEndMono=na frameTotalNs=na dropped=na")
            else OrbitPerf.emitOnFrame(target, "p06_consistent", fields)
        }
    }

    override fun close() { scope.cancel() }

    companion object {
        const val NET = "net"
        const val FOREGROUND = "foreground"
        const val RELAUNCH = "relaunch"
    }
}

/** The store's witness as `rt_durable` lines: `stream=session … seq=<n> dup=0|1 via=sse|page|tail` for each durable event, and
 * `stream=account … seq=na dup=0 type=<type>` for each account event, which carries no sequence (that stream replays nothing; a
 * reconnect re-reads REST instead). Called on the store's thread. */
internal object RealtimeLines : RealtimeWitness {
    override val enabled get() = OrbitPerf.enabled
    private var hashed: String? = null
    private var sid8 = ""

    private fun sid8(sessionId: String): String {
        if (sessionId != hashed) { sid8 = OrbitPerf.sid8(sessionId); hashed = sessionId }
        return sid8
    }

    override fun durable(sessionId: String, seq: Long, duplicate: Boolean, via: String) =
        OrbitPerf.emit("rt_durable", "stream=session sid8=${sid8(sessionId)} seq=$seq dup=${if (duplicate) 1 else 0} via=$via")

    override fun account(type: String, sessionId: String) = OrbitPerf.emit("rt_durable",
        "stream=account sid8=${if (sessionId.isEmpty()) "none" else sid8(sessionId)} seq=na dup=0 " +
            "type=${type.filter { it.isLetterOrDigit() || it in "._-" }}")
}

/**
 * `p06_restored`'s fields from what the page shows two frames after it settled: draft=1 when the composer read a draft back and
 * its box is enabled; anchor=1 when the list stands where the bookmark it restored says — on its first event row at its offset,
 * or at the end for a bookmark that followed the tail — the position the reader would save again now. No bookmark restored, or
 * none read back: 0.
 */
internal fun restoredFields(sessionId: String, draftLoaded: Boolean, draft: String, restored: RestoredPosition?,
    shownSeq: Long?, shownOffset: Int, atEnd: Boolean): String {
    val anchor = when {
        restored == null -> false
        restored.following -> atEnd
        else -> shownSeq == restored.seq && shownOffset == restored.offset
    }
    return "sid8=${OrbitPerf.sid8(sessionId)} draft=${if (draftLoaded && draft.isNotEmpty()) 1 else 0} anchor=${if (anchor) 1 else 0}"
}

/** The reading position a page restored from disk: its first event row's sequence and pixel offset, or the tail. */
internal data class RestoredPosition(val seq: Long, val offset: Int, val following: Boolean)
