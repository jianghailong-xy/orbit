package io.orbitd.android.reader

import android.content.Context
import android.provider.Settings
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.R
import io.orbitd.android.core.cards.BackgroundRow
import io.orbitd.android.core.cards.BgJob
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.tasks.TaskTime
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.watch.WatchIcons
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject

/** The Background row's reading of the session, and how its names move (board v2, project 34yq7HVPsPDGBiMEm8sL2; iOS `BackgroundTrayView`). */
internal object BackgroundTrayLogic {
    /** How one name gives way to the next: pushed up from below, or — with animations removed — a crossfade in place. */
    enum class Change { PUSH, CROSSFADE }

    fun change(animationsRemoved: Boolean) = if (animationsRemoved) Change.CROSSFADE else Change.PUSH

    /** Developer options' Remove animations (and the accessibility setting that writes it): the animator duration scale is 0. */
    fun animationsRemoved(context: Context): Boolean =
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

    /** The names stop while the list is open, while the app is not in front and while the band is folded away. */
    fun paused(open: Boolean, foreground: Boolean, folded: Boolean) = open || !foreground || folded

    /** Whether the session's run is not over: a session that is not live has nothing running, whatever its list last said. */
    fun sessionLive(detail: JsonObject?): Boolean =
        (detail?.text("runStatus") ?: detail?.text("status")) !in setOf("SUCCEEDED", "FAILED", "CANCELLED")

    /**
     * When the person last sent a message: the newest user turn somebody typed (OrbitKit `BackgroundRowRule.lastUserMessageAt`). A
     * turn Orbit opened — a wake, a job's news, a task's start, a card — is nobody's message and clears nothing.
     */
    fun lastUserMessageAt(events: List<RunEvent>): String? = events.lastOrNull { e ->
        e.type == "user" && e.ts != null && transcriptCards(e).let { cards -> StickySummary.isAnchor(e, cards) && !StickySummary.isOrbits(cards) }
    }?.ts

    /**
     * When the agent's latest turn started (web `lastAgentTurnStartedAt`): the earliest event of the turn the newest non-user event
     * belongs to, so a wake's turn counts from its recorded note. Null while no agent event carries a turn.
     */
    fun lastAgentTurnStartedAt(events: List<RunEvent>): String? {
        val turnId = events.lastOrNull { it.type != "user" && it.turnId != null && it.ts != null }?.turnId ?: return null
        return events.filter { it.turnId == turnId && it.ts != null }
            .minByOrNull { runCatching { java.time.Instant.parse(it.ts!!) }.getOrDefault(java.time.Instant.MAX) }?.ts
    }

    /** The open list's header count (iOS `countText`): "N running · N total". */
    fun countText(procs: List<JsonObject>, sessionLive: Boolean): String {
        val running = procs.count { status(it, sessionLive) == "running" }
        return (if (running > 0) "$running running · " else "") + "${procs.size} total"
    }

    /** A row's status in the list: a running one on a session that is no longer live is stale, so unknown. */
    fun status(proc: JsonObject, sessionLive: Boolean): String {
        val status = proc.text("status") ?: "unknown"
        return if (status == "running" && !sessionLive) "unknown" else status
    }

    /** Whether a row takes Stop (R3): a bg_run job still running on a live session, which the list marks stoppable. */
    fun stoppable(proc: JsonObject, sessionLive: Boolean): Boolean =
        proc.text("kind") == "job" && status(proc, sessionLive) == "running" && proc["stoppable"] == kotlinx.serialization.json.JsonPrimitive(true)

    /** A list row's name: its description, else its command (iOS `BackgroundRow`). */
    fun name(proc: JsonObject): String =
        proc.text("description")?.takeIf { it.isNotBlank() } ?: proc.text("command")?.takeIf { it.isNotBlank() } ?: "Background process"

    /** Agents and workflows wear a small kind label; a shell and a bg_run job are drawn alike. */
    fun kindLabel(proc: JsonObject): String? = when (proc.text("kind")) { "agent" -> "Agent"; "workflow" -> "Workflow"; else -> null }

    /** What the folded row shows now and how its names change, for tests: the screen reader reads neither. */
    val ShownName = SemanticsPropertyKey<String>("BackgroundShownName")
    val NameChange = SemanticsPropertyKey<Change>("BackgroundNameChange")

    const val TITLE = "Background processes"
    const val NO_OUTPUT = "No output captured yet — either the process hasn't written any, or the agent hasn't read its .output file."
}

/**
 * The session's background processes in the composer band, between Watching and Tasks (iOS `BackgroundTrayView`, board v2). Folded
 * it is the row the shared rule draws ([BackgroundRow]): "Background", the name in the tint and its mark, several running names
 * rotating newest first, and the count; nothing at all when the rule shows nothing. Tapped open it is the list — "Background
 * processes · N running · N total", each row (status · name · age) opening to that process's output tail.
 */
@Composable
internal fun BackgroundTray(procs: List<JsonObject>, clearedAt: String?, sessionLive: Boolean, folded: Boolean = false,
    jumpToJob: (String) -> (() -> Unit)? = { null }) {
    val row = remember(procs, clearedAt, sessionLive) { BackgroundRow.rowOf(procs, clearedAt, sessionLive) } ?: return
    var open by rememberSaveable { mutableStateOf(false) }
    // Which rotating name shows: kept here, above the folded row, so a pause holds it and it goes on from there.
    val names = (row.name as? BackgroundRow.Name.Rotate)?.items?.takeIf { it.size > 1 }
    val ids = names?.map { it.id }.orEmpty()
    // A new set of running names starts again from the newest.
    var turn by remember(ids) { mutableIntStateOf(0) }
    val paused = BackgroundTrayLogic.paused(open, rememberForeground(), folded)
    LaunchedEffect(ids, paused) {
        if (names == null || paused) return@LaunchedEffect
        while (true) {
            delay(BackgroundRow.ROTATE_PER_NAME_MS.toLong())
            turn = (turn + 1) % names.size
        }
    }
    val item = when (val name = row.name) {
        is BackgroundRow.Name.One -> name.item
        is BackgroundRow.Name.Rotate -> name.items[turn % name.items.size]
    }
    val shape = RoundedCornerShape(8.dp)
    val accent = MaterialTheme.colorScheme.primary
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp).clip(shape)
        .background(accent.copy(alpha = 0.04f)).border(1.dp, accent.copy(alpha = 0.10f), shape).testTag("background-tray")) {
        if (open) {
            OpenHeader(procs, sessionLive) { open = false }
            HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            Column(Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()).testTag("background-tray:list")) {
                var expanded by rememberSaveable { mutableStateOf<String?>(null) }
                procs.forEachIndexed { index, proc ->
                    val id = proc.text("shellId").orEmpty()
                    if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
                    // A bg_run job's row goes to its Job card, as the Agents list goes to a run's block (R1); one whose card is not
                    // drawn opens to its output as any row does.
                    val jump = if (proc.text("kind") == "job") jumpToJob(id) else null
                    ProcRow(proc, sessionLive, expanded == id) {
                        if (jump != null) { open = false; jump() } else expanded = if (expanded == id) null else id
                    }
                }
            }
        } else {
            FoldedRow(row, item) { open = true }
        }
    }
}

/** Whether the app is in front: its lifecycle at least started. */
@Composable
private fun rememberForeground(): Boolean {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    return foreground
}

@Composable
private fun FoldedRow(row: BackgroundRow.Row, item: BackgroundRow.Item, open: () -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val change = BackgroundTrayLogic.change(BackgroundTrayLogic.animationsRemoved(LocalContext.current))
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open)
        // The screen reader reads the row's own label, never a name that changes every 3 s.
        .clearAndSetSemantics {
            contentDescription = row.accessibilityLabel; role = Role.Button; onClick { open(); true }
            set(SemanticsProperties.TestTag, "background-tray:row"); set(BackgroundTrayLogic.ShownName, item.name); set(BackgroundTrayLogic.NameChange, change)
        }
        .heightIn(min = 48.dp).padding(horizontal = 10.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(R.drawable.ic_terminal), null, Modifier.size(14.dp), tint = secondary)
        Text(row.label, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
        val ms = BackgroundRow.ROTATE_CHANGE_MS
        AnimatedContent(item, Modifier.weight(1f).clipToBounds(),
            transitionSpec = {
                when (change) {
                    BackgroundTrayLogic.Change.CROSSFADE -> fadeIn(tween(ms)) togetherWith fadeOut(tween(ms))
                    BackgroundTrayLogic.Change.PUSH -> (slideInVertically(tween(ms)) { it } + fadeIn(tween(ms))) togetherWith
                        (slideOutVertically(tween(ms)) { -it } + fadeOut(tween(ms)))
                }
            }, contentKey = { it.id }, label = "background-name") { shown ->
            Text(shown.name, Modifier.fillMaxWidth(), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary, maxLines = 1,
                overflow = if (shown.truncate == BackgroundRow.Truncate.MIDDLE) TextOverflow.MiddleEllipsis else TextOverflow.Ellipsis)
        }
        // The count, then the mark, at the right edge before the chevron, as the web and Apple Agents rows end.
        if (row.countParts.isNotEmpty()) Text(buildAnnotatedString {
            row.countParts.forEachIndexed { i, part ->
                if (i > 0) withStyle(SpanStyle(color = secondary)) { append(" · ") }
                withStyle(SpanStyle(color = secondary)) { append(part.text) }
            }
        }, style = MaterialTheme.typography.labelSmall, maxLines = 1)
        Mark(item.mark)
        Icon(WatchIcons.chevronRight, null, Modifier.size(14.dp), tint = secondary)
    }
}

/** The folded row's mark: the list row's own spinner and icons. The spinner is drawn as iOS draws it (`SpinnerGlyph`: 13pt, a
 * 2pt stroke, the accent), the app's running mark, not a quieter grey of its own. */
@Composable
private fun Mark(mark: BackgroundRow.Mark) = StatusIcon(mark.name.lowercase())

@Composable
private fun StatusIcon(status: String) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Box(Modifier.size(18.dp).testTag("background-status:$status"), contentAlignment = Alignment.Center) {
        when (status) {
            "running" -> CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.primary)
            "done" -> Icon(painterResource(R.drawable.ic_check_circle), null, Modifier.size(14.dp), tint = LocalOrbitColors.current.success)
            "failed" -> Icon(painterResource(R.drawable.ic_x_circle), null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.error)
            "killed" -> Icon(painterResource(R.drawable.ic_stop), null, Modifier.size(14.dp), tint = secondary)
            else -> Icon(painterResource(R.drawable.ic_remove_circle), null, Modifier.size(14.dp), tint = secondary)
        }
    }
}

@Composable
private fun OpenHeader(procs: List<JsonObject>, sessionLive: Boolean, close: () -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Hide background processes", onClick = close)
        .heightIn(min = 48.dp).padding(horizontal = 10.dp, vertical = 3.dp).testTag("background-tray:header"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(R.drawable.ic_terminal), null, Modifier.size(14.dp), tint = secondary)
        Text(BackgroundTrayLogic.TITLE, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold), maxLines = 1)
        Text(BackgroundTrayLogic.countText(procs, sessionLive), Modifier.weight(1f), style = MaterialTheme.typography.labelSmall,
            color = secondary, maxLines = 1)
        Icon(WatchIcons.chevronDown, null, Modifier.size(14.dp), tint = secondary)
    }
}

/** One process: status · name · age, opening to its command (when a description names it) and its output tail. */
@Composable
private fun ProcRow(proc: JsonObject, sessionLive: Boolean, expanded: Boolean, toggle: () -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val id = proc.text("shellId").orEmpty()
    var confirming by remember { mutableStateOf(false) }
    if (confirming) StopJobDialog(id) { confirming = false }
    Column(Modifier.fillMaxWidth().testTag("background-proc:$id")) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = if (expanded) "Hides the output" else "Shows the output", onClick = toggle)
            .heightIn(min = 48.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusIcon(BackgroundTrayLogic.status(proc, sessionLive))
            BackgroundTrayLogic.kindLabel(proc)?.let {
                Text(it, Modifier.background(secondary.copy(alpha = 0.14f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = secondary, maxLines = 1)
            }
            Text(BackgroundTrayLogic.name(proc), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            proc.text("startedTs")?.let { TaskTime.relative(it) }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1)
            }
            // A running bg_run job its runner can stop (R3): Stop, behind the Job card's own confirmation.
            if (BackgroundTrayLogic.stoppable(proc, sessionLive) && LocalJobCards.current.stop != null) {
                TextButton(onClick = { confirming = true }, Modifier.testTag("background-proc:$id:stop")) {
                    Text(BgJob.stop, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                }
            }
            Icon(if (expanded) WatchIcons.chevronDown else WatchIcons.chevronRight, null, Modifier.size(12.dp), tint = secondary.copy(alpha = 0.6f))
        }
        if (expanded) Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp).testTag("background-proc:$id:output"),
            verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val command = proc.text("command")?.takeIf { it.isNotBlank() }
            if (!proc.text("description").isNullOrBlank() && command != null) Text("$ $command", style = MaterialTheme.typography.labelSmall
                .copy(fontFamily = FontFamily.Monospace), color = secondary)
            val tail = proc.text("latestOutput").orEmpty()
            if (tail.isEmpty()) Text(BackgroundTrayLogic.NO_OUTPUT, style = MaterialTheme.typography.labelSmall, color = secondary)
            else Text(tail.lines().takeLast(16).joinToString("\n"), Modifier.fillMaxWidth()
                .background(secondary.copy(alpha = 0.08f), RoundedCornerShape(6.dp)).padding(horizontal = 9.dp, vertical = 6.dp),
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace))
        }
    }
}
