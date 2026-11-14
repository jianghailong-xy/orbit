package io.orbitd.android.core.cards

import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The owner's terminal doors (apiserver terminals.controller.ts; OrbitKit APIClient's `terminals`): each one's method and path, no
 * body on Approve and Deny, the answers read as the server writes them, and a 404 for the pending list — a server that predates
 * terminals — read as none, not an error. */
class TerminalsApiTest {
    private val handle = SessionHandle(AccountKey("https://orbit.example/", "owner"))

    private class Server(var status: Int = 200, var body: String = "{}") : OrbitApi {
        val asked = mutableListOf<String>()
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            asked += "${request.method} ${request.path.joinToString("/")}" + if (request.body != null) " body" else ""
            return ApiResponse(status, body.encodeToByteArray())
        }
    }

    @Test fun thePendingRequestsAreReadAsTheServerWritesThem() = runTest {
        val server = Server(body = """{"requests":[{"id":"q1","userCode":"7KQ-4MZ","machineName":"dev-laptop","runnerId":"r1",
            "createdAt":"2026-11-12T09:58:00.000Z","expiresAt":"2026-11-12T10:08:00.000Z","extra":true}]}""")
        val requests = TerminalsApi(server, handle).requests()
        assertEquals(listOf("GET terminals/requests"), server.asked)
        assertEquals(listOf(TerminalRequest("q1", "7KQ-4MZ", "dev-laptop", "r1", "2026-11-12T09:58:00.000Z", "2026-11-12T10:08:00.000Z")), requests)
    }

    @Test fun anOlderServersNotFoundIsNoRequestsButOtherFailuresStayFailures() = runTest {
        assertEquals(emptyList<TerminalRequest>(), TerminalsApi(Server(404, """{"message":"Cannot GET /api/terminals/requests"}"""), handle).requests())
        val failure = runCatching { TerminalsApi(Server(503, """{"message":"down"}"""), handle).requests() }.exceptionOrNull()
        assertEquals(503, (failure as ApiError).status)
    }

    @Test fun approveDenyAndRevokePressTheirDoors() = runTest {
        val server = Server()
        val api = TerminalsApi(server, handle)
        api.approve("q1")
        api.deny("q2")
        api.revoke("t1")
        assertEquals(listOf("POST terminals/requests/q1/approve", "POST terminals/requests/q2/deny", "DELETE terminals/t1"), server.asked)
    }

    @Test fun aRefusedPressThrows() = runTest {
        val api = TerminalsApi(Server(404, """{"message":"terminal sign-in not found"}"""), handle)
        assertEquals(listOf("terminal sign-in not found"), (runCatching { api.approve("q1") }.exceptionOrNull() as ApiError).messages)
    }

    @Test fun theLiveTerminalsAreReadWithANeverUsedOne() = runTest {
        val server = Server(body = """{"terminals":[{"id":"t1","machineName":"dev-laptop","runnerId":"r1","createdAt":"a","approvedAt":"b",
            "lastUsedAt":null,"expiresAt":"c"}]}""")
        val terminal = TerminalsApi(server, handle).list().single()
        assertEquals(listOf("GET terminals"), server.asked)
        assertEquals("dev-laptop", terminal.machineName)
        assertNull(terminal.lastUsedAt)
    }
}
