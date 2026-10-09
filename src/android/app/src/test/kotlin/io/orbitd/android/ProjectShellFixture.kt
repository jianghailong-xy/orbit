package io.orbitd.android

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.awaitCancellation

/** One controlled Orbit server for the A05d shell tests: the production Activity, AuthSession, RealtimeStore and navigation over
 * these answers. Project Launch's coordinator and a running member are in Alpha, a member waiting on you in Beta, a member in
 * Completed; Alpha also has an ordinary session. A second open project, Quiet, has no sessions at all. Not a deployed backend. */
internal object ProjectShell {
    const val ALPHA = "34A05dWorkspaceAlpha01"
    const val BETA = "34A05dWorkspaceBeta002"
    const val LAUNCH = "34A05dProjectLaunch001"
    const val QUIET = "34A05dProjectQuiet0002"
    const val COORD = "34A05dSessionCoord0001"
    const val WORKER = "34A05dSessionWorker002"
    const val WAITING = "34A05dSessionWaiting03"
    const val PLAIN = "34A05dSessionPlain0004"
    const val DONE = "34A05dSessionDone00005"
    private val ids = listOf(ALPHA, BETA, LAUNCH, QUIET, COORD, WORKER, WAITING, PLAIN, DONE)

    /** Every request after the login, as `METHOD path?query`. */
    val calls = CopyOnWriteArrayList<String>()
    /** Whether anyone has started Launch, and what its open items hold (a start request, or nothing). */
    @Volatile var started = true
    @Volatile var startRequest = false
    /** The status the project-scoped session reads answer with, instead of their rows (Quiet's failure case). */
    @Volatile var quietStatus = 200

    fun reset() { calls.clear(); started = true; startRequest = false; quietStatus = 200 }

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private val workspaces = """[
        {"id":"$ALPHA","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"},
        {"id":"$BETA","name":"Beta","runnerId":"r1","enabled":true,"position":1,"createdAt":"2026-10-01T02:00:00.000Z"}]"""

    private fun member(role: String) = """"projectMembership":{"projectId":"$LAUNCH","projectTitle":"Launch","projectStatus":"OPEN","role":"$role"}"""
    private fun row(id: String, title: String, workspace: String, run: String, extra: String, lifecycle: String = "OPEN", lastTurnAt: String = ago(5),
        approvals: Int = 0) =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"$lifecycle","agent":{"id":"$workspace","name":"${if (workspace == ALPHA) "Alpha" else "Beta"}"},
            "agentId":"$workspace","createdAt":"${ago(600)}","lastTurnAt":"$lastTurnAt","pendingApprovals":$approvals,"tags":[],
            "capabilities":{"canComplete":${lifecycle == "OPEN"},"canRestore":${lifecycle != "OPEN"}}$extra}"""
    private fun session(id: String) = when (id) {
        COORD -> row(COORD, "Coordinate launch", ALPHA, "AWAITING_INPUT", ""","lastAssistantText":"Planning the release",${member("COORDINATOR")}""", lastTurnAt = ago(30))
        WORKER -> row(WORKER, "Wire tests", ALPHA, "RUNNING", ""","lastToolUse":"Bash",${member("TASK")}""", lastTurnAt = ago(2))
        WAITING -> row(WAITING, "Quota retry", BETA, "AWAITING_INPUT", ""","waitingKind":"OWNER_CONFIRMATION",${member("TASK")}""", lastTurnAt = ago(10), approvals = 1)
        PLAIN -> row(PLAIN, "Plain notes", ALPHA, "AWAITING_INPUT", ""","lastAssistantText":"Notes kept"""")
        else -> row(DONE, "Shipped docs", ALPHA, "SUCCEEDED", ""","completedAt":"${ago(2 * 24 * 60)}",${member("TASK")}""", "COMPLETED", ago(2 * 24 * 60))
    }
    private fun list(vararg sessions: String) = sessions.joinToString(",", "[", "]") { session(it) }

    private fun sidebar() = """[{"id":"$LAUNCH","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":2},
        "taskCounts":{"done":3,"failed":1,"total":8},"attention":{},"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":1},
        "startedAt":${if (started) "\"2026-10-02T00:00:00Z\"" else "null"}},
        {"id":"$QUIET","title":"Quiet","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{},"attention":{},"startedAt":"2026-10-02T00:00:00Z"}]"""
    private val integration get() = """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":1,"queuedCount":0,
        "inFlight":{"kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskTitle":"Wire the page","startedAt":"${ago(3)}","heartbeatAt":"${ago(0)}"}}"""
    private val openItems get() = if (!startRequest) """{"needsYou":[],"withCoordinator":[]}""" else """{"needsYou":[],"withCoordinator":[],
        "startRequest":{"itemId":"start-1","waitingSince":"${ago(130)}","startRequest":{"criteriaDigest":"digest-1","why":"Everything is filed.",
        "settings":{"line":"PROJECT_BRANCH","automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null,"projectBranchName":"project/launch"}}}}"""
    private val project = """{"id":"$LAUNCH","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z","_count":{"tasks":8}}"""

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/") { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
        val method = api.method.name
        if (path == "auth/login") return@HttpTransport ok("""{"accessToken":"a05d-access","refreshToken":"a05d-refresh","user":{"id":"u1","email":"owner@a05d.test","name":"Owner"}}""")
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        calls += "$method $path" + if (query.isEmpty()) "" else "?$query"
        val view = api.query.firstOrNull { it.first == "view" }?.second ?: "open"
        val scoped = api.query.firstOrNull { it.first == "projectId" }?.second?.let { id -> ids.firstOrNull { ObjectId.same(it, id) } }
        when {
            path == "users/me" -> ok("""{"id":"u1","email":"owner@a05d.test","name":"Owner"}""")
            path == "workspaces" -> ok(workspaces)
            path == "runners" -> ok("""[{"id":"r1","name":"Fixture runner","online":true}]""")
            path == "sessions" && scoped == QUIET -> if (quietStatus == 200) ok("[]") else ApiResponse(quietStatus, """{"message":"The project's sessions are unavailable"}""".encodeToByteArray())
            path == "sessions" && scoped == LAUNCH -> ok(if (view == "open") list(COORD, WORKER, WAITING) else if (view == "completed") list(DONE) else "[]")
            path == "sessions" -> ok(when (view) { "open" -> list(COORD, WORKER, WAITING, PLAIN); "completed" -> list(DONE); else -> "[]" })
            api.path.size == 2 && path.startsWith("sessions/") && method == "GET" -> ok(session(path.removePrefix("sessions/")))
            path.startsWith("sessions/") && path.endsWith("/page") -> ok("""{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}""")
            path == "projects/sidebar" -> ok(sidebar())
            path == "projects" -> ok("""[$project,{"id":"$QUIET","title":"Quiet","status":"OPEN","createdAt":"2026-10-01T00:00:00Z"}]""")
            path == "projects/$LAUNCH" -> ok(project)
            path == "projects/$LAUNCH/integration" -> ok(integration)
            path == "projects/$LAUNCH/open-items" -> ok(openItems)
            path.startsWith("projects/") -> ok("{}")
            path.startsWith("wiki/") -> ApiResponse(404, """{"code":"WIKI_DISABLED","message":"The wiki is off."}""".encodeToByteArray())
            method == "GET" -> ok("[]")
            else -> ok("{}")
        }
    }

    /** The streams open and stay quiet: the account is connected, so writes are offered. */
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
    }, "a05d-shell", eventTransport = events)

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://a05d.test"), "owner@a05d.test", "fixture")
}

/** The shell's application with the controlled server in place of the network and the device stores. */
class ProjectShellApplication : OrbitApplication() {
    override fun createSession(): AuthSession = ProjectShell.session()
    // Unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
}
