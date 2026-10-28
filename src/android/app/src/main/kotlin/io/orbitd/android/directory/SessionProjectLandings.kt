package io.orbitd.android.directory

import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectAttention
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.reader.LandingSessionCopy
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.JsonObject

// The Landings row on a project's sessions page and the project's Landings window (owner 2026-10-27, docs/mocks/landings-one-window;
// contract §2.9 LS6, revision 28): the row's count sentence, the window's day sections and its `Now`, and the read-only footer. A direct
// port of OrbitKit's SessionProjectLandings.swift, itself a port of the web's `landingsWindow` and `landingsRowSummary`.

/** The row's and the window's words, and the source session's derived label's. */
object SessionLandingsCopy {
    const val title = "Landings"
    const val waiting = "waiting for a decision"
    const val inFlight = "in flight"
    const val landed = "landed"
    const val mergedInto = "merged into"
    const val today = "today"
    const val nothingLandedToday = "Nothing landed today"
    const val now = "Now"
    const val orbitRunsTheseLandings = "Orbit runs these landings — nothing to type here."
    /** A merge round's row when its record is past the read's 20: the round merged into main. */
    const val mergedIntoMain = "Merged into main"

    // The derived label on a source work session (board v4 06 e), the web's `SESSION_SOURCE_LANDING_COPY`.
    const val landing = "Landing"
    const val on = "On"
    /** The source label's own spelling, capitalized because it stands alone on the chip. */
    const val sourceNothingToLand = "Nothing to land"
    const val checksFailed = "checks failed"
    const val conflict = "conflict"
    const val error = "error"
    const val queued = "queued"
    const val running = "running"

    /** How a row names a settlement this build has no word for (the Swift's `settledWord` fallback). */
    const val settled = "Settled"
}

/** The mark a settled row's head carries: ✓ landed, ⇢ merged into main, ◌ nothing to land and every other quiet ending. */
enum class LandingsWindowTone { OK, MERGE, QUIET }

/** One settled landing in the window, drawn with the merged line's head: the mark that says how it ended, the task's name, the moment
 *  it settled, and one line under them. [key] is the landing session's id, or `merge:<promotionId>` for a merge into main that has no
 *  landing session (it predates them); [sessionId] is the LANDING session the row opens in place, null for such a merge, whose receipt
 *  is all there is to open. [time] is the clock time it settled at (`17:42`), [at] that instant in epoch milliseconds
 *  ([Long.MIN_VALUE] when it cannot be read), and [promotion] the round's merged record (`promotions/merged`), joined by
 *  `landingSessionId` — null on a task's row and on a round older than the read's 20 records. */
data class LandingsWindowRow(val key: String, val sessionId: String?, val subject: String, val title: String, val detail: String,
    val tone: LandingsWindowTone, val time: String, val at: Long, val promotion: JsonObject? = null) {
    /** What the window opens, scrolls to and outlines: the session where there is one. */
    val id: String get() = sessionId ?: key
}

/** One landing that has not settled: a card at the bottom of the window. [state] is `IN_FLIGHT` or `AWAITING_DECISION`; [title] the
 *  task's name (a round's own title), the line the card adds under its head; [at] when it started, in epoch milliseconds. */
data class LandingsWindowCard(val sessionId: String, val subject: String, val state: String, val title: String, val at: Long) {
    val id: String get() = sessionId
}

/** One of the session list's day sections, holding the landings that settled in it. */
data class LandingsWindowDay(val title: String, val rows: List<LandingsWindowRow>)

/** The settled landings by the session list's own day sections, oldest first and oldest row first — the window reads like a
 *  conversation, the newest at the bottom — and the landings still in hand, in the order they started: the window's last group. */
data class LandingsWindow(val days: List<LandingsWindowDay> = emptyList(), val now: List<LandingsWindowCard> = emptyList())

/** The Landings row's mark: ✕ something waits for a decision, the blue ring something is in flight, ✓ all settled. */
enum class LandingsRowMark { FAIL, RUNNING, OK }

/** The Landings row's three facts: the mark of the most urgent landing, how long it has waited (or how long ago the last one settled),
 *  and the counts under them. */
data class LandingsRowSummary(val mark: LandingsRowMark, val time: String, val line: String)

object SessionProjectLandings {
    /** The session list's day sections, as the window files a settlement (`SessionTimeGrouping.bucketTitles`). */
    val dayTitles: List<String> = recencyTitles.drop(1)

    /** A task segment's title is the server's `Land · <task>`: the window names the task alone. */
    fun taskName(title: String?): String {
        val name = title ?: ""
        val prefix = "${LandingSessionCopy.LAND} · "
        return if (name.startsWith(prefix)) name.substring(prefix.length) else name
    }

    /**
     * The project's Landings window: every landing the project has had, from the two reads its sessions page already makes — the
     * LANDING sessions (`includeLanding=1`, open and completed) and the merges into main (`promotions/merged`).
     *
     * A settled landing is one row in the day it settled, in the session list's own day sections, all of them kept. A round of merging
     * that merged is one row with its record, joined by `landingSessionId`; a merge older than landing sessions has a row of its own that
     * opens to its receipt alone, and a round past the read's last 20 records keeps its session's row. A landing still in hand — in
     * flight, or waiting for a decision — is a card under `Now`, in the order it started.
     */
    fun window(rows: List<DirectorySession>, merges: List<JsonObject>, now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault()): LandingsWindow {
        val records = merges.filter { it.obj("merged") != null }
        val bySession = mutableMapOf<String, JsonObject>()
        for (record in records) {
            val id = record.text("landingSessionId")?.takeIf { it.isNotEmpty() } ?: continue
            bySession.putIfAbsent(key(id), record)
        }
        val joined = mutableSetOf<String>()
        class Settled(val row: LandingsWindowRow, val at: Instant?)
        val settled = mutableListOf<Settled>()
        val cards = mutableListOf<LandingsWindowCard>()
        for (session in rows) {
            val landing = session.landing ?: continue
            val subject = landing.subject.orEmpty()
            val state = landing.state ?: if (landing.settledAt != null) "SETTLED" else "IN_FLIGHT"
            val name = if (subject == "TASK") taskName(session.title) else session.title.orEmpty()
            if (state != "SETTLED") {
                cards += LandingsWindowCard(session.id, subject, state, name, instant(session.createdAt))
                continue
            }
            if (subject == "PROMOTION" && landing.settledAs == "MERGED") {
                val record = bySession[key(session.id)]
                record?.text("promotionId")?.let(joined::add)
                val at = ProjectTime.parse(record?.obj("merged")?.text("at") ?: landing.settledAt)
                settled += Settled(LandingsWindowRow(session.id, session.id, "PROMOTION",
                    record?.let(PromotionCards::timelineTitle) ?: SessionLandingsCopy.mergedIntoMain,
                    record?.let(PromotionCards::timelineDetail) ?: name, LandingsWindowTone.MERGE, clock(at, zone), millis(at), record), at)
                continue
            }
            val (word, tone) = settledWord(landing.settledAs)
            val at = ProjectTime.parse(landing.settledAt)
            settled += Settled(LandingsWindowRow(session.id, session.id, subject, name, word, tone, clock(at, zone), millis(at)), at)
        }
        // A merge whose round has no session in the read: older than landing sessions, or a session the read did not list. It is still
        // a merge into main, at its own instant.
        for (record in records) {
            val promotionId = record.text("promotionId").orEmpty()
            if (promotionId in joined) continue
            val at = ProjectTime.parse(record.obj("merged")?.text("at"))
            val session = record.text("landingSessionId")?.takeIf { it.isNotEmpty() }
            settled += Settled(LandingsWindowRow(session ?: "merge:$promotionId", session, "PROMOTION", PromotionCards.timelineTitle(record),
                PromotionCards.timelineDetail(record), LandingsWindowTone.MERGE, clock(at, zone), millis(at), record), at)
        }
        // Oldest first, in the session list's day sections (the local calendar day): the window reads down to today, and `Now` under it.
        val today = now.atZone(zone).toLocalDate()
        val buckets = List(dayTitles.size) { mutableListOf<LandingsWindowRow>() }
        settled.sortedWith(compareBy<Settled> { it.row.at }.thenByDescending { it.row.key })
            .forEach { buckets[recencyBucket(it.at, today, zone) - 1] += it.row }
        val days = buckets.withIndex().reversed().filter { it.value.isNotEmpty() }.map { LandingsWindowDay(dayTitles[it.index], it.value) }
        return LandingsWindow(days, cards.sortedWith(compareBy<LandingsWindowCard> { it.at }.thenBy { it.sessionId }))
    }

    /** `1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today` — a count of 0 is left out, today's two share one
     *  `today` at the end, and with all four at 0 the line is `Nothing landed today`. */
    fun countLine(waiting: Int, inFlight: Int, landed: Int, merged: Int, main: String = RunSettings.defaultMainBranch): String {
        val today = listOfNotNull(
            if (landed > 0) "$landed ${SessionLandingsCopy.landed}" else null,
            if (merged > 0) "$merged ${SessionLandingsCopy.mergedInto} $main" else null,
        ).joinToString(" · ")
        val parts = listOfNotNull(
            if (waiting > 0) "$waiting ${SessionLandingsCopy.waiting}" else null,
            if (inFlight > 0) "$inFlight ${SessionLandingsCopy.inFlight}" else null,
            if (today.isEmpty()) null else "$today ${SessionLandingsCopy.today}",
        )
        return if (parts.isEmpty()) SessionLandingsCopy.nothingLandedToday else parts.joinToString(" · ")
    }

    /**
     * The project sessions page's one Landings row (owner 2026-10-27, board 01 b), in the place the Landings group had: under the
     * coordinator, above the page's own timeline. It opens the project's Landings window. Null for a project that has never had a
     * landing, which draws no row.
     *
     * The mark follows the most urgent landing: one waiting for a decision is the red ✕ and the right slot says how long the longest of
     * them has waited; else one in flight is the blue ring; else ✓. Without a waiting one the right slot says how long ago the last one
     * settled. Today's counts are the window's own `Today` section, so the row and the window never disagree about a day.
     */
    fun rowSummary(rows: List<DirectorySession>, merges: List<JsonObject>, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(),
        main: String = RunSettings.defaultMainBranch): LandingsRowSummary? {
        val landings = rows.filter { it.landing != null }
        if (landings.isEmpty() && merges.none { it.obj("merged") != null }) return null
        val window = window(landings, merges, now, zone)
        val waiting = window.now.filter { it.state == "AWAITING_DECISION" }
        val inFlight = window.now.filter { it.state == "IN_FLIGHT" }
        val today = window.days.firstOrNull { it.title == dayTitles[0] }?.rows.orEmpty()
        val lastSettled = window.days.flatMap { it.rows }.maxOfOrNull { it.at } ?: Long.MIN_VALUE
        val time = if (waiting.isNotEmpty()) elapsed(waiting.minOf { it.at }, now)
            else if (lastSettled != Long.MIN_VALUE) elapsed(lastSettled, now) else null
        return LandingsRowSummary(
            mark = if (waiting.isNotEmpty()) LandingsRowMark.FAIL else if (inFlight.isNotEmpty()) LandingsRowMark.RUNNING else LandingsRowMark.OK,
            time = time.orEmpty(),
            line = countLine(waiting.size, inFlight.size, today.count { it.tone == LandingsWindowTone.OK },
                today.count { it.tone == LandingsWindowTone.MERGE }, main))
    }

    /** How a settled subject ended, in the row's own words. */
    fun settledWord(settledAs: String?): Pair<String, LandingsWindowTone> = when (settledAs) {
        "LANDED" -> LandingSessionCopy.LANDED to LandingsWindowTone.OK
        "ALREADY_LANDED" -> LandingSessionCopy.ALREADY_LANDED to LandingsWindowTone.OK
        "NOTHING_TO_LAND" -> LandingSessionCopy.NOTHING_TO_LAND to LandingsWindowTone.QUIET
        "HANDLED" -> LandingSessionCopy.HANDLED to LandingsWindowTone.QUIET
        "DECLINED" -> LandingSessionCopy.DECLINED to LandingsWindowTone.QUIET
        "CANCELLED" -> LandingSessionCopy.CANCELLED to LandingsWindowTone.QUIET
        "DELETED" -> LandingSessionCopy.DELETED to LandingsWindowTone.QUIET
        else -> (settledAs ?: SessionLandingsCopy.settled) to LandingsWindowTone.QUIET
    }

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

    /** The part of a code session's detail the label reads (`SessionSourceLanding`, §2.9 LS1's derived field). */
    data class LandingSummary(val landingSessionId: String, val subject: String? = null, val state: String? = null, val phase: String? = null,
        val settledAs: String? = null, val targetRef: String? = null)

    private fun branchOf(ref: String?) = (ref ?: "").replaceFirst("refs/heads/", "")
    /** Either spelling of a session id is one session. */
    private fun key(id: String) = ObjectId.canonical(id) ?: id
    private fun instant(iso: String?): Long = millis(ProjectTime.parse(iso))
    private fun millis(at: Instant?): Long = at?.toEpochMilli() ?: Long.MIN_VALUE
    private fun clock(at: Instant?, zone: ZoneId) = at?.let { ProjectPage.landingClockTime(it, zone) }.orEmpty()
    /** `20m`, `2h`, `3d` — the waiting chips' own scale, for an instant the window already read. */
    private fun elapsed(at: Long, now: Instant): String? =
        if (at == Long.MIN_VALUE) null else ProjectAttention.elapsedLabel(Instant.ofEpochMilli(at).toString(), now)
}

/** The source session's derived landing label: its words and the ink they wear (`run`, `landed`, `failed` or `quiet`). */
data class SourceLandingLabel(val text: String, val tone: String)
