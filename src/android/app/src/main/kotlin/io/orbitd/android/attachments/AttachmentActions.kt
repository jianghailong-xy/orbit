package io.orbitd.android.attachments

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.ContentValues
import android.provider.MediaStore
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import kotlinx.coroutines.*
import java.io.File
import java.util.UUID

/** Only these private handoff files are exposed, through expiring Android URI grants. */
class AttachmentProvider : FileProvider()

fun clearAttachmentHandoffs(context: Context) {
    val clipboard = context.getSystemService(ClipboardManager::class.java)
    if (clipboard.primaryClip?.let { it.itemCount > 0 && it.getItemAt(0).uri?.authority == "${context.packageName}.attachments" } == true) clipboard.clearPrimaryClip()
    val root = File(context.cacheDir, "handoff")
    root.walkTopDown().filter { it.isFile }.forEach { file ->
        runCatching { context.revokeUriPermission(FileProvider.getUriForFile(context, "${context.packageName}.attachments", file), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
    root.deleteRecursively()
}

@Composable
fun AttachmentActions(name: String, mime: String, bytes: suspend () -> ByteArray, closeLabel: String = "Close attachment",
    previous: (() -> Unit)? = null, next: (() -> Unit)? = null, contentKey: String = name, close: () -> Unit) {
    // Keep the Android window while changing images; reset only the file's content and jobs.
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        key(contentKey) { AttachmentContent(name, mime, bytes, closeLabel, previous, next, close) }
    }
}

@Composable
private fun AttachmentContent(name: String, mime: String, bytes: suspend () -> ByteArray, closeLabel: String,
    previous: (() -> Unit)?, next: (() -> Unit)?, close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    val image by produceState<android.graphics.Bitmap?>(null, retry) {
        if (mime.startsWith("image/")) {
            try {
                val data = bytes()
                value = withContext(Dispatchers.Default) {
                    decodeAttachmentImage({ data.inputStream() }, maxDimension = 2560)
                }
            } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { error = "Couldn't load image. Retry or open the file." }
        }
    }
    fun run(success: String? = null, action: suspend (ByteArray) -> Unit) {
        if (busy) return
        busy = true; error = null
        scope.launch {
            try { action(bytes()); notice = success }
            catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { error = "Couldn't open or save this file. Check access and try again." }
            finally { busy = false }
        }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(mime)) { uri ->
        if (uri != null) run("Saved file") { data -> withContext(Dispatchers.IO) {
            context.contentResolver.openOutputStream(uri)?.use { it.write(data) } ?: error("Unavailable destination")
        } }
    }
    suspend fun handoff(data: ByteArray, action: String) {
        val file = withContext(Dispatchers.IO) {
            val directory = File(context.cacheDir, "handoff/${UUID.randomUUID()}").apply { check(mkdirs()) }
            File(directory, name.substringAfterLast('/').substringAfterLast('\\').ifBlank { "attachment" }).apply { writeBytes(data) }
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.attachments", file)
        val clip = ClipData.newUri(context.contentResolver, name, uri)
        if (action == "copy") {
            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
        } else {
            val intent = Intent(action).apply {
                if (action == Intent.ACTION_SEND) { type = mime; putExtra(Intent.EXTRA_STREAM, uri) }
                else setDataAndType(uri, mime)
                clipData = clip
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, if (action == Intent.ACTION_SEND) "Share file" else "Open file"))
        }
    }
    suspend fun saveImage(data: ByteArray) = withContext(Dispatchers.IO) {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, options)
        require(options.outWidth > 0 && options.outHeight > 0)
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, options.outMimeType)
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Orbit")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: kotlin.run {
            // A provider may refuse to reserve a reused name even after deletion.
            values.put(MediaStore.Images.Media.DISPLAY_NAME, "${UUID.randomUUID()}-$name")
            resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: error("Can't save image")
        }
        try {
            resolver.openOutputStream(uri)?.use { it.write(data) } ?: error("Can't save image")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
        } catch (failure: Exception) { resolver.delete(uri, null, null); throw failure }
    }
    Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column(Modifier.padding(12.dp)) {
        TextButton(onClick = close) { Text(closeLabel) }
        Text(name, style = MaterialTheme.typography.titleMedium)
        notice?.let { Text(it) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { error = null; retry++ }) { Text("Retry") } }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            if (mime.startsWith("image/")) TextButton(enabled = !busy, onClick = { run("Saved to Pictures/Orbit") { saveImage(it) } }) { Text("Save image") }
            TextButton(enabled = !busy, onClick = { save.launch(name) }) { Text("Download") }
            TextButton(enabled = !busy, onClick = { run { handoff(it, Intent.ACTION_VIEW) } }) { Text("Open") }
            TextButton(enabled = !busy, onClick = { run { handoff(it, Intent.ACTION_SEND) } }) { Text("Share") }
            TextButton(enabled = !busy, onClick = { run("Copied file") { handoff(it, "copy") } }) { Text("Copy") }
        }
        if (previous != null || next != null) Row {
            TextButton(enabled = previous != null, onClick = { previous?.invoke() }) { Text("Previous image") }
            TextButton(enabled = next != null, onClick = { next?.invoke() }) { Text("Next image") }
        }
        image?.let { bitmap ->
            var scale by remember { mutableFloatStateOf(1f) }
            var x by remember { mutableFloatStateOf(0f) }; var y by remember { mutableFloatStateOf(0f) }
            Image(bitmap.asImageBitmap(), name, Modifier.weight(1f).fillMaxWidth().pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ -> scale = (scale * zoom).coerceIn(1f, 5f); x += pan.x; y += pan.y }
            }.graphicsLayer { scaleX = scale; scaleY = scale; translationX = x; translationY = y }, contentScale = ContentScale.Fit)
        }
    } }
}
