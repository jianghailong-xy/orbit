package io.orbitd.android.documents

import android.graphics.Bitmap
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.core.documents.DocumentsEntry
import io.orbitd.android.core.documents.DocumentsLogic
import io.orbitd.android.core.documents.DocumentsWriter
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The board's rows: 16 sp names, 13.5 sp lines in the variant colour, 20 dp sides, 56 dp tall at least (04-android `.li`). */
internal object DocumentsMetrics {
    val side = 20.dp
    val rowMin = 56.dp
    val icon = 30.dp
    val name = 16.sp
    val line = 13.5.sp
}

/** The icon a row draws: a filled folder in the brand colour, a file's kind in the variant colour. */
@Composable
internal fun EntryIcon(icon: DocumentsLogic.Icon, modifier: Modifier = Modifier) {
    val (res, tint) = when (icon) {
        DocumentsLogic.Icon.FOLDER -> R.drawable.ic_folder_filled to MaterialTheme.colorScheme.primary
        DocumentsLogic.Icon.PICTURE -> R.drawable.ic_image to Color(0xFF3B7BD9)
        DocumentsLogic.Icon.MARKDOWN, DocumentsLogic.Icon.TEXT -> R.drawable.ic_doc_text to MaterialTheme.colorScheme.onSurfaceVariant
        DocumentsLogic.Icon.TABLE -> R.drawable.ic_doc_table to Color(0xFF2E8B57)
        DocumentsLogic.Icon.PDF -> R.drawable.ic_doc_text to Color(0xFFC6402F)
        DocumentsLogic.Icon.ARCHIVE -> R.drawable.ic_doc_archive to MaterialTheme.colorScheme.onSurfaceVariant
        DocumentsLogic.Icon.VIDEO -> R.drawable.ic_video to Color(0xFFC6402F)
        DocumentsLogic.Icon.AUDIO -> R.drawable.ic_audio to MaterialTheme.colorScheme.onSurfaceVariant
        DocumentsLogic.Icon.FILE -> R.drawable.ic_doc to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Icon(painterResource(res), null, modifier.size(DocumentsMetrics.icon), tint = tint)
}

/** A picture's thumbnail where it is small enough to read, else its icon (board frame 3). */
@Composable
internal fun EntryThumb(store: DocumentsStore, entry: DocumentsEntry) {
    val icon = DocumentsLogic.icon(entry)
    if (icon != DocumentsLogic.Icon.PICTURE || entry.sizeBytes > 6L * 1024 * 1024) return EntryIcon(icon)
    val key = "${entry.id}:${entry.currentVersionId}"
    val bitmap by produceState(store.thumbnails.get(key), key) {
        if (value == null) value = runCatching {
            val bytes = store.api.content(entry.id)
            withContext(Dispatchers.Default) { decodeThumb(bytes, 96) }
        }.getOrNull()?.also { store.thumbnails.put(key, it) }
    }
    val shown = bitmap
    if (shown == null) EntryIcon(icon)
    else Image(shown.asImageBitmap(), null, Modifier.size(DocumentsMetrics.icon).clip(RoundedCornerShape(6.dp)), contentScale = ContentScale.Crop)
}

internal fun decodeThumb(bytes: ByteArray, max: Int): Bitmap? {
    val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= max && bounds.outHeight / (sample * 2) >= max) sample *= 2
    return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
}

/** "Agent in <session>" with the session's title as a link to it (rule 6); every other writer plain. [rest] follows after " · ". */
@Composable
internal fun writerLine(store: DocumentsStore, writer: DocumentsWriter, rest: String?, openSession: (String) -> Unit): AnnotatedString {
    val name = store.writerName(writer)
    val session = DocumentsLogic.writerSession(writer)
    val link = MaterialTheme.colorScheme.primary
    return buildAnnotatedString {
        if (session != null && name.startsWith(DocumentsLogic.AGENT_IN) && name != "${DocumentsLogic.AGENT_IN}a session") {
            append(DocumentsLogic.AGENT_IN)
            withLink(LinkAnnotation.Clickable("session", TextLinkStyles(SpanStyle(color = link))) { openSession(ObjectId.canonical(session) ?: session) }) {
                append(name.removePrefix(DocumentsLogic.AGENT_IN))
            }
        } else append(name)
        if (!rest.isNullOrEmpty()) append(" · $rest")
    }
}

/** One full-width Material list row (board `.li`): leading icon, name and line, trailing text, and an optional ⋮. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun DocumentsRow(
    title: String,
    line: AnnotatedString?,
    modifier: Modifier = Modifier,
    leading: @Composable () -> Unit,
    trailing: String? = null,
    selected: Boolean = false,
    progress: Float? = null,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    end: (@Composable () -> Unit)? = null,
    /** A small line above the name, which then reads in medium weight (the preview's writer row: "Last written today 14:02"). */
    overline: String? = null,
) {
    Row(modifier.fillMaxWidth().heightIn(min = DocumentsMetrics.rowMin)
        .then(if (selected) Modifier.background(MaterialTheme.colorScheme.secondaryContainer) else Modifier)
        .then(if (onClick != null || onLongClick != null) Modifier.combinedClickable(onClick = { onClick?.invoke() }, onLongClick = onLongClick) else Modifier)
        .padding(start = DocumentsMetrics.side, end = if (end != null) 8.dp else DocumentsMetrics.side, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        leading()
        Column(Modifier.weight(1f)) {
            if (overline != null) Text(overline, fontSize = DocumentsMetrics.line, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            Text(title, fontSize = if (overline != null) 15.sp else DocumentsMetrics.name, maxLines = 1, overflow = TextOverflow.Ellipsis,
                fontWeight = if (overline != null) FontWeight.Medium else null, color = MaterialTheme.colorScheme.onSurface)
            if (line != null && line.isNotEmpty()) Text(line, fontSize = DocumentsMetrics.line, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (progress != null) ThinBar(progress, Modifier.padding(top = 8.dp))
        }
        if (trailing != null) Text(trailing, fontSize = DocumentsMetrics.line, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        end?.invoke()
    }
}

/** The board's 4 dp bar (`.bar2`). */
@Composable
internal fun ThinBar(fraction: Float?, modifier: Modifier = Modifier) {
    val track = if (MaterialTheme.colorScheme.background == Color.Black) Color(0xFF3A3C41) else Color(0xFFDFE3EC)
    if (fraction == null) LinearProgressIndicator(modifier.fillMaxWidth().height(4.dp), trackColor = track, strokeCap = StrokeCap.Round)
    else LinearProgressIndicator({ fraction.coerceIn(0f, 1f) }, modifier.fillMaxWidth().height(4.dp), trackColor = track, strokeCap = StrokeCap.Round,
        gapSize = 0.dp, drawStopIndicator = {})
}

/** A row of a bottom sheet (`.mi2`): icon, words; red for Move to Trash. */
@Composable
internal fun SheetItem(icon: Int, label: String, danger: Boolean = false, tag: String? = null, onClick: () -> Unit) {
    val color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    Row(Modifier.fillMaxWidth().combinedClickableNoLong(onClick).then(if (tag != null) Modifier.testTag(tag) else Modifier)
        .padding(horizontal = 24.dp, vertical = 13.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
        Icon(painterResource(icon), null, Modifier.size(22.dp), tint = color)
        Text(label, fontSize = 16.sp, color = color)
    }
}

@OptIn(ExperimentalFoundationApi::class)
internal fun Modifier.combinedClickableNoLong(onClick: () -> Unit) = this.combinedClickable(onClick = onClick)

/** A section's heading in the brand colour (`.sh`). */
@Composable
internal fun SectionHeading(text: String, modifier: Modifier = Modifier, action: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(start = DocumentsMetrics.side, end = 8.dp, top = 14.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.primary, maxLines = 1,
            overflow = TextOverflow.Ellipsis)
        action?.invoke()
    }
}

/** The trail under the bar (`.crumb2`): "Documents › Orbit UI migration". */
@Composable
internal fun Crumb(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.fillMaxWidth().padding(start = DocumentsMetrics.side, end = DocumentsMetrics.side, bottom = 8.dp), fontSize = 13.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** The sheets' grey (`.bs`): #F4F5F8 light, #1D1E21 dark. */
@Composable
internal fun sheetColor() = if (MaterialTheme.colorScheme.background == Color.Black) Color(0xFF1D1E21) else Color(0xFFF4F5F8)

/** The dialogs' grey (`.dlg`). */
@Composable
internal fun dialogColor() = if (MaterialTheme.colorScheme.background == Color.Black) Color(0xFF1D1E21) else Color(0xFFEEF0F5)

/** The warning colour of Share anyway and the secrets box (`#985900`, `#FFF4E0`). */
@Composable
internal fun warningColors(): Pair<Color, Color> = if (MaterialTheme.colorScheme.background == Color.Black)
    Color(0xFFFFC66D) to Color(0xFF3A2A10) else Color(0xFF985900) to Color(0xFFFFF4E0)
