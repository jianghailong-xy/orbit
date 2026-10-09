package io.orbitd.android

import io.orbitd.android.core.protocol.Wire
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
            "orbit://project/$publicId", "orbit://session/../x",
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
