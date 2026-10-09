package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
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
 * A turn the control plane opened because a background job had news or a wakeup came due (A08-11; iOS `BackgroundWakeCardView`):
 * one line in the agent's stream — its mark, what happened, which job, how it came out, when, and the details label — that opens to
 * the rest. A failed job's output tail stays out of the fold, three rendered lines with 展开输出 / 收起输出. When it does not fit one
 * line, the name and the closing words each take a line under the title. A wake written into the running turn says how far it got.
 */
@Composable
internal fun BackgroundWakeLine(wake: JsonObject, ts: String?, steerState: String? = null, undelivered: Boolean = false,
    queued: Boolean = false, onCancelQueued: (() -> Unit)? = null) {
    var open by rememberSaveable(wake.toString()) { mutableStateOf(false) }
    val jobs = BackgroundWakeCard.jobs(wake)
    val failed = jobs.any(BackgroundWakeCard::isFailed)
    val several = jobs.size > 1
    val red = MaterialTheme.colorScheme.error
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val label = MaterialTheme.typography.bodySmall
    val mark = @Composable {
        when {
            failed -> Icon(painterResource(R.drawable.ic_x_circle), null, Modifier.size(14.dp), tint = red)
            BackgroundWakeCard.isPending(wake) -> Icon(painterResource(R.drawable.ic_clock), null, Modifier.size(14.dp), tint = secondary)
            else -> Icon(painterResource(R.drawable.ic_check_circle), null, Modifier.size(14.dp), tint = LocalOrbitColors.current.success)
        }
    }
    val title = @Composable { Text(BackgroundWakeCard.title(wake), style = label, color = if (failed) red else secondary, maxLines = 1) }
    val name = BackgroundWakeCard.lineName(wake)
    val isCommand = jobs.size == 1 && jobs.single().text("description").isNullOrEmpty()
    val nameText = @Composable { modifier: Modifier ->
        name?.let { Text(it, modifier, style = if (isCommand) label.copy(fontFamily = FontFamily.Monospace) else label,
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f), maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
    val closing = @Composable {
        BackgroundWakeCard.lineStatus(wake)?.let {
            Text(it, Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = secondary, maxLines = 1)
        }
        ts?.let { BackgroundWakeCard.relative(it) }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1) }
        Text(BackgroundWakeCard.detailsLabel(wake), Modifier.testTag("wake-details-label"), style = MaterialTheme.typography.labelSmall,
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
        if (open) WakeFold(wake, several)
        jobs.filter { BackgroundWakeCard.isFailed(it) && !it.text("outputTail").isNullOrEmpty() }.forEach { job ->
            Column(Modifier.padding(start = 20.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                if (several) Text(BackgroundWakeCard.name(job), style = MaterialTheme.typography.labelSmall, color = secondary)
                FailedOutput(job.text("outputTail").orEmpty())
            }
        }
        if (undelivered) Text(BackgroundWakeCard.undelivered, Modifier.padding(start = 20.dp), style = MaterialTheme.typography.labelSmall,
            color = LocalOrbitColors.current.needsYou)
        steerState?.let { Text(it, Modifier.padding(start = 20.dp).testTag("background-wake:steer"), style = MaterialTheme.typography.labelSmall, color = secondary) }
        onCancelQueued?.let { cancel -> QueuedFoot(Modifier.padding(start = 20.dp), cancel) }
    }
}

/** The queue's own line under a turn still waiting for a runner: "Queued", and the Cancel a queued message has. */
@Composable
internal fun QueuedFoot(modifier: Modifier = Modifier, cancel: () -> Unit) {
    Row(modifier.testTag("queued-foot"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Queued", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = cancel, Modifier.testTag("queued-foot:cancel")) { Text("Cancel", style = MaterialTheme.typography.labelSmall) }
    }
}

/** A failed job's output tail, bounded by rendered lines so compact JSON cannot fill the transcript; its own fold, apart from the line's. */
@Composable
private fun FailedOutput(text: String) {
    var open by rememberSaveable(text) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f), RoundedCornerShape(6.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp).testTag("background-wake:failed-output"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(BackgroundWakeCard.outputTail, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer {
            Text(text, Modifier.testTag("background-wake:tail"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = if (open) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis)
        }
        Text(if (open) BackgroundWakeCard.collapseOutput else BackgroundWakeCard.expandOutput,
            Modifier.clickable(role = Role.Button) { open = !open }.testTag("background-wake:toggle-output"),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
    }
}

/** What the line carried, opened: a row per job or wakeup, who queued the turn, and what the agent read — hung off a rule. */
@Composable
private fun WakeFold(wake: JsonObject, several: Boolean) {
    var raw by rememberSaveable(wake.toString()) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.padding(start = 20.dp).height(IntrinsicSize.Min)) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(secondary.copy(alpha = 0.25f)))
        Column(Modifier.padding(start = 10.dp).testTag("background-wake:fold"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            BackgroundWakeCard.jobs(wake).forEach { job ->
                val described = !job.text("description").isNullOrEmpty()
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    if (several || described) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(BackgroundWakeCard.name(job), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f))
                        if (several) BackgroundWakeCard.status(job)?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = secondary)
                        }
                    }
                    if (described || !several) Text(job.text("command").orEmpty(), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = secondary)
                    Text(BackgroundWakeCard.jobMeta(job), style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = secondary)
                }
            }
            BackgroundWakeCard.wakeups(wake).forEach { wakeup ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    wakeup.text("reason")?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                    BackgroundWakeCard.wakeupMeta(wakeup).takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary) }
                    wakeup.text("prompt")?.takeIf { it.isNotEmpty() }?.let { PromptFold(it) }
                }
            }
            Text(BackgroundWakeCard.meta(wake), style = MaterialTheme.typography.labelSmall, color = secondary)
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
