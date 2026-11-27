package io.orbitd.android.drive

import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.auth.pressSignIn
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The Drive chat on the emulator against the composer fixture's Drive (scripts/composer-fixture.py), walking the approved board
 * docs/mocks/drive-chat/02-native.html frames 9–12 and capturing each: the list with the chat's marks and the round button over Upload,
 * the half sheet on a new chat with Runs in, the folder chip and the examples, the full sheet with the change card and Undo, and the
 * overwrite card with Keep both. Run it with `A07_TEST=io.orbitd.android.drive.DriveChatDeviceTest scripts/composer-device-test.sh`.
 */
@RunWith(AndroidJUnit4::class)
class DriveChatDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server get() = InstrumentationRegistry.getArguments().getString("a07_server") ?: "http://127.0.0.1:18767"
    private val evidence get() = File(app.filesDir, "a07-composer").apply { mkdirs() }
    private val session = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"

    private val chat = """{"sessionId":"$session","title":"Sort October receipts","status":"AWAITING_INPUT","open":true,"completed":false,
        "working":false,"needsYou":0,"workspaceId":"$workspace","createdAt":"2026-11-26T14:20:00Z","updatedAt":"2026-11-26T14:32:00Z",
        "lastActiveAt":"2026-11-26T14:32:00Z"}"""
    private fun item(id: String, kind: String, entry: String, before: String?, after: String, path: String?) =
        """{"id":"$id","kind":"$kind","entryId":"$entry","entryKind":"FILE","before":{"parentId":null,"parentPath":null,"name":${before?.let { "\"$it\"" } ?: "null"}},
        "after":{"parentId":null,"parentPath":${path?.let { "\"$it\"" } ?: "null"},"name":"$after"},"state":"DONE","reason":null}"""
    private val items = listOf(item("i1", "NEW_FOLDER", "r10", null, "2026-10", "/Receipts 2026"), item("i2", "NEW_FOLDER", "r11", null, "2026-11", "/Receipts 2026"),
        item("i3", "MOVE", "bluebottle", null, "2026-10-03 Blue Bottle.pdf", "/Receipts 2026/2026-10"),
        item("i4", "RENAME", "totals", "scan 13.pdf", "2026-10-11 AWS invoice.pdf", "/Receipts 2026"),
        item("i5", "RENAME", "totals", "2026-10-11 AWS invoice.pdf", "2026 totals.xlsx", "/Receipts 2026"),
        item("i6", "MOVE", "shop", null, "shop index.pdf", "/Receipts 2026")) +
        (7..24).map { item("i$it", "MOVE", "x$it", null, "receipt-$it.pdf", "/Receipts 2026/2026-11") }
    private val group = """{"id":"g1","sessionId":"$session","turnId":"t1","status":"DONE","held":false,"createdAt":"2026-11-26T14:32:00Z",
        "appliedAt":null,"undoneAt":null,"counts":{"NEW_FOLDER":2,"MOVE":20,"RENAME":2},"total":24,"skipped":0,"items":[${items.joinToString(",")}],"heldItems":[]}"""
    private fun file(id: String, path: String, size: Long, at: String) = """{"entryId":"$id","path":"$path","sizeBytes":$size,"modifiedAt":"$at",
        "lastWriter":{"kind":"OWNER","sessionId":null,"sessionTitle":null}}"""
    private val question = """{"id":"q1","sessionId":"$session","turnId":"t2","status":"OPEN","choice":null,
        "moving":${file("lease", "/Scans/lease-2026.pdf", 2_300_000, "2026-09-30T09:00:00Z")},
        "existing":${file("homelease", "/Documents/Home/lease-2026.pdf", 410_000, "2026-01-04T09:00:00Z")},
        "destination":{"parentId":"home","name":"lease-2026.pdf"},"outcome":null,"reason":null,"createdAt":"2026-11-26T14:40:00Z","answeredAt":null}"""
    private val note = "\n\n<orbit_drive_chat folder=\"/Scans\" selected=\"0\">\nThe owner has the folder /Scans open (id scans).\n</orbit_drive_chat>"
    private fun user(seq: Int, turn: String, words: String) = buildJsonObject {
        put("seq", seq); put("type", "user"); put("turnId", turn); put("ts", "2026-11-26T14:${20 + seq}:00Z")
        putJsonObject("payload") { put("text", words + note); put("controlPlaneNote", note) }
    }
    private fun agent(seq: Int, turn: String, words: String) = buildJsonObject {
        put("seq", seq); put("type", "assistant"); put("turnId", turn); put("ts", "2026-11-26T14:${20 + seq}:30Z")
        putJsonObject("payload") { put("text", words) }
    }
    private val firstTurn = listOf(user(1, "t1", "Put these receipts into Receipts 2026, one folder per month, and name each file by date and shop."),
        agent(2, "t1", "I moved 10 receipts into **2026-10** and **2026-11**, and 2 duplicate photos to Trash."),
        buildJsonObject { put("seq", 3); put("type", "turn_end"); put("turnId", "t1"); putJsonObject("payload") {} })
    private val secondTurn = listOf(user(4, "t2", "Move the lease into Documents/Home."),
        agent(5, "t2", "Documents/Home already has a `lease-2026.pdf`. It’s a different file, so I haven’t touched it. The one there is a 2-page draft: I’d keep both."),
        buildJsonObject { put("seq", 6); put("type", "turn_end"); put("turnId", "t2"); putJsonObject("payload") {} })

    @Test fun frames() = journey("drive-chat") {
        login("""{"extraDetail":{"title":"Sort October receipts"},"driveChats":[$chat],"driveGroups":[$group],"rows":${JsonArray(firstTurn)}}""")
        openDrive()
        // Frame 9: the chat's marks on the list it changed, and the round button over Upload (owner Q1 A).
        compose.onNodeWithTag("drive-entry:Receipts 2026").performClick()
        await { exists("drive-mark:New") && exists("drive-mark:Renamed") && exists("drive-mark:Moved") }
        await { exists("chat-fab") && exists("drive-upload") }
        val fab = compose.onNodeWithTag("chat-fab").fetchSemanticsNode().boundsInRoot
        val upload = compose.onNodeWithTag("drive-upload").fetchSemanticsNode().boundsInRoot
        assertTrue("the chat button stacks above Upload", fab.bottom <= upload.top)
        SystemClock.sleep(1200)
        capture("09-list-marks-fab")
        // Frame 10: on Scans, the button opens the chat that is open; its title's menu starts a new one, at half height.
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists("drive-entry:Scans") }
        compose.onNodeWithTag("drive-entry:Scans").performClick()
        await { exists("drive-entry:lease-2026.pdf") }
        compose.onNodeWithTag("chat-fab").performClick()
        await { exists("chat-sheet-half") }
        compose.onNodeWithTag("chat-title").performClick()
        await { exists("chat-new") }
        SystemClock.sleep(600)
        capture("10a-title-menu")
        compose.onNodeWithTag("chat-new").performClick()
        await { compose.onAllNodesWithTag("chat-example").fetchSemanticsNodes().size == 3 && exists("drive-chat-folder-chip") }
        await { exists("drive-chat-runs-in") }
        compose.onNodeWithText("Folder · Scans").assertExists()
        SystemClock.sleep(1200)
        capture("10-new-chat-half")
        // Frame 11: back to the chat, full height: the turn, its note, and its change card with Undo.
        compose.onNodeWithTag("chat-title").performClick()
        await { exists("chat-history-row") }
        compose.onNodeWithTag("chat-history-row").performClick()
        await { exists("transcript-list") }
        compose.onNodeWithTag("chat-sheet-handle").performClick()
        await { exists("chat-sheet-full") && exists("drive-changes:DONE") }
        await { exists("orbit-attached") }
        compose.onNodeWithText("Orbit attached: Folder · Scans").assertExists()
        compose.onNodeWithText("Done · 24 changes").assertExists()
        compose.onNodeWithText("and 20 more").assertExists()
        compose.onNodeWithTag("drive-changes:DONE").performScrollTo()
        SystemClock.sleep(1500)
        capture("11-changes-card-full")
        compose.onNodeWithTag("drive-changes-undo").performClick()
        await { exists("drive-changes:UNDONE") }
        assertTrue(stats()["drivePosts"]!!.jsonArray.any { it.jsonObject["path"]!!.jsonPrimitive.content == "$session/groups/g1/undo" })
        SystemClock.sleep(800)
        capture("11b-changes-undone")
        // Frame 12: the next turn asks before it overwrites; the card waits on the owner, Keep both over Replace.
        control("""{"driveQuestions":[$question],"rows":${JsonArray(firstTurn + secondTurn)}}""")
        await(60_000) { exists("drive-replace:OPEN") }
        compose.onNodeWithTag("drive-replace:OPEN").performScrollTo()
        SystemClock.sleep(1500)
        capture("12-replace-card-full")
        // Closed, the button counts what waits.
        compose.onNodeWithTag("chat-close").performClick()
        await { exists("chat-fab-count") }
        SystemClock.sleep(800)
        capture("04-fab-needs-you")
        compose.onNodeWithTag("chat-fab").performClick()
        await { exists("drive-replace:OPEN") }
        compose.onNodeWithTag("drive-replace:OPEN").performScrollTo()
        compose.onNodeWithTag("drive-replace-keep-both").performClick()
        await { exists("drive-replace:ANSWERED") }
        compose.onNodeWithText("Kept both · saved as lease-2026 (2).pdf.").assertExists()
        assertEquals("KEEP_BOTH", stats()["drivePosts"]!!.jsonArray.first { it.jsonObject["path"]!!.jsonPrimitive.content == "$session/questions/q1" }
            .jsonObject["body"]!!.jsonObject["choice"]!!.jsonPrimitive.content)
        compose.onNodeWithTag("drive-replace:ANSWERED").performScrollTo()
        SystemClock.sleep(800)
        capture("12b-kept-both")
    }

    private fun exists(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun await(timeout: Long = 20_000, condition: () -> Boolean) = compose.waitUntil(timeout, condition)
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun login(setup: String) {
        compose.waitUntil(10000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.session.logout() }; control("""{"reset":true}"""); control(setup)
        compose.waitUntil(15000) { compose.onAllNodesWithText("Welcome back").fetchSemanticsNodes().isNotEmpty() }
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement("a07@example.test")
        compose.onNodeWithText("Password").performTextReplacement("a07-fixture-password")
        compose.pressSignIn()
        compose.waitUntil(15000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun openDrive() {
        compose.onNodeWithContentDescription("Open navigation").performClick()
        await { compose.onAllNodes(drawerRow("Drive")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(drawerRow("Drive")).performClick()
        await { exists("drive-entry:Receipts 2026") }
    }
    private fun request(path: String, body: String? = null): String = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.toByteArray()) } }
        check(responseCode == 200); inputStream.bufferedReader().use { it.readText() }.also { disconnect() }
    }
    private fun control(body: String) { request("/__control", body) }
    private fun stats() = Json.parseToJsonElement(request("/__stats")).jsonObject
    private fun capture(name: String) {
        SystemClock.sleep(300)
        val tree = StringBuilder()
        fun visit(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || depth > 24) return
            val bounds = android.graphics.Rect(); node.getBoundsInScreen(bounds)
            tree.appendLine("${" ".repeat(depth)}${node.className} text=${node.text} desc=${node.contentDescription} click=${node.isClickable} $bounds")
            for (i in 0 until node.childCount) visit(node.getChild(i), depth + 1)
        }
        visit(instrument.uiAutomation.rootInActiveWindow, 0); File(evidence, "$name-ui.txt").writeText(tree.toString())
        val shot = (1..3).firstNotNullOfOrNull { instrument.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(1000); null } }
        if (shot == null) { File(evidence, "missing-captures.txt").appendText("$name\n"); return }
        File(evidence, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }; shot.recycle()
    }
    private fun journey(name: String, block: () -> Unit) {
        instrument.sendStatus(0, Bundle().apply { putString("a07_pid", Process.myPid().toString()) })
        File(evidence, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\napi=${Build.VERSION.SDK_INT}\n")
        try { block(); File(evidence, "$name-result.txt").writeText("PASS\n") }
        catch (e: Throwable) { capture("$name-failure"); File(evidence, "$name-result.txt").writeText(e.stackTraceToString()); throw e }
        finally { File(evidence, "$name-server.json").writeText(request("/__stats")); runBlocking { app.session.logout() } }
    }
}
