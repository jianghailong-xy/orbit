package io.orbitd.android.schedule

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.cards.BusinessCard
import io.orbitd.android.cards.OwnerRequestStore
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.core.schedule.TaskStartWhenView
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.TimeZone
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * NATIVE frames 2 to 6 of the condition-triggers board (docs/mocks/condition-triggers/01-board.png) on an Android phone: each is drawn
 * by the production composable over the real wire — a loopback server holding the iOS probe's made-up data
 * (docs/evidence/condition-triggers/ios/probe-harness/stub.py), read through `AuthSession`, `ScheduleApi` and the stores as the app
 * reads it — checked for the board's words, and written under `src/android/build/evidence/condition-triggers-android/` beside its
 * semantics tree.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ConditionShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val fixture = Fixture()
    private lateinit var handle: SessionHandle
    private lateinit var store: ScheduledStore
    private var savedZone: TimeZone = TimeZone.getDefault()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/condition-triggers-android").also { it.mkdirs() }
    }

    @Before fun setUp() {
        // The app runs in Asia/Shanghai, as the iOS probe does: "Fired 03:12".
        TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"))
        handle = runBlocking { fixture.signIn() }
        store = ScheduledStore(fixture.auth, handle, scope)
    }

    @After fun tearDown() {
        scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close()
        TimeZone.setDefault(savedZone)
    }

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() }
        } } }
        compose.waitForIdle()
    }

    /** Every window's root view, oldest first: the activity, then a bottom sheet over it. */
    @Suppress("UNCHECKED_CAST")
    private fun windows(): List<android.view.View> {
        val global = Class.forName("android.view.WindowManagerGlobal")
        val instance = global.getMethod("getInstance").invoke(null)
        val field = global.getDeclaredField("mViews").apply { isAccessible = true }
        return (field.get(instance) as List<android.view.View>).filter { it.isAttachedToWindow && it.width > 0 }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        // A bottom sheet is a window of its own: each root's tree, and each window drawn over the last at its place on screen.
        val roots = compose.onAllNodes(isRoot(), useUnmergedTree = true)
        File(output, "$name-semantics.txt").writeText(roots.fetchSemanticsNodes().indices.joinToString("\n") {
            roots[it].printToString()
        })
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        for (window in windows()) {
            val at = IntArray(2).also(window::getLocationOnScreen)
            canvas.save(); canvas.translate(at[0].toFloat(), at[1].toFloat()); window.draw(canvas); canvas.restore()
        }
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun says(words: String) = compose.onAllNodesWithText(words, substring = true, useUnmergedTree = true).fetchSemanticsNodes()
        .isNotEmpty().also { assertTrue("on screen: $words", it) }
    private fun waitFor(words: String) = compose.waitUntil(10_000) {
        compose.onAllNodesWithText(words, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    /** Frame 2: the task create card that starts on a condition, as the conversation's catalog makes it. */
    @Test fun frame2TaskCreateCard() {
        val approval = buildJsonObject {
            put("id", "ap-pool"); put("sessionId", "S-pool"); put("toolName", "orbit_task_create"); put("status", "PENDING")
            put("createdAt", Instant.now().toString()); put("input", Fixture.taskCreateInput())
        }
        val card = CardCatalog.session("S-pool", SessionSnapshot(buildJsonObject { put("id", "S-pool") }, listOf(approval), emptyList(),
            emptyList(), emptyMap())).single()
        assertEquals("Create task that starts on a condition?", card.title)
        show { Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) { BusinessCard(card, fresh = true, open = {}, submit = { _, _ -> }) } }
        listOf("Create task that starts on a condition?", "Set kubernetes pool to 3 copies", "Starts when", "3 or more OSDs are in",
            "Once. Checked every 5 min on workstation-gpu, no model.", Fixture.OSD_COMMAND, "Today", "2 in. Not yet.", "If never",
            "Asks you after 30 days of waiting").forEach(::says)
        shot("frame-2-task-create-card")
    }

    /** Frame 3: the schedule create card with a WHEN rule, and the card for a new probe command, in their conversations. */
    @Test fun frame3ScheduleCreateCardAndWidenCard() {
        runBlocking { store.loadNow(); store.loadSessionNow("S-cap"); store.loadSessionNow("S-cmd") }
        show {
            val state by store.state.collectAsState()
            Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) {
                ScheduleInsert.of(state, "S-cap").forEach { ScheduleConversationInsert(it, store, "S-cap") {} }
            }
        }
        listOf("Create scheduled task?", "Ceph capacity guard", "Raw used above 90%", " for 10 min",
            "Fires again only after it drops below 85%. Checked every 5 min on workstation-gpu, no model.", Fixture.GUARD_COMMAND,
            "6.9%. Nothing to report.", "HPC · Claude agent", "Check only", "Up to ", "3 runs a week", "Not now", "Create").forEach(::says)
        shot("frame-3-schedule-create-card")
        show {
            val state by store.state.collectAsState()
            Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) {
                ScheduleInsert.of(state, "S-cmd").forEach { ScheduleConversationInsert(it, store, "S-cmd") {} }
            }
        }
        waitFor("Let Ceph capacity guard check with a new command?")
        listOf(Fixture.GUARD_COMMAND, Fixture.NEW_COMMAND, "Keep the approved command", "Allow",
            "It runs on its own, without a model, every time the condition is checked.").forEach(::says)
        shot("frame-3b-widen-card")
    }

    /** Frame 4: the Scheduled page — "Waiting for a condition" above Today with each row's newest reading and its age, the gauge, and
     * the condition that cannot be read at its head (no Needs you group, owner 2026-11-19). */
    @Test fun frame4ScheduledPage() {
        show { ScheduledPage(store, listOf("a1" to "HPC", "a2" to "apiserver"), "a1", null, {}, {}, {}) }
        waitFor("Waiting for a condition")
        assertEquals("no Needs you group", 0, compose.onAllNodesWithText("Needs you", useUnmergedTree = true).fetchSemanticsNodes().size)
        listOf("Mon disk guard", "Can't read", "When root disk below 5% · HPC", "Ceph capacity guard", "6.9%",
            " · 1 min ago", "When raw used above 90% · HPC", "Set kubernetes pool to 3 copies", "2 in", " · 3 min ago",
            "Task · once, when 3 or more OSDs are in · HPC", "Today", "Release notes draft").forEach(::says)
        compose.onNodeWithTag("scheduled-count", useUnmergedTree = true).assertTextEquals("6")
        assertEquals(3, compose.onAllNodesWithTag("schedule-gauge", useUnmergedTree = true).fetchSemanticsNodes().size)
        shot("frame-4-scheduled-page")
    }

    /** Frame 5: a run its condition started, at the head of its session: the firing in place of a planned time, and its report. */
    @Test fun frame5RunConversationCards() {
        runBlocking { store.loadSessionNow("S-run"); store.loadConditionNow("c-guard") }
        show {
            val state by store.state.collectAsState()
            Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ScheduleInsert.of(state, "S-run").forEach { ScheduleConversationInsert(it, store, "S-run") {} }
            }
        }
        waitFor("Fired 03:12 · 90.4% for 10 min · Check only")
        listOf("Reported: Changed · above-90@", "Raw used 90.4%. Cause: old snapshots in kubernetes.").forEach(::says)
        shot("frame-5-run-header")
    }

    /** Frame 6 ①: the can't-read card (Pause, Look into it) and the 30-day question (Keep waiting, Stop), at the head of the
     * Scheduled page: there is no Waiting on you page (docs/mocks/waiting-on-you-removal). */
    @Test fun frame6ConditionCardsOnTheScheduledPage() {
        val owner = OwnerRequestStore(fixture.auth, handle, scope)
        runBlocking { store.loadNow() }
        owner.load(OwnerRequestStore.OPEN)
        compose.waitUntil(10_000) { owner.state.value.conditionItems.size == 2 }
        val conditionItems = owner.state.value.conditionItems
        show { ScheduledPage(store, listOf("a1" to "HPC"), "a1", null, {}, {}, {}, conditionWaiting = conditionItems) }
        waitFor("Can't read: Root disk below 5%")
        waitFor("Pause")
        listOf("Condition", "The check timed out 3 times in a row.", "Look into it", "Still waiting for 3 or more OSDs are in. Keep waiting?",
            "Keep waiting", "Stop").forEach(::says)
        shot("frame-6a-scheduled-condition-cards")
    }

    /** Frame 6 ② ③: the inspector's Condition and How it checks blocks, and its Fired / Ready again history lines. */
    @Test fun frame6Inspector() {
        show { ScheduledPage(store, listOf("a1" to "HPC"), "a1", "s-guard", {}, {}, {}) }
        waitFor("How it checks".uppercase())
        listOf("CONDITION", "6.9%", "checked 1 min ago", "Fires above 90% for 10 min. Ready again below 85%.", "90%", "85%",
            "Every 5 min on workstation-gpu, without a model.", Fixture.GUARD_COMMAND, "Read-only. Approved by you on ").forEach(::says)
        shot("frame-6b-inspector")
        compose.onNode(hasScrollAction() and hasAnyDescendant(hasText("HISTORY")))
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.ScrollBy) { it(0f, 1200f) }
        listOf("Ready again · 82.9%", "Fired · 90.4% for 10 min", "Run", "Created · Check only").forEach(::says)
        shot("frame-6c-inspector-history")
    }

    /** Tasks: the waiting line on a startWhen task (§6.2). */
    @Test fun theTaskWaitingLine() {
        val startWhen = TaskStartWhenView("c-osd", "3 or more OSDs are in", "in", "WAITING", 2.0, Instant.now().minusSeconds(180).toString(),
            null, "Waiting for: 3 or more OSDs are in")
        show { Column(Modifier.padding(16.dp)) { TaskWaitingLine(startWhen) } }
        listOf("Waiting for: 3 or more OSDs are in", "2 in · 3 min ago").forEach(::says)
        shot("extra-task-waiting-line")
    }

    /** The iOS probe's data (stub.py), served as the doors answer it: times worked out at each read. */
    private class Fixture {
        val calls = CopyOnWriteArrayList<String>()

        private val server = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val path = request.requestUrl!!.encodedPath
                    calls += "${request.method} $path"
                    fun json(body: Any) = MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json").setBody(body.toString())
                    if (request.method != "GET" && path != "/api/auth/login") return MockResponse().setResponseCode(409).setBody("""{"message":"read-only fixture"}""")
                    return when (path) {
                        "/api/auth/login" -> json("""{"accessToken":"or-access","refreshToken":"or-refresh","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                        "/api/schedules" -> json(buildJsonObject { put("schedules", JsonArray(schedules())); putJsonArray("runs") {}
                            put("waitingTasks", JsonArray(listOf(waitingTask()))) })
                        "/api/schedules/drafts" -> json("""{"drafts":[]}""")
                        "/api/schedules/s-guard" -> json(guardDetail())
                        "/api/conditions/c-guard", "/api/conditions/c-mon", "/api/conditions/c-osd" -> json(condition(path.substringAfterLast('/')))
                        "/api/owner-requests" -> json(buildJsonObject { put("requests",
                            if (request.requestUrl!!.queryParameter("state") in setOf("open", "all", null)) JsonArray(ownerRequests()) else JsonArray(emptyList())) })
                        "/api/projects" -> json("[]")
                        "/api/terminals/requests" -> json("""{"requests":[]}""")
                        "/api/account-secrets" -> json("""{"secrets":[]}""")
                        "/api/sessions/S-cap/schedule-cards" -> json(buildJsonObject { put("run", JsonNull); put("cards", JsonArray(listOf(createCard()))); putJsonArray("records") {} })
                        "/api/sessions/S-cmd/schedule-cards" -> json(buildJsonObject { put("run", JsonNull); put("cards", JsonArray(listOf(widenCard()))); putJsonArray("records") {} })
                        "/api/sessions/S-run/schedule-cards" -> json(buildJsonObject { put("run", guardRun()); putJsonArray("cards") {}; putJsonArray("records") {} })
                        else -> MockResponse().setResponseCode(404).setBody("{}")
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

        companion object {
            const val GUARD_COMMAND = "ceph df -f json | jq .stats.total_used_raw_ratio"
            const val NEW_COMMAND = "ceph df -f json | jq '.stats.total_used_raw_bytes / .stats.total_bytes * 100'"
            const val OSD_COMMAND = "ceph osd stat -f json | jq .num_in_osds"
            private val SH: ZoneId = ZoneId.of("Asia/Shanghai")
            private val started: Instant = Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MINUTES)

            private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
            private fun before(minutes: Long) = started.minusSeconds(minutes * 60).toString()
            private fun localToday(hour: Int, minute: Int, days: Long = 0) =
                ZonedDateTime.now(SH).withHour(hour).withMinute(minute).withSecond(0).withNano(0).plusDays(days).toInstant().toString()
            /** The guard's firing: 03:12 Shanghai, four days ago. */
            private fun firedAt() = localToday(3, 12, -4)

            private fun guardCondition(command: String = GUARD_COMMAND) = buildJsonObject {
                put("text", "Raw used above 90%"); put("command", command)
                putJsonObject("compare") { put("op", "GT"); put("value", 90) }; put("holdSeconds", 600)
                putJsonObject("rearm") { put("op", "LT"); put("value", 85) }; put("intervalSeconds", 300); put("unit", "%")
                put("timeoutSeconds", 20); put("repeatSeconds", JsonNull)
            }
            private fun guardRule(id: String? = "c-guard", command: String = GUARD_COMMAND) = buildJsonObject {
                put("kind", "WHEN"); put("conditionId", id); put("runsPerWeek", 3); put("condition", guardCondition(command))
            }
            private val monRule = buildJsonObject {
                put("kind", "WHEN"); put("conditionId", "c-mon"); put("runsPerWeek", 3)
                putJsonObject("condition") {
                    put("text", "Root disk below 5%"); put("command", "df --output=pcent / | tail -1 | tr -dc 0-9")
                    putJsonObject("compare") { put("op", "LT"); put("value", 5) }; put("unit", "%")
                }
            }

            private fun schedule(id: String, title: String, rule: JsonObject, workspace: String = "a1", workspaceName: String = "HPC",
                nextDue: String? = null, condition: JsonObject? = null, lastRun: JsonObject? = null) = buildJsonObject {
                val runs = (rule["runsPerWeek"] as? JsonPrimitive)?.intOrNull ?: 7
                put("id", id); put("title", title); put("intent", title); put("prompt", title); put("rule", rule); put("timezone", "Asia/Shanghai")
                put("workspaceId", workspace); put("workspaceName", workspaceName); put("accessLevel", "CHECK_ONLY"); put("runLimitMinutes", 30)
                put("runsPerWeek", runs)
                putJsonObject("envelope") { put("workspaceId", workspace); put("accessLevel", "CHECK_ONLY"); put("runsPerWeek", runs)
                    put("runLimitMinutes", 30); put("commandHash", if (rule["kind"]?.jsonPrimitive?.content == "WHEN") "a1b2" else null) }
                put("state", "ACTIVE"); put("revision", 1); put("nextDueAt", nextDue); put("consecutiveFailures", 0)
                put("createdFromSessionId", "S-cap"); put("createdAt", before(4 * 24 * 60)); put("lastRun", lastRun ?: JsonNull)
                put("condition", condition ?: JsonNull)
            }

            fun schedules() = listOf(
                schedule("s-guard", "Ceph capacity guard", guardRule(), condition = buildJsonObject {
                    put("id", "c-guard"); put("text", "Raw used above 90%"); put("unit", "%"); put("state", "WAITING"); put("lastValue", 6.9)
                    put("lastSampleAt", ago(1)) }),
                schedule("s-mon", "Mon disk guard", monRule, condition = buildJsonObject {
                    put("id", "c-mon"); put("text", "Root disk below 5%"); put("unit", "%"); put("state", "UNKNOWN"); put("lastValue", 5)
                    put("lastSampleAt", ago(16)) }),
                schedule("s-codex", "Codex stable check", buildJsonObject { put("kind", "DAILY"); put("time", "10:00") }, "a2", "apiserver",
                    localToday(10, 0, 1)),
                schedule("s-notes", "Release notes draft", buildJsonObject { put("kind", "DAILY"); put("time", "17:00") }, "a2", "apiserver",
                    localToday(17, 0)),
                schedule("s-sweep", "Nightly pg spec sweep", buildJsonObject { put("kind", "DAILY"); put("time", "02:00") }, "a2", "apiserver",
                    localToday(2, 0, 1)),
            )

            fun waitingTask() = buildJsonObject {
                put("id", "t-osd"); put("title", "Set kubernetes pool to 3 copies"); put("workspaceId", "a1"); put("workspaceName", "HPC")
                putJsonObject("condition") { put("id", "c-osd"); put("text", "3 or more OSDs are in"); put("unit", "in"); put("state", "WAITING")
                    put("lastValue", 2); put("lastSampleAt", ago(3)) }
            }

            fun guardRun() = buildJsonObject {
                val at = firedAt()
                val key = "above-90@" + DateTimeFormatter.ofPattern("MMM d", Locale.ROOT).format(Instant.parse(at).atZone(SH))
                put("id", "r-guard"); put("scheduleId", "s-guard"); put("scheduleRevision", 1); put("plannedAt", at); put("trigger", "CONDITION")
                put("state", "CHANGED"); put("attempt", 1); put("startedAt", at); put("endedAt", Instant.parse(at).plusSeconds(9 * 60).toString())
                put("sessionId", "S-run"); put("key", key); put("summary", "Raw used 90.4%. Cause: old snapshots in kubernetes.")
                putJsonObject("session") { put("id", "S-run"); put("state", "OPEN") }
            }

            fun condition(id: String): JsonObject {
                val fired = firedAt()
                val ready = Instant.parse(fired).plusSeconds(((24 + 6) * 60 + 28) * 60L).toString()
                return buildJsonObject {
                    put("id", id); put("workspaceId", "a1"); put("approvedAt", before(4 * 24 * 60)); put("keepsWorkspaceAwake", false)
                    put("runnerName", "workstation-gpu"); putJsonArray("samples") {}; put("intervalSeconds", 300)
                    when (id) {
                        "c-guard" -> {
                            put("text", "Raw used above 90%"); put("unit", "%")
                            putJsonObject("probe") { put("command", GUARD_COMMAND); put("timeoutSeconds", 20) }
                            putJsonObject("compare") { put("op", "GT"); put("value", 90) }; put("holdSeconds", 600)
                            putJsonObject("rearm") { put("op", "LT"); put("value", 85) }; put("state", "WAITING")
                            put("lastSampleAt", ago(1)); put("lastValue", 6.9); put("lastReadAt", ago(1)); put("firedAt", fired); put("scheduleId", "s-guard")
                            putJsonArray("events") {
                                addJsonObject { put("at", ready); put("kind", "READY_AGAIN"); put("value", 82.9); put("runId", JsonNull); put("repeat", false) }
                                addJsonObject { put("at", fired); put("kind", "FIRED"); put("value", 90.4); put("runId", "r-guard"); put("repeat", false) }
                            }
                        }
                        "c-mon" -> {
                            put("text", "Root disk below 5%"); put("unit", "%")
                            putJsonObject("probe") { put("command", "df --output=pcent / | tail -1 | tr -dc 0-9"); put("timeoutSeconds", 20) }
                            putJsonObject("compare") { put("op", "LT"); put("value", 5) }; put("state", "UNKNOWN"); put("lastValue", 5)
                            put("lastReadAt", ago(16)); put("unknownReason", "TIMEOUT"); put("failedChecks", 3); put("scheduleId", "s-mon")
                            putJsonArray("events") {}
                        }
                        else -> {
                            put("text", "3 or more OSDs are in"); put("unit", "in")
                            putJsonObject("probe") { put("command", OSD_COMMAND); put("timeoutSeconds", 20) }
                            putJsonObject("compare") { put("op", "GTE"); put("value", 3) }; put("state", "WAITING"); put("lastValue", 2)
                            put("lastReadAt", ago(3)); put("taskId", "t-osd"); putJsonArray("events") {}
                        }
                    }
                }
            }

            fun guardDetail() = buildJsonObject {
                val s = schedules()[0]
                put("schedule", s); put("lastRun", JsonNull); put("recentRuns", JsonArray(listOf(guardRun()))); putJsonArray("findings") {}
                putJsonObject("usage") { put("since", before(30 * 24 * 60)); put("runs", 1); put("minutes", 12) }
                putJsonArray("history") { addJsonObject {
                    put("scheduleId", "s-guard"); put("title", "Ceph capacity guard"); put("revision", 1); put("changedBy", "USER")
                    put("sessionId", "S-cap"); put("before", JsonNull)
                    putJsonObject("after") { put("accessLevel", "CHECK_ONLY"); put("envelope", s["envelope"]!!) }
                    put("createdAt", before(4 * 24 * 60))
                } }
                putJsonArray("pendingCards") {}
            }

            fun ownerRequests() = listOf(
                buildJsonObject {
                    put("id", "o-mon"); put("kind", "CONDITION_UNKNOWN"); put("state", "PENDING"); put("title", "Can't read: Root disk below 5%")
                    put("why", "The check timed out 3 times in a row. The last reading was 5%, 16 minutes ago. It does not fire while it cannot be " +
                        "read, and its hold starts over. This closes by itself when a check reads again.")
                    put("conditionId", "c-mon"); put("workspaceId", "a1"); put("askedBySessionId", "S-cap"); putJsonArray("blocksTaskIds") {}
                    put("createdAt", ago(1))
                },
                buildJsonObject {
                    put("id", "o-osd"); put("kind", "CONDITION_STILL_WAITING"); put("state", "PENDING")
                    put("title", "Still waiting for 3 or more OSDs are in. Keep waiting?")
                    put("why", "This task starts when 3 or more OSDs are in, and that has not held in 30 days. Keep waiting asks again in 30 days. " +
                        "Stop ends the check; the task stays open, and you can start it yourself.")
                    putJsonArray("options") {
                        addJsonObject { put("label", "Keep waiting"); put("description", "Ask again in 30 days.") }
                        addJsonObject { put("label", "Stop"); put("description", "End the check. The task stays open.") }
                    }
                    put("recommendedOption", 0); put("conditionId", "c-osd"); put("workspaceId", "a1"); put("askedBySessionId", "S-pool")
                    putJsonArray("blocksTaskIds") {}; put("createdAt", ago(40))
                },
            )

            fun taskCreateInput() = buildJsonObject {
                put("title", "Set kubernetes pool to 3 copies"); put("assigneeId", "a1")
                put("description", "When a third OSD is in, I check the cluster again and propose setting kubernetes to size 3. Nothing changes " +
                    "until you approve.")
                put("acceptanceCriteria", "The kubernetes pool reads size 3 after the owner approved the change.")
                put("completionCriterion", "OWNER_CONFIRMED")
                putJsonObject("startWhen") { put("text", "3 or more OSDs are in"); put("command", OSD_COMMAND)
                    putJsonObject("compare") { put("op", "GTE"); put("value", 3) }; put("unit", "in"); putJsonObject("baseline") { put("value", 2) } }
                putJsonObject("preview") {
                    put("taskCount", 1); put("startingNow", 0); put("blocked", 0); put("needsManualStart", 0); put("notDispatchable", 0)
                    put("scheduled", 0); put("waitingForCondition", 1); put("awaitingProjectStart", 0); putJsonArray("lists") {}
                    putJsonArray("tasks") { addJsonObject {
                        put("title", "Set kubernetes pool to 3 copies")
                        putJsonObject("startWhen") {
                            put("startsWhen", "3 or more OSDs are in"); put("checked", "Once. Checked every 5 min on workstation-gpu, no model.")
                            put("command", OSD_COMMAND); put("today", "2 in. Not yet."); put("ifNever", "Asks you after 30 days of waiting")
                            put("awake", JsonNull)
                        }
                    } }
                }
            }

            fun createCard() = buildJsonObject {
                put("id", "q-cap"); put("kind", "CREATE"); put("state", "PENDING"); put("askedBy", "SESSION"); put("askedBySessionId", "S-cap")
                put("createdAt", before(5)); putJsonObject("decision") { put("allow", "Create"); put("decline", "Not now") }
                put("title", "Ceph capacity guard")
                put("readBack", "Whenever Ceph's raw use goes above 90%, I look at what is using the space and propose what to clear. I tell " +
                    "you each time it crosses.")
                put("intent", "Tell me when Ceph's raw use goes above 90%, and look at what can be cleared.")
                putJsonObject("when") {
                    put("rule", guardRule(null)); put("timezone", JsonNull); put("firstRunAt", JsonNull)
                    putJsonObject("condition") {
                        put("text", "Raw used above 90% for 10 min")
                        put("detail", "Fires again only after it drops below 85%. Checked every 5 min on workstation-gpu, no model.")
                        put("command", GUARD_COMMAND); put("repeat", JsonNull); put("awake", JsonNull)
                    }
                }
                putJsonObject("runsIn") { put("workspaceId", "a1"); put("workspaceName", "HPC"); put("engine", "claude") }
                putJsonObject("may") { put("accessLevel", "CHECK_ONLY") }
                putJsonObject("costs") { put("runsPerWeek", 3); put("runLimitMinutes", 30) }
                putJsonObject("today") { put("key", "below-90"); put("summary", "6.9%. Nothing to report.") }
                put("notice", "You'll hear when it crosses 90%, and if Ceph can't be read.")
            }

            fun widenCard() = buildJsonObject {
                val lines = buildJsonObject {
                    putJsonObject("runsIn") { put("workspaceId", "a1"); put("workspaceName", "HPC"); put("engine", "claude") }
                    putJsonObject("may") { put("accessLevel", "CHECK_ONLY") }
                    putJsonObject("costs") { put("runsPerWeek", 3); put("runLimitMinutes", 30) }
                }
                put("id", "q-cmd"); put("kind", "UPDATE"); put("state", "PENDING"); put("askedBy", "SESSION"); put("askedBySessionId", "S-cmd")
                put("scheduleId", "s-guard"); put("createdAt", before(3)); put("title", "Ceph capacity guard")
                putJsonObject("decision") { put("allow", "Allow"); put("decline", "Keep the approved command") }
                putJsonObject("proposed") { put("rule", guardRule("c-guard", NEW_COMMAND)) }
                putJsonObject("envelope") { putJsonArray("widens") { add("PROBE_COMMAND") }; put("now", lines); put("asked", lines) }
            }
        }
    }
}
