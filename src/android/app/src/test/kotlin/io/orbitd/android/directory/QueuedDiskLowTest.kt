package io.orbitd.android.directory

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A new session Keep Free holds (queuedReason `disk_below_floor`), case for case with OrbitKit `QueuedDiskLowTests`. */
class QueuedDiskLowTest {
    private fun row(reason: String?) = DirectorySession(id = "S1", status = "PENDING", runState = "QUEUED", queuedReason = reason)

    @Test fun heldByKeepFreeAndNoOtherGate() {
        assertTrue(QueuedDiskLow.isDiskHeld(row("disk_below_floor").queuedGate))
        listOf("runner_at_capacity", "runner_updating", "runner_offline", null).forEach { assertFalse("$it", QueuedDiskLow.isDiskHeld(row(it).queuedGate)) }
        assertFalse(QueuedDiskLow.isDiskHeld(null))
    }

    @Test fun theListAndHeaderSayLowDiskSpace() {
        assertEquals("Low disk space", SessionLine.make(row("disk_below_floor"), live = true).text)
        assertEquals("Low disk space", SessionHeader.statusWord(row("disk_below_floor")))
    }

    /** The words are web `runnerSlots.ts`'s. */
    @Test fun theWordsAreTheWebs() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/lib/runnerSlots.ts").isFile }
        val copy = File(root, "src/web/src/lib/runnerSlots.ts").readText()
        assertTrue(copy.contains("export const DISK_LOW_TITLE = '${QueuedDiskLow.TITLE}';"))
        assertTrue(copy.contains("export const DISK_LOW_WAIT = '${QueuedDiskLow.WAIT}';"))
        assertTrue(copy.contains("case '${QueuedDiskLow.REASON}':"))
    }
}
