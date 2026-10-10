package io.orbitd.android

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.directory.recapLabel
import io.orbitd.android.navigation.ObjectId
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
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

/** One controlled Orbit server for the recap's two places beyond the session list (0418): a project, Launch, whose coordinator and
 * one member the server has recapped and whose third member has only a reply, all in Alpha; the coordinator's conversation; and
 * the account, whose Session recaps switch [recapsOff] turns off. Not a deployed backend; the sentences are invented. */
internal object RecapEntriesServer {
    const val ALPHA = "34RecapWorkspaceAlpha1"
    const val LAUNCH = "34RecapProjectLaunch01"
    const val COORD = "34RecapSessionCoord001"
    const val MEMBER = "34RecapSessionMember01"
    const val PLAIN = "34RecapSessionPlain001"
    private val ids = listOf(ALPHA, LAUNCH, COORD, MEMBER, PLAIN)

    const val COORD_TITLE = "Coordinate the recap"
    const val COORD_RECAP = "Landed the chat-page recap on all three clients; the shots are next."
    const val COORD_REPLY = "Filed the evidence task and pinged the reviewer."
    const val MEMBER_RECAP = "Wired the coordinator card to the session list's own line."
    const val MEMBER_REPLY = "Pushed the card change."
    const val PLAIN_REPLY = "Rebased the fixtures; the suite is green."
    /** The conversation's own turns, which the chat page draws under its recap. */
    const val ASKED = "Put the recap at the top of the chat page and on the project's entries."
    const val ANSWERED = "Done on all three clients: the header line, the coordinator card and the project row."

    /** The account's Session recaps switch, off: `users/me` answers `preferences.recaps: false`. */
    @Volatile var recapsOff = false
    val calls = CopyOnWriteArrayList<String>()
    /** Five minutes before the test began, for the chat page's "Recap · 5m ago"; the member's forty. */
    var coordRecapAt = ""; var memberRecapAt = ""; var readAt = ""

    fun reset() {
        recapsOff = false; calls.clear()
        val now = Instant.now().truncatedTo(ChronoUnit.SECONDS)
        coordRecapAt = now.minusSeconds(5 * 60).toString(); memberRecapAt = now.minusSeconds(40 * 60).toString(); readAt = now.toString()
    }

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    /** A member's relation to Launch; `projectId` is the coordinator's own, as the server serves it. */
    private fun member(role: String) = (if (role == "COORDINATOR") """"projectId":"$LAUNCH",""" else "") +
        """"projectMembership":{"projectId":"$LAUNCH","projectTitle":"Launch","projectStatus":"OPEN","role":"$role"}"""
    private fun row(id: String, title: String, extra: String, lastTurnAt: String) =
        """{"id":"$id","title":"$title","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
            "agent":{"id":"$ALPHA","name":"Alpha"},"agentId":"$ALPHA","createdAt":"${ago(600)}","lastTurnAt":"$lastTurnAt","pendingApprovals":0,
            "tags":[],"capabilities":{"canComplete":true,"canRestore":false,"canSend":true},$extra}"""
    private fun session(id: String) = when (id) {
        COORD -> row(COORD, COORD_TITLE, """"lastAssistantText":"$COORD_REPLY","recapText":"$COORD_RECAP","recapAt":"$coordRecapAt",${member("COORDINATOR")}""", ago(4))
        MEMBER -> row(MEMBER, "Coordinator card line", """"lastAssistantText":"$MEMBER_REPLY","recapText":"$MEMBER_RECAP","recapAt":"$memberRecapAt",${member("TASK")}""", ago(38))
        else -> row(PLAIN, "Fixture rebase", """"lastAssistantText":"$PLAIN_REPLY",${member("TASK")}""", ago(90))
    }
    private fun list() = listOf(COORD, MEMBER, PLAIN).joinToString(",", "[", "]") { session(it) }

    private fun event(seq: Int, type: String, text: String, minutes: Long) =
        """{"type":"$type","seq":$seq,"ts":"${ago(minutes)}","turnId":"t1","payload":{"text":"$text"}}"""
    private fun page() = """{"events":[${event(1, "user", ASKED, 9)},${event(2, "assistant", ANSWERED, 6)}],"hasMore":false,"lastSeq":2,"latestSeq":2}"""

    private val project = """{"id":"$LAUNCH","title":"Launch","status":"OPEN","goal":"Show the recap wherever a session is entered.",
        "createdAt":"2026-10-01T00:00:00Z","_count":{"tasks":5}}"""
    private val sidebar = """[{"id":"$LAUNCH","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{},
        "taskCounts":{"done":2,"failed":0,"total":5},"attention":{},"startedAt":"2026-10-02T00:00:00Z"}]"""
    /** The coordinator status read as the server answers it: the conversation's state and times, and none of its words. */
    private fun coordinator() = """{"projectId":"$LAUNCH","readAt":"$readAt","state":"LIVE","coordination":{"sessionId":"$COORD","sessionIdAbsentReason":null,
        "session":{"id":"$COORD","title":"$COORD_TITLE","runStatus":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
        "filingState":"OPEN","endReason":null,"startedAt":"${ago(600)}","finishedAt":null,"completedAt":null,"deletedAt":null,"lastTurnAt":"${ago(4)}",
        "engineTurnActive":false,"pendingApprovals":0},"sessionAbsentReason":null,"coordinatorGeneration":"0","workspaceId":"$ALPHA",
        "workspaceName":"Alpha","agentId":null,"agentName":null,"wakeups":{"state":"NONE","at":null},"fuse":null},
        "openability":{"canOpen":true,"requiredAction":null}}"""

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/") { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
        val method = api.method.name
        if (path == "auth/login") return@HttpTransport ok("""{"accessToken":"recap-access","refreshToken":"recap-refresh","user":{"id":"u1","email":"owner@recap.test","name":"Owner"}}""")
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        calls += "$method $path" + if (query.isEmpty()) "" else "?$query"
        val view = api.query.firstOrNull { it.first == "view" }?.second ?: "open"
        when {
            path == "users/me" -> ok("""{"id":"u1","email":"owner@recap.test","name":"Owner","preferences":${if (recapsOff) """{"recaps":false}""" else "{}"}}""")
            path == "workspaces" -> ok("""[{"id":"$ALPHA","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}]""")
            path == "runners" -> ok("""[{"id":"r1","name":"Fixture runner","online":true}]""")
            path == "sessions" -> ok(if (view == "open") list() else "[]")
            api.path.size == 2 && path.startsWith("sessions/") && method == "GET" -> ok(session(path.removePrefix("sessions/")))
            path == "sessions/$COORD/events/page" -> ok(page())
            path == "projects/sidebar" -> ok(sidebar)
            path == "projects" -> ok("[$project]")
            path == "projects/$LAUNCH" -> ok(project)
            path == "projects/$LAUNCH/coordinator/status" -> ok(coordinator())
            path == "projects/$LAUNCH/open-items" -> ok("""{"needsYou":[],"withCoordinator":[]}""")
            path.startsWith("projects/") -> ok("{}")
            path.startsWith("wiki/") -> ApiResponse(404, """{"code":"WIKI_DISABLED","message":"The wiki is off."}""".encodeToByteArray())
            method == "GET" -> ok("[]")
            else -> ok("{}")
        }
    }

    /** The streams open and stay quiet: the account is connected. */
    private val events = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit): Unit {
            onOpen()
            awaitCancellation()
        }
    }

    fun session() = AuthSession(transport, object : CredentialStore {
        private var value: StoredSession? = null
        override suspend fun load() = value
        override suspend fun save(session: StoredSession) { value = session }
        override suspend fun clear() { value = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) = Unit
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
        override suspend fun clearAll() = Unit
    }, "recap-entries", eventTransport = events)

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://recap.test"), "owner@recap.test", "fixture")
}

/** The application with the controlled server in place of the network and the device stores. */
class RecapEntriesApplication : OrbitApplication() {
    override fun createSession(): AuthSession = RecapEntriesServer.session()
    // Unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
}

/**
 * The server's recap in the two places a session is entered from besides the session list (task 34dImqU6exubPCbqnawhe), in the
 * production shell: the chat page draws it under its header — "Recap · 5m ago", then the sentence — and a project's entries draw
 * it as the session list does, a recap under its "Recap · <clock>" label in place of the raw reply: the project's row in the
 * workspace list, its sessions page, and its page's coordinator card. With the account's Session recaps switch off, none of the
 * three draws a recap — the chat page draws nothing in its place, the entries their raw replies. Each state is written to a PNG
 * under `src/android/build/evidence/session-recap-entries-android/`, beside its semantics tree.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = RecapEntriesApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionRecapEntriesShotsTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = RecapEntriesServer.reset()

    private val server = RecapEntriesServer
    /** A list row's label, as the row's own `recapLabel` reads the time. */
    private fun label(recapAt: String) = recapLabel(recapAt, Instant.now())

    @Test fun theRecapIsOnTheChatPageAndOnTheProjectsEntries() {
        signIn(); openAlpha()
        // The project's row in the workspace list says its coordinator's line: the recap, under its label.
        await { exists(hasTestTag("project-row-line") and hasText("${label(server.coordRecapAt)} ${server.COORD_RECAP}"), unmerged = true) }
        shot("list-project-row-with-recap")

        // Its sessions page: the coordinator and the recapped member under their labels, the reply-only member as it was.
        compose.onNodeWithTag("project-row:${server.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions")) && exists(hasText(server.PLAIN_REPLY, substring = true)) }
        rowSays(server.COORD_TITLE, "${label(server.coordRecapAt)} ${server.COORD_RECAP}")
        rowSays("Coordinator card line", "${label(server.memberRecapAt)} ${server.MEMBER_RECAP}")
        rowSays("Fixture rebase", server.PLAIN_REPLY)
        assertFalse(exists(hasText(server.COORD_REPLY, substring = true)))
        assertFalse(exists(hasText(server.MEMBER_REPLY, substring = true)))
        shot("project-sessions-with-recap")

        // The project's page: the coordinator card says the coordinator's line from the session list, its recap first.
        compose.onNodeWithContentDescription("Open Project").performClick()
        await { exists(projectPage) }
        compose.onNode(projectPage).performScrollToNode(hasTestTag("project-coordinator-section"))
        await { exists(hasTestTag("project-coordinator-line"), unmerged = true) }
        compose.onNodeWithTag("project-coordinator-line", useUnmergedTree = true)
            .assertTextEquals("${label(server.coordRecapAt)} ${server.COORD_RECAP}")
        shot("project-coordinator-with-recap")

        // The chat page: the recap under the header, dated by how long ago it was written — and never the raw reply.
        open("orbit-session:${server.COORD}")
        await { exists(hasText(server.ANSWERED, substring = true), unmerged = true) && exists(hasTestTag("session-recap")) }
        val recap = text(compose.onNodeWithTag("session-recap").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Text))
        assertTrue("the chat page's recap line reads \"$recap\"",
            Regex("Recap · \\d+m ago ${Regex.escape(server.COORD_RECAP)}").matches(recap))
        compose.onAllNodes(hasTestTag("session-recap") and hasText(server.COORD_REPLY, substring = true)).assertCountEquals(0)
        shot("chat-with-recap")
    }

    @Test fun withTheSwitchOffNoneOfThemDrawsARecap() {
        server.recapsOff = true
        signIn(); openAlpha()
        // The switch has reached the lists once the row says its coordinator's raw reply instead.
        await { exists(hasTestTag("project-row-line") and hasText(server.COORD_REPLY), unmerged = true) }
        noRecap()
        shot("list-project-row-with-recaps-off")

        compose.onNodeWithTag("project-row:${server.LAUNCH}").performClick()
        await { exists(hasTestTag("project-sessions")) && exists(hasText(server.PLAIN_REPLY, substring = true)) }
        rowSays(server.COORD_TITLE, server.COORD_REPLY)
        rowSays("Coordinator card line", server.MEMBER_REPLY)
        rowSays("Fixture rebase", server.PLAIN_REPLY)
        noRecap()
        shot("project-sessions-with-recaps-off")

        compose.onNodeWithContentDescription("Open Project").performClick()
        await { exists(projectPage) }
        compose.onNode(projectPage).performScrollToNode(hasTestTag("project-coordinator-section"))
        await { exists(hasTestTag("project-coordinator-line"), unmerged = true) }
        compose.onNodeWithTag("project-coordinator-line", useUnmergedTree = true).assertTextEquals(server.COORD_REPLY)
        noRecap()
        shot("project-coordinator-with-recaps-off")

        // The chat page draws nothing in the recap's place: its header, then the conversation.
        open("orbit-session:${server.COORD}")
        await { exists(hasText(server.ANSWERED, substring = true), unmerged = true) }
        compose.onAllNodesWithTag("session-recap").assertCountEquals(0)
        noRecap()
        shot("chat-with-recaps-off")
    }

    /** The project's page once it has read the project: its list, not the loading box that wears the same tag. */
    private val projectPage = hasTestTag("project-detail") and hasScrollToIndexAction()

    /** No recap anywhere on screen: neither its label nor either recap sentence. */
    private fun noRecap() {
        assertFalse("a Recap label is drawn", exists(hasText("Recap ·", substring = true), unmerged = true))
        assertFalse(exists(hasText(server.COORD_RECAP, substring = true), unmerged = true))
        assertFalse(exists(hasText(server.MEMBER_RECAP, substring = true), unmerged = true))
    }

    /** The sessions page's row titled [title] says [line] as its preview. */
    private fun rowSays(title: String, line: String) {
        compose.onNodeWithTag("project-sessions-list").performScrollToNode(hasText(title, substring = true))
        assertTrue("$title's row does not say “$line”", exists(hasText(title, substring = true) and hasText(line, substring = true)))
    }

    private fun text(values: List<androidx.compose.ui.text.AnnotatedString>?) = values.orEmpty().joinToString("") { it.text }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) =
        compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { RecapEntriesServer.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun openAlpha() {
        await { exists(hasTestTag("workspace:${RecapEntriesServer.ALPHA}")) }
        compose.onNodeWithTag("workspace:${RecapEntriesServer.ALPHA}").performClick()
        await { exists(hasTestTag("project-row:${RecapEntriesServer.LAUNCH}")) }
    }
    /** A link as Android delivers one to the running Activity; the launch intent is put back for ActivityScenario. */
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/session-recap-entries-android").also { it.mkdirs() }
    }

    /** The screen as a PNG, never a blank one, with the semantics tree on screen beside it. */
    private fun shot(name: String) {
        compose.waitForIdle()
        val roots = compose.onAllNodes(isRoot())
        File(output, "$name-semantics.txt").writeText(
            (0 until roots.fetchSemanticsNodes().size).joinToString("\n\n") { roots[it].printToString() })
        val view = compose.activity.window.decorView
        assertTrue("$name: the view was never laid out", view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        val file = File(output, "$name.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> $file")
        bitmap.recycle()
    }
}
