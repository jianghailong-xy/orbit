package io.orbitd.android.directory

import io.orbitd.android.core.cards.PromotionStage
import io.orbitd.android.projects.ProjectPage
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The merge into main on the project's sessions page (iOS 6b4bef713's ProjectMergeCardTests): the card under the progress card,
 * the merge check's line moving into it, the page's timeline of sessions, and how often the page reads the merge. */
class ProjectMergeTest {
    private fun candidate(state: String, conflicts: List<String> = emptyList()) = Json.parseToJsonElement("""{"promotionId":"pr-1","state":"$state",
        "sourceRef":"refs/heads/project/34ZurCP3bv9yLXGVyUGnx","sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main","taskIds":["t1","t2"],
        "conflicts":${conflicts.joinToString(",", "[", "]") { "\"$it\"" }}}""").jsonObject
    private fun integration(kind: String?, state: String = "RUNNING") = Json.parseToJsonElement("""{"integratingCount":1,"queuedCount":0,
        "inFlight":{"state":"$state","startedAt":"2026-10-06T03:20:00Z"${kind?.let { ",\"kind\":\"$it\"" }.orEmpty()},"phase":"CHECK"}}""").jsonObject
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
        // A task landing on the project branch is the landing card's, and a merge already made is the timeline's: neither draws it.
        assertNull(ProjectMergeCard.shape(null, integration("LAND_TASK")))
        assertNull(ProjectMergeCard.shape(candidate("MERGED"), null))
        assertNull(ProjectMergeCard.shape(candidate("DECLINED"), null))
        assertNull(ProjectMergeCard.shape(null, null))
    }

    /** The page's two cards split the kinds between them (iOS 749d995c5): a task landing on the project branch is the landing card's,
     * a job about main is the merge card's. */
    @Test fun theMergeJobsMoveFromTheLandingCardIntoTheMergeCard() {
        val now = at("2026-10-06T03:24:00Z")
        for (kind in listOf("CHECK_PROMOTION", "LAND_PROMOTION")) {
            val view = integration(kind)
            assertNull(kind, ProjectMergeCard.taskLandingCard(view, now, now, false))
            assertEquals(kind, ProjectPage.landingLine(view, now, now, false), ProjectMergeCard.mergeLandingLine(view, now, now, false))
        }
        val task = integration("LAND_TASK")
        assertEquals(ProjectPage.landingCard(task, now, now, false), ProjectMergeCard.taskLandingCard(task, now, now, false))
        assertNull(ProjectMergeCard.mergeLandingLine(task, now, now, false))
        // An older server names no kind: the card stays where it always was.
        assertNotNull(ProjectMergeCard.taskLandingCard(integration(null), now, now, false))
        assertEquals("Merge check", ProjectMergeCard.mergeLandingLine(integration("CHECK_PROMOTION"), now, now, false)?.word)
    }

    // MARK: who is in front of a blocked merge (iOS befc9694c's ProjectMergeCardTests)

    /** The project's current landings, as `integration.landTasks` serves them: one landing on the project branch by default. */
    private fun landings(title: String = "同步项目线与 main：解开迁移台账冲突", state: String = "QUEUED", phase: String? = null,
        targetRef: String = "refs/heads/project/34ZurCP3bv9yLXGVyUGnx",
        summary: String? = "Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” is running on this branch first") = buildJsonObject {
        putJsonArray("landTasks") { addJsonObject {
            put("taskId", "t9"); put("taskTitle", title)
            putJsonObject("integration") { putJsonObject("landTask") {
                put("jobId", "job-9"); put("state", state); put("phase", phase); put("targetRef", targetRef)
                summary?.let { putJsonObject("blockingReason") { put("code", "WAITING_SERIAL_SLOT"); put("summary", it) } }
            } }
        } }
    }

    /** The owner's report of 2026-10-08: the card said "1 file conflict" and "Coordinator is resolving it", and never what the merge was
     * behind — a landing on the project branch, itself queued behind another task's landing. Both links are in the project's own read. */
    @Test fun theBlockedCardNamesTheLandingHoldingTheBranchAndWhatHoldsIt() {
        val blocked = candidate("BLOCKED", listOf("a.go"))
        assertEquals("“同步项目线与 main：解开迁移台账冲突” is landing on the project line · queued · " +
            "Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” is running on this branch first", ProjectMergeCard.blockedByLine(blocked, landings()))
        // Running says which step the runner reported, in the same words the landing line uses.
        assertEquals("“同步项目线与 main：解开迁移台账冲突” is landing on the project line · syncing main · " +
            "Waiting to land: the landing of “修合并树上的 11 个 Swift 失败” is running on this branch first",
            ProjectMergeCard.blockedByLine(blocked, landings(state = "RUNNING", phase = "MAIN_SYNC")))
        assertEquals("“同步项目线与 main：解开迁移台账冲突” is landing on the project line · running",
            ProjectMergeCard.blockedByLine(blocked, landings(state = "RUNNING", summary = null)))
        // With no reason from the server the sentence stops at what it does know.
        assertEquals("“同步项目线与 main：解开迁移台账冲突” is landing on the project line · queued", ProjectMergeCard.blockedByLine(blocked, landings(summary = null)))
        assertEquals("Blocked by", ProjectMergeCard.blockedByLabel)
    }

    /** Nothing to name is said as nothing: an invented step would be worse than the sentence the card already had. */
    @Test fun theBlockedCardSaysNothingWhenTheLineIsDoingNothingOnItsBranches() {
        val blocked = candidate("BLOCKED", listOf("a.go"))
        assertNull(ProjectMergeCard.blockedByLine(blocked, buildJsonObject { putJsonArray("landTasks") {} }))
        assertNull("a server that predates landTasks", ProjectMergeCard.blockedByLine(blocked, buildJsonObject { put("integratingCount", 1) }))
        assertNull("nothing read yet", ProjectMergeCard.blockedByLine(blocked, null))
        assertNull(ProjectMergeCard.blockedByLine(blocked, landings(targetRef = "refs/heads/orbit/elsewhere")))
        // A landing that has stopped holds nothing: the line is idle, and this row is not the place its failure is reported.
        assertNull(ProjectMergeCard.blockedByLine(blocked, landings(state = "CONFLICT")))
        // `refs/heads/x` and `x` are one branch, and the upstream is one of the branches the merge goes through.
        assertNotNull(ProjectMergeCard.blockedByLine(blocked, landings(targetRef = "project/34ZurCP3bv9yLXGVyUGnx")))
        assertNotNull(ProjectMergeCard.blockedByLine(candidate("BLOCKED"), landings(targetRef = "refs/heads/main")))
    }

    /** The page's timeline is its sessions alone (owner 2026-10-27): the merges into main are rows of the project's Landings window,
     * and the sections are the list's own recency grouping (OrbitKit `testTheTimelineIsTheSessionGroupingWithoutPinned`). */
    @Test fun theTimelineIsTheSessionGroupingWithoutPinned() {
        val sessions = listOf(session("s-now", "2026-10-06T03:58:00Z"), session("s-log", "2026-10-06T03:12:00Z"),
            session("s-old", "2026-10-03T08:00:00Z"), session("s-ancient", "2026-09-01T00:00:00Z"))
        val now = at("2026-10-06T04:01:00Z")
        val out = ProjectTimeline.sections(sessions, now, ZoneOffset.UTC)
        assertEquals(listOf("Today", "2–7 days ago", "Older"), out.map { it.title })
        assertEquals(listOf("s-now", "s-log"), out[0].sessions.map { it.id })
        val grouping = directoryGroups(sessions, SessionView.COMPLETED, Grouping.RECENCY, now, ZoneOffset.UTC)
        assertEquals(grouping.map { it.title }, out.map { it.title })
        assertEquals(grouping.flatMap { g -> g.sessions.map { it.id } }, out.flatMap { s -> s.sessions.map { it.id } })
        assertEquals(grouping.map { it.id }, out.map { it.id })
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
