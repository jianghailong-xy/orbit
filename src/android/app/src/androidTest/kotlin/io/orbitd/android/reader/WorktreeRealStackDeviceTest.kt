package io.orbitd.android.reader

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.*
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.core.auth.AuthState
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

/**
 * A06c's worktree merge on the A11 isolated Orbit stack (its apiserver, PostgreSQL and Go runner with the
 * stand-in engine that writes a line into the session's worktree), signed in through the product's screen:
 * the bar offers Commit for the dirty worktree, then Merge to main, and the runner's real git answer is what
 * the bar says — read back from the stack's API beside the screenshots. Arguments as RealStackDeviceTest's
 * (a11Seed, ownerEmail, ownerPassword; base64), run by scripts/tasks-projects-stack-device-test.sh.
 */
@RunWith(AndroidJUnit4::class)
class WorktreeRealStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private fun arg(key: String) = String(Base64.decode(requireNotNull(InstrumentationRegistry.getArguments().getString(key)) { "missing argument $key" }, Base64.DEFAULT))
    private val seed by lazy { Wire.json.parseToJsonElement(arg("a11Seed")).jsonObject }
    private val server by lazy { seed["server"]!!.jsonPrimitive.content }
    private val reads = mutableListOf<String>()

    private fun http(method: String, path: String, body: String?, bearer: String?): Pair<Int, String> =
        (URL("$server/api$path").openConnection() as HttpURLConnection).run {
            connectTimeout = 10_000; readTimeout = 30_000; requestMethod = method
            bearer?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json"); outputStream.use { it.write(body.toByteArray()) } }
            try { responseCode to ((if (responseCode < 400) inputStream else errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()) }
            finally { disconnect() }
        }
    private val token by lazy {
        val (status, text) = http("POST", "/auth/login", buildJsonObject { put("email", arg("ownerEmail")); put("password", arg("ownerPassword")) }.toString(), null)
        check(status in 200..299) { "API sign-in: HTTP $status" }
        Wire.json.parseToJsonElement(text).jsonObject["accessToken"]!!.jsonPrimitive.content
    }
    private fun api(method: String, path: String, body: JsonObject? = null): JsonObject {
        val (status, text) = http(method, path, body?.toString(), token)
        check(status in 200..299) { "$method $path: HTTP $status ${text.take(300)}" }
        return Wire.json.parseToJsonElement(text).jsonObject
    }
    private fun JsonObject.text(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull

    private fun awaitText(text: String, timeout: Long = 60_000) =
        compose.waitUntil(timeout) { compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(700)
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    /** Poll the stack's own answer for the session until [done] holds, recording each read. */
    private fun awaitSession(id: String, what: String, timeoutMs: Long = 180_000, done: (JsonObject) -> Boolean): JsonObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val detail = api("GET", "/sessions/$id")
            if (done(detail)) { reads += "$what => status=${detail.text("status")} isolation=${detail.text("isolationStatus")} branch=${detail.text("branch")} " +
                "dirty=${detail["worktreeDirty"]} merge=${detail.text("mergeStatus")} target=${detail.text("mergeTarget")} commit=${detail.text("commitStatus")} " +
                "files=${detail["changedFiles"]}"; return detail }
            check(SystemClock.uptimeMillis() < deadline) { "$what: never held; last ${detail.toString().take(600)}" }
            SystemClock.sleep(2_000)
        }
    }

    @Test fun theWorktreeBarCommitsAndMergesARealWorktree() {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "worktree-identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nserver=$server\n" +
            "scope=isolated Orbit stack (server trees of ${seed["sourceSha"]?.jsonPrimitive?.content}), test account ${arg("ownerEmail")}; not production\n")
        try {
            // A session in the stack's workspace: its runner checks out a worktree, and the stand-in engine writes a line in it.
            val workspace = seed["workspace"]!!.jsonObject["id"]!!.jsonPrimitive.content
            val created = api("POST", "/sessions", buildJsonObject {
                put("workspaceId", workspace); put("title", "A06c worktree merge"); put("prompt", "A06c: leave a note in the worktree")
            })
            val id = created.text("id")!!
            reads += "POST /sessions => $id"
            awaitSession(id, "dirty worktree after the turn") { d ->
                d.text("isolationStatus") == "worktree" && d["worktreeDirty"] == JsonPrimitive(true) &&
                    (d["changedFiles"] as? JsonArray).orEmpty().isNotEmpty() && (d.text("runStatus") ?: d.text("status")) == "AWAITING_INPUT"
            }
            compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
            if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
            awaitText("Welcome back")
            compose.chooseServer(server)
            compose.onNodeWithText("Email").performTextReplacement(arg("ownerEmail"))
            compose.onNodeWithText("Password").performTextReplacement(arg("ownerPassword"))
            compose.onNodeWithText("Sign In").performScrollTo().performClick()
            compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
            compose.activityRule.scenario.onActivity { activity ->
                val original = activity.intent
                MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                    .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:$id")).setClass(activity, MainActivity::class.java))
                activity.intent = original
            }
            compose.waitUntil(60_000) { compose.onAllNodesWithText("Commit").fetchSemanticsNodes().isNotEmpty() }
            capture("worktree-stack-dirty")
            compose.onNodeWithText(" · 1 file", substring = true, useUnmergedTree = true).assertExists()
            compose.onNodeWithText("Commit").performClick()
            awaitSession(id, "after Commit") { it.text("commitStatus") in setOf("committed", "nochange", "error") && it["worktreeDirty"] != JsonPrimitive(true) }
            compose.waitUntil(60_000) { compose.onAllNodesWithText("Merge to ", substring = true).fetchSemanticsNodes().isNotEmpty() }
            capture("worktree-stack-committed")
            compose.onNode(hasText("Merge to ", substring = true) and hasClickAction()).performClick()
            val merged = awaitSession(id, "after Merge") { it.text("mergeStatus") in setOf("merged", "conflict", "error") || it["mergeRecovery"] is JsonObject }
            File(output, "worktree-stack-session.json").writeText(merged.toString())
            assertEquals("the runner merged the worktree", "merged", merged.text("mergeStatus"))
            compose.waitUntil(60_000) { compose.onAllNodesWithText("✓ Merged").fetchSemanticsNodes().isNotEmpty() }
            awaitText("Merged into ")
            capture("worktree-stack-merged")
            // The changed files the merge carried, as the bar's sheet shows them.
            compose.onNodeWithText(" · committed", substring = true, useUnmergedTree = true).performClick()
            awaitText("Worktree changes")
            awaitText("A11_STACK_NOTES.md")
            capture("worktree-stack-files")
            File(output, "worktree-stack-result.txt").writeText("PASS\n")
        } catch (error: Throwable) {
            capture("worktree-stack-failed"); reads += "FAILED: $error"; throw error
        } finally {
            File(output, "worktree-stack-readback.txt").writeText(reads.joinToString("\n"))
            runBlocking { app.session.logout() }
        }
    }
}
