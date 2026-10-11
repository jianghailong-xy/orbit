package io.orbitd.android.core.cards

import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/** Which of the merge card's four states a candidate is in (OrbitKit `PromotionStage`, mock 4, §7.5). */
enum class PromotionStage {
    /** A: checks passed, waiting for the owner. */
    ASKING_YOU,
    /** B: confirmed, and landing on its own — possibly re-checking because the upstream moved. */
    MERGING,
    /** C: merged. The card becomes the receipt. */
    MERGED,
    /** D: it cannot merge yet. */
    BLOCKED,
}

/** Who holds a blocked candidate, off the project's open items (OrbitKit `PromotionCards.holder`): [Unread] until the read has come
 * back, the [Open] item that names this candidate, or [Gone] — nobody — when the read came back without one. */
sealed interface PromotionHolder {
    data object Unread : PromotionHolder
    data class Open(val row: JsonObject) : PromotionHolder
    data object Gone : PromotionHolder
}

/** How the coordinator conversation's one line for a merge is drawn: orange only while it waits on the reader. */
enum class PromotionTone { NEEDS_YOU, WORKING, BLOCKED, QUIET }

/** One merge already made, as a record: the merge's own row and the moment it happened (OrbitKit `PromotionCards.Receipt`). A row
 * with no `merged.at` is a candidate on offer, not a record, and is never one. */
data class PromotionReceipt(val promotion: JsonObject, val moment: String) {
    val id: String get() = "merge:${promotion.text("promotionId").orEmpty()}"
}

/**
 * The merge into main as OrbitKit's `PromotionCards` words it (iOS 6b4bef713, 39adc7561, dbab6fc5b; the blocked card as main's
 * 8297b18a3 corrected it): the project sessions page's card, the coordinator conversation's one line, the review both open, and the
 * receipt a merge leaves. Pure functions over the server's promotion view (`GET /projects/:id/promotions/current` and `/merged`).
 *
 * While it merges, what the card says follows the candidate's own job (`execution`) — queued, confirmed and waiting for it,
 * re-checking the combined tree, or the step it has reached — and Cancel goes dead once the job is pushing, which the server refuses
 * to call back.
 */
object PromotionCards {
    const val mergeToMain = "Merge to main"
    /** The press, said of the branch the merge goes into — [mergeToMain] for a project on main (web's `mergeTo`). */
    fun mergeTo(main: String) = "Merge to $main"
    const val notNow = "Not now"
    const val merging = "Merging…"
    const val cancel = "Cancel"
    const val openCoordinator = "Open coordinator"
    /** §7.5's provenance mark. */
    const val provenance = "FROM ORBIT"
    const val mergedHeading = "✓ Merged into main"
    fun mergedHeading(main: String) = "✓ Merged into $main"
    /** C's heading when nobody pressed Merge: the receipt is the only place the owner learns the Automatic setting merged it. */
    const val mergedAutomaticallyHeading = "✓ Merged into main automatically"
    fun mergedAutomaticallyHeading(main: String) = "✓ Merged into $main automatically"
    /** The receipt's row of what the merge put on the branch it went into: "Now on main". */
    fun nowOn(main: String) = "Now on $main"
    /** Who merged it, where a pressed merge says "by you". */
    const val underAutomatic = "under your Automatic setting"
    /** What a merge the read no longer publishes says about itself, rather than vanishing. */
    const val supersededTitle = "This merge is no longer on offer"
    const val superseded = "A newer candidate replaced it, or it was answered somewhere else. The next one comes back here as its own card."
    /** B's `You` row in the review, verbatim from mock 4: the whole point is that the reader may walk away. */
    const val nothingToDo = "nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t"
    /** D's press, which reads rather than acts: who has the branch. */
    const val resolving = "Coordinator is resolving it"
    /** The same press once the clock has handed the item to the reader. */
    const val itIsYours = "It is yours"
    /** The trailing word on the conversation's line while the candidate is asking. */
    const val review = "Review"
    /** The page card's badge while it asks. */
    const val needsYouBadge = "Needs you"
    /** The page card's way into the full review. */
    const val details = "Details"
    /** B's sentence on the page card, where it stands alone rather than as the `You` row's value. */
    const val pageNothingToDo = "Nothing to do — it lands on its own if the re-check passes, and comes back here if it doesn’t."

    /** `refs/heads/x` and `x` are the same branch. */
    fun shortRef(ref: String) = ref.removePrefix("refs/heads/")
    /** Confirmed, or re-checking before it merges: the card's merging stage. */
    fun isMerging(view: JsonObject) = view.text("state") in setOf("CONFIRMED", "RECHECKING")
    private fun job(view: JsonObject) = view.obj("execution")
    private fun into(view: JsonObject) = shortRef(view.text("upstreamRef") ?: "main")
    /** The branch a candidate merges into, as every sentence about it names it: its `upstreamRef`, short; main when it says none. */
    fun mainBranch(view: JsonObject) = into(view)
    private fun branch(view: JsonObject) = shortRef(view.text("sourceRef").orEmpty())
    private fun merged(view: JsonObject) = view.obj("merged")
    private fun automatic(view: JsonObject) = (merged(view)?.get("automatic") as? JsonPrimitive)?.booleanOrNull == true
    private fun plural(n: Int, one: String) = "$n $one${if (n == 1) "" else "s"}"

    /** Which card to draw, or null while there is nothing to say: a candidate still being checked is not a question yet, and one
     * that was declined, cancelled or superseded is not one any more. */
    fun stage(view: JsonObject?): PromotionStage? = when (view?.text("state")) {
        "READY" -> PromotionStage.ASKING_YOU
        "CONFIRMED", "RECHECKING" -> PromotionStage.MERGING
        "MERGED" -> PromotionStage.MERGED
        "BLOCKED" -> PromotionStage.BLOCKED
        else -> null
    }

    /** Only a READY candidate may be confirmed (§3.3). */
    fun confirmable(view: JsonObject?) = view?.text("state") == "READY"

    /** The heading while it merges: "Merge queued: project/x into main", "Re-checking project/x before merging into main…". */
    fun mergingTitle(view: JsonObject): String {
        val branch = branch(view)
        val job = job(view)
        if (job?.text("state") == "QUEUED") return "Merge queued: $branch into ${into(view)}"
        if (job?.text("state") != "RUNNING") return "Merge confirmed: $branch into ${into(view)}"
        if (job.text("phase") == "CHECK") return "Re-checking $branch before merging into ${into(view)}…"
        return "Merging $branch into ${into(view)}…"
    }

    /** The card's heading, per state — the receipt's title once it has merged. */
    fun title(view: JsonObject): String = when (stage(view)) {
        PromotionStage.MERGING -> mergingTitle(view)
        PromotionStage.MERGED -> if (automatic(view)) mergedAutomaticallyHeading(into(view)) else mergedHeading(into(view))
        PromotionStage.BLOCKED -> "${branch(view)} can’t merge into ${into(view)} yet"
        else -> "Merge ${branch(view)} into ${into(view)}?"
    }

    /** The review's title: the branch has its own row, outside the heading. */
    fun previewTitle(view: JsonObject?): String {
        view ?: return supersededTitle
        return when (stage(view)) {
            PromotionStage.ASKING_YOU -> "Merge to ${into(view)}"
            PromotionStage.MERGING -> "${mergingActionLabel(view)} · ${into(view)}"
            PromotionStage.BLOCKED -> "Merge to ${into(view)} blocked"
            PromotionStage.MERGED -> title(view)
            null -> supersededTitle
        }
    }

    /** Whether one check passed: the exit code it declared, and not a timeout (OrbitKit `IntegrationCheckResult.passed`). */
    fun passed(check: JsonObject): Boolean {
        val exit = (check["exitCode"] as? JsonPrimitive)?.intOrNull
        return !check.flag("timedOut") && exit != null && exit == ((check["expectedExitCode"] as? JsonPrimitive)?.intOrNull ?: 0)
    }

    /** Every recorded check contributes to the verdict. */
    fun previewChecks(view: JsonObject): String {
        val checks = view.objects("checks")
        if (checks.isEmpty()) return "No checks recorded"
        if (checks.any { it.flag("timedOut") }) return "Checks timed out"
        return if (checks.all(::passed)) "✓ Checks passed" else "✕ Checks failed"
    }

    /** Whether the asking card's checks row is the green one: every check passed and nothing conflicts. */
    fun checksClean(view: JsonObject) = view.objects("checks").let { it.isNotEmpty() && it.all(::passed) } && view.strings("conflicts").isEmpty()

    /** `project/bg-jobs · 7 commits ahead of main` — mock 4's Branch row. */
    fun branchLine(view: JsonObject): String {
        val ahead = view.number("commitsAhead") ?: return branch(view)
        return "${branch(view)} · ${plural(ahead, "commit")} ahead of ${into(view)}"
    }

    /** `4 landed on the branch` — how much this merge would carry. */
    fun tasksLine(view: JsonObject) = "${view.strings("taskIds").size} landed on the branch"

    /** `✓ Passed on the combined tree · <command> · 6m 12s`, or what failed instead. */
    fun checksLine(view: JsonObject): String {
        val checks = view.objects("checks")
        if (checks.isEmpty()) return "no checks recorded"
        return checks.joinToString("\n\n") { check ->
            val elapsed = check.number("durationMs")?.let { " · ${duration(it)}" }.orEmpty()
            val verdict = when {
                passed(check) -> "✓ Passed on the combined tree"
                check.flag("timedOut") -> "✕ Timed out on the combined tree"
                else -> "✕ Failed on the combined tree"
            }
            "$verdict · ${check.text("command").orEmpty()}$elapsed"
        }
    }

    /** The upstream row: whether this candidate conflicts with it. `no conflicts` is the fact the owner is deciding on. */
    fun upstreamLine(view: JsonObject): String {
        val n = view.strings("conflicts").size
        return if (n > 0) "${plural(n, "file")} conflict with ${into(view)}" else "no conflicts"
    }

    /** `3 of 6 met on this branch — merging does not close the project`; null before the criteria were read. */
    fun criteriaLine(met: Int, total: Int): String? = if (total > 0) "$met of $total met on this branch — merging does not close the project" else null

    /** `exactly the tested tree 58f3a47 · as a merge commit` — what M-S3 promises. */
    fun landsLine(view: JsonObject): String {
        val how = if (view.text("landsAs") == "FAST_FORWARD") "as a fast-forward" else "as a merge commit"
        return "exactly the tested tree ${view.text("sourceSha").orEmpty().take(7)} · $how"
    }

    /** The status row: where the merge's own job stands, and nothing a running job has not said. */
    fun mergingStatusLine(view: JsonObject): String {
        val into = into(view)
        val job = job(view)
        if (job?.text("state") == "QUEUED") return "confirmed — queued to merge into $into"
        if (job?.text("state") != "RUNNING") return "confirmed — waiting for merge execution"
        return when (job.text("phase")) {
            "CHECK" -> if (view.text("state") == "RECHECKING") "$into moved since the check — re-checking the combined tree" else "re-checking the combined tree"
            "FETCH" -> "confirmed — fetching the branches"
            "MAIN_SYNC" -> "confirmed — syncing the branches"
            "REBASE" -> "confirmed — rebasing the branch"
            "MERGE" -> "confirmed — preparing the combined tree"
            "VERIFY" -> "confirmed — verifying the tested tree"
            "PUSH" -> "confirmed — publishing the tested tree to $into"
            else -> "confirmed — starting the merge"
        }
    }

    /** The label of the stage's dead press. */
    fun mergingActionLabel(view: JsonObject): String {
        val job = job(view)
        if (job?.text("state") == "QUEUED") return "Queued"
        if (job?.text("state") != "RUNNING") return "Confirmed"
        return if (job.text("phase") == "CHECK") "Re-checking…" else merging
    }

    /** A merge is called back only before its job pushes. */
    fun cancellable(view: JsonObject) = job(view)?.text("phase") != "PUSH"

    /** C's commit row: what landed, who merged it, and when. */
    fun mergedLine(view: JsonObject, now: Instant = Instant.now()): String {
        val merged = merged(view) ?: return "merged"
        val time = merged.text("at")?.let { elapsed(it, now) }?.let { " · $it" }.orEmpty()
        val who = if (automatic(view)) underAutomatic else "by you"
        return "${merged.text("sha").orEmpty().take(7)} · merge of ${branch(view)} · $who$time"
    }

    /** C's undo row, on a merge the Automatic setting made; null on a pressed merge. */
    fun revertLine(view: JsonObject): String? = if (automatic(view)) merged(view)?.text("revert") else null

    /** D's first row: why it cannot merge. The job's own reason comes first (`blockedReason`): a branch already on main and a job
     * that errored are blocked with no checks and no conflicts, which the arrays alone would read as a failed check. */
    fun blockedLine(view: JsonObject): String {
        if (view.text("blockedReason") == "ALREADY_LANDED") return "nothing to merge — ${branch(view)} is already on ${into(view)}"
        if (view.text("blockedReason") == "ERROR") return "the merge stopped on an error — no check failed"
        val conflicts = view.strings("conflicts")
        if (conflicts.isEmpty()) return "the checks on the combined tree did not pass"
        val more = if (conflicts.size > 3) " and ${conflicts.size - 3} more" else ""
        return "${plural(conflicts.size, "file")} conflict with ${into(view)}: ${conflicts.take(3).joinToString(", ")}$more"
    }

    /** D's reason in a few words, for a line too short for the files: `2 files conflict`, or `checks failed`. */
    fun blockedReason(view: JsonObject): String {
        if (view.text("blockedReason") == "ALREADY_LANDED") return "nothing to merge"
        if (view.text("blockedReason") == "ERROR") return "check errored"
        val n = view.strings("conflicts").size
        return if (n > 0) "${plural(n, "file")} conflict" else "checks failed"
    }

    /** Who holds a blocked candidate, off the project's open items (both groups). [PromotionHolder.Gone] is nobody: the coordinator
     * closed its item and nothing else holds the branch, so no press may name somebody who is not there. */
    fun holder(promotionId: String, items: JsonObject?): PromotionHolder {
        items ?: return PromotionHolder.Unread
        val row = (items.objects("needsYou") + items.objects("withCoordinator")).firstOrNull { it.text("promotionId") == promotionId }
        return row?.let(PromotionHolder::Open) ?: PromotionHolder.Gone
    }

    /** D's press as one line: `Coordinator is resolving it · 2h`, or `It is yours · waiting 2h` once the item is the reader's. An item
     * not read yet says who state D means and stops; nobody holding it draws no press at all (null). */
    fun resolvingLine(holder: PromotionHolder, now: Instant = Instant.now()): String? {
        val row = when (holder) { PromotionHolder.Gone -> return null; PromotionHolder.Unread -> null; is PromotionHolder.Open -> holder.row }
        val waited = row?.text("waitingSince")?.let(::parse)?.let { span(seconds(it, now)) }
        if (row?.text("assignee") != "OWNER") return resolving + (waited?.let { " · $it" }.orEmpty())
        return itIsYours + (waited?.let { " · waiting $it" }.orEmpty())
    }

    /** Whether the mark over that press turns: somebody else is working on the branch — never over the reader's own, nor nobody. */
    fun resolvingSpins(holder: PromotionHolder) = when (holder) {
        PromotionHolder.Gone -> false
        PromotionHolder.Unread -> true
        is PromotionHolder.Open -> holder.row.text("assignee") != "OWNER"
    }

    /** Whether that press is the reader's own: the item the clock handed them. */
    fun resolvingIsYours(holder: PromotionHolder) = holder is PromotionHolder.Open && holder.row.text("assignee") == "OWNER"

    /** `asked 2h 10m ago`, A's footnote. */
    fun askedLine(view: JsonObject, now: Instant = Instant.now()): String? = view.text("askedAt")?.let { ago(it, now) }?.let { "asked $it" }

    // The project's sessions page, and the conversation's one line (iOS 6b4bef713).

    /** The merge card's heading on the project's sessions page. The branch is the line under it. */
    fun pageTitle(view: JsonObject): String {
        val into = into(view)
        return when (stage(view)) {
            PromotionStage.ASKING_YOU -> "Merge into $into?"
            PromotionStage.MERGING -> {
                val job = job(view)
                when {
                    job?.text("state") == "QUEUED" -> "Merge into $into queued"
                    job?.text("state") != "RUNNING" -> "Merge into $into confirmed"
                    job.text("phase") == "CHECK" -> "Re-checking before merging into $into…"
                    else -> "Merging into $into…"
                }
            }
            PromotionStage.MERGED -> title(view)
            PromotionStage.BLOCKED -> "Can’t merge into $into yet"
            null -> supersededTitle
        }
    }

    /** `2 tasks · 10 files` — what the card carries, under the branch line that already says how many commits. */
    fun pageCounts(view: JsonObject): String {
        val files = view.number("filesChanged") ?: return taskCount(view)
        return "${taskCount(view)} · ${plural(files, "file")}"
    }

    /** The titles of the tasks a candidate carries, at most [limit], and how many more there are. A task the read did not name (a
     * server older than `tasks`) is still counted in `more`, so the card never says it carries less than it does. */
    fun taskTitles(view: JsonObject, limit: Int = 3): Pair<List<String>, Int> {
        val tasks = view.objects("tasks")
        val shown = tasks.take(maxOf(0, limit)).map { it.text("title").orEmpty() }
        return shown to maxOf(view.strings("taskIds").size, tasks.size) - shown.size
    }

    /** `+2 more`, under the titles — null when they were all named. */
    fun moreTasks(more: Int): String? = if (more > 0) "+$more more" else null

    /** Every task a merge carries by title, in the server's order: the review's and the receipt's rows. */
    fun allTaskTitles(view: JsonObject) = view.objects("tasks").map { it.text("title").orEmpty() }

    /** The coordinator conversation's one line for a candidate, in place of the card it used to draw there: the same states in the
     * same words as the page's card. A candidate the read no longer publishes is null, and says so. */
    fun eventLine(view: JsonObject?): Pair<String, PromotionTone> {
        view ?: return supersededTitle to PromotionTone.QUIET
        return when (stage(view)) {
            PromotionStage.ASKING_YOU -> "Merge into ${into(view)} is waiting for you" to PromotionTone.NEEDS_YOU
            PromotionStage.MERGING -> pageTitle(view) to PromotionTone.WORKING
            PromotionStage.BLOCKED -> "${pageTitle(view)} · ${blockedReason(view)}" to PromotionTone.BLOCKED
            PromotionStage.MERGED -> receiptLine(view) to PromotionTone.QUIET
            null -> supersededTitle to PromotionTone.QUIET
        }
    }

    /** The record's one line in the conversation: `✓ Merged into main · 8d5a868 · 2 tasks`, and ` · automatically` when nobody
     * pressed Merge. */
    fun receiptLine(view: JsonObject): String = buildList {
        add("✓ Merged into ${into(view)}")
        merged(view)?.text("sha")?.let { add(it.take(7)) }
        add(taskCount(view))
        if (automatic(view)) add("automatically")
    }.joinToString(" · ")

    /** The timeline row's heading on the sessions page. The check mark is the row's icon there. */
    fun timelineTitle(view: JsonObject) = "Merged into ${into(view)}"

    /** The timeline row's second line: `8d5a868 · 2 tasks · by you`, or `· automatically`. */
    fun timelineDetail(view: JsonObject): String =
        listOfNotNull(merged(view)?.text("sha")?.take(7), taskCount(view), if (automatic(view)) "automatically" else "by you").joinToString(" · ")

    /** The receipt's `Now on main` row. */
    fun nowOnMainLine(view: JsonObject) = taskCount(view)

    /** `5 commits · 10 files` — the receipt's size row, null when the read gave neither. */
    fun changesLine(view: JsonObject): String? = listOfNotNull(view.number("commitsAhead")?.let { plural(it, "commit") },
        view.number("filesChanged")?.let { plural(it, "file") }).takeIf { it.isNotEmpty() }?.joinToString(" · ")

    fun taskCount(view: JsonObject) = plural(view.strings("taskIds").size, "task")

    /** The merges a project has made, each with its moment — the timeline's rows and the conversation's records. */
    fun receipts(merged: List<JsonObject>): List<PromotionReceipt> =
        merged.mapNotNull { row -> row.obj("merged")?.text("at")?.let { PromotionReceipt(row, it) } }

    /** How long a check took, to the second: "48s", "6m 12s", "1h 4m". */
    fun duration(ms: Int): String {
        val total = maxOf(0, ms) / 1_000
        if (total < 60) return "${total}s"
        val minutes = total / 60; val seconds = total % 60
        if (minutes < 60) return if (seconds == 0) "${minutes}m" else "${minutes}m ${seconds}s"
        val hours = minutes / 60; val rest = minutes % 60
        return if (rest == 0) "${hours}h" else "${hours}h ${rest}m"
    }

    // OrbitKit `RelativeTime`, as the merge's sentences use it.
    private fun parse(iso: String): Instant? = runCatching { Instant.parse(iso) }.getOrNull()
    private fun seconds(from: Instant, to: Instant) = (to.toEpochMilli() - from.toEpochMilli()) / 1000.0
    /** "45s", "12m", "3h 20m", "23h", "2d 4h", "12d" — the web's `formatSpan`. */
    private fun span(seconds: Double): String {
        val s = maxOf(0.0, seconds)
        if (s < 60) return "${maxOf(1, s.toInt())}s"
        if (s < 3_600) return "${(s / 60).toInt()}m"
        if (s < 86_400) { val h = (s / 3_600).toInt(); val m = ((s % 3_600) / 60).toInt(); return if (h < 6 && m > 0) "${h}h ${m}m" else "${h}h" }
        val d = (s / 86_400).toInt(); val h = ((s % 86_400) / 3_600).toInt()
        return if (d < 3 && h > 0) "${d}d ${h}h" else "${d}d"
    }
    /** "just now" under ten seconds, "3h 20m ago" above it. */
    private fun ago(iso: String, now: Instant): String? = parse(iso)?.let { seconds(it, now) }?.let { if (it < 10) "just now" else "${span(it)} ago" }
    /** "8s", "12m", "2h", "3d" — how long something has been going. */
    private fun elapsed(iso: String, now: Instant): String? {
        val diff = maxOf(0.0, seconds(parse(iso) ?: return null, now))
        return when {
            diff < 60 -> "${diff.toInt()}s"
            diff < 3_600 -> "${(diff / 60).toInt()}m"
            diff < 86_400 -> "${(diff / 3_600).toInt()}h"
            else -> "${(diff / 86_400).toInt()}d"
        }
    }
}
