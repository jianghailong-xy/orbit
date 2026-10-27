package io.orbitd.android.perf

import android.app.Activity
import android.content.ContextWrapper
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.FrameMetrics
import android.view.View
import android.view.Window
import io.orbitd.android.navigation.ObjectId
import java.security.MessageDigest

/**
 * D09's collection points (a01-errata-v2), in the format A15 fixed for its one collector (A06g comment 34mPWCRYn3Shl96g3IQwZ):
 * one logcat line per event under [TAG], `v=1 ev=<name> key=value … rt=<elapsedRealtimeNanos> mono=<System.nanoTime>`, ASCII,
 * values without spaces, never message text, titles, addresses or tokens. The two clocks are read back to back: FrameMetrics,
 * Choreographer and input times are on `mono`, and the pair carries them onto `rt`, which keeps counting through sleep.
 *
 * Off unless the tag is loggable at DEBUG: `adb shell setprop log.tag.OrbitPerf D` turns it on and `… INFO` off again, with no
 * reinstall or restart; collect with `adb logcat -v epoch -s OrbitPerf:D`. Off, nothing is built, allocated or registered —
 * callers test [enabled] before they build their fields — so the build every user runs pays one property read per point.
 */
object OrbitPerf {
    const val TAG = "OrbitPerf"
    val enabled: Boolean get() = Log.isLoggable(TAG, Log.DEBUG)
    private val main by lazy { Handler(Looper.getMainLooper()) }
    /** The UI thread's part of a frame, which ends where its draw is handed to the render thread. */
    private val uiPhases = intArrayOf(FrameMetrics.UNKNOWN_DELAY_DURATION, FrameMetrics.INPUT_HANDLING_DURATION,
        FrameMetrics.ANIMATION_DURATION, FrameMetrics.LAYOUT_MEASURE_DURATION, FrameMetrics.DRAW_DURATION)

    /** One line for [ev]; [fields] are space-separated `key=value` pairs, or empty. */
    fun emit(ev: String, fields: String = "") { if (enabled) write(ev, fields) }

    /** A session as `sid8=`: the first 8 hex digits of the SHA-256 of the UTF-8 bytes of its id spelled as the lowercase
     * hyphenated UUID (`ObjectId.canonical`), so its base62 public id and its UUID give one value; an id that is neither is
     * hashed as given. A collector computes the same for a fixture's ids. */
    fun sid8(sessionId: String): String = MessageDigest.getInstance("SHA-256")
        .digest((ObjectId.canonical(sessionId) ?: sessionId).toByteArray()).take(4).joinToString("") { "%02x".format(it) }

    /**
     * [ev] with [fields] and the frame that draws the state its caller has just seen: the first frame of the window of the
     * Activity [view] belongs to (MainActivity's window for its Compose content, not a dialog's own) whose UI-thread work —
     * INTENDED_VSYNC plus its unknown-delay, input, animation, layout and draw durations — ends at or after this call. Called
     * while a frame composes, lays out or draws, that is this frame; called between frames, the next one, which invalidating
     * [view] makes sure is drawn. Appends `frameVsyncMono=<INTENDED_VSYNC_TIMESTAMP>`,
     * `frameEndMono=<INTENDED_VSYNC_TIMESTAMP+TOTAL_DURATION>`, `frameTotalNs=<TOTAL_DURATION>` and `dropped=<the listener's
     * dropCountSinceLastInvocation summed from this call to that frame>` (A15 counts a sample with dropped>0 as invalid), or
     * `na` for all four when the window cannot be observed. Main thread only.
     */
    fun emitOnFrame(view: View, ev: String, fields: String = "") {
        if (!enabled) return
        val called = System.nanoTime()
        val window = generateSequence(view.context) { (it as? ContextWrapper)?.baseContext }
            .firstNotNullOfOrNull { it as? Activity }?.window
        val listener = object : Window.OnFrameMetricsAvailableListener {
            private var dropped = 0L
            private var done = false
            override fun onFrameMetricsAvailable(window: Window, metrics: FrameMetrics, dropCountSinceLastInvocation: Int) {
                if (done) return
                dropped += dropCountSinceLastInvocation
                val vsync = metrics.getMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP)
                if (vsync + uiPhases.sumOf { metrics.getMetric(it) } < called) return
                done = true
                val total = metrics.getMetric(FrameMetrics.TOTAL_DURATION)
                write(ev, join(fields, "frameVsyncMono=$vsync frameEndMono=${vsync + total} frameTotalNs=$total dropped=$dropped"))
                // Not from inside the callback: the window may still be delivering this report.
                main.post { runCatching { window.removeOnFrameMetricsAvailableListener(this) } }
            }
        }
        try { checkNotNull(window).addOnFrameMetricsAvailableListener(listener, main) }
        catch (_: RuntimeException) {
            write(ev, join(fields, "frameVsyncMono=na frameEndMono=na frameTotalNs=na dropped=na"))
            return
        }
        view.invalidate()
    }

    private fun join(fields: String, more: String) = if (fields.isEmpty()) more else "$fields $more"

    private fun write(ev: String, fields: String) {
        val rt = SystemClock.elapsedRealtimeNanos()
        val mono = System.nanoTime()
        Log.d(TAG, if (fields.isEmpty()) "v=1 ev=$ev rt=$rt mono=$mono" else "v=1 ev=$ev $fields rt=$rt mono=$mono")
    }
}
