package io.orbitd.android.drive

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.core.drive.DriveEntry
import io.orbitd.android.core.drive.DriveListing
import io.orbitd.android.core.drive.DriveLogic
import io.orbitd.android.core.drive.DriveUploadState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * A folder of Drive (board 04-android frames 2, 3, 5, 7 and 13): full-width Material rows, folders first, each file with who last
 * wrote it (rule 6); at the top level the search field and, last, Trash and Storage; an extended Upload button that shrinks while the
 * list scrolls; New folder in the bar. [route]'s id is the folder (null: the drive's root) and its recordId the folder's name.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DriveFolderPage(store: DriveStore, route: OrbitRoute, open: (OrbitRoute) -> Unit, openSession: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val actions = remember(store) { DriveActions(context, store, scope, snackbar) }
    val folderId = route.id
    val root = folderId == null
    var listing by remember { mutableStateOf<DriveListing?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var path by remember { mutableStateOf<String?>(null) }
    var trashCount by remember { mutableStateOf<Int?>(null) }
    var total by remember { mutableStateOf<Long?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var found by remember { mutableStateOf<List<DriveEntry>?>(null) }
    val uploads by store.uploads.items.collectAsState()
    val completed by store.uploads.completedCount.collectAsState()
    LaunchedEffect(folderId, store.revision, completed) {
        runCatching { store.api.folder(folderId) }.onSuccess { read ->
            listing = read; error = null
            store.readCounts(read.entries.filter { it.isFolder }.map { it.id })
        }.onFailure { if (listing == null) error = store.failure("read the folder", it) }
        if (root) {
            runCatching { store.api.trash() }.getOrNull()?.let { groups -> trashCount = groups.sumOf { it.itemCount } }
            runCatching { store.api.usage() }.getOrNull()?.let { total = it.totalBytes }
        }
    }
    LaunchedEffect(folderId) {
        store.loadLinks()
        if (folderId != null) path = runCatching { store.api.entry(folderId).path }.getOrNull()
    }
    LaunchedEffect(query, store.revision) {
        val words = query.trim()
        if (words.isEmpty()) { found = null; return@LaunchedEffect }
        delay(250)
        found = runCatching { store.api.search(words).entries }.getOrNull() ?: emptyList()
    }
    // The agents' syncs, read every few seconds while a Drive page is up: fast while one runs. The wait is wall-clock time, off
    // the frame clock, which a test may run ahead.
    LaunchedEffect(store) {
        while (true) {
            store.readSyncs()
            val wait = if (store.syncs.any { it.running }) 2_000L else 10_000L
            withContext(Dispatchers.Default) { delay(wait) }
        }
    }
    val title = if (root) DriveLogic.TITLE else listing?.folder?.name ?: route.recordId ?: DriveLogic.TITLE
    var sheetFor by remember { mutableStateOf<DriveEntry?>(null) }
    var renaming by remember { mutableStateOf<DriveEntry?>(null) }
    var moving by remember { mutableStateOf<DriveEntry?>(null) }
    var sharing by remember { mutableStateOf<DriveEntry?>(null) }
    var naming by remember { mutableStateOf(false) }
    var uploadSheet by remember { mutableStateOf(false) }
    var uploadsSheet by remember { mutableStateOf(false) }
    LaunchedEffect(store.showUploads) { if (store.showUploads) { uploadsSheet = true; store.showUploads = false } }
    var menu by remember { mutableStateOf(false) }
    // The chat's sheet at its full height takes the screen, the bar with it (board frames 11, 12).
    LaunchedEffect(folderId, title) { store.chat.here = DriveChatHere(folderId, title) }
    PageBar.Bind(route, title, folds = store.chat.shown && store.chat.expanded, actions = {
        IconButton(onClick = { naming = true }, Modifier.testTag("drive-new-folder")) { Icon(painterResource(R.drawable.ic_folder_plus), DriveLogic.NEW_FOLDER) }
        Box {
            IconButton(onClick = { menu = true }) { Icon(painterResource(R.drawable.ic_more), "More") }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(DriveLogic.UPLOADS) }, onClick = { menu = false; uploadsSheet = true })
                DropdownMenuItem(text = { Text("Refresh") }, onClick = { menu = false; store.changed() })
            }
        }
    })

    val folderName = title
    fun uploadTo(requests: suspend () -> List<io.orbitd.android.core.drive.DriveUploadRequest>) {
        scope.launch {
            val picked = withContext(Dispatchers.IO) { runCatching { requests() }.getOrDefault(emptyList()) }
            DriveUploads.add(store.app, store.handle, picked)
        }
    }
    val target = listing?.folder?.id?.takeUnless { root } // the root uploads with no parentId
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri> ->
        uploadTo { DriveUploads.requests(context, uris, target, folderName) }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris: List<Uri> ->
        uploadTo { DriveUploads.requests(context, uris, target, folderName) }
    }
    val tree = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        uri?.let { uploadTo { DriveUploads.folder(context, it, target, folderName) } }
    }

    val list = rememberLazyListState()
    val entries = remember(listing) { DriveLogic.sorted(listing?.entries.orEmpty()) }
    val here = uploads.filter { it.state != DriveUploadState.DONE && it.relativePath == null &&
        (if (root) it.parentId == null else ObjectId.same(it.parentId, folderId)) }
    val going = uploads.any { it.state == DriveUploadState.UPLOADING || it.state == DriveUploadState.QUEUED } || store.syncs.any { it.running }
    Box(Modifier.fillMaxSize().testTag("drive-folder")) {
        // Room under the rows for Upload and the chat's button over it.
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 168.dp)) {
            if (!root) item { Crumb(DriveLogic.crumb(path?.split("/")?.filter { it.isNotEmpty() } ?: listOf(title))) }
            if (root) item { SearchField(query) { query = it } }
            if (going) item { UploadsCard(store) { uploadsSheet = true } }
            val searching = found
            if (searching != null) {
                if (searching.isEmpty()) item { Text("Nothing matches.", Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                items(searching, key = { "found:${it.id}" }) { entry ->
                    DriveRow(entry.name, AnnotatedString(DriveLogic.searchFolder(entry.folderPath)), leading = { EntryThumb(store, entry) },
                        trailing = if (entry.isFile) DriveLogic.formatSize(entry.sizeBytes) else null,
                        onClick = { openEntry(entry, open) }, onLongClick = { sheetFor = entry })
                }
                return@LazyColumn
            }
            error?.let { item { ErrorBlock(it) { error = null; store.changed() } } }
            if (listing == null && error == null) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(20.dp)) }
            items(entries, key = { it.id }) { entry ->
                // A Drive chat's change marks the row until it is opened (board frame 9).
                val mark = store.chat.markOf(entry.id)
                val opening = { store.chat.opened(entry.id); openEntry(entry, open) }
                if (entry.isFolder) DriveRow(entry.name, AnnotatedString(DriveLogic.folderLine(entry, store.counts[entry.id])),
                    Modifier.testTag("drive-entry:${entry.name}"), leading = { EntryIcon(DriveLogic.Icon.FOLDER) },
                    onClick = opening, onLongClick = { sheetFor = entry }, mark = mark)
                else DriveRow(entry.name, writerLine(store, entry.lastWriter, DriveLogic.formatWhen(entry.lastWriter.at ?: entry.updatedAt), openSession),
                    Modifier.testTag("drive-entry:${entry.name}"), leading = { EntryThumb(store, entry) },
                    trailing = DriveLogic.formatSize(entry.sizeBytes), onClick = opening, onLongClick = { sheetFor = entry }, mark = mark,
                    end = {
                        IconButton(onClick = { sheetFor = entry }, Modifier.size(36.dp).testTag("drive-more:${entry.name}")) {
                            Icon(painterResource(R.drawable.ic_more), "Actions for ${entry.name}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    })
            }
            // A file still going up sits in its folder with its bar (board frame 13).
            items(here, key = { "upload:${it.id}" }) { upload ->
                DriveRow(upload.name, AnnotatedString(DriveLogic.uploadingInFolder(upload)), Modifier.testTag("drive-uploading:${upload.name}"),
                    leading = { EntryIcon(DriveLogic.icon(upload.name)) }, trailing = DriveLogic.formatSize(upload.size),
                    progress = upload.percent / 100f, onClick = { uploadsSheet = true })
            }
            if (listing != null && entries.isEmpty() && here.isEmpty() && !root) item {
                Text("This folder is empty.", Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (root && listing != null) {
                item { HorizontalDivider(Modifier.padding(vertical = 6.dp), color = MaterialTheme.colorScheme.outlineVariant) }
                item {
                    DriveRow(DriveLogic.TRASH, null, Modifier.testTag("drive-trash-row"), leading = { SmallIcon(R.drawable.ic_trash) },
                        trailing = trashCount?.let(DriveLogic::items), onClick = { open(OrbitRoute(Destination.DRIVE_TRASH)) })
                }
                item {
                    DriveRow(DriveLogic.STORAGE, null, Modifier.testTag("drive-storage-row"), leading = { SmallIcon(R.drawable.ic_chart) },
                        trailing = total?.let(DriveLogic::storageSize), onClick = { open(OrbitRoute(Destination.DRIVE_STORAGE)) })
                }
            }
        }
        ExtendedFloatingActionButton(text = { Text(DriveLogic.UPLOAD, fontWeight = FontWeight.Medium) },
            icon = { Icon(painterResource(R.drawable.ic_upload), null) }, onClick = { uploadSheet = true },
            expanded = !list.isScrollInProgress, containerColor = MaterialTheme.colorScheme.secondaryContainer,
            contentColor = MaterialTheme.colorScheme.onSecondaryContainer, shape = RoundedCornerShape(16.dp),
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = DriveMetrics.uploadBottom).testTag("drive-upload"))
        // Over Upload and the chat's round button stacked on it, so neither covers the snackbar's Undo.
        DriveSnackbar(snackbar, Modifier.align(Alignment.BottomCenter).padding(start = 12.dp, end = 12.dp, bottom = 166.dp))
    }

    sheetFor?.let { entry ->
        RowActionsSheet(store, entry, onDismiss = { sheetFor = null }, rename = { renaming = entry }, move = { moving = entry },
            download = { actions.download(entry) }, sendCopy = { actions.handOff(entry, ShareSend) }, share = { sharing = entry },
            trash = { actions.trash(entry) })
    }
    renaming?.let { entry -> NameDialog(DriveLogic.RENAME, entry.name, DriveLogic.RENAME, { renaming = null }) { actions.rename(entry, it); renaming = null } }
    moving?.let { entry -> MoveDialog(store, entry, actions) { moving = null } }
    sharing?.let { entry -> ShareDialog(store, entry) { sharing = null } }
    if (naming) NameDialog(DriveLogic.NEW_FOLDER, DriveLogic.NEW_FOLDER, "Create", { naming = false }) { name ->
        naming = false; actions.newFolder(target, name)
    }
    if (uploadSheet) ModalBottomSheet(onDismissRequest = { uploadSheet = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = sheetColor(), modifier = Modifier.testTag("drive-upload-sheet")) {
        Text(DriveLogic.uploadTo(folderName), Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp), fontSize = 16.sp, fontWeight = FontWeight.Medium)
        SheetItem(R.drawable.ic_doc, DriveLogic.PICK_FILES, tag = "drive-pick-files") { uploadSheet = false; files.launch(arrayOf("*/*")) }
        SheetItem(R.drawable.ic_image, DriveLogic.PICK_PHOTOS, tag = "drive-pick-photos") {
            uploadSheet = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
        }
        SheetItem(R.drawable.ic_folder, DriveLogic.PICK_FOLDER, tag = "drive-pick-folder") { uploadSheet = false; tree.launch(null) }
        HorizontalDivider(Modifier.padding(vertical = 4.dp), color = MaterialTheme.colorScheme.outlineVariant)
        SheetItem(R.drawable.ic_folder_plus, DriveLogic.NEW_FOLDER) { uploadSheet = false; naming = true }
        Spacer(Modifier.height(12.dp))
    }
    if (uploadsSheet) UploadsSheet(store, openSession, openFolder = { id, name -> open(OrbitRoute(Destination.DRIVE, id, recordId = name)) }) { uploadsSheet = false }
}

internal fun openEntry(entry: DriveEntry, open: (OrbitRoute) -> Unit) {
    if (entry.isFolder) open(OrbitRoute(Destination.DRIVE, entry.id, recordId = entry.name))
    else open(OrbitRoute(Destination.DRIVE_FILE, entry.id, folderId = entry.parentId, recordId = entry.name))
}

@Composable
internal fun SmallIcon(res: Int) {
    Box(Modifier.size(DriveMetrics.icon), contentAlignment = Alignment.Center) {
        Icon(painterResource(res), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The board's pill search field (`.search2`). */
@Composable
internal fun SearchField(query: String, height: Int = 52, onChange: (String) -> Unit) {
    Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 8.dp).fillMaxWidth().height(height.dp)
        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape((height / 2).dp)).padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Icon(painterResource(R.drawable.ic_search), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.weight(1f)) {
            if (query.isEmpty()) Text(DriveLogic.SEARCH, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            BasicTextField(query, onChange, Modifier.fillMaxWidth().testTag("drive-search"), singleLine = true,
                textStyle = TextStyle(fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurface), cursorBrush = SolidColor(MaterialTheme.colorScheme.primary))
        }
        if (query.isNotEmpty()) Icon(painterResource(R.drawable.ic_clear), "Clear", Modifier.size(20.dp).clickable { onChange("") },
            tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** While anything goes up, a card at the top of the folder counts uploads and syncs together (board frame 7 ①). */
@Composable
internal fun UploadsCard(store: DriveStore, show: () -> Unit) {
    val uploads by store.uploads.items.collectAsState()
    val (title, bytes) = DriveLogic.trayTitle(uploads, store.syncs)
    Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp).fillMaxWidth()
        .background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(16.dp)).clickable(onClick = show)
        .padding(horizontal = 16.dp, vertical = 12.dp).testTag("drive-uploads-card"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(painterResource(R.drawable.ic_upload), null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
        Text(androidx.compose.ui.text.buildAnnotatedString {
            pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Medium)); append(title); pop()
            bytes?.let { append(" · $it") }
        }, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSecondaryContainer, fontSize = 15.sp)
        Text(DriveLogic.SHOW, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Medium)
    }
}

@Composable
internal fun ErrorBlock(message: String, retry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(message, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = retry) { Text(DriveLogic.TRY_AGAIN) }
    }
}

/** The board's snackbar: the inverse surface with the action in #8AC6FF (`.snack`). */
@Composable
internal fun DriveSnackbar(state: SnackbarHostState, modifier: Modifier = Modifier) {
    SnackbarHost(state, modifier.testTag("drive-snackbar")) { data ->
        Snackbar(data, containerColor = Color(0xFF313033), contentColor = Color(0xFFF4EFF4), actionColor = Color(0xFF8AC6FF),
            shape = RoundedCornerShape(6.dp))
    }
}
