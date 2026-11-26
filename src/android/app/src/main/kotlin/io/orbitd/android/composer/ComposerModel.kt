package io.orbitd.android.composer

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.ClaudeRegion
import io.orbitd.android.core.net.*
import io.orbitd.android.core.promptoptimizer.PromptOptimizationRequest
import io.orbitd.android.core.promptoptimizer.PromptOptimizer
import io.orbitd.android.core.promptoptimizer.PromptOptimizerState
import io.orbitd.android.core.promptoptimizer.optimizePrompt
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.directoryError
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.reader.COULDNT_CANCEL_MESSAGE
import io.orbitd.android.reader.SteerDelivery
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastTone
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
    internal val api = ComposerApi(auth, handle, sessionId, target)
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
                notice = if (draft.pending != null) "Delivery is unconfirmed. Retry the saved message." else null)
            // An upload the last run left unfinished goes again from its saved copy: the chip spins, then lands or goes with why.
            draft.attachments.filter { it.remoteId == null }.forEach { retryUpload(it.id) }
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

    // Prompt optimizer (docs/prompt-optimizer-design.md, board docs/mocks/prompt-optimizer), iOS ConsoleModel's. Every rule is
    // PromptOptimizerState's; this runs the request and puts text in the box.
    private var optimizeJob: Job? = null
    private fun optimizer(change: (PromptOptimizerState) -> PromptOptimizerState) = mutable.update { it.copy(optimizer = change(it.optimizer)) }

    /** ✦ Optimize pressed (frame 2): the draft goes to the server with this session — or, for a new session, the workspace picked (a
     * bare machine's has none yet). Pressed while busy (frame 3), it cancels. Nothing in the box changes until Use. */
    fun optimize() {
        if (state.value.optimizer.isOptimizing) { cancelOptimize(); return }
        val draft = state.value.draft.text
        val trimmed = draft.trim()
        if (trimmed.isEmpty()) return
        optimizer { it.start(draft) }
        val request = PromptOptimizationRequest(trimmed.take(PromptOptimizer.MAX_DRAFT_CHARS),
            sessionId = if (target == null) sessionId else null, workspaceId = target?.workspaceId?.takeIf { it.isNotEmpty() })
        optimizeJob?.cancel()
        optimizeJob = scope.launch {
            try {
                val result = auth.optimizePrompt(handle, request)
                optimizer { it.succeeded(result) }
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { optimizer { it.failedNow() } }
        }
    }

    /** The busy button pressed again: the press is dropped, the draft is as it was. */
    fun cancelOptimize() {
        optimizeJob?.cancel(); optimizeJob = null
        optimizer { it.cancel() }
    }

    /** Try again (frame 4's, or frame 6's failure line): the box's draft as it is now goes out again. */
    fun retryOptimize() { optimizer { it.dismiss() }; optimize() }

    /** × / back / swipe down: the sheet (or the failure line) goes; the draft is kept. */
    fun dismissOptimization() = optimizer { it.dismiss() }

    fun toggleOptimizationGloss() = optimizer { it.toggleGloss() }

    /** Use, or Edit, then use: the suggestion replaces the draft's words (attachments stay), the caret at its end. */
    fun useOptimization() {
        val text = state.value.optimizer.suggestion?.insertText ?: return
        val current = state.value.draft.text
        optimizer { it.use(current) }
        edit(text, text.length, text.length)
    }

    /** Frame 5's Undo: the owner's own draft comes back. */
    fun undoOptimization() {
        val o = state.value.optimizer
        val current = state.value.draft.text
        val draft = o.undoDraft?.takeIf { o.offersUndo(current) } ?: return
        optimizer { it.undo(current) }
        edit(draft, draft.length, draft.length)
    }

    /** The Undo toast went: Undo is no longer offered; a send of the unedited text still skips translation. */
    fun forgetOptimizationUndo() = optimizer { it.forgetUndo() }
    /** Why the box won't do what was asked of it, said as an error: there until dismissed. */
    fun refuse(message: String) { mutable.update { it.copy(error = message) } }
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
                    // A file that can't be read or isn't allowed (over the size limit) is refused with its reason alone, as iOS refuses one
                    // before staging it (`Attachments.rejectReason`): there was no upload to fail.
                    val (metadata, bytes) = try { read() } catch (cancel: CancellationException) { throw cancel }
                        catch (e: Exception) { uploadFailed(attachment, e, upload = false); return@withPermit }
                    auth.writeData(handle, DataKind.DRAFT, "$key:attachment:${attachment.id}", bytes)
                    if (state.value.draft.attachments.none { it.id == attachment.id }) return@withPermit
                    mutable.update { it.copy(draft = it.draft.copy(attachments = it.draft.attachments.map { a ->
                        if (a.id == attachment.id) metadata.copy(uri = null) else a })) }
                    persist()
                    uploadBytes(metadata, bytes)
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { uploadFailed(attachment, e) }
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
            if (a.id == attachment.id) a.copy(remoteId = remote) else a })) }
        persist()
    }
    private fun retryUpload(id: String) {
        if (id in uploads) return
        val attachment = state.value.draft.attachments.firstOrNull { it.id == id && it.remoteId == null } ?: return
        mutable.update { it.copy(uploads = it.uploads + (id to 0f)) }
        val task = scope.launch(start = CoroutineStart.LAZY) {
            try { uploadSlots.withPermit { uploadBytes(attachment, attachmentBytes(id)) } }
            catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { uploadFailed(attachment, e) }
            finally { uploads.remove(id); mutable.update { it.copy(uploads = it.uploads - id) } }
        }
        uploads[id] = task; task.start()
    }
    /** Uploads that failed since the composer opened: a send waiting on its uploads stops when one fails while it waits. */
    private var uploadFailures = 0
    /** A failed upload drops its chip and says so in the error line above the box, as iOS does (ConsoleModel.attach): "Upload failed —
     * notes.pdf: the connection dropped". Picking the file again is the retry. */
    private fun uploadFailed(attachment: StagedAttachment, e: Exception, upload: Boolean = true) {
        val name = state.value.draft.attachments.firstOrNull { it.id == attachment.id }?.name ?: return
        uploadFailures++
        uploads.remove(attachment.id) // this upload's own job: removing the chip must not cancel the job reporting it
        removeAttachment(attachment.id)
        mutable.update { it.copy(error = if (upload) "Upload failed — $name: ${uploadFailure(e)}" else uploadFailure(e)) }
    }
    /** Why, in APIClient.failureReason's words: the server's own, a dropped connection, or what the device said (a file it can't read). */
    private fun uploadFailure(e: Exception): String = when (e) {
        is ApiError, is NetworkException -> io.orbitd.android.management.personalFailure(e)
        is IllegalStateException, is IllegalArgumentException -> e.message?.trimEnd('.') ?: io.orbitd.android.management.personalFailure(e)
        else -> io.orbitd.android.management.personalFailure(e)
    }
    fun removeAttachment(id: String) {
        uploads.remove(id)?.cancel()
        mutable.update { it.copy(draft = it.draft.copy(attachments = it.draft.attachments.filterNot { a -> a.id == id }),
            uploads = it.uploads - id) }
        launch { persist(); auth.writeData(handle, DataKind.DRAFT, "$key:attachment:$id", ByteArray(0)) }
    }

    /** [seedModel]: for a new session that names no model, the one it starts on — the last picked for its engine and credential.
     * [queueForNextTurn]: Send's other way while a turn runs (decided 2026-10-16, docs/mocks/steer-tray) — queued for the next turn
     * (`intent: NEXT_TURN`) instead of into this one. Otherwise no intent goes out and the server places the message as it always has. */
    fun send(seedModel: String? = null, queueForNextTurn: Boolean = false) {
        // A machine with no workspace sends nothing: its page is the setup card, which makes the workspace.
        if (target?.isMachineDraft == true) return
        if (!state.value.loaded || state.value.busy || state.value.waiting || state.value.draft.pending != null || state.value.draft.createdSessionId != null) return
        mutable.update { it.copy(waiting = true, error = null, notice = null) }
        launch {
            try {
                // Keep text editable while uploads finish. Failed or removed uploads cannot be silently sent: an upload that fails while
                // this waits stops the send, its chip gone and the error line saying why, and the words stay in the box.
                val failedBefore = uploadFailures
                while (uploads.isNotEmpty()) uploads.values.toList().joinAll()
                if (uploadFailures != failedBefore) { mutable.update { it.copy(waiting = false) }; return@launch }
                mutable.update { it.copy(busy = true, waiting = false) }
                val draft = state.value.draft
                check(draft.attachments.all { it.remoteId != null }) { "Retry or remove failed uploads before sending." }
                val detail = api.detail() // Revalidate resume/capabilities at the actual send, not from cache.
                if (draft.text.trim().takeWhile { !it.isWhitespace() } == "/status") {
                    // The engine first, as the rows of iOS's status card name it (A07-19 (c), iOS cef3c3f83 `statusRows`).
                    val engineId = ProviderChoices.engine(JsonObject(detail + draft.resumeConfig), state.value.catalog?.providers.orEmpty())
                    val engine = ProviderEngines.cliName(engineId)
                    mutable.update { it.copy(draft = it.draft.copy(text = "", selectionStart = 0, selectionEnd = 0),
                        notice = "Engine: $engine · Provider: ${detail.text("provider").orEmpty()} · Model: ${detail.text("model").orEmpty()} · " +
                            "Session: ${detail.text("status") ?: "New session"} · Permission: ${detail.text("permissionMode") ?: CursorRuntime.unsetMode(engineId)}") }
                    persist(); return@launch
                }
                val endpoint = if (target != null) {
                    check(detail.flag("enabled") != false) { "Workspace is disabled." }; "create"
                } else sendEndpoint(detail)
                val raw = draft.text.trim()
                val shell = raw.startsWith("!")
                val content = if (shell) raw.drop(1).trim() else raw
                if (content.isEmpty() && (shell || draft.attachments.isEmpty())) return@launch
                val id = UUID.randomUUID().toString()
                // D2: the unedited gloss goes with the optimizer's agent-language prompt as its translation — on a turn, a revive and
                // a new session's opening message alike. Send never waits for the optimizer: a press still out, or a sheet still open, goes.
                val optimizedTranslation = state.value.optimizer.optimizedTranslation(draft.text)
                cancelOptimize(); dismissOptimization()
                val body = PromptOptimizer.withOptimizedTranslation(if (target != null) {
                    buildCreateBody(detail, content, shell, draft.attachments, seedModel)
                } else buildJsonObject {
                    if (endpoint == "resume") {
                        draft.resumeConfig.filterKeys { it != "account" }.forEach { (k, v) -> put(k, v) }
                        draft.resumeConfig["account"]?.let { put("account", it) }
                    }
                    put("clientTurnId", id); put("content", content); put("kind", if (shell) "shell" else "message")
                    if (queueForNextTurn && endpoint == "turns") put("intent", "NEXT_TURN")
                    putJsonArray("attachmentIds") { draft.attachments.forEach { add(it.remoteId!!) } }
                }, optimizedTranslation)
                val pending = PendingSend(id, endpoint, body, draft.text, draft.attachments)
                mutable.update { it.copy(draft = it.draft.copy(text = "", selectionStart = 0, selectionEnd = 0, attachments = emptyList(), pending = pending)) }
                try { persist() } catch (e: Exception) {
                    // Nothing has left the device. In particular, create has no replay contract.
                    restoreUnsent(pending)
                    throw e
                }
                transmit(pending, firstAttempt = true)
                // The optimized text is spent.
                optimizer { it.sent() }
            } finally { mutable.update { it.copy(busy = false, waiting = false) } }
        }
    }
    /** A message the box never held — the auto-retry card's Continue (A07-12) — sent as anything typed is: written to the outbox
     * before the POST, replayed under the same clientTurnId, and handed back to the box only if the server refuses it. */
    suspend fun sendMessage(text: String) {
        if (!state.value.loaded || state.value.busy || state.value.waiting || state.value.draft.pending != null || target != null) return
        mutable.update { it.copy(busy = true, error = null, notice = null) }
        try {
            val endpoint = sendEndpoint(api.detail())
            val config = state.value.draft.resumeConfig
            val id = UUID.randomUUID().toString()
            val body = buildJsonObject {
                if (endpoint == "resume") { config.filterKeys { it != "account" }.forEach { (k, v) -> put(k, v) }; config["account"]?.let { put("account", it) } }
                put("clientTurnId", id); put("content", text); put("kind", "message"); putJsonArray("attachmentIds") {}
            }
            val pending = PendingSend(id, endpoint, body, text)
            mutable.update { it.copy(draft = it.draft.copy(pending = pending)) }
            try { persist() } catch (e: Exception) { mutable.update { it.copy(draft = it.draft.copy(pending = null)) }; throw e }
            transmit(pending, firstAttempt = true)
        } finally { mutable.update { it.copy(busy = false) } }
    }
    /** The context dialog's Compact (board 03): the engine's `/compact`, sent as [sendMessage] sends, a refusal shown as the box's. */
    fun compact() { launch { sendMessage(CoordinatorHandoffCopy.COMPACT_COMMAND) } }
    fun retrySend() {
        if (state.value.busy || state.value.waiting) return
        if (state.value.acknowledgementPending) {
            mutable.update { it.copy(busy = true, error = null) }
            launch {
                try { persist(); mutable.update { it.copy(acknowledgementPending = false) } }
                finally { mutable.update { it.copy(busy = false) } }
            }
            return
        }
        val pending = state.value.draft.pending ?: return
        // The existing create-session door has no public idempotency contract. Never replay an
        // ambiguous create and accidentally start a second agent. Existing turns remain replayable.
        if (pending.endpoint == "create") return
        mutable.update { it.copy(busy = true, error = null) }
        launch { try { persist(); transmit(pending) } finally { mutable.update { it.copy(busy = false) } } }
    }
    private fun restoreUnsent(pending: PendingSend) {
        mutable.update { it.copy(draft = it.draft.copy(pending = null, text = pending.text + it.draft.text,
            selectionStart = pending.text.length, selectionEnd = pending.text.length,
            attachments = pending.attachments + it.draft.attachments)) }
    }
    private suspend fun transmit(pending: PendingSend, firstAttempt: Boolean = false) {
        val accepted = try { api.mutation(pending.endpoint, pending.body) } catch (e: ApiError) {
            // A refusal of the first POST proves this operation was not accepted. A later refusal
            // (e.g. access revoked after a lost ACK) cannot disprove an earlier accepted request.
            if (firstAttempt && e.status in setOf(400, 403, 404, 409, 413, 422)) {
                restoreUnsent(pending)
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
        mutable.update { it.copy(draft = it.draft.copy(pending = null, resumeConfig = JsonObject(emptyMap()), createdSessionId = created),
            acknowledgementPending = created != null) }
        try { persist() } catch (e: Exception) {
            // Once create returned an id, retry only its local ACK. Never turn known success back
            // into an ambiguous create or POST it again. Navigation waits for the durable ACK.
            if (created == null) mutable.update { it.copy(draft = it.draft.copy(pending = pending, resumeConfig = previous.resumeConfig)) }
            throw e
        }
        // The provider pick has done what its line said it would.
        mutable.update { it.copy(notice = note, error = null, acknowledgementPending = false, switchNote = null) }
        pending.attachments.forEach { auth.writeData(handle, DataKind.DRAFT, "$key:attachment:${it.id}", ByteArray(0)) }
        refresh()
    }
    /** What a Retry re-sends with (RetryIdentityDto, iOS 163e67872): the provider picked here for the next turn, with its engine and
     * its account — so the re-send runs there, as a send would. Nothing picked, the body is empty and the re-send goes where the
     * session is. */
    fun retryIdentity(): JsonObject = retryIdentityOf(state.value.draft.resumeConfig)
    /** The failed message again, through the retry door: the server re-sends it under a key of its own, so a second press is the
     * turn already queued. */
    fun retryFailed() = control("retry-message", body = retryIdentity())
    /** The composer's Stop (A07-20; iOS f4e1b0efa `ConsoleModel.interrupt`): the turn, and the background work the session left running
     * with it — the runner's jobs, a dev server or watcher among them, and the engine's own shells, Monitors and background workflows.
     * The session is not ended: its next turn runs in it. The one interrupt that asks for this; a bare one kills nothing. */
    fun stop() = control("interrupt", body = buildJsonObject { put("stopBackgroundWork", true) })
    /** Settings › Translation's doors on one message (`turns/:id/translation/retry`, `…/send-as-written`, `events/:seq/translation/retry`):
     * a press of their own, which neither waits for the box nor holds it — a message can be sent while another one's translation is
     * retried — and goes once while it is out. What came of it arrives on the session's stream; a refusal is the box's error. */
    private val translationPresses = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    fun translationAction(endpoint: String) {
        if (!translationPresses.add(endpoint)) return
        launch {
            try { api.mutation(endpoint, null, HttpMethod.POST); refresh() }
            finally { translationPresses.remove(endpoint) }
        }
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

    /**
     * The tray's Withdraw (DELETE …/turns/:turnId; web `withdrawSteer` and `cancelQueued`, iOS `ConsoleModel`'s): a message queued for
     * the next turn, or a [steer] nothing has read yet — the server deletes one no runner has taken, and asks the runner holding one to
     * have its engine drop it. Taken back, its [words] return to the box under any draft: an explicit press, so a draft keeps its place
     * above them. Its pictures and files are not staged again: the box holds only what this device staged. Too late is an answer, not a
     * failure — the agent on [engine] read it first, and it is part of the turn.
     *
     * [files] are staged again too, read before the DELETE since the server drops them with the turn; [refused] is the one line a
     * failure is said with, in place of the tray's ([cancelHeld]).
     */
    fun withdraw(turnId: String, words: String?, steer: Boolean, engine: String, files: List<StagedAttachment> = emptyList(),
        refused: String? = null) {
        val id = ObjectId.canonical(turnId) ?: turnId
        if (id in state.value.withdrawing || id in state.value.withdrawn) return
        mutable.update { it.copy(withdrawing = it.withdrawing + id) }
        launch {
            try {
                val kept = try {
                    files.map { it to api.attachment(it.id) }.also { api.mutation("turns/$turnId", method = HttpMethod.DELETE) }
                }
                catch (cancel: CancellationException) { throw cancel }
                catch (e: Exception) {
                    when {
                        refused != null -> OrbitToasts.show(refused, detail = failure(e), tone = ToastTone.ERROR)
                        e is ApiError && e.code == "STEER_ALREADY_READ" ->
                            OrbitToasts.show(PendingTray.TOO_LATE, detail = PendingTray.alreadyRead(engine), tone = ToastTone.INFO)
                        !steer -> OrbitToasts.show(PendingTray.ALREADY_PROCESSING, tone = ToastTone.INFO)
                        else -> OrbitToasts.show(PendingTray.COULDNT_WITHDRAW, detail = failure(e), tone = ToastTone.ERROR)
                    }
                    return@launch
                }
                val restores = !words.isNullOrBlank() && state.value.loaded
                mutable.update { it.copy(withdrawn = it.withdrawn + id, draft = if (restores) it.draft.under(words!!) else it.draft) }
                if (restores) persist()
                kept.forEach { (file, bytes) ->
                    val staged = file.copy(id = UUID.randomUUID().toString(), size = bytes.size)
                    importAttachment(staged, { staged to bytes }, {})
                }
                refresh()
            } finally { mutable.update { it.copy(withdrawing = it.withdrawing - id) } }
        }
    }

    /** Cancel under a message whose translation failed: [withdraw], once the box is there to take it back. */
    fun cancelHeld(turnId: String, words: String, files: List<StagedAttachment>) {
        if (state.value.loaded) withdraw(turnId, words, steer = false, engine = "", files = files, refused = COULDNT_CANCEL_MESSAGE)
    }

    /** The tray's Steer (POST …/turns/:turnId/steer; web and iOS `steerQueued`): a message queued for the next turn sent into the one
     * running now, as the steer it would have been. With no turn left to join, or an engine or runner that cannot take one, it stays
     * queued, and the reader is told so in their terms. */
    fun steer(turnId: String) {
        val id = ObjectId.canonical(turnId) ?: turnId
        if (id in state.value.steering) return
        mutable.update { it.copy(steering = it.steering + id) }
        launch {
            try {
                try { api.mutation("turns/$turnId/steer") }
                catch (cancel: CancellationException) { throw cancel }
                catch (e: Exception) {
                    if (e is ApiError && e.code == "CURRENT_WORK_UNAVAILABLE") OrbitToasts.show(PendingTray.STEER_REFUSED,
                        detail = PendingTray.steerRefusal((e.body as? JsonObject)?.text("reason")), tone = ToastTone.INFO)
                    else OrbitToasts.show(PendingTray.STEER_REFUSED, detail = failure(e), tone = ToastTone.ERROR)
                    return@launch
                }
                mutable.update { it.copy(steered = it.steered + id) }
                refresh()
            } finally { mutable.update { it.copy(steering = it.steering - id) } }
        }
    }
    /**
     * Put back in the composer (web `restoreUndelivered`, and `takeBackUndelivered` for a receipt): the words of a steer that was not
     * delivered, back in the box under any draft as Withdraw returns them — an explicit press, so a draft keeps its place above them.
     * Nothing is sent. A steer known only from the server's receipt names its turn ([discard]), which is then discarded (DELETE
     * …/turns/:turnId) and its row gone from the tail; one the server keeps is said, and the words stay in the box.
     */
    fun putBack(words: String, discard: String? = null) {
        if (!state.value.loaded || (words.isBlank() && discard == null)) return
        val id = discard?.let { ObjectId.canonical(it) ?: it }
        if (id != null && (id in state.value.withdrawing || id in state.value.withdrawn)) return
        mutable.update { it.copy(draft = if (words.isBlank()) it.draft else it.draft.under(words.trim()),
            withdrawing = if (id == null) it.withdrawing else it.withdrawing + id) }
        launch {
            try {
                if (words.isNotBlank()) persist()
                if (discard == null) return@launch
                try { api.mutation("turns/$discard", method = HttpMethod.DELETE) }
                catch (cancel: CancellationException) { throw cancel }
                catch (e: Exception) { OrbitToasts.show(SteerDelivery.COULDNT_DISCARD, detail = failure(e), tone = ToastTone.ERROR); return@launch }
                mutable.update { it.copy(withdrawn = it.withdrawn + id!!) }
                refresh()
            } finally { if (id != null) mutable.update { it.copy(withdrawing = it.withdrawing - id) } }
        }
    }
    private fun failure(e: Exception) = if (e is ApiError) e.messages.firstOrNull() ?: directoryError(e) else directoryError(e)
    /** [words] back in the box under what it holds, the cursor after them. */
    private fun ComposerDraft.under(words: String): ComposerDraft {
        val next = if (text.isBlank()) words else "$text\n\n$words"
        return copy(text = next, selectionStart = next.length, selectionEnd = next.length)
    }

    fun loadCatalog() {
        if (state.value.catalogLoading) return
        mutable.update { it.copy(catalogLoading = true, catalogError = null, catalog = null) }
        launch {
            try { val catalog = threeTries { api.catalog(api.detail()) }; mutable.update { it.copy(catalog = catalog) } }
            catch (e: Exception) { if (e is CancellationException) throw e; mutable.update { it.copy(catalogError = directoryError(e)) } }
            finally { mutable.update { it.copy(catalogLoading = false) } }
        }
    }
    /** The session's runner row again, once a minute while the session streams and on each reconnect (A07-18, iOS bc790273c
     * `refreshRunner`), for what the catalogue on screen reads off it — the context window, the model menu, the quotas; a catalogue
     * whose opening read failed is read whole. Quiet: a read that fails keeps what is shown, and nothing is read for a catalogue
     * nothing has asked for. */
    suspend fun refreshCatalog() {
        val now = state.value
        if (now.catalogLoading) return
        val shown = now.catalog
        try {
            if (shown != null) {
                val runner = api.runner(shown.runner.text("id")) ?: return
                mutable.update { if (it.catalog !== shown) it else it.copy(catalog = shown.copy(runner = runner)) }
            } else if (now.catalogError != null) {
                val catalog = api.catalog(api.detail())
                mutable.update { if (it.catalogLoading || it.catalog != null) it else it.copy(catalog = catalog, catalogError = null) }
            }
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
    }
    /** A provider is never written without its engine (docs/provider-engine-contract.md §3.5, §6.1): the session's own, which a
     * switch never changes, or — for a draft — the engine the provider was picked under, else the provider's default. */
    private fun withEngine(values: JsonObject, detail: JsonObject): JsonObject {
        val provider = values.text("provider") ?: return values
        if (values["engine"] != null) return values
        val engine = (if (target == null) detail.text("engine") else null) ?: state.value.catalog?.providerEngines(provider)?.firstOrNull() ?: return values
        return JsonObject(values + ("engine" to JsonPrimitive(engine)))
    }
    private suspend fun draftOrSessionDetail(): JsonObject = if (target?.isMachineDraft == true) {
        runCatching { api.detail() }.getOrElse {
            val runner = state.value.catalog?.runner
            MachineSetup.machineDraft(
                target.runnerId.orEmpty(),
                runner?.let(RunnerPage::displayName) ?: target.runnerId.orEmpty(),
                runner?.let(MachineSetup::firstEngineOn) ?: ProviderEngines.CLAUDE,
            )
        }
    } else api.detail()

    private fun buildCreateBody(
        detail: JsonObject,
        content: String,
        shell: Boolean,
        attachments: List<StagedAttachment>,
        seedModel: String?,
    ): JsonObject {
        val config = state.value.draft.resumeConfig
        return buildJsonObject {
            config.filterKeys { it != "account" }.forEach { (k, v) -> put(k, v) }
            if (config["model"] == null) seedModel?.let { put("model", it) }
            put("workspaceId", target!!.workspaceId)
            target.folderId?.let { put("folderId", it) }
            put("prompt", content)
            put("shell", shell)
            config.text("account")?.let { account ->
                val provider = config.text("provider") ?: detail.text("lastProvider") ?: detail.text("provider")
                if (provider != null && RunnerPage.keepsAccounts(provider) && account != "automatic") {
                    put("${provider}Account", account)
                }
            }
            putJsonArray("attachmentIds") { attachments.mapNotNull { it.remoteId }.forEach { add(it) } }
        }
    }

    fun config(requested: JsonObject, accountOnly: Boolean = false) {
        if (state.value.busy || state.value.waiting || state.value.draft.pending != null || state.value.draft.createdSessionId != null) return
        mutable.update { it.copy(busy = true, error = null) }
        launch {
            try {
                val detail = draftOrSessionDetail()
                val values = withEngine(requested, detail)
                // A provider picked for the session says what it will do and when, in place of the line that only said it was kept.
                val note = switchNote(detail, values)
                if (target != null || terminal(detail) && !accountOnly) {
                    mutable.update {
                        val config = it.draft.resumeConfig
                        val changedProvider = values.text("provider")?.let { provider -> provider != (config.text("provider") ?: detail.text("provider")) } == true
                        it.copy(draft = it.draft.copy(resumeConfig = JsonObject((if (changedProvider) config - "account" else config) + values)),
                            notice = if (note != null) null else if (target == null) "Applies when this session resumes." else "Applies when this session starts.",
                            switchNote = note ?: it.switchNote)
                    }
                    persist()
                } else {
                    api.mutation(if (accountOnly) "account" else "config", values, HttpMethod.PATCH)
                    mutable.update { it.copy(notice = if (note != null) null else "Selection saved.", switchNote = note ?: it.switchNote) }; refresh()
                }
            } finally { mutable.update { it.copy(busy = false) } }
        }
    }
    /** What a provider picked for the session will do, and when (A07-19 (a), iOS e6295abe7/6f3083272 `providerSwitchNote`): said by the
     * names of the credential it is on — or a pick already held for it — and the one picked, over a session still going as the turn
     * in flight finishing on the one and the next on the other. None for a draft, a pick of what it is already on, or before the
     * catalogue that names them is read. A session held for its runner's Claude region has nothing in flight: its waiting message runs on
     * the pick (OrbitKit ConsoleModel `liveRun: isLive && !regionHeld`). */
    private fun switchNote(detail: JsonObject, values: JsonObject): String? {
        if (target != null) return null
        val to = values.text("provider") ?: return null
        val from = state.value.draft.resumeConfig.text("provider") ?: detail.text("provider") ?: return null
        val catalog = state.value.catalog ?: return null
        val engine = values.text("engine") ?: catalog.engineOf(detail)
        return EngineCopy.switchNote(catalog.providerName(engine, from), catalog.providerName(engine, to),
            liveRun = !terminal(detail) && !ClaudeRegion.held(detail))
    }
    fun consumeCreated() { mutable.update { it.copy(draft = it.draft.copy(createdSessionId = null)) }; launch { persist() } }

    /** A pick made for this draft from elsewhere — a Cursor CLI quota card's "start a new session on Team" (the board's iOS 5 ⑧) — held as
     * if picked here, once the draft's saved copy is read: its engine, provider and account, the model left to the draft's own seed. */
    /** Words put in this draft from elsewhere — Save & clean's "Open in a new session" — as [putBack] does, once the saved copy is read. */
    fun putBackWhenLoaded(words: String) {
        launch {
            withTimeoutOrNull(10_000) { state.first { it.loaded } } ?: return@launch
            putBack(words)
        }
    }

    fun hold(values: JsonObject) {
        launch {
            withTimeoutOrNull(10_000) { state.first { it.loaded } } ?: return@launch
            mutable.update { it.copy(draft = it.draft.copy(resumeConfig = JsonObject(it.draft.resumeConfig - "account" - "model" - "effort" + values))) }
            persist()
        }
    }
}
