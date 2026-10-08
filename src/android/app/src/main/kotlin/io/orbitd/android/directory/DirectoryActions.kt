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
import io.orbitd.android.core.protocol.SessionAction
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

sealed interface DirectoryDialog {
    data class SessionMenu(val session: DirectorySession, val view: SessionView) : DirectoryDialog
    data class Rename(val session: DirectorySession) : DirectoryDialog
    data class Purge(val session: DirectorySession) : DirectoryDialog
    data class Deleted(val session: DirectorySession) : DirectoryDialog
    data class Tags(val session: DirectorySession) : DirectoryDialog
    data class Move(val session: DirectorySession) : DirectoryDialog
    data class EndToMove(val session: DirectorySession) : DirectoryDialog
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
    val canWrite = !busy && data.fresh
    var draft by remember { mutableStateOf(when (dialog) {
        is DirectoryDialog.Rename -> dialog.session.title.orEmpty()
        is DirectoryDialog.EditFolder -> dialog.folder.name
        else -> ""
    }) }
    fun perform(next: DirectoryDialog? = null, block: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try { block(); onChanged(); setDialog(next) }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = directoryError(failure) }
            finally { busy = false }
        }
    }
    val title = when (dialog) {
        is DirectoryDialog.SessionMenu -> dialog.session.name
        is DirectoryDialog.Rename -> "Rename session"
        is DirectoryDialog.Purge -> "Delete permanently?"
        is DirectoryDialog.Deleted -> "Moved to Trash"
        is DirectoryDialog.Tags -> "Tags"
        is DirectoryDialog.Move -> "Move session"
        is DirectoryDialog.EndToMove -> "End session before moving?"
        is DirectoryDialog.ConfirmMove -> "Move to ${dialog.target.name}?"
        is DirectoryDialog.Share -> "Share session"
        is DirectoryDialog.NewFolder -> "New folder"
        is DirectoryDialog.EditFolder -> "Folder options"
        is DirectoryDialog.DeleteFolder -> "Delete folder?"
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
                            perform { if (positive == SessionAction.COMPLETE) api.complete(s.id) else api.restore(s.id) }
                        }
                        if (!allowed) Text("This action isn't available in the current session state.", style = MaterialTheme.typography.bodySmall)
                        if (dialog.view != SessionView.TRASH) {
                            ActionButton("Share…", canWrite) { setDialog(DirectoryDialog.Share(s)) }
                            ActionButton("Move…", canWrite) { setDialog(DirectoryDialog.Move(s)) }
                        }
                        ActionButton(if (dialog.view == SessionView.TRASH) "Delete Permanently…" else "Move to Trash", canWrite) {
                            if (dialog.view == SessionView.TRASH) setDialog(DirectoryDialog.Purge(s))
                            else perform(DirectoryDialog.Deleted(s)) { api.delete(s.id, false) }
                        }
                    }
                    is DirectoryDialog.Rename -> {
                        OutlinedTextField(draft, { draft = it }, Modifier.fillMaxWidth(), label = { Text("Session name") })
                        ActionButton("Save", canWrite && draft.isNotBlank()) { perform { api.rename(dialog.session.id, draft) } }
                    }
                    is DirectoryDialog.Purge -> {
                        Text("This session and its full transcript will be permanently deleted. This can't be undone.")
                        ActionButton("Delete Permanently", canWrite) { perform { api.delete(dialog.session.id, true) } }
                    }
                    is DirectoryDialog.Deleted -> {
                        Text("${dialog.session.name} is in Trash.")
                        ActionButton("Undo", canWrite) { perform { api.restore(dialog.session.id) } }
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
                    is DirectoryDialog.DeleteFolder -> {
                        Text("The sessions in ${dialog.folder.name} will return to their workspace. Sessions won't be deleted.")
                        ActionButton("Delete folder", canWrite) { perform { api.deleteFolder(dialog.folder.id) } }
                    }
                    is DirectoryDialog.Move -> MoveChoices(dialog.session, api, canWrite, setDialog) { workspace, folder ->
                        perform { api.move(dialog.session.id, workspace, folder) }
                    }
                    is DirectoryDialog.EndToMove -> {
                        Text("End this session first. Its worktree changes stay in the original workspace.")
                        ActionButton("End session", canWrite) { perform(DirectoryDialog.Move(dialog.session)) { api.end(dialog.session.id) } }
                    }
                    is DirectoryDialog.ConfirmMove -> {
                        Text("Move ${dialog.session.name} to ${dialog.target.name}${dialog.folder?.let { " / ${it.name}" }.orEmpty()}.")
                        Text(if (dialog.target.conversation == "rebuilt") "The conversation will be rebuilt from Orbit's record on the new runner." else "The conversation will continue on this runner.")
                        if (!dialog.target.runnerOnline) Text("The runner is offline. The next message will wait for it.")
                        dialog.targets.branch?.let { Text("Worktree changes stay on $it (${dialog.targets.changedFiles} changed files).") }
                        ActionButton("Move", canWrite) { perform { api.move(dialog.session.id, dialog.target.workspaceId, dialog.folder?.id) } }
                    }
                    is DirectoryDialog.Share -> io.orbitd.android.management.SessionSharePanel(dialog.session.id)
                }
            }
        })
}

@Composable
private fun MoveChoices(session: DirectorySession, api: DirectoryApi, enabled: Boolean,
    setDialog: (DirectoryDialog?) -> Unit, move: (String?, String?) -> Unit) {
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
        ActionButton("No folder", enabled && result.folderId != null) { move(null, null) }
        result.folders.forEach { folder -> ActionButton("${folder.name} (${folder.sessionCount})", enabled && !ObjectId.same(folder.id, result.folderId)) { move(null, folder.id) } }
        Text("Move to another workspace", style = MaterialTheme.typography.titleMedium)
        result.reason?.let { Text(it) }
        if (result.needsEnd) ActionButton("End session…", enabled) { setDialog(DirectoryDialog.EndToMove(session)) }
        result.targets.forEach { target ->
            val available = enabled && result.reason == null && !result.needsEnd && target.reason == null
            ActionButton(target.name, available) { setDialog(DirectoryDialog.ConfirmMove(session, result, target, null)) }
            target.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            target.folders.forEach { folder -> ActionButton("${target.name} / ${folder.name}", available) {
                setDialog(DirectoryDialog.ConfirmMove(session, result, target, folder))
            } }
        }
    }
}

@Composable
private fun ActionButton(text: String, enabled: Boolean, action: () -> Unit) {
    TextButton(onClick = action, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(text) }
}
