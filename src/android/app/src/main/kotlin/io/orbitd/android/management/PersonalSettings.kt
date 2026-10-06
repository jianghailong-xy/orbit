package io.orbitd.android.management

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.core.content.FileProvider
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
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
    TextButton(onClick = { scope.launch { record.load() } }, enabled = !record.busy) { Text("Refresh") }
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

internal val personalPermissions = listOf("default" to "Default", "acceptEdits" to "Accept edits",
    "plan" to "Plan", "auto" to "Auto", "dontAsk" to "Don't ask", "bypassPermissions" to "Bypass permissions")

@Composable
fun PersonalSettings(api: ManagementApi, revision: Long, onAppearance: (String) -> Unit) {
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val user = record.value as? JsonObject
    val preferences = user?.get("preferences") as? JsonObject ?: JsonObject(emptyMap())
    val appearanceCallback by rememberUpdatedState(onAppearance)
    LaunchedEffect(record.ready, preferences.text("theme")) {
        if (record.ready) appearanceCallback(preferences.text("theme").ifBlank { "system" })
    }
    var name by remember(api) { mutableStateOf("") }
    var current by remember(api) { mutableStateOf("") }
    var fresh by remember(api) { mutableStateOf("") }
    var confirm by remember(api) { mutableStateOf("") }
    var notice by remember(api) { mutableStateOf<String?>(null) }
    var photo by remember(api) { mutableStateOf<Bitmap?>(null) }
    var draft by remember(api) { mutableStateOf<Bitmap?>(null) }
    var pendingPhoto by remember(api) { mutableStateOf<ByteArray?>(null) }
    var pendingPreview by remember(api) { mutableStateOf<Bitmap?>(null) }
    var removePhoto by remember(api) { mutableStateOf(false) }
    LaunchedEffect(user?.text("name")) { name = user?.text("name").orEmpty() }
    LaunchedEffect(user?.text("avatarUpdatedAt"), record.stale) {
        photo = null
        if (record.ready && !user?.text("avatarUpdatedAt").isNullOrBlank()) {
            try {
                val bytes = api.session.request(api.handle, ApiRequest(listOf("users", "me", "avatar"),
                    maxResponseBytes = 2L * 1024 * 1024)).body
                photo = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { notice = "Could not load your photo. Refresh to retry." }
        }
    }
    fun pick(uri: Uri?) {
        if (uri == null) return
        scope.launch {
            try { draft = withContext(Dispatchers.IO) { personalDecodePhoto(context.contentResolver, uri) } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { notice = "Couldn't read that image." }
        }
    }
    val library = rememberLauncherForActivityResult(ActivityResultContracts.GetContent(), ::pick)
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument(), ::pick)
    var cameraCapture by remember(api) { mutableStateOf<PersonalCameraCapture?>(null) }
    DisposableEffect(api) { onDispose { cameraCapture?.close(context); cameraCapture = null } }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { captured ->
        val pending = cameraCapture
        if (pending != null) {
            if (!captured) { pending.close(context); cameraCapture = null }
            else scope.launch {
                try { draft = withContext(Dispatchers.IO) { personalDecodePhoto(context.contentResolver, pending.uri) } }
                catch (e: CancellationException) { throw e }
                catch (_: Exception) { notice = "Couldn't read the camera photo. Take a new photo." }
                finally { pending.close(context); if (cameraCapture === pending) cameraCapture = null }
            }
        }
    }
    fun preference(key: String, value: JsonPrimitive) {
        scope.launch {
            notice = null
            if (record.mutate { api.patch("users/me/preferences", buildJsonObject { put(key, value) }) } && key == "theme")
                onAppearance((record.value as JsonObject)["preferences"]!!.jsonObject.text("theme"))
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Profile & preferences", style = MaterialTheme.typography.titleLarge)
        PersonalRecordStatus(record)
        user?.let {
            (if (removePhoto) null else pendingPreview ?: photo)?.let { Image(it.asImageBitmap(), "Profile photo", Modifier.size(80.dp).clip(CircleShape)) }
                ?: Text(it.text("name").ifBlank { it.text("email") }.take(1), style = MaterialTheme.typography.displayMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TextButton(onClick = { library.launch("image/*") }, enabled = record.ready) { Text("Photo library") }
                TextButton(onClick = { files.launch(arrayOf("image/*")) }, enabled = record.ready) { Text("Choose file") }
            }
            TextButton(onClick = {
                try {
                    cameraCapture?.close(context)
                    cameraCapture = personalPrepareCamera(context)
                    camera.launch(cameraCapture!!.uri)
                } catch (_: Exception) {
                    cameraCapture?.close(context); cameraCapture = null
                    notice = "Couldn't open the camera. Choose a photo from your library or files."
                }
            }, enabled = record.ready) { Text("Take photo") }
            if (it.text("avatarUpdatedAt").isNotBlank() || pendingPhoto != null) TextButton(onClick = {
                removePhoto = true; pendingPhoto = null; pendingPreview = null
            }, enabled = record.ready) { Text("Remove photo") }
            OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true,
                enabled = record.ready, modifier = Modifier.fillMaxWidth())
            Text("People in your shared pools see you by this name.")
            Button(onClick = { scope.launch { record.mutate {
                // ProfileEdit in OrbitKit: commit the photo first; retry only the remaining step.
                pendingPhoto?.let { jpeg -> personalUploadAvatar(api, jpeg); pendingPhoto = null; pendingPreview = null }
                if (removePhoto) { api.delete("users/me/avatar"); removePhoto = false }
                if (name.trim() != it.text("name")) api.patch("users/me", buildJsonObject { put("name", name.trim()) })
            } } }, enabled = record.ready && name.trim().isNotEmpty() && name.trim().length <= 80 &&
                (name.trim() != it.text("name") || pendingPhoto != null || removePhoto)) { Text("Save profile") }
            SelectionContainer { Text("Email: ${it.text("email")}\nRole: ${it.text("role")}\nInstance: ${api.handle.account.server}") }
            PersonalChoice("Appearance", preferences.text("theme").ifBlank { "system" },
                listOf("system" to "System", "light" to "Light", "dark" to "Dark"), record.ready) { preference("theme", JsonPrimitive(it)) }
            PersonalChoice("Default permission", preferences.text("defaultPermissionMode").ifBlank { "auto" },
                personalPermissions, record.ready) { preference("defaultPermissionMode", JsonPrimitive(it)) }
            Text("Session orchestration")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Switch(modifier = Modifier.semantics { contentDescription = "Let sessions orchestrate" },
                    checked = (preferences["enableOrchestration"] as? JsonPrimitive)?.booleanOrNull != false,
                    onCheckedChange = { preference("enableOrchestration", JsonPrimitive(it)) }, enabled = record.ready)
                Text("Let sessions orchestrate")
            }
            Text("Sessions in every workspace can spawn and manage other sessions via the orbit MCP session tools. Off → those tools are hidden and refused.")
            HorizontalDivider()
            Text("Change password", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(current, { current = it }, label = { Text("Current password") }, visualTransformation = PasswordVisualTransformation(), enabled = record.ready)
            OutlinedTextField(fresh, { fresh = it }, label = { Text("New password · at least 6 characters") }, visualTransformation = PasswordVisualTransformation(), enabled = record.ready)
            OutlinedTextField(confirm, { confirm = it }, label = { Text("Confirm new password") }, visualTransformation = PasswordVisualTransformation(), enabled = record.ready)
            if (confirm.isNotEmpty() && fresh != confirm) Text("Passwords do not match")
            Button(onClick = { scope.launch {
                notice = null
                if (record.mutate { api.post("auth/change-password", buildJsonObject {
                    put("currentPassword", current); put("newPassword", fresh)
                }) }) { current = ""; fresh = ""; confirm = ""; notice = "Password changed" }
            } }, enabled = record.ready && current.isNotEmpty() && fresh.length >= 6 && fresh == confirm) { Text("Change password") }
        }
        notice?.let { Text(it) }
    }
    draft?.let { source -> PersonalPhotoDialog(source, onDismiss = { draft = null }, onSave = { bytes ->
        draft = null; pendingPhoto = bytes; removePhoto = false
        pendingPreview = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }) }
}

@Composable
fun NotificationsPreferences(api: ManagementApi, revision: Long) {
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val preferences = (record.value as? JsonObject)?.get("preferences") as? JsonObject
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Sent to all your devices", style = MaterialTheme.typography.titleMedium)
        PersonalRecordStatus(record)
        listOf("notifySessionFinished" to "When a session finishes", "notifyAgentMessage" to "When an agent asks for you").forEach { (key, title) ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Switch(modifier = Modifier.semantics { contentDescription = title },
                    checked = (preferences?.get(key) as? JsonPrimitive)?.booleanOrNull != false, enabled = record.ready,
                    onCheckedChange = { checked -> scope.launch { record.mutate {
                        api.patch("users/me/preferences", buildJsonObject { put(key, checked) })
                    } } })
                Text(title)
            }
        }
        Text("Always sent: Tool approvals · Projects waiting on you · Engine sign-outs · Watch matches")
        Text("Account preferences do not enable device notifications. Device delivery needs an authorized, registered device.")
    }
}

internal fun personalDecodePhoto(resolver: ContentResolver, uri: Uri): Bitmap =
    ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
        val scale = minOf(1.0, 1024.0 / maxOf(info.size.width, info.size.height))
        decoder.setTargetSize(maxOf(1, (info.size.width * scale).toInt()), maxOf(1, (info.size.height * scale).toInt()))
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }

/** Small decoded source, oriented by ImageDecoder; the sliders address only valid square crops. */
internal fun personalCropPhoto(source: Bitmap, zoom: Float, horizontal: Float, vertical: Float): Bitmap {
    val side = maxOf(1, (minOf(source.width, source.height) / zoom.coerceIn(1f, 5f)).toInt())
    val left = ((source.width - side) * horizontal.coerceIn(0f, 1f)).toInt()
    val top = ((source.height - side) * vertical.coerceIn(0f, 1f)).toInt()
    val square = Bitmap.createBitmap(source, left, top, side, side)
    return Bitmap.createScaledBitmap(square, 512, 512, true)
}

@Composable
private fun PersonalPhotoDialog(source: Bitmap, onDismiss: () -> Unit, onSave: (ByteArray) -> Unit) {
    var zoom by remember(source) { mutableFloatStateOf(1f) }
    var horizontal by remember(source) { mutableFloatStateOf(.5f) }
    var vertical by remember(source) { mutableFloatStateOf(.5f) }
    val cropped = remember(source, zoom, horizontal, vertical) { personalCropPhoto(source, zoom, horizontal, vertical) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Crop profile photo") }, text = {
        Column {
            Image(cropped.asImageBitmap(), "Photo crop preview", Modifier.size(200.dp).clip(CircleShape))
            Text("Zoom"); Slider(zoom, { zoom = it }, valueRange = 1f..5f)
            Text("Horizontal position"); Slider(horizontal, { horizontal = it })
            Text("Vertical position"); Slider(vertical, { vertical = it })
        }
    }, confirmButton = { TextButton(onClick = {
        val out = ByteArrayOutputStream(); cropped.compress(Bitmap.CompressFormat.JPEG, 85, out); onSave(out.toByteArray())
    }) { Text("Save photo") } }, dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
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
