package io.orbitd.android.taskprojects

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class FeatureWritesTest {
    @Test fun lostResponseIsNotReplayedAfterProcessRestoration() = runTest {
        val fixture = Fixture()
        val first = fixture.session()
        val handle = first.login(fixture.server, "fixture@example.test", "fixture")
        fixture.response = { throw java.io.IOException("lost response") }
        try { FeatureWrites(first, handle).execute("task:one:revision:1", mutation); fail() }
        catch (_: FeatureWriteUncertain) { }
        assertEquals(1, fixture.mutations)
        // New AuthSession restores the same encrypted-store contract and persisted fence.
        val restored = fixture.session()
        restored.restore()
        val next = (restored.state.value as AuthState.SignedIn).handle
        fixture.response = { ApiResponse(200, "{}".encodeToByteArray()) }
        try { FeatureWrites(restored, next).execute("task:one:revision:1", mutation); fail() }
        catch (_: FeatureWriteUncertain) { }
        assertEquals(1, fixture.mutations)
        FeatureWrites(restored, next).execute("task:one:revision:2", mutation)
        assertEquals(2, fixture.mutations)
    }

    @Test fun definitiveRejectionAllowsCorrectedGestureButServerErrorDoesNot() = runTest {
        val fixture = Fixture()
        val session = fixture.session()
        val handle = session.login(fixture.server, "fixture@example.test", "fixture")
        val writes = FeatureWrites(session, handle)
        fixture.response = { ApiResponse(409, "{\"code\":\"REVISION_CHANGED\"}".encodeToByteArray()) }
        try { writes.execute("settings:1", mutation); fail() } catch (error: ApiError) { assertEquals(409, error.status) }
        fixture.response = { ApiResponse(200, "{\"configRevision\":2}".encodeToByteArray()) }
        assertNotNull(writes.execute("settings:1", mutation))
        fixture.response = { ApiResponse(503, "{}".encodeToByteArray()) }
        try { writes.execute("settings:2", mutation); fail() } catch (_: FeatureWriteUncertain) { }
        try { writes.execute("settings:2", mutation); fail() } catch (_: FeatureWriteUncertain) { }
        assertEquals(3, fixture.mutations)
    }

    @Test fun navigationCannotSubmitTwoConcurrentWritesAndLogoutRevokesHandle() = runTest {
        val fixture = Fixture()
        val session = fixture.session()
        val handle = session.login(fixture.server, "fixture@example.test", "fixture")
        val entered = CompletableDeferred<Unit>()
        val released = CompletableDeferred<Unit>()
        fixture.response = { entered.complete(Unit); released.await(); ApiResponse(200, "{}".encodeToByteArray()) }
        val inFlight = async { FeatureWrites(session, handle).execute("run:one", mutation) }
        entered.await()
        try { FeatureWrites(session, handle).execute("run:two", mutation); fail() }
        catch (error: IllegalStateException) { assertTrue(error.message!!.startsWith("Another change")) }
        released.complete(Unit)
        inFlight.await()
        session.logout()
        try { FeatureWrites(session, handle).execute("run:three", mutation); fail() } catch (_: SessionChanged) { }
        assertEquals(1, fixture.mutations)
    }

    private val mutation = ApiRequest(listOf("tasks", "one", "run"), HttpMethod.POST,
        body = "{\"triggerId\":\"fixed-user-gesture\"}".encodeToByteArray())

    private class Fixture {
        val server = ServerAddress.parse("https://fixture.example")
        var stored: StoredSession? = null
        var selected: String? = null
        val cache = mutableMapOf<Triple<AccountKey, DataKind, String>, ByteArray>()
        var mutations = 0
        var response: suspend () -> ApiResponse = { ApiResponse(200, "{}".encodeToByteArray()) }
        fun session() = AuthSession(HttpTransport { request ->
            when (request.api.path) {
                listOf("auth", "login") -> ApiResponse(200, """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"fixture-user","name":"Fixture","email":"fixture@example.test"}}""".encodeToByteArray())
                listOf("auth", "logout") -> ApiResponse(200, "{}".encodeToByteArray())
                else -> { mutations++; response() }
            }
        }, object : CredentialStore {
            override suspend fun load() = stored
            override suspend fun save(session: StoredSession) { stored = session }
            override suspend fun clear() { stored = null }
        }, object : InstanceStore {
            override suspend fun load() = selected
            override suspend fun save(server: String) { selected = server }
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String) = cache[Triple(account, kind, key)]
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { cache[Triple(account, kind, key)] = bytes }
            override suspend fun clearAll() { cache.clear() }
        }, "test")
    }
}
