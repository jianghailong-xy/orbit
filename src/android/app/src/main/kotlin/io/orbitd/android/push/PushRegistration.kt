package io.orbitd.android.push

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Owns the FCM binding; failures disable notifications without failing an authenticated screen. */
class PushRegistration(
    private val session: AuthSession,
    private val storage: PushStorage,
    private val packageName: String,
    private val clearLocalNotifications: () -> Unit,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val unregisterTimeoutMillis: Long = 2_500,
) {
    private val lock = Mutex()
    @Volatile private var binding = storage.binding()
    @Volatile private var activeHandle: SessionHandle? = null
    @Volatile private var blockedHandle: SessionHandle? = null
    private var canRestoreBinding = true

    fun hasToken(token: String): Boolean = storage.token() == token

    /** Identity check is synchronous: a missed/conflated auth observation cannot accept old pushes. */
    fun activeBinding(): PushBinding? {
        val handle = (session.state.value as? AuthState.SignedIn)?.handle ?: return null
        return binding?.takeIf { activeHandle === handle && blockedHandle !== handle && matches(it, handle) }
    }

    fun accepts(registrationKey: String): Boolean = activeBinding()?.registrationKey == registrationKey

    /** Firebase onNewToken is an edge, including when the opaque string happens to be unchanged. */
    suspend fun updateToken(token: String) = safely {
        if (token.isBlank() || token.length > 4096) return@safely
        lock.withLock {
            invalidate()
            storage.setToken(token)
            registerLocked()
        }
    }

    /** Ordinary startup/resume checks do not rotate a valid key and invalidate in-flight messages. */
    suspend fun ensureRegistered() = safely { lock.withLock { registerLocked() } }

    suspend fun onAuthStateChanged() = ensureRegistered()

    /** Call before AuthSession.logout/selectServer/login. Keep this handle blocked until auth changes. */
    suspend fun beforeSignOut() = withContext(NonCancellable + dispatcher) {
        val handle = (session.state.value as? AuthState.SignedIn)?.handle
        val previous = binding?.takeIf { handle != null && matches(it, handle) }
        blockedHandle = handle
        binding = null
        clearNotifications()
        try {
            withTimeoutOrNull(unregisterTimeoutMillis) {
                lock.withLock {
                    if (handle != null && previous != null && isCurrent(handle)) {
                        session.request(handle, request("unregister", buildJsonObject {
                            put("platform", "android")
                            put("token", previous.token)
                            put("registrationKey", previous.registrationKey)
                        }.toString()))
                    }
                }
            }
        } catch (_: Exception) {
            // Logout still clears the binding offline or after an uncertain unregister response.
        } finally {
            binding = null
            try { storage.setBinding(null) } catch (_: Exception) { }
        }
    }

    private suspend fun registerLocked() {
        val state = session.state.value
        if (state is AuthState.Restoring) return
        val handle = (state as? AuthState.SignedIn)?.handle
        if (handle == null) {
            activeHandle = null
            canRestoreBinding = false
            invalidate()
            return
        }
        if (blockedHandle === handle) return
        if (activeHandle !== handle) {
            val restored = binding?.takeIf { canRestoreBinding && matches(it, handle) && it.token == storage.token() }
            canRestoreBinding = false
            activeHandle = handle
            if (restored == null) invalidate() else binding = restored
        }
        if (activeBinding() != null) return
        val token = storage.token()?.takeIf { it.isNotBlank() && it.length <= 4096 } ?: return
        val installationId = storage.installationId(handle.account.server)
        invalidate()
        val response = session.request(handle, request("register", buildJsonObject {
            put("platform", "android")
            put("token", token)
            put("bundleId", packageName)
            put("environment", "production")
            put("installationId", installationId)
        }.toString()))
        val body = Wire.json.parseToJsonElement(response.body.decodeToString()).jsonObject
        check(body["ok"]?.jsonPrimitive?.booleanOrNull == true)
        val rawKey = body["registrationKey"]?.jsonPrimitive?.takeIf { it.isString } ?: return
        val key = rawKey.content
        check(UUID.fromString(key).toString().equals(key, ignoreCase = true))
        // AuthSession fences HTTP, and this second check also covers our pre-logout blocking window.
        if (!isCurrent(handle) || blockedHandle === handle) return
        val next = PushBinding(handle.account.server, handle.account.userId, token, key)
        storage.setBinding(next)
        if (!isCurrent(handle) || blockedHandle === handle) {
            storage.setBinding(null)
            return
        }
        binding = next
    }

    private fun invalidate() {
        binding = null
        clearNotifications()
        storage.setBinding(null)
    }

    private fun clearNotifications() {
        try { clearLocalNotifications() } catch (_: Exception) { }
    }

    private fun isCurrent(handle: SessionHandle) = (session.state.value as? AuthState.SignedIn)?.handle === handle
    private fun matches(value: PushBinding, handle: SessionHandle) =
        value.server == handle.account.server && value.accountId == handle.account.userId

    private fun request(operation: String, body: String) = ApiRequest(
        listOf("push", operation), HttpMethod.POST, body = body.encodeToByteArray(), maxResponseBytes = 16_384,
    )

    private suspend fun safely(block: suspend () -> Unit) = withContext(dispatcher) {
        try { block() } catch (_: CancellationException) {
            // Superseded AuthSession work is expected; cancellation of our own caller still propagates.
            currentCoroutineContext().ensureActive()
        } catch (_: Exception) {
            // An uncertain register is retried by the next token/login/foreground/network trigger.
        }
    }
}
