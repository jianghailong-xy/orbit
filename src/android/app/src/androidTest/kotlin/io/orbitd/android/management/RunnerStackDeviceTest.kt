package io.orbitd.android.management

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/**
 * A13c on A11's isolated real stack: runners that report Antigravity through the real runner API (register and heartbeat —
 * Google sign-in relayed with two accounts, a macOS runner on its Gemini key, a runner too old to relay it), read back by the
 * app from the real server's GET /runners. What the server answered is kept beside the screenshots. Skipped unless the run
 * passes the stack (instrumentation arguments a13cServer, a13cEmail, a13cPassword).
 */
@RunWith(AndroidJUnit4::class)
class RunnerStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val args get() = InstrumentationRegistry.getArguments()
    private lateinit var server: String
    private lateinit var dir: File

    @Before fun stack() {
        assumeTrue("Needs the isolated stack (instrumentation argument a13cServer)", args.getString("a13cServer") != null)
        server = args.getString("a13cServer")!!.trimEnd('/')
        dir = File(app.filesDir, "a13c-stack").apply { mkdirs() }
        compose.waitUntil(15_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
    }

    private fun note(line: String) = dir.resolve("checks.log").appendText("${Instant.now()} $line\n")
    private fun await(text: String, timeoutMs: Long = 30_000) {
        val until = System.currentTimeMillis() + timeoutMs
        while (compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isEmpty()) {
            if (System.currentTimeMillis() > until) { note("FAIL shows \"$text\""); capture("failed-${text.hashCode()}"); throw AssertionError("not shown: $text") }
            // The pages' timers run on the test's clock: move it with real time.
            compose.mainClock.advanceTimeBy(500); compose.waitForIdle(); Thread.sleep(250)
        }
        note("PASS shows \"$text\"")
    }
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(20_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick(); compose.waitForIdle()
    }
    private fun back() { compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }; compose.waitForIdle() }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync(); Thread.sleep(700)
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            dir.resolve("$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    /** What the server says of the runners now, with the signed-in account's own token. */
    private fun keepServersAnswer(label: String) {
        val http = OkHttpClient()
        val login = Request.Builder().url("$server/api/auth/login").post(
            """{"email":"${args.getString("a13cEmail")}","password":"${args.getString("a13cPassword")}"}""".toRequestBody("application/json".toMediaType())).build()
        val token = http.newCall(login).execute().use { Regex("\"accessToken\":\"([^\"]+)\"").find(it.body!!.string())!!.groupValues[1] }
        val runners = http.newCall(Request.Builder().url("$server/api/runners").header("Authorization", "Bearer $token").build()).execute().use { it.body!!.string() }
        dir.resolve("$label.json").writeText(runners)
    }

    @Test fun theRunnerPagesShowWhatTheRunnersReport() {
        runBlocking { app.session.login(ServerAddress.parse(server, true), args.getString("a13cEmail")!!, args.getString("a13cPassword")!!) }
        compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        keepServersAnswer("server-runners")
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        click(hasText("Settings") and hasClickAction()); await("Default permission")
        click(hasText("Runners") and hasClickAction()); await("a13c-agy")
        capture("stack-runners")
        // Google sign-in relayed, two Google accounts: one window on the row, the account a new session starts on named above it.
        click(hasText("a13c-agy") and hasClickAction()); await("Max Concurrent")
        await("2 accounts signed in"); await("Next: Default"); await("3p-weekly"); await("98% remaining")
        compose.onAllNodesWithText("Next: Default", substring = true).onFirst().performScrollTo()
        capture("stack-agy-runner")
        click(hasText("Antigravity") and hasClickAction()); await("Accounts")
        await("Work"); await("~/.orbit/antigravity-accounts/5c2e91a0"); await("gemini-5h"); await("4% remaining")
        capture("stack-agy-engine")
        compose.onAllNodesWithText("Google terms", substring = true).onLast().performScrollTo()
        await("Add Account")
        capture("stack-agy-engine-terms")
        back()
        // Claude Code: Default's login lapses in two days; Work's quota rides the runner's FLAT plan usage (A13-6).
        click(hasText("Claude Code") and hasClickAction()); await("Login expires in 2 days"); await("Renew")
        await("41%")
        capture("stack-claude-engine")
        back(); back()
        // macOS: Google sign-in not supported there; Antigravity on the runner's own key.
        click(hasText("a13c-mac") and hasClickAction()); await("Max Concurrent")
        await("Google sign-in is not supported on macOS runners yet. Use a Gemini API key."); await("env key")
        capture("stack-mac-runner")
        back()
        // Too old to relay Google sign-in.
        click(hasText("a13c-old") and hasClickAction()); await("Max Concurrent")
        await("Update runner"); await("Update this runner to sign in with Google.")
        capture("stack-old-runner")
        back()
        keepServersAnswer("server-runners-after")
        runBlocking { app.session.logout() }
    }
}
