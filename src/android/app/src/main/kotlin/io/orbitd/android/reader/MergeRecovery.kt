package io.orbitd.android.reader

import kotlinx.serialization.json.*

/**
 * A merge held for target recovery (OrbitKit `MergeRecovery`, @orbit/shared `mergeRecovery.ts`): the target
 * moved or diverged on origin, so the runner previews a synchronized candidate, and the owner reviews it
 * before anything is pushed. Steps, titles and gates are web's `MergeRecoveryPanel`'s.
 */
internal data class MergeRecovery(
    val code: String, val targetBranch: String, val repoRoot: String? = null, val previewId: String? = null,
    val sourceSha: String? = null, val localSha: String? = null, val remoteSha: String? = null, val candidateSha: String? = null,
    val candidateTreeSha: String? = null, val repairBranch: String? = null, val repairWorktree: String? = null,
    val phase: String? = null, val conflicts: List<String>? = null, val localCommits: List<Commit>? = null,
    val remoteCommits: List<Commit>? = null, val pushCommits: List<Commit>? = null, val patch: String? = null,
    val addsMergeCommit: Boolean? = null, val checkedAt: String? = null, val check: Check? = null,
) {
    data class Commit(val sha: String, val subject: String, val author: String, val date: String, val merge: Boolean? = null)
    data class Check(val status: String, val output: String? = null, val command: String? = null)
    enum class Origin(val label: String) { LOCAL_ONLY("Local-only"), MERGE("Merge commit"), SESSION("This session") }

    /** One step of the review. `preparePR` is set for the two repair-session steps. */
    data class Button(val title: String, val action: String, val preparePR: Boolean? = null)
    data class Buttons(val primary: Button?, val secondary: List<Button>, val headerCheck: Button?)

    val ready: Boolean get() {
        val shas = listOfNotNull(sourceSha, localSha, remoteSha, candidateSha, candidateTreeSha)
        return code == "READY" && !previewId.isNullOrEmpty() && patch != null && check?.status in setOf("passed", "unconfigured") &&
            shas.size == 5 && shas.all { sha -> sha.length == 40 && sha.all { it in "0123456789abcdef" } }
    }

    val title: String get() = when {
        code == "LOCAL_SYNC_PENDING" -> "Merged into origin/$targetBranch; local sync pending"
        ready -> "Review synchronization into $targetBranch"
        code == "CONFLICT" -> if (phase == "TARGET_SYNC") "$targetBranch synchronization has conflicts" else "Your changes conflict with the synchronized target"
        code == "PREVIEW_CHANGED" -> "Branches changed — check again"
        code == "FETCH_FAILED" -> "Could not check the remote"
        code in setOf("PUSH_FAILED", "REMOTE_NOT_VERIFIED") -> "Could not confirm the target push"
        else -> "$targetBranch needs synchronization"
    }

    /** Local-only first: an unpublished local merge is still unpublished. */
    fun origin(commit: Commit): Origin = when {
        localCommits?.any { it.sha == commit.sha } == true -> Origin.LOCAL_ONLY
        commit.merge == true -> Origin.MERGE
        else -> Origin.SESSION
    }

    /** Every local-only and merge commit the push adds, and this session's first few; the rest wait behind one row. */
    fun inlinePushCommits(sessionLimit: Int = 5): Pair<List<Commit>, Int> {
        var sessions = 0
        val all = pushCommits.orEmpty()
        val shown = all.filter { origin(it) != Origin.SESSION || ++sessions <= sessionLimit }
        return shown to all.size - shown.size
    }

    /** Local target against origin/target, once a check has listed both sides. */
    val targetRelation: String? get() {
        val local = localSha ?: return null
        val remote = remoteSha ?: return null
        if (local != remote && localCommits == null && remoteCommits == null) return null
        val t = targetBranch
        val ahead = if (local == remote) 0 else localCommits?.size ?: 0
        val behind = if (local == remote) 0 else remoteCommits?.size ?: 0
        return when {
            ahead == 0 && behind == 0 -> "Local $t matches origin/$t"
            behind == 0 -> "Local $t is $ahead ahead of origin/$t"
            ahead == 0 -> "Local $t is $behind behind origin/$t"
            else -> "Local $t: $ahead ahead, $behind behind origin/$t"
        }
    }

    /** How the push lands, under the commits it adds. */
    val landingNote: String get() {
        val local = localCommits?.size ?: 0
        return (if (addsMergeCommit == true) "A merge commit joins both histories; nothing already on origin/$targetBranch is rewritten."
            else "Fast-forward push: nothing already on origin/$targetBranch is rewritten.") +
            (if (local == 0) "" else " Includes $local local-only ${if (local == 1) "commit that was" else "commits that were"} never pushed.")
    }

    /** What the check proved and, for a ready candidate, the way to a PR. */
    val reviewNote: String? get() {
        val parts = mutableListOf<String>()
        check?.let { parts += when (it.status) { "unconfigured" -> "Git preview only; no merge check is configured."
            "passed" -> "Configured merge check passed."; else -> "Configured merge check failed." } }
        if (ready) {
            if (pushCommits.isNullOrEmpty() && !localCommits.isNullOrEmpty()) parts += "The local-only commits above will be pushed with this session’s changes."
            parts += "For linear history or required PRs, prepare a PR candidate instead."
        }
        return parts.ifEmpty { null }?.joinToString(" ")
    }

    /** The review's steps, arranged around the one the state asks for. An older runner can't recover, so it gets none. */
    fun buttons(supported: Boolean): Buttons {
        if (!supported) return Buttons(null, emptyList(), null)
        if (code == "LOCAL_SYNC_PENDING") return Buttons(Button("Sync local checkout", "sync-local"), emptyList(), null)
        val check = Button(if (previewId == null) "Check and repair" else "Check again", "preview")
        val resolve = Button("Resolve in repair session", "repair", preparePR = false)
        val preparePR = Button("Prepare PR candidate", "repair", preparePR = true)
        val repairs = if (repairWorktree == null) emptyList() else if (ready) listOf(preparePR) else listOf(resolve, preparePR)
        return when {
            ready -> Buttons(Button("Sync $targetBranch and merge", "apply"), repairs, check)
            code in setOf("PUSH_FAILED", "REMOTE_NOT_VERIFIED") -> Buttons(Button("Check result / retry reviewed candidate", "apply"), repairs, check)
            code == "CONFLICT" && repairWorktree != null -> Buttons(resolve, listOf(preparePR), check)
            else -> Buttons(check, repairs, null)
        }
    }

    companion object {
        /** Null for anything @orbit/shared `readMergeRecovery` would refuse. */
        fun of(value: JsonObject): MergeRecovery? {
            fun str(key: String): String? = (value[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
            for (key in listOf("repoRoot", "previewId", "sourceSha", "localSha", "remoteSha", "candidateSha", "candidateTreeSha",
                    "rebaseBaseSha", "repairBranch", "repairWorktree", "phase", "patch", "checkedAt"))
                if (value[key] != null && value[key] !is JsonNull && str(key) == null) return null
            fun commits(key: String): List<Commit>? = (value[key] as? JsonArray)?.map { element ->
                val c = element as? JsonObject ?: return null
                fun field(name: String) = (c[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
                Commit(field("sha") ?: return null, field("subject") ?: return null, field("author") ?: return null, field("date") ?: return null,
                    (c["merge"] as? JsonPrimitive)?.booleanOrNull)
            }
            val check = (value["check"] as? JsonObject)?.let { c ->
                val status = (c["status"] as? JsonPrimitive)?.contentOrNull?.takeIf { it in setOf("passed", "failed", "unconfigured") } ?: return null
                Check(status, (c["output"] as? JsonPrimitive)?.contentOrNull, (c["command"] as? JsonPrimitive)?.contentOrNull)
            }
            return MergeRecovery(str("code") ?: return null, str("targetBranch") ?: return null, str("repoRoot"), str("previewId"),
                str("sourceSha"), str("localSha"), str("remoteSha"), str("candidateSha"), str("candidateTreeSha"), str("repairBranch"),
                str("repairWorktree"), str("phase"), (value["conflicts"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
                commits("localCommits"), commits("remoteCommits"), commits("pushCommits"), str("patch"),
                (value["addsMergeCommit"] as? JsonPrimitive)?.booleanOrNull, str("checkedAt"), check)
        }
    }
}
