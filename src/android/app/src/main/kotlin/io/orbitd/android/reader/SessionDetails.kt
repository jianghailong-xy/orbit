package io.orbitd.android.reader

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.core.realtime.SessionState
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.text.*
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

@Composable
internal fun SessionDetails(session: SessionState?, api: DirectoryApi, open: (String) -> Unit, close: () -> Unit) {
    val detail = session?.snapshot?.detail ?: return
    var diff by remember { mutableStateOf(false) }
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column(Modifier.padding(16.dp)) {
            TextButton(onClick = close) { Text("Close session details") }
            LazyColumn(Modifier.testTag("session-details"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                item { SelectionContainer { Text(detail.string("title") ?: "Session", style = MaterialTheme.typography.headlineMedium) } }
                listOf("taskId" to "task", "projectId" to "project", "parentSessionId" to "session").forEach { (key, kind) ->
                    detail.string(key)?.let { id -> item { TextButton(enabled = session.fresh, onClick = { open("orbit-$kind:$id") }) { Text("Open $kind") } } }
                }
                item {
                    Text("Worktree / Git", style = MaterialTheme.typography.titleMedium)
                    SelectionContainer { Column {
                        listOf("branch" to "Branch", "worktreeBranch" to "Worktree branch", "baseSha" to "Base commit",
                            "mergeTarget" to "Merge target", "isolationStatus" to "Worktree status",
                            "worktreeDirty" to "Uncommitted changes", "branchMerged" to "Branch merged").forEach { (key, label) ->
                            detail.string(key)?.let { Text("$label: $it") }
                        }
                        if (detail.string("branch").isNullOrEmpty()) Text("No isolated branch reported")
                    } }
                    TextButton(enabled = session.fresh, onClick = { diff = true }) { Text("View changed files and diff") }
                }
                val files = (detail["changedFiles"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                items(files, key = { it.string("path").orEmpty() }) { f -> Text("${f.string("path")}  +${f.string("additions") ?: "0"} −${f.string("deletions") ?: "0"}") }
                item { Text("Background work", style = MaterialTheme.typography.titleMedium) }
                val background = session.snapshot?.background.orEmpty()
                if (background.isEmpty()) item { Text("No background jobs") }
                items(background, key = { it.string("toolUseId") ?: it.string("shellId") ?: it.string("id").orEmpty() }) { job ->
                    Column {
                        Text(job.string("description") ?: job.string("command") ?: "Background job")
                        Text(job.string("status") ?: "No end reported", style = MaterialTheme.typography.bodySmall)
                        val live = session.transcript.backgroundOutputs[job.string("toolUseId")]
                            ?: session.transcript.backgroundOutputs[job.string("shellId")]
                        val output = live?.string("content") ?: live?.string("output") ?: live?.string("chunk") ?: live?.string("text") ?: job.string("latestOutput")
                        output?.let { CodeText(it) }
                    }
                }
            }
        } }
    }
    if (diff && session.fresh) DiffDialog(session.id, api) { diff = false }
}

@Composable
private fun DiffDialog(id: String, api: DirectoryApi, close: () -> Unit) {
    var patches by remember { mutableStateOf<List<JsonObject>?>(null) }
    var error by remember { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    LaunchedEffect(id, retry) {
        error = false
        try { patches = (api.objectRead(listOf("sessions", id, "diff"))["patches"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>() }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { patches = null; error = true }
    }
    val displayed = patches
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column(Modifier.padding(16.dp)) {
            TextButton(onClick = close) { Text("Close diff") }
            if (error) TextButton(onClick = { retry++ }) { Text("Couldn't load diff · Retry") }
            else if (displayed == null) CircularProgressIndicator()
            LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (displayed?.isEmpty() == true) item { Text("No diff to preview") }
                items(displayed.orEmpty(), key = { it.string("path").orEmpty() }) { patch ->
                    Text(patch.string("path").orEmpty(), style = MaterialTheme.typography.titleMedium)
                    val text = patch.string("patch")
                    if (text != null) CodeText(text, "diff") else Text(if (patch.string("truncated") == "true") "Diff too large to preview" else "Binary file or no diff to preview")
                }
            }
        } }
    }
}
