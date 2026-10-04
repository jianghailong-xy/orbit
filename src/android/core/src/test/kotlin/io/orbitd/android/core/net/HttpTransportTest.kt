package io.orbitd.android.core.net

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.MemoryCredentials
import io.orbitd.android.core.auth.MemoryData
import io.orbitd.android.core.auth.MemoryInstances
import io.orbitd.android.core.auth.tokens
import io.orbitd.android.core.protocol.Wire
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.*
import org.junit.Test

class HttpTransportTest {
    private fun MockWebServer.address() = ServerAddress.parse(url("/prefix").toString(), true)

    @Test fun uploadProgressReportsChunkWritesWithoutChangingBytesOrRetrying503() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(503))
            val bytes = ByteArray(240_123) { (it % 251).toByte() }
            val progress = java.util.concurrent.CopyOnWriteArrayList<Pair<Long, Long>>()
            val response = OkHttpTransport().execute(HttpRequest(server.address(), ApiRequest(listOf("attachments"),
                HttpMethod.POST, body = bytes, contentType = "application/octet-stream", onUploadProgress = { sent, total -> progress += sent to total }), "test"))
            assertEquals(503, response.status); assertEquals(1, server.requestCount)
            assertArrayEquals(bytes, server.takeRequest().body.readByteArray())
            assertEquals(0L, progress.first().first); assertEquals(bytes.size.toLong(), progress.last().first)
            assertTrue(progress.size > 3); assertTrue(progress.all { it.second == bytes.size.toLong() })
            assertTrue(progress.zipWithNext().all { (a, b) -> a.first < b.first })
        }
    }

    @Test fun readingLimitsBoundBothDeclaredAndChunkedBinaryResponses() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("x".repeat(100)))
            server.enqueue(MockResponse().setChunkedBody("x".repeat(100), 5))
            server.enqueue(MockResponse().setBody("12345678"))
            val transport = OkHttpTransport()
            val request = HttpRequest(server.address(), ApiRequest(listOf("attachments", "id"), maxResponseBytes = 8), "test")
            repeat(2) {
                try { transport.execute(request); fail("Oversized resource must not be buffered") }
                catch (_: NetworkException) { }
            }
            assertEquals("12345678", transport.execute(request).body.decodeToString())
        }
    }

    @Test fun loginRefreshRetryAndLogoutUseTheWireContractAndIdenticalMutationBody() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody(Wire.json.encodeToString(tokens())))
            server.enqueue(MockResponse().setResponseCode(401))
            server.enqueue(MockResponse().setBody(Wire.json.encodeToString(tokens(version = 1))))
            server.enqueue(MockResponse().setBody("{}"))
            server.enqueue(MockResponse().setBody("{\"success\":true}"))
            val client = AuthSession(OkHttpTransport(), MemoryCredentials(), MemoryInstances(), MemoryData(), "0.1.0-a03", true)
            val handle = client.login(server.address(), "alice@example.test", "fixture-password")
            val body = """{"clientTurnId":"same-turn","message":"Hello"}""".encodeToByteArray()
            client.request(handle, ApiRequest(listOf("sessions", "s1", "turn"), HttpMethod.POST, body = body))
            client.logout()
            val calls = List(5) { server.takeRequest(5, TimeUnit.SECONDS)!! }
            assertTrue(calls.all { it.getHeader("X-Orbit-Client") == "android/0.1.0-a03" })
            assertEquals(listOf("/prefix/api/auth/login", "/prefix/api/sessions/s1/turn", "/prefix/api/auth/refresh", "/prefix/api/sessions/s1/turn", "/prefix/api/auth/logout"), calls.map { it.path })
            assertNull(calls[0].getHeader("Authorization"))
            assertNull(calls[2].getHeader("Authorization"))
            assertNull(calls[4].getHeader("Authorization"))
            assertTrue(calls[1].getHeader("Authorization") == "Bearer ${tokens().accessToken}")
            assertTrue(calls[3].getHeader("Authorization") == "Bearer ${tokens(version = 1).accessToken}")
            assertArrayEquals(body, calls[1].body.readByteArray())
            assertArrayEquals(body, calls[3].body.readByteArray())
            assertTrue(calls[4].body.readUtf8().contains(tokens(version = 1).refreshToken))
        }
    }

    @Test fun redirectsAndHttp503NeverResubmitAuthCredentials() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", server.url("/leak")))
            server.enqueue(MockResponse().setResponseCode(503).setHeader("Retry-After", "0"))
            val transport = OkHttpTransport()
            val request = HttpRequest(server.address(), ApiRequest(listOf("auth", "refresh"), HttpMethod.POST,
                body = "{\"refreshToken\":\"fixture-refresh\"}".encodeToByteArray()), "test")
            assertEquals(307, transport.execute(request).status)
            assertEquals(1, server.requestCount)
            assertEquals(503, transport.execute(request).status)
            assertEquals(2, server.requestCount)
        }
    }

    @Test fun callerCancellationCancelsTheSocketCall() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val call = async(kotlinx.coroutines.Dispatchers.IO) {
                OkHttpTransport().execute(HttpRequest(server.address(), ApiRequest(listOf("users", "me")), "test"))
            }
            assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            call.cancel()
            withTimeout(2_000) { call.join() }
            assertTrue(call.isCancelled)
        }
    }
}
