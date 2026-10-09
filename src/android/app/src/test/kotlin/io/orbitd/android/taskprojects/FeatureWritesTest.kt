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

    @Test fun anUnknownAnswerHoldsThatPressForAMinuteNotForever() = runTest {
        val fixture = Fixture()
        val session = fixture.session()
        val handle = session.login(fixture.server, "fixture@example.test", "fixture")
        var now = 1_000_000L
        val writes = FeatureWrites(session, handle, clock = { now })
        fixture.response = { throw java.io.IOException("lost response") }
        try { writes.execute("comment:1", mutation); fail() } catch (_: FeatureWriteUncertain) { }
        fixture.response = { ApiResponse(200, "{}".encodeToByteArray()) }
        now += FeatureWrites.FENCE_MS - 1
        try { writes.execute("comment:1", mutation); fail("still held") } catch (_: FeatureWriteUncertain) { }
        assertEquals(1, fixture.mutations)
        // Past the hold the page has re-read the record; the same press is the person's to make again.
        now += 2
        assertNotNull(writes.execute("comment:1", mutation))
        assertEquals(2, fixture.mutations)
    }

    @Test fun nothingIsSentWhileTheAccountStreamIsDown() = runTest {
        val fixture = Fixture()
        val session = fixture.session()
        val handle = session.login(fixture.server, "fixture@example.test", "fixture")
        var online = false
        val writes = FeatureWrites(session, handle, writable = { online })
        try { writes.execute("pause:1", mutation); fail() } catch (_: FeatureWriteRefused) { }
        assertEquals(0, fixture.mutations)
        online = true
        assertNotNull(writes.execute("pause:1", mutation))
        assertEquals(1, fixture.mutations)
    }

    @Test fun aNamedPressIsResentUnchangedButAnAnswerIsNeverRetried() = runTest {
        val fixture = Fixture()
        val session = fixture.session()
        val handle = session.login(fixture.server, "fixture@example.test", "fixture")
        val writes = FeatureWrites(session, handle)
        var calls = 0
        fixture.response = { if (++calls < 3) throw java.io.IOException("dropped") else ApiResponse(200, "{\"sessionId\":\"s\"}".encodeToByteArray()) }
        assertNotNull(writes.execute("run:1", mutation, resends = 3))
        assertEquals(3, fixture.mutations)
        fixture.response = { ApiResponse(409, "{\"code\":\"TASK_ALREADY_RUNNING\"}".encodeToByteArray()) }
        try { writes.execute("run:2", mutation, resends = 3); fail() } catch (error: ApiError) { assertEquals(409, error.status) }
        assertEquals("a refusal is the answer, not a fault to resend", 4, fixture.mutations)
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
