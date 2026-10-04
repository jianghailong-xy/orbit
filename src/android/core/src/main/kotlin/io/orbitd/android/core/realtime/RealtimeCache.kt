package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/** One atomic record couples every replay cursor with the events it covers. A03 owns account /
 * instance hashing, private no-backup storage and logout purge. No action-bearing cards on disk. */
@Serializable
internal data class RealtimeCache(
    val schema: Int = 1,
    val directory: DirectorySnapshot? = null,
    val lastSessionId: String? = null,
    val sessions: Map<String, Transcript> = emptyMap(),
) {
    fun remember(id: String, transcript: Transcript) = copy(lastSessionId = id,
        sessions = (sessions - id + (id to transcript.withoutLive())).entries.toList().takeLast(8).associate { it.toPair() })

    companion object {
        private const val KEY = "realtime-v1"
        private const val MAX_BYTES = 8 * 1024 * 1024

        suspend fun read(auth: AuthSession, handle: SessionHandle): RealtimeCache {
            val bytes = auth.readData(handle, DataKind.CACHE, KEY) ?: return RealtimeCache()
            if (bytes.size > MAX_BYTES) return RealtimeCache()
            val cached = try { Wire.decode(bytes, serializer()) } catch (_: Exception) { return RealtimeCache() }
            if (cached.schema != 1 || cached.sessions.size > 8) return RealtimeCache()
            if (cached.sessions.values.any { t ->
                t.resumeSeq !in 0 until SENTINEL_SEQ || t.events.size > Transcript.WINDOW_SIZE ||
                    t.resumeSeq > (t.events.lastOrNull()?.seq ?: 0) ||
                    t.events.any { !it.durable } || t.events.zipWithNext().any { it.first.seq >= it.second.seq }
            }) return RealtimeCache()
            return cached.copy(sessions = cached.sessions.mapValues { it.value.withoutLive() })
        }

        suspend fun write(auth: AuthSession, handle: SessionHandle, cache: RealtimeCache) {
            var bounded = cache
            var bytes = Wire.json.encodeToString(bounded).encodeToByteArray()
            while (bytes.size > MAX_BYTES && bounded.sessions.isNotEmpty()) {
                bounded = bounded.copy(sessions = bounded.sessions - bounded.sessions.keys.first())
                bytes = Wire.json.encodeToString(bounded).encodeToByteArray()
            }
            // An unusually large directory is optional cache content, never a partial authority.
            if (bytes.size > MAX_BYTES) bytes = Wire.json.encodeToString(bounded.copy(directory = null)).encodeToByteArray()
            auth.writeData(handle, DataKind.CACHE, KEY, bytes)
        }
    }
}
