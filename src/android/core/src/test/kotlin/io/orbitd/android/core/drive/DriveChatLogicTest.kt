package io.orbitd.android.core.drive

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/** The Drive chat's reading rules (board docs/mocks/drive-chat/02-native.html frames 9–12; web lib/driveChat.ts, lib/driveChanges.ts). */
class DriveChatLogicTest {
    private fun row(id: String, open: Boolean = true, completed: Boolean = false, needsYou: Int = 0) =
        DriveChatRow(sessionId = id, open = open, completed = completed, needsYou = needsYou)

    private fun item(id: String, kind: String, entry: String, state: String = "DONE", before: String? = null, after: String? = null, path: String? = null) =
        DriveChatChangeItem(id, kind, entry, before = DriveChatPlace(name = before), after = DriveChatPlace(parentPath = path, name = after), state = state)

    private fun group(id: String, status: String = "DONE", at: String = "2026-11-26T10:00:00Z", items: List<DriveChatChangeItem> = emptyList(),
        held: List<DriveChatHeldItem> = emptyList(), total: Int = items.size) =
        DriveChatChangeGroup(id, "s", "t-$id", status, createdAt = at, items = items, heldItems = held, total = total)

    @Test fun theRoundButtonSaysNeedsYouFirstThenWorkingThenUpdated() {
        assertEquals(ChatFabState.IDLE to "Chat", DriveChatLogic.fab(0, working = false, updated = false))
        assertEquals(ChatFabState.WORKING to "Working…", DriveChatLogic.fab(0, working = true, updated = true))
        assertEquals(ChatFabState.NEEDS_YOU to "1 needs you", DriveChatLogic.fab(1, working = true, updated = true))
        assertEquals(ChatFabState.NEEDS_YOU to "3 need you", DriveChatLogic.fab(3, working = false, updated = false))
        assertEquals(ChatFabState.UPDATED to "Drive updated", DriveChatLogic.fab(0, working = false, updated = true))
    }

    @Test fun theSheetOpensOnTheChatThatNeedsYouElseTheNewestOpenOneElseANewChat() {
        assertNull(DriveChatLogic.toOpen(emptyList()))
        assertNull("a completed or ended chat is not continued", DriveChatLogic.toOpen(listOf(row("a", completed = true), row("b", open = false))))
        assertEquals("b", DriveChatLogic.toOpen(listOf(row("a", completed = true), row("b"), row("c"))))
        assertEquals("c", DriveChatLogic.toOpen(listOf(row("b"), row("c", needsYou = 2))))
    }

    @Test fun aCardListsWhatWasMadeInTheWebsWords() {
        val g = group("g", items = listOf(
            item("1", "NEW_FOLDER", "e1", after = "2026-10"),
            item("2", "MOVE", "e2", after = "2026-10-03 Blue Bottle.pdf", path = "/Receipts 2026/2026-10"),
            item("3", "RENAME", "e3", before = "scan 13.pdf", after = "2026-10-11 AWS invoice.pdf"),
            item("4", "TRASH", "e4", before = "IMG_4907.jpg"),
            item("5", "MOVE", "e5", after = "top.pdf"),
        ), total = 24)
        assertEquals(listOf("New folder" to "2026-10", "Moved" to "2026-10-03 Blue Bottle.pdf → /Receipts 2026/2026-10",
            "Renamed" to "scan 13.pdf → 2026-10-11 AWS invoice.pdf", "To Trash" to "IMG_4907.jpg", "Moved" to "top.pdf → Drive"),
            DriveChatLogic.lines(g).map { it.kind to it.detail })
        assertEquals("Done · 24 changes", DriveChatLogic.state(g))
        assertEquals("Done · 1 change", DriveChatLogic.state(g.copy(total = 1)))
        assertEquals("and 20 more", DriveChatCopy.more(20))
    }

    @Test fun aHeldGroupListsWhatWaitsForApplyAndNeedsYou() {
        val g = group("g", status = "PENDING", held = listOf(
            DriveChatHeldItem("h1", "MOVE", name = "a.pdf", fromPath = "/Scans/a.pdf", toPath = "/Receipts/a.pdf"),
            DriveChatHeldItem("h2", "NEW_FOLDER", name = "2026-12"),
        ))
        assertEquals(listOf("Moved" to "/Scans/a.pdf → /Receipts/a.pdf", "New folder" to "2026-12"), DriveChatLogic.lines(g).map { it.kind to it.detail })
        assertEquals("Needs you", DriveChatLogic.state(g))
        assertEquals("212 changes waiting for Apply", DriveChatCopy.pending(212))
        assertEquals("Undone", DriveChatLogic.state(g.copy(status = "UNDONE")))
        assertEquals("Undoing…", DriveChatLogic.state(g.copy(status = "UNDOING")))
        assertEquals("2 left as they are", DriveChatCopy.skipped(2))
        assertEquals("1 left as it is", DriveChatCopy.skipped(1))
    }

    @Test fun heldGroupsAndOpenQuestionsCountTowardTheButton() {
        val file = DriveChatQuestionFile("e", "/a")
        val q = { status: String -> DriveChatQuestion("q$status", "s", "t", status, moving = file, existing = file) }
        val groups = listOf(group("a", "PENDING"), group("b", "DONE"), group("c", "UNDONE"))
        assertEquals(3, DriveChatLogic.needYou(groups, listOf(q("OPEN"), q("ANSWERING"), q("ANSWERED"), q("STALE"))))
    }

    @Test fun anAnsweredQuestionSaysWhatItMade() {
        val file = DriveChatQuestionFile("e", "/a")
        val q = DriveChatQuestion("q", "s", "t", "ANSWERED", "KEEP_BOTH", file, file, outcome = DriveChatOutcome("e", "/Documents/Home/lease-2026 (2).pdf", "lease-2026 (2).pdf"))
        assertEquals("Kept both · saved as lease-2026 (2).pdf.", DriveChatLogic.answered(q))
        assertEquals("Replaced. The old file is in its versions.", DriveChatLogic.answered(q.copy(choice = "REPLACE")))
        assertEquals("This question is no longer open.", DriveChatLogic.answered(q.copy(status = "STALE")))
        assertNull(DriveChatLogic.answered(q.copy(status = "OPEN")))
        assertEquals("You", DriveChatLogic.writer(file))
        assertEquals("Agent in Weekly review", DriveChatLogic.writer(file.copy(lastWriter = DriveChatWriter("AGENT", "s", "Weekly review"))))
        assertEquals("An agent", DriveChatLogic.writer(file.copy(lastWriter = DriveChatWriter("AGENT"))))
    }

    @Test fun marksAreTheLatestStandingChangeOfAMadeGroup() {
        val first = group("a", at = "2026-11-26T10:00:00Z", items = listOf(item("1", "NEW_FOLDER", "f"), item("2", "MOVE", "x"),
            item("3", "TRASH", "y"), item("4", "RENAME", "z", state = "UNDONE")))
        val second = group("b", at = "2026-11-26T11:00:00Z", items = listOf(item("5", "RENAME", "x")))
        val undone = group("c", "UNDONE", at = "2026-11-26T12:00:00Z", items = listOf(item("6", "MOVE", "f")))
        val held = group("d", "PENDING", at = "2026-11-26T13:00:00Z", items = listOf(item("7", "MOVE", "f")))
        val marks = DriveChatLogic.marks(listOf(second, undone, first, held))
        assertEquals(mapOf("f" to (DriveMark.NEW to "1"), "x" to (DriveMark.RENAMED to "5")), marks)
    }

    @Test fun aCardGoesAfterTheLastRowOfItsTurn() {
        // Rows start at seqs 1 (turn A's message), 3 (A's answer), 6 (turn B's message), 8 (B's answer).
        val lastOf = mapOf("A" to 5L, "B" to 9L)
        val placed = DriveChatLogic.place(listOf(1L, 3L, 6L, 8L), lastOf::get, listOf("g1" to "A", "g2" to "B", "g3" to "gone"))
        assertEquals(mapOf("g1" to 1, "g2" to 3), placed)
    }

    @Test fun aNewChatSendsTheFolderShownOrSaysNoFolder() {
        val composer = JsonObject(mapOf("model" to JsonPrimitive("claude-opus-5-5"), "account" to JsonPrimitive("x")))
        val body = DriveChatLogic.createBody("Sort these", "11111111-1111-4111-8111-111111111111", "ws", DriveChatContext("f1"), composer)
        assertEquals("Sort these", body["text"]!!.jsonPrimitive.content)
        assertEquals("ws", body["workspaceId"]!!.jsonPrimitive.content)
        assertEquals("f1", body["folderId"]!!.jsonPrimitive.content)
        assertEquals("claude-opus-5-5", body["model"]!!.jsonPrimitive.content)
        assertFalse("only the composer's own fields", "account" in body)
        assertFalse("noFolder" in body)
        val top = DriveChatLogic.createBody("x", "id", null, DriveChatContext(null))
        assertTrue("the top level is a null folder", top.containsKey("folderId") && top["folderId"] is kotlinx.serialization.json.JsonNull)
        assertFalse("workspaceId" in top)
        val crossed = DriveChatLogic.createBody("x", "id", "", null)
        assertEquals(true, crossed["noFolder"]!!.jsonPrimitive.content.toBoolean())
        assertFalse("folderId" in crossed)
    }

    @Test fun aLaterMessageCarriesTheFolderAsDriveContext() {
        assertNull(DriveChatLogic.turnContext(null))
        val ctx = DriveChatLogic.turnContext(DriveChatContext("f1", listOf("a", "b")))!!["driveContext"]!!.jsonObject
        assertEquals("f1", ctx["folderId"]!!.jsonPrimitive.content)
        assertEquals(listOf("a", "b"), ctx["entryIds"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun theServersAnswersDecode() {
        val list = Wire.decode("""{"workspace":{"id":"w","name":"Orbit Cloud","runner":null,"online":true},"workspaceFrom":"ORBIT_CLOUD",
            "fab":{"needsYou":1,"working":true},"chats":[{"sessionId":"s","title":"Sort October receipts","status":"RUNNING","open":true,
            "completed":false,"working":true,"needsYou":1,"workspaceId":"w","createdAt":"a","updatedAt":"b","lastActiveAt":"c"}],"more":false}"""
            .encodeToByteArray(), DriveChatList.serializer())
        assertEquals("Orbit Cloud", list.workspace?.name)
        assertEquals(1, list.fab.needsYou)
        assertEquals("Sort October receipts", list.chats.single().title)
        val question = Wire.decode("""{"id":"q","sessionId":"s","turnId":"t","status":"OPEN","choice":null,
            "moving":{"entryId":"m","path":"/Scans/lease-2026.pdf","sizeBytes":2300000,"modifiedAt":"2026-09-30T00:00:00Z","lastWriter":{"kind":"OWNER","sessionId":null,"sessionTitle":null}},
            "existing":{"entryId":"e","path":"/Documents/Home/lease-2026.pdf","sizeBytes":410000,"modifiedAt":"2026-01-04T00:00:00Z","lastWriter":{"kind":"OWNER","sessionId":null,"sessionTitle":null}},
            "destination":{"parentId":"p","name":"lease-2026.pdf"},"outcome":null,"reason":null,"createdAt":"x","answeredAt":null}""".encodeToByteArray(),
            DriveChatQuestion.serializer())
        assertTrue(DriveChatLogic.questionNeedsYou(question))
        assertEquals("/Documents/Home/lease-2026.pdf", question.existing.path)
    }

    @Test fun theNoteUnderTheMessageNamesTheFolderAndTheSelection() {
        assertEquals("Folder · Scans", DriveChatLogic.noteLabel("<orbit_drive_chat folder=\"/Scans\" selected=\"0\">\nThe owner has the folder /Scans open.\n</orbit_drive_chat>"))
        assertEquals("Folder · Drive · 12 files", DriveChatLogic.noteLabel("<orbit_drive_chat folder=\"/\" selected=\"12\">\n…\n</orbit_drive_chat>"))
        assertEquals("Folder · Tom & Ann's", DriveChatLogic.noteLabel("<orbit_drive_chat folder=\"/Home/Tom &amp; Ann's\">\n</orbit_drive_chat>"))
        assertEquals("1 file", DriveChatLogic.noteLabel("<orbit_drive_chat selected=\"1\">\n</orbit_drive_chat>"))
        assertNull("the guidance alone is not attached by the owner", DriveChatLogic.noteLabel("<orbit_drive_chat>\nHow to work in this chat:\n</orbit_drive_chat>"))
        assertNull(DriveChatLogic.noteLabel("<orbit_wiki_context entries=\"3\">\n</orbit_wiki_context>"))
        assertNull(DriveChatLogic.noteLabel(null))
    }

    @Test fun theChipsReadAsTheBoardWritesThem() {
        assertEquals("Folder · Scans", DriveChatCopy.folder("Scans"))
        assertEquals("Folder · Drive", DriveChatCopy.folder(DriveLogic.TITLE))
    }
}
