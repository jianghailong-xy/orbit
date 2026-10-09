package io.orbitd.android

import io.orbitd.android.core.realtime.DirectorySnapshot
import io.orbitd.android.core.realtime.RealtimeState
import io.orbitd.android.directory.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The directory as main's server answers it. A workspace nobody has dragged keeps `position: null`
 * (schema.prisma Workspace.position Int?; GET /workspaces sorts it last), and the rows carry the explicit
 * nulls the server sends for everything it has no value for. */
class DirectoryDecodingTest {
    private fun rows(json: String) = Json.parseToJsonElement(json).jsonArray.map { it.jsonObject }

    private val workspaces = """[
        {"id":"w-arranged","name":"Arranged","description":null,"model":null,"runnerId":"r1","runner":{"id":"r1","name":"host","displayName":null},
         "enabled":true,"workDir":"/srv/arranged","repoUrl":null,"position":0,"createdAt":"2026-10-08T01:00:03.000Z","deletedAt":null,"repoHealth":null,"repoCleanup":null},
        {"id":"w-never","name":"Never reordered","description":null,"model":null,"runnerId":"r1","runner":{"id":"r1","name":"host","displayName":null},
         "enabled":true,"workDir":"/srv/never","repoUrl":null,"position":null,"createdAt":"2026-10-08T01:00:02.000Z","deletedAt":null,"repoHealth":null,"repoCleanup":null},
        {"id":"w-config","name":"No runner","description":null,"model":null,"runnerId":null,"runner":null,
         "enabled":true,"workDir":null,"repoUrl":null,"position":null,"createdAt":"2026-10-08T01:00:01.000Z","deletedAt":null,"repoHealth":null,"repoCleanup":null}
    ]"""
    private val runners = """[{"id":"r1","name":"host","displayName":null,"hostname":null,"status":"ONLINE","online":true,"position":null,"version":null}]"""
    private val folders = """[{"id":"f1","workspaceId":"w-never","agentId":"w-never","name":"Research"}]"""
    private val bug = """{"id":"t1","name":"Bug","color":"#EF4444","isSystem":true,"position":0}"""
    private val tags = """[$bug,{"id":"t2","name":"Focus","color":"#3B82F6","isSystem":false,"position":0}]"""
    private val never = """{"id":"w-never","name":"Never reordered","model":null,"effort":null}"""
    /** A sessions.service list row: `workspace` (mirrored to `agent`) is null for a session with no workspace. */
    private fun session(id: String, title: String, workspace: String = never, tags: String = "[]", folderId: String = "null",
        lastTurnAt: String = "null", deletedAt: String = "null") = """{"id":"$id","status":"ENDED","title":"$title",
        "createdAt":"2026-10-08T01:05:00.000Z","lastTurnAt":$lastTurnAt,"deletedAt":$deletedAt,"pinnedAt":null,"folderId":$folderId,
        "tags":$tags,"runningBgJobCount":0,"workspace":$workspace,"agent":$workspace,"runState":"ENDED","lifecycleState":"OPEN",
        "pendingApprovals":0,"confirmationUnderReview":null,"lastAssistantText":null,"lastUserText":null,"capabilities":{"canSend":true,
        "canResume":false,"resumeBlockedReason":null,"canComplete":true,"canArchive":true,"canRestore":false}}"""
    private val sessions = mapOf(
        "open" to "[${session("s1", "Directory check", tags = "[$bug]")},${session("s2", "No workspace", workspace = "null")}]",
        "completed" to "[${session("s3", "Filed", folderId = "\"f1\"", lastTurnAt = "\"2026-10-08T01:06:00.000Z\"")}]",
        "trash" to "[${session("s4", "Deleted", deletedAt = "\"2026-10-08T01:07:00.000Z\"")}]")

    private fun directory() = directoryData(RealtimeState(directoryFresh = true, directory = DirectorySnapshot(
        workspaces = rows(workspaces), sessions = sessions.mapValues { rows(it.value) },
        folders = rows(folders), tags = rows(tags), runners = rows(runners))))

    @Test fun aWorkspaceNobodyHasReorderedIsListedInsteadOfAnUnreadableDirectory() {
        val data = directory()
        assertNull(data.error)
        assertEquals(listOf("Arranged", "Never reordered", "No runner"), data.workspaces.map { it.name })
        assertEquals(listOf(0, null, null), data.workspaces.map { it.position })
        assertEquals(listOf("Arranged", "Never reordered", "No runner"), orderedWorkspaces(data.workspaces).map { it.name })
    }

    /** The other fields the directory reads where the server may send null are already read as absent. */
    @Test fun everyRowTheServerSendsWithExplicitNullsDecodes() {
        val data = directory()
        assertNull(data.error)
        assertEquals(listOf("r1", "r1", null), data.workspaces.map { it.runnerId })
        assertEquals(listOf("host"), data.runners.map { it.name })
        assertEquals(listOf("Research"), data.folders.map { it.name })
        assertEquals(listOf("Bug", "Focus"), data.tags.map { it.name })
        val open = data.sessions.getValue("open")
        assertEquals(listOf("w-never", null), open.map { it.workspace })
        assertEquals(listOf(listOf("Bug"), emptyList()), open.map { row -> row.tags.map { it.name } })
        assertTrue(open.all { it.pinnedAt == null && it.folderId == null && it.lastTurnAt == null && it.confirmationUnderReview == null &&
            it.lastAssistantText == null && it.lastUserText == null && it.capabilities?.resumeBlockedReason == null })
        assertEquals(listOf("f1"), data.sessions.getValue("completed").map { it.folderId })
        assertEquals(listOf("Deleted"), data.sessions.getValue("trash").map { it.name })
    }
}
