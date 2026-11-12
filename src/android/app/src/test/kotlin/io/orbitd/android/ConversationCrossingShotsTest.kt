package io.orbitd.android

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ApiResponse
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog

/**
 * The crossing card where the owner meets it (task 34vT0PEhdlq1lILqsg2WG): in the production shell, Launch's coordinator conversation
 * — the owner's message, the agent's answer, and the eight moves it asked for placed right after that answer — its review opened over
 * the conversation in the sheet's own window, Approve pressed there, and the card answered in place; and, seen waiting, answered at
 * another end. A move batch is answered with ONE body through the session's batch door (owner 11-12). NATIVE frames and semantics are written under `$ORBIT_CROSSING_SHOTS` (default: the JVM's tmpdir), `conversation-*`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w393dp-h852dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ConversationCrossingShotsTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 0) val midday = MiddayZone()
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()

    private val coord = ProjectShell.COORD
    private val batch = "crossing-batch-34vMoveRow01"
    private val rows = CopyOnWriteArrayList<JsonObject>()
    private val decisions = CopyOnWriteArrayList<Pair<String, String>>()
    private val batches = CopyOnWriteArrayList<String>()
    private val output: File by lazy {
        File(System.getenv("ORBIT_CROSSING_SHOTS") ?: File(System.getProperty("java.io.tmpdir"), "crossing-cards-android").path).also { it.mkdirs() }
    }

    private val titles = listOf(
        "False offline alert after a link reconnect", "Self-update waits forever on a busy runner",
        "Heartbeat gaps read as the runner going offline", "Drain watchdog never fires on a wedged link",
        "Link gateway drops frames over 1 MB", "Upgrade leaves the old service unit running",
        "Reconnect storm after a gateway restart", "Runner restart loses the queued turn")

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()

    @Before fun start() {
        ProjectShell.reset()
        ProjectShell.coordEvents = buildJsonArray {
            add(Json.parseToJsonElement("""{"type":"user","seq":1,"turnId":"t-1","ts":"${ago(20)}","payload":{"text":"Criteria 4–11 still have no tasks. What do you need from me?"}}"""))
            add(Json.parseToJsonElement("""{"type":"assistant","seq":2,"turnId":"t-1","ts":"${ago(19)}","payload":{"text":"Criteria 4–11 have no task in this project yet. I asked to move the 8 tasks that serve them from the finished v1 project."}}"""))
        }.toString()
        titles.forEachIndexed { index, title ->
            val n = index + 4
            rows += buildJsonObject {
                put("id", "34vMoveRow%02d".format(index + 1)); put("publicId", "34vMoveRow%02d".format(index + 1))
                put("fromProjectId", "34vSourceProject000001"); put("toProjectId", ProjectShell.LAUNCH); put("kind", "MOVE_TASK")
                put("subjectTaskId", "34vMovedTask%02d".format(n)); put("crossingKey", "key-$n"); put("state", "PENDING"); put("title", title)
                put("reason", "These tasks serve criteria 4–11 here; their old project is done.")
                put("requestedAt", Instant.now().minusSeconds(18 * 60L - index).toString()); put("decidedAt", JsonNull)
                putJsonObject("fromProject") { put("title", "Runner v1: control-plane link to WebSocket"); put("status", "DONE") }
                putJsonObject("toProject") { put("title", "Launch"); put("status", "OPEN") }
                putJsonObject("subjectTask") { put("id", "34vMovedTask%02d".format(n)); put("title", title) }
                putJsonObject("requestedCriterion") { put("key", "$n"); put("text", "Criterion $n") }
            }
        }
        publish()
        // A move batch is ONE answer through the session's batch door; a per-crossing answer would be recorded here too, and is not.
        ProjectShell.onDecision = { door, body -> decisions += door to body; ApiResponse(500, "{}".encodeToByteArray()) }
        ProjectShell.onMoveBatch = { body ->
            batches += body
            val sent = Json.parseToJsonElement(body).jsonObject
            val approve = sent["decision"]?.jsonPrimitive?.content == "APPROVE"
            sent["moves"]!!.jsonArray.forEach { answer(it.jsonObject["handoffId"]!!.jsonPrimitive.content, if (approve) "APPLIED" else "DENIED") }
            ApiResponse(200, "[]".encodeToByteArray())
        }
    }

    private fun publish() { ProjectShell.crossings = JsonArray(rows.reversed()).toString() }
    private fun answer(door: String, state: String) {
        val i = rows.indexOfFirst { it["publicId"]?.jsonPrimitive?.content == door }
        rows[i] = JsonObject(rows[i] + mapOf("state" to JsonPrimitive(state), "decidedAt" to JsonPrimitive(Instant.now().toString())))
        publish()
    }

    @Test fun pendingThenReviewedThenApprovedInTheConversation() {
        signIn(); open("orbit-session:$coord")
        await { shows("Move these tasks here?") && shows("I asked to move the 8 tasks") }
        // The card is the agent's answer's neighbour in the transcript, not a card in the rail at its foot.
        val agent = compose.onNodeWithText("I asked to move the 8 tasks", substring = true, useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y
        val card = node("$batch:preview").fetchSemanticsNode().positionInRoot.y
        assertTrue("card below the agent's message", card > agent)
        assertEquals("8 tasks from Runner v1: control-plane link to WebSocket · for criteria 4–11", text("$batch:summary"))
        shot("conversation-pending-card")

        node("$batch:preview").performClick()
        await { shows("move · 8 waiting") }
        compose.onNodeWithText("False offline alert after a link reconnect", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Show 5 more", useUnmergedTree = true).assertExists()
        sheetShot("conversation-review-sheet")

        node("$batch:review:approve").performClick()
        await { shows("Approved by you") && batches.size == 1 }
        assertEquals("""{"decision":"APPROVE","moves":[""" + (1..8).joinToString(",") { """{"handoffId":"34vMoveRow%02d","crossingKey":"key-${it + 3}"}""".format(it) } + "]}",
            batches.single())
        assertTrue("no per-crossing answer", decisions.isEmpty())
        // The review leaves on its own after the record, and the card in the conversation keeps the receipt.
        await { compose.onAllNodesWithTag("$batch:review", useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
        await { shows("Decision recorded") }
        assertTrue(text("$batch:receipt").matches(Regex("Decision recorded · ✓ Approved by you at \\d{1,2}:\\d{2}.*")))
        assertEquals("moved", text("$batch:badge"))
        shot("conversation-answered-card")
    }

    @Test fun seenWaitingThenRefusedAtAnotherEnd() {
        signIn(); open("orbit-session:$coord")
        await { shows("View details & act") }
        rows.toList().forEach { answer(it["publicId"]!!.jsonPrimitive.content, "DENIED") }
        ProjectShell.event("session.updated", coord)
        await { shows("Refused at another end") }
        assertEquals("refused", text("$batch:badge"))
        assertTrue(decisions.isEmpty() && batches.isEmpty())
        shot("conversation-refused-elsewhere")
    }

    private fun node(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true)
    private fun text(tag: String) = node(tag).fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString("") { it.text }
    private fun shows(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun draw(name: String, vararg views: android.view.View) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = Int.MAX_VALUE))
        val base = views.first()
        val bitmap = Bitmap.createBitmap(base.width, base.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        views.forEach { view ->
            val at = IntArray(2).also(view::getLocationOnScreen)
            canvas.save(); canvas.translate(at[0].toFloat(), at[1].toFloat()); view.draw(canvas); canvas.restore()
        }
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun shot(name: String) = draw(name, compose.activity.window.decorView)
    /** The sheet is a window of its own: drawn over the conversation it opened on. */
    private fun sheetShot(name: String) = draw(name, compose.activity.window.decorView, ShadowDialog.getLatestDialog()!!.window!!.decorView)

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
