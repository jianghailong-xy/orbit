package io.orbitd.android.watch

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** The watch calls on the real wire: OkHttp through `AuthSession` to a loopback server on an ephemeral port. */
class WatchHttpTest {
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.requestUrl!!.encodedPath
                fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)
                return when {
                    path == "/api/auth/login" -> json(200, """{"accessToken":"watch-access","refreshToken":"watch-refresh","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                    path == "/api/watches" && request.requestUrl!!.query == "needsAttention=true" -> json(200, "[]")
                    path == "/api/watches" -> json(200, "[${WatchFixture.WITHDRAWN_WAKE_JSON}]")
                    path == "/api/watches/34Oaok4mTYwXssYuZtrVT/pause" -> json(409, """{"message":"a MATCHED watch cannot be paused","state":"MATCHED"}""")
                    path.startsWith("/api/watches/") -> json(404, """{"message":"Watch not found"}""")
                    else -> json(404, "{}")
                }
            }
        }
        start()
    }
    private val auth = AuthSession(OkHttpTransport(), object : CredentialStore {
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
    }, "test", allowLoopbackHttp = true)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After fun close() { scope.cancel(); runBlocking { auth.logout() }; server.shutdown() }

    private suspend fun signIn() = auth.login(ServerAddress.parse(server.url("/").toString(), allowLoopbackHttp = true), "u@example.test", "fixture-password")

    @Test fun theFourReadsCarryTheAccountsTokenAndDecodeARealRow() = runBlocking {
        val store = WatchStore(auth, signIn(), scope)
        store.load()
        val reads = requests.filter { it.requestUrl!!.encodedPath == "/api/watches" }
        assertEquals(listOf("state=ACTIVE", "state=PAUSED", null, "needsAttention=true"), reads.map { it.requestUrl!!.query })
        assertTrue(reads.all { it.method == "GET" && it.getHeader("Authorization") == "Bearer watch-access" })
        assertTrue(reads.all { it.getHeader("X-Orbit-Client") == "android/test" })
        // The same row came back from three reads and is held once, decoded as the server wrote it.
        val watch = store.state.value.watches.single()
        assertEquals("34Oaok4mTYwXssYuZtrVT", watch.id)
        assertEquals(WatchState.MATCHED, watch.state)
        assertEquals("Wake withdrawn", WatchProjection.deliveryStatus(watch))
        assertEquals(WatchGroup.HISTORY, WatchProjection.group(watch, WatchFixture.now))
    }

    @Test fun aControlPostsToItsRouteWithNoBodyAndARefusalIsReadBack() = runBlocking {
        val store = WatchStore(auth, signIn(), scope)
        store.load()
        requests.clear()
        val message = store.perform(WatchControl.PAUSE, store.state.value.watches.single())
        assertEquals("Couldn't pause the watch — a MATCHED watch cannot be paused.", message)
        val post = requests.first()
        assertEquals("POST", post.method)
        assertEquals("/api/watches/34Oaok4mTYwXssYuZtrVT/pause", post.requestUrl!!.encodedPath)
        assertEquals(0L, post.bodySize)
        // Then the list, read again — never the control again.
        assertEquals(1, requests.count { it.method == "POST" })
        assertEquals(4, requests.count { it.method == "GET" && it.requestUrl!!.encodedPath == "/api/watches" })
    }

    @Test fun aDeepLinkedIdIsFetchedOnItsOwnAndA404LeavesItUnfound() = runBlocking {
        val store = WatchStore(auth, signIn(), scope)
        val uuid = "0195c0de-0000-7000-8000-0000000000c3"
        store.fetch(uuid)
        assertEquals("/api/watches/$uuid", requests.last().requestUrl!!.encodedPath)
        assertNull(store.watch(uuid))
        assertFalse(store.state.value.unsupported)
    }
}
