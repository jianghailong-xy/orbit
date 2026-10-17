package io.orbitd.android.wiki

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import io.orbitd.android.toast.ToastHost

/** The screenshots of the Wiki under server execution (P9, mock 35): the settings page and Set up, the Runs band and
 * a run's page, drawn from fake reads and written to PNGs under `src/android/build/evidence/wiki-android-server-execution/`.
 * Compose/Robolectric shots with the fixture's data, not a deployment (the production shots are P10's); the same
 * pages the device run opens, and every read the pages draw comes from the shared fixture. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1400dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WikiServerExecutionShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val space = WikiFixtures.spaceID
    private val server = "https://fixture.test"

    private val output: File by lazy {
        File(WikiSharedFiles.file("src/shared/src/wiki-server-execution.fixture.json").parentFile.parentFile.parentFile.parentFile,
            "src/android/build/evidence/wiki-android-server-execution").also { it.mkdirs() }
    }

    /** The space as the server keeps it while it executes the wiki: maintenance on, the System model in place of the
     * provider, and a workspace to read the repository from. */
    private val spaceRead = """{"id":"$space","slug":"orbit","repoUrlNorm":"github.com/jianghailong-xy/orbit",
        "rootCommitSha":"${WikiFixtures.sha}","pendingOps":3,
        "settings":{"reviewMode":"automatic","maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm","dailyRunLimit":8,"lookbackDays":14}}}"""

    private val systemModel = """{"state":"up","model":"qwen3.8-27b-fp8","since":"2026-10-08T06:00:00.000Z",
        "checkedAt":"2026-10-08T06:29:55.000Z","workerSeenAt":"2026-10-08T06:29:55.000Z",
        "executor":{"mode":"server","serverExecutes":true}}"""

    private val health = """{"spaceId":"$space","entries":11689,
        "maintenance":{"look":"ok","enabled":true,"lastOkAt":"2026-10-08T06:00:00.000Z","lastRunAt":"2026-10-08T06:00:00.000Z",
          "consecutiveFailures":0,"backlog":6,"oldestPendingAt":"2026-10-08T06:20:00.000Z","lagSeconds":2400,
          "dailyLimitReached":false,"held":null,"running":null,
          "lastRun":{"sessionId":null,"jobId":"34cE0job0000000000009","outcome":"succeeded","endedAt":"2026-10-08T06:00:00.000Z"}},
        "repo":{"look":"ready","pending":0},
        "executor":{"mode":"server","serverExecutes":true},
        "systemModel":{"state":"up","model":"qwen3.8-27b-fp8","since":"2026-10-08T06:00:00.000Z",
          "checkedAt":"2026-10-08T06:29:55.000Z","workerSeenAt":"2026-10-08T06:29:55.000Z"}}"""

    /** The fixture's runs, with ids of their own: one running with its calls under way, one queued, one done. */
    private fun jobsRead(): String {
        val cases = WikiSharedFiles.serverExecution.fobj("runs").farr("cases").map { it.jsonObject }
        fun case(name: String) = cases.first { it["name"]!!.jsonPrimitive.content == name }.getValue("job").jsonObject
        fun withId(job: JsonObject, id: String) = JsonObject(job + ("id" to JsonPrimitive(id)))
        val running = withId(case("running: its calls ended so far, and the next call's place in the queue"), "34cE0job0000000000001")
        // The running run's own newest calls, so its page lists them.
        val calls = WikiSharedFiles.serverExecution.fobj("runs").farr("calls").map { it.jsonObject.getValue("call") }
        val runningWithCalls = JsonObject(running + ("requests" to JsonArray(calls.take(3))) +
            ("calls" to buildJsonObject { put("total", 3); put("queued", 1); put("running", 1); put("succeeded", 1)
                put("failed", 0); put("cancelled", 0); put("inputTokens", 1204); put("outputTokens", 296) }))
        val queued = withId(case("queued: the runs the workers take first, and how long it has waited"), "34cE0job0000000000002")
        val done = withId(case("done: its calls, the tokens they spent, and how long it took"), "34cE0job0000000000003")
        val failed = withId(case("failed: the first line of why, and its calls"), "34cE0job0000000000004")
        return buildJsonObject { put("spaceId", space); put("jobs", JsonArray(listOf(runningWithCalls, queued, done, failed))) }.toString()
    }

    private val sent = mutableListOf<String>()
    private fun respond(api: ApiRequest): ApiResponse {
        val path = api.path.joinToString("/")
        sent += "${api.method} $path"
        fun ok(json: String) = ApiResponse(200, json.encodeToByteArray())
        return when {
            path == "auth/login" -> ok("""{"accessToken":"a","refreshToken":"r","user":{"id":"u","email":"u@example.test","name":"U"}}""")
            path == "wiki/spaces" -> ok("[$spaceRead]")
            path == "wiki/spaces/$space" -> ok(spaceRead)
            path == "wiki/spaces/$space/entries" -> ok(WikiFixtures.entries)
            path == "wiki/spaces/$space/timeline" -> ok(WikiFixtures.timeline)
            path == "wiki/spaces/$space/health" -> ok(health)
            path == "wiki/spaces/$space/jobs" -> ok(jobsRead())
            path == "wiki/system-model" -> ok(systemModel)
            path == "wiki/review" -> ok("[]")
            path == "workspaces" -> ok("""[{"id":"w1","name":"orbit","runnerId":"r1"}]""")
            path == "runners" -> ok("""[{"id":"r1","name":"host-1","displayName":"Mac mini"}]""")
            path == "providers" -> ok("""[{"slug":"local-vllm","runtime":"claude","defaultModel":"qwen3.8-27b-fp8","models":[]}]""")
            path == "link-previews" -> ok("""{"previews":[]}""")
            else -> ApiResponse(404, "{}".encodeToByteArray())
        }
    }

    private fun store(): WikiStore = runBlocking {
        val auth = AuthSession(HttpTransport { respond(it.api) }, object : CredentialStore {
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
        }, "test")
        auth.login(ServerAddress.parse(server), "u@example.test", "password")
        WikiStore(auth, (auth.state.value as AuthState.SignedIn).handle, CoroutineScope(SupervisorJob() + Dispatchers.Main))
    }

    private val nav = WikiNav({}, {}, server) {}

    /** A block that is not one node to TalkBack (a card, a field) says each of [texts] in one of its lines. */
    private fun says(tag: String, vararg texts: String) = texts.forEach { text ->
        assertTrue("$tag does not say “$text”", compose.onAllNodes((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and
            hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }

    private fun show(route: OrbitRoute, screen: @androidx.compose.runtime.Composable (WikiStore) -> Unit) {
        val store = store()
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme { Box { screen(store); ToastHost({}, {}, {}) } } } }
        compose.waitForIdle()
    }

    /** The screen as a PNG, and never a blank one: a shot that drew nothing fails here rather than being committed.
     * The semantics tree on screen goes beside it, so what the picture holds is readable without looking at it. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText(
            (0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out (${view.width}×${view.height})", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank — the graphics mode drew nothing", pixels.any { it != 0 })
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("$name: no PNG was written", file.length() > 0)
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
        bitmap.recycle()
    }

    @Test fun theServerExecutionShots() {
        // ① the settings page: no provider, the System model read-only with its state, the privacy note.
        val settings = OrbitRoute(Destination.WIKI_SETTINGS)
        show(settings) { WikiSettingsScreen(it, settings, DirectoryData(), nav) }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("wiki-settings-model-row").fetchSemanticsNodes().isNotEmpty() }
        says("wiki-settings-workspace-row", WikiModeCopy.repoFrom, "orbit · Mac mini")
        says("wiki-settings-model-row", WikiRunsCopy.systemModelLabel("qwen3.8-27b-fp8"), WikiRunsCopy.modelState("up"))
        compose.onAllNodesWithTag("wiki-settings-provider-row").assertCountEquals(0)
        compose.onNodeWithTag("wiki-settings-privacy").assertTextContains(WikiModeCopy.privacyNote)
        shot("settings-server")

        // ② the Runs band on Activity (the Wiki page's management half since A12-2), after Review and Plan.
        val activity = OrbitRoute(Destination.WIKI_ACTIVITY)
        show(activity) { WikiActivityScreen(it, activity, DirectoryData(), nav) }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("wiki-job-row").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("wiki-activity-list").performScrollToIndex(3)
        compose.onNodeWithTag("wiki-activity-list").performScrollToNode(hasText(WikiRunsCopy.systemModelLabel("qwen3.8-27b-fp8")))
        val rows = compose.onAllNodesWithTag("wiki-job-row")
        assertTrue("the band lists the runs", rows.fetchSemanticsNodes().size >= 4)
        rows[0].assertTextContains(WikiRunsCopy.running, substring = true)
        shot("runs-server")

        // ③ a run's page: its state and line, then each call.
        val run = OrbitRoute(Destination.WIKI_JOB, "34cE0job0000000000001")
        show(run) { WikiJobScreen(it, run) }
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("wiki-job-page").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithTag("wiki-call-row").assertCountEquals(3)
        compose.onNodeWithTag("wiki-job-page").performScrollToNode(hasText("waited 1s · ran 14s · 1,204 → 296 tokens"))
        shot("run-server")
    }
}
