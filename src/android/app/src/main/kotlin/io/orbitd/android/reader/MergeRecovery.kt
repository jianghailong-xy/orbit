package io.orbitd.android.reader

import io.orbitd.android.tasks.TaskTime
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * A merge held for target recovery (OrbitKit `MergeRecovery`, @orbit/shared `mergeRecovery.ts`): the target
 * moved or diverged on origin, so the runner previews a synchronized candidate, and the owner reviews it
 * before anything is pushed. Steps, titles and gates are web's `MergeRecoveryPanel`'s; with a repair session
 * at work, the states and steps of the repair loop's board (docs/mocks/merge-recovery-repair-loop-ios.html).
 */
internal data class MergeRecovery(
    val code: String, val targetBranch: String, val repoRoot: String? = null, val previewId: String? = null,
    val sourceSha: String? = null, val localSha: String? = null, val remoteSha: String? = null, val candidateSha: String? = null,
    val candidateTreeSha: String? = null, val repairBranch: String? = null, val repairWorktree: String? = null,
    val phase: String? = null, val conflicts: List<String>? = null, val localCommits: List<Commit>? = null,
    val remoteCommits: List<Commit>? = null, val pushCommits: List<Commit>? = null, val patch: String? = null,
    val addsMergeCommit: Boolean? = null, val checkedAt: String? = null, val check: Check? = null,
    val landedCommits: List<Commit>? = null,
) {
    /** [sourceSha]: a landed commit's — the commit of this session it carries onto origin. */
    data class Commit(val sha: String, val subject: String, val author: String, val date: String, val merge: Boolean? = null,
        val sourceSha: String? = null)
    data class Check(val status: String, val output: String? = null, val command: String? = null)
    enum class Origin(val label: String) { LOCAL_ONLY("Local-only"), MERGE("Merge commit"), SESSION("This session") }

    /** One step of the review. `preparePR` is set for the repair-session steps; `open` opens the repair at work, `wait` waits for its check. */
    data class Button(val title: String, val action: String, val preparePR: Boolean? = null)
    /** [note]: what happens next, under the steps. */
    data class Buttons(val primary: Button?, val secondary: List<Button>, val headerCheck: Button?, val note: String? = null)

    /** The repair session working on a recovery: the detail's `mergeRepairSession`, the newest one not in Trash. */
    data class Repair(val id: String?, val title: String?, val runState: String?, val error: String?,
        /** When its last turn ended, or it finished; what it last said, clipped. Older servers send neither. */
        val stoppedAt: String?, val lastAssistantText: String?) {
        val running: Boolean get() = runState in setOf("PENDING", "QUEUED", "RUNNING")
    }

    /**
     * The repair row's six states on the board; FINISHED, a stopped repair with no verdict of theirs to show — the check on screen
     * predates its stop, or found something else; and COMPLETED, the row a server that does not check repairs by itself gets.
     */
    enum class RepairState { RUNNING, CHECKING, READY, CONFLICTS, NEEDS_REPLY, FAILED, FINISHED, COMPLETED }
    data class RepairRow(val state: RepairState, val headline: String, val line: String?)
    /** The review of the repair loop: the repair row, whether the server is checking what the repair left — "Checking the repair…"
     *  under the title, the snapshot faded — and the steps. */
    data class Review(val row: RepairRow?, val checking: Boolean, val buttons: Buttons)

    val ready: Boolean get() = code == "READY" && !previewId.isNullOrEmpty() && patch != null && check?.status in setOf("passed", "unconfigured") &&
        listOf(sourceSha, localSha, remoteSha, candidateSha, candidateTreeSha).all { isSha(it) }

    /** Whether Done may close this recovery (@orbit/shared `mergeRecoveryConfirmable`): a check that found every commit of this session on origin. */
    val confirmable: Boolean get() = code == "ALREADY_LANDED" && !previewId.isNullOrEmpty() && isSha(sourceSha)

    val title: String get() = when {
        code == "LOCAL_SYNC_PENDING" -> "Merged into origin/$targetBranch; local sync pending"
        ready -> "Review synchronization into $targetBranch"
        code == "CONFLICT" -> if (phase == "TARGET_SYNC") "$targetBranch synchronization has conflicts" else "Your changes conflict with the synchronized target"
        code == "PREVIEW_CHANGED" -> "Branches changed — check again"
        code == "FETCH_FAILED" -> "Could not check the remote"
        code in setOf("PUSH_FAILED", "REMOTE_NOT_VERIFIED") -> "Could not confirm the target push"
        code == "REPAIR_IN_PROGRESS" -> "The repair isn’t finished"
        code == "ALREADY_LANDED" -> "Already on origin/$targetBranch"
        else -> "$targetBranch needs synchronization"
    }

    /** The sentence under the title, for the states that have one. */
    fun lede(zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault(), now: Instant = Instant.now()): String? {
        val t = targetBranch
        if (ready) return if (!pushCommits.isNullOrEmpty()) null else "Preserves both target histories." + if (addsMergeCommit == true) " Adds one merge commit." else ""
        return when (code) {
            "TARGET_DIVERGED" -> "Local $t and origin/$t each have unique commits."
            "TARGET_AHEAD" -> "Local $t has extra commits that are not on origin/$t. Review them before continuing this merge."
            "LOCAL_SYNC_PENDING" -> "The remote contains the reviewed candidate. Save blocking local edits before syncing; this action only updates this machine."
            "REPAIR_IN_PROGRESS" -> "Some files in the repair worktree are still unresolved."
            // The newest landed commit is when the last of this session's changes reached origin.
            "ALREADY_LANDED" -> (landedCommits?.firstOrNull()?.let { "This session’s changes reached origin/$t on ${day(it.date, zone, locale, now)}. " } ?: "") +
                "Nothing is left to merge."
            else -> null
        }
    }

    /** The files the check lists: what conflicts, or what a repair left unfinished still has unresolved. */
    val conflictsHeading: String get() = if (code == "REPAIR_IN_PROGRESS") "Still unresolved" else "Conflicts"

    /**
     * Board ④'s footnote, by the project's rule: a finished repair carried to a moved target keeps its branch, named for the check
     * that made it rather than this one, and only what conflicts with the new commits is listed. A carried repair can also meet a
     * fresh SOURCE_REPLAY conflict with nothing moved, so it is TARGET_SYNC's alone.
     */
    val movedAfterRepairNote: String? get() {
        if (code != "CONFLICT" || phase != "TARGET_SYNC" || repairBranch == null || previewId == null || repairBranch == "orbit/recovery/$previewId") return null
        return "origin/$targetBranch moved after the repair. The repair was kept; " +
            if (conflicts.orEmpty().size > 1) "only these files conflict with the new commits." else "only this file conflicts with the new commits."
    }

    /** ALREADY_LANDED, under the commits on origin: they carry copies of this session's, so its branch was rewritten after they merged. */
    val landedNote: String? get() = landedCommits.orEmpty().takeIf { commits -> commits.any { it.sha != it.sourceSha } }?.let {
        "Matched by content — this branch was rewritten after ${if (it.size == 1) "it" else "these"} merged."
    }

    /** ALREADY_LANDED, under the branches: the local target's own commits, which are not this session's to push. */
    val localNote: String? get() = localCommits?.size?.takeIf { it > 0 }?.let { n ->
        "Local $targetBranch’s own $n ${if (n == 1) "commit isn’t" else "commits aren’t"} part of this session."
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

    /**
     * The repair row. [loop]: the server checks the recovery again after every repair turn (S1); without it the row says what
     * it said before. [checking]: that check is in flight, or owed until this session's own turn ends ([Companion.checking]).
     */
    fun repairRow(repair: Repair, loop: Boolean, checking: Boolean, now: Instant = Instant.now()): RepairRow {
        val finished = "Repair session finished"
        fun ago(iso: String) = TaskTime.relative(iso, now) ?: iso
        // Only a check made after the repair stopped speaks for what the repair did.
        val stopped = TaskTime.parse(repair.stoppedAt)
        val checked = checkedAt?.takeIf { stopped != null && TaskTime.parse(it)?.isBefore(stopped) == false }?.let(::ago)
        val asked = repair.stoppedAt?.let(::ago)
        return when {
            repair.running -> RepairRow(RepairState.RUNNING, "Repair session running", "Tap to open the running session")
            repair.runState == "FAILED" -> RepairRow(RepairState.FAILED, "Repair session failed", repair.error?.trim()?.ifEmpty { null }?.takeIf { loop })
            !loop -> RepairRow(RepairState.COMPLETED, "Repair session completed", "Ready to check again")
            checking -> RepairRow(RepairState.CHECKING, finished, "Checking its result…")
            checked == null -> RepairRow(RepairState.FINISHED, finished, null)
            // The check found the repair unfinished: it stopped to ask, and what it asked is its last word.
            code == "REPAIR_IN_PROGRESS" -> RepairRow(RepairState.NEEDS_REPLY, "Repair session needs your reply",
                repair.lastAssistantText?.trim()?.replace(Regex("\\s+"), " ")?.ifEmpty { null }?.let { "“$it” · $asked" })
            ready -> RepairRow(RepairState.READY, finished, "Checked $checked — ready to merge")
            code == "CONFLICT" -> conflicts.orEmpty().size.let { n ->
                RepairRow(RepairState.CONFLICTS, finished, "Checked $checked — $n ${if (n == 1) "conflict" else "conflicts"} left") }
            else -> RepairRow(RepairState.FINISHED, finished, "Checked $checked")
        }
    }

    /**
     * The review for [detail], the session this recovery belongs to. A server that checks each repair turn by itself (S1) gets the
     * loop's row and steps; an older one, or an older runner, the review as it was. With every commit on origin there is no repair
     * row (board ⑥). While the server checks what a repair left, and no repair turn runs again, the one step is to wait — whatever
     * the row says: a failed repair's row keeps saying it failed.
     */
    fun review(detail: JsonObject, now: Instant = Instant.now()): Review {
        val supported = (detail["mergeRecoverySupported"] as? JsonPrimitive)?.booleanOrNull == true
        val loop = supported && followsRepairs(detail)
        val session = repair(detail)?.takeIf { code != "ALREADY_LANDED" }
        val row = session?.let { repairRow(it, loop, checking(detail), now) }
        val waiting = loop && session != null && !session.running && checking(detail)
        return Review(row, waiting, buttons(supported, row?.state?.takeIf { loop }, waiting))
    }

    /**
     * The review's steps, arranged around the one the state asks for. An older runner can't recover, so it gets none. [repair]:
     * the repair row's state while the server checks each repair turn by itself — the board's steps; null keeps the steps as they were.
     * [checking]: the server is checking what the repair left, whatever the row says.
     */
    fun buttons(supported: Boolean, repair: RepairState? = null, checking: Boolean = false): Buttons {
        if (!supported) return Buttons(null, emptyList(), null)
        if (code == "LOCAL_SYNC_PENDING") return Buttons(Button("Sync local checkout", "sync-local"), emptyList(), null)
        // Nothing to press until the server has said what the repair did.
        if (checking || repair == RepairState.CHECKING) return Buttons(Button("Checking…", "wait"), emptyList(), null)
        // Every commit is on origin already: Done records the session merged and clears the recovery (confirm-landed).
        if (confirmable) return Buttons(Button("Done", "confirm-landed"), emptyList(), null)
        // A check now could only find the repair unfinished; the one step is to look at it.
        if (repair == RepairState.RUNNING) return Buttons(Button("Open repair session", "open"), emptyList(), null,
            "Orbit checks again when the repair stops.")
        val check = Button(if (previewId == null) "Check and repair" else "Check again", "preview")
        // With a repair session in the loop, the same session carries on (S2) — but a failed one is replaced by a new one.
        val resolve = Button(if (repair == null || repair == RepairState.FAILED) "Resolve in repair session" else "Continue repair", "repair", preparePR = false)
        val preparePR = Button("Prepare PR candidate", "repair", preparePR = true)
        val repairs = if (repairWorktree == null) emptyList() else if (ready) listOf(preparePR) else listOf(resolve, preparePR)
        return when {
            ready -> Buttons(Button("Sync $targetBranch and merge", "apply"), repairs, check)
            code in setOf("PUSH_FAILED", "REMOTE_NOT_VERIFIED") -> Buttons(Button("Check result / retry reviewed candidate", "apply"), repairs, check)
            // A repair left unfinished: the owner answers the session that stopped, or a new one takes over from the failed one.
            code == "REPAIR_IN_PROGRESS" && repair != null ->
                Buttons(if (repair == RepairState.FAILED) resolve else Button("Reply in repair session", "repair", preparePR = false), emptyList(), check)
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
            fun commits(key: String, landed: Boolean = false): List<Commit>? = (value[key] as? JsonArray)?.map { element ->
                val c = element as? JsonObject ?: return null
                fun field(name: String) = (c[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
                Commit(field("sha") ?: return null, field("subject") ?: return null, field("author") ?: return null, field("date") ?: return null,
                    (c["merge"] as? JsonPrimitive)?.booleanOrNull, if (landed) field("sourceSha") ?: return null else null)
            }
            val check = (value["check"] as? JsonObject)?.let { c ->
                val status = (c["status"] as? JsonPrimitive)?.contentOrNull?.takeIf { it in setOf("passed", "failed", "unconfigured") } ?: return null
                Check(status, (c["output"] as? JsonPrimitive)?.contentOrNull, (c["command"] as? JsonPrimitive)?.contentOrNull)
            }
            return MergeRecovery(str("code") ?: return null, str("targetBranch") ?: return null, str("repoRoot"), str("previewId"),
                str("sourceSha"), str("localSha"), str("remoteSha"), str("candidateSha"), str("candidateTreeSha"), str("repairBranch"),
                str("repairWorktree"), str("phase"), (value["conflicts"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
                commits("localCommits"), commits("remoteCommits"), commits("pushCommits"), str("patch"),
                (value["addsMergeCommit"] as? JsonPrimitive)?.booleanOrNull, str("checkedAt"), check, commits("landedCommits", landed = true))
        }

        /** The session detail's repair session, if it has one. */
        fun repair(detail: JsonObject): Repair? = (detail["mergeRepairSession"] as? JsonObject)?.let { s ->
            Repair(s.string("id"), s.string("title"), s.string("runState") ?: s.string("runStatus"), s.string("error"),
                s.string("lastTurnAt") ?: s.string("finishedAt"), s.string("lastAssistantText"))
        }

        /** Whether the server checks the recovery again after each repair turn (S1): it sends the column that check is owed in. */
        fun followsRepairs(detail: JsonObject): Boolean = "mergeRepairTurnEndedAt" in detail

        /** The project's rule for "checking": a check in flight, or one a repair turn left owed until this session's own turn ends. */
        fun checking(detail: JsonObject): Boolean =
            detail.string("mergeStatus") == "pending" && detail.string("mergeRecoveryAction") == "preview" || detail.string("mergeRepairTurnEndedAt") != null

        /** A commit's day as the review writes it ("Oct 11", with the year when it is not this one), in the reader's zone; the date as sent
         *  when it does not parse. */
        fun day(iso: String, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault(), now: Instant = Instant.now()): String =
            runCatching {
                val date = OffsetDateTime.parse(iso).atZoneSameInstant(zone)
                DateTimeFormatter.ofPattern(if (date.year == now.atZone(zone).year) "MMM d" else "MMM d, yyyy", locale).format(date)
            }.getOrDefault(iso)

        private fun isSha(sha: String?) = sha != null && sha.length == 40 && sha.all { it in "0123456789abcdef" }
    }
}
