package io.orbitd.android.composer

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer

class ComposerApi(private val auth: OrbitApi, private val handle: SessionHandle, val sessionId: String, private val target: DraftTarget? = null) {
    suspend fun read(path: List<String>): JsonElement = Wire.json.parseToJsonElement(auth.request(handle, ApiRequest(path)).body.decodeToString())
    suspend fun detail() = read(if (target == null) listOf("sessions", sessionId) else listOf("workspaces", target.workspaceId)).jsonObject
    suspend fun mutation(endpoint: String, body: JsonObject? = null, method: HttpMethod = HttpMethod.POST): JsonObject {
        val response = auth.request(handle, ApiRequest(if (endpoint == "create") listOf("sessions") else listOf("sessions", sessionId) + endpoint.split('/'), method,
            body = body?.toString()?.encodeToByteArray()))
        return if (response.body.isEmpty()) JsonObject(emptyMap()) else Wire.json.parseToJsonElement(response.body.decodeToString()).jsonObject
    }
    suspend fun catalog(detail: JsonObject): ComposerCatalog {
        val runnerId = detail.text("assignedRunnerId") ?: detail.text("runnerId")
            ?: (detail["agent"] as? JsonObject)?.text("runnerId") ?: error("Runner is not assigned.")
        val runner = read(listOf("runners")).jsonArray.filterIsInstance<JsonObject>()
            .firstOrNull { ObjectId.same(it.text("id"), runnerId) } ?: error("Runner is unavailable.")
        val providers = read(listOf("providers")).jsonArray.filterIsInstance<JsonObject>()
        val pools = read(listOf("providers", "pools")).jsonArray.filterIsInstance<JsonObject>()
        val shared = read(listOf("providers", "shared-pools")).jsonArray.filterIsInstance<JsonObject>()
        fun pool(row: JsonObject, fallback: String) = JsonObject(row + mapOf("runtime" to JsonPrimitive(row.text("engine") ?: fallback), "modelsFromRuntime" to JsonPrimitive(true)))
        return ComposerCatalog(runner, (providers + pools.map { pool(it, "claude") } + shared.map { pool(it, "codex") }).distinctBy { it.text("slug") })
    }
    suspend fun upload(attachment: StagedAttachment, bytes: ByteArray, progress: (Float) -> Unit): String = withContext(Dispatchers.IO) {
        val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", attachment.name, bytes.toRequestBody(attachment.mime.toMediaType())).build()
        val encoded = Buffer().apply { multipart.writeTo(this) }.readByteArray()
        val response = auth.request(handle, ApiRequest(listOf("attachments"), HttpMethod.POST,
            query = if (target == null) listOf("sessionId" to sessionId) else emptyList(), body = encoded, contentType = multipart.contentType().toString(),
            onUploadProgress = { sent, total -> progress(if (total == 0L) 0f else sent.toFloat() / total) }))
        Wire.json.parseToJsonElement(response.body.decodeToString()).jsonObject.text("id") ?: error("Upload response has no attachment id.")
    }
}
