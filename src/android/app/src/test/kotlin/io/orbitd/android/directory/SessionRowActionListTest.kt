package io.orbitd.android.directory

import io.orbitd.android.core.protocol.SessionCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** iOS `SessionRowActions`: what each side of a row's swipe holds in each scope, and the long press's menu, from one list. */
class SessionRowActionListTest {
    private fun session(pinned: Boolean = false, capabilities: SessionCapabilities? = SessionCapabilities(canComplete = true, canRestore = false),
        role: String? = null) = DirectorySession(id = "34RowActionSession0001", title = "Notes", pinnedAt = if (pinned) "2026-10-01T00:00:00Z" else null,
        capabilities = capabilities, projectMembership = role?.let { SessionProjectMembership("34RowActionProject0001", role = it) })
    private fun titles(actions: List<SessionRowAction>) = actions.map { it.title }

    @Test fun openSwipesShowCompleteAndPinThenShareMoveDelete() {
        assertEquals(listOf("Complete", "Pin"), titles(SessionRowActionList.leading(session(), SessionView.OPEN)))
        // From the screen edge inward: left to right the row reads Share · Move · Delete.
        assertEquals(listOf("Delete", "Move", "Share"), titles(SessionRowActionList.trailing(session(), SessionView.OPEN)))
        assertEquals(listOf("Complete", "Unpin"), titles(SessionRowActionList.leading(session(pinned = true), SessionView.OPEN)))
    }

    @Test fun completedMovesBackToOpenAndSwipesLeftAsOpenDoes() {
        val done = session(capabilities = SessionCapabilities(canComplete = false, canRestore = true))
        assertEquals(listOf("Move to Open", "Pin"), titles(SessionRowActionList.leading(done, SessionView.COMPLETED)))
        assertEquals(listOf("Delete", "Move", "Share"), titles(SessionRowActionList.trailing(done, SessionView.COMPLETED)))
        assertTrue(SessionRowActionList.enabled(SessionRowAction.MOVE_TO_OPEN, done))
    }

    @Test fun trashHasMoveToOpenAndDeletePermanentlyAlone() {
        val trashed = session(capabilities = SessionCapabilities(canRestore = true))
        assertEquals(listOf("Move to Open"), titles(SessionRowActionList.leading(trashed, SessionView.TRASH)))
        assertEquals(listOf("Delete Permanently"), titles(SessionRowActionList.trailing(trashed, SessionView.TRASH)))
        assertEquals(listOf("Move to Open", "Delete Permanently"), SessionRowActionList.menu(trashed, SessionView.TRASH).map { it.menuTitle })
    }

    @Test fun aProjectsMemberHasNoMoveButItsCoordinatorDoes() {
        assertEquals(listOf("Delete", "Share"), titles(SessionRowActionList.trailing(session(role = "TASK"), SessionView.OPEN)))
        assertEquals(listOf("Delete", "Move", "Share"), titles(SessionRowActionList.trailing(session(role = "COORDINATOR"), SessionView.OPEN)))
        assertFalse(SessionRowActionList.menu(session(role = "TASK"), SessionView.OPEN).contains(SessionRowAction.MOVE))
    }

    /** The menu holds the swipe's actions and Rename… and Tags…, which open an editor and so are the menu's alone. */
    @Test fun theMenuIsTheSameListInIosOrder() {
        assertEquals(listOf("Rename…", "Pin", "Tags…", "Complete", "Share…", "Move…", "Delete"),
            SessionRowActionList.menu(session(), SessionView.OPEN).map { it.menuTitle })
        assertEquals(listOf("Rename…", "Unpin", "Tags…", "Move to Open", "Share…", "Move…", "Delete"),
            SessionRowActionList.menu(session(pinned = true), SessionView.COMPLETED).map { it.menuTitle })
        for (view in SessionView.entries) {
            val swiped = SessionRowActionList.leading(session(), view) + SessionRowActionList.trailing(session(), view)
            assertFalse(swiped.contains(SessionRowAction.RENAME) || swiped.contains(SessionRowAction.TAGS))
            assertTrue("every swiped action is in the menu too", SessionRowActionList.menu(session(), view).containsAll(swiped))
        }
        assertEquals(listOf(SessionRowAction.DELETE), SessionRowActionList.menu(session(), SessionView.OPEN).filter { it.destructive })
    }

    /** A session that can't do it keeps the button, off; one that has not said can, as iOS's `?? true`, and the server says otherwise. */
    @Test fun whatASessionCannotDoIsOffAndWhatItHasNotSaidIsOn() {
        val held = session(capabilities = SessionCapabilities(canComplete = false))
        assertFalse(SessionRowActionList.enabled(SessionRowAction.COMPLETE, held))
        assertTrue(SessionRowActionList.leading(held, SessionView.OPEN).contains(SessionRowAction.COMPLETE))
        assertTrue(SessionRowActionList.enabled(SessionRowAction.COMPLETE, session(capabilities = null)))
        assertTrue(SessionRowActionList.enabled(SessionRowAction.MOVE_TO_OPEN, session(capabilities = null)))
        assertTrue(SessionRowActionList.enabled(SessionRowAction.DELETE, held))
    }
}
