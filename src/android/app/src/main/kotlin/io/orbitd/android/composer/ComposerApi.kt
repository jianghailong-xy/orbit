package io.orbitd.android.composer

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer

/** A read a page makes as it opens, tried three times — 300 ms, then 600 ms apart — before it fails (A07-18, iOS bc790273c
 * `fetchRunners`): one transient failure, common on a phone, would otherwise leave what it reads missing until the page opens again. */
/** A send's endpoint that is a page chat's own create door ([ChatDoor]): the prefix, then the path. */
internal const val CHAT_CREATE = "chat-create:"

/** A send that makes a session — the draft's `POST /sessions` or a page chat's door: never replayed when its answer is lost. */
internal fun isCreate(endpoint: String): Boolean = endpoint == "create" || endpoint.startsWith(CHAT_CREATE)

internal suspend fun <T> threeTries(read: suspend () -> T): T {
    repeat(2) { attempt ->
        try { return read() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { delay(300L * (attempt + 1)) }
    }
    return read()
}

class ComposerApi(private val auth: OrbitApi, private val handle: SessionHandle, val sessionId: String, private val target: DraftTarget? = null) {
    suspend fun read(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement =
        Wire.json.parseToJsonElement(auth.request(handle, ApiRequest(path, query = query)).body.decodeToString())
    suspend fun detail(): JsonObject = when {
        target == null -> read(listOf("sessions", sessionId)).jsonObject
        target.isMachineDraft -> {
            val runner = runner(target.runnerId) ?: error("Runner is unavailable.")
            MachineSetup.machineDraft(runner.text("id") ?: target.runnerId!!, RunnerPage.displayName(runner), MachineSetup.firstEngineOn(runner))
        }
        else -> read(listOf("workspaces", target.workspaceId)).jsonObject
    }
    suspend fun workspaces(): List<JsonObject> = read(listOf("workspaces")).jsonArray.filterIsInstance<JsonObject>()
    /** `POST /workspaces` (a machine's setup card): the workspace made, which answers its `id`. */
    suspend fun createWorkspace(body: JsonObject): JsonObject {
        val response = auth.request(handle, ApiRequest(listOf("workspaces"), HttpMethod.POST, body = body.toString().encodeToByteArray()))
        return Wire.json.parseToJsonElement(response.body.decodeToString()).jsonObject
    }
    suspend fun askDirProbe(runnerId: String, path: String) {
        auth.request(handle, ApiRequest(listOf("runners", runnerId, "dir-probe"), HttpMethod.POST,
            body = buildJsonObject { put("path", path) }.toString().encodeToByteArray()))
    }
    suspend fun readDirProbe(runnerId: String, path: String): DirProbeAnswer =
        DirProbeAnswer.fromJson(read(listOf("runners", runnerId, "dir-probe"), query = listOf("path" to path)).jsonObject)
    suspend fun probeDir(runnerId: String, path: String, ask: Boolean): DirProbeRelay.Outcome =
        DirProbeRelay.probe(
            ask = if (ask) ({ askDirProbe(runnerId, path) }) else null,
            read = { readDirProbe(runnerId, path) },
            sleep = { ms -> delay(ms) },
        )
    /** [answerSeconds]: how long the transport itself may wait for the answer, where its own 10 s read timeout is too short — a
     * message's send, which its 20 s deadline ends instead ([PendingSendCopy.ANSWER_TIMEOUT_MS]). */
    suspend fun mutation(endpoint: String, body: JsonObject? = null, method: HttpMethod = HttpMethod.POST, answerSeconds: Long? = null): JsonObject {
        val path = when {
            endpoint == "create" -> listOf("sessions")
            endpoint.startsWith(CHAT_CREATE) -> endpoint.removePrefix(CHAT_CREATE).split('/')
            else -> listOf("sessions", sessionId) + endpoint.split('/')
        }
        val response = auth.request(handle, ApiRequest(path, method,
            body = body?.toString()?.encodeToByteArray(), readTimeoutSeconds = answerSeconds, callTimeoutSeconds = answerSeconds))
        return if (response.body.isEmpty()) JsonObject(emptyMap()) else Wire.json.parseToJsonElement(response.body.decodeToString()).jsonObject
    }
    /** The runner [id] as GET /runners lists it, or null where the list no longer holds it. */
    suspend fun runner(id: String?): JsonObject? =
        read(listOf("runners")).jsonArray.filterIsInstance<JsonObject>().firstOrNull { ObjectId.same(it.text("id"), id) }
    suspend fun catalog(detail: JsonObject): ComposerCatalog {
        val runnerId = detail.text("assignedRunnerId") ?: detail.text("runnerId")
            ?: (detail["agent"] as? JsonObject)?.text("runnerId") ?: error("Runner is not assigned.")
        // Every runner of the account, which says whether Cursor CLI is drawn at all (ComposerCatalog.fleet).
        val runners = read(listOf("runners")).jsonArray.filterIsInstance<JsonObject>()
        val runner = runners.firstOrNull { ObjectId.same(it.text("id"), runnerId) } ?: error("Runner is unavailable.")
        // Each key with the engines it runs on (`engines`, the server's answer: only it can tell a Claude subscription token).
        val providers = read(listOf("providers")).jsonArray.filterIsInstance<JsonObject>()
        val pools = read(listOf("providers", "pools")).jsonArray.filterIsInstance<JsonObject>()
        val shared = read(listOf("providers", "shared-pools")).jsonArray.filterIsInstance<JsonObject>()
        val rows = (providers + pools.map { ProviderEngines.poolRow(it, ProviderEngines.CLAUDE) } +
            shared.map { ProviderEngines.poolRow(it, ProviderEngines.CODEX, shared = true) }).distinctBy { it.text("slug") }
        // A session whose key the list no longer has: the account's own keys, turned-off ones included, say whether it was turned
        // off or deleted.
        val provider = detail.text("provider")
        val own = if (provider == null || provider in ProviderEngines.LOGIN_ENGINES || provider == ProviderEngines.OPENCODE ||
            rows.any { it.text("slug") == provider }) null
            else try { read(listOf("providers", "mine")).jsonArray.filterIsInstance<JsonObject>() }
                catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        return ComposerCatalog(runner, rows, own, runners)
    }
    /** A sent file's bytes, to stage it again. */
    suspend fun attachment(id: String): ByteArray = auth.request(handle, ApiRequest(listOf("attachments", id), maxResponseBytes = 25L * 1024 * 1024)).body
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
