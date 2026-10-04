package io.orbitd.android.realtime

import android.app.Activity
import android.app.Application
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.LoginResponse
import io.orbitd.android.core.protocol.User
import io.orbitd.android.core.realtime.*
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkCapabilities
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class RealtimeLifecycleTest {
    @Test fun reachableTargetOnUnvalidatedNetworkConnectsAndStillStopsInBackground() = runBlocking {
        val streamOpens = AtomicInteger()
        val paths = java.util.concurrent.CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path!!.substringBefore('?')
                paths += path
                if (path == "/api/events" || path == "/api/sessions/s1/events") {
                    streamOpens.incrementAndGet()
                    return MockResponse().setHeader("Content-Type", "text/event-stream")
                        .setBody("data: {\"type\":\"ping\"}\n\n".repeat(1000))
                        .throttleBody(23, 100, java.util.concurrent.TimeUnit.MILLISECONDS)
                }
                val body = when (path) {
                    "/api/sessions/s1" -> """{"id":"s1","status":"RUNNING"}"""
                    "/api/sessions/s1/events/page" -> """{"events":[],"hasMore":false}"""
                    "/api/tasks/evidence-decisions/pending" -> """{"pending":[]}"""
                    else -> "[]"
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        // Bind and address the same family; the fixture is not listening on localhost's ::1.
        server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
        val address = ServerAddress.parse("http://127.0.0.1:${server.port}", allowLoopbackHttp = true)
        var credentials: StoredSession? = StoredSession(address.value,
            LoginResponse("fixture-access", "fixture-refresh", User("u1", "fixture@example.test", "Fixture")))
        val auth = AuthSession(OkHttpTransport(), object : CredentialStore {
            override suspend fun load() = credentials
            override suspend fun save(session: StoredSession) { credentials = session }
            override suspend fun clear() { credentials = null }
        }, object : InstanceStore {
            override suspend fun load() = address.value
            override suspend fun save(server: String) = Unit
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
            override suspend fun clearAll() = Unit
        }, "test", allowLoopbackHttp = true)
        auth.restore()
        val owner = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val store = RealtimeStore(auth, owner)
        val app = RuntimeEnvironment.getApplication()
        val connectivity = shadowOf(app.getSystemService(ConnectivityManager::class.java))
        val lifecycle = RealtimeLifecycle(app, store)
        try {
            val handle = (auth.state.value as AuthState.SignedIn).handle
            assertEquals(200, auth.request(handle, ApiRequest(listOf("workspaces"))).status)
            val network = ShadowNetwork.newInstance(101)
            val capabilities = ShadowNetworkCapabilities.newInstance()
            shadowOf(capabilities).addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            shadowOf(capabilities).removeCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            assertFalse(capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            val callback = connectivity.networkCallbacks.single()
            callback.onAvailable(network)
            callback.onCapabilitiesChanged(network, capabilities)
            store.selectSession("s1")
            lifecycle.onActivityStarted(Activity())
            withTimeoutOrNull(3000) {
                while (store.state.value.session?.connection != ConnectionState.CONNECTED || !store.state.value.directoryFresh) delay(10)
            }
            assertEquals(ConnectionState.CONNECTED, store.state.value.controlConnection)
            assertEquals(ConnectionState.CONNECTED, store.state.value.session?.connection)
            assertTrue(store.state.value.directoryFresh)
            assertTrue(streamOpens.get() >= 2)
            callback.onLost(network)
            withTimeout(3000) { while (store.state.value.controlConnection != ConnectionState.STOPPED) delay(10) }
            callback.onAvailable(network); callback.onCapabilitiesChanged(network, capabilities)
            withTimeoutOrNull(3000) { while (store.state.value.controlConnection != ConnectionState.CONNECTED) delay(10) }
            assertEquals("state=${store.state.value}, opens=${streamOpens.get()}, paths=$paths",
                ConnectionState.CONNECTED, store.state.value.controlConnection)
            lifecycle.onActivityStopped(Activity())
            withTimeout(3000) { while (store.state.value.session?.connection != ConnectionState.STOPPED) delay(10) }
        } finally {
            lifecycle.close(); store.close(); owner.cancel(); auth.logout(); server.shutdown()
        }
    }
}
