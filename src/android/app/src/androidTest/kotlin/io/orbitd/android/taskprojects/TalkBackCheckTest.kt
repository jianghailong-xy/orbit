package io.orbitd.android.taskprojects

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.*
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** The Tasks and Projects pages with TalkBack itself running (not a lint of the source): every control TalkBack
 * can reach is read off the accessibility tree TalkBack reads, a control without words fails the check, and
 * TalkBack's own focus is put on the icon-only presses and photographed. TalkBack's settings are put back after.
 * Driven through semantics actions only: with TalkBack on, an injected touch is explore-by-touch, not a press. */
@RunWith(AndroidJUnit4::class)
class TalkBackCheckTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server = "http://127.0.0.1:18771"
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private val taskId = "34ZaIKb2sLBtndX7DqxHH"
    private val projectId = "34ZZn8fmemArxvl2CsCFp"
    private val talkBack = "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService"
    private var savedServices = "null"
    private var savedEnabled = "0"
    private val report = StringBuilder()
    private val problems = mutableListOf<String>()

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrument.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText().trim() }
    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.toByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject } finally { disconnect() }
    }
    private fun awaitText(text: String) = compose.waitUntil(20_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitTag(tag: String) = compose.waitUntil(20_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun press(node: SemanticsNodeInteraction) = node.performSemanticsAction(SemanticsActions.OnClick)
    private fun open(uri: String) = compose.activityRule.scenario.onActivity { activity ->
        val original = activity.intent
        MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
            .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setClass(activity, MainActivity::class.java))
        activity.intent = original
    }

    @Before fun talkBackOn() {
        savedServices = shell("settings get secure enabled_accessibility_services")
        savedEnabled = shell("settings get secure accessibility_enabled")
        shell("settings put secure enabled_accessibility_services $talkBack")
        shell("settings put secure accessibility_enabled 1")
        val manager = app.getSystemService(AccessibilityManager::class.java)
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (!manager.isTouchExplorationEnabled && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        report.appendLine("talkback_enabled=${manager.isEnabled} touch_exploration=${manager.isTouchExplorationEnabled} services=${shell("settings get secure enabled_accessibility_services")}")
    }

    @After fun talkBackBack() {
        if (savedServices == "null" || savedServices.isBlank()) shell("settings delete secure enabled_accessibility_services")
        else shell("settings put secure enabled_accessibility_services $savedServices")
        if (savedEnabled == "null" || savedEnabled.isBlank()) shell("settings delete secure accessibility_enabled") else shell("settings put secure accessibility_enabled $savedEnabled")
        report.appendLine("restored services=${shell("settings get secure enabled_accessibility_services")} enabled=${shell("settings get secure accessibility_enabled")}")
        File(output, "talkback-report.txt").writeText(report.toString())
        File(output, "talkback-problems.txt").writeText(problems.joinToString("\n"))
        runBlocking { app.session.logout() }
    }

    private fun login() {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nscope=controlled HTTP fixture with TalkBack on\n")
        app.getSharedPreferences("orbit.tasks", android.content.Context.MODE_PRIVATE).edit().clear().commit()
        http("/__control", """{"reset":true,"case":"x1","mode":""}""")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        awaitText("Instance address")
        compose.onNodeWithText("Instance address").performTextReplacement(server)
        compose.onNodeWithText("Email").performTextReplacement("a08@example.test")
        compose.onNodeWithText("Password").performTextReplacement("a08-fixture-password")
        press(compose.onAllNodesWithText("Sign in")[1])
        compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }

    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(900)
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    /** What TalkBack can reach on the active window, with the words it has for each; a press with none is a problem. */
    private fun audit(page: String) {
        compose.waitForIdle(); SystemClock.sleep(600)
        val root = instrument.uiAutomation.rootInActiveWindow ?: run { problems += "$page: no active window"; return }
        report.appendLine("## $page")
        fun words(node: AccessibilityNodeInfo) = listOfNotNull(node.contentDescription, node.text, node.hintText,
            if (Build.VERSION.SDK_INT >= 30) node.stateDescription else null)
            .map { it.toString().trim() }.filter { it.isNotEmpty() }
        fun walk(node: AccessibilityNodeInfo, depth: Int) {
            val reachable = node.isVisibleToUser && (node.isClickable || node.isFocusable || node.isCheckable || node.isLongClickable)
            if (reachable || words(node).isNotEmpty()) {
                val label = words(node).joinToString(" | ")
                report.appendLine("${"  ".repeat(depth)}${node.className?.toString()?.substringAfterLast('.')} clickable=${node.isClickable} enabled=${node.isEnabled} words=\"$label\"")
                if (reachable && node.isClickable && label.isEmpty()) problems += "$page: a press without words (${node.className}) at ${android.graphics.Rect().also(node::getBoundsInScreen)}"
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, depth + 1) }
        }
        walk(root, 0)
    }

    /** TalkBack's own focus on one control, photographed: the ring is what a TalkBack user lands on. */
    private fun focusOn(words: String, shot: String) {
        val root = instrument.uiAutomation.rootInActiveWindow ?: return
        val target = root.findAccessibilityNodeInfosByText(words).firstOrNull { it.isVisibleToUser }
        if (target == null) { problems += "$shot: TalkBack found nothing named \"$words\""; return }
        target.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
        report.appendLine("focus \"$words\" -> accessibilityFocused=${root.findAccessibilityNodeInfosByText(words).any { it.isAccessibilityFocused }}")
        capture(shot)
    }

    @Test fun tasksAndProjectsWithTalkBackOn() {
        login()
        // The task list.
        press(compose.onAllNodesWithContentDescription("Open navigation").onFirst()); awaitText("Tasks")
        press(compose.onAllNodesWithText("Tasks").onFirst()); awaitTag("tasks-list"); awaitText("A11 task checklist")
        audit("tasks-list"); focusOn("Task options", "talkback-tasks-list-options")
        // The task page and its acceptance sheet.
        open("orbit-task:$taskId"); awaitTag("task-detail"); awaitText("A11 task checklist")
        audit("task-detail"); focusOn("Task actions", "talkback-task-detail-actions"); focusOn("Send comment", "talkback-task-detail-send-comment")
        compose.onNodeWithTag("task-detail").performScrollToNode(hasTestTag("task-edit-acceptance"))
        press(compose.onNodeWithTag("task-edit-acceptance")); awaitTag("task-acceptance-sheet")
        audit("task-acceptance-sheet"); capture("talkback-task-acceptance-sheet")
        press(compose.onNodeWithText("Cancel"))
        // The project page: open items, How it runs, and the done sheet.
        open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        audit("project-detail-top"); focusOn("Project actions", "talkback-project-actions")
        compose.onNodeWithTag("project-detail").performScrollToNode(hasTestTag("project-settings"))
        audit("project-how-it-runs"); capture("talkback-project-how-it-runs")
        press(compose.onNodeWithTag("project-menu")); awaitText("Record as done")
        press(compose.onAllNodesWithText("Record as done").onFirst()); awaitTag("project-done-sheet")
        audit("project-done-sheet"); capture("talkback-project-done-sheet")
        assertTrue("TalkBack reached presses without words:\n${problems.joinToString("\n")}", problems.isEmpty())
    }
}
