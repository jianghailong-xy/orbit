package io.orbitd.android.projects

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Start a new coordinator in… (docs/mocks/coordinator-move-workspace 03-final): the picker's rows and the confirmation's words,
 * held to the web's `lib/coordinatorWorkspace.ts`, which the iOS half follows on its own schedule. */
class StartCoordinatorInTest {
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/coordinatorWorkspace.ts").isFile }
    private val web = File(root, "src/web/src/lib/coordinatorWorkspace.ts").readText()

    @Test fun everyWordIsTheWebsLiteral() {
        for (words in listOf(StartCoordinatorIn.menuTitle, StartCoordinatorIn.menuDetail, StartCoordinatorIn.pickerTitle, StartCoordinatorIn.current,
            StartCoordinatorIn.runnerOffline, StartCoordinatorIn.disabled, StartCoordinatorIn.noRunner, StartCoordinatorIn.keep)) {
            assertTrue("the web no longer says '$words'", web.contains("'$words'"))
        }
        assertTrue(web.contains("\"${StartCoordinatorIn.pickerFoot}\""))
        // Each sentence with the web's interpolations put back is one template literal there.
        fun template(rendered: String, vararg names: Pair<String, String>) = names.fold(rendered) { t, (from, to) -> t.replace(from, "\${$to}") }
            .let { assertTrue("the web no longer says `$it`", web.contains("`$it`")) }
        template(StartCoordinatorIn.title("§W"), "§W" to "workspace")
        val open = StartCoordinatorIn.paragraphs("§P", "§T", "§F", StartCoordinatorIn.Outgoing.OPEN)
        template(open[0].replace(" in §F", "§WHERE"), "§WHERE" to "where")
        template(open[1], "§P" to "project", "§T" to "to")
        template(StartCoordinatorIn.paragraphs("§P", "§T", "§F", StartCoordinatorIn.Outgoing.COMPLETED)[0].replace(" in §F", "§WHERE"), "§WHERE" to "where")
        template(StartCoordinatorIn.action("§W", StartCoordinatorIn.Outgoing.OPEN), "§W" to "workspace")
        template(StartCoordinatorIn.action("§W", StartCoordinatorIn.Outgoing.NONE), "§W" to "workspace")
    }

    @Test fun rowsGreyWhatCannotOpenAndMarkCurrentAndOffline() {
        val workspaces = listOf(
            obj("""{"id":"w1","name":"orbit","enabled":true,"runnerId":"r1","runner":{"name":"gpu","displayName":"workstation-gpu"},"lastProvider":"claude"}"""),
            obj("""{"id":"w2","name":"wikova-develop","runnerId":"r2","runner":{"name":"wikova"},"lastProvider":"codex"}"""),
            obj("""{"id":"w3","name":"HPC","enabled":true,"runnerId":null}"""),
            obj("""{"id":"w4","name":"Old","enabled":false,"runnerId":"r1"}"""),
        )
        val rows = StartCoordinatorIn.rows(workspaces, "w1", setOf("r1"))
        assertEquals(listOf(
            StartCoordinatorIn.Row("w1", "orbit", "Claude Code · workstation-gpu", null, current = true, runnerOffline = false),
            StartCoordinatorIn.Row("w2", "wikova-develop", "Codex · wikova", null, current = false, runnerOffline = true),
            StartCoordinatorIn.Row("w3", "HPC", "This workspace has no runner.", "This workspace has no runner.", current = false, runnerOffline = false),
            StartCoordinatorIn.Row("w4", "Old", "This workspace is disabled.", "This workspace is disabled.", current = false, runnerOffline = false),
        ), rows)
        // Liveness not read yet is no note rather than a wrong one.
        assertEquals(listOf(false, false, false, false), StartCoordinatorIn.rows(workspaces, null, null).map { it.runnerOffline })
        assertEquals(listOf(false, false, false, false), StartCoordinatorIn.rows(workspaces, null, null).map { it.current })
    }

    @Test fun theQuestionSaysWhereTheOldConversationStaysAndTheButtonWhatItDoes() {
        fun status(session: String?) = obj("""{"state":"LIVE","coordination":{"workspaceName":"orbit","session":${session ?: "null"}}}""")
        assertEquals(StartCoordinatorIn.Outgoing.OPEN, StartCoordinatorIn.outgoing(status("""{"lifecycleState":"ACTIVE"}""")))
        assertEquals(StartCoordinatorIn.Outgoing.COMPLETED, StartCoordinatorIn.outgoing(status("""{"lifecycleState":"COMPLETED"}""")))
        assertEquals(StartCoordinatorIn.Outgoing.NONE, StartCoordinatorIn.outgoing(status("""{"lifecycleState":"ACTIVE","deletedAt":"2026-11-11T00:00:00Z"}""")))
        assertEquals(StartCoordinatorIn.Outgoing.NONE, StartCoordinatorIn.outgoing(status(null)))
        assertEquals(StartCoordinatorIn.Outgoing.NONE, StartCoordinatorIn.outgoing(null as JsonObject?))

        assertEquals("Start a new coordinator in orbit-prod?", StartCoordinatorIn.title("orbit-prod"))
        assertEquals(listOf(
            "The current conversation is completed — a turn in flight finishes first — and stays readable in orbit.",
            "Session list redesign is coordinated from a new, empty conversation in orbit-prod, and its row moves to orbit-prod’s list. Its tasks keep running where they are.",
        ), StartCoordinatorIn.paragraphs("Session list redesign", "orbit-prod", "orbit", StartCoordinatorIn.Outgoing.OPEN))
        assertEquals("The current conversation stays completed and readable.",
            StartCoordinatorIn.paragraphs("P", "x", null, StartCoordinatorIn.Outgoing.COMPLETED)[0])
        assertEquals(1, StartCoordinatorIn.paragraphs("P", "x", "orbit", StartCoordinatorIn.Outgoing.NONE).size)
        assertEquals("Complete and start in orbit-prod", StartCoordinatorIn.action("orbit-prod", StartCoordinatorIn.Outgoing.OPEN))
        assertEquals("Start in orbit-prod", StartCoordinatorIn.action("orbit-prod", StartCoordinatorIn.Outgoing.COMPLETED))
        assertEquals("Start in orbit-prod", StartCoordinatorIn.action("orbit-prod", StartCoordinatorIn.Outgoing.NONE))
    }
}
