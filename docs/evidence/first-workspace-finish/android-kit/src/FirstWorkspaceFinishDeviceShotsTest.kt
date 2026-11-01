package io.orbitd.android

import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.AnnotatedString
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.composer.MachineSetupCopy
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/**
 * Emulator frames for task 34pSMchIBHSRImnxiCxuk (the setup card's finishing touches) on the shared API 36 emulator
 * (`emulator-5554`), against a controlled MockWebServer inside the instrumentation. Adapted from
 * docs/evidence/first-workspace-android/kit (task 34pLtXumbawMl6II4gUPa).
 *
 * 1. `f1-connecting`: a machine approved a moment ago and never heard from (offline, no heartbeat, nothing declared) is
 *    waited for, not said to update itself, and its folder step is closed.
 * 2. `f1-connected`: its first heartbeat, found by the page's own reads: the folder step opens.
 * 3. `f6-new-folder-exists`: a new folder's name already a folder at `<reposRoot>/<name>` is said to be used as it is.
 * 4. `f6-new-folder-file`: a name that is a file there can't be one, and says why.
 */
@RunWith(AndroidJUnit4::class)
class FirstWorkspaceFinishDeviceShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val calls = CopyOnWriteArrayList<String>()
    private val bodies = CopyOnWriteArrayList<Pair<String, String>>()

    private val runnerId = "34FwfShotsRunnerAustin"
    private val register = "/home/orbit/code/app"
    @Volatile private var connecting = true
    @Volatile private var asked: String? = null
    private val now get() = Instant.now()

    @Test fun setupCardFinishOnEmulator() {
        compose.waitUntil(15_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)

        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            runBlocking {
                app.session.login(ServerAddress.parse(server.url("/").toString(), true), "owner@orbit.test", "controlled-fixture")
            }
            compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

            // Nothing online yet: Machines & models, then the machine's Start a session.
            awaitText("orbit@austin")
            click(hasText("orbit@austin") and hasClickAction())
            awaitText(MachineSetupCopy.START_A_SESSION)
            click(hasText(MachineSetupCopy.START_A_SESSION) and hasClickAction())

            // Scene 1: waited for, in the card's own words.
            awaitText(MachineSetupCopy.setupConnecting("orbit@austin"))
            assertEquals(0, compose.onAllNodesWithText("updates itself first", substring = true).fetchSemanticsNodes().size)
            assertEquals(0, compose.onAllNodesWithText("is offline", substring = true).fetchSemanticsNodes().size)
            compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsNotEnabled()
            assertFalse("a machine still connecting is asked nothing", calls.any { it.startsWith("POST /api/runners/") && it.endsWith("/dir-probe") })
            capture("f1-connecting")

            // Scene 2: its first heartbeat; nothing tells the page, its own reads (2 s apart while it connects) find it.
            connecting = false
            pageClockUntil(MachineSetupCopy.SETUP_REGISTER_DIR, maxMs = 5_000)
            assertEquals(0, compose.onAllNodesWithText(MachineSetupCopy.setupConnecting("orbit@austin")).fetchSemanticsNodes().size)
            awaitText("Found · git repository · main")
            capture("f1-connected")

            // Scene 3: a new folder's name that is a folder already.
            press(MachineSetupCopy.SETUP_NEW_FOLDER)
            compose.onNodeWithTag("setup-new-folder-name").performSemanticsAction(SemanticsActions.SetText) { it(AnnotatedString("payments")) }
            pageClockUntil(MachineSetupCopy.setupNewFolderExists("orbit@austin"))
            assertEquals(0, compose.onAllNodesWithText("Starts empty", substring = true).fetchSemanticsNodes().size)
            compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsEnabled()
            assertTrue("asked about where it would go", bodies.any { it.second.contains("/home/orbit/orbit-repos/payments") })
            capture("f6-new-folder-exists")

            // Scene 4: a name that is a file there.
            compose.onNodeWithTag("setup-new-folder-name").performSemanticsAction(SemanticsActions.SetText) { it(AnnotatedString("notes.txt")) }
            pageClockUntil(MachineSetupCopy.setupNewFolderIsFile("orbit@austin"))
            compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsNotEnabled()
            assertFalse("nothing was sent", calls.contains("POST /api/sessions"))
            capture("f6-new-folder-file")
        }
    }

    private fun awaitText(text: String) = compose.waitUntil(20_000) {
        compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    /** The page's own timers (its reads of the machine, the relay's polls, the typing pause) run on the test clock. */
    private fun pageClockUntil(text: String, maxMs: Long = 6_000) {
        var waited = 0L
        while (compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            assertTrue("\"$text\" never showed within ${maxMs}ms of the page's clock", waited < maxMs)
            compose.mainClock.advanceTimeBy(250)
            waited += 250
            android.os.SystemClock.sleep(50)
            compose.waitForIdle()
        }
    }

    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(15_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }

    private fun press(label: String) {
        val matcher = hasText(label) and hasClickAction()
        compose.waitUntil(15_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodes(matcher).onFirst().performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }

    private fun capture(label: String) {
        compose.waitForIdle()
        instrumentation.waitForIdleSync()
        android.os.SystemClock.sleep(700)
        val dir = File(app.filesDir, "first-workspace").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(dir, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    private fun userJson() = """{
        "id":"u1",
        "name":"Owner",
        "email":"owner@orbit.test",
        "role":"OWNER",
        "avatarUpdatedAt":null,
        "preferences":{"theme":"light","defaultPermissionMode":"auto","notifySessionFinished":false,"notifyAgentMessage":true}
    }"""

    /** Until its first heartbeat: offline, never heard from, nothing declared (docs/first-workspace-contract.md §2). */
    private fun runnerJson(): String {
        val heartbeat = if (connecting) "null" else "\"$now\""
        val capabilities = if (connecting) "[]" else """["dir-probe/v1","create-workdir/v1"]"""
        val engines = if (connecting) "null" else """[
            {"engine":"claude","installed":true,"version":"2.1.302","auth":"no"},
            {"engine":"codex","installed":true,"version":"0.164.0","auth":"no"}
        ]"""
        return """{
            "id":"$runnerId",
            "name":"orbit@austin",
            "displayName":"orbit@austin",
            "hostname":"austin",
            "online":${!connecting},
            "status":"${if (connecting) "OFFLINE" else "ONLINE"}",
            "lastHeartbeatAt":$heartbeat,
            "version":"0.1.240",
            "maxConcurrent":16,
            "activeSessions":0,
            "registerDir":"$register",
            "reposRoot":"/home/orbit/orbit-repos",
            "capabilities":$capabilities,
            "engines":$engines,
            "modelCatalog":{
                "claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],
                "codex":[{"value":"gpt-5.4","label":"GPT-5.4"}]
            }
        }"""
    }

    /** What the runner finds at a path: the register directory, and the Repos Folder's leftovers. */
    private fun at(p: String): String = when (p) {
        register -> """{"path":"$p","exists":true,"isDir":true,"isGit":true,"branch":"main","isHome":false,"freeBytes":10737418240}"""
        "/home/orbit/orbit-repos/payments" ->
            """{"path":"$p","exists":true,"isDir":true,"isGit":true,"branch":"main","isHome":false,"freeBytes":10737418240}"""
        "/home/orbit/orbit-repos/notes.txt" ->
            """{"path":"$p","exists":true,"isDir":false,"isGit":false,"branch":null,"isHome":false,"freeBytes":null}"""
        else -> """{"path":"$p","exists":false,"isDir":false,"isGit":false,"branch":null,"isHome":false,"freeBytes":null}"""
    }

    private fun dispatcher() = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val url = request.requestUrl!!
            val path = url.encodedPath
            val method = request.method ?: "GET"
            val bodyText = request.body.readUtf8()
            calls += "$method $path"
            if (method != "GET") bodies += "$method $path" to bodyText

            fun json(body: String, code: Int = 200) =
                MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

            return when {
                path == "/dl/version.json" -> json("""{"version":"0.1.240"}""")
                path == "/api/auth/methods" -> MockResponse().setResponseCode(404)
                path == "/api/auth/login" -> json("""{"accessToken":"fwf-access","refreshToken":"fwf-refresh","user":${userJson()}}""")
                path == "/api/users/me" -> json(userJson())
                path == "/api/runners" -> json("[${runnerJson()}]")
                path == "/api/runners/$runnerId" && method == "GET" -> json(runnerJson())
                path.startsWith("/api/runners/") && path.endsWith("/dir-probe") && method == "POST" -> {
                    if (connecting) return json("""{"statusCode":400,"message":"Runner is offline"}""", 400)
                    val p = runCatching { Json.parseToJsonElement(bodyText).jsonObject["path"]?.jsonPrimitive?.contentOrNull }.getOrNull().orEmpty()
                    asked = p
                    json("""{"path":"$p","status":"pending","requestedAt":"$now"}""")
                }
                path.startsWith("/api/runners/") && path.endsWith("/dir-probe") && method == "GET" -> {
                    val p = url.queryParameter("path").orEmpty()
                    if (p != asked) json("""{"path":"$p","status":"idle","result":null}""")
                    else json("""{"path":"$p","status":"done","result":${at(p)}}""")
                }
                path == "/api/workspaces" && method == "GET" -> json("[]")
                path == "/api/providers" -> json("[]")
                path == "/api/providers/pools" -> json("[]")
                path == "/api/providers/shared-pools" -> json("[]")
                path == "/api/sessions" && method == "GET" -> json("[]")
                // The account's event stream, as the first-workspace kit serves it: connected, with keepalives.
                path.endsWith("/events") -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody("data: {\"type\":\"ping\",\"seq\":0}\n\n" + ": connected\n\n".repeat(120), 13)
                    .throttleBody(13, 1, TimeUnit.SECONDS)
                method == "GET" -> json("[]")
                else -> json("{}")
            }
        }
    }
}
