package io.orbitd.android

import android.util.Log
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.core.app.ActivityScenario
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.LoginResponse
import io.orbitd.android.core.protocol.User
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
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
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

/** P01 TTFD (A01 D09 v2, DS2): a signed-in cold start is fully drawn once the workspace it lands on shows the rows of a valid
 * snapshot — the copy this device saved, before any read from the server lands, or that first read when there is no copy — and
 * each Activity reports it once. The production Activity, AuthSession and RealtimeStore over [ColdStart]. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ColdStartApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class DirectoryFullyDrawnTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createEmptyComposeRule()
    private lateinit var scenario: ActivityScenario<MainActivity>

    @Before fun start() {
        ColdStart.reset()
        ShadowLog.setLoggable("OrbitPerf", Log.DEBUG)
    }
    @After fun finish() { if (::scenario.isInitialized) scenario.close() }

    @Test fun aSavedListIsFullyDrawnBeforeAnyServerReadLands() {
        ColdStart.cache = ColdStart.CACHED
        launch()
        // The launch lands on the workspace by itself, and its rows are the copy this device saved.
        await { shows("Cached review") }
        draw()
        // The line waits for the frame to finish: on a device the report runs before Compose lays the new rows out.
        assertEquals(emptyList<String>(), perf())
        compose.waitForIdle()
        assertTrue(reported())
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=cache rows=1"), perf())
        // The directory's read is on the wire, and nothing the server could answer has landed.
        assertTrue(ColdStart.sent.toString(), "workspaces" in ColdStart.sent)
        assertFalse(ColdStart.network.isCompleted)
        with((RuntimeEnvironment.getApplication() as OrbitApplication).realtime.state.value) {
            assertTrue(directoryCached); assertFalse(directoryFresh)
        }
    }

    /** A spinner is all the page has while the saved list is still being read: frames are drawn, but with no rows nothing is reported. */
    @Test fun nothingIsFullyDrawnBeforeTheDirectoryHasRows() {
        ColdStart.cache = ColdStart.CACHED
        ColdStart.cacheRead = CompletableDeferred()
        launch()
        await { spinner() }
        repeat(3) { frame() }
        assertFalse(reported())
        assertEquals(emptyList<String>(), perf())
        ColdStart.cacheRead.complete(Unit)
        await { shows("Cached review") }
        frame()
        assertTrue(reported())
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=cache rows=1"), perf())
    }

    /** No copy on the device (a first sign-in, a list past the cap): the first read from the server is what is drawn. */
    @Test fun withoutASavedListTheFirstServerReadIsFullyDrawn() {
        launch()
        await { spinner() }
        repeat(3) { frame() }
        assertFalse(reported())
        assertEquals(emptyList<String>(), perf())
        ColdStart.network.complete(Unit)
        await { shows("Server review") }
        frame()
        assertTrue(reported())
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=network rows=1"), perf())
    }

    /** An account with work running, and no copy on the device: the stream is open and an account event arrives while each read is on
     * the wire. Its rows are still drawn. */
    @Test fun aColdStartWhoseEveryReadAnEventOvertakesStillDrawsItsRows() {
        ColdStart.overtaken = true
        launch()
        await { spinner() }
        ColdStart.network.complete(Unit)
        await { shows("Server review") }
        ColdStart.overtaken = false
    }

    @Test fun eachActivityReportsOnce() {
        ColdStart.cache = ColdStart.CACHED
        launch()
        await { shows("Cached review") }
        frame()
        // The server's read landing does not report again.
        ColdStart.network.complete(Unit)
        await { shows("Server review") }
        frame()
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=cache rows=1"), perf())
        // A recreated Activity has a reporter of its own: it reports once, from the workspace's list it comes back to.
        scenario.recreate()
        await { shows("Server review") }
        frame()
        assertTrue(reported())
        frame()
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=cache rows=1", "v=1 ev=p01_fully_drawn source=network rows=1"), perf())
    }

    /** The line is A15's, off by default: the report itself does not depend on it. */
    @Test fun withTheLogOffTheReportStillComesAndNothingIsLogged() {
        ShadowLog.setLoggable("OrbitPerf", Log.INFO)
        ColdStart.cache = ColdStart.CACHED
        launch()
        await { shows("Cached review") }
        frame()
        assertTrue(reported())
        assertTrue(ShadowLog.getLogsForTag("OrbitPerf").isEmpty())
    }

    /** A device with a network: Robolectric reports none, so the store is told, as the other shell tests do. */
    private fun launch() {
        (RuntimeEnvironment.getApplication() as OrbitApplication).realtime.setNetwork(true, "fixture")
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }
    /** Robolectric runs no draw pass, so this dispatches the draw callbacks a device's frame runs — where the Activity's
     * FullyDrawnReporter calls reportFullyDrawn from — on this, the main thread, and runs nothing posted after them. */
    private fun draw() {
        lateinit var activity: MainActivity
        scenario.onActivity { activity = it }
        activity.window.decorView.viewTreeObserver.dispatchOnDraw()
    }
    /** A frame drawn and finished. */
    private fun frame() {
        draw()
        compose.waitForIdle()
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
    private fun shows(text: String) = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
    private fun spinner() = compose.onAllNodesWithTag("workspaces-loading").fetchSemanticsNodes().isNotEmpty()
    /** The platform's reportFullyDrawn ran, through the Activity's reporter. */
    private fun reported(): Boolean {
        var drawn = false
        scenario.onActivity { drawn = shadowOf(it).reportFullyDrawn && it.fullyDrawnReporter.isFullyDrawnReported }
        return drawn
    }
    /** The p01 lines logged (other collection points share the tag), without their two clocks — which each must end with. */
    private fun perf() = ShadowLog.getLogsForTag("OrbitPerf").filter { it.msg.startsWith("v=1 ev=p01_fully_drawn ") }.map {
        assertTrue(it.msg, it.msg.matches(Regex("v=1 ev=p01_fully_drawn source=\\S+ rows=\\d+ rt=\\d+ mono=\\d+")))
        it.msg.substringBefore(" rt=")
    }
}

/** One signed-in account at a cold start: a stored session to restore, [cache] as the list this device saved (`directory-v1`, as
 * SavedDirectory writes it) or none, [cacheRead] holding the read of it, and a server that answers nothing — not even the stream —
 * until [network] completes. Alpha keeps its id across both answers; the server renamed it. */
internal object ColdStart {
    private const val SERVER = "https://a05g.test/"
    const val ALPHA = "34A05gWorkspace00001"
    const val GAMMA = "34A05gWorkspace00003"
    const val DELTA = "34A05gWorkspace00004"
    private const val RUNNER = """{"id":"r1","name":"Fixture runner","online":true}"""
    @Volatile var cache: String? = null
    /** This device's other records in the account's cache: what the app writes, and a test may have left. */
    val records = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()
    /** The workspaces and runners the server lists, a status it answers `workspaces` with instead, and the account's preferences. */
    @Volatile var server = listOf(ALPHA to "Server Alpha", DELTA to "Server Delta")
    @Volatile var runners = "[$RUNNER]"
    @Volatile var status: Int? = null
    @Volatile var preferences: String? = null
    @Volatile var cacheRead = CompletableDeferred(Unit)
    @Volatile var network = CompletableDeferred<Unit>()
    /** An account event reaches the store while each directory read is on the wire: the read waits for it to be handled. */
    @Volatile var overtaken = false
    private val overtaking = Channel<CompletableDeferred<Unit>>(Channel.UNLIMITED)
    /** The path of every request sent to the server. */
    val sent = CopyOnWriteArrayList<String>()

    fun reset() {
        cache = null; cacheRead = CompletableDeferred(Unit); network = CompletableDeferred(); overtaken = false; sent.clear()
        records.clear(); server = listOf(ALPHA to "Server Alpha", DELTA to "Server Delta"); runners = "[$RUNNER]"; status = null; preferences = null
        while (overtaking.tryReceive().isSuccess) Unit
    }

    private fun workspace(id: String, name: String, position: Int) =
        """{"id":"$id","name":"$name","runnerId":"r1","enabled":true,"position":$position,"createdAt":"2026-10-01T01:00:00.000Z"}"""
    private fun session(id: String, title: String, fields: String = "") = """{"id":"$id","title":"$title","status":"AWAITING_INPUT",
        "runState":"AWAITING_INPUT","lifecycleState":"OPEN","agentId":"$ALPHA","createdAt":"2026-10-08T08:00:00Z",
        "lastTurnAt":"2026-10-09T01:00:00Z","pendingApprovals":0,"tags":[]$fields}"""
    val CACHED = """{"workspaces":[${workspace(ALPHA, "Cached Alpha", 0)},
        ${workspace("34A05gWorkspace00002", "Cached Beta", 1)},${workspace(GAMMA, "Cached Gamma", 2)}],
        "sessions":{"open":[${session("34A05gSessionCached01", "Cached review")}]},
        "folders":[],"tags":[],"runners":[$RUNNER]}"""
    val CACHED_WITH_RECAP = """{"workspaces":[${workspace(ALPHA, "Cached Alpha", 0)}],
        "sessions":{"open":[${session("34A05gSessionCached01", "Cached review", ""","recapText":"The recap","lastAssistantText":"The last reply"""")}]},
        "folders":[],"tags":[],"runners":[$RUNNER]}"""

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())
    private val transport = HttpTransport { request ->
        val path = request.api.path.joinToString("/")
        sent += path
        network.await()
        if (path == "workspaces" && overtaken) CompletableDeferred<Unit>().also { overtaking.send(it) }.await()
        when {
            path == "users/me" -> ok("""{"id":"u1","email":"owner@a05g.test","name":"Owner"${preferences?.let { ""","preferences":$it""" }.orEmpty()}}""")
            path == "workspaces" -> status?.let { ApiResponse(it, "{}".encodeToByteArray()) }
                ?: ok(server.withIndex().joinToString(",", "[", "]") { (index, row) -> workspace(row.first, row.second, index) })
            path == "runners" -> ok(runners)
            path == "sessions" && request.api.query.contains("view" to "open") -> ok("[${session("34A05gSessionServer01", "Server review")}]")
            path.startsWith("wiki/") -> ApiResponse(404, """{"code":"WIKI_DISABLED","message":"The wiki is off."}""".encodeToByteArray())
            request.api.method == HttpMethod.GET -> ok("[]")
            else -> ok("{}")
        }
    }
    private val events = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
            network.await()
            onOpen()
            for (handled in overtaking) {
                onFrame(SseFrame("""{"type":"session.updated","sessionId":"","data":{}}""", null, null))
                handled.complete(Unit)
            }
        }
    }

    fun session() = AuthSession(transport, object : CredentialStore {
        private var value: StoredSession? = StoredSession(SERVER, LoginResponse("a05g-access", "a05g-refresh",
            User("u1", "owner@a05g.test", "Owner")))
        override suspend fun load() = value
        override suspend fun save(session: StoredSession) { value = session }
        override suspend fun clear() { value = null }
    }, object : InstanceStore {
        override suspend fun load() = SERVER
        override suspend fun save(server: String) = Unit
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? {
            if (kind != DataKind.CACHE) return null
            if (key != "directory-v1") return records[key]
            cacheRead.await()
            return cache?.encodeToByteArray()
        }
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { if (kind == DataKind.CACHE) records[key] = bytes }
        override suspend fun clearAll() = Unit
    }, "a05g-cold-start", eventTransport = events)
}

/** The application over [ColdStart] in place of the network and the device's stores. */
class ColdStartApplication : OrbitApplication() {
    override fun createSession(): AuthSession = ColdStart.session()
    // Unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
}
