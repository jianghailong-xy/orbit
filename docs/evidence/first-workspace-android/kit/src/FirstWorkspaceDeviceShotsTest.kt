package io.orbitd.android

import android.graphics.Bitmap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
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
 * Emulator screenshot and flow verification for task 34pLtXumbawMl6II4gUPa (Android P1b: a machine's first workspace in conversation)
 * on the shared API 36 emulator (`emulator-5554`) against a controlled MockWebServer inside the instrumentation.
 *
 * Captures the five scenes compared against board 03:
 * 1. `01-setup-card`: cold-start landing on the first online bare machine (`orbit@austin`) with the setup card.
 * 2. `02-drawer-set-up`: the drawer's `Set up orbit@austin` row with `New session` enabled.
 * 3. `05-machine-page`: `orbit@austin`'s machine page with 0 workspaces, showing `Start a session` and no `"on the web"`.
 * 4. `03-setup-held`: Step 1 folded and the first message waiting under the card with `Withdraw`.
 * 5. `04-created-workspace`: auto-created session opening with `Created workspace app on orbit@austin · /home/orbit/code/app` and `Rename · Settings`.
 */
@RunWith(AndroidJUnit4::class)
class FirstWorkspaceDeviceShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val calls = CopyOnWriteArrayList<String>()
    private val bodies = CopyOnWriteArrayList<Pair<String, String>>()

    private val runnerId = "34FwShotsRunnerAustin1"
    private val createdWorkspaceId = "34FwShotsWorkspaceApp1"
    private val sessionId = "34FwShotsSessionFirst1"
    @Volatile private var workspaceCreated = false
    @Volatile private var workspaceName = "app"
    @Volatile private var hasApiKey = true
    private val now get() = Instant.now()

    @Test fun firstWorkspaceFlowOnEmulator() {
        compose.waitUntil(15_000) { app.session.state.value !is AuthState.Restoring }
        assertTrue("Dedicated signed-out debug installation required", app.session.state.value is AuthState.SignedOut)

        MockWebServer().use { server ->
            server.dispatcher = dispatcher()
            runBlocking {
                app.session.login(ServerAddress.parse(server.url("/").toString(), true), "owner@orbit.test", "controlled-fixture")
            }
            compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }

            // Scene 1 (with an enabled Claude API key on the account): Cold-start lands on orbit@austin's new session page
            // with the hamburger on the left and draws "Use an API Key" alongside "Sign In" (board 03 frame 2).
            awaitText(MachineSetupCopy.setupTitle("orbit@austin"))
            awaitText("Found · git repository · main")
            awaitText(MachineSetupCopy.SETUP_REGISTER_DIR)
            awaitText(MachineSetupCopy.SETUP_NEW_FOLDER)
            awaitText(MachineSetupCopy.setupOtherFolder("orbit@austin"))
            awaitText(MachineSetupCopy.SETUP_USE_FOLDER)
            awaitText(MachineSetupCopy.setupSignIn("Claude Code", "orbit@austin"))
            awaitText(MachineSetupCopy.SETUP_USE_API_KEY)
            awaitText(MachineSetupCopy.setupUseEngine("Codex"))
            awaitText(MachineSetupCopy.composerPlaceholderFor("orbit@austin"))
            capture("01-setup-card")

            // Scene 1b (0 keys on the account): When GET /api/providers returns [], "Use an API Key" is omitted.
            hasApiKey = false
            compose.runOnIdle {
                val handle = (app.session.state.value as AuthState.SignedIn).handle
                val target = io.orbitd.android.composer.DraftTarget(workspaceId = "", runnerId = runnerId)
                app.composer(handle, target.key, target).loadCatalog()
            }
            compose.waitUntil(15_000) {
                compose.onAllNodesWithText(MachineSetupCopy.SETUP_USE_API_KEY).fetchSemanticsNodes().isEmpty()
            }
            awaitText(MachineSetupCopy.setupSignIn("Claude Code", "orbit@austin"))
            capture("01b-setup-card-no-key")

            // Restore the API key for the rest of the flow.
            hasApiKey = true
            compose.runOnIdle {
                val handle = (app.session.state.value as AuthState.SignedIn).handle
                val target = io.orbitd.android.composer.DraftTarget(workspaceId = "", runnerId = runnerId)
                app.composer(handle, target.key, target).loadCatalog()
            }
            awaitText(MachineSetupCopy.SETUP_USE_API_KEY)

            // Scene 2: Drawer shows "Set up orbit@austin" under Workspaces and enables "New session".
            compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
            awaitText(MachineSetupCopy.setupTitle("orbit@austin"))
            compose.onNodeWithTag("setup-machine:$runnerId").assertExists()
            compose.onNode(
                hasText("New session") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button)
            ).assertIsEnabled()
            capture("02-drawer-set-up")

            // Scene 5: Machine page (Settings -> Machines & models -> orbit@austin) shows Start a session and never "on the web".
            click(hasText("Settings") and hasClickAction())
            click(hasText("Machines & models") and hasClickAction())
            awaitText("orbit@austin")
            click(hasText("orbit@austin") and hasClickAction())
            awaitText(MachineSetupCopy.machineEmptyHere("orbit@austin"))
            assertEquals(
                "Runner page must not contain 'on the web'",
                0,
                compose.onAllNodesWithText("on the web", substring = true).fetchSemanticsNodes().size
            )
            compose.onNode(hasText(MachineSetupCopy.START_A_SESSION) and hasClickAction()).performScrollTo()
            capture("05-machine-page")

            // Pressing "Start a session" on the machine page opens orbit@austin's new session page.
            press(MachineSetupCopy.START_A_SESSION)
            awaitText(MachineSetupCopy.setupTitle("orbit@austin"))
            awaitText("Found · git repository · main")
            awaitText(MachineSetupCopy.SETUP_USE_API_KEY)

            // Scene 3: Send a message before steps are done -> waits under the card with Withdraw.
            val prompt = "Fix the flaky login test in tests/auth — it fails about one run in five on CI."
            compose.onNodeWithTag("composer-input").performSemanticsAction(SemanticsActions.SetText) {
                it(AnnotatedString(prompt))
            }
            compose.waitForIdle()
            compose.onNodeWithTag("composer-send").performSemanticsAction(SemanticsActions.OnClick)
            awaitText(MachineSetupCopy.heldWaiting("orbit@austin"))
            awaitText(MachineSetupCopy.HELD_WITHDRAW)
            assertFalse("must not POST /api/sessions before both steps are done", calls.contains("POST /api/sessions"))

            // Withdraw restores the prompt to the composer and removes the waiting bubble.
            press(MachineSetupCopy.HELD_WITHDRAW)
            compose.waitUntil(10_000) { compose.onAllNodesWithTag("held-first-message").fetchSemanticsNodes().isEmpty() }
            compose.onNodeWithTag("composer-input").assertTextContains(prompt)

            // Complete Step 1 (Use This Folder) and send again so the message waits while Step 1 is folded.
            press(MachineSetupCopy.SETUP_USE_FOLDER)
            compose.onNodeWithTag("composer-send").performSemanticsAction(SemanticsActions.OnClick)
            awaitText(MachineSetupCopy.heldWaiting("orbit@austin"))
            assertFalse("must not POST /api/sessions when only step 1 is done", calls.contains("POST /api/sessions"))
            capture("03-setup-held")

            // Scene 4: Complete Step 2 (Use an API Key) -> auto-creates the workspace and session and opens the conversation.
            press(MachineSetupCopy.SETUP_USE_API_KEY)
            compose.waitUntil(20_000) { calls.contains("POST /api/sessions") }
            val createBody = lastBody("POST /api/sessions")!!
            assertNull("bare machine session creation must not send workspaceId", createBody["workspaceId"])
            assertEquals(
                buildJsonObject { put("workDir", "/home/orbit/code/app") },
                createBody["newWorkspace"]?.jsonObject
            )
            assertEquals("claude", createBody["engine"]?.jsonPrimitive?.content)
            assertEquals("deepseek", createBody["provider"]?.jsonPrimitive?.content)
            assertEquals(prompt, createBody["prompt"]?.jsonPrimitive?.content)

            awaitText("Created workspace app on orbit@austin · /home/orbit/code/app")
            compose.onNodeWithTag("created-workspace").assertExists()
            compose.onNode(hasText(MachineSetupCopy.CREATED_RENAME) and hasAnyAncestor(hasTestTag("created-workspace"))).assertExists()
            compose.onNode(hasText(MachineSetupCopy.CREATED_SETTINGS) and hasAnyAncestor(hasTestTag("created-workspace"))).assertExists()
            awaitText("I’ll reproduce it first")
            compose.waitUntil(15_000) { app.realtime.state.value.session?.fresh == true }
            capture("04-created-workspace")
        }
    }

    private fun awaitText(text: String) = compose.waitUntil(20_000) {
        compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
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

    private fun lastBody(call: String): JsonObject? =
        bodies.lastOrNull { it.first == call }?.second?.takeIf { it.isNotEmpty() }?.let { Json.parseToJsonElement(it).jsonObject }

    private fun userJson() = """{
        "id":"u1",
        "name":"Owner",
        "email":"owner@orbit.test",
        "role":"OWNER",
        "avatarUpdatedAt":null,
        "preferences":{"theme":"light","defaultPermissionMode":"auto","notifySessionFinished":false,"notifyAgentMessage":true}
    }"""

    private fun runnerJson() = """{
        "id":"$runnerId",
        "name":"orbit@austin",
        "displayName":"orbit@austin",
        "hostname":"austin",
        "online":true,
        "status":"ONLINE",
        "lastHeartbeatAt":"$now",
        "version":"0.1.240",
        "maxConcurrent":16,
        "activeSessions":0,
        "registerDir":"/home/orbit/code/app",
        "reposRoot":"/home/orbit/orbit-repos",
        "capabilities":["dir-probe/v1","create-workdir/v1"],
        "engines":[
            {"engine":"claude","installed":true,"version":"2.1.302","auth":"no"},
            {"engine":"codex","installed":true,"version":"0.164.0","auth":"no"}
        ],
        "modelCatalog":{
            "claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],
            "codex":[{"value":"gpt-5.4","label":"GPT-5.4"}]
        }
    }"""

    private fun workspaceJson() = """{
        "id":"$createdWorkspaceId",
        "name":"$workspaceName",
        "runnerId":"$runnerId",
        "workDir":"/home/orbit/code/app",
        "enabled":true,
        "position":0,
        "provider":"deepseek",
        "model":"claude-opus-5-5",
        "createdAt":"2026-10-31T01:00:00.000Z"
    }"""

    private fun sessionDetailJson() = """{
        "id":"$sessionId",
        "title":"Fix the flaky login test",
        "status":"AWAITING_INPUT",
        "runState":"AWAITING_INPUT",
        "lifecycleState":"OPEN",
        "provider":"deepseek",
        "engine":"claude",
        "model":"claude-opus-5-5",
        "assignedRunnerId":"$runnerId",
        "createdWorkspace":true,
        "agent":{
            "id":"$createdWorkspaceId",
            "name":"$workspaceName",
            "workDir":"/home/orbit/code/app",
            "runnerId":"$runnerId",
            "deletedAt":null
        },
        "agentId":"$createdWorkspaceId",
        "createdAt":"2026-10-31T08:00:00Z",
        "lastTurnAt":"2026-10-31T08:00:05Z",
        "capabilities":{"canSend":true,"canResume":false,"canComplete":true},
        "tags":[],
        "pendingApprovals":0
    }"""

    private fun eventsPageJson() = """{
        "events":[
            {
                "seq":1,
                "type":"user",
                "ts":"2026-10-31T08:00:01Z",
                "payload":{"text":"Fix the flaky login test in tests/auth — it fails about one run in five on CI."}
            },
            {
                "seq":2,
                "type":"assistant",
                "ts":"2026-10-31T08:00:04Z",
                "payload":{"text":"I’ll reproduce it first: running the auth tests 20 times in a row to catch the failing case, then I’ll read the test and the session-expiry code it touches."}
            }
        ],
        "hasMore":false
    }"""

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
                path == "/api/auth/login" -> json("""{"accessToken":"fw-access","refreshToken":"fw-refresh","user":${userJson()}}""")
                path == "/api/users/me" -> json(userJson())
                path == "/api/runners" -> json("[${runnerJson()}]")
                path.startsWith("/api/runners/") && path.endsWith("/dir-probe") && method == "POST" ->
                    json("""{"path":"/home/orbit/code/app","status":"pending","requestedAt":"$now"}""")
                path.startsWith("/api/runners/") && path.endsWith("/dir-probe") && method == "GET" -> {
                    val p = url.queryParameter("path") ?: "/home/orbit/code/app"
                    json(
                        """{
                            "path":"$p",
                            "status":"done",
                            "result":{
                                "path":"$p",
                                "exists":true,
                                "isDir":true,
                                "isGit":true,
                                "branch":"main",
                                "isHome":false,
                                "freeBytes":10737418240
                            }
                        }"""
                    )
                }
                path == "/api/workspaces" && method == "GET" ->
                    json(if (workspaceCreated) "[${workspaceJson()}]" else "[]")
                path.startsWith("/api/workspaces/") && method == "GET" ->
                    json(workspaceJson())
                path.startsWith("/api/workspaces/") && method == "PATCH" -> {
                    runCatching {
                        Json.parseToJsonElement(bodyText).jsonObject["name"]?.jsonPrimitive?.contentOrNull?.let { workspaceName = it }
                    }
                    json(workspaceJson())
                }
                path == "/api/providers" -> json(
                    if (hasApiKey) {
                        """[{
                            "id":"prov-deepseek",
                            "slug":"deepseek",
                            "label":"DeepSeek",
                            "runtime":"claude",
                            "presetSlug":"deepseek",
                            "hasApiKey":true,
                            "enabled":true,
                            "defaultModel":"claude-opus-5-5",
                            "models":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],
                            "engines":["claude"]
                        }]"""
                    } else "[]"
                )
                path == "/api/providers/pools" -> json("[]")
                path == "/api/providers/shared-pools" -> json("[]")
                path == "/api/sessions" && method == "POST" -> {
                    workspaceCreated = true
                    json("""{"id":"$sessionId"}""", 201)
                }
                path == "/api/sessions" && method == "GET" ->
                    json(if (workspaceCreated) "[${sessionDetailJson()}]" else "[]")
                path.startsWith("/api/sessions/") && path.endsWith("/events/page") ->
                    json(eventsPageJson())
                path.startsWith("/api/sessions/") && path.endsWith("/retry-message") ->
                    json("""{"text":""}""")
                path.endsWith("/events") -> MockResponse().setHeader("Content-Type", "text/event-stream")
                    .setChunkedBody("data: {\"type\":\"ping\",\"seq\":0}\n\n" + ": connected\n\n".repeat(120), 13)
                    .throttleBody(13, 1, TimeUnit.SECONDS)
                path == "/api/sessions/$sessionId" && method == "GET" ->
                    json(sessionDetailJson())
                method == "GET" -> json("[]")
                else -> json("{}")
            }
        }
    }
}
