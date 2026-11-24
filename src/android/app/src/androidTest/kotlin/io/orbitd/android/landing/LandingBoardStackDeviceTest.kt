package io.orbitd.android.landing

import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/**
 * The landing setting and the pull request landing states on a real stack (this branch's apiserver on a throwaway PostgreSQL, seeded by
 * pull-request-landing.pg.spec case 16 with LANDING_STATES_OUT). The manifest it wrote is passed as the `boardManifest` argument (its
 * JSON, base64); the run signs in as the board's owner and screenshots every state: the six pull request cards on the task page and the
 * project's landing card, and each workspace's Landing section. Skipped without the arguments.
 */
@RunWith(AndroidJUnit4::class)
class LandingBoardStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val args get() = InstrumentationRegistry.getArguments()
    private lateinit var dir: File
    private lateinit var manifest: JSONObject

    @Before fun stack() {
        assumeTrue("Needs boardServer and boardManifest", args.getString("boardServer") != null)
        manifest = JSONObject(String(android.util.Base64.decode(args.getString("boardManifest"), android.util.Base64.DEFAULT)))
        dir = File(app.filesDir, "landing-board").apply { deleteRecursively(); mkdirs() }
        compose.waitUntil(15_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
    }

    private fun note(line: String) = dir.resolve("checks.log").appendText("${Instant.now()} $line\n")
    private fun shown(text: String, substring: Boolean = true) = compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty()
    private fun await(text: String, timeoutMs: Long = 40_000) {
        val until = System.currentTimeMillis() + timeoutMs
        while (!shown(text)) {
            if (System.currentTimeMillis() > until) { note("FAIL shows \"$text\""); capture("failed-${text.hashCode()}"); throw AssertionError("not shown: $text") }
            compose.mainClock.advanceTimeBy(500); compose.waitForIdle(); Thread.sleep(250)
        }
        note("PASS shows \"$text\"")
    }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync(); Thread.sleep(700)
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            dir.resolve("$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    /** Hands the app a link as its running activity receives one, without starting another instance of it. */
    private fun link(uri: String) {
        compose.activityRule.scenario.onActivity {
            val deliver = MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
            deliver.invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(it.packageName))
        }
        compose.waitForIdle()
    }
    private fun shownAfter(text: String): Boolean { try { await(text, 8_000) } catch (_: AssertionError) { return false }; return true }
    private fun scrollTo(text: String) { try { compose.onAllNodesWithText(text, substring = true).onFirst().performScrollTo() } catch (_: AssertionError) { } }

    @Test fun everyBoardStateOnARealStack() {
        val server = args.getString("boardServer")!!
        runBlocking { app.session.login(ServerAddress.parse(server, true), args.getString("boardEmail")!!, args.getString("boardPassword")!!) }
        compose.waitUntil(90_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        val only = args.getString("boardOnly")
        val cards = manifest.getJSONObject("cards")
        // The pull request states, on each task's own Landing section.
        val heads = mapOf("a" to "Pull request open", "b" to "Waiting for review", "c" to "Check failed: PostgreSQL specs", "d" to "Catching up with main",
            "e" to "Landed by pull request", "f" to "Opened a pull request instead", "closed" to "Pull request closed")
        // The project's landing card carries the in-flight pull request; the Landings window carries every state, a settled one opened.
        val sessions = manifest.getJSONObject("landingSessions")
        for ((key, head) in heads) {
            if (only != null && only != "card:$key") continue
            if (key in listOf("a", "b", "d", "f")) {
                link("orbit-project:${cards.getJSONObject(key).getString("projectId")}")
                await(head); if (key == "b") await("Faster next time"); capture("project-$key")
            }
            link("orbit-session:${sessions.getString(key)}")
            if (!shownAfter(head)) {
                compose.onAllNodes(SemanticsMatcher("landing row") { n ->
                    (androidx.compose.ui.semantics.SemanticsProperties.TestTag in n.config && n.config[androidx.compose.ui.semantics.SemanticsProperties.TestTag].startsWith("landing-row:")) }).onFirst().performClick()
            }
            await(head); scrollTo(head)
            capture("landings-$key")
        }
        val names = mapOf("pullRequest" to "opened-with-checks-running", "pushAsMe" to "push-as-me-on", "refused" to "push-refused",
            "notFromGithub" to "not-from-github", "permissionsPending" to "permissions-pending", "notConnected" to "github-not-connected")
        for ((key, name) in names) {
            if (only != key) continue
            if (key == "notConnected") break // belongs to the second account; read in the unit shell test
            await(name)
            compose.onAllNodesWithText(name, substring = false).onFirst().performScrollTo().performClick()
            compose.waitForIdle()
            capture("settings-$key-directory")
            compose.onNodeWithContentDescription("Session scope", substring = true).performClick()
            compose.onNodeWithText("Settings").performClick()
            await("$name settings"); await("Landing")
            when (key) { "refused", "permissionsPending" -> { val box = if (key == "refused") "refused" else "permissions-pending"; compose.onNodeWithTag("landing-setting:$box:action", useUnmergedTree = true).performScrollTo() }; else -> scrollTo("Landing") }
            capture("settings-$key")
        }
        note("DONE ${only ?: "all"}")
        runBlocking { app.session.logout() }
    }
}
