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
        val asked = mutableListOf<String>()
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            val key = (request.path + listOfNotNull(request.query.toMap()["view"])).joinToString("/")
            asked += key
            return ApiResponse(200, (bodies[key] ?: "[]").encodeToByteArray())
        }
    }
    private fun row(id: Int, title: String) = """{"id":"s$id","title":"$title","tags":[{"id":"t1","name":"red"}],"costUsd":0.25}"""
    private fun list(vararg rows: String) = rows.joinToString(",", "[", "]")

    @Test fun aDirectoryReadAgainKeepsTheRowsItAlreadyHolds() = runTest {
        val server = Server()
        server.bodies["sessions/open"] = list(row(1000, "running"), row(1001, "waiting"), *Array(500) { row(it, "parked $it") })
        server.bodies["workspaces"] = list("""{"id":"w1","name":"Orbit"}""")
        val rest = RealtimeRest(server)
        val first = rest.directory(handle)
        server.bodies["sessions/open"] = list(row(1000, "running again"), row(1001, "waiting"), row(1002, "new"), *Array(500) { row(it, "parked $it") })
        val second = rest.directory(handle, first)
        // Nothing changed in the parked rows: each is the object already held, so the read added no second tree.
        val before = first.sessions.getValue("open")
        val after = second.sessions.getValue("open")
        assertEquals(503, after.size)
        (0 until 500).forEach { assertSame(before[it + 2], after[it + 3]) }
        assertSame(first.workspaces.single(), second.workspaces.single())
        assertNotSame(before[0], after[0])
        assertSame(before[1], after[1])
        assertEquals(listOf("running again", "waiting", "new"), after.take(3).map { it.text("title") })
        // Kept or read anew, the snapshot is what a read with nothing held gives.
        assertEquals(rest.directory(handle), second)
    }

    /** iOS: a launch, a connect and an event read Open. An owner's Completed is 18 MB; the page showing it reads it. */
    @Test fun aDirectoryReadAsksForOpenAndNotCompletedOrTrash() = runTest {
        val server = Server()
        val rest = RealtimeRest(server)
        val snapshot = rest.directory(handle)
        assertEquals(setOf("open"), snapshot.sessions.keys)
        assertEquals(listOf("sessions/open"), server.asked.filter { it.startsWith("sessions") })
    }

    @Test fun aListThatIsNotAnArrayOfObjectsIsStillAProtocolError() = runTest {
        val server = Server()
        val rest = RealtimeRest(server)
        for (body in listOf("", "{}", "null", "[1]", """[{"id":"s1"},"s2"]""", """[{"id":"s1"}""", """[{"id":"s1"}] []""")) {
            server.bodies["sessions/open"] = body
            val error = runCatching { rest.directory(handle) }.exceptionOrNull()
            assertTrue("$body: $error", error is ProtocolException)
        }
    }

    /** The server's side of `GET sessions?view=open&since=` as open-list-delta.ts answers it: a cursor per list it built, the whole
     * list for one it does not hold, and otherwise the rows that moved, the ids that left and the order when it moved. */
    private class DeltaServer : OrbitApi {
        var rows = listOf<String>()
        val asked = mutableListOf<String?>()
        private val built = mutableMapOf<String, List<String>>()
        /** Cursors the server has forgotten (evicted, or a restart). */
        val forgotten = mutableSetOf<String>()
        private fun id(row: String) = Regex(""""id":"([^"]+)"""").find(row)!!.groupValues[1]
        override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
            val query = request.query.toMap()
            if (request.path != listOf("sessions")) return ApiResponse(200, "[]".encodeToByteArray())
            asked += query["since"]
            val cursor = "c${built.size}"
            built[cursor] = rows
            val base = query["since"]?.takeIf { it !in forgotten }?.let(built::get)
            val body = if (base == null) """{"full":true,"sessions":[${rows.joinToString(",")}],"cursor":"$cursor"}""" else {
                val upserts = rows.filter { it !in base }
                val removed = base.map(::id) - rows.map(::id).toSet()
                val order = rows.map(::id).takeIf { it != base.map(::id) }
                """{"full":false,"upserts":[${upserts.joinToString(",")}],"removedIds":[${removed.joinToString(",") { "\"$it\"" }}],""" +
                    (order?.let { o -> """"order":[${o.joinToString(",") { "\"$it\"" }}],""" } ?: "") + """"cursor":"$cursor"}"""
            }
            return ApiResponse(200, body.encodeToByteArray())
        }
    }

    /** docs/list-freshness-design.md §3: each delta applied to the list the server last sent is the list a full read gives — a row
     * added, one removed, one changed, the rows reordered, and all at once — and a forgotten cursor's `full: true` replaces it. */
    @Test fun anAppliedDeltaIsTheListAFullReadGives() = runTest {
        val server = DeltaServer()
        val rest = RealtimeRest(server)
        val full = Server()
        server.rows = listOf(row(1, "one"), row(2, "two"), row(3, "three"))
        var snapshot = rest.directory(handle, lists = setOf(DirectoryList.OPEN))
        assertEquals("the first read asks for a cursor", listOf(""), server.asked)
        val steps = listOf<(List<String>) -> List<String>>(
            { it + row(4, "added") },
            { it.filterNot { r -> r.contains("\"s2\"") } },
            { it.map { r -> if (r.contains("\"s3\"")) row(3, "changed") else r } },
            { it.reversed() },
            { listOf(row(5, "new")) + it.drop(1).map { r -> if (r.contains("\"s1\"")) row(1, "moved") else r }.reversed() },
            { it },
        )
        steps.forEachIndexed { step, change ->
            server.rows = change(server.rows)
            snapshot = rest.directory(handle, snapshot, setOf(DirectoryList.OPEN))
            full.bodies["sessions/open"] = list(*server.rows.toTypedArray())
            assertEquals("step $step", RealtimeRest(full).directory(handle).sessions, snapshot.sessions)
            assertEquals("step $step asks against the last cursor", "c$step", server.asked.last())
        }
        // The server forgot the cursor: its whole list replaces the held one.
        server.forgotten += "c${steps.size}"
        server.rows = listOf(row(9, "after a restart"))
        snapshot = rest.directory(handle, snapshot, setOf(DirectoryList.OPEN))
        assertEquals(listOf("after a restart"), snapshot.sessions.getValue("open").map { it.text("title") })
        server.rows = server.rows + row(10, "and on")
        snapshot = rest.directory(handle, snapshot, setOf(DirectoryList.OPEN))
        assertEquals("the full answer's cursor is the next base", "c${steps.size + 1}", server.asked.last())
        assertEquals(listOf("after a restart", "and on"), snapshot.sessions.getValue("open").map { it.text("title") })
    }

    /** Unchanged rows of a delta are the rows already held, as a full read keeps them. */
    @Test fun aDeltaKeepsTheRowsItDidNotChange() = runTest {
        val server = DeltaServer()
        val rest = RealtimeRest(server)
        server.rows = List(50) { row(it, "parked $it") }
        val first = rest.directory(handle, lists = setOf(DirectoryList.OPEN))
        server.rows = server.rows.mapIndexed { index, r -> if (index == 7) row(7, "moved") else r }
        val second = rest.directory(handle, first, setOf(DirectoryList.OPEN))
        val before = first.sessions.getValue("open")
        val after = second.sessions.getValue("open")
        (0 until 50).filter { it != 7 }.forEach { assertSame(before[it], after[it]) }
        assertEquals("moved", after[7].text("title"))
    }
}
