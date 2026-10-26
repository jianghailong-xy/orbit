package io.orbitd.android.perf

import android.app.Activity
import android.app.Application
import android.app.Dialog
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.FrameMetrics
import android.view.View
import android.view.ViewTreeObserver
import android.view.Window
import android.view.inspector.WindowInspector
import androidx.lifecycle.findViewTreeLifecycleOwner
import io.orbitd.android.MainActivity
import java.util.concurrent.CopyOnWriteArrayList

/**
 * D09 P03 `hwuiRenderGt700Count` (a01-errata-v2 §3–4, A15 comment 34mPWCRYn3Shl96g3IQwZ): every app window's HWUI
 * `FrameMetrics.TOTAL_DURATION`, frame by frame, counted per window for the life of the process — a window's first frame
 * (FIRST_DRAW_FRAME=1) as any other — beside the reports the platform dropped (`dropCountSinceLastInvocation`). It is the time to
 * draw a frame and hand it to the display system, not a measure of a frozen screen.
 *
 * Lines ([OrbitPerf]): `frame_gt700 win=… totalNs=… vsyncMono=… first=0|1` as each frame over 700 ms is reported, and
 * `frames win=… framesTotal=… gt700Total=… droppedTotal=… maxTotalNs=… firstTotal=… firstSeen=0|1` every 10 s for a window with new
 * reports, when its Activity pauses and when the window goes ([FrameTally]). `win` is `main` (MainActivity's window, across
 * recreations), `activity:<class>`, or `dialog:<class>#<n>` for a Compose Dialog, ModalBottomSheet or other ComponentDialog. A popup
 * (DropdownMenu, tooltip, text toolbar) has no Window to observe: `window_unobserved win=popup:<class>#<n>` says one opened.
 *
 * Only while OrbitPerf is on: armed when an Activity is created or resumed, or a session is opened, with the tag on, and let go at
 * the next lifecycle event or 10 s tick that finds it off. An Activity's window is watched from its creation, so its first frame is
 * counted. Other windows are found as they open: each window watched, and each popup, looks for new ones as it draws, which comes
 * before a dialog's own first frame when a window under it draws first (as a tap's ripple does); one found later says `firstSeen=0`.
 */
internal object WindowFrames : Application.ActivityLifecycleCallbacks {
    const val GT700_NS = 700_000_000L
    private const val SUMMARY_MS = 10_000L

    private class Armed(val thread: HandlerThread) { val handler = Handler(thread.looper) }
    /** [found]: by [scan], so it was in the process's window list, which it leaves when it goes. */
    private class Watched(val window: Window, val tally: FrameTally, val listener: Window.OnFrameMetricsAvailableListener, val found: Boolean)

    @Volatile private var armed: Armed? = null
    private val main by lazy { Handler(Looper.getMainLooper()) }
    // Main thread: windows by their root view, the label each popup got, and every window's counts by label.
    private val watched = HashMap<View, Watched>()
    private val unobserved = HashMap<View, String>()
    private val tallies = HashMap<String, FrameTally>()
    private val all = CopyOnWriteArrayList<FrameTally>()
    private var serial = 0

    private val preDraw = ViewTreeObserver.OnPreDrawListener { scan(); true }
    private val gone = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) = Unit
        override fun onViewDetachedFromWindow(view: View) = forget(view)
    }
    private val tick: Runnable = object : Runnable {
        override fun run() {
            val armed = armed ?: return
            if (!OrbitPerf.enabled) { main.post(::disarm); return }
            all.forEach { if (it.moved) OrbitPerf.emit("frames", it.summary()) }
            armed.handler.postDelayed(this, SUMMARY_MS)
        }
    }

    /** Start watching, if the tag is on: the windows already open, and each that opens after. Main thread. */
    fun arm() {
        if (armed != null || !OrbitPerf.enabled) return
        armed = Armed(HandlerThread("OrbitPerf-frames").apply { start() }).also { it.handler.postDelayed(tick, SUMMARY_MS) }
        scan()
    }

    override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (OrbitPerf.enabled) { arm(); watch(activity) }
    }
    override fun onActivityResumed(activity: Activity) {
        if (OrbitPerf.enabled) { arm(); watch(activity) } else disarm()
    }
    override fun onActivityPaused(activity: Activity) {
        val armed = armed ?: return
        watched[activity.window.peekDecorView() ?: return]?.let { armed.handler.post { summarize(it.tally) } }
    }
    override fun onActivityDestroyed(activity: Activity) { activity.window.peekDecorView()?.let(::forget) }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    private fun watch(activity: Activity) {
        val root = activity.window.peekDecorView() ?: return
        if (root !in watched) watch(activity.window, root, if (activity is MainActivity) "main" else "activity:${activity.javaClass.simpleName}")
    }

    /** The process's windows not yet watched: each with a Window of its own (an Activity's, a dialog's) is, the others are named. */
    internal fun scan() {
        if (armed == null) return
        val roots = WindowInspector.getGlobalWindowViews()
        // One that went without ever being attached (a dialog dismissed before its first frame) sent no detach.
        watched.keys.filter { watched[it]?.found == true && it !in roots }.forEach(::forget)
        unobserved.keys.filter { it !in roots }.forEach(::forget)
        for (root in roots) {
            if (root in watched || root in unobserved) continue
            val window = when (val owner = root.findViewTreeLifecycleOwner()) {
                is Activity -> owner.window.takeIf { it.peekDecorView() === root }?.let { it to if (owner is MainActivity) "main" else "activity:${owner.javaClass.simpleName}" }
                is Dialog -> owner.window?.takeIf { it.peekDecorView() === root }?.let { it to "dialog:${owner.javaClass.simpleName}#${++serial}" }
                else -> null
            }
            if (window != null) watch(window.first, root, window.second, found = true) else {
                val label = "popup:${root.javaClass.simpleName}#${++serial}"
                unobserved[root] = label
                // Its frames can't be read, but as it draws (a menu animating) it can still look for windows opened over it.
                root.viewTreeObserver.addOnPreDrawListener(preDraw)
                root.addOnAttachStateChangeListener(gone)
                OrbitPerf.emit("window_unobserved", "win=$label")
            }
        }
    }

    private fun watch(window: Window, root: View, label: String, found: Boolean = false) {
        val armed = armed ?: return
        val tally = tallies.getOrPut(label) { FrameTally(label).also(all::add) }
        // Attached means drawn: the window's first traversal attaches it and draws.
        val late = root.isAttachedToWindow
        val listener = Window.OnFrameMetricsAvailableListener { _, metrics, dropped -> tally.report(metrics, dropped) }
        try { window.addOnFrameMetricsAvailableListener(listener, armed.handler) } catch (_: RuntimeException) { return }
        if (late) armed.handler.post { tally.firstSeen = false }
        root.viewTreeObserver.addOnPreDrawListener(preDraw)
        root.addOnAttachStateChangeListener(gone)
        watched[root] = Watched(window, tally, listener, found)
    }

    private fun forget(root: View, summary: Boolean = true) {
        val window = watched.remove(root)
        if (window == null && unobserved.remove(root) == null) return
        window?.let { runCatching { it.window.removeOnFrameMetricsAvailableListener(it.listener) } }
        runCatching { root.viewTreeObserver.removeOnPreDrawListener(preDraw) }
        root.removeOnAttachStateChangeListener(gone)
        if (window == null) return
        if (summary) armed?.handler?.post { summarize(window.tally) }
    }

    private fun summarize(tally: FrameTally) { if (tally.reports > 0) OrbitPerf.emit("frames", tally.summary()) }

    private fun disarm() {
        val armed = armed ?: return
        this.armed = null
        (watched.keys + unobserved.keys).forEach { forget(it, summary = false) }
        armed.thread.quitSafely()
    }

    /** The frames thread, while armed. */
    internal val looper: Looper? get() = armed?.thread?.looper
    /** The windows watched now, by label. */
    internal val windows: List<String> get() = watched.values.map { it.tally.window }
}

/** One window's counts, kept for the process; changed and read on the frames thread. */
internal class FrameTally(val window: String) {
    var frames = 0L; private set
    var gt700 = 0L; private set
    var dropped = 0L; private set
    var firsts = 0L; private set
    var maxTotalNs = 0L; private set
    /** Every Window under this label was watched before its first frame. */
    var firstSeen = true
    private var summarized = 0L
    /** Frames reported, and reports dropped. */
    val reports get() = frames + dropped
    val moved get() = reports != summarized

    /** One report: [totalNs] its TOTAL_DURATION, [first] its FIRST_DRAW_FRAME, [droppedSince] the reports dropped before it.
     * True when the frame took longer than 700 ms. */
    fun add(totalNs: Long, first: Boolean, droppedSince: Int): Boolean {
        frames++; dropped += droppedSince
        if (first) firsts++
        if (totalNs > maxTotalNs) maxTotalNs = totalNs
        return (totalNs > WindowFrames.GT700_NS).also { if (it) gt700++ }
    }

    fun report(metrics: FrameMetrics, droppedSince: Int) {
        val total = metrics.getMetric(FrameMetrics.TOTAL_DURATION)
        val first = metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L
        if (add(total, first, droppedSince)) OrbitPerf.emit("frame_gt700",
            "win=$window totalNs=$total vsyncMono=${metrics.getMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP)} first=${if (first) 1 else 0}")
    }

    fun summary(): String {
        summarized = reports
        return "win=$window framesTotal=$frames gt700Total=$gt700 droppedTotal=$dropped maxTotalNs=$maxTotalNs firstTotal=$firsts " +
            "firstSeen=${if (firstSeen) 1 else 0}"
    }
}
