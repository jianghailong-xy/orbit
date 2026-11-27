package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.protocol.Wire
import java.util.WeakHashMap
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

@Serializable
data class ReadingAccess(val revision: Long = 0, val denied: Boolean = false)

/** One revocation marker for every record bookmark of a session, inside A03's account namespace.
 * Old bytes may remain on disk, but their revision can never restore or overwrite a newer lease. */
class ReadingCache(private val auth: AuthSession, private val handle: SessionHandle, session: String) {
    private val accessKey = "session-reading-access-$session"
    private suspend fun access() = auth.readData(handle, DataKind.CACHE, accessKey)
        ?.let { Wire.decode(it, ReadingAccess.serializer()) } ?: ReadingAccess()
    private suspend fun set(value: ReadingAccess): ReadingAccess {
        auth.writeData(handle, DataKind.CACHE, accessKey, Wire.json.encodeToString(value).encodeToByteArray())
        return value
    }
    suspend fun permission() = lock.withLock { access() }
    suspend fun read(key: String) = lock.withLock {
        val access = access()
        access to if (access.denied) null else auth.readData(handle, DataKind.CACHE, key)
    }
    suspend fun revoke() = lock.withLock {
        val access = access()
        if (access.denied) access else set(ReadingAccess(access.revision + 1, true))
    }
    suspend fun authorize(revision: Long) = lock.withLock {
        val access = access()
        if (access.revision == revision && access.denied) set(access.copy(denied = false)) else access
    }
    suspend fun valid(revision: Long) = lock.withLock { access() == ReadingAccess(revision) }
    suspend fun write(key: String, revision: Long, bytes: ByteArray) = lock.withLock {
        if (access() == ReadingAccess(revision)) auth.writeData(handle, DataKind.CACHE, key, bytes)
    }
    private val lock = lockFor(auth)

    companion object {
        // Serializes marker checks and writes across route instances, including late close saves: one lock per AuthSession, whose
        // disk namespace holds the markers. Not one for the process: a step that never resumes (in Robolectric, a resume the main
        // looper's reset dropped as its test ended) then held every later AuthSession's readers, and their stores, with it.
        private val locks = WeakHashMap<AuthSession, Mutex>()
        private fun lockFor(auth: AuthSession) = synchronized(locks) { locks.getOrPut(auth) { Mutex() } }
    }
}
