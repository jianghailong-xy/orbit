package io.orbitd.android.reader

import androidx.compose.runtime.staticCompositionLocalOf
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastTone
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.util.UUID

/** The two calls the model makes, so a session (DirectoryApi) and the runner page (ManagementApi) can both drive it. */
internal interface MainCheckoutTransport {
    suspend fun get(path: List<String>, query: List<Pair<String, String>> = emptyList()): JsonElement
    suspend fun send(path: List<String>, method: HttpMethod = HttpMethod.POST, body: JsonObject? = null): JsonElement?
}

internal fun DirectoryApi.mainCheckoutTransport() = object : MainCheckoutTransport {
    override suspend fun get(path: List<String>, query: List<Pair<String, String>>) = read(path, JsonElement.serializer(), query)
    override suspend fun send(path: List<String>, method: HttpMethod, body: JsonObject?): JsonElement? =
        mutate(path, method, body).decodeToString().takeIf { it.isNotBlank() }?.let { runCatching { Wire.json.parseToJsonElement(it) }.getOrNull() }
}

internal data class MainCheckoutState(
    /** The workspace record: `repoHealth` (§4 counts), `mainCheckoutActions`, `workDir`, `enableWorktree`. */
    val workspace: JsonObject? = null,
    /** The review sheet's read (§10.4), and its per-file patches as they are asked for. */
    val view: MainCheckout.View? = null,
    val viewLoading: Boolean = false,
    val viewError: String? = null,
    val diffs: Map<String, JsonObject> = emptyMap(),
    val diffLoading: Set<String> = emptySet(),
    val busy: Boolean = false,
    /** Which sheet is up: the review, or this session's own worktree changes (a Move line's View changes). */
    val sheet: Sheet? = null,
    /** A push waiting on the managed-branch warning (§5): the project it skips. */
    val confirmPush: String? = null,
    /** Other worktree sessions of the workspace a Move could go to (board 02②): id, title, branch, running. */
    val targets: List<MoveTarget> = emptyList(),
) {
    enum class Sheet { REVIEW, WORKTREE_CHANGES }
}

internal data class MoveTarget(val id: String, val title: String, val branch: String, val busy: Boolean)

/**
 * The main checkout of one session's workspace (board 01–03): the bar's counts from the workspace's heartbeat entry, the review
 * sheet's snapshot and diffs, and the four actions. An action's outcome comes back as a line in the session ([TranscriptRows]),
 * so this only says what the server refused outright.
 */
internal class MainCheckoutModel(private val api: MainCheckoutTransport, val sessionId: String?, private val scope: CoroutineScope) {
    private val mutable = MutableStateFlow(MainCheckoutState())
    val state = mutable.asStateFlow()
    var workspaceId: String? = null
        private set

    /** Composer prefill and openers the session supplies; the runner page leaves them unset. */
    var prefill: (String) -> Unit = {}
    /** Opens the workspace's new-session draft with a prompt in it, nothing sent. */
    var openDraft: (workspaceId: String, prompt: String) -> Unit = { _, _ -> }

    fun bind(workspaceId: String?) {
        if (workspaceId == null || workspaceId == this.workspaceId) return
        this.workspaceId = workspaceId
        mutable.update { MainCheckoutState() }
    }

    fun adoptWorkspace(workspace: JsonObject) { mutable.update { it.copy(workspace = workspace) } }

    val actionsSupported get() = (mutable.value.workspace?.get("mainCheckoutActions") as? JsonPrimitive)?.booleanOrNull == true
    val repoHealth get() = mutable.value.workspace?.get("repoHealth") as? JsonObject

    suspend fun loadWorkspace() {
        val id = workspaceId ?: return
        val next = try { api.get(listOf("workspaces", id)) as? JsonObject } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null } ?: return
        mutable.update { it.copy(workspace = next) }
    }

    /** The bar follows the heartbeat (60 s on the runner): read the workspace again every 20 s while it is on screen. */
    suspend fun poll() {
        while (currentCoroutineContext().isActive) { loadWorkspace(); delay(20_000) }
    }

    fun open(sheet: MainCheckoutState.Sheet?) {
        mutable.update { it.copy(sheet = sheet) }
        if (sheet == MainCheckoutState.Sheet.REVIEW) scope.launch { loadView(); loadTargets() }
    }

    suspend fun loadView(): MainCheckout.View? {
        val id = workspaceId ?: return null
        mutable.update { it.copy(viewLoading = true, viewError = null) }
        return try {
            val view = (api.get(listOf("workspaces", id, "main-checkout")) as? JsonObject)?.let(MainCheckout::view)
            mutable.update { it.copy(view = view, viewLoading = false, diffs = emptyMap()) }
            view
        } catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { mutable.update { it.copy(viewLoading = false, viewError = reason(error)) }; null }
    }

    fun loadDiff(path: String) {
        val id = workspaceId ?: return
        if (path in mutable.value.diffs || path in mutable.value.diffLoading) return
        mutable.update { it.copy(diffLoading = it.diffLoading + path) }
        scope.launch {
            try {
                val read = api.get(listOf("workspaces", id, "main-checkout"), listOf("diff" to path)) as? JsonObject ?: JsonObject(emptyMap())
                val diff = (read["diffs"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                    .firstOrNull { (it["path"] as? JsonPrimitive)?.contentOrNull == path } ?: buildJsonObject { put("path", path) }
                mutable.update { it.copy(diffs = it.diffs + (path to diff)) }
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {
            } finally { mutable.update { it.copy(diffLoading = it.diffLoading - path) } }
        }
    }

    /** The workspace's other worktree sessions, for Move to a worktree ▾. Best effort: without them, only this session is offered. */
    suspend fun loadTargets() {
        val id = workspaceId ?: return
        val list = try { api.get(listOf("sessions"), listOf("workspaceId" to id, "view" to "open")) }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        val rows = (list as? JsonArray ?: (list as? JsonObject)?.get("sessions") as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
        mutable.update { it.copy(targets = moveTargets(rows, sessionId)) }
    }

    fun request(build: (requestId: String) -> MainCheckout.Request, after: () -> Unit = {}) {
        val id = workspaceId ?: return
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true) }
        scope.launch {
            try {
                api.send(listOf("workspaces", id, "main-checkout", "actions"), body = MainCheckout.encode(build(UUID.randomUUID().toString())))
                withContext(Dispatchers.Main) { after() }
            } catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) { OrbitToasts.show("Couldn't reach the main checkout", detail = reason(error), tone = ToastTone.ERROR) }
            finally { mutable.update { it.copy(busy = false) }; loadWorkspace() }
        }
    }

    /** Push from the bar or a Commit line: read the checkout first, for its HEAD and whether the branch is a project's (§5). */
    fun push(confirmed: Boolean = false) = scope.launch {
        val view = mutable.value.view?.takeIf { confirmed } ?: loadView() ?: return@launch
        val managed = view.managedBranch
        if (!confirmed && managed != null) { mutable.update { it.copy(confirmPush = managed.projectTitle) }; return@launch }
        mutable.update { it.copy(confirmPush = null) }
        request({ MainCheckout.push(view.snapshot.root, view.snapshot.fingerprint, it, sessionId) })
    }

    fun dismissPush() = mutable.update { it.copy(confirmPush = null) }

    fun cancel(requestId: String) {
        val id = workspaceId ?: return
        scope.launch {
            try { api.send(listOf("workspaces", id, "main-checkout", "actions", requestId, "cancel")) }
            catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) { OrbitToasts.show("Couldn't cancel", detail = reason(error), tone = ToastTone.ERROR) }
        }
    }

    fun cleanUp() {
        val id = workspaceId ?: return
        scope.launch {
            try { api.send(listOf("workspaces", id, "repo-cleanup")); OrbitToasts.show("Cleaning up the main checkout…", tone = ToastTone.INFO) }
            catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) { OrbitToasts.show("Couldn't clean up the checkout", detail = reason(error), tone = ToastTone.ERROR) }
        }
    }

    private fun reason(error: Exception): String? = when (error) {
        is ApiError -> error.messages.joinToString("\n").ifEmpty { null } ?: ((error.body as? JsonObject)?.get("message") as? JsonPrimitive)?.contentOrNull
        else -> "Check your connection."
    }

    companion object {
        /** Sessions of the list a Move can name: worktree sessions on a branch, this one first; a running one is shown, not offered. */
        fun moveTargets(rows: List<JsonObject>, self: String?): List<MoveTarget> = rows.mapNotNull { row ->
            val s = { k: String -> (row[k] as? JsonPrimitive)?.contentOrNull }
            val id = s("id") ?: return@mapNotNull null
            val branch = s("branch")?.takeIf { s("isolationStatus") == "worktree" && it.isNotEmpty() } ?: return@mapNotNull null
            val status = s("runStatus") ?: s("status")
            MoveTarget(id, s("title") ?: "Untitled", branch, status in setOf("PENDING", "RUNNING"))
        }.sortedByDescending { it.id == self }
    }
}

internal val LocalMainCheckout = staticCompositionLocalOf<MainCheckoutModel?> { null }
