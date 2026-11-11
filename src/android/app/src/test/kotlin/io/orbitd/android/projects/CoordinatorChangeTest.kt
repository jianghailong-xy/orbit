package io.orbitd.android.projects

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Change workspace… (docs/mocks/coordinator-move-workspace 04-change, decision D2: Android only starts a new coordinator): the
 * list's rows and the confirmation's words, held to the web's `lib/coordinatorWorkspace.ts`. */
class CoordinatorChangeTest {
    private fun obj(text: String) = Json.parseToJsonElement(text).jsonObject
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/coordinatorWorkspace.ts").isFile }
    private val web = File(root, "src/web/src/lib/coordinatorWorkspace.ts").readText()

    @Test fun everyWordIsTheWebsLiteral() {
        for (words in listOf(CoordinatorChange.button, CoordinatorChange.title, CoordinatorChange.current, CoordinatorChange.runnerOffline,
            CoordinatorChange.newConversation, CoordinatorChange.foot, CoordinatorChange.disabled, CoordinatorChange.noRunner, CoordinatorChange.cancel)) {
            assertTrue("the web no longer says '$words'", web.contains("'$words'"))
        }
        // Each sentence with the web's interpolations put back is one template literal there.
        fun template(rendered: String, vararg names: Pair<String, String>) = names.fold(rendered) { t, (from, to) -> t.replace(from, "\${$to}") }
            .let { assertTrue("the web no longer says `$it`", web.contains("`$it`")) }
        template(CoordinatorChange.title("§P", "§T"), "§P" to "project", "§T" to "to")
        template(CoordinatorChange.paragraphs("§T", "§F", CoordinatorChange.Outgoing.OPEN)[0].replace(" in §F", "§WHERE"), "§WHERE" to "where", "§T" to "to")
        template(CoordinatorChange.paragraphs("§T", "§F", CoordinatorChange.Outgoing.COMPLETED)[0].replace(" in §F", "§WHERE"), "§WHERE" to "where", "§T" to "to")
        template(CoordinatorChange.paragraphs("§T", "§F", CoordinatorChange.Outgoing.NONE)[0], "§T" to "to")
        assertTrue(web.contains("'${CoordinatorChange.paragraphs("x", null, CoordinatorChange.Outgoing.NONE)[1]}'"))
        template(CoordinatorChange.action("§T", CoordinatorChange.Outgoing.OPEN), "§T" to "to")
        template(CoordinatorChange.action("§T", CoordinatorChange.Outgoing.NONE), "§T" to "to")
    }

    /** Web `changeRowsFromWorkspaces`' own case, with Android's engine names. */
    @Test fun currentLeadsAndIsNoPressAndWhatCannotTakeANewOneIsGreyed() {
        val workspaces = listOf(
            obj("""{"id":"w2","name":"orbit-prod","enabled":true,"runnerId":"r1","runner":{"displayName":"workstation-gpu"},"lastProvider":"claude"}"""),
            obj("""{"id":"w1","name":"orbit","enabled":true,"runnerId":"r1"}"""),
            obj("""{"id":"w3","name":"HPC","enabled":true,"runnerId":null}"""),
            obj("""{"id":"w4","name":"mac-tools","enabled":false,"runnerId":"r1"}"""),
            obj("""{"id":"w5","name":"wikova","enabled":true,"runnerId":"r2","lastProvider":"codex"}"""),
        )
        val rows = CoordinatorChange.rows(workspaces, "w1", setOf("r1"))
        assertEquals(listOf(
            CoordinatorChange.Row("w1", "orbit", "Claude Code", null, current = true, runnerOffline = false),
            CoordinatorChange.Row("w2", "orbit-prod", "Claude Code · workstation-gpu", null, current = false, runnerOffline = false),
            CoordinatorChange.Row("w3", "HPC", "This workspace has no runner.", "This workspace has no runner.", current = false, runnerOffline = false),
            CoordinatorChange.Row("w4", "mac-tools", "This workspace is disabled.", "This workspace is disabled.", current = false, runnerOffline = false),
            CoordinatorChange.Row("w5", "wikova", "Codex", null, current = false, runnerOffline = true),
        ), rows)
        // Every press opens a new conversation, and says so; the current workspace and a greyed one are no press.
        assertEquals(listOf(false, true, false, false, true), rows.map { it.pickable })
        assertEquals(listOf("Claude Code", "Claude Code · workstation-gpu · New conversation", "This workspace has no runner.",
            "This workspace is disabled.", "Codex · New conversation"), rows.map { it.line })
        // Liveness not read yet is no note rather than a wrong one; with no current workspace none is marked.
        assertEquals(listOf(false, false, false, false, false), CoordinatorChange.rows(workspaces, null, null).map { it.runnerOffline })
        assertEquals(listOf(false, false, false, false, false), CoordinatorChange.rows(workspaces, null, null).map { it.current })
    }

    @Test fun theQuestionSaysWhereTheOldConversationStaysAndTheButtonWhatItDoes() {
        fun status(session: String?) = obj("""{"state":"LIVE","coordination":{"workspaceName":"orbit","session":${session ?: "null"}}}""")
        assertEquals(CoordinatorChange.Outgoing.OPEN, CoordinatorChange.outgoing(status("""{"lifecycleState":"ACTIVE"}""")))
        assertEquals(CoordinatorChange.Outgoing.COMPLETED, CoordinatorChange.outgoing(status("""{"lifecycleState":"COMPLETED"}""")))
        assertEquals(CoordinatorChange.Outgoing.NONE, CoordinatorChange.outgoing(status("""{"lifecycleState":"ACTIVE","deletedAt":"2026-11-11T00:00:00Z"}""")))
        assertEquals(CoordinatorChange.Outgoing.NONE, CoordinatorChange.outgoing(status(null)))
        assertEquals(CoordinatorChange.Outgoing.NONE, CoordinatorChange.outgoing(null as JsonObject?))

        assertEquals("Coordinate Website Revamp from orbit-prod?", CoordinatorChange.title("Website Revamp", "orbit-prod"))
        assertEquals(listOf(
            "It is completed — a turn in flight finishes first — and stays readable in orbit. A new, empty one opens in wikova.",
            "Its tasks keep running where they are.",
        ), CoordinatorChange.paragraphs("wikova", "orbit", CoordinatorChange.Outgoing.OPEN))
        assertEquals("It stays completed and readable in a. A new, empty one opens in b.",
            CoordinatorChange.paragraphs("b", "a", CoordinatorChange.Outgoing.COMPLETED)[0])
        assertEquals(listOf("A new, empty one opens in b.", "Its tasks keep running where they are."),
            CoordinatorChange.paragraphs("b", null, CoordinatorChange.Outgoing.NONE))
        assertEquals("Complete and start in wikova", CoordinatorChange.action("wikova", CoordinatorChange.Outgoing.OPEN))
        assertEquals("Start in b", CoordinatorChange.action("b", CoordinatorChange.Outgoing.COMPLETED))
        assertEquals("Start in b", CoordinatorChange.action("b", CoordinatorChange.Outgoing.NONE))
    }
}
