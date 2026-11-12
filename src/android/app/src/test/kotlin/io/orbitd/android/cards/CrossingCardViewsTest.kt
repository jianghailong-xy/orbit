package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The crossing cards of a coordinator conversation (task 34vT0PEhdlq1lILqsg2WG) over the real wire: a loopback server holding eight
 * move requests into the coordinated project, read through `ProjectApi` and `CrossingCardStore` as the reader does — the project's
 * handoffs and the session's task moves — drawn by the production composables. Approve or Refuse on a move batch is ONE answer through
 * the session's batch door with every move's crossing key; a stale key is refused whole, nothing written, and the card stays live with
 * the door's words; the session that asked draws the same card in its own words; the answered card's receipt says who answered. Filings
 * keep their per-row door. NATIVE frames are written beside the semantics trees under
 * `$ORBIT_CROSSING_SHOTS` (default: the JVM's tmpdir).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w393dp-h852dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CrossingCardViewsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val fixture = Fixture()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var store: CrossingCardStore
    private val batchId = "crossing-batch-Pm4"

    private val output: File by lazy {
        File(System.getenv("ORBIT_CROSSING_SHOTS") ?: File(System.getProperty("java.io.tmpdir"), "crossing-cards-android").path).also { it.mkdirs() }
    }

    @Before fun setUp() {
        fixture.hold((4..11).map { n -> move("m$n", n) })
        val handle = runBlocking { fixture.signIn() }
        store = CrossingCardStore(fixture.auth, handle, scope, ProjectApi(fixture.auth, handle))
    }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() }
        } } }
        compose.waitForIdle()
    }

    /** The conversation's place for the cards, as the reader draws them. */
    @Composable private fun Conversation(project: String? = PROJECT, session: String = SESSION) {
        val state by store.state.collectAsState()
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            state.batches(project, session).forEach { CrossingCardView(it, state) { store.open(it.id) } }
        }
    }

    /** The review page the card opens, at a phone's height (the sheet's content, without the sheet's window). */
    @Composable private fun Review(project: String? = PROJECT, session: String = SESSION) {
        val state by store.state.collectAsState()
        state.batches(project, session).firstOrNull()?.let { batch ->
            Box(Modifier.fillMaxSize().padding(top = 24.dp)) { CrossingReview(batch, state, close = {}) { store.decide(project, session, batch, it) } }
        }
    }

    private fun shows(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun tag(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true)
    private fun textOf(tag: String) = tag(tag).fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("") { it.text }
    private fun loaded(predicate: () -> Boolean) {
        store.load(PROJECT); store.loadMoves(SESSION)
        compose.waitUntil(10_000) { shows("here?") && predicate() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Test fun approveAnswersEachRowWithItsKeyAndARefusedRowStaysLiveWithItsReason() {
        show { Conversation() }
        loaded { store.state.value.rows[PROJECT]?.size == 8 }
        compose.onNodeWithText("Move these tasks here?", useUnmergedTree = true).assertExists()
        assertEquals("8 tasks from Runner v1: control plane · for criteria 4–11", textOf("$batchId:summary"))
        assertEquals("move", textOf("$batchId:badge"))
        compose.onNodeWithText("View details & act", useUnmergedTree = true).assertExists()
        shot("crossing-pending-card")

        show { Review() }
        assertEquals("move · 8 waiting", textOf("$batchId:review:waiting"))
        compose.onNodeWithText("From Orbit — not the requesting agent.", useUnmergedTree = true).assertExists()
        assertEquals("From Runner v1: control plane", textOf("$batchId:review:from"))
        compose.onNodeWithText("To this project", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Tasks to move", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Target criterion requested: 4", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithText("Task m7", useUnmergedTree = true).assertCountEquals(0)
        assertEquals("Show 5 more", textOf("$batchId:review:more"))
        compose.onNodeWithText("“These tasks serve criteria 4–11 here; their old project is done.”", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(io.orbitd.android.projects.CrossingCards.batchMoveConsequence, useUnmergedTree = true).assertExists()
        shot("crossing-review")
        tag("$batchId:review:more").performClick()
        compose.onNodeWithText("Task m11", useUnmergedTree = true).assertExists()

        // A key that no longer names its crossing: the batch door refuses the whole answer, nothing is written, and the card keeps
        // asking with the door's code and words.
        fixture.mismatch = "the crossing key of Pm5 names another crossing; nothing was written"
        tag("$batchId:review:approve").performClick()
        compose.waitUntil(10_000) { store.state.value.batchRefusals.isNotEmpty() && batchId !in store.state.value.sending }
        assertEquals(1, fixture.batchDecisions().size)
        assertTrue("no per-row door for a move", fixture.decisions().none { it.path.contains("/handoffs/") })
        assertEquals("That answer was not recorded APPROVAL_TARGET_MISMATCH", textOf("$batchId:review:refused:head"))
        compose.onNodeWithText("the crossing key of Pm5 names another crossing; nothing was written", useUnmergedTree = true).assertExists()
        assertTrue(fixture.held.values.all { it["state"]!!.jsonPrimitive.content == "PENDING" })
        tag("$batchId:review:approve").assertIsEnabled()
        shot("crossing-review-refused-batch")

        show { Conversation() }
        assertEquals("That answer was not recorded APPROVAL_TARGET_MISMATCH", textOf("$batchId:refused:head"))
        compose.onAllNodesWithTag("$batchId:receipt", useUnmergedTree = true).assertCountEquals(0)

        // Pressed again: ONE answer with every move and the crossing key the card read; answered, the card is dimmed and says so.
        fixture.mismatch = null
        show { Review() }
        tag("$batchId:review:approve").performClick()
        compose.waitUntil(10_000) { shows("Approved by you") }
        assertEquals(2, fixture.batchDecisions().size)
        val sent = Json.parseToJsonElement(fixture.batchDecisions().last().body).jsonObject
        assertEquals("/api/sessions/$SESSION/task-moves/decision", fixture.batchDecisions().last().path)
        assertEquals("APPROVE", sent["decision"]!!.jsonPrimitive.content)
        assertEquals((4..11).map { "Pm$it" to "key-m$it" }, sent["moves"]!!.jsonArray.map {
            it.jsonObject["handoffId"]!!.jsonPrimitive.content to it.jsonObject["crossingKey"]!!.jsonPrimitive.content })
        assertTrue(fixture.decisions().none { it.path.contains("/handoffs/") })
        show { Conversation() }
        compose.waitUntil(10_000) { shows("Approved by you") }
        assertTrue(textOf("$batchId:receipt").matches(Regex("Decision recorded · ✓ Approved by you at \\d{1,2}:\\d{2}.*")))
        assertEquals("moved", textOf("$batchId:badge"))
        compose.onNodeWithText("View details", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithTag("$batchId:refused", useUnmergedTree = true).assertCountEquals(0)
        shot("crossing-answered-card")
    }

    @Test fun refuseIsOneDenyForTheWholeBatch() {
        show { Review() }
        loaded { store.state.value.rows[PROJECT]?.size == 8 }
        tag("$batchId:review:refuse").performClick()
        compose.waitUntil(10_000) { shows("Refused by you") }
        val sent = Json.parseToJsonElement(fixture.batchDecisions().single().body).jsonObject
        assertEquals("DENY", sent["decision"]!!.jsonPrimitive.content)
        assertEquals(8, sent["moves"]!!.jsonArray.size)
        assertTrue(fixture.held.values.all { it["state"]!!.jsonPrimitive.content == "DENIED" })
    }

    /** The session that ASKED for the moves draws the same card from its own read, in words that name where the tasks go, and answers
     * it through its own batch door. */
    @Test fun theAskingSessionDrawsTheSameCardAndAnswersIt() {
        fixture.drawnAs = "REQUESTER"
        show { Conversation(project = null, session = ASKER) }
        store.loadMoves(ASKER)
        compose.waitUntil(10_000) { shows("Move these tasks into Runner hardening?") }
        assertEquals("8 tasks from Runner v1: control plane · for criteria 4–11", textOf("$batchId:summary"))
        compose.onAllNodesWithText("here?", substring = true, useUnmergedTree = true).assertCountEquals(0)
        shot("crossing-asking-session-card")
        show { Review(project = null, session = ASKER) }
        assertEquals("To Runner hardening", textOf("$batchId:review:to"))
        shot("crossing-asking-session-review")
        tag("$batchId:review:approve").performClick()
        compose.waitUntil(10_000) { shows("Approved by you") }
        assertEquals("/api/sessions/$ASKER/task-moves/decision", fixture.batchDecisions().single().path)
    }

    /** Answered at the other end: the asking session saw the card waiting, and its next read says so. */
    @Test fun theAskingSessionSeesAnAnswerGivenAtTheOtherEnd() {
        fixture.drawnAs = "REQUESTER"
        show { Conversation(project = null, session = ASKER) }
        store.loadMoves(ASKER)
        compose.waitUntil(10_000) { shows("View details & act") }
        fixture.answerAll("APPLIED")
        store.loadMoves(ASKER)
        compose.waitUntil(10_000) { shows("at another end") }
        assertEquals("Approved at another end", textOf("$batchId:receipt"))
        shot("crossing-asking-session-answered-elsewhere")
    }

    /** A coordinator that is also the asker is served the batch by both reads: one card. */
    @Test fun aBatchBothReadsServeIsOneCard() {
        fixture.drawnAs = "TARGET_COORDINATOR"
        show { Conversation() }
        loaded { store.state.value.rows[PROJECT]?.size == 8 && store.state.value.sessionMoves[SESSION]?.size == 1 }
        compose.onAllNodesWithTag(batchId, useUnmergedTree = true).assertCountEquals(1)
        assertEquals(1, store.state.value.batches(PROJECT, SESSION).size)
    }

    @Test fun aCardSeenWaitingThenAnsweredElsewhereSaysSo() {
        show { Conversation() }
        loaded { shows("View details & act") }
        fixture.answerAll("DENIED")
        store.load(PROJECT)
        compose.waitUntil(10_000) { shows("at another end") }
        assertEquals("Refused at another end", textOf("$batchId:receipt"))
        assertEquals("refused", textOf("$batchId:badge"))
        assertTrue(fixture.decisions().isEmpty())
        shot("crossing-answered-elsewhere-card")
    }

    @Test fun anAnsweredCardNeverSeenWaitingReadsAsTheOwners() {
        fixture.answerAll("APPLIED")
        show { Conversation() }
        loaded { shows("by you") }
        assertTrue(textOf("$batchId:receipt").startsWith("Decision recorded · ✓ Approved by you at "))
    }

    @Test fun aFilingAndADependencyAreTheirOwnCardsInTheirOwnWords() {
        fixture.held.clear()
        fixture.hold(listOf(
            move("f1", 2, kind = "FILE_TASK", minute = 1),
            move("d1", 3, kind = "DEPEND_ON_TASK", minute = 2), move("d2", 3, kind = "DEPEND_ON_TASK", minute = 3)))
        show { Conversation() }
        loaded { shows("Allow these dependencies?") }
        assertEquals("1 task from Runner v1: control plane · for criterion 2", textOf("crossing-batch-Pf1:summary"))
        assertEquals("file", textOf("crossing-batch-Pf1:badge"))
        assertEquals("2 dependencies from Runner v1: control plane · for criterion 3", textOf("crossing-batch-Pd1:summary"))
        assertEquals("depend", textOf("crossing-batch-Pd1:badge"))
        compose.onNodeWithText("File this task here?", useUnmergedTree = true).assertExists()
    }

    private fun move(id: String, criterion: Int, kind: String = "MOVE_TASK", minute: Int = criterion) = buildJsonObject {
        put("id", "uuid-$id"); put("publicId", "P$id"); put("fromProjectId", "AAASource"); put("toProjectId", PROJECT); put("kind", kind)
        put("crossingKey", "key-$id"); put("state", "PENDING"); put("title", "Task $id"); put("requestedAt", "2026-11-10T09:%02d:00.000Z".format(minute))
        put("decidedAt", JsonNull); put("reason", "These tasks serve criteria 4–11 here; their old project is done.")
        putJsonObject("fromProject") { put("title", "Runner v1: control plane") }
        putJsonObject("toProject") { put("title", "Runner hardening") }
        if (kind != "FILE_TASK") putJsonObject("subjectTask") { put("title", "Task $id") }
        putJsonObject("requestedCriterion") { put("key", "$criterion"); put("text", "Criterion $criterion") }
    }

    private companion object { const val PROJECT = "AAATarget"; const val SESSION = "AAACoordinator"; const val ASKER = "AAAAsker" }

    /** A loopback handoffs server: the rows it holds move from PENDING as decisions are posted, unless a row's answer is refused. */
    private class Fixture {
        data class Call(val method: String, val path: String, val body: String)
        val calls = CopyOnWriteArrayList<Call>()
        val held = java.util.Collections.synchronizedMap(LinkedHashMap<String, JsonObject>())
        val refuse = ConcurrentHashMap<String, Pair<String, String>>()
        /** The batch door's 409 sentence, when a test wants a stale key; null answers the batch. */
        @Volatile var mismatch: String? = null
        /** How the session read says the session draws the moves. */
        @Volatile var drawnAs = "TARGET_COORDINATOR"

        fun hold(rows: List<JsonObject>) = rows.forEach { held[(it["publicId"] as JsonPrimitive).content] = it }
        /** One answer for every row, at one moment, as the batch door writes it. */
        fun answerAll(state: String) { val at = Instant.now().toString(); held.keys.toList().forEach { held[it] = decided(held[it]!!, state, at) } }
        fun decisions() = calls.filter { it.method == "POST" && it.path.endsWith("/decision") }
        fun batchDecisions() = calls.filter { it.method == "POST" && it.path.endsWith("/task-moves/decision") }
        /** The session read: the held moves as batches, waiting first, then each answer's own (`listMovesForSession`). */
        fun moveBatches() = buildJsonArray {
            held.values.filter { it["kind"]!!.jsonPrimitive.content == "MOVE_TASK" }
                .groupBy { it["state"]!!.jsonPrimitive.content + "|" + (it["decidedAt"] as? JsonPrimitive)?.contentOrNull }.forEach { (_, rows) ->
                    addJsonObject {
                        put("batchKey", "b-${rows.first()["publicId"]!!.jsonPrimitive.content}"); put("state", rows.first()["state"]!!)
                        put("since", rows.first()["requestedAt"]!!); putJsonArray("drawnAs") { add(drawnAs) }; put("moves", JsonArray(rows))
                    }
                }
        }
        private fun decided(row: JsonObject, state: String, at: String = Instant.now().toString()) =
            JsonObject(row + mapOf("state" to JsonPrimitive(state), "decidedAt" to JsonPrimitive(at)))

        private val server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    val body = request.body.readUtf8()
                    calls += Call(request.method!!, path, body)
                    fun json(code: Int, text: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(text)
                    val parts = path.removePrefix("/api/").split('/')
                    return when {
                        path == "/api/auth/login" -> json(200, """{"accessToken":"or-access","refreshToken":"or-refresh","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                        path == "/api/projects/$PROJECT/handoffs" && request.method == "GET" -> json(200, JsonArray(held.values.toList().reversed()).toString())
                        parts.size == 3 && parts[0] == "sessions" && parts[2] == "task-moves" && request.method == "GET" -> json(200, moveBatches().toString())
                        parts.size == 4 && parts[0] == "sessions" && parts[3] == "decision" && request.method == "POST" -> {
                            mismatch?.let { return json(409, buildJsonObject {
                                put("statusCode", 409); put("code", "APPROVAL_TARGET_MISMATCH"); put("message", it) }.toString()) }
                            val sent = Json.parseToJsonElement(body).jsonObject
                            val state = if (sent["decision"]!!.jsonPrimitive.content == "APPROVE") "APPLIED" else "DENIED"
                            val at = Instant.now().toString()
                            val ids = sent["moves"]!!.jsonArray.map { it.jsonObject["handoffId"]!!.jsonPrimitive.content }
                            ids.forEach { id -> held[id] = JsonObject(held[id]!! + mapOf("state" to JsonPrimitive(state), "decidedAt" to JsonPrimitive(at))) }
                            json(200, JsonArray(ids.map { held[it]!! }).toString())
                        }
                        parts.size == 5 && parts[2] == "handoffs" && parts[4] == "decision" && request.method == "POST" -> {
                            val door = parts[3]
                            refuse[door]?.let { (code, message) ->
                                return json(409, buildJsonObject { put("statusCode", 409); put("code", code); put("message", message) }.toString())
                            }
                            val row = held[door] ?: return json(404, """{"message":"not found"}""")
                            val decision = Json.parseToJsonElement(body).jsonObject["decision"]!!.jsonPrimitive.content
                            held[door] = decided(row, if (decision == "APPROVE") "APPLIED" else "DENIED")
                            json(200, held[door].toString())
                        }
                        else -> json(404, "{}")
                    }
                }
            }
            start()
        }

        val auth = AuthSession(OkHttpTransport(), object : CredentialStore {
            private var saved: StoredSession? = null
            override suspend fun load() = saved
            override suspend fun save(session: StoredSession) { saved = session }
            override suspend fun clear() { saved = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) {}
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
            override suspend fun clearAll() {}
        }, "test", allowLoopbackHttp = true)

        suspend fun signIn(): SessionHandle =
            auth.login(ServerAddress.parse(server.url("/").toString(), allowLoopbackHttp = true), "u@example.test", "fixture-password")
        fun close() = server.shutdown()
    }
}
