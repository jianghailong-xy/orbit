package io.orbitd.android.directory

import io.orbitd.android.composer.CloneHeard
import io.orbitd.android.composer.CloneState
import io.orbitd.android.composer.WorkspaceClone
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * A session held by its GitHub workspace's clone (queuedReason `WORKSPACE_CLONING` / `WORKSPACE_CLONE_FAILED`). Every word is web
 * `runnerSlots.ts`'s (`CLONE_WAIT_TITLE`, `cloneWaitTitle`, `CLONE_WAIT_STARTS`, `cloneRowLabel`, `CLONE_FAILED_*`), and the waiting
 * card's logic is web `useCloneWait` (docs/mocks/clone-progress-wait-card).
 */
internal object QueuedClone {
    const val REASON_CLONING = "WORKSPACE_CLONING"
    const val REASON_FAILED = "WORKSPACE_CLONE_FAILED"
    const val TITLE = "Waiting for the clone"
    const val FAILED_TITLE = "Clone failed"
    const val FAILED_WAIT = "This session starts once the repository is cloned."
    const val STARTS = "This session starts when the clone is done."

    fun isCloning(gate: QueuedGate?): Boolean = gate?.queuedReason == REASON_CLONING
    fun isFailed(gate: QueuedGate?): Boolean = gate?.queuedReason == REASON_FAILED
    fun isHeld(gate: QueuedGate?): Boolean = isCloning(gate) || isFailed(gate)

    /** The waiting card's title while a clone is under way or yet to start. */
    fun waitTitle(state: CloneState, repository: String): String =
        "${if (state == CloneState.CLONING) "Cloning" else "Waiting to clone"} $repository"

    /** A held session's list line once git has reported a percentage. */
    fun rowLabel(progress: Int): String = "Cloning · $progress%"

    /** Where a held session's clone stands: what is cloning, git's percentage when it has said one (null before), and the state. */
    data class Wait(val state: CloneState, val progress: Int?, val repository: String)

    /**
     * The clone behind a held session, from its detail's `workspace` (repoUrl, cloneState — read at [storedAtMs]) weighed against what the
     * stream [heard]; null unless this is a GitHub clone still PENDING or CLONING (then the plain queued words stand).
     */
    fun wait(workspace: JsonObject?, heard: CloneHeard?, storedAtMs: Long? = null): Wait? {
        fun text(key: String) = (workspace?.get(key) as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
        val stored = text("cloneState") ?: return null
        val repository = WorkspaceClone.repositoryOf(text("repoUrl")) ?: return null
        val clone = WorkspaceClone.now(stored, heard, storedAtMs) ?: return null
        if (clone.state != CloneState.PENDING && clone.state != CloneState.CLONING) return null
        return Wait(clone.state, clone.progress, repository)
    }
}
