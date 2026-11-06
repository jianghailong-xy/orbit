package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.Harness
import io.orbitd.android.core.protocol.Wire
import java.lang.management.ManagementFactory
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A04c: an owner's directory of thousands of sessions was encoded into one string before its size was checked, and that
 * 69.7 MB allocation crashed a release build. A write may hold no more than the record's own cap, whatever it is given. */
class RealtimeCacheTest {
    private val cap = 8 * 1024 * 1024 // Each record's 8 MiB (docs/realtime.md).
    private val texts = mutableMapOf<Int, String>()
    /** One string per length, shared by every row and event that uses it: the encoded snapshot can be far larger than the heap it takes. */
    private fun text(length: Int) = texts.getOrPut(length) { "x".repeat(length) }
    private val workspace = JsonObject(mapOf("id" to JsonPrimitive("w1"), "name" to JsonPrimitive("Orbit")))
    private fun directory(rows: Int, title: Int) = DirectorySnapshot(workspaces = listOf(workspace), sessions = mapOf("open" to
        List(rows) { JsonObject(mapOf("id" to JsonPrimitive("row-$it"), "title" to JsonPrimitive(text(title)))) }))
    private fun window(events: Int, text: Int) = Transcript(List(events) {
        RunEvent("assistant", it + 1L, JsonObject(mapOf("text" to JsonPrimitive(text(text)))))
    }, resumeSeq = events.toLong(), seeded = true)

    /** Bytes this thread allocated while [block] ran (HotSpot's per-thread counter). A bounded write still allocates a few
     * times what it measures: the stream encoder copies each long string into a scratch array, one string at a time. */
    private inline fun allocatedBy(block: () -> Unit): Long {
        val threads = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        val before = threads.currentThreadAllocatedBytes
        block()
        return threads.currentThreadAllocatedBytes - before
    }

    @Test fun aSavedListFarOverTheCapIsLeftOutWithoutEverBeingEncodedWhole() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        // 64 MiB of directory JSON; the device's was past 17M characters when its 69.7 MB buffer failed.
        val huge = directory(1024, 64 * 1024)
        val allocated = allocatedBy { SavedDirectory.write(harness.client, handle, huge) }
        // The old write allocated 2,009,400,728 bytes here: the whole record as one string.
        assertTrue("$allocated bytes allocated", allocated < 4L * cap)
        assertEquals(0, harness.data.values.values.single().size)
        assertNull(SavedDirectory.read(harness.client, handle))
    }

    /** Rows from before the list outgrew the cap are not what a launch should draw once it has. */
    @Test fun aSavedListPastTheCapTakesTheOlderCopysPlace() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        val small = directory(3, 40)
        SavedDirectory.write(harness.client, handle, small)
        assertEquals(small, SavedDirectory.read(harness.client, handle))
        SavedDirectory.write(harness.client, handle, directory(1024, 64 * 1024))
        assertNull(SavedDirectory.read(harness.client, handle))
    }

    /** An account with no workspace has nothing to draw from a copy, and its landing is the server's to decide. */
    @Test fun aSavedListWithNoWorkspaceReadsAsNone() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        SavedDirectory.write(harness.client, handle, DirectorySnapshot())
        assertNull(SavedDirectory.read(harness.client, handle))
    }

    @Test fun aRecordThatDoesNotDecodeReadsAsNone() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        harness.client.writeData(handle, DataKind.CACHE, "directory-v1", "{not json".encodeToByteArray())
        assertNull(SavedDirectory.read(harness.client, handle))
    }

    /** The saved list has a record of its own, so writing a transcript never encodes a list of thousands of sessions again. */
    @Test fun theSavedListAndTheTranscriptsAreTwoRecords() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        val small = directory(3, 40)
        val cache = RealtimeCache(lastSessionId = "s1", sessions = mapOf("s1" to window(3, 30)))
        SavedDirectory.write(harness.client, handle, small)
        RealtimeCache.write(harness.client, handle, cache)
        assertEquals(small, SavedDirectory.read(harness.client, handle))
        assertEquals(cache, RealtimeCache.read(harness.client, handle))
        assertEquals(2, harness.data.values.size)
    }

    /** The record as builds before this one wrote it: the list in it is dropped, and what it says about transcripts stays. */
    @Test fun anOlderRecordsListIsDroppedAndItsTranscriptsKept() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        val transcript = Wire.json.encodeToString(window(3, 30))
        harness.client.writeData(handle, DataKind.CACHE, "realtime-v1",
            """{"directory":{"workspaces":[{"id":"w1"}]},"lastSessionId":"s1","sessions":{"s1":$transcript}}""".encodeToByteArray())
        assertEquals(RealtimeCache(lastSessionId = "s1", sessions = mapOf("s1" to window(3, 30))), RealtimeCache.read(harness.client, handle))
        assertNull(SavedDirectory.read(harness.client, handle))
    }

    @Test fun windowsStayNewestFirstAndOneThatCannotFitIsEvictedWhole() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        // About 10 MiB on its own: more than the whole record may hold, so nothing older is evicted to make room for it.
        val cache = RealtimeCache(lastSessionId = "s3",
            sessions = mapOf("s1" to window(20, 200), "s2" to window(20, 200), "s3" to window(2_000, 5 * 1024)))
        val allocated = allocatedBy { RealtimeCache.write(harness.client, handle, cache) }
        assertTrue("$allocated bytes allocated", allocated < 4L * cap)
        val stored = harness.data.values.values.single()
        assertTrue("${stored.size} bytes stored", stored.size <= cap)
        val restored = RealtimeCache.read(harness.client, handle)
        assertEquals(cache.copy(sessions = cache.sessions - "s3"), restored)
        assertEquals(listOf("s1", "s2"), restored.sessions.keys.toList())
    }

    @Test fun windowsFillTheRecordNewestFirst() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        // Five 1.5 MiB windows fit in 8 MiB, six do not.
        val sessions = (1..8).associate { "s$it" to window(300, 5 * 1024) }
        val cache = RealtimeCache(lastSessionId = "s8", sessions = sessions)
        RealtimeCache.write(harness.client, handle, cache)
        assertTrue(harness.data.values.values.single().size <= cap)
        val restored = RealtimeCache.read(harness.client, handle)
        assertEquals(cache.copy(sessions = sessions.filterKeys { it in setOf("s4", "s5", "s6", "s7", "s8") }), restored)
        assertEquals(listOf("s4", "s5", "s6", "s7", "s8"), restored.sessions.keys.toList())
    }

    @Test fun aRecordWithinTheCapIsStoredByteForByteAsBefore() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        val cache = RealtimeCache(lastSessionId = "s1", sessions = mapOf("s2" to window(5, 30), "s1" to window(3, 30)))
        RealtimeCache.write(harness.client, handle, cache)
        assertEquals(Wire.json.encodeToString(cache), harness.data.values.values.single().decodeToString())
    }
}
