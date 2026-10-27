package io.orbitd.android.reader

import android.util.Log
import android.view.FrameMetrics
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.perf.OrbitPerf
import io.orbitd.android.realtime.RealtimeLifecycle
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.FrameMetricsBuilder
import org.robolectric.shadows.ShadowLog

/** D09 P06 in the production shell: the session page the system brings back with its saved state after a relaunch writes
 * `p06_restored` once, saying whether the draft and the reading position came back; a page entered afresh writes none. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp")
class P06RestoredShellTest : ComposerShellTest() {
    private fun answer(seq: Long) = buildJsonObject {
        put("type", "assistant"); put("seq", seq)
        put("payload", buildJsonObject { put("text", "Answer $seq\n\nIt goes on for a while, so that a few of these fill the page.") })
    }
    private fun restoredLines() = ShadowLog.getLogsForTag(OrbitPerf.TAG).map { it.msg }.filter { it.startsWith("v=1 ev=p06_restored ") }
    private fun frame(): FrameMetrics {
        val vsync = System.nanoTime() + 1_000_000
        return FrameMetricsBuilder().setMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP, vsync).setMetric(FrameMetrics.VSYNC_TIMESTAMP, vsync)
            .setMetric(FrameMetrics.DRAW_DURATION, 4_000_000).setMetric(FrameMetrics.SWAP_BUFFERS_DURATION, 5_000_000).build()
    }
    /** Frames as the window reports them, as long as the page is drawing. */
    private fun frames(): Boolean { shadowOf(compose.activity.window).reportOnFrameMetricsAvailable(frame()); return true }
    /** What a relaunch tells the lifecycle — the process's first Activity was created with saved state — in this process. */
    private fun relaunched() = RealtimeLifecycle::class.java.getDeclaredField("relaunched").run {
        isAccessible = true; setBoolean(app().realtimeLifecycle, true)
    }
    private fun input() = compose.onNodeWithTag("composer-input").fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text

    @Before fun on() {
        ShadowLog.setLoggable(OrbitPerf.TAG, Log.DEBUG)
        ComposerShell.events = (1L..40L).map(::answer)
    }

    @Test fun aPageBroughtBackAfterARelaunchSaysOnceThatItsDraftAndPositionCameBack() {
        signIn(); openSession()
        await { has(hasTestTag("event:40")) }
        compose.onNodeWithTag("composer-input").performTextInput("A draft to read back")
        // Back up the transcript as a finger does, off the tail, so the bookmark is a row and an offset.
        compose.onNodeWithTag("transcript-list").performTouchInput {
            down(center); repeat(10) { moveBy(Offset(0f, 150f)) }; advanceEventTime(200); up()
        }
        compose.waitForIdle()
        await { has(hasTestTag("transcript-jump")) }
        relaunched()
        compose.activityRule.scenario.recreate()
        await { frames() && restoredLines().isNotEmpty() }
        val line = restoredLines().single()
        assertTrue(line, line.matches(Regex("v=1 ev=p06_restored sid8=${OrbitPerf.sid8(ComposerShell.SESSION)} draft=1 anchor=1 " +
            "frameVsyncMono=\\d+ frameEndMono=\\d+ frameTotalNs=9000000 dropped=0 rt=\\d+ mono=\\d+")))
        assertEquals("A draft to read back", input())
        assertTrue("still off the tail", has(hasTestTag("transcript-jump")))
        // Once per relaunch: brought back again in the same process (a rotation), the page writes no second line.
        compose.activityRule.scenario.recreate()
        await { has(hasTestTag("composer-model") and isEnabled()) }
        repeat(10) { frames(); compose.mainClock.advanceTimeByFrame() }
        assertEquals(1, restoredLines().size)
    }

    @Test fun withNothingSavedInItsBoxTheRestoredLineSaysTheDraftDidNotComeBack() {
        signIn(); openSession()
        await { has(hasTestTag("event:40")) }
        compose.waitForIdle()
        relaunched()
        compose.activityRule.scenario.recreate()
        await { frames() && restoredLines().isNotEmpty() }
        assertTrue(restoredLines().single(), restoredLines().single().contains(" draft=0 anchor=1 "))
    }

    @Test fun aSessionOpenedAfterARelaunchIsNotOneBroughtBackAndWritesNone() {
        signIn()
        relaunched()
        openSession()
        await { has(hasTestTag("event:40")) }
        repeat(10) { frames(); compose.mainClock.advanceTimeByFrame() }
        assertEquals(emptyList<String>(), restoredLines())
    }

    @Test fun offThePageWritesNothing() {
        ShadowLog.setLoggable(OrbitPerf.TAG, Log.INFO)
        signIn(); openSession()
        await { has(hasTestTag("event:40")) }
        relaunched()
        compose.activityRule.scenario.recreate()
        await { has(hasTestTag("composer-model") and isEnabled()) }
        repeat(10) { frames(); compose.mainClock.advanceTimeByFrame() }
        assertEquals(emptyList<String>(), ShadowLog.getLogsForTag(OrbitPerf.TAG))
    }
}
