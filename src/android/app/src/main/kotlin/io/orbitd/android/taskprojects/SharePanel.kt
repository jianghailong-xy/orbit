package io.orbitd.android.taskprojects

import android.content.Intent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/** OrbitKit `SharePanel`/`SharePanelCopy`: one public-link panel for a task and a project (A05 owns
 * the session's). Every change is saved as it is made and the server's answer replaces it. */
enum class ShareRootKind(val segment: String) { TASK("tasks"), PROJECT("projects") }

object SharePanelCopy {
    const val access = "Access"
    const val onlyYou = "Only you"
    const val onlyYouDetail = "Turns the link off. Turning it on again makes a new link."
    const val anyoneWithTheLink = "Anyone with the link"
    const val anyoneWithTheLinkDetail = "No sign-in needed to view."
    const val privateDetail = "Only you can open it, signed in. Choose “Anyone with the link” to make a public link."
    const val turnOffTitle = "Turn off this link?"
    const val turnOffDetail = "Anyone who has it loses access right away."
    const val turnOff = "Turn off"
    const val cancel = "Cancel"
    const val copyLink = "Copy Link"
    const val copied = "Copied"
    const val shareLink = "Share Link…"
    const val includes = "Includes"
    const val conversationsRisk = "Can include command output and file contents."
    const val always = "Always"
    const val updates = "Updates"
    const val live = "Live — viewers see changes as they happen"
    const val expires = "Expires"
    const val notOpenedYet = "Not opened yet"
    const val done = "Done"
    const val couldNotLoad = "Couldn’t load this link:"
    const val retry = "Retry"
    const val share = "Share…"
    const val liveLink = "Live link"
    const val copyAsMarkdown = "Copy as Markdown"
    const val linkCopied = "Link copied"
    const val markdownCopied = "Markdown copied"
    fun title(kind: ShareRootKind) = if (kind == ShareRootKind.TASK) "Share task" else "Share project"
    const val publicDetail = "Anyone with the link can view — no sign-in. They can’t change anything."
    fun countOf(n: Int, noun: String) = "$n $noun${if (n == 1) "" else "s"}"
    fun viewsLine(viewCount: Int, lastViewedAt: String?, now: Instant = Instant.now()): String {
        if (viewCount == 0) return notOpenedYet
        val times = if (viewCount == 1) "once" else "$viewCount times"
        lastViewedAt ?: return "Viewed $times"
        return "Viewed $times · last ${ago(lastViewedAt, now) ?: "unknown"}"
    }
    fun shortDate(iso: String): String? = runCatching { DateTimeFormatter.ofPattern("MMM d", Locale.US).format(Instant.parse(iso).atZone(ZoneOffset.UTC)) }.getOrNull()
    /** The web's `ago`: "just now" under ten seconds, then a span such as "3h 20m ago". */
    fun ago(iso: String, now: Instant = Instant.now()): String? {
        val date = runCatching { Instant.parse(iso) }.getOrNull() ?: return null
        val seconds = Duration.between(date, now).seconds.toDouble()
        return if (seconds < 10) "just now" else "${span(seconds)} ago"
    }
    fun span(seconds: Double): String {
        val s = maxOf(0.0, seconds)
        if (s < 60) return "${maxOf(1, s.toInt())}s"
        if (s < 3600) return "${(s / 60).toInt()}m"
        if (s < 86_400) { val h = (s / 3600).toInt(); val m = ((s % 3600) / 60).toInt(); return if (h < 6 && m > 0) "${h}h ${m}m" else "${h}h" }
        val d = (s / 86_400).toInt(); val h = ((s % 86_400) / 3600).toInt()
        return if (d < 3 && h > 0) "${d}d ${h}h" else "${d}d"
    }
}

data class ShareLayerRow(val layer: String?, val name: String, val detail: String, val count: String?, val on: Boolean,
    val nested: Boolean, val idle: Boolean, val warns: Boolean) { val editable get() = layer != null && !idle }

object SharePanel {
    val expiryChoices = listOf("never" to "Never", "1" to "1 day", "7" to "7 days", "30" to "30 days")
    /** The open link; one that has ended reads as no link at all. */
    fun open(read: JsonObject?): JsonObject? = read?.obj("link")?.takeIf { it.text("state") != "ENDED" }
    /** What a ⋯ menu's Share… says under itself; nothing before the read came back. */
    fun menuStatus(read: JsonObject?): String? = read?.let { if (open(it) == null) SharePanelCopy.onlyYou else SharePanelCopy.liveLink }
    fun publicUrl(server: String, link: JsonObject): String? = link.text("token")?.let {
        runCatching { server.toHttpUrl().newBuilder().addPathSegment("s").addPathSegment(it).build().toString() }.getOrNull()
    }
    private fun commentsAndFiles(counts: JsonObject): String {
        val files = counts.number("files") ?: 0
        return (listOf(SharePanelCopy.countOf(counts.number("comments") ?: 0, "comment")) +
            if (files > 0) listOf(SharePanelCopy.countOf(files, "file")) else emptyList()).joinToString(" · ")
    }
    fun layers(kind: ShareRootKind, link: JsonObject?, counts: JsonObject?, pending: Map<String, Boolean>): List<ShareLayerRow> {
        val include = (link?.obj("include") ?: JsonObject(emptyMap())).mapValues { (it.value as? JsonPrimitive)?.booleanOrNull } + pending
        fun on(layer: String) = include[layer] != false
        val transcripts = counts?.let { SharePanelCopy.countOf(it.number("transcripts") ?: 0, "transcript") }
        return when (kind) {
            ShareRootKind.TASK -> listOf(
                ShareLayerRow(null, "Overview", "Description, acceptance, dependencies and runs", counts?.let { SharePanelCopy.always }, true, false, false, false),
                ShareLayerRow("commentsAndFiles", "Comments & files", "Written by agents and people", counts?.let(::commentsAndFiles), on("commentsAndFiles"), false, false, false),
                ShareLayerRow("conversations", "Conversations", SharePanelCopy.conversationsRisk, transcripts, on("conversations"), false, false, on("conversations")),
            )
            ShareRootKind.PROJECT -> {
                val pages = on("taskPages")
                val runs = counts?.number("runs") ?: 0
                val coordinator = if ((counts?.number("transcripts") ?: 0) > runs) " and the coordinator" else ""
                listOf(
                    ShareLayerRow(null, "Overview", "Goal, work overview, acceptance criteria and task graph", counts?.let { SharePanelCopy.always }, true, false, false, false),
                    ShareLayerRow("taskPages", "Task pages", "Description, acceptance and runs for each task", counts?.let { SharePanelCopy.countOf(it.number("tasks") ?: 0, "task") }, pages, false, false, false),
                    ShareLayerRow("commentsAndFiles", "Comments & files", "Written by agents and people", counts?.let(::commentsAndFiles), on("commentsAndFiles"), true, !pages, false),
                    ShareLayerRow("conversations", "Conversations", if (counts == null) SharePanelCopy.conversationsRisk
                        else "${SharePanelCopy.countOf(runs, "run")}$coordinator. ${SharePanelCopy.conversationsRisk}", transcripts,
                        on("conversations"), true, !pages, on("conversations") && pages),
                )
            }
        }
    }
    /** Never clears the expiry; a duration counts from now. */
    fun expiryRequest(value: String, now: Instant = Instant.now()): JsonObject? {
        val days = when (value) { "never" -> 0L; "1" -> 1L; "7" -> 7L; "30" -> 30L; else -> return null }
        return buildJsonObject { put("expiresAt", if (days == 0L) JsonNull else JsonPrimitive(DateTimeFormatter.ISO_INSTANT.format(now.plus(Duration.ofDays(days))))) }
    }
}

/** The Share panel for one task or project: Access, the public link, Includes, Updates/Expires and views. */
@Composable
fun ShareSheet(app: OrbitApplication, handle: SessionHandle, kind: ShareRootKind, rootId: String, close: () -> Unit, changed: (JsonObject) -> Unit = {}) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val live by app.realtime.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val connected = writable(live, handle, (auth as? AuthState.SignedIn)?.handle)
    val path = listOf(kind.segment, rootId, "share")
    var read by remember(rootId) { mutableStateOf<JsonObject?>(null) }
    var failure by remember(rootId) { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<Map<String, Boolean>>(emptyMap()) }
    var expiryChoice by remember { mutableStateOf<String?>(null) }
    var confirmOff by remember { mutableStateOf(false) }
    var copied by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(rootId, attempt) {
        failure = null
        try { read = Wire.decode(app.session.request(handle, ApiRequest(path)).body, JsonObject.serializer()); read?.let(changed) }
        catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { failure = shareFailure(e) }
    }
    fun save(body: JsonObject?, method: HttpMethod = HttpMethod.PUT) {
        if (busy || !app.canWrite(handle)) return
        busy = true; error = null
        scope.launch {
            try {
                val response = app.session.request(handle, ApiRequest(path, method, body = body?.toString()?.encodeToByteArray()))
                val link = if (method == HttpMethod.DELETE) null else Wire.decode(response.body, JsonObject.serializer())
                read = buildJsonObject { put("link", link ?: JsonNull); read?.obj("counts")?.let { put("counts", it) } }
                if (method == HttpMethod.DELETE) { expiryChoice = null; copied = false }
                pending = emptyMap(); read?.let(changed)
            } catch (cancel: CancellationException) { throw cancel }
            catch (e: Exception) { pending = emptyMap(); expiryChoice = null; error = shareFailure(e) }
            finally { busy = false }
        }
    }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth(0.94f).testTag("share-sheet"), shape = MaterialTheme.shapes.large) {
            Column(Modifier.padding(20.dp).heightIn(max = 680.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(SharePanelCopy.title(kind), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = close) { Text(SharePanelCopy.done) }
                }
                val current = read
                when {
                    failure != null -> { Text("${SharePanelCopy.couldNotLoad} $failure"); TextButton(onClick = { attempt++ }) { Text(SharePanelCopy.retry) } }
                    current == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
                    else -> {
                        val link = SharePanel.open(current)
                        Text(SharePanelCopy.access, style = MaterialTheme.typography.titleSmall)
                        listOf(false to SharePanelCopy.onlyYou, true to SharePanelCopy.anyoneWithTheLink).forEach { (public, label) ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                RadioButton((link != null) == public, enabled = connected && !busy, onClick = {
                                    if (public && link == null) save(buildJsonObject { })
                                    else if (!public && link != null) confirmOff = true
                                })
                                Text(label)
                            }
                        }
                        Text(if (link == null) SharePanelCopy.privateDetail else SharePanelCopy.publicDetail, style = MaterialTheme.typography.bodySmall)
                        if (link != null) SharePanel.publicUrl(app.session.let { handle.account.server }, link)?.let { url ->
                            Text(url, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                TextButton(onClick = { clipboard.setText(AnnotatedString(url)); copied = true }) { Text(if (copied) SharePanelCopy.copied else SharePanelCopy.copyLink) }
                                TextButton(onClick = {
                                    runCatching { context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url), null)) }
                                }) { Text(SharePanelCopy.shareLink) }
                            }
                            Text(SharePanelCopy.includes, style = MaterialTheme.typography.titleSmall)
                            SharePanel.layers(kind, link, current.obj("counts"), pending).forEach { row ->
                                Row(Modifier.padding(start = if (row.nested) 16.dp else 0.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(row.name)
                                        Text(row.detail, style = MaterialTheme.typography.bodySmall,
                                            color = if (row.warns) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurfaceVariant)
                                        row.count?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                    }
                                    Switch(row.on, { on -> row.layer?.let { layer -> pending = pending + (layer to on)
                                        save(buildJsonObject { putJsonObject("include") { put(layer, on) } }) } },
                                        enabled = row.editable && connected && !busy)
                                }
                            }
                            Text(SharePanelCopy.updates, style = MaterialTheme.typography.titleSmall)
                            Text("● ${SharePanelCopy.live}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            val expires = link.text("expiresAt")
                            val selection = expiryChoice ?: if (expires != null) "until" else "never"
                            Text(SharePanelCopy.expires, style = MaterialTheme.typography.titleSmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                (SharePanel.expiryChoices + listOfNotNull(if (selection == "until") expires?.let(SharePanelCopy::shortDate)?.let { "until" to "Until $it" } else null)).forEach { (value, label) ->
                                    FilterChip(selection == value, { SharePanel.expiryRequest(value)?.let { expiryChoice = value; save(it) } }, label = { Text(label) },
                                        enabled = connected && !busy)
                                }
                            }
                            if (expires != null && selection != "until") SharePanelCopy.shortDate(expires)?.let { Text("Stops working $it", style = MaterialTheme.typography.bodySmall) }
                            Text(SharePanelCopy.viewsLine(link.number("viewCount") ?: 0, link.text("lastViewedAt")), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
    if (confirmOff) AlertDialog(onDismissRequest = { confirmOff = false }, title = { Text(SharePanelCopy.turnOffTitle) }, text = { Text(SharePanelCopy.turnOffDetail) },
        confirmButton = { TextButton(onClick = { confirmOff = false; save(null, HttpMethod.DELETE) }, enabled = connected) { Text(SharePanelCopy.turnOff, color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { confirmOff = false }) { Text(SharePanelCopy.cancel) } })
}

/** The server's own sentence when it wrote one (`APIClient.failureReason`). */
fun shareFailure(error: Throwable): String = when {
    error is ApiError && error.messages.isNotEmpty() -> error.messages.first()
    error is ApiError -> "Request failed (HTTP ${error.status})"
    error is FeatureWriteRefused -> error.message.orEmpty()
    else -> "Request failed — check your connection."
}
