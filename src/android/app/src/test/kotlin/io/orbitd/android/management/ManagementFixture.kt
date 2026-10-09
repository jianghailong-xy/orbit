package io.orbitd.android.management

import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.json.*
import java.io.IOException
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

/** One controlled Orbit server for the A13 JVM tests: the routes these pages read and write, what was sent, and switches for failures. */
object ManagementFixture {
    const val WORKSPACE = "0198f3a2-1111-7000-8000-000000000001"
    const val RUNNER = "0198f3a2-2222-7000-8000-000000000002"
    const val SESSION = "0198f3a2-3333-7000-8000-000000000003"
    const val POOL = "0198f3a2-4444-7000-8000-000000000004"
    const val ME = "0198f3a2-5555-7000-8000-000000000005"
    const val OTHER = "0198f3a2-6666-7000-8000-000000000006"
    const val RUNNER_TWO = "0198f3a2-7777-7000-8000-000000000007"
    const val TASK = "0198f3a2-8888-7000-8000-000000000008"
    const val KEY_DEEPSEEK = "0198f3a2-9999-7000-8000-000000000009"
    const val KEY_HARNESS = "0198f3a2-aaaa-7000-8000-00000000000a"
    const val KEY_OPENAI = "0198f3a2-bbbb-7000-8000-00000000000b"

    val calls = CopyOnWriteArrayList<String>()
    /** The calls that carried a query, with it: "GET providers/mine/<id>/balance?refresh=1". */
    val queries = CopyOnWriteArrayList<String>()
    /** The account's switch for smart model selection as users/me's preferences carry it; null leaves it out, as before it was written. */
    @Volatile var modelRouting: Boolean? = null
    /** The account's Session recaps switch as users/me's preferences carry it; null leaves it out, as before it was written. */
    @Volatile var recaps: Boolean? = null
    /** GET access-tokens' tokens, newest first; DELETE access-tokens/:id revokes one (REVOKED, by its USER). */
    @Volatile var accessTokens: List<JsonObject> = emptyList()
    @Volatile var accessTokensFail = false
    /** GET providers (the pickers' catalogue, no ids) and GET providers/mine (the account's own, with ids, endpoints and hasApiKey). */
    @Volatile var providerCatalog = "[]"
    @Volatile var providersMine = "[]"
    /** Each DeepSeek key's balance answer by provider id, and a gate that holds a key's read until it completes. */
    val balances = java.util.concurrent.ConcurrentHashMap<String, String>()
    val balanceGates = java.util.concurrent.ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    /** GET tasks/:id for [TASK]. */
    @Volatile var task = "{}"
    @Volatile var workspaceName = "Alpha"
    @Volatile var runnerAlias = "Old alias"
    @Volatile var runnerCapacity = 2
    @Volatile var poolLabel = "Team Codex"
    @Volatile var theme = "system"
    @Volatile var shareFails = false
    @Volatile var accessFails = false
    /** The viewer's place in the pool: ADMIN and creator (its owner), ADMIN, or MEMBER. */
    @Volatile var viewerRole = "ADMIN"
    @Volatile var viewerCreates = true
    @Volatile var membersCanAdd = false
    @Volatile var membersCanAddAccounts = false
    @Volatile var loginState = "ACTIVE"
    @Volatile var secondRunner = false
    @Volatile var runnerOrder = listOf(RUNNER, RUNNER_TWO)
    @Volatile var removedRunners = emptySet<String>()
    /** The runner's selfUpdate report's state; null is a runner too old to report one. */
    @Volatile var selfUpdate: String? = null
    /** The runner's engines as GET /runners reports them, and more of its members (`,"capabilities":[…],"antigravity":{…}`). */
    @Volatile var runnerEngines = "[]"
    @Volatile var runnerExtra = ""
    /** The sign-in relay as GET runners/:id/login reads it. POST login answers [loginStarted] and POST login/code [codeSent],
     * each of which it then reads; DELETE cancels it. The bodies sent are kept, in order. */
    @Volatile var loginRelay = """{"status":null}"""
    @Volatile var loginStarted = """{"status":"pending"}"""
    @Volatile var codeSent = """{"status":"done"}"""
    /** Run when a code is sent, as a runner reports the account it signed in on its next check-in. */
    @Volatile var onCode: () -> Unit = {}
    val loginBodies = CopyOnWriteArrayList<JsonObject>()
    val pauseBodies = CopyOnWriteArrayList<String>()
    /** Completing it drops the control stream; a reconnect then never opens. */
    @Volatile var drop = CompletableDeferred<Unit>()
    @Volatile private var opened = 0

    fun reset() {
        calls.clear(); workspaceName = "Alpha"; runnerAlias = "Old alias"; runnerCapacity = 2; poolLabel = "Team Codex"; theme = "system"; shareFails = false; accessFails = false
        viewerRole = "ADMIN"; viewerCreates = true; membersCanAdd = false; membersCanAddAccounts = false; loginState = "ACTIVE"
        secondRunner = false; runnerOrder = listOf(RUNNER, RUNNER_TWO); removedRunners = emptySet(); selfUpdate = null
        runnerEngines = "[]"; runnerExtra = ""; loginRelay = """{"status":null}"""; loginStarted = """{"status":"pending"}"""
        codeSent = """{"status":"done"}"""; onCode = {}; loginBodies.clear(); pauseBodies.clear()
        drop = CompletableDeferred(); opened = 0
        queries.clear(); modelRouting = null; accessTokens = emptyList(); accessTokensFail = false; providerCatalog = "[]"; providersMine = "[]"
        balances.clear(); balanceGates.clear(); task = "{}"
    }

    fun writes(path: String) = calls.filter { it.endsWith(" $path") && !it.startsWith("GET ") }

    /** Requests answer on the caller's thread, as WatchFixture's do. On IO a page's load resumed on the IO worker under the Compose
     *  rule's unconfined effects and wrote its state there, racing the first composition (an NPE in addPendingInvalidationsLocked). */
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
    }, "a13-test", dispatcher = Dispatchers.Unconfined, eventTransport = events)

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://example.test"), "a13@example.test", "fixture")

    private val now get() = Instant.now()
    private fun user() = """{"id":"$ME","email":"a13@example.test","name":"Fixture","role":"MEMBER","avatarUpdatedAt":null,
        "preferences":{"theme":"$theme","defaultPermissionMode":"auto","enableOrchestration":true${modelRouting?.let { ",\"modelRouting\":$it" }.orEmpty()}${recaps?.let { ",\"recaps\":$it" }.orEmpty()}}}"""
    private fun workspace() = """{"id":"$WORKSPACE","name":"$workspaceName","runnerId":"$RUNNER","enabled":true,"workDir":"/srv/alpha",
        "lastProvider":"claude","effort":"","modelRouting":false,"env":{},"position":0,"createdAt":"2026-09-01T00:00:00Z"}"""
    private fun runners() = runnerOrder.filter { (it == RUNNER || secondRunner) && it !in removedRunners }.joinToString(",", "[", "]") { if (it == RUNNER) runner() else runnerTwo() }
    private fun runnerTwo() = """{"id":"$RUNNER_TWO","name":"spare","displayName":"Spare box","hostname":"spare-01","version":"0.1.200","online":true,
        "status":"ONLINE","lastHeartbeatAt":"$now","maxConcurrent":1,"activeSessions":0,"runsAsRoot":false,"minFreeDiskMb":null,"engines":[],"enrolledAt":"2026-09-02T00:00:00Z"}"""
    private fun runner() = """{"id":"$RUNNER","name":"box","displayName":"$runnerAlias","hostname":"box-01","version":"0.1.200","online":true,
        "status":"ONLINE","lastHeartbeatAt":"$now","maxConcurrent":$runnerCapacity,"activeSessions":0,"runsAsRoot":false,"minFreeDiskMb":null,
        "selfUpdate":${selfUpdate?.let { """{"state":"$it"}""" } ?: "null"},"engines":$runnerEngines$runnerExtra,"enrolledAt":"2026-09-01T00:00:00Z"}"""
    private fun sessionRow() = """{"id":"$SESSION","title":"Fixture session","status":"SUCCEEDED","lifecycleState":"OPEN","workspaceId":"$WORKSPACE",
        "agentId":"$WORKSPACE","createdAt":"${now.minusSeconds(600)}","lastTurnAt":"${now.minusSeconds(300)}","pendingApprovals":0}"""
    private fun link() = """{"id":"L1","token":"fixture-token","kind":"SESSION","state":"ACTIVE","root":{"id":"$SESSION","title":"Fixture session"},
        "include":{"toolOutput":true},"viewCount":0}"""
    private fun login() = """{"state":"$loginState","email":"me@example.test","plan":"plus","fingerprint":"…AB12","userId":"$ME","next":true}"""
    private fun pools() = """[{"id":"$POOL","slug":"team-codex","label":"$poolLabel","engine":"codex","logins":[${login()}]}]"""
    private fun access() = """{"id":"$POOL","slug":"team-codex","label":"$poolLabel","engine":"codex","shared":false,"logins":[${login()}],
        "membersCanAdd":$membersCanAdd,"membersCanAddAccounts":$membersCanAddAccounts,"ownKeyFirst":false,"viewerRole":"$viewerRole",
        "people":[{"userId":"$ME","name":"Fixture","role":"$viewerRole","creator":$viewerCreates,"you":true,"keys":1,"sessions":1},
          {"userId":"$OTHER","name":"Owner Two","role":"${if (viewerCreates) "MEMBER" else "ADMIN"}","creator":${!viewerCreates},"you":false,"keys":0,"sessions":0}],
        "keys":[{"id":"K1","label":"Team key","fingerprint":"sk-…9XYZ","state":"ACTIVE","enabled":true,"contributor":{"userId":"$ME","name":"Fixture","you":true},
          "usage":{"inputTokens":0,"outputTokens":0,"costUsd":0}}]}"""

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())
    private fun fail(status: Int, message: String) = ApiResponse(status, """{"statusCode":$status,"message":"$message"}""".encodeToByteArray())

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/")
        calls += "${api.method} $path"
        if (api.query.isNotEmpty()) queries += "${api.method} $path?" + api.query.joinToString("&") { (k, v) -> "$k=$v" }
        fun body() = Json.parseToJsonElement(api.body!!.decodeToString()).jsonObject
        when (path) {
            "auth/login" -> ok("""{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":${user()}}""")
            "auth/logout" -> ok("{}")
            "users/me" -> ok(user())
            "users/me/preferences" -> {
                body()["theme"]?.let { theme = it.jsonPrimitive.content }
                body()["modelRouting"]?.let { modelRouting = it.jsonPrimitive.boolean }
                body()["recaps"]?.let { recaps = it.jsonPrimitive.boolean }
                ok(user())
            }
            "access-tokens" -> if (accessTokensFail) fail(503, "token list failed") else ok("""{"tokens":${JsonArray(accessTokens)}}""")
            "providers" -> ok(providerCatalog)
            "providers/mine" -> ok(providersMine)
            "tasks/$TASK" -> ok(task)
            "users/me/avatar" -> fail(404, "no avatar")
            "workspaces" -> ok("[${workspace()}]")
            "workspaces/$WORKSPACE" -> { if (api.method == HttpMethod.PATCH) workspaceName = body()["name"]!!.jsonPrimitive.content; ok(workspace()) }
            "runners" -> ok(runners())
            "runners/reorder" -> { runnerOrder = body()["ids"]!!.jsonArray.map { it.jsonPrimitive.content }; ok(runners()) }
            "runners/$RUNNER_TWO" -> if (api.method == HttpMethod.DELETE) { removedRunners = removedRunners + RUNNER_TWO; ok("{}") } else ok(runnerTwo())
            "runners/$RUNNER" -> {
                if (api.method == HttpMethod.DELETE) { removedRunners = removedRunners + RUNNER; return@HttpTransport ok("{}") }
                if (api.method == HttpMethod.PATCH) body().let { patch ->
                    patch["displayName"]?.let { runnerAlias = it.jsonPrimitive.content }
                    patch["maxConcurrent"]?.let { runnerCapacity = it.jsonPrimitive.int }
                }
                ok(runner())
            }
            "runners/$RUNNER/login" -> when (api.method) {
                HttpMethod.POST -> { loginBodies += body(); loginRelay = loginStarted; ok(loginRelay) }
                HttpMethod.DELETE -> { loginRelay = """{"status":"cancelled"}"""; ok(loginRelay) }
                else -> ok(loginRelay)
            }
            "runners/$RUNNER/login/code" -> { loginBodies += body(); loginRelay = codeSent; onCode(); ok(loginRelay) }
            "runners/$RUNNER/self-update" -> ok("""{"requestedAt":"$now"}""")
            "sessions" -> ok(if (api.query.contains("view" to "open")) "[${sessionRow()}]" else "[]")
            "sessions/$SESSION/share" -> when {
                shareFails -> fail(503, "share read failed")
                api.method == HttpMethod.GET -> ok("""{"link":${link()},"counts":{"messages":3,"toolCalls":1}}""")
                api.method == HttpMethod.DELETE -> ok("{}")
                else -> ok(link())
            }
            "providers/pools" -> ok(pools())
            "share-links" -> ok("""{"links":[${link()}]}""")
            "providers/shared-pools" -> ok("[]")
            "providers/shared-pools/$POOL" -> if (accessFails) fail(503, "pool read failed") else ok(access())
            else -> when {
                path.startsWith("runners/$RUNNER/accounts/") && path.endsWith("/pause") -> { pauseBodies += "$path ${api.body!!.decodeToString()}"; ok("{}") }
                path.startsWith("access-tokens/") && api.method == HttpMethod.DELETE -> {
                    val id = path.removePrefix("access-tokens/")
                    accessTokens = accessTokens.map { if (it["id"]?.jsonPrimitive?.content == id) JsonObject(it + mapOf("state" to JsonPrimitive("REVOKED"),
                        "revokedAt" to JsonPrimitive(now.toString()), "revokedReason" to JsonPrimitive("USER"))) else it }
                    ok("""{"id":"$id","revokedAt":"$now","revokedReason":"USER"}""")
                }
                path.startsWith("providers/mine/") && path.endsWith("/balance") -> {
                    val id = path.removePrefix("providers/mine/").removeSuffix("/balance")
                    balanceGates[id]?.await()
                    balances[id]?.let(::ok) ?: fail(404, "Not Found")
                }
                else -> ok("[]")
            }
        }
    }

    val events = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
            if (request.api.path != listOf("events") || opened++ > 0) awaitCancellation()
            onOpen()
            drop.await()
            throw IOException("control stream dropped")
        }
    }
}

/** The shell's application with the controlled server in place of the network and the device stores. */
class ManagementShellApplication : OrbitApplication() {
    override fun createSession(): AuthSession = ManagementFixture.session()
}
