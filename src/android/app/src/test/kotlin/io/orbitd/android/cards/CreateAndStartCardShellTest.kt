package io.orbitd.android.cards

import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The single-task create card's Create and start (task 34o9etf0IZ0t5oPbYGDz9) in a conversation, over the controlled server: a task
 * the server's forecast says nothing would start, on a card the server marked `acceptsStartAfterCreate`, is offered it between
 * Create task and Chat about this, and its press posts the card's decision with `startAfterCreate`. A task that starts by itself,
 * or a card its runner cannot act on, is offered Create task alone, whose press posts the body it always has.
 */
class CreateAndStartCardShellTest : ComposerShellTest() {
    private val decision = "POST sessions/${ComposerShell.SESSION}/approvals/ct1/decision"
    @Volatile private var decided = false

    /** One task-create card whose forecast counts the task under [bucket], marked [accepts] by the server; the pending read leaves
     * it out once it is decided. */
    private fun filed(bucket: String, accepts: Boolean = true) {
        val approval = buildJsonObject {
            put("id", "ct1"); put("sessionId", ComposerShell.SESSION); put("toolName", "orbit_task_create"); put("status", "PENDING")
            put("createdAt", "2026-10-09T01:00:00.000Z")
            putJsonObject("input") {
                put("title", "Rotate the signing key"); put("description", "Replace the key the release job signs with.")
                put("completionCriterion", "EVIDENCE_JUDGMENT")
                if (accepts) put("acceptsStartAfterCreate", true)
                putJsonObject("preview") {
                    put("taskCount", 1)
                    listOf("startingNow", "blocked", "needsManualStart", "notDispatchable", "scheduled", "awaitingProjectStart").forEach {
                        put(it, if (it == bucket) 1 else 0)
                    }
                    putJsonArray("lists") { addJsonObject { put("id", "list1"); put("title", "Backlog") } }
                }
            }
        }
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/approvals"] = {
            ApiResponse(200, (if (decided) "[]" else "[$approval]").encodeToByteArray())
        }
        ComposerShell.answers[decision] = { decided = true; ApiResponse(200, """{"id":"ct1","status":"ALLOWED"}""".encodeToByteArray()) }
    }
    private fun door(verb: String) = hasTestTag("approval:ct1:$verb")
    private fun top(verb: String) = compose.onNode(door(verb)).fetchSemanticsNode().positionInRoot.y
    private fun sent() = ComposerShell.bodies.single { it.first == decision }.second

    @Test fun aTaskNothingWouldStartIsOfferedCreateAndStartWhosePressStartsIt() {
        filed("needsManualStart")
        signIn(); openSession()
        await { has(door("CREATE_AND_START")) }
        compose.onNode(door("CHAT")).performScrollTo().assertTextEquals("Chat about this")
        compose.onNode(door("CREATE_TASK")).assertTextEquals("Create task").assertIsEnabled()
        compose.onNode(door("CREATE_AND_START")).assertTextEquals("Create and start").assertIsEnabled()
        assertTrue("Create task, then Create and start, then Chat about this",
            top("CREATE_TASK") < top("CREATE_AND_START") && top("CREATE_AND_START") < top("CHAT"))
        compose.onNode(door("CREATE_AND_START")).performScrollTo().performClick()
        await { shows("Allowed · recorded by the server") }
        assertEquals("""{"behavior":"allow","startAfterCreate":true}""", sent())
    }

    @Test fun aTaskThatStartsByItselfIsOfferedCreateTaskAloneWhichStartsNothing() {
        filed("startingNow")
        signIn(); openSession()
        await { has(door("CREATE_TASK")) }
        assertTrue(shows("1 starts running within the minute"))
        assertFalse(has(door("CREATE_AND_START")))
        assertFalse(has(hasText("Create and start"), unmerged = true))
        compose.onNode(door("CREATE_TASK")).performScrollTo().performClick()
        await { shows("Allowed · recorded by the server") }
        assertEquals("""{"behavior":"allow"}""", sent())
    }

    /** An older runner's card: the same forecast, without the server's mark. The press would only create the task, so it is not
     * offered. */
    @Test fun aCardWhoseRunnerCannotActOnItIsOfferedCreateTaskAlone() {
        filed("needsManualStart", accepts = false)
        signIn(); openSession()
        await { has(door("CREATE_TASK")) }
        assertTrue(shows("1 needs a manual start"))
        assertFalse(has(door("CREATE_AND_START")))
        assertFalse(has(hasText("Create and start"), unmerged = true))
        compose.onNode(door("CREATE_TASK")).performScrollTo().performClick()
        await { shows("Allowed · recorded by the server") }
        assertEquals("""{"behavior":"allow"}""", sent())
    }
}
