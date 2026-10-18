package io.orbitd.android.core.auth

import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.net.HttpRequest
import io.orbitd.android.core.net.HttpTransport
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.GoogleExchangeRequest
import io.orbitd.android.core.protocol.LoginRequest
import io.orbitd.android.core.protocol.LoginResponse
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.RefreshRequest
import io.orbitd.android.core.protocol.SignInMethods
import io.orbitd.android.core.protocol.User
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.OkHttpEventTransport
import io.orbitd.android.core.realtime.SseFrame
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString

/** How many times `signInMethods` sends its request through network failures. */
private const val METHODS_ATTEMPTS = 3
/** How many times `restore` reads storage through failures that may pass, and how long it waits between reads. */
private const val RESTORE_ATTEMPTS = 3
private const val RESTORE_RETRY_MS = 200L

/** This failure's class and its causes', and never a message: a message can quote what was being read. */
private fun Throwable.classes() = generateSequence(this) { it.cause }.take(8).joinToString(" < ") { it.javaClass.name }

/** Identity, not value equality: logging in again as the same user still invalidates old work. */
class SessionHandle internal constructor(val account: AccountKey)
class SessionChanged : CancellationException("The login session changed")
enum class SignOutReason { USER, SWITCHED, EXPIRED, STORAGE }

sealed interface AuthState {
    data object Restoring : AuthState
    data class SignedOut(val server: ServerAddress?, val reason: SignOutReason? = null) : AuthState
    data class SigningIn(val server: ServerAddress) : AuthState
    data class SignedIn(val handle: SessionHandle, val user: User) : AuthState
}

/** Shared by directory, session and business pages; capture a handle before starting work. */
interface OrbitApi {
    suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse
}

class AuthSession(
    private val transport: HttpTransport,
    private val credentials: CredentialStore,
    private val instances: InstanceStore,
    private val data: SessionDataStore,
    private val clientVersion: String,
    private val allowLoopbackHttp: Boolean = false,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val eventTransport: EventTransport = OkHttpEventTransport(),
    private val emails: EmailStore? = null,
    /** Diagnostics without values: which way a restore went, and the classes of what failed. */
    private val log: (String) -> Unit = {},
) : OrbitApi {
    private class Epoch(val server: ServerAddress, dispatcher: CoroutineDispatcher) {
        val job = SupervisorJob()
        val scope = CoroutineScope(job + dispatcher)
        var handle: SessionHandle? = null
        var tokens: LoginResponse? = null
        var version = 0L
        var refreshing: Pair<Long, Deferred<LoginResponse>>? = null
    }

    private val lock = Mutex()
    private val revocations = CoroutineScope(SupervisorJob() + dispatcher)
    private val mutableState = MutableStateFlow<AuthState>(AuthState.Restoring)
    val state: StateFlow<AuthState> = mutableState.asStateFlow()
    private var epoch: Epoch? = null
    private var initialized = false

    init { require(clientVersion.matches(Regex("[A-Za-z0-9.+-]{1,32}"))) }

    /**
     * Signs the stored session in. A stored session that can never be read again is retired: credentials and account data
     * are cleared. A storage failure that may pass is read again; if it persists, this launch starts signed out but deletes
     * nothing, so the next launch restores it, as iOS's Keychain read that fails only returns nil.
     */
    suspend fun restore() = withContext(NonCancellable) {
        lock.withLock {
            if (initialized) return@withLock
            initialized = true
            var server: ServerAddress? = null
            for (attempt in 1..RESTORE_ATTEMPTS) {
                try {
                    server = instances.load()?.let { ServerAddress.parse(it, allowLoopbackHttp) }
                    val stored = credentials.load()
                    if (stored == null) {
                        data.clearAll()
                        mutableState.value = AuthState.SignedOut(server)
                        log("restore: no stored session")
                    } else {
                        val savedServer = ServerAddress.parse(stored.server, allowLoopbackHttp)
                        if (server != null && server != savedServer) throw SecureStorageException(unrecoverable = true)
                        server = savedServer
                        instances.save(savedServer.value)
                        val next = Epoch(savedServer, dispatcher)
                        epoch = next
                        activateLocked(next, stored.credentials)
                        log("restore: stored session restored on attempt $attempt")
                    }
                    return@withLock
                } catch (error: Exception) {
                    if (error !is SecureStorageException || error.unrecoverable) {
                        log("restore: stored session can never be read (${error.classes()}); " +
                            "signed out, credentials and account data cleared")
                        retireLocked(server, SignOutReason.STORAGE)
                        return@withLock
                    }
                    if (attempt == RESTORE_ATTEMPTS) {
                        log("restore: storage unreadable after $attempt attempts (${error.classes()}); " +
                            "signed out, stored session and account data kept for the next launch")
                        mutableState.value = AuthState.SignedOut(server, SignOutReason.STORAGE)
                    } else {
                        log("restore: attempt $attempt of $RESTORE_ATTEMPTS failed (${error.classes()}); " +
                            "reading again in $RESTORE_RETRY_MS ms")
                        delay(RESTORE_RETRY_MS)
                    }
                }
            }
        }
    }

    suspend fun selectServer(server: ServerAddress) = withContext(NonCancellable) {
        lock.withLock {
            initialized = true
            retireLocked(server, SignOutReason.SWITCHED)
            instances.save(server.value)
        }
    }

    /** Public: what [server]'s login page offers (docs/google-sign-in-design.md §6). Older servers answer 404. */
    suspend fun signInMethods(server: ServerAddress): SignInMethods {
        val request = HttpRequest(server, ApiRequest(listOf("auth", "methods")), clientVersion)
        var failures = 0
        while (true) {
            val response = try {
                transport.execute(request)
            } catch (error: NetworkException) {
                // The transport never retries, and a pooled connection the server has since closed fails
                // once when reused. This request carries no credential and changes nothing: send it again.
                if (++failures == METHODS_ATTEMPTS) throw error
                continue
            }
            return Wire.decode(response.requireSuccess().body, SignInMethods.serializer())
        }
    }

    /** The email the last successful password sign-in on [server] used, for its login page; null when there is none. */
    suspend fun rememberedEmail(server: ServerAddress): String? =
        try { emails?.load(server.value) } catch (_: SecureStorageException) { null }

    /** Also switches accounts: old requests/data are invalidated before the login leaves the device. */
    suspend fun login(server: ServerAddress, email: String, password: String): SessionHandle =
        signIn(server, listOf("login"), Wire.json.encodeToString(LoginRequest(email, password)), email)

    /**
     * The last step of a Google sign-in (§4.3): its callback's one-time ticket and the verifier only
     * this process holds, for the same session `login` answers with. Switches accounts as `login` does.
     */
    suspend fun loginWithGoogleTicket(server: ServerAddress, ticket: String, codeVerifier: String): SessionHandle =
        signIn(server, listOf("google", "exchange"), Wire.json.encodeToString(GoogleExchangeRequest(ticket, codeVerifier)))

    private suspend fun signIn(server: ServerAddress, operation: List<String>, body: String, email: String? = null): SessionHandle {
        val next = withContext(NonCancellable) {
            lock.withLock {
                initialized = true
                retireLocked(server, SignOutReason.SWITCHED)
                Epoch(server, dispatcher).also {
                    epoch = it
                    mutableState.value = AuthState.SigningIn(server)
                }
            }
        }
        try {
            return owned(next) {
                val response = sendPublic(next.server, operation, body)
                val tokens = Wire.decode(response.requireSuccess().body, LoginResponse.serializer())
                lock.withLock {
                    requireCurrent(next)
                    // Only what signed in is remembered, so a mistyped server or email never sticks (iOS fdeb033ad).
                    instances.save(server.value)
                    credentials.save(StoredSession(server.value, tokens))
                    // The prefill is a convenience: a store that fails costs it, never the sign-in.
                    if (email != null) try { emails?.save(server.value, email) } catch (_: SecureStorageException) {}
                    activateLocked(next, tokens)
                }
            }
        } catch (error: Exception) {
            withContext(NonCancellable) {
                lock.withLock {
                    if (epoch === next) retireLocked(server, if (error is SecureStorageException) SignOutReason.STORAGE else null)
                }
            }
            throw error
        }
    }

    suspend fun logout() = withContext(NonCancellable) {
        lock.withLock {
            initialized = true
            retireLocked(currentServer(), SignOutReason.USER)
        }
    }

    override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
        val current = lock.withLock { current(handle) }
        return owned(current) {
            val (first, version) = lock.withLock {
                requireCurrent(current)
                current.tokens!! to current.version
            }
            var response = transport.execute(HttpRequest(current.server, request, clientVersion, first.accessToken))
            lock.withLock { requireCurrent(current) }
            if (response.status == 401) {
                refresh(current, version)
                val (fresh, retryVersion) = lock.withLock {
                    requireCurrent(current)
                    current.tokens!! to current.version
                }
                response = transport.execute(HttpRequest(current.server, request, clientVersion, fresh.accessToken))
                withContext(NonCancellable) {
                    lock.withLock {
                        requireCurrent(current)
                        // A delayed rejection of an older retry cannot clear a newer rotation.
                        if (response.status == 401 && current.version == retryVersion) {
                            retireLocked(current.server, SignOutReason.EXPIRED)
                            throw SessionChanged()
                        }
                    }
                }
            }
            lock.withLock { requireCurrent(current) }
            response.requireSuccess()
        }
    }

    suspend fun readData(handle: SessionHandle, kind: DataKind, key: String): ByteArray? = lock.withLock {
        current(handle)
        data.read(handle.account, kind, key)
    }

    suspend fun writeData(handle: SessionHandle, kind: DataKind, key: String, bytes: ByteArray) = lock.withLock {
        current(handle)
        data.write(handle.account, kind, key, bytes)
    }

    /** Streams share the REST epoch and refresh flight; credentials never leave this boundary. */
    suspend fun stream(handle: SessionHandle, request: ApiRequest,
        onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
        val current = lock.withLock { current(handle) }
        owned(current) {
            var opened = false
            suspend fun consume(token: String) = eventTransport.stream(
                HttpRequest(current.server, request, clientVersion, token),
                { lock.withLock { requireCurrent(current) }; opened = true; onOpen() },
                { frame -> lock.withLock { requireCurrent(current) }; onFrame(frame) },
            )
            val (first, version) = lock.withLock {
                requireCurrent(current)
                current.tokens!! to current.version
            }
            try { consume(first.accessToken) } catch (error: ApiError) {
                if (opened || error.status != 401) throw error
                refresh(current, version)
                val (fresh, retryVersion) = lock.withLock {
                    requireCurrent(current)
                    current.tokens!! to current.version
                }
                try { consume(fresh.accessToken) } catch (retry: ApiError) {
                    withContext(NonCancellable) {
                        lock.withLock {
                            requireCurrent(current)
                            if (!opened && retry.status == 401 && current.version == retryVersion) {
                                retireLocked(current.server, SignOutReason.EXPIRED)
                                throw SessionChanged()
                            }
                        }
                    }
                    throw retry
                }
            }
            lock.withLock { requireCurrent(current) }
        }
    }

    private suspend fun refresh(current: Epoch, rejectedVersion: Long): LoginResponse {
        val flight = lock.withLock {
            requireCurrent(current)
            // A delayed 401 for a previous access token reuses the already committed rotation.
            if (current.version != rejectedVersion) return current.tokens!!
            current.refreshing?.takeIf { it.first == rejectedVersion }?.second
                ?: current.scope.async(start = CoroutineStart.LAZY) { rotate(current) }.also {
                    current.refreshing = rejectedVersion to it
                    it.start()
                }
        }
        // This flight belongs to the session, not to any one waiting page/request.
        return flight.await()
    }

    private suspend fun rotate(current: Epoch): LoginResponse {
        try {
            val old = lock.withLock { requireCurrent(current); current.tokens!! }
            val response = sendPublic(current.server, listOf("refresh"), Wire.json.encodeToString(RefreshRequest(old.refreshToken)))
            val fresh = Wire.decode(response.requireSuccess().body, LoginResponse.serializer())
            if (fresh.user.id != old.user.id || fresh.refreshToken == old.refreshToken) throw ProtocolException()
            return lock.withLock {
                requireCurrent(current)
                credentials.save(StoredSession(current.server.value, fresh))
                current.tokens = fresh
                current.version++
                mutableState.value = AuthState.SignedIn(current.handle!!, fresh.user)
                fresh
            }
        } catch (error: Exception) {
            withContext(NonCancellable) {
                lock.withLock {
                    if (epoch === current) retireLocked(current.server, SignOutReason.EXPIRED)
                }
            }
            // Even a lost refresh response can have consumed the token: never replay it.
            throw error
        }
    }

    private suspend fun sendPublic(server: ServerAddress, operation: List<String>, body: String): ApiResponse =
        transport.execute(HttpRequest(server, ApiRequest(listOf("auth") + operation, HttpMethod.POST,
            body = body.encodeToByteArray()), clientVersion))

    private fun activateLocked(current: Epoch, tokens: LoginResponse): SessionHandle {
        val handle = SessionHandle(AccountKey(current.server.value, tokens.user.id))
        current.tokens = tokens
        current.handle = handle
        mutableState.value = AuthState.SignedIn(handle, tokens.user)
        return handle
    }

    /** Runs under the lock with cancellation masked, so a half-cleared session cannot be restored. */
    private suspend fun retireLocked(server: ServerAddress?, reason: SignOutReason?) {
        val old = epoch
        epoch = null
        mutableState.value = AuthState.SignedOut(server, reason)
        old?.job?.cancel(SessionChanged())
        val oldRefresh = old?.tokens?.refreshToken
        old?.tokens = null
        old?.refreshing = null
        if (old != null && oldRefresh != null) revocations.launch {
            withTimeoutOrNull(5_000) {
                try { sendPublic(old.server, listOf("logout"), Wire.json.encodeToString(RefreshRequest(oldRefresh))) }
                catch (_: Exception) { /* Local logout is authoritative when offline. */ }
            }
        }
        try { credentials.clear() } finally { data.clearAll() }
    }

    private fun currentServer(): ServerAddress? = epoch?.server ?: when (val value = state.value) {
        is AuthState.SignedOut -> value.server
        else -> null
    }

    private fun current(handle: SessionHandle): Epoch = epoch?.takeIf { it.handle === handle }
        ?: throw SessionChanged()

    private fun requireCurrent(current: Epoch) {
        if (epoch !== current) throw SessionChanged()
    }

    private suspend fun <T> owned(current: Epoch, block: suspend () -> T): T {
        val work = current.scope.async { block() }
        try { return work.await() } finally { work.cancel() }
    }
}
