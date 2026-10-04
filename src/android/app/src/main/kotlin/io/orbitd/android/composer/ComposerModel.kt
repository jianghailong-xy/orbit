package io.orbitd.android.composer

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.util.UUID

/** Lives with the login epoch, not an Activity. AuthSession owns all durable bytes and requests. */
class ComposerModel(val auth: AuthSession, val handle: SessionHandle, val sessionId: String,
    parent: CoroutineScope, val target: DraftTarget? = null, private val refresh: () -> Unit = {}) {
    private val job = SupervisorJob(parent.coroutineContext[Job])
    private val scope = CoroutineScope(parent.coroutineContext + job)
    private val api = ComposerApi(auth, handle, sessionId, target)
    private val key = "composer-v1:${ObjectId.canonical(sessionId) ?: sessionId}"
    private val disk = Mutex()
    private val uploadSlots = Semaphore(2)
    private val uploads = mutableMapOf<String, Job>()
    private val mutable = MutableStateFlow(ComposerState())
    val state: StateFlow<ComposerState> = mutable.asStateFlow()

    init { restore() }
    fun restore() {
      if (state.value.loaded || state.value.busy) return
      mutable.update { it.copy(busy = true, error = null) }
      scope.launch {
        try {
            val bytes = auth.readData(handle, DataKind.DRAFT, key)
            val draft = bytes?.let { Wire.decode(it, ComposerDraft.serializer()) } ?: ComposerDraft()
            mutable.value = ComposerState(draft = draft, loaded = true,
                notice = if (draft.pending != null) "Delivery is unconfirmed. Retry the saved message." else null,
                failures = draft.attachments.filter { it.remoteId == null }.associate { it.id to "Upload interrupted · Retry" })
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { mutable.value = ComposerState(error = "Couldn't restore the draft. Retry to read the saved copy.") }
      }
    }

    fun close() { job.cancel() }
    private suspend fun persist() = disk.withLock {
        auth.writeData(handle, DataKind.DRAFT, key, Wire.json.encodeToString(mutable.value.draft).encodeToByteArray())
    }
    private fun error(e: Exception) {
        mutable.update { it.copy(error = if (e is ApiError) e.messages.firstOrNull() ?: directoryError(e)
            else if (e is IllegalStateException || e is IllegalArgumentException) e.message else directoryError(e)) }
        refresh()
    }
    private fun launch(block: suspend () -> Unit) = scope.launch {
        try { block() } catch (cancel: CancellationException) { throw cancel } catch (e: Exception) { error(e) }
    }
    fun edit(text: String, start: Int, end: Int) {
        if (!state.value.loaded) return
        mutable.update { it.copy(draft = it.draft.copy(text = text, selectionStart = start, selectionEnd = end)) }
        launch { persist() }
    }
    fun clearError() { mutable.update { it.copy(error = null) } }
    suspend fun attachmentBytes(id: String): ByteArray = auth.readData(handle, DataKind.DRAFT, "$key:attachment:$id")
        ?.takeIf { it.isNotEmpty() } ?: error("Select the file again; its saved copy is unavailable.")

    /** The importer holds the URI grant until this durable copy succeeds. */
    fun importAttachment(attachment: StagedAttachment, read: suspend () -> Pair<StagedAttachment, ByteArray>, release: () -> Unit) {
        if (!state.value.loaded) { release(); return }
        mutable.update { it.copy(draft = it.draft.copy(attachments = it.draft.attachments + attachment),
            uploads = it.uploads + (attachment.id to 0f)) }
        val task = scope.launch(start = CoroutineStart.LAZY) {
            try {
                persist()
                uploadSlots.withPermit {
                    val (metadata, bytes) = read()
                    auth.writeData(handle, DataKind.DRAFT, "$key:attachment:${attachment.id}", bytes)
                    if (state.value.draft.attachments.none { it.id == attachment.id }) return@withPermit
                    mutable.update { it.copy(draft = it.draft.copy(attachments = it.draft.attachments.map { a ->
                        if (a.id == attachment.id) metadata.copy(uri = null) else a })) }
                    persist()
                    uploadBytes(metadata, bytes)
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { mutable.update { it.copy(failures = it.failures + (attachment.id to (e.message ?: "Upload failed"))) } }
            finally { release(); uploads.remove(attachment.id); mutable.update { it.copy(uploads = it.uploads - attachment.id) } }
        }
        uploads[attachment.id] = task; task.start()
    }
    private suspend fun uploadBytes(attachment: StagedAttachment, bytes: ByteArray) {
        val remote = api.upload(attachment, bytes) { percent ->
            mutable.update { if (it.draft.attachments.any { a -> a.id == attachment.id }) it.copy(uploads = it.uploads + (attachment.id to percent)) else it }
        }
        // A removed chip must never be brought back by a delayed successful upload.
        mutable.update { it.copy(draft = it.draft.copy(attachments = it.draft.attachments.map { a ->
            if (a.id == attachment.id) a.copy(remoteId = remote) else a }), failures = it.failures - attachment.id) }
        persist()
    }
    fun retryUpload(id: String) {
        if (id in uploads) return
        val attachment = state.value.draft.attachments.firstOrNull { it.id == id && it.remoteId == null } ?: return
        mutable.update { it.copy(uploads = it.uploads + (id to 0f), failures = it.failures - id) }
        val task = scope.launch(start = CoroutineStart.LAZY) {
            try { uploadSlots.withPermit { uploadBytes(attachment, attachmentBytes(id)) } }
            catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { mutable.update { it.copy(failures = it.failures + (id to (e.message ?: "Upload failed"))) } }
            finally { uploads.remove(id); mutable.update { it.copy(uploads = it.uploads - id) } }
        }
        uploads[id] = task; task.start()
    }
    fun removeAttachment(id: String) {
        uploads.remove(id)?.cancel()
        mutable.update { it.copy(draft = it.draft.copy(attachments = it.draft.attachments.filterNot { a -> a.id == id }),
            uploads = it.uploads - id, failures = it.failures - id) }
        launch { persist(); auth.writeData(handle, DataKind.DRAFT, "$key:attachment:$id", ByteArray(0)) }
    }

    fun send() {
        if (!state.value.loaded || state.value.busy || state.value.waiting || state.value.draft.pending != null) return
        mutable.update { it.copy(waiting = true, error = null, notice = null) }
        launch {
            try {
                // Keep text editable while uploads finish. Failed or removed uploads cannot be silently sent.
                while (uploads.isNotEmpty()) uploads.values.toList().joinAll()
                mutable.update { it.copy(busy = true, waiting = false) }
                val detail = api.detail() // Revalidate resume/capabilities at the actual send, not from cache.
                if (state.value.draft.text.trim().takeWhile { !it.isWhitespace() } == "/status") {
                    mutable.update { it.copy(draft = it.draft.copy(text = "", selectionStart = 0, selectionEnd = 0),
                        notice = "${detail.text("provider").orEmpty()} · ${detail.text("model").orEmpty()} · ${detail.text("status") ?: "New session"} · ${detail.text("permissionMode") ?: "default"}") }
                    persist(); return@launch
                }
                val endpoint = if (target != null) {
                    check(detail.flag("enabled") != false) { "Workspace is disabled." }; "create"
                } else sendEndpoint(detail)
                val draft = state.value.draft
                check(draft.attachments.all { it.remoteId != null }) { "Retry or remove failed uploads before sending." }
                val raw = draft.text.trim()
                val shell = raw.startsWith("!")
                val content = if (shell) raw.drop(1).trim() else raw
                if (content.isEmpty() && (shell || draft.attachments.isEmpty())) return@launch
                check(!shell || draft.attachments.isEmpty()) { "Remove attachments before running a shell command." }
                val id = UUID.randomUUID().toString()
                val body = buildJsonObject {
                    if (endpoint in setOf("resume", "create")) draft.resumeConfig.filterKeys { it != "account" }.forEach { (k, v) -> put(k, v) }
                    if (target != null) {
                        put("workspaceId", target.workspaceId); target.folderId?.let { put("folderId", it) }
                        put("prompt", content); put("shell", shell)
                        draft.resumeConfig.text("account")?.let { account ->
                            val provider = draft.resumeConfig.text("provider") ?: detail.text("provider")
                            if (provider in setOf("codex", "claude")) put("${provider}Account", account)
                        }
                    } else {
                        if (endpoint == "resume") draft.resumeConfig["account"]?.let { put("account", it) }
                        put("clientTurnId", id); put("content", content); put("kind", if (shell) "shell" else "message")
                    }
                    putJsonArray("attachmentIds") { draft.attachments.forEach { add(it.remoteId!!) } }
                }
                val pending = PendingSend(id, endpoint, body, draft.text, draft.attachments)
                mutable.update { it.copy(draft = it.draft.copy(text = "", selectionStart = 0, selectionEnd = 0, attachments = emptyList(), pending = pending)) }
                persist() // A write failure prevents POST; the in-memory pending remains retryable.
                transmit(pending)
            } finally { mutable.update { it.copy(busy = false, waiting = false) } }
        }
    }
    fun retrySend() {
        if (state.value.busy || state.value.waiting) return
        val pending = state.value.draft.pending ?: return
        // The existing create-session door has no public idempotency contract. Never replay an
        // ambiguous create and accidentally start a second agent. Existing turns remain replayable.
        if (pending.endpoint == "create") return
        mutable.update { it.copy(busy = true, error = null) }
        launch { try { persist(); transmit(pending) } finally { mutable.update { it.copy(busy = false) } } }
    }
    private suspend fun transmit(pending: PendingSend) {
        val accepted = try { api.mutation(pending.endpoint, pending.body) } catch (e: ApiError) {
            if (pending.endpoint == "create" && e.status in setOf(400, 403, 404, 409, 422)) {
                mutable.update { it.copy(draft = it.draft.copy(pending = null, text = pending.text + it.draft.text, attachments = pending.attachments + it.draft.attachments)) }
                persist()
            }
            throw e
        }
        val note = when {
            accepted.text("routedToSessionId") != null -> "Sent to session ${accepted.text("routedToSessionId")}."
            accepted.text("kind") == "steer" -> "Sent to the current turn."
            accepted.text("status") == "PENDING" || accepted.text("placement") == "queued" -> "Message queued."
            else -> "Message accepted."
        }
        // Persist acknowledgement before removing the retry. If disk fails, replay is still safe.
        val previous = state.value.draft
        val created = if (pending.endpoint == "create") accepted.text("id") ?: error("Creation response has no session id.") else null
        mutable.update { it.copy(draft = it.draft.copy(pending = null, resumeConfig = JsonObject(emptyMap()), createdSessionId = created)) }
        try { persist() } catch (e: Exception) {
            mutable.update { it.copy(draft = it.draft.copy(pending = pending, resumeConfig = previous.resumeConfig, createdSessionId = previous.createdSessionId)) }; throw e
        }
        mutable.update { it.copy(notice = note, error = null) }
        pending.attachments.forEach { auth.writeData(handle, DataKind.DRAFT, "$key:attachment:${it.id}", ByteArray(0)) }
        refresh()
    }
    fun control(endpoint: String, method: HttpMethod = HttpMethod.POST, body: JsonObject? = null) {
        if (state.value.busy || state.value.waiting) return
        mutable.update { it.copy(busy = true, error = null) }
        launch {
            try {
                api.detail() // Auth and permission preflight; the mutation remains authoritative.
                api.mutation(endpoint, body, method)
                mutable.update { it.copy(notice = if (endpoint == "interrupt") "Stop requested." else "Request accepted.") }
                refresh()
            } finally { mutable.update { it.copy(busy = false) } }
        }
    }
    fun loadCatalog() {
        if (state.value.catalogLoading) return
        mutable.update { it.copy(catalogLoading = true, catalogError = null, catalog = null) }
        launch {
            try { val catalog = api.catalog(api.detail()); mutable.update { it.copy(catalog = catalog) } }
            catch (e: Exception) { if (e is CancellationException) throw e; mutable.update { it.copy(catalogError = directoryError(e)) } }
            finally { mutable.update { it.copy(catalogLoading = false) } }
        }
    }
    fun config(values: JsonObject, accountOnly: Boolean = false) {
        if (state.value.busy || state.value.waiting || state.value.draft.pending != null) return
        mutable.update { it.copy(busy = true, error = null) }
        launch {
            try {
                val detail = api.detail()
                if (target != null || terminal(detail) && !accountOnly) {
                    mutable.update { it.copy(draft = it.draft.copy(resumeConfig = JsonObject(it.draft.resumeConfig + values)), notice = if (target == null) "Applies when this session resumes." else "Applies when this session starts.") }
                    persist()
                } else {
                    api.mutation(if (accountOnly) "account" else "config", values, HttpMethod.PATCH)
                    mutable.update { it.copy(notice = "Selection saved.") }; refresh()
                }
            } finally { mutable.update { it.copy(busy = false) } }
        }
    }
    fun consumeCreated() { mutable.update { it.copy(draft = it.draft.copy(createdSessionId = null)) }; launch { persist() } }
}
