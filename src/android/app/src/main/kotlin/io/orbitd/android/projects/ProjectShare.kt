package io.orbitd.android.projects

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.directoryError
import io.orbitd.android.taskprojects.FeatureWrites
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.time.Instant
import java.time.temporal.ChronoUnit

/** The existing project share door: each gesture changes only the layer or expiry it names. */
@Composable
fun ProjectShareDialog(id: String, handle: SessionHandle, api: DirectoryApi, writes: FeatureWrites,
    revision: Long, available: Boolean, dismiss: () -> Unit) {
    var read by remember(id, handle) { mutableStateOf<JsonObject?>(null) }
    var fresh by remember(id, handle) { mutableStateOf(false) }
    var busy by remember(id, handle) { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    var message by remember(id, handle) { mutableStateOf<String?>(null) }
    var confirmOff by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val path = listOf("projects", id, "share")
    LaunchedEffect(id, handle, revision, retry) {
        fresh = false
        try { read = api.objectRead(path); fresh = true }
        catch (cancel: CancellationException) { throw cancel }
        catch (error: Exception) { read = null; message = directoryError(error) }
    }
    val link = read?.obj("link")
    val enabled = available && fresh && !busy
    fun write(method: HttpMethod, body: JsonObject? = null) {
        if (!enabled) return
        val shown = read ?: return
        busy = true
        scope.launch {
            try {
                val checked = api.objectRead(path)
                check(checked.obj("link") == shown.obj("link")) { "This share link changed. Review its current settings." }
                writes.execute("project-share:$id:${shown.obj("link")?.text("id")}:${shown.obj("link")?.text("updatedAt")}:$method:$body",
                    ApiRequest(path, method, body = body?.toString()?.encodeToByteArray()))
                message = "Share settings saved."
            } catch (cancel: CancellationException) { throw cancel }
            catch (error: Exception) { message = (error as? ApiError)?.messages?.firstOrNull() ?: error.message ?: directoryError(error) }
            finally { busy = false; fresh = false; retry++ }
        }
    }
    Dialog(onDismissRequest = { if (!busy) dismiss() }) {
        Surface(shape = MaterialTheme.shapes.large) {
            Column(Modifier.padding(20.dp).heightIn(max = 650.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Share project", style = MaterialTheme.typography.titleLarge)
                if (!fresh) LinearProgressIndicator(Modifier.fillMaxWidth())
                message?.let { Text(it) }
                if (read == null) TextButton(onClick = { retry++ }) { Text("Retry") }
                if (read != null) {
                    Text("Access", style = MaterialTheme.typography.titleMedium)
                    Text(if (link == null) "Only you" else "Anyone with the link")
                    Text("Anyone with the public link can read the included project content without signing in.")
                    if (link == null) Button(enabled = enabled, onClick = { write(HttpMethod.PUT, buildJsonObject {}) }) { Text("Create public link") }
                    else {
                        val token = link.text("token")
                        val url = token?.let { handle.account.server.toHttpUrl().newBuilder().addPathSegment("s").addPathSegment(it).build().toString() }
                        if (url != null) {
                            Text(url, style = MaterialTheme.typography.bodySmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                TextButton(enabled = fresh, onClick = { clipboard.setText(AnnotatedString(url)); message = "Public link copied." }) { Text("Copy public link") }
                                TextButton(enabled = fresh, onClick = {
                                    val intent = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
                                    try { context.startActivity(Intent.createChooser(intent, "Share project")) }
                                    catch (_: Exception) { message = "No application can share this link." }
                                }) { Text("Share link…") }
                            }
                        }
                        Text("Includes", style = MaterialTheme.typography.titleMedium)
                        Text("Project overview and criteria")
                        val layers = linkedMapOf("taskPages" to "Task pages", "commentsAndFiles" to "Comments and files", "conversations" to "Conversations", "toolOutput" to "Tool output")
                        layers.forEach { (key, label) ->
                            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                                Checkbox(link.obj("include")?.get(key) != JsonPrimitive(false), { value ->
                                    write(HttpMethod.PUT, buildJsonObject { putJsonObject("include") { put(key, value) } })
                                }, enabled = enabled)
                                Text(label)
                            }
                        }
                        read?.obj("counts")?.let { counts -> Text(listOf("tasks", "comments", "files", "runs", "transcripts").mapNotNull { key -> counts.number(key)?.let { "$it $key" } }.joinToString(" · ")) }
                        Text("Live · follows future changes to the included content.")
                        Text("Expires · ${link.text("expiresAt") ?: "Never"}")
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            TextButton(enabled = enabled, onClick = { write(HttpMethod.PUT, buildJsonObject { put("expiresAt", JsonNull) }) }) { Text("Never") }
                            listOf(1L, 7L, 30L).forEach { days -> TextButton(enabled = enabled, onClick = {
                                write(HttpMethod.PUT, buildJsonObject { put("expiresAt", Instant.now().plus(days, ChronoUnit.DAYS).toString()) })
                            }) { Text("${days}d") } }
                        }
                        Text("Opened ${link.number("viewCount") ?: 0} times")
                        link.text("lastViewedAt")?.let { Text("Last opened $it") }
                        TextButton(enabled = enabled, onClick = { confirmOff = true }) { Text("Turn off public link…") }
                    }
                }
                TextButton(enabled = !busy, onClick = dismiss) { Text("Done") }
            }
        }
    }
    if (confirmOff) AlertDialog(onDismissRequest = { confirmOff = false }, title = { Text("Turn off this public link?") },
        text = { Text("Anyone who has it loses access immediately.") },
        confirmButton = { TextButton(enabled = enabled, onClick = { confirmOff = false; write(HttpMethod.DELETE) }) { Text("Turn off") } },
        dismissButton = { TextButton(onClick = { confirmOff = false }) { Text("Cancel") } })
}
