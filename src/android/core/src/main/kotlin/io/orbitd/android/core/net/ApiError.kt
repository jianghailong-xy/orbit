package io.orbitd.android.core.net

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Callers can inspect code/body; logging the exception never prints server prose or credentials. */
class ApiError private constructor(
    val status: Int,
    val code: String?,
    val messages: List<String>,
    val body: JsonElement?,
) : Exception("Request failed (HTTP $status)") {
    companion object {
        fun parse(status: Int, bytes: ByteArray): ApiError {
            val body = try {
                Wire.json.parseToJsonElement(bytes.decodeToString()).takeIf { it is JsonObject || it is JsonArray }
            } catch (_: Exception) { null }
            val obj = body as? JsonObject
            fun JsonElement?.text() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
            val message = obj?.get("message")
            val messages = when (message) {
                is JsonArray -> message.mapNotNull { it.text() }
                else -> listOfNotNull(message.text())
            }
            return ApiError(status, obj?.get("code").text(), messages, body)
        }
    }
}

class NetworkException : Exception("Could not reach the server")
