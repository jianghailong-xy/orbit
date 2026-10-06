package io.orbitd.android.projects

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import io.orbitd.android.cards.BusinessCard
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*

@Composable
fun ProjectSettingsDialog(page: ProjectPageData, enabled: Boolean, notice: String?, dismiss: () -> Unit,
    submit: (String, ApiRequest) -> Unit) {
    val document = page.document
    val integration = page.sections["integration"] ?: return
    val id = document.text("id") ?: return
    var automatic by rememberSaveable(id, document.text("configRevision"), integration.toString()) { mutableStateOf(document.flag("coordinatorEnabled")) }
    var concurrency by rememberSaveable(id, document.text("configRevision"), integration.toString()) { mutableStateOf((document.number("maxConcurrentTasks") ?: 1).toString()) }
    var command by rememberSaveable(id, document.text("configRevision"), integration.toString()) { mutableStateOf(integration.text("mergeCheckCommand").orEmpty()) }
    var escalation by rememberSaveable(id, document.text("configRevision"), integration.toString()) { mutableStateOf((integration.number("escalationSeconds") ?: 7200).toString()) }
    var line by rememberSaveable(id, document.text("configRevision"), integration.toString()) { mutableStateOf(integration.text("line")) }
    fun send(body: JsonObject, suffix: String? = null) = submit("Save run settings", ApiRequest(listOfNotNull("projects", id, suffix), HttpMethod.PATCH, body = body.toString().encodeToByteArray()))
    Dialog(onDismissRequest = { if (enabled) dismiss() }) {
        Surface(shape = MaterialTheme.shapes.large) {
            Column(Modifier.testTag("project-settings").padding(20.dp).heightIn(max = 650.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("How it runs", style = MaterialTheme.typography.titleLarge)
                Text("Applies from the next task.")
                notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Checkbox(automatic, { automatic = it }, enabled = enabled)
                    Text("Automatic")
                }
                OutlinedTextField(concurrency, { concurrency = it }, enabled = enabled, label = { Text("Concurrent tasks (1–100)") }, singleLine = true)
                Button(enabled = enabled && (concurrency.toIntOrNull() ?: 0) in 1..100 &&
                    (automatic != document.flag("coordinatorEnabled") || concurrency.toIntOrNull() != document.number("maxConcurrentTasks")), onClick = {
                    send(projectAuthorization(document, automatic, concurrency.toInt()))
                }) { Text("Save task settings") }
                HorizontalDivider()
                Text("Tasks land on", style = MaterialTheme.typography.titleMedium)
                listOf("MAIN" to "Main", "PROJECT_BRANCH" to "Project branch").forEach { (value, label) ->
                    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                        RadioButton(line == value, { line = value }, enabled = enabled && !integration.flag("locked"))
                        Text(label)
                    }
                }
                if (integration.flag("locked")) Text("This project started integrating, so its landing line can no longer change.")
                Button(enabled = enabled && !integration.flag("locked") && line != null && line != integration.text("line"), onClick = { send(buildJsonObject { put("line", line) }, "integration") }) { Text("Save landing line") }
                OutlinedTextField(command, { command = it }, enabled = enabled, label = { Text("Merge check command") })
                if (automatic && line == "PROJECT_BRANCH" && command.isBlank()) Text("Automatic will merge the project branch into main without running a merge check.")
                Button(enabled = enabled && command.trim().takeIf(String::isNotEmpty) != integration.text("mergeCheckCommand"), onClick = {
                    send(buildJsonObject { put("mergeCheckCommand", command.trim().takeIf(String::isNotEmpty)?.let(::JsonPrimitive) ?: JsonNull) }, "integration")
                }) { Text("Save merge check") }
                OutlinedTextField(escalation, { escalation = it }, enabled = enabled, label = { Text("Escalate after (seconds, 300–604800)") }, singleLine = true)
                Text("Items the coordinator hasn't handled by then come to you.")
                Button(enabled = enabled && (escalation.toIntOrNull() ?: 0) in 300..604800 && escalation.toIntOrNull() != integration.number("escalationSeconds"), onClick = {
                    send(buildJsonObject { put("exceptionEscalationSeconds", escalation.toInt()) }, "integration")
                }) { Text("Save escalation window") }
                TextButton(enabled = enabled, onClick = dismiss) { Text("Close") }
            }
        }
    }
}

/** The owner's own Start… reuses A08's card inputs; no coordinator request is invented or sent. */
@Composable
fun ProjectStartDialog(page: ProjectPageData, enabled: Boolean, notice: String?, dismiss: () -> Unit, submit: (ApiRequest) -> Unit) {
    val id = page.document.text("id") ?: return
    val digest = page.sections["confirmation"]?.obj("currentVersion")?.text("digest") ?: return
    val settings = projectStartSettings(page)
    val source = buildJsonObject { putJsonObject("startRequest") {
        put("criteriaDigest", digest)
        put("settings", Wire.json.encodeToJsonElement(ProjectStartSettings.serializer(), settings))
    } }
    val card = InteractionCard("owner-start:$id", CardFamily.START, "Start this project?", source, "", id, "owner-start", digest,
        listOf(CardVerb.START), context = JsonObject(page.document + ("plan" to (page.sections["graph"] ?: JsonObject(emptyMap())))))
    Dialog(onDismissRequest = { if (enabled) dismiss() }) {
        Surface(shape = MaterialTheme.shapes.large) {
            Column(Modifier.padding(16.dp).heightIn(max = 680.dp).verticalScroll(rememberScrollState())) {
                Text("Not asked yet · your own start", style = MaterialTheme.typography.bodySmall)
                BusinessCard(card, enabled && page.document.objects("acceptanceCriteriaItems").isNotEmpty(), result = CardActionState(message = notice), open = {}) { verb, input ->
                    if (verb == CardVerb.START) {
                        // CardRequests validates the shared five settings. The owner door omits requestId.
                        val prepared = CardRequests.build(card, verb, input)
                        val body = Wire.json.parseToJsonElement(requireNotNull(prepared.body).decodeToString()).jsonObject
                        submit(ApiRequest(prepared.path, prepared.method, body = JsonObject(body - "requestId").toString().encodeToByteArray()))
                    }
                }
                TextButton(enabled = enabled, onClick = dismiss) { Text("Cancel") }
            }
        }
    }
}
