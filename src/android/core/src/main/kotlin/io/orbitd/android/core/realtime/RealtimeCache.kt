package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.protocol.Wire
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.encodeToStream

/** One atomic record couples every replay cursor with the events it covers. A03 owns account /
 * instance hashing, private no-backup storage and logout purge. No action-bearing cards on disk. */
@Serializable
internal data class RealtimeCache(
    val schema: Int = 1,
    val lastSessionId: String? = null,
    val sessions: Map<String, Transcript> = emptyMap(),
) {
    fun remember(id: String, transcript: Transcript) = copy(lastSessionId = id,
        sessions = (sessions - id + (id to transcript.withoutLive())).entries.toList().takeLast(8).associate { it.toPair() })

    companion object {
        private const val KEY = "realtime-v1"
        private const val MAX_BYTES = 8 * 1024 * 1024

        /** [context] is where the record is decoded, and [write]'s where it is encoded: the application's store runs on the main
         * thread and passes another. */
        suspend fun read(auth: AuthSession, handle: SessionHandle, context: CoroutineContext = EmptyCoroutineContext): RealtimeCache {
            val bytes = auth.readData(handle, DataKind.CACHE, KEY) ?: return RealtimeCache()
            if (bytes.size > MAX_BYTES) return RealtimeCache()
            val cached = try { withContext(context) { Wire.decode(bytes, serializer()) } }
                catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { return RealtimeCache() }
            if (cached.schema != 1 || cached.sessions.size > 8) return RealtimeCache()
            if (cached.sessions.values.any { t ->
                t.resumeSeq !in 0 until SENTINEL_SEQ || t.events.size > Transcript.WINDOW_SIZE ||
                    t.resumeSeq > (t.events.lastOrNull()?.seq ?: 0) ||
                    t.events.any { !it.durable } || t.events.zipWithNext().any { it.first.seq >= it.second.seq }
            }) return RealtimeCache()
            return cached.copy(sessions = cached.sessions.mapValues { it.value.withoutLive() })
        }

        suspend fun write(auth: AuthSession, handle: SessionHandle, cache: RealtimeCache, context: CoroutineContext = EmptyCoroutineContext) {
            val bytes = withContext(context) { encode(cache) }
            auth.writeData(handle, DataKind.CACHE, KEY, bytes)
        }

        /**
         * The record as stored, at most MAX_BYTES, and making it never encodes more than that into memory (A04c: an owner's
         * directory of thousands of sessions, encoded whole before its size was checked, was a 69.7 MB allocation that crashed
         * a release build). Each part is first measured by an encoder that is stopped once it passes the room left, keeping no
         * bytes; only parts that fit are encoded. Session windows go newest first, each kept whole or not at all; one that cannot
         * fit in what is left is evicted, and older ones that still fit stay.
         */
        @OptIn(ExperimentalSerializationApi::class)
        private fun encode(cache: RealtimeCache): ByteArray {
            var room = MAX_BYTES
            // A part measured as a record of its own is a few bytes more than it adds to the whole, so what is kept fits.
            fun fits(part: RealtimeCache) = size(part, room)?.let { room -= it } != null
            fits(RealtimeCache(lastSessionId = cache.lastSessionId))
            val kept = mutableSetOf<String>()
            for ((id, window) in cache.sessions.entries.reversed()) if (fits(RealtimeCache(sessions = mapOf(id to window)))) kept += id
            val out = ByteArrayOutputStream(MAX_BYTES - room)
            Wire.json.encodeToStream(serializer(), cache.copy(sessions = cache.sessions.filterKeys { it in kept }), out)
            return out.toByteArray()
        }

        /** The bytes [part] encodes to, or null once they pass [limit]: the encoder is stopped there, and nothing is kept. */
        @OptIn(ExperimentalSerializationApi::class)
        private fun size(part: RealtimeCache, limit: Int): Int? {
            val counter = Counter(limit)
            return try { Wire.json.encodeToStream(serializer(), part, counter); counter.count } catch (_: Counter.Full) { null }
        }
    }
}

/**
 * What a launch draws before any read has landed (iOS `LaunchSnapshot`): the workspaces, their folders and tags, the runners and the Open
 * list, as they were when the app last left the foreground. A record of its own, so a transcript's write never rewrites it. Nothing here
 * is an answer: the launch's own reads replace it. A copy that lists no workspace is no copy, so an empty account's landing is only
 * ever decided by a read. One past the cap is not kept, and that launch waits for its first read.
 */
internal object SavedDirectory {
    private const val KEY = "directory-v1"
    private const val MAX_BYTES = 8 * 1024 * 1024

    suspend fun read(auth: AuthSession, handle: SessionHandle, context: CoroutineContext = EmptyCoroutineContext): DirectorySnapshot? {
        val bytes = auth.readData(handle, DataKind.CACHE, KEY) ?: return null
        if (bytes.size > MAX_BYTES) return null
        return try { withContext(context) { Wire.decode(bytes, DirectorySnapshot.serializer()) } }
            catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
            ?.takeIf { it.workspaces.isNotEmpty() }
    }

    suspend fun write(auth: AuthSession, handle: SessionHandle, snapshot: DirectorySnapshot, context: CoroutineContext = EmptyCoroutineContext) {
        // An empty record reads as none and takes the older copy's place, so a list past the cap never brings back rows from before it.
        val bytes = withContext(context) { encode(snapshot) } ?: ByteArray(0)
        auth.writeData(handle, DataKind.CACHE, KEY, bytes)
    }

    /** The record, or null when it is past the cap: measured first by an encoder that stops there and keeps nothing (A04c). */
    @OptIn(ExperimentalSerializationApi::class)
    private fun encode(snapshot: DirectorySnapshot): ByteArray? {
        val counter = Counter(MAX_BYTES)
        try { Wire.json.encodeToStream(DirectorySnapshot.serializer(), snapshot, counter) } catch (_: Counter.Full) { return null }
        val out = ByteArrayOutputStream(counter.count)
        Wire.json.encodeToStream(DirectorySnapshot.serializer(), snapshot, out)
        return out.toByteArray()
    }
}

private class Counter(private val limit: Int) : OutputStream() {
    class Full : RuntimeException(null, null, false, false)
    var count = 0
        private set
    override fun write(b: Int) = add(1)
    override fun write(b: ByteArray, off: Int, len: Int) = add(len)
    private fun add(bytes: Int) {
        count += bytes
        if (count > limit) throw Full()
    }
}
