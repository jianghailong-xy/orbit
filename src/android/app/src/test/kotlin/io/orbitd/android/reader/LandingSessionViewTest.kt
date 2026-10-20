package io.orbitd.android.reader

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
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
 * The landing session page as drawn, in the frames the board's v4 07/05 name (A-1; contract §2.9 LS1/LS6, §7.2 V6):
 * checking, a timed-out LAND_TASK, a timed-out Merge to main, after a takeover, settled, a merge round checking, the
 * task segment's ⋮ menu and the merge round's ⋮ menu. Each frame is written beside its semantics tree, light and
 * dark, under `src/android/build/evidence/landing-session-android/<theme>/`, which is not committed. With
 * `ORBIT_WRITE_EVIDENCE=1` in the environment they go to the committed `docs/evidence/landing-session-android/<theme>/`
 * instead, so a plain test run never rewrites the pictures a reader checks against 07/05.
 */
abstract class LandingSessionFrames {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    /** The theme this frame set is drawn in: the class's own qualifier decides it. */
    protected abstract val theme: String

    private val launch = ProjectShell.LAUNCH
    private val landing = ProjectShell.LANDING
    private fun ago(seconds: Long) = Instant.now().minusSeconds(seconds).toString()

    @Before fun start() = ProjectShell.reset()
    @After fun stop() { compose.waitForIdle() }

    private fun view(kind: String = "LAND_TASK", subject: String = "TASK", taskId: String? = "t-landing", promotionId: String? = null,
        state: String = "RUNNING", liveness: String? = "LIVE", timedOut: Boolean = false, retryable: Boolean = false, claim: Int = 1,
        round: Int? = 1, phase: String? = "CHECK", runner: String = "wikova", step: Long = 110, heartbeat: Long = 0,
        settledAt: String? = null, settledAs: String? = null, timeline: String? = null, checks: String = "[]",
        check: Boolean = state == "RUNNING"): String {
        val attempt = """{"jobId":"j-1","kind":"$kind","state":"$state","generation":1,"phase":${phase?.let { "\"$it\"" } ?: "null"},
            "round":${round ?: "null"},"step":null,"claim":$claim,"runnerName":"$runner","sourceSessionId":"$landing",
            "targetRef":"refs/heads/project/launch","startedAt":"${ago(step)}","heartbeatAt":${if (heartbeat == 0L) "\"${ago(0)}\"" else "\"${ago(heartbeat)}\""},
            "outputMovedAt":"${ago(6)}","progressProtocol":"v2",
            "check":${if (check) """{"name":"${if (kind == "CHECK_PROMOTION") "MERGE_CHECK" else "TASK_ACCEPTANCE"}","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(step)}"}""" else "null"},
            "liveness":${liveness?.let { "\"$it\"" } ?: "null"},"blockingReason":null,"timedOut":$timedOut,"limitSeconds":600,
            "retryable":$retryable,"pushBoundaryPassed":false}"""
        return """{"sessionId":"$landing","projectId":"$launch","subject":"$subject","taskId":${taskId?.let { "\"$it\"" } ?: "null"},
            "promotionId":${promotionId?.let { "\"$it\"" } ?: "null"},"episode":4,"openedAt":"${ago(3600)}",
            "settledAt":${settledAt?.let { "\"$it\"" } ?: "null"},"settledAs":${settledAs?.let { "\"$it\"" } ?: "null"},"checks":$checks,
            "phase":${phase?.let { "\"$it\"" } ?: "null"},"round":${round ?: "null"},"currentAttempt":$attempt,"todos":[],"generations":[]
            ${timeline?.let { ""","timeline":$it""" }.orEmpty()}}"""
    }

    /** One fact of the server's timeline: the kind the ledger stores, when, the sentence the server writes for it
     *  (`project-integration-event.ts`), and the phase a push line is recognised by. */
    private data class Fact(val kind: String, val at: String, val text: String, val phase: String? = null)

    /** One section of the server's own timeline: its title and the facts it recorded, each with the server's sentence,
     *  never the kind's name. */
    private fun timeline(entries: Array<Fact>, title: String = "Generation 1", kind: String = "LAND_TASK", state: String = "RUNNING"): String =
        """{"sections":[{"title":"$title","jobId":"j-1","kind":"$kind","generation":1,"state":"$state","entries":[${
            entries.joinToString(",") { e -> """{"kind":"${e.kind}","at":"${e.at}","claim":1,"round":1,"phase":${e.phase?.let { "\"$it\"" } ?: "null"},"check":null,"text":"${e.text}"}""" }
        }]}],"facts":[]}"""

    private var signedIn = false

    /** The link again: a fresh page reads the fixture as it stands now. Whatever is up — a landing page, an open ⋮
     *  popup, or both — is left first; a back press the popup swallows is fine, the loop checks what remains. */
    private fun openLanding(landingJson: String) {
        ProjectShell.landing = landingJson
        if (!signedIn) { signIn(); signedIn = true }
        leavePage()
        open("orbit-session:$landing")
        await { exists(hasTestTag("landing-page")) }
        compose.waitForIdle()
    }

    private fun backOnce() {
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.waitForIdle()
    }

    private fun leavePage() {
        repeat(4) {
            if (menuItems().isEmpty() && !exists(hasTestTag("landing-page"))) return
            backOnce()
            compose.waitForIdle()
        }
    }

    @Test fun theFramesAreDrawn() {
        // ① Checking (05 a, 07): the head every landing surface wears, the budget and its meter, the V6 live line, and the
        // server's own timeline sentences with the running check's tail.
        openLanding(view(timeline = timeline(arrayOf(
            Fact("ENQUEUED", ago(240), "Task marked done · queued to land on project/launch"),
            Fact("CLAIMED", ago(180), "Claimed by runner wikova · claim 1"),
            Fact("CHECK_STARTED", ago(110), "Task acceptance started · claim 1 · wikova")))))
        await { text("landing-head:right")?.matches(Regex("1m 5\\ds of 60m")) == true }
        assertTrue(text("landing-head:detail")!!.matches(Regex("checking · output \\d+s ago · claim 1 · round 1 of 3 · updated just now")))
        assertTrue(text("landing:budget")!!.matches(Regex("Task acceptance 1m 5\\ds of 60m")))
        assertTrue(text("landing:live")!!.matches(Regex("Output \\d+s ago · Updated just now")))
        assertEquals("Generation 1", text("landing:section-title:j-1"))
        assertTrue(exists(hasText("Claimed by runner wikova · claim 1")))
        assertTrue(exists(hasTestTag("landing:live-check")))
        shot("01-checking")

        // ② A timed-out LAND_TASK (05 i, 07): the whole card amber, the runner's last word, J12's sentence, Retry and Abandon.
        openLanding(view(timedOut = true, liveness = "LEASE_EXPIRED", retryable = true, step = 1380, heartbeat = 1380,
            timeline = timeline(arrayOf(
                Fact("ENQUEUED", ago(1600), "Task marked done · queued to land on project/launch"),
                Fact("CLAIMED", ago(1500), "Claimed by runner wikova · claim 1"),
                Fact("STEP", ago(1440), "Rebasing onto project/launch", phase = "REBASE")))))
        await { exists(hasTestTag("landing-head:timed-out"), unmerged = true) }
        assertEquals("No report for 23m · limit 10m", text("landing-head:detail"))
        assertEquals("Nothing was pushed — the runner reports before it pushes, and it never did.", text("landing:push-sentence"))
        assertTrue(exists(hasTestTag("landing:retry")) && exists(hasTestTag("landing:abandon")))
        assertFalse(exists(hasTestTag("landing:rerun")))
        assertTrue(exists(hasText("Rebasing onto project/launch")))
        shot("02-timed-out-land-task")

        // ③ A timed-out Merge to main (05 f): no Retry, Abandon and the card's own sentence, and the review the round is
        // decided on; the timeline says where the push stopped.
        ProjectShell.promotion = """{"promotionId":"pr-1","state":"CONFIRMED","sourceRef":"refs/heads/project/launch","upstreamRef":"refs/heads/main",
            "landsAs":"MERGE_COMMIT","taskIds":["t1","t2"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}]}"""
        openLanding(view(subject = "PROMOTION", taskId = null, promotionId = "pr-1", kind = "LAND_PROMOTION", timedOut = true,
            liveness = "LEASE_EXPIRED", phase = "PUSH", step = 1380, heartbeat = 1380,
            timeline = timeline(arrayOf(Fact("STEP", "2026-10-20T15:42:00Z", "Reported starting the push to project/launch", phase = "PUSH")),
                title = "Merge to main · 1", kind = "LAND_PROMOTION")))
        await { text("landing-head:title") == "Merge to main" }
        assertEquals("Timed out", text("landing-head:right"))
        assertTrue(text("landing:push-sentence")!!.startsWith("May have been pushed"))
        assertFalse(exists(hasTestTag("landing:retry")))
        assertEquals("No Retry: a confirmed merge ends by Abandon, or finishes when a new process on the runner takes it over.",
            text("landing:door-hint"))
        shot("03-timed-out-merge-to-main")

        // ④ After a takeover (05 j): claim 2 of the same section, the first start kept, the new claim's own clock.
        openLanding(view(claim = 2, step = 290, timeline = timeline(arrayOf(
            Fact("CLAIMED", "2026-10-20T17:03:00Z", "Claimed by runner wikova · claim 1"),
            Fact("TAKEN_OVER", "2026-10-20T17:31:00Z", "Taken over by a new process on runner wikova · claim 2")))))
        await { text("landing-head:detail")?.contains("claim 2") == true }
        assertTrue(text("landing-head:detail")!!.contains("Taken over "))
        val firstStarted = io.orbitd.android.projects.ProjectPage.landingClockTime(Instant.parse("2026-10-20T17:03:00Z"))
        assertTrue(text("landing-head:detail")!!.contains("first started $firstStarted"))
        assertTrue(exists(hasText("Taken over by a new process on runner wikova · claim 2")))
        shot("04-taken-over")

        // ⑤ Settled (05 c): the round's outcome with the green ✓, the tasks now on main, the check that passed and the tree
        // it landed.
        ProjectShell.merged = """[{"promotionId":"pr-1","sourceRef":"refs/heads/project/launch","upstreamRef":"refs/heads/main","landsTreeSha":"5e5bfca1234",
            "landsAs":"MERGE_COMMIT","taskIds":["t1","t2"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}],
            "merged":{"sha":"8ed0ea712345","at":"${ago(600)}","automatic":true},
            "checks":[{"name":"MERGE_CHECK","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":1061000}]}]"""
        openLanding(view(subject = "PROMOTION", taskId = null, promotionId = "pr-1", kind = "LAND_PROMOTION", state = "MERGED",
            settledAt = ago(600), settledAs = "MERGED",
            checks = """[{"name":"MERGE_CHECK","expectedExitCode":0,"exitCode":0,"timedOut":false,"durationMs":1061000}]"""))
        await { text("landing-head:title") == "Merged into main" }
        assertEquals("8ed0ea7 · 2 tasks · automatically", text("landing-head:detail"))
        assertTrue(exists(hasTestTag("landing-head:done"), unmerged = true))
        assertTrue(exists(hasText("Now on main · 2 tasks"), unmerged = true))
        assertTrue(exists(hasText("Landed exactly the tested tree 5e5bfca · as a merge commit"), unmerged = true))
        assertEquals("This landing is complete — nothing to type here.", text("landing:footer-line"))
        shot("05-settled")

        // ⑥ A confirmed merge round, ⋮ open (05 d): Merge to main, the ways to look — Review card, Open coordinator — then
        // Cancel merge with its consequence, and no Open task / Open source session / Copy Link.
        ProjectShell.coordinatorStatus = """{"state":"LIVE","coordination":{"session":{"id":"${ProjectShell.COORD}"}}}"""
        ProjectShell.promotion = """{"promotionId":"pr-1","state":"CONFIRMED","sourceRef":"refs/heads/project/launch",
            "upstreamRef":"refs/heads/main","landsAs":"MERGE_COMMIT","taskIds":["t1","t2"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}]}"""
        openLanding(view(subject = "PROMOTION", taskId = null, promotionId = "pr-1", kind = "LAND_PROMOTION", phase = "PUSH",
            step = 290, check = false,
            timeline = timeline(arrayOf(Fact("STEP", ago(290), "Reported starting the push to project/launch", phase = "PUSH")),
                title = "Merge to main · 1", kind = "LAND_PROMOTION")))
        await { text("landing-head:title") == "Merge to main" }
        await { exists(hasTestTag("landing-more")) }
        compose.onNodeWithTag("landing-more").performClick()
        await { menuItems().isNotEmpty() }
        assertEquals(listOf("Open coordinator", "Review card", "Cancel merge"), menuItems())
        assertTrue(exists(hasText(LandingSessionCopy.CANCEL_BEFORE_PUSH), unmerged = true))
        shot("06-merge-menu", popup = true)

        // ⑦ The task segment's ⋮ menu (07 11:05): Open task / Open source session / Open coordinator, then Stop landing.
        openLanding(view(timeline = timeline(arrayOf(
            Fact("ENQUEUED", ago(240), "Task marked done · queued to land on project/launch"),
            Fact("CLAIMED", ago(180), "Claimed by runner wikova · claim 1")))))
        await { exists(hasTestTag("landing-more")) }
        compose.onNodeWithTag("landing-more").performClick()
        await { menuItems().isNotEmpty() }
        assertEquals(listOf("Open task", "Open source session", "Open coordinator", "Stop landing"), menuItems())
        assertTrue(exists(hasText("Before the push only · nothing pushed yet"), unmerged = true))
        shot("07-task-menu", popup = true)

        // ⑧ A merge round checking alone (05 a): Merge check's budget and usually, the live line, the on-pass sentence and
        // the footer's `A clean pass merges on its own` — no menu over it.
        ProjectShell.promotion = """{"promotionId":"pr-1","state":"CHECKING","onPass":"MERGE","sourceRef":"refs/heads/project/launch",
            "upstreamRef":"refs/heads/main","landsAs":"MERGE_COMMIT","taskIds":["t1","t2"],"tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}]}"""
        openLanding(view(subject = "PROMOTION", taskId = null, promotionId = "pr-1", kind = "CHECK_PROMOTION", phase = "CHECK",
            step = 160, timeline = timeline(arrayOf(Fact("CHECK_STARTED", ago(160), "Merge check started · claim 1 · wikova")),
                title = "Merge check · 1", kind = "CHECK_PROMOTION")))
        await { text("landing-head:title") == "Merge check" }
        assertEquals("Merges on its own when it passes.", text("landing:on-pass"))
        assertTrue(exists(hasText("A clean pass merges on its own")))
        assertTrue(text("landing:budget")!!.matches(Regex("Merge check 2m 4\\ds of 60m")))
        assertTrue(text("landing:live")!!.matches(Regex("Output \\d+s ago · Updated just now")))
        assertTrue(exists(hasText("Merge check started · claim 1 · wikova")))
        shot("08-merge-checking")
    }

    /** The page's ⋮ rows, in the order the board draws them. */
    private fun menuItems() = compose.onAllNodes(hasAnyAncestor(isPopup()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }

    private fun text(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        val base = if (System.getenv("ORBIT_WRITE_EVIDENCE") == "1") "docs/evidence" else "src/android/build/evidence"
        File(root, "$base/landing-session-android/$theme").also { it.mkdirs() }
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

/** The frames in the app's light theme. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w412dp-h915dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingSessionViewTest : LandingSessionFrames() {
    override val theme = "light"
}

/** The same frames in the app's dark theme (the night qualifier is what `isSystemInDarkTheme` reads). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w412dp-h915dp-night-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingSessionViewDarkTest : LandingSessionFrames() {
    override val theme = "dark"
}
