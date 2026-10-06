package io.orbitd.android.management

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*

/** Management uses the same account generation and rotating credentials as the rest of Orbit. */
class ManagementApi(val session: OrbitApi, val handle: SessionHandle) {
    suspend fun get(path: String, query: List<Pair<String, String>> = emptyList()): JsonElement =
        send(path, HttpMethod.GET, query = query)
    suspend fun post(path: String, body: JsonObject = JsonObject(emptyMap())) = send(path, HttpMethod.POST, body)
    suspend fun patch(path: String, body: JsonObject) = send(path, HttpMethod.PATCH, body)
    suspend fun put(path: String, body: JsonObject) = send(path, HttpMethod.PUT, body)
    suspend fun delete(path: String, query: List<Pair<String, String>> = emptyList()) = send(path, HttpMethod.DELETE, query = query)

    private suspend fun send(path: String, method: HttpMethod, body: JsonObject? = null,
        query: List<Pair<String, String>> = emptyList()): JsonElement {
        require(!path.startsWith('/') && !path.contains("://") && !path.contains("?") && !path.contains("#"))
        val response = session.request(handle, ApiRequest(path.trim('/').split('/'), method,
            query = query, body = body?.toString()?.encodeToByteArray()))
        return if (response.body.isEmpty()) JsonNull else Wire.json.parseToJsonElement(response.body.decodeToString())
    }
}

fun JsonObject.text(name: String): String = (this[name] as? JsonPrimitive)?.contentOrNull.orEmpty()
fun JsonObject.flag(name: String): Boolean = (this[name] as? JsonPrimitive)?.booleanOrNull == true
fun JsonObject.list(name: String): List<JsonObject> = (this[name] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
