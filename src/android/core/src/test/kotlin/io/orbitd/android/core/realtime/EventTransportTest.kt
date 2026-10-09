package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.ProtocolException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class EventTransportTest {
    private fun request(server: MockWebServer) = HttpRequest(
        ServerAddress.parse(server.url("/").toString(), allowLoopbackHttp = true),
        ApiRequest(listOf("sessions", "s1", "events"), query = listOf("sinceSeq" to "9")), "test", "fixture-token")

    @Test fun actualHttpCarriesHeadersAndParsesFragmentedUtf8() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream; charset=utf-8")
                .setChunkedBody(": heartbeat\r\ndata: {\"type\":\"text_delta\",\"payload\":{\"text\":\"中文🙂\"}}\r\n\r\n", 1))
            val frames = mutableListOf<SseFrame>()
            var opened = false
            OkHttpEventTransport().stream(request(server), { opened = true }, { assertTrue(opened); frames += it })
            assertEquals("中文🙂", RunEvent.decode(frames.single()).fields.text("text"))
            val wire = server.takeRequest(60, TimeUnit.SECONDS)!!
            assertEquals("/api/sessions/s1/events?sinceSeq=9", wire.path)
            assertEquals("Bearer fixture-token", wire.getHeader("Authorization"))
            assertEquals("android/test", wire.getHeader("X-Orbit-Client"))
            assertEquals("text/event-stream", wire.getHeader("Accept"))
        }
    }

    /** A comment every 250 ms keeps a 1 s watchdog quiet through a 2 s stream; a socket silent after its headers ends at
     * the watchdog, well before its 3 s body. Windows this wide hold on a loaded host. */
    @Test fun watchdogCountsCommentBytesAndSilentSocketsTimeOut() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
                .setBody(":k\n\n".repeat(8)).throttleBody(4, 250, TimeUnit.MILLISECONDS))
            withTimeout(60_000) { OkHttpEventTransport(1_000).stream(request(server), {}, { fail("Comments do not dispatch") }) }
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
                .setBody("data: {}\n\n").setBodyDelay(3, TimeUnit.SECONDS))
            var opened = false
            try {
                withTimeout(60_000) { OkHttpEventTransport(1_000).stream(request(server), { opened = true }, {}) }
                fail("Silent stream should fail")
            } catch (_: NetworkException) { assertTrue(opened) }
        }
    }

    @Test fun cancellationClosesAReadWithoutWaitingForTheWatchdog() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
                .setBody("data: {}\n\n").setBodyDelay(2, TimeUnit.SECONDS))
            val opened = CompletableDeferred<Unit>()
            val job = launch { OkHttpEventTransport().stream(request(server), { opened.complete(Unit) }, {}) }
            withTimeout(60_000) { opened.await() }
            withTimeout(500) { job.cancelAndJoin() }
            assertTrue(job.isCancelled)
        }
    }

    @Test fun hostnameReconnectFallsBackToTheReachableAddressAfterCancellation() = runBlocking {
        MockWebServer().use { server ->
            server.start(java.net.InetAddress.getByName("127.0.0.1"), 0)
            val request = HttpRequest(ServerAddress.parse("http://localhost:${server.port}", allowLoopbackHttp = true),
                ApiRequest(listOf("events")), "test", "fixture-token")
            val transport = OkHttpEventTransport()
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
                .setBody("data: {\"type\":\"ping\"}\n\n".repeat(1000)).throttleBody(24, 50, TimeUnit.MILLISECONDS))
            val opened = CompletableDeferred<Unit>()
            val first = launch { transport.stream(request, { opened.complete(Unit) }, {}) }
            withTimeout(60_000) { opened.await() }
            withTimeout(500) { first.cancelAndJoin() }
            server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream").setBody("data: recovered\n\n"))
            val frames = mutableListOf<SseFrame>()
            withTimeout(60_000) { transport.stream(request, {}, { frames += it }) }
            assertEquals("recovered", frames.single().data)
        }
    }

    @Test fun redirectsAndWrongContentTypeAreNeverConsumed() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", server.url("/leak")))
            try { OkHttpEventTransport().stream(request(server), { fail() }, { fail() }); fail() }
            catch (error: ApiError) { assertEquals(307, error.status) }
            assertEquals(1, server.requestCount)
            server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("{}"))
            try { OkHttpEventTransport().stream(request(server), { fail() }, { fail() }); fail() }
            catch (_: ProtocolException) { /* Cannot mark an HTML/JSON response as a connected stream. */ }
        }
    }

    @Test fun twentyRestAndStream401sShareOneRotation() = runTest {
        val allRejected = CompletableDeferred<Unit>()
        var rejected = 0
        var refreshes = 0
        suspend fun rejectOld() { if (++rejected == 20) allRejected.complete(Unit); allRejected.await() }
        val streams = object : EventTransport {
            override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
                if (request.accessToken == tokens().accessToken) { rejectOld(); throw ApiError.parse(401, byteArrayOf()) }
                onOpen()
            }
        }
        val credentials = MemoryCredentials().apply { value = StoredSession(serverA.value, tokens()) }
        val auth = AuthSession(HttpTransport {
            if (it.api.path == listOf("auth", "refresh")) { refreshes++; response(tokens(version = 1)) }
            else if (it.accessToken == tokens().accessToken) { rejectOld(); unauthorized() } else ok()
        }, credentials, MemoryInstances(), MemoryData(), "test", dispatcher = StandardTestDispatcher(testScheduler), eventTransport = streams)
        auth.restore()
        val handle = (auth.state.value as AuthState.SignedIn).handle
        (1..20).map { index -> async {
            if (index % 2 == 0) auth.request(handle, ApiRequest(listOf("sessions")))
            else auth.stream(handle, ApiRequest(listOf("events")), {}, {})
        } }.awaitAll()
        assertEquals(1, refreshes)
        assertEquals(tokens(version = 1).refreshToken, credentials.value!!.credentials.refreshToken)
    }

    @Test fun lateStreamRetry401CannotClearNewerRestRotation() = runTest {
        val retryStarted = CompletableDeferred<Unit>()
        val releaseRetry = CompletableDeferred<Unit>()
        var refreshes = 0
        val credentials = MemoryCredentials().apply { value = StoredSession(serverA.value, tokens()) }
        val data = MemoryData()
        val auth = AuthSession(HttpTransport { request ->
            when {
                request.api.path == listOf("auth", "refresh") -> response(tokens(version = ++refreshes))
                request.api.path == listOf("auth", "logout") -> ok()
                request.accessToken == tokens(version = 2).accessToken -> ok()
                else -> unauthorized()
            }
        }, credentials, MemoryInstances(), data, "test", dispatcher = StandardTestDispatcher(testScheduler),
            eventTransport = object : EventTransport {
                override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
                    if (request.accessToken == tokens(version = 1).accessToken) {
                        retryStarted.complete(Unit)
                        releaseRetry.await()
                    }
                    throw ApiError.parse(401, byteArrayOf())
                }
            })
        auth.restore()
        val handle = (auth.state.value as AuthState.SignedIn).handle
        auth.writeData(handle, DataKind.CACHE, "retained", byteArrayOf(1))
        val late = async { runCatching { auth.stream(handle, ApiRequest(listOf("events")), {}, {}) } }
        retryStarted.await()
        auth.request(handle, ApiRequest(listOf("sessions")))
        assertEquals(2, refreshes)
        releaseRetry.complete(Unit)
        assertEquals(401, (late.await().exceptionOrNull() as ApiError).status)
        assertSame(handle, (auth.state.value as AuthState.SignedIn).handle)
        assertEquals(tokens(version = 2).accessToken, credentials.value!!.credentials.accessToken)
        assertArrayEquals(byteArrayOf(1), auth.readData(handle, DataKind.CACHE, "retained"))
        assertEquals(2, refreshes)
    }

    @Test fun callbackErrorsCannotRefreshOrExpireStreamCredentials() = runTest {
        var requests = 0
        val auth = AuthSession(HttpTransport { requests++; ok() },
            MemoryCredentials().apply { value = StoredSession(serverA.value, tokens()) }, MemoryInstances(), MemoryData(), "test",
            dispatcher = StandardTestDispatcher(testScheduler), eventTransport = object : EventTransport {
                override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) = onOpen()
            })
        auth.restore()
        val handle = (auth.state.value as AuthState.SignedIn).handle
        try { auth.stream(handle, ApiRequest(listOf("events")), { throw ApiError.parse(401, byteArrayOf()) }, {}); fail() }
        catch (_: ApiError) { assertSame(handle, (auth.state.value as AuthState.SignedIn).handle) }
        assertEquals(0, requests)
    }
}
