package io.orbitd.android.directory

import io.orbitd.android.projects.ProjectPage
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The project's Landings window and its one row on the sessions page (owner 2026-10-27, docs/mocks/landings-one-window; contract §2.9
 * LS6, revision 28): OrbitKit's `SessionProjectLandingsTests`, test for test, with its fixtures. Every instant is built in the reader's
 * own zone, so the day sections and today's counts read the same in any zone.
 */
class SessionProjectLandingsTest {
    private val zone = ZoneId.systemDefault()
    /** Tuesday 2026-10-27, 10:20 — the board's moment. */
    private val now = local(27, 10, 20)

    private fun local(day: Int, hour: Int, minute: Int = 0): Instant = LocalDateTime.of(2026, 10, day, hour, minute).atZone(zone).toInstant()

    private fun row(id: String, title: String? = null, subject: String = "TASK", state: String, settledAs: String? = null,
        settledAt: Instant? = null, createdAt: Instant? = null) =
        DirectorySession(id, title = title ?: "Land · $id", status = "SUCCEEDED", createdAt = (createdAt ?: local(27, 8)).toString(),
            sessionKind = "LANDING", landing = SessionLandingSummary(subject, state, settledAs, settledAt?.toString()))

    private fun merged(id: String, at: Instant, session: String?, automatic: Boolean = true): JsonObject = buildJsonObject {
        put("promotionId", id); put("state", "MERGED"); put("sourceRef", "refs/heads/project/p1"); put("sourceSha", "a")
        put("upstreamRef", "refs/heads/main")
        putJsonArray("taskIds") { add("t1"); add("t2") }
        putJsonObject("merged") { put("sha", "3f1c2a9000000000000000000000000000000000"); put("at", at.toString()); put("automatic", automatic) }
        session?.let { put("landingSessionId", it) }
    }

    private fun clock(at: Instant) = ProjectPage.landingClockTime(at, zone)

    private fun window(rows: List<DirectorySession>, merges: List<JsonObject> = emptyList()) = SessionProjectLandings.window(rows, merges, now, zone)

    @Test fun groupsTheSettledOnesByTheSessionListsDaysOldestFirstAndKeepsEveryOne() {
        val window = window(listOf(
            row("Fix the deep link", state = "SETTLED", settledAs = "NOTHING_TO_LAND", settledAt = local(27, 8, 30)),
            row("Ledger migration order", state = "SETTLED", settledAs = "LANDED", settledAt = local(26, 17, 42)),
            row("Runner model order", state = "SETTLED", settledAs = "LANDED", settledAt = local(27, 10, 2)),
            row("Month-old fix", state = "SETTLED", settledAs = "CANCELLED", settledAt = local(1, 9)),
            row("Wiki review link", state = "SETTLED", settledAs = "ALREADY_LANDED", settledAt = local(27, 9, 5))))
        assertEquals(listOf("8–30 days ago", "Yesterday", "Today"), window.days.map { it.title })
        assertEquals(listOf("Fix the deep link", "Wiki review link", "Runner model order"), window.days[2].rows.map { it.title })
        assertEquals(listOf("${clock(local(27, 8, 30))} Nothing to land quiet", "${clock(local(27, 9, 5))} Already landed ok",
            "${clock(local(27, 10, 2))} Landed ok"), window.days[2].rows.map { "${it.time} ${it.detail} ${it.tone.name.lowercase()}" })
        assertEquals("Cancelled", window.days[0].rows[0].detail)
        assertEquals(emptyList<LandingsWindowCard>(), window.now)
    }

    @Test fun putsWhatIsInHandUnderNowInTheOrderItStarted() {
        val window = window(listOf(
            row("Checks failed", state = "AWAITING_DECISION", createdAt = local(27, 10, 1)),
            row("Still landing", state = "IN_FLIGHT", createdAt = local(27, 9, 40)),
            row("round", title = "Merge project/p1 → main · #12", subject = "PROMOTION", state = "IN_FLIGHT", createdAt = local(27, 10, 5))))
        assertEquals(emptyList<LandingsWindowDay>(), window.days)
        assertEquals(listOf("Still landing|IN_FLIGHT|TASK", "Checks failed|AWAITING_DECISION|TASK", "Merge project/p1 → main · #12|IN_FLIGHT|PROMOTION"),
            window.now.map { "${it.title}|${it.state}|${it.subject}" })
    }

    @Test fun joinsAMergeIntoMainWithItsRoundsLandingSessionByLandingSessionIdOneRow() {
        val window = window(listOf(row("S-12", title = "Merge project/p1 → main · #12", subject = "PROMOTION", state = "SETTLED",
            settledAs = "MERGED", settledAt = local(27, 9, 52))), listOf(merged("P-12", local(27, 9, 51), "S-12")))
        assertEquals(1, window.days.size)
        assertEquals(1, window.days[0].rows.size)
        val row = window.days[0].rows[0]
        assertEquals("S-12", row.key)
        assertEquals("S-12", row.sessionId)
        assertEquals("Merged into main", row.title)
        assertEquals("3f1c2a9 · 2 tasks · automatically", row.detail)
        assertEquals(LandingsWindowTone.MERGE, row.tone)
        assertEquals(clock(local(27, 9, 51)), row.time)
        assertEquals("P-12", (row.promotion?.get("promotionId") as? kotlinx.serialization.json.JsonPrimitive)?.content)
    }

    @Test fun keepsAMergeOlderThanLandingSessionsAndARoundPastTheTwentyRecords() {
        val window = window(listOf(row("S-3", title = "Merge project/p1 → main · #3", subject = "PROMOTION", state = "SETTLED",
            settledAs = "MERGED", settledAt = local(25, 15))), listOf(merged("P-1", local(26, 11, 30), null, automatic = false)))
        assertEquals(listOf("2–7 days ago", "Yesterday"), window.days.map { it.title })
        val round = window.days[0].rows[0]
        assertEquals("S-3", round.key)
        assertEquals("Merged into main", round.title)
        assertEquals("Merge project/p1 → main · #3", round.detail)
        assertNull(round.promotion)
        val old = window.days[1].rows[0]
        assertEquals("merge:P-1", old.key)
        assertNull(old.sessionId)
        assertEquals("3f1c2a9 · 2 tasks · by you", old.detail)
        assertEquals(clock(local(26, 11, 30)), old.time)
    }

    @Test fun namesATaskSegmentByItsTaskAndARoundThatDidNotMergeByItsOwnTitle() {
        assertEquals("Ledger migration order", SessionProjectLandings.taskName("Land · Ledger migration order"))
        assertEquals("Ledger migration order (#2)", SessionProjectLandings.taskName("Land · Ledger migration order (#2)"))
        assertEquals("Something else", SessionProjectLandings.taskName("Something else"))
        val window = window(listOf(row("declined", title = "Merge project/p1 → main · #4", subject = "PROMOTION", state = "SETTLED",
            settledAs = "DECLINED", settledAt = local(27, 9))))
        assertEquals("Merge project/p1 → main · #4", window.days[0].rows[0].title)
        assertEquals("Declined", window.days[0].rows[0].detail)
    }

    @Test fun countsTheRowAZeroIsLeftOutTodaysTwoShareOneTodayAndAllZeroIsNothingLandedToday() {
        assertEquals("1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today",
            SessionProjectLandings.countLine(waiting = 1, inFlight = 1, landed = 3, merged = 1))
        assertEquals("2 in flight", SessionProjectLandings.countLine(waiting = 0, inFlight = 2, landed = 0, merged = 0))
        assertEquals("2 landed today", SessionProjectLandings.countLine(waiting = 0, inFlight = 0, landed = 2, merged = 0))
        assertEquals("1 merged into master today", SessionProjectLandings.countLine(waiting = 0, inFlight = 0, landed = 0, merged = 1, main = "master"))
        assertEquals("2 waiting for a decision", SessionProjectLandings.countLine(waiting = 2, inFlight = 0, landed = 0, merged = 0))
        assertEquals("Nothing landed today", SessionProjectLandings.countLine(waiting = 0, inFlight = 0, landed = 0, merged = 0))
    }

    @Test fun marksTheRowByTheMostUrgentLandingAndTimesTheLongestWait() {
        val rows = listOf(
            row("Checks failed", state = "AWAITING_DECISION", createdAt = now.minusSeconds(18 * 60)),
            row("Still landing", state = "IN_FLIGHT"),
            row("a", state = "SETTLED", settledAs = "LANDED", settledAt = local(27, 9)),
            row("b", state = "SETTLED", settledAs = "LANDED", settledAt = local(27, 9, 30)),
            row("c", state = "SETTLED", settledAs = "ALREADY_LANDED", settledAt = local(27, 10)),
            row("yesterday", state = "SETTLED", settledAs = "LANDED", settledAt = local(26, 22)),
            row("nothing", state = "SETTLED", settledAs = "NOTHING_TO_LAND", settledAt = local(27, 8)))
        assertEquals(LandingsRowSummary(LandingsRowMark.FAIL, "18m", "1 waiting for a decision · 1 in flight · 3 landed · 1 merged into main today"),
            SessionProjectLandings.rowSummary(rows, listOf(merged("P-1", local(27, 9, 51), null)), now, zone))
        assertEquals(LandingsRowSummary(LandingsRowMark.RUNNING, "20m", "1 in flight · 3 landed today"),
            SessionProjectLandings.rowSummary(rows.drop(1), emptyList(), now, zone))
        assertEquals(LandingsRowMark.OK, SessionProjectLandings.rowSummary(rows.drop(2), emptyList(), now, zone)?.mark)
    }

    @Test fun saysNothingLandedTodayOverAQuietDayAndIsNoRowForAProjectThatNeverHadALanding() {
        assertEquals(LandingsRowSummary(LandingsRowMark.OK, "12h", "Nothing landed today"), SessionProjectLandings.rowSummary(
            listOf(row("yesterday", state = "SETTLED", settledAs = "LANDED", settledAt = local(26, 22))), emptyList(), now, zone))
        // A merge older than landing sessions is a landing the project had.
        assertEquals("Nothing landed today", SessionProjectLandings.rowSummary(emptyList(), listOf(merged("P-1", local(20, 9), null)), now, zone)?.line)
        assertNull(SessionProjectLandings.rowSummary(emptyList(), emptyList(), now, zone))
        // A conversation carries no landing summary and is no landing.
        val chat = DirectorySession("chat", title = "chat", status = "SUCCEEDED", createdAt = local(27, 9).toString())
        assertNull(SessionProjectLandings.rowSummary(listOf(chat), emptyList(), now, zone))
    }

    // MARK: the source session's derived label

    private fun source(subject: String = "TASK", state: String = "RUNNING", phase: String? = "CHECK", settledAs: String? = null,
        targetRef: String = "refs/heads/project/p1") = SessionProjectLandings.LandingSummary("S1", subject, state, phase, settledAs, targetRef)

    @Test fun theSourceLabelSaysCheckingWhileItMovesTheBranchOnceItLandedAndWhatStoppedIt() {
        assertEquals(SourceLandingLabel("Landing · checking", "run"), SessionProjectLandings.sourceLabel(source()))
        assertEquals(SourceLandingLabel("Landing · rebasing", "run"), SessionProjectLandings.sourceLabel(source(phase = "REBASE")))
        assertEquals(SourceLandingLabel("Landing · queued", "run"), SessionProjectLandings.sourceLabel(source(state = "QUEUED", phase = null)))
        assertEquals(SourceLandingLabel("On project/p1 ✓", "landed"), SessionProjectLandings.sourceLabel(source(settledAs = "LANDED")))
        assertEquals(SourceLandingLabel("Landing · checks failed", "failed"), SessionProjectLandings.sourceLabel(source(state = "CHECK_FAILED")))
        assertEquals("failed", SessionProjectLandings.sourceLabel(source(state = "CONFLICT"))?.tone)
        assertEquals("Landing · error", SessionProjectLandings.sourceLabel(source(state = "ERROR"))?.text)
    }

    @Test fun theSourceLabelSaysWhereAMergeRoundPutTheWorkByTheProjectsMainBranch() {
        assertEquals(SourceLandingLabel("On main ✓", "landed"), SessionProjectLandings.sourceLabel(source(subject = "PROMOTION", settledAs = "MERGED")))
        assertEquals(SourceLandingLabel("On master ✓", "landed"),
            SessionProjectLandings.sourceLabel(source(subject = "PROMOTION", settledAs = "MERGED"), main = "master"))
        assertEquals(SourceLandingLabel("Nothing to land", "quiet"), SessionProjectLandings.sourceLabel(source(settledAs = "NOTHING_TO_LAND")))
    }

    @Test fun theSourceLabelIsNothingAtAllForAConversationThatFedNoLanding() {
        assertNull(SessionProjectLandings.sourceLabel(null))
    }
}
