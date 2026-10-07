package io.orbitd.android.taskprojects

import android.accessibilityservice.AccessibilityService
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
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
 * can land on is read off the accessibility tree TalkBack reads, with the label TalkBack composes for it (its own
 * words and those of the non-focusable nodes under it); a control with no label fails the check. TalkBack's own
 * focus is put on the icon-only presses and photographed. TalkBack's settings are put back after.
 * Driven through semantics actions only: with TalkBack on, an injected touch is explore-by-touch, not a press. */
@RunWith(AndroidJUnit4::class)
class TalkBackCheckTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    /** Every use goes through this one connection: the default UiAutomation connection suppresses TalkBack. */
    private val automation get() = instrument.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server = "http://127.0.0.1:18771"
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private val taskId = "34ZaIKb2sLBtndX7DqxHH"
    private val projectId = "34ZZn8fmemArxvl2CsCFp"
    private val talkBack = "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService"
    private var savedServices = "null"
    private var savedEnabled = "0"
    private val notificationPermission get() = shell("dumpsys package com.google.android.marvin.talkback").lines()
        .firstOrNull { it.contains("android.permission.POST_NOTIFICATIONS:") }?.trim().orEmpty()
    private var savedNotificationPermission = ""
    private val report = StringBuilder()
    private val problems = mutableListOf<String>()
    private val manager get() = app.getSystemService(AccessibilityManager::class.java)

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).bufferedReader().use { it.readText().trim() }
    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.toByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject } finally { disconnect() }
    }
    /** False, not an error, while the app is not the resumed window (TalkBack can put its own screen over it). */
    private fun has(matcher: SemanticsMatcher) = runCatching { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)
    private fun awaitText(text: String) = compose.waitUntil(20_000) { has(hasText(text, substring = true)) }
    private fun awaitTag(tag: String) = compose.waitUntil(20_000) { has(hasTestTag(tag)) }
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
        savedNotificationPermission = notificationPermission
        shell("settings put secure enabled_accessibility_services $talkBack")
        shell("settings put secure accessibility_enabled 1")
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (!manager.isTouchExplorationEnabled && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
        report.appendLine("talkback_enabled=${manager.isEnabled} touch_exploration=${manager.isTouchExplorationEnabled} services=${shell("settings get secure enabled_accessibility_services")}")
        assertTrue("TalkBack did not start (touch exploration stayed off)", manager.isTouchExplorationEnabled)
        // Starting TalkBack makes it ask for notifications (Android's permission prompt over the app). This is a check
        // of the app: the prompt is dismissed with Back, unanswered, and any flag that leaves is cleared after.
        SystemClock.sleep(3_000)
        backToTheApp("after TalkBack started")
    }

    @After fun talkBackBack() {
        if (savedServices == "null" || savedServices.isBlank()) shell("settings delete secure enabled_accessibility_services")
        else shell("settings put secure enabled_accessibility_services $savedServices")
        if (savedEnabled == "null" || savedEnabled.isBlank()) shell("settings delete secure accessibility_enabled") else shell("settings put secure accessibility_enabled $savedEnabled")
        report.appendLine("restored services=${shell("settings get secure enabled_accessibility_services")} enabled=${shell("settings get secure accessibility_enabled")}")
        backToTheApp("after TalkBack stopped")
        val permission = notificationPermission
        if (permission != savedNotificationPermission) {
            shell("pm clear-permission-flags com.google.android.marvin.talkback android.permission.POST_NOTIFICATIONS user-set user-fixed")
            report.appendLine("TalkBack's notification permission was \"$savedNotificationPermission\", became \"$permission\"; flags cleared: now \"$notificationPermission\"")
        } else report.appendLine("TalkBack's notification permission unchanged: \"$permission\"")
        File(output, "talkback-report.txt").writeText(report.toString())
        File(output, "talkback-problems.txt").writeText(problems.joinToString("\n"))
        runBlocking { app.session.logout() }
    }

    private fun login() {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nscope=controlled HTTP fixture with TalkBack on\n")
        app.getSharedPreferences("orbit.tasks", Context.MODE_PRIVATE).edit().clear().commit()
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
        automation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    /** Whatever is over the app (TalkBack's permission prompt) is dismissed with Back, unanswered, and photographed first. */
    private fun backToTheApp(moment: String) {
        val until = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < until) {
            val front = automation.rootInActiveWindow?.packageName?.toString()
            if (front == app.packageName) return
            report.appendLine("over the app $moment: $front")
            if (front != null) { capture("talkback-over-app-${moment.replace(' ', '-')}"); automation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK) }
            SystemClock.sleep(1_500)
        }
        report.appendLine("the app was not back in front $moment")
    }

    private fun own(node: AccessibilityNodeInfo) = listOfNotNull(node.contentDescription, node.text, node.hintText,
        if (Build.VERSION.SDK_INT >= 30) node.stateDescription else null).map { it.toString().trim() }.filter { it.isNotEmpty() }
    private fun focusable(node: AccessibilityNodeInfo) = node.isClickable || node.isFocusable || node.isCheckable || node.isLongClickable ||
        (Build.VERSION.SDK_INT >= 28 && node.isScreenReaderFocusable)
    /** What TalkBack says for a node it lands on: its own words, then those of the nodes under it it cannot land on. */
    private fun label(node: AccessibilityNodeInfo): List<String> = own(node) + (0 until node.childCount).mapNotNull(node::getChild)
        .filter { !focusable(it) }.flatMap(::label)
    private fun nodes(root: AccessibilityNodeInfo): List<AccessibilityNodeInfo> =
        listOf(root) + (0 until root.childCount).mapNotNull(root::getChild).flatMap(::nodes)

    /** Every control TalkBack can land on in the active window, with what it would say; one with nothing to say is a problem. */
    private fun audit(page: String) {
        compose.waitForIdle(); SystemClock.sleep(600)
        report.appendLine("## $page (touch_exploration=${manager.isTouchExplorationEnabled})")
        if (!manager.isTouchExplorationEnabled) problems += "$page: TalkBack was not running"
        val root = automation.rootInActiveWindow ?: run { problems += "$page: no active window"; return }
        nodes(root).filter { it.isVisibleToUser && focusable(it) }.forEach { node ->
            val said = label(node).joinToString(", ")
            val bounds = Rect().also(node::getBoundsInScreen)
            report.appendLine("${node.className?.toString()?.substringAfterLast('.')} clickable=${node.isClickable} enabled=${node.isEnabled} at $bounds says=\"$said\"")
            // A press TalkBack would land on with nothing to say. A non-pressable container whose words sit in a focusable
            // child is read through that child, and a row scrolled almost out of view has its words clipped out of the tree.
            val press = node.isClickable || node.isLongClickable || node.isCheckable
            if (said.isEmpty() && press && bounds.height() >= 48) problems += "$page: TalkBack has nothing to say for a ${node.className} at $bounds"
        }
    }

    /** TalkBack's own focus on the control it would announce with these words, photographed. */
    private fun focusOn(words: String, shot: String) {
        val root = automation.rootInActiveWindow ?: return
        val target = nodes(root).firstOrNull { it.isVisibleToUser && focusable(it) && label(it).any { said -> said.contains(words) } }
        if (target == null) { problems += "$shot: TalkBack has no control that says \"$words\""; return }
        target.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
        SystemClock.sleep(400); target.refresh()
        report.appendLine("focus \"$words\" -> accessibilityFocused=${target.isAccessibilityFocused} says=\"${label(target).joinToString(", ")}\"")
        if (!target.isAccessibilityFocused) problems += "$shot: TalkBack's focus did not land on \"$words\""
        capture(shot)
    }

    @Test fun tasksAndProjectsWithTalkBackOn() = try { walkThrough() } catch (error: Throwable) { runCatching { capture("talkback-failed") }; throw error }

    private fun walkThrough() {
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
        // The project page: its top and open items, How it runs, and the done sheet.
        open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        audit("project-detail-top"); focusOn("Project actions", "talkback-project-actions")
        compose.onNodeWithTag("project-detail").performScrollToNode(hasTestTag("project-settings"))
        audit("project-how-it-runs"); capture("talkback-project-how-it-runs")
        compose.onNodeWithTag("project-detail").performScrollToNode(hasTestTag("project-menu")); awaitTag("project-menu")
        press(compose.onNodeWithTag("project-menu"))
        compose.waitUntil(20_000) { compose.onAllNodesWithText("Record as done").fetchSemanticsNodes().isNotEmpty() } // the menu item, not the row's "Record as done…"
        press(compose.onAllNodesWithText("Record as done").onFirst()); awaitTag("project-done-sheet")
        audit("project-done-sheet"); capture("talkback-project-done-sheet")
        assertTrue("TalkBack problems:\n${problems.joinToString("\n")}", problems.isEmpty())
    }
}
