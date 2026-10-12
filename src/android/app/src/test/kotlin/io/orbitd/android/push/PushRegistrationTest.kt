package io.orbitd.android.push

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class PushRegistrationTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun registrationAndUnregisterUseAuthenticatedBackendWireAndActualPackage() = runTest {
        MockWebServer().use { server ->
            server.start()
            server.enqueue(MockResponse().setBody(login))
            val key = UUID.randomUUID().toString()
            server.enqueue(MockResponse().setBody(registered(key)))
            server.enqueue(MockResponse().setBody("{\"ok\":true}"))
            val session = session(OkHttpTransport())
            val address = ServerAddress.parse(server.url("/").toString(), allowLoopbackHttp = true)
            session.login(address, "fixture@example.test", "password")
            var cleared = 0
            val storage = PushStorage(temporary.newFolder())
            val registration = PushRegistration(session, storage, "io.orbitd.android.debug", { cleared++ })
            registration.updateToken(token)
            assertTrue(registration.accepts(key))
            registration.ensureRegistered()
            registration.ensureRegistered()
            assertEquals("Valid foreground checks must not rotate the key", 2, server.requestCount)
            registration.beforeSignOut()
            assertNull(registration.activeBinding())
            assertNull(storage.binding())
            registration.ensureRegistered()
            assertEquals("The pre-logout gap must stay blocked", 3, server.requestCount)
            assertTrue(cleared > 0)

            server.takeRequest()
            val register = server.takeRequest()
            assertEquals("/api/push/register", register.path)
            assertEquals("POST", register.method)
            assertEquals("Bearer fixture-access", register.getHeader("Authorization"))
            assertTrue(register.getHeader("Content-Type")!!.startsWith("application/json"))
            val body = Wire.json.parseToJsonElement(register.body.readUtf8()).jsonObject
            assertEquals("android", body["platform"]!!.jsonPrimitive.content)
            assertEquals("production", body["environment"]!!.jsonPrimitive.content)
            assertEquals("io.orbitd.android.debug", body["bundleId"]!!.jsonPrimitive.content)
            assertEquals(token, body["token"]!!.jsonPrimitive.content)
            assertEquals(4, UUID.fromString(body["installationId"]!!.jsonPrimitive.content).version())
            val unregister = server.takeRequest()
            assertEquals("/api/push/unregister", unregister.path)
            val removal = Wire.json.parseToJsonElement(unregister.body.readUtf8()).jsonObject
            assertEquals(key, removal["registrationKey"]!!.jsonPrimitive.content)
            assertEquals(token, removal["token"]!!.jsonPrimitive.content)
            assertEquals("android", removal["platform"]!!.jsonPrimitive.content)
        }
    }

    @Test fun refreshSerializesRequestsPreservesInstallationAndInvalidatesOldKey() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val firstStarted = CompletableDeferred<Unit>()
        val firstResponse = CompletableDeferred<Unit>()
        val calls = mutableListOf<HttpRequest>()
        val keys = List(2) { UUID.randomUUID().toString() }
        val session = session(HttpTransport { request ->
            if (request.api.path == listOf("auth", "login")) response(login) else {
                calls += request
                if (calls.size == 1) { firstStarted.complete(Unit); firstResponse.await() }
                response(registered(keys[calls.size - 1]))
            }
        }, dispatcher)
        session.login(address, "fixture@example.test", "password")
        val registration = PushRegistration(session, PushStorage(temporary.newFolder()), "io.orbitd.android.debug", {}, dispatcher)
        val first = launch { registration.updateToken(token) }
        firstStarted.await()
        val next = launch { registration.updateToken(token + "-rotated") }
        runCurrent()
        assertEquals(1, calls.size)
        firstResponse.complete(Unit)
        first.join(); next.join()
        val bodies = calls.map { Wire.json.parseToJsonElement(it.api.body!!.decodeToString()).jsonObject }
        assertEquals(bodies[0]["installationId"], bodies[1]["installationId"])
        assertEquals(token + "-rotated", bodies[1]["token"]!!.jsonPrimitive.content)
        assertFalse(registration.accepts(keys[0]))
        assertTrue(registration.accepts(keys[1]))
    }

    @Test fun uncertainRegisterRetriesNextTriggerAndSameTokenCallbackRotates() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        var attempts = 0
        val key = UUID.randomUUID().toString()
        val session = session(HttpTransport { request ->
            if (request.api.path == listOf("auth", "login")) response(login) else {
                attempts++
                if (attempts == 1) throw IOException("Controlled lost response")
                response(registered(key))
            }
        }, dispatcher)
        session.login(address, "fixture@example.test", "password")
        val registration = PushRegistration(session, PushStorage(temporary.newFolder()), "io.orbitd.android.debug", {}, dispatcher)
        registration.updateToken(token)
        assertNull(registration.activeBinding())
        registration.ensureRegistered()
        assertEquals(2, attempts)
        assertTrue(registration.accepts(key))
        registration.ensureRegistered()
        assertEquals(2, attempts)
        registration.updateToken(token)
        assertEquals(3, attempts)
    }

    @Test fun coldProcessAdoptsMatchingSavedBindingButNewLoginGenerationRotatesIt() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val directory = temporary.newFolder()
        val credentials = MemoryCredentials()
        val keys = List(2) { UUID.randomUUID().toString() }
        var registrations = 0
        val transport = HttpTransport { request -> when (request.api.path) {
            listOf("auth", "login") -> response(login)
            listOf("push", "register") -> response(registered(keys[registrations++]))
            else -> response("{}")
        } }
        val original = session(transport, dispatcher, credentials)
        original.login(address, "fixture@example.test", "password")
        val storage = PushStorage(directory)
        val originalRegistration = PushRegistration(original, storage, "io.orbitd.android.debug", {}, dispatcher)
        originalRegistration.updateToken(token)
        val installation = storage.installationId(address.value)

        val restored = session(transport, dispatcher, credentials)
        val restoredRegistration = PushRegistration(restored, PushStorage(directory), "io.orbitd.android.debug", {}, dispatcher)
        assertNull(restoredRegistration.activeBinding())
        restored.restore()
        restoredRegistration.onAuthStateChanged()
        assertEquals(1, registrations)
        assertTrue(restoredRegistration.accepts(keys[0]))
        restored.login(address, "fixture@example.test", "password")
        assertFalse("Before auth observer runs, old handle must already be rejected", restoredRegistration.accepts(keys[0]))
        restoredRegistration.onAuthStateChanged()
        assertEquals(2, registrations)
        assertTrue(restoredRegistration.accepts(keys[1]))
        assertEquals(installation, PushStorage(directory).installationId(address.value))
    }

    @Test fun supersededRegistrationResponseCannotBindAnotherAccount() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val started = CompletableDeferred<Unit>()
        val responseReady = CompletableDeferred<Unit>()
        val key = UUID.randomUUID().toString()
        var logins = 0
        val session = session(HttpTransport { request -> when (request.api.path) {
            listOf("auth", "login") -> response(if (++logins == 1) login else login.replace("\"id\":\"user\"", "\"id\":\"other\""))
            listOf("push", "register") -> { started.complete(Unit); responseReady.await(); response(registered(key)) }
            else -> response("{}")
        } }, dispatcher)
        session.login(address, "fixture@example.test", "password")
        val storage = PushStorage(temporary.newFolder())
        val registration = PushRegistration(session, storage, "io.orbitd.android.debug", {}, dispatcher)
        val pending = launch { registration.updateToken(token) }
        started.await()
        session.login(address, "other@example.test", "password")
        responseReady.complete(Unit)
        pending.join()
        assertNull(storage.binding())
        assertFalse(registration.accepts(key))
        registration.onAuthStateChanged()
        assertEquals("other", registration.activeBinding()!!.accountId)
    }

    @Test fun offlineUnregisterIsBoundedClearsLocalBindingAndBlocksSameHandle() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val unregisterStarted = CompletableDeferred<Unit>()
        val forever = CompletableDeferred<Unit>()
        var registrations = 0
        val session = session(HttpTransport { request -> when (request.api.path) {
            listOf("auth", "login") -> response(login)
            listOf("push", "register") -> { registrations++; response(registered(UUID.randomUUID().toString())) }
            listOf("push", "unregister") -> { unregisterStarted.complete(Unit); forever.await(); response("{}") }
            else -> response("{}")
        } }, dispatcher)
        session.login(address, "fixture@example.test", "password")
        val storage = PushStorage(temporary.newFolder())
        var cleared = 0
        val registration = PushRegistration(session, storage, "io.orbitd.android.debug", { cleared++ }, dispatcher, 100)
        registration.updateToken(token)
        val signOut = launch { registration.beforeSignOut() }
        unregisterStarted.await()
        assertNull(registration.activeBinding())
        val refresh = launch { registration.ensureRegistered() }
        advanceTimeBy(101)
        signOut.join(); refresh.join()
        assertNull(storage.binding())
        assertTrue(cleared > 0)
        assertEquals(1, registrations)
        assertTrue(registration.hasToken(token))
    }

    @Test fun installationIdentitySurvivesAccountRemovalAndSeparatesServers() {
        val directory = temporary.newFolder()
        val storage = PushStorage(directory)
        val one = storage.installationId("https://one.example")
        val two = storage.installationId("https://two.example")
        assertNotEquals(one, two)
        assertEquals(4, UUID.fromString(one).version())
        storage.setToken(token)
        storage.setBinding(PushBinding("https://one.example", "first", token, UUID.randomUUID().toString()))
        storage.setBinding(null)
        val reopened = PushStorage(directory)
        assertEquals(one, reopened.installationId("https://one.example"))
        assertEquals(two, reopened.installationId("https://two.example"))
        assertEquals(token, reopened.token())
        assertNull(reopened.binding())
    }

    private fun session(transport: HttpTransport, dispatcher: CoroutineDispatcher = kotlinx.coroutines.Dispatchers.IO,
        credentials: MemoryCredentials = MemoryCredentials()) = AuthSession(transport, credentials,
        object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) {}
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
            override suspend fun clearAll() {}
        }, "test", allowLoopbackHttp = true, dispatcher = dispatcher)

    private class MemoryCredentials : CredentialStore {
        var stored: StoredSession? = null
        override suspend fun load() = stored
        override suspend fun save(session: StoredSession) { stored = session }
        override suspend fun clear() { stored = null }
    }
}

private val address = ServerAddress.parse("https://one.example")
private val token = listOf("controlled", "registration", "token").joinToString("-")
private const val login = """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"user","name":"Fixture","email":"fixture@example.test"}}"""
private fun registered(key: String) = """{"ok":true,"registrationKey":"$key"}"""
private fun response(body: String) = ApiResponse(200, body.encodeToByteArray())
