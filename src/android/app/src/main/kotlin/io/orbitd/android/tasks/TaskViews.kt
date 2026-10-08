package io.orbitd.android.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject
import io.orbitd.android.core.cards.*

/** The pill's colour by kind: shape and text say the state too, never colour alone. */
@Composable
fun pillColor(kind: PillKind): Color {
    val orbit = LocalOrbitColors.current
    return when (kind) {
        PillKind.RUNNING, PillKind.IN_PROGRESS -> orbit.running
        PillKind.QUEUED -> orbit.needsYou
        PillKind.DONE -> orbit.success
        PillKind.FAILED -> MaterialTheme.colorScheme.error
        PillKind.OPEN, PillKind.CANCELLED -> MaterialTheme.colorScheme.onSurfaceVariant
    }
}

@Composable
fun TaskStatusPill(pill: TaskPill, modifier: Modifier = Modifier) {
    val color = pillColor(pill.kind)
    Row(modifier.background(color.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (pill.kind == PillKind.RUNNING) CircularProgressIndicator(Modifier.size(9.dp), color = color, strokeWidth = 1.5.dp)
        else Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(pill.label, style = MaterialTheme.typography.labelSmall, color = color, maxLines = 1)
    }
}

/** The compact Session row's rhythm: title and time, then the pill, one phrase and the first label. */
@Composable
fun TaskRowView(task: JsonObject, modifier: Modifier = Modifier) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(task.text("title") ?: "Untitled task", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyLarge)
            TaskListLogic.rowTime(task)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(start = 8.dp)) }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            TaskStatusPill(TaskListLogic.pill(task))
            val phrase = TaskListLogic.rowPhrase(task)
            val phraseColor = when (phrase) {
                TaskRowPhrase.WaitingForConfirmation -> LocalOrbitColors.current.needsYou
                TaskRowPhrase.PrerequisiteCancelled -> MaterialTheme.colorScheme.error
                else -> muted
            }
            Text(TaskListLogic.phraseText(task, phrase), style = MaterialTheme.typography.bodySmall, color = phraseColor, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            task.strings("labels").firstOrNull()?.let { label ->
                Text(label, style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(5.dp)).padding(horizontal = 6.dp, vertical = 2.dp))
            }
        }
    }
}

/** A section's heading written as a row: the bold title, a grey count or fact, a trailing control. */
@Composable
fun TaskSectionHeader(title: String, detail: String? = null, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(top = 14.dp, bottom = 2.dp).semantics { heading() }, verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        detail?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

/** What went wrong the last time, above what it is about — the iOS orange banner. */
@Composable
fun TaskErrorBanner(message: String, retry: (() -> Unit)? = null, dismiss: () -> Unit) {
    Row(Modifier.fillMaxWidth().testTag("task-error").background(LocalOrbitColors.current.needsYou.copy(alpha = 0.12f), RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        retry?.let { TextButton(onClick = it) { Text("Retry") } }
        TextButton(onClick = dismiss, modifier = Modifier.semantics { contentDescription = "Dismiss error" }) { Text("✕") }
    }
}

/** The refusal a Run met, kept whole and read as a way out (`TaskRunHandoffCard`). */
@Composable
fun TaskRunConflictCard(conflict: TaskRunHandoff.Conflict, openRun: (String) -> Unit, clearPin: (() -> Unit)?, dismiss: () -> Unit) {
    Surface(Modifier.fillMaxWidth().testTag("task-run-conflict"), shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(conflict.title, style = MaterialTheme.typography.titleSmall)
            Text(conflict.body, style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                conflict.sessionId?.let { session -> Button(onClick = { openRun(session) }) { Text(TaskRunHandoff.openTheRun) } }
                if (conflict.kind == TaskRunHandoff.Kind.PIN && clearPin != null) OutlinedButton(onClick = clearPin) { Text(TaskRunHandoff.clearThePin) }
                TextButton(onClick = dismiss) { Text("Dismiss") }
            }
        }
    }
}

/** The account stream is not connected: writes are refused until it is (Android's own sentence). */
@Composable
fun OfflineNote(modifier: Modifier = Modifier) {
    Text(OFFLINE_NOTE, modifier.testTag("tasks-offline"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
const val OFFLINE_NOTE = "Reconnecting to Orbit… Changes are unavailable until it's back."
