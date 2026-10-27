package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.protocol.ProtocolException
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** A04c: with the cache write bounded, an owner's directory read again on every account event still ran a release build out
 * of heap: each read held its body as one string and built a second tree beside the published one. */
class RealtimeRestTest {
    private val handle = SessionHandle(AccountKey("https://orbit.example/", "owner"))
    private class Server : OrbitApi {
        /** Bodies by path, and by `view` for the session lists; any other list is empty. */
        val bodies = mutableMapOf<String, String>()
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            val key = (request.path + listOfNotNull(request.query.toMap()["view"])).joinToString("/")
            return ApiResponse(200, (bodies[key] ?: "[]").encodeToByteArray())
        }
    }
    private fun row(id: Int, title: String) = """{"id":"s$id","title":"$title","tags":[{"id":"t1","name":"red"}],"costUsd":0.25}"""
    private fun list(vararg rows: String) = rows.joinToString(",", "[", "]")

    @Test fun aDirectoryReadAgainKeepsTheRowsItAlreadyHolds() = runTest {
        val server = Server()
        server.bodies["sessions/completed"] = list(*Array(500) { row(it, "done $it") })
        server.bodies["sessions/open"] = list(row(1000, "running"), row(1001, "waiting"))
        server.bodies["workspaces"] = list("""{"id":"w1","name":"Orbit"}""")
        val rest = RealtimeRest(server)
        val first = rest.directory(handle)
        server.bodies["sessions/open"] = list(row(1000, "running again"), row(1001, "waiting"), row(1002, "new"))
        val second = rest.directory(handle, first)
        // Nothing changed in Completed: every row is the object already held, so the read added no second tree.
        val before = first.sessions.getValue("completed")
        val after = second.sessions.getValue("completed")
        assertEquals(500, after.size)
        before.indices.forEach { assertSame(before[it], after[it]) }
        assertSame(first.workspaces.single(), second.workspaces.single())
        val open = second.sessions.getValue("open")
        assertNotSame(first.sessions.getValue("open")[0], open[0])
        assertSame(first.sessions.getValue("open")[1], open[1])
        assertEquals(listOf("running again", "waiting", "new"), open.map { it.text("title") })
        // Kept or read anew, the snapshot is what a read with nothing held gives.
        assertEquals(rest.directory(handle), second)
    }

    @Test fun aListThatIsNotAnArrayOfObjectsIsStillAProtocolError() = runTest {
        val server = Server()
        val rest = RealtimeRest(server)
        for (body in listOf("", "{}", "null", "[1]", """[{"id":"s1"},"s2"]""", """[{"id":"s1"}""", """[{"id":"s1"}] []""")) {
            server.bodies["sessions/completed"] = body
            val error = runCatching { rest.directory(handle) }.exceptionOrNull()
            assertTrue("$body: $error", error is ProtocolException)
        }
    }
}
