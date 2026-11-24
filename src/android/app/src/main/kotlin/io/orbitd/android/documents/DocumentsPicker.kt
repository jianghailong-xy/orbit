package io.orbitd.android.documents

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.core.documents.DocumentsEntry
import io.orbitd.android.core.documents.DocumentsLogic
import kotlinx.coroutines.delay

/** Where the drive is mounted for an agent (design §4.5): a file's path in a message is this plus its place in Documents. */
const val DOCUMENTS_MOUNT = "/home/orbit/Documents"

/** The project's folder name in Documents (D22): no `/`, at most 60 characters (the web's `projectFolderName`). */
fun projectFolderName(title: String): String = title.replace('/', '-').trim().take(60)

/**
 * Add from Documents (board frame 14; D21, D22): the composer's From Documents opens this sheet on the session's project folder when it
 * has one, else on the drive's root. Folders open, files toggle; Add hands back the picked files' `/home/orbit/Documents/…` paths — the
 * agent reads them from its mount, and nothing is uploaded again.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentsPickerSheet(store: DocumentsStore, projectTitle: String?, onDismiss: () -> Unit, onPick: (List<String>) -> Unit) {
    var trail by remember { mutableStateOf<List<Pair<String?, String>>?>(null) }
    var entries by remember { mutableStateOf<List<DocumentsEntry>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var found by remember { mutableStateOf<List<DocumentsEntry>?>(null) }
    val picked = remember { mutableStateMapOf<String, String>() }
    // The project's folder is looked for by its name, and with the short suffix a clash adds; none found: the root.
    LaunchedEffect(Unit) {
        val root = runCatching { store.api.folder(null) }.getOrNull()
        val wanted = projectTitle?.let(::projectFolderName)
        val folder = wanted?.let { w -> root?.entries?.firstOrNull { it.isFolder && it.name == w } ?: root?.entries?.firstOrNull { it.isFolder && it.name.startsWith("$w-") } }
        trail = listOf<Pair<String?, String>>(null to DocumentsLogic.TITLE) + listOfNotNull(folder?.let { it.id to it.name })
    }
    val here = trail?.last()
    LaunchedEffect(here) {
        val shown = trail ?: return@LaunchedEffect
        entries = null
        runCatching { store.api.folder(shown.last().first) }.onSuccess { entries = DocumentsLogic.sorted(it.entries); error = null }
            .onFailure { error = store.failure("read the folder", it) }
    }
    LaunchedEffect(query) {
        if (query.isBlank()) { found = null; return@LaunchedEffect }
        delay(250)
        found = runCatching { store.api.search(query.trim()).entries.filter { it.isFile } }.getOrNull() ?: emptyList()
    }
    val folderPath = (listOf(DOCUMENTS_MOUNT) + trail.orEmpty().drop(1).map { it.second }).joinToString("/")
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = sheetColor(), modifier = Modifier.testTag("documents-picker")) {
        Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Add from Documents", Modifier.weight(1f), fontSize = 16.sp, fontWeight = FontWeight.Medium)
            TextButton(enabled = picked.isNotEmpty(), onClick = { onPick(picked.values.toList()) }, modifier = Modifier.testTag("documents-picker-add")) {
                Text(if (picked.isEmpty()) "Add" else "Add ${picked.size}")
            }
        }
        SearchField(query, height = 44) { query = it }
        val shownTrail = trail
        if (shownTrail != null && found == null) Crumb(buildAnnotatedString {
            shownTrail.forEachIndexed { i, (_, name) ->
                if (i > 0) append(" › ")
                if (i == shownTrail.lastIndex) withStyle(SpanStyle(fontWeight = FontWeight.Medium)) { append(name) } else append(name)
            }
        }.text)
        LazyColumn(Modifier.fillMaxWidth().heightIn(min = 240.dp, max = 520.dp)) {
            if (shownTrail != null && shownTrail.size > 1 && found == null) item {
                DocumentsRow(shownTrail[shownTrail.lastIndex - 1].second, null, leading = {
                    Icon(painterResource(R.drawable.ic_back), null, Modifier.size(DocumentsMetrics.icon).padding(3.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }, onClick = { trail = shownTrail.dropLast(1) })
            }
            error?.let { item { Text(it, Modifier.padding(20.dp), color = MaterialTheme.colorScheme.error) } }
            val rows = found ?: entries
            if (rows == null && error == null) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(20.dp)) }
            if (rows != null && rows.isEmpty()) item {
                Text(if (found != null) "Nothing matches." else "This folder is empty.", Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(rows.orEmpty(), key = { it.id }) { entry ->
                if (entry.isFolder) DocumentsRow(entry.name, null, Modifier.testTag("documents-picker-folder:${entry.name}"),
                    leading = { EntryIcon(DocumentsLogic.Icon.FOLDER) }, onClick = { trail = shownTrail.orEmpty() + (entry.id to entry.name); query = "" },
                    end = { Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.padding(end = 12.dp).size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant) })
                else {
                    val chosen = entry.id in picked
                    val line = if (found != null) AnnotatedString(DocumentsLogic.searchFolder(entry.folderPath))
                        else AnnotatedString(DocumentsLogic.fileLine(store.writerName(entry.lastWriter), entry))
                    DocumentsRow(entry.name, line, Modifier.testTag("documents-picker-file:${entry.name}"), leading = { EntryIcon(DocumentsLogic.icon(entry)) },
                        selected = chosen, onClick = {
                            if (chosen) picked.remove(entry.id)
                            else picked[entry.id] = if (found != null) "$DOCUMENTS_MOUNT${entry.folderPath?.takeIf { it != "/" }.orEmpty()}/${entry.name}"
                                else "$folderPath/${entry.name}"
                        }, end = if (chosen) ({ Icon(painterResource(R.drawable.ic_check), null, Modifier.padding(end = 12.dp), tint = MaterialTheme.colorScheme.primary) }) else null)
                }
            }
        }
        Text("Puts the file's path in your message; nothing is uploaded again.", Modifier.padding(horizontal = 24.dp, vertical = 10.dp),
            fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
