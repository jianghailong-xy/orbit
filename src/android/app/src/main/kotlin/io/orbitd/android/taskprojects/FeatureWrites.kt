package io.orbitd.android.taskprojects

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.security.MessageDigest

/** Transport safety for direct Tasks/Projects writes; business permission stays on the server.
 * A caller's key includes the displayed revision. An ambiguous write to that revision is never
 * replayed automatically, including after Activity or process recreation. A08 owns card writes. */
class FeatureWrites(private val auth: AuthSession, private val handle: SessionHandle) {
    suspend fun execute(key: String, request: ApiRequest): JsonElement? {
        require(request.method != HttpMethod.GET)
        check(lock.tryLock()) { "Another change is being sent. Refresh before trying again." }
        var sent = false
        val fence = "task-project-write-" + MessageDigest.getInstance("SHA-256")
            .digest(key.encodeToByteArray()).joinToString("") { "%02x".format(it) }
        try {
            if (auth.readData(handle, DataKind.CACHE, fence)?.isNotEmpty() == true) throw FeatureWriteUncertain()
            auth.writeData(handle, DataKind.CACHE, fence, byteArrayOf(1))
            sent = true
            val response = auth.request(handle, request)
            val result = response.body.takeIf { it.isNotEmpty() }?.let { Wire.decode(it, JsonElement.serializer()) }
            check((result as? JsonObject)?.get("ok") != JsonPrimitive(false)) { "The server did not accept this change. Refresh to check its state." }
            auth.writeData(handle, DataKind.CACHE, fence, ByteArray(0))
            return result
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: Exception) {
            val definitive = error is ApiError && error.status in 400..499 && error.status !in setOf(408, 429)
            if (sent && definitive) auth.writeData(handle, DataKind.CACHE, fence, ByteArray(0))
            if (sent && !definitive) throw FeatureWriteUncertain(error)
            throw error
        } finally { lock.unlock() }
    }

    companion object { private val lock = Mutex() }
}

class FeatureWriteUncertain(cause: Throwable? = null) : IllegalStateException(
    "The change may have reached Orbit. Refresh and check the server record before making another change. It has not been resent.", cause)
