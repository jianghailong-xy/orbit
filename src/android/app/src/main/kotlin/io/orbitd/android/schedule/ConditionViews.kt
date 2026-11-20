package io.orbitd.android.schedule

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.schedule.ConditionCopy as CC
import io.orbitd.android.core.schedule.ConditionDisplay
import io.orbitd.android.core.schedule.ConditionView
import io.orbitd.android.core.schedule.ConditionWaitingItem
import io.orbitd.android.core.schedule.ScheduleDisplay
import io.orbitd.android.core.schedule.StartWhenCardLines
import io.orbitd.android.core.schedule.TaskStartWhenView
import java.time.Instant
import kotlinx.coroutines.launch

// Conditions on Android (docs/condition-triggers-design.md §9, board docs/mocks/condition-triggers/, iOS `ConditionViews.swift` the
// reference): the inspector's Condition and How it checks blocks, the command as a card shows it, the task create card's Starts when /
// Today / If never, the two Waiting on you cards a condition files, and a task's waiting line. The words and rules are `:core`'s
// (`ConditionCopy`, `ConditionDisplay`).

/** A probe command as a card shows it, verbatim, in a grey box (board ② ③ ⑥): what Create approved, and what runs. */
@Composable
fun ConditionCommandBox(command: String) {
    SelectionContainer {
        Text(command, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f), RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 7.dp).testTag("condition-command"),
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurface)
    }
}

/** The inspector's two blocks for a WHEN rule (board ⑥ ② ③): Condition — the reading, its age, a bar with the firing and re-arm lines,
 * the rule in words — and How it checks — interval and runner, the command, when it was approved. */
@Composable
fun ConditionBlocks(condition: ConditionView, timezone: String, now: Instant) {
    val block = ConditionDisplay.conditionBlock(condition, now)
    val checks = ConditionDisplay.checksBlock(condition, timezone)
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.testTag("condition-block")) {
            Section(CC.conditionSection) {
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    block.reading?.let { Text(it, style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold)) }
                    Text(block.checked, Modifier.padding(bottom = 4.dp), style = MaterialTheme.typography.bodyMedium, color = secondary)
                }
                block.cantRead?.let { cantRead ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(14.dp), tint = scheduleWarn())
                        Text(cantRead, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold), color = scheduleWarn())
                    }
                }
                block.bar?.let { ConditionBar(it) }
                Text(block.rule, style = MaterialTheme.typography.bodySmall, color = secondary)
                block.repeat?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = secondary) }
            }
        }
        Box(Modifier.testTag("condition-how-it-checks")) {
            Section(CC.howItChecks) {
                Text(checks.every, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.height(4.dp))
                ConditionCommandBox(checks.command)
                Spacer(Modifier.height(4.dp))
                Text(checks.approved, style = MaterialTheme.typography.bodySmall, color = secondary)
                checks.awake?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = secondary) }
            }
        }
    }
}

/** The reading on one scale with the re-arm (grey) and firing (red) lines and their values under them (board ⑥ ②). */
@Composable
fun ConditionBar(bar: ConditionDisplay.Bar) {
    val track = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.15f)
    val fill = MaterialTheme.colorScheme.primary
    val grey = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
    val red = scheduleRed()
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp).clearAndSetSemantics { }, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Canvas(Modifier.fillMaxWidth().height(18.dp)) {
            val w = size.width
            val h = 8.dp.toPx()
            val top = (size.height - h) / 2
            drawRoundRect(track, Offset(0f, top), Size(w, h), CornerRadius(h / 2))
            drawRoundRect(fill, Offset(0f, top), Size(maxOf(h, w * bar.value.toFloat()), h), CornerRadius(h / 2))
            bar.rearm?.let { drawRect(grey, Offset(w * it.toFloat() - 1.dp.toPx(), 0f), Size(2.dp.toPx(), size.height)) }
            drawRect(red, Offset(w * bar.fire.toFloat() - 1.dp.toPx(), 0f), Size(2.dp.toPx(), size.height))
        }
        BoxWithConstraints(Modifier.fillMaxWidth().height(16.dp)) {
            val w = maxWidth
            // Two labels close together move apart: the re-arm one to the left of its line.
            val close = bar.rearm?.let { bar.fire - it < 0.08 } ?: false
            val rearm = bar.rearm
            val rearmLabel = bar.rearmLabel
            if (rearm != null && rearmLabel != null) Text(rearmLabel, Modifier.offset(x = w * rearm.toFloat() - (if (close) 34.dp else 14.dp)),
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
            Text(bar.fireLabel, Modifier.offset(x = minOf(w - 30.dp, w * bar.fire.toFloat() - (if (close) 2.dp else 14.dp))),
                style = MaterialTheme.typography.labelSmall, color = red, maxLines = 1)
        }
    }
}

/** One label-and-value row of a card, with a label column wide enough for "Starts when" (board frame 2). */
@Composable
private fun StartWhenRow(label: String, value: @Composable ColumnScope.() -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.width(92.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp), content = value)
    }
}

/** The task create card's condition lines (board frame 2): Starts when — the condition, how it is checked, the command — Today, and
 * If never. */
@Composable
fun StartWhenLines(lines: StartWhenCardLines) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("start-when-lines"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        StartWhenRow(CC.startsWhen) {
            Text(lines.startsWhen, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            Text(lines.checked, style = MaterialTheme.typography.bodyMedium, color = secondary)
            lines.awake?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = secondary) }
            ConditionCommandBox(lines.command)
        }
        StartWhenRow(CC.today) { Text(lines.today, style = MaterialTheme.typography.bodyMedium) }
        StartWhenRow(CC.ifNever) { Text(lines.ifNever, style = MaterialTheme.typography.bodyMedium) }
    }
}

/** A task that starts when its condition holds says so where a task says why it has not started (§6.2): "Waiting for: 3 or more
 * OSDs are in", and the newest reading. Nothing once it fired or ended. */
@Composable
fun TaskWaitingLine(startWhen: TaskStartWhenView?, now: Instant = Instant.now()) {
    val waiting = ConditionDisplay.taskWaiting(startWhen, now) ?: return
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("task-waiting-line"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(R.drawable.ic_gauge), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(waiting.line, style = MaterialTheme.typography.bodyMedium)
            waiting.reading?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/**
 * A condition's Waiting on you card (board ⑥ ①): the amber "Condition" head with when, the server's title and why, then Pause and
 * Look into it on a can't-read card, or Keep waiting and Stop on the 30-day question. [openSchedule] and [openTask] are where Look
 * into it goes; [answered] reads the list again.
 */
@Composable
fun ConditionWaitingCard(item: ConditionWaitingItem, store: ScheduledStore, openSchedule: (String) -> Unit, openTask: (String) -> Unit,
    answered: () -> Unit) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var busy by remember(item.id) { mutableStateOf(false) }
    var said by remember(item.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(item.id) { item.conditionId?.let(store::loadCondition) }
    val condition = state.condition(item.conditionId)
    val actions = ConditionDisplay.waitingActions(item, condition?.scheduleId)
    val warn = scheduleWarn()
    val zone = store.timezone
    val now = Instant.now()
    fun press(index: Int, title: String) {
        busy = true
        scope.launch {
            said = when {
                // The 30-day question's answers are its options, by index: Keep waiting (0), Stop (1).
                item.isStillWaiting -> store.answerCondition(item, index)
                title == CC.pause && condition?.scheduleId != null -> store.pause(condition.scheduleId!!)
                else -> {
                    condition?.scheduleId?.let(openSchedule) ?: condition?.taskId?.let(openTask)
                    null
                }
            }
            busy = false
            answered()
        }
    }
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(warn.copy(alpha = 0.03f)).border(1.dp, warn.copy(alpha = 0.45f), shape)
        .testTag("condition-waiting-${item.kind}")) {
        Row(Modifier.fillMaxWidth().background(warn.copy(alpha = 0.10f)).padding(horizontal = 14.dp, vertical = 8.dp)) {
            Text(CC.waitingKind, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold), color = warn)
            Text(ScheduleDisplay.parse(item.createdAt)?.let { ScheduleDisplay.whenText(it, now, zone) }.orEmpty(),
                style = MaterialTheme.typography.bodySmall, color = warn.copy(alpha = 0.8f))
        }
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(item.title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
            Text(item.why, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheduleRed()) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                actions.forEachIndexed { index, title ->
                    val tag = Modifier.weight(1f).testTag("condition-waiting-$title")
                    if (index == actions.lastIndex) Button(onClick = { press(index, title) }, tag, enabled = !busy) {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    } else FilledTonalButton(onClick = { press(index, title) }, tag, enabled = !busy) {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
