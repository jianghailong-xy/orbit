package io.orbitd.android.directory

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.protocol.SessionAction
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.failureReason
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastGlyph
import io.orbitd.android.toast.ToastTone
import io.orbitd.android.toast.toastTitle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

sealed interface DirectoryDialog {
    data class SessionMenu(val session: DirectorySession, val view: SessionView) : DirectoryDialog
    data class Rename(val session: DirectorySession) : DirectoryDialog
    data class Purge(val session: DirectorySession) : DirectoryDialog
    data class Tags(val session: DirectorySession) : DirectoryDialog
    data class Move(val session: DirectorySession) : DirectoryDialog
    data class ConfirmMove(val session: DirectorySession, val targets: MoveTargets, val target: MoveTarget, val folder: MoveFolder?) : DirectoryDialog
    data class Share(val session: DirectorySession) : DirectoryDialog
    data class NewFolder(val workspace: String) : DirectoryDialog
    data class EditFolder(val folder: Folder) : DirectoryDialog
    data class DeleteFolder(val folder: Folder) : DirectoryDialog
}

@Composable
fun DirectoryActionDialog(dialog: DirectoryDialog, api: DirectoryApi, data: DirectoryData,
    setDialog: (DirectoryDialog?) -> Unit, onChanged: () -> Unit) = key(dialog) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var phase by remember { mutableStateOf<String?>(null) }
    val canWrite = !busy && data.fresh
    // Complete, Move to Open, Move to Trash, Rename and a folder move close the dialog at once; the toast says how they
    // went (A05-4), so their requests run in the app's scope rather than this dialog's.
    val app = LocalContext.current.applicationContext as OrbitApplication
    val changed by rememberUpdatedState(onChanged)
    val actions = remember(api) { SessionActions(api, app.processScope) { changed() } }
    var draft by remember { mutableStateOf(when (dialog) {
        is DirectoryDialog.Rename -> dialog.session.title.orEmpty()
        is DirectoryDialog.EditFolder -> dialog.folder.name
        else -> ""
    }) }
    fun perform(next: DirectoryDialog? = null, describe: (Exception) -> String = ::directoryError, block: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try { block(); onChanged(); setDialog(next) }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = (failure as? DirectoryMoveFailure)?.message ?: describe(failure) }
            finally { busy = false; phase = null }
        }
    }
    // A press that deletes, or moves a session's conversation elsewhere, asks as every confirmation on a phone does (iOS 6969f7840):
    // the question, what it does, and the press beside Cancel.
    val question: DirectoryQuestion? = when (dialog) {
        is DirectoryDialog.Purge -> DirectoryQuestion("Delete permanently?",
            "This session and its full transcript will be permanently deleted. This can't be undone.", "Delete Permanently", destructive = true) {
            perform { api.delete(dialog.session.id, true) }
        }
        is DirectoryDialog.DeleteFolder -> DirectoryQuestion(MoveCopy.deleteFolderTitle(dialog.folder.name), MoveCopy.DELETE_FOLDER_MESSAGE,
            MoveCopy.DELETE_FOLDER_CONFIRM, destructive = true) { perform { api.deleteFolder(dialog.folder.id) } }
        is DirectoryDialog.ConfirmMove -> {
            val from = data.workspaces.firstOrNull { ObjectId.same(it.id, dialog.session.workspace) }?.name ?: "this workspace"
            DirectoryQuestion(MoveCopy.confirmTitle(dialog.target), MoveCopy.confirmMessage(dialog.targets, dialog.target, from),
                MoveCopy.confirmAction(dialog.targets), destructive = false) {
                perform(describe = { "Couldn't move the session\n${failureReason(it)}" }) {
                    moveToWorkspace(api, dialog.session.id, dialog.target.workspaceId, dialog.folder?.id, dialog.targets.needsEnd, phase = { phase = it })
                    OrbitToasts.show("Moved to ${dialog.target.name}", toastTitle(dialog.session.title), dialog.session.id,
                        tone = ToastTone.INFO, glyph = ToastGlyph.FOLDER)
                }
            }
        }
        else -> null
    }
    if (question != null) {
        AlertDialog(onDismissRequest = { if (!busy) setDialog(null) }, title = { Text(question.title) },
            text = {
                Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(question.message)
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (!data.fresh) Text("Refresh the directory before making changes.")
                    if (busy) LoadingMessage(phase ?: "Saving…")
                }
            },
            confirmButton = { TextButton(onClick = question.press, enabled = canWrite) {
                Text(question.action, color = if (question.destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            } },
            dismissButton = { TextButton(onClick = { setDialog(null) }, enabled = !busy) { Text("Cancel") } })
    } else {
        val title = when (dialog) {
            is DirectoryDialog.SessionMenu -> dialog.session.name
            is DirectoryDialog.Rename -> "Rename session"
            is DirectoryDialog.Tags -> "Tags"
            is DirectoryDialog.Move -> "Move session"
            is DirectoryDialog.Share -> "Share session"
            is DirectoryDialog.NewFolder -> "New folder"
            is DirectoryDialog.EditFolder -> "Folder options"
            is DirectoryDialog.Purge, is DirectoryDialog.DeleteFolder, is DirectoryDialog.ConfirmMove -> ""
        }
        AlertDialog(onDismissRequest = { if (!busy) setDialog(null) }, title = { Text(title) },
            confirmButton = { TextButton(onClick = { setDialog(null) }, enabled = !busy) { Text("Close") } },
            text = {
                Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (!data.fresh) Text("Refresh the directory before making changes.")
                    if (busy) LoadingMessage("Saving…")
                    when (dialog) {
                        is DirectoryDialog.SessionMenu -> {
                            val s = dialog.session
                            if (dialog.view != SessionView.TRASH) {
                                ActionButton("Rename", canWrite) { setDialog(DirectoryDialog.Rename(s)) }
                                ActionButton(if (s.pinnedAt == null) "Pin" else "Unpin", canWrite) { perform { api.pin(s.id, s.pinnedAt == null) } }
                                ActionButton("Tags…", canWrite) { setDialog(DirectoryDialog.Tags(s)) }
                            }
                            val positive = if (dialog.view == SessionView.OPEN) SessionAction.COMPLETE else SessionAction.RESTORE
                            val allowed = data.fresh && s.capabilities?.allows(positive) == true
                            ActionButton(if (positive == SessionAction.COMPLETE) "Complete" else "Move to Open", !busy && allowed) {
                                setDialog(null)
                                if (positive == SessionAction.COMPLETE) actions.complete(s.id, s.title) else actions.restore(s.id, s.title)
                            }
                            if (!allowed) Text("This action isn't available in the current session state.", style = MaterialTheme.typography.bodySmall)
                            if (dialog.view != SessionView.TRASH) {
                                ActionButton("Share…", canWrite) { setDialog(DirectoryDialog.Share(s)) }
                                // A project's members are listed where its coordinator is, so of its sessions only the coordinator offers Move… (A05-6).
                                if (s.projectMembership?.isCoordinator != false) ActionButton("Move…", canWrite) { setDialog(DirectoryDialog.Move(s)) }
                            }
                            ActionButton(if (dialog.view == SessionView.TRASH) "Delete Permanently…" else "Move to Trash", canWrite) {
                                if (dialog.view == SessionView.TRASH) setDialog(DirectoryDialog.Purge(s))
                                else { setDialog(null); actions.trash(s.id, s.title) }
                            }
                        }
                        is DirectoryDialog.Rename -> {
                            OutlinedTextField(draft, { draft = it }, Modifier.fillMaxWidth(), label = { Text("Session name") })
                            ActionButton("Save", canWrite && draft.isNotBlank()) { setDialog(null); actions.rename(dialog.session.id, dialog.session.title, draft) }
                        }
                        is DirectoryDialog.Tags -> {
                            var selected by remember { mutableStateOf(dialog.session.tags.map { it.id }.toSet()) }
                            data.tags.forEach { tag ->
                                Row(Modifier.fillMaxWidth().toggleable(value = tag.id in selected, enabled = canWrite, role = Role.Checkbox,
                                    onValueChange = { checked -> selected = if (checked) selected + tag.id else selected - tag.id }), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Checkbox(tag.id in selected, null, enabled = canWrite)
                                    Text(tag.name, Modifier.padding(top = 12.dp))
                                }
                            }
                            ActionButton("Save tags", canWrite) { perform { api.setTags(dialog.session.id, selected) } }
                            OutlinedTextField(draft, { draft = it.take(40) }, Modifier.fillMaxWidth(), label = { Text("New tag") })
                            ActionButton("Create tag", canWrite && draft.isNotBlank()) { perform { api.createTag(draft) } }
                        }
                        is DirectoryDialog.NewFolder, is DirectoryDialog.EditFolder -> {
                            OutlinedTextField(draft, { draft = it.take(60) }, Modifier.fillMaxWidth(), label = { Text("Folder name") })
                            ActionButton("Save", canWrite && draft.isNotBlank()) { perform {
                                if (dialog is DirectoryDialog.NewFolder) api.createFolder(dialog.workspace, draft)
                                if (dialog is DirectoryDialog.EditFolder) api.renameFolder(dialog.folder.id, draft)
                            } }
                            if (dialog is DirectoryDialog.EditFolder) ActionButton("Delete folder…", canWrite) { setDialog(DirectoryDialog.DeleteFolder(dialog.folder)) }
                        }
                        is DirectoryDialog.Move -> MoveChoices(dialog.session, api, canWrite, setDialog) { folder, from ->
                            setDialog(null); actions.file(dialog.session.id, dialog.session.title, folder, from)
                        }
                        is DirectoryDialog.Share -> io.orbitd.android.management.SessionSharePanel(dialog.session.id)
                        is DirectoryDialog.Purge, is DirectoryDialog.DeleteFolder, is DirectoryDialog.ConfirmMove -> Unit
                    }
                }
            })
    }
}

/** Where a session can go: a folder of its workspace (or none) — [file] with the folder and the one it leaves — or another
 * workspace, which asks first. */
@Composable
private fun MoveChoices(session: DirectorySession, api: DirectoryApi, enabled: Boolean,
    setDialog: (DirectoryDialog?) -> Unit, file: (MoveFolder?, MoveFolder?) -> Unit) {
    var targets by remember { mutableStateOf<MoveTargets?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    LaunchedEffect(session.id, retry) {
        error = null
        try { targets = api.moveTargets(session.id) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = directoryError(failure) }
    }
    error?.let { StatusMessage("Move unavailable", it, { retry++ }) }
    if (targets == null && error == null) LoadingMessage("Loading destinations…")
    targets?.let { result ->
        Text("In this workspace", style = MaterialTheme.typography.titleMedium)
        val current = result.folders.firstOrNull { ObjectId.same(it.id, result.folderId) }
        ActionButton("No folder", enabled && result.folderId != null) { file(null, current) }
        result.folders.forEach { folder -> ActionButton("${folder.name} (${folder.sessionCount})", enabled && !ObjectId.same(folder.id, result.folderId)) { file(folder, current) } }
        Text("Move to another workspace", style = MaterialTheme.typography.titleMedium)
        result.reason?.let { Text(it) }
        result.targets.forEach { target ->
            val available = enabled && result.reason == null && target.reason == null
            ActionButton(target.name, available) { setDialog(DirectoryDialog.ConfirmMove(session, result, target, null)) }
            target.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            target.folders.forEach { folder -> ActionButton("${target.name} / ${folder.name}", available) {
                setDialog(DirectoryDialog.ConfirmMove(session, result, target, folder))
            } }
        }
    }
}

@Composable
internal fun ActionButton(text: String, enabled: Boolean, action: () -> Unit) {
    TextButton(onClick = action, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(text) }
}

/** A question the directory asks before a press it cannot take back: the title, what happens, and the press beside Cancel. */
private class DirectoryQuestion(val title: String, val message: String, val action: String, val destructive: Boolean, val press: () -> Unit)

/** A move that didn't happen, in the sentence the confirmation shows. */
internal class DirectoryMoveFailure(message: String) : Exception(message)

/** SessionFolderCopy's Delete Folder… and SessionMoveCopy's confirmation, in iOS's words. */
internal object MoveCopy {
    fun deleteFolderTitle(name: String) = "Delete “$name”?"
    /** It names no number: every session filed in the folder goes back to the list. */
    const val DELETE_FOLDER_MESSAGE = "Its sessions move back to the list. No session is deleted."
    const val DELETE_FOLDER_CONFIRM = "Delete"
    const val ENDING = "Ending the session…"
    const val MOVING = "Moving…"
    const val END_TIMED_OUT = "The session hasn’t finished ending, so it wasn’t moved. Try again once it has ended."
    fun endFailed(reason: String) = "The session couldn’t be ended, so it wasn’t moved: ${reason.trimEnd('.')}."
    fun confirmTitle(target: MoveTarget) = "Move to ${target.name}?"
    /** End and Move for a session that has to be ended first. */
    fun confirmAction(targets: MoveTargets) = if (targets.needsEnd) "End and Move" else "Move"

    /** The conversation goes, the agent's memory of it is summarized when another runner rebuilds it, the changes stay on their
     * branch in the old workspace — with how many aren't merged yet when some aren't — and an idle session ends first. An away
     * runner, which iOS says on the workspace's page, is said here, where Android chooses the workspace. */
    fun confirmMessage(targets: MoveTargets, target: MoveTarget, from: String): String {
        val paragraphs = mutableListOf("The conversation moves with it. Your next message continues it in ${target.name}.")
        if (target.conversation == "rebuilt") paragraphs += "Earlier parts of the conversation are summarized for the agent."
        val branch = targets.branch
        if (branch != null && targets.changedFiles > 0) {
            val unmerged = targets.unmergedFiles
            paragraphs += if (unmerged > 0) {
                val files = if (unmerged == 1) "1 changed file isn’t" else "$unmerged changed files aren’t"
                "$files merged into ${targets.mergeTarget ?: "main"} yet. ${if (unmerged == 1) "It stays" else "They stay"} on branch $branch in $from."
            } else "Changes made so far stay on branch $branch in $from."
        }
        if (!target.runnerOnline) paragraphs += "The runner is offline: your next message waits for it."
        if (targets.needsEnd) paragraphs += "The session ends first."
        return paragraphs.joinToString("\n\n")
    }
}

/**
 * SessionWorkspaceMove.run: move the session to another workspace — ending it first for End and Move, since the move only takes an
 * ended session, and waiting until its run is over rather than for the end to be answered: ending is when its runner commits what it
 * left. A 409 on the end is a session already ending, so the wait goes on; a status read that fails is a missed look. A session
 * still not ended after [timeoutMs] is not moved.
 */
internal suspend fun moveToWorkspace(api: DirectoryApi, id: String, workspace: String, folder: String?, endingFirst: Boolean,
    phase: (String) -> Unit, timeoutMs: Long = 60_000, intervalMs: Long = 1_000) {
    if (endingFirst) {
        phase(MoveCopy.ENDING)
        try { api.end(id) }
        catch (e: CancellationException) { throw e }
        catch (e: ApiError) { if (e.status != 409) throw DirectoryMoveFailure(MoveCopy.endFailed(directoryError(e))) }
        catch (e: Exception) { throw DirectoryMoveFailure(MoveCopy.endFailed(directoryError(e))) }
        var waited = 0L
        while (!sessionEnded(api, id)) {
            if (waited >= timeoutMs) throw DirectoryMoveFailure(MoveCopy.END_TIMED_OUT)
            delay(intervalMs)
            waited += intervalMs
        }
    }
    phase(MoveCopy.MOVING)
    api.move(id, workspace, folder)
}

/** Whether the session's run is over (SUCCEEDED, FAILED or CANCELLED), as the server has it now; a failed read is not yet. */
private suspend fun sessionEnded(api: DirectoryApi, id: String): Boolean = try {
    val session = api.objectRead(listOf("sessions", id))
    val status = (session["runStatus"] as? JsonPrimitive)?.contentOrNull ?: (session["status"] as? JsonPrimitive)?.contentOrNull
    status in setOf("SUCCEEDED", "FAILED", "CANCELLED")
} catch (e: CancellationException) { throw e } catch (_: Exception) { false }
