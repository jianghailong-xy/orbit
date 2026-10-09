package io.orbitd.android.reader

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import java.util.concurrent.CopyOnWriteArrayList

/** A signed-in account over a controlled `/api` for reader tests: every request is recorded and answered by [respond]. */
internal class FakeReaderServer {
    val calls = CopyOnWriteArrayList<ApiRequest>()
    @Volatile var respond: (ApiRequest) -> ApiResponse = { ApiResponse(200, "[]".encodeToByteArray()) }

    val auth = AuthSession(HttpTransport { request ->
        val api = request.api
        if (api.path == listOf("auth", "login")) return@HttpTransport ApiResponse(200,
            """{"accessToken":"reader-access","refreshToken":"reader-refresh","user":{"id":"u1","email":"a@example.test","name":"A"}}""".encodeToByteArray())
        calls += api
        respond(api)
    }, object : CredentialStore {
        private var saved: StoredSession? = null
        override suspend fun load() = saved
        override suspend fun save(session: StoredSession) { saved = session }
        override suspend fun clear() { saved = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) {}
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
        override suspend fun clearAll() {}
    }, "test", dispatcher = Dispatchers.Unconfined, eventTransport = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) = awaitCancellation()
    })

    suspend fun signIn(): SessionHandle = auth.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "fixture-password")

    companion object {
        /** A small real PNG (2×2), so the platform decoder has something to decode. */
        val png: ByteArray = java.util.Base64.getDecoder().decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4oaEBRAwQCgAhLgRhHuBtwgAAAABJRU5ErkJggg==")
    }
}
