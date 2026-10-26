package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.Harness
import io.orbitd.android.core.protocol.Wire
import java.lang.management.ManagementFactory
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A04c: an owner's directory of thousands of sessions was encoded into one string before its size was checked, and that
 * 69.7 MB allocation crashed a release build. A write may hold no more than the record's own cap, whatever it is given. */
class RealtimeCacheTest {
    private val cap = 8 * 1024 * 1024 // The record's 8 MiB (docs/realtime.md).
    private val texts = mutableMapOf<Int, String>()
    /** One string per length, shared by every row and event that uses it: the encoded snapshot can be far larger than the heap it takes. */
    private fun text(length: Int) = texts.getOrPut(length) { "x".repeat(length) }
    private fun directory(rows: Int, title: Int) = DirectorySnapshot(sessions = mapOf("completed" to
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

    @Test fun aDirectoryFarOverTheCapIsLeftOutWithoutEverBeingEncodedWhole() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        // 64 MiB of directory JSON; the device's was past 17M characters when its 69.7 MB buffer failed.
        val cache = RealtimeCache(directory = directory(1024, 64 * 1024), lastSessionId = "s2",
            sessions = mapOf("s1" to window(20, 200), "s2" to window(20, 200)))
        val allocated = allocatedBy { RealtimeCache.write(harness.client, handle, cache) }
        // The old write allocated 2,009,400,728 bytes here: the whole record as one string, again for each window it evicted.
        assertTrue("$allocated bytes allocated", allocated < 4L * cap)
        val stored = harness.data.values.values.single()
        assertTrue("${stored.size} bytes stored", stored.size <= cap)
        assertEquals(cache.copy(directory = null), RealtimeCache.read(harness.client, handle))
    }

    @Test fun windowsStayNewestFirstAndOneThatCannotFitIsEvictedWhole() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        // About 10 MiB on its own: more than the whole record may hold, so nothing older is evicted to make room for it.
        val cache = RealtimeCache(directory = directory(10, 100), lastSessionId = "s3",
            sessions = mapOf("s1" to window(20, 200), "s2" to window(20, 200), "s3" to window(2_000, 5 * 1024)))
        val allocated = allocatedBy { RealtimeCache.write(harness.client, handle, cache) }
        assertTrue("$allocated bytes allocated", allocated < 4L * cap)
        val stored = harness.data.values.values.single()
        assertTrue("${stored.size} bytes stored", stored.size <= cap)
        val restored = RealtimeCache.read(harness.client, handle)
        assertEquals(cache.copy(sessions = cache.sessions - "s3"), restored)
        assertEquals(listOf("s1", "s2"), restored.sessions.keys.toList())
    }

    @Test fun windowsFillWhatTheDirectoryLeavesNewestFirst() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        // A 1 MiB directory leaves room for four 1.5 MiB windows (7 of 8 MiB) but not five (8.5).
        val sessions = (1..8).associate { "s$it" to window(300, 5 * 1024) }
        val cache = RealtimeCache(directory = directory(10, 100 * 1024), lastSessionId = "s8", sessions = sessions)
        RealtimeCache.write(harness.client, handle, cache)
        assertTrue(harness.data.values.values.single().size <= cap)
        val restored = RealtimeCache.read(harness.client, handle)
        assertEquals(cache.copy(sessions = sessions.filterKeys { it in setOf("s5", "s6", "s7", "s8") }), restored)
        assertEquals(listOf("s5", "s6", "s7", "s8"), restored.sessions.keys.toList())
    }

    @Test fun aRecordWithinTheCapIsStoredByteForByteAsBefore() = runTest {
        val harness = Harness(this)
        val handle = harness.seed()
        val cache = RealtimeCache(directory = directory(3, 40), lastSessionId = "s1",
            sessions = mapOf("s2" to window(5, 30), "s1" to window(3, 30)))
        RealtimeCache.write(harness.client, handle, cache)
        assertEquals(Wire.json.encodeToString(cache), harness.data.values.values.single().decodeToString())
    }
}
