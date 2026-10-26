package io.orbitd.android.perf

import android.app.Activity
import android.app.Application
import android.os.Looper
import android.util.Log
import android.view.FrameMetrics
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.FrameMetricsBuilder
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class OrbitPerfTest {
    private fun lines() = ShadowLog.getLogsForTag(OrbitPerf.TAG).map { it.msg }
    private fun frame(vsync: Long, uiNs: Long, totalNs: Long): FrameMetrics = FrameMetricsBuilder()
        .setMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP, vsync).setMetric(FrameMetrics.VSYNC_TIMESTAMP, vsync)
        .setMetric(FrameMetrics.DRAW_DURATION, uiNs).setMetric(FrameMetrics.SWAP_BUFFERS_DURATION, totalNs - uiNs).build()

    @Test fun offWritesNothingAndWatchesNoFrame() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        OrbitPerf.emit("p06_foreground")
        OrbitPerf.emitOnFrame(View(activity), "p06_restored", "draft=1")
        shadowOf(activity.window).reportOnFrameMetricsAvailable(frame(System.nanoTime() + 1_000_000, 4_000_000, 9_000_000))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(emptyList<String>(), lines())
    }

    @Test fun aLineCarriesVersionEventFieldsAndBothClocks() {
        ShadowLog.setLoggable(OrbitPerf.TAG, Log.DEBUG)
        OrbitPerf.emit("p06_foreground", "activity=MainActivity")
        OrbitPerf.emit("p06_start_cb")
        val (first, second) = lines()
        assertTrue(first, first.matches(Regex("v=1 ev=p06_foreground activity=MainActivity rt=\\d+ mono=\\d+")))
        assertTrue(second, second.matches(Regex("v=1 ev=p06_start_cb rt=\\d+ mono=\\d+")))
        assertEquals(Log.DEBUG, ShadowLog.getLogsForTag(OrbitPerf.TAG).first().type)
    }

    @Test fun sid8IsOneValueForBothSpellingsOfASession() {
        // Reference values computed outside the app: sha256("0199a3c4-1b2c-7d3e-8f40-123456789abc")[:8], sha256("not-an-id")[:8].
        assertEquals("2a44366c", OrbitPerf.sid8("0199a3c4-1b2c-7d3e-8f40-123456789abc"))
        assertEquals("2a44366c", OrbitPerf.sid8("0199A3C4-1B2C-7D3E-8F40-123456789ABC"))
        assertEquals("2a44366c", OrbitPerf.sid8("31ClMs0C84piyKTUai8oW"))
        assertEquals("4e60bf52", OrbitPerf.sid8("not-an-id"))
    }

    @Test fun theFrameIsTheFirstWhoseDrawEndsAfterTheCallAndDropsAddUp() {
        ShadowLog.setLoggable(OrbitPerf.TAG, Log.DEBUG)
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val window = shadowOf(activity.window)
        val before = System.nanoTime()
        OrbitPerf.emitOnFrame(View(activity), "p06_restored", "sid8=2a44366c draft=1 anchor=1")
        // Its UI thread finished drawing before the call: the render thread was still on it, so it shows the old state.
        window.reportOnFrameMetricsAvailable(frame(before - 20_000_000, 5_000_000, 12_000_000), 1)
        assertEquals(emptyList<String>(), lines())
        val vsync = System.nanoTime() + 2_000_000
        window.reportOnFrameMetricsAvailable(frame(vsync, 6_000_000, 14_000_000), 2)
        window.reportOnFrameMetricsAvailable(frame(vsync + 16_666_667, 6_000_000, 14_000_000), 0)
        shadowOf(Looper.getMainLooper()).idle()
        window.reportOnFrameMetricsAvailable(frame(vsync + 33_333_334, 6_000_000, 14_000_000), 0)
        val only = lines().single()
        assertTrue(only, only.matches(Regex("v=1 ev=p06_restored sid8=2a44366c draft=1 anchor=1 frameVsyncMono=$vsync " +
            "frameEndMono=${vsync + 14_000_000} frameTotalNs=14000000 dropped=3 rt=\\d+ mono=\\d+")))
    }

    @Test fun aFrameStillDrawingWhenCalledIsThatFrame() {
        ShadowLog.setLoggable(OrbitPerf.TAG, Log.DEBUG)
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val vsync = System.nanoTime() - 3_000_000 // the call lands 3 ms into an 8 ms draw
        OrbitPerf.emitOnFrame(View(activity), "p02_ready")
        shadowOf(activity.window).reportOnFrameMetricsAvailable(frame(vsync, 8_000_000, 15_000_000))
        val only = lines().single()
        assertTrue(only, only.startsWith("v=1 ev=p02_ready frameVsyncMono=$vsync frameEndMono=${vsync + 15_000_000} frameTotalNs=15000000 dropped=0 "))
    }

    @Test fun withoutAnActivityWindowTheLineSaysSo() {
        ShadowLog.setLoggable(OrbitPerf.TAG, Log.DEBUG)
        OrbitPerf.emitOnFrame(View(org.robolectric.RuntimeEnvironment.getApplication()), "p06_restored", "draft=0 anchor=0")
        val only = lines().single()
        assertTrue(only, only.matches(Regex("v=1 ev=p06_restored draft=0 anchor=0 frameVsyncMono=na frameEndMono=na frameTotalNs=na dropped=na rt=\\d+ mono=\\d+")))
    }
}
