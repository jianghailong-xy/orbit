package io.orbitd.android.taskprojects

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.view.KeyEvent
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.*
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Product MainActivity and real AuthSession HTTP; authority is a controlled, explicitly named fixture. */
@RunWith(AndroidJUnit4::class)
class TasksProjectsDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server = "http://127.0.0.1:18771"
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private val taskId = "34ZaIKb2sLBtndX7DqxHH"
    private val projectId = "34ZZn8fmemArxvl2CsCFp"
    private val sessionId = "34ZaIKKTQq8IdW0pn90xH"

    private fun http(path: String, body: String? = null): JsonObject = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; outputStream.use { it.write(body.toByteArray()) } }
        try { check(responseCode == 200); Wire.json.parseToJsonElement(inputStream.bufferedReader().use { it.readText() }).jsonObject }
        finally { disconnect() }
    }
    private fun awaitText(text: String) { compose.waitUntil(20_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() } }
    private fun awaitTag(tag: String) { compose.waitUntil(20_000) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() } }
    private fun click(text: String, list: String? = null) {
        if (list != null) compose.onNodeWithTag(list).performScrollToNode(hasText(text))
        compose.onNodeWithText(text).performClick()
    }
    private fun capture(name: String) {
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun open(uri: String) { compose.runOnUiThread { compose.activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setClass(compose.activity, MainActivity::class.java)) } }
    private fun login(case: String = "normal", mode: String = "") {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nscope=controlled HTTP fixture; no real deployed account\n")
        http("/__control", """{"reset":true,"case":"$case","mode":"$mode"}""")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        awaitText("Instance address")
        compose.onNodeWithText("Instance address").performTextReplacement(server)
        compose.onNodeWithText("Email").performTextReplacement("a08@example.test")
        compose.onNodeWithText("Password").performTextReplacement("a08-fixture-password")
        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
        compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun journey(name: String, block: () -> Unit) {
        try { block(); File(output, "$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) { capture("$name-failed"); throw error }
        finally { File(output, "$name-journal.json").writeText(http("/__stats").toString()); runBlocking { app.session.logout() } }
    }

    @Test fun sourceConversationTaskAndProjectReturnKeepDraft() = journey("source-return") {
        login(); open("orbit-session:$sessionId"); awaitTag("composer-input")
        compose.onNodeWithTag("composer-input").performTextInput("A11 return draft")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("Open A11 task"))
        compose.onNodeWithText("Open A11 task").performTouchInput { click() }
        awaitTag("task-detail"); awaitText("A11 task checklist"); capture("task-from-conversation")
        compose.activityRule.scenario.recreate(); awaitTag("task-detail")
        compose.onNodeWithContentDescription("Back").performClick(); awaitTag("composer-input")
        compose.onNodeWithTag("composer-input").assertTextContains("A11 return draft")
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("Open A11 project"))
        compose.onNodeWithText("Open A11 project").performTouchInput { click() }
        awaitTag("project-detail"); awaitText("A11 Android launch"); capture("project-from-conversation")
        compose.onNodeWithContentDescription("Back").performClick(); awaitTag("composer-input")
        compose.onNodeWithTag("composer-input").assertTextContains("A11 return draft")
        capture("original-conversation-and-draft")
    }

    @Test fun taskSearchAndLabelsKeepScopeThroughRecreation() = journey("tasks-search-labels") {
        login(); compose.onNodeWithContentDescription("Open navigation").performClick(); click("Tasks")
        awaitTag("tasks-list"); awaitText("A11 task checklist")
        compose.onNodeWithTag("task-search").performTextInput("checklist")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        click("Sprint, one"); compose.activityRule.scenario.recreate(); awaitTag("task-search")
        compose.onNodeWithTag("task-search").assertTextContains("checklist")
        awaitText("A11 task checklist"); capture("tasks-filter-restored")
        val reads = http("/__stats").objects("journal").filter { it.text("method") == "GET" && it.text("path") == "/api/tasks/page" }
        assertTrue("At least one search request retains no-project scope and comma-containing label", reads.any { row ->
            val query = row.obj("query") ?: return@any false
            query.strings("q") == listOf("checklist") && query.strings("projectId") == listOf("none") && query.strings("labels") == listOf("Sprint, one")
        })
        compose.onNodeWithTag("tasks-list").performScrollToNode(hasTestTag("task:$taskId"))
        compose.onNodeWithTag("task:$taskId").performClick(); awaitTag("task-detail")
        compose.onNodeWithContentDescription("Back").performClick(); awaitTag("task-search")
        compose.onNodeWithTag("task-search").assertTextContains("checklist")
    }

    @Test fun commentMutationAndRemoteDenialClearTaskDetails() = journey("task-comment-revocation") {
        login(); open("orbit-task:$taskId"); awaitTag("task-detail"); awaitText("A11 task checklist")
        compose.onNodeWithTag("task-detail").performScrollToNode(hasTestTag("task-comment"))
        compose.onNodeWithTag("task-comment").performTextInput("A11 controlled comment")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        click("Post comment", "task-detail")
        compose.waitUntil(20_000) { http("/__stats").objects("journal").any {
            it.text("method") == "POST" && it.text("path")?.endsWith("/comments") == true && it.obj("body")?.text("body") == "A11 controlled comment"
        } }
        compose.onNodeWithTag("task-detail").performScrollToNode(hasText("A11 controlled comment")); capture("comment-recorded")
        http("/__control", """{"denyTasks":true,"invalidate":true}""")
        awaitText("You don't have permission to access this task.")
        compose.onAllNodesWithTag("task-comment").assertCountEquals(0)
        compose.onAllNodesWithText("Run now").assertCountEquals(0); capture("task-permission-withdrawn")
    }

    @Test fun projectSettingsBindRevisionAndGraphOpensTask() = journey("project-settings-graph") {
        login(); open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        click("Edit run settings", "project-detail"); awaitTag("project-settings")
        compose.onNodeWithText("Concurrent tasks (1–100)").performTextReplacement("3")
        click("Save task settings")
        compose.waitUntil(20_000) { http("/__stats").obj("project")?.number("maxConcurrentTasks") == 3 }
        val write = http("/__stats").objects("journal").last { it.text("method") == "PATCH" && it.text("path") == "/api/projects/$projectId" }
        assertNotNull(write.obj("body")?.get("expectedConfigRevision"))
        assertEquals(3, write.obj("body")?.number("maxConcurrentTasks"))
        capture("project-settings-authoritative")
        click("Expand graph", "project-detail")
        compose.onNodeWithText("Zoom in").performClick(); capture("project-dependency-graph")
        compose.onAllNodesWithText("A11 project delivery").onFirst().performClick()
        click("Open task"); awaitTag("task-detail"); awaitText("A11 project delivery")
        compose.onNodeWithContentDescription("Back").performClick(); awaitTag("project-detail")
        capture("graph-return-project")
    }

    @Test fun staleProjectSettingsAreRefusedAndPermissionChangeWithdrawsActions() = journey("project-conflict-permission") {
        login(); open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        click("Edit run settings", "project-detail"); awaitTag("project-settings")
        compose.onNodeWithText("Concurrent tasks (1–100)").performTextReplacement("4")
        http("/__control", """{"mode":"conflict"}""")
        click("Save task settings"); awaitText("STALE_CONFIG_REVISION"); capture("project-stale-settings-refusal")
        assertNotEquals(4, http("/__stats").obj("project")?.number("maxConcurrentTasks"))
        http("/__control", """{"denyProjects":true,"invalidate":true}""")
        awaitText("You don't have permission to access this item.")
        compose.onAllNodesWithTag("project-coordinator").assertCountEquals(0)
        compose.onAllNodesWithText("Edit run settings").assertCountEquals(0); capture("project-permission-withdrawn")
    }

    @Test fun projectExceptionHandsOffToExistingCardAndReturns() = journey("project-review-handoff") {
        login(case = "x1"); open("orbit-project:$projectId"); awaitTag("project-detail"); awaitText("A11 Android launch")
        compose.onNodeWithTag("project-detail").performScrollToNode(hasText("Review in coordinator session"))
        compose.onAllNodesWithText("Review in coordinator session").onFirst().performClick()
        awaitTag("interaction-cards")
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("item:x1"))
        capture("exception-existing-card")
        compose.onNodeWithTag("item:x1:MARK_HANDLED").performScrollTo().performClick()
        compose.onNodeWithText("Why is it no longer open?").performScrollTo().performTextInput("Checked the fixed source and current server record")
        instrument.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
        compose.onNodeWithTag("item:x1:MARK_HANDLED").performScrollTo().performClick()
        compose.waitUntil(20_000) { http("/__stats").objects("journal").any { row ->
            row.text("method") == "POST" && row.text("path") == "/api/projects/$projectId/open-items/x1/resolve" &&
                row.obj("body")?.text("note") == "Checked the fixed source and current server record"
        } }
        assertFalse(http("/__stats").flag("pending")); capture("exception-recorded-after-handoff")
        compose.onNodeWithContentDescription("Back").performClick(); awaitTag("project-detail"); awaitText("A11 Android launch")
        assertTrue(http("/__stats").objects("journal").any { it.text("method") == "POST" && it.text("path") == "/api/projects/$projectId/coordinator" })
        capture("review-return-project")
    }

    @Test fun taskPrerequisiteAndScheduleUseAuthoritativeMutations() = journey("task-dependency-schedule") {
        login()
        http("/__control", """{"task":{"id":"$taskId","runAt":"2030-01-01T00:00:00.000Z"}}""")
        open("orbit-task:$taskId"); awaitTag("task-detail"); awaitText("A11 task checklist")
        click("Add prerequisite", "task-detail")
        compose.onNodeWithText("Search prerequisites").performTextInput("A11 prerequisite")
        awaitText("A11 prerequisite · Done")
        click("A11 prerequisite · Done"); click("Save")
        compose.waitUntil(20_000) { http("/__stats").obj("tasks")?.obj(taskId)?.objects("dependsOn")?.size == 1 }
        click("Schedule…", "task-detail"); click("Cancel scheduled start"); click("Save")
        compose.waitUntil(20_000) { http("/__stats").obj("tasks")?.obj(taskId)?.get("runAt") == JsonNull }
        val writes = http("/__stats").objects("journal")
        assertTrue(writes.any { it.text("path") == "/api/tasks/$taskId/dependencies" && it.obj("body")?.text("dependsOnTaskId") == "34ZaIKb2sLBtndX7DqxHI" })
        assertTrue(writes.any { it.text("method") == "PATCH" && it.obj("body")?.get("runAt") == JsonNull })
        compose.onNodeWithTag("task-detail").performScrollToNode(hasText("Dependencies")); capture("task-dependency-final-state")
    }
}
