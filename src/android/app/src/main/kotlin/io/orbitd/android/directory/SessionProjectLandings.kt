package io.orbitd.android.directory

import io.orbitd.android.core.cards.*
import io.orbitd.android.projects.ProjectAttention
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.reader.LandingSessionCopy
import java.time.Instant
import kotlinx.serialization.json.JsonObject

// The Landings group of a project's sessions page (owner 2026-10-19, board v4 04 c1; contract §2.9 LS6): the landings waiting on a
// decision and the ones that settled in the last day, under the coordinator and above the page's own timeline. A direct port of
// OrbitKit's SessionProjectLandings.swift, itself a port of the web's `landingGroup`.

/** The group's heading, its fold, and the two words for who holds a landing waiting on somebody. */
object SessionLandingsCopy {
    const val title = "Landings"
    const val earlier = "Earlier"
    const val landed = "landed"
    const val nothingToLand = "nothing to land"
    const val withYou = "with you"
    const val withCoordinator = "with the coordinator"
    const val waiting = "Waiting for a decision"

    // The derived label on a source work session (board v4 06 e), the web's `SESSION_SOURCE_LANDING_COPY`.
    const val landing = "Landing"
    const val on = "On"
    /** The source label's own spelling, capitalized because it stands alone on the chip — the group's fold says the same fact in
     *  lower case (`nothingToLand`). */
    const val sourceNothingToLand = "Nothing to land"
    const val checksFailed = "checks failed"
    const val conflict = "conflict"
    const val error = "error"
    const val queued = "queued"
    const val running = "running"

    /** The settled words the group shares with the landing page (OrbitKit takes them from `LandingPageCopy`). */
    const val mergedIntoMain = "Merged into main"
    const val settled = "Settled"
}

/** How far back a settled landing is still listed in the group: 24 hours (owner 2026-10-19). */
const val landingsSettledWindowMs: Long = 24 * 60 * 60 * 1_000

/** The mark a landing group row's head carries: ✕ stopped, ✓ landed, ⇢ merged, ◌ nothing to land. */
enum class LandingGroupTone { FAIL, OK, MERGE, QUIET }

data class LandingGroupRow(val id: String, val title: String, val time: String, val detail: String, val tone: LandingGroupTone)

/** The fold's two counts: how many of the older landings landed, and how many had nothing to land. */
data class LandingEarlier(val landed: Int, val nothing: Int)

data class LandingGroup(val waiting: List<LandingGroupRow>, val settled: List<LandingGroupRow>, val earlier: LandingEarlier?,
    val older: List<LandingGroupRow>) {
    /** The group draws nothing at all when it has nothing to list. */
    val isEmpty get() = waiting.isEmpty() && settled.isEmpty() && older.isEmpty()
}

/** What the row a landing is waiting on says: its kind's outcome, and whose it is (`OWNER` or `COORDINATOR`). */
data class LandingHolder(val reason: String?, val assignee: String?)

object SessionProjectLandings {
    /** The group of a project's landing rows, or null when it has nothing to list. A landing still in flight is not here (it is on
     *  the Landing card); neither is a round of merging that merged (the timeline already has its own row). Everything older folds
     *  into one line that opens. [holders] is what the project's open items say about a landing that waits (§4.7). */
    fun group(rows: List<DirectorySession>, now: Instant = Instant.now(), holders: Map<String, LandingHolder> = emptyMap()): LandingGroup? {
        class At(val row: LandingGroupRow, val at: Long)
        val waiting = mutableListOf<At>()
        val settled = mutableListOf<At>()
        val before = mutableListOf<At>()
        var landed = 0
        var nothing = 0
        var older = 0
        for (session in rows) {
            val landing = session.landing ?: continue
            if (landing.state == "IN_FLIGHT") continue
            val title = session.title?.takeIf { it.isNotEmpty() } ?: SessionLandingsCopy.title
            if (landing.state == "AWAITING_DECISION") {
                val holder = holders[session.id]
                val outcome = holder?.reason ?: SessionLandingsCopy.waiting
                val who = when (holder?.assignee) { "OWNER" -> SessionLandingsCopy.withYou; "COORDINATOR" -> SessionLandingsCopy.withCoordinator; else -> null }
                waiting += At(LandingGroupRow(session.id, title, ProjectAttention.elapsedLabel(session.createdAt, now) ?: "",
                    listOfNotNull(outcome, who).joinToString(" · "),
                    // An item names what stopped it, and that is the red mark; a waiting landing with no item yet says only that it is waiting.
                    if (holder?.reason != null) LandingGroupTone.FAIL else LandingGroupTone.QUIET), instant(session.createdAt))
                continue
            }
            // A round of merging that merged is the timeline's own row, not this group's.
            if (landing.subject == "PROMOTION" && landing.settledAs == "MERGED") continue
            val at = instant(landing.settledAt)
            val word = settledWord(landing.settledAs)
            if (at == Long.MIN_VALUE || now.toEpochMilli() - at > landingsSettledWindowMs) {
                older += 1
                if (landing.settledAs in setOf("LANDED", "ALREADY_LANDED")) landed += 1
                if (landing.settledAs == "NOTHING_TO_LAND") nothing += 1
                before += At(LandingGroupRow(session.id, title, ProjectAttention.elapsedLabel(landing.settledAt, now) ?: "", word.first, word.second), at)
                continue
            }
            settled += At(LandingGroupRow(session.id, title, ProjectAttention.elapsedLabel(landing.settledAt, now) ?: "", word.first, word.second), at)
        }
        if (waiting.isEmpty() && settled.isEmpty() && older == 0) return null
        // The waiting ones first, longest wait first: the page answers "what is stuck, and on whom".
        waiting.sortBy { it.at }
        settled.sortByDescending { it.at }
        before.sortByDescending { it.at }
        // The fold is there whenever something older is, and opens to all of it; it counts only what landed and what had nothing to
        // land, so with both at 0 it reads a bare `Earlier`.
        return LandingGroup(waiting.map { it.row }, settled.map { it.row },
            if (older > 0) LandingEarlier(landed, nothing) else null, before.map { it.row })
    }

    /** How a settled subject ended, in the group's own words. */
    fun settledWord(settledAs: String?): Pair<String, LandingGroupTone> = when (settledAs) {
        "LANDED" -> LandingSessionCopy.LANDED to LandingGroupTone.OK
        "ALREADY_LANDED" -> LandingSessionCopy.ALREADY_LANDED to LandingGroupTone.OK
        "MERGED" -> LandingSessionCopy.MERGED_INTO + " " + LandingSessionCopy.INTO_MAIN to LandingGroupTone.MERGE
        "NOTHING_TO_LAND" -> LandingSessionCopy.NOTHING_TO_LAND to LandingGroupTone.QUIET
        "HANDLED" -> LandingSessionCopy.HANDLED to LandingGroupTone.QUIET
        "DECLINED" -> LandingSessionCopy.DECLINED to LandingGroupTone.QUIET
        "CANCELLED" -> LandingSessionCopy.CANCELLED to LandingGroupTone.QUIET
        "DELETED" -> LandingSessionCopy.DELETED to LandingGroupTone.QUIET
        else -> (settledAs ?: SessionLandingsCopy.settled) to LandingGroupTone.QUIET
    }

    /** Who holds each landing that waits, joined by `landingSessionId`: the item's kind's outcome and its side. The first item
     *  about a landing wins, as on iOS. */
    fun holders(openItems: JsonObject?): Map<String, LandingHolder> {
        val map = mutableMapOf<String, LandingHolder>()
        (openItems?.objects("needsYou").orEmpty() + openItems?.objects("withCoordinator").orEmpty()).forEach { row ->
            val sessionId = row.text("landingSessionId")?.takeIf { it.isNotEmpty() } ?: return@forEach
            if (map.containsKey(sessionId)) return@forEach
            map[sessionId] = LandingHolder(itemReason(row.text("kind")), row.text("assignee"))
        }
        return map
    }

    /** What an open item about a landing is about, in the group's words; null for a kind that is not a landing's outcome. */
    fun itemReason(kind: String?): String? = when (kind) {
        "INTEGRATION_CONFLICT" -> "Merge conflict"
        "INTEGRATION_CHECK_FAILED" -> "Checks failed"
        "INTEGRATION_ERROR" -> "Integration error"
        "TASK_FAILED" -> "Task failed"
        "DELIVERY_REVIEW" -> "Delivery review"
        "LANDING_LEASE_EXPIRED" -> "No report from the runner"
        else -> null
    }

    /** `Earlier · 31 landed · 3 nothing to land` — the fold's one line. A segment whose count is 0 is left out: `Earlier · 2 landed`,
     *  and with both at 0 the line is the bare `Earlier`. */
    fun earlierLine(earlier: LandingEarlier) = listOfNotNull(SessionLandingsCopy.earlier,
        "${earlier.landed} ${SessionLandingsCopy.landed}".takeIf { earlier.landed > 0 },
        "${earlier.nothing} ${SessionLandingsCopy.nothingToLand}".takeIf { earlier.nothing > 0 }).joinToString(" · ")

    /** The derived label on a source work session (board v4 06 e): three facts, three inks. A settled subject says where the work
     *  went; an open one says what the platform is doing — the attempt's own step where the server names it, else its state. */
    fun sourceLabel(landing: LandingSummary?, main: String = RunSettings.defaultMainBranch): SourceLandingLabel? {
        if (landing == null) return null
        val branch = branchOf(landing.targetRef).ifEmpty { branchOf(main) }
        when (landing.settledAs) {
            "LANDED", "ALREADY_LANDED" -> return SourceLandingLabel("${SessionLandingsCopy.on} $branch ✓", "landed")
            "MERGED" -> return SourceLandingLabel("${SessionLandingsCopy.on} ${RunSettings.mainBranchName(main)} ✓", "landed")
            "NOTHING_TO_LAND" -> return SourceLandingLabel(SessionLandingsCopy.sourceNothingToLand, "quiet")
            "HANDLED", "DECLINED", "CANCELLED", "DELETED" ->
                return SourceLandingLabel("${SessionLandingsCopy.landing} · ${landing.settledAs.lowercase()}", "quiet")
        }
        val stopped = when (landing.state) {
            "CHECK_FAILED" -> SessionLandingsCopy.checksFailed
            "CONFLICT" -> SessionLandingsCopy.conflict
            "ERROR" -> SessionLandingsCopy.error
            else -> null
        }
        if (stopped != null) return SourceLandingLabel("${SessionLandingsCopy.landing} · $stopped", "failed")
        val step = if (landing.state == "RUNNING") landing.phase?.let { ProjectPage.phaseWords(main)[it] }
            ?: SessionLandingsCopy.running
        else if (landing.state == "QUEUED") SessionLandingsCopy.queued
        else landing.state.orEmpty().lowercase()
        return SourceLandingLabel("${SessionLandingsCopy.landing} · $step", "run")
    }

    /** The part of a code session's detail the group reads (`SessionSourceLanding`, §2.9 LS1's derived field). */
    data class LandingSummary(val landingSessionId: String, val subject: String? = null, val state: String? = null, val phase: String? = null,
        val settledAs: String? = null, val targetRef: String? = null)

    private fun branchOf(ref: String?) = (ref ?: "").replaceFirst("refs/heads/", "")
    private fun instant(iso: String?): Long = iso?.let { ProjectTime.parse(it)?.toEpochMilli() } ?: Long.MIN_VALUE
}

/** The source session's derived landing label: its words and the ink they wear (`run`, `landed`, `failed` or `quiet`). */
data class SourceLandingLabel(val text: String, val tone: String)
