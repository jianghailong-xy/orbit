package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.SessionSnapshot
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The plain tool-call card reads the call, not its JSON (web `ToolCallBody.test.tsx`, board docs/mocks/tool-call-card). */
class ToolCallCardTest {
    private fun snap(approval: JsonObject) = SessionSnapshot(buildJsonObject { put("id", "s1") }, listOf(approval), emptyList(), emptyList(), emptyMap())
    private fun input(json: String) = Json.parseToJsonElement(json).jsonObject
    private fun chips(tool: String, json: String) = ToolCalls.chips(tool, input(json)).map { it.label }

    @Test fun theHeadingAsksWhatTheCallDoes() {
        val none = input("{}")
        assertEquals("Run a command?", ToolCalls.heading("Bash", none))
        assertEquals("Edit a file?", ToolCalls.heading("Edit", none))
        assertEquals("Edit a file?", ToolCalls.heading("MultiEdit", none))
        assertEquals("Write a file?", ToolCalls.heading("Write", none))
        assertEquals("Read a file?", ToolCalls.heading("Read", none))
        assertEquals("Edit a notebook?", ToolCalls.heading("NotebookEdit", none))
        assertEquals("Fetch a web page?", ToolCalls.heading("WebFetch", none))
        assertEquals("Search the web?", ToolCalls.heading("WebSearch", none))
        assertEquals("Search files?", ToolCalls.heading("Grep", none))
        assertEquals("Search files?", ToolCalls.heading("Glob", none))
        assertEquals("Run a command?", ToolCalls.heading("mcp__shell__exec", input("""{"command":"ls"}""")))
        assertEquals("Approve tool call?", ToolCalls.heading("mcp__x__y", input("""{"command":7}""")))
        assertEquals("Approve tool call?", ToolCalls.heading("mcp__x__y", none))
    }

    @Test fun durationsReadInMinutesOrSeconds() {
        assertEquals("10 min", ToolCalls.duration(600_000.0))
        assertEquals("1.5 min", ToolCalls.duration(90_000.0))
        assertEquals("2 min", ToolCalls.duration(119_999.0))
        assertEquals("45 s", ToolCalls.duration(45_000.0))
    }

    @Test fun aCommandNamesTheSettingsThatChangeTheRisk() {
        val all = ToolCalls.chips("Bash", input("""{"command":"make","timeout":600000,"run_in_background":true,"dangerouslyDisableSandbox":true}"""))
        assertEquals(listOf("timeout 10 min", "runs in background", "sandbox off"), all.map { it.label })
        assertEquals(listOf(false, false, true), all.map { it.warn })
        assertEquals(emptyList<String>(), chips("Bash", """{"command":"make","run_in_background":false}"""))
    }

    @Test fun fileToolsCarryTheirOwnChips() {
        assertEquals(listOf("Every occurrence"), chips("Edit", """{"file_path":"/a","old_string":"x","new_string":"y","replace_all":true}"""))
        assertEquals(listOf("2 edits"), chips("MultiEdit", """{"file_path":"/a","edits":[{"old_string":"a","new_string":"b"},{"old_string":"c","new_string":"d"}]}"""))
        assertEquals(listOf("3 lines"), chips("Write", """{"file_path":"/a","content":"1\n2\n3"}"""))
        assertEquals(listOf("1 line"), chips("Write", """{"file_path":"/a","content":"1"}"""))
        assertEquals(listOf("lines 240–399"), chips("Read", """{"file_path":"/a","offset":240,"limit":160}"""))
        assertEquals(listOf("from line 240"), chips("Read", """{"file_path":"/a","offset":240}"""))
        assertEquals(emptyList<String>(), chips("Read", """{"file_path":"/a"}"""))
        assertEquals(listOf("in src/web/src", "*.css"),
            chips("Grep", """{"pattern":"approval-input","path":"/root/.orbit/worktrees/abc/src/web/src","glob":"*.css"}"""))
    }

    @Test fun eachToolTakesItsShape() {
        assertEquals(ToolCalls.Shape.COMMAND, ToolCalls.shape("Bash", input("{}")))
        assertEquals(ToolCalls.Shape.COMMAND, ToolCalls.shape("mcp__x", input("""{"command":"ls"}""")))
        assertEquals(ToolCalls.Shape.EDIT, ToolCalls.shape("Edit", input("""{"command":"ls"}""")))
        assertEquals(ToolCalls.Shape.FILE, ToolCalls.shape("NotebookEdit", input("""{"notebook_path":"/n.ipynb"}""")))
        assertEquals(ToolCalls.Shape.FIELDS, ToolCalls.shape("Read", input("{}")))
        assertEquals(ToolCalls.Shape.FETCH, ToolCalls.shape("WebFetch", input("""{"url":"https://example.com"}""")))
        assertEquals(ToolCalls.Shape.FIELDS, ToolCalls.shape("mcp__linear__create_issue", input("""{"title":"x"}""")))
    }

    @Test fun theDescriptionIsShownOnceWithTheOriginalBesideATranslation() {
        assertNull(ToolCalls.description(null, null))
        assertEquals(ToolCalls.Description("Run the web tests"), ToolCalls.description("Run the web tests", null))
        assertEquals(ToolCalls.Description("Run the web tests"), ToolCalls.description("Run the web tests", "Run the web tests"))
        assertEquals(ToolCalls.Description("ウェブのテストを実行", "Run the web tests"), ToolCalls.description("ウェブのテストを実行", "Run the web tests"))
        // A fetch with no description leads with its prompt.
        assertEquals(ToolCalls.Description("Summarize the notes"),
            ToolCalls.descriptionLine("WebFetch", input("""{"url":"https://example.com/notes","prompt":"Summarize the notes"}""")))
    }

    @Test fun aTranslatedCardKeepsTheAgentsOwnWordsAndTitlesTheCall() {
        val approval = input("""{"id":"ap1","sessionId":"s1","toolName":"Bash","status":"PENDING",
            "input":{"command":"npm test","description":"Run the web tests"},"translation":{"lang":"ja","description":"ウェブのテストを実行"}}""")
        val card = CardCatalog.session("s1", snap(approval)).single()
        assertEquals("Run a command?", card.title)
        assertEquals(ToolCalls.Description("ウェブのテストを実行", "Run the web tests"),
            ToolCalls.descriptionLine("Bash", card.source.obj("input")!!, card.context))
        // Orbit's own asks keep their own title.
        val merge = input("""{"id":"ap2","sessionId":"s1","toolName":"${ApprovalRules.mergeCheckChange}","status":"PENDING","input":{}}""")
        assertEquals(LandingCheckCopy.confirmTitle,
            CardCatalog.session("s1", snap(merge)).single().title)
    }

    @Test fun longTextFoldsAfterTwelveLines() {
        val text = (0 until 31).joinToString("\n") { "echo $it" }
        val folded = ToolCalls.fold(text, open = false)
        assertTrue(folded.shown.endsWith("echo 11"))
        assertEquals("Show 19 more lines", folded.toggle)
        assertEquals(text, ToolCalls.fold(text, open = true).shown)
        assertNull(ToolCalls.fold("echo 1", open = false).toggle)
    }

    @Test fun anEditIsDrawnAsItsChangedLines() {
        val old = (1..10).joinToString("\n") { "line $it" }
        val new = old.replace("line 6", "line six")
        assertEquals(listOf("⋯ 2 unchanged lines ⋯", " line 3", " line 4", " line 5", "-line 6", "+line six", " line 7", " line 8", " line 9",
            "⋯ 1 unchanged line ⋯"), ToolCalls.diff(old, new).split("\n"))
        assertEquals("-const a = 1;\n+const a = 2;", ToolCalls.diff("const a = 1;", "const a = 2;"))
    }

    @Test fun anUnknownToolShowsItsFieldsWithoutTheDescription() {
        val i = input("""{"title":"Escaped JSON","priority":2,"description":"File it"}""")
        assertEquals(setOf("title", "priority"), ToolCalls.fields(i).keys)
        assertTrue(ToolCalls.rawInput(i).contains("\n    \"title\": \"Escaped JSON\""))
    }
}
