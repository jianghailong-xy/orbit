package io.orbitd.android.documents

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
import io.orbitd.android.core.documents.DocumentsEntry
import io.orbitd.android.core.documents.DocumentsListing
import io.orbitd.android.core.documents.DocumentsLogic
import io.orbitd.android.core.documents.DocumentsUploadState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * A folder of Documents (board 04-android frames 2, 3, 5, 7 and 13): full-width Material rows, folders first, each file with who last
 * wrote it (rule 6); at the top level the search field and, last, Trash and Storage; an extended Upload button that shrinks while the
 * list scrolls; New folder in the bar. [route]'s id is the folder (null: the drive's root) and its recordId the folder's name.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DocumentsFolderPage(store: DocumentsStore, route: OrbitRoute, open: (OrbitRoute) -> Unit, openSession: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val actions = remember(store) { DocumentsActions(context, store, scope, snackbar) }
    val folderId = route.id
    val root = folderId == null
    var listing by remember { mutableStateOf<DocumentsListing?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var path by remember { mutableStateOf<String?>(null) }
    var trashCount by remember { mutableStateOf<Int?>(null) }
    var total by remember { mutableStateOf<Long?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var found by remember { mutableStateOf<List<DocumentsEntry>?>(null) }
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
    // The agents' syncs, read every few seconds while a Documents page is up: fast while one runs.
    LaunchedEffect(store) {
        while (true) { store.readSyncs(); delay(if (store.syncs.any { it.running }) 2_000 else 10_000) }
    }
    val title = if (root) DocumentsLogic.TITLE else listing?.folder?.name ?: route.recordId ?: DocumentsLogic.TITLE
    var sheetFor by remember { mutableStateOf<DocumentsEntry?>(null) }
    var renaming by remember { mutableStateOf<DocumentsEntry?>(null) }
    var moving by remember { mutableStateOf<DocumentsEntry?>(null) }
    var sharing by remember { mutableStateOf<DocumentsEntry?>(null) }
    var naming by remember { mutableStateOf(false) }
    var uploadSheet by remember { mutableStateOf(false) }
    var uploadsSheet by remember { mutableStateOf(false) }
    LaunchedEffect(store.showUploads) { if (store.showUploads) { uploadsSheet = true; store.showUploads = false } }
    var menu by remember { mutableStateOf(false) }
    PageBar.Bind(route, title, actions = {
        IconButton(onClick = { naming = true }, Modifier.testTag("documents-new-folder")) { Icon(painterResource(R.drawable.ic_folder_plus), DocumentsLogic.NEW_FOLDER) }
        Box {
            IconButton(onClick = { menu = true }) { Icon(painterResource(R.drawable.ic_more), "More") }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(DocumentsLogic.UPLOADS) }, onClick = { menu = false; uploadsSheet = true })
                DropdownMenuItem(text = { Text("Refresh") }, onClick = { menu = false; store.changed() })
            }
        }
    })

    val folderName = title
    fun uploadTo(requests: suspend () -> List<io.orbitd.android.core.documents.DocumentsUploadRequest>) {
        scope.launch {
            val picked = withContext(Dispatchers.IO) { runCatching { requests() }.getOrDefault(emptyList()) }
            DocumentsUploads.add(store.app, store.handle, picked)
        }
    }
    val target = listing?.folder?.id?.takeUnless { root } // the root uploads with no parentId
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri> ->
        uploadTo { DocumentsUploads.requests(context, uris, target, folderName) }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris: List<Uri> ->
        uploadTo { DocumentsUploads.requests(context, uris, target, folderName) }
    }
    val tree = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        uri?.let { uploadTo { DocumentsUploads.folder(context, it, target, folderName) } }
    }

    val list = rememberLazyListState()
    val entries = remember(listing) { DocumentsLogic.sorted(listing?.entries.orEmpty()) }
    val here = uploads.filter { it.state != DocumentsUploadState.DONE && it.relativePath == null &&
        (if (root) it.parentId == null else ObjectId.same(it.parentId, folderId)) }
    val going = uploads.any { it.state == DocumentsUploadState.UPLOADING || it.state == DocumentsUploadState.QUEUED } || store.syncs.any { it.running }
    Box(Modifier.fillMaxSize().testTag("documents-folder")) {
        LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 96.dp)) {
            if (!root) item { Crumb(DocumentsLogic.crumb(path?.split("/")?.filter { it.isNotEmpty() } ?: listOf(title))) }
            if (root) item { SearchField(query) { query = it } }
            if (going) item { UploadsCard(store) { uploadsSheet = true } }
            val searching = found
            if (searching != null) {
                if (searching.isEmpty()) item { Text("Nothing matches.", Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                items(searching, key = { "found:${it.id}" }) { entry ->
                    DocumentsRow(entry.name, AnnotatedString(DocumentsLogic.searchFolder(entry.folderPath)), leading = { EntryThumb(store, entry) },
                        trailing = if (entry.isFile) DocumentsLogic.formatSize(entry.sizeBytes) else null,
                        onClick = { openEntry(entry, open) }, onLongClick = { sheetFor = entry })
                }
                return@LazyColumn
            }
            error?.let { item { ErrorBlock(it) { error = null; store.changed() } } }
            if (listing == null && error == null) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(20.dp)) }
            items(entries, key = { it.id }) { entry ->
                if (entry.isFolder) DocumentsRow(entry.name, AnnotatedString(DocumentsLogic.folderLine(entry, store.counts[entry.id])),
                    Modifier.testTag("documents-entry:${entry.name}"), leading = { EntryIcon(DocumentsLogic.Icon.FOLDER) },
                    onClick = { openEntry(entry, open) }, onLongClick = { sheetFor = entry })
                else DocumentsRow(entry.name, writerLine(store, entry.lastWriter, DocumentsLogic.formatWhen(entry.lastWriter.at ?: entry.updatedAt), openSession),
                    Modifier.testTag("documents-entry:${entry.name}"), leading = { EntryThumb(store, entry) },
                    trailing = DocumentsLogic.formatSize(entry.sizeBytes), onClick = { openEntry(entry, open) }, onLongClick = { sheetFor = entry },
                    end = {
                        IconButton(onClick = { sheetFor = entry }, Modifier.size(36.dp).testTag("documents-more:${entry.name}")) {
                            Icon(painterResource(R.drawable.ic_more), "Actions for ${entry.name}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    })
            }
            // A file still going up sits in its folder with its bar (board frame 13).
            items(here, key = { "upload:${it.id}" }) { upload ->
                DocumentsRow(upload.name, AnnotatedString(DocumentsLogic.uploadingInFolder(upload)), Modifier.testTag("documents-uploading:${upload.name}"),
                    leading = { EntryIcon(DocumentsLogic.icon(upload.name)) }, trailing = DocumentsLogic.formatSize(upload.size),
                    progress = upload.percent / 100f, onClick = { uploadsSheet = true })
            }
            if (listing != null && entries.isEmpty() && here.isEmpty() && !root) item {
                Text("This folder is empty.", Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (root && listing != null) {
                item { HorizontalDivider(Modifier.padding(vertical = 6.dp), color = MaterialTheme.colorScheme.outlineVariant) }
                item {
                    DocumentsRow(DocumentsLogic.TRASH, null, Modifier.testTag("documents-trash-row"), leading = { SmallIcon(R.drawable.ic_trash) },
                        trailing = trashCount?.let(DocumentsLogic::items), onClick = { open(OrbitRoute(Destination.DOCUMENTS_TRASH)) })
                }
                item {
                    DocumentsRow(DocumentsLogic.STORAGE, null, Modifier.testTag("documents-storage-row"), leading = { SmallIcon(R.drawable.ic_chart) },
                        trailing = total?.let(DocumentsLogic::storageSize), onClick = { open(OrbitRoute(Destination.DOCUMENTS_STORAGE)) })
                }
            }
        }
        ExtendedFloatingActionButton(text = { Text(DocumentsLogic.UPLOAD, fontWeight = FontWeight.Medium) },
            icon = { Icon(painterResource(R.drawable.ic_upload), null) }, onClick = { uploadSheet = true },
            expanded = !list.isScrollInProgress, containerColor = MaterialTheme.colorScheme.secondaryContainer,
            contentColor = MaterialTheme.colorScheme.onSecondaryContainer, shape = RoundedCornerShape(16.dp),
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 22.dp).testTag("documents-upload"))
        DocumentsSnackbar(snackbar, Modifier.align(Alignment.BottomCenter).padding(start = 12.dp, end = 12.dp, bottom = 90.dp))
    }

    sheetFor?.let { entry ->
        RowActionsSheet(store, entry, onDismiss = { sheetFor = null }, rename = { renaming = entry }, move = { moving = entry },
            download = { actions.download(entry) }, sendCopy = { actions.handOff(entry, ShareSend) }, share = { sharing = entry },
            trash = { actions.trash(entry) })
    }
    renaming?.let { entry -> NameDialog(DocumentsLogic.RENAME, entry.name, DocumentsLogic.RENAME, { renaming = null }) { actions.rename(entry, it); renaming = null } }
    moving?.let { entry -> MoveDialog(store, entry, actions) { moving = null } }
    sharing?.let { entry -> ShareDialog(store, entry) { sharing = null } }
    if (naming) NameDialog(DocumentsLogic.NEW_FOLDER, DocumentsLogic.NEW_FOLDER, "Create", { naming = false }) { name ->
        naming = false; actions.newFolder(target, name)
    }
    if (uploadSheet) ModalBottomSheet(onDismissRequest = { uploadSheet = false }, containerColor = sheetColor(), modifier = Modifier.testTag("documents-upload-sheet")) {
        Text(DocumentsLogic.uploadTo(folderName), Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp), fontSize = 16.sp, fontWeight = FontWeight.Medium)
        SheetItem(R.drawable.ic_doc, DocumentsLogic.PICK_FILES, tag = "documents-pick-files") { uploadSheet = false; files.launch(arrayOf("*/*")) }
        SheetItem(R.drawable.ic_image, DocumentsLogic.PICK_PHOTOS, tag = "documents-pick-photos") {
            uploadSheet = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
        }
        SheetItem(R.drawable.ic_folder, DocumentsLogic.PICK_FOLDER, tag = "documents-pick-folder") { uploadSheet = false; tree.launch(null) }
        HorizontalDivider(Modifier.padding(vertical = 4.dp), color = MaterialTheme.colorScheme.outlineVariant)
        SheetItem(R.drawable.ic_folder_plus, DocumentsLogic.NEW_FOLDER) { uploadSheet = false; naming = true }
        Spacer(Modifier.height(12.dp))
    }
    if (uploadsSheet) UploadsSheet(store, openSession, openFolder = { id, name -> open(OrbitRoute(Destination.DOCUMENTS, id, recordId = name)) }) { uploadsSheet = false }
}

internal fun openEntry(entry: DocumentsEntry, open: (OrbitRoute) -> Unit) {
    if (entry.isFolder) open(OrbitRoute(Destination.DOCUMENTS, entry.id, recordId = entry.name))
    else open(OrbitRoute(Destination.DOCUMENTS_FILE, entry.id, folderId = entry.parentId, recordId = entry.name))
}

@Composable
internal fun SmallIcon(res: Int) {
    Box(Modifier.size(DocumentsMetrics.icon), contentAlignment = Alignment.Center) {
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
            if (query.isEmpty()) Text(DocumentsLogic.SEARCH, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            BasicTextField(query, onChange, Modifier.fillMaxWidth().testTag("documents-search"), singleLine = true,
                textStyle = TextStyle(fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurface), cursorBrush = SolidColor(MaterialTheme.colorScheme.primary))
        }
        if (query.isNotEmpty()) Icon(painterResource(R.drawable.ic_clear), "Clear", Modifier.size(20.dp).clickable { onChange("") },
            tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** While anything goes up, a card at the top of the folder counts uploads and syncs together (board frame 7 ①). */
@Composable
internal fun UploadsCard(store: DocumentsStore, show: () -> Unit) {
    val uploads by store.uploads.items.collectAsState()
    val (title, bytes) = DocumentsLogic.trayTitle(uploads, store.syncs)
    Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp).fillMaxWidth()
        .background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(16.dp)).clickable(onClick = show)
        .padding(horizontal = 16.dp, vertical = 12.dp).testTag("documents-uploads-card"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(painterResource(R.drawable.ic_upload), null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
        Text(androidx.compose.ui.text.buildAnnotatedString {
            pushStyle(androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Medium)); append(title); pop()
            bytes?.let { append(" · $it") }
        }, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSecondaryContainer, fontSize = 15.sp)
        Text(DocumentsLogic.SHOW, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Medium)
    }
}

@Composable
internal fun ErrorBlock(message: String, retry: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(message, color = MaterialTheme.colorScheme.error)
        OutlinedButton(onClick = retry) { Text(DocumentsLogic.TRY_AGAIN) }
    }
}

/** The board's snackbar: the inverse surface with the action in #8AC6FF (`.snack`). */
@Composable
internal fun DocumentsSnackbar(state: SnackbarHostState, modifier: Modifier = Modifier) {
    SnackbarHost(state, modifier.testTag("documents-snackbar")) { data ->
        Snackbar(data, containerColor = Color(0xFF313033), contentColor = Color(0xFFF4EFF4), actionColor = Color(0xFF8AC6FF),
            shape = RoundedCornerShape(6.dp))
    }
}
