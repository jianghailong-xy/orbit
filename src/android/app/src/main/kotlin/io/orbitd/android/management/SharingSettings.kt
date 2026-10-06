package io.orbitd.android.management

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.time.Instant
import java.time.temporal.ChronoUnit

internal fun sharingPath(kind: String, id: String): String = when (kind) {
    "SESSION" -> "sessions"
    "TASK" -> "tasks"
    "PROJECT" -> "projects"
    else -> throw IllegalArgumentException("Unknown share kind")
} + "/$id/share"

/** A malformed success must not become "Only you" or an empty shared-links list. */
internal fun sharingRead(value: JsonElement, kind: String, id: String): JsonObject {
    val read = value as? JsonObject ?: throw IllegalStateException("Invalid share response")
    require("link" in read) { "Missing share state" }
    require(read["counts"] == null || read["counts"] == JsonNull || read["counts"] is JsonObject) { "Invalid share counts" }
    val link = read["link"]
    if (link != JsonNull) {
        sharingValidateLink(link)
        require(link!!.jsonObject.text("kind") == kind && ObjectId.same(link.jsonObject["root"]!!.jsonObject.text("id"), id)) { "Share response belongs to another resource" }
    }
    return read
}

internal fun sharingList(value: JsonElement): JsonObject {
    val read = value as? JsonObject ?: throw IllegalStateException("Invalid shared-links response")
    val links = read["links"] as? JsonArray ?: throw IllegalStateException("Missing shared-links list")
    links.forEach(::sharingValidateLink)
    return read
}

private fun sharingValidateLink(value: JsonElement?) {
    val link = value as? JsonObject ?: throw IllegalStateException("Invalid shared link")
    val root = link["root"] as? JsonObject ?: throw IllegalStateException("Missing share root")
    require(listOf("id", "kind", "state", "token").all { link.text(it).isNotBlank() } && root.text("id").isNotBlank()) { "Incomplete shared link" }
    val include = link["include"] as? JsonObject ?: throw IllegalStateException("Missing included content")
    require(include.values.all { (it as? JsonPrimitive)?.booleanOrNull != null }) { "Invalid included content" }
}

internal fun sharingCanTurnOff(link: JsonObject) = link.text("state") in setOf("ACTIVE", "PAUSED")
internal fun sharingPublicUrl(server: String, token: String): String = server.toHttpUrl().newBuilder()
    .addPathSegment("s").addPathSegment(token).build().toString()
internal fun sharingExpiry(days: Int?, now: Instant = Instant.now()) = buildJsonObject {
    put("expiresAt", days?.let { JsonPrimitive(now.plus(it.toLong(), ChronoUnit.DAYS).toString()) } ?: JsonNull)
}
internal fun sharingLayerEnabled(kind: String, key: String, include: JsonObject): Boolean =
    !(kind == "PROJECT" && key in setOf("commentsAndFiles", "conversations") && !include.flag("taskPages"))

@Composable
fun SharingSettings(api: ManagementApi, revision: Long) {
    val record = remember(api) { PersonalRecord { sharingList(api.get("share-links")) } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val links = (record.value as? JsonObject)?.list("links").orEmpty()
    var tab by remember(api) { mutableStateOf("ACTIVE") }
    var turnOff by remember(api) { mutableStateOf<JsonObject?>(null) }
    var selected by remember(api) { mutableStateOf<Pair<String, String>?>(null) }
    selected?.let { (kind, id) ->
        BackHandler { selected = null; scope.launch { record.load() } }
        Column {
            TextButton(onClick = { selected = null; scope.launch { record.load() } }) { Text("Back to shared links") }
            ShareResourceSettings(api, revision, kind, id)
        }
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Shared links", style = MaterialTheme.typography.titleLarge)
        Text("Everything you've made viewable by link. Anyone who has one of these links can open what it includes — no sign-in.")
        PersonalRecordStatus(record)
        PersonalChoice("State", tab, listOf("ACTIVE" to "Active", "PAUSED" to "Paused", "ENDED" to "Ended", "UNKNOWN" to "Unknown"), !record.busy) { tab = it }
        val shown = links.filter { if (tab == "UNKNOWN") it.text("state") !in setOf("ACTIVE", "PAUSED", "ENDED") else it.text("state") == tab }
        if (record.value != null && shown.isEmpty()) Text(when (tab) {
            "ACTIVE" -> "Nothing is shared right now. Share a session, task or project from its Share entry."
            "PAUSED" -> "No link is paused. A session's link pauses while the session is in Trash."
            "ENDED" -> "No link has ended yet."
            else -> "No link has an unknown state."
        })
        shown.forEach { link ->
            val root = link["root"] as? JsonObject ?: JsonObject(emptyMap())
            HorizontalDivider()
            Text(root.text("title").ifBlank { link.text("kind") }, style = MaterialTheme.typography.titleMedium)
            Text("${link.text("kind")} · ${link.text("state")} · ${link.text("stateReason")}")
            if (link.text("state") == "PAUSED") Text("In Trash — restoring the session turns this link back on.")
            Text("Views: ${link.text("viewCount").ifBlank { "0" }} · Last viewed: ${link.text("lastViewedAt").ifBlank { "Not opened yet" }}")
            Text("Expires: ${link.text("expiresAt").ifBlank { "Never" }}")
            if (link.text("state") == "ACTIVE") SharingLinkActions(api, link, record.ready)
            if (link.text("kind") in setOf("SESSION", "TASK", "PROJECT") && root.text("id").isNotBlank()) {
                TextButton(onClick = { selected = link.text("kind") to root.text("id") }, enabled = record.ready) { Text("Access & included content") }
            }
            if (sharingCanTurnOff(link)) TextButton(onClick = { turnOff = link }, enabled = record.ready) { Text("Turn off link") }
        }
    }
    if (turnOff != null) SharingTurnOffDialog(onDismiss = { turnOff = null }, enabled = record.ready) {
        val id = turnOff!!.text("id"); turnOff = null
        scope.launch { record.mutate { api.post("share-links/turn-off", buildJsonObject {
            put("shareLinkIds", JsonArray(listOf(JsonPrimitive(id))))
        }) } }
    }
}

/** Minimal shared entry for session/task/project owners; the owner endpoint supplies authority. */
@Composable
fun ShareResourceSettings(api: ManagementApi, revision: Long, kind: String, id: String) {
    val path = remember(kind, id) { sharingPath(kind, id) }
    val record = remember(api, path) { PersonalRecord { sharingRead(api.get(path), kind, id) } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val read = record.value as? JsonObject
    val rawLink = read?.get("link") as? JsonObject
    val link = rawLink?.takeIf { sharingCanTurnOff(it) }
    val unknown = rawLink != null && rawLink.text("state") !in setOf("ACTIVE", "PAUSED", "ENDED")
    val include = link?.get("include") as? JsonObject ?: JsonObject(emptyMap())
    val counts = read?.get("counts") as? JsonObject
    var confirming by remember(api, path) { mutableStateOf(false) }
    fun save(body: JsonObject) { scope.launch { record.mutate { api.put(path, body) } } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Share ${kind.lowercase()}", style = MaterialTheme.typography.titleLarge)
        PersonalRecordStatus(record)
        if (read != null) {
            Text("Access: ${if (unknown) "Unknown — refresh required" else if (link == null) "Only you" else "Anyone with the link"}")
            Text(if (unknown) "The server returned an unsupported link state. Refresh before changing access."
                else if (link == null) "Only you can open it, signed in. Choose Anyone with the link to make a public link."
                else "Anyone with the link can view — no sign-in. They can't change anything.")
            if (!unknown && link == null) Button(onClick = { save(JsonObject(emptyMap())) }, enabled = record.ready) { Text("Anyone with the link") }
            if (link != null) {
                if (link.text("state") == "PAUSED") Text("Paused in Trash. Restoring the session reopens this link.")
                SharingLinkActions(api, link, record.ready && link.text("state") == "ACTIVE")
                TextButton(onClick = { confirming = true }, enabled = record.ready) { Text("Only you · turn off link") }
                Text("Includes", style = MaterialTheme.typography.titleMedium)
                Text(if (kind == "SESSION") "Messages · Always · ${counts?.text("messages").orEmpty()} messages" else "Overview · Always")
                val specs = when (kind) {
                    "SESSION" -> listOf(Triple("toolOutput", "Tool calls and output", "toolCalls"))
                    "TASK" -> listOf(Triple("commentsAndFiles", "Comments & files", "comments"), Triple("conversations", "Conversations", "transcripts"))
                    else -> listOf(Triple("taskPages", "Task pages", "tasks"), Triple("commentsAndFiles", "Comments & files", "comments"), Triple("conversations", "Conversations", "transcripts"))
                }
                specs.forEach { (key, title, countKey) ->
                    val nested = kind == "PROJECT" && key != "taskPages"
                    Row(Modifier.padding(start = if (nested) 16.dp else 0.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Switch(modifier = Modifier.semantics { contentDescription = title }, checked = include.flag(key), enabled = record.ready && key in include && sharingLayerEnabled(kind, key, include),
                            onCheckedChange = { value -> save(buildJsonObject { put("include", buildJsonObject { put(key, value) }) }) })
                        Column {
                            Text(title)
                            Text("${counts?.text(countKey).orEmpty().ifBlank { "—" }} ${if (countKey == "toolCalls") "calls" else countKey}")
                            if (key == "commentsAndFiles") Text("Files: ${counts?.text("files").orEmpty().ifBlank { "—" }}")
                            if (key == "conversations") Text("Can include command output and file contents.")
                            if (key == "toolOutput") Text("Commands, file reads and what they returned. Off shows only which tools ran.")
                        }
                    }
                }
                Text("Live — viewers see changes as they happen")
                Text("Expires: ${link.text("expiresAt").ifBlank { "Never" }}")
                PersonalChoice("Change expiry", "choose", listOf("choose" to "Choose…", "never" to "Never", "1" to "1 day", "7" to "7 days", "30" to "30 days"), record.ready) {
                    if (it != "choose") save(sharingExpiry(it.toIntOrNull()))
                }
                Text("Viewed ${link.text("viewCount").ifBlank { "0" }} times · Last viewed ${link.text("lastViewedAt").ifBlank { "Not opened yet" }}")
            }
        }
    }
    if (confirming) SharingTurnOffDialog(onDismiss = { confirming = false }, enabled = record.ready) {
        confirming = false; scope.launch { record.mutate { api.delete(path) } }
    }
}

@Composable
private fun SharingLinkActions(api: ManagementApi, link: JsonObject, enabled: Boolean) {
    val context = LocalContext.current
    var copied by remember(link.text("token")) { mutableStateOf(false) }
    val url = sharingPublicUrl(api.handle.account.server, link.text("token"))
    Text(url)
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(enabled = enabled, onClick = {
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Public link", url))
            copied = true
        }) { Text(if (copied) "Copied" else "Copy Link") }
        TextButton(enabled = enabled, onClick = {
            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "text/plain"; putExtra(Intent.EXTRA_TEXT, url) }, "Share Link"))
        }) { Text("Share Link…") }
    }
}

@Composable
private fun SharingTurnOffDialog(onDismiss: () -> Unit, enabled: Boolean, onConfirm: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Turn off this link?") },
        text = { Text("Anyone who has it loses access right away. Turning it on again makes a new link.") },
        confirmButton = { TextButton(onClick = onConfirm, enabled = enabled) { Text("Turn off") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}
