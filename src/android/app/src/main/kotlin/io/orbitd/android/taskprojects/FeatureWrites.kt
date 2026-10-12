package io.orbitd.android.taskprojects

import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.ConnectionState
import io.orbitd.android.core.realtime.RealtimeState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.*
import java.security.MessageDigest

/** Transport safety for direct Tasks/Projects writes; business permission stays on the server.
 * A caller's key includes the displayed revision. An ambiguous write is never replayed
 * automatically, and the same press is refused for [FENCE_MS] afterwards, across Activity and
 * process recreation, so a double press cannot repeat a comment or a replacement. A08 owns card writes.
 * `writable` is read at the moment of sending, not from a composed frame: a page drawn while the
 * account stream was live must not send after the device went offline. */
class FeatureWrites(private val auth: AuthSession, private val handle: SessionHandle, private val writable: () -> Boolean = { true },
    private val clock: () -> Long = System::currentTimeMillis) {
    /** `resends` > 0 only for a request the server answers by its own name (a Run's `triggerId`):
     * the same bytes are sent again after a lost answer or while the first delivery still holds the
     * lease, and the server answers them from the first delivery's receipt (`executeTask`). */
    suspend fun execute(key: String, request: ApiRequest, resends: Int = 0): JsonElement? {
        require(request.method != HttpMethod.GET)
        if (!writable()) throw FeatureWriteRefused()
        check(lock.tryLock()) { "Another change is being sent. Refresh before trying again." }
        var sent = false
        val fence = "task-project-write-" + MessageDigest.getInstance("SHA-256")
            .digest(key.encodeToByteArray()).joinToString("") { "%02x".format(it) }
        try {
            // The same press is held for a minute after an unknown answer: long enough for the page's
            // own re-read to show whether it landed, never a lock that outlives a refresh.
            val since = auth.readData(handle, DataKind.CACHE, fence)?.takeIf { it.size == 8 }?.let { java.nio.ByteBuffer.wrap(it).long }
            if (since != null && clock() - since in 0 until FENCE_MS) throw FeatureWriteUncertain()
            auth.writeData(handle, DataKind.CACHE, fence, java.nio.ByteBuffer.allocate(8).putLong(clock()).array())
            sent = true
            var attempt = 0
            var response: ApiResponse? = null
            while (response == null) {
                try { response = auth.request(handle, request) }
                catch (cancel: CancellationException) { throw cancel }
                catch (error: Exception) {
                    val inProgress = error is ApiError && error.status == 409 && error.code == "TASK_RUN_REQUEST_IN_PROGRESS"
                    if (attempt >= resends || (error is ApiError && !inProgress)) throw error
                    delay(250L shl attempt++)
                }
            }
            val result = response.body.takeIf { it.isNotEmpty() }?.let { Wire.decode(it, JsonElement.serializer()) }
            check((result as? JsonObject)?.get("ok") != JsonPrimitive(false)) { "The server did not accept this change. Refresh to check its state." }
            auth.writeData(handle, DataKind.CACHE, fence, ByteArray(0))
            return result
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (error: Exception) {
            val definitive = error is ApiError && error.status in 400..499 && error.status !in setOf(408, 429) &&
                error.code != "TASK_RUN_REQUEST_IN_PROGRESS"
            if (sent && definitive) auth.writeData(handle, DataKind.CACHE, fence, ByteArray(0))
            if (sent && !definitive) throw FeatureWriteUncertain(error)
            throw error
        } finally { lock.unlock() }
    }

    companion object {
        private val lock = Mutex()
        const val FENCE_MS = 60_000L
    }
}

/** The account stream decides whether a page may write: this handle, signed in, in the foreground
 * with a network and its control stream connected — the stream that brings another device's change
 * here. Not `directoryFresh`: every control event withdraws that for one directory read, which would
 * make each button blink off on an unrelated event. Offline, backgrounded or reconnecting: no write. */
fun writable(state: RealtimeState, handle: SessionHandle, signedIn: SessionHandle?): Boolean =
    signedIn === handle && state.handle === handle && state.controlConnection == ConnectionState.CONNECTED

/** The same answer read from the process's live stores at the moment of the press. */
fun OrbitApplication.canWrite(handle: SessionHandle): Boolean =
    writable(realtime.state.value, handle, (session.state.value as? AuthState.SignedIn)?.handle)

fun OrbitApplication.featureWrites(handle: SessionHandle) = FeatureWrites(session, handle, writable = { canWrite(handle) })

class FeatureWriteUncertain(cause: Throwable? = null) : IllegalStateException(
    "The change may have reached Orbit. Refresh and check the server record before making another change. It has not been resent.", cause)

class FeatureWriteRefused : IllegalStateException("Reconnecting to Orbit. Changes are unavailable until the current state is read.")
