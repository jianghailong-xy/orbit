package io.orbitd.android

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.*
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitNavigation
import io.orbitd.android.navigation.OrbitRoute
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class DirectoryGroupingTest {
    private val now = Instant.parse("2026-10-04T00:30:00Z")
    @Test fun bucketsUseLocalCalendarDaysAndHonorPinsOnlyInOpen() {
        val data = listOf(
            DirectorySession("pin", pinnedAt = "2026-01-01"),
            DirectorySession("future", createdAt = "2026-10-05T00:00:00Z"),
            DirectorySession("today", createdAt = "2026-10-03T17:00:00Z"),
            DirectorySession("yesterday", createdAt = "2026-10-03T00:00:00Z"),
            DirectorySession("week", createdAt = "2026-09-27T00:00:00Z"),
            DirectorySession("month", createdAt = "2026-09-04T00:00:00Z"),
            DirectorySession("old", createdAt = "invalid"))
        val groups = directoryGroups(data, SessionView.OPEN, Grouping.RECENCY, now, ZoneId.of("Asia/Shanghai"))
        assertEquals(listOf("Pinned", "Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older"), groups.map { it.title })
        assertEquals(listOf("future", "today"), groups[1].sessions.map { it.id })
        assertFalse(directoryGroups(data, SessionView.COMPLETED, Grouping.RECENCY, now).any { it.title == "Pinned" })
    }

    @Test fun foldersDoNotDuplicateRowsAndDeletedFoldersDoNotHideSessions() {
        val folders = listOf(Folder("f", "w", "Research"))
        val sessions = listOf(DirectorySession("a", agent = WorkspaceRef("w"), folderId = "f"),
            DirectorySession("b", workspaceId = "w", folderId = "gone"), DirectorySession("c", agentId = "w"),
            DirectorySession("d", agentId = "other"))
        assertEquals(listOf("b", "c"), visibleSessions(sessions, folders, "w", null, SessionView.OPEN, null).map { it.id })
        assertEquals(listOf("a"), visibleSessions(sessions, folders, "w", "f", SessionView.OPEN, null).map { it.id })
        assertEquals(3, visibleSessions(sessions, folders, "w", null, SessionView.TRASH, null).size)
        assertEquals(3, visibleSessions(sessions, folders, "w", null, SessionView.OPEN, null, byTag = true).size)
    }

    @Test fun scheduledRunsAreKeptOnlyOnTheirWorkspaceFolderPage() {
        val run = Wire.decode(
            """{"id":"run","agent":{"id":"w"},"folderId":"f","runSource":"SCHEDULE"}""".encodeToByteArray(),
            DirectorySession.serializer(),
        )
        val rows = listOf(run, run.copy(id = "elsewhere", workspaceId = "other"), run.copy(id = "manual", runSource = "MANUAL"),
            run.copy(id = "legacy", runSource = null))
        assertEquals(listOf("manual", "legacy"), rows.withoutScheduledRuns().map { it.id })
        assertEquals(listOf(run), ScheduledRunsFolder.sessions(rows, "w"))
    }

    @Test fun aChangeConversationIsNoRunAndShowsInNoList() {
        // A SCHEDULE_CHANGE session (§8.2): a realtime upsert can bring a row in, and it must not appear in an ordinary
        // list or count — exactly where a SCHEDULE run is kept out — nor in the Scheduled runs folder, which it is not.
        val change = DirectorySession("change", workspaceId = "w", runSource = "SCHEDULE_CHANGE")
        assertTrue(change.isScheduleChange)
        assertFalse(change.isScheduledRun)
        val rows = listOf(change, DirectorySession("manual", workspaceId = "w"))
        assertEquals(listOf("manual"), rows.withoutScheduledRuns().map { it.id })
        assertEquals(emptyList<DirectorySession>(), ScheduledRunsFolder.sessions(rows, "w"))
    }

    @Test fun scheduledFolderShowsWithRunsInFolderViewsAndCountsSessionsNeedingReply() {
        val rows = listOf(
            DirectorySession("running", status = "RUNNING", workspaceId = "w", runSource = "SCHEDULE"),
            DirectorySession("waiting", pendingApprovals = 3, workspaceId = "w", runSource = "SCHEDULE"),
            DirectorySession("start", pendingApprovals = 1, waitingKind = "START_REQUEST", workspaceId = "w", runSource = "SCHEDULE"),
            DirectorySession("parked", status = "AWAITING_INPUT", engineTurnActive = true, workspaceId = "w", runSource = "SCHEDULE"),
        )
        val sessions = ScheduledRunsFolder.sessions(rows, "w")
        for (view in listOf(SessionView.OPEN, SessionView.COMPLETED)) {
            val show = listShowsFolders(false, view, null, Grouping.RECENCY)
            assertEquals(FolderRowSummary(4, 1, true), ScheduledRunsFolder.row(sessions, show))
            assertNull(ScheduledRunsFolder.row(emptyList(), show))
        }
        assertEquals(FolderRowSummary(3, 1, false), ScheduledRunsFolder.row(sessions.drop(1), true))
        assertNull(ScheduledRunsFolder.row(sessions, listShowsFolders(false, SessionView.TRASH, null, Grouping.RECENCY)))
        assertNull(ScheduledRunsFolder.row(sessions, listShowsFolders(false, SessionView.OPEN, "tag", Grouping.RECENCY)))
        assertNull(ScheduledRunsFolder.row(sessions, listShowsFolders(false, SessionView.OPEN, null, Grouping.TAG)))
        assertNull(ScheduledRunsFolder.row(sessions, listShowsFolders(true, SessionView.OPEN, null, Grouping.RECENCY)))
    }

    @Test fun backFromRunKeepsTheFolderAndItsView() {
        val workspace = OrbitRoute(Destination.WORKSPACE, "w")
        val folder = OrbitRoute(Destination.FOLDER, ScheduledRunsFolder.ID, "w", sessionView = SessionView.COMPLETED.query)
        val run = OrbitRoute(Destination.SESSION, "run", "w")
        val nav = OrbitNavigation().select("w", workspace).push(folder).push(run)
        assertEquals(folder, nav.back().current)
        assertEquals(workspace, nav.back().back().current)
    }

    @Test fun tagGroupingUsesOnePrimaryTagPerSessionAndKeepsUntagged() {
        val a = Tag("a", "Later", position = 4); val b = Tag("b", "System", isSystem = true)
        val rows = listOf(DirectorySession("one", tags = listOf(a, b)), DirectorySession("two", tags = listOf(b)), DirectorySession("none"))
        val groups = directoryGroups(rows, SessionView.OPEN, Grouping.TAG)
        assertEquals(listOf("System", "Later", "Untagged"), groups.map { it.title })
        assertEquals(3, groups.sumOf { it.sessions.size })
    }

    @Test fun tagIdentitySurvivesRenameAndCannotCollideWithSyntheticBucket() {
        fun groups(name: String) = directoryGroups(listOf(DirectorySession("a", tags = listOf(Tag("t", name))),
            DirectorySession("b")), SessionView.OPEN, Grouping.TAG)
        val before = groups("Untagged")
        assertEquals(listOf("Untagged", "Untagged"), before.map { it.title })
        assertEquals(2, before.map { it.id }.distinct().size)
        assertEquals(before.map { it.id }, groups("Renamed").map { it.id })
    }

    private fun failed(id: String, vararg facts: Pair<String, Any?>): DirectorySession {
        val f = facts.toMap()
        return DirectorySession(id, createdAt = "2026-10-03T17:00:00Z", status = "FAILED", phase = f["phase"] as String?,
            released = f["released"] as Boolean?, lastTurnOutcome = f["outcome"] as String?, endReason = f["endReason"] as String?,
            retryAt = f["retryAt"] as String?)
    }
    private fun needsYou(s: DirectorySession) =
        directoryGroups(listOf(s), SessionView.OPEN, Grouping.RECENCY, now, ZoneId.of("UTC")).first().title == "Needs you"

    @Test fun anEndTheRunnerNeverConfirmedIsNotUnderNeedsYou() =
        assertFalse(needsYou(failed("a", "phase" to "IDLE", "released" to true, "outcome" to "FAILED", "endReason" to "user_ended")))

    @Test fun aRealFailureIsUnderNeedsYou() =
        assertTrue(needsYou(failed("a", "phase" to "IDLE", "released" to true, "outcome" to "FAILED")))

    @Test fun aFailureBeingRetriedIsNotUnderNeedsYou() =
        assertFalse(needsYou(failed("a", "phase" to "IDLE", "released" to true, "outcome" to "FAILED", "retryAt" to "2026-10-04T01:00:00Z")))

    @Test fun factsAbsentGroupsAsBefore() {
        assertTrue(needsYou(failed("a", "endReason" to "user_ended")))
        assertFalse(needsYou(failed("a", "retryAt" to "2026-10-04T01:00:00Z")))
    }
}
