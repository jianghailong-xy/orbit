package io.orbitd.android.drive

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.core.drive.DriveEntry
import io.orbitd.android.core.drive.DriveLogic
import io.orbitd.android.core.drive.DriveTrashGroup
import io.orbitd.android.core.drive.DriveUsage
import io.orbitd.android.core.drive.StorageUsage
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.launch

/**
 * Trash (board frame 11; D6, D11, D17, rule 3): grouped by the folder an item was deleted from and when — one delete is one group,
 * restored whole by Restore all — and the earlier versions of overwritten files. A row's ⋮ has Restore, Restore as a copy (a version)
 * and Delete for good; only Delete for good and Empty ask first. Agents cannot see Trash.
 */
@Composable
internal fun DriveTrashPage(store: DriveStore, route: OrbitRoute) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val actions = remember(store) { DriveActions(context, store, scope, snackbar) }
    var groups by remember { mutableStateOf<List<DriveTrashGroup>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var asking by remember { mutableStateOf<Pair<String, suspend () -> Unit>?>(null) }
    LaunchedEffect(store.revision) {
        runCatching { store.api.trash() }.onSuccess { groups = it; error = null }.onFailure { if (groups == null) error = store.failure("read Trash", it) }
        store.loadLinks()
    }
    fun run(what: String, done: String?, call: suspend () -> Unit) {
        scope.launch {
            runCatching { call() }.onSuccess { store.changed(); done?.let { snackbar.showSnackbar(it) } }.onFailure { actions.failed(what, it) }
        }
    }
    PageBar.Bind(route, DriveLogic.TRASH, actions = {
        if (!groups.isNullOrEmpty()) TextButton(onClick = {
            asking = DriveLogic.emptyTrashMessage(groups!!) to { store.api.emptyTrash() }
        }, Modifier.testTag("drive-trash-empty")) { Text(DriveLogic.EMPTY, color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Medium) }
    })
    Box(Modifier.fillMaxSize().testTag("drive-trash")) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            val shown = groups
            error?.let { item { ErrorBlock(it) { error = null; store.changed() } } }
            if (shown == null && error == null) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(20.dp)) }
            if (shown != null) {
                item { Crumb(if (shown.isEmpty()) DriveLogic.TRASH_EMPTY else DriveLogic.trashSummary(shown)) }
                shown.forEach { group ->
                    item(key = "g:${group.id}") {
                        SectionHeading(DriveLogic.groupHeading(group), Modifier.testTag("drive-trash-group:${group.id}")) {
                            TextButton(onClick = {
                                val version = group.version
                                if (version != null) run("restore ${version.entry.name}", DriveLogic.RESTORED_AS_CURRENT) { store.api.restoreVersion(version.id, false) }
                                else run("restore", DriveLogic.restored(DriveLogic.items(group.itemCount), group)) { store.api.restoreGroup(group.id) }
                            }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) { Text(DriveLogic.RESTORE_ALL) }
                        }
                    }
                    val version = group.version
                    if (version != null) item(key = "v:${group.id}") {
                        TrashRow(store, version.entry, AnnotatedString(DriveLogic.versionLine(group, store.writerName(version.writer))),
                            DriveLogic.formatSize(version.sizeBytes), restore = {
                                run("restore ${version.entry.name}", DriveLogic.RESTORED_AS_CURRENT) { store.api.restoreVersion(version.id, false) }
                            }, restoreCopy = {
                                run("restore ${version.entry.name}", DriveLogic.RESTORED_AS_COPY) { store.api.restoreVersion(version.id, true) }
                            }, deleteForGood = { asking = store.deleteQuestion(group) to { store.api.deleteGroup(group.id) } })
                    } else items(group.items, key = { "i:${group.id}:${it.id}" }) { entry ->
                        TrashRow(store, entry, AnnotatedString(DriveLogic.trashLine(entry, group, store.writerName(group.actor))),
                            if (entry.isFile) DriveLogic.formatSize(entry.sizeBytes) else null, restore = {
                                run("restore ${entry.name}", DriveLogic.restored(entry.name, group)) { store.api.restoreItem(group.id, entry.id) }
                            }, restoreCopy = null, deleteForGood = { asking = store.deleteQuestion(group) to { store.api.deleteGroup(group.id) } })
                    }
                }
                if (shown.isNotEmpty()) item {
                    Text(DriveLogic.TRASH_FOOT, Modifier.padding(20.dp), fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        DriveSnackbar(snackbar, Modifier.align(Alignment.BottomCenter).padding(12.dp))
    }
    asking?.let { (message, call) ->
        AlertDialog(onDismissRequest = { asking = null }, containerColor = dialogColor(), title = { Text(DriveLogic.DELETE_FOR_GOOD + "?") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = { asking = null; run("delete for good", null, call) }, Modifier.testTag("drive-confirm-delete")) {
                Text(DriveLogic.DELETE_FOR_GOOD, color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { asking = null }) { Text(DriveLogic.CANCEL) } })
    }
}

/** The question before Delete for good, saying when it ends a share link (§9). */
private fun DriveStore.deleteQuestion(group: DriveTrashGroup): String =
    DriveLogic.deleteForGoodMessage(group) +
        if (DriveLogic.groupEndsALink(group, links.toList(), ObjectId::same)) " " + DriveLogic.ENDS_A_SHARE_LINK else ""

@Composable
private fun TrashRow(store: DriveStore, entry: DriveEntry, line: AnnotatedString, size: String?, restore: () -> Unit,
                     restoreCopy: (() -> Unit)?, deleteForGood: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    DriveRow(entry.name, line, Modifier.testTag("drive-trash-row:${entry.name}"), leading = { EntryIcon(DriveLogic.icon(entry)) },
        trailing = size, onLongClick = { menu = true }, onClick = { menu = true }, end = {
            Box {
                IconButton(onClick = { menu = true }, Modifier.size(36.dp)) {
                    Icon(painterResource(R.drawable.ic_more), "Actions for ${entry.name}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text(DriveLogic.RESTORE) }, onClick = { menu = false; restore() }, modifier = Modifier.testTag("drive-trash-restore"))
                    restoreCopy?.let { DropdownMenuItem(text = { Text(DriveLogic.RESTORE_AS_COPY) }, onClick = { menu = false; it() }) }
                    DropdownMenuItem(text = { Text(DriveLogic.DELETE_FOR_GOOD, color = MaterialTheme.colorScheme.error) },
                        onClick = { menu = false; deleteForGood() }, modifier = Modifier.testTag("drive-trash-delete"))
                }
            }
        })
}

/**
 * Storage (board frame 12; D13, D19): the account's total and the drive's share of it, Trash counting until emptied, then what the
 * account keeps besides — with the largest projects and tasks and what each week added. Android had no Settings → Storage; this is it.
 */
@Composable
internal fun DriveStoragePage(store: DriveStore, route: OrbitRoute, open: (OrbitRoute) -> Unit) {
    var usage by remember { mutableStateOf<DriveUsage?>(null) }
    var other by remember { mutableStateOf<StorageUsage?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(store.revision) {
        runCatching { store.api.usage() }.onSuccess { usage = it; error = null }.onFailure { error = store.failure("read Storage", it) }
        other = runCatching { store.api.storageUsage() }.getOrNull()
    }
    PageBar.Bind(route, DriveLogic.STORAGE)
    LazyColumn(Modifier.fillMaxSize().testTag("drive-storage"), contentPadding = PaddingValues(bottom = 24.dp)) {
        error?.let { item { ErrorBlock(it) { error = null; store.changed() } } }
        val shown = usage
        if (shown == null && error == null) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(20.dp)) }
        if (shown != null) item {
            Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp).fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp)).padding(16.dp)) {
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(DriveLogic.storageSize(shown.totalBytes), fontSize = 30.sp, modifier = Modifier.testTag("drive-storage-total"))
                    Text(DriveLogic.IN_THIS_ACCOUNT, Modifier.padding(bottom = 5.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                val bar = DriveLogic.storageBar(shown)
                val colours = listOf(Color(0xFF0066BE), Color(0xFF8AC6FF), Color(0xFFB4B4BA))
                Row(Modifier.padding(top = 10.dp).fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp)).background(MaterialTheme.colorScheme.outlineVariant)) {
                    listOf(bar.drive, bar.trash, bar.other).zip(colours).forEach { (part, colour) ->
                        if (part > 0.001) Box(Modifier.fillMaxHeight().weight(part.toFloat()).background(colour))
                    }
                    val rest = 1.0 - bar.drive - bar.trash - bar.other
                    if (rest > 0.001) Spacer(Modifier.weight(rest.toFloat()))
                }
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    DriveLogic.storageLegend(shown).zip(colours).forEach { (label, colour) ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                            Box(Modifier.size(8.dp).background(colour, CircleShape))
                            Text(label, fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                DriveLogic.storeWarning(shown)?.let { Text(it, Modifier.padding(top = 10.dp), color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
            }
        }
        val rest = other
        if (rest != null) {
            item { SectionHeading(DriveLogic.OTHER_STORAGE) }
            item { StorageRow(DriveLogic.EVERYTHING_ELSE, DriveLogic.storedValue(rest), DriveLogic.EVERYTHING_ELSE_NOTE) }
            if (DriveLogic.storageFull(rest)) item {
                Text(DriveLogic.STORAGE_FULL_NOTE, Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            }
            if (rest.projects.isNotEmpty()) {
                item { SectionHeading(DriveLogic.LARGEST_PROJECTS) }
                items(rest.projects.take(5), key = { "p:${it.projectId}" }) { p ->
                    StorageRow(p.title, DriveLogic.storageSize(p.bytes) + " ›") { open(OrbitRoute(Destination.PROJECT, ObjectId.canonical(p.projectId) ?: p.projectId)) }
                }
            }
            if (rest.tasks.isNotEmpty()) {
                item { SectionHeading(DriveLogic.LARGEST_TASKS) }
                items(rest.tasks.take(5), key = { "t:${it.taskId}" }) { t ->
                    StorageRow(t.title, DriveLogic.storageSize(t.bytes) + " ›") { open(OrbitRoute(Destination.TASK, ObjectId.canonical(t.taskId) ?: t.taskId)) }
                }
            }
            val weeks = rest.weeks.filter { it.bytes > 0 }
            if (weeks.isNotEmpty()) {
                item { SectionHeading(DriveLogic.ADDED_EACH_WEEK) }
                items(weeks.reversed().take(8), key = { "w:${it.weekStart}" }) { w -> StorageRow(DriveLogic.weekLabel(w.weekStart), DriveLogic.storageSize(w.bytes)) }
            }
        }
    }
}

@Composable
private fun StorageRow(title: String, value: String, note: String? = null, onClick: (() -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).then(if (onClick != null) Modifier.combinedClickableNoLong(onClick) else Modifier)
        .padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 15.sp, maxLines = 1)
            note?.let { Text(it, fontSize = 12.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Text(value, fontSize = DriveMetrics.line, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
