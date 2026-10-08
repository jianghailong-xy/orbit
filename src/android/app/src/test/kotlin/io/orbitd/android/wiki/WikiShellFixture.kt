package io.orbitd.android.wiki

import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.watch.WatchFixture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*

/** One controlled Orbit server for the A12 shell tests: the production Activity, AuthSession, RealtimeStore and
 * navigation over these answers. A request can be held at a gate (and is recorded as answered or as cancelled
 * while it waited), the account stream is fed event by event, and the server's answers can be switched — a stale
 * op recorded `conflict`, a watch control refused. Not a deployed backend. */
internal object WikiShell {
    const val SPACE = WikiFixtures.spaceID
    const val OTHER_SPACE = "34UAqWikovaSpace000002"
    /** A space this account does not have: the server never lists it. */
    const val GONE_SPACE = "34UAqGoneSpace00000003"
    const val ENTRY = WikiFixtures.pitfallID
    const val AMEND_OP = "34UDOpAmendDeploy0003"
    const val AMEND_CHANGESET = "34UDCsAmendDeploy0003"
    const val WATCH = "01a0cca7-8609-70ed-a0e2-d4b55b832b80"
    const val DOC = "session-runtime"

    /** Every request after the login, as `METHOD path?query`. */
    val calls = CopyOnWriteArrayList<String>()
    /** How each held request ended, by `METHOD path`: `answered`, or `cancelled` while it waited at its gate. */
    val ended = ConcurrentHashMap<String, String>()
    private val gates = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    private val decided = ConcurrentHashMap.newKeySet<String>()
    /** What a decide records for the op it answers: `accepted`, or `conflict` for an op the entry moved past. */
    @Volatile var decision = "accepted"
    @Volatile var watchState = "ACTIVE"
    /** A pause answered 409 with this message, as for a watch that already ended. */
    @Volatile var pauseRefusal: String? = null
    /** The server has the wiki off for this account: every wiki route answers 404 WIKI_DISABLED. */
    @Volatile var wikiDisabled = false
    /** `GET /wiki/spaces` as the server lists the spaces. */
    @Volatile var spaces: String = WikiFixtures.spaces
    /** Every entry of the space, which `GET …/entries` answers as `WikiService.listEntries` does. */
    @Volatile var entries: List<JsonObject> = fixtureEntries()
    /** `GET /wiki/review` before any decide. */
    @Volatile var reviewQueue: String = WikiFixtures.review
    /** `GET /wiki/spaces/:id/plan` by space id; a space with none answers 404, as a server from before the plan. */
    @Volatile var plans: Map<String, String> = emptyMap()
    /** `GET /workspaces`: the directory's workspaces. */
    @Volatile var workspaces: String = "[]"
    /** `GET /wiki/spaces/:id/docs` (the shared fixture's directory read unless set), answered with [docsStatus]. */
    @Volatile var docs: String? = null
    @Volatile var docsStatus: Int = 200
    /** `GET /wiki/spaces/:id/articles`; none answers 404, as a server from before the articles. */
    @Volatile var articles: String? = null
    @Volatile private var frames = Channel<String>(Channel.UNLIMITED)
    @Volatile private var opened = 0

    fun reset() {
        calls.clear(); ended.clear(); gates.clear(); decided.clear()
        decision = "accepted"; watchState = "ACTIVE"; pauseRefusal = null
        wikiDisabled = false; spaces = WikiFixtures.spaces; entries = fixtureEntries(); reviewQueue = WikiFixtures.review
        plans = emptyMap(); workspaces = "[]"; docs = null; docsStatus = 200; articles = null
        frames = Channel(Channel.UNLIMITED); opened = 0
    }

    private fun fixtureEntries() = Wire.json.parseToJsonElement(WikiFixtures.entries).jsonArray.map { it.jsonObject }

    /** `WikiService.listEntries`: of the `kind` and `status` asked, newest recorded first, between 1 and 200 (50 unasked). */
    fun listEntries(store: List<JsonObject>, query: List<Pair<String, String>>): String {
        fun asked(key: String) = query.firstOrNull { it.first == key }?.second
        fun field(entry: JsonObject, key: String) = (entry[key] as? JsonPrimitive)?.contentOrNull
        val limit = (asked("limit")?.toIntOrNull() ?: 50).coerceIn(1, 200)
        return JsonArray(store.filter { entry -> asked("kind").let { it == null || field(entry, "kind") == it } &&
            asked("status").let { it == null || field(entry, "status") == it } }
            .sortedWith(compareByDescending<JsonObject> { field(it, "recordedAt") ?: "" }.thenByDescending { field(it, "id") ?: "" })
            .take(limit)).toString()
    }

    /** Hold the next `METHOD path` until the gate is completed. */
    fun hold(method: String, path: String): CompletableDeferred<Unit> = CompletableDeferred<Unit>().also { gates["$method $path"] = it }

    /** One account-stream event of [type] (the stream carries no payload these pages read). */
    fun event(type: String) { frames.trySend("""{"type":"$type","sessionId":"","data":{}}""") }

    fun count(prefix: String) = calls.count { it.startsWith(prefix) }
    fun writes(path: String) = calls.filter { !it.startsWith("GET ") && it.substringAfter(' ').substringBefore('?') == path }

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())
    private fun status(code: Int, body: String) = ApiResponse(code, body.encodeToByteArray())

    private fun user() = """{"id":"u1","email":"owner@a12.test","name":"Owner"}"""
    private fun otherSpace() = WikiFixtures.space.replace(SPACE, OTHER_SPACE).replace("\"orbit\"", "\"wikova\"")
        .replace("\"Orbit\"", "\"Wikova\"")
    private fun review(): String = JsonArray(Wire.json.parseToJsonElement(reviewQueue).jsonArray.map { changeset ->
        val ops = changeset.jsonObject.getValue("ops").jsonArray.filter { it.jsonObject.getValue("id").jsonPrimitive.content !in decided }
        JsonObject(changeset.jsonObject + ("ops" to JsonArray(ops)))
    }).toString()
    /** A decide's answer: the changeset as it now stands, the answered op carrying what was recorded for it. */
    private fun decidedChangeset(changeset: String, opId: String): String {
        val row = Wire.json.parseToJsonElement(reviewQueue).jsonArray.map { it.jsonObject }
            .firstOrNull { it.getValue("id").jsonPrimitive.content == changeset } ?: return "{}"
        val ops = row.getValue("ops").jsonArray.map { op ->
            if (op.jsonObject.getValue("id").jsonPrimitive.content != opId) op
            else JsonObject(op.jsonObject + ("decision" to JsonPrimitive(decision)))
        }
        return JsonObject(row + ("ops" to JsonArray(ops))).toString()
    }
    private fun watch() = WatchFixture.json(id = WATCH, state = watchState, action = "NOTIFY_USER", observer = null).toString()
    private val docsFixture = wikiDocsFixture().obj("docs")

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/")
        val method = api.method.name
        if (path == "auth/login") return@HttpTransport ok("""{"accessToken":"a12-access","refreshToken":"a12-refresh","user":${user()}}""")
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        calls += "$method $path" + if (query.isEmpty()) "" else "?$query"
        val key = "$method $path"
        // The answer is what the server held when the request arrived; a held request only answers later.
        val answer = respond(api, path, method)
        gates.remove(key)?.let { gate ->
            try { gate.await() } catch (cancel: CancellationException) { ended[key] = "cancelled"; throw cancel }
            ended[key] = "answered"
        }
        answer
    }

    /** A path's ids in either spelling (a link hands the app a UUID, the lists name public ids): spelled as the fixture's. */
    private fun spelled(path: List<String>): String = path.joinToString("/") { part ->
        listOf(SPACE, OTHER_SPACE, ENTRY, WATCH, AMEND_CHANGESET).firstOrNull { ObjectId.same(it, part) } ?: part
    }

    private fun respond(api: ApiRequest, raw: String, method: String): ApiResponse {
        val path = spelled(api.path)
        fun body() = Wire.json.parseToJsonElement(api.body!!.decodeToString()).jsonObject
        return when {
            path == "auth/logout" -> ok("{}")
            path == "users/me" -> ok(user())
            wikiDisabled && path.startsWith("wiki/") -> status(404,
                """{"code":"WIKI_DISABLED","message":"The Orbit wiki is not on for this account on this Orbit server (ORBIT_WIKI=canary), so nothing was read from it or written to it."}""")
            path == "wiki/spaces" -> ok(spaces)
            path == "wiki/spaces/$SPACE" && method == "PATCH" -> ok(WikiFixtures.space)
            path == "wiki/spaces/$SPACE" -> ok(WikiFixtures.space)
            path == "wiki/spaces/$OTHER_SPACE" -> ok(otherSpace())
            path.endsWith("/entries") && path.startsWith("wiki/spaces/") -> ok(listEntries(entries, api.query))
            path.startsWith("wiki/spaces/") && path.endsWith("/plan") -> plans[api.path[2]]?.let(::ok) ?: plans[path.split('/')[2]]?.let(::ok)
                ?: status(404, """{"message":"not found"}""")
            path == "workspaces" -> ok(workspaces)
            path.endsWith("/timeline") -> ok(WikiFixtures.timeline)
            path.endsWith("/docs") -> status(docsStatus, if (docsStatus == 200) docs ?: docsFixture.obj("directory").obj("read").toString() else """{"message":"unavailable"}""")
            path.endsWith("/articles") && articles != null -> ok(articles!!)
            path.endsWith("/docs/$DOC") -> ok(docsFixture.obj("doc").obj("read").toString())
            path.endsWith("/doc-index") -> ok(buildJsonObject { put("plan", docsFixture.obj("directory").obj("read").obj("plan")); put("items", docsFixture.obj("index").arr("items")) }.toString())
            path == "wiki/spaces/$SPACE/changesets" -> ok("""{"changesetId":"34UDCsOwnerEdit000009","ops":[{"seq":0,"status":"applied","entryId":"$ENTRY","revision":5}]}""")
            path == "wiki/entries/$ENTRY" -> ok(WikiFixtures.entryDetail)
            path == "wiki/review" -> ok(review())
            path.startsWith("wiki/changesets/") && path.endsWith("/decide") -> {
                val opId = body().getValue("decisions").jsonArray[0].jsonObject.getValue("opId").jsonPrimitive.content
                decided += opId
                ok(decidedChangeset(api.path[2], opId))
            }
            path == "link-previews" -> ok("""{"previews":[]}""")
            path == "watches" -> ok("[${watch()}]")
            path == "watches/$WATCH" -> ok(watch())
            path == "watches/$WATCH/pause" -> pauseRefusal?.let { status(409, """{"message":"$it","state":"MATCHED"}""") }
                ?: run { watchState = "PAUSED"; ok(watch()) }
            path == "watches/$WATCH/resume" -> { watchState = "ACTIVE"; ok(watch()) }
            path == "watches/$WATCH/cancel" -> { watchState = "CANCELLED"; ok(watch()) }
            path.startsWith("wiki/") -> status(404, """{"message":"not found"}""")
            else -> ok("[]")
        }
    }

    /** The account stream: every (re)connect opens and takes the events queued for it; a session's stream stays quiet. */
    val events = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) {
            if (request.api.path != listOf("events")) awaitCancellation()
            opened++
            calls += "STREAM events #$opened"
            onOpen()
            for (frame in frames) { calls += "EVENT ${Wire.json.parseToJsonElement(frame).jsonObject.getValue("type").jsonPrimitive.content}"; onFrame(SseFrame(frame, null, null)) }
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
    }, "a12-shell", eventTransport = events)

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://a12.test"), "owner@a12.test", "fixture")
}

/** The shell's application with the controlled server in place of the network and the device stores. */
class WikiShellApplication : OrbitApplication() {
    override fun createSession(): AuthSession = WikiShell.session()
}
