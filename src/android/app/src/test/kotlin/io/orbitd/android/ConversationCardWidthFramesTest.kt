package io.orbitd.android

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
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
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The real conversation (SessionReader over the coordinator's session, through the production shell) with a prose reply that runs the
 * whole column and the cards that used to: an open item on the rail, an answered question's record, the exception item's delivery card
 * and a tool failure. Widths are measured from the semantics tree and written, with the frame, under `$ORBIT_CARD_WIDTH_SHOTS`
 * (default build/evidence/conversation-card-width) as `<label>-widths.txt` / `<label>.png`, `<label>` from `-Dorbit.shot.label` (default "after").
 * The wide frame is 1100dp; the phone frame is 411dp.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w1100dp-h1400dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ConversationCardWidthFramesTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 0) val midday = MiddayZone()
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()

    private val coord = ProjectShell.COORD
    private val label = System.getProperty("orbit.shot.label") ?: System.getenv("ORBIT_SHOT_LABEL") ?: "after"
    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(System.getenv("ORBIT_CARD_WIDTH_SHOTS") ?: File(root, "src/android/build/evidence/conversation-card-width").path).also { it.mkdirs() }
    }
    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private val prose = "I went through every open item and every closed question in this project before writing back. " +
        "Nothing here needs you to read anything twice: the exception below is the only thing waiting on you, the question above it is " +
        "answered and recorded, and the failure in between is the editor tool refusing a stale patch, which I already retried. " +
        "This paragraph is deliberately long so that on a wide column it runs the whole line, which is what prose does and cards must not."

    private fun item() = """{"itemId":"item-xe5","kind":"LANDING_LEASE_EXPIRED","title":"A landing stopped reporting","detailLine":"The runner stopped reporting",
        "assignee":"OWNER","assigneeReason":"ESCALATED","waitingSince":"${ago(120)}","escalatedAt":"${ago(120)}","landingSessionId":null,"integrationJobId":null,
        "actions":["ABANDON"],"primaryAction":"ABANDON","requiredAction":"The runner stopped reporting; abandon this landing, or wait for the runner to come back."}"""

    private fun closed() = """{"itemId":"item-q1","question":{"question":"Reopen the rollout now or at the next round?","options":[{"label":"Reopen now"},{"label":"At the next round"}]},
        "askedAt":"${ago(90)}","resolution":"ANSWERED","resolvedBy":"USER","resolvedAt":"${ago(60)}","answer":{"option":1,"text":"After 22:00."},
        "delivery":{"sessionId":"c1","at":"${ago(59)}"},"withdrawReason":null}"""

    private fun start() {
        ProjectShell.reset()
        ProjectShell.needsYouItems = "[${item()}]"
        ProjectShell.closedQuestions = "[${closed()}]"
        val delivery = """{"itemId":"item-d1","kind":"INTEGRATION_CONFLICT","title":"Merge conflict: Regenerate the API reference",
            "task":{"id":"01a03f58-40bd-76ac-85c1-d9c6b29f8ca9","title":"Regenerate the API reference"},"files":["docs/api-reference.md"],"targetRef":"refs/heads/main",
            "actions":["OPEN_TASK_SESSION"],"landing":{"receipts":0,"state":"NOT_KNOWN","upstream":"main","integration":"main"}}"""
        ProjectShell.coordEvents = """[
          {"type":"user","seq":1,"turnId":"t-1","ts":"${ago(30)}","payload":{"text":"What is waiting on me?"}},
          {"type":"assistant","seq":2,"turnId":"t-1","ts":"${ago(29)}","payload":{"text":${JsonPrimitive(prose)}}},
          {"type":"error","seq":3,"turnId":"t-1","ts":"${ago(28)}","payload":{"text":"ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /srv/worktrees/abc123/docs/api-reference.md:\n- old line"}},
          {"type":"user","seq":4,"turnId":"t-2","ts":"${ago(20)}","payload":{"text":"From Orbit · project item delivered.","openItemDelivery":$delivery}},
          {"type":"assistant","seq":5,"turnId":"t-2","ts":"${ago(19)}","payload":{"text":${JsonPrimitive(prose)}}}]"""
    }

    private fun scene(shotName: String) {
        start(); signIn(); open("orbit-session:$coord")
        await { shows("This paragraph is deliberately long") && shows("A landing stopped reporting") }
        compose.waitForIdle()
        val density = compose.activity.resources.displayMetrics.density
        val tags = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.TestTag), useUnmergedTree = true).fetchSemanticsNodes()
            .map { it.config[SemanticsProperties.TestTag] to it.size.width / density }
        val proseWidth = compose.onAllNodesWithText("This paragraph is deliberately long", substring = true, useUnmergedTree = true)
            .fetchSemanticsNodes().first().size.width / density
        val lines = buildList {
            add("prose reply\t${"%.1f".format(proseWidth)}")
            tags.filter { (t, _) -> t.endsWith(":openItemDelivery") || t == "tool-failure-card" || t.startsWith("item:") && t.count { it == ':' } == 1 ||
                t.startsWith("question-record") || t.startsWith("item-q1") || t.contains("record:") }.forEach { (t, w) -> add("$t\t${"%.1f".format(w)}") }
        }
        File(output, "$label-$shotName-widths.txt").writeText("window ${compose.activity.resources.displayMetrics.widthPixels / density}dp\n" +
            lines.joinToString("\n") + "\n--- all tags ---\n" + tags.joinToString("\n") { "${it.first}\t${"%.1f".format(it.second)}" })
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$label-$shotName.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun wide() = scene("wide")
    @Test @Config(qualifiers = "w411dp-h1400dp") fun phone() = scene("phone")

    private fun shows(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}
