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
 * move requests into the coordinated project, read through `ProjectApi` and `CrossingCardStore` as the reader does, drawn by the
 * production composables. Approve answers each waiting row with its own crossing key; a row the door refuses keeps its words and the
 * card stays live; the answered card's receipt says who answered. NATIVE frames are written beside the semantics trees under
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
    @Composable private fun Conversation() {
        val state by store.state.collectAsState()
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            state.batches(PROJECT).forEach { CrossingCardView(it, state) { store.open(it.id) } }
        }
    }

    /** The review page the card opens, at a phone's height (the sheet's content, without the sheet's window). */
    @Composable private fun Review() {
        val state by store.state.collectAsState()
        state.batches(PROJECT).firstOrNull()?.let { batch ->
            Box(Modifier.fillMaxSize().padding(top = 24.dp)) { CrossingReview(batch, state, close = {}) { store.decide(PROJECT, batch, it) } }
        }
    }

    private fun shows(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    private fun tag(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true)
    private fun textOf(tag: String) = tag(tag).fetchSemanticsNode().config[SemanticsProperties.Text].joinToString("") { it.text }
    private fun loaded(predicate: () -> Boolean) {
        store.load(PROJECT)
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

        // The door refuses one row: the seven others are taken, that one keeps the door's words and the card still asks.
        fixture.refuse["Pm5"] = "MOVE_TASK_LANDING_IN_FLIGHT" to "task m5 is being landed — nothing was written and the request is still waiting."
        tag("$batchId:review:approve").performClick()
        compose.waitUntil(10_000) { shows("1 waiting") && fixture.decisions().size == 8 }
        assertEquals((4..11).map { "/api/projects/$PROJECT/handoffs/Pm$it/decision" }, fixture.decisions().map { it.path })
        assertEquals((4..11).map { """{"decision":"APPROVE","acknowledgedCrossingKey":"key-m$it"}""" }, fixture.decisions().map { it.body })
        assertEquals("That answer was not recorded MOVE_TASK_LANDING_IN_FLIGHT", textOf("$batchId:review:row:Pm5:refused"))
        compose.onNodeWithText("task m5 is being landed — nothing was written and the request is still waiting.", useUnmergedTree = true).assertExists()
        tag("$batchId:review:approve").assertIsEnabled()
        shot("crossing-review-refused-row")

        show { Conversation() }
        assertEquals("1 answer was not recorded", textOf("$batchId:not-recorded"))
        compose.onAllNodesWithTag("$batchId:receipt", useUnmergedTree = true).assertCountEquals(0)

        // Pressed again, only the row still waiting is sent; answered, the card is dimmed and says it was answered here.
        fixture.refuse.clear()
        show { Review() }
        tag("$batchId:review:approve").performClick()
        compose.waitUntil(10_000) { shows("Approved by you") }
        assertEquals(9, fixture.decisions().size)
        assertEquals("/api/projects/$PROJECT/handoffs/Pm5/decision", fixture.decisions().last().path)
        show { Conversation() }
        compose.waitUntil(10_000) { shows("Approved by you") }
        assertTrue(textOf("$batchId:receipt").matches(Regex("Decision recorded · ✓ Approved by you at \\d{1,2}:\\d{2}.*")))
        assertEquals("moved", textOf("$batchId:badge"))
        compose.onNodeWithText("View details", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithTag("$batchId:not-recorded", useUnmergedTree = true).assertCountEquals(0)
        shot("crossing-answered-card")
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

    private companion object { const val PROJECT = "AAATarget" }

    /** A loopback handoffs server: the rows it holds move from PENDING as decisions are posted, unless a row's answer is refused. */
    private class Fixture {
        data class Call(val method: String, val path: String, val body: String)
        val calls = CopyOnWriteArrayList<Call>()
        val held = java.util.Collections.synchronizedMap(LinkedHashMap<String, JsonObject>())
        val refuse = ConcurrentHashMap<String, Pair<String, String>>()

        fun hold(rows: List<JsonObject>) = rows.forEach { held[(it["publicId"] as JsonPrimitive).content] = it }
        fun answerAll(state: String) = held.keys.toList().forEach { held[it] = decided(held[it]!!, state) }
        fun decisions() = calls.filter { it.method == "POST" && it.path.endsWith("/decision") }
        private fun decided(row: JsonObject, state: String) =
            JsonObject(row + mapOf("state" to JsonPrimitive(state), "decidedAt" to JsonPrimitive(Instant.now().toString())))

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
