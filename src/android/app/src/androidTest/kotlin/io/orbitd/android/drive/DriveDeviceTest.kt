package io.orbitd.android.drive

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
import io.orbitd.android.core.drive.DriveEntry
import io.orbitd.android.core.drive.DriveUploadRequest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Drive on a real Orbit server (board docs/mocks/drive/04-android), signed in through the login page as a person does: the
 * server, account and password come as instrumentation arguments (`docs_server`, `docs_email`, `docs_password`) and are never
 * written down. [screens] walks the board's frames and captures each; [writes] does what the owner does — upload, download, rename,
 * move, new folder, Move to Trash and restore, a share link — and checks each through the server's own answer; [off] is the
 * server with Drive off, where the drawer has no row.
 */
class DriveDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val args get() = InstrumentationRegistry.getArguments()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val evidence get() = File(app.filesDir, "a07-composer").apply { mkdirs() }
    private val suffix get() = args.getString("docs_suffix") ?: "light"
    private val handle get() = (app.session.state.value as AuthState.SignedIn).handle
    private val api get() = DriveStore.of(app, handle).api

    @Test fun screens() = journey("screens") {
        login(); openDrive()
        capture("02-root")
        openDrawer(); capture("01-drawer"); compose.onNode(drawerRow("Drive")).performClick()
        await { exists("drive-entry:Orbit UI migration") }
        compose.onNodeWithTag("drive-entry:Orbit UI migration").performClick()
        await { exists("drive-entry:sign-in-v3.png") }
        SystemClock.sleep(1500)
        capture("03-folder")
        compose.onNodeWithTag("drive-more:migration-notes.md").performClick()
        await { exists("drive-action-rename") }
        capture("04-row-actions")
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        await { !exists("drive-action-rename") }
        compose.onNodeWithTag("drive-upload").performClick()
        await { exists("drive-pick-files") }
        capture("05-upload-sheet")
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        await { !exists("drive-pick-files") }
        compose.onNodeWithContentDescription("More").performClick()
        compose.onNodeWithText("Uploads").performClick()
        await { exists("drive-uploads-sheet") }
        await { exists("drive-sync-row:data") }
        capture("07-uploads-sheet")
        // A sync that ended with failures opens its details (board frame 15).
        compose.onNodeWithTag("drive-sync-row:data").performClick()
        await { exists("drive-sync-details") }
        capture("15-sync-details")
        compose.onNodeWithText("Done").performClick()
        await { !exists("drive-sync-details") }
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        await { !exists("drive-uploads-sheet") }
        compose.onNodeWithTag("drive-entry:sign-in-v3.png").performClick()
        await { exists("drive-picture") }
        SystemClock.sleep(1000)
        capture("08-picture-preview")
        back()
        await { exists("drive-entry:migration-notes.md") }
        compose.onNodeWithTag("drive-entry:migration-notes.md").performClick()
        await { exists("drive-words") }
        SystemClock.sleep(1000)
        capture("08b-markdown-preview")
        back()
        await { exists("drive-more:migration-notes.md") }
        compose.onNodeWithTag("drive-more:migration-notes.md").performClick()
        await { exists("drive-action-move") }
        compose.onNodeWithTag("drive-action-move").performClick()
        await { exists("drive-move-folder:Drive service") }
        compose.onNodeWithTag("drive-move-folder:Drive service").performClick()
        await { exists("drive-move-up") }
        capture("09-move")
        // Back goes up one folder, then closes.
        repeat(2) { instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK); SystemClock.sleep(600) }
        await { !exists("drive-move") }
        back()
        await { exists("drive-entry:Drive service") }
        compose.onNodeWithTag("drive-entry:Drive service").performClick()
        await { exists("drive-more:deploy-checklist.md") }
        compose.onNodeWithTag("drive-more:deploy-checklist.md").performClick()
        await { exists("drive-action-share") }
        compose.onNodeWithTag("drive-action-share").performClick()
        await { exists("drive-share-secrets") }
        capture("10-share-warning")
        compose.onNodeWithText("Cancel").performClick()
        back()
        await { exists("drive-trash-row") }
        compose.onNodeWithTag("drive-trash-row").performClick()
        await { exists("drive-trash") && compose.onAllNodesWithText("kept until you empty it", substring = true).fetchSemanticsNodes().isNotEmpty() }
        capture("11-trash")
        back()
        await { exists("drive-storage-row") }
        compose.onNodeWithTag("drive-storage-row").performClick()
        await { exists("drive-storage-total") }
        SystemClock.sleep(800)
        capture("12-storage")
    }

    @Test fun writes() = journey("writes") {
        login(); openDrive()
        val root = runBlocking { api.folder(null) }
        fun live(parent: String?) = runBlocking { api.folder(parent).entries }
        fun find(parent: String?, name: String): DriveEntry? = live(parent).firstOrNull { it.name == name }
        val datasets = find(null, "Datasets")!!

        // New folder, through the bar's button.
        compose.onNodeWithTag("drive-entry:Datasets").performClick()
        await { exists("drive-folder") && exists("drive-entry:labels.csv") }
        compose.onNodeWithTag("drive-new-folder").performClick()
        await { exists("drive-name-field") }
        compose.onNodeWithTag("drive-name-field").performTextReplacement("Device run")
        compose.onNodeWithText("Create").performClick()
        await { exists("drive-entry:Device run") }
        assertNotNull("the server has the new folder", find(datasets.id, "Device run"))
        note("new folder: Datasets/Device run on the server")

        // Upload: a 40 MB file picked into Datasets, sent in chunks by the background work, with its notification.
        val file = File(app.cacheDir, "device-upload.bin")
        file.outputStream().use { out -> val block = ByteArray(1 shl 20) { (it * 31).toByte() }; repeat(40) { out.write(block) } }
        DriveUploads.add(app, handle, DriveUploads.requests(app, listOf(Uri.fromFile(file)), datasets.id, "Datasets"))
        SystemClock.sleep(400)
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        SystemClock.sleep(1200)
        capture("06-notification")
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        await(120_000) { find(datasets.id, "device-upload.bin")?.sizeBytes == file.length() }
        await { exists("drive-entry:device-upload.bin") }
        note("upload: device-upload.bin ${file.length()} bytes in Datasets on the server")

        // Download, from the row's sheet, to the phone's Downloads.
        compose.onNodeWithTag("drive-more:labels.csv").performClick()
        await { exists("drive-action-download") }
        compose.onNodeWithTag("drive-action-download").performClick()
        val manager = app.getSystemService(DownloadManager::class.java)
        await(60_000) {
            manager.query(DownloadManager.Query().setFilterByStatus(DownloadManager.STATUS_SUCCESSFUL)).use { c ->
                generateSequence { if (c.moveToNext()) c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TITLE)) else null }.any { it == "labels.csv" }
            }
        }
        note("download: labels.csv reached the download manager as successful (Downloads)")

        // Rename, through the row's sheet.
        compose.onNodeWithTag("drive-more:labels.csv").performClick()
        await { exists("drive-action-rename") }
        compose.onNodeWithTag("drive-action-rename").performClick()
        await { exists("drive-name-field") }
        compose.onNodeWithTag("drive-name-field").performTextReplacement("labels-v2.csv")
        compose.onAllNodesWithText("Rename").onLast().performClick()
        await { exists("drive-entry:labels-v2.csv") }
        assertNotNull(find(datasets.id, "labels-v2.csv"))
        note("rename: labels.csv → labels-v2.csv on the server")

        // Move, into the folder made above.
        compose.onNodeWithTag("drive-more:labels-v2.csv").performClick()
        await { exists("drive-action-move") }
        compose.onNodeWithTag("drive-action-move").performClick()
        // The dialog opens at the drive's root: into Datasets, then Device run.
        await { exists("drive-move-folder:Datasets") }
        compose.onNodeWithTag("drive-move-folder:Datasets").performClick()
        await { exists("drive-move-folder:Device run") }
        compose.onNodeWithTag("drive-move-folder:Device run").performClick()
        await { exists("drive-move-folder:Device run").not() && exists("drive-move-up") }
        compose.onNodeWithText("Move to Device run").performClick()
        await { !exists("drive-entry:labels-v2.csv") }
        val folder = find(datasets.id, "Device run")!!
        assertNotNull(find(folder.id, "labels-v2.csv"))
        note("move: labels-v2.csv → Datasets/Device run on the server")

        // Move to Trash with the snackbar's Undo.
        compose.onNodeWithTag("drive-more:eval-runs-2026-10.zip").performClick()
        await { exists("drive-action-trash") }
        compose.onNodeWithTag("drive-action-trash").performClick()
        await { compose.onAllNodesWithText("Moved eval-runs-2026-10.zip to Trash").fetchSemanticsNodes().isNotEmpty() }
        assertNull(find(datasets.id, "eval-runs-2026-10.zip"))
        capture("03b-snackbar-undo")
        compose.onNodeWithText("Undo").performClick()
        await { exists("drive-entry:eval-runs-2026-10.zip") }
        assertNotNull(find(datasets.id, "eval-runs-2026-10.zip"))
        note("trash + undo: eval-runs-2026-10.zip went to Trash and Undo restored it")

        // Move to Trash, then restore from Trash.
        compose.onNodeWithTag("drive-more:device-upload.bin").performClick()
        await { exists("drive-action-trash") }
        compose.onNodeWithTag("drive-action-trash").performClick()
        await { !exists("drive-entry:device-upload.bin") }
        back()
        await { exists("drive-trash-row") }
        compose.onNodeWithTag("drive-trash-row").performClick()
        await { exists("drive-trash-row:device-upload.bin") }
        capture("11b-trash-with-upload")
        compose.onNodeWithTag("drive-trash-row:device-upload.bin").performClick()
        await { exists("drive-trash-restore") }
        compose.onNodeWithTag("drive-trash-restore").performClick()
        await { !exists("drive-trash-row:device-upload.bin") }
        assertNotNull(find(datasets.id, "device-upload.bin"))
        note("trash + restore: device-upload.bin restored from the Trash page")
        back()

        // A share link on a clean file: made straight away, with its address.
        await { exists("drive-entry:Orbit UI migration") }
        compose.onNodeWithTag("drive-entry:Orbit UI migration").performClick()
        await { exists("drive-more:sign-in-v3.png") }
        compose.onNodeWithTag("drive-more:sign-in-v3.png").performClick()
        await { exists("drive-action-share") }
        compose.onNodeWithTag("drive-action-share").performClick()
        await(30_000) { exists("drive-share-url") }
        capture("10b-share-link")
        val links = runBlocking { api.shareLinks() }
        val signIn = find(root.entries.first { it.name == "Orbit UI migration" }.id, "sign-in-v3.png")!!
        assertTrue(links.any { it.root.id == signIn.id || io.orbitd.android.navigation.ObjectId.same(it.root.id, signIn.id) })
        note("share link: the server lists a DRIVE_FILE link for sign-in-v3.png")
        compose.onNodeWithText("Done").performClick()
        back()

        // Storage.
        await { exists("drive-storage-row") }
        compose.onNodeWithTag("drive-storage-row").performClick()
        await { exists("drive-storage-total") }
        note("storage: ${compose.onNodeWithTag("drive-storage-total").fetchSemanticsNode().config[SemanticsProperties.Text].joinToString()}")
    }

    /** Frames 7 and 13: a file still going up sits in its folder with its bar, and the uploads sheet holds it beside an agent's
     * running sync. The upload is cancelled afterwards, so the drive is left as it was. */
    @Test fun live() = journey("live") {
        login(); openDrive()
        compose.onNodeWithTag("drive-entry:Orbit UI migration").performClick()
        await { exists("drive-entry:sign-in-v3.png") }
        val folder = runBlocking { api.folder(null).entries.first { it.name == "Orbit UI migration" } }
        val file = File(app.cacheDir, "walkthrough.mov")
        java.io.RandomAccessFile(file, "rw").use { it.setLength(3L * 1024 * 1024 * 1024) }
        DriveUploads.add(app, handle, DriveUploads.requests(app, listOf(Uri.fromFile(file)), folder.id, folder.name))
        await { exists("drive-uploading:walkthrough.mov") && exists("drive-uploads-card") }
        SystemClock.sleep(1500)
        capture("13-folder-uploading")
        compose.onNodeWithTag("drive-uploads-card").performClick()
        await { exists("drive-uploads-sheet") && exists("drive-upload-row:walkthrough.mov") }
        SystemClock.sleep(800)
        capture("07-uploads-sheet-live")
        val queue = DriveStore.of(app, handle).uploads
        queue.items.value.filter { it.name == "walkthrough.mov" }.forEach { queue.cancel(it.id) }
        file.delete()
        note("live: walkthrough.mov went up in Orbit UI migration beside the agent's sync, then was cancelled")
    }

    @Test fun off() = journey("off") {
        login()
        openDrawer()
        await { compose.onAllNodes(drawerRow("Tasks")).fetchSemanticsNodes().isNotEmpty() }
        SystemClock.sleep(3000)
        compose.onAllNodes(drawerRow("Drive")).assertCountEquals(0)
        capture("01b-drawer-drive-off")
        note("off: no Drive row in the drawer")
    }

    private fun note(text: String) = File(evidence, "drive-$suffix-checks.txt").appendText("$text\n")
    private fun exists(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun drawerRow(text: String) = hasText(text) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
    private fun await(timeout: Long = 30_000, condition: () -> Boolean) = compose.waitUntil(timeout, condition)
    private fun back() { compose.onNodeWithContentDescription("Back").performClick(); compose.waitForIdle() }
    private fun openDrawer() { compose.onNodeWithContentDescription("Open navigation").performClick(); compose.waitForIdle(); SystemClock.sleep(600) }
    private fun openDrive() {
        openDrawer()
        await { compose.onAllNodes(drawerRow("Drive")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(drawerRow("Drive")).performClick()
        await { exists("drive-entry:Orbit UI migration") && exists("drive-storage-row") }
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
        val shotName = "drive-$suffix-$name"
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
        try { block(); File(evidence, "drive-$suffix-$name-result.txt").writeText("PASS\n") }
        catch (e: Throwable) { capture("$name-failure"); File(evidence, "drive-$suffix-$name-result.txt").writeText(e.stackTraceToString()); throw e }
        finally { runBlocking { app.session.logout() } }
    }
}
