package io.orbitd.android.cards

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.net.Uri
import android.provider.DocumentsContract
import android.util.LruCache
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import io.orbitd.android.R
import io.orbitd.android.attachments.decodeAttachmentImage
import io.orbitd.android.attachments.handOffFile
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.text.ReaderResources
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.ui.OrbitTheme
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/*
 * What a version of evidence cites, on its card (docs/orbit-files-design.md §2.6; the web's `EvidenceFiles.tsx`): the file area under
 * the criterion, the Evidence files page it opens, and the viewer a thumbnail opens.
 *
 * ONLY A RASTER IMAGE IS EVER DRAWN. Every byte here was written by whoever submitted the evidence. `EvidenceFiles.isPicture` is the one
 * test for what is decoded, and what is decoded is decoded by BitmapFactory into pixels and nothing else. Everything else, SVG and HTML
 * included, is a tile that can be saved through the system's own save screen or shared: no web view draws it and no other app is asked to open it.
 *
 * WHAT OUTLIVES THE BYTES. The list and the summaries are read from rows, so an expired file keeps its name, its size, its sha256 and its
 * report here. Only its picture goes.
 */

/** Set where the conversation draws its cards: a card anywhere else draws no file area. */
internal val LocalEvidenceFiles = staticCompositionLocalOf<EvidenceFilesStore?> { null }

/** The thumbnails a conversation keeps in memory: about fifty-six. */
private const val THUMBNAIL_BYTES = 32 * 1024 * 1024
/** A thumbnail's side in pixels, enough for a tile on a phone. */
internal const val THUMBNAIL_SIDE = 384
/** A dot for each picture while that can be told apart on a phone; past it the position alone says where you are. */
private const val MOST_DOTS = 20

/**
 * What a conversation holds of the files its evidence cards cite: each version's list, the thumbnails, and which page is open. A card
 * is a row of the transcript, recycled as it scrolls, so these live with `SessionCardsModel` rather than the row: scrolling back to a
 * card reads nothing again, and the page stays open over a card the list has scrolled away.
 */
@Stable
class EvidenceFilesStore internal constructor(private val auth: AuthSession, private val handle: SessionHandle, internal val scope: CoroutineScope,
    private val page: MutableState<String?>) {
    private val versions = HashMap<String, EvidenceFileVersion>()
    internal val thumbnails = object : LruCache<String, Bitmap>(THUMBNAIL_BYTES) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    /** A file can be 25 MiB, and it is read whole: two at a time, for a tile, the viewer or a hand-off alike. */
    internal val reads = Semaphore(2)

    /** The card whose page is open, by its address: kept across the Activity being recreated. */
    val openCard: String? get() = page.value
    fun open(card: String) { page.value = card }
    fun close() { page.value = null }

    fun version(task: String, revision: String) = versions.getOrPut("$task:$revision") { EvidenceFileVersion(auth, handle, scope, task, revision) }
    /** What the conversation reads again when it reconnects: the lists that could not be read before. */
    fun readAgain() = versions.values.forEach { if (it.unread) it.read() }

    /** The files with a press of their pin on its way. */
    internal val pinning = mutableStateSetOf<String>()

    /**
     * Press a file's pin, either way. A file can be cited by several versions of its task, so the answer goes into every list read of that
     * task. Told its bytes have gone since the list was read, the file stops offering a pin. [refused] says what a press that did not go through says.
     */
    internal fun pressPin(task: String, file: EvidenceFile, refused: (String) -> Unit) {
        if (!pinning.add(file.id)) return
        val pin = !EvidenceFiles.isPinned(file)
        fun change(update: (EvidenceFile) -> EvidenceFile) =
            versions.forEach { (key, version) -> if (key.startsWith("$task:")) version.change(file.id, update) }
        scope.launch {
            try {
                val answer = Wire.decode(auth.request(handle, EvidenceFiles.pinRequest(file.id, pin)).body, EvidenceFilePinAnswer.serializer())
                change { EvidenceFiles.withPin(it, answer) }
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) {
                if (EvidenceFiles.isExpiredRead(failure)) change { it.copy(pinnable = false) }
                refused(if (pin) EvidenceFiles.pinFailed else EvidenceFiles.unpinFailed)
            } finally { pinning -= file.id }
        }
    }
}

/** One version's list, a page at a time. The heading's count and size are the whole list's on every page. */
@Stable
class EvidenceFileVersion internal constructor(private val auth: AuthSession, private val handle: SessionHandle, private val scope: CoroutineScope,
    private val task: String, private val revision: String) {
    var list by mutableStateOf<EvidenceFileList?>(null); private set
    /** The last read failed, and nothing has been read since. */
    var unread by mutableStateOf(false); private set
    var readingMore by mutableStateOf(false); private set
    private var reading = false

    /** A page can be 1.7 MB of JSON, so it is not decoded on the main thread. */
    private suspend fun page(offset: Int): EvidenceFilePage {
        val body = auth.request(handle, EvidenceFiles.request(task, revision, offset)).body
        return withContext(Dispatchers.Default) { Wire.decode(body, EvidenceFilePage.serializer()) }
    }

    /** One file changed, wherever the list holds it. */
    internal fun change(id: String, update: (EvidenceFile) -> EvidenceFile) { list = list?.updating(id, update) }

    /** Reads the first page, unless it has been read or is on its way. */
    fun read() {
        if (list != null || reading) return
        reading = true
        scope.launch {
            try {
                val first = page(0)
                list = EvidenceFileList(first.submittedAt, first.fileCount, first.totalBytes, emptyList()) + first
                unread = false
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { unread = true }
            finally { reading = false }
        }
    }

    /** Reads the list's next page. One that does not come is pressed again: what is drawn stays. */
    fun more() {
        val offset = list?.nextOffset ?: return
        if (readingMore) return
        readingMore = true
        scope.launch {
            try { page(offset).let { next -> list = list?.plus(next) } }
            catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { }
            finally { readingMore = false }
        }
    }
}

/** One surface's pictures: the store's thumbnails, and what would not come back or would not draw, which that surface draws as a file. */
@Stable
private class EvidencePictures(private val resources: ReaderResources, private val store: EvidenceFilesStore) {
    val failed = mutableStateSetOf<String>()
    fun held(id: String): Bitmap? = store.thumbnails[id]
    private suspend fun bytes(id: String) = resources.bytes("orbit-attachment:$id")
    suspend fun <T> withBytes(id: String, use: suspend (ByteArray) -> T): T = store.reads.withPermit { use(bytes(id)) }
    suspend fun thumbnail(id: String): Bitmap? = held(id) ?: try {
        store.reads.withPermit {
            held(id) ?: bytes(id).let { data -> withContext(Dispatchers.Default) { decodeThumbnail(data) }.also { store.thumbnails.put(id, it) } }
        }
    } catch (cancel: CancellationException) { throw cancel }
    catch (_: Exception) { failed += id; null }
}

/** What a tile draws of a picture, and all that is kept of it: its top as a square, where a page keeps what it is about, at one size. A
 * long screenshot keeps the width a tile needs, and no tile holds more than this however large its picture is. */
internal fun decodeThumbnail(data: ByteArray): Bitmap {
    val picture = decodeAttachmentImage({ data.inputStream() })
    val side = minOf(picture.width, picture.height)
    val square = Bitmap.createBitmap(picture, (picture.width - side) / 2, 0, side, side)
    val thumbnail = if (side > THUMBNAIL_SIDE) Bitmap.createScaledBitmap(square, THUMBNAIL_SIDE, THUMBNAIL_SIDE, true) else square
    if (square !== thumbnail && square !== picture) square.recycle()
    if (picture !== thumbnail) picture.recycle()
    return thumbnail
}

/** The grey every tile without a picture has: the card's own text colour, faint, on whichever surface it sits. */
@Composable
private fun tileFill() = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.10f)

private val tileShape = RoundedCornerShape(8.dp)

/** One thumbnail, on the card and on the page. A tile never stretches with its picture: an expired one has the board's dashed outline. */
@Composable
private fun Tile(modifier: Modifier, dashed: Boolean = false, square: Boolean = true, content: @Composable BoxScope.() -> Unit) {
    val outline = MaterialTheme.colorScheme.outline
    val edge = if (dashed) Modifier.drawWithContent {
        drawContent()
        drawRoundRect(outline, cornerRadius = CornerRadius(8.dp.toPx()),
            style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
    } else Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, tileShape)
    Box((if (square) modifier.aspectRatio(1f) else modifier).then(edge).clip(tileShape).background(tileFill()), contentAlignment = Alignment.Center, content = content)
}

/** What a file whose bytes have gone leaves in a conversation: a card's expired tile, at the size [modifier] gives it. No date from a server that does not say when. */
@Composable
internal fun ExpiredAttachmentFace(at: String?, modifier: Modifier = Modifier) = Tile(modifier, dashed = true, square = false) {
    TileWords(listOfNotNull(EvidenceFiles.expired, at?.let { EvidenceFiles.expiryDate(it) }).joinToString("\n"))
}

@Composable
private fun TileWords(words: String, weight: FontWeight? = null) = Text(words, Modifier.padding(4.dp), style = MaterialTheme.typography.labelSmall,
    fontWeight = weight, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis)

/** What fills a tile: its thumbnail, the grey that takes its place once it has expired, or the file's kind. A row that went took its date
 * with it. */
@Composable
private fun TileFace(file: EvidenceFile, pictures: EvidencePictures) {
    when {
        EvidenceFiles.isGone(file) -> TileWords(listOfNotNull(EvidenceFiles.expired, file.expiredAt?.let { EvidenceFiles.expiryDate(it) }).joinToString("\n"))
        !EvidenceFiles.isPicture(file) || file.id in pictures.failed -> TileWords(EvidenceFiles.kind(file), FontWeight.SemiBold)
        else -> {
            val bitmap by produceState(pictures.held(file.id), file.id) { if (value == null) value = pictures.thumbnail(file.id) }
            bitmap?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize().testTag("evidence-files:picture:${file.id}"), contentScale = ContentScale.Crop) }
        }
    }
}

@Composable
private fun ReportMark(report: EvidenceTestReport, quiet: Boolean) {
    val failed = report.failed > 0
    Icon(painterResource(if (failed) R.drawable.ic_x_circle else R.drawable.ic_check_circle), null, Modifier.size(16.dp), tint = when {
        failed -> MaterialTheme.colorScheme.error
        quiet -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> LocalOrbitColors.current.success
    })
}

/** The report's line on the card, with the failed cases it can name. The page has the rest. */
@Composable
private fun ReportLine(report: EvidenceTestReport, quiet: Boolean, tag: String) {
    val names = report.failedNames.take(EvidenceFiles.reportNamesShown)
    val rest = report.failed - names.size
    val small = MaterialTheme.typography.bodySmall
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val strong = MaterialTheme.colorScheme.onSurface
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ReportMark(report, quiet)
            Text(buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = strong)) { append(EvidenceFiles.reportFormat(report)) }
                append(" · ${EvidenceFiles.reportCounts(report)}")
            }, Modifier.testTag(tag), style = small, color = muted)
        }
        names.forEach { Text(it, Modifier.padding(start = 22.dp), style = small, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        if (names.isNotEmpty() && rest > 0) Text(EvidenceFiles.reportNamesMore(rest), Modifier.padding(start = 22.dp), style = small, color = muted)
    }
}

/**
 * The file area: a heading, up to four thumbnails and what a report said. One press, because what it does is one thing: it opens the
 * page, where the whole set can be paged. Its height does not depend on the read: the row is held open for the tiles while the list
 * comes, so a card that is on screen does not move what is under it. A version that cites no file draws none of this and reads nothing.
 */
@Composable
internal fun EvidenceFilesArea(card: InteractionCard) {
    val store = LocalEvidenceFiles.current ?: return
    val resources = LocalReaderResources.current ?: return
    val citations = card.source.objects("citations")
    // A version that has left the read is nobody's question now, as on the web, and a conversation can keep eighty of those copies.
    if (!EvidenceFiles.cites(citations) || card.status == CardPreviews.stale) return
    val task = card.source.text("taskId") ?: return
    val revision = card.source.text("evidenceRevision") ?: return
    val version = remember(store, task, revision) { store.version(task, revision) }
    LaunchedEffect(version) { version.read() }
    val pictures = remember(resources, store) { EvidencePictures(resources, store) }
    val list = version.list
    val reports = remember(citations) { EvidenceFiles.reports(citations) }
    val quiet = list != null && EvidenceFiles.allGone(list)
    Column(Modifier.fillMaxWidth().clip(tileShape).clickable(role = Role.Button) { store.open(card.key) }.testTag("${card.key}:files"),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(list?.let { EvidenceFiles.headline(it) } ?: EvidenceFiles.heading, Modifier.testTag("${card.key}:files-head"),
            style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            // The board's 56, and five of them with their gaps on any phone.
            val side = min(56.dp, (maxWidth - 8.dp * EvidenceFiles.shown) / (EvidenceFiles.shown + 1))
            if (list == null) Box(Modifier.height(side), contentAlignment = Alignment.CenterStart) {
                Text(if (version.unread) EvidenceFiles.unread else EvidenceFiles.loading, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val onCard = remember(list) { EvidenceFiles.onCard(list) }
                onCard.shown.forEach { file -> key(file.id) {
                    Tile(Modifier.size(side).testTag("${card.key}:files-tile:${file.id}"), dashed = EvidenceFiles.isGone(file)) { TileFace(file, pictures) }
                } }
                if (onCard.rest > 0) Tile(Modifier.size(side).testTag("${card.key}:files-more")) {
                    Text(EvidenceFiles.more(onCard.rest), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        reports.forEachIndexed { index, report -> ReportLine(report, quiet, "${card.key}:files-report:$index") }
    }
}

/**
 * The Evidence files page: which version and how much of it, what its reports said, and every file by the folder it was uploaded in.
 * Hosted by the reader beside the review, as a sheet from the bottom, so the rail's rows cannot dismiss it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EvidenceFilesSheet(cards: SessionCardsModel) {
    val store = cards.evidenceFiles
    val key = store.openCard ?: return
    val (_, session) = cardSession() ?: return
    val resources = LocalReaderResources.current ?: return
    val card = cards.shown(session).firstOrNull { it.key == key }
    val task = card?.source?.text("taskId")
    val revision = card?.source?.text("evidenceRevision")
    if (card == null || task == null || revision == null) {
        // Only once the conversation has been read: a page reopened after the process was killed waits for that.
        if (session.fresh) LaunchedEffect(key) { store.close() }
        return
    }
    val version = remember(store, task, revision) { store.version(task, revision) }
    // A list that could not be read gets another try as its page opens.
    LaunchedEffect(version) { version.read() }
    ModalBottomSheet(onDismissRequest = { store.close() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        dragHandle = { BottomSheetDefaults.DragHandle() }) {
        Column(Modifier.fillMaxWidth().fillMaxHeight().testTag("evidence-files")) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(EvidenceFiles.title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton(onClick = { store.close() }, Modifier.testTag("evidence-files:close")) {
                    Icon(painterResource(R.drawable.ic_close), CardPreviews.close)
                }
            }
            HorizontalDivider()
            val listed = version.list?.files.orEmpty()
            EvidenceFilesPage(store, task, revision, version, remember(card.source, listed) { EvidenceFiles.reports(card.source.objects("citations"), listed) },
                remember(resources, store) { EvidencePictures(resources, store) }, store.scope)
        }
    }
}

private class SaveFileRequest(val name: String, val mime: String)

/** The system's own save screen, for a file of any type: what it is called and what it is are the press's. */
private object SaveFile : ActivityResultContract<SaveFileRequest, Uri?>() {
    override fun createIntent(context: Context, input: SaveFileRequest) = Intent(Intent.ACTION_CREATE_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE).setType(input.mime).putExtra(Intent.EXTRA_TITLE, input.name)
    override fun parseResult(resultCode: Int, intent: Intent?) = intent?.data.takeIf { resultCode == Activity.RESULT_OK }
}

private const val ANY_BYTES = "application/octet-stream"

/** The two things a file with bytes can be handed to, and what the last one said. The page takes a door out of reach while one is busy. */
@Stable
private class FileDoors(private val pictures: EvidencePictures, private val context: Context, private val page: CoroutineScope, private val conversation: CoroutineScope) {
    var busy by mutableStateOf(false); private set
    var notice by mutableStateOf<String?>(null); private set
    var refused by mutableStateOf(false); private set

    /** What a press elsewhere on the page said, where the eye looks for what these say. */
    fun refuse(words: String) { notice = words; refused = true }

    private fun hand(scope: CoroutineScope, id: String, done: String?, failure: String, undo: () -> Unit = {}, action: suspend (ByteArray) -> Unit) {
        busy = true; notice = null; refused = false
        // Handing a file on starts another app's screen, which is the main thread's to do however the bytes came.
        scope.launch(Dispatchers.Main.immediate) {
            try { pictures.withBytes(id) { action(it) }; notice = done }
            catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { undo(); notice = failure; refused = true }
            finally { busy = false }
        }
    }

    fun share(file: EvidenceFile) = hand(page, file.id, null, EvidenceFiles.shareFailed) { data ->
        handOffFile(context, EvidenceFiles.saveName(file), file.mimeType ?: ANY_BYTES, data, Intent.ACTION_SEND)
    }

    /** With the conversation's scope: the system's screen has already made the file, so closing the page does not leave it empty. One that
     * could not be written is not left behind empty either. */
    fun write(id: String, to: Uri) {
        val files = context.applicationContext.contentResolver
        hand(conversation, id, EvidenceFiles.saved, EvidenceFiles.downloadFailed, undo = { runCatching { DocumentsContract.deleteDocument(files, to) } }) { data ->
            withContext(Dispatchers.IO) { files.openOutputStream(to)?.use { it.write(data) } ?: error("Unavailable destination") }
        }
    }
}

/** What the last hand-off said, where the eye is after it: under the page's heading, over the viewer's caption. */
@Composable
private fun DoorsNotice(doors: FileDoors) {
    if (doors.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    doors.notice?.let { Text(it, Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("evidence-files:notice"), style = MaterialTheme.typography.bodySmall,
        color = if (doors.refused) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
}

/** The two things only: Download and Share. Neither opens the file. */
@Composable
private fun FileDoorsMenu(expanded: Boolean, enabled: Boolean, dismiss: () -> Unit, save: () -> Unit, share: () -> Unit) {
    DropdownMenu(expanded, dismiss) {
        DropdownMenuItem(text = { Text(EvidenceFiles.download) }, onClick = { dismiss(); save() }, modifier = Modifier.testTag("evidence-files:download"), enabled = enabled)
        DropdownMenuItem(text = { Text(EvidenceFiles.share) }, onClick = { dismiss(); share() }, modifier = Modifier.testTag("evidence-files:share"), enabled = enabled)
    }
}

@Composable
private fun EvidenceFilesPage(store: EvidenceFilesStore, task: String, revision: String, version: EvidenceFileVersion, reports: List<EvidenceTestReport>, pictures: EvidencePictures, conversation: CoroutineScope) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val doors = remember(pictures, context, scope) { FileDoors(pictures, context, scope, conversation) }
    // The file the system's save screen is up for, and the picture the viewer is on: both outlive the Activity being recreated.
    var saving by rememberSaveable { mutableStateOf<String?>(null) }
    var viewing by rememberSaveable { mutableStateOf<String?>(null) }
    val saveTo = rememberLauncherForActivityResult(SaveFile) { uri ->
        val id = saving
        saving = null
        if (id != null && uri != null) doors.write(id, uri)
    }
    val save = { file: EvidenceFile ->
        saving = file.id
        saveTo.launch(SaveFileRequest(EvidenceFiles.saveName(file), file.mimeType ?: ANY_BYTES))
    }
    val pin = { file: EvidenceFile -> store.pressPin(task, file, doors::refuse) }
    val list = version.list
    val groups = remember(list) { EvidenceFiles.groups(list?.files.orEmpty()) }
    val quiet = list != null && EvidenceFiles.allGone(list)
    val paged = remember(groups, pictures.failed.size) { groups.flatMap { it.files }.filter { EvidenceFiles.isPicture(it) && it.id !in pictures.failed } }
    val shown = paged.firstOrNull { it.id == viewing }
    // A picture that will not draw leaves the set while it is shown, and one on a later page is not in what a recreated Activity has read:
    // the viewer closes for good rather than show nothing, or open by itself once it is read.
    if (viewing != null && list != null && shown == null) LaunchedEffect(viewing) { viewing = null }
    val small = MaterialTheme.typography.bodySmall
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxSize()) {
        DoorsNotice(doors)
        LazyVerticalGrid(GridCells.Adaptive(104.dp), Modifier.fillMaxSize().testTag("evidence-files:grid"), contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                FitsAcross(listOfNotNull(EvidenceFiles.revisionLine(revision) + (list?.let { OwnerReview.receiptTime(it.submittedAt) }?.let { " · $it" } ?: ""),
                    list?.let { EvidenceFiles.count(it) }), "evidence-files:version")
            }
            items(reports.size, span = { GridItemSpan(maxLineSpan) }) { ReportBlock(reports[it], quiet, "evidence-files:report:$it") }
            if (list == null) item(span = { GridItemSpan(maxLineSpan) }) {
                Text(if (version.unread) EvidenceFiles.unread else EvidenceFiles.loading, Modifier.testTag("evidence-files:quiet"), style = small, color = muted)
            }
            groups.forEach { group ->
                item("group:${group.name}", span = { GridItemSpan(maxLineSpan) }) {
                    Text(buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(group.name) }
                        withStyle(SpanStyle(color = muted)) { append("  ${group.files.size}") }
                    }, Modifier.padding(top = 8.dp).testTag("evidence-files:group:${group.name}"), style = small)
                }
                items(group.files, { "file:${it.id}" }) { file ->
                    PageTile(file, pictures, doors.busy, file.id in store.pinning, view = { viewing = file.id }, save = { save(file) }, share = { doors.share(file) }, pin = { pin(file) })
                }
            }
            if (list?.nextOffset != null) item(span = { GridItemSpan(maxLineSpan) }) {
                Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(EvidenceFiles.showing(list.files.size, list.fileCount), Modifier.weight(1f).testTag("evidence-files:showing"), style = small, color = muted)
                    OutlinedButton(onClick = { version.more() }, Modifier.testTag("evidence-files:more"), enabled = !version.readingMore) { Text(EvidenceFiles.showMore) }
                }
            }
        }
    }
    if (shown != null) EvidenceFileViewer(paged, shown, pictures, doors, store, view = { viewing = it }, close = { viewing = null }, save = save, pin = pin)
}

/** Two short lines on one line when they fit, the first starting it and the second ending it, one under the other when they don't. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FitsAcross(lines: List<String>, tag: String) {
    FlowRow(Modifier.fillMaxWidth().testTag(tag), horizontalArrangement = Arrangement.SpaceBetween) {
        lines.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** One report at the top of the page, opening into the cases it failed and skipped. The server keeps twenty names of each: the count
 * is the whole of it. */
@Composable
private fun ReportBlock(report: EvidenceTestReport, quiet: Boolean, tag: String) {
    var open by rememberSaveable { mutableStateOf(false) }
    val lists = listOf(Triple(EvidenceFiles.reportFailed, report.failed, report.failedNames), Triple(EvidenceFiles.reportSkipped, report.skipped, report.skippedNames))
        .filter { it.second > 0 }
    val small = MaterialTheme.typography.bodySmall
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().clip(tileShape).border(1.dp, MaterialTheme.colorScheme.outlineVariant, tileShape)
        .then(if (lists.isEmpty()) Modifier else Modifier.clickable(role = Role.Button) { open = !open }).testTag(tag).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ReportMark(report, quiet)
            Text(EvidenceFiles.reportTitle(report), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            if (lists.isNotEmpty()) Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp).rotate(if (open) 90f else 0f), tint = muted)
        }
        Text(EvidenceFiles.reportFacts(report), Modifier.padding(start = 22.dp), style = small, color = muted)
        if (open) lists.forEach { (word, count, names) ->
            Column(Modifier.padding(start = 22.dp, top = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(EvidenceFiles.reportList(word, count), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = muted)
                names.forEach { Text(it, style = small) }
                if (count > names.size) Text(EvidenceFiles.reportNamesMore(count - names.size), style = small, color = muted)
            }
        }
    }
}

/** A file's pin as a tile's corner draws it: a press where the tile has no viewer to pin it from, and on a picture only the mark that it is pinned. */
@Composable
private fun PinFace(pinned: Boolean, modifier: Modifier = Modifier) {
    val edge = if (pinned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant
    Box(modifier.size(26.dp).background(MaterialTheme.colorScheme.surface, CircleShape).border(1.dp, edge, CircleShape), contentAlignment = Alignment.Center) {
        Icon(painterResource(if (pinned) R.drawable.ic_pin_filled else R.drawable.ic_pin), null, Modifier.size(15.dp),
            tint = if (pinned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A tile on the page. A picture opens the viewer, and any other file with bytes offers its two doors, because neither an SVG nor a page
 * may be opened. An expired one does neither, and says what it was.
 *
 * A picture is pinned from the viewer, so here it only says that it is. Everything else has no viewer: its pin is on the tile, as long as the server offers one. */
@Composable
private fun PageTile(file: EvidenceFile, pictures: EvidencePictures, busy: Boolean, pinning: Boolean, view: () -> Unit, save: () -> Unit, share: () -> Unit, pin: () -> Unit) {
    val gone = EvidenceFiles.isGone(file)
    val picture = EvidenceFiles.isPicture(file) && file.id !in pictures.failed
    val name = EvidenceFiles.name(file)
    val tag = "evidence-files:tile:${file.id}"
    var doors by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box {
            val press = when {
                gone -> Modifier
                picture -> Modifier.clickable(role = Role.Button, onClick = view).semantics { contentDescription = name }
                else -> Modifier.clickable(role = Role.Button) { doors = true }.semantics { contentDescription = EvidenceFiles.downloadName(name) }
            }
            Tile(Modifier.fillMaxWidth().clip(tileShape).then(press).testTag(tag), dashed = gone) { TileFace(file, pictures) }
            if (!gone && !picture) FileDoorsMenu(doors, !busy, { doors = false }, save, share)
            val pinned = EvidenceFiles.isPinned(file)
            if (picture) {
                if (pinned) PinFace(true, Modifier.align(Alignment.TopEnd).padding(6.dp).testTag("$tag:pinned").semantics { contentDescription = EvidenceFiles.pinned })
            } else if (file.pinnable) {
                val word = if (pinned) EvidenceFiles.unpin else EvidenceFiles.pin
                Box(Modifier.align(Alignment.TopEnd).size(44.dp).clickable(enabled = !pinning, role = Role.Button, onClick = pin).testTag("$tag:pin")
                    .semantics { contentDescription = word }, contentAlignment = Alignment.TopEnd) { PinFace(pinned, Modifier.padding(6.dp)) }
            }
        }
        if (!picture) Column {
            Text(EvidenceFiles.saveName(file), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(EvidenceFiles.facts(file), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            EvidenceFiles.keep(file)?.let { Text(it, Modifier.testTag("$tag:keep"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

private class ViewerImage(val bitmap: Bitmap, val width: Int, val height: Int)

/** The picture to draw, and the size it really is: a folder's rows do not record it, and what is drawn may be read down from it. */
private fun decodeViewerImage(data: ByteArray): ViewerImage {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
    val orientation = try { ExifInterface(data.inputStream()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        catch (_: IOException) { ExifInterface.ORIENTATION_NORMAL } // E.g. GIF has no EXIF.
    val turned = orientation in 5..8
    return ViewerImage(decodeAttachmentImage({ data.inputStream() }), if (turned) bounds.outHeight else bounds.outWidth, if (turned) bounds.outWidth else bounds.outHeight)
}

/**
 * The viewer, paging the pictures in the order the page shows them and reading ahead one either way (the board's fourth panel): which of
 * how many, then the picture, then its path, size, dimensions and sha256, with its two doors at the corner. It is dark whatever the
 * theme, as a picture's surround is.
 */
@Composable
private fun EvidenceFileViewer(paged: List<EvidenceFile>, shown: EvidenceFile, pictures: EvidencePictures, doors: FileDoors, store: EvidenceFilesStore, view: (String) -> Unit, close: () -> Unit,
    save: (EvidenceFile) -> Unit, pin: (EvidenceFile) -> Unit) {
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) { OrbitTheme(darkTheme = true) {
        // Black to the screen's edge, so the status bar's icons are the light ones whatever the theme.
        val root = LocalView.current
        LaunchedEffect(root) { (root.parent as? DialogWindowProvider)?.window?.let { WindowCompat.getInsetsController(it, root).isAppearanceLightStatusBars = false } }
        val latest by rememberUpdatedState(paged)
        // Not saved by itself: which picture is saved, by its id, and a position would name another one in a list read again.
        val pager = remember { PagerState(paged.indexOf(shown).coerceAtLeast(0)) { latest.size } }
        LaunchedEffect(pager) { snapshotFlow { pager.currentPage }.collect { page -> latest.getOrNull(page)?.let { view(it.id) } } }
        val sizes = remember { mutableStateMapOf<String, Pair<Int, Int>>() }
        val light = MaterialTheme.colorScheme.onSurface
        val quiet = MaterialTheme.colorScheme.onSurfaceVariant
        Column(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding().testTag("evidence-viewer")) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
                TextButton(onClick = close, Modifier.align(Alignment.CenterStart).testTag("evidence-viewer:done")) { Text(EvidenceFiles.done) }
                Text(EvidenceFiles.position(pager.currentPage + 1, paged.size), Modifier.testTag("evidence-viewer:position"),
                    style = MaterialTheme.typography.titleMedium, color = light)
            }
            // Clipped: a picture pinched larger stays under the row above it, whose Done is how out.
            HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth().clipToBounds().testTag("evidence-viewer:pager"), beyondViewportPageCount = 1, key = { paged[it].id }) { page ->
                val file = paged[page]
                ViewerPage(file, pictures) { width, height -> sizes[file.id] = width to height }
            }
            if (paged.size in 2..MOST_DOTS) Row(Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("evidence-viewer:dots").clearAndSetSemantics { },
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally)) {
                repeat(paged.size) { Box(Modifier.size(6.dp).background(if (it == pager.currentPage) light else light.copy(alpha = 0.3f), CircleShape)) }
            }
            DoorsNotice(doors)
            val current = paged.getOrNull(pager.currentPage) ?: shown
            val size = current.width?.takeIf { it > 0 }?.let { width -> current.height?.takeIf { it > 0 }?.let { width to it } } ?: sizes[current.id]
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(EvidenceFiles.name(current), Modifier.testTag("evidence-viewer:path"), style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace, color = light, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(EvidenceFiles.facts(current, size?.first, size?.second), Modifier.testTag("evidence-viewer:facts"),
                        style = MaterialTheme.typography.bodySmall, color = quiet)
                    EvidenceFiles.keep(current)?.let { Text(it, Modifier.testTag("evidence-viewer:keep"), style = MaterialTheme.typography.bodySmall, color = quiet) }
                }
                if (current.pinnable) {
                    val pinned = EvidenceFiles.isPinned(current)
                    IconButton(onClick = { pin(current) }, Modifier.testTag("evidence-viewer:pin"), enabled = current.id !in store.pinning) {
                        Icon(painterResource(if (pinned) R.drawable.ic_pin_filled else R.drawable.ic_pin),
                            if (pinned) EvidenceFiles.unpin else EvidenceFiles.pin, tint = if (pinned) MaterialTheme.colorScheme.primary else light)
                    }
                }
                var open by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { open = true }, Modifier.testTag("evidence-viewer:doors")) {
                        Icon(painterResource(R.drawable.ic_share), EvidenceFiles.saveOrShare, tint = light)
                    }
                    FileDoorsMenu(open, !doors.busy, { open = false }, { save(current) }, { doors.share(current) })
                }
            }
        }
    } }
}

/** One picture, pinched to look closer as every picture the app opens is. A finger alone moves to the next one until it is pinched. */
@Composable
private fun ViewerPage(file: EvidenceFile, pictures: EvidencePictures, read: (Int, Int) -> Unit) {
    val image by produceState<ViewerImage?>(null, file.id) {
        try {
            value = pictures.withBytes(file.id) { data -> withContext(Dispatchers.Default) { decodeViewerImage(data) } }.also { read(it.width, it.height) }
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { pictures.failed += file.id }
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val loaded = image
        if (loaded == null) CircularProgressIndicator() else {
            var scale by remember { mutableFloatStateOf(1f) }
            var pan by remember { mutableStateOf(Offset.Zero) }
            Image(loaded.bitmap.asImageBitmap(), EvidenceFiles.name(file), Modifier.fillMaxSize().testTag("evidence-viewer:image").pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.size > 1 || scale > 1f) {
                            scale = (scale * event.calculateZoom()).coerceIn(1f, 5f)
                            pan = if (scale > 1f) pan + event.calculatePan() else Offset.Zero
                            event.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }.graphicsLayer { scaleX = scale; scaleY = scale; translationX = pan.x; translationY = pan.y }, contentScale = ContentScale.Fit)
        }
    }
}
