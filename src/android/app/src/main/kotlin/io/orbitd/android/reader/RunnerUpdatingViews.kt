package io.orbitd.android.reader

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import io.orbitd.android.directory.QueuedCapacity
import io.orbitd.android.directory.QueuedClone
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import io.orbitd.android.directory.QueuedDiskLow
import io.orbitd.android.directory.QueuedGate
import io.orbitd.android.directory.RunningOverLimit
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import kotlinx.coroutines.launch
import io.orbitd.android.directory.RunnerUpdating
import io.orbitd.android.directory.RunnerUpdatingPart
import java.time.Instant
import kotlinx.coroutines.delay

private const val CANCEL = "Cancel"
private const val RUNNING = "Running"

/** A clock that moves every 30 seconds, for the waits counted in minutes (web `useMinuteNow`). */
@Composable
internal fun rememberMinuteNow(): Instant {
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = Instant.now() } }
    return now
}

/**
 * The queued page of a session held by its runner's update (board 2 ②–③, board 5's phone; web `RunnerUpdatingQueued`): why, with the
 * turns it waits for as links, and how long it has waited, centred; then [later], Later… and Update Now… for the session's runner.
 */
@Composable
internal fun RunnerUpdatingQueued(gate: QueuedGate, machine: String?, openSession: (String) -> Unit, modifier: Modifier = Modifier,
    now: Instant = rememberMinuteNow(), later: (@Composable () -> Unit)? = null) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val link = MaterialTheme.colorScheme.primary
    val parts = remember(gate, machine) { RunnerUpdating.runnerUpdatingDescription(gate, machine) }
    val waited = RunnerUpdating.runnerUpdatingWaited(gate, now)
    Column(modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp).testTag("runner-updating"),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(RunnerUpdating.runnerUpdatingTitle(gate), Modifier.testTag("runner-updating:title"), style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        val open by rememberUpdatedState(openSession)
        val text = remember(parts, link) { buildAnnotatedString {
            parts.forEach { part -> when (part) {
                is RunnerUpdatingPart.Words -> append(part.text)
                is RunnerUpdatingPart.Session ->
                    withLink(LinkAnnotation.Clickable(part.id, TextLinkStyles(SpanStyle(color = link))) { open(part.id) }) { append(part.title) }
            } }
        } }
        Text(text, Modifier.testTag("runner-updating:description"), style = MaterialTheme.typography.bodyMedium, color = secondary,
            textAlign = TextAlign.Center)
        waited?.let { Text(it, Modifier.testTag("runner-updating:waited"), style = MaterialTheme.typography.bodySmall, color = secondary) }
        later?.let { Column(Modifier.padding(top = 8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) { it() } }
    }
}

/**
 * The foot row under the message the update holds (board 2 ⑤; web `RunnerUpdatingTag`): `Queued · runner updating`, in the meta
 * voice, the reason dotted-underlined because a press opens why — the update's account and, on its own line, how long it has waited.
 * A full runner, run or batch is drawn the same way in [QueuedCapacity]'s words, `Queued · runner full` (web `CapacityHeldTag`,
 * docs/mocks/queued-card-runner-full), its popover ending in [runNow] where the session can be started over the limit. A new session
 * Keep Free holds reads `Queued · low disk space` ([QueuedDiskLow]), with nothing to press. With [cancel] — under an accepted message no runner has taken yet
 * ([cancellableHeldTurn]) — the row ends ` · Cancel`, which takes the message back (web `HeldFoot`).
 */
@Composable
internal fun RunnerUpdatingFoot(gate: QueuedGate, machine: String?, modifier: Modifier = Modifier, now: Instant = rememberMinuteNow(),
    later: (@Composable () -> Unit)? = null, cancel: (() -> Unit)? = null, runNow: (@Composable () -> Unit)? = null) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.labelSmall
    var open by remember { mutableStateOf(false) }
    val full = QueuedCapacity.isCapacityHeld(gate)
    val disk = QueuedDiskLow.isDiskHeld(gate)
    Row(modifier.testTag("runner-updating-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(RunnerUpdating.QUEUED, style = style, color = secondary)
        Text("·", style = style, color = secondary)
        Text(if (disk) QueuedDiskLow.TAG else if (full) QueuedCapacity.tag(gate) else RunnerUpdating.runnerUpdatingTag(gate), Modifier.clickable(role = Role.Button) { open = true }
            .drawBehind {
                val y = size.height - 1.dp.toPx()
                drawLine(secondary, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx(),
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 2.dp.toPx())))
            }.testTag("runner-updating-foot:reason"), style = style, color = secondary)
        if (cancel != null) {
            Text("·", style = style, color = secondary)
            Text(CANCEL, Modifier.clickable(role = Role.Button, onClick = cancel).testTag("runner-updating-foot:cancel"), style = style,
                color = MaterialTheme.colorScheme.primary)
        }
    }
    if (open) Dialog({ open = false }) {
        Surface(shape = RoundedCornerShape(14.dp), tonalElevation = 6.dp, modifier = Modifier.widthIn(max = 320.dp).testTag("runner-updating-pop")) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (disk) QueuedDiskLow.TITLE else if (full) QueuedCapacity.title(gate) else RunnerUpdating.runnerUpdatingTitle(gate),
                    style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                // Keep Free's wait counts from when the session went PENDING, as a full runner's does.
                val waited = if (full || disk) QueuedCapacity.waited(gate, now) else RunnerUpdating.runnerUpdatingWaited(gate, now)
                val said = if (disk) QueuedDiskLow.WAIT
                    else if (full) QueuedCapacity.messageText(gate, machine) else RunnerUpdating.runnerUpdatingMessageText(gate, machine)
                Text(said + (waited?.let { "\n$it." } ?: ""),
                    Modifier.testTag("runner-updating-pop:text"), style = MaterialTheme.typography.bodyMedium)
                if (full) runNow?.invoke() else if (!disk) later?.invoke()
            }
        }
    }
}

/**
 * Run now in a full runner's, run's or batch's popover (docs/mocks/queued-run-now ① and ③; web `CapacityHeldTag`): the button, and
 * under it what pressing does, or the server's sentence beside a disabled one. Nothing where [QueuedCapacity.runNowNote] has none.
 */
@Composable
internal fun RunNowAction(gate: QueuedGate, machine: String?, runnerActive: Int?, runnerLimit: Int?, pending: Boolean, press: () -> Unit) {
    val note = QueuedCapacity.runNowNote(gate, machine, runnerActive, runnerLimit) ?: return
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Button(press, Modifier.align(Alignment.End).testTag("run-now"),
            enabled = !pending && gate.runNowAvailable && gate.runNowRefusal.isNullOrEmpty()) {
            if (pending) CircularProgressIndicator(Modifier.padding(end = 8.dp).size(16.dp), strokeWidth = 2.dp)
            Text(QueuedCapacity.RUN_NOW)
        }
        Text(note, Modifier.testTag("run-now:note"), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** The seq of the message that opened the turn still running: the last one sent that was not a steer, null once a `turn_end` follows
 *  it (web `lastUserEventSeq(events, true)`). */
internal fun openTurnUserSeq(events: List<RunEvent>): Long? {
    for (event in events.asReversed()) {
        if (event.type == "turn_end") return null
        if (event.type == "user" && (event.fields["steer"] as? JsonPrimitive)?.booleanOrNull != true) return event.seq
    }
    return null
}

/**
 * Under the message whose turn was started over its runner's limit, while it runs (board ②; web `RunningOverLimitFoot`):
 * `Running` and an amber `over limit · 17/16`, which a press explains.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RunningOverLimitFoot(overflow: RunningOverLimit, modifier: Modifier = Modifier) {
    val style = MaterialTheme.typography.labelSmall
    // The web's --warning, --warning-bg and --warning-border.
    val light = MaterialTheme.colorScheme.surface.luminance() > 0.5f
    val ink = if (light) Color(0xFFC2710C) else Color(0xFFE0A23B)
    val fill = if (light) Color(0xFFFFF4E6) else Color(0x26FA8C16)
    val edge = if (light) Color(0xFFFFD591) else Color(0x61FA8C16)
    val hint = rememberTooltipState(isPersistent = true)
    val scope = rememberCoroutineScope()
    Row(modifier.testTag("over-limit-foot"), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(RUNNING, style = style, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TooltipBox(TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
            tooltip = { PlainTooltip { Text(QueuedCapacity.overLimitHint(overflow), Modifier.testTag("over-limit:hint")) } }, state = hint) {
            Text(QueuedCapacity.overLimitTag(overflow), Modifier.clickable(role = Role.Button) { scope.launch { hint.show() } }
                .background(fill, RoundedCornerShape(5.dp)).border(1.dp, edge, RoundedCornerShape(5.dp))
                .padding(horizontal = 6.dp, vertical = 2.dp).testTag("over-limit"), style = style, color = ink)
        }
    }
}

/**
 * The waiting card of a session held by its workspace's clone (web `CloneWaitNotice`, board docs/mocks/clone-progress-wait-card ②):
 * what is cloning, git's percentage once it has said one, and where. [clone] is null for a failed clone, which says its two plain
 * sentences. [compact] is the card under a transcript: the same centred card, with a spinner while no percentage is heard.
 */
@Composable
internal fun CloneWaitNotice(clone: QueuedClone.Wait?, failed: Boolean, machine: String?, compact: Boolean, modifier: Modifier = Modifier) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val title = when {
        clone != null -> QueuedClone.waitTitle(clone.state, clone.repository)
        failed -> QueuedClone.FAILED_TITLE
        else -> QueuedClone.TITLE
    }
    // Both cards are centred, as web and iOS draw them.
    val align = Alignment.CenterHorizontally
    val pad = if (compact) Modifier.padding(horizontal = 16.dp, vertical = 14.dp) else Modifier.padding(horizontal = 24.dp, vertical = 32.dp)
    Column(modifier.fillMaxWidth().then(pad).testTag("clone-wait"), horizontalAlignment = align, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            // The full-height card's own dots already say it is waiting; the compact one has none, so it spins until a percentage is heard.
            if (compact && clone != null && clone.progress == null) CloneSpinner(Modifier.testTag("clone-wait:spinner"))
            Text(title, Modifier.testTag("clone-wait:title"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center)
        }
        clone?.progress?.let { progress ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                LinearProgressIndicator(progress = { progress / 100f },
                    modifier = Modifier.width(220.dp).height(4.dp).semantics { contentDescription = title }.testTag("clone-wait:bar"),
                    drawStopIndicator = {}, gapSize = 0.dp)
                Text("$progress%", Modifier.testTag("clone-wait:percent"), style = MaterialTheme.typography.bodyMedium, color = secondary)
            }
        }
        val where = machine?.takeIf { clone != null }
        Text(
            when {
                clone == null && failed -> QueuedClone.FAILED_WAIT
                where != null -> "On $where. ${QueuedClone.STARTS}"
                else -> QueuedClone.STARTS
            },
            Modifier.testTag("clone-wait:description"), style = MaterialTheme.typography.bodyMedium, color = secondary,
            textAlign = TextAlign.Center)
    }
}

/** A turning three-quarter ring the size of the card's title: drawn in full at every moment, where the indeterminate indicator's arc passes through a sliver. */
@Composable
private fun CloneSpinner(modifier: Modifier = Modifier) {
    val angle by rememberInfiniteTransition(label = "clone-spin").animateFloat(0f, 360f,
        infiniteRepeatable(tween(1_000, easing = LinearEasing)), label = "clone-spin")
    val color = MaterialTheme.colorScheme.primary
    Canvas(modifier.size(20.dp)) {
        val stroke = 2.dp.toPx()
        drawArc(color, startAngle = angle, sweepAngle = 270f, useCenter = false, topLeft = Offset(stroke / 2, stroke / 2),
            size = Size(size.width - stroke, size.height - stroke), style = Stroke(stroke, cap = StrokeCap.Round))
    }
}
