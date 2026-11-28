package io.orbitd.android.directory

import io.orbitd.android.core.protocol.Wire
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A folder, a project and the drawer's workspace read [isRunning] for the sessions under them, and the row draws its spinner from
 * `phase`. The row a folder sat idle over (2026-11-28): parked, with one background job gone quiet — `phase` RUNNING, the legacy
 * glyph a still terminal. With the facts, `phase` decides for all of them.
 */
class SessionRunningPhaseTest {
    private fun decode(json: String) = Wire.json.decodeFromString(DirectorySession.serializer(), json)

    @Test fun withTheFactsPhaseDecidesLikeTheRow() {
        val quietJob = decode("""{"id":"s1","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","phase":"RUNNING","released":false,
            "lastTurnOutcome":"ANSWERED","activity":"BACKGROUND_JOB","runningBgCount":1,"runningBgJobCount":0}""")
        assertTrue(quietJob.isRunning())
        assertFalse(quietJob.isRunningJob())

        val idle = decode("""{"id":"s2","status":"RUNNING","runState":"RUNNING","phase":"IDLE","released":false}""")
        assertFalse(idle.isRunning())
    }

    @Test fun withoutTheFactsTheLegacyGlyphStillDecides() {
        val legacyJob = decode("""{"id":"s3","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","runningBgCount":1,"runningBgJobCount":1}""")
        assertFalse(legacyJob.isRunning())
        assertTrue(legacyJob.isRunningJob())
    }
}
