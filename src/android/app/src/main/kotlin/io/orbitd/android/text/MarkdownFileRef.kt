package io.orbitd.android.text

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.attachments.AttachmentActions
import kotlinx.coroutines.*
import org.commonmark.node.Link

/**
 * A prose link to a file (OrbitKit `MarkdownFileRef` / `AttachmentLink`). An uploaded file keeps its
 * original name in the Markdown title — its `orbit-attachment:` URL has no extension — so the parser's
 * link title is kept to tell a picture from a document.
 */
internal data class MarkdownFileRef(val href: String, val label: String, val name: String?) {
    private val attachment get() = href.startsWith("orbit-attachment:")
    val fileName: String get() = if (attachment) name?.ifEmpty { null } ?: label.ifEmpty { "file" } else fileNameInPath(href)
    val isImage: Boolean get() = looksLikeImage(fileName)
    /** Legacy attachment links may carry neither a name nor an extension: let the decoder decide those. */
    val shouldLoadImage: Boolean get() = isImage || (attachment && name == null && extension(fileName).isEmpty())

    companion object {
        private val sourceLocation = Regex(":\\d+(?::\\d+)?(?:-\\d+(?::\\d+)?)?$")
        private val imageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff")
        private fun extension(path: String) = sourceLocation.replace(path, "").substringAfterLast('/').let { leaf ->
            if ('.' in leaf) leaf.substringAfterLast('.').lowercase() else "" }
        fun looksLikeImage(path: String) = extension(path) in imageExtensions
        fun fileNameInPath(path: String): String =
            sourceLocation.replace(path, "").split('/').lastOrNull { it.isNotEmpty() }?.let(::percentDecoded) ?: "file"

        /** `%E4%B8%AD` → 中; a malformed escape keeps the text as written. */
        private fun percentDecoded(text: String): String {
            if ('%' !in text) return text
            val out = StringBuilder()
            val bytes = java.io.ByteArrayOutputStream()
            fun flush() { if (bytes.size() > 0) { out.append(bytes.toString(Charsets.UTF_8.name())); bytes.reset() } }
            var i = 0
            while (i < text.length) {
                if (text[i] != '%') { flush(); out.append(text[i]); i++; continue }
                val hex = text.substring(i + 1, minOf(i + 3, text.length))
                if (hex.length < 2 || !hex.all { it in "0123456789abcdefABCDEF" }) return text
                bytes.write(hex.toInt(16)); i += 3
            }
            flush()
            return out.toString()
        }

        /** The link as a file reference the session can serve as an image, or null for every other link. */
        fun imageFile(link: Link, sessionId: String?): MarkdownFileRef? {
            if (resourceRequest(link.destination, sessionId) == null) return null
            val label = plainText(link).trim()
            return MarkdownFileRef(link.destination, label, link.title?.ifEmpty { null }).takeIf { it.shouldLoadImage }
        }

        private fun plainText(node: org.commonmark.node.Node): String = when (node) {
            is org.commonmark.node.Text -> node.literal
            is org.commonmark.node.Code -> node.literal
            else -> generateSequence(node.firstChild) { it.next }.joinToString("") { plainText(it) }
        }
    }
}

/**
 * A Markdown link to an image file — a screenshot an agent saved and linked — as the image file row
 * (iOS 49d2f3003): the picture, a photo mark, its label and "<EXT> image · Tap to preview", opening the
 * shared image viewer. Before the bytes decode (or when they never do) it is the file row, "Preview file",
 * which opens the file the ordinary way.
 */
@Composable
internal fun ImageFileRow(ref: MarkdownFileRef, open: (String) -> Unit) {
    val resources = LocalReaderResources.current
    var viewer by remember(ref) { mutableStateOf(false) }
    var loading by remember(ref) { mutableStateOf(true) }
    val bitmap by produceState<Bitmap?>(null, ref, resources) {
        value = null; loading = true
        try {
            val bytes = resources?.bytes(ref.href) ?: error("Unavailable image")
            value = withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                require(bounds.outWidth > 0 && bounds.outHeight > 0)
                var sample = 1
                while (bounds.outWidth / sample > 1_440 || bounds.outHeight / sample > 2_560) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { value = null }
        finally { loading = false }
    }
    val image = bitmap
    val label = ref.label.ifEmpty { ref.fileName }
    val accent = MaterialTheme.colorScheme.primary
    val shape = RoundedCornerShape(if (image == null) 9.dp else 14.dp)
    Column(Modifier.widthIn(max = 320.dp).clip(shape).background(MaterialTheme.colorScheme.surfaceContainerLow)
        .border(1.dp, if (image != null) MaterialTheme.colorScheme.outlineVariant else accent.copy(alpha = 0.22f), shape)
        .clickable(onClickLabel = if (image != null) "Preview image" else "Preview or open this file") { if (image != null) viewer = true else open(ref.href) }
        .semantics(mergeDescendants = true) { contentDescription = label }) {
        if (image != null) {
            Box(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp)) {
                Image(image.asImageBitmap(), null, Modifier.fillMaxWidth().height(160.dp), contentScale = ContentScale.Fit)
                Text("⤢", Modifier.align(Alignment.BottomEnd).clip(RoundedCornerShape(7.dp)).background(MaterialTheme.colorScheme.surface)
                    .padding(horizontal = 7.dp, vertical = 2.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider()
        }
        Row(Modifier.padding(horizontal = if (image == null) 10.dp else 12.dp, vertical = if (image == null) 7.dp else 11.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            when {
                loading -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                else -> Text(if (image != null) "🖼" else "📄", Modifier.clip(RoundedCornerShape(8.dp)).background(accent.copy(alpha = 0.07f))
                    .padding(5.dp), color = accent)
            }
            Column(Modifier.weight(1f)) {
                Text(label, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, style = MaterialTheme.typography.labelLarge)
                Text(if (image != null) imageCaption(ref) else "Preview file", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!loading) Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (viewer && image != null && resources?.available() == true) {
        // The session's other pictures stay one swipe away when this one is among them.
        var selected by remember(ref) { mutableStateOf(ref.href) }
        val gallery = resources.images()
        val index = gallery.indexOf(selected)
        val info = resources.metadata(selected)
        AttachmentActions(if (selected == ref.href) ref.fileName else info?.first ?: "image",
            info?.second?.takeIf { it.startsWith("image/") } ?: "image/*", { resources.bytes(selected) },
            closeLabel = "Close image", contentKey = selected,
            previous = if (index > 0) ({ selected = gallery[index - 1] }) else null,
            next = if (index >= 0 && index < gallery.lastIndex) ({ selected = gallery[index + 1] }) else null) { viewer = false }
    }
}

/** "PNG image · Tap to preview" — "Image" where the name gave no image extension to go on. */
internal fun imageCaption(ref: MarkdownFileRef): String =
    (if (ref.isImage) ref.fileName.substringAfterLast('.').uppercase() + " image" else "Image") + " · Tap to preview"
