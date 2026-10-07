package io.orbitd.android.tasks

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.UUID

// The task page's sheets (TaskDetailParts.swift): Start at, Acceptance, Follow task, the
// prerequisite picker and a routed run's Why. Every word comes from TaskDetailCopy.

/** `Start at`: the one time the task starts by itself, saved explicitly, never in the past. */
@Composable
internal fun ScheduleSheet(task: JsonObject, enabled: Boolean, error: String?, close: () -> Unit, save: (String?) -> Unit) {
    val context = LocalContext.current
    val zone = ZoneId.systemDefault()
    var picked by rememberSaveable(task.text("id")) { mutableStateOf(TaskTime.parse(task.text("runAt"))?.toEpochMilli()
        ?: Instant.now().truncatedTo(ChronoUnit.HOURS).plus(1, ChronoUnit.HOURS).toEpochMilli()) }
    val instant = Instant.ofEpochMilli(picked)
    val future = instant.isAfter(Instant.now())
    AlertDialog(onDismissRequest = close, title = { Text(TaskDetailCopy.startAtLabel) }, modifier = Modifier.testTag("task-schedule-sheet"),
        text = { Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(TaskTime.local(instant.toString()) ?: "", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = {
                    val now = instant.atZone(zone)
                    DatePickerDialog(context, { _, y, m, d -> picked = LocalDateTime.of(y, m + 1, d, now.hour, now.minute).atZone(zone).toInstant().toEpochMilli() },
                        now.year, now.monthValue - 1, now.dayOfMonth).apply { datePicker.minDate = System.currentTimeMillis() - 1000 }.show()
                }) { Text("Date") }
                OutlinedButton(onClick = {
                    val now = instant.atZone(zone)
                    TimePickerDialog(context, { _, h, min -> picked = now.withHour(h).withMinute(min).withSecond(0).toInstant().toEpochMilli() },
                        now.hour, now.minute, android.text.format.DateFormat.is24HourFormat(context)).show()
                }) { Text("Time") }
            }
            Text(TaskDetailLogic.scheduleHint(task.text("runAt")), style = MaterialTheme.typography.bodySmall)
            error?.let { Text(it, Modifier.testTag("task-sheet-error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            if (task.text("runAt") != null) TextButton(onClick = { save(null) }, enabled = enabled, modifier = Modifier.testTag("task-cancel-schedule")) {
                Text(TaskDetailCopy.cancelSchedule, color = MaterialTheme.colorScheme.error) }
        } },
        confirmButton = { TextButton(onClick = { save(instant.truncatedTo(ChronoUnit.MILLIS).toString()) }, enabled = enabled && future,
            modifier = Modifier.testTag("task-save-schedule")) { Text(TaskDetailCopy.saveSchedule) } },
        dismissButton = { TextButton(onClick = close) { Text(TaskDetailCopy.cancel) } })
}

/** The acceptance editor: criteria, and the command with the exit code that counts as done — together or not at all. */
@Composable
internal fun AcceptanceSheet(current: AcceptanceDraft, enabled: Boolean, error: String?, close: () -> Unit, save: (JsonObject) -> Unit) {
    var criteria by rememberSaveable { mutableStateOf(current.criteria) }
    var command by rememberSaveable { mutableStateOf(current.command) }
    var exitCode by rememberSaveable { mutableStateOf(current.exitCode) }
    val draft = AcceptanceDraft(criteria, command, exitCode)
    AlertDialog(onDismissRequest = close, title = { Text(TaskDetailCopy.acceptanceHeading) }, modifier = Modifier.testTag("task-acceptance-sheet"),
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(TaskDetailCopy.acceptanceCriteriaLabel, style = MaterialTheme.typography.labelMedium)
            OutlinedTextField(criteria, { criteria = it }, Modifier.fillMaxWidth().testTag("task-acceptance-criteria"), placeholder = { Text(TaskDetailCopy.acceptanceCriteriaPlaceholder) },
                minLines = 3, maxLines = 10)
            Text(TaskDetailCopy.automaticJudgementLabel, style = MaterialTheme.typography.labelMedium)
            OutlinedTextField(command, { command = it }, Modifier.fillMaxWidth().testTag("task-acceptance-command"), label = { Text(TaskDetailCopy.acceptanceCommandLabel) },
                placeholder = { Text(TaskDetailCopy.acceptanceCommandPlaceholder) }, textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace), singleLine = true)
            OutlinedTextField(exitCode, { exitCode = it }, Modifier.fillMaxWidth().testTag("task-acceptance-exit"), label = { Text(TaskDetailCopy.doneWhenItExits) },
                placeholder = { Text("0") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            Text(TaskDetailCopy.acceptanceAutomaticHint, style = MaterialTheme.typography.bodySmall)
            draft.problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            error?.let { Text(it, Modifier.testTag("task-sheet-error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        } },
        confirmButton = { TextButton(onClick = { save(draft.patch(current)) }, enabled = enabled && draft.canSave(current),
            modifier = Modifier.testTag("task-save-acceptance")) { Text(TaskDetailCopy.saveAcceptance) } },
        dismissButton = { TextButton(onClick = close) { Text(TaskDetailCopy.cancel) } })
}

/** The conditions Follow offers over one task (`WatchEditing.conditions(for: .task)`) and how each reads. */
object TaskFollow {
    private fun leaf(kind: String, leaf: String) = buildJsonObject { put("kind", kind); put("over", "ALL_TARGETS"); put("leaf", leaf) }
    val conditions: List<JsonObject> = listOf(
        leaf("ALL", "TASK_TERMINAL"),
        buildJsonObject { put("kind", "ANY_OF"); putJsonArray("operands") { add(leaf("ALL", "TASK_TERMINAL")); add(leaf("ANY", "TASK_FAILED")) } },
        leaf("ALL", "TASK_DONE"),
        leaf("ANY", "TASK_FAILED"),
    )
    val deadlines = listOf(3_600, 21_600, 86_400, 259_200, 604_800, 2_592_000)
    const val defaultDeadline = 86_400
    fun deadlineTitle(seconds: Int): String = if (seconds % 86_400 == 0) { val days = seconds / 86_400; if (days == 1) "1 day" else "$days days" }
        else { val hours = seconds / 3_600; if (hours == 1) "1 hour" else "$hours hours" }
    private const val unknown = "a condition this version of Orbit can't show"
    /** `WatchProjection.condition` for one task target. */
    fun condition(predicate: JsonObject?): String {
        val text = sentence(predicate, nested = false)
        return text.replaceFirstChar { it.uppercase() }
    }
    private fun sentence(predicate: JsonObject?, nested: Boolean): String = when (predicate?.text("kind")) {
        "ALL", "ANY" -> if (predicate.text("over") != "ALL_TARGETS") unknown else when (predicate.text("leaf")) {
            "TASK_TERMINAL" -> "the task finishes"; "TASK_FAILED" -> "the task fails"; "TASK_DONE" -> "the task is done"; else -> unknown }
        "ALL_OF" -> predicate.objects("operands").joinToString(" and ") { sentence(it, true) }.let { if (nested) "($it)" else it }
        "ANY_OF" -> predicate.objects("operands").joinToString(", or ") { sentence(it, true) }.let { if (nested) "($it)" else it }
        else -> unknown
    }
}

/** Follow task: wait for a condition on this task, then notify you — until a deadline. One key per sheet. */
@Composable
internal fun FollowSheet(task: JsonObject, enabled: Boolean, error: String?, close: () -> Unit, follow: (JsonObject, Int, String) -> Unit) {
    var condition by rememberSaveable { mutableIntStateOf(0) }
    var ttl by rememberSaveable { mutableIntStateOf(TaskFollow.defaultDeadline) }
    val key = rememberSaveable { UUID.randomUUID().toString().lowercase() }
    AlertDialog(onDismissRequest = close, title = { Text(TaskDetailCopy.followTask) }, modifier = Modifier.testTag("task-follow-sheet"),
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(TaskDetailCopy.watchingLabel, style = MaterialTheme.typography.labelMedium)
            Text(task.text("title").orEmpty(), maxLines = 3)
            Text(TaskDetailCopy.waitUntilTheTask, style = MaterialTheme.typography.labelMedium)
            TaskFollow.conditions.forEachIndexed { index, predicate ->
                Row(Modifier.fillMaxWidth().clickable(role = Role.RadioButton) { condition = index }, verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(condition == index, null); Text(TaskFollow.condition(predicate))
                }
            }
            Text(TaskDetailCopy.thenLabel, style = MaterialTheme.typography.labelMedium)
            Text("🔔 ${TaskDetailCopy.notifyMe}")
            Text(TaskDetailCopy.stopWatchingAfter, style = MaterialTheme.typography.labelMedium)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TaskFollow.deadlines.take(3).forEach { seconds -> FilterChip(ttl == seconds, { ttl = seconds }, label = { Text(TaskFollow.deadlineTitle(seconds)) }) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TaskFollow.deadlines.drop(3).forEach { seconds -> FilterChip(ttl == seconds, { ttl = seconds }, label = { Text(TaskFollow.deadlineTitle(seconds)) }) }
            }
            Text(TaskDetailCopy.followDeadlineHint, style = MaterialTheme.typography.bodySmall)
            error?.let { Text(it, Modifier.testTag("task-sheet-error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        } },
        confirmButton = { TextButton(onClick = { follow(TaskFollow.conditions[condition], ttl, key) }, enabled = enabled, modifier = Modifier.testTag("task-follow-confirm")) {
            Text(TaskDetailCopy.follow) } },
        dismissButton = { TextButton(onClick = close) { Text(TaskDetailCopy.cancel) } })
}

/** The bounded, server-searched prerequisite picker (`TaskDependencyPicker`). */
@Composable
internal fun DependencyPicker(api: TaskApi, taskId: String, existing: List<String>, enabled: Boolean, refused: String?, close: () -> Unit, pick: (String) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var candidates by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(query) {
        loading = true; candidates = emptyList(); error = null
        delay(250)
        try { candidates = api.candidates(query) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = taskError(failure) }
        finally { loading = false }
    }
    val needle = query.trim()
    val shown = candidates.filter { candidate ->
        val id = candidate.text("id")
        id != null && !io.orbitd.android.navigation.ObjectId.same(id, taskId) && existing.none { io.orbitd.android.navigation.ObjectId.same(it, id) } &&
            (needle.isEmpty() || candidate.text("title").orEmpty().contains(needle, ignoreCase = true))
    }
    AlertDialog(onDismissRequest = close, title = { Text(TaskDetailCopy.addPrerequisite) }, modifier = Modifier.testTag("task-dependency-picker"),
        text = { LazyColumn(Modifier.heightIn(max = 460.dp)) {
            item { OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().testTag("task-dependency-search"), label = { Text(TaskListCopy.searchTasks) }, singleLine = true) }
            if (loading && shown.isEmpty()) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 8.dp)) }
            error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
            refused?.let { item { Text(it, Modifier.testTag("task-sheet-error"), color = MaterialTheme.colorScheme.error) } }
            if (!loading && shown.isEmpty()) item { Text("No matching tasks", Modifier.padding(vertical = 12.dp)) }
            items(shown, key = { it.text("id").orEmpty() }) { candidate ->
                Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button) { candidate.text("id")?.let(pick) }.padding(vertical = 10.dp)
                    .testTag("candidate:${candidate.text("id")}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TaskStatusPill(TaskListLogic.pill(candidate)); Text(candidate.text("title").orEmpty(), maxLines = 2)
                }
            }
        } },
        confirmButton = {}, dismissButton = { TextButton(onClick = close) { Text(TaskDetailCopy.cancel) } })
}

/** The Why of one routed run: the router's own sentences, then its policy and when it decided. */
@Composable
internal fun RouteWhySheet(route: JsonObject, modelLabel: (String) -> String, close: () -> Unit) {
    AlertDialog(onDismissRequest = close, title = { Text(TaskDetailCopy.why(TaskDetailLogic.routePick(route, modelLabel))) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            route.strings("reasons").forEachIndexed { index, reason -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("${index + 1}", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary); Text(reason)
            } }
            Text(TaskDetailLogic.routeWhyFooter(route), style = MaterialTheme.typography.bodySmall)
        } },
        confirmButton = { TextButton(onClick = close) { Text("Done") } })
}
