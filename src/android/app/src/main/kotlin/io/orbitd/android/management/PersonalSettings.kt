package io.orbitd.android.management

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.R
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.net.NetworkException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID
import kotlin.math.roundToInt

/** A refresh must establish authority before another write. Late reads cannot undo invalidation. */
internal class PersonalRecord(private val fetch: suspend () -> JsonElement) {
    var value by mutableStateOf<JsonElement?>(null); private set
    var busy by mutableStateOf(false); private set
    var stale by mutableStateOf(true); private set
    var error by mutableStateOf<String?>(null); private set
    private var generation = 0L
    private val mutex = Mutex()
    val ready get() = value != null && !busy && !stale
    fun invalidate() { generation++; stale = true }
    suspend fun load() {
        val ticket = ++generation
        stale = true
        mutex.withLock {
            if (ticket != generation) return
            busy = true
            try {
                val answer = fetch()
                if (ticket == generation) { value = answer; stale = false; error = null }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (ticket == generation) failed(e) }
            finally { busy = false }
        }
    }
    suspend fun mutate(action: suspend () -> Unit): Boolean {
        if (!ready) return false
        val ticket = ++generation
        busy = true; stale = true; error = null
        return mutex.withLock {
            try {
                action()
                val answer = fetch()
                if (ticket == generation) { value = answer; stale = false; true } else false
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (ticket == generation) failed(e); false }
            finally { busy = false }
        }
    }
    private fun failed(e: Exception) {
        stale = true
        if (e is ApiError && e.status in setOf(401, 403, 404)) value = null
        error = when (e) {
            is ApiError -> e.messages.joinToString("; ").ifBlank { e.message.orEmpty() }
            else -> e.message ?: "Could not reach the server"
        }
    }
}

@Composable
internal fun PersonalRecordLifecycle(record: PersonalRecord, revision: Long) {
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(record, revision) { record.load() }
    DisposableEffect(record, owner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> scope.launch { record.load() }
                Lifecycle.Event.ON_PAUSE -> record.invalidate()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer); record.invalidate() }
    }
}

@Composable
internal fun PersonalRecordStatus(record: PersonalRecord) {
    val scope = rememberCoroutineScope()
    if (record.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    if (record.stale && !record.busy) Text("Refresh required before making changes.")
    record.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    if (!record.busy) TextButton(onClick = { scope.launch { record.load() } }) { Text("Refresh") }
}

@Composable
internal fun PersonalChoice(label: String, current: String, options: List<Pair<String, String>>, enabled: Boolean,
    onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }, enabled = enabled) {
            Text("$label: ${options.firstOrNull { it.first == current }?.second ?: current}")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (value, title) -> DropdownMenuItem(text = { Text(title) }, onClick = {
                expanded = false; onSelect(value)
            }, enabled = enabled) }
        }
    }
}

/** AgentDefaults.permissionModes and their labels; an unset preference is the server's floor, Auto. */
internal val personalPermissions = listOf("default" to "Default", "acceptEdits" to "Accept Edits",
    "plan" to "Plan", "auto" to "Auto", "dontAsk" to "Don't Ask", "bypassPermissions" to "Bypass")

/** APIClient.failureReason: the server's own words, else what went wrong. */
internal fun personalFailure(error: Throwable): String = when (error) {
    is ApiError -> error.messages.joinToString("; ").ifBlank { "the server returned ${error.status}" }
    is NetworkException -> "the connection dropped"
    else -> "the server's reply couldn't be read"
}

/** What Save does to the photo: nothing, put this one in its place, or take it away (ProfileEdit.Photo). */
internal sealed interface ProfilePhoto {
    data object Unchanged : ProfilePhoto
    class Replaced(val jpeg: ByteArray, val preview: Bitmap) : ProfilePhoto
    data object Removed : ProfilePhoto
}

internal sealed interface ProfileStep {
    class SetPhoto(val jpeg: ByteArray) : ProfileStep
    data object RemovePhoto : ProfileStep
    data class Rename(val name: String) : ProfileStep
}

/** ProfileEdit: Save is live once the draft names someone and changes the name or the photo. */
internal fun profileCanSave(draft: String, saved: String?, photo: ProfilePhoto) =
    draft.trim().isNotEmpty() && (draft.trim() != saved || photo != ProfilePhoto.Unchanged)

/** The photo first, then the name, each only when it changed; a step that lands stays landed. */
internal fun profileSteps(draft: String, saved: String?, photo: ProfilePhoto): List<ProfileStep> {
    if (!profileCanSave(draft, saved, photo)) return emptyList()
    return listOfNotNull(when (photo) {
        is ProfilePhoto.Replaced -> ProfileStep.SetPhoto(photo.jpeg)
        ProfilePhoto.Removed -> ProfileStep.RemovePhoto
        ProfilePhoto.Unchanged -> null
    }, draft.trim().takeIf { it != saved }?.let(ProfileStep::Rename))
}

/** The account's photo, fetched with its token and keyed by avatarUpdatedAt; never another version's. */
@Composable
internal fun rememberAccountPhoto(api: ManagementApi, user: JsonObject?): Bitmap? {
    val version = user?.text("avatarUpdatedAt").orEmpty()
    var photo by remember(api) { mutableStateOf<Pair<String, Bitmap>?>(null) }
    LaunchedEffect(api, version) {
        if (version.isBlank() || photo?.first == version) return@LaunchedEffect
        try {
            val bytes = api.session.request(api.handle, ApiRequest(listOf("users", "me", "avatar"),
                maxResponseBytes = 2L * 1024 * 1024)).body
            withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }?.let { photo = version to it }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { /* The monogram stays until the next version or visit. */ }
    }
    return photo?.takeIf { it.first == version }?.second
}

@Composable
internal fun AccountAvatar(name: String, photo: Bitmap?, size: Dp) {
    if (photo != null) Image(photo.asImageBitmap(), null, Modifier.size(size).clip(CircleShape))
    else Box(Modifier.size(size).clip(CircleShape).background(MaterialTheme.colorScheme.secondaryContainer), Alignment.Center) {
        Text(name.trim().take(1).uppercase(), style = MaterialTheme.typography.headlineLarge,
            color = MaterialTheme.colorScheme.onSecondaryContainer)
    }
}

/** The card Settings' header opens: the photo and the name. Nothing is written until Save profile. */
@Composable
fun EditProfile(api: ManagementApi, revision: Long, done: () -> Unit) {
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val user = record.value as? JsonObject
    val saved = rememberAccountPhoto(api, user)
    var draft by rememberSaveable { mutableStateOf<String?>(null) }
    var photo by remember(api) { mutableStateOf<ProfilePhoto>(ProfilePhoto.Unchanged) }
    var crop by remember(api) { mutableStateOf<Bitmap?>(null) }
    var saving by remember(api) { mutableStateOf(false) }
    var failure by remember(api) { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    LaunchedEffect(user) { if (draft == null && user != null) draft = user.text("name") }
    val name = draft.orEmpty()
    fun pick(uri: Uri?) {
        if (uri == null) return
        scope.launch {
            try { crop = withContext(Dispatchers.IO) { personalDecodePhoto(context.contentResolver, uri) } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { failure = "Couldn't save your photo — that file isn't an image Orbit can read." }
        }
    }
    val library = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { pick(it) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument(), ::pick)
    var cameraCapture by remember(api) { mutableStateOf<PersonalCameraCapture?>(null) }
    DisposableEffect(api) { onDispose { cameraCapture?.close(context); cameraCapture = null } }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { captured ->
        val pending = cameraCapture ?: return@rememberLauncherForActivityResult
        if (!captured) { pending.close(context); cameraCapture = null }
        else scope.launch {
            try { crop = withContext(Dispatchers.IO) { personalDecodePhoto(context.contentResolver, pending.uri) } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { failure = "Couldn't save your photo — the camera photo couldn't be read." }
            finally { pending.close(context); if (cameraCapture === pending) cameraCapture = null }
        }
    }
    val hasCamera = remember { context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) }
    val showsPhoto = when (photo) { is ProfilePhoto.Replaced -> true; ProfilePhoto.Removed -> false; ProfilePhoto.Unchanged -> !user?.text("avatarUpdatedAt").isNullOrBlank() }
    fun save() {
        val steps = profileSteps(name, user?.text("name"), photo)
        if (saving || steps.isEmpty() || !record.ready) return
        saving = true; failure = null
        scope.launch {
            try {
                for (step in steps) {
                    try {
                        when (step) {
                            is ProfileStep.SetPhoto -> { personalUploadAvatar(api, step.jpeg); photo = ProfilePhoto.Unchanged }
                            ProfileStep.RemovePhoto -> { api.delete("users/me/avatar"); photo = ProfilePhoto.Unchanged }
                            is ProfileStep.Rename -> api.patch("users/me", buildJsonObject { put("name", step.name) })
                        }
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) {
                        failure = "${if (step is ProfileStep.Rename) "Couldn't save your name" else "Couldn't save your photo"} — ${personalFailure(e)}."
                        record.load()
                        return@launch
                    }
                }
                record.load()
                done()
            } finally { saving = false }
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (user == null) { PersonalRecordStatus(record); return@Column }
        Box {
            Box(Modifier.clickable(null, ripple(bounded = false, radius = 48.dp), enabled = !saving, role = Role.Button) { menu = true }
                .semantics { contentDescription = "Choose photo" }) {
                AccountAvatar(name, when (val chosen = photo) {
                    is ProfilePhoto.Replaced -> chosen.preview; ProfilePhoto.Removed -> null; ProfilePhoto.Unchanged -> saved
                }, 96.dp)
                // CameraBadge: a white disc with a light shadow at the avatar's corner.
                Surface(Modifier.align(Alignment.BottomEnd).size(32.dp), shape = CircleShape, color = MaterialTheme.colorScheme.surface, shadowElevation = 3.dp) {
                    Icon(painterResource(R.drawable.ic_camera), null, Modifier.padding(7.dp))
                }
            }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text("Photo library") }, onClick = {
                    menu = false; library.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                })
                if (hasCamera) DropdownMenuItem(text = { Text("Take photo") }, onClick = {
                    menu = false
                    try {
                        cameraCapture?.close(context)
                        cameraCapture = personalPrepareCamera(context)
                        camera.launch(cameraCapture!!.uri)
                    } catch (_: Exception) {
                        cameraCapture?.close(context); cameraCapture = null
                        failure = "Couldn't save your photo — the camera couldn't be opened."
                    }
                })
                DropdownMenuItem(text = { Text("Choose file") }, onClick = { menu = false; files.launch(arrayOf("image/*")) })
                if (showsPhoto) DropdownMenuItem(text = { Text("Remove photo", color = MaterialTheme.colorScheme.error) },
                    onClick = { menu = false; photo = ProfilePhoto.Removed; failure = null })
            }
        }
        if (record.busy || record.stale) PersonalRecordStatus(record)
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            OutlinedTextField(name, { draft = it; failure = null }, Modifier.fillMaxWidth(), enabled = !saving,
                label = { Text("Name") }, placeholder = { Text("Your name") }, singleLine = true)
            Text(failure ?: "People in your shared pools see you by this name.", style = MaterialTheme.typography.bodySmall,
                color = if (failure == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error)
        }
        Button(onClick = ::save, enabled = !saving && record.ready && profileCanSave(name, user.text("name"), photo)) {
            if (saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Save profile")
        }
        TextButton(onClick = done, enabled = !saving) { Text("Cancel") }
    }
    crop?.let { source -> PersonalPhotoDialog(source, onDismiss = { crop = null }, onSave = { bytes ->
        crop = null; failure = null
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { photo = ProfilePhoto.Replaced(bytes, it) }
    }) }
}

/** The web Profile page's form: the current password, and the new one twice. */
@Composable
fun ChangePassword(api: ManagementApi) {
    val scope = rememberCoroutineScope()
    var current by remember(api) { mutableStateOf("") }
    var fresh by remember(api) { mutableStateOf("") }
    var confirm by remember(api) { mutableStateOf("") }
    var busy by remember(api) { mutableStateOf(false) }
    var outcome by remember(api) { mutableStateOf<String?>(null) }
    val canSubmit = current.isNotEmpty() && fresh.length >= 6 && confirm == fresh
    val password = KeyboardOptions(keyboardType = KeyboardType.Password)
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        OutlinedTextField(current, { current = it }, Modifier.fillMaxWidth(), label = { Text("Current password") },
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = password, singleLine = true)
        OutlinedTextField(fresh, { fresh = it; outcome = null }, Modifier.fillMaxWidth(), label = { Text("New password") },
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = password, singleLine = true)
        OutlinedTextField(confirm, { confirm = it }, Modifier.fillMaxWidth(), label = { Text("Confirm new password") },
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = password, singleLine = true)
        Text(outcome ?: if (confirm.isNotEmpty() && confirm != fresh) "Passwords do not match" else "At least 6 characters",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = { scope.launch {
            busy = true
            try {
                api.post("auth/change-password", buildJsonObject { put("currentPassword", current); put("newPassword", fresh) })
                current = ""; fresh = ""; confirm = ""; outcome = "Password changed"
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                outcome = (e as? ApiError)?.messages?.joinToString("; ")?.ifBlank { null } ?: "Couldn't change password."
            } finally { busy = false }
        } }, enabled = canSubmit && !busy) { Text("Change password") }
    }
}

/** The account's two switches (the web page's, in its words) and the alerts neither of them governs. */
@Composable
fun NotificationsPreferences(api: ManagementApi, revision: Long) {
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val preferences = (record.value as? JsonObject)?.get("preferences") as? JsonObject
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Sent to all your devices", style = MaterialTheme.typography.titleMedium)
        if (record.busy || record.stale || record.error != null) PersonalRecordStatus(record)
        listOf(Triple("notifySessionFinished", "When a session finishes", "Alert your devices when a run finishes on its own or fails for good."),
            Triple("notifyAgentMessage", "When an agent asks for you", "Let a running agent alert your devices itself — to ask something only you can answer, or to report what you were waiting for. At most one per session per minute.")
        ).forEach { (key, title, hint) ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(title, Modifier.weight(1f))
                // Absent means on: only the switch that moved is written.
                Switch(modifier = Modifier.semantics { contentDescription = title },
                    checked = (preferences?.get(key) as? JsonPrimitive)?.booleanOrNull != false, enabled = record.ready,
                    onCheckedChange = { checked -> scope.launch { record.mutate {
                        api.patch("users/me/preferences", buildJsonObject { put(key, checked) })
                    } } })
            }
            Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("Always sent", style = MaterialTheme.typography.titleMedium)
        listOf("Tool approvals", "Projects waiting on you", "Engine sign-outs", "Watch matches").forEach { kind ->
            Row { Text(kind, Modifier.weight(1f)); Text("Always", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Text("Each one waits on you, or is a watch you set up.", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

internal fun personalDecodePhoto(resolver: ContentResolver, uri: Uri): Bitmap =
    ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        val scale = minOf(1.0, 1024.0 / maxOf(info.size.width, info.size.height))
        decoder.setTargetSize(maxOf(1, (info.size.width * scale).toInt()), maxOf(1, (info.size.height * scale).toInt()))
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }

/**
 * AvatarCrop (OrbitKit): where a round profile photo is cut from, as the crop screen frames it. The photo covers
 * the circle at least (zoom 1), zooms in to [maxZoom], and moves only as far as keeps the circle on the photo.
 * Offsets are in screen pixels, from the circle's centre to the photo's.
 */
internal object AvatarCrop {
    const val maxZoom = 5f

    /** The photo's size on screen at zoom 1: just covering a circle of that diameter. */
    fun fitted(image: Size, circle: Float): Size {
        if (image.width <= 0f || image.height <= 0f) return Size.Zero
        val k = maxOf(circle / image.width, circle / image.height)
        return Size(image.width * k, image.height * k)
    }

    fun clampedZoom(zoom: Float) = zoom.coerceIn(1f, maxZoom)

    /** The offset, moved back inside what keeps the circle on the photo at that zoom. */
    fun clampedOffset(offset: Offset, fitted: Size, circle: Float, zoom: Float): Offset {
        val slackX = maxOf(0f, (fitted.width * zoom - circle) / 2)
        val slackY = maxOf(0f, (fitted.height * zoom - circle) / 2)
        // + 0f: no movement room reads as 0, not -0 (Offset compares its bits).
        return Offset(offset.x.coerceIn(-slackX, slackX) + 0f, offset.y.coerceIn(-slackY, slackY) + 0f)
    }

    /** The square of the photo, in the photo's own pixels, that the circle covers. */
    fun cropRect(image: Size, circle: Float, zoom: Float, offset: Offset): Rect {
        val fitted = fitted(image, circle)
        if (fitted.width <= 0f) return Rect.Zero
        val shown = Size(fitted.width * zoom, fitted.height * zoom)
        val k = shown.width / image.width
        return Rect(Offset((shown.width / 2 - offset.x - circle / 2) / k, (shown.height / 2 - offset.y - circle / 2) / k), Size(circle / k, circle / k))
    }
}

/** orbitAvatarJPEG: the square the circle covers, at most 512 pixels, drawn on white. */
internal fun personalCropPhoto(source: Bitmap, square: Rect): Bitmap {
    val side = maxOf(1, minOf(square.width.roundToInt(), source.width, source.height))
    val left = square.left.roundToInt().coerceIn(0, source.width - side)
    val top = square.top.roundToInt().coerceIn(0, source.height - side)
    val out = minOf(side, 512)
    val scaled = Bitmap.createScaledBitmap(Bitmap.createBitmap(source, left, top, side, side), out, out, true)
    // Composited onto white, so a transparent image is not sent as black JPEG.
    val pixels = IntArray(out * out).also { scaled.getPixels(it, 0, out, 0, 0, out, out) }
    for (index in pixels.indices) {
        val p = pixels[index]; val a = p ushr 24
        fun over(c: Int) = (c * a + 255 * (255 - a)) / 255
        pixels[index] = (0xFF shl 24) or (over(p shr 16 and 0xFF) shl 16) or (over(p shr 8 and 0xFF) shl 8) or over(p and 0xFF)
    }
    return Bitmap.createBitmap(out, out, Bitmap.Config.ARGB_8888).apply { setPixels(pixels, 0, out, 0, 0, out, out) }
}

/**
 * AvatarCropView: the photo under a round window on black, pinched and dragged into place (AvatarCrop keeps the
 * circle covered), Cancel (×) and Save along the bottom. Save hands back the circle's square as the JPEG that is
 * sent. TalkBack, which cannot pinch, gets Zoom in / Zoom out on the photo.
 */
@Composable
private fun PersonalPhotoDialog(source: Bitmap, onDismiss: () -> Unit, onSave: (ByteArray) -> Unit) {
    val image = remember(source) { source.asImageBitmap() }
    var zoom by remember(source) { mutableFloatStateOf(1f) }
    var offset by remember(source) { mutableStateOf(Offset.Zero) }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Color.Black)) {
            val density = LocalDensity.current
            val circle = with(density) { maxOf(1.dp, minOf(maxWidth, maxHeight) - 88.dp).toPx() }
            val photo = Size(source.width.toFloat(), source.height.toFloat())
            val fitted = AvatarCrop.fitted(photo, circle)
            fun zoomTo(value: Float) { zoom = AvatarCrop.clampedZoom(value); offset = AvatarCrop.clampedOffset(offset, fitted, circle, zoom) }
            Box(Modifier.fillMaxSize().pointerInput(source, circle) {
                detectTransformGestures { _, pan, change, _ ->
                    zoom = AvatarCrop.clampedZoom(zoom * change)
                    offset = AvatarCrop.clampedOffset(offset + pan, fitted, circle, zoom)
                }
            }.semantics {
                contentDescription = "Photo crop preview"
                customActions = listOf(CustomAccessibilityAction("Zoom in") { zoomTo(zoom * 1.25f); true },
                    CustomAccessibilityAction("Zoom out") { zoomTo(zoom / 1.25f); true })
            }) {
                with(density) {
                    Image(image, null, Modifier.align(Alignment.Center).requiredSize((fitted.width * zoom).toDp(), (fitted.height * zoom).toDp())
                        .graphicsLayer { translationX = offset.x; translationY = offset.y }, contentScale = ContentScale.FillBounds)
                }
                // Everything outside the circle dimmed, and the circle's edge drawn.
                Canvas(Modifier.fillMaxSize().graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)) {
                    drawRect(Color.Black.copy(alpha = .6f))
                    drawCircle(Color.Transparent, radius = circle / 2, blendMode = BlendMode.Clear)
                    drawCircle(Color.White.copy(alpha = .7f), radius = circle / 2, style = Stroke(1.dp.toPx()))
                }
            }
            Row(Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(horizontal = 20.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically) {
                FilledTonalIconButton(onClick = onDismiss, Modifier.size(48.dp).semantics { contentDescription = "Cancel" }) {
                    Text("✕", Modifier.clearAndSetSemantics { }, style = MaterialTheme.typography.titleMedium)
                }
                Spacer(Modifier.weight(1f))
                FilledTonalButton(onClick = {
                    val square = AvatarCrop.cropRect(photo, circle, zoom, offset)
                    val out = ByteArrayOutputStream(); personalCropPhoto(source, square).compress(Bitmap.CompressFormat.JPEG, 85, out)
                    onSave(out.toByteArray())
                }, Modifier.height(48.dp)) { Text("Save") }
            }
        }
    }
}

internal suspend fun personalUploadAvatar(api: ManagementApi, jpeg: ByteArray) {
    require(jpeg.isNotEmpty() && jpeg.size <= 2 * 1024 * 1024)
    val boundary = "orbit-avatar-${UUID.randomUUID()}"
    val start = "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"avatar.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".encodeToByteArray()
    val end = "\r\n--$boundary--\r\n".encodeToByteArray()
    api.session.request(api.handle, ApiRequest(listOf("users", "me", "avatar"), HttpMethod.PUT,
        body = start + jpeg + end, contentType = "multipart/form-data; boundary=$boundary"))
}

/** The existing handoff provider already confines this URI to private cache; no media permission. */
internal class PersonalCameraCapture(val file: File, val uri: Uri) {
    fun close(context: Context) {
        context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        file.delete()
        file.parentFile?.delete()
    }
}

internal fun personalPrepareCamera(context: Context): PersonalCameraCapture {
    val directory = File(context.cacheDir, "handoff/avatar-${UUID.randomUUID()}")
    check(directory.mkdirs()) { "Could not prepare the camera photo" }
    val file = File(directory, "capture.jpg")
    return try {
        check(file.createNewFile())
        PersonalCameraCapture(file, FileProvider.getUriForFile(context, "${context.packageName}.attachments", file))
    } catch (error: Exception) {
        file.delete(); directory.delete(); throw error
    }
}
