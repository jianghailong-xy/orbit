package io.orbitd.android

import io.orbitd.android.directory.*
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
    }

    @Test fun tagGroupingUsesOnePrimaryTagPerSessionAndKeepsUntagged() {
        val a = Tag("a", "Later", position = 4); val b = Tag("b", "System", isSystem = true)
        val rows = listOf(DirectorySession("one", tags = listOf(a, b)), DirectorySession("two", tags = listOf(b)), DirectorySession("none"))
        val groups = directoryGroups(rows, SessionView.OPEN, Grouping.TAG)
        assertEquals(listOf("System", "Later", "Untagged"), groups.map { it.title })
        assertEquals(3, groups.sumOf { it.sessions.size })
    }
}
