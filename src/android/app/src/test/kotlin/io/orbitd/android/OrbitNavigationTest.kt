package io.orbitd.android

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.DirectoryWorkspace
import io.orbitd.android.directory.SessionProjectMembership
import io.orbitd.android.navigation.*
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class OrbitNavigationTest {
    private val publicId = "34TcwNgAIo6tGUiIKjqnQ"
    private val uuid = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"

    @Test fun coldDeepLinkSurvivesLoginAndProcessStateRoundTrip() {
        val route = OrbitLinks.parse("orbit://session/$publicId?at=$publicId", origin = Origin.EXTERNAL)!!
        val waiting = OrbitNavigation().receive(route)
        assertEquals(Destination.WORKSPACES, waiting.current.destination)
        val recreated = Wire.json.decodeFromString<OrbitNavigation>(Wire.json.encodeToString(waiting))
        val signedIn = recreated.bindAccount("https://one|user")
        assertEquals(route, signedIn.current)
        assertEquals(uuid, signedIn.current.recordId)
        assertNull(signedIn.pending)
        assertEquals(Destination.WORKSPACES, signedIn.back().current.destination)
    }

    /** A05-8 (iOS 3d50935b4, the coordinator's call to follow it): within a destination Back walks its return path —
     * a folder, a search, a session the search opened and the objects it links to — and a drawer row for another
     * destination lands on that destination's root, the stack it leaves going with it. This replaces
     * `folderSearchAndCrossObjectReturnPathsAreRetainedPerSection`, which pinned every section keeping its stack
     * across a switch: switching to Tasks and back used to bring the whole path back. */
    @Test fun returnPathsHoldWithinADestinationAndEachDrawerRowLandsOnItsRoot() {
        val root = OrbitRoute(Destination.WORKSPACE, "w1")
        val folder = OrbitRoute(Destination.FOLDER, "f1", "w1")
        val search = OrbitRoute(Destination.SEARCH)
        val path = OrbitNavigation().bindAccount("server|user").select("w1", root)
            .push(folder).push(search).push(OrbitRoute(Destination.SESSION, uuid, origin = Origin.SEARCH))
            .push(OrbitRoute(Destination.TASK, uuid, origin = Origin.LINK))
            .push(OrbitRoute(Destination.PROJECT, uuid, origin = Origin.LINK))
            .push(OrbitRoute(Destination.WIKI_ENTRY, uuid, origin = Origin.LINK))
            .push(OrbitRoute(Destination.WATCH, uuid, origin = Origin.LINK))
        var nav = path
        repeat(5) { nav = nav.back() }
        assertEquals(search, nav.current)
        assertEquals(folder, nav.back().current)
        val tasks = path.select("Tasks", OrbitRoute(Destination.TASKS))
        assertEquals(listOf(OrbitRoute(Destination.TASKS)), tasks.frames)
        assertEquals("the stack it left goes", setOf("Tasks"), tasks.stacks.keys)
        val again = tasks.select("w1", root)
        assertEquals("the workspace again, at its root", listOf(root), again.frames)
        assertFalse(again.canGoBack)
    }

    /** The row of the destination already showing only closes the drawer: the page on top of it stays. */
    @Test fun theDestinationAlreadyShowingStaysWhereItIs() {
        val task = OrbitNavigation().bindAccount("server|user").select("Tasks", OrbitRoute(Destination.TASKS))
            .push(OrbitRoute(Destination.TASK, uuid))
        assertEquals(task, task.select("Tasks", OrbitRoute(Destination.TASKS)))
    }

    /** A page that sends the reader to a workspace (a runner's, a deleted workspace's settings) lands on that
     * workspace's root even when it is the destination already showing — unlike a drawer row. */
    @Test fun aPageSendingTheReaderToADestinationLandsOnItsRoot() {
        val root = OrbitRoute(Destination.WORKSPACE, "w1", "w1")
        val runner = OrbitNavigation().bindAccount("server|user").select("w1", root).push(OrbitRoute(Destination.RUNNER, "r1"))
        assertEquals(listOf(root), runner.land("w1", root).frames)
        assertEquals(listOf(OrbitRoute(Destination.WORKSPACES)), runner.land("workspaces", OrbitRoute(Destination.WORKSPACES)).frames)
    }

    /** A drawer project row is a destination of its own; the two spellings of a project's id are one destination. */
    @Test fun aProjectIsADestinationOfItsOwn() {
        assertEquals(projectDestination(publicId), projectDestination(uuid))
        val project = OrbitNavigation().bindAccount("server|user").select("Tasks", OrbitRoute(Destination.TASKS))
            .select(projectDestination(publicId), OrbitRoute(Destination.PROJECT, publicId, origin = Origin.DRAWER))
        assertEquals(listOf(OrbitRoute(Destination.PROJECT, publicId, origin = Origin.DRAWER)), project.frames)
        assertFalse(project.canGoBack)
    }

    /** A11-9's push (iOS 6b4bef713): `orbit://project/<id>` is a merge's project sessions page, which names no workspace, so it waits —
     * through the login and the process state, and while signed in, over whatever is showing — until the shell has read the directory
     * and lands it as its project's root, as the drawer's row does. A later link replaces it; a switch of account drops it. */
    @Test fun aMergesPushWaitsForTheDirectoryAndLandsAsItsProjectsRoot() {
        val arrival = OrbitLinks.parse("orbit://project/$publicId", origin = Origin.EXTERNAL)!!
        assertEquals(OrbitRoute(Destination.PROJECT_SESSIONS, uuid, origin = Origin.EXTERNAL), arrival)
        assertTrue(arrival.waitsForDirectory)
        val showing = OrbitNavigation().bindAccount("server|user").select("w1", OrbitRoute(Destination.WORKSPACE, "w1", "w1"))
            .push(OrbitRoute(Destination.SESSION, uuid, "w1"))
        val waiting = showing.receive(arrival)
        assertEquals(showing.stacks, waiting.stacks)
        assertEquals(arrival, waiting.pending)
        val root = OrbitRoute(Destination.PROJECT_SESSIONS, uuid, "w2", origin = Origin.EXTERNAL)
        assertFalse(root.waitsForDirectory)
        val landed = waiting.landPending(root)
        assertEquals(projectDestination(publicId), landed.section)
        assertEquals(listOf(root), landed.frames)
        assertEquals("the stack it left goes", setOf(projectDestination(uuid)), landed.stacks.keys)
        assertFalse(landed.canGoBack)
        assertNull(landed.pending)

        val cold = Wire.json.decodeFromString<OrbitNavigation>(Wire.json.encodeToString(OrbitNavigation().receive(arrival)))
            .bindAccount("server|user")
        assertEquals(listOf(OrbitRoute(Destination.WORKSPACES)), cold.frames)
        assertEquals(arrival, cold.pending)
        assertNull(cold.bindAccount("server|other").pending)

        val task = OrbitRoute(Destination.TASK, uuid, origin = Origin.EXTERNAL)
        val later = waiting.receive(task)
        assertNull(later.pending)
        assertEquals(task, later.current)
        assertTrue(later.canGoBack)
    }

    /** A project's root page (iOS `openProjectSessions(_:inColumn: false)`): its sessions page over its coordinator's workspace — or the
     * one showing, or the first in the drawer's order — and the project's own page when no workspace is known. */
    @Test fun aProjectsRootIsItsSessionsPageOverItsCoordinatorsWorkspace() {
        val workspaces = listOf(DirectoryWorkspace("w2", "Beta", "r1", position = 1), DirectoryWorkspace("w1", "Alpha", "r1", position = 0))
        val coordinator = DirectorySession("c1", agentId = "w2",
            projectMembership = SessionProjectMembership(uuid, role = "COORDINATOR"))
        val member = DirectorySession("m1", agentId = "w1", projectMembership = SessionProjectMembership(uuid, role = "TASK"))
        val data = DirectoryData(workspaces = workspaces, sessions = mapOf("open" to listOf(member), "completed" to listOf(coordinator)))
        assertEquals(OrbitRoute(Destination.PROJECT_SESSIONS, publicId, "w2", origin = Origin.EXTERNAL),
            projectRoot(publicId, data, "w1", Origin.EXTERNAL))
        val noCoordinator = data.copy(sessions = mapOf("open" to listOf(member)))
        assertEquals("w2", projectRoot(publicId, noCoordinator, "w2", Origin.DRAWER).workspaceId)
        assertEquals("w1", projectRoot(publicId, noCoordinator, null, Origin.DRAWER).workspaceId)
        assertEquals(OrbitRoute(Destination.PROJECT, publicId, origin = Origin.EXTERNAL), projectRoot(publicId, DirectoryData(), null, Origin.EXTERNAL))
    }

    /** A05-3: a session completed or moved to Trash from its own page leaves the stack, in either spelling of its id
     * (iOS `NavState.removeConsole`); a stack it is not on stays as it is. */
    @Test fun aSessionLeavingItsPageLeavesTheStack() {
        val root = OrbitRoute(Destination.WORKSPACE, "w1")
        val nav = OrbitNavigation().bindAccount("server|user").select("w1", root)
            .push(OrbitRoute(Destination.SESSION, uuid)).push(OrbitRoute(Destination.TASK, uuid)).push(OrbitRoute(Destination.SESSION, publicId, origin = Origin.LINK))
        assertEquals(listOf(root, OrbitRoute(Destination.TASK, uuid)), nav.dropSession(publicId).frames)
        val other = OrbitNavigation().bindAccount("server|user").select("w1", root)
        assertEquals(other, other.dropSession(publicId))
    }

    /** Copy Link's address names the session by its public id, as the deployment's own routes do (OrbitKit `PublicID.toPublic`). */
    @Test fun aSessionsPublicIdIsItsUuidInBase62() {
        assertEquals(publicId, ObjectId.toPublic(uuid))
        assertEquals(publicId, ObjectId.toPublic(publicId))
    }

    @Test fun accountAndInstanceChangesDiscardEveryOldPathAndPendingObject() {
        val nav = OrbitNavigation().bindAccount("server1|user1").push(OrbitRoute(Destination.TASK, uuid))
        listOf(null, "server2|user1", "server1|user2").forEach { scope ->
            val reset = nav.bindAccount(scope)
            assertFalse(reset.canGoBack)
            assertEquals(Destination.WORKSPACES, reset.current.destination)
            assertNull(reset.pending)
        }
    }

    @Test fun rejectsForeignInstancePrivilegedPathsMalformedIdsAndUnsupportedIosSchemes() {
        listOf("https://other.test/tasks/$publicId", "https://orbitd.io:444/tasks/$publicId",
            "https://orbitd.io/api/sessions/$publicId", "https://orbitd.io/s/$publicId",
            "orbit://projects/$publicId", "orbit://session/../x",
            "orbit-task:invalid!", "orbit://watch/zzzzzzzzzzzzzzzzzzzzzz", "https://orbitd.io/lists/none").forEach {
            assertNull(it, OrbitLinks.parse(it, "https://orbitd.io"))
        }
        assertEquals(uuid, OrbitLinks.parse("https://orbitd.io:443/tasks/$publicId", "https://orbitd.io")!!.id)
        assertEquals(uuid, OrbitLinks.parse("https://orbitd.io/install1/tasks/$publicId", "https://orbitd.io/install1")!!.id)
        assertNull(OrbitLinks.parse("https://orbitd.io/tasks/$publicId", "https://orbitd.io/install1"))
        assertNull(OrbitLinks.parse("orbit://session/$publicId?at=bad!", null)!!.recordId)
    }

    @Test fun objectLinksConsumeExistingCrossPlatformGoldenTargets() {
        val fixture = File("../../shared/src/orbit-link.fixture.json").takeIf { it.exists() }
            ?: File("../src/shared/src/orbit-link.fixture.json")
        val root = Wire.json.parseToJsonElement(fixture.readText()).jsonObject
        var checked = 0
        root.getValue("cases").jsonArray.forEach { c ->
            val row = c.jsonObject
            val host = row["host"]?.jsonPrimitive?.content ?: root.getValue("host").jsonPrimitive.content
            row.getValue("blocks").jsonArray.forEach { block ->
                val card = block.jsonObject["card"] as? JsonObject ?: return@forEach
                val raw = (card["url"] ?: card["ref"])!!.jsonPrimitive.content
                val result = OrbitLinks.parse(raw, if (host.contains("://")) host else "https://$host")
                assertNotNull(raw, result)
                assertEquals(raw, card.getValue("id").jsonPrimitive.content, result!!.id)
                checked++
            }
        }
        assertEquals("Every golden card target must be consumed", root.getValue("cases").jsonArray.sumOf { c -> c.jsonObject.getValue("blocks").jsonArray.count { it.jsonObject.containsKey("card") } }, checked)
        assertTrue(checked > 0)
    }
}
