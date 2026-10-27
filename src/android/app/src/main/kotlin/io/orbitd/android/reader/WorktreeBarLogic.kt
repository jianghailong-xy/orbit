package io.orbitd.android.reader

import kotlinx.serialization.json.*

/** One changed file of a session's worktree, as `SessionDetail.changedFiles` carries it; binary when its counts are negative. */
internal data class ChangedFile(val path: String, val additions: Int, val deletions: Int, val status: String) {
    val binary: Boolean get() = additions < 0 || deletions < 0

    companion object {
        fun of(detail: JsonObject?): List<ChangedFile> = (detail?.get("changedFiles") as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            .mapNotNull { file -> file.string("path")?.let { ChangedFile(it, file.int("additions"), file.int("deletions"), file.string("status").orEmpty()) } }
        private fun JsonObject.int(key: String) = (get(key) as? JsonPrimitive)?.intOrNull ?: 0
    }
}

/**
 * The worktree bar's decisions — OrbitKit's `WorktreeBarLogic`, which mirrors web's `SessionOutputs`: the
 * view hands in the session's git state and lifecycle and draws whatever comes back.
 */
internal object WorktreeBarLogic {
    enum class Mode { HIDDEN, NOT_ISOLATED, WORKTREE }

    /** No isolation → hidden; `shared-nogit` → the nudge; a worktree with a branch and a change (or an outcome to report) → the bar. */
    fun mode(isolationStatus: String?, branch: String?, changedFileCount: Int, mergeStatus: String? = null,
        commitStatus: String? = null, hasMergeRecovery: Boolean = false): Mode {
        val iso = isolationStatus ?: return Mode.HIDDEN
        if (iso == "shared-nogit") return Mode.NOT_ISOLATED
        if (iso != "worktree" || branch == null) return Mode.HIDDEN
        val actionable = mergeStatus in setOf("pending", "conflict", "error") || commitStatus in setOf("pending", "error")
        return if (changedFileCount > 0 || actionable || hasMergeRecovery) Mode.WORKTREE else Mode.HIDDEN
    }

    /** What a session without a worktree (`shared-nogit`: it edits its workspace's folder directly) says above the composer. */
    enum class SharedFolder { HIDDEN, NOT_GIT, NO_BRANCH }

    /**
     * From the session's workspace record (web's `sharedFolderOf`): nothing once the workspace has answered the notice — worktree
     * isolation turned off, or git initialization queued; a repository git couldn't branch; else a folder that is not a repository,
     * which is also how an unknown reads (an older runner never probed the folder, or the record couldn't be read).
     */
    fun sharedFolder(workDirIsGit: Boolean?, autoInitGit: Boolean?, enableWorktree: Boolean?): SharedFolder = when {
        enableWorktree == false || autoInitGit == true -> SharedFolder.HIDDEN
        workDirIsGit == true -> SharedFolder.NO_BRANCH
        else -> SharedFolder.NOT_GIT
    }

    enum class Primary { NONE, COMMIT, MERGE }

    /** A dirty live tree commits and a clean one merges; an older runner (no `worktreeDirty`) goes by the lifecycle. Merge waits for the turn. */
    fun primary(worktreeDirty: Boolean?, committed: Boolean, turnActive: Boolean): Primary {
        val dirtyKnown = worktreeDirty != null
        val showCommit = dirtyKnown && worktreeDirty == true && !committed
        val mergeReady = if (dirtyKnown) !showCommit else committed
        return when { showCommit -> Primary.COMMIT; mergeReady && !turnActive -> Primary.MERGE; else -> Primary.NONE }
    }

    /**
     * Whether a turn is in flight: what holds Merge back and keeps Commit and the merge recovery's steps disabled (iOS
     * `WorktreeBarLogic.turnActive`, f759d743e). A queued turn counts as much as a running one — the server refuses to merge
     * or commit during either. So does a message on its way ([sending]): the send queues the turn before the record says
     * so, and a Merge pressed in that gap came back "wait for the current turn to finish before merging". A parked session
     * whose sub-agents still run is still writing to the worktree. An ended session holds nothing back.
     */
    fun turnActive(status: String?, runningSubagents: Int?, sending: Boolean): Boolean = when (status) {
        "PENDING", "RUNNING" -> true
        "AWAITING_INPUT", "INTERRUPTED" -> sending || (runningSubagents ?: 0) > 0
        else -> false
    }

    /** The sub-agents still at work: the detail's `runningSubagents` ids, or the session list row's `runningSubagentCount`. */
    fun runningSubagents(detail: JsonObject): Int? =
        (detail["runningSubagents"] as? JsonArray)?.size ?: (detail["runningSubagentCount"] as? JsonPrimitive)?.intOrNull

    /** The agent's remembered target if still offered, else main, else master, else the first; null lets the runner detect it. */
    fun defaultTarget(targets: List<String>, agentDefaultTarget: String?): String? = when {
        agentDefaultTarget != null && agentDefaultTarget in targets -> agentDefaultTarget
        "main" in targets -> "main"
        "master" in targets -> "master"
        else -> targets.firstOrNull()
    }

    /** A real conflict can only be cleared by the agent rebasing; an `error` is a precondition a plain retry follows. */
    fun resolvable(mergeStatus: String?): Boolean = mergeStatus == "conflict"

    fun conflictTarget(mergeTarget: String?, targets: List<String>, agentDefaultTarget: String?): String =
        mergeTarget ?: defaultTarget(targets, agentDefaultTarget) ?: "main"

    /** The failed commit or merge in words, keeping the runner's raw git output (a phone has no hover tooltip). */
    fun failureMessage(mergeStatus: String?, mergeError: String?, commitStatus: String?, commitError: String?): String? = when {
        commitStatus == "error" -> trimmed(commitError) ?: "Commit failed — try again."
        mergeStatus == "conflict" -> trimmed(mergeError)?.let { "Merge conflict — aborted, working tree left clean.\n$it" }
            ?: "Merge conflict — aborted, working tree left clean."
        mergeStatus == "error" -> trimmed(mergeError) ?: "Merge failed — try again."
        else -> null
    }

    data class CommitFailure(val headline: String, val why: String, val gitOutput: String?)

    /** A failed commit as the person who pressed Commit needs it: what, why (the runner's own sentence first), and git's words. */
    fun commitFailure(commitStatus: String?, commitError: String?, commitResultMessage: String?): CommitFailure? {
        if (commitStatus != "error") return null
        val raw = trimmed(commitError).orEmpty()
        val lockBusy = raw.contains("index.lock")
        val firstLine = raw.split("\n").map { it.trim() }.firstOrNull { it.isNotEmpty() }
        val why = trimmed(commitResultMessage)
            ?: (if (lockBusy) "Another git process holds this worktree's index lock. Retry once it finishes, or hand it to the session." else null)
            ?: firstLine ?: "Commit failed — try again."
        return CommitFailure(if (lockBusy) "Couldn't commit — git is busy in this worktree" else "Couldn't commit", why,
            raw.takeIf { it.isNotEmpty() && it != why })
    }

    /** What "Resolve in session" asks the agent to do about a failed commit — word for word web's `resolveCommitPrompt`. */
    fun resolveCommitPrompt(branch: String, why: String): String =
        "The Commit button on the worktree bar could not commit this session's work. It said: \"$why\"\n\n" +
            "You're in this session's isolated git worktree, checked out on $branch. Find out what stopped" +
            " the commit and clear it: let a git command that is still running here finish; an index.lock" +
            " that no process has open was left behind by a git that died and is safe to remove. Then commit" +
            " the work on this branch with a message that describes it. Do not push."

    /** What "Resolve in session" asks about a merge conflict — web's `resolveMut` prompt. */
    fun resolveConflictPrompt(branch: String, target: String): String =
        "Rebase this branch onto the latest $target and resolve any conflicts.\n\n" +
            "You're in this session's isolated git worktree, checked out on $branch. " +
            "Run git rebase $target — it may stop on conflicts. For each, resolve every conflict " +
            "using your knowledge of the changes made on this branch, git add the resolved " +
            "files, then git rebase --continue, repeating until the rebase completes. Do not " +
            "push. Once the rebase finishes, the branch can be merged into $target cleanly from " +
            "the status bar above the composer."

    fun manualMergeCommand(mergeTarget: String?, branch: String): String {
        val target = mergeTarget ?: "main"
        return "git rebase $target $branch && git checkout $target && git merge --ff-only $branch"
    }

    /** Whether the file list is ahead of the stored patches, so a live session asks its runner for a fresh diff. */
    fun shouldRefreshDiff(isLive: Boolean, changedFiles: List<ChangedFile>, patches: List<JsonObject>): Boolean {
        if (!isLive) return false
        val ready = patches.mapNotNull { patch ->
            val path = patch.string("path") ?: return@mapNotNull null
            if (patch.string("truncated") == "true") path else patch.string("patch")?.takeIf { it.isNotEmpty() }?.let { path }
        }.toSet()
        return changedFiles.any { !it.binary && it.path !in ready }
    }

    /** `orbit/<slug>-<hash>` as (prefix, slug, hash), for a label that dims the parts nobody reads first; null for any other shape. */
    fun branchParts(branch: String): Triple<String, String, String>? {
        if (!branch.startsWith("orbit/")) return null
        val rest = branch.removePrefix("orbit/")
        if (rest.length < 8) return null
        val hash = rest.takeLast(7)
        if (hash[0] != '-' || !hash.drop(1).all { it in "0123456789abcdef" }) return null
        val slug = rest.dropLast(7).ifEmpty { return null }
        return Triple("orbit/", slug, hash)
    }

    /** A06-8 (iOS 621e62f0b): a coordinator's work lands on its project's integration line, so that is the branch it shows. */
    fun displayBranch(detail: JsonObject, branch: String): String {
        val role = (detail["projectMembership"] as? JsonObject)?.string("role")
        return if (role == "COORDINATOR") detail.string("projectIntegrationRef")?.ifEmpty { null } ?: branch else branch
    }

    /** The merge button's target: the server-resolved one (an explicit choice, the project's line, the default), then the local default. */
    fun mergeTarget(detail: JsonObject): String? {
        val targets = (detail["mergeTargets"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
        return detail.string("mergeTarget")?.ifEmpty { null } ?: defaultTarget(targets, (detail["agent"] as? JsonObject)?.string("defaultMergeTarget"))
    }

    private fun trimmed(value: String?) = value?.trim()?.ifEmpty { null }
}

/**
 * The words of the notice for a session without a worktree, of its Initialize git… confirmation and of its actions' toasts: web's
 * `SharedFolderNotice` and `InitializeGitSteps`, and `WorkspaceView`'s `askEnableIsolation`, `enableIsoMut` and `keepSharedMut`,
 * word for word (SharedFolderCopyParityTest).
 */
internal object SharedFolderCopy {
    /** The headline either side of its folder, which the view sets in monospace; an unknown folder is said in words. */
    fun headline(notice: WorktreeBarLogic.SharedFolder, path: String?): Triple<String, String, String> =
        if (notice == WorktreeBarLogic.SharedFolder.NO_BRANCH) Triple("⚠ No branch for this session: it edits ", path ?: "the folder", " directly")
        else Triple("⚠ ", path ?: "This folder", " isn’t a git repository")

    const val NOT_GIT_DETAIL = "Sessions here edit the folder directly: no branch or diff to review, and sessions running at the same time" +
        " can overwrite each other’s changes."
    const val NO_BRANCH_DETAIL = "The folder is a git repository, but git couldn’t add a worktree for this session. A repository with no" +
        " commits has nothing to branch from."
    const val INITIALIZE = "Initialize git…"
    /** The ✕ aloud: on a folder that is not a repository it turns worktree isolation off for the workspace; on a repository, it only hides. */
    const val KEEP_PLAIN = "Keep it as a plain folder"
    const val HIDE_HERE = "Hide for this session"

    const val CONFIRM_TITLE = "Initialize git in this folder?"
    const val CONFIRM = "Initialize git"
    fun confirmLead(workspace: String?) = "When the next session starts in ${workspace?.let { "“$it”" } ?: "this workspace"}, Orbit will:"
    /** The runner's `initGitRepo`, step by step. */
    val confirmSteps = listOf("run git init", "add a .gitignore for dependencies, build output and .env files, unless the folder has one",
        "commit the existing files as “orbit: baseline”. Nothing is pushed anywhere.")
    const val CONFIRM_AFTER = "Each new session then works on its own branch, with a diff you review and merge. This session keeps editing" +
        " the folder directly."

    const val GIT_QUEUED = "Git will be set up when the next session starts"
    const val GIT_FAILED = "Couldn't turn on git setup"
    fun isolationOff(workspace: String?) = "Worktree isolation is off for ${workspace?.let { "“$it”" } ?: "this workspace"}"
    const val ISOLATION_OFF_DETAIL = "Its sessions keep editing the folder directly, without this notice. Turn it back on in the workspace’s settings."
    const val UNDO = "Turn worktree isolation back on"
    const val OFF_FAILED = "Couldn't turn off worktree isolation"
    const val ON_FAILED = "Couldn't turn worktree isolation back on"
}

/** Why a current-worktree file can't be shown, and whether trying again can help (OrbitKit `WorktreeFileFailure`). */
internal data class WorktreeFileFailure(val title: String, val detail: String, val canRetry: Boolean) {
    companion object {
        val deleted = WorktreeFileFailure("File deleted", "This file is no longer in the current worktree.", false)
        val invalidImage = WorktreeFileFailure("Couldn't preview image", "The image may be incomplete or damaged. Try reading the file again.", true)
        private val timedOut = WorktreeFileFailure("File request timed out", "The runner did not return this file in time. Try again.", true)

        fun from(error: Throwable): WorktreeFileFailure = when ((error as? io.orbitd.android.core.net.ApiError)?.status) {
            404 -> WorktreeFileFailure("File not found", "The file may have moved or been removed from the current worktree.", true)
            413 -> WorktreeFileFailure("File too large", "This file exceeds the download limit. Open it on the runner instead.", false)
            503 -> WorktreeFileFailure("Runner unavailable", "The runner is offline or cannot read this file right now. Try again when it is connected.", true)
            504 -> timedOut
            400, 403 -> WorktreeFileFailure("File unavailable", failureReason(error), false)
            else -> if (error is java.net.SocketTimeoutException || error.cause is java.net.SocketTimeoutException) timedOut
                else WorktreeFileFailure("Couldn't load file", failureReason(error), true)
        }

        /** The server's own words when it gave some, else what kind of failure it was (iOS `APIClient.failureReason`). */
        fun failureReason(error: Throwable): String = when (error) {
            is io.orbitd.android.core.net.ApiError -> error.messages.joinToString("\n").ifEmpty { null }
                ?: if (error.status == 401) "you're signed out" else "the server returned ${error.status}"
            is io.orbitd.android.core.net.NetworkException -> "the connection dropped"
            else -> "the server's reply couldn't be read"
        }
    }
}
