package io.orbitd.android

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.navigation.ObjectId
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.awaitCancellation

/** One controlled Orbit server for the A05c shell tests: the production Activity, AuthSession, RealtimeStore and
 * navigation over these answers. Three workspaces as `GET /workspaces` orders them (position asc), the runner-less
 * one placed between the two with a runner; a task; sessions of the first workspace; an open project. Not a deployed
 * backend. */
internal object NavShell {
    const val ALPHA = "34A05cWorkspaceAlpha01"
    const val SPARE = "34A05cWorkspaceSpare02"
    const val BETA = "34A05cWorkspaceBeta003"
    const val TASK = "34A05cTaskAssignMe0001"
    const val PROJECT = "34A05cProjectLaunch001"
    /** An open session of Alpha, run by the task [TASK]. */
    const val SESSION = "34A05cSessionReview001"
    /** An open session of Alpha in no task and no project. */
    const val PLAIN = "34A05cSessionPlain0002"

    /** Every request after the login, as `METHOD path?query`. */
    val calls = CopyOnWriteArrayList<String>()
    /** The lifecycle and run of each session, which the session writes move. */
    @Volatile var lifecycle: Map<String, String> = emptyMap()
    @Volatile var running: Set<String> = emptySet()
    /** Sessions whose run has ended: nothing is left to stop. The rest wait for input, which iOS counts as live. */
    @Volatile var ended: Set<String> = emptySet()
    /** A write answered with this status and message instead of 200. */
    @Volatile var refuse: Pair<Int, String>? = null
    /** What the runner answers a merge of [PLAIN]'s worktree with: `merged`, or `conflict`; null before any merge. */
    @Volatile var mergeAnswer = "merged"
    @Volatile var mergeStatus: String? = null

    fun reset() {
        calls.clear(); refuse = null; mergeAnswer = "merged"; mergeStatus = null
        lifecycle = mapOf(SESSION to "OPEN", PLAIN to "OPEN"); running = emptySet(); ended = emptySet()
    }

    val workspaces = """[
        {"id":"$ALPHA","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"},
        {"id":"$SPARE","name":"Spare","runnerId":null,"enabled":true,"position":1,"createdAt":"2026-10-01T02:00:00.000Z"},
        {"id":"$BETA","name":"Beta","runnerId":"r1","enabled":true,"position":2,"createdAt":"2026-10-01T03:00:00.000Z"}]"""

    private fun session(id: String): String {
        val title = if (id == SESSION) "Review navigation" else "Plain notes"
        val state = lifecycle[id] ?: "OPEN"
        val run = when (id) { in running -> "RUNNING"; in ended -> "ENDED"; else -> "AWAITING_INPUT" }
        val linked = if (id == SESSION) ""","taskId":"$TASK","projectId":"$PROJECT"""" else
            // Plain notes works in a worktree with one committed change: its bar offers Merge to main.
            ""","isolationStatus":"worktree","branch":"orbit/plain-notes-a05c","worktreeDirty":false,"mergeTargets":["main"],
            "changedFiles":[{"path":"notes.md","additions":3,"deletions":1,"status":"M"}],"mergeTarget":"main"""" +
                (mergeStatus?.let { ""","mergeStatus":"$it"""" } ?: "") +
                (if (mergeStatus == "conflict") ""","mergeError":"CONFLICT (content): notes.md"""" else "")
        return """{"id":"$id","title":"$title","status":"${if (run == "ENDED") "CANCELLED" else run}",
            "runState":"$run","lifecycleState":"$state",
            "agent":{"id":"$ALPHA","name":"Alpha"},"agentId":"$ALPHA","createdAt":"2026-10-08T08:00:00Z","lastTurnAt":"2026-10-09T01:00:00Z",
            "capabilities":{"canComplete":${state == "OPEN"},"canRestore":${state != "OPEN"}},"tags":[],"pendingApprovals":0$linked}"""
    }
    private fun view(name: String) = "[" + listOf(SESSION, PLAIN).filter { (lifecycle[it] ?: "OPEN") == name.uppercase() }
        .joinToString(",") { session(it) } + "]"

    private val task = """{"id":"$TASK","title":"Assign me","status":"OPEN","priority":0,"createdAt":"2026-10-08T00:00:00Z",
        "updatedAt":"2026-10-08T00:00:00Z","creatorType":"USER","comments":[],"dependsOn":[],"dependedOnBy":[]}"""
    private val project = """{"id":"$PROJECT","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z"}"""

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/") { part -> listOf(ALPHA, SPARE, BETA, TASK, PROJECT, SESSION, PLAIN).firstOrNull { ObjectId.same(it, part) } ?: part }
        val method = api.method.name
        if (path == "auth/login") return@HttpTransport ok("""{"accessToken":"a05c-access","refreshToken":"a05c-refresh","user":{"id":"u1","email":"owner@a05c.test","name":"Owner"}}""")
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        calls += "$method $path" + if (query.isEmpty()) "" else "?$query"
        if (method != "GET") refuse?.let { (status, message) -> return@HttpTransport ApiResponse(status, """{"message":"$message"}""".encodeToByteArray()) }
        val id = api.path.getOrNull(1)?.let { part -> listOf(SESSION, PLAIN).firstOrNull { ObjectId.same(it, part) } }
        when {
            path == "auth/logout" -> ok("{}")
            path == "users/me" -> ok("""{"id":"u1","email":"owner@a05c.test","name":"Owner"}""")
            path == "workspaces" -> ok(workspaces)
            path == "runners" -> ok("""[{"id":"r1","name":"Fixture runner","online":true}]""")
            path == "sessions" -> ok(view(api.query.firstOrNull { it.first == "view" }?.second ?: "open"))
            id != null && api.path.size == 2 && method == "GET" -> ok(session(id))
            id != null && api.path.size == 2 && method == "PATCH" -> ok(session(id))
            id != null && api.path.last() == "complete" -> { lifecycle = lifecycle + (id to "COMPLETED"); ok("{}") }
            id != null && api.path.last() == "restore" -> { lifecycle = lifecycle + (id to "OPEN"); ok("{}") }
            id != null && api.path.size == 2 && method == "DELETE" -> { lifecycle = lifecycle + (id to "TRASH"); ok("{}") }
            id != null && api.path.last() == "page" -> ok("""{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}""")
            id != null && api.path.last() == "merge" -> { mergeStatus = mergeAnswer; ok("{}") }
            path == "tasks/page" -> ok("""{"items":[$task],"nextCursor":null}""")
            path == "tasks/$TASK" -> ok(task)
            path.startsWith("tasks/") -> ok("{}")
            path == "projects" -> ok("[$project]")
            path == "projects/$PROJECT" -> ok(project)
            path.startsWith("projects/") -> ok("{}")
            path.startsWith("wiki/") -> ApiResponse(404, """{"code":"WIKI_DISABLED","message":"The wiki is off."}""".encodeToByteArray())
            method == "GET" -> ok("[]")
            else -> ok("{}")
        }
    }

    /** The streams open and stay quiet: the account is connected, so writes are offered. */
    val events = object : EventTransport {
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
    }, "a05c-shell", eventTransport = events)

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://a05c.test"), "owner@a05c.test", "fixture")
}

/** The shell's application with the controlled server in place of the network and the device stores. */
class NavShellApplication : OrbitApplication() {
    override fun createSession(): AuthSession = NavShell.session()
    // Unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
}
