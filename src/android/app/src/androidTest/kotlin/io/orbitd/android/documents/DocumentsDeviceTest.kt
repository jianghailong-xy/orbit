package io.orbitd.android.documents

import android.app.DownloadManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.auth.pressSignIn
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.documents.DocumentsEntry
import io.orbitd.android.core.documents.DocumentsUploadRequest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Documents on a real Orbit server (board docs/mocks/documents/04-android), signed in through the login page as a person does: the
 * server, account and password come as instrumentation arguments (`docs_server`, `docs_email`, `docs_password`) and are never
 * written down. [screens] walks the board's frames and captures each; [writes] does what the owner does — upload, download, rename,
 * move, new folder, Move to Trash and restore, a share link — and checks each through the server's own answer; [off] is the
 * server with Documents off, where the drawer has no row.
 */
class DocumentsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val args get() = InstrumentationRegistry.getArguments()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val evidence get() = File(app.filesDir, "a07-composer").apply { mkdirs() }
    private val suffix get() = args.getString("docs_suffix") ?: "light"
    private val handle get() = (app.session.state.value as AuthState.SignedIn).handle
    private val api get() = DocumentsStore.of(app, handle).api

    @Test fun screens() = journey("screens") {
        login(); openDocuments()
        capture("02-root")
        openDrawer(); capture("01-drawer"); compose.onNode(drawerRow("Documents")).performClick()
        await { exists("documents-entry:Orbit UI migration") }
        compose.onNodeWithTag("documents-entry:Orbit UI migration").performClick()
        await { exists("documents-entry:sign-in-v3.png") }
        SystemClock.sleep(1500)
        capture("03-folder")
        compose.onNodeWithTag("documents-more:migration-notes.md").performClick()
        await { exists("documents-action-rename") }
        capture("04-row-actions")
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        await { !exists("documents-action-rename") }
        compose.onNodeWithTag("documents-upload").performClick()
        await { exists("documents-pick-files") }
        capture("05-upload-sheet")
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        await { !exists("documents-pick-files") }
        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Uploads").performClick()
        await { exists("documents-uploads-sheet") }
        await { exists("documents-sync-row:data") }
        capture("07-uploads-sheet")
        // A sync that ended with failures opens its details (board frame 15).
        compose.onNodeWithTag("documents-sync-row:data").performClick()
        await { exists("documents-sync-details") }
        capture("15-sync-details")
        compose.onNodeWithText("Done").performClick()
        await { !exists("documents-sync-details") }
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        await { !exists("documents-uploads-sheet") }
        compose.onNodeWithTag("documents-entry:sign-in-v3.png").performClick()
        await { exists("documents-picture") }
        SystemClock.sleep(1000)
        capture("08-picture-preview")
        back()
        await { exists("documents-entry:migration-notes.md") }
        compose.onNodeWithTag("documents-entry:migration-notes.md").performClick()
        await { exists("documents-words") }
        SystemClock.sleep(1000)
        capture("08b-markdown-preview")
        back()
        await { exists("documents-more:migration-notes.md") }
        compose.onNodeWithTag("documents-more:migration-notes.md").performClick()
        await { exists("documents-action-move") }
        compose.onNodeWithTag("documents-action-move").performClick()
        await { exists("documents-move-folder:Drive service") }
        compose.onNodeWithTag("documents-move-folder:Drive service").performClick()
        await { exists("documents-move-up") }
        capture("09-move")
        // Back goes up one folder, then closes.
        repeat(2) { instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); SystemClock.sleep(600) }
        await { !exists("documents-move") }
        back()
        await { exists("documents-entry:Drive service") }
        compose.onNodeWithTag("documents-entry:Drive service").performClick()
        await { exists("documents-more:deploy-checklist.md") }
        compose.onNodeWithTag("documents-more:deploy-checklist.md").performClick()
        await { exists("documents-action-share") }
        compose.onNodeWithTag("documents-action-share").performClick()
        await { exists("documents-share-secrets") }
        capture("10-share-warning")
        compose.onNodeWithText("Cancel").performClick()
        back()
        await { exists("documents-trash-row") }
        compose.onNodeWithTag("documents-trash-row").performClick()
        await { exists("documents-trash") && compose.onAllNodesWithText("kept until you empty it", substring = true).fetchSemanticsNodes().isNotEmpty() }
        capture("11-trash")
        back()
        await { exists("documents-storage-row") }
        compose.onNodeWithTag("documents-storage-row").performClick()
        await { exists("documents-storage-total") }
        SystemClock.sleep(800)
        capture("12-storage")
    }

    @Test fun writes() = journey("writes") {
        login(); openDocuments()
        val root = runBlocking { api.folder(null) }
        fun live(parent: String?) = runBlocking { api.folder(parent).entries }
        fun find(parent: String?, name: String): DocumentsEntry? = live(parent).firstOrNull { it.name == name }
        val datasets = find(null, "Datasets")!!

        // New folder, through the bar's button.
        compose.onNodeWithTag("documents-entry:Datasets").performClick()
        await { exists("documents-folder") && exists("documents-entry:labels.csv") }
        compose.onNodeWithTag("documents-new-folder").performClick()
        await { exists("documents-name-field") }
        compose.onNodeWithTag("documents-name-field").performTextReplacement("Device run")
        compose.onNodeWithText("Create").performClick()
        await { exists("documents-entry:Device run") }
        assertNotNull("the server has the new folder", find(datasets.id, "Device run"))
        note("new folder: Datasets/Device run on the server")

        // Upload: a 40 MB file picked into Datasets, sent in chunks by the background work, with its notification.
        val file = File(app.cacheDir, "device-upload.bin")
        file.outputStream().use { out -> val block = ByteArray(1 shl 20) { (it * 31).toByte() }; repeat(40) { out.write(block) } }
        DocumentsUploads.add(app, handle, DocumentsUploads.requests(app, listOf(Uri.fromFile(file)), datasets.id, "Datasets"))
        SystemClock.sleep(400)
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        SystemClock.sleep(1200)
        capture("06-notification")
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        await(120_000) { find(datasets.id, "device-upload.bin")?.sizeBytes == file.length() }
        await { exists("documents-entry:device-upload.bin") }
        note("upload: device-upload.bin ${file.length()} bytes in Datasets on the server")

        // Download, from the row's sheet, to the phone's Downloads.
        compose.onNodeWithTag("documents-more:labels.csv").performClick()
        await { exists("documents-action-download") }
        compose.onNodeWithTag("documents-action-download").performClick()
        val manager = app.getSystemService(DownloadManager::class.java)
        await(60_000) {
            manager.query(DownloadManager.Query().setFilterByStatus(DownloadManager.STATUS_SUCCESSFUL)).use { c ->
                generateSequence { if (c.moveToNext()) c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)) else null }.any { it == "labels.csv" }
            }
        }
        note("download: labels.csv reached the download manager as successful (Downloads)")

        // Rename, through the row's sheet.
        compose.onNodeWithTag("documents-more:labels.csv").performClick()
        await { exists("documents-action-rename") }
        compose.onNodeWithTag("documents-action-rename").performClick()
        await { exists("documents-name-field") }
        compose.onNodeWithTag("documents-name-field").performTextReplacement("labels-v2.csv")
        compose.onAllNodesWithText("Rename").onLast().performClick()
        await { exists("documents-entry:labels-v2.csv") }
        assertNotNull(find(datasets.id, "labels-v2.csv"))
        note("rename: labels.csv → labels-v2.csv on the server")

        // Move, into the folder made above.
        compose.onNodeWithTag("documents-more:labels-v2.csv").performClick()
        await { exists("documents-action-move") }
        compose.onNodeWithTag("documents-action-move").performClick()
        // The dialog opens at the drive's root: into Datasets, then Device run.
        await { exists("documents-move-folder:Datasets") }
        compose.onNodeWithTag("documents-move-folder:Datasets").performClick()
        await { exists("documents-move-folder:Device run") }
        compose.onNodeWithTag("documents-move-folder:Device run").performClick()
        await { exists("documents-move-folder:Device run").not() && exists("documents-move-up") }
        compose.onNodeWithText("Move to Device run").performClick()
        await { !exists("documents-entry:labels-v2.csv") }
        val folder = find(datasets.id, "Device run")!!
        assertNotNull(find(folder.id, "labels-v2.csv"))
        note("move: labels-v2.csv → Datasets/Device run on the server")

        // Move to Trash with the snackbar's Undo.
        compose.onNodeWithTag("documents-more:eval-runs-2026-10.zip").performClick()
        await { exists("documents-action-trash") }
        compose.onNodeWithTag("documents-action-trash").performClick()
        await { compose.onAllNodesWithText("Moved eval-runs-2026-10.zip to Trash").fetchSemanticsNodes().isNotEmpty() }
        assertNull(find(datasets.id, "eval-runs-2026-10.zip"))
        capture("03b-snackbar-undo")
        compose.onNodeWithText("Undo").performClick()
        await { exists("documents-entry:eval-runs-2026-10.zip") }
        assertNotNull(find(datasets.id, "eval-runs-2026-10.zip"))
        note("trash + undo: eval-runs-2026-10.zip went to Trash and Undo restored it")

        // Move to Trash, then restore from Trash.
        compose.onNodeWithTag("documents-more:device-upload.bin").performClick()
        await { exists("documents-action-trash") }
        compose.onNodeWithTag("documents-action-trash").performClick()
        await { !exists("documents-entry:device-upload.bin") }
        back()
        await { exists("documents-trash-row") }
        compose.onNodeWithTag("documents-trash-row").performClick()
        await { exists("documents-trash-row:device-upload.bin") }
        capture("11b-trash-with-upload")
        compose.onNodeWithTag("documents-trash-row:device-upload.bin").performClick()
        await { exists("documents-trash-restore") }
        compose.onNodeWithTag("documents-trash-restore").performClick()
        await { !exists("documents-trash-row:device-upload.bin") }
        assertNotNull(find(datasets.id, "device-upload.bin"))
        note("trash + restore: device-upload.bin restored from the Trash page")
        back()

        // A share link on a clean file: made straight away, with its address.
        await { exists("documents-entry:Orbit UI migration") }
        compose.onNodeWithTag("documents-entry:Orbit UI migration").performClick()
        await { exists("documents-more:sign-in-v3.png") }
        compose.onNodeWithTag("documents-more:sign-in-v3.png").performClick()
        await { exists("documents-action-share") }
        compose.onNodeWithTag("documents-action-share").performClick()
        await(30_000) { exists("documents-share-url") }
        capture("10b-share-link")
        val links = runBlocking { api.shareLinks() }
        val signIn = find(root.entries.first { it.name == "Orbit UI migration" }.id, "sign-in-v3.png")!!
        assertTrue(links.any { it.root.id == signIn.id || io.orbitd.android.navigation.ObjectId.same(it.root.id, signIn.id) })
        note("share link: the server lists a DRIVE_FILE link for sign-in-v3.png")
        compose.onNodeWithText("Done").performClick()
        back()

        // Storage.
        await { exists("documents-storage-row") }
        compose.onNodeWithTag("documents-storage-row").performClick()
        await { exists("documents-storage-total") }
        note("storage: ${compose.onNodeWithTag("documents-storage-total").fetchSemanticsNode().config[SemanticsProperties.Text].joinToString()}")
    }

    @Test fun off() = journey("off") {
        login()
        openDrawer()
        await { compose.onAllNodes(drawerRow("Tasks")).fetchSemanticsNodes().isNotEmpty() }
        SystemClock.sleep(3000)
        compose.onAllNodes(drawerRow("Documents")).assertCountEquals(0)
        capture("01b-drawer-documents-off")
        note("off: no Documents row in the drawer")
    }

    private fun note(text: String) = File(evidence, "documents-$suffix-checks.txt").appendText("$text\n")
    private fun exists(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun await(timeout: Long = 30_000, condition: () -> Boolean) = compose.waitUntil(timeout, condition)
    private fun back() { compose.onNodeWithContentDescription("Back").performClick(); compose.waitForIdle() }
    private fun openDrawer() { compose.onNodeWithContentDescription("Open navigation").performClick(); compose.waitForIdle(); SystemClock.sleep(600) }
    private fun openDocuments() {
        openDrawer()
        await { compose.onAllNodes(drawerRow("Documents")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(drawerRow("Documents")).performClick()
        await { exists("documents-entry:Orbit UI migration") && exists("documents-storage-row") }
        SystemClock.sleep(1500)
    }
    private fun login() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.session.logout() }
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Welcome back").fetchSemanticsNodes().isNotEmpty() }
        compose.chooseServer(args.getString("docs_server")!!)
        compose.onNodeWithText("Email").performTextReplacement(args.getString("docs_email")!!)
        compose.onNodeWithText("Password").performTextReplacement(args.getString("docs_password")!!)
        compose.pressSignIn()
        compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn }
        compose.waitUntil(30_000) { compose.onAllNodesWithContentDescription("Open navigation").fetchSemanticsNodes().isNotEmpty() }
    }
    private fun systemRoot(): AccessibilityNodeInfo? {
        val automation = instrument.uiAutomation
        val info = automation.serviceInfo
        if (info.flags and android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS == 0) {
            info.flags = info.flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            automation.serviceInfo = info
        }
        return automation.rootInActiveWindow
    }
    private fun capture(name: String) {
        val shotName = "documents-$suffix-$name"
        SystemClock.sleep(400)
        val tree = StringBuilder()
        fun visit(node: AccessibilityNodeInfo?, depth: Int) {
            if (node == null || depth > 24) return
            val bounds = android.graphics.Rect(); node.getBoundsInScreen(bounds)
            tree.appendLine("${" ".repeat(depth)}${node.className} text=${node.text} desc=${node.contentDescription} $bounds")
            for (i in 0 until node.childCount) visit(node.getChild(i), depth + 1)
        }
        visit(systemRoot(), 0); File(evidence, "$shotName-ui.txt").writeText(tree.toString())
        val shot = (1..3).firstNotNullOfOrNull { instrument.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(1000); null } }
        if (shot == null) { File(evidence, "missing-captures.txt").appendText("$shotName\n"); return }
        File(evidence, "$shotName.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }; shot.recycle()
    }
    private fun journey(name: String, block: () -> Unit) {
        instrument.sendStatus(0, Bundle().apply { putString("a07_pid", Process.myPid().toString()) })
        File(evidence, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\napi=${Build.VERSION.SDK_INT}\n")
        try { block(); File(evidence, "documents-$suffix-$name-result.txt").writeText("PASS\n") }
        catch (e: Throwable) { capture("$name-failure"); File(evidence, "documents-$suffix-$name-result.txt").writeText(e.stackTraceToString()); throw e }
        finally { runBlocking { app.session.logout() } }
    }
}
