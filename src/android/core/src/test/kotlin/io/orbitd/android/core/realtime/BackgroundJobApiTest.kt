package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.strings
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/** R2/R3: a job card reads its tail and asks for its stop on the owner's two routes (web `getBackgroundJobTail`, `stopBackgroundJob`). */
class BackgroundJobApiTest {
    private val handle = SessionHandle(AccountKey("https://orbit.example/", "owner"))
    private class Server(val status: Int = 200, val body: String = "") : OrbitApi {
        val asked = mutableListOf<Pair<HttpMethod, String>>()
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            asked += request.method to request.path.joinToString("/")
            return ApiResponse(status, body.encodeToByteArray()).requireSuccess()
        }
    }

    @Test fun theTailAndTheStopGoToTheJobsOwnRoutes() = runTest {
        val server = Server(body = """{"jobId":"bgj_a1","status":"running","exitCode":null,"lines":["one","two"],"truncated":false}""")
        val api = BackgroundJobApi(server, handle, "s1")
        val tail = api.tail("bgj_a1")
        assertEquals("running", tail.text("status"))
        assertEquals(listOf("one", "two"), tail.strings("lines"))
        api.stop("bgj_a1")
        assertEquals(listOf(HttpMethod.GET to "sessions/s1/background/jobs/bgj_a1/tail",
            HttpMethod.POST to "sessions/s1/background/jobs/bgj_a1/stop"), server.asked)
    }

    @Test fun aRunnerTooOldToReadItAnswersWithItsStatus() = runTest {
        try {
            BackgroundJobApi(Server(409, """{"code":"RUNNER_CANNOT_READ_JOB_OUTPUT"}"""), handle, "s1").tail("bgj_a1")
            fail("a refusal is an error")
        } catch (e: ApiError) {
            assertEquals(409, e.status)
        }
    }
}
