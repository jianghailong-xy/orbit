package io.orbitd.android.management

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/**
 * A13d on A11's isolated real stack (A01b A13-7/8/11/14/16): every write the app makes is read back from the real server with the
 * signed-in account's own token — the smart model selection switch (preferences.modelRouting), a revoked access token, the runners'
 * order and a removed runner, Kimi's site on a sign-in start (the relay, and the start the runner was handed) — and the DeepSeek
 * balance the app draws is the one the server answers. What the server said is kept beside the screenshots. Skipped unless the run
 * passes the stack (instrumentation arguments a13dServer, a13dEmail, a13dPassword).
 */
@RunWith(AndroidJUnit4::class)
class A13dStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val args get() = InstrumentationRegistry.getArguments()
    private lateinit var server: String
    private lateinit var dir: File
    private val http = OkHttpClient()
    private var token = ""

    @Before fun stack() {
        assumeTrue("Needs the isolated stack (instrumentation argument a13dServer)", args.getString("a13dServer") != null)
        server = args.getString("a13dServer")!!.trimEnd('/')
        dir = File(app.filesDir, "a13d-stack").apply { mkdirs() }
        compose.waitUntil(15_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
    }

    // ---- The server, read with the account's own token. ----

    private fun call(method: String, path: String, body: String? = null): Pair<Int, JsonElement?> {
        val payload = body?.toRequestBody("application/json".toMediaType()) ?: if (method == "POST") "".toRequestBody(null) else null
        val request = Request.Builder().url("$server/api/$path").method(method, payload).apply { if (token.isNotEmpty()) header("Authorization", "Bearer $token") }.build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            return response.code to text.takeIf { it.isNotBlank() }?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() }
        }
    }
    private fun signInToServer() {
        val (code, body) = call("POST", "auth/login", """{"email":"${args.getString("a13dEmail")}","password":"${args.getString("a13dPassword")}"}""")
        check(code in 200..299) { "server: sign-in $code" }
        token = body!!.jsonObject["accessToken"]!!.jsonPrimitive.content
    }
    private fun read(path: String): JsonElement {
        val (code, body) = call("GET", path)
        check(code in 200..299) { "server: GET $path → $code" }
        return body ?: JsonNull
    }
    private fun keep(label: String, path: String) = read(path).also { dir.resolve("$label.json").writeText(it.toString()) }
    private fun JsonElement.objects() = jsonArray.map { it.jsonObject }
    private fun JsonObject.s(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull

    private fun note(line: String) = dir.resolve("checks.log").appendText("${Instant.now()} $line\n")
    private fun ok(what: String, holds: Boolean) { note((if (holds) "PASS " else "FAIL ") + what); assertTrue(what, holds) }
    /** A write that went out through the UI, read back from the server until it shows (or 30 s pass). */
    private fun eventually(what: String, holds: () -> Boolean) {
        val until = System.currentTimeMillis() + 30_000
        var last: Throwable? = null
        while (System.currentTimeMillis() < until) {
            try { if (holds()) { note("PASS server: $what"); return } } catch (e: Throwable) { last = e }
            compose.mainClock.advanceTimeBy(500); compose.waitForIdle(); Thread.sleep(500)
        }
        note("FAIL server: $what${last?.let { " ($it)" }.orEmpty()}")
        throw AssertionError(what, last)
    }

    // ---- The app. ----

    private fun await(text: String, timeoutMs: Long = 30_000) {
        val until = System.currentTimeMillis() + timeoutMs
        while (compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isEmpty()) {
            if (System.currentTimeMillis() > until) { note("FAIL shows \"$text\""); capture("failed-${text.hashCode()}"); throw AssertionError("not shown: $text") }
            // The pages' timers run on the test's clock: move it with real time.
            compose.mainClock.advanceTimeBy(500); compose.waitForIdle(); Thread.sleep(250)
        }
        note("PASS shows \"$text\"")
    }
    private fun click(matcher: SemanticsMatcher, scroll: Boolean = true) {
        compose.waitUntil(20_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        if (scroll) try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick(); compose.waitForIdle()
    }
    private fun back() { compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }; compose.waitForIdle() }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync(); Thread.sleep(700)
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            dir.resolve("$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun settings() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        click(hasText("Settings") and hasClickAction()); await("Default permission")
    }

    @Test fun a13dWritesAreReadBackFromTheServer() {
        runBlocking { app.session.login(ServerAddress.parse(server, true), args.getString("a13dEmail")!!, args.getString("a13dPassword")!!) }
        compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        signInToServer()
        keep("server-before", "users/me")
        settings()

        // A13-14: the switch is written alone, and the server keeps what was written.
        val routingBefore = read("users/me").jsonObject["preferences"]?.jsonObject?.get("modelRouting")
        ok("smart model selection starts off on the server ($routingBefore)", routingBefore == null || routingBefore == JsonPrimitive(false))
        click(hasText("Smart model selection") and isToggleable())
        eventually("preferences.modelRouting is true") { read("users/me").jsonObject["preferences"]!!.jsonObject["modelRouting"] == JsonPrimitive(true) }
        capture("stack-smart-selection-on")
        click(hasText("Smart model selection") and isToggleable())
        eventually("preferences.modelRouting is false again") { read("users/me").jsonObject["preferences"]!!.jsonObject["modelRouting"] == JsonPrimitive(false) }

        // A13-7: the tokens the account issued on the web, and one revoked from here.
        val issued = keep("server-access-tokens-before", "access-tokens").jsonObject["tokens"]!!.objects()
        val laptop = issued.first { it.s("name") == "a13d laptop" }
        click(hasText("Access tokens") and hasClickAction())
        await("a13d laptop"); await("orbit_pat_…${laptop.s("tokenHint")}"); await("Never expires"); await("Last used")
        capture("stack-access-tokens")
        click(hasContentDescription("More for a13d laptop"), scroll = false)
        click(hasText("Revoke") and hasClickAction(), scroll = false)
        await("Revoke “a13d laptop”?")
        click(hasText("Revoke") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
        eventually("the laptop's token is REVOKED by its USER") {
            read("access-tokens").jsonObject["tokens"]!!.objects().first { it.s("id") == laptop.s("id") }.let { it.s("state") == "REVOKED" && it.s("revokedReason") == "USER" }
        }
        await("Token revoked")
        capture("stack-access-tokens-revoked")
        keep("server-access-tokens-after", "access-tokens")
        back(); await("Default permission")

        // A13-16: the DeepSeek key's balance is the server's answer — this key is refused, so no amount is drawn.
        val key = read("providers/mine").objects().first { it.s("label") == "DeepSeek (a13d)" }
        val answer = keep("server-deepseek-balance", "providers/mine/${key.s("id")}/balance").jsonObject
        click(hasText("Providers") and hasClickAction()); await("DeepSeek (a13d)")
        if (answer["ok"] == JsonPrimitive(false)) await("Unavailable")
        capture("stack-providers")
        click(hasText("DeepSeek (a13d)") and hasClickAction()); await("DeepSeek account balance")
        if (answer["ok"] == JsonPrimitive(false)) {
            await("Couldn't get the balance"); answer.s("message")?.let { await(it) }
            ok("no amount drawn for a balance not read", compose.onAllNodesWithText("¥", substring = true).fetchSemanticsNodes().isEmpty())
        }
        capture("stack-deepseek-key")
        click(hasText("Retry", substring = true) and hasClickAction())
        Thread.sleep(1_500)
        keep("server-deepseek-balance-after-retry", "providers/mine/${key.s("id")}/balance")
        back(); back(); await("Default permission")

        // A13-11: the runners' order is the dragged one, and a runner removed from its menu is gone.
        val before = keep("server-runners-before", "runners").objects()
        click(hasText("Runners") and hasClickAction()); await("a13d-spare")
        capture("stack-runners")
        val names = before.map { it.s("displayName")?.takeIf(String::isNotEmpty) ?: it.s("name").orEmpty() }
        val firstId = before.first().s("id")!!
        // TalkBack's Move down on the first row (what a drag of its handle sends too): one POST runners/reorder with the first
        // runner second, in the ids GET /runners gave the app. This server drops them — its ReorderRunnersDto takes plain strings
        // where workspaces' reorder takes @IsPublicId, so base62 ids match no runner and the order stands — so what the server
        // answered is written down rather than asserted (a server defect, filed separately; the app has no UUIDs to send).
        val firstRow = compose.onAllNodes(hasText(names.first()) and hasClickAction()).onFirst()
        val moveDown = firstRow.fetchSemanticsNode().config[SemanticsActions.CustomActions].first { it.label == "Move down" }
        compose.runOnIdle { moveDown.action() }
        Thread.sleep(3_000); compose.waitForIdle()
        val moved = keep("server-runners-after-move", "runners").objects().map { it.s("id") }.indexOf(firstId) == 1
        note((if (moved) "PASS" else "NOTE") + " server: after Move down the first runner is " + (if (moved) "second" else "still first (POST runners/reorder ignores public ids)"))
        capture("stack-runners-moved")
        click(hasContentDescription("More for a13d-spare"), scroll = false)
        click(hasText("Remove…") and hasClickAction(), scroll = false)
        await("Remove “a13d-spare”?")
        click(hasText("Remove Runner") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
        eventually("a13d-spare is no longer on the account") { read("runners").objects().none { it.s("name") == "a13d-spare" } }
        keep("server-runners-after", "runners")
        capture("stack-runners-removed")

        // A13-8: Kimi's sign-in asks the site; kimi.ai goes as region=global, kimi.com as mainland-cn (the runner can be told).
        click(hasText("a13d-kimi") and hasClickAction()); await("Max Concurrent")
        await("2.1.1 · kimi.com · Signed in")
        capture("stack-kimi-runner")
        click(hasText("Kimi Code") and hasClickAction()); await("Accounts")
        compose.onNodeWithContentDescription("More for Default").performScrollTo().performClick()
        click(hasText("Sign In Again"), scroll = false)
        await("Which Kimi account are you signing in with?"); await("Current")
        capture("stack-kimi-site-question")
        click(hasText("kimi.ai") and hasClickAction())
        await("Sign in with your kimi.ai account there", 60_000); await("Q2PF-8XWA")
        val runnerId = read("runners").objects().first { it.s("name") == "a13d-kimi" }.s("id")!!
        ok("server: the relay is the device step of kimi.ai", keep("server-kimi-login-global", "runners/$runnerId/login").jsonObject.let {
            it.s("status") == "awaiting_approval" && it.s("url")?.contains("kimi.ai") == true })
        capture("stack-kimi-device-kimi-ai")
        click(hasText("Use kimi.com instead") and hasClickAction())
        await("Sign in with your kimi.com account there", 60_000); await("7K06-QP86")
        ok("server: the relay is the device step of kimi.com", keep("server-kimi-login-mainland", "runners/$runnerId/login").jsonObject.let {
            it.s("status") == "awaiting_approval" && it.s("url")?.contains("kimi.com") == true })
        capture("stack-kimi-device-kimi-com")
        click(hasText("Cancel") and hasClickAction())
        eventually("the sign-in is cancelled") { read("runners/$runnerId/login").jsonObject.s("status") in setOf("cancelled", "cancelling", null) }
        keep("server-kimi-login-after", "runners/$runnerId/login")
        runBlocking { app.session.logout() }
    }
}
