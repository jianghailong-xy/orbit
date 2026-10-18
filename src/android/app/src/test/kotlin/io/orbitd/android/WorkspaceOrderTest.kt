package io.orbitd.android

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.*
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/** The drawer's workspace order is iOS's: OrbitKit AgentListLogic.ordered keeps GET /workspaces' order
 * (workspaces.service list: position asc nulls last, then createdAt asc) and moves runner-less workspaces to the bottom. */
class WorkspaceOrderTest {
    private fun workspaces(json: String) = Wire.json.decodeFromString(ListSerializer(DirectoryWorkspace.serializer()), json)
    private fun order(json: String) = orderedWorkspaces(workspaces(json)).map { it.id }

    @Test fun iosVectorsKeepTheServerOrderAndMoveOnlyRunnerlessWorkspacesDown() {
        // AgentListLogicTests.testOrderedMatchesSidebarWithHostLast (the iOS branch).
        assertEquals(listOf("1", "3", "4", "2", "5"), order("""[{"id":"1","name":"a","runnerId":"r1"},{"id":"2","name":"b"},
            {"id":"3","name":"c","runnerId":"r2"},{"id":"4","name":"d","runnerId":"r1"},{"id":"5","name":"e"}]"""))
        assertEquals(emptyList<String>(), order("[]"))
        // AgentListLogicTests.testRunnerOrderMatchesPersistedOrderWithHostLast: runner order never reshuffles workspaces.
        assertEquals(listOf("1", "3", "4", "2"), order("""[{"id":"1","name":"a","runnerId":"workstation"},{"id":"2","name":"b"},
            {"id":"3","name":"c","runnerId":"wikova"},{"id":"4","name":"d","runnerId":"macbook"}]"""))
    }

    @Test fun neverReorderedWorkspacesFollowThePlacedOnesOldestFirst() {
        // As GET /workspaces sends it: position asc nulls last, then createdAt asc.
        val server = """[
            {"id":"b","name":"b","runnerId":"r","position":0,"createdAt":"2026-10-08T01:00:06.000Z"},
            {"id":"a","name":"a","runnerId":"r","position":1,"createdAt":"2026-10-08T01:00:05.000Z"},
            {"id":"f","name":"f","runnerId":null,"position":2,"createdAt":"2026-10-08T01:00:04.000Z"},
            {"id":"d","name":"d","runnerId":null,"position":null,"createdAt":"2026-10-08T01:00:01.000Z"},
            {"id":"c","name":"c","runnerId":"r","position":null,"createdAt":"2026-10-08T01:00:02.000Z"},
            {"id":"e","name":"e","runnerId":"r","position":null,"createdAt":"2026-10-08T01:00:03.000Z"}]"""
        val ios = listOf("b", "a", "c", "e", "f", "d")
        assertEquals(ios, order(server))
        // The same rows in any other order (a cached copy, a merge) still come out in the server's order.
        val rows = workspaces(server)
        assertEquals(ios, orderedWorkspaces(rows.reversed()).map { it.id })
        assertEquals(ios, orderedWorkspaces(rows.sortedBy { it.name }).map { it.id })
        // The realtime directory's raw rows (Tasks' assignee lists, A05-2) come out in the same order.
        val raw = Wire.json.parseToJsonElement(server).jsonArray.map { it.jsonObject }
        assertEquals(ios, orderedWorkspaceRows(raw.reversed()).map { it.getValue("id").jsonPrimitive.content })
    }
}
