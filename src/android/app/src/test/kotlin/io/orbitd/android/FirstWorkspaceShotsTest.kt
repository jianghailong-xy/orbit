package io.orbitd.android

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.composer.MachineSetupCopy
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.management.MachinesAndModels
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
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

/**
 * End-to-end Compose & Robolectric native-graphics screenshot verification for a machine's first workspace
 * (project 34pLjYBjU6ILsehatEjJs, task 34pLtXumbawMl6II4gUPa, board 03 iPhone rules & board 04):
 * - Drawer `Set up <machine>` row and enabled `New session` with 0 workspaces
 * - Cold-start landing on the first online machine's draft (or `Machines & models` when all are offline)
 * - Setup card (`MachineSetupCard`) with 3-way folder picker, `dir-probe` check, sign-in card & `Use an API Key`
 * - Held first message (`HeldFirstMessageView`), `Withdraw`, and automatic `POST /sessions` with `newWorkspace`
 * - `Created workspace` line at the top of the conversation with `Rename` (`PATCH /workspaces/:id`) and `Settings`
 * - Machine page empty state with `Start a session` and no `"on the web"`
 *
 * Writes PNG screenshots to `src/android/build/evidence/first-workspace-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = FirstWorkspaceShotsApplication::class, qualifiers = "w411dp-h900dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class FirstWorkspaceShotsTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }
            .first { File(it, "src/android").isDirectory }
        File(root, "src/android/build/evidence/first-workspace-android").also { it.mkdirs() }
    }

    @Before fun resetFixture() = FirstWorkspaceShell.reset()

    private fun app() = compose.activity.application as OrbitApplication

    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { FirstWorkspaceShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }

    private fun awaitText(text: String) = compose.waitUntil(60_000) {
        compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText(
            (0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() }
        )
        val view = compose.activity.window.decorView
        assertTrue("$name: view was never laid out (${view.width}x${view.height})", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: screenshot is blank", pixels.any { it != 0 })
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("$name: no PNG written", file.length() > 0)
        println("shot $name ${bitmap.width}x${bitmap.height} -> $file")
        bitmap.recycle()
    }

    @Test fun coldStartWithNoWorkspacesLandsOnTheFirstOnlineMachineShowsTheSetupCardAndTheDrawerSetUpRow() {
        signIn()

        // Lands on the first online machine's new session page and probes registerDir (/home/orbit/code/app).
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

        assertTrue(
            "expected POST runners/${FirstWorkspaceShell.RUNNER}/dir-probe",
            FirstWorkspaceShell.calls.contains("POST runners/${FirstWorkspaceShell.RUNNER}/dir-probe")
        )
        assertEquals(
            buildJsonObject { put("path", "/home/orbit/code/app") },
            FirstWorkspaceShell.body("POST runners/${FirstWorkspaceShell.RUNNER}/dir-probe")
        )

        shot("01-setup-card")

        // Open drawer: shows Set up orbit@austin (selected) and New session enabled, with no "Add a workspace to start a session."
        compose.onNodeWithContentDescription("Open navigation").performClick()
        compose.waitForIdle()
        val setUpRow = hasText(MachineSetupCopy.setupTitle("orbit@austin")) and
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
        compose.onNode(setUpRow).assertExists().assertIsSelected()
        compose.onAllNodesWithText("Add a workspace to start a session.", substring = true).assertCountEquals(0)
        compose.onNode(
            hasText("New session") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button)
        ).assertIsEnabled()

        shot("02-drawer-set-up")
    }

    @Test fun heldMessageWaitsCanBeWithdrawnAutoCreatesTheSessionOnceReadyAndDrawsTheCreatedWorkspaceLine() {
        signIn()
        awaitText("Found · git repository · main")

        val prompt = "Fix the flaky login test in tests/auth — it fails about one run in five on CI."
        compose.onNodeWithTag("composer-input").performTextInput(prompt)
        compose.onNodeWithTag("composer-send").performClick()
        compose.waitForIdle()

        // Not ready yet: no POST /sessions was sent, and the message waits under the card with Withdraw.
        assertFalse("must not POST sessions before both steps are done", FirstWorkspaceShell.calls.contains("POST sessions"))
        awaitText(MachineSetupCopy.heldWaiting("orbit@austin"))
        awaitText(MachineSetupCopy.HELD_WITHDRAW)
        compose.onNodeWithTag("held-first-message").assertExists()

        // Withdraw restores the text to the composer and clears the waiting message.
        compose.onNode(hasText(MachineSetupCopy.HELD_WITHDRAW) and hasClickAction())
            .performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
        compose.onAllNodesWithTag("held-first-message").assertCountEquals(0)
        compose.onNodeWithTag("composer-input").assertTextContains(prompt)

        // Step 1: Use This Folder (/home/orbit/code/app) -> folds Step 1 to its compact summary line.
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction())
            .performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()

        // Send again: Step 2 is still unsigned, so the message waits under the card until Step 2 finishes.
        compose.onNodeWithTag("composer-send").performClick()
        awaitText(MachineSetupCopy.heldWaiting("orbit@austin"))
        assertFalse("must not POST sessions when only step 1 is done", FirstWorkspaceShell.calls.contains("POST sessions"))

        shot("03-setup-held")

        // Step 2: Use an API Key -> both steps are now done, so the held message sends automatically!
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_API_KEY) and hasClickAction())
            .performSemanticsAction(SemanticsActions.OnClick)

        compose.waitUntil(60_000) { FirstWorkspaceShell.calls.contains("POST sessions") }
        val createBody = FirstWorkspaceShell.body("POST sessions")!!
        assertEquals(FirstWorkspaceShell.RUNNER, createBody["assignedRunnerId"]?.jsonPrimitive?.content)
        assertNull("bare machine session creation must not send agentId", createBody["agentId"])
        assertEquals(
            buildJsonObject { put("workDir", "/home/orbit/code/app") },
            createBody["newWorkspace"]?.jsonObject
        )
        assertEquals("claude", createBody["engine"]?.jsonPrimitive?.content)
        assertEquals("deepseek", createBody["provider"]?.jsonPrimitive?.content)
        assertEquals(prompt, createBody["prompt"]?.jsonPrimitive?.content)

        // Opens the created session with the Created workspace line at the top of the transcript.
        awaitText("Created workspace app on orbit@austin · /home/orbit/code/app")
        compose.onNodeWithTag("created-workspace").assertExists()
        compose.onNode(hasText(MachineSetupCopy.CREATED_RENAME) and hasAnyAncestor(hasTestTag("created-workspace"))).assertExists()
        compose.onNode(hasText(MachineSetupCopy.CREATED_SETTINGS) and hasAnyAncestor(hasTestTag("created-workspace"))).assertExists()

        shot("04-created-workspace")

        // Rename from the Created workspace line sends PATCH workspaces/:id and updates the line.
        compose.onNode(hasText(MachineSetupCopy.CREATED_RENAME) and hasAnyAncestor(hasTestTag("created-workspace"))).performClick()
        compose.waitUntil(60_000) { compose.onAllNodesWithTag("created-workspace-rename-input").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("created-workspace-rename-input").performTextReplacement("payments")
        compose.onNode(hasText("Save") and hasClickAction()).performClick()
        compose.waitUntil(60_000) { FirstWorkspaceShell.calls.contains("PATCH workspaces/${FirstWorkspaceShell.CREATED_WORKSPACE}") }
        assertEquals(
            buildJsonObject { put("name", "payments") },
            FirstWorkspaceShell.body("PATCH workspaces/${FirstWorkspaceShell.CREATED_WORKSPACE}")
        )
        awaitText("Created workspace payments on orbit@austin · /home/orbit/code/app")
    }

    @Test fun allMachinesOfflineLandsOnMachinesAndModelsAndRunnerPageSaysStartASessionWithoutOnTheWeb() {
        FirstWorkspaceShell.runnerOnline = false
        signIn()

        // Rule 11: 0 workspaces and 0 online machines -> lands on Machines & models.
        awaitText(MachinesAndModels.MACHINES)
        awaitText("orbit@austin")

        // Open the runner's page: Workspaces section shows machineEmptyHere + Start a session, and never "on the web".
        compose.onNode(hasText("orbit@austin") and hasClickAction()).performScrollTo().performClick()
        awaitText(MachineSetupCopy.machineEmptyHere("orbit@austin"))
        compose.onAllNodesWithText("on the web", substring = true).assertCountEquals(0)
        compose.onNode(hasText(MachineSetupCopy.START_A_SESSION) and hasClickAction()).performScrollTo().performClick()

        // Opens the offline machine's draft page, showing the offline notice on the setup card.
        awaitText(MachineSetupCopy.setupOffline("orbit@austin"))
    }

    private fun openTheMachineFromMachinesAndModels() {
        awaitText(MachinesAndModels.MACHINES)
        compose.onNode(hasText("orbit@austin") and hasClickAction()).performScrollTo().performClick()
        awaitText(MachineSetupCopy.START_A_SESSION)
        compose.onNode(hasText(MachineSetupCopy.START_A_SESSION) and hasClickAction()).performScrollTo().performClick()
    }

    /** Lets the page's own timers run: its reads of the machine, the relay's polls and the typing pause are on the test clock. */
    private fun waitFor(text: String, maxMs: Long = 6_000) {
        var waited = 0L
        while (compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            assertTrue("\"$text\" never showed within ${maxMs}ms of the page's clock", waited < maxMs)
            compose.mainClock.advanceTimeBy(250)
            waited += 250
            compose.waitForIdle()
        }
    }

    @Test fun aMachineApprovedAMomentAgoIsWaitedForAndItsFolderStepOpensWithinSecondsOfItsFirstHeartbeat() {
        FirstWorkspaceShell.runnerConnecting = true
        signIn()
        // Nothing online yet: rule 11 lands on Machines & models, and the machine's Start a session opens its card.
        openTheMachineFromMachinesAndModels()
        awaitText(MachineSetupCopy.setupConnecting("orbit@austin"))
        compose.onAllNodesWithText("updates itself first", substring = true).assertCountEquals(0)
        compose.onAllNodesWithText("is offline", substring = true).assertCountEquals(0)
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsNotEnabled()
        assertFalse("a machine still connecting is asked nothing", FirstWorkspaceShell.calls.any { it.startsWith("POST runners/${FirstWorkspaceShell.RUNNER}/dir-probe") })
        shot("06-connecting")

        // Its first heartbeat. Nothing tells the page: its own reads, 2 s apart while it connects, find it.
        FirstWorkspaceShell.runnerConnecting = false
        waitFor("Found · git repository · main", maxMs = 5_000)
        compose.onAllNodesWithText(MachineSetupCopy.setupConnecting("orbit@austin")).assertCountEquals(0)
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsEnabled()
    }

    @Test fun aRegisterQuestionAnotherPathTookIsAskedAgainSoTheSuggestionStillComes() {
        FirstWorkspaceShell.slots = true
        FirstWorkspaceShell.slowFirstRegisterAnswer = true
        signIn()
        awaitText(MachineSetupCopy.setupOtherFolder("orbit@austin"))
        compose.onAllNodesWithText(MachineSetupCopy.SETUP_REGISTER_DIR).assertCountEquals(0)

        // Another folder, typed before the machine has answered about the register directory: its question takes the slot.
        compose.onNode(hasText(MachineSetupCopy.setupOtherFolder("orbit@austin")) and hasClickAction()).performClick()
        compose.onNodeWithTag("setup-other-folder-path").performTextInput("/srv/shared")
        waitFor("Found · not a git repository")
        waitFor(MachineSetupCopy.SETUP_REGISTER_DIR)
        assertEquals(
            "the register directory is asked twice: once at first, once after the path's answer",
            2,
            FirstWorkspaceShell.bodies.count { (call, body) ->
                call == "POST runners/${FirstWorkspaceShell.RUNNER}/dir-probe" && body.contains("/home/orbit/code/app")
            },
        )
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsEnabled()
    }

    @Test fun aNewFolderNameIsCheckedWhereItWouldGoBeforeAnythingIsSent() {
        FirstWorkspaceShell.slots = true
        signIn()
        awaitText("Found · git repository · main")
        compose.onNode(hasText(MachineSetupCopy.SETUP_NEW_FOLDER) and hasClickAction()).performClick()

        // A folder a deleted workspace left: it is used with what is in it, not called empty.
        compose.onNodeWithTag("setup-new-folder-name").performTextInput("payments")
        waitFor(MachineSetupCopy.setupNewFolderExists("orbit@austin"))
        assertEquals(
            buildJsonObject { put("path", "/home/orbit/orbit-repos/payments") },
            FirstWorkspaceShell.body("POST runners/${FirstWorkspaceShell.RUNNER}/dir-probe"),
        )
        compose.onAllNodesWithText("Starts empty", substring = true).assertCountEquals(0)
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsEnabled()
        shot("07-new-folder-exists")

        // A file of that name: it can't be one, and says why.
        compose.onNodeWithTag("setup-new-folder-name").performTextReplacement("notes.txt")
        waitFor(MachineSetupCopy.setupNewFolderIsFile("orbit@austin"))
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsNotEnabled()

        // Nothing there: it starts empty, as the board says.
        compose.onNodeWithTag("setup-new-folder-name").performTextReplacement("scratch-notes")
        waitFor(MachineSetupCopy.SETUP_NEW_FOLDER_META)
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).assertIsEnabled()

        // Back to the one that is there: Use This Folder takes it as that folder.
        compose.onNodeWithTag("setup-new-folder-name").performTextReplacement("payments")
        waitFor(MachineSetupCopy.setupNewFolderExists("orbit@austin"))
        compose.onNode(hasText(MachineSetupCopy.SETUP_USE_FOLDER) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick)
        awaitText("/home/orbit/orbit-repos/payments")
        compose.onAllNodesWithText(MachineSetupCopy.SETUP_NEW_FOLDER_DONE).assertCountEquals(0)
    }
}

internal object FirstWorkspaceShell {
    const val RUNNER = "34FwRunnerAustin000001"
    const val CREATED_WORKSPACE = "34FwWorkspaceApp000001"
    const val SESSION = "34FwSessionFirst000001"

    val calls = CopyOnWriteArrayList<String>()
    val bodies = CopyOnWriteArrayList<Pair<String, String>>()
    private val disk = ConcurrentHashMap<String, ByteArray>()

    @Volatile var runnerOnline = true
    /** Approved a moment ago and not beaten yet: offline, never heard from, nothing declared (contract §2). */
    @Volatile var runnerConnecting = false
    /** The relay as the server keeps it: one question per machine, answered only for the path in it. */
    @Volatile var slots = false
    /** With [slots]: the register directory's first question is not answered until another takes its place. */
    @Volatile var slowFirstRegisterAnswer = false
    @Volatile var workspaceCreated = false
    @Volatile var workspaceName = "app"
    @Volatile private var asked: String? = null
    private val asks = ConcurrentHashMap<String, Int>()

    fun reset() {
        calls.clear()
        bodies.clear()
        disk.clear()
        asks.clear()
        asked = null
        runnerOnline = true
        runnerConnecting = false
        slots = false
        slowFirstRegisterAnswer = false
        workspaceCreated = false
        workspaceName = "app"
    }

    private const val REGISTER = "/home/orbit/code/app"

    /** What the runner finds at a path, in the slot model: the register directory, and the Repos Folder's leftovers. */
    private fun at(path: String): String = when (path) {
        REGISTER -> """{"path":"$path","exists":true,"isDir":true,"isGit":true,"branch":"main","isHome":false,"freeBytes":10737418240}"""
        "/srv/shared" -> """{"path":"$path","exists":true,"isDir":true,"isGit":false,"branch":null,"isHome":false,"freeBytes":10737418240}"""
        "/home/orbit/orbit-repos/payments" ->
            """{"path":"$path","exists":true,"isDir":true,"isGit":true,"branch":"main","isHome":false,"freeBytes":10737418240}"""
        "/home/orbit/orbit-repos/notes.txt" ->
            """{"path":"$path","exists":true,"isDir":false,"isGit":false,"branch":null,"isHome":false,"freeBytes":null}"""
        else -> """{"path":"$path","exists":false,"isDir":false,"isGit":false,"branch":null,"isHome":false,"freeBytes":null}"""
    }

    fun obj(json: String): JsonObject = Wire.json.parseToJsonElement(json).jsonObject
    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    private fun runnerJson(): JsonObject {
        val now = Instant.now()
        val online = runnerOnline && !runnerConnecting
        val heartbeat = if (runnerConnecting) "null" else "\"${if (online) now else now.minusSeconds(3 * 86_400)}\""
        val capabilities = if (runnerConnecting) "[]" else """["dir-probe/v1","create-workdir/v1"]"""
        val engines = if (runnerConnecting) "null" else """[
                    {"engine":"claude","installed":true,"version":"2.1.302","auth":"no"},
                    {"engine":"codex","installed":true,"version":"0.164.0","auth":"no"}
                ]"""
        return obj(
            """{
                "id":"$RUNNER",
                "name":"orbit@austin",
                "online":$online,
                "status":"${if (online) "ONLINE" else "OFFLINE"}",
                "version":"0.1.240",
                "maxConcurrent":16,
                "activeSessions":0,
                "lastHeartbeatAt":$heartbeat,
                "registerDir":"/home/orbit/code/app",
                "reposRoot":"/home/orbit/orbit-repos",
                "capabilities":$capabilities,
                "engines":$engines,
                "modelCatalog":{
                    "claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],
                    "codex":[{"value":"gpt-5.4","label":"GPT-5.4"}]
                }
            }"""
        )
    }

    private fun workspaceJson(): JsonObject = obj(
        """{
            "id":"$CREATED_WORKSPACE",
            "name":"$workspaceName",
            "runnerId":"$RUNNER",
            "workDir":"/home/orbit/code/app",
            "enabled":true,
            "position":0,
            "provider":"deepseek",
            "model":"claude-opus-5-5",
            "createdAt":"2026-10-31T01:00:00.000Z"
        }"""
    )

    private fun sessionDetailJson(): JsonObject = obj(
        """{
            "id":"$SESSION",
            "title":"Fix the flaky login test",
            "status":"AWAITING_INPUT",
            "runState":"AWAITING_INPUT",
            "lifecycleState":"OPEN",
            "provider":"deepseek",
            "engine":"claude",
            "model":"claude-opus-5-5",
            "assignedRunnerId":"$RUNNER",
            "createdWorkspace":true,
            "agent":{
                "id":"$CREATED_WORKSPACE",
                "name":"$workspaceName",
                "workDir":"/home/orbit/code/app",
                "runnerId":"$RUNNER",
                "deletedAt":null
            },
            "agentId":"$CREATED_WORKSPACE",
            "createdAt":"2026-10-31T08:00:00Z",
            "lastTurnAt":"2026-10-31T08:00:05Z",
            "capabilities":{"canSend":true,"canResume":false,"canComplete":true},
            "tags":[],
            "pendingApprovals":0
        }"""
    )

    private val eventsJson: List<JsonObject> by lazy {
        listOf(
            obj(
                """{
                    "seq":1,
                    "type":"user",
                    "ts":"2026-10-31T08:00:01Z",
                    "payload":{"text":"Fix the flaky login test in tests/auth — it fails about one run in five on CI."}
                }"""
            ),
            obj(
                """{
                    "seq":2,
                    "type":"assistant",
                    "ts":"2026-10-31T08:00:04Z",
                    "payload":{"text":"I’ll reproduce it first: running the auth tests 20 times in a row to catch the failing case, then I’ll read the test and the session-expiry code it touches."}
                }"""
            ),
        )
    }

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/") { part ->
            listOf(RUNNER, CREATED_WORKSPACE, SESSION).firstOrNull { ObjectId.same(it, part) } ?: part
        }
        val method = api.method.name
        if (path == "auth/login") {
            return@HttpTransport ok(
                """{"accessToken":"fw-access","refreshToken":"fw-refresh","user":{"id":"u1","email":"owner@orbit.test","name":"Owner"}}"""
            )
        }
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        calls += "$method $path" + if (query.isEmpty()) "" else "?$query"
        if (method != "GET") bodies += "$method $path" to (api.body?.decodeToString() ?: "")

        when {
            path == "auth/methods" -> ApiResponse(404, """{"statusCode":404}""".encodeToByteArray())
            path == "auth/logout" -> ok("{}")
            path == "users/me" -> ok("""{"id":"u1","email":"owner@orbit.test","name":"Owner"}""")
            path == "runners" -> ok("[${runnerJson()}]")
            path == "runners/$RUNNER/dir-probe" && method == "POST" && slots -> {
                val p = api.body?.decodeToString()?.let(::obj)?.get("path")?.jsonPrimitive?.contentOrNull.orEmpty()
                asked = p
                asks.merge(p, 1, Int::plus)
                ok("""{"path":"$p","status":"pending","requestedAt":"2026-10-31T08:00:00Z"}""")
            }
            path == "runners/$RUNNER/dir-probe" && method == "GET" && slots -> {
                val p = api.query.firstOrNull { it.first == "path" }?.second.orEmpty()
                when {
                    p != asked -> ok("""{"path":"$p","status":"idle","result":null}""")
                    p == REGISTER && slowFirstRegisterAnswer && asks[p] == 1 -> ok("""{"path":"$p","status":"pending","result":null}""")
                    else -> ok("""{"path":"$p","status":"done","result":${at(p)}}""")
                }
            }
            path == "runners/$RUNNER/dir-probe" && method == "POST" -> ok(
                """{"path":"/home/orbit/code/app","status":"pending","requestedAt":"2026-10-31T08:00:00Z"}"""
            )
            path == "runners/$RUNNER/dir-probe" && method == "GET" -> {
                val p = api.query.firstOrNull { it.first == "path" }?.second ?: "/home/orbit/code/app"
                ok(
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
            path == "workspaces" && method == "GET" -> ok(if (workspaceCreated) "[${workspaceJson()}]" else "[]")
            path == "workspaces/$CREATED_WORKSPACE" && method == "GET" -> ok(workspaceJson().toString())
            path == "workspaces/$CREATED_WORKSPACE" && method == "PATCH" -> {
                val body = api.body?.decodeToString()?.let(::obj)
                body?.get("name")?.jsonPrimitive?.contentOrNull?.let { workspaceName = it }
                ok(workspaceJson().toString())
            }
            path == "providers" -> ok(
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
            )
            path == "providers/pools" -> ok("[]")
            path == "providers/shared-pools" -> ok("[]")
            path == "sessions" && method == "POST" -> {
                workspaceCreated = true
                ok("""{"id":"$SESSION"}""")
            }
            path == "sessions" && method == "GET" -> ok(if (workspaceCreated) "[${sessionDetailJson()}]" else "[]")
            path == "sessions/$SESSION" && method == "GET" -> ok(sessionDetailJson().toString())
            path == "sessions/$SESSION/events/page" -> ok(
                buildJsonObject {
                    put("events", JsonArray(eventsJson))
                    put("hasMore", false)
                }.toString()
            )
            path == "sessions/$SESSION/retry-message" -> ok("""{"text":""}""")
            method == "GET" -> ok("[]")
            else -> ok("{}")
        }
    }

    private val eventsTransport = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
            onOpen()
            awaitCancellation()
        }
    }

    fun session() = AuthSession(
        transport,
        object : CredentialStore {
            private var value: StoredSession? = null
            override suspend fun load() = value
            override suspend fun save(session: StoredSession) { value = session }
            override suspend fun clear() { value = null }
        },
        object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) = Unit
        },
        object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = disk["$kind:$key"]
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { disk["$kind:$key"] = bytes.copyOf() }
            override suspend fun clearAll() = disk.clear()
        },
        "fw-shots",
        dispatcher = Dispatchers.Unconfined,
        eventTransport = eventsTransport,
    )

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://orbit.test"), "owner@orbit.test", "fixture")

    fun body(call: String): JsonObject? = bodies.lastOrNull { it.first == call }?.second?.takeIf { it.isNotEmpty() }?.let(::obj)
}

class FirstWorkspaceShotsApplication : OrbitApplication() {
    override fun createSession(): AuthSession = FirstWorkspaceShell.session()
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(
        this,
        processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false),
    )
}
