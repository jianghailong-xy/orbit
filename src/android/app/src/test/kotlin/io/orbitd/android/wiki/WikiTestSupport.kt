package io.orbitd.android.wiki

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.*

/** A shared file found by walking up from the test's working directory — never a skip: a fixture that moved fails here. */
internal object WikiSharedFiles {
    fun file(relative: String): File {
        val start = File(System.getProperty("user.dir") ?: ".").absoluteFile
        return generateSequence(start) { it.parentFile }.map { File(it, relative) }.firstOrNull { it.isFile }
            ?: throw AssertionError("$relative was not found above $start. The plan and settings pages are one half of a pair; " +
                "if the other half moved, move this check with it rather than deleting it.")
    }
    fun json(relative: String): JsonObject = Wire.json.parseToJsonElement(file(relative).readText()).jsonObject
    val docs: JsonObject by lazy { json("src/shared/src/wiki-docs.fixture.json") }
    val reviewMode: JsonObject by lazy { json("src/shared/src/wiki-review-mode.fixture.json") }
    val serverExecution: JsonObject by lazy { json("src/shared/src/wiki-server-execution.fixture.json") }
    val health: JsonObject by lazy { json("src/shared/src/wiki-health.fixture.json") }
    val contract: JsonObject by lazy { json("contracts/wiki.contract.json") }
}

internal fun JsonElement?.fobj(key: String): JsonObject = (this as JsonObject)[key] as? JsonObject ?: throw AssertionError("no object `$key`")
internal fun JsonElement?.farr(key: String): JsonArray = (this as JsonObject)[key] as? JsonArray ?: throw AssertionError("no array `$key`")
internal fun JsonElement?.fstr(key: String): String = this[key].text() ?: throw AssertionError("no string `$key`")
internal fun JsonElement?.fstrings(key: String): List<String> = farr(key).map { it.jsonPrimitive.content }
internal fun JsonElement?.fint(key: String): Int = this[key].integer() ?: throw AssertionError("no integer `$key`")
internal fun <T> JsonElement.decode(serializer: KSerializer<T>): T = Wire.json.decodeFromJsonElement(serializer, this)

/** The `plan` half of `wiki-docs.fixture.json` as the pages read it: its versions, proposals and jobs, and each named
 * state built the way the shared cases build it (OrbitKit `WikiPlanCopyParityTests.state`). */
internal object WikiPlanFixture {
    val shared: JsonObject get() = WikiSharedFiles.docs
    val plan: JsonObject get() = shared.fobj("plan")
    val now get() = RelativeTime.parse(shared.fstr("now"))!!
    val zone: java.time.ZoneId get() = java.time.ZoneId.of(shared.fstr("timeZone"))
    val directory: WikiDocsDirectory get() = shared.fobj("docs").fobj("directory").fobj("read").decode(WikiDocsDirectory.serializer())
    val proposals: List<WikiPlanProposal> get() = plan.farr("proposals").decode(kotlinx.serialization.builtins.ListSerializer(WikiPlanProposal.serializer()))
    fun version(key: String) = plan.fobj("versions").fobj(key).decode(WikiPlanVersion.serializer())
    fun spec(name: String): JsonObject = plan.fobj("states").fobj(name).fobj("spec")
    fun online(name: String) = spec(name)["runnerOnline"].bool()
    fun state(name: String) = state(spec(name))
    fun state(spec: JsonObject) = WikiPlanState("sp1", if (spec["confirmed"].text() == "v1") version("v1") else null,
        if (spec["draft"].text() == "v2") version("v2") else null, if (spec["proposals"].bool() == true) proposals else emptyList(),
        spec["job"].text()?.let { WikiPlanJob.read(plan.fobj("jobs")[it]) })
    /** The state as `GET /api/wiki/spaces/:id/plan` answers it. */
    fun read(name: String): JsonObject {
        val spec = spec(name)
        return buildJsonObject {
            put("spaceId", "sp1")
            put("confirmed", if (spec["confirmed"].text() == "v1") plan.fobj("versions").fobj("v1") else JsonNull)
            put("draft", if (spec["draft"].text() == "v2") plan.fobj("versions").fobj("v2") else JsonNull)
            put("proposals", if (spec["proposals"].bool() == true) plan.farr("proposals") else JsonArray(emptyList()))
            put("job", spec["job"].text()?.let { plan.fobj("jobs").fobj(it) } ?: JsonNull)
        }
    }
}

/** `DRAFT_FAILED` as the web spells it: `draftFailed`. */
internal fun camel(name: String): String = name.lowercase().split('_').mapIndexed { i, part ->
    if (i == 0) part else part.replaceFirstChar(Char::uppercase) }.joinToString("")

/** A signed-in account over an in-memory server: every request after the login is recorded and answered by
 * [answer] (status and body), or 404. Requests run on the caller's thread, so a write lands before the press returns. */
internal class WikiTestRig(private val answer: (ApiRequest) -> Pair<Int, String>?) {
    val requests = CopyOnWriteArrayList<ApiRequest>()
    val auth = AuthSession(HttpTransport { request ->
        if (request.api.path == listOf("auth", "login")) ApiResponse(200,
            """{"accessToken":"wiki-access","refreshToken":"wiki-refresh","user":{"id":"u1","email":"owner@example.test","name":"Owner"}}""".encodeToByteArray())
        else {
            requests += request.api
            val (status, body) = answer(request.api) ?: (404 to """{"message":"not found"}""")
            ApiResponse(status, body.encodeToByteArray())
        }
    }, object : CredentialStore {
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
    }, "test", dispatcher = Dispatchers.Unconfined)
    val handle: SessionHandle = runBlocking { auth.login(ServerAddress.parse("https://wiki.test"), "owner@example.test", "fixture-password") }
    fun store(scope: CoroutineScope = CoroutineScope(Dispatchers.Unconfined)) = WikiStore(auth, handle, scope)
    /** `PATCH wiki/spaces/sp1`-style: the method and the path as the server sees it. */
    fun line(request: ApiRequest) = "${request.method} /api/${request.path.joinToString("/")}"
    fun body(request: ApiRequest): JsonElement? = request.body?.decodeToString()?.let(Wire.json::parseToJsonElement)
}
