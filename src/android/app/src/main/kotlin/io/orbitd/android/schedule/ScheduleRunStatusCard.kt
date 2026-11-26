package io.orbitd.android.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.schedule.ScheduleRunSessionStatus
import io.orbitd.android.core.schedule.ScheduleRunStatusCopy.Actions
import io.orbitd.android.core.schedule.ScheduleRunStatusDisplay
import io.orbitd.android.core.schedule.ScheduleRunStatusKind
import io.orbitd.android.core.schedule.ScheduleRunView
import io.orbitd.android.directory.QueuedCapacity
import io.orbitd.android.directory.QueuedGate
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ScheduleRunStatusCard(
    run: ScheduleRunView,
    status: ScheduleRunSessionStatus,
    kind: ScheduleRunStatusKind,
    store: ScheduledStore,
    sessionId: String,
    runner: String,
    engine: String,
    openSchedule: (String) -> Unit,
    openRun: (String) -> Unit,
) {
    var now by remember(run.id) { mutableStateOf(Instant.now()) }
    val zone = store.timezone
    val colors = MaterialTheme.colorScheme
    val type = MaterialTheme.typography
    val text = when (kind) {
        ScheduleRunStatusKind.DIDNT_RUN -> ScheduleRunStatusDisplay.didntRun(run, status, runner, now, zone)
        ScheduleRunStatusKind.QUEUED_FULL -> {
            val queue = status.queue ?: return
            LaunchedEffect(run.id) {
                while (true) {
                    delay(30_000)
                    now = Instant.now()
                }
            }
            val gate = QueuedGate(queue.queuedReason, queue.queuedActive, queuedLimit = queue.queuedLimit,
                queuedHeldByJobs = queue.queuedHeldByJobs, since = queue.since)
            ScheduleRunStatusDisplay.queued(
                QueuedCapacity.tag(gate), QueuedCapacity.runText(gate, runner), QueuedCapacity.waited(gate, now),
                queue.deadline, now, zone,
            )
        }
        ScheduleRunStatusKind.STARTED_ON -> ScheduleRunStatusDisplay.startedOn(run, status, engine, runner, zone) ?: return
    }
    val scope = rememberCoroutineScope()
    var busy by remember(run.id, kind) { mutableStateOf(false) }
    var error by remember(run.id, kind) { mutableStateOf<String?>(null) }
    fun press(action: suspend () -> String?) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try { error = action() } finally { busy = false }
        }
    }

    val shape = RoundedCornerShape(16.dp)
    val dot = when (kind) {
        ScheduleRunStatusKind.DIDNT_RUN -> colors.onSurfaceVariant
        ScheduleRunStatusKind.QUEUED_FULL -> scheduleWarn()
        ScheduleRunStatusKind.STARTED_ON -> scheduleGreen()
    }
    Column(
        Modifier.fillMaxWidth().testTag("schedule-run-status-${kind.name}")
            .background(colors.surfaceVariant.copy(alpha = 0.52f), shape)
            .border(1.dp, colors.outline.copy(alpha = 0.25f), shape)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(9.dp).background(dot, CircleShape))
            Text(text.title, style = type.titleMedium)
        }
        Text(text.body, style = type.bodyMedium)
        if (text.times.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                text.times.forEach { time ->
                    Text(time, Modifier.background(colors.surfaceVariant, RoundedCornerShape(6.dp))
                        .padding(horizontal = 7.dp, vertical = 2.dp), color = colors.onSurfaceVariant, style = type.bodySmall)
                }
            }
        }
        text.gaveUp?.let { Text(it, color = colors.onSurfaceVariant, style = type.bodySmall) }
        text.next?.let { Text(it, color = colors.onSurfaceVariant, style = type.bodySmall) }

        val buttonShape = RoundedCornerShape(10.dp)
        val buttonPadding = PaddingValues(horizontal = 8.dp, vertical = 9.dp)
        Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            when (kind) {
                ScheduleRunStatusKind.DIDNT_RUN -> Button(
                    onClick = { press { store.runNow(run.scheduleId, openRun) } },
                    modifier = Modifier.weight(1f), enabled = !busy, shape = buttonShape, contentPadding = buttonPadding,
                ) { Text(Actions.runNow) }
                ScheduleRunStatusKind.QUEUED_FULL -> OutlinedButton(
                    onClick = { press { store.cancelRun(run, sessionId) } },
                    modifier = Modifier.weight(1f), enabled = !busy, shape = buttonShape, contentPadding = buttonPadding,
                ) { Text(Actions.cancelRun) }
                ScheduleRunStatusKind.STARTED_ON -> Button(
                    onClick = { run.sessionId?.let(openRun) }, modifier = Modifier.weight(1f),
                    shape = buttonShape, contentPadding = buttonPadding,
                ) { Text(Actions.openRun) }
            }
            if (kind != ScheduleRunStatusKind.STARTED_ON) {
                OutlinedButton(
                    onClick = { openSchedule(run.scheduleId) }, modifier = Modifier.weight(1f),
                    shape = buttonShape, contentPadding = buttonPadding,
                ) { Text(Actions.openSchedule) }
            }
        }
        error?.let { Text(it, color = colors.error, style = type.bodySmall) }
    }
}
