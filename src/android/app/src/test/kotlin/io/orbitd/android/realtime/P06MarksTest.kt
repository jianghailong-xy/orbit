package io.orbitd.android.realtime

import android.app.Activity
import android.app.Application
import android.os.Looper
import android.util.Log
import android.view.FrameMetrics
import android.view.View
import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.core.realtime.EventPage
import io.orbitd.android.core.realtime.RealtimeState
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.core.realtime.Transcript
import io.orbitd.android.perf.OrbitPerf
import java.time.Duration
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
class P06MarksTest {
    private val handle = SessionHandle::class.java.getConstructor(AccountKey::class.java).newInstance(AccountKey("https://orbit.test/", "u1"))
    private val sessionId = "0199a3c4-1b2c-7d3e-8f40-123456789abc"
    private val transcript = Transcript().page(EventPage(listOf(RunEvent("user", 41), RunEvent("assistant", 42))))
    private val snapshot = SessionSnapshot(JsonObject(emptyMap()), emptyList(), emptyList(), emptyList(), emptyMap())
    private val live = SessionState(sessionId, transcript, snapshot, fresh = true, connection = ConnectionState.CONNECTED)
    private val reconciled = RealtimeState(handle = handle, directoryFresh = true, controlConnection = ConnectionState.CONNECTED, session = live)

    private fun on() = ShadowLog.setLoggable(OrbitPerf.TAG, Log.DEBUG)
    private fun lines() = ShadowLog.getLogsForTag(OrbitPerf.TAG).map { it.msg }
    private fun frames(count: Int) = repeat(count) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(17)) }
    private fun frame(): FrameMetrics {
        val vsync = System.nanoTime() + 1_000_000
        return FrameMetricsBuilder().setMetric(FrameMetrics.INTENDED_VSYNC_TIMESTAMP, vsync).setMetric(FrameMetrics.VSYNC_TIMESTAMP, vsync)
            .setMetric(FrameMetrics.DRAW_DURATION, 4_000_000).setMetric(FrameMetrics.SWAP_BUFFERS_DURATION, 5_000_000).build()
    }

    @Test fun onlyBothStreamsWithTheirReadsLandedAreConsistentNotAConnectionAlone() {
        assertFalse("skeleton", RealtimeState().reconciled())
        assertFalse("signed out", reconciled.copy(handle = null).reconciled())
        assertFalse("account stream connected, its snapshot not read yet", reconciled.copy(directoryFresh = false).reconciled())
        assertFalse("directory read in flight", reconciled.copy(directoryRefreshing = true).reconciled())
        assertFalse("account stream not back", reconciled.copy(controlConnection = ConnectionState.CONNECTING).reconciled())
        assertFalse("session stream still catching up", reconciled.copy(session = live.copy(connection = ConnectionState.CONNECTING)).reconciled())
        assertFalse("session stream connected, authority not read again", reconciled.copy(session = live.copy(fresh = false)).reconciled())
        assertFalse("no snapshot", reconciled.copy(session = live.copy(snapshot = null)).reconciled())
        assertFalse("denied", reconciled.copy(session = live.copy(accessDenied = true)).reconciled())
        assertTrue(reconciled.reconciled())
        assertTrue("no session open: the account part", reconciled.copy(session = null).reconciled())
        assertEquals("cause=net sid8=2a44366c acct=1 sess=1 snap=1 pend=1 tailSeq=42", reconciled.consistentFields("net"))
        assertEquals("cause=foreground sid8=none acct=1 sess=na snap=na pend=na tailSeq=na", reconciled.copy(session = null).consistentFields("foreground"))
    }

    @Test fun theNetworkLinesAreItsInternetAndValidatedEdges() {
        on()
        val edges = P06Network()
        assertFalse("the process's first validation starts no round", edges.capabilities("100", internet = true, valid = true, transport = "wifi"))
        assertFalse(edges.capabilities("100", internet = true, valid = true, transport = "wifi"))
        assertFalse(edges.capabilities("100", internet = true, valid = false, transport = "wifi"))
        assertTrue("validated again", edges.capabilities("100", internet = true, valid = true, transport = "wifi"))
        edges.lost("100"); edges.lost("100")
        assertFalse(edges.capabilities("101", internet = true, valid = false, transport = "cellular"))
        assertTrue("a network the default moved to", edges.capabilities("101", internet = true, valid = true, transport = "cellular"))
        assertTrue(edges.capabilities("102", internet = true, valid = true, transport = "wifi"))
        assertFalse(edges.capabilities("102", internet = false, valid = true, transport = "wifi"))
        assertEquals(listOf("p06_net_validated net=wifi netId=100", "p06_net_lost net=wifi netId=100", "p06_net_validated net=wifi netId=100",
            "p06_net_lost net=wifi netId=100", "p06_net_validated net=cellular netId=101", "p06_net_validated net=wifi netId=102",
            "p06_net_lost net=wifi netId=102"), lines().map { it.removePrefix("v=1 ev=").substringBefore(" rt=") })
        assertTrue(lines().all { it.matches(Regex("v=1 ev=p06_net_\\w+ net=\\w+ netId=\\d+ rt=\\d+ mono=\\d+")) })
    }

    @Test fun offTheEdgesAreStillTrackedSoTurningItOnReportsNoneThatIsStale() {
        val edges = P06Network()
        edges.capabilities("100", internet = true, valid = true, transport = "wifi")
        on()
        assertFalse(edges.capabilities("100", internet = true, valid = true, transport = "wifi"))
        assertEquals(emptyList<String>(), lines())
    }

    @Test fun theRestoredLineSaysWhichOfDraftAndAnchorCameBack() {
        val at = RestoredPosition(seq = 120, offset = 37, following = false)
        val tail = RestoredPosition(seq = 300, offset = 0, following = true)
        assertEquals("sid8=2a44366c draft=1 anchor=1", restoredFields(sessionId, true, "a draft read back", at, 120, 37, atEnd = false))
        assertEquals("no draft saved", "sid8=2a44366c draft=0 anchor=1", restoredFields(sessionId, true, "", at, 120, 37, atEnd = false))
        assertEquals("draft not read back", "sid8=2a44366c draft=0 anchor=1", restoredFields(sessionId, false, "", at, 120, 37, atEnd = false))
        assertEquals("another offset", "sid8=2a44366c draft=1 anchor=0", restoredFields(sessionId, true, "x", at, 120, 0, atEnd = false))
        assertEquals("another row", "sid8=2a44366c draft=1 anchor=0", restoredFields(sessionId, true, "x", at, 119, 37, atEnd = false))
        assertEquals("nothing restored", "sid8=2a44366c draft=1 anchor=0", restoredFields(sessionId, true, "x", null, 120, 37, atEnd = true))
        assertEquals("following, at the end", "sid8=2a44366c draft=1 anchor=1", restoredFields(sessionId, true, "x", tail, 290, 0, atEnd = true))
        assertEquals("following, short of it", "sid8=2a44366c draft=1 anchor=0", restoredFields(sessionId, true, "x", tail, 290, 0, atEnd = false))
    }

    @Test fun aRoundEndsOnceAtTheFirstFrameDrawnAfterTheStoreReconciled() {
        on()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val view = View(activity)
        val state = MutableStateFlow(RealtimeState(handle = handle))
        P06Rounds(state) { view }.use { rounds ->
            rounds.start(P06Rounds.RELAUNCH)
            frames(3)
            state.value = reconciled.copy(directoryFresh = false); frames(3)
            assertEquals(emptyList<String>(), lines())
            state.value = reconciled; frames(3)
            shadowOf(activity.window).reportOnFrameMetricsAvailable(frame())
            val only = lines().single()
            assertTrue(only, only.matches(Regex("v=1 ev=p06_consistent cause=relaunch sid8=2a44366c acct=1 sess=1 snap=1 pend=1 tailSeq=42 " +
                "frameVsyncMono=\\d+ frameEndMono=\\d+ frameTotalNs=9000000 dropped=0 rt=\\d+ mono=\\d+")))
            // The round is spent: reconciling again is not another end.
            state.value = reconciled.copy(directoryFresh = false); frames(2); state.value = reconciled; frames(3)
            shadowOf(activity.window).reportOnFrameMetricsAvailable(frame())
            assertEquals(1, lines().size)
            // Back from the background: a new round, already reconciled here, ends at the next frames.
            rounds.start(P06Rounds.FOREGROUND); frames(3)
            shadowOf(activity.window).reportOnFrameMetricsAvailable(frame())
            assertTrue(lines().last(), lines().last().startsWith("v=1 ev=p06_consistent cause=foreground "))
            assertEquals(2, lines().size)
        }
    }

    @Test fun offlineAtARelaunchTheNetworksArrivalLeavesTheRoundTheRelaunchs() {
        on()
        val state = MutableStateFlow(RealtimeState(handle = handle))
        P06Rounds(state) { null }.use { rounds ->
            rounds.start(P06Rounds.RELAUNCH)
            rounds.start(P06Rounds.NET)
            state.value = reconciled; frames(3)
            val only = lines().single()
            assertTrue(only, only.matches(Regex("v=1 ev=p06_consistent cause=relaunch .* frameVsyncMono=na frameEndMono=na frameTotalNs=na dropped=na rt=\\d+ mono=\\d+")))
            rounds.start(P06Rounds.NET); frames(3)
            assertTrue(lines().last(), lines().last().startsWith("v=1 ev=p06_consistent cause=net "))
        }
    }

    @Test fun offARoundWatchesNothing() {
        val state = MutableStateFlow(reconciled)
        P06Rounds(state) { null }.use { rounds ->
            rounds.start(P06Rounds.FOREGROUND); frames(3)
            assertEquals(0, state.subscriptionCount.value)
        }
        assertEquals(emptyList<String>(), lines())
    }

    @Test fun theProcessStartIsOnTheRtClock() {
        on()
        p06ProcessStart()
        val only = lines().single()
        assertTrue(only, only.matches(Regex("v=1 ev=p06_process_start procStartRt=\\d+ rt=\\d+ mono=\\d+")))
    }

    @Test fun theWitnessLinesNameTheStreamTheSessionAndTheDuplicate() {
        on()
        RealtimeLines.durable(sessionId, 42, duplicate = false, via = "sse")
        RealtimeLines.durable(sessionId, 42, duplicate = true, via = "page")
        RealtimeLines.account("session.updated", sessionId)
        RealtimeLines.account("task list changed", "")
        assertEquals(listOf("v=1 ev=rt_durable stream=session sid8=2a44366c seq=42 dup=0 via=sse",
            "v=1 ev=rt_durable stream=session sid8=2a44366c seq=42 dup=1 via=page",
            "v=1 ev=rt_durable stream=account sid8=2a44366c seq=na dup=0 type=session.updated",
            "v=1 ev=rt_durable stream=account sid8=none seq=na dup=0 type=tasklistchanged"), lines().map { it.substringBefore(" rt=") })
    }
}
