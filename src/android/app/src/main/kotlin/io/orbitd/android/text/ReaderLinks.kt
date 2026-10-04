package io.orbitd.android.text

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.orbitd.android.attachments.AttachmentActions
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.navigation.*
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URI
import java.util.Base64
import java.util.concurrent.TimeUnit

/** Only API paths can receive credentials. External image requests use a separate, bare client. */
class ReaderResources(val auth: AuthSession, val handle: SessionHandle, val sessionId: String? = null,
    val available: () -> Boolean = { true }, val metadata: (String) -> Pair<String, String>? = { null }) {
    suspend fun bytes(source: String): ByteArray {
        if ((auth.state.value as? AuthState.SignedIn)?.handle !== handle || !available()) throw SessionChanged()
        val request = resourceRequest(source, sessionId)
        val bytes = if (request != null) auth.request(handle, request).body else withContext(Dispatchers.IO) {
            if (source.startsWith("data:image/") && source.substringBefore(',').endsWith(";base64")) {
                require(source.length <= MAX_BYTES * 2)
                Base64.getDecoder().decode(source.substringAfter(','))
            } else {
                val uri = URI(source)
                require(uri.scheme == "https" && uri.host != null && uri.userInfo == null)
                external.newCall(Request.Builder().url(source).build()).execute().use { response ->
                    check(response.isSuccessful)
                    val body = response.body ?: error("No image")
                    require(body.contentLength() <= MAX_BYTES)
                    val input = body.source()
                    input.request((MAX_BYTES + 1).toLong())
                    input.readByteArray(minOf(input.buffer.size, (MAX_BYTES + 1).toLong()))
                }
            }
        }
        require(bytes.size <= MAX_BYTES)
        if ((auth.state.value as? AuthState.SignedIn)?.handle !== handle || !available()) throw SessionChanged()
        return bytes
    }
    companion object {
        private const val MAX_BYTES = 25 * 1024 * 1024 // Server's MAX_UPLOAD_BYTES.
        private val external = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .callTimeout(20, TimeUnit.SECONDS).build()
    }
}

internal fun resourceRequest(source: String, sessionId: String?): ApiRequest? {
    if (source.startsWith("orbit-attachment:")) {
        val id = ObjectId.canonical(source.substringAfter(':')) ?: return null
        return ApiRequest(listOf("attachments", id), maxResponseBytes = 25L * 1024 * 1024)
    }
    val path = source.replace(Regex(":\\d+(?::\\d+)?(?:-\\d+(?::\\d+)?)?$"), "")
    val match = Regex("^/(?:root|home/[^/]+|Users/[^/]+)/\\.orbit/(?:uploads|worktrees)/([^/]+)/(.+)$").matchEntire(path) ?: return null
    if (!ObjectId.same(match.groupValues[1], sessionId) || match.groupValues[2].split('/').any { it == ".." }) return null
    return ApiRequest(listOf("sessions", sessionId!!, "artifacts"), query = listOf("path" to path), maxResponseBytes = 25L * 1024 * 1024)
}

val LocalReaderResources = staticCompositionLocalOf<ReaderResources?> { null }

@Composable
fun rememberReaderLinkHandler(resources: ReaderResources, open: (OrbitRoute) -> Unit): (String) -> Unit {
    val context = LocalContext.current
    val latestOpen by rememberUpdatedState(open)
    var file by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(resources.available()) { if (!resources.available()) file = null }
    file?.takeIf { resources.available() }?.let { source ->
        val info = resources.metadata(source)
        val name = info?.first ?: source.substringAfterLast('/').substringAfter(':').ifBlank { "orbit-file" }
        val mime = info?.second ?: android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "")) ?: "application/octet-stream"
        AttachmentActions(name, mime, { resources.bytes(source) }) { file = null }
    }
    message?.let { AlertDialog(onDismissRequest = { message = null }, text = { Text(it) }, confirmButton = {
        TextButton(onClick = { message = null }) { Text("OK") }
    }) }
    return remember(resources, context) { { raw ->
        val route = OrbitLinks.parse(raw, resources.handle.account.server)
        when {
            route != null -> latestOpen(route)
            resourceRequest(raw, resources.sessionId) != null -> file = raw
            runCatching { URI(raw).scheme?.lowercase() in setOf("https", "http", "mailto") }.getOrDefault(false) -> {
                try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw))) }
                catch (_: Exception) { message = "No application can open this link." }
            }
            else -> message = "This file or link is unavailable on this device."
        }
    } }
}

@Composable
fun TranscriptImage(source: String, alt: String, open: (String) -> Unit) {
    val resources = LocalReaderResources.current
    var retry by remember { mutableIntStateOf(0) }
    var zoom by remember { mutableStateOf(false) }
    var failed by remember(source, resources) { mutableStateOf(false) }
    val bitmap by produceState<android.graphics.Bitmap?>(null, source, resources, retry) {
        value = null; failed = false
        try {
            val bytes = resources?.bytes(source) ?: error("Unavailable image")
            value = withContext(Dispatchers.Default) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                require(bounds.outWidth > 0 && bounds.outHeight > 0)
                var sample = 1
                while (bounds.outWidth / sample > 1_440 || bounds.outHeight / sample > 2_560) sample *= 2
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: error("Unreadable image")
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { failed = true }
    }
    Column {
        // Fixed preview bounds prevent a late decode from displacing the reader's anchor.
        Box(Modifier.fillMaxWidth().height(240.dp), contentAlignment = androidx.compose.ui.Alignment.Center) {
            val loaded = bitmap
            when {
                loaded != null -> Image(loaded.asImageBitmap(), alt.ifBlank { "Image" }, Modifier.fillMaxSize().clickable { zoom = true }, contentScale = ContentScale.Fit)
                failed -> TextButton(onClick = { retry++ }) { Text("Image unavailable · Retry") }
                else -> CircularProgressIndicator()
            }
        }
        if (alt.isNotBlank()) Text(alt, style = MaterialTheme.typography.bodySmall)
        if (!source.startsWith("data:")) TextButton(onClick = { open(source) }) { Text("Open image") }
    }
    if (zoom && bitmap != null && resources?.available() == true) {
        val info = resources.metadata(source)
        AttachmentActions(info?.first ?: alt.ifBlank { "image.png" }, info?.second ?: "image/*",
            { resources.bytes(source) }, closeLabel = "Close image") { zoom = false }
    }
}
