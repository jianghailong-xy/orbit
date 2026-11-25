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
import io.orbitd.android.navigation.OrbitLinks
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.JsonObject
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

/** A drive held in memory behind the A05c shell's server: the owner's /documents routes as drive.controller.ts answers them. */
internal object DriveFake {
    data class Node(val id: String, var parent: String?, val kind: String, var name: String, val size: Long = 0, val writer: String = """{"kind":"OWNER"}""",
                    var trashed: String? = null)

    @Volatile var enabled: String? = "true"
    val calls = CopyOnWriteArrayList<String>()
    val nodes = mutableListOf<Node>()
    val groups = mutableMapOf<String, List<String>>()
    var made = 0
    @Volatile var linked: String? = null

    fun reset() {
        enabled = "true"; calls.clear(); groups.clear(); made = 0; linked = null
        nodes.clear()
        nodes += Node("root", null, "FOLDER", "")
        nodes += Node("f-ui", "root", "FOLDER", "Orbit UI migration")
        nodes += Node("f-drive", "root", "FOLDER", "Drive service")
        nodes += Node("f-data", "root", "FOLDER", "Datasets")
        nodes += Node("reading", "root", "FILE", "reading-list.md", 4_000)
        nodes += Node("signin", "f-ui", "FILE", "sign-in-v3.png", 1_200_000, """{"kind":"AGENT","sessionId":"${NavShell.SESSION}","at":"2026-11-24T06:02:00Z"}""")
        nodes += Node("notes", "f-ui", "FILE", "migration-notes.md", 18_000, """{"kind":"AGENT","runnerId":"cloud"}""")
        nodes += Node("checklist", "f-drive", "FILE", "deploy-checklist.md", 2_000)
        nodes += Node("old", "f-data", "FILE", "old-run.zip", 2_500_000_000)
        groups["g-old"] = listOf("old")
        nodes.first { it.id == "old" }.trashed = "2026-11-17T08:00:00Z"
    }

    private fun entry(n: Node) = """{"id":"${n.id}","parentId":${n.parent?.let { "\"$it\"" } ?: "null"},"kind":"${n.kind}","name":"${n.name}",
        "sizeBytes":${n.size},"mtime":"2026-11-16T09:00:00Z","currentVersionId":"v-${n.id}","seq":1,"createdAt":"2026-11-16T09:00:00Z",
        "updatedAt":"2026-11-16T09:00:00Z","lastWriter":${n.writer},"path":"${path(n)}"}"""
    private fun path(n: Node): String = if (n.parent == null) "/" else generateSequence(n) { c -> nodes.firstOrNull { it.id == c.parent } }
        .takeWhile { it.parent != null }.map { it.name }.toList().reversed().joinToString("/", "/")
    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())
    private fun body(api: ApiRequest) = Wire.json.parseToJsonElement(api.body!!.decodeToString()) as JsonObject

    fun answer(api: ApiRequest): ApiResponse? = synchronized(this) {
        val p = api.path
        val method = api.method.name
        if (p == listOf("auth", "capabilities")) return ok(enabled?.let { """{"documents":{"enabled":$it}}""" } ?: "{}")
        if (p.firstOrNull() == "share-links") {
            calls += "$method share-links"
            return if (method == "POST") { linked = body(api)["driveEntryId"]!!.jsonPrimitive.content
                ok("""{"link":{"id":"l1","kind":"DRIVE_FILE","token":"tok123","state":"ACTIVE","root":{"id":"$linked","pinnedIsCurrent":true}},"warnings":[],"checkedBytes":10,"partial":false}""") }
            else ok("""{"links":[]}""")
        }
        if (p == listOf("attachments", "usage")) return ok("""{"totalBytes":1932735283,"fileCount":1204,"projects":[],"tasks":[],"weeks":[{"weekStart":"2026-11-16","bytes":1288490188}]}""")
        if (p.firstOrNull() != "drive") return null
        val live = nodes.filter { it.trashed == null }
        calls += "$method ${p.drop(1).joinToString("/")}" + (api.query.toMap()["parentId"]?.let { "?parentId=$it" } ?: "")
        val rest = p.drop(1)
        return when {
            rest == listOf("entries") && method == "GET" -> {
                val folder = api.query.toMap()["parentId"] ?: "root"
                ok("""{"folder":${entry(nodes.first { it.id == folder })},"entries":[${live.filter { it.parent == folder }.joinToString(",") { entry(it) }}],"nextCursor":null}""")
            }
            rest.size == 2 && rest[0] == "entries" && method == "GET" -> ok(entry(nodes.first { it.id == rest[1] }))
            rest.size == 2 && rest[0] == "entries" && method == "PATCH" -> {
                val n = nodes.first { it.id == rest[1] }
                val b = body(api)
                b["name"]?.let { n.name = it.jsonPrimitive.content }
                b["parentId"]?.let { n.parent = it.jsonPrimitive.content }
                ok(entry(n))
            }
            rest.size == 2 && rest[0] == "entries" && method == "DELETE" -> {
                nodes.first { it.id == rest[1] }.trashed = "2026-11-24T06:20:00Z"
                groups["g-${rest[1]}"] = listOf(rest[1])
                ok("""{"trashGroupId":"g-${rest[1]}"}""")
            }
            rest == listOf("folders") -> {
                val b = body(api)
                val n = Node("new${++made}", b["parentId"]?.jsonPrimitive?.content ?: "root", "FOLDER", b["name"]!!.jsonPrimitive.content)
                nodes += n
                ok(entry(n))
            }
            rest.size == 3 && rest[2] == "versions" -> ok("""{"entry":${entry(nodes.first { it.id == rest[1] })},"versions":[]}""")
            rest.size == 3 && rest[2] == "share-check" -> ok(if (rest[1] == "checklist")
                """{"versionId":"v","warnings":[{"kind":"a private key","line":9},{"kind":"an AWS access key id","line":14}],"checkedBytes":2000,"partial":false}"""
                else """{"versionId":"v","warnings":[],"checkedBytes":10,"partial":false}""")
            rest.size == 3 && rest[2] == "content" -> ok("# Reading list\n\n- one\n- two\n")
            rest == listOf("trash") && method == "GET" -> ok("""{"groups":[${groups.entries.filter { (_, ids) -> ids.any { id -> nodes.first { it.id == id }.trashed != null } }
                .joinToString(",") { (g, ids) -> val items = ids.map { id -> nodes.first { it.id == id } }
                    """{"id":"$g","kind":"DELETE","folderPath":"${path(nodes.first { it.id == items.first().parent })}","createdAt":"2026-11-17T08:00:00Z",
                    "itemCount":${items.size},"sizeBytes":${items.sumOf { it.size }},"actor":{"kind":"OWNER"},"items":[${items.joinToString(",") { entry(it) }}]}""" }}],"nextCursor":null}""")
            rest.size == 4 && rest[0] == "trash" && rest[3] == "restore" -> {
                groups[rest[2]]!!.forEach { id -> nodes.first { it.id == id }.trashed = null }
                ok("""{"entryIds":${groups[rest[2]]!!.joinToString(",", "[", "]") { "\"$it\"" }}}""")
            }
            rest == listOf("usage") -> ok("""{"totalBytes":19756849561,"driveBytes":13110000000,"trashBytes":1395864371,"otherBytes":6646849561}""")
            rest == listOf("syncs") -> ok("""{"syncs":[{"id":"s1","status":"DONE","sourceName":"data","destPath":"/Datasets","destEntryId":"f-data",
                "session":{"id":"${NavShell.SESSION}","title":"Clean survey data"},"filesDone":30,"failedCount":1,
                "failed":[{"path":"survey-2026/raw/export.zip","error":"Changed while uploading. It was being written to."}],
                "startedAt":"2026-11-24T06:00:00Z","updatedAt":"2026-11-24T06:12:00Z","endedAt":"2026-11-24T06:12:00Z"}]}""")
            else -> ApiResponse(404, """{"message":"no such route"}""".encodeToByteArray())
        }
    }
}

/**
 * Drive in the Android shell (board docs/mocks/drive/04-android): the drawer row and its switch, browsing with who wrote each
 * file, a folder's writes (rename, new folder, move, Move to Trash with Undo), the share link with the secret warning, Trash's
 * restore, Storage, the uploads sheet's agent sync and its details, and the upload notification's link.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DriveShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() {
        NavShell.reset(); DriveFake.reset()
        NavShell.routes = DriveFake::answer
    }

    @Test fun theDrawerHasDriveInItsFirstGroupAndItsRootListsTheDriveWithTrashAndStorage() {
        signIn()
        openDrawer()
        await { compose.onAllNodes(drawerRow("Drive")).fetchSemanticsNodes().isNotEmpty() }
        // This server has the Wiki off, so its row is away: Documents is the first group's last row, under Tasks and above Workspaces.
        val tasks = compose.onNode(drawerRow("Tasks")).fetchSemanticsNode().boundsInRoot
        val drive = compose.onNode(drawerRow("Drive")).fetchSemanticsNode().boundsInRoot
        val workspaces = compose.onNodeWithText("Workspaces").fetchSemanticsNode().boundsInRoot
        assertTrue("Drive ends the first group", drive.top > tasks.top && drive.bottom <= workspaces.top)
        compose.onNode(drawerRow("Drive")).performClick()
        await { exists("drive-entry:Orbit UI migration") }
        compose.onNodeWithText("Search Drive").assertExists()
        listOf("Drive service", "Datasets", "reading-list.md").forEach { compose.onNodeWithTag("drive-entry:$it").assertExists() }
        compose.onNodeWithTag("drive-trash-row").assertExists()
        compose.onNodeWithTag("drive-storage-row").assertExists()
        compose.onNodeWithTag("drive-upload").assertExists()
        // Folders first, then files, as the board orders them.
        val folder = compose.onNodeWithTag("drive-entry:Orbit UI migration").fetchSemanticsNode().boundsInRoot
        val file = compose.onNodeWithTag("drive-entry:reading-list.md").fetchSemanticsNode().boundsInRoot
        assertTrue(folder.top < file.top)
        await { compose.onAllNodesWithText("You · Nov 16", substring = true).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun aServerThatSaysDriveIsOffHasNoRow() {
        DriveFake.enabled = "false"
        signIn()
        openDrawer()
        await { compose.onAllNodes(drawerRow("Tasks")).fetchSemanticsNodes().isNotEmpty() }
        await { DriveStore.of(app(), (app().session.state.value as AuthState.SignedIn).handle).shown != null }
        compose.waitForIdle()
        assertTrue(DriveFake.calls.isEmpty() || DriveFake.calls.none { it.startsWith("GET entries") })
        compose.onAllNodes(drawerRow("Drive")).assertCountEquals(0)
        assertEquals(false, DriveStore.of(app(), (app().session.state.value as AuthState.SignedIn).handle).shown)
    }

    @Test fun aFolderSaysWhoWroteEachFileAndTheSessionsTitleIsReadOnce() {
        openDrive()
        compose.onNodeWithTag("drive-entry:Orbit UI migration").performClick()
        await { exists("drive-entry:sign-in-v3.png") }
        compose.onNodeWithText("Drive › Orbit UI migration").assertExists()
        await { compose.onAllNodesWithText("Agent in Review navigation", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("An agent on Orbit Cloud", substring = true).assertExists()
        compose.onNodeWithText("1.2 MB").assertExists()
    }

    @Test fun aRowsSheetOffersItsActionsAndMoveToTrashOffersUndo() {
        openDrive()
        compose.onNodeWithTag("drive-more:reading-list.md").performClick()
        await { exists("drive-action-rename") }
        listOf("Rename", "Move to…", "Download", "Send a copy…", "Share link…", "Move to Trash").forEach { compose.onNodeWithText(it).assertExists() }
        // Rename and New folder open a dialog holding a text field, which never settles in Robolectric (as Directory's folder dialog,
        // SessionListPageShellTest): DriveDeviceTest#writes presses them on the emulator against a real server.
        compose.onNodeWithTag("drive-action-trash").performClick()
        await { compose.onAllNodesWithText("Moved reading-list.md to Trash").fetchSemanticsNodes().isNotEmpty() }
        await { !exists("drive-entry:reading-list.md") }
        assertTrue("Move to Trash asks nothing (D6)", DriveFake.calls.contains("DELETE entries/reading"))
        compose.onNodeWithText("Undo").performClick()
        await { exists("drive-entry:reading-list.md") }
        assertTrue(DriveFake.calls.contains("POST trash/groups/g-reading/restore"))
    }

    @Test fun aFolderSheetLeavesOutWhatOnlyAFileHas() {
        openDrive()
        compose.onNodeWithTag("drive-entry:Datasets").performTouchInput { longClick() }
        await { exists("drive-action-rename") }
        listOf("drive-action-move", "drive-action-trash").forEach { compose.onNodeWithTag(it).assertExists() }
        listOf("drive-action-download", "drive-action-send", "drive-action-share").forEach { compose.onAllNodesWithTag(it).assertCountEquals(0) }
    }

    @Test fun moveWalksTheFolderTreeAndMovesIntoTheFolderShown() {
        openDrive()
        compose.onNodeWithTag("drive-more:reading-list.md").performClick()
        await { exists("drive-action-move") }
        compose.onNodeWithTag("drive-action-move").performClick()
        await { exists("drive-move-folder:Drive service") }
        compose.onNodeWithText("Move “reading-list.md”").assertExists()
        compose.onNodeWithTag("drive-move-confirm").assertIsNotEnabled()
        compose.onNodeWithTag("drive-move-folder:Drive service").performClick()
        await { exists("drive-move-up") }
        compose.onNodeWithText("Move to Drive service").assertIsEnabled().performClick()
        await { !exists("drive-move") }
        await { !exists("drive-entry:reading-list.md") }
        assertEquals("f-drive", DriveFake.nodes.first { it.id == "reading" }.parent)
    }

    @Test fun aShareLinkWarnsOfSecretsAndMakesTheLinkOnlyWhenAsked() {
        openDrive()
        compose.onNodeWithTag("drive-entry:Drive service").performClick()
        await { exists("drive-more:deploy-checklist.md") }
        compose.onNodeWithTag("drive-more:deploy-checklist.md").performClick()
        await { exists("drive-action-share") }
        compose.onNodeWithTag("drive-action-share").performClick()
        await { exists("drive-share-secrets") }
        compose.onNodeWithText("This file looks like it holds secrets").assertExists()
        compose.onNodeWithText("A private key").assertExists()
        compose.onNodeWithText("line 14").assertExists()
        assertNull("nothing shared before Share anyway", DriveFake.linked)
        compose.onNodeWithTag("drive-share-anyway").performClick()
        await { exists("drive-share-url") }
        assertEquals("checklist", DriveFake.linked)
        compose.onNodeWithText("https://a05c.test/s/tok123").assertExists()
        compose.onNodeWithText("Stop sharing").assertExists()
    }

    @Test fun trashRestoresAGroupAndStorageShowsTheTotal() {
        openDrive()
        compose.onNodeWithTag("drive-trash-row").performClick()
        await { exists("drive-trash-row:old-run.zip") }
        compose.onNodeWithText("1 item · 2.5 GB · kept until you empty it").assertExists()
        compose.onNodeWithText("Deleted by you").assertExists()
        compose.onNodeWithText("Restore all").performClick()
        await { compose.onAllNodesWithText("Trash is empty.").fetchSemanticsNodes().isNotEmpty() }
        assertNull(DriveFake.nodes.first { it.id == "old" }.trashed)
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists("drive-storage-row") }
        compose.onNodeWithTag("drive-storage-row").performClick()
        await { exists("drive-storage-total") }
        compose.onNodeWithText("18.4 GB").assertExists()
        compose.onNodeWithText("Drive 10.9 GB").assertExists()
        compose.onNodeWithText("Week of Nov 16").assertExists()
    }

    @Test fun aMarkdownFileOpensRenderedWithItsWriter() {
        openDrive()
        compose.onNodeWithTag("drive-entry:reading-list.md").performClick()
        await { exists("drive-words") }
        await { compose.onAllNodesWithText("Reading list").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("drive-file-info").assertTextContains("MD · 4 KB", substring = true)
        compose.onNodeWithTag("drive-file-download").assertExists()
        compose.onNodeWithTag("drive-file-share").assertExists()
    }

    @Test fun theUploadsSheetShowsAnAgentsSyncAndItsDetails() {
        openDrive()
        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Uploads").performClick()
        await { exists("drive-sync-row:data") }
        compose.onNodeWithText("data/ → Datasets").assertExists()
        compose.onNodeWithText("Details", substring = true).assertExists()
        // The row of a sync that ended with failures, like its Details link, opens the full-screen dialog.
        compose.onNodeWithTag("drive-sync-row:data").performClick()
        await { exists("drive-sync-details") }
        compose.onNodeWithText("survey-2026/raw/export.zip").assertExists()
        compose.onNodeWithText("Open Datasets").assertExists()
    }

    @Test fun theComposersFromDrivePutsThePickedFilesPathInTheDraft() {
        signIn()
        await { compose.onAllNodesWithText("Review navigation").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithText("Review navigation").onFirst().performClick()
        await { compose.onAllNodes(hasTestTag("composer-plus") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer-plus").performClick()
        await { exists("composer-from-drive") }
        compose.onNodeWithTag("composer-from-drive").performClick()
        await { exists("drive-picker-file:reading-list.md") }
        compose.onNodeWithTag("drive-picker-add").assertIsNotEnabled()
        compose.onNodeWithTag("drive-picker-folder:Orbit UI migration").performClick()
        await { exists("drive-picker-file:migration-notes.md") }
        compose.onNodeWithTag("drive-picker-file:migration-notes.md").performClick()
        compose.onNodeWithText("Add 1").performClick()
        await { !exists("drive-picker") }
        val handle = (app().session.state.value as AuthState.SignedIn).handle
        assertEquals("/home/orbit/Drive/Orbit UI migration/migration-notes.md ", app().composer(handle, NavShell.SESSION).state.value.draft.text)
    }

    @Test fun theUploadNotificationsShowLinkOpensDrive() {
        val route = OrbitLinks.parse("orbit://drive/uploads")!!
        assertEquals(io.orbitd.android.navigation.Destination.DRIVE, route.destination)
        assertEquals("uploads", route.recordId)
    }

    private fun exists(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun openDrawer() {
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.waitForIdle()
    }
    private fun openDrive() {
        signIn()
        openDrawer()
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
