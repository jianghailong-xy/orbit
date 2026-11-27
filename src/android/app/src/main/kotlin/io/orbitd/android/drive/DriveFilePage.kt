package io.orbitd.android.drive

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.core.drive.DriveEntry
import io.orbitd.android.core.drive.DriveLogic
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.wiki.PageBar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private sealed interface Loaded {
    data object Loading : Loaded
    data class Picture(val bitmap: Bitmap, val width: Int, val height: Int) : Loaded
    data class Words(val text: String, val cut: Boolean) : Loaded
    data object Failed : Loaded
}

/**
 * A file (board frame 8; iPhone frame 5 for Markdown): a picture with pinch to zoom and a swipe to the folder's next picture; Markdown
 * rendered as the Wiki renders it, read-only; text as it is; any other file its icon with Download and Open with…. Under it the
 * file's kind and size, who last wrote it (the writer opens its session), its earlier versions, and Download and Share link….
 */
@Composable
internal fun DriveFilePage(store: DriveStore, route: OrbitRoute, open: (OrbitRoute) -> Unit, openSession: (String) -> Unit, back: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val actions = remember(store) { DriveActions(context, store, scope, snackbar) }
    var fileId by remember { mutableStateOf(route.id!!) }
    var entry by remember { mutableStateOf<DriveEntry?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var siblings by remember { mutableStateOf<List<DriveEntry>>(emptyList()) }
    var earlier by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(fileId, store.revision) {
        runCatching { store.api.entry(fileId) }.onSuccess { entry = it; error = null }.onFailure { if (entry == null) error = store.failure("read the file", it) }
        earlier = runCatching { store.api.versions(fileId).versions.count { !it.current } }.getOrNull()
    }
    LaunchedEffect(route.folderId, store.revision) {
        siblings = runCatching { store.api.folder(route.folderId) }.getOrNull()?.entries.orEmpty()
            .let(DriveLogic::sorted).filter { it.isFile && DriveLogic.preview(it.name, it.sizeBytes) == DriveLogic.Preview.PICTURE }
    }
    val shown = entry
    val name = shown?.name ?: route.recordId ?: ""
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    var sharing by remember { mutableStateOf(false) }
    // The chat's chips: the file's folder and the file (board ① note: a file's page adds its name).
    LaunchedEffect(shown?.id, shown?.path) {
        shown?.let { file ->
            val folderName = file.path?.substringBeforeLast('/')?.substringAfterLast('/')?.ifEmpty { null } ?: DriveLogic.TITLE
            store.chat.here = DriveChatHere(file.parentId?.takeIf { file.path?.substringBeforeLast('/')?.isNotEmpty() == true }, folderName, file.id, file.name)
        }
    }
    PageBar.Bind(route, name, folds = store.chat.shown && store.chat.expanded, actions = {
        IconButton(onClick = { shown?.let { actions.handOff(it, ShareSend) } }, enabled = shown != null) { Icon(painterResource(R.drawable.ic_share), DriveLogic.SEND_A_COPY) }
        Box {
            IconButton(onClick = { menu = true }, Modifier.testTag("drive-file-more")) { Icon(painterResource(R.drawable.ic_more), "More") }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(DriveLogic.RENAME) }, onClick = { menu = false; renaming = true })
                DropdownMenuItem(text = { Text(DriveLogic.MOVE_TO) }, onClick = { menu = false; moving = true })
                DropdownMenuItem(text = { Text(DriveLogic.OPEN_WITH) }, onClick = { menu = false; shown?.let { actions.handOff(it, ShareView) } })
                DropdownMenuItem(text = { Text(DriveLogic.MOVE_TO_TRASH, color = MaterialTheme.colorScheme.error) },
                    onClick = { menu = false; shown?.let { actions.trash(it, back) } })
            }
        }
    })
    Box(Modifier.fillMaxSize().testTag("drive-file")) {
        if (shown == null) {
            error?.let { ErrorBlock(it) { error = null; store.changed() } } ?: LinearProgressIndicator(Modifier.fillMaxWidth().padding(20.dp))
        } else {
            val kind = DriveLogic.preview(shown.name, shown.sizeBytes)
            val folder = shown.path?.substringBeforeLast('/')?.let(DriveLogic::folderLabel)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                var size by remember { mutableStateOf<Pair<Int, Int>?>(null) }
                when (kind) {
                    DriveLogic.Preview.PICTURE -> {
                        val pages = siblings.takeIf { list -> list.any { ObjectId.same(it.id, shown.id) } } ?: listOf(shown)
                        val start = pages.indexOfFirst { ObjectId.same(it.id, shown.id) }.coerceAtLeast(0)
                        val pager = rememberPagerState(start) { pages.size }
                        LaunchedEffect(pager.currentPage, pages) {
                            val now = pages.getOrNull(pager.currentPage) ?: return@LaunchedEffect
                            if (!ObjectId.same(now.id, fileId)) { fileId = now.id; size = null }
                        }
                        HorizontalPager(pager, Modifier.fillMaxWidth().height(310.dp).background(Color(0xFF0F0F12)), key = { pages[it].id }) { page ->
                            PicturePage(store, pages[page]) { w, h -> if (ObjectId.same(pages[page].id, fileId)) size = w to h }
                        }
                    }
                    else -> {}
                }
                Column(Modifier.fillMaxWidth().padding(horizontal = DriveMetrics.side, vertical = 10.dp)) {
                    Text(shown.name, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                    Text(DriveLogic.infoLine(shown, folder, size?.first, size?.second), fontSize = DriveMetrics.line,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("drive-file-info"))
                }
                when (kind) {
                    DriveLogic.Preview.MARKDOWN, DriveLogic.Preview.TEXT -> WordsPreview(store, shown, kind)
                    DriveLogic.Preview.PICTURE -> {}
                    else -> Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        EntryIcon(DriveLogic.icon(shown), Modifier.size(64.dp))
                        Text(DriveLogic.NO_PREVIEW, Modifier.padding(top = 10.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(onClick = { actions.handOff(shown, ShareView) }) { Text(DriveLogic.OPEN_WITH) }
                    }
                }
                WriterCard(store, shown, earlier, openSession) { open(OrbitRoute(Destination.DRIVE_TRASH)) }
                // 88 under the buttons, so the chat's round button never covers them (board frame 4 note).
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 88.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onClick = { actions.download(shown) }, Modifier.weight(1f).testTag("drive-file-download")) { Text(DriveLogic.DOWNLOAD) }
                    Button(onClick = { sharing = true }, Modifier.weight(1f).testTag("drive-file-share")) { Text(DriveLogic.SHARE_LINK) }
                }
            }
            if (renaming) NameDialog(DriveLogic.RENAME, shown.name, DriveLogic.RENAME, { renaming = false }) { actions.rename(shown, it) { e -> entry = e }; renaming = false }
            if (moving) MoveDialog(store, shown, actions) { moving = false }
            if (sharing) ShareDialog(store, shown) { sharing = false }
        }
        DriveSnackbar(snackbar, Modifier.align(Alignment.BottomCenter).padding(12.dp))
    }
}

@Composable
private fun PicturePage(store: DriveStore, entry: DriveEntry, measured: (Int, Int) -> Unit) {
    val loaded by produceState<Loaded>(Loaded.Loading, entry.id, entry.currentVersionId) {
        value = runCatching {
            val bytes = store.api.content(entry.id, limit = DriveLogic.PICTURE_PREVIEW_BYTES + 1)
            withContext(Dispatchers.Default) {
                val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                val bitmap = decodeThumb(bytes, 2048) ?: return@withContext Loaded.Failed
                Loaded.Picture(bitmap, bounds.outWidth, bounds.outHeight)
            }
        }.getOrDefault(Loaded.Failed)
    }
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(androidx.compose.ui.geometry.Offset.Zero) }
    Box(Modifier.fillMaxSize().padding(horizontal = 40.dp, vertical = 26.dp), contentAlignment = Alignment.Center) {
        when (val l = loaded) {
            Loaded.Loading -> CircularProgressIndicator(color = Color.White)
            is Loaded.Picture -> {
                LaunchedEffect(l) { measured(l.width, l.height) }
                Image(l.bitmap.asImageBitmap(), entry.name, Modifier.fillMaxSize().testTag("drive-picture")
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 5f)
                            offset = if (scale == 1f) androidx.compose.ui.geometry.Offset.Zero else offset + pan
                        }
                    }
                    .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y))
            }
            else -> Text(DriveLogic.PREVIEW_FAILED, color = Color.White)
        }
    }
}

@Composable
private fun WordsPreview(store: DriveStore, entry: DriveEntry, kind: DriveLogic.Preview) {
    val loaded by produceState<Loaded>(Loaded.Loading, entry.id, entry.currentVersionId) {
        val limit = DriveLogic.previewBytes(kind, entry.sizeBytes)
        value = runCatching { store.api.content(entry.id, maxBytes = limit) }
            .map { Loaded.Words(it.decodeToString(), limit != null) }.getOrDefault(Loaded.Failed)
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = DriveMetrics.side, vertical = 8.dp).testTag("drive-words")) {
        when (val l = loaded) {
            Loaded.Loading -> LinearProgressIndicator(Modifier.fillMaxWidth())
            is Loaded.Words -> {
                if (kind == DriveLogic.Preview.MARKDOWN) MarkdownText(l.text)
                else Text(l.text, Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                if (l.cut) Text(DriveLogic.previewCut(DriveLogic.TEXT_PREVIEW_BYTES), Modifier.padding(top = 8.dp), fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> Text(DriveLogic.PREVIEW_FAILED, color = MaterialTheme.colorScheme.error)
        }
    }
}

/** Who wrote it, with its session, and the earlier versions (board frame 8 ①). */
@Composable
private fun WriterCard(store: DriveStore, entry: DriveEntry, earlier: Int?, openSession: (String) -> Unit, openTrash: () -> Unit) {
    val session = DriveLogic.writerSession(entry.lastWriter)
    val name = store.writerName(entry.lastWriter)
    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 12.dp).fillMaxWidth()
        .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp))) {
        DriveRow(name, null, Modifier.testTag("drive-file-writer"), leading = {
            Box(Modifier.size(30.dp).background(if (entry.lastWriter.isOwner) MaterialTheme.colorScheme.primary else Color(0xFF1C1C1E), CircleShape),
                contentAlignment = Alignment.Center) {
                Text(if (entry.lastWriter.isOwner) "Y" else "A", color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
        }, onClick = session?.let { { openSession(ObjectId.canonical(it) ?: it) } }, end = if (session != null) ({
            Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.padding(end = 12.dp).size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }) else null, overline = DriveLogic.lastWritten(entry))
        DriveRow(DriveLogic.EARLIER_VERSIONS, null, leading = { SmallIcon(R.drawable.ic_restore) },
            trailing = earlier?.let { DriveLogic.earlierVersions(it) + if (it > 0) " ›" else "" },
            onClick = if ((earlier ?: 0) > 0) openTrash else null)
    }
}
