package io.orbitd.android.management

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Dismissing an engine's update warning until its next release, over the controlled server (the web's
 * MachineSettingsPage.engines.test.tsx on Android): the Needs Attention card offers "Dismiss until next Codex release" beside Update
 * Engines Now and the Codex row its own Dismiss; either POSTs runners/:id/engines/codex/update-warning/dismiss, after which the card and
 * the row's warning are gone and the engine page's version line keeps the drift with "· warning dismissed". A newer latest brings the
 * card back. Each state is drawn to `src/android/build/evidence/engine-update-dismiss-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EngineUpdateDismissPageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset(); fixture.runnerAlias = "aivps-sg" }

    private var record by mutableStateOf<String?>(null)
    private var revision by mutableLongStateOf(0L)
    private var shownOnce = false
    private fun page(where: String?) {
        record = where; revision++
        if (!shownOnce) {
            shownOnce = true
            val session = fixture.session()
            runBlocking { fixture.signIn(session) }
            val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
            compose.setContent { OrbitTheme(darkTheme = false) { Surface(color = MaterialTheme.colorScheme.background) {
                RunnerScreen(api, fixture.RUNNER, record, revision, {}, {}, {})
            } } }
        }
        compose.waitForIdle()
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun gone(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isEmpty() }
    private fun tagged(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().size
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(60_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun scrollTo(tag: String) { try { compose.onNodeWithTag(tag).performScrollTo() } catch (_: AssertionError) { }; compose.waitForIdle() }
    private fun dismissCalls() = fixture.writes("runners/${fixture.RUNNER}/engines/codex/update-warning/dismiss")

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/engine-update-dismiss-android").also { it.mkdirs() }
    }
    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    /** Codex 13 days behind [latest], its last update failed half an hour ago. */
    private fun codexBehind(latest: String): String {
        val now = Instant.now()
        return """[{"engine":"claude","installed":true,"version":"2.1.290 (Claude Code)","auth":"yes"},
            {"engine":"codex","installed":true,"version":"codex-cli 0.159.2","auth":"yes","update":{"status":"failed",
              "at":"${now.minusSeconds(1_800)}","okAt":"${now.minusSeconds(20 * 86_400L)}","latest":"$latest",
              "behindSince":"${now.minusSeconds(13 * 86_400L + 3_600)}","message":"npm isn't on this runner's PATH."}}]"""
    }
    private fun dismissed(latest: String) = ""","engineUpdateDismissals":{"codex":"$latest"}"""

    @Test fun theCardsDismissPostsTheRouteAndHidesTheCardAndTheRowsWarning() {
        fixture.runnerEngines = codexBehind("0.169.0")
        fixture.onEngineDismiss = { fixture.runnerExtra = dismissed("0.169.0") }
        page(null)
        await("Dismiss until next Codex release")
        await(RunnerCopy.UPDATE_ENGINES_NOW)
        shot("android-needs-attention-dismiss")
        assertEquals(1, tagged("engine-row:codex:dismiss"))
        scrollTo("engine-row:codex:dismiss")
        shot("android-engine-row-dismiss")
        assertTrue("nothing sent before the press", dismissCalls().isEmpty())

        click(hasTestTag("attention-dismiss:codex"))
        gone("Dismiss until next Codex release")
        assertEquals(listOf("POST runners/${fixture.RUNNER}/engines/codex/update-warning/dismiss"), dismissCalls())
        gone("Update to 0.169.0 failed")
        assertEquals("the row's Dismiss is gone too", 0, tagged("engine-row:codex:dismiss"))
        assertEquals(0, compose.onAllNodesWithText(RunnerCopy.NEEDS_ATTENTION).fetchSemanticsNodes().size)
        compose.onRoot().performTouchInput { swipeDown() }
        shot("android-after-dismiss-machine")

        page("engine:codex")
        await("13d behind 0.169.0 · warning dismissed")
        assertEquals(0, tagged("engine-page:dismiss"))
        shot("android-after-dismiss-engine-page")
    }

    @Test fun theRowsDismissPostsTheSameRoute() {
        fixture.runnerEngines = codexBehind("0.169.0")
        fixture.onEngineDismiss = { fixture.runnerExtra = dismissed("0.169.0") }
        page(null)
        click(hasTestTag("engine-row:codex:dismiss"))
        gone("Dismiss until next Codex release")
        assertEquals(listOf("POST runners/${fixture.RUNNER}/engines/codex/update-warning/dismiss"), dismissCalls())
    }

    @Test fun theEnginePageOffersDismissBesideItsWarning() {
        fixture.runnerEngines = codexBehind("0.169.0")
        fixture.onEngineDismiss = { fixture.runnerExtra = dismissed("0.169.0") }
        page("engine:codex")
        await("13d behind 0.169.0")
        shot("android-engine-page-dismiss")
        click(hasTestTag("engine-page:dismiss"))
        await("13d behind 0.169.0 · warning dismissed")
        assertEquals(listOf("POST runners/${fixture.RUNNER}/engines/codex/update-warning/dismiss"), dismissCalls())
        assertEquals(0, tagged("engine-page:dismiss"))
    }

    @Test fun aNewerReleaseThanTheDismissedOneBringsTheCardBack() {
        fixture.runnerEngines = codexBehind("0.170.0")
        fixture.runnerExtra = dismissed("0.169.0")
        page(null)
        await("Codex update failed")
        await("Dismiss until next Codex release")
        assertEquals(1, tagged("engine-row:codex:dismiss"))
    }
}
