package io.orbitd.android.core.auth

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.RefreshRequest
import io.orbitd.android.core.protocol.SignInMethods
import io.orbitd.android.core.protocol.Wire
import java.io.IOException
import java.security.InvalidKeyException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.currentTime
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

    @Test fun delayedRetry401DoesNotClearANewerCommittedRotation() = runTest {
        val h = Harness(this)
        val handle = h.seed()
        h.client.writeData(handle, DataKind.DRAFT, "s1", byteArrayOf(1))
        h.client.writeData(handle, DataKind.CACHE, "s1", byteArrayOf(2))
        val retryStarted = CompletableDeferred<Unit>()
        val releaseRetry = CompletableDeferred<Unit>()
        var rotation = 0
        h.handler = { req ->
            when {
                req.api.path.last() == "refresh" -> {
                    assertTrue(Wire.decode(req.api.body!!, RefreshRequest.serializer()).refreshToken == tokens(version = rotation).refreshToken)
                    response(tokens(version = ++rotation))
                }
                req.api.path.last() == "delayed" && req.accessToken == tokens(version = 1).accessToken -> {
                    retryStarted.complete(Unit)
                    releaseRetry.await()
                    unauthorized()
                }
                req.accessToken == tokens(version = 2).accessToken -> ok()
                else -> unauthorized()
            }
        }
        val delayed = async { runCatching { h.client.request(handle, ApiRequest(listOf("delayed"))) } }
        runCurrent()
        assertTrue("first request is waiting for its v1 retry response", retryStarted.isCompleted)
        assertEquals(1, h.refreshes.size)
        // Another request's v1 rejection rotates to v2 before the delayed v1 rejection arrives.
        assertEquals(200, h.client.request(handle, read).status)
        assertTrue(h.credentials.value!!.credentials == tokens(version = 2))
        val signedIn = h.client.state.value
        releaseRetry.complete(Unit)
        val failure = delayed.await().exceptionOrNull()
        runCurrent()
        assertSame("a superseded retry must not sign out the current session", signedIn, h.client.state.value)
        assertTrue("the committed v2 pair must remain", h.credentials.value?.credentials == tokens(version = 2))
        assertTrue(failure is ApiError && failure.status == 401)
        assertArrayEquals(byteArrayOf(1), h.client.readData(handle, DataKind.DRAFT, "s1"))
        assertArrayEquals(byteArrayOf(2), h.client.readData(handle, DataKind.CACHE, "s1"))
        assertEquals(2, h.requests.count { it.api.path.last() == "delayed" })
        assertEquals(2, h.refreshes.size)
        assertFalse(h.requests.any { it.api.path.last() == "logout" })
        assertEquals(200, h.client.request(handle, read).status)
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
            if (corrupt) h.credentials.loadFailures += SecureStorageException(unrecoverable = true)
            h.data.write(AccountKey(serverA.value, "alice"), DataKind.DRAFT, "s1", byteArrayOf(1))
            h.client.restore()
            assertTrue(h.client.state.value is AuthState.SignedOut)
            assertNull(h.credentials.value)
            assertTrue(h.data.values.isEmpty())
        }
    }

    /** A03d: a storage failure that may pass (I/O, a busy Keystore) is read again; it costs neither credentials nor data. */
    @Test fun aStorageFailureThatPassesIsReadAgainAndKeepsTheSessionAndData() = runTest {
        val h = Harness(this)
        val stored = storeSessionAndData(h)
        h.credentials.loadFailures += SecureStorageException(IOException("fixture I/O failure"))
        h.client.restore()
        assertTrue("the stored session survives", h.credentials.value == stored)
        val handle = (h.client.state.value as AuthState.SignedIn).handle
        assertEquals(AccountKey(serverA.value, "alice"), handle.account)
        assertArrayEquals("account data survives", byteArrayOf(1), h.client.readData(handle, DataKind.DRAFT, "s1"))
        assertEquals("read again once, 200 ms later", 2, h.credentials.loads)
        assertEquals(200L, currentTime)
        assertLogged(h, "attempt 1 of 3 failed", IOException::class.java.name, "restored on attempt 2")
    }

    /** As iOS, whose Keychain read that fails only returns nil: signed out for this launch, nothing deleted, the next restores. */
    @Test fun aStorageFailureThatPersistsSignsOutButKeepsTheSessionAndDataForTheNextLaunch() = runTest {
        val h = Harness(this)
        val stored = storeSessionAndData(h)
        repeat(3) { h.credentials.loadFailures += SecureStorageException(IOException("fixture I/O failure")) }
        h.client.restore()
        assertTrue("nothing is deleted", h.credentials.value == stored)
        assertEquals(1, h.data.values.size)
        assertEquals(AuthState.SignedOut(serverA, SignOutReason.STORAGE), h.client.state.value)
        assertEquals("three reads, 200 ms apart", 3, h.credentials.loads)
        assertEquals(400L, currentTime)
        assertLogged(h, "attempt 2 of 3 failed", "unreadable after 3 attempts", "kept for the next launch")
        val next = h.launch()
        next.restore()
        val handle = (next.state.value as AuthState.SignedIn).handle
        assertArrayEquals(byteArrayOf(1), next.readData(handle, DataKind.DRAFT, "s1"))
        assertTrue(h.credentials.value == stored)
    }

    /** The Android store reports KeyPermanentlyInvalidatedException (an InvalidKeyException) as unrecoverable. */
    @Test fun aStoredSessionWhoseKeyIsPermanentlyInvalidatedIsStillRetiredAndCleared() = runTest {
        val h = Harness(this)
        storeSessionAndData(h)
        h.credentials.loadFailures += SecureStorageException(InvalidKeyException("fixture key invalidated"), unrecoverable = true)
        h.client.restore()
        assertEquals(AuthState.SignedOut(serverA, SignOutReason.STORAGE), h.client.state.value)
        assertNull(h.credentials.value)
        assertTrue(h.data.values.isEmpty())
        assertEquals("never read again", 1, h.credentials.loads)
        assertEquals(0L, currentTime)
        assertLogged(h, "can never be read", InvalidKeyException::class.java.name, "cleared")
    }

    @Test fun withoutAStoredSessionRestoreIsUnchanged() = runTest {
        val h = Harness(this)
        h.instances.value = serverA.value
        h.data.write(AccountKey(serverA.value, "alice"), DataKind.DRAFT, "s1", byteArrayOf(1))
        h.client.restore()
        assertEquals(AuthState.SignedOut(serverA), h.client.state.value)
        assertNull(h.credentials.value)
        assertTrue("orphan account data is still cleared", h.data.values.isEmpty())
        assertEquals(1, h.credentials.loads)
        assertEquals(0L, currentTime)
        assertLogged(h, "no stored session")
    }

    private suspend fun storeSessionAndData(h: Harness): StoredSession {
        h.instances.value = serverA.value
        h.credentials.value = StoredSession(serverA.value, tokens())
        h.data.write(AccountKey(serverA.value, "alice"), DataKind.DRAFT, "s1", byteArrayOf(1))
        return h.credentials.value!!
    }

    /** The log names the way restore went and the failure's classes, never a credential, account, server or message. */
    private fun assertLogged(h: Harness, vararg expected: String) {
        val text = h.logs.joinToString("\n")
        for (part in expected) assertTrue("log names \"$part\": $text", text.contains(part))
        for (value in listOf(tokens().accessToken, tokens().refreshToken, tokens().user.email, "alice", "orbit.example", "fixture")) {
            assertFalse("log holds \"$value\": $text", text.contains(value))
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

    @Test fun googleTicketLoginExchangesTheTicketAndSwitchesLikeAPasswordLogin() = runTest {
        val h = Harness(this)
        val alice = h.seed()
        h.client.writeData(alice, DataKind.DRAFT, "s1", byteArrayOf(1))
        h.handler = { req -> if (req.api.path == listOf("auth", "google", "exchange")) response(tokens("bob")) else unauthorized() }
        val bob = h.client.loginWithGoogleTicket(serverB, "fixture-ticket", "fixture-verifier")
        runCurrent()
        val exchange = h.requests.single { it.api.path == listOf("auth", "google", "exchange") }
        assertEquals(serverB, exchange.server)
        assertEquals(HttpMethod.POST, exchange.api.method)
        assertNull("the exchange never carries the old session's bearer", exchange.accessToken)
        assertEquals("""{"ticket":"fixture-ticket","codeVerifier":"fixture-verifier"}""", exchange.api.body!!.decodeToString())
        // The password login's switch: the old session is revoked, fenced and purged before the new one is published.
        val revoked = h.requests.single { it.api.path == listOf("auth", "logout") }
        assertEquals(tokens().refreshToken, Wire.decode(revoked.api.body!!, RefreshRequest.serializer()).refreshToken)
        assertTrue(runCatching { h.client.readData(alice, DataKind.DRAFT, "s1") }.exceptionOrNull() is SessionChanged)
        assertTrue(h.data.values.isEmpty())
        assertTrue(h.credentials.value == StoredSession(serverB.value, tokens("bob")))
        assertEquals(serverB.value, h.instances.value)
        assertEquals(AccountKey(serverB.value, "bob"), bob.account)
        assertEquals(AuthState.SignedIn(bob, tokens("bob").user), h.client.state.value)
        assertNull(h.client.readData(bob, DataKind.DRAFT, "s1"))
    }

    @Test fun aFailedGoogleTicketLoginLeavesNoSession() = runTest {
        val refusal = """{"code":"GOOGLE_ACCOUNT_NOT_FOUND","message":"No Orbit account signs in with this Google account"}"""
        for (failure in listOf("refused", "storage")) {
            val h = Harness(this)
            h.seed()
            h.credentials.failSave = failure == "storage"
            h.handler = { if (failure == "refused") ApiResponse(403, refusal.encodeToByteArray()) else response(tokens("bob")) }
            val error = runCatching { h.client.loginWithGoogleTicket(serverB, "fixture-ticket", "fixture-verifier") }.exceptionOrNull()
            if (failure == "refused") assertTrue(error is ApiError && error.status == 403 && error.code == "GOOGLE_ACCOUNT_NOT_FOUND")
            else assertTrue(error is SecureStorageException)
            assertNull(failure, h.credentials.value)
            assertEquals(failure, AuthState.SignedOut(serverB, if (failure == "storage") SignOutReason.STORAGE else null), h.client.state.value)
        }
    }

    /** iOS fdeb033ad: only what signed in is remembered, so a mistyped server or email never sticks; the coordinator's A03c decision
     * keeps each server's email, encrypted, through sign-out, as iOS keeps its one. */
    @Test fun onlyASuccessfulPasswordLoginRemembersItsServerAndEmail() = runTest {
        val h = Harness(this)
        h.instances.value = serverA.value
        h.client.restore()
        // Turned down, or out of reach: nothing is remembered, but the page keeps the server it tried.
        h.handler = { unauthorized() }
        assertTrue(runCatching { h.client.login(serverB, "bob@example.test", "wrong-password") }.isFailure)
        h.handler = { throw NetworkException() }
        assertTrue(runCatching { h.client.login(serverB, "bob@example.test", "fixture-password") }.isFailure)
        assertEquals(serverA.value, h.instances.value)
        assertNull(h.client.rememberedEmail(serverB))
        assertEquals(serverB, (h.client.state.value as AuthState.SignedOut).server)

        h.handler = { response(tokens("bob")) }
        h.client.login(serverB, "bob@example.test", "fixture-password")
        assertEquals(serverB.value, h.instances.value)
        assertEquals("bob@example.test", h.client.rememberedEmail(serverB))
        assertNull("each server has its own", h.client.rememberedEmail(serverA))
        // Signing out keeps the server and its email for the login page.
        h.client.logout()
        assertEquals(serverB.value, h.instances.value)
        assertEquals("bob@example.test", h.client.rememberedEmail(serverB))

        // Google remembers its server and no email: none was typed.
        h.handler = { response(tokens("carol")) }
        h.client.loginWithGoogleTicket(serverA, "fixture-ticket", "fixture-verifier")
        assertEquals(serverA.value, h.instances.value)
        assertNull(h.client.rememberedEmail(serverA))
        assertEquals("bob@example.test", h.client.rememberedEmail(serverB))

        // The next sign-in on a server replaces its email; a store that fails costs only the prefill, never the sign-in.
        h.handler = { response(tokens("dave")) }
        h.client.login(serverB, "dave@example.test", "fixture-password")
        assertEquals("dave@example.test", h.client.rememberedEmail(serverB))
        h.emails.fail = true
        h.client.login(serverB, "erin@example.test", "fixture-password")
        assertTrue(h.client.state.value is AuthState.SignedIn)
        assertNull(h.client.rememberedEmail(serverB))
        h.emails.fail = false
        assertEquals("dave@example.test", h.client.rememberedEmail(serverB))
        assertEquals(mapOf(serverB.value to "dave@example.test"), h.emails.values)
    }

    @Test fun signInMethodsAsksTheInstanceWithoutTouchingTheSession() = runTest {
        val h = Harness(this)
        h.seed()
        h.handler = { ApiResponse(200, """{"password":true,"google":true,"googleSignup":false,"later":1}""".encodeToByteArray()) }
        assertEquals(SignInMethods(password = true, google = true, googleSignup = false), h.client.signInMethods(serverB))
        val asked = h.requests.single()
        assertEquals(listOf("auth", "methods"), asked.api.path)
        assertEquals(HttpMethod.GET, asked.api.method)
        assertEquals(serverB, asked.server)
        assertNull(asked.accessToken)
        // A server from before Google sign-in has no such route.
        h.handler = { ApiResponse(404, """{"statusCode":404,"message":"Cannot GET /api/auth/methods"}""".encodeToByteArray()) }
        assertEquals(404, (runCatching { h.client.signInMethods(serverA) }.exceptionOrNull() as ApiError).status)
        assertTrue(h.client.state.value is AuthState.SignedIn)
        assertTrue(h.credentials.value == StoredSession(serverA.value, tokens()))
        // A network failure (such as a pooled connection the server closed) is sent again, three times at most.
        var failing = 2
        h.handler = { if (failing-- > 0) throw NetworkException() else ApiResponse(200, "{}".encodeToByteArray()) }
        assertEquals(SignInMethods(), h.client.signInMethods(serverB))
        h.handler = { throw NetworkException() }
        val before = h.requests.size
        assertTrue(runCatching { h.client.signInMethods(serverB) }.exceptionOrNull() is NetworkException)
        assertEquals(3, h.requests.size - before)
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
