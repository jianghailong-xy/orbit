package io.orbitd.android.text

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.attachments.AttachmentActions
import io.orbitd.android.cards.ExpiredAttachmentFace
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.EvidenceFiles
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.navigation.*
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URI
import java.util.Base64
import java.util.concurrent.TimeUnit

/** Only API paths can receive credentials. External image requests use a separate, bare client. [guestSessionId] is set on a guest
 * page's: its files are read through the guest door, since the owner's `attachments/:id` answers a guest 404. */
class ReaderResources(val auth: AuthSession, val handle: SessionHandle, val sessionId: String? = null,
    val available: () -> Boolean = { true }, val metadata: (String) -> Pair<String, String>? = { null },
    val images: () -> List<String> = { emptyList() }, val guestSessionId: String? = null) {
    suspend fun bytes(source: String): ByteArray {
        if ((auth.state.value as? AuthState.SignedIn)?.handle !== handle || !available()) throw SessionChanged()
        val request = resourceRequest(source, sessionId, guestSessionId)
        val bytes = if (request != null) auth.request(handle, request).body else withContext(Dispatchers.IO) {
            if (source.startsWith("data:image/") && source.substringBefore(',').endsWith(";base64")) {
                require(source.length <= MAX_BYTES * 2)
                Base64.getDecoder().decode(source.substringAfter(','))
            } else {
                require(externalImage(source))
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

internal fun resourceRequest(source: String, sessionId: String?, guestSessionId: String? = null): ApiRequest? {
    if (source.startsWith("orbit-attachment:")) {
        val id = ObjectId.canonical(source.substringAfter(':')) ?: return null
        val path = if (guestSessionId != null) listOf("guest-sessions", guestSessionId, "attachments", id) else listOf("attachments", id)
        return ApiRequest(path, maxResponseBytes = 25L * 1024 * 1024)
    }
    val path = source.replace(Regex(":\\d+(?::\\d+)?(?:-\\d+(?::\\d+)?)?$"), "")
    val match = Regex("^/(?:root|home/[^/]+|Users/[^/]+)/\\.orbit/(?:uploads|worktrees)/([^/]+)/(.+)$").matchEntire(path) ?: return null
    if (!ObjectId.same(match.groupValues[1], sessionId) || match.groupValues[2].split('/').any { it == ".." }) return null
    return ApiRequest(listOf("sessions", sessionId!!, "artifacts"), query = listOf("path" to path), maxResponseBytes = 25L * 1024 * 1024)
}

/** An image on the open web, which only the bare client fetches: the two schemes iOS's `MarkdownImageView.remoteURL` takes. */
internal fun externalImage(source: String): Boolean = runCatching {
    val uri = URI(source)
    // http as well as https, as on iOS: the account owner's decision of 2026-10-15 (card 34g6JcZwpKTUcwc5WvuVx).
    uri.scheme in setOf("https", "http") && uri.host != null && uri.userInfo == null
}.getOrDefault(false)

val LocalReaderResources = staticCompositionLocalOf<ReaderResources?> { null }

/** A read of a file told its bytes have gone (410), and when they expired, from a server that says. */
internal data class ExpiredRead(val at: String?)

@Composable
fun rememberReaderLinkHandler(resources: ReaderResources, open: (OrbitRoute) -> Unit): (String) -> Unit {
    val context = LocalContext.current
    val latestOpen by rememberUpdatedState(open)
    var file by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(resources.available()) { if (!resources.available()) file = null }
    val handler: (String) -> Unit = remember(resources, context) { { raw ->
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
    file?.takeIf { resources.available() }?.let { source ->
        val info = resources.metadata(source)
        val name = info?.first ?: source.substringAfterLast('/').substringAfter(':').ifBlank { "orbit-file" }
        val mime = info?.second ?: android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "")) ?: "application/octet-stream"
        AttachmentActions(name, mime, { resources.bytes(source) }, contentKey = source, open = handler) { file = null }
    }
    message?.let { AlertDialog(onDismissRequest = { message = null }, text = { Text(it) }, confirmButton = {
        TextButton(onClick = { message = null }) { Text("OK") }
    }) }
    return handler
}

/** [inBubble]: one of the reader's own sent images (iOS `ChatAttachmentImage`): fitted to 300 × 360 dp on the trailing edge, rounded,
 * with no caption or "Open image" — a tap opens it; [square], one of several, as a 96 dp cropped square (iOS `ChatAttachmentThumb`). */
@Composable
fun TranscriptImage(source: String, alt: String, open: (String) -> Unit, inBubble: Boolean = false, square: Boolean = false) {
    val resources = LocalReaderResources.current
    var retry by remember { mutableIntStateOf(0) }
    var zoom by remember { mutableStateOf(false) }
    var selected by remember(source) { mutableStateOf(source) }
    var failed by remember(source, resources) { mutableStateOf(false) }
    // Told its bytes have gone, there is nothing to try again: what is left of it is the placeholder.
    var expired by remember(source, resources) { mutableStateOf<ExpiredRead?>(null) }
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
        catch (failure: Exception) {
            if (EvidenceFiles.isExpiredRead(failure)) expired = ExpiredRead(EvidenceFiles.expiredAtOf(failure)) else failed = true
        }
    }
    Column {
        // Fixed preview bounds prevent a late decode from displacing the reader's anchor. A sent image holds its cap's height
        // while it loads, which is a portrait screenshot's: the common one keeps its place, a wider one comes in shorter.
        val shape = androidx.compose.foundation.shape.RoundedCornerShape(8.dp)
        val bounds = when {
            square -> Modifier.size(96.dp)
            inBubble && bitmap == null && expired == null && !failed -> Modifier.size(200.dp, 360.dp)
            inBubble && bitmap == null -> Modifier
            inBubble -> Modifier.widthIn(max = 300.dp).heightIn(max = 360.dp)
            else -> Modifier.fillMaxWidth().height(240.dp)
        }
        Box(bounds, contentAlignment = androidx.compose.ui.Alignment.Center) {
            val loaded = bitmap
            val gone = expired
            when {
                loaded != null && inBubble -> Image(loaded.asImageBitmap(), alt.ifBlank { "Image" },
                    (if (square) Modifier.fillMaxSize() else Modifier.aspectRatio(loaded.width.toFloat() / loaded.height)).clip(shape)
                        .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f), shape)
                        .clickable { selected = source; zoom = true }.testTag("user-turn-image"),
                    contentScale = if (square) ContentScale.Crop else ContentScale.Fit)
                loaded != null -> Image(loaded.asImageBitmap(), alt.ifBlank { "Image" }, Modifier.fillMaxSize().clickable { selected = source; zoom = true }, contentScale = ContentScale.Fit)
                gone != null -> ExpiredAttachmentFace(gone.at, Modifier.size(120.dp, 90.dp).testTag("attachment-expired"))
                failed -> TextButton(onClick = { retry++ }) { Text("Image unavailable · Retry") }
                else -> CircularProgressIndicator()
            }
        }
        if (!inBubble && alt.isNotBlank()) Text(alt, style = MaterialTheme.typography.bodySmall)
        if (!inBubble && !source.startsWith("data:") && expired == null) TextButton(onClick = { open(source) }) { Text("Open image") }
    }
    if (zoom && bitmap != null && resources?.available() == true) {
        val info = resources.metadata(selected)
        val gallery = resources.images(); val index = gallery.indexOf(selected)
        AttachmentActions(info?.first ?: alt.ifBlank { "image.png" }, info?.second ?: "image/*",
            { resources.bytes(selected) }, closeLabel = "Close image", contentKey = selected,
            previous = if (index > 0) ({ selected = gallery[index - 1] }) else null,
            next = if (index >= 0 && index < gallery.lastIndex) ({ selected = gallery[index + 1] }) else null) { zoom = false }
    }
}
