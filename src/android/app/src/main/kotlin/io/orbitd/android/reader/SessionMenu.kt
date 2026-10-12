package io.orbitd.android.reader

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import io.orbitd.android.R
import io.orbitd.android.core.protocol.SessionAction
import io.orbitd.android.directory.DirectoryDialog
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SessionActions
import io.orbitd.android.directory.SessionView
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.Origin
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.taskprojects.SharePanelCopy
import io.orbitd.android.tasks.resolvedRunState
import io.orbitd.android.toast.OrbitToasts
import kotlinx.serialization.json.JsonObject

/** A run that is live — queued, running, waiting for input or interrupted — is what completing the session or moving it
 * to Trash stops (OrbitKit `SessionRunState.isLive`). */
private val LIVE = setOf("QUEUED", "RUNNING", "AWAITING_INPUT", "INTERRUPTED")

/**
 * The session page's ⋯ in the bar (iOS d2858a5e8, `ConsoleView.sessionMenu`), in iOS's order: Share… and Copy Link;
 * Rename…, Pin, Move… and Tags…; Open Task or Open Project for a session one of them runs; Complete Session, or Move to
 * Open for a completed one; Move to Trash. A trashed session offers only Move to Open and, asked first, Delete
 * Permanently. What would stop a live run says so. Its writes wait for a fresh session and directory ([writable]), as
 * every Android write does; [left] takes the page away once the session is completed or in Trash.
 */
@Composable
internal fun SessionMenu(session: DirectorySession?, detail: JsonObject?, link: String, writable: Boolean, actions: SessionActions,
    open: (OrbitRoute) -> Unit, dialog: (DirectoryDialog) -> Unit, left: () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    Box {
        IconButton(onClick = { expanded = true }, enabled = session != null) { Icon(painterResource(R.drawable.ic_more), "Session actions") }
        if (session != null) DropdownMenu(expanded, { expanded = false }, Modifier.testTag("session-menu")) {
            fun press(action: () -> Unit): () -> Unit = { expanded = false; action() }
            val view = SessionView.entries.firstOrNull { it.name == session.lifecycleState } ?: SessionView.OPEN
            val restorable = writable && session.capabilities?.allows(SessionAction.RESTORE) != false
            val restore = press { actions.restore(session.id, session.title) }
            if (view == SessionView.TRASH) {
                Item("Move to Open", restorable, onClick = restore)
                HorizontalDivider()
                Item("Delete Permanently", writable, danger = true, onClick = press { dialog(DirectoryDialog.Purge(session)) })
            } else {
                val stops = if (detail?.let(::resolvedRunState) in LIVE) "Stops the current run" else null
                Item(SharePanelCopy.share, onClick = press { dialog(DirectoryDialog.Share(session)) })
                Item(SharePanelCopy.copyLink, onClick = press { clipboard.setText(AnnotatedString(link)); OrbitToasts.show(SharePanelCopy.linkCopied) })
                HorizontalDivider()
                Item("Rename…", writable, onClick = press { dialog(DirectoryDialog.Rename(session)) })
                Item(if (session.pinnedAt == null) "Pin" else "Unpin", writable, onClick = press { actions.pin(session.id, session.pinnedAt == null) })
                Item("Move…", writable && session.workspace != null, onClick = press { dialog(DirectoryDialog.Move(session)) })
                Item("Tags…", writable, onClick = press { dialog(DirectoryDialog.Tags(session)) })
                val task = detail?.string("taskId")
                val project = detail?.string("projectId")
                if (task != null || project != null) {
                    HorizontalDivider()
                    if (task != null) Item("Open Task", onClick = press { open(OrbitRoute(Destination.TASK, task, origin = Origin.LINK)) })
                    else Item("Open Project", onClick = press { open(OrbitRoute(Destination.PROJECT, project, origin = Origin.LINK)) })
                }
                HorizontalDivider()
                if (view == SessionView.COMPLETED) Item("Move to Open", restorable, onClick = restore)
                else Item("Complete Session", writable && session.capabilities?.allows(SessionAction.COMPLETE) != false, stops,
                    onClick = press { actions.complete(session.id, session.title, left) })
                HorizontalDivider()
                Item("Move to Trash", writable, stops, danger = true, onClick = press { actions.trash(session.id, session.title, left) })
            }
        }
    }
}

/** One of the menu's actions, with what it would stop under it. */
@Composable
private fun Item(title: String, enabled: Boolean = true, note: String? = null, danger: Boolean = false, onClick: () -> Unit) {
    DropdownMenuItem(text = {
        Column {
            Text(title, color = if (danger && enabled) MaterialTheme.colorScheme.error else Color.Unspecified)
            note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }, onClick = onClick, enabled = enabled)
}
