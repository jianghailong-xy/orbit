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
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.SubagentFinished
import io.orbitd.android.core.cards.SubagentFinishedCard
import io.orbitd.android.core.cards.SubagentFinishedRun
import io.orbitd.android.core.cards.BackgroundWakeCard
import io.orbitd.android.reader.AgentTone
import io.orbitd.android.reader.LocalSubagentCardJump
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.ui.LocalOrbitColors

/**
 * A turn the control plane opened because a SubAgent ended ([SubagentFinished]), drawn as one line in the agent's stream in the grammar a
 * background job's news uses ([BackgroundWakeLine]; board docs/mocks/subagent-finished-line, web `SubagentFinishedCard.tsx`): the purple ✦
 * of the SubAgent card, how it ended, a status chip, when, and Details — never the reader's own bubble over the raw block.
 *
 * What it handed back stays out of the fold, three lines of it as Markdown with Show full result. A lone run that did not finish turns the
 * line red and says why. Several runs each get a row with one line of their result. The fold holds each run's id, the way back to its
 * SubAgent card when that card is drawn, who queued the turn and what the agent read — the only place the block's sentences for the agent
 * are shown. A wake written into the running turn says how far it got, as a steer does.
 */
@Composable
internal fun SubagentFinishedLine(wake: SubagentFinished, ts: String?, steerState: String? = null, undelivered: Boolean = false,
    queued: Boolean = false, onCancelQueued: (() -> Unit)? = null) {
    var open by rememberSaveable(wake.text) { mutableStateOf(false) }
    val failed = SubagentFinishedCard.failed(wake)
    val red = MaterialTheme.colorScheme.error
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val label = MaterialTheme.typography.bodySmall
    val tone = if (failed) red else AgentTone
    val mark = @Composable { Text(SubagentFinishedCard.mark, Modifier.clearAndSetSemantics { }.testTag("subagent-finished:mark"), color = tone,
        style = MaterialTheme.typography.labelLarge) }
    val title = @Composable { Text(SubagentFinishedCard.title(wake), style = label, color = if (failed) red else secondary, maxLines = 1) }
    val nameText = @Composable { modifier: Modifier ->
        SubagentFinishedCard.name(wake)?.let { Text(it, modifier, style = label, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f),
            maxLines = 1, overflow = TextOverflow.Ellipsis) }
    }
    val closing = @Composable {
        StatusChip(SubagentFinishedCard.status(wake), failed, Modifier.testTag("subagent-finished:status"))
        ts?.let { BackgroundWakeCard.relative(it) }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1) }
        Text(SubagentFinishedCard.details, style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1)
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp).rotate(if (open) 90f else 0f), tint = secondary.copy(alpha = 0.6f))
    }
    Column(Modifier.fillMaxWidth().testTag("subagent-finished"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        val dashed = if (queued) Modifier.dashedBorder(secondary.copy(alpha = 0.5f), 6.dp) else Modifier
        FitsOrStack(Modifier.fillMaxWidth().then(dashed).clickable(role = Role.Button) { open = !open }.padding(horizontal = 4.dp, vertical = 3.dp)
            .testTag("subagent-finished:line"),
            wide = {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    mark(); title(); nameText(Modifier); closing()
                }
            },
            narrow = {
                Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { mark(); title() }
                    nameText(Modifier.padding(start = 20.dp))
                    Row(Modifier.padding(start = 20.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { closing() }
                }
            })
        if (open) Fold(wake)
        val lone = wake.runs.singleOrNull()
        if (lone != null) RunOutcome(lone) else Runs(wake.runs)
        if (undelivered) Text(SubagentFinishedCard.undelivered, Modifier.padding(start = 20.dp), style = MaterialTheme.typography.labelSmall,
            color = LocalOrbitColors.current.needsYou)
        steerState?.let { Text(it, Modifier.padding(start = 20.dp).testTag("subagent-finished:steer"), style = MaterialTheme.typography.labelSmall, color = secondary) }
        onCancelQueued?.let { cancel -> QueuedFoot(Modifier.padding(start = 20.dp), cancel) }
    }
}

@Composable
private fun StatusChip(text: String, failed: Boolean, modifier: Modifier = Modifier) {
    val color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    Text(text, modifier.background(color.copy(alpha = if (failed) 0.12f else 0.08f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = color, maxLines = 1)
}

/** The rule a run's outcome hangs off: purple for one that finished, red for one that did not. */
@Composable
private fun Ruled(color: Color, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Row(modifier.padding(start = 20.dp).fillMaxWidth().height(IntrinsicSize.Min)
        .background(color.copy(alpha = 0.05f), RoundedCornerShape(topEnd = 6.dp, bottomEnd = 6.dp))) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(color.copy(alpha = 0.55f)))
        Column(Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = content)
    }
}

/** Under a lone run's line: why it ended if it did not finish, then what it handed back. */
@Composable
private fun RunOutcome(run: SubagentFinishedRun) {
    if (run.ok && run.result.isEmpty()) return
    val red = MaterialTheme.colorScheme.error
    Ruled(if (run.ok) AgentTone else red, Modifier.testTag("subagent-finished:outcome")) {
        run.reason?.let { Text(it, Modifier.testTag("subagent-finished:reason"), style = MaterialTheme.typography.bodyMedium, color = red) }
        if (run.result.isNotEmpty()) ResultPreview(run.result)
        else Text(SubagentFinishedCard.noResult, Modifier.testTag("subagent-finished:no-result"), style = MaterialTheme.typography.bodyMedium.copy(
            fontStyle = androidx.compose.ui.text.font.FontStyle.Italic), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Each of several runs: its mark, name and end, and one line of what it handed back. */
@Composable
private fun Runs(runs: List<SubagentFinishedRun>) {
    Ruled(AgentTone, Modifier.testTag("subagent-finished:runs")) {
        runs.forEach { run ->
            val red = MaterialTheme.colorScheme.error
            Column(Modifier.testTag("subagent-finished:run"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (run.ok) "✓" else "✕", color = if (run.ok) LocalOrbitColors.current.success else red, style = MaterialTheme.typography.bodyMedium)
                    Text(run.description, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyMedium,
                        color = if (run.ok) MaterialTheme.colorScheme.onSurface else red, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    StatusChip(run.status.lowercase(), !run.ok)
                }
                // One small line, cut with an ellipsis (web `.sawake-run-line`): why it ended in red where it handed nothing back,
                // and No result in italics where it gave no reason either.
                val first = run.result.split("\n").firstOrNull { it.isNotBlank() }
                Text(SubagentFinishedCard.rowLine(run).replace(Regex("\\*\\*|`"), ""), Modifier.padding(start = 20.dp),
                    style = MaterialTheme.typography.bodySmall.copy(fontStyle = if (first == null && run.reason == null)
                        androidx.compose.ui.text.font.FontStyle.Italic else null),
                    color = if (first == null && run.reason != null) red else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/** A run's result as Markdown, three lines of it until the reader asks for the rest — offered only when three lines do not hold it. */
@Composable
private fun ResultPreview(text: String) {
    var open by rememberSaveable(text) { mutableStateOf(false) }
    var overflows by remember(text) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.testTag("subagent-finished:result")) {
            CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurface) {
                if (open) MarkdownText(text)
                else Clamped(SubagentFinishedCard.resultLines, onOverflow = { overflows = it }) { MarkdownText(text) }
            }
        }
        if (open || overflows) Row(Modifier.clickable(role = Role.Button) { open = !open }.testTag("subagent-finished:toggle"),
            horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (open) SubagentFinishedCard.showLess else SubagentFinishedCard.showFullResult, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary)
            Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(12.dp).rotate(if (open) 180f else 0f), tint = MaterialTheme.colorScheme.primary)
        }
    }
}

/** Markdown [content], cut at [lines] of its paragraphs' line height (MarkdownText draws prose in bodyLarge) — on a line's boundary —
 * and saying whether anything was cut. */
@Composable
private fun Clamped(lines: Int, onOverflow: (Boolean) -> Unit = {}, content: @Composable () -> Unit) {
    val style = MaterialTheme.typography.bodyLarge
    val cap = with(LocalDensity.current) { (style.lineHeight * lines).roundToPx() }
    val report by rememberUpdatedState(onOverflow)
    ProvideTextStyle(style) {
        Layout(content, Modifier.clipToBounds()) { measurables, constraints ->
            val placeables = measurables.map { it.measure(constraints.copy(minHeight = 0, maxHeight = Constraints.Infinity)) }
            val full = placeables.maxOfOrNull { it.height } ?: 0
            report(full > cap)
            layout(placeables.maxOfOrNull { it.width } ?: 0, minOf(full, cap)) { placeables.forEach { it.placeRelative(0, 0) } }
        }
    }
}

/** What the line carried, opened: each run and the way back to its card, who queued it, and what the agent read. */
@Composable
private fun Fold(wake: SubagentFinished) {
    var raw by rememberSaveable(wake.text) { mutableStateOf(false) }
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val jump = LocalSubagentCardJump.current
    val several = wake.runs.size > 1
    Row(Modifier.padding(start = 20.dp).height(IntrinsicSize.Min)) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(secondary.copy(alpha = 0.25f)))
        Column(Modifier.padding(start = 10.dp).testTag("subagent-finished:fold"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            wake.runs.forEach { run ->
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (several) Text("${run.description} · ", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.75f))
                    Text(SubagentFinishedCard.run, style = MaterialTheme.typography.labelSmall, color = secondary)
                    Text(run.runId, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = secondary)
                    // A way back to a card that is not drawn would go nowhere, so there is none.
                    jump(run.runId)?.let { go ->
                        Text(" · ", style = MaterialTheme.typography.labelSmall, color = secondary)
                        Text(SubagentFinishedCard.itsCard, Modifier.clickable(role = Role.Button, onClick = go).testTag("subagent-finished:card-link"),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            Text(SubagentFinishedCard.uncommitted, style = MaterialTheme.typography.labelSmall, color = secondary)
            Text(SubagentFinishedCard.queuedBy, style = MaterialTheme.typography.labelSmall, color = secondary)
            Disclosure(SubagentFinishedCard.rawSummary, raw, "subagent-finished:raw") { raw = !raw }
            if (raw) SelectionContainer {
                Text(wake.text, Modifier.testTag("subagent-finished:raw-text"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = secondary)
            }
        }
    }
}
