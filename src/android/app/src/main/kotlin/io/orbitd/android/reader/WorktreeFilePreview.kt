package io.orbitd.android.reader

import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.text.format.Formatter
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import io.orbitd.android.attachments.AttachmentActions
import kotlinx.coroutines.*
import java.io.File
import java.util.UUID

/**
 * A binary file the worktree changed, as it is in the worktree now (A06-7, iOS 797e004ec `WorktreeFilePreview`):
 * where it is and what it is, then the picture (scrolled within, "Full screen" opening the image viewer) or,
 * for anything else, "No preview available" with Save to Files and Share…. A deleted file has nothing to
 * read, and a failed read says why and whether trying again can help.
 */
@Composable
internal fun WorktreeFilePreview(model: WorktreeModel, file: ChangedFile) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var attempt by remember(file) { mutableIntStateOf(0) }
    var data by remember(file) { mutableStateOf<ByteArray?>(null) }
    var image by remember(file) { mutableStateOf<Bitmap?>(null) }
    var dimensions by remember(file) { mutableStateOf<String?>(null) }
    var failure by remember(file) { mutableStateOf<WorktreeFileFailure?>(null) }
    var loading by remember(file) { mutableStateOf(true) }
    var viewer by remember(file) { mutableStateOf(false) }
    var saveError by remember(file) { mutableStateOf<String?>(null) }
    val name = file.path.substringAfterLast('/')
    val directory = file.path.substringBeforeLast('/', "")
    val extension = name.substringAfterLast('.', "").uppercase()
    LaunchedEffect(file, attempt) {
        data = null; image = null; dimensions = null; failure = null; loading = true
        try {
            if (file.status.uppercase().startsWith("D")) { failure = WorktreeFileFailure.deleted; return@LaunchedEffect }
            val bytes = model.readFile(file.path)
            data = bytes
            val decoded = withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) null else {
                    var sample = 1
                    while (bounds.outWidth / sample > 2_560 || bounds.outHeight / sample > 2_560) sample *= 2
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                        ?.let { it to "${bounds.outWidth} × ${bounds.outHeight}" }
                }
            }
            image = decoded?.first; dimensions = decoded?.second
            if (decoded == null && io.orbitd.android.text.MarkdownFileRef.looksLikeImage(file.path)) failure = WorktreeFileFailure.invalidImage
        } catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { failure = WorktreeFileFailure.from(error) }
        finally { loading = false }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val bytes = data
        if (uri != null && bytes != null) scope.launch {
            try { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("Unavailable destination") } }
            catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) { saveError = WorktreeFileFailure.failureReason(error) }
        }
    }
    fun share(bytes: ByteArray) = scope.launch {
        try {
            val shared = withContext(Dispatchers.IO) {
                // Each share gets its own directory, so the real filename never replaces another open preview's file.
                val dir = File(context.cacheDir, "handoff/${UUID.randomUUID()}").apply { check(mkdirs()) }
                File(dir, name.ifBlank { "file" }).apply { writeBytes(bytes) }
            }
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.attachments", shared)
            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "application/octet-stream"; putExtra(Intent.EXTRA_STREAM, uri); clipData = ClipData.newUri(context.contentResolver, name, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }, "Share file"))
        } catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { saveError = WorktreeFileFailure.failureReason(error) }
    }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (directory.isNotEmpty()) SelectionContainer { Text("▤ $directory", color = secondary, style = MaterialTheme.typography.labelLarge, maxLines = 2) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(extension.ifEmpty { "FILE" }, Modifier.clip(RoundedCornerShape(4.dp)).background(secondary.copy(alpha = 0.10f))
                    .padding(horizontal = 6.dp, vertical = 3.dp), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = secondary)
                dimensions?.let { Text(it, color = secondary, style = MaterialTheme.typography.labelLarge) }
                data?.let {
                    if (dimensions != null) Text("·", color = secondary)
                    Text(Formatter.formatShortFileSize(context, it.size.toLong()), color = secondary, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        HorizontalDivider()
        val bitmap = image
        val bytes = data
        val failed = failure
        when {
            loading -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator()
                Text("Loading file…", Modifier.padding(top = 12.dp), color = secondary, style = MaterialTheme.typography.labelLarge)
            }
            failed != null -> Centered("⌧", failed.title, failed.detail) {
                if (failed.canRetry) OutlinedButton(onClick = { attempt++ }) { Text("↻ Retry") }
            }
            bitmap != null -> Column(Modifier.fillMaxSize()) {
                Box(Modifier.weight(1f).fillMaxWidth().background(secondary.copy(alpha = 0.06f)).verticalScroll(rememberScrollState()).padding(16.dp)) {
                    Image(bitmap.asImageBitmap(), name, Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).clickable { viewer = true },
                        contentScale = ContentScale.FillWidth)
                }
                HorizontalDivider()
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Scroll to explore", Modifier.weight(1f), color = secondary, style = MaterialTheme.typography.labelLarge)
                    Text("⤢ Full screen", Modifier.clip(CircleShape).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f))
                        .clickable(role = Role.Button) { viewer = true }.heightIn(min = 44.dp).padding(horizontal = 15.dp, vertical = 12.dp),
                        color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                }
            }
            else -> Centered(if (extension == "ZIP") "🗜" else "📄", "No preview available",
                "This file can’t be previewed here.\nSave it to Files or open it in another app.") {
                if (bytes != null) {
                    Button(onClick = { save.launch(name) }, shape = CircleShape) { Text("⤓ Save to Files") }
                    TextButton(onClick = { share(bytes) }) { Text("Share…") }
                }
            }
        }
    }
    val shownBytes = data
    if (viewer && image != null && shownBytes != null) {
        AttachmentActions(name, "image/*", { shownBytes }, closeLabel = "Close image", contentKey = file.path) { viewer = false }
    }
    saveError?.let { reason -> AlertDialog(onDismissRequest = { saveError = null }, title = { Text("Couldn't save file") }, text = { Text(reason) },
        confirmButton = { TextButton(onClick = { saveError = null }) { Text("OK") } }) }
}

@Composable
private fun Centered(glyph: String, title: String, detail: String, actions: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().padding(28.dp), verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text(glyph, style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.clearAndSetSemantics { })
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        actions()
    }
}
