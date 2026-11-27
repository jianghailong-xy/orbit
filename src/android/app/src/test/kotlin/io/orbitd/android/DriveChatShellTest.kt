package io.orbitd.android

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.drive.DriveStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/** The Drive chat's routes (apiserver drive/drive-chat.ts, drive-chat-changes.ts) over [DriveFake]'s drive. */
internal object DriveChatFake {
    val posts = CopyOnWriteArrayList<Pair<String, JsonObject?>>()
    @Volatile var chats = "[]"
    @Volatile var needsYou = 0
    @Volatile var groups = "[]"
    @Volatile var questions = "[]"

    fun reset() { posts.clear(); chats = "[]"; needsYou = 0; groups = "[]"; questions = "[]" }

    /** One open chat, [NavShell.SESSION], whose turn moved two folders in, renamed a file and holds an overwrite for the owner. */
    fun withAChat() {
        chats = """[{"sessionId":"${NavShell.SESSION}","title":"Sort October receipts","status":"IDLE","open":true,"completed":false,"working":false,
            "needsYou":0,"workspaceId":"${NavShell.ALPHA}","createdAt":"2026-11-26T10:00:00Z","updatedAt":"2026-11-26T10:00:00Z","lastActiveAt":"2026-11-26T10:00:00Z"}]"""
        val item = { id: String, kind: String, entry: String, before: String?, after: String, path: String? ->
            """{"id":"$id","kind":"$kind","entryId":"$entry","entryKind":"FOLDER","before":{"parentId":null,"parentPath":null,"name":${before?.let { "\"$it\"" } ?: "null"}},
            "after":{"parentId":null,"parentPath":${path?.let { "\"$it\"" } ?: "null"},"name":"$after"},"state":"DONE","reason":null}"""
        }
        groups = """[{"id":"g1","sessionId":"${NavShell.SESSION}","turnId":"t-gone","status":"DONE","held":false,"createdAt":"2026-11-26T10:01:00Z",
            "appliedAt":null,"undoneAt":null,"counts":{"NEW_FOLDER":2,"RENAME":1},"total":24,"skipped":0,"items":[
            ${item("i1", "NEW_FOLDER", "f-ui", null, "Orbit UI migration", "/")},${item("i2", "NEW_FOLDER", "f-x", null, "2026-11", "/")},
            ${item("i3", "MOVE", "f-y", null, "2026-10-03 Blue Bottle.pdf", "/Receipts 2026/2026-10")},
            ${item("i4", "RENAME", "reading", "scan 13.pdf", "reading-list.md", "/")},${item("i5", "MOVE", "f-z", null, "z.pdf", null)}],"heldItems":[]}]"""
        val file = { id: String, path: String, size: Long -> """{"entryId":"$id","path":"$path","sizeBytes":$size,"modifiedAt":"2026-01-04T09:00:00Z",
            "lastWriter":{"kind":"OWNER","sessionId":null,"sessionTitle":null}}""" }
        questions = """[{"id":"q1","sessionId":"${NavShell.SESSION}","turnId":"t-gone","status":"OPEN","choice":null,
            "moving":${file("m", "/Scans/lease-2026.pdf", 2_300_000)},"existing":${file("e", "/Documents/Home/lease-2026.pdf", 410_000)},
            "destination":{"parentId":"p","name":"lease-2026.pdf"},"outcome":null,"reason":null,"createdAt":"2026-11-26T10:02:00Z","answeredAt":null}]"""
    }

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    fun answer(api: ApiRequest): ApiResponse? {
        val p = api.path
        if (p.take(2) != listOf("drive", "chats")) return DriveFake.answer(api)
        val body = api.body?.let { Wire.json.parseToJsonElement(it.decodeToString()) as JsonObject }
        if (api.method.name == "POST") posts += p.drop(2).joinToString("/") to body
        val rest = p.drop(2)
        return when {
            rest.isEmpty() && api.method.name == "GET" -> ok("""{"workspace":{"id":"${NavShell.ALPHA}","name":"Alpha","runner":"Fixture runner","online":true},
                "workspaceFrom":"ORBIT_CLOUD","fab":{"needsYou":$needsYou,"working":false},"chats":$chats,"more":false}""")
            rest.isEmpty() -> ok("""{"sessionId":"${NavShell.SESSION}","chat":${chats.removePrefix("[").removeSuffix("]").ifBlank {
                """{"sessionId":"${NavShell.SESSION}"}""" }},"workspace":{"id":"${NavShell.ALPHA}","name":"Alpha"}}""")
            rest.size == 2 && rest[1] == "groups" -> ok("""{"groups":$groups}""")
            rest.size == 2 && rest[1] == "questions" -> ok("""{"questions":$questions}""")
            rest.size == 4 && rest[3] == "undo" -> { groups = groups.replace("\"status\":\"DONE\"", "\"status\":\"UNDONE\""); ok(groups.trim().removePrefix("[").removeSuffix("]")) }
            rest.size == 3 && rest[1] == "questions" -> {
                questions = questions.replace("\"status\":\"OPEN\",\"choice\":null", "\"status\":\"ANSWERED\",\"choice\":\"KEEP_BOTH\"")
                    .replace("\"outcome\":null", "\"outcome\":{\"entryId\":\"m\",\"path\":\"/Documents/Home/lease-2026 (2).pdf\",\"name\":\"lease-2026 (2).pdf\"}")
                ok(questions.trim().removePrefix("[").removeSuffix("]"))
            }
            else -> ApiResponse(404, """{"message":"no such route"}""".encodeToByteArray())
        }
    }
}

/**
 * The Drive chat on Android (board docs/mocks/drive-chat/02-native.html frames 9–12, owner Q1 A): the round button over Upload, the
 * non-modal sheet on a new chat with Runs in, the folder chip and the examples, the first message through `POST /api/drive/chats`, a
 * chat's change card with Undo and its overwrite card with Keep both, and the marks its changes leave on the list.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DriveChatShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() {
        NavShell.reset(); DriveFake.reset(); DriveChatFake.reset()
        NavShell.routes = DriveChatFake::answer
    }

    @Test fun theRoundButtonStandsOverUploadAndOpensANewChatOnTheFolder() {
        openDrive()
        await { exists("chat-fab") }
        val fab = compose.onNodeWithTag("chat-fab").fetchSemanticsNode().boundsInRoot
        val upload = compose.onNodeWithTag("drive-upload").fetchSemanticsNode().boundsInRoot
        assertTrue("the chat button stacks above Upload (owner Q1 A)", fab.bottom <= upload.top)
        assertTrue("both in the bottom-right corner", fab.right >= upload.right - 2f)
        compose.onNodeWithContentDescription("Chat").assertExists()
        compose.onNodeWithTag("chat-fab").performClick()
        await { exists("chat-sheet-half") }
        compose.onNodeWithTag("chat-title").assertTextContains("New chat")
        compose.onNodeWithText("Runs in").assertExists()
        await { compose.onAllNodesWithText("Alpha").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Ask about your files, or say how to sort them.", substring = true).assertExists()
        compose.onAllNodesWithTag("chat-example").assertCountEquals(3)
        await { exists("drive-chat-folder-chip") }
        compose.onNodeWithText("Folder · Drive").assertExists()
        // Non-modal: the list behind stays there to be pressed, and the button is covered by the sheet.
        compose.onNodeWithTag("drive-entry:Datasets").assertExists()
        compose.onAllNodesWithTag("chat-fab").assertCountEquals(0)
        // ✕ puts the button back.
        compose.onNodeWithTag("chat-close").performClick()
        await { exists("chat-fab") }
    }

    @Test fun anExampleFillsTheBoxAndTheFirstMessageOpensTheChatThroughDrivesDoor() {
        openDrive()
        await { exists("chat-fab") }
        compose.onNodeWithTag("chat-fab").performClick()
        await { compose.onAllNodesWithTag("chat-example").fetchSemanticsNodes().size == 3 }
        compose.onAllNodesWithTag("chat-example")[1].performClick()
        val handle = (app().session.state.value as AuthState.SignedIn).handle
        await { app().composer(handle, io.orbitd.android.composer.DraftTarget(NavShell.ALPHA, chat = "drive").key).state.value.draft.text == "What’s taking up the most space?" }
        assertTrue("an example sends nothing", DriveChatFake.posts.isEmpty())
        await { compose.onAllNodes(hasTestTag("composer-send") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer-send").performClick()
        // The send's own steps run on the main looper, which compose's waitUntil leaves paused here: idle it until the POST is out.
        val until = System.currentTimeMillis() + 60_000
        while (DriveChatFake.posts.none { it.first == "" } && System.currentTimeMillis() < until) {
            org.robolectric.shadows.ShadowLooper.idleMainLooper(); Thread.sleep(50)
        }
        assertTrue("the first message goes through Drive's door", DriveChatFake.posts.any { it.first == "" })
        val sent = DriveChatFake.posts.first { it.first == "" }.second!!
        assertEquals("What’s taking up the most space?", sent["text"]!!.jsonPrimitive.content)
        assertEquals(NavShell.ALPHA, sent["workspaceId"]!!.jsonPrimitive.content)
        assertEquals("the top level is a null folder", JsonNull, sent["folderId"])
        assertNotNull(sent["clientTurnId"])
        // The sheet goes on in the chat it made.
        await { DriveStore.of(app(), handle).chat.current == NavShell.SESSION }
    }

    @Test fun aChatsCardsUndoAndKeepBothAndItsChangesMarkTheList() {
        DriveChatFake.withAChat()
        openDrive()
        // The marks: a folder the chat made, a file it renamed.
        await { exists("drive-mark:New") }
        compose.onNodeWithTag("drive-mark:Renamed", useUnmergedTree = true).assertExists()
        // The open question counts on the button.
        await { exists("chat-fab-count") }
        compose.onNodeWithContentDescription("1 needs you").assertExists()
        compose.onNodeWithTag("chat-fab").performClick()
        await { exists("chat-sheet-half") }
        compose.onNodeWithTag("chat-title").assertTextContains("Sort October receipts")
        compose.onNodeWithTag("chat-sheet-handle").performClick()
        await { exists("chat-sheet-full") }
        await { exists("drive-changes:DONE") }
        compose.onNodeWithText("Done · 24 changes").assertExists()
        compose.onNodeWithText("and 20 more").assertExists()
        compose.onNodeWithText("2026-10-03 Blue Bottle.pdf → /Receipts 2026/2026-10").assertExists()
        compose.onNodeWithTag("drive-changes-undo").performScrollTo().performClick()
        await { DriveChatFake.posts.any { it.first == "${NavShell.SESSION}/groups/g1/undo" } }
        await { exists("drive-changes:UNDONE") }
        await { exists("drive-replace:OPEN") }
        compose.onNodeWithText("/Documents/Home/lease-2026.pdf").assertExists()
        compose.onNodeWithText("410 KB · You", substring = true).assertExists()
        compose.onNodeWithTag("drive-replace-keep-both").performScrollTo().performClick()
        await { DriveChatFake.posts.any { it.first == "${NavShell.SESSION}/questions/q1" } }
        assertEquals("KEEP_BOTH", DriveChatFake.posts.first { it.first.endsWith("questions/q1") }.second!!["choice"]!!.jsonPrimitive.content)
        await { compose.onAllNodesWithText("Kept both · saved as lease-2026 (2).pdf.").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun openingAMarkedRowClearsItsMark() {
        DriveChatFake.withAChat()
        openDrive()
        await { exists("drive-mark:New") }
        compose.onNodeWithTag("drive-entry:Orbit UI migration").performClick()
        await { exists("drive-entry:sign-in-v3.png") }
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists("drive-entry:Datasets") }
        compose.onAllNodesWithTag("drive-mark:New", useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithTag("drive-mark:Renamed", useUnmergedTree = true).assertExists()
    }

    @Test fun trashAndStorageHaveNoChat() {
        openDrive()
        await { exists("chat-fab") }
        compose.onNodeWithTag("drive-trash-row").performClick()
        await { exists("drive-trash-row:old-run.zip") }
        compose.onAllNodesWithTag("chat-fab").assertCountEquals(0)
    }

    private fun exists(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun openDrive() {
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.waitForIdle()
        await { compose.onAllNodes(drawerRow("Drive")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(drawerRow("Drive")).performClick()
        await { exists("drive-entry:reading-list.md") }
    }
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
