package io.orbitd.android.management

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

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
/** A project's comments and conversations sit under its task pages, idle while those are turned off. */
internal fun sharingLayerEnabled(kind: String, key: String, include: JsonObject): Boolean =
    !(kind == "PROJECT" && key in setOf("commentsAndFiles", "conversations") && include.bool("taskPages") == false)

/** SharePanelCopy / SharedLinksList words. */
internal object ShareCopy {
    const val turnOffTitle = "Turn off this link?"
    const val turnOffDetail = "Anyone who has it loses access right away."
    const val conversationsRisk = "Can include command output and file contents."
    const val live = "Live — viewers see changes as they happen"
    const val notCurrent = "Not up to date — sharing can’t be changed until Orbit reconnects."
    const val privateDetail = "Only you can open it, signed in. Choose “Anyone with the link” to make a public link."
    const val listSubtitle = "Everything you’ve made viewable by link. Anyone who has one of these links can open what it includes — no sign-in."
    fun title(kind: String) = "Share ${kind.lowercase()}"
    fun publicDetail(kind: String) = if (kind == "SESSION") "Anyone with the link can view — no sign-in. They can’t reply or change anything."
        else "Anyone with the link can view — no sign-in. They can’t change anything."
    fun countOf(n: Int, noun: String) = "$n $noun${if (n == 1) "" else "s"}"
    fun shortDate(iso: String?, zone: ZoneId = ZoneId.systemDefault()) =
        isoMs(iso)?.let { DateTimeFormatter.ofPattern("MMM d", Locale.US).withZone(zone).format(Instant.ofEpochMilli(it)) }
    /** RelativeTime.span: `5s`, `12m`, `2h 5m`, `3h`, `1d 4h`, `9d`. */
    fun span(seconds: Long): String {
        val s = maxOf(0, seconds)
        if (s < 60) return "${maxOf(1, s)}s"
        if (s < 3_600) return "${s / 60}m"
        if (s < 86_400) { val h = s / 3_600; val m = s % 3_600 / 60; return if (h < 6 && m > 0) "${h}h ${m}m" else "${h}h" }
        val d = s / 86_400; val h = s % 86_400 / 3_600
        return if (d < 3 && h > 0) "${d}d ${h}h" else "${d}d"
    }
    fun ago(iso: String, nowMs: Long): String? = isoMs(iso)?.let { val diff = (nowMs - it) / 1000; if (diff < 10) "just now" else "${span(diff)} ago" }
    fun viewsLine(viewCount: Int, lastViewedAt: String?, nowMs: Long): String {
        if (viewCount == 0) return "Not opened yet"
        val times = if (viewCount == 1) "once" else "$viewCount times"
        lastViewedAt ?: return "Viewed $times"
        return "Viewed $times · last ${ago(lastViewedAt, nowMs) ?: "unknown"}"
    }
    fun kindWord(kind: String) = when (kind) { "SESSION" -> "Session"; "TASK" -> "Task"; "PROJECT" -> "Project"; else -> kind }
    private val taskStatus = mapOf("DONE" to "Done", "IN_PROGRESS" to "In progress", "OPEN" to "Open", "FAILED" to "Failed", "CANCELLED" to "Cancelled")
    private val projectStatus = mapOf("OPEN" to "Open", "DONE" to "Completed", "CANCELLED" to "Cancelled")
    /** SharedLinksList.whereLine: where the shared thing stands, or why the link stopped. */
    fun whereLine(link: JsonObject): String {
        val kind = kindWord(link.text("kind"))
        val root = link.obj("root") ?: JsonObject(emptyMap())
        return when (link.text("state")) {
            "PAUSED" -> "Paused · in Trash — restoring the session turns this link back on"
            "ENDED" -> {
                val word = if (link.str("stateReason") == "EXPIRED") "Expired" else "Turned off"
                "$kind · " + (shortDate(link.str("revokedAt") ?: link.str("expiresAt"))?.let { "$word $it" } ?: word)
            }
            else -> "$kind · " + when (link.text("kind")) {
                "TASK" -> root.text("status").let { taskStatus[it] ?: it }
                "PROJECT" -> root.text("status").let { projectStatus[it] ?: it }
                else -> {
                    val lifecycle = when (root.str("lifecycleState")?.uppercase()) {
                        "COMPLETED", "ARCHIVED" -> "Completed"; "TRASH" -> "Trash"; "OPEN" -> "Open"
                        else -> if (root.str("completedAt") == null) "Open" else "Completed"
                    }
                    if (lifecycle == "Completed") shortDate(root.str("completedAt"))?.let { "$lifecycle $it" } ?: lifecycle else lifecycle
                }
            }
        }
    }
    fun turnedOff(count: Int) = if (count == 1) "Link turned off" else "$count links turned off"

    data class Layer(val key: String?, val name: String, val detail: String, val count: String?, val on: Boolean, val nested: Boolean,
                     val idle: Boolean, val warns: Boolean) { val editable get() = key != null && !idle }
    /** SharePanel.layers: the layers a kind shares, each on unless turned off, nested ones idle under an off parent. */
    fun layers(kind: String, include: JsonObject, counts: JsonObject?): List<Layer> {
        fun on(key: String?) = key == null || include.bool(key) != false
        fun count(name: String, noun: String) = counts?.let { countOf(it.int(name) ?: 0, noun) }
        val comments = counts?.let { c -> listOf(countOf(c.int("comments") ?: 0, "comment")) +
            ((c.int("files") ?: 0).takeIf { it > 0 }?.let { listOf(countOf(it, "file")) }.orEmpty()) }?.joinToString(" · ")
        val specs: List<Layer> = when (kind) {
            "SESSION" -> listOf(Layer(null, "Messages", "What you and the agent wrote", count("messages", "message"), true, false, false, false),
                Layer("toolOutput", "Tool calls and output", "Commands, file reads and what they returned. Off shows only which tools ran.", count("toolCalls", "call"), true, false, false, false))
            "TASK" -> listOf(Layer(null, "Overview", "Description, acceptance, dependencies and runs", counts?.let { "Always" }, true, false, false, false),
                Layer("commentsAndFiles", "Comments & files", "Written by agents and people", comments, true, false, false, false),
                Layer("conversations", "Conversations", conversationsRisk, count("transcripts", "transcript"), true, false, false, true))
            else -> {
                val runs = counts?.int("runs") ?: 0
                val coordinator = if ((counts?.int("transcripts") ?: 0) > runs) " and the coordinator" else ""
                listOf(Layer(null, "Overview", "Goal, work overview, acceptance criteria and task graph", counts?.let { "Always" }, true, false, false, false),
                    Layer("taskPages", "Task pages", "Description, acceptance and runs for each task", count("tasks", "task"), true, false, false, false),
                    Layer("commentsAndFiles", "Comments & files", "Written by agents and people", comments, true, true, false, false),
                    Layer("conversations", "Conversations", if (counts == null) conversationsRisk else "${countOf(runs, "run")}$coordinator. $conversationsRisk",
                        count("transcripts", "transcript"), true, true, false, true))
            }
        }
        return specs.map { spec ->
            val isOn = on(spec.key)
            val idle = spec.nested && include.bool("taskPages") == false
            spec.copy(on = isOn, idle = idle, warns = spec.warns && isOn && !idle)
        }
    }
}

/** SharedLinksSettingsPage: every public link this account has made, by where it stands. */
@Composable
fun SharingSettings(api: ManagementApi, revision: Long) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val notice = remember { Notice() }
    val now = rememberNow(60_000)
    var links by remember(api) { mutableStateOf<List<JsonObject>?>(null) }
    var failure by remember(api) { mutableStateOf<String?>(null) }
    var tab by rememberSaveable { mutableStateOf("ACTIVE") }
    var turnOff by remember { mutableStateOf<JsonObject?>(null) }
    suspend fun load() {
        try { links = sharingList(api.get("share-links")).list("links"); failure = null }
        catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e) }
    }
    LaunchedEffect(api, revision, rememberResumed()) { load() }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val all = links.orEmpty()
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf("ACTIVE" to "Active", "PAUSED" to "Paused", "ENDED" to "Ended").forEachIndexed { index, (state, label) ->
                    SegmentedButton(selected = tab == state, onClick = { tab = state }, shape = SegmentedButtonDefaults.itemShape(index, 3)) {
                        Text("$label ${all.count { it.text("state") == state }}")
                    }
                }
            }
            Text(ShareCopy.listSubtitle, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            when {
                links == null && failure != null -> {
                    Text("Couldn’t load your links: $failure", color = Ink.muted)
                    TextButton(onClick = { scope.launch { load() } }) { Text("Retry") }
                }
                links == null -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                else -> {
                    failure?.let { Text("Couldn’t load your links: $it", color = Ink.red, style = MaterialTheme.typography.labelMedium) }
                    val shown = all.filter { it.text("state") == tab }
                    if (shown.isEmpty()) Text(when (tab) {
                        "ACTIVE" -> "Nothing is shared right now. Share a session from its ⋯ menu."
                        "PAUSED" -> "No link is paused. A session’s link pauses while the session is in Trash."
                        else -> "No link has ended yet."
                    }, color = Ink.muted)
                    shown.forEach { link ->
                        HorizontalDivider()
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(link.obj("root")?.str("title") ?: ShareCopy.kindWord(link.text("kind")), maxLines = 2)
                            Text(ShareCopy.whereLine(link), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                            Text(ShareCopy.viewsLine(link.int("viewCount") ?: 0, link.str("lastViewedAt"), now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                if (link.text("state") == "ACTIVE") {
                                    val url = sharingPublicUrl(api.handle.account.server, link.text("token"))
                                    TextButton(onClick = { copyText(context, "Public link", url); notice.show("Link copied") }) { Text("Copy Link") }
                                    TextButton(onClick = { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                                        .putExtra(Intent.EXTRA_TEXT, url), null)) }) { Text("Share Link…") }
                                }
                                if (sharingCanTurnOff(link)) TextButton(onClick = { turnOff = link }) { Text("Turn off", color = Ink.red) }
                            }
                        }
                    }
                }
            }
        }
        notice.Host(Modifier.align(Alignment.BottomCenter))
    }
    turnOff?.let { link ->
        AlertDialog(onDismissRequest = { turnOff = null }, title = { Text(ShareCopy.turnOffTitle) }, text = { Text(ShareCopy.turnOffDetail) },
            confirmButton = { TextButton(onClick = {
                turnOff = null
                scope.launch {
                    try {
                        val count = (api.post("share-links/turn-off", buildJsonObject { put("shareLinkIds", JsonArray(listOf(JsonPrimitive(link.text("id"))))) })
                            as? JsonObject)?.int("count") ?: 1
                        notice.show(ShareCopy.turnedOff(count)); load()
                    } catch (e: CancellationException) { throw e } catch (e: Exception) { notice.show("Couldn’t turn that off: ${personalFailure(e)}") }
                }
            }) { Text("Turn off", color = Ink.red) } }, dismissButton = { TextButton(onClick = { turnOff = null }) { Text("Cancel") } })
    }
}

/** The share sheet as a page of its own (the reader's Share, and the API a task/project page calls). */
@Composable
fun ShareResourceSettings(api: ManagementApi, revision: Long, kind: String, id: String) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text(ShareCopy.title(kind), style = MaterialTheme.typography.titleLarge)
        ShareResourcePanel(api, revision, kind, id, fresh = rememberLiveFor(api).second)
    }
}

/** The account's live connection, as (invalidation revision, current): while it is not current nothing tells a panel what a link became meanwhile. */
@Composable
private fun rememberLiveFor(api: ManagementApi): Pair<Long, Boolean> {
    val app = LocalContext.current.applicationContext as? OrbitApplication ?: return 0L to true
    val live by app.realtime.state.collectAsState()
    return if (live.handle === api.handle) live.invalidationRevision to live.directoryFresh else 0L to false
}

/** The directory's session Share dialog hosts the same panel, on the signed-in account's own handle. */
@Composable
fun SessionSharePanel(sessionId: String) {
    val app = LocalContext.current.applicationContext as OrbitApplication
    val handle = (app.session.state.collectAsState().value as? AuthState.SignedIn)?.handle ?: return
    val api = remember(handle) { ManagementApi(app.session, handle, app.processScope) }
    val (revision, fresh) = rememberLiveFor(api)
    ShareResourcePanel(api, revision, "SESSION", sessionId, fresh)
}

/** SharePanel: access, the link, what it includes, when it stops, and how often it was opened. */
@Composable
fun ShareResourcePanel(api: ManagementApi, revision: Long, kind: String, id: String, fresh: Boolean = true) {
    val path = remember(kind, id) { sharingPath(kind, id) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val now = rememberNow(60_000)
    var link by remember(path) { mutableStateOf<JsonObject?>(null) }
    var counts by remember(path) { mutableStateOf<JsonObject?>(null) }
    var loaded by remember(path) { mutableStateOf(false) }
    var loadFailure by remember(path) { mutableStateOf<String?>(null) }
    var failure by remember(path) { mutableStateOf<String?>(null) }
    var pending by remember(path) { mutableStateOf<Map<String, Boolean>>(emptyMap()) }
    var expiryChoice by remember(path) { mutableStateOf<String?>(null) }
    var confirmingOff by remember(path) { mutableStateOf(false) }
    var copied by remember(path) { mutableStateOf(false) }
    var busy by remember(path) { mutableStateOf(false) }
    // Writes need a read that held and a live connection, as the directory's own Share did (fresh && !busy).
    val writable = fresh && !busy
    fun open(value: JsonObject?) = value?.takeIf { it.text("state") != "ENDED" }
    suspend fun load() {
        try {
            val read = sharingRead(api.get(path), kind, id)
            link = open(read["link"] as? JsonObject); counts = read["counts"] as? JsonObject; loaded = true; loadFailure = null
        } catch (e: CancellationException) { throw e } catch (e: Exception) { loadFailure = personalFailure(e) }
    }
    fun save(body: JsonObject, rollback: () -> Unit = {}) {
        busy = true; failure = null
        scope.launch {
            try { link = open(api.put(path, body).jsonObject.let { (it["link"] as? JsonObject) ?: it.takeIf { o -> "token" in o } }); pending = emptyMap() }
            catch (e: CancellationException) { throw e } catch (e: Exception) { pending = emptyMap(); rollback(); failure = personalFailure(e) }
            finally { busy = false }
        }
    }
    LaunchedEffect(path, revision, rememberResumed()) { load() }
    LaunchedEffect(copied) { if (copied) { delay(1_500); copied = false } }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        // As iOS: a read that failed, the first or a later one, shows why and Retry, and nothing to change.
        loadFailure?.let {
            Text("Couldn’t load this link: $it", color = Ink.muted)
            TextButton(onClick = { scope.launch { load() } }) { Text("Retry") }
            return@Column
        }
        if (!loaded) { CircularProgressIndicator(Modifier.size(24.dp)); return@Column }
        if (!fresh) Text(ShareCopy.notCurrent, style = MaterialTheme.typography.bodySmall, color = Ink.amber)
        Text("Access", style = MaterialTheme.typography.titleMedium)
        listOf(false to "Only you", true to "Anyone with the link").forEach { (public, label) ->
            Row(Modifier.fillMaxWidth().selectable(selected = (link != null) == public, enabled = writable, role = Role.RadioButton) {
                if (public && link == null) save(JsonObject(emptyMap())) else if (!public && link != null) confirmingOff = true
            }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = (link != null) == public, onClick = null); Spacer(Modifier.width(8.dp)); Text(label)
            }
        }
        Text(if (link == null) ShareCopy.privateDetail else ShareCopy.publicDetail(kind), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        failure?.let { Text(it, color = Ink.red, style = MaterialTheme.typography.labelMedium) }
        link?.let { current ->
            val url = sharingPublicUrl(api.handle.account.server, current.text("token"))
            SelectionContainer { Text(url, style = MaterialTheme.typography.bodySmall) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { copyText(context, "Public link", url); copied = true }) { Text(if (copied) "Copied" else "Copy Link") }
                OutlinedButton(onClick = { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT, url), null)) }) { Text("Share Link…") }
            }
            Text("Includes", style = MaterialTheme.typography.titleMedium)
            val include = JsonObject((current.obj("include") ?: JsonObject(emptyMap())) + pending.mapValues { JsonPrimitive(it.value) })
            ShareCopy.layers(kind, include, counts).forEach { layer ->
                Row(Modifier.fillMaxWidth().padding(start = if (layer.nested) 16.dp else 0.dp, top = 4.dp, bottom = 4.dp)
                    .let { if (layer.key != null) it.toggleable(layer.on, enabled = layer.editable && writable, role = Role.Switch) { on ->
                        pending = pending + (layer.key to on); save(buildJsonObject { put("include", buildJsonObject { put(layer.key, on) }) })
                    } else it }, verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(layer.name, color = if (layer.idle) Ink.muted else MaterialTheme.colorScheme.onSurface)
                        Text(layer.detail, style = MaterialTheme.typography.bodySmall, color = if (layer.warns) Ink.amber else Ink.muted)
                        layer.count?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.muted) }
                    }
                    if (layer.key != null) Switch(checked = layer.on, onCheckedChange = null, enabled = layer.editable && writable)
                }
            }
            Text("Updates", style = MaterialTheme.typography.titleMedium)
            Text(ShareCopy.live, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            Text("Expires", style = MaterialTheme.typography.titleMedium)
            val until = ShareCopy.shortDate(current.str("expiresAt"))?.let { "Until $it" }
            val selection = expiryChoice ?: if (current.str("expiresAt") != null) "until" else "never"
            val options = listOf("never" to "Never", "1" to "1 day", "7" to "7 days", "30" to "30 days") +
                if (selection == "until" && until != null) listOf("until" to until) else emptyList()
            var expanded by remember { mutableStateOf(false) }
            Box {
                OutlinedButton(onClick = { expanded = true }, enabled = writable) { Text(options.firstOrNull { it.first == selection }?.second ?: "Never") }
                DropdownMenu(expanded, { expanded = false }) {
                    options.filter { it.first != "until" }.forEach { (value, label) ->
                        DropdownMenuItem(text = { Text(label) }, trailingIcon = if (value == selection) { { Text("✓") } } else null, onClick = {
                            expanded = false
                            val before = expiryChoice
                            expiryChoice = value
                            save(sharingExpiry(value.toIntOrNull())) { expiryChoice = before }
                        })
                    }
                }
            }
            if (selection != "until") ShareCopy.shortDate(current.str("expiresAt"))?.let { Text("Stops working $it", style = MaterialTheme.typography.bodySmall, color = Ink.muted) }
            Text(ShareCopy.viewsLine(current.int("viewCount") ?: 0, current.str("lastViewedAt"), now), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        }
    }
    if (confirmingOff) AlertDialog(onDismissRequest = { confirmingOff = false }, title = { Text(ShareCopy.turnOffTitle) }, text = { Text(ShareCopy.turnOffDetail) },
        confirmButton = { TextButton(enabled = writable, onClick = {
            confirmingOff = false; busy = true; failure = null
            scope.launch {
                try { api.delete(path); link = null; expiryChoice = null; pending = emptyMap() }
                catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e) }
                finally { busy = false }
            }
        }) { Text("Turn off", color = Ink.red) } }, dismissButton = { TextButton(onClick = { confirmingOff = false }) { Text("Cancel") } })
}
