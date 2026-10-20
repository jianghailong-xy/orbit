package io.orbitd.android.reader

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.view.View
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.ProjectShell
import io.orbitd.android.ProjectShellApplication
import io.orbitd.android.core.auth.AuthState
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The landing session page as drawn, in the six states the board's v4 07 frame and 05's frames name (A-1; contract §2.9
 * LS1/LS6, §7.2 V6): checking, a timed-out LAND_TASK, a timed-out Merge to main, after a takeover, settled, and the ⋮ menu
 * open. Every state is written to a PNG under `src/android/build/evidence/a1-landing-session/` beside its semantics tree.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingSessionViewTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    private val launch = ProjectShell.LAUNCH
    private val landing = ProjectShell.LANDING
    private fun ago(seconds: Long) = Instant.now().minusSeconds(seconds).toString()

    @Before fun start() = ProjectShell.reset()
    @After fun stop() { compose.waitForIdle() }

    private fun view(kind: String = "LAND_TASK", subject: String = "TASK", taskId: String? = "t-landing", promotionId: String? = null,
        state: String = "RUNNING", liveness: String? = "LIVE", timedOut: Boolean = false, retryable: Boolean = false, claim: Int = 1,
        round: Int? = 1, phase: String? = "CHECK", runner: String = "wikova", step: Long = 110, heartbeat: Long = 0,
        settledAt: String? = null, settledAs: String? = null, timeline: String? = null, checks: String = "[]"): String {
        val attempt = """{"jobId":"j-1","kind":"$kind","state":"$state","generation":1,"phase":${phase?.let { "\"$it\"" } ?: "null"},
            "round":${round ?: "null"},"step":null,"claim":$claim,"runnerName":"$runner","sourceSessionId":"$landing",
            "targetRef":"refs/heads/project/launch","startedAt":"${ago(step)}","heartbeatAt":${if (heartbeat == 0L) "\"${ago(0)}\"" else "\"${ago(heartbeat)}\""},
            "outputMovedAt":"${ago(6)}","progressProtocol":"v2",
            "check":${if (state == "RUNNING") """{"name":"${if (kind == "CHECK_PROMOTION") "MERGE_CHECK" else "TASK_ACCEPTANCE"}","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(step)}"}""" else "null"},
            "liveness":${liveness?.let { "\"$it\"" } ?: "null"},"blockingReason":null,"timedOut":$timedOut,"limitSeconds":600,
            "retryable":$retryable,"pushBoundaryPassed":false}"""
        return """{"sessionId":"$landing","projectId":"$launch","subject":"$subject","taskId":${taskId?.let { "\"$it\"" } ?: "null"},
            "promotionId":${promotionId?.let { "\"$it\"" } ?: "null"},"episode":4,"openedAt":"${ago(3600)}",
            "settledAt":${settledAt?.let { "\"$it\"" } ?: "null"},"settledAs":${settledAs?.let { "\"$it\"" } ?: "null"},"checks":$checks,
            "phase":${phase?.let { "\"$it\"" } ?: "null"},"round":${round ?: "null"},"currentAttempt":$attempt,"todos":[],"generations":[]
            ${timeline?.let { ""","timeline":$it""" }.orEmpty()}}"""
    }

    private fun timeline(vararg entries: Pair<String, String>) = """{"sections":[{"title":"Generation 1","jobId":"j-1","kind":"LAND_TASK",
        "generation":1,"state":"RUNNING","entries":[${entries.joinToString(",") { """{"kind":"${it.first}","at":"${it.second}",
        "claim":1,"round":1,"check":null,${if (it.first == "TAKEN_OVER") "\"claim\":2," else ""}"text":"${it.first}"}""" }}]}],"facts":[]}"""

    private fun openLanding(landingJson: String) {
        if (ProjectShell.landing == null) {
            ProjectShell.landing = landingJson
            signIn()
            open("orbit-session:$landing")
        } else {
            // Back to the page beneath, then the same link again: a fresh page reads the fixture as it stands now.
            await { exists(hasContentDescription("Back")) }
            compose.onNodeWithContentDescription("Back").performClick()
            compose.waitForIdle()
            ProjectShell.landing = landingJson
            open("orbit-session:$landing")
        }
        try { await { exists(hasTestTag("landing-page")) } } catch (failure: Throwable) {
            File(output, "timeout-tree.txt").writeText(runCatching { compose.onRoot().printToString() }.getOrDefault(""))
            File(output, "timeout-calls.txt").writeText("landingSet=${ProjectShell.landing != null} served=${ProjectShell.landingServed}\n" +
                ProjectShell.calls.joinToString("\n"))
            throw failure
        }
        compose.waitForIdle()
    }

    @Test fun theSixStatesAreDrawn() {
        val generation1 = timeline("ENQUEUED" to ago(240), "CLAIMED" to ago(180), "CHECK_STARTED" to ago(110))

        // ① Checking: the shape of the head every landing surface wears, the budget and its meter, the live line, V6's facts.
        openLanding(view(timeline = generation1))
        await { text("landing-head:right") == "1m 50s of 60m" }
        assertEquals("checking · output 6s ago · claim 1 · round 1 of 3 · updated just now", text("landing-head:detail"))
        assertEquals("Task acceptance 1m 50s of 60m", text("landing:budget"))
        assertEquals("Output 6s ago · Updated just now", text("landing:live"))
        assertEquals("Generation 1", text("landing:section-title:j-1"))
        assertTrue(exists(hasTestTag("landing:live-check")))
        shot("1-checking")

        // ② A timed-out LAND_TASK: the whole card amber, the runner's last word, J12's sentence, Retry and Abandon.
        openLanding(view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true, step = 1380, heartbeat = 1380,
            timeline = timeline("ENQUEUED" to ago(1600), "CLAIMED" to ago(1500), "STEP" to ago(1440))))
        await { exists(hasTestTag("landing-head:timed-out"), unmerged = true) }
        assertEquals("No report for 23m · limit 10m", text("landing-head:detail"))
        assertEquals("Nothing was pushed — the runner reports before it pushes, and it never did.", text("landing:push-sentence"))
        assertTrue(exists(hasTestTag("landing:retry")) && exists(hasTestTag("landing:abandon")))
        assertFalse(exists(hasTestTag("landing:rerun")))
        shot("2-timed-out-land-task")

        // ③ A timed-out Merge to main: no Retry, Abandon and the card's own sentence, and the review the round is decided on.
        ProjectShell.promotion = """{"promotionId":"pr-1","state":"CONFIRMED","sourceRef":"refs/heads/project/launch","upstreamRef":"refs/heads/main",
            "landsAs":"MERGE_COMMIT","taskIds":["t1","t2"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}]}"""
        val pushLine = """{"sections":[{"title":"Merge to main · 1","jobId":"j-1","kind":"LAND_PROMOTION","generation":1,"state":"RUNNING",
            "entries":[{"kind":"STEP","at":"2026-10-20T15:42:00Z","claim":1,"phase":"PUSH","text":"Reported starting the push to main"}]}],"facts":[]}"""
        openLanding(view(subject = "PROMOTION", taskId = null, promotionId = "pr-1", kind = "LAND_PROMOTION", timedOut = true,
            liveness = "LEASE_EXPIRED", phase = "PUSH", step = 1380, heartbeat = 1380, timeline = pushLine))
        await { text("landing-head:title") == "Merge to main" }
        assertEquals("Timed out", text("landing-head:right"))
        assertTrue(text("landing:push-sentence")!!.startsWith("May have been pushed"))
        assertFalse(exists(hasTestTag("landing:retry")))
        assertEquals("No Retry: a confirmed merge ends by Abandon, or finishes when a new process on the runner takes it over.",
            text("landing:door-hint"))
        shot("3-timed-out-merge-to-main")

        // ④ After a takeover: claim 2 of the same section, first started kept, the new claim's own clock.
        openLanding(view(claim = 2, step = 290, timeline = timeline("CLAIMED" to "2026-10-20T17:03:00Z", "TAKEN_OVER" to "2026-10-20T17:31:00Z")))
        await { text("landing-head:detail")?.contains("claim 2") == true }
        assertTrue(text("landing-head:detail")!!.contains("Taken over "))
        val firstStarted = io.orbitd.android.projects.ProjectPage.landingClockTime(Instant.parse("2026-10-20T17:03:00Z"))
        assertTrue(text("landing-head:detail")!!.contains("first started $firstStarted"))
        shot("4-taken-over")

        // ⑤ Settled: the round's outcome, the tasks now on main, the check that passed and the tree it landed.
        ProjectShell.merged = """[{"promotionId":"pr-1","sourceRef":"refs/heads/project/launch","upstreamRef":"refs/heads/main","landsTreeSha":"5e5bfca1234",
            "landsAs":"MERGE_COMMIT","taskIds":["t1","t2"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}],
            "merged":{"sha":"8ed0ea712345","at":"${ago(600)}","automatic":true},
            "checks":[{"name":"MERGE_CHECK","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":1061000}]}]"""
        openLanding(view(subject = "PROMOTION", taskId = null, promotionId = "pr-1", kind = "LAND_PROMOTION", state = "MERGED",
            settledAt = ago(600), settledAs = "MERGED",
            checks = """[{"name":"MERGE_CHECK","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":1061000}]"""))
        await { text("landing-head:title") == "Merged into main" }
        assertEquals("Merged into main", text("landing-head:title"))
        assertEquals("8ed0ea7 · 2 tasks · automatically", text("landing-head:detail"))
        assertTrue(exists(hasText("Now on main · 2 tasks"), unmerged = true))
        assertTrue(exists(hasText("Landed exactly the tested tree 5e5bfca · as a merge commit"), unmerged = true))
        assertEquals("This landing is complete — nothing to type here.", text("landing:footer-line"))
        shot("5-settled")

        // ⑥ The ⋯ menu open: the ways to look at the merge round, then its Cancel merge, and no session menu's rows.
        ProjectShell.coordinatorStatus = """{"state":"LIVE","coordination":{"session":{"id":"${ProjectShell.COORD}"}}}"""
        ProjectShell.promotion = """{"promotionId":"pr-1","state":"CONFIRMED","sourceRef":"refs/heads/project/launch","upstreamRef":"refs/heads/main",
            "landsAs":"MERGE_COMMIT","taskIds":["t1","t2"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}]}"""
        openLanding(view(subject = "PROMOTION", taskId = null, promotionId = "pr-1", kind = "LAND_PROMOTION", phase = "PUSH", step = 290))
        await { exists(hasTestTag("landing-more")) }
        compose.onNodeWithTag("landing-more").performClick()
        await { compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(listOf("Open coordinator", "Review card", "Cancel merge"), menuItems())
        shot("6-menu-open", popup = true)
    }

    /** One of the page's two intents: the menu's rows, in the order the board draws them. */
    private fun menuItems() = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }

    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/a1-landing-session").also { it.mkdirs() }
    }

    /** The window as drawn, written beside its semantics tree; a menu's popup is drawn where DropdownMenu put it. */
    private fun shot(name: String, popup: Boolean = false) {
        compose.waitForIdle()
        // A menu draws in a window of its own: every root is written, so the popup's tree is beside the page's.
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText((0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        if (popup) drawPopup(bitmap)?.let { File(output, "$name-popup.png").outputStream().use { out -> it.compress(Bitmap.CompressFormat.PNG, 100, out) } }
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    /** Compose draws a DropdownMenu in its own window; the activity's bitmap does not hold it. Draw the popup's own view
     *  where the menu anchors (its end under the ⋮), and keep the popup on its own too. */
    private fun drawPopup(window: Bitmap): Bitmap? {
        val shadow = Shadows.shadowOf(compose.activity.windowManager) as org.robolectric.shadows.ShadowWindowManagerImpl
        val popup = shadow.views.lastOrNull { it !== compose.activity.window.decorView } ?: return null
        if (popup.width <= 0 || popup.height <= 0) return null
        val anchor = compose.onNodeWithTag("landing-more").fetchSemanticsNode().boundsInWindow
        val own = Bitmap.createBitmap(popup.width, popup.height, Bitmap.Config.ARGB_8888)
        popup.draw(Canvas(own))
        val canvas = Canvas(window)
        canvas.save()
        canvas.translate((anchor.right - popup.width).coerceAtLeast(0f), anchor.bottom)
        popup.draw(canvas)
        canvas.restore()
        return own
    }

    private fun app() = compose.activity.application as io.orbitd.android.OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
}
