package io.orbitd.android.reader

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.directory.DirectoryApi
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import java.util.UUID

/** An outcome of a worktree action, said where the bar is: a failure stays until dismissed, the rest go by themselves. */
internal data class WorktreeNotice(val message: String, val detail: String? = null, val failure: Boolean = false,
    val key: String? = null, val inProgress: Boolean = false, val id: Long = System.nanoTime())

internal data class WorktreeState(val detail: JsonObject? = null, val busy: Boolean = false, val notice: WorktreeNotice? = null,
    val diff: List<JsonObject> = emptyList(), val diffLoading: Boolean = false, val diffRefreshing: Boolean = false)

/**
 * The worktree bar for one session (iOS `WorktreeModel`): the session detail behind the bar, polled while
 * an outcome is pending (3 s) or the session is live (5 s), the lazily read per-file diffs, and the commit /
 * merge / adopt / resolve-in-session actions with their shared busy flag. A request the server accepted is
 * followed to its result, which the bar then says.
 */
internal class WorktreeModel(private val api: DirectoryApi, private val id: String, private val scope: CoroutineScope) {
    private val mutable = MutableStateFlow(WorktreeState())
    val state = mutable.asStateFlow()
    private var followed: String? = null
    private var accepts = 0
    private var diffGeneration = 0

    /** A read the realtime store made; taken unless this bar is waiting on its own request's answer. */
    fun offer(detail: JsonObject) {
        if (mutable.value.busy || followed != null) return
        adopt(detail, follow = false)
    }

    /** Best effort: a failed read keeps the last snapshot, so a blip doesn't blank the bar. */
    suspend fun loadDetail() {
        val acceptedBefore = accepts
        val next = try { api.objectRead(listOf("sessions", id)) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return }
        // A read already in flight when a request was accepted can carry the status from before it.
        adopt(next, follow = acceptedBefore == accepts)
    }

    private fun adopt(next: JsonObject, follow: Boolean) {
        val old = mutable.value.detail
        mutable.update { it.copy(detail = next) }
        surfaceRetry(old, next)
        if (follow) followed?.let { kind -> resultNotice(kind, next)?.let { followed = null; say(it) } }
    }

    /** Keep the bar current while the session is on screen (web's refetch policy). */
    suspend fun poll(live: () -> Boolean) {
        loadDetail()
        while (currentCoroutineContext().isActive) {
            val d = mutable.value.detail
            val pending = d?.string("mergeStatus") == "pending" || d?.string("commitStatus") == "pending"
            val repairing = (d?.get("mergeRepairSession") as? JsonObject)?.let { it.string("runState") ?: it.string("runStatus") } in setOf("QUEUED", "RUNNING")
            if (!pending && !live() && !repairing) { delay(3_000); continue }
            delay(if (pending) 3_000 else 5_000)
            loadDetail()
        }
    }

    fun commit() = act {
        try { api.mutate(listOf("sessions", id, "commit")) }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { say(failure("Couldn't start the commit", error, "commit")); return@act }
        accepted("commit")
    }

    fun merge(target: String?) = act {
        try { api.mutate(listOf("sessions", id, "merge"), body = buildJsonObject { target?.let { put("targetBranch", it) } }) }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { say(failure("Couldn't start the merge" + (target?.let { " into $it" } ?: ""), error, "merge")); return@act }
        accepted("merge")
    }

    /** Re-point the session at the branch its worktree is really on, after an in-worktree `git checkout -b`. */
    fun adoptBranch() = act {
        try { api.mutate(listOf("sessions", id, "adopt-branch")) }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { say(failure("Couldn't update the tracked branch", error)); return@act }
        say(WorktreeNotice("Now tracking this worktree's branch"))
        loadDetail()
    }

    /** One step of a merge held for target recovery: check again (`preview`), push the reviewed candidate, sync local. */
    fun recoverMerge(action: String, previewId: String?, target: String) = act {
        try {
            api.mutate(listOf("sessions", id, "merge"), body = buildJsonObject {
                put("targetBranch", target); put("recoveryAction", action); previewId?.let { put("previewId", it) }
            })
        } catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { say(failure("Couldn't start the recovery", error)); return@act }
        // A preview only checks again, and the review shows what it found; every other step is followed to its result.
        if (action != "preview") { followed = "merge"; accepts++ }
        loadDetail()
    }

    /** A repair session for the recovery — to resolve it, or to prepare a PR candidate — opened once it exists. */
    fun repairRecovery(preparePR: Boolean, opened: (String) -> Unit) = act {
        val created = try { api.mutate(listOf("sessions", id, "merge-repair"), body = buildJsonObject { put("preparePR", preparePR) }) }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { say(failure("Couldn't start the repair session", error)); return@act }
        loadDetail()
        runCatching { io.orbitd.android.core.protocol.Wire.json.parseToJsonElement(created.decodeToString()).jsonObject.string("id") }.getOrNull()
            ?.let { withContext(Dispatchers.Main) { opened(it) } }
    }

    /** Hand a conflicted merge to the session's own agent, which has the context for its changes. */
    fun resolveInSession(branch: String, target: String) = resume(WorktreeBarLogic.resolveConflictPrompt(branch, target),
        "Resuming the session to resolve the conflict…", "Couldn't start resolving the conflict")

    /** Hand a failed commit to the session: its agent can see what refused it and clear it. */
    fun resolveCommitInSession(branch: String, why: String) = resume(WorktreeBarLogic.resolveCommitPrompt(branch, why),
        "Handed the commit to the session", "Couldn't hand the commit to the session")

    private fun resume(content: String, done: String, failed: String) = act {
        try {
            api.mutate(listOf("sessions", id, "resume"), body = buildJsonObject {
                put("clientTurnId", UUID.randomUUID().toString()); put("content", content); put("kind", "message")
            })
        } catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { say(failure(failed, error)); return@act }
        say(WorktreeNotice(done))
        loadDetail()
    }

    fun dismiss(notice: WorktreeNotice) { mutable.update { if (it.notice?.id == notice.id) it.copy(notice = null) else it } }

    /** Current-worktree bytes, never kept: reopening or retrying a preview reads the file as it is now. */
    suspend fun readFile(path: String): ByteArray = api.bytes(listOf("sessions", id, "worktree-file"), listOf("path" to path))

    /** The per-file patches, and for a live session whose file list is ahead of them, a refresh the runner answers within ~16 s. */
    suspend fun loadDiff(isLive: Boolean) {
        val generation = ++diffGeneration
        mutable.update { it.copy(diffLoading = true, diffRefreshing = false) }
        try {
            val patches = try { readPatches() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return }
            if (generation != diffGeneration) return
            mutable.update { it.copy(diff = patches) }
            if (!refreshNeeded(isLive)) return
            mutable.update { it.copy(diffLoading = false, diffRefreshing = true) }
            try { api.mutate(listOf("sessions", id, "diff", "refresh")) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {}
            repeat(8) {
                delay(2_000)
                if (generation != diffGeneration) return
                val next = try { readPatches() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return@repeat }
                if (generation != diffGeneration) return
                mutable.update { it.copy(diff = next) }
                loadDetail()
                if (!refreshNeeded(isLive)) return
            }
        } finally {
            if (generation == diffGeneration) mutable.update { it.copy(diffLoading = false, diffRefreshing = false) }
        }
    }

    private suspend fun readPatches() = (api.objectRead(listOf("sessions", id, "diff"))["patches"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
    private fun refreshNeeded(isLive: Boolean) = WorktreeBarLogic.shouldRefreshDiff(isLive, ChangedFile.of(mutable.value.detail), mutable.value.diff)

    private fun act(block: suspend () -> Unit) {
        if (mutable.value.busy) return
        mutable.update { it.copy(busy = true) }
        scope.launch { try { block() } finally { mutable.update { it.copy(busy = false) } } }
    }

    private suspend fun accepted(kind: String) {
        followed = kind
        accepts++
        // Reflect the pending state at once; the poll then follows the runner's answer.
        loadDetail()
    }

    private fun say(notice: WorktreeNotice) = mutable.update { it.copy(notice = notice) }

    /** A failed merge or commit picked up again: say it is under way until its result takes the place. */
    private fun surfaceRetry(old: JsonObject?, new: JsonObject) {
        old ?: return
        if (old.string("mergeStatus") in setOf("conflict", "error") && new.string("mergeStatus") == "pending")
            say(WorktreeNotice("Merging into ${new.string("mergeTarget") ?: "main"}…", key = "merge", inProgress = true))
        else if (old.string("commitStatus") == "error" && new.string("commitStatus") == "pending")
            say(WorktreeNotice("Committing changes…", key = "commit", inProgress = true))
    }

    companion object {
        /** What the runner answered a merge or commit with, as web's notices say it; null while there is nothing to report. */
        fun resultNotice(kind: String, detail: JsonObject): WorktreeNotice? {
            val trimmed = { key: String -> detail.string(key)?.trim()?.ifEmpty { null } }
            if (kind == "merge") {
                (detail["mergeRecovery"] as? JsonObject)?.let { MergeRecovery.of(it) }?.let { return WorktreeNotice(it.title, key = "merge", failure = it.code != "READY") }
                val target = detail.string("mergeTarget") ?: "main"
                return when (detail.string("mergeStatus")) {
                    "merged" -> WorktreeNotice("Merged into $target", key = "merge")
                    "conflict" -> WorktreeNotice("Couldn't merge into ${WorktreeBarLogic.conflictTarget(detail.string("mergeTarget"),
                        (detail["mergeTargets"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
                        (detail["agent"] as? JsonObject)?.string("defaultMergeTarget"))}", trimmed("mergeError"), failure = true, key = "merge")
                    "error" -> WorktreeNotice("Couldn't merge into $target", trimmed("mergeError"), failure = true, key = "merge")
                    else -> null
                }
            }
            return when (detail.string("commitStatus")) {
                "error" -> WorktreeNotice("Couldn't commit", WorktreeBarLogic.commitFailure(detail.string("commitStatus"), detail.string("commitError"),
                    detail.string("commitResultMessage"))?.why, failure = true, key = "commit")
                "committed" -> WorktreeNotice("Changes committed", trimmed("commitResultMessage"), key = "commit")
                "nochange" -> WorktreeNotice("No changes to commit", trimmed("commitResultMessage"), key = "commit")
                else -> null
            }
        }

        /** A failed action: the attempt as the headline, the server's own words under it. */
        fun failure(headline: String, error: Throwable, key: String? = null) = WorktreeNotice(headline, when (error) {
            is ApiError -> if (error.status == 401) "Session expired — sign in again." else error.messages.joinToString("\n").ifEmpty { null }
                ?: ((error.body as? JsonObject)?.get("error") as? JsonPrimitive)?.contentOrNull
            is NetworkException -> "Check your connection."
            else -> "Check your connection."
        }, failure = true, key = key)
    }
}
