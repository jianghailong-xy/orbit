package io.orbitd.android

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * EVIDENCE KIT, not part of the app's tests (task 34jQkOSz5CENWMRYAWVHC, landing page small fixes): NATIVE frames of the landing
 * page's result line for a merge check that ended READY, light and dark, against docs/mocks/landing-session/v4/05 and 07. The
 * production MainActivity over ProjectShell's fixture transport, opened by an `orbit-session:` link, as the follow-up kit
 * (docs/evidence/landing-session-followup/android-kit) does.
 *
 * It compiles into the app's unit tests through `kit.gradle` (an init script that adds this directory to the test source set) and
 * writes `src/android/build/evidence/landing-page-fixes/<theme>/`, beside each frame's semantics tree.
 */
abstract class LandingPageFixesShots {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    protected abstract val theme: String

    @Before fun start() = ProjectShell.reset()

    private val launch = ProjectShell.LAUNCH
    private val landing = ProjectShell.LANDING
    private fun ago(minutes: Double): String = Instant.now().minusMillis((minutes * 60_000).toLong()).toString()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/landing-page-fixes/$theme").also { it.mkdirs() }
    }

    private val passed = """{"exitCode":0,"expectedExitCode":0,"timedOut":false}"""

    /** One merge check's section as the server writes it when the check passes and ends READY (resultText's `Ready to merge into
     *  main`, data.state READY), then the owner's question. */
    private fun checkSection(job: String, n: Int, start: Double) = """{"title":"Merge check · $n","jobId":"$job","kind":"CHECK_PROMOTION",
        "generation":$n,"state":"READY","entries":[
        {"kind":"ENQUEUED","at":"${ago(start)}","claim":0,"text":"Merge check queued · project/launch → main"},
        {"kind":"CLAIMED","at":"${ago(start - 0.5)}","claim":1,"text":"Claimed by runner wikova · claim 1"},
        {"kind":"ROUND","at":"${ago(start - 0.5)}","claim":1,"round":1,"data":{"round":1},"text":"Round 1"},
        {"kind":"STEP","at":"${ago(start - 1)}","claim":1,"phase":"FETCH","text":"Fetched · synced main"},
        {"kind":"CHECK_STARTED","at":"${ago(start - 1.2)}","claim":1,"round":1,"check":{"name":"MERGE_CHECK","index":1},
         "text":"Merge check started · claim 1 · wikova"},
        {"kind":"CHECK_FINISHED","at":"${ago(start - 18)}","claim":1,"round":1,"check":{"name":"MERGE_CHECK","index":1},
         "data":$passed,"text":"Merge check passed · 17m 02s"},
        {"kind":"RESULT","at":"${ago(start - 18)}","claim":1,"phase":"CHECK","data":{"state":"READY","requestedState":"READY"},
         "text":"Ready to merge into main"},
        {"kind":"HANDED_TO","at":"${ago(start - 18)}","claim":1,"data":{"assignee":"OWNER","itemKind":"PROMOTION_APPROVAL"},
         "text":"Asked the owner to merge into main"}]}"""

    private fun round(sections: String, job: String) {
        val attempt = """{"jobId":"$job","kind":"CHECK_PROMOTION","state":"READY","generation":1,"phase":"CHECK","round":1,"step":null,
            "claim":1,"runnerName":"wikova","sourceSessionId":"$landing","targetRef":"refs/heads/project/launch","startedAt":"${ago(22.0)}",
            "heartbeatAt":"${ago(4.0)}","outputMovedAt":"${ago(4.0)}","progressProtocol":"v2","check":null,"liveness":null,
            "blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":false}"""
        ProjectShell.landing = """{"sessionId":"$landing","projectId":"$launch","subject":"PROMOTION","taskId":null,"promotionId":"p-1",
            "episode":9,"openedAt":"${ago(60.0)}","settledAt":null,"settledAs":null,"phase":"CHECK","round":1,
            "checks":[{"name":"MERGE_CHECK","exitCode":0,"expectedExitCode":0,"timedOut":false,"durationMs":1022000}],
            "currentAttempt":$attempt,"todos":[],"generations":[],"timeline":{"sections":[$sections],"facts":[]}}"""
        ProjectShell.landingTitle = "Merge project/launch → main · #9"
        signIn()
        open("orbit-session:$landing")
        await { exists(hasTestTag("landing-page")) }
    }

    /** 05: the round's merge check passed and ended READY; its result line draws ✓ (it drew ✗ before this task). */
    @Test fun aMergeCheckThatEndedReadyDrawsACheckmark() {
        round(checkSection("j-1", 1, 22.0), "j-1")
        await { exists(hasText("Ready to merge into main", substring = true), unmerged = true) }
        compose.onNodeWithTag("landing:entry:6", useUnmergedTree = true).assertTextEquals("Ready to merge into main")
        compose.onNodeWithTag("landing:mark:6", useUnmergedTree = true).assertTextEquals("✓")
        compose.onNodeWithTag("landing:mark:5", useUnmergedTree = true).assertTextEquals("✓")
        shot("01-ready-result")
    }

    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launchIntent = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launchIntent
        }
        compose.waitForIdle()
    }

    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot().printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
    private fun app() = compose.activity.application as OrbitApplication
}

/** Light frames. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1100dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingPageFixesShotsTest : LandingPageFixesShots() {
    override val theme = "light"
}

/** Dark frames: `isSystemInDarkTheme()` reads the night qualifier, as on a device. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1100dp-night")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingPageFixesDarkShotsTest : LandingPageFixesShots() {
    override val theme = "dark"
}
