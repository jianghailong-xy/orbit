package io.orbitd.android.perf

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Looper
import android.util.Log
import android.view.FrameMetrics
import android.view.Gravity
import android.view.View
import android.widget.PopupWindow
import androidx.activity.ComponentActivity
import androidx.activity.ComponentDialog
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.FrameMetricsBuilder
import org.robolectric.shadows.ShadowLog

/** A window of its own to count: each test hosts its frames in its own Activity class, as the counts are kept for the process. */
open class FramesHost : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); setContentView(View(this)) }
}
class FramesHostFirst : FramesHost()
class FramesHostDialog : FramesHost()
class FramesHostLate : FramesHost()
class FramesHostPress : FramesHost()
class FramesHostPopup : FramesHost()
class FramesHostOff : FramesHost()
class FramesHostLetGo : FramesHost()
class FramesHostGone : FramesHost()

/** D09 P03 `hwuiRenderGt700Count` (WindowFrames): what is counted for each window, and which windows are watched. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class WindowFramesTest {
    private val app get() = RuntimeEnvironment.getApplication()
    private var host: ActivityController<out Activity>? = null
    private fun lines() = ShadowLog.getLogsForTag(OrbitPerf.TAG).map { it.msg }
    private fun on() = ShadowLog.setLoggable(OrbitPerf.TAG, Log.DEBUG)
    private fun frame(totalNs: Long, first: Boolean = false): FrameMetrics = FrameMetricsBuilder()
        .setMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP, 5_000).setMetric(FrameMetrics.VSYNC_TIMESTAMP, 5_000)
        .setMetric(FrameMetrics.DRAW_DURATION, totalNs).setMetric(FrameMetrics.FIRST_DRAW_FRAME, if (first) 1 else 0).build()
    private fun <T : Activity> start(type: Class<T>): T = Robolectric.buildActivity(type).also { host = it }.setup().get()
    /** What the frames thread has been handed, done. */
    private fun settle() {
        shadowOf(Looper.getMainLooper()).idle()
        WindowFrames.looper?.let { shadowOf(it).idle() }
    }
    private fun summary(window: String) = lines().last { it.startsWith("v=1 ev=frames win=$window ") }

    @Before fun register() = app.registerActivityLifecycleCallbacks(WindowFrames)
    @After fun letGo() {
        // Off, the next Activity callback lets every window go and stops the frames thread.
        ShadowLog.setLoggable(OrbitPerf.TAG, Log.INFO)
        host?.get()?.let(WindowFrames::onActivityResumed)
        app.unregisterActivityLifecycleCallbacks(WindowFrames)
    }

    @Test fun firstFramesAndDroppedReportsAreCountedAndOnlyOver700MsIsLong() {
        val tally = FrameTally("main")
        assertFalse(tally.add(16_000_000, first = true, droppedSince = 0))
        assertTrue("a first frame over 700 ms is a long frame like any other", tally.add(700_000_001, first = true, droppedSince = 2))
        assertFalse("700 ms itself is not over", tally.add(700_000_000, first = false, droppedSince = 1))
        assertEquals("win=main framesTotal=3 gt700Total=1 droppedTotal=3 maxTotalNs=700000001 firstTotal=2 firstSeen=1", tally.summary())
        assertFalse(tally.moved)
        tally.add(1_000_000, first = false, droppedSince = 0)
        assertTrue(tally.moved)
    }

    @Test fun offNoWindowIsWatched() {
        val activity = start(FramesHostOff::class.java)
        shadowOf(activity.window).reportOnFrameMetricsAvailable(frame(900_000_000, first = true), 3)
        settle()
        assertEquals(emptyList<String>(), WindowFrames.windows)
        assertNull("no frames thread", WindowFrames.looper)
        assertEquals(emptyList<String>(), lines())
    }

    @Test fun anActivityWindowIsCountedFromItsFirstFrame() {
        on()
        val activity = start(FramesHostFirst::class.java)
        assertEquals(listOf("activity:FramesHostFirst"), WindowFrames.windows)
        val window = shadowOf(activity.window)
        window.reportOnFrameMetricsAvailable(frame(900_000_000, first = true))
        window.reportOnFrameMetricsAvailable(frame(12_000_000), 2)
        assertEquals(1, lines().count { it.startsWith("v=1 ev=frame_gt700 ") })
        val long = lines().single { it.startsWith("v=1 ev=frame_gt700 ") }
        assertTrue(long, long.matches(Regex("v=1 ev=frame_gt700 win=activity:FramesHostFirst totalNs=900000000 vsyncMono=5000 first=1 rt=\\d+ mono=\\d+")))
        host!!.pause(); settle()
        val paused = summary("activity:FramesHostFirst")
        assertTrue(paused, paused.matches(Regex("v=1 ev=frames win=activity:FramesHostFirst framesTotal=2 gt700Total=1 droppedTotal=2 " +
            "maxTotalNs=900000000 firstTotal=1 firstSeen=1 rt=\\d+ mono=\\d+")))
    }

    @Test fun aDialogsWindowIsWatchedAsItOpensAndSummedWhenItGoes() {
        on()
        val activity = start(FramesHostDialog::class.java)
        settle()
        val dialog = ComponentDialog(activity).apply { setContentView(View(activity)); show() }
        // The window under it draws before the dialog's first traversal, as a press's ripple makes it.
        WindowFrames.scan()
        val label = WindowFrames.windows.single { it.startsWith("dialog:ComponentDialog#") }
        settle()
        assertTrue("then it is attached and drawn", dialog.window!!.decorView.isAttachedToWindow)
        val window = shadowOf(dialog.window!!)
        window.reportOnFrameMetricsAvailable(frame(750_000_000, first = true), 1)
        window.reportOnFrameMetricsAvailable(frame(9_000_000))
        assertTrue(lines().any { it.startsWith("v=1 ev=frame_gt700 win=$label totalNs=750000000 vsyncMono=5000 first=1 ") })
        dialog.dismiss(); settle()
        assertFalse("let go with its window", label in WindowFrames.windows)
        val gone = summary(label)
        assertTrue(gone, gone.startsWith("v=1 ev=frames win=$label framesTotal=2 gt700Total=1 droppedTotal=1 maxTotalNs=750000000 firstTotal=1 firstSeen=1 "))
        assertTrue("the Activity's window stays watched", "activity:FramesHostDialog" in WindowFrames.windows)
    }

    @Test fun aWindowFoundAfterItWasDrawnSaysItsFirstFrameWasNotCounted() {
        on()
        val activity = start(FramesHostLate::class.java)
        val dialog = ComponentDialog(activity).apply { setContentView(View(activity)); show() }
        settle()
        assertTrue(dialog.window!!.decorView.isAttachedToWindow)
        WindowFrames.scan()
        val label = WindowFrames.windows.single { it.startsWith("dialog:ComponentDialog#") }
        shadowOf(dialog.window!!).reportOnFrameMetricsAvailable(frame(8_000_000))
        dialog.dismiss(); settle()
        assertTrue(summary(label).contains(" framesTotal=1 gt700Total=0 droppedTotal=0 maxTotalNs=8000000 firstTotal=0 firstSeen=0 "))
    }

    @Test fun aWatchedWindowDrawingLooksForTheWindowsOpenedOverIt() {
        on()
        val activity = start(FramesHostPress::class.java)
        settle()
        val dialog = ComponentDialog(activity).apply { setContentView(View(activity)); show() }
        // The Activity's window about to draw again, before the dialog's own first traversal.
        assertFalse("it never holds a draw back", activity.window.decorView.viewTreeObserver.dispatchOnPreDraw())
        val label = WindowFrames.windows.single { it.startsWith("dialog:ComponentDialog#") }
        settle()
        shadowOf(dialog.window!!).reportOnFrameMetricsAvailable(frame(20_000_000, first = true))
        dialog.dismiss(); settle()
        assertTrue(summary(label).contains(" framesTotal=1 gt700Total=0 droppedTotal=0 maxTotalNs=20000000 firstTotal=1 firstSeen=1 "))
    }

    @Test fun aDialogDismissedBeforeItsFirstFrameIsLetGoAtTheNextLook() {
        on()
        val activity = start(FramesHostGone::class.java)
        settle()
        val dialog = ComponentDialog(activity).apply { setContentView(View(activity)); show() }
        WindowFrames.scan()
        assertTrue(WindowFrames.windows.any { it.startsWith("dialog:ComponentDialog#") })
        dialog.dismiss()
        WindowFrames.scan()
        assertEquals(listOf("activity:FramesHostGone"), WindowFrames.windows)
        settle()
        assertTrue("nothing drawn, nothing to sum", lines().none { it.startsWith("v=1 ev=frames win=dialog:") })
    }

    @Test fun aPopupHasNoWindowToWatchAndSaysSo() {
        on()
        val activity = start(FramesHostPopup::class.java)
        settle()
        val popup = PopupWindow(View(activity), 100, 100).apply { showAtLocation(activity.window.decorView, Gravity.CENTER, 0, 0) }
        WindowFrames.scan()
        val said = lines().single { it.startsWith("v=1 ev=window_unobserved ") }
        assertTrue(said, said.matches(Regex("v=1 ev=window_unobserved win=popup:\\w+#\\d+ rt=\\d+ mono=\\d+")))
        assertEquals(listOf("activity:FramesHostPopup"), WindowFrames.windows)
        popup.dismiss(); settle()
    }

    @Test fun turnedOffEveryWindowIsLetGoAndNothingMoreIsCounted() {
        on()
        val activity = start(FramesHostLetGo::class.java)
        assertEquals(listOf("activity:FramesHostLetGo"), WindowFrames.windows)
        ShadowLog.setLoggable(OrbitPerf.TAG, Log.INFO)
        host!!.pause().resume(); settle()
        assertEquals(emptyList<String>(), WindowFrames.windows)
        assertNull(WindowFrames.looper)
        // No listener is left on the window: a long frame now, with the tag back on, is not counted.
        on()
        shadowOf(activity.window).reportOnFrameMetricsAvailable(frame(900_000_000))
        assertEquals(emptyList<String>(), lines().filter { it.startsWith("v=1 ev=frame_gt700 ") })
    }
}
