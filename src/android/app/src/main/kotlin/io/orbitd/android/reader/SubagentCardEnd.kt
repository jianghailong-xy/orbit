package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.cards.Disclosure
import io.orbitd.android.core.cards.BackgroundWakeCard
import io.orbitd.android.core.cards.SubagentFinished
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.text.markdownInline
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.Json
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * How a background SubAgent's card ends (board docs/mocks/subagent-card-and-end-line, approved 2026-11-20; web `SubagentCardEnd.tsx`,
 * word for word). Like Claude Code's built-in Agent, a SubAgent is one card from start to end: when its run ends, the card's row turns
 * into the end and the line under it into the ending. The turn the control plane opened for the end (`<orbit-subagent-finished>`) draws
 * nothing: the agent still reads that block unchanged, and the card keeps it under `What the agent read`.
 */
internal object SubagentEnd {
    enum class Tone { OK, FAILED, STOPPED }

    val ENDS = setOf("DONE", "FAILED", "INTERRUPTED", "STOPPED")

    /**
     * Why a run ended, said to the reader. The control plane's block says it to the agent in one fixed sentence per end (apiserver
     * `ENDED_BECAUSE`), so the card needs nothing but the run's status to say it — even where the block was never loaded, or never sent.
     */
    val because = mapOf(
        "INTERRUPTED" to "The runner hosting it stopped (a restart, an update or a crash) before it finished.",
        "FAILED" to "It did not finish its work.",
        "STOPPED" to "Stopped by the agent.",
    )

    const val showFiles = "Show files"
    const val waiting = "Waiting for the agent to read it ·"
    const val dontSend = "Don't send"
    const val whatTheAgentRead = "What the agent read"

    /** How many of the files an opened end lists before the reader asks for the rest. */
    const val FILES_SHOWN = 3

    /** A run whose end the card draws: a background one that has ended. A foreground call is its own end. */
    fun ended(run: SubagentRun?): SubagentRun? = run?.takeIf { it.background && it.status in ENDS }

    /** Red for a run that did not finish; grey for one somebody stopped, which is no failure. */
    fun tone(status: String): Tone = when (status) { "DONE" -> Tone.OK; "STOPPED" -> Tone.STOPPED; else -> Tone.FAILED }

    /** The row's word chip: every end but DONE, lower-cased. */
    fun word(status: String): String? = status.takeIf { it != "DONE" }?.lowercase()

    fun fileCount(n: Int) = "$n ${if (n == 1) "file" else "files"} left uncommitted"

    /** `model-routing.ts · task-route-decision.ts · +7`: the first two files by name, and how many more. */
    fun names(files: List<String>): String {
        val first = files.take(2).map { path -> path.substring(path.lastIndexOf('/') + 1).ifEmpty { path } }
        return (first + listOfNotNull("+${files.size - first.size}".takeIf { files.size > first.size })).joinToString(" · ")
    }

    /** The opened end's first line: `Interrupted 10m ago: the runner hosting it stopped …`, `Stopped 10m ago by the agent.`; none for DONE. */
    fun head(run: SubagentRun, now: Instant = Instant.now()): String? {
        val whenText = run.endedAt?.let { BackgroundWakeCard.relative(it, now) }?.let { " $it" }.orEmpty()
        return when (tone(run.status)) {
            Tone.OK -> null
            Tone.STOPPED -> "Stopped$whenText by the agent."
            Tone.FAILED -> "${if (run.status == "FAILED") "Failed" else "Interrupted"}$whenText: ${because.getValue(run.status).replaceFirstChar { it.lowercase() }}"
        }
    }

    fun filesHead(n: Int) = "${fileCount(n)} in the working tree:"
    fun more(n: Int) = "… $n more"
    fun runLine(runId: String, readAt: String?) = "Run $runId" + readAt?.let { " · read by the agent at ${clock(it)}" }.orEmpty()

    private fun clock(iso: String): String = runCatching {
        DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(iso))
    }.getOrDefault(iso)

    /** The run a `delegate` call's result names (a foreground call's end or a background call's launch receipt; web `delegateRunId`). */
    fun runId(callResult: String?): String? = runCatching {
        (Json.parseToJsonElement(callResult!!.trim()) as? JsonObject)?.string("runId")?.ifEmpty { null }
    }.getOrNull()
}

/** What a SubAgent's end turn told the agent about one run, joined to its card by run id. */
internal data class SubagentWakeSeen(
    /** The `<orbit-subagent-finished>` block, exactly as the agent read it. */
    val text: String,
    /** When the agent read it; null while it was never confirmed delivered. */
    val readAt: String?,
)

/** The SubAgent end turns among [events], by run id: the block the agent read and, once delivered, when (web `subagentWakesOf`). */
internal fun subagentWakesOf(events: List<RunEvent>, deliveries: Map<String, String> = emptyMap()): Map<String, SubagentWakeSeen> = buildMap {
    events.forEach { event ->
        if (event.type != "user") return@forEach
        val wake = SubagentFinished.parse(event.fields.string("controlPlaneNote")) ?: return@forEach
        val delivery = event.turnId?.let(deliveries::get) ?: event.fields.string("delivery")
        val read = delivery != "failed" && delivery != "unconfirmed"
        wake.runs.forEach { put(it.runId, SubagentWakeSeen(wake.text, if (read) event.ts else null)) }
    }
}

/** The end turns loaded in this conversation, by run id. */
internal val LocalSubagentWakes = staticCompositionLocalOf<Map<String, SubagentWakeSeen>> { emptyMap() }

/** The end turns still on the queue, by run id: each one's `Don't send`, which takes it off the queue (null where it cannot be). */
internal val LocalSubagentQueuedWakes = staticCompositionLocalOf<Map<String, (() -> Unit)?>> { emptyMap() }

@Composable
private fun toneColor(tone: SubagentEnd.Tone): Color = when (tone) {
    SubagentEnd.Tone.OK -> LocalOrbitColors.current.success
    SubagentEnd.Tone.FAILED -> MaterialTheme.colorScheme.error
    SubagentEnd.Tone.STOPPED -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** The row's end: ✓ alone for DONE; a word chip and the mark for every other end — red ✕, or grey ■ for a stop. */
@Composable
internal fun SubagentEndStatus(status: String) {
    val tone = SubagentEnd.tone(status)
    val color = toneColor(tone)
    val word = SubagentEnd.word(status)
    if (word == null) {
        Icon(painterResource(R.drawable.ic_check_circle), "done", Modifier.size(16.dp).testTag("subagent-end-mark:done"), tint = color)
        return
    }
    Text(word, Modifier.background(color.copy(alpha = if (tone == SubagentEnd.Tone.FAILED) 0.12f else 0.1f), RoundedCornerShape(4.dp))
        .padding(horizontal = 5.dp, vertical = 1.dp).testTag("subagent-end-chip"),
        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = color, maxLines = 1)
    if (tone == SubagentEnd.Tone.STOPPED) {
        Box(Modifier.size(16.dp).background(color, CircleShape).semantics { contentDescription = word }.testTag("subagent-end-mark:$word"),
            contentAlignment = Alignment.Center) {
            Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.surface, RoundedCornerShape(1.dp)))
        }
    } else Icon(painterResource(R.drawable.ic_x_circle), word, Modifier.size(16.dp).testTag("subagent-end-mark:$word"), tint = color)
}

/** `9 files left uncommitted Show files model-routing.ts · task-route-decision.ts · +7` */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilesLine(files: List<String>, onShow: () -> Unit) {
    if (files.isEmpty()) return
    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    FlowRow(Modifier.testTag("subagent-ending-files"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(SubagentEnd.fileCount(files.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
        Text(SubagentEnd.showFiles, Modifier.clickable(role = Role.Button, onClick = onShow).testTag("subagent-show-files"),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        Text(SubagentEnd.names(files), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = grey,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * The folded card's ending, where the live line was while it ran: two lines of what a run that finished handed back, or why one did not,
 * once, and the files it left.
 */
@Composable
internal fun SubagentFoldedEnd(run: SubagentRun, modifier: Modifier = Modifier, onShowFiles: () -> Unit) {
    val tone = SubagentEnd.tone(run.status)
    if (tone == SubagentEnd.Tone.OK) {
        val summary = run.resultSummary?.ifEmpty { null } ?: return
        Text(markdownInline(summary), modifier.testTag("subagent-ending"), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
        return
    }
    Column(modifier.testTag("subagent-ending"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(SubagentEnd.because.getValue(run.status), Modifier.testTag("subagent-ending-reason"), style = MaterialTheme.typography.bodyMedium,
            color = toneColor(tone))
        FilesLine(run.changedFiles, onShowFiles)
    }
}

/** While the end turn waits on the queue: the agent has not read it yet, and it can still be kept back. */
@Composable
internal fun SubagentWakeQueued(modifier: Modifier = Modifier, onDontSend: (() -> Unit)?) {
    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    Row(modifier.testTag("subagent-queued"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (onDontSend != null) SubagentEnd.waiting else SubagentEnd.waiting.removeSuffix(" ·"), style = MaterialTheme.typography.bodySmall,
            color = grey)
        onDontSend?.let { dontSend ->
            Text(SubagentEnd.dontSend, Modifier.clickable(role = Role.Button, onClick = dontSend).testTag("subagent-dont-send"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}

/** The opened card's foot: how it ended and when, every file it left, what the agent read, and the run. */
@Composable
internal fun SubagentEndBlock(run: SubagentRun, runId: String?, wake: SubagentWakeSeen?) {
    val tone = SubagentEnd.tone(run.status)
    val color = toneColor(tone)
    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    var allFiles by rememberSaveable(run.toolUseId, "files") { mutableStateOf(false) }
    var raw by rememberSaveable(run.toolUseId, "raw") { mutableStateOf(false) }
    val files = run.changedFiles
    val shown = if (allFiles) files else files.take(SubagentEnd.FILES_SHOWN)
    val tint = if (tone == SubagentEnd.Tone.OK) grey else color
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).testTag("subagent-end:${tone.name.lowercase()}")
        .background(tint.copy(alpha = 0.06f), RoundedCornerShape(topEnd = 6.dp, bottomEnd = 6.dp))) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(tint.copy(alpha = 0.5f)))
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            SubagentEnd.head(run)?.let { Text(it, Modifier.testTag("subagent-end-head"), style = MaterialTheme.typography.bodyMedium, color = color) }
            if (files.isNotEmpty()) {
                Text(SubagentEnd.filesHead(files.size), Modifier.testTag("subagent-end-files-head"), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurface)
                Column(Modifier.testTag("subagent-end-files")) {
                    shown.forEach { Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = grey) }
                    if (shown.size < files.size) Text(SubagentEnd.more(files.size - shown.size),
                        Modifier.clickable(role = Role.Button) { allFiles = true }.testTag("subagent-end-more"),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
            }
            if (wake != null) {
                Disclosure(SubagentEnd.whatTheAgentRead, raw, "subagent-end-raw") { raw = !raw }
                if (raw) SelectionContainer {
                    Text(wake.text, Modifier.testTag("subagent-end-raw-text"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = grey)
                }
            }
            runId?.let { Text(SubagentEnd.runLine(it, wake?.readAt), Modifier.testTag("subagent-end-run"), style = MaterialTheme.typography.labelSmall, color = grey) }
        }
    }
}
