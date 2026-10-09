package io.orbitd.android.providerengine

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
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
 * T9's screenshots (task 34cdPiEnaMzkzS596poDi): the provider/engine split on Android against kit/fixture.py, the account the
 * boards draw. Each journey signs in afresh and captures the screens the boards cover — the new session's engine list and each
 * engine's Provider menu, a Harness session switching between its DeepSeek keys, a session whose key was deleted, a task's
 * engine and provider pins, the key list's engines, a DeepSeek key's page and the runner's Harness row — under the theme the
 * driver (kit/run.sh) set, into files/t9-shots/<theme>/. It checks what each screen must say as it goes, and what the fixture
 * received: the engine travels with the provider on every write.
 */
@RunWith(AndroidJUnit4::class)
class ProviderEngineShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val arguments get() = InstrumentationRegistry.getArguments()
    private val server get() = arguments.getString("t9_server") ?: "http://127.0.0.1:18791"
    private val theme get() = arguments.getString("t9_theme") ?: "light"
    private val shots get() = File(app.filesDir, "t9-shots/$theme").apply { mkdirs() }
    private val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b83e001"
    private val runner = "01a0cca7-8609-70ed-a0e2-d4b55b83e002"
    private val dshSession = "01a0cca7-8609-70ed-a0e2-d4b55b83e003"
    private val goneSession = "01a0cca7-8609-70ed-a0e2-d4b55b83e004"
    private val task = "01a0cca7-8609-70ed-a0e2-d4b55b83e006"

    @Test fun a_newSessionPicksTheEngineThenTheProvider() = journey("new-session") {
        login()
        compose.onNodeWithTag("workspace:$workspace").performClick()
        awaitText("New session"); compose.onAllNodesWithText("New session")[0].performClick()
        awaitTag("new-session-engine")
        engine("dsh", shot = "01-new-session-engines")
        menu("02-new-session-dsh-menu", title = "DeepSeek Harness")
        // Harness enforces three modes: the others are not offered.
        listOf("default", "auto", "dontAsk").forEach { compose.onNodeWithTag("composer-mode:$it").assertExists() }
        listOf("acceptEdits", "plan", "bypassPermissions").forEach { compose.onNodeWithTag("composer-mode:$it").assertDoesNotExist() }
        provider("03-new-session-dsh-provider")
        compose.onNodeWithTag("composer-provider:deepseek").assertExists(); compose.onNodeWithTag("composer-provider:deepseek-2").assertExists()
        assertTrue("no Harness row of its own", compose.onAllNodes(hasTestTag("composer-provider:dsh")).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Close").performClick()
        engine("claude"); menu(title = "Claude Code"); provider("04-new-session-claude-provider")
        awaitText("Signed in on hpc"); awaitText("Account pools"); awaitText("API keys")
        compose.onNodeWithText("Close").performClick()
        engine("opencode"); menu(title = "OpenCode"); provider("05-new-session-opencode-provider")
        awaitText("Claude Max isn’t here: a subscription token runs on Claude Code only.")
        compose.onNodeWithText("Close").performClick()
        // The pick is the pair: Harness on the second DeepSeek key, sent with the first message.
        engine("dsh"); menu(title = "DeepSeek Harness"); provider()
        compose.onNodeWithTag("composer-provider:deepseek-2").performScrollTo().performClick()
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithTag("composer-input").performTextInput("Look at why CI is red")
        compose.waitUntil(15_000) { compose.onNodeWithTag("composer-send").fetchSemanticsNode().config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.Disabled) == null }
        compose.onNodeWithTag("composer-send").performClick()
        compose.waitUntil(15_000) { stats()["creations"]!!.jsonArray.isNotEmpty() }
        val created = stats()["creations"]!!.jsonArray.single().jsonObject
        assertEquals("dsh", created["engine"]!!.jsonPrimitive.content)
        assertEquals("deepseek-2", created["provider"]!!.jsonPrimitive.content)
    }

    @Test fun b_withoutADeepSeekKeyHarnessOffersTheConnection() = journey("no-deepseek-key") {
        login(); control("""{"noDeepSeek":true}""")
        compose.onNodeWithTag("workspace:$workspace").performClick()
        awaitText("New session"); compose.onAllNodesWithText("New session")[0].performClick()
        awaitTag("new-session-engine")
        compose.onNodeWithTag("new-session-engine").performClick()
        awaitText("Connect a DeepSeek key →")
        capture("06-new-session-no-deepseek-key")
        compose.onNodeWithText("Done").performClick()
    }

    @Test fun c_aHarnessSessionSwitchesBetweenItsDeepSeekKeys() = journey("composer-switch") {
        login()
        open("orbit://session/$dshSession")
        awaitTag("composer-model")
        menu(title = "DeepSeek Harness"); provider("07-composer-dsh-switch")
        compose.onNodeWithTag("composer-provider:deepseek-2").performScrollTo().performClick()
        compose.waitUntil(15_000) { stats()["calls"]!!.jsonArray.any { it.jsonObject["path"]!!.jsonPrimitive.content.endsWith("/$dshSession/config") } }
        val patch = stats()["calls"]!!.jsonArray.last { it.jsonObject["path"]!!.jsonPrimitive.content.endsWith("/$dshSession/config") }.jsonObject
        assertEquals("PATCH", patch["method"]!!.jsonPrimitive.content)
        assertEquals("dsh", patch["body"]!!.jsonObject["engine"]!!.jsonPrimitive.content)
        assertEquals("deepseek-2", patch["body"]!!.jsonObject["provider"]!!.jsonPrimitive.content)
        compose.onNodeWithText("Close").performClick()
        compose.runOnIdle { app.realtime.refreshSession() }
        SystemClock.sleep(1500)
        menu(title = "DeepSeek Harness"); provider()
        awaitText("✓ DeepSeek 2")
        capture("08-composer-dsh-switched")
        compose.onNodeWithText("Close").performClick()
    }

    @Test fun d_aSessionWhoseKeyIsDeletedSaysSo() = journey("composer-key-deleted") {
        login()
        open("orbit://session/$goneSession")
        awaitTag("composer-model")
        menu(title = "DeepSeek Harness"); provider()
        awaitText("Key deleted"); awaitText("This session's key")
        capture("09-composer-key-deleted")
        compose.onNodeWithText("Close").performClick()
    }

    @Test fun e_aTaskPinsTheEngineThenAProviderItRuns() = journey("task-pin") {
        login()
        open("orbit://task/$task")
        awaitTag("task-engine")
        awaitText("Assignee's · Claude Code")
        compose.onNodeWithTag("task-engine").performScrollTo().performClick()
        awaitText("DeepSeek Harness")
        capture("10-task-pin-engine-menu")
        compose.onNodeWithText("DeepSeek Harness").performClick()
        compose.waitUntil(15_000) { stats()["task"]!!.jsonObject["engine"]?.jsonPrimitive?.contentOrNull == "dsh" }
        awaitText("Engine default · DeepSeek")
        compose.onNodeWithTag("task-provider").performScrollTo().performClick()
        awaitText("Your DeepSeek keys")
        capture("11-task-pin-provider-menu")
        compose.onNodeWithText("DeepSeek 2").performClick()
        compose.waitUntil(15_000) { stats()["task"]!!.jsonObject["provider"]?.jsonPrimitive?.contentOrNull == "deepseek-2" }
        val pin = stats()["calls"]!!.jsonArray.last { it.jsonObject["path"]!!.jsonPrimitive.content == "/api/tasks/$task" }.jsonObject["body"]!!.jsonObject
        assertEquals("dsh", pin["engine"]!!.jsonPrimitive.content); assertEquals("deepseek-2", pin["provider"]!!.jsonPrimitive.content)
        awaitText("DeepSeek 2")
        compose.onNodeWithTag("task-engine").performScrollTo()
        capture("12-task-pinned")
    }

    @Test fun f_theKeysSayTheEnginesTheyRunOn() = journey("keys") {
        login()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        awaitText("Settings"); compose.onAllNodesWithText("Settings").onFirst().performClick()
        awaitText("Providers"); compose.onNodeWithText("Providers").performScrollTo().performClick()
        awaitText("Your API keys")
        compose.onNodeWithText("Claude Code · subscription token", useUnmergedTree = true).performScrollTo()
        awaitText("Claude Code · OpenCode · DeepSeek Harness", unmerged = true)
        capture("13-keys-engines")
        compose.onNode(hasText("DeepSeek") and hasClickAction()).performScrollTo().performClick()
        awaitText("Works with")
        compose.onNodeWithText("Works with").performScrollTo()
        compose.onNodeWithText("Anthropic-compatible").performScrollTo()
        capture("14-deepseek-key-works-with")
    }

    @Test fun g_theRunnerSaysHarnessUsesApiKeys() = journey("runner") {
        login()
        open("orbit://runner/$runner")
        awaitText("Engines")
        awaitText("DeepSeek Harness")
        compose.onNodeWithText("DeepSeek Harness").performScrollTo()
        awaitText("Uses API keys", substring = true)
        capture("15-runner-engines")
    }

    // The journey's steps.

    /** Opens the new session's Engine list and picks [engine], capturing the list as [shot] first. */
    private fun engine(engine: String, shot: String? = null) {
        compose.onNodeWithTag("new-session-engine").performClick()
        awaitTag("engine:$engine")
        shot?.let(::capture)
        compose.onNodeWithTag("engine:$engine").performClick()
        compose.waitUntil(15_000) { compose.onAllNodes(hasTestTag("engine-choices")).fetchSemanticsNodes().isEmpty() }
        SystemClock.sleep(500)
    }

    /** Opens the composer's model menu, titled by the session's engine. */
    private fun menu(shot: String? = null, title: String) {
        compose.waitUntil(15_000) { compose.onNodeWithTag("composer-model").fetchSemanticsNode().config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.Disabled) == null }
        compose.onNodeWithTag("composer-model").performClick()
        awaitTag("composer-provider")
        compose.onNodeWithTag("composer-engine-title").assertTextEquals(title)
        shot?.let(::capture)
    }

    /** Scrolls the model menu to its Provider part. */
    private fun provider(shot: String? = null) {
        compose.onNodeWithTag("composer-provider").performScrollTo()
        compose.onAllNodes(hasTestTag("composer-provider:", substring = true)).fetchSemanticsNodes().lastOrNull()?.let {
            compose.onAllNodes(hasTestTag("composer-provider:", substring = true)).onLast().performScrollTo()
        }
        compose.onNodeWithTag("composer-provider").performScrollTo()
        shot?.let(::capture)
    }

    private fun login() {
        instrument.sendStatus(0, Bundle().apply { putString("t9_pid", Process.myPid().toString()) })
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        control("""{"reset":true}""")
        awaitText("Welcome back")
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement("t9@example.test")
        compose.onNodeWithText("Password").performTextReplacement("t9-fixture-password")
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }

    /** A warm link delivered to the running activity, as the A08 journeys open theirs. */
    private fun open(uri: String) = compose.activityRule.scenario.onActivity { activity ->
        val original = activity.intent
        MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
            .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setClass(activity, MainActivity::class.java))
        activity.intent = original
    }

    private fun awaitText(text: String, substring: Boolean = false, unmerged: Boolean = false) =
        compose.waitUntil(20_000) { compose.onAllNodesWithText(text, substring = substring, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitTag(tag: String) = compose.waitUntil(20_000) { compose.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }
    private fun hasTestTag(tag: String, substring: Boolean) = SemanticsMatcher("testTag starts with $tag") {
        it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.let { value -> if (substring) value.startsWith(tag) else value == tag } == true
    }

    private fun request(path: String, body: String? = null): String = (URL(server + path).openConnection() as HttpURLConnection).run {
        connectTimeout = 5000; readTimeout = 5000
        if (body != null) { requestMethod = "POST"; doOutput = true; setRequestProperty("Content-Type", "application/json"); outputStream.use { it.write(body.toByteArray()) } }
        check(responseCode == 200); inputStream.bufferedReader().use { it.readText() }.also { disconnect() }
    }
    private fun control(body: String) { request("/__control", body) }
    private fun stats() = Json.parseToJsonElement(request("/__stats")).jsonObject

    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(600)
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(shots, "$name-$theme.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    private fun journey(name: String, block: () -> Unit) {
        File(shots, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\napi=${Build.VERSION.SDK_INT}\ntheme=$theme\n")
        try { block(); File(shots, "$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) {
            runCatching { capture("$name-failed") }
            File(shots, "$name-result.txt").writeText(error.stackTraceToString()); throw error
        } finally {
            runCatching { File(shots, "$name-server.json").writeText(request("/__stats")) }
            runBlocking { app.session.logout() }
        }
    }
}
