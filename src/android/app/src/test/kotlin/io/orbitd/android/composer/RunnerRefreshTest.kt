package io.orbitd.android.composer

import io.orbitd.android.reader.refreshWhileStreaming
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/**
 * A07-18 (iOS bc790273c, `fetchRunners`, `runnerPollTask` and the reconnect's `refreshRunner`; ConsoleRunnerRefreshWiringTests): a read
 * a page makes as it opens is tried three times, 300 ms and then 600 ms apart; the session page reads the runner again on every
 * reconnect of its stream — not on the first connect, which is the page opening — and once a minute while it stays connected.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RunnerRefreshTest {
    @Test fun anOpeningReadIsTriedThreeTimes300And600MsApart() = runTest {
        val at = mutableListOf<Long>()
        val rows = threeTries { at += currentTime; if (at.size < 3) throw IOException("dropped") else "runner row" }
        assertEquals("runner row", rows)
        assertEquals(listOf(0L, 300L, 900L), at)
    }

    @Test fun theThirdFailureIsTheReadsAnswer() = runTest {
        var tries = 0
        val failure = runCatching { threeTries<String> { tries++; throw IOException("down #$tries") } }.exceptionOrNull()
        assertEquals(3, tries)
        assertEquals("down #3", failure?.message)
        assertEquals(900L, currentTime)
    }

    @Test fun aReadThatAnswersIsReadOnce() = runTest {
        var tries = 0
        assertEquals(1, threeTries { ++tries })
        assertEquals(0L, currentTime)
    }

    @Test fun theRunnerIsReadAgainOnEveryReconnectAndEveryMinuteWhileConnected() = runTest {
        val connected = MutableStateFlow(false)
        val refreshes = mutableListOf<Long>()
        backgroundScope.launch { refreshWhileStreaming(connected, { refreshes += currentTime }) }
        runCurrent()
        connected.value = true; runCurrent()
        assertTrue("the first connect is the page opening, which reads for itself", refreshes.isEmpty())
        advanceTimeBy(59_999); runCurrent()
        assertTrue(refreshes.isEmpty())
        advanceTimeBy(1); runCurrent()
        assertEquals(listOf(60_000L), refreshes)
        advanceTimeBy(60_000); runCurrent()
        assertEquals(listOf(60_000L, 120_000L), refreshes)
        // The stream drops: no minute's read while it is down, and one the moment it is back.
        connected.value = false; runCurrent()
        advanceTimeBy(5 * 60_000L); runCurrent()
        assertEquals(2, refreshes.size)
        connected.value = true; runCurrent()
        assertEquals(listOf(60_000L, 120_000L, 420_000L), refreshes)
        advanceTimeBy(60_000); runCurrent()
        assertEquals(480_000L, refreshes.last())
    }
}
