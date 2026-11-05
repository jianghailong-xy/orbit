package io.orbitd.android.directory

import io.orbitd.android.R
import io.orbitd.android.core.protocol.SessionAction

/** A session row's actions (iOS `SessionRowActions`): what each is called on a swipe and in the long press's menu, and how it draws.
 * Rename… and Tags… are the menu's alone, so they have no glyph. */
internal enum class SessionRowAction(val title: String, val menuTitle: String, val icon: Int, val tint: RowActionTint, val destructive: Boolean = false) {
    COMPLETE("Complete", "Complete", R.drawable.ic_row_complete, RowActionTint.GREEN),
    MOVE_TO_OPEN("Move to Open", "Move to Open", R.drawable.ic_row_restore, RowActionTint.BLUE),
    PIN("Pin", "Pin", R.drawable.ic_row_pin, RowActionTint.INDIGO),
    UNPIN("Unpin", "Unpin", R.drawable.ic_row_unpin, RowActionTint.INDIGO),
    SHARE("Share", "Share…", R.drawable.ic_row_share, RowActionTint.BLUE),
    MOVE("Move", "Move…", R.drawable.ic_row_folder, RowActionTint.INDIGO),
    DELETE("Delete", "Delete", R.drawable.ic_row_trash, RowActionTint.RED, destructive = true),
    DELETE_PERMANENTLY("Delete Permanently", "Delete Permanently", R.drawable.ic_row_trash_slash, RowActionTint.RED, destructive = true),
    RENAME("Rename…", "Rename…", 0, RowActionTint.INDIGO),
    TAGS("Tags…", "Tags…", 0, RowActionTint.INDIGO),
}

/**
 * The one list a session row's swipe, long press and screen reader are drawn from (iOS `SessionRowActions`). Rename… and Tags… open an
 * editor rather than performing the action, which is not what a swipe promises, so they are the menu's alone.
 */
internal object SessionRowActionList {
    private fun positive(view: SessionView) = if (view == SessionView.OPEN) SessionRowAction.COMPLETE else SessionRowAction.MOVE_TO_OPEN
    private fun pin(s: DirectorySession) = if (s.pinnedAt == null) SessionRowAction.PIN else SessionRowAction.UNPIN
    /** A project's members are listed where its coordinator is, so of its sessions only the coordinator offers Move. */
    private fun moves(s: DirectorySession) = s.projectMembership?.isCoordinator != false

    /** From the screen edge inward; the first is what a full swipe performs. */
    fun leading(s: DirectorySession, view: SessionView): List<SessionRowAction> =
        if (view == SessionView.TRASH) listOf(positive(view)) else listOf(positive(view), pin(s))

    /** From the screen edge inward: left to right the row reads Share · Move · Delete. */
    fun trailing(s: DirectorySession, view: SessionView): List<SessionRowAction> =
        if (view == SessionView.TRASH) listOf(SessionRowAction.DELETE_PERMANENTLY)
        else listOfNotNull(SessionRowAction.DELETE, SessionRowAction.MOVE.takeIf { moves(s) }, SessionRowAction.SHARE)

    fun menu(s: DirectorySession, view: SessionView): List<SessionRowAction> =
        if (view == SessionView.TRASH) listOf(positive(view), SessionRowAction.DELETE_PERMANENTLY)
        else listOfNotNull(SessionRowAction.RENAME, pin(s), SessionRowAction.TAGS, positive(view), SessionRowAction.SHARE,
            SessionRowAction.MOVE.takeIf { moves(s) }, SessionRowAction.DELETE)

    /** A session that has not said what it can do can do it; the server's refusal says otherwise. */
    fun enabled(action: SessionRowAction, s: DirectorySession): Boolean = when (action) {
        SessionRowAction.COMPLETE -> s.capabilities?.allows(SessionAction.COMPLETE) ?: true
        SessionRowAction.MOVE_TO_OPEN -> s.capabilities?.allows(SessionAction.RESTORE) ?: true
        else -> true
    }

    /** What a press of [action] does on [s]: the writes are [actions]', the panels the list's, through [setDialog]. */
    fun press(action: SessionRowAction, s: DirectorySession, actions: SessionActions, setDialog: (DirectoryDialog?) -> Unit) {
        when (action) {
            SessionRowAction.COMPLETE -> actions.complete(s.id, s.title)
            SessionRowAction.MOVE_TO_OPEN -> actions.restore(s.id, s.title)
            SessionRowAction.PIN -> actions.pin(s.id, true)
            SessionRowAction.UNPIN -> actions.pin(s.id, false)
            SessionRowAction.SHARE -> setDialog(DirectoryDialog.Share(s))
            SessionRowAction.MOVE -> setDialog(DirectoryDialog.Move(s))
            SessionRowAction.DELETE -> actions.trash(s.id, s.title)
            SessionRowAction.DELETE_PERMANENTLY -> setDialog(DirectoryDialog.Purge(s))
            SessionRowAction.RENAME -> setDialog(DirectoryDialog.Rename(s))
            SessionRowAction.TAGS -> setDialog(DirectoryDialog.Tags(s))
        }
    }

    /** The row's swipe and screen reader actions. */
    fun rowActions(s: DirectorySession, view: SessionView, actions: SessionActions, setDialog: (DirectoryDialog?) -> Unit): RowActions {
        fun side(listed: List<SessionRowAction>) = listed.map { action ->
            RowAction(action.title, action.icon, action.tint, enabled(action, s)) { press(action, s, actions, setDialog) }
        }
        val leading = leading(s, view)
        return RowActions(side(leading), side(trailing(s, view)), leadingFullSwipe = enabled(leading.first(), s))
    }

    /** A project row's (iOS `SessionProjectRowActions`): Pin and Move act on its coordinator, and without one it has neither. */
    fun projectRowActions(row: SessionProjectRow, pin: (DirectorySession) -> Unit, move: (DirectorySession) -> Unit): RowActions {
        val coordinator = row.coordinator ?: return RowActions(emptyList(), emptyList(), false)
        val pinAction = if (coordinator.pinnedAt == null) SessionRowAction.PIN else SessionRowAction.UNPIN
        return RowActions(listOf(RowAction(pinAction.title, pinAction.icon, pinAction.tint) { pin(coordinator) }),
            listOf(RowAction(SessionRowAction.MOVE.title, SessionRowAction.MOVE.icon, SessionRowAction.MOVE.tint) { move(coordinator) }), leadingFullSwipe = true)
    }
}
