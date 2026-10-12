package io.orbitd.android.directory

import io.orbitd.android.core.cards.PromotionCards
import io.orbitd.android.core.cards.PromotionStage
import io.orbitd.android.projects.ProjectPage
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The merge into main on the project's sessions page (iOS 6b4bef713's ProjectMergeCardTests): the card under the progress card,
 * the merge check's line moving into it, the merges drawn on the page's timeline, and how often the page reads them. */
class ProjectMergeTest {
    private fun candidate(state: String, conflicts: List<String> = emptyList()) = Json.parseToJsonElement("""{"promotionId":"pr-1","state":"$state",
        "sourceRef":"refs/heads/project/34ZurCP3bv9yLXGVyUGnx","sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main","taskIds":["t1","t2"],
        "conflicts":${conflicts.joinToString(",", "[", "]") { "\"$it\"" }}}""").jsonObject
    private fun integration(kind: String?, state: String = "RUNNING") = Json.parseToJsonElement("""{"integratingCount":1,"queuedCount":0,
        "inFlight":{"state":"$state","startedAt":"2026-10-06T03:20:00Z"${kind?.let { ",\"kind\":\"$it\"" }.orEmpty()},"phase":"CHECK"}}""").jsonObject
    private fun merge(id: String, at: String) = PromotionCards.receipts(listOf(Json.parseToJsonElement("""{"promotionId":"$id","state":"MERGED",
        "sourceRef":"refs/heads/project/p","sourceSha":"abc","upstreamRef":"refs/heads/main","taskIds":["t1"],
        "merged":{"sha":"8d5a868e90df","at":"$at","automatic":false,"revert":null}}""").jsonObject)).single()
    private fun session(id: String, at: String?) = DirectorySession(id, title = id, status = "AWAITING_INPUT", createdAt = at, lastTurnAt = at)
    private fun at(iso: String) = Instant.parse(iso)

    @Test fun theCardTakesTheCandidatesStateAndTheMergeChecksLineBeforeThat() {
        assertEquals(ProjectMergeCard.Shape.ASKING, ProjectMergeCard.shape(candidate("READY"), null))
        assertEquals(ProjectMergeCard.Shape.MERGING, ProjectMergeCard.shape(candidate("CONFIRMED"), null))
        assertEquals(ProjectMergeCard.Shape.MERGING, ProjectMergeCard.shape(candidate("RECHECKING"), null))
        assertEquals(ProjectMergeCard.Shape.BLOCKED, ProjectMergeCard.shape(candidate("BLOCKED", listOf("a.go")), null))
        // Before there is anything to ask, the merge check running is what the card says.
        assertEquals(ProjectMergeCard.Shape.CHECKING, ProjectMergeCard.shape(candidate("CHECKING"), integration("CHECK_PROMOTION")))
        assertEquals(ProjectMergeCard.Shape.CHECKING, ProjectMergeCard.shape(null, integration("CHECK_PROMOTION")))
        // A task landing on the project branch is the progress card's, and a merge already made is the timeline's: neither draws it.
        assertNull(ProjectMergeCard.shape(null, integration("LAND_TASK")))
        assertNull(ProjectMergeCard.shape(candidate("MERGED"), null))
        assertNull(ProjectMergeCard.shape(candidate("DECLINED"), null))
        assertNull(ProjectMergeCard.shape(null, null))
    }

    @Test fun theMergeJobsLineMovesFromTheProgressCardIntoTheMergeCard() {
        val now = at("2026-10-06T03:24:00Z")
        for (kind in listOf("CHECK_PROMOTION", "LAND_PROMOTION")) {
            val view = integration(kind)
            assertNull(kind, ProjectMergeCard.progressLandingLine(view, now, now, false))
            assertEquals(kind, ProjectPage.landingLine(view, now, now, false), ProjectMergeCard.mergeLandingLine(view, now, now, false))
        }
        val task = integration("LAND_TASK")
        assertEquals(ProjectPage.landingLine(task, now, now, false), ProjectMergeCard.progressLandingLine(task, now, now, false))
        assertNull(ProjectMergeCard.mergeLandingLine(task, now, now, false))
        // An older server names no kind: the line stays where it always was.
        assertNotNull(ProjectMergeCard.progressLandingLine(integration(null), now, now, false))
        assertEquals("Merge check", ProjectMergeCard.mergeLandingLine(integration("CHECK_PROMOTION"), now, now, false)?.word)
    }

    @Test fun mergesSitAmongTheSessionsAtTheirOwnInstant() {
        val sessions = listOf(session("s-now", "2026-10-06T03:58:00Z"), session("s-p6", "2026-10-06T03:45:00Z"),
            session("s-log", "2026-10-06T03:12:00Z"), session("s-old", "2026-10-03T08:00:00Z"))
        val merges = listOf(merge("m-old", "2026-10-04T10:00:00Z"), merge("m-today", "2026-10-06T03:42:00Z"))
        val out = ProjectTimeline.sections(sessions, merges, at("2026-10-06T04:01:00Z"), ZoneOffset.UTC)
        assertEquals(listOf("Today", "2–7 days ago"), out.map { it.title })
        assertEquals(listOf("s-now", "s-p6", merges[1].id, "s-log"), out[0].items.map { it.key })
        assertEquals(listOf(merges[0].id, "s-old"), out[1].items.map { it.key })
    }

    @Test fun aMergeOlderThanEverySessionStillShowsAndNoMergesIsTheSessionGrouping() {
        val sessions = listOf(session("a", "2026-10-06T03:00:00Z"))
        val now = at("2026-10-06T04:00:00Z")
        val out = ProjectTimeline.sections(sessions, listOf(merge("m", "2026-09-01T00:00:00Z")), now, ZoneOffset.UTC)
        assertEquals(listOf("Today", "Older"), out.map { it.title })
        assertEquals(1, out[1].items.size)
        // With no merges the page is the list's own recency grouping, as it was before.
        val plain = ProjectTimeline.sections(sessions, emptyList(), now, ZoneOffset.UTC)
        val grouping = directoryGroups(sessions, SessionView.COMPLETED, Grouping.RECENCY, now, ZoneOffset.UTC)
        assertEquals(grouping.map { it.title }, plain.map { it.title })
        assertEquals(grouping.flatMap { g -> g.sessions.map { it.id } }, plain.flatMap { s -> s.items.map { it.key } })
        assertEquals(grouping.map { it.id }, plain.map { it.id })
    }

    /** iOS `ProjectMergeModel.load`: the candidate every poll; the merges when it moved or once a minute; the holder's items every
     * 20 s while it is blocked; the criteria once a minute while it asks. */
    @Test fun eachPollReadsWhatTheCardIsDrawnFromAndNoMore() {
        val now = at("2026-10-06T04:00:00Z")
        val fresh = now.minusSeconds(10); val stale = now.minusSeconds(61)
        fun due(force: Boolean = false, moved: Boolean = false, stage: PromotionStage? = null, merged: Instant? = fresh, items: Instant? = fresh,
            criteria: Instant? = fresh) = ProjectMergePolls.due(force, moved, stage, now, merged, items, criteria)
        assertEquals(ProjectMergePolls.Due(merged = false, items = false, criteria = false), due())
        assertTrue("the merges are read when the candidate moved", due(moved = true).merged)
        assertTrue("and once a minute", due(merged = stale).merged)
        assertTrue("and on the first poll", due(merged = null).merged)
        assertFalse("the items are not read while nothing is blocked", due(items = stale).items)
        assertFalse(due(stage = PromotionStage.BLOCKED).items)
        assertTrue("every 20 s while it is blocked", due(stage = PromotionStage.BLOCKED, items = now.minusSeconds(21)).items)
        assertTrue(due(stage = PromotionStage.BLOCKED, moved = true).items)
        assertFalse("the criteria are read only while it asks", due(stage = PromotionStage.MERGING, criteria = stale).criteria)
        assertFalse(due(stage = PromotionStage.ASKING_YOU).criteria)
        assertTrue("once a minute while it asks", due(stage = PromotionStage.ASKING_YOU, criteria = stale).criteria)
        assertEquals("a pull to refresh reads everything the card is drawn from", ProjectMergePolls.Due(merged = true, items = true, criteria = true),
            due(force = true, stage = PromotionStage.ASKING_YOU))
    }
}
