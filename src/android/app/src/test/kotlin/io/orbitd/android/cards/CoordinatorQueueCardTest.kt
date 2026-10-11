package io.orbitd.android.cards

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.CoordinatorQueue
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
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

/** One controlled Orbit server for the coordinator queue (project 34cygPTQe5LPUT7tdUAzG): the production Activity, AuthSession,
 * RealtimeStore and reader over these answers. An Automatic project's coordinator conversation — paused on Claude's weekly limit,
 * or back — with one task's evidence waiting for it or sent to it, and, beside it, today's evidence card for another task. Not a
 * deployed backend. */
internal object CoordinatorQueueServer {
    const val WORKSPACE = "34T4cqWorkspaceAlpha01"
    const val COORD = "34T4cqSessionCoord0001"
    const val PROJECT = "34T4cqProjectQueue0001"
    const val TASK = "34T4cqTaskWaiting00001"
    const val TODAY = "34T4cqTaskPending00002"
    private val ids = listOf(WORKSPACE, COORD, PROJECT, TASK, TODAY)
    const val TITLE = "Release notes for 0.1.230"
    const val CRITERION = "The release notes list every change merged since 0.1.229."
    const val CLAIM = "Every change merged since 0.1.229 is listed under its area, with its pull request."
    const val GAP = "The Android section was not checked against a device build."
    /** The evidence card's address: the waiting card, the line it becomes and the card Decide it myself opens all draw under it. */
    const val KEY = "evidence:$TASK:1"

    enum class Stage { PAUSED, BACK, SENT }
    @Volatile var stage = Stage.PAUSED
    /** Today's evidence card for another task is in the pending read too. */
    @Volatile var today = false
    @Volatile var decided = false
    val calls = CopyOnWriteArrayList<String>()
    /** Every decision posted, as its path and body. */
    val posts = CopyOnWriteArrayList<Pair<String, JsonObject>>()
    var submittedAt = ""; var retryAt = ""; var deliveredAt = ""; var quota = ""

    fun reset() {
        stage = Stage.PAUSED; today = false; decided = false; calls.clear(); posts.clear()
        val now = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        submittedAt = now.minusSeconds(4 * 60).toString()
        // The weekly reset two days out at 7pm where the runtime says, which the server arms the retry at.
        val reset = ZonedDateTime.now(ZoneId.of("Asia/Shanghai")).plusDays(2).withHour(19).withMinute(0).withSecond(0).withNano(0)
        retryAt = reset.toInstant().toString()
        quota = "You've hit your weekly limit · resets ${DateTimeFormatter.ofPattern("MMM d", Locale.US).format(reset)}, 7pm (Asia/Shanghai)"
        deliveredAt = now.minusSeconds(60).toString()
    }

    private fun detail() = buildJsonObject {
        val paused = stage == Stage.PAUSED
        put("id", COORD); put("title", "Coordinate the release"); put("projectId", PROJECT)
        put("status", if (paused) "FAILED" else "AWAITING_INPUT"); put("runState", if (paused) "FAILED" else "AWAITING_INPUT")
        put("lifecycleState", "OPEN"); put("agentId", WORKSPACE); putJsonObject("agent") { put("id", WORKSPACE); put("name", "Alpha") }
        put("createdAt", "2026-10-09T01:00:00.000Z"); put("lastTurnAt", submittedAt)
        // The server's count: the evidence waiting for the coordinator is not in it (T1), today's card is.
        put("pendingApprovals", if (today) 1 else 0)
        if (paused) { put("error", quota); put("retryAt", retryAt) }
        put("lastAssistantText", if (paused) quota else "Reading the evidence that waited for me.")
        putJsonObject("capabilities") { put("canSend", true); put("canComplete", true) }
        putJsonArray("tags") {}
    }

    private fun event(seq: Int, type: String, text: String) = buildJsonObject {
        put("type", type); put("seq", seq); putJsonObject("payload") { put("text", text) }; put("ts", submittedAt)
    }
    private fun page() = buildJsonObject {
        val events = listOfNotNull(event(1, "user", "Keep the release moving, and decide each task’s evidence as it comes in."),
            event(2, "assistant", quota),
            if (stage == Stage.SENT) event(3, "user", "Task “$TITLE” submitted revision 1 of its completion evidence. This revision was " +
                "submitted at $submittedAt while you were unavailable. It waited for you; nobody has decided it yet.") else null)
        put("events", JsonArray(events)); put("hasMore", false); put("lastSeq", events.size); put("latestSeq", events.size)
    }

    private fun evidence(task: String, title: String, revision: String) = buildJsonObject {
        put("taskId", task); put("title", title); put("status", "IN_PROGRESS"); put("projectId", PROJECT); put("ownerCard", JsonNull)
        putJsonObject("criterion") { put("key", "notes"); put("text", CRITERION) }
        put("evidenceRevision", revision); put("submittedAt", submittedAt); put("ageSeconds", 240)
        put("claim", CLAIM); putJsonArray("gaps") { add(GAP) }
        putJsonArray("citations") { addJsonObject {
            put("kind", "TOOL_CALL"); put("ref", "bgj_5f0c2a9e41d7"); put("resolved", true); put("reason", JsonNull); put("label", "Changelog diff against 0.1.229")
        } }
        putJsonObject("decidability") { put("decidable", true); put("refusal", JsonNull); put("requiredAction", JsonNull) }
        putJsonObject("independence") { put("independent", true); put("disqualification", JsonNull); put("requiredAction", JsonNull) }
    }
    private fun queue() = buildJsonObject {
        put("decidingSessionId", COORD); put("count", if (today) 1 else 0); put("oldestAgeSeconds", if (today) 240 else null)
        putJsonArray("pending") { if (today) add(evidence(TODAY, "Changelog links", "3")) }
        putJsonArray("waitingOnYou") {}
        putJsonArray("waitingOnCoordinator") { if (stage != Stage.SENT && !decided) add(evidence(TASK, TITLE, "1")) }
        putJsonArray("sentToCoordinator") { if (stage == Stage.SENT) addJsonObject {
            put("taskId", TASK); put("title", TITLE); put("projectId", PROJECT); put("evidenceRevision", "1"); put("deliveredAt", deliveredAt)
        } }
        putJsonArray("decided") { if (decided) addJsonObject {
            put("taskId", TASK); put("title", TITLE); put("projectId", PROJECT); put("evidenceRevision", "1"); put("decision", "CONFIRM")
            put("note", JsonNull); put("decidedAt", Instant.now().toString()); put("decidedByType", "USER")
        } }
    }
    private val project = """{"id":"$PROJECT","title":"Release 0.1.230","status":"OPEN","goal":"Ship 0.1.230.","createdAt":"2026-10-09T00:00:00Z"}"""

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/") { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
        val method = api.method.name
        if (path == "auth/login") return@HttpTransport ok("""{"accessToken":"t4-access","refreshToken":"t4-refresh","user":{"id":"u1","email":"owner@t4.test","name":"Owner"}}""")
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        calls += "$method $path" + if (query.isEmpty()) "" else "?$query"
        when {
            method == "POST" && path.endsWith("/evidence/decision") -> {
                posts += path to Wire.json.parseToJsonElement(api.body!!.decodeToString()).jsonObject
                decided = true; ok("""{"ok":true}""")
            }
            path == "users/me" -> ok("""{"id":"u1","email":"owner@t4.test","name":"Owner"}""")
            path == "workspaces" -> ok("""[{"id":"$WORKSPACE","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]""")
            path == "runners" -> ok("""[{"id":"r1","name":"Fixture runner","online":true}]""")
            path == "sessions" -> ok(if ((api.query.firstOrNull { it.first == "view" }?.second ?: "open") == "open") "[${detail()}]" else "[]")
            path == "sessions/$COORD" && method == "GET" -> ok(detail().toString())
            path == "sessions/$COORD/events/page" -> ok(page().toString())
            path == "tasks/evidence-decisions/pending" -> ok(queue().toString())
            path == "projects/$PROJECT" -> ok(project)
            path == "projects/$PROJECT/open-items" -> ok("""{"needsYou":[],"withCoordinator":[]}""")
            path.startsWith("projects/") -> ok("{}")
            path.startsWith("wiki/") -> ApiResponse(404, """{"code":"WIKI_DISABLED","message":"The wiki is off."}""".encodeToByteArray())
            method == "GET" -> ok("[]")
            else -> ok("{}")
        }
    }

    /** The streams open and stay quiet: the account is connected, so writes are offered. */
    private val events = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit): Unit {
            onOpen()
            awaitCancellation()
        }
    }

    fun session() = AuthSession(transport, object : CredentialStore {
        private var value: StoredSession? = null
        override suspend fun load() = value
        override suspend fun save(session: StoredSession) { value = session }
        override suspend fun clear() { value = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) = Unit
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
        override suspend fun clearAll() = Unit
    }, "t4-queue", eventTransport = events)

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://t4.test"), "owner@t4.test", "fixture")
}

/** The application with the controlled server in place of the network and the device stores. */
class CoordinatorQueueApplication : OrbitApplication() {
    override fun createSession(): AuthSession = CoordinatorQueueServer.session()
    // Unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
}

/**
 * The coordinator queue in the conversation (project 34cygPTQe5LPUT7tdUAzG; design docs/mocks/evidence-waits-for-coordinator/):
 * a revision waiting for the paused coordinator is a card in "Decisions and requests" that asks nothing until Decide it myself opens
 * today's evidence card in place, whose Confirm done posts today's request as the same deciding session; once sent it is one line
 * where its card was; and nothing of it is counted — not by the conversation's needs-you bar, not by the session row. Each of the
 * three states is written to a PNG under `src/android/build/evidence/evidence-waits-for-coordinator-t4/`, beside its semantics tree.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = CoordinatorQueueApplication::class, qualifiers = "w411dp-h1200dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class CoordinatorQueueCardTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = CoordinatorQueueServer.reset()

    private val key = CoordinatorQueueServer.KEY
    private fun clock(iso: String) = OwnerReview.receiptTime(iso)!!

    @Test fun aWaitingRevisionIsACardInDecisionsAndRequestsThatAsksNothing() {
        signIn(); open("orbit-session:${CoordinatorQueueServer.COORD}")
        await { exists(hasTestTag(key)) }
        // Where today's evidence card is drawn: the conversation's "Decisions and requests".
        compose.onNode(hasText("Decisions and requests") and hasAnyAncestor(hasTestTag("interaction-cards"))).assertExists()
        compose.onNode(hasTestTag(key) and hasAnyAncestor(hasTestTag("interaction-cards"))).assertExists()
        says(key, CoordinatorQueue.title, clock(CoordinatorQueueServer.submittedAt), CoordinatorQueueServer.TITLE)
        compose.onNodeWithTag("$key:paused", useUnmergedTree = true)
            .assertTextEquals("Coordinator paused · weekly limit · resets ${clock(CoordinatorQueueServer.retryAt)}")
        compose.onNodeWithTag("$key:note", useUnmergedTree = true).assertTextEquals(CoordinatorQueue.explanation)
        compose.onNodeWithTag("$key:DECIDE_MYSELF").performScrollTo().assertTextEquals("Decide it myself").assertIsEnabled()
        // No decision on it until then, and none of today's evidence.
        listOf("CONFIRM_EVIDENCE", "SEND_BACK").forEach { compose.onAllNodesWithTag("$key:$it").assertCountEquals(0) }
        assertFalse(exists(hasText(CoordinatorQueueServer.CLAIM), unmerged = true))
        compose.onAllNodesWithTag("needs-you-bar").assertCountEquals(0)
        shot("1-waiting")
    }

    @Test fun decideItMyselfOpensTodaysCardInPlaceAndPostsItsRequest() {
        signIn(); open("orbit-session:${CoordinatorQueueServer.COORD}")
        await { exists(hasTestTag("$key:DECIDE_MYSELF")) }
        compose.onNodeWithTag("$key:DECIDE_MYSELF").performScrollTo().performClick()
        await { exists(hasTestTag("$key:CONFIRM_EVIDENCE")) }
        compose.onAllNodesWithTag("$key:DECIDE_MYSELF").assertCountEquals(0)
        compose.onNodeWithTag("$key:CONFIRM_EVIDENCE").assertTextEquals("Confirm done").assertIsEnabled()
        compose.onNodeWithTag("$key:SEND_BACK").assertTextEquals("Chat about this").assertIsEnabled()
        // Still saying what it waits for, and under that, that deciding here is the owner's choice.
        compose.onNodeWithTag("$key:paused", useUnmergedTree = true)
            .assertTextEquals("Coordinator paused · weekly limit · resets ${clock(CoordinatorQueueServer.retryAt)}")
        compose.onNodeWithTag("$key:note", useUnmergedTree = true).assertTextEquals(CoordinatorQueue.decideHere)
        says(key, CoordinatorQueue.title, CoordinatorQueueServer.TITLE, CoordinatorQueueServer.CRITERION, CoordinatorQueueServer.CLAIM, CoordinatorQueueServer.GAP)
        compose.onAllNodesWithTag("needs-you-bar").assertCountEquals(0)
        // The whole card in view: its last button brought up from below the fold.
        compose.onNodeWithTag("$key:SEND_BACK").performScrollTo()
        shot("2-decide-it-myself")
        compose.onNodeWithTag("$key:CONFIRM_EVIDENCE").performScrollTo().performClick()
        // The press is re-read, posted and read again; the receipt it leaves is the server's.
        await { exists(hasText("Evidence decision recorded")) }
        val (path, body) = CoordinatorQueueServer.posts.single()
        assertEquals("tasks/${CoordinatorQueueServer.TASK}/evidence/decision", path)
        assertEquals(buildJsonObject { put("decidingSessionId", CoordinatorQueueServer.COORD); put("evidenceRevision", "1"); put("decision", "CONFIRM") }, body)
    }

    /** Sent once the coordinator was back: the card turns into one line where it was, and no copy of it is kept. */
    @Test fun aRevisionSentToTheCoordinatorIsOneLineWhereItsCardWas() {
        CoordinatorQueueServer.stage = CoordinatorQueueServer.Stage.BACK
        signIn(); open("orbit-session:${CoordinatorQueueServer.COORD}")
        await { exists(hasTestTag("$key:paused"), unmerged = true) }
        compose.onNodeWithTag("$key:paused", useUnmergedTree = true).assertTextEquals("Coordinator is back · it gets this when its current turn ends")
        CoordinatorQueueServer.stage = CoordinatorQueueServer.Stage.SENT
        app().realtime.refreshSession()
        val sent = "Sent to the coordinator · ${clock(CoordinatorQueueServer.deliveredAt)}"
        await { exists(hasText(sent) and hasAnyAncestor(hasTestTag(key)), unmerged = true) }
        compose.onAllNodesWithTag("$key:paused", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithTag("$key:DECIDE_MYSELF").assertCountEquals(0)
        assertFalse(exists(hasText(CoordinatorQueue.title), unmerged = true))
        assertFalse(exists(hasText("No longer pending", substring = true), unmerged = true))
        compose.onAllNodesWithTag("needs-you-bar").assertCountEquals(0)
        // Opened again, the conversation has the delivery in its transcript, and the line where the card was.
        compose.onNodeWithContentDescription("Back").performClick()
        open("orbit-session:${CoordinatorQueueServer.COORD}")
        await { exists(hasText("It waited for you; nobody has decided it yet.", substring = true), unmerged = true) && exists(hasText(sent), unmerged = true) }
        assertFalse(exists(hasText(CoordinatorQueue.title), unmerged = true))
        shot("3-sent")
    }

    /** Counted nowhere: today's card beside it is the one the conversation's bar and the session row count. */
    @Test fun theWaitingRevisionIsCountedNowhereTodaysCardIs() {
        signIn()
        await { exists(hasTestTag("workspace:${CoordinatorQueueServer.WORKSPACE}")) }
        compose.onNodeWithTag("workspace:${CoordinatorQueueServer.WORKSPACE}").performClick()
        await { exists(hasContentDescription("Options for Coordinate the release")) }
        assertFalse(exists(hasText("Needs you", substring = true), unmerged = true))
        open("orbit-session:${CoordinatorQueueServer.COORD}")
        await { exists(hasTestTag(key)) }
        compose.onAllNodesWithTag("needs-you-bar").assertCountEquals(0)
        CoordinatorQueueServer.today = true
        app().realtime.refreshSession(); app().realtime.refreshDirectory()
        await { exists(hasTestTag("evidence:${CoordinatorQueueServer.TODAY}:3")) }
        await { exists(hasTestTag("needs-you-bar-text") and hasText("1 open question", substring = true), unmerged = true) }
        assertTrue("still drawn beside it", exists(hasTestTag("$key:DECIDE_MYSELF")))
        assertEquals(1, NeedsYouLogic.belowRows(app().realtime.state.value.session!!.id, app().realtime.state.value.session!!.snapshot!!).size)
        compose.onNodeWithContentDescription("Back").performClick()
        await { exists(hasText("Needs you · 1"), unmerged = true) }
    }

    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) =
        compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty()
    /** A card says each of [texts] in one of its lines. */
    private fun says(tag: String, vararg texts: String) = texts.forEach { text ->
        assertTrue("$tag does not say “$text”", exists((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and hasText(text), unmerged = true))
    }
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { CoordinatorQueueServer.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    /** A link as Android delivers one to the running Activity; the launch intent is put back for ActivityScenario. */
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/evidence-waits-for-coordinator-t4").also { it.mkdirs() }
    }

    /** The screen as a PNG, never a blank one, with the semantics tree on screen beside it. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText(
            (0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
        bitmap.recycle()
    }
}
