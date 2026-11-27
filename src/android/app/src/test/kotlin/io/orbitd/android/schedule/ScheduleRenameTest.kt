package io.orbitd.android.schedule

import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.ui.OrbitTheme
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Rename… on the Scheduled page (docs/scheduled-tasks-design.md §8.4 *Rename*; board docs/mocks/schedule-rename ② of the phone): the
 * production page over a loopback server: a row's long-press menu, the detail sheet's ⋯, the request the server gets and the History
 * line. The dialog itself is driven on a device (`ScheduleRenameDeviceTest`): Robolectric never goes idle over a dialog window that
 * holds a text field.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScheduleRenameTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val old = "US app 1070 check"
    private val new = "US app 1070 data readiness"
    @Volatile private var title = old
    @Volatile private var state = "ACTIVE"
    private val writes = CopyOnWriteArrayList<String>()

    private fun schedule() = """{"id":"s1","title":"$title","intent":"Check it every morning","rule":{"kind":"DAILY","time":"09:07"},
        "timezone":"UTC","workspaceId":"w","workspaceName":"tea-cli","accessLevel":"CHECK_ONLY","state":"$state","revision":2,
        "nextDueAt":"2099-01-01T09:07:00.000Z","lastRun":{"id":"r1","scheduleId":"s1","plannedAt":"2026-11-25T09:07:00.000Z",
        "state":"NO_CHANGE","sessionId":"run-session"}}"""

    private fun history() = if (title == old) "" else """{"scheduleId":"s1","title":"$title","revision":2,"changedBy":"USER",
        "before":{"title":"$old"},"after":{"title":"$title"},"createdAt":"2026-11-26T01:00:00.000Z",
        "undo":{"path":"/api/schedules/s1/undo","body":{"revision":2}}}"""

    private val server = MockWebServer().apply {
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                fun json(body: String) = MockResponse().setHeader("Content-Type", "application/json").setBody(body)
                if (request.method != "GET" && path != "/api/auth/login") {
                    val body = request.body.readUtf8()
                    writes += "${request.method} $path $body"
                    if (path == "/api/schedules/s1/rename") title = body.substringAfter(":\"").substringBeforeLast('"')
                    return json("""{"outcome":"APPLIED"}""")
                }
                return when (path) {
                    "/api/auth/login" -> json("""{"accessToken":"a","refreshToken":"r","user":{"id":"u","email":"u@example.test","name":"U"}}""")
                    "/api/schedules" -> json("""{"schedules":[${schedule()}],"runs":[]}""")
                    "/api/schedules/drafts" -> json("""{"drafts":[]}""")
                    "/api/schedules/s1" -> json("""{"schedule":${schedule()},"recentRuns":[],"findings":[],"history":[${history()}],"pendingCards":[]}""")
                    else -> MockResponse().setResponseCode(404).setBody("{}")
                }
            }
        }
        start()
    }

    private val auth = AuthSession(OkHttpTransport(), object : CredentialStore {
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
    private lateinit var store: ScheduledStore

    @Before fun setUp() {
        val handle = runBlocking {
            auth.login(ServerAddress.parse(server.url("/").toString(), allowLoopbackHttp = true), "u@example.test", "fixture-password")
        }
        store = ScheduledStore(auth, handle, scope)
    }

    @After fun tearDown() { scope.cancel(); runBlocking { auth.logout() }; server.shutdown() }

    private fun show() {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            ScheduledPage(store, listOf("w" to "tea-cli"), "w", null, openSession = {}, openRun = {}, change = {})
        } } }
        waitFor(hasText(old))
    }

    private fun waitFor(matcher: SemanticsMatcher) = compose.waitUntil(10_000) {
        compose.onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    private fun tag(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true)

    /** The open menu's items, top to bottom, by their words. */
    private fun menu(vararg tags: String): List<String> {
        val nodes = compose.onAllNodes(SemanticsMatcher("a schedule menu item") { node ->
            node.config.getOrNull(SemanticsProperties.TestTag)?.let { it.startsWith("schedule-menu-") || it.startsWith("schedule-detail-") &&
                it in tags } == true
        }, useUnmergedTree = false).fetchSemanticsNodes().sortedBy { it.positionInRoot.y }
        return nodes.map { node -> node.config[SemanticsProperties.Text].joinToString { it.text } }
    }

    @Test fun aLongPressOffersTheIPhonesMenuInItsOrder() {
        show()
        compose.onNodeWithTag("schedule-row").performTouchInput { longClick() }
        waitFor(hasTestTag("schedule-menu-rename"))
        assertEquals(listOf("Run now", "Pause", "Rename…", "Change…", "Open last run", "Delete"), menu())
        assertEquals(emptyList<String>(), writes)
    }

    @Test fun aHeldScheduleOffersResumeAndNoRunNow() {
        state = "HELD"
        show()
        compose.onNodeWithTag("schedule-row").performTouchInput { longClick() }
        waitFor(hasTestTag("schedule-menu-rename"))
        assertEquals(listOf("Resume", "Rename…", "Change…", "Open last run", "Delete"), menu())
    }

    @Test fun aRenameSendsTheTrimmedTitleAndReadsTheScheduleAgain() = runBlocking {
        assertNull(store.rename("s1", "  $new  ", old))
        assertEquals(listOf("""POST /api/schedules/s1/rename {"title":"$new"}"""), writes)
        assertEquals("the row is updated", new, store.state.value.schedule("s1")?.title)
    }

    @Test fun theStoreSendsNothingForAnEmptyOrUnchangedName() = runBlocking {
        for (nothing in listOf("", " \n ", old, " $old ")) assertNull(store.rename("s1", nothing, old))
        assertEquals(emptyList<String>(), writes)
    }

    @Test fun theSheetsMenuOffersRenameAndItsHistorySaysFromWhatWithUndo() {
        show()
        runBlocking { store.rename("s1", new, old) }
        waitFor(hasText(new))
        compose.onNodeWithTag("schedule-row").performClick()
        waitFor(hasText("Renamed from “$old”"))
        tag("schedule-detail-more").performClick()
        waitFor(hasTestTag("schedule-detail-rename"))
        assertEquals(listOf("Rename…", "Delete"), menu("schedule-detail-rename", "schedule-detail-delete"))
        tag("schedule-detail-delete").performClick()
        compose.onNodeWithText("Cancel", useUnmergedTree = true).performClick()
        compose.onNodeWithText("Undo", useUnmergedTree = true).performScrollTo().performClick()
        compose.waitUntil(10_000) { writes.size == 2 }
        assertEquals("""POST /api/schedules/s1/undo {"revision":2}""", writes[1])
    }
}
