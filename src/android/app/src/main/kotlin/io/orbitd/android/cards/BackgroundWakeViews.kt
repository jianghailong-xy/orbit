package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject

/** Draws [wide] when it fits the width on one line, otherwise [narrow] (SwiftUI's `ViewThatFits(in: .horizontal)`). */
@Composable
internal fun FitsOrStack(modifier: Modifier = Modifier, wide: @Composable () -> Unit, narrow: @Composable () -> Unit) {
    SubcomposeLayout(modifier) { constraints ->
        val probe = subcompose("wide-probe", wide).map { it.measure(Constraints()) }
        val fits = probe.maxOfOrNull { it.width }.let { it == null || it <= constraints.maxWidth }
        val placeables = subcompose(if (fits) "wide" else "narrow", if (fits) wide else narrow).map { it.measure(constraints.copy(minHeight = 0)) }
        layout(placeables.maxOfOrNull { it.width } ?: 0, placeables.sumOf { it.height }) {
            var y = 0
            placeables.forEach { it.placeRelative(0, y); y += it.height }
        }
    }
}

/**
 * A turn the control plane opened because a wakeup came due (A08-11; iOS `BackgroundWakeCardView`): one line in the agent's stream — its
 * clock, "Scheduled wakeup", why it was asked for, when, and the details label — that opens to the rest. When it does not fit one line,
 * the name and the closing words each take a line under the title. A wake written into the running turn says how far it got. A
 * background job's end, new output or stall draws no line any more (board C1): the job is one card from start to end (reader
 * `JobCardView`), and [wake] holds only the wakeups that came due beside it ([io.orbitd.android.core.cards.BgJob.wakeupsOnly]).
 */
@Composable
internal fun BackgroundWakeLine(wake: JsonObject, ts: String?, steerState: String? = null, undelivered: Boolean = false,
    queued: Boolean = false, onCancelQueued: (() -> Unit)? = null) {
    var open by rememberSaveable(wake.toString()) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val label = MaterialTheme.typography.bodySmall
    val mark = @Composable { Icon(painterResource(R.drawable.ic_clock), null, Modifier.size(14.dp), tint = secondary) }
    val title = @Composable { Text(BackgroundWakeCard.title, style = label, color = secondary, maxLines = 1) }
    val name = BackgroundWakeCard.lineName(wake)
    val nameText = @Composable { modifier: Modifier ->
        name?.let { Text(it, modifier, style = label, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f), maxLines = 1,
            overflow = TextOverflow.Ellipsis) }
    }
    val closing = @Composable {
        ts?.let { BackgroundWakeCard.relative(it) }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1) }
        Text(BackgroundWakeCard.details, Modifier.testTag("wake-details-label"), style = MaterialTheme.typography.labelSmall,
            color = secondary, maxLines = 1)
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp).rotate(if (open) 90f else 0f), tint = secondary.copy(alpha = 0.6f))
    }
    Column(Modifier.fillMaxWidth().testTag("background-wake"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // Dashed while it is still queued, so the one line reads as two states rather than as two things.
        val dashed = if (queued) Modifier.dashedBorder(secondary.copy(alpha = 0.5f), 6.dp) else Modifier
        FitsOrStack(Modifier.fillMaxWidth().then(dashed).clickable(role = Role.Button) { open = !open }.padding(horizontal = 4.dp, vertical = 3.dp)
            .testTag("background-wake:line"),
            wide = {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    mark(); title(); nameText(Modifier); closing()
                }
            },
            narrow = {
                Column(Modifier.testTag("background-wake:narrow"), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { mark(); title() }
                    nameText(Modifier.padding(start = 20.dp))
                    Row(Modifier.padding(start = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { closing() }
                }
            })
        if (open) WakeFold(wake)
        if (undelivered) Text(BackgroundWakeCard.undelivered, Modifier.padding(start = 20.dp), style = MaterialTheme.typography.labelSmall,
            color = LocalOrbitColors.current.needsYou)
        steerState?.let { Text(it, Modifier.padding(start = 20.dp).testTag("background-wake:steer"), style = MaterialTheme.typography.labelSmall, color = secondary) }
        onCancelQueued?.let { cancel -> QueuedFoot(Modifier.padding(start = 20.dp), cancel) }
    }
}

/**
 * Provided on a queued-tail turn its runner's update holds (docs/mocks/queued-card-runner-updating ②⑤): the tag its queue line reads in
 * place of its word — `Queued · runner updating`, opening to why (reader `RunnerUpdatingFoot`). Null on every other turn.
 */
internal val LocalQueuedHeld = staticCompositionLocalOf<(@Composable () -> Unit)?> { null }

/** The word a queued turn's line opens with, or, where its runner's update holds it, the tag that says so ([LocalQueuedHeld]). */
@Composable
internal fun QueuedWord(label: String = "Queued", color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    val held = LocalQueuedHeld.current
    if (held != null) held() else Text(label, style = MaterialTheme.typography.labelSmall, color = color)
}

/** The queue's own line under a turn still waiting for a runner: "Queued", and the Cancel a queued message has. */
@Composable
internal fun QueuedFoot(modifier: Modifier = Modifier, cancel: () -> Unit) {
    Row(modifier.testTag("queued-foot"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        QueuedWord()
        TextButton(onClick = cancel, Modifier.testTag("queued-foot:cancel")) { Text("Cancel", style = MaterialTheme.typography.labelSmall) }
    }
}

/** What the line carried, opened: a row per wakeup, who queued the turn, and what the agent read — hung off a rule. */
@Composable
private fun WakeFold(wake: JsonObject) {
    var raw by rememberSaveable(wake.toString()) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.padding(start = 20.dp).height(IntrinsicSize.Min)) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(secondary.copy(alpha = 0.25f)))
        Column(Modifier.padding(start = 10.dp).testTag("background-wake:fold"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            BackgroundWakeCard.wakeups(wake).forEach { wakeup ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    wakeup.text("reason")?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    BackgroundWakeCard.wakeupMeta(wakeup).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary) }
                    wakeup.text("prompt")?.takeIf { it.isNotEmpty() }?.let { PromptFold(it) }
                }
            }
            Text(BackgroundWakeCard.meta, style = MaterialTheme.typography.labelSmall, color = secondary)
            Disclosure(BackgroundWakeCard.rawSummary, raw, "background-wake:raw") { raw = !raw }
            if (raw) SelectionContainer { Text(wake.text("text").orEmpty(), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = secondary) }
        }
    }
}

/** A wakeup's prompt, folded by logical lines at eight (the web's `Pre`). */
@Composable
private fun PromptFold(text: String) {
    var open by rememberSaveable(text) { mutableStateOf(false) }
    val lines = text.split("\n")
    val hidden = maxOf(0, lines.size - BackgroundWakeCard.tailLines)
    Text(if (open || hidden == 0) text else lines.take(BackgroundWakeCard.tailLines).joinToString("\n"),
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (hidden > 0) Text(if (open) "Show less" else "Show $hidden more ${if (hidden == 1) "line" else "lines"}",
        Modifier.clickable(role = Role.Button) { open = !open }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
}
