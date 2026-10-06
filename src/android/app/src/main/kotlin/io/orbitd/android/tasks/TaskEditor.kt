package io.orbitd.android.tasks

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.ComposerCatalog
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.navigation.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

@Composable
internal fun TaskEditor(kind: String, task: JsonObject, api: TaskApi, enabled: Boolean, workspaces: List<JsonObject>,
    close: () -> Unit, submit: (JsonObject) -> Unit, operation: (suspend () -> Unit) -> Unit, open: (OrbitRoute) -> Unit) {
    val id = task.text("id")!!
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var criteria by rememberSaveable(id, kind) { mutableStateOf(task.text("acceptanceCriteria").orEmpty()) }
    var command by rememberSaveable(id, kind) { mutableStateOf(task.text("acceptanceCommand").orEmpty()) }
    var exitCode by rememberSaveable(id, kind) { mutableStateOf(task.number("acceptanceExpectedExitCode")?.toString().orEmpty()) }
    var schedule by rememberSaveable(id, kind) { mutableStateOf(task.text("runAt")) }
    var provider by rememberSaveable(id, kind) { mutableStateOf(task.text("provider")) }
    var model by rememberSaveable(id, kind) { mutableStateOf(task.text("model")) }
    var catalog by remember { mutableStateOf<ComposerCatalog?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var candidates by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var prerequisite by remember { mutableStateOf<String?>(null) }
    var follow by rememberSaveable { mutableStateOf("TASK_TERMINAL") }
    var ttl by rememberSaveable { mutableStateOf("86400") }
    val followKey = rememberSaveable { UUID.randomUUID().toString() }
    var share by remember { mutableStateOf<JsonObject?>(null) }
    var shareExpiry by rememberSaveable { mutableStateOf<String?>(null) }
    var shareComments by rememberSaveable { mutableStateOf(false) }
    var shareConversations by rememberSaveable { mutableStateOf(false) }
    var shareTools by rememberSaveable { mutableStateOf(true) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(kind, query) {
        if (kind !in setOf("dependency", "model", "share")) return@LaunchedEffect
        loading = true; error = null
        try {
            when (kind) {
                "dependency" -> {
                    prerequisite = null; delay(250)
                    // Prerequisites can belong to a project; do not apply the Tasks tab's outside-project scope.
                    val result = api.read(listOf("tasks", "page"), listOf("limit" to "100", "q" to query, "counts" to "none")) as JsonObject
                    val existing = task.objects("dependsOn").mapNotNull { it.obj("dependsOnTask")?.text("id") }
                    candidates = result.objects("items").filter { it.text("id") != id && it.text("id") !in existing }
                }
                "model" -> {
                    val workspace = workspaces.firstOrNull { ObjectId.same(it.text("id"), task.text("assigneeId")) }
                    val runnerId = workspace?.text("runnerId") ?: workspace?.obj("runner")?.text("id")
                    val runner = runnerId?.let { api.read(listOf("runners", it)) as JsonObject } ?: JsonObject(emptyMap())
                    val providers = (api.read(listOf("providers")) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                    catalog = ComposerCatalog(runner, providers)
                }
                "share" -> {
                    share = api.read(listOf("tasks", id, "share")) as JsonObject
                    val existing = share?.obj("link")
                    shareExpiry = existing?.text("expiresAt")
                    existing?.obj("include")?.let { include ->
                        shareComments = include.flag("commentsAndFiles"); shareConversations = include.flag("conversations"); shareTools = include.flag("toolOutput")
                    }
                }
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = taskError(failure) }
        finally { loading = false }
    }
    val acceptanceValid = acceptanceProblem(command, exitCode) == null
    val canSave = enabled && !loading && error == null && when (kind) {
        "acceptance" -> acceptanceValid
        "dependency" -> prerequisite != null
        "schedule" -> schedule == null || runCatching { Instant.parse(schedule) }.isSuccess
        "model" -> catalog != null
        else -> true
    }
    AlertDialog(onDismissRequest = close, title = { Text(when (kind) {
        "acceptance" -> "Edit acceptance"; "dependency" -> "Add prerequisite"; "schedule" -> "Schedule task"
        "model" -> "Provider and model"; "follow" -> "Follow task"; else -> "Public sharing"
    }) }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        when (kind) {
            "acceptance" -> {
                OutlinedTextField(criteria, { criteria = it }, label = { Text("Acceptance criteria") }, minLines = 3)
                OutlinedTextField(command, { command = it }, label = { Text("Acceptance command") })
                OutlinedTextField(exitCode, { exitCode = it }, label = { Text("Expected exit code") })
                acceptanceProblem(command, exitCode)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Text("Orbit checks whether this changes the completion method and whether the edit is allowed.", style = MaterialTheme.typography.bodySmall)
            }
            "schedule" -> {
                val whenLocal = schedule?.let { runCatching { Instant.parse(it).atZone(ZoneId.systemDefault()) }.getOrNull() }
                Text(whenLocal?.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z")) ?: "No scheduled start")
                TextButton(onClick = {
                    val initial = whenLocal ?: Instant.now().atZone(ZoneId.systemDefault()).plusHours(1)
                    DatePickerDialog(context, { _, year, month, day ->
                        TimePickerDialog(context, { _, hour, minute ->
                            schedule = java.time.LocalDateTime.of(year, month + 1, day, hour, minute).atZone(ZoneId.systemDefault()).toInstant().toString()
                        }, initial.hour, initial.minute, android.text.format.DateFormat.is24HourFormat(context)).show()
                    }, initial.year, initial.monthValue - 1, initial.dayOfMonth).show()
                }) { Text("Choose date and time") }
                TextButton(onClick = { schedule = null }) { Text("Cancel scheduled start") }
                Text("The task starts once at this local time, subject to its dependencies and server run policy.")
            }
            "dependency" -> {
                OutlinedTextField(query, { query = it }, label = { Text("Search prerequisites") })
                if (!loading && candidates.isEmpty()) Text("No matching tasks")
                candidates.forEach { candidate ->
                    Row { RadioButton(prerequisite == candidate.text("id"), onClick = { prerequisite = candidate.text("id") })
                        TextButton(onClick = { prerequisite = candidate.text("id") }) { Text("${candidate.text("title")} · ${taskStatus(candidate)}") }
                    }
                }
            }
            "model" -> {
                val workspace = workspaces.firstOrNull { ObjectId.same(it.text("id"), task.text("assigneeId")) }
                val inherited = workspace?.text("provider") ?: "claude"
                val effective = provider ?: inherited
                val providers = catalog?.options(effective, newSession = true).orEmpty()
                TaskChoice("Provider", (listOf(null to "Assignee's ($inherited)") + providers.map { it.id to it.label } +
                    listOfNotNull(provider?.let { it to it })).distinctBy { it.first }, provider) { provider = it; model = null }
                val models = catalog?.models(effective).orEmpty()
                TaskChoice("Model", (listOf(null to "Provider default") + models.map { it.text("value") to (it.text("label") ?: it.text("value").orEmpty()) } +
                    listOfNotNull(model?.let { it to it })).distinctBy { it.first }, model) { model = it }
            }
            "follow" -> {
                TaskChoice("Notify me when", listOf("TASK_TERMINAL" to "The task finishes", "TASK_DONE" to "The task is done", "TASK_FAILED" to "The task fails"), follow) { follow = it!! }
                TaskChoice("Stop watching after", listOf("3600" to "1 hour", "21600" to "6 hours", "86400" to "1 day", "259200" to "3 days", "604800" to "7 days", "2592000" to "30 days"), ttl) { ttl = it!! }
                Text("Send a notification to my account when the condition is met.")
            }
            "share" -> {
                val url = share?.obj("link")?.text("token")?.let { "${api.server.trimEnd('/')}/s/$it" }
                Text(if (url != null) "Public link is enabled" else "Enable a public, read-only link to this task.")
                if (url != null) TextButton(onClick = { clipboard.setText(AnnotatedString(url)) }) { Text("Copy public link") }
                Row { Checkbox(shareComments, { shareComments = it }); Text("Comments and files", Modifier.padding(top = 12.dp)) }
                Row { Checkbox(shareConversations, { shareConversations = it }); Text("Run conversations", Modifier.padding(top = 12.dp)) }
                if (shareConversations) Row { Checkbox(shareTools, { shareTools = it }); Text("Tool output", Modifier.padding(top = 12.dp)) }
                TaskChoice("Expires", listOf(null to "Never") + listOfNotNull(shareExpiry?.let { it to it }) + listOf(86400L to "1 day", 604800L to "7 days", 2592000L to "30 days").map { (seconds, label) ->
                    Instant.now().plusSeconds(seconds).toString() to label
                }, shareExpiry) { shareExpiry = it }
                TextButton(onClick = { operation { api.write(listOf("tasks", id, "share"), HttpMethod.DELETE) } }, enabled = canSave && url != null) { Text("Disable public link") }
            }
        }
    } }, confirmButton = { TextButton(enabled = canSave, onClick = {
        when (kind) {
            "acceptance" -> submit(acceptancePatch(task, criteria, command, exitCode))
            "schedule" -> submit(buildJsonObject { put("runAt", schedule?.let(::JsonPrimitive) ?: JsonNull) })
            "model" -> submit(buildJsonObject { put("provider", provider?.let(::JsonPrimitive) ?: JsonNull); put("model", model?.let(::JsonPrimitive) ?: JsonNull) })
            "dependency" -> operation { api.addDependency(id, prerequisite!!) }
            "follow" -> operation {
                val response = api.write(listOf("watches"), body = buildJsonObject {
                    put("predicateVersion", 2); putJsonObject("predicate") { put("kind", if (follow == "TASK_FAILED") "ANY" else "ALL"); put("over", "ALL_TARGETS"); put("leaf", follow) }
                    putJsonArray("targets") { add(buildJsonObject { put("kind", "TASK"); put("id", id) }) }
                    put("action", "NOTIFY_USER"); put("ttlSeconds", ttl.toInt()); put("idempotencyKey", followKey)
                }) as? JsonObject
                response?.text("id")?.let { open(OrbitRoute(Destination.WATCH, it)) }
            }
            "share" -> operation { api.write(listOf("tasks", id, "share"), HttpMethod.PUT, buildJsonObject {
                put("expiresAt", shareExpiry?.let(::JsonPrimitive) ?: JsonNull)
                putJsonObject("include") { put("commentsAndFiles", shareComments); put("conversations", shareConversations); put("toolOutput", shareTools) }
            }) }
        }
    }) { Text(if (kind == "share") "Enable public link" else if (kind == "follow") "Follow" else "Save") } },
        dismissButton = { TextButton(onClick = close) { Text("Cancel") } })
}

internal fun acceptanceProblem(command: String, code: String): String? = when {
    command.isBlank() && code.isBlank() -> null
    command.isBlank() || code.isBlank() -> "Set both the command and its expected exit code, or clear both."
    !code.trim().matches(Regex("-?[0-9]+")) || code.trim().toIntOrNull() == null -> "Expected exit code must be a whole number."
    else -> null
}
internal fun acceptancePatch(task: JsonObject, criteria: String, command: String, code: String): JsonObject {
    require(acceptanceProblem(command, code) == null)
    return buildJsonObject {
        if (criteria.trim() != task.text("acceptanceCriteria").orEmpty().trim()) put("acceptanceCriteria", criteria.takeUnless { it.isBlank() }?.let(::JsonPrimitive) ?: JsonNull)
        if (command.trim() != task.text("acceptanceCommand").orEmpty().trim() || code.trim() != task.number("acceptanceExpectedExitCode")?.toString().orEmpty()) {
            put("acceptanceCommand", command.takeUnless { it.isBlank() }?.let(::JsonPrimitive) ?: JsonNull)
            put("acceptanceExpectedExitCode", code.trim().toIntOrNull()?.let(::JsonPrimitive) ?: JsonNull)
        }
    }
}
