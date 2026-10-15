package io.orbitd.android.projects

import io.orbitd.android.navigation.DrawerCopy
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A11-2's rest: a drawer project row's amber count, counted as M2's iOS counts it (OrbitKit `ProjectAttention.needsYouItemCount`,
 * the cases of `ProjectAttentionTests`' drawer tests; web's `projectNeedsYouCount`) — the four owner items by their counts, and a
 * coordinator asking to start the project or to record it done as one each; nothing for a closed project or a kind this build
 * does not name. */
class DrawerCountTest {
    private val now = Instant.parse("2026-10-05T00:00:00Z")
    private fun at(secondsAgo: Long) = now.minusSeconds(secondsAgo).toString()
    private fun item(kind: String, count: Int, waited: Long = 3600) = """{"kind":"$kind","count":$count,"oldestWaitingSince":"${at(waited)}"}"""
    private fun project(attention: String, status: String = "OPEN") =
        Json.parseToJsonElement("""{"id":"p","title":"P","status":"$status","buckets":{"running":1},"attention":$attention}""").jsonObject
    private fun asking(waited: Long, vararg items: String) = """{"ownerItems":[${items.joinToString()}],"startRequest":{"waitingSince":"${at(waited)}"}}"""
    private fun closing(waited: Long, vararg items: String) = """{"ownerItems":[${items.joinToString()}],"doneRequest":{"waitingSince":"${at(waited)}"}}"""
    private fun count(attention: String, status: String = "OPEN") = ProjectAttention.needsYouItemCount(project(attention, status))

    @Test fun aStartRequestIsOneMoreThingWaitingOnYou() {
        assertEquals(1, count(asking(7200)))
        assertEquals(2, count(asking(60, item("COORDINATOR_QUESTION", 1, 60))))
        assertEquals("a closed project asks nothing, whatever it still carries", 0, count(asking(3600), "DONE"))
    }

    @Test fun aDoneRequestIsOneMoreThingWaitingOnYou() {
        assertEquals(1, count(closing(7200)))
        assertEquals(3, count(closing(60, item("ESCALATED", 2, 60))))
        assertEquals(0, count(closing(3600), "DONE"))
        assertEquals("both requests at once are two", 2, count("""{"ownerItems":[],"startRequest":{"waitingSince":"${at(60)}"},"doneRequest":{"waitingSince":"${at(60)}"}}"""))
    }

    @Test fun theCountIsTheItemsWaitingOnYouNotTheirKinds() {
        assertEquals(3, count("""{"ownerItems":[${item("PROMOTION_APPROVAL", 1)},${item("COORDINATOR_QUESTION", 2, 60)},${item("SOMETHING_NEW", 4)}]}"""))
        assertEquals(1, count("""{"ownerItems":[${item("FUSE_PAUSED", 1)},${item("ESCALATED", 0)}]}"""))
    }

    @Test fun quietProjectsUnknownKindsAndUnreadableRequestsCountNothing() {
        assertEquals(0, count("""{"ownerItems":[],"userBlockers":2,"coordinatorBlockers":1}"""))
        assertEquals(0, count("""{"ownerItems":[${item("SOMETHING_NEW", 1)}]}"""))
        assertEquals("a request this build cannot read names none", 0, count("""{"ownerItems":[],"doneRequest":{"since":1},"startRequest":null}"""))
        assertEquals(0, ProjectAttention.needsYouItemCount(Json.parseToJsonElement("""{"id":"p","status":"OPEN"}""").jsonObject))
    }

    /** The rule and the row as M2's Swift states them, so a change there fails here rather than drifting. */
    @Test fun theSwiftCountsAndSaysItTheSameWay() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
        val attention = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/ProjectAttention.swift").readText()
        assertTrue(attention.contains("waitingOwnerItems(project).reduce(0) { \$0 + \$1.count } + (waitingStartRequest(project) != nil ? 1 : 0)\n" +
            "            + (waitingDoneRequest(project) != nil ? 1 : 0)"))
        assertTrue(attention.contains("(project.attention?.ownerItems ?? []).filter { \$0.kind != .unknown && \$0.count > 0 }"))
        assertTrue(attention.contains("if waiting > 0 { return .needsYou(waiting) }"))
        val shell = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/CompactShell.swift").readText()
        assertTrue(shell.contains("case .needsYou(let count):\n                        NeedsYouCountCapsule(count: count)"))
        val capsule = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift").readText()
        assertTrue(capsule.contains(".accessibilityLabel(\"\\(count) waiting for you\")"))
        assertEquals("3 waiting for you", DrawerCopy.waitingForYou(3))
    }
}
