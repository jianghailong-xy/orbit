package io.orbitd.android.composer

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
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
 * A07c on A11's isolated Orbit stack (its apiserver, PostgreSQL and Go runner with the stand-in engine), seeded by
 * scripts/a11-stack/a07c-stack.mjs, which also speaks for the runner "a07c-engines" through the real runner API. Signed in through
 * the product's screen, the app reads what the real server says and presses what it offers: the Engine list over that runner's
 * engines and lapsed Antigravity sign-in, and each engine's Provider list, its accounts and a key OpenCode runs (A07-3/4/6/10/13); the auto-retry card over a weekly
 * limit the server armed itself, its switch and its Retry (baseline); a FAILED turn re-sent on the provider picked after it (A07-8);
 * a pool session naming the key it runs on (A07-7); a Codex reset credit spent through the server's relay until none is left
 * (baseline, A07-9); a Markdown and a text file opened in the app (A07-1). Every press is read back from the stack's API with the
 * owner's own token, beside the screenshots. Arguments as RealStackDeviceTest's (a11Seed with its `a07c` part, ownerEmail,
 * ownerPassword; base64), run by scripts/tasks-projects-stack-device-test.sh with A11_TEST naming this class.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class ComposerStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private fun arg(key: String) = String(Base64.decode(requireNotNull(InstrumentationRegistry.getArguments().getString(key)) { "missing argument $key" }, Base64.DEFAULT))
    private val seed by lazy { Wire.json.parseToJsonElement(arg("a11Seed")).jsonObject }
    private val a07c by lazy { seed["a07c"]!!.jsonObject }
    private val server by lazy { seed["server"]!!.jsonPrimitive.content }
    private val reads = mutableListOf<String>()
    private fun JsonObject.field(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull
    private fun seeded(vararg path: String) = path.fold(a07c) { node, key -> node[key]!!.jsonObject }

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
    private fun session(key: String) = api("/sessions/${seeded("sessions", key).field("id")}").jsonObject
    private fun keep(name: String, element: JsonElement) = File(output, "$name.json").writeText(element.toString())

    private fun has(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun awaitText(text: String, timeout: Long = 60_000) =
        compose.waitUntil(timeout) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    /** Press the first node offering [label]. A list the server's answer recomposes between the lookup and the touch (the model
     * menu as its catalog arrives) loses the node, and nothing was pressed: look it up again. */
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
    private fun dialogTexts() = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasText("", substring = true)).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString(" | ") { t -> t.text } }
    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(700)
        instrument.uiAutomation.takeScreenshot().let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
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
        val id = seeded("sessions", key).field("id")!!
        compose.activityRule.scenario.onActivity { activity ->
            val original = activity.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(activity, Intent(Intent.ACTION_VIEW, Uri.parse("orbit-session:$id")).setClass(activity, MainActivity::class.java))
            activity.intent = original
        }
        compose.waitUntil(60_000) { has(hasTestTag("composer-model")) }
    }
    /** The transcript is a lazy list that opens on its latest row and stays pinned there until the reader drags it: a row below is
     * scrolled to, a row above is dragged down to, as a reader would. */
    private fun reveal(matcher: SemanticsMatcher) {
        val list = compose.onNodeWithTag("transcript-list")
        try { list.performScrollToNode(matcher) } catch (_: AssertionError) {
            for (drag in 1..30) { if (has(matcher)) break; list.performTouchInput { swipeDown() }; compose.waitForIdle() }
            compose.onAllNodes(matcher).onFirst().performScrollTo()
        }
        compose.waitForIdle()
    }
    private fun openModelMenu() {
        compose.waitUntil(30_000) { has(hasTestTag("composer-model") and isEnabled()) }
        compose.onNodeWithTag("composer-model").performClick()
        compose.waitUntil(30_000) { has(hasTestTag("composer-engine-title")) }
    }
    private fun journey(name: String, block: () -> Unit) {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "a07c-identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nserver=$server\n" +
            "scope=isolated Orbit stack (server trees of ${seed["sourceSha"]?.jsonPrimitive?.content}), test account ${arg("ownerEmail")}; not production\n")
        try { block(); File(output, "$name-result.txt").writeText("PASS\n") }
        catch (error: Throwable) {
            capture("$name-failed"); reads += "FAILED: $error"; File(output, "$name-result.txt").writeText(error.stackTraceToString())
            runCatching { File(output, "$name-failed-tree.txt").writeText(compose.onRoot().printToString(Int.MAX_VALUE)) }
            throw error
        }
        finally { File(output, "$name-readback.txt").writeText(reads.joinToString("\n")); runBlocking { app.session.logout() } }
    }

    /** A07-3, A07-10, A07-4, A07-6, A07-13 on the provider/engine split, over what the server says of a07c-engines: a new session's
     * Engine list names its engines in the boards' order, Antigravity CLI with its lapsed Google sign-in as the reason — which opens
     * that runner's Antigravity page; under each engine the model menu lists only its credentials: its accounts with Automatic first,
     * and the configured key under Claude Code and again under OpenCode. */
    @Test fun s1_aNewSessionListsTheRunnersEnginesTheirAccountsAndTheKeys() = journey("a07c-stack-menu") {
        val runner = seeded("enginesRunner").field("id")!!
        keep("a07c-stack-runner", awaitServer("/runners", "a07c-engines online with its engines") { all ->
            all.jsonArray.any { it.jsonObject.field("id") == runner && it.jsonObject["online"] == JsonPrimitive(true) &&
                (it.jsonObject["antigravity"] as? JsonObject)?.field("authSource") == "google" }
        })
        keep("a07c-stack-providers", api("/providers"))
        signIn()
        val workspace = seeded("enginesWorkspace").field("id")!!
        compose.waitUntil(30_000) { has(hasTestTag("workspace:$workspace")) }
        compose.onNodeWithTag("workspace:$workspace").performScrollTo().performClick()
        // The workspace's own New session (the drawer's is off screen).
        compose.waitUntil(30_000) { compose.onAllNodes(hasText("New session") and hasClickAction() and isEnabled()).fetchSemanticsNodes().any { it.boundsInRoot.left >= 0f } }
        val buttons = compose.onAllNodes(hasText("New session") and hasClickAction() and isEnabled())
        buttons[buttons.fetchSemanticsNodes().indexOfFirst { it.boundsInRoot.left >= 0f }].performClick()
        fun engineList(): List<String> {
            compose.waitUntil(30_000) { has(hasTestTag("new-session-engine") and isEnabled()) }
            compose.onNodeWithTag("new-session-engine").performClick()
            compose.waitUntil(30_000) { has(hasTestTag("engine:claude")) }
            return dialogTexts()
        }
        fun pickEngine(engine: String, name: String) {
            engineList(); compose.onNodeWithTag("engine:$engine").performScrollTo().performClick()
            compose.waitUntil(30_000) { has(hasText("$name ⌄")) }
        }
        /** The model menu's Provider section, below its heading and the current credential beside it. */
        fun providerRows(): List<String> {
            openModelMenu()
            compose.waitUntil(30_000) { has(hasText("Provider") and hasAnyAncestor(isDialog())) && has(hasText("Signed in on", substring = true) or hasText("On ", substring = true)) }
            val all = dialogTexts()
            return all.drop(all.indexOf("Provider") + 2)
        }
        val engines = engineList()
        File(output, "a07c-stack-engines.txt").writeText(engines.joinToString("\n"))
        fun at(row: String) = engines.indexOfFirst { it == row || it.startsWith("$row | ") }.also { assertTrue("engine $row in $engines", it >= 0) }
        val order = listOf("Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode").map(::at)
        assertEquals("A07-3: the engines in the boards' order", order.sorted(), order)
        assertTrue("A07-4: Antigravity CLI says why it can't run, and where that is fixed",
            engines.any { it.startsWith("Antigravity CLI | ") && it.contains("Not signed in →") })
        capture("a07c-stack-engine-list")
        // A new session starts on the engine its workspace last ran (the seed's Codex session's): Claude Code is picked here.
        compose.onNodeWithTag("engine:claude").performScrollTo().performClick()
        compose.waitUntil(30_000) { has(hasText("Claude Code ⌄")) }

        val claude = providerRows()
        File(output, "a07c-stack-menu.txt").writeText(claude.joinToString("\n"))
        reads += "A07-13: the menu is titled ${compose.onNodeWithTag("composer-engine-title").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Text)}"
        compose.onNodeWithTag("composer-engine-title").assertTextEquals("Claude Code")
        fun rowAt(rows: List<String>, row: String) = rows.indexOfFirst { it.removePrefix("✓ ") == row || it.removePrefix("✓ ").startsWith("$row | ") }
            .also { assertTrue("row $row in $rows", it >= 0) }
        assertTrue("A07-10: Claude Code's accounts, Automatic first", rowAt(claude, "Automatic") < rowAt(claude, "Default") && rowAt(claude, "Default") < rowAt(claude, "Work"))
        assertTrue("A07-6: the key under API keys", rowAt(claude, "API keys") < rowAt(claude, "DeepSeek"))
        assertTrue("only Claude Code's: no other engine's account", claude.none { it.startsWith("Team") })
        compose.onNodeWithContentDescription("Automatic: starts on the Claude Code account whose quota resets soonest, and switches when it hits its limit").assertExists()
        capture("a07c-stack-provider-list")
        appClick("Close")

        pickEngine("codex", "Codex")
        val codex = providerRows()
        assertTrue("A07-10: Codex's accounts, Automatic first", rowAt(codex, "Automatic") < rowAt(codex, "Default") && rowAt(codex, "Default") < rowAt(codex, "Team"))
        assertTrue(codex.none { it.startsWith("Work") || it.startsWith("DeepSeek") })
        capture("a07c-stack-codex-accounts")
        appClick("Close")

        pickEngine("opencode", "OpenCode")
        val openCode = providerRows()
        assertTrue("A07-6: the key again under OpenCode, after its own sign-in", rowAt(openCode, "OpenCode's own sign-in") < rowAt(openCode, "DeepSeek"))
        capture("a07c-stack-opencode-keys")
        appClick("Close")

        // A07-4: the engine's row names why, and opens the page that fixes it.
        engineList()
        compose.onNodeWithTag("engine:antigravity").performScrollTo().performClick()
        compose.waitUntil(30_000) { !has(isDialog()) && has(hasText("Antigravity CLI")) }
        capture("a07c-stack-antigravity-page")
    }

    /** The auto-retry card (baseline) over the server's own answer to Claude Code's weekly-limit sentence: armed for its reset; the
     * switch turns it off and on again on the server; Retry re-sends the message, and the card goes once the session moves on. */
    @Test fun s2_aWeeklyLimitIsTheServersArmedRetry() = journey("a07c-stack-auto-retry") {
        val armed = session("quota")
        reads += "seeded: retryAt=${armed.field("retryAt")} retryAttempts=${armed["retryAttempts"]} status=${armed.field("status")}"
        assertNotNull("the server armed the retry from the weekly-limit sentence", armed.field("retryAt"))
        signIn(); openSession("quota")
        awaitText("Weekly limit reached"); awaitText("Auto-retry when the quota resets"); awaitText("Retry now anyway")
        // The card is taller than the transcript's viewport here (720×1280): its head, then its switch and press.
        reveal(hasText("Weekly limit reached"))
        capture("a07c-stack-auto-retry-armed-head")
        compose.onNodeWithTag("auto-retry-switch").performScrollTo()
        capture("a07c-stack-auto-retry-armed")
        val path = "/sessions/${seeded("sessions", "quota").field("id")}"
        compose.onNodeWithTag("auto-retry-switch").performScrollTo().performClick()
        awaitServer(path, "switched off: no retry armed") { it.jsonObject["retryAt"] in listOf(null, JsonNull) }
        awaitText("Off — nothing will re-send until you do.")
        capture("a07c-stack-auto-retry-off")
        compose.onNodeWithTag("auto-retry-switch").performScrollTo().performClick()
        awaitServer(path, "switched on: armed again") { it.jsonObject.field("retryAt") != null }
        awaitText("Retry now anyway")
        appClick("Retry now anyway")
        val moved = awaitServer(path, "re-sent and answered") { d -> d.jsonObject["retryAt"] in listOf(null, JsonNull) &&
            d.jsonObject.field("status") == "AWAITING_INPUT" && (d.jsonObject["numTurns"] as? JsonPrimitive)?.intOrNull?.let { it >= 2 } == true }
        keep("a07c-stack-quota-session", moved)
        // The answer is the newest row: scrolled to once the app has it.
        val answer = hasText("a11-stack fake engine", substring = true)
        compose.waitUntil(60_000) { runCatching { compose.onNodeWithTag("transcript-list").performScrollToNode(answer) }.isSuccess }
        capture("a07c-stack-auto-retry-answered")
        // The card the session moved past is history: still there, and nothing on it to press.
        reveal(hasTestTag("auto-retry-card"))
        compose.waitUntil(30_000) { !has(hasTestTag("auto-retry-switch")) }
        assertTrue(compose.onAllNodes(hasAnyAncestor(hasTestTag("auto-retry-card")) and hasClickAction()).fetchSemanticsNodes().isEmpty())
        capture("a07c-stack-auto-retry-history")
    }

    /** A07-8: a FAILED turn, the provider picked after it held for the resume, and Retry re-sends the message on that pick. */
    @Test fun s3_aRetryAfterAPickRunsOnThePick() = journey("a07c-stack-retry-provider") {
        val failed = session("fail")
        reads += "seeded: status=${failed.field("status")} provider=${failed.field("provider")}"
        assertEquals("the stand-in engine's failed turn leaves the session FAILED", "FAILED", failed.field("status"))
        signIn(); openSession("fail")
        openModelMenu()
        compose.onNodeWithTag("composer-engine-title").assertTextEquals("Claude Code")
        appClick("DeepSeek")
        awaitText("Applies when this session resumes.")
        capture("a07c-stack-retry-pick")
        if (has(hasText("Close") and hasClickAction())) appClick("Close")
        compose.onNodeWithText("+").performClick(); awaitText("Retry last failed message"); appClick("Retry last failed message")
        val deepseek = seeded("keys", "deepseek").field("slug")!!
        val resumed = awaitServer("/sessions/${seeded("sessions", "fail").field("id")}", "re-sent on the pick") { d ->
            d.jsonObject.field("provider") == deepseek && d.jsonObject.field("status") == "AWAITING_INPUT" }
        keep("a07c-stack-retry-session", resumed)
        awaitText("a11-stack fake engine")
        capture("a07c-stack-retry-on-pick")
    }

    /** A07-7: a session on a shared pool of keys names the key its claim recorded — the one the server says it runs on. */
    @Test fun s4_aPoolSessionNamesTheKeyItRunsOn() = journey("a07c-stack-pool") {
        val detail = session("pool")
        keep("a07c-stack-pool-session", detail)
        val key = detail.field("poolKeyId")
        reads += "seeded: provider=${detail.field("provider")} status=${detail.field("status")} poolKeyId=$key"
        assertNotNull("the claim recorded the pool's key it runs on", key)
        val pool = seeded("sharedPool")
        val label = pool["keys"]!!.jsonArray.map { it.jsonObject }.first { it.field("id") == key }.field("label")!!
        signIn(); openSession("pool")
        compose.waitUntil(60_000) { has(hasTestTag("composer-pool-account")) }
        compose.onNodeWithTag("composer-pool-account").assertTextEquals(label)
        compose.onNodeWithContentDescription("${pool.field("label")} is running this session on $label").assertExists()
        capture("a07c-stack-pool-account")
        compose.onNode(hasText("Usage", substring = true) and hasClickAction()).performClick()
        awaitText("Context and plan usage"); awaitText(label)
        capture("a07c-stack-pool-usage")
    }

    /** The reset-credit card (baseline) and A07-9 through the server's relay: two credits, one spent (the card stays with one), the
     * last spent (the card goes, its windows stay). */
    @Test fun s5_aCodexResetCreditIsSpentThroughTheRelayUntilNoneIsLeft() = journey("a07c-stack-reset") {
        val runner = seeded("enginesRunner").field("id")!!
        signIn(); openSession("codex")
        compose.waitUntil(30_000) { has(hasText("Usage", substring = true) and hasClickAction()) }
        compose.onNode(hasText("Usage", substring = true) and hasClickAction()).performClick()
        awaitText("Reset credit"); awaitText("2 available"); awaitText("Primary: 23%")
        capture("a07c-stack-reset-two")
        fun spend(left: Int) {
            compose.waitUntil(60_000) { compose.onAllNodes(hasText("Use reset credit") and hasClickAction() and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
            appClick("Use reset credit"); awaitText("Use reset credit?")
            appClick("Use reset")
            val settled = awaitServer("/runners/$runner/codex-rate-limit-reset", "a reset settled, $left left") { read ->
                (read.jsonObject["latest"] as? JsonObject)?.field("status") == "SUCCEEDED" && read.jsonObject["active"] in listOf(null, JsonNull) &&
                    api("/runners").jsonArray.first { it.jsonObject.field("id") == runner }.jsonObject["planUsage"]?.jsonObject?.get("codex")?.jsonObject
                        ?.get("rateLimitReset")?.jsonObject?.get("rateLimitResetCredits")?.jsonObject?.get("availableCount")?.jsonPrimitive?.intOrNull == left }
            keep("a07c-stack-reset-$left-left", settled)
        }
        spend(1)
        awaitText("Usage limits reset · 1 credit used"); awaitText("1 available")
        capture("a07c-stack-reset-one-left")
        spend(0)
        compose.waitUntil(60_000) { !has(hasText("Reset credit")) }
        awaitText("Primary: 23%")
        capture("a07c-stack-reset-none-left")
        keep("a07c-stack-reset-runner", api("/runners").jsonArray.first { it.jsonObject.field("id") == runner })
    }

    /** A07-1: a Markdown and a text file the session sent, downloaded from the server and read in the app. */
    @Test fun s6_aMarkdownAndATextFileOpenInTheApp() = journey("a07c-stack-files") {
        signIn(); openSession("files")
        compose.waitUntil(60_000) { has(hasTestTag("transcript-list")) }
        reveal(hasText("release-notes.md")); appClick("release-notes.md")
        awaitText("4 lines"); awaitText("Release notes")
        capture("a07c-stack-markdown-preview")
        appClick("Source"); awaitText("# Release notes")
        capture("a07c-stack-markdown-source")
        appClick("Close attachment")
        appClick("build.log"); awaitText("3 lines"); awaitText("BUILD SUCCESSFUL in 4m")
        capture("a07c-stack-text-file")
        appClick("Close attachment")
    }
}
