package io.orbitd.android.drive

import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.R
import io.orbitd.android.core.drive.DriveEntry
import io.orbitd.android.core.drive.DriveLogic
import io.orbitd.android.navigation.ObjectId

/**
 * Move to a folder (board frame 9): a full-screen dialog that walks the folder tree, listing only folders. A folder made with New
 * folder is selected straight away; the button moves into the selected folder, else the one shown. The system back gesture goes up
 * one folder, then closes.
 */
@Composable
internal fun MoveDialog(store: DriveStore, entry: DriveEntry, actions: DriveActions, onDismiss: () -> Unit) {
    // The trail from the root down, as (id, name); the root's id is learnt from its listing.
    var trail by remember { mutableStateOf(listOf<Pair<String?, String>>(null to DriveLogic.TITLE)) }
    var folders by remember { mutableStateOf<List<DriveEntry>?>(null) }
    var rootId by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var picked by remember { mutableStateOf<DriveEntry?>(null) }
    var naming by remember { mutableStateOf(false) }
    var reads by remember { mutableIntStateOf(0) }
    val here = trail.last()
    LaunchedEffect(here.first, reads) {
        folders = null
        runCatching { store.api.folder(here.first) }.onSuccess { listing ->
            if (here.first == null) rootId = listing.folder.id
            folders = DriveLogic.sorted(listing.entries.filter { it.isFolder && !ObjectId.same(it.id, entry.id) })
            error = null
        }.onFailure { error = store.failure("read the folder", it) }
    }
    fun up() { if (trail.size > 1) { trail = trail.dropLast(1); picked = null } else onDismiss() }
    val targetId = picked?.id ?: here.first ?: rootId
    val targetName = picked?.name ?: here.second
    val ancestors = listOfNotNull(rootId) + trail.mapNotNull { it.first } + listOfNotNull(picked?.id)
    val allowed = targetId != null && DriveLogic.canMove(entry, targetId, ancestors, ObjectId::same)
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BackHandler { up() }
        Surface(Modifier.fillMaxSize().testTag("drive-move"), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize().systemBarsPadding()) {
                Row(Modifier.fillMaxWidth().height(60.dp).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(painterResource(R.drawable.ic_close), DriveLogic.CANCEL) }
                    Text(DriveLogic.moveTitle(entry.name), Modifier.weight(1f).padding(start = 6.dp), fontSize = 19.sp, maxLines = 1,
                        overflow = TextOverflow.Ellipsis)
                }
                Crumb(buildAnnotatedString {
                    trail.forEachIndexed { i, (_, name) ->
                        if (i > 0) append(" › ")
                        if (i == trail.lastIndex) withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.Medium)) { append(name) }
                        else append(name)
                    }
                }.text)
                LazyColumn(Modifier.weight(1f)) {
                    if (trail.size > 1) item {
                        DriveRow(trail[trail.lastIndex - 1].second, null, Modifier.testTag("drive-move-up"),
                            leading = { Icon(painterResource(R.drawable.ic_back), null, Modifier.size(DriveMetrics.icon).padding(3.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant) }, onClick = ::up)
                    }
                    error?.let { item { Text(it, Modifier.padding(20.dp), color = MaterialTheme.colorScheme.error) } }
                    if (folders == null && error == null) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(20.dp)) }
                    items(folders.orEmpty(), key = { it.id }) { folder ->
                        val chosen = picked?.id == folder.id
                        DriveRow(folder.name, if (chosen) AnnotatedString(DriveLogic.NEW_FOLDER) else null,
                            Modifier.testTag("drive-move-folder:${folder.name}"), leading = { EntryIcon(DriveLogic.Icon.FOLDER) }, selected = chosen,
                            onClick = { trail = trail + (folder.id to folder.name); picked = null },
                            end = {
                                if (chosen) Icon(painterResource(R.drawable.ic_check), null, Modifier.padding(end = 12.dp), tint = MaterialTheme.colorScheme.primary)
                                else Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.padding(end = 12.dp).size(18.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            })
                    }
                    item {
                        DriveRow(DriveLogic.NEW_FOLDER, null, Modifier.testTag("drive-move-new-folder"),
                            leading = { Icon(painterResource(R.drawable.ic_folder_plus), null, Modifier.size(DriveMetrics.icon).padding(3.dp),
                                tint = MaterialTheme.colorScheme.primary) }, onClick = { naming = true })
                    }
                }
                Button(onClick = { targetId?.let { actions.move(entry, it, targetName, onDismiss) } }, enabled = allowed,
                    modifier = Modifier.fillMaxWidth().padding(16.dp).height(44.dp).testTag("drive-move-confirm")) {
                    Text(DriveLogic.moveButton(targetName))
                }
            }
        }
        if (naming) NameDialog(DriveLogic.NEW_FOLDER, DriveLogic.NEW_FOLDER, "Create", { naming = false }) { name ->
            naming = false
            actions.newFolder(here.first ?: rootId, name) { made -> picked = made; reads++ }
        }
    }
}
