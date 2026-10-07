package io.orbitd.android.taskprojects

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.management.LiveSharePanel
import io.orbitd.android.management.ManagementApi
import kotlinx.serialization.json.JsonObject
import java.time.Duration
import java.time.Instant

/** OrbitKit `SharePanel`/`SharePanelCopy`: the ⋯ menu's words and the Share dialog of a task and a project (A05 owns the
 * session's). The panel inside is A13's `ShareResourcePanel`, the one every Share uses; the server's answer replaces each change. */
enum class ShareRootKind(val segment: String) { TASK("tasks"), PROJECT("projects") }

object SharePanelCopy {
    const val onlyYou = "Only you"
    const val copyLink = "Copy Link"
    const val share = "Share…"
    const val liveLink = "Live link"
    const val copyAsMarkdown = "Copy as Markdown"
    const val linkCopied = "Link copied"
    const val markdownCopied = "Markdown copied"
    const val done = "Done"
    fun title(kind: ShareRootKind) = if (kind == ShareRootKind.TASK) "Share task" else "Share project"
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

object SharePanel {
    /** The open link; one that has ended reads as no link at all. */
    fun open(read: JsonObject?): JsonObject? = read?.obj("link")?.takeIf { it.text("state") != "ENDED" }
    /** What a ⋯ menu's Share… says under itself; nothing before the read came back. */
    fun menuStatus(read: JsonObject?): String? = read?.let { if (open(it) == null) SharePanelCopy.onlyYou else SharePanelCopy.liveLink }
}

/** The Share dialog of one task or project. [changed] hears the server's answer to every read and change of its link. */
@Composable
fun ShareSheet(app: OrbitApplication, handle: SessionHandle, kind: ShareRootKind, rootId: String, close: () -> Unit, changed: (JsonObject) -> Unit = {}) {
    val api = remember(handle) { ManagementApi(app.session, handle, app.processScope) }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth(0.94f).testTag("share-sheet"), shape = MaterialTheme.shapes.large) {
            Column(Modifier.padding(20.dp).heightIn(max = 680.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(SharePanelCopy.title(kind), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    TextButton(onClick = close) { Text(SharePanelCopy.done) }
                }
                LiveSharePanel(api, kind.name, rootId, changed)
            }
        }
    }
}
