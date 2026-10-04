package io.orbitd.android.core.auth

import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.RefreshRequest
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class AuthSessionTest {
    private val read = ApiRequest(listOf("users", "me"))

    @Test fun twentyConcurrent401sShareOneRotationAndTheNextRotationUsesTheNewToken() = runTest {
        val h = Harness(this)
        val handle = h.seed()
        val allFirstRequests = CompletableDeferred<Unit>()
        val releaseRefresh = CompletableDeferred<Unit>()
        var initial = 0
        var version = 0
        h.handler = { req ->
            when {
                req.api.path.last() == "refresh" -> {
                    val sent = Wire.decode(req.api.body!!, RefreshRequest.serializer())
                    assertTrue("refresh uses the current rotating token", sent.refreshToken == tokens(version = version).refreshToken)
                    releaseRefresh.await()
                    response(tokens(version = ++version))
                }
                req.accessToken == tokens().accessToken -> {
                    if (++initial == 20) allFirstRequests.complete(Unit)
                    allFirstRequests.await()
                    unauthorized()
                }
                else -> ok()
            }
        }
        val calls = List(20) { async { h.client.request(handle, read) } }
        runCurrent()
        assertEquals(20, initial)
        assertEquals(1, h.refreshes.size)
        releaseRefresh.complete(Unit)
        assertTrue(calls.awaitAll().all { it.status == 200 })
        assertEquals(1, h.refreshes.size)
        assertTrue(h.credentials.value!!.credentials == tokens(version = 1))
        val seen = h.requests.count { it.accessToken == tokens(version = 1).accessToken }
        assertEquals(20, seen)
        h.handler = { req ->
            if (req.api.path.last() == "refresh") {
                assertTrue(Wire.decode(req.api.body!!, RefreshRequest.serializer()).refreshToken == tokens(version = 1).refreshToken)
                response(tokens(version = 2))
            } else if (req.accessToken == tokens(version = 1).accessToken) unauthorized() else ok()
        }
        h.client.request(handle, read)
        assertEquals(2, h.refreshes.size)
        assertTrue(h.credentials.value!!.credentials == tokens(version = 2))
    }

    @Test fun delayedOld401ReusesTheAlreadyRotatedToken() = runTest {
        val h = Harness(this)
        val handle = h.seed()
        val late = CompletableDeferred<Unit>()
        h.handler = { req ->
            if (req.api.path.last() == "refresh") response(tokens(version = 1))
            else if (req.accessToken == tokens().accessToken) {
                if (req.api.path.last() == "late") late.await()
                unauthorized()
            } else ok()
        }
        val slow = async { h.client.request(handle, ApiRequest(listOf("late"))) }
        runCurrent()
        h.client.request(handle, read)
        late.complete(Unit)
        slow.await()
        assertEquals(1, h.refreshes.size)
    }

    @Test fun cancellingOneWaiterDoesNotCancelTheSharedRefresh() = runTest {
        val h = Harness(this)
        val handle = h.seed()
        val release = CompletableDeferred<Unit>()
        h.handler = { req ->
            if (req.api.path.last() == "refresh") { release.await(); response(tokens(version = 1)) }
            else if (req.accessToken == tokens().accessToken) unauthorized() else ok()
        }
        val cancelled = async { h.client.request(handle, read) }
        val other = async { h.client.request(handle, read) }
        runCurrent()
        cancelled.cancel()
        release.complete(Unit)
        assertEquals(200, other.await().status)
        assertEquals(1, h.refreshes.size)
        assertTrue(h.client.state.value is AuthState.SignedIn)
    }

    @Test fun refreshFailuresCancelTwentyWaitersPurgeDataAndNeverReplay() = runTest {
        // Rejection, outage, lost response, malformed/partial pair, reuse, identity change, disk failure.
        for (failure in 0..7) {
            val h = Harness(this)
            val handle = h.seed()
            h.client.writeData(handle, DataKind.DRAFT, "s1", byteArrayOf(1))
            h.client.writeData(handle, DataKind.CACHE, "s1", byteArrayOf(2))
            val release = CompletableDeferred<Unit>()
            h.handler = { req ->
                if (req.api.path.last() == "refresh") {
                    release.await()
                    when (failure) {
                        0 -> unauthorized()
                        1 -> ApiResponse(503, byteArrayOf())
                        2 -> throw NetworkException()
                        3 -> ApiResponse(200, "invalid".encodeToByteArray())
                        4 -> ApiResponse(200, "{\"accessToken\":\"partial\"}".encodeToByteArray())
                        5 -> response(tokens())
                        6 -> response(tokens("bob", 1))
                        else -> { h.credentials.failSave = true; response(tokens(version = 1)) }
                    }
                } else unauthorized()
            }
            val calls = List(20) { async { runCatching { h.client.request(handle, read) } } }
            runCurrent()
            assertEquals(1, h.refreshes.size)
            release.complete(Unit)
            assertTrue("failure case $failure", calls.awaitAll().all { it.isFailure })
            assertTrue(h.client.state.value is AuthState.SignedOut)
            assertNull(h.credentials.value)
            assertTrue(h.data.values.isEmpty())
            assertTrue(runCatching { h.client.request(handle, read) }.exceptionOrNull() is SessionChanged)
            assertEquals(1, h.refreshes.size)
        }
    }

    @Test fun retry401SignsOutWithoutAnotherRefresh() = runTest {
        val h = Harness(this)
        val handle = h.seed()
        h.handler = { if (it.api.path.last() == "refresh") response(tokens(version = 1)) else unauthorized() }
        assertTrue(runCatching { h.client.request(handle, read) }.isFailure)
        assertEquals(1, h.refreshes.size)
        assertNull(h.credentials.value)
        assertEquals(SignOutReason.EXPIRED, (h.client.state.value as AuthState.SignedOut).reason)
    }

    @Test fun logoutOrSwitchDuringRefreshCannotResurrectTheOldSession() = runTest {
        for (switch in listOf("logout", "server", "server-login", "account", "same-account")) {
            val h = Harness(this)
            val old = h.seed()
            val release = CompletableDeferred<Unit>()
            h.handler = { req ->
                when (req.api.path.last()) {
                    "refresh" -> withContext(NonCancellable) { release.await(); response(tokens(version = 1)) }
                    "login" -> response(tokens(if (switch == "account") "bob" else "alice", 5))
                    else -> unauthorized()
                }
            }
            h.client.writeData(old, DataKind.DRAFT, "s1", byteArrayOf(1))
            val work = async { runCatching { h.client.request(old, read) } }
            runCurrent()
            when (switch) {
                "logout" -> h.client.logout()
                "server" -> h.client.selectServer(serverB)
                "server-login" -> h.client.login(serverB, "fixture@example.test", "fixture-password")
                else -> h.client.login(serverA, "fixture@example.test", "fixture-password")
            }
            val before = h.credentials.value
            val state = h.client.state.value
            release.complete(Unit)
            assertTrue(work.await().isFailure)
            runCurrent()
            assertTrue("late refresh must not change storage: $switch", before == h.credentials.value)
            assertSame(state, h.client.state.value)
            assertTrue(h.data.values.isEmpty())
            assertTrue(runCatching { h.client.writeData(old, DataKind.CACHE, "s1", byteArrayOf(3)) }.isFailure)
        }
    }

    @Test fun aLateLoginAndLateSuccessfulReadCannotCrossAnInstanceSwitch() = runTest {
        val h = Harness(this)
        val old = h.seed()
        val releaseRead = CompletableDeferred<Unit>()
        val releaseLogin = CompletableDeferred<Unit>()
        h.handler = { req -> withContext(NonCancellable) {
            if (req.api.path.last() == "login") { releaseLogin.await(); response(tokens("bob")) }
            else { releaseRead.await(); ok() }
        } }
        val readWork = async { runCatching { h.client.request(old, read) } }
        runCurrent()
        val login = async { runCatching { h.client.login(serverA, "bob@example.test", "fixture-password") } }
        runCurrent()
        h.client.selectServer(serverB)
        releaseRead.complete(Unit)
        releaseLogin.complete(Unit)
        assertTrue(readWork.await().isFailure)
        assertTrue(login.await().isFailure)
        runCurrent()
        assertNull(h.credentials.value)
        assertEquals(serverB, (h.client.state.value as AuthState.SignedOut).server)
    }

    @Test fun accountAndServerSwitchesPurgeBothNamespacesAndFenceOldHandles() = runTest {
        val h = Harness(this)
        val alice = h.seed()
        h.client.writeData(alice, DataKind.DRAFT, "same-session-id", byteArrayOf(1))
        h.client.writeData(alice, DataKind.CACHE, "same-session-id", byteArrayOf(2))
        h.handler = { response(tokens("bob")) }
        val bob = h.client.login(serverA, "bob@example.test", "fixture-password")
        assertNotEquals(alice.account, bob.account)
        assertNull(h.client.readData(bob, DataKind.DRAFT, "same-session-id"))
        h.client.writeData(bob, DataKind.DRAFT, "same-session-id", byteArrayOf(3))
        val otherServer = h.client.login(serverB, "bob@example.test", "fixture-password")
        assertNotEquals(bob.account, otherServer.account)
        assertNull(h.client.readData(otherServer, DataKind.DRAFT, "same-session-id"))
        assertTrue(runCatching { h.client.readData(alice, DataKind.DRAFT, "same-session-id") }.isFailure)
        assertTrue(runCatching { h.client.readData(bob, DataKind.CACHE, "same-session-id") }.isFailure)
        assertEquals(serverB.value, h.credentials.value!!.server)
        h.client.logout()
        runCurrent()
        val revoked = h.requests.last { it.api.path.last() == "logout" }
        assertEquals(serverB, revoked.server)
        assertNull(revoked.accessToken)
        assertNull(h.credentials.value)
    }

    @Test fun corruptOrMismatchedRestoreFailsClosedAndCleansOrphanData() = runTest {
        for (corrupt in listOf(false, true)) {
            val h = Harness(this)
            h.instances.value = serverB.value
            h.credentials.value = StoredSession(serverA.value, tokens())
            h.credentials.failLoad = corrupt
            h.data.write(AccountKey(serverA.value, "alice"), DataKind.DRAFT, "s1", byteArrayOf(1))
            h.client.restore()
            assertTrue(h.client.state.value is AuthState.SignedOut)
            assertNull(h.credentials.value)
            assertTrue(h.data.values.isEmpty())
        }
    }

    @Test fun loginStorageFailureNeverPublishesAnAuthenticatedSession() = runTest {
        val h = Harness(this)
        h.credentials.failSave = true
        h.handler = { response(tokens()) }
        assertTrue(runCatching { h.client.login(serverA, "alice@example.test", "fixture-password") }.exceptionOrNull() is SecureStorageException)
        assertNull(h.credentials.value)
        assertTrue(h.client.state.value is AuthState.SignedOut)
    }

    @Test fun switchingCancelsAnOrdinaryInFlightTransportCall() = runTest {
        val h = Harness(this)
        val handle = h.seed()
        var cancelled = false
        h.handler = { try { CompletableDeferred<Unit>().await(); ok() } finally { cancelled = true } }
        val call = async { runCatching { h.client.request(handle, read) } }
        runCurrent()
        h.client.selectServer(serverB)
        assertTrue(call.await().isFailure)
        assertTrue(cancelled)
    }
}
