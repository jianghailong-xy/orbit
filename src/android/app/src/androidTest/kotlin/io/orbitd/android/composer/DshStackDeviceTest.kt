package io.orbitd.android.composer

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
import org.junit.FixMethodOrder
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * A07d (A07-5) on A11's isolated Orbit stack, its server main's own (the provider/engine split: a session says its `engine`), seeded
 * by scripts/a11-stack/a07d-stack.mjs, which speaks for two runners through the real runner API: "a07d-dsh", whose DeepSeek Harness
 * is ready and which claimed two Harness sessions on a DeepSeek key — one asking an approval, one failed with DeepSeek's real 401
 * sentence — and "a07d-dsh-old", whose Harness is a version Orbit doesn't support, and which answers an install. Signed in through
 * the product's screen, the app reads what the real server says and presses what it offers: the approval card's Allow and Deny alone,
 * the repair card and its Retry, a `!` command kept in the composer, the chip's runtime-picked model, and the engine page's install
 * through the server's relay. Every press is read back from the stack's API with the owner's own token, beside the screenshots.
 * Arguments as ComposerStackDeviceTest's (a11Seed with its `a07d` part, ownerEmail, ownerPassword; base64), run by
 * scripts/tasks-projects-stack-device-test.sh with A11_TEST naming this class.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class DshStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private fun arg(key: String) = String(Base64.decode(requireNotNull(InstrumentationRegistry.getArguments().getString(key)) { "missing argument $key" }, Base64.DEFAULT))
    private val seed by lazy { Wire.json.parseToJsonElement(arg("a11Seed")).jsonObject }
    private val a07d by lazy { seed["a07d"]!!.jsonObject }
    private val server by lazy { seed["server"]!!.jsonPrimitive.content }
    private val reads = mutableListOf<String>()
    private fun JsonObject.field(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull
    private fun seeded(vararg path: String) = path.fold(a07d) { node, key -> node[key]!!.jsonObject }
    private fun sessionId(key: String) = seeded("sessions", key).field("id")!!

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
    private fun api(path: String): JsonElement {
        val (status, text) = http("GET", path, null, token)
        check(status in 200..299) { "GET $path: HTTP $status ${text.take(300)}" }
        return Wire.json.parseToJsonElement(text)
    }
    /** Poll the stack's own answer until [done] holds, recording the read that did. */
    private fun awaitServer(path: String, what: String, timeoutMs: Long = 120_000, done: (JsonElement) -> Boolean): JsonElement {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val read = api(path)
            if (done(read)) { reads += "$what: GET $path => ${read.toString().take(400)}"; return read }
            check(SystemClock.uptimeMillis() < deadline) { "$what: never held; last ${read.toString().take(600)}" }
            SystemClock.sleep(2_000)
        }
    }
    private fun keep(name: String, element: JsonElement) = File(output, "$name.json").writeText(element.toString())
    private fun runner(name: String) = api("/runners").jsonArray.map { it.jsonObject }.first { it.field("name") == name }
    private fun JsonObject.engine(name: String) = (get("engines") as? JsonArray)?.map { it.jsonObject }?.firstOrNull { it.field("engine") == name }

    private fun has(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun awaitText(text: String, timeout: Long = 60_000) =
        compose.waitUntil(timeout) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    /** Press the first node offering [label], looked up again if a recomposition took it between the lookup and the touch. */
    private fun appClick(label: String) {
        val matcher = (hasText(label) or hasContentDescription(label)) and hasClickAction()
        compose.waitUntil(30_000) { has(matcher) }
        for (attempt in 1..3) {
            try {
                val node = compose.onAllNodes(matcher).onFirst()
                try { node.performScrollTo() } catch (_: AssertionError) { }
                node.performClick(); compose.waitForIdle(); return
            } catch (error: AssertionError) { if (attempt == 3) throw error; compose.waitForIdle() }
        }
    }
    /** The transcript is a lazy list pinned to its latest row: a row in it is scrolled to, as a reader would, so its head shows. */
    private fun reveal(matcher: SemanticsMatcher) {
        compose.waitUntil(30_000) { has(matcher) }
        try { compose.onNodeWithTag("transcript-list").performScrollToNode(matcher) }
        catch (_: AssertionError) { compose.onAllNodes(matcher).onFirst().performScrollTo() }
        compose.waitForIdle()
    }
    /** Brought into view on its page's own scroll. */
    private fun scrollTo(matcher: SemanticsMatcher) {
        compose.waitUntil(30_000) { has(matcher) }
        try { compose.onAllNodes(matcher).onFirst().performScrollTo() } catch (_: AssertionError) { }
        compose.waitForIdle()
    }
    /** A screenshot the system withholds under load (UiAutomation returns null) is asked for again. */
    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(700)
        for (attempt in 1..3) {
            val bitmap = instrument.uiAutomation.takeScreenshot()
            if (bitmap != null) {
                File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle(); return
            }
            SystemClock.sleep(1_000)
        }
        reads += "NOTE: no screenshot for $name (the system returned none three times)"
    }

    private fun signIn() {
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        awaitText("Welcome back")
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement(arg("ownerEmail"))
        compose.onNodeWithText("Password").performTextReplacement(arg("ownerPassword"))
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
    }
    private fun openSession(key: String) {
        val id = sessionId(key)
        compose.activityRule.scenario.onActivity { activity ->
            val original = activity.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:$id")).setClass(activity, MainActivity::class.java))
            activity.intent = original
        }
        compose.waitUntil(60_000) { has(hasTestTag("composer-model")) }
    }
    private fun journey(name: String, block: () -> Unit) {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "a07d-identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nserver=$server\n" +
            "scope=isolated Orbit stack (server trees of ${seed["sourceSha"]?.jsonPrimitive?.content}), test account ${arg("ownerEmail")}; not production\n")
        try { block(); File(output, "$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) {
            capture("$name-failed"); reads += "FAILED: $error"; File(output, "$name-result.txt").writeText(error.stackTraceToString())
            runCatching { File(output, "$name-failed-tree.txt").writeText(compose.onRoot().printToString(Int.MAX_VALUE)) }
            throw error
        }
        finally { File(output, "$name-readback.txt").writeText(reads.joinToString("\n")); runBlocking { app.session.logout() } }
    }

    /** cef6c8e0d: a Harness session's approval card is Allow and Deny alone, and the Allow carries no rule to the server. */
    @Test fun s1_aHarnessSessionsApprovalIsAllowAndDenyAlone() = journey("a07d-stack-approval") {
        val id = sessionId("approval")
        keep("a07d-stack-approval-session", awaitServer("/sessions/$id", "the session runs on DeepSeek Harness") { it.jsonObject.field("engine") == "dsh" })
        awaitServer("/sessions/$id/approvals", "its approval is pending") { all -> all.jsonArray.any { it.jsonObject.field("status") == "PENDING" } }
        signIn(); openSession("approval")
        compose.waitUntil(60_000) { has(hasText("Allow") and hasClickAction()) && has(hasText("Deny") and hasClickAction()) }
        assertFalse("no Allow & remember on Harness", has(hasText("Allow & remember", substring = true)))
        // The card's head — the tool and its command — then its doors: the transcript's viewport holds one at a time here.
        reveal(hasText("Decisions and requests"))
        capture("a07d-stack-approval-card")
        scrollTo(hasText("Deny") and hasClickAction())
        capture("a07d-stack-approval-doors")
        appClick("Allow")
        val decided = awaitServer("/sessions/$id/approvals", "allowed") { all -> all.jsonArray.any { it.jsonObject.field("status") == "ALLOWED" } }
        keep("a07d-stack-approval-decided", decided)
        compose.waitUntil(60_000) { !has(hasText("Deny") and hasClickAction()) }
        capture("a07d-stack-approval-allowed")
    }

    /** e789ce3dc, 13720e241: DeepSeek's real 401, as the runner words it, is the repair card; its Retry re-sends the message. */
    @Test fun s2_aKeyDeepSeekRejectedIsTheRepairCard() = journey("a07d-stack-repair") {
        val id = sessionId("rejected")
        val failed = awaitServer("/sessions/$id", "the turn failed on the rejected key") { d ->
            d.jsonObject.field("engine") == "dsh" && d.jsonObject.field("status") in setOf("FAILED", "AWAITING_INPUT") }
        keep("a07d-stack-rejected-session", failed)
        signIn(); openSession("rejected")
        awaitText("DeepSeek rejected this API key")
        awaitText("Update the key in Infrastructure, then send your message again.")
        awaitText("Update the API key")
        awaitText("Retry — re-send my last message")
        assertFalse("the card stands in for the runner's line", has(hasText("Authentication Fails", substring = true)))
        reveal(hasText("DeepSeek rejected this API key"))
        capture("a07d-stack-repair-card")
        scrollTo(hasText("Retry — re-send my last message") and hasClickAction())
        capture("a07d-stack-repair-buttons")
        appClick("Retry — re-send my last message")
        keep("a07d-stack-rejected-retried", awaitServer("/sessions/$id", "the message went again") { d ->
            d.jsonObject.field("status") in setOf("PENDING", "RUNNING") })
        capture("a07d-stack-repair-retried")
    }

    /** e789ce3dc, 7ca6ab87e: on Harness a `!` command stays in the composer with why, and the chip says the runtime picks the model. */
    @Test fun s3_aShellCommandStaysAndTheChipSaysHarnessPicks() = journey("a07d-stack-composer") {
        val id = sessionId("approval")
        val before = api("/sessions/$id").jsonObject
        reads += "before: model=${before.field("model")} engine=${before.field("engine")} status=${before.field("status")}"
        signIn(); openSession("approval")
        if (before.field("model").isNullOrEmpty()) {
            compose.waitUntil(30_000) { has(hasContentDescription("Model Picked by DeepSeek Harness, effort Default")) }
        }
        compose.onNodeWithTag("composer-input").performTextInput("!git status")
        compose.onNodeWithTag("composer-send").performClick()
        awaitText("DeepSeek Harness sessions don't run ! shell commands — ask the agent to run it instead.")
        assertTrue("the command stays where it was typed", has(hasTestTag("composer-input") and hasText("!git status")))
        capture("a07d-stack-shell-refused")
        // Nothing went out: no turn queued behind the running one.
        SystemClock.sleep(3_000)
        val turns = api("/sessions/$id/turns")
        keep("a07d-stack-shell-turns", turns)
        assertTrue("no turn for the ! command: $turns", turns.jsonArray.none { it.jsonObject.toString().contains("git status") })
        compose.onNodeWithTag("composer-input").performTextReplacement("")
    }

    /** e789ce3dc's engine page: a Harness version Orbit doesn't support, installed again through the server's relay. */
    @Test fun s4_theEnginePageInstallsHarnessThroughTheRelay() = journey("a07d-stack-install") {
        val name = seeded("oldRunner").field("name")!!
        keep("a07d-stack-old-runner", awaitServer("/runners", "$name online, its Harness unsupported") { all ->
            all.jsonArray.map { it.jsonObject }.firstOrNull { it.field("name") == name }?.engine("dsh")?.get("dsh")?.jsonObject?.get("versionCompatible") == JsonPrimitive(false) })
        signIn()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        appClick("Settings"); awaitText("Default permission")
        appClick("Runners"); awaitText(name)
        appClick(name); awaitText("DeepSeek Harness")
        scrollTo(hasText("DeepSeek Harness") and hasClickAction())
        capture("a07d-stack-runner-page")
        appClick("DeepSeek Harness")
        awaitText("This runner has a DeepSeek Harness version Orbit does not support. Reinstall it from Infrastructure.")
        capture("a07d-stack-engine-page")
        appClick("Install DeepSeek Harness")
        keep("a07d-stack-install-started", awaitServer("/runners", "an install of Harness started") { all ->
            all.jsonArray.map { it.jsonObject }.first { it.field("name") == name }["install"]?.jsonObject?.field("engine") == "dsh" })
        awaitText("Installing DeepSeek Harness 0.2.0-rc.2…", timeout = 90_000)
        capture("a07d-stack-engine-installing")
        keep("a07d-stack-installed", awaitServer("/runners", "Harness installed, a supported version", timeoutMs = 240_000) { all ->
            all.jsonArray.map { it.jsonObject }.first { it.field("name") == name }.engine("dsh")?.get("dsh")?.jsonObject?.get("versionCompatible") == JsonPrimitive(true) })
        compose.waitUntil(90_000) { !has(hasText("Install DeepSeek Harness") and hasClickAction()) }
        awaitText("0.2.0-rc.2")
        capture("a07d-stack-engine-installed")
        keep("a07d-stack-old-runner-after", runner(name))
    }
}
