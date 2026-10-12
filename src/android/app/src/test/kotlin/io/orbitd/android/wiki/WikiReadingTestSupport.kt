package io.orbitd.android.wiki

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpTransport
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.OrbitNavigation
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.*
import java.io.File

/** A shared file above the test's working directory, found the way core's `CardContractTest` finds its fixtures —
 * never a skip. */
internal fun wikiShared(relative: String): File = generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
    .map { File(it, relative) }.firstOrNull { it.isFile }
    ?: throw AssertionError("$relative was not found above ${System.getProperty("user.dir")}. If it moved, point this check at its new home — " +
        "don't delete the check.")

internal fun wikiJson(relative: String): JsonObject = Wire.json.parseToJsonElement(wikiShared(relative).readText()).jsonObject
internal fun wikiContract(): JsonObject = wikiJson("contracts/wiki.contract.json")
internal fun wikiArticlesFixture(): JsonObject = wikiJson("src/shared/src/wiki-articles.fixture.json")
internal fun wikiDocsFixture(): JsonObject = wikiJson("src/shared/src/wiki-docs.fixture.json")

internal fun <T> JsonElement.decodeAs(serializer: KSerializer<T>): T = Wire.json.decodeFromJsonElement(serializer, this)
internal fun <T> String.decodeAs(serializer: KSerializer<T>): T = Wire.json.decodeFromString(serializer, this)

internal fun JsonObject.obj(key: String): JsonObject = getValue(key).jsonObject
internal fun JsonObject.arr(key: String): JsonArray = getValue(key).jsonArray
internal fun JsonObject.str(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonObject.num(key: String): Int? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
internal val JsonArray.objects: List<JsonObject> get() = map { it.jsonObject }
internal val JsonArray.texts: List<String> get() = map { it.jsonPrimitive.content }
internal val JsonObject.keyList: List<String> get() = keys.toList()

/** A signed-in account whose server answers its login and, for everything else, `answer(path)` — a status and a body.
 * Requests run where they are made, so a page's read lands before the next frame. */
internal fun wikiSignedIn(answer: (List<String>) -> Pair<Int, String>): Pair<AuthSession, SessionHandle> {
    val transport = HttpTransport { request ->
        if (request.api.path == listOf("auth", "login")) ApiResponse(200,
            """{"accessToken":"fixture-access","refreshToken":"fixture-refresh","user":{"id":"u1","email":"fixture@example.test","name":"Fixture"}}""".encodeToByteArray())
        else answer(request.api.path).let { (status, body) -> ApiResponse(status, body.encodeToByteArray()) }
    }
    val auth = AuthSession(transport, object : CredentialStore {
        private var value: StoredSession? = null
        override suspend fun load() = value
        override suspend fun save(session: StoredSession) { value = session }
        override suspend fun clear() { value = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) {}
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
        override suspend fun clearAll() {}
    }, "test", dispatcher = Dispatchers.Unconfined)
    val handle = runBlocking { auth.login(ServerAddress.parse("https://fixture.test"), "fixture@example.test", "fixture-password") }
    return auth to handle
}

/** The Wiki store over such a server: one space, `orbit`, on GitHub. */
internal fun wikiTestStore(answer: (List<String>) -> Pair<Int, String>): WikiStore {
    val (auth, handle) = wikiSignedIn { path ->
        if (path == listOf("wiki", "spaces")) 200 to """[{"id":"sp1","slug":"orbit","repoUrlNorm":"github.com/jianghailong-xy/orbit"}]"""
        else answer(path)
    }
    return WikiStore(auth, handle, kotlinx.coroutines.CoroutineScope(Dispatchers.Unconfined))
}

/** Where a Wiki page's presses went: every route pushed, every stack change, every web page. */
internal class WikiNavRecord {
    val pushed = mutableListOf<OrbitRoute>()
    val changes = mutableListOf<(OrbitNavigation) -> OrbitNavigation>()
    val urls = mutableListOf<String>()
    val nav = WikiNav({ pushed += it }, { changes += it }, "https://fixture.test") { urls += it }
}
