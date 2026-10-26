package io.orbitd.android

import android.util.Log
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
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
import kotlinx.coroutines.awaitCancellation
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

/** P01 TTFD (A01 D09 v2, DS2): a signed-in cold start is fully drawn once the directory on screen shows the rows of a valid
 * snapshot — the copy this device's cache restored, before any read from the server lands, or that first read when there is
 * no copy — and each Activity reports it once. The production Activity, AuthSession and RealtimeStore over [ColdStart]. */
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

    @Test fun aCachedDirectoryIsFullyDrawnBeforeAnyServerReadLands() {
        ColdStart.cache = ColdStart.CACHED
        launch()
        await { rows(ColdStart.ALPHA) }
        draw()
        // The line waits for the frame to finish: on a device the report runs before Compose lays the new rows out.
        assertEquals(emptyList<String>(), perf())
        compose.waitForIdle()
        assertTrue(reported())
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=cache rows=3"), perf())
        // The directory's read is on the wire, and nothing the server could answer has landed.
        assertTrue(ColdStart.sent.toString(), "workspaces" in ColdStart.sent)
        assertFalse(ColdStart.network.isCompleted)
        assertTrue(shows("Showing saved sessions. Connecting to Orbit…"))
        with((RuntimeEnvironment.getApplication() as OrbitApplication).realtime.state.value) {
            assertTrue(directoryCached); assertFalse(directoryFresh)
        }
        // Its rows are live: a tap opens the workspace's list, from the same copy.
        compose.onNodeWithTag("workspace:${ColdStart.ALPHA}").performClick()
        await { shows("Cached review") }
    }

    /** "Waiting for connection" is all the page has while the cache is still being read: frames are drawn, but with no rows
     * nothing is reported. */
    @Test fun nothingIsFullyDrawnBeforeTheDirectoryHasRows() {
        ColdStart.cache = ColdStart.CACHED
        ColdStart.cacheRead = CompletableDeferred()
        launch()
        await { shows("Waiting for connection") }
        repeat(3) { frame() }
        assertFalse(reported())
        assertEquals(emptyList<String>(), perf())
        ColdStart.cacheRead.complete(Unit)
        await { rows(ColdStart.ALPHA) }
        frame()
        assertTrue(reported())
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=cache rows=3"), perf())
    }

    /** No copy on the device (a first sign-in, a cache that did not restore): the first read from the server is what is drawn. */
    @Test fun withoutACachedCopyTheFirstServerReadIsFullyDrawn() {
        launch()
        await { shows("Loading workspaces and sessions…") }
        repeat(3) { frame() }
        assertFalse(reported())
        assertEquals(emptyList<String>(), perf())
        ColdStart.network.complete(Unit)
        await { shows("Server Alpha") && rows(ColdStart.ALPHA) }
        frame()
        assertTrue(reported())
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=network rows=2"), perf())
    }

    @Test fun eachActivityReportsOnce() {
        ColdStart.cache = ColdStart.CACHED
        launch()
        await { rows(ColdStart.ALPHA) }
        frame()
        // Neither the workspace's own list nor the server's read landing reports again.
        compose.onNodeWithTag("workspace:${ColdStart.ALPHA}").performClick()
        await { shows("Cached review") }
        frame()
        ColdStart.network.complete(Unit)
        await { shows("Server review") }
        frame()
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=cache rows=3"), perf())
        // A recreated Activity has a reporter of its own: it reports once, from the workspace's list it comes back to.
        scenario.recreate()
        await { shows("Server review") }
        frame()
        assertTrue(reported())
        frame()
        assertEquals(listOf("v=1 ev=p01_fully_drawn source=cache rows=3", "v=1 ev=p01_fully_drawn source=network rows=1"), perf())
    }

    /** The line is A15's, off by default: the report itself does not depend on it. */
    @Test fun withTheLogOffTheReportStillComesAndNothingIsLogged() {
        ShadowLog.setLoggable("OrbitPerf", Log.INFO)
        ColdStart.cache = ColdStart.CACHED
        launch()
        await { rows(ColdStart.ALPHA) }
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
    /** The Workspaces page draws [workspace]'s row (the closed drawer, composed off screen, has one of its own). */
    private fun rows(workspace: String) = compose.onAllNodesWithTag("workspace:$workspace").fetchSemanticsNodes().isNotEmpty()
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

/** One signed-in account at a cold start: a stored session to restore, [cache] as the record this device's cache holds
 * (`realtime-v1`, as RealtimeCache writes it) or none, [cacheRead] holding the read of it, and a server that answers nothing —
 * not even the stream — until [network] completes. Alpha keeps its id across both answers; the server renamed it. */
internal object ColdStart {
    private const val SERVER = "https://a05g.test/"
    const val ALPHA = "34A05gWorkspace00001"
    private const val RUNNER = """{"id":"r1","name":"Fixture runner","online":true}"""
    @Volatile var cache: String? = null
    @Volatile var cacheRead = CompletableDeferred(Unit)
    @Volatile var network = CompletableDeferred<Unit>()
    /** The path of every request sent to the server. */
    val sent = CopyOnWriteArrayList<String>()

    fun reset() { cache = null; cacheRead = CompletableDeferred(Unit); network = CompletableDeferred(); sent.clear() }

    private fun workspace(id: String, name: String, position: Int) =
        """{"id":"$id","name":"$name","runnerId":"r1","enabled":true,"position":$position,"createdAt":"2026-10-01T01:00:00.000Z"}"""
    private fun session(id: String, title: String) = """{"id":"$id","title":"$title","status":"AWAITING_INPUT",
        "runState":"AWAITING_INPUT","lifecycleState":"OPEN","agentId":"$ALPHA","createdAt":"2026-10-08T08:00:00Z",
        "lastTurnAt":"2026-10-09T01:00:00Z","pendingApprovals":0,"tags":[]}"""
    val CACHED = """{"schema":1,"directory":{"workspaces":[${workspace(ALPHA, "Cached Alpha", 0)},
        ${workspace("34A05gWorkspace00002", "Cached Beta", 1)},${workspace("34A05gWorkspace00003", "Cached Gamma", 2)}],
        "sessions":{"open":[${session("34A05gSessionCached01", "Cached review")}],"completed":[],"trash":[]},
        "folders":[],"tags":[],"runners":[$RUNNER]}}"""

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())
    private val transport = HttpTransport { request ->
        val path = request.api.path.joinToString("/")
        sent += path
        network.await()
        when {
            path == "users/me" -> ok("""{"id":"u1","email":"owner@a05g.test","name":"Owner"}""")
            path == "workspaces" -> ok("[${workspace(ALPHA, "Server Alpha", 0)},${workspace("34A05gWorkspace00004", "Server Delta", 1)}]")
            path == "runners" -> ok("[$RUNNER]")
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
            awaitCancellation()
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
            if (kind != DataKind.CACHE || key != "realtime-v1") return null
            cacheRead.await()
            return cache?.encodeToByteArray()
        }
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
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
