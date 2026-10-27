package io.orbitd.android.reader

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.view.FrameMetrics
import android.view.MotionEvent
import androidx.compose.ui.test.*
import io.orbitd.android.MainActivity
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.perf.OrbitPerf
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.FrameMetricsBuilder
import org.robolectric.shadows.ShadowLog

/**
 * D09 P02 in the production shell (LastPageMark): an entry to a session's last page writes `p02_start`, and `p02_ready` once, for the
 * frame that first draws the newest durable row with a usable composer — never while the page is still loading — saying whether the
 * window's first content was the device's own (`source=cache`) or the server's (`source=network`).
 */
class LastPageMarkTest : ComposerShellTest() {
    private val sid8 get() = OrbitPerf.sid8(ComposerShell.SESSION)
    private fun lines(ev: String) = ShadowLog.getLogsForTag(OrbitPerf.TAG).map { it.msg }.filter { it.startsWith("v=1 ev=$ev ") }
    private fun on() = ShadowLog.setLoggable(OrbitPerf.TAG, Log.DEBUG)

    /** A frame of MainActivity's window drawn from now on, as the platform reports one: what `p02_ready` waits for. */
    private fun drawFrame() = compose.runOnIdle {
        val vsync = System.nanoTime()
        shadowOf(compose.activity.window).reportOnFrameMetricsAvailable(FrameMetricsBuilder()
            .setMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP, vsync).setMetric(FrameMetrics.VSYNC_TIMESTAMP, vsync)
            .setMetric(FrameMetrics.DRAW_DURATION, 4_000_000).setMetric(FrameMetrics.SWAP_BUFFERS_DURATION, 6_000_000).build())
    }
    private fun awaitReady(count: Int) = await { drawFrame(); lines("p02_ready").size >= count }
    /** [n] frames by hand, while the clock does not advance by itself: what is posted to the main thread, then a frame. */
    private fun step(n: Int) = repeat(n) { compose.waitForIdle(); compose.mainClock.advanceTimeByFrame() }

    private fun conversation() {
        ComposerShell.events = listOf(
            ComposerShell.obj("""{"type":"user","seq":1,"payload":{"text":"First question"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"payload":{"text":"First answer"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":3,"payload":{"text":"Latest answer 3"}}"""))
    }
    private fun sessionRow() = hasText("Composer increments") and hasClickAction()
    private fun openWorkspace() {
        await { has(hasText("Alpha") and hasClickAction()) }
        compose.onAllNodes(hasText("Alpha") and hasClickAction())[0].performClick()
        await { has(sessionRow()) }
    }
    /** A finger's tap on the session's row, through MainActivity as the screen delivers one; its UP at [up] (uptime ms). */
    private fun tapRow(up: Long) {
        val center = compose.onNode(sessionRow()).fetchSemanticsNode().boundsInWindow.center
        compose.runOnUiThread {
            compose.activity.dispatchTouchEvent(MotionEvent.obtain(up - 60, up - 60, MotionEvent.ACTION_DOWN, center.x, center.y, 0))
            compose.activity.dispatchTouchEvent(MotionEvent.obtain(up - 60, up, MotionEvent.ACTION_UP, center.x, center.y, 0))
        }
    }
    /** A link Android hands the running Activity; a notification's tap carries the notification's tag as the identifier. */
    private fun deliver(link: String, notificationTag: String? = null) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java).setIdentifier(notificationTag))
            it.intent = launch
        }
        compose.waitForIdle()
    }

    @Test fun aTappedSessionIsMarkedOnceWhenItsLastPageAndComposerAreFirstDrawn() {
        on()
        conversation()
        val page = CompletableDeferred<Unit>().also { ComposerShell.pageGate = it }
        signIn(); openWorkspace()
        // The loading line's spinner never lets Compose idle: its frames are driven by hand until the page lands.
        compose.mainClock.autoAdvance = false
        val up = SystemClock.uptimeMillis()
        tapRow(up)
        step(20)
        val start = lines("p02_start").single()
        assertTrue(start, start.matches(Regex("v=1 ev=p02_start sid8=$sid8 via=list inputMono=${up * 1_000_000} rt=\\d+ mono=\\d+")))
        // The page is still on its way: the loading line, and no mark however many frames are drawn.
        assertTrue(shows("Loading messages…"))
        repeat(3) { drawFrame(); step(1) }
        assertEquals(emptyList<String>(), lines("p02_ready"))
        page.complete(Unit)
        var frames = 0
        while (!shows("Latest answer 3") && frames++ < 600) step(1)
        compose.mainClock.autoAdvance = true
        awaitReady(1)
        val ready = lines("p02_ready").single()
        assertTrue(ready, ready.matches(Regex("v=1 ev=p02_ready sid8=$sid8 source=network tailSeq=3 frameVsyncMono=(\\d+) " +
            "frameEndMono=\\d+ frameTotalNs=10000000 dropped=0 rt=\\d+ mono=\\d+")))
        assertTrue(shows("Latest answer 3") && has(hasTestTag("composer-input") and isEnabled()))
        // Once an entry: a reply arriving, and the frames that draw it, add none.
        ComposerShell.push("""{"type":"assistant","seq":4,"payload":{"text":"Later answer 4"}}""")
        awaitText("Later answer 4")
        repeat(3) { drawFrame() }
        assertEquals(1, lines("p02_ready").size)
    }

    @Test fun openingItAgainFromTheListIsANewEntryThatTheCacheDraws() {
        on()
        conversation()
        signIn(); openWorkspace()
        compose.onNode(sessionRow()).performClick()
        awaitReady(1)
        assertTrue(lines("p02_start").single(), lines("p02_start").single().matches(Regex("v=1 ev=p02_start sid8=$sid8 via=list inputMono=(na|\\d+) .*")))
        assertTrue(lines("p02_ready").single(), lines("p02_ready").single().contains(" source=network tailSeq=3 "))
        compose.onNodeWithContentDescription("Back").performClick()
        await { has(sessionRow()) }
        compose.onNode(sessionRow()).performClick()
        awaitReady(2)
        assertEquals(2, lines("p02_start").size)
        assertTrue(lines("p02_ready")[1], lines("p02_ready")[1].contains(" source=cache tailSeq=3 "))
    }

    @Test fun aLinkSaysLinkAndANotificationsTapSaysPush() {
        on()
        conversation()
        signIn()
        deliver("orbit-session:${ComposerShell.SESSION}")
        awaitReady(1)
        assertTrue(lines("p02_start").single(), lines("p02_start").single().contains(" sid8=$sid8 via=link inputMono=na "))
        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitForIdle()
        deliver("orbit-session:${ComposerShell.SESSION}", notificationTag = "orbit.session.${ComposerShell.SESSION}")
        awaitReady(2)
        assertTrue(lines("p02_start")[1], lines("p02_start")[1].contains(" sid8=$sid8 via=push inputMono=na "))
    }

    @Test fun offNothingIsWrittenOrWatched() {
        conversation()
        signIn(); openWorkspace()
        compose.onNode(sessionRow()).performClick()
        awaitText("Latest answer 3")
        await { has(hasTestTag("composer-input") and isEnabled()) }
        repeat(3) { drawFrame() }
        assertEquals(emptyList<String>(), ShadowLog.getLogsForTag(OrbitPerf.TAG).map { it.msg })
    }
}
