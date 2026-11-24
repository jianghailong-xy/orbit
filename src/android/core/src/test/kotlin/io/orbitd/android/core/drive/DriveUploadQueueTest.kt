package io.orbitd.android.core.drive

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** The resumable upload queue (OrbitKit DriveUploadsTests' cases): chunks, resume from what arrived, a lost connection pauses and
 * comes back, a changed file is refused, a picked folder shares one top folder, and what is kept across a restart. */
class DriveUploadQueueTest {
    private class Files(val bytes: MutableMap<String, ByteArray>) : DriveFileSource {
        override fun stat(source: String) = bytes[source]?.let { it.size.toLong() to 7L }
        override fun read(source: String, offset: Long, length: Int): ByteArray {
            val b = bytes.getValue(source)
            return b.copyOfRange(offset.toInt(), minOf(b.size, offset.toInt() + length))
        }
    }

    private class Server(val chunkSize: Int = 4) : DriveUploadTransport {
        val opened = mutableListOf<Triple<String, String?, String?>>()
        val chunks = mutableMapOf<String, MutableMap<Int, ByteArray>>()
        val completed = mutableListOf<String>()
        val abandoned = mutableListOf<String>()
        var failNext = 0
        /** Only puts of this chunk fail, while [failNext] lasts; null: any. */
        var failAt: Int? = null
        val puts = mutableListOf<Int>()
        var failWith: Exception = NetworkException()
        var hold: CompletableDeferred<Unit>? = null
        override suspend fun openUpload(parentId: String?, name: String, size: Long, relativePath: String?, dropRootId: String?): DriveUploadOpened {
            val id = "u${opened.size}"
            opened += Triple(name, relativePath, dropRootId)
            chunks[id] = mutableMapOf()
            return DriveUploadOpened(id, chunkSize, dropRootId = if (relativePath != null) dropRootId ?: "top-$id" else null)
        }
        override suspend fun uploadStatus(uploadId: String) =
            DriveUploadStatus(chunkSize, chunks.getValue(uploadId).map { DriveUploadStatus.Chunk(it.key, it.value.size.toLong()) })
        override suspend fun putChunk(uploadId: String, index: Int, bytes: ByteArray, sha256: String) {
            hold?.await()
            puts += index
            if (failNext > 0 && (failAt == null || failAt == index)) { failNext--; throw failWith }
            assertEquals(DriveUploadQueue.sha256(bytes), sha256)
            chunks.getValue(uploadId)[index] = bytes
        }
        override suspend fun completeUpload(uploadId: String): DriveEntry {
            completed += uploadId
            return DriveEntry(id = "e-$uploadId", kind = "FILE", name = uploadId)
        }
        override suspend fun abandonUpload(uploadId: String) { abandoned += uploadId }
    }

    private class Store : DriveUploadStore {
        var json: String? = null
        override fun load() = json
        override fun save(json: String) { this.json = json }
    }

    private fun TestScope.queue(server: Server, files: Files, store: Store? = null) =
        DriveUploadQueue(server, store, files, this, retryDelayMillis = 0, io = StandardTestDispatcher(testScheduler), clock = { 0 })

    private fun request(name: String, size: Long, relative: String? = null, drop: String? = null) =
        DriveUploadRequest(source = name, name = name.substringAfterLast('/'), size = size, modifiedAt = 7, parentId = "p", parentName = "Datasets",
            relativePath = relative, dropKey = drop)

    @Test fun aFileGoesUpInChunksAndCompletes() = runTest {
        val server = Server()
        val q = queue(server, Files(mutableMapOf("a.csv" to "0123456789".encodeToByteArray())))
        q.add(listOf(request("a.csv", 10)))
        advanceUntilIdle(); q.idle()
        val item = q.items.value.single()
        assertEquals(DriveUploadState.DONE, item.state)
        assertEquals("e-u0", item.entryId)
        assertEquals(listOf(0, 1, 2), server.chunks.getValue("u0").keys.sorted())
        assertEquals("89", server.chunks.getValue("u0")[2]!!.decodeToString())
        assertEquals(1, q.completedCount.value)
    }

    @Test fun aLostConnectionPausesAfterItsRetriesAndGoesOnFromWhatArrived() = runTest {
        val server = Server()
        val q = queue(server, Files(mutableMapOf("b.csv" to "abcdefghij".encodeToByteArray())))
        server.failAt = 1
        server.failNext = DriveUploadQueue.RETRIES + 1
        q.add(listOf(request("b.csv", 10)))
        advanceUntilIdle(); q.idle()
        val paused = q.items.value.single()
        assertEquals(DriveUploadState.PAUSED, paused.state)
        assertEquals(DriveUploadQueue.CONNECTION_LOST, paused.error)
        assertEquals(4L, paused.sentBytes)
        assertEquals("the first chunk, then the second tried four times", listOf(0, 1, 1, 1, 1), server.puts)
        assertTrue(q.resumeInterrupted())
        advanceUntilIdle(); q.idle()
        assertEquals(DriveUploadState.DONE, q.items.value.single().state)
        assertEquals("one upload, resumed, not opened again", 1, server.opened.size)
        assertEquals("only what had not arrived is sent again", listOf(0, 1, 1, 1, 1, 1, 2), server.puts)
        assertEquals("abcdefghij", (0..2).joinToString("") { server.chunks.getValue("u0")[it]!!.decodeToString() })
    }

    @Test fun aRefusalFailsWithTheServersWords() = runTest {
        val server = Server()
        server.failNext = 1
        server.failWith = ApiError.parse(413, """{"message":"Drive storage is full."}""".encodeToByteArray())
        val q = queue(server, Files(mutableMapOf("a.csv" to "0123".encodeToByteArray())))
        q.add(listOf(request("a.csv", 4)))
        advanceUntilIdle(); q.idle()
        assertEquals(DriveUploadState.FAILED, q.items.value.single().state)
        assertEquals("Drive storage is full.", q.items.value.single().error)
    }

    @Test fun aFileChangedSincePickedIsRefused() = runTest {
        val files = Files(mutableMapOf("a.csv" to "0123".encodeToByteArray()))
        val q = queue(Server(), files)
        files.bytes["a.csv"] = "012345".encodeToByteArray()
        q.add(listOf(request("a.csv", 4)))
        advanceUntilIdle(); q.idle()
        assertEquals("a.csv changed since it was picked. Upload it again.", q.items.value.single().error)
    }

    @Test fun aPickedFolderLandsUnderOneTopFolder() = runTest {
        val server = Server()
        val q = queue(server, Files(mutableMapOf("d/x.csv" to "1".encodeToByteArray(), "d/sub/y.csv" to "2".encodeToByteArray())))
        val drop = DriveUploadRequest.dropKey()
        q.add(listOf(request("d/x.csv", 1, "d/x.csv", drop), request("d/sub/y.csv", 1, "d/sub/y.csv", drop)))
        advanceUntilIdle(); q.idle()
        assertEquals(listOf(null, "top-u0"), server.opened.map { it.third })
        assertEquals("d/sub", DriveLogic.uploadDestination(q.items.value[1]))
    }

    @Test fun pauseCancelAndARestartKeepWhatWasLeft() = runTest {
        val server = Server()
        val store = Store()
        val files = Files(mutableMapOf("a.csv" to "01234567".encodeToByteArray(), "b.csv" to "0".encodeToByteArray()))
        val q = queue(server, files, store)
        server.hold = CompletableDeferred()
        q.add(listOf(request("a.csv", 8), request("b.csv", 1)))
        q.add(listOf(request("a.csv", 8)))
        assertEquals("the same file waiting is not added twice", 2, q.items.value.size)
        advanceUntilIdle()
        val a = q.items.value.first()
        q.pause(a.id)
        q.cancel(q.items.value[1].id)
        server.hold!!.complete(Unit); server.hold = null
        advanceUntilIdle(); q.idle()
        assertEquals(DriveUploadState.PAUSED, q.items.value.single().state)
        // The app is closed and opened again: the paused upload is still there, with its staging id.
        val again = queue(server, files, store)
        assertEquals(listOf(DriveUploadState.PAUSED), again.items.value.map { it.state })
        assertEquals("u0", again.items.value.single().uploadId)
        again.resume(again.items.value.single().id)
        advanceUntilIdle(); again.idle()
        assertEquals(DriveUploadState.DONE, again.items.value.single().state)
        assertEquals(1, server.opened.size)
        again.clearFinished()
        assertTrue(again.items.value.isEmpty())
    }

    @Test fun chunkPlansFollowWhatArrived() {
        assertEquals(3, DriveChunkPlan.chunks(10, 4).size)
        assertEquals(listOf(1), DriveChunkPlan.missing(10, 4, mapOf(0 to 4L, 2 to 2L)).map { it.index })
        assertEquals(listOf(1, 2), DriveChunkPlan.missing(10, 4, mapOf(0 to 4L, 2 to 1L)).map { it.index })
        assertEquals(6, DriveChunkPlan.arrivedBytes(10, 4, mapOf(0 to 4L, 2 to 2L)))
        assertTrue(DriveChunkPlan.chunks(0, 4).isEmpty())
    }
}
