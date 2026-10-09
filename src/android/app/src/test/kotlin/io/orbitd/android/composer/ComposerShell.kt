package io.orbitd.android.composer

import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.navigation.ObjectId
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.*

/** One controlled Orbit server for the A07c composer tests: the production Activity, AuthSession, RealtimeStore, session page
 * and composer over these answers — a session of one workspace on one runner, its transcript, the runner's engines and the
 * account's providers, each a test may replace. Every write is recorded with its body. Not a deployed backend. */
internal object ComposerShell {
    const val SESSION = "34A07cComposerSession1"
    const val WORKSPACE = "34A07cComposerWorkspc1"
    const val RUNNER = "34A07cComposerRunner01"

    /** Every request after the login, as `METHOD path?query`, and each write's body. */
    val calls = CopyOnWriteArrayList<String>()
    val bodies = CopyOnWriteArrayList<Pair<String, String>>()
    /** Fields over the session's detail (provider, model, status, retryAt…). */
    @Volatile var session: Map<String, JsonElement> = emptyMap()
    /** Fields over the workspace (its detail is also what a new session's composer reads). */
    @Volatile var workspace: Map<String, JsonElement> = emptyMap()
    /** The runner as GET /runners lists it. */
    @Volatile var runner: JsonObject = JsonObject(emptyMap())
    @Volatile var providers = "[]"
    @Volatile var pools = "[]"
    @Volatile var sharedPools = "[]"
    /** The transcript's durable events, as GET …/events/page answers them. */
    @Volatile var events: List<JsonObject> = emptyList()
    /** GET …/retry-message. */
    @Volatile var retryMessage = """{"text":""}"""
    /** Attachment bytes by id. */
    @Volatile var attachments: Map<String, ByteArray> = emptyMap()
    /** Answers for paths a test owns, before the defaults (`METHOD path` → response). */
    val answers = ConcurrentHashMap<String, () -> ApiResponse>()

    fun reset() {
        calls.clear(); bodies.clear(); answers.clear(); disk.clear()
        session = emptyMap(); workspace = emptyMap(); providers = "[]"; pools = "[]"; sharedPools = "[]"
        events = emptyList(); retryMessage = """{"text":""}"""; attachments = emptyMap()
        runner = obj("""{"id":"$RUNNER","name":"Fixture runner","online":true,"status":"ONLINE","version":"0.1.230",
            "engines":[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"yes"}],
            "modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}],"codex":[{"value":"gpt-6","label":"GPT-6"}]}}""")
    }

    fun obj(json: String) = Wire.json.parseToJsonElement(json).jsonObject
    fun fields(json: String): Map<String, JsonElement> = obj(json)

    private fun workspaceJson() = JsonObject(obj("""{"id":"$WORKSPACE","name":"Alpha","runnerId":"$RUNNER","enabled":true,"position":0,
        "provider":"claude","model":"claude-opus-5-5","createdAt":"2026-10-01T01:00:00.000Z"}""") + workspace)

    fun detail(): JsonObject = JsonObject(obj("""{"id":"$SESSION","title":"Composer increments","status":"AWAITING_INPUT",
        "runState":"AWAITING_INPUT","lifecycleState":"OPEN","provider":"claude","model":"claude-opus-5-5","assignedRunnerId":"$RUNNER",
        "agent":{"id":"$WORKSPACE","name":"Alpha"},"agentId":"$WORKSPACE","createdAt":"2026-10-08T08:00:00Z","lastTurnAt":"2026-10-09T01:00:00Z",
        "capabilities":{"canSend":true,"canResume":false,"canComplete":true},"tags":[],"pendingApprovals":0}""") + session)

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/") { part -> listOf(SESSION, WORKSPACE, RUNNER).firstOrNull { ObjectId.same(it, part) } ?: part }
        val method = api.method.name
        if (path == "auth/login") return@HttpTransport ok("""{"accessToken":"a07c-access","refreshToken":"a07c-refresh","user":{"id":"u1","email":"owner@a07c.test","name":"Owner"}}""")
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        calls += "$method $path" + if (query.isEmpty()) "" else "?$query"
        if (method != "GET") bodies += "$method $path" to (api.body?.decodeToString() ?: "")
        answers["$method $path"]?.let { return@HttpTransport it() }
        val attachment = api.path.takeIf { it.size == 2 && it[0] == "attachments" }?.get(1)
        when {
            path == "auth/methods" -> ApiResponse(404, """{"statusCode":404}""".encodeToByteArray())
            path == "auth/logout" -> ok("{}")
            path == "users/me" -> ok("""{"id":"u1","email":"owner@a07c.test","name":"Owner"}""")
            path == "workspaces" -> ok("[${workspaceJson()}]")
            path == "workspaces/$WORKSPACE" -> ok(workspaceJson().toString())
            path == "runners" -> ok("[$runner]")
            path == "providers" -> ok(providers)
            path == "providers/pools" -> ok(pools)
            path == "providers/shared-pools" -> ok(sharedPools)
            path == "sessions" && method == "GET" -> ok(if (api.query.any { it == "view" to "open" }) "[${detail()}]" else "[]")
            path == "sessions" && method == "POST" -> ok("""{"id":"$SESSION"}""")
            path == "sessions/$SESSION" && method == "GET" -> ok(detail().toString())
            path == "sessions/$SESSION" || path == "sessions/$SESSION/config" || path == "sessions/$SESSION/account" -> ok(detail().toString())
            path == "sessions/$SESSION/events/page" -> ok(buildJsonObject {
                put("events", JsonArray(events)); put("hasMore", false)
            }.toString())
            path == "sessions/$SESSION/retry-message" && method == "GET" -> ok(retryMessage)
            path == "sessions/$SESSION/turns" && method == "POST" || path == "sessions/$SESSION/resume" ->
                ok("""{"turnId":"turn-1","kind":"message","status":"PENDING"}""")
            attachment != null -> attachments.entries.firstOrNull { ObjectId.same(it.key, attachment) }?.let { ApiResponse(200, it.value) }
                ?: ApiResponse(404, """{"message":"not found"}""".encodeToByteArray())
            method == "GET" -> ok("[]")
            else -> ok("{}")
        }
    }

    /** The streams open and stay quiet: the account is connected, so writes are offered. */
    private val events_ = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
            onOpen()
            awaitCancellation()
        }
    }

    /** Drafts and outboxes are kept, as the device keeps them, for the life of the process. */
    private val disk = ConcurrentHashMap<String, ByteArray>()

    fun session() = AuthSession(transport, object : CredentialStore {
        private var value: StoredSession? = null
        override suspend fun load() = value
        override suspend fun save(session: StoredSession) { value = session }
        override suspend fun clear() { value = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) = Unit
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = disk["$kind:$key"]
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { disk["$kind:$key"] = bytes.copyOf() }
        override suspend fun clearAll() = disk.clear()
    }, "a07c-composer", dispatcher = Dispatchers.Unconfined, eventTransport = events_)

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://a07c.test"), "owner@a07c.test", "fixture")

    /** The last body written to `METHOD path`. */
    fun body(call: String): JsonObject? = bodies.lastOrNull { it.first == call }?.second?.takeIf { it.isNotEmpty() }?.let(::obj)
}

/** The composer tests' application: the controlled server in place of the network and the device stores. */
class ComposerShellApplication : OrbitApplication() {
    override fun createSession(): AuthSession = ComposerShell.session()
    // Unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
}
