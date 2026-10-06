package io.orbitd.android.wiki

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun WikiSettings(ui: WikiUi) {
    val space = ui.page.content
    val settings = space.obj("settings") ?: buildJsonObject {}
    val maintenance = settings.obj("maintenance") ?: buildJsonObject {}
    val mode = settings.text("reviewMode")?.takeIf { it in setOf("manual", "tiered", "automatic") } ?: "manual"
    var editing by rememberSaveable { mutableStateOf(false) }
    val enabled = ui.fresh && !ui.busy
    WikiPageColumn {
        WikiHeading("Wiki settings")
        Text(space.text("slug") ?: "")
        settings.text("reviewModeChangedBy")?.takeIf { it != "owner" }?.let { Text("Review mode changed by ${it.replace('_', ' ')}.") }
        WikiHeading("Review mode")
        listOf("manual" to "Every change from sessions, maintenance and imports waits for you in Review.", "tiered" to "Your own words and machine-checked entries apply at once; the rest show as Unreviewed and are not sent to agents.", "automatic" to "local-vllm checks each change against its sources first: supported ones apply, partly supported ones show as Unreviewed, the rest are rejected with a reason.").forEach { (value, note) ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                RadioButton(mode == value, onClick = { ui.write { ui.api.updateSpace(space.text("id")!!, buildJsonObject { put("reviewMode", value) }) } }, enabled = enabled)
                Column(Modifier.weight(1f)) { Text(value.replaceFirstChar(Char::uppercase)); Text(note, style = MaterialTheme.typography.bodySmall) }
            }
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text("Spot checks"); Text("Automatic sends one in 200 changes to you for a check.", style = MaterialTheme.typography.bodySmall) }
            Switch(settings.flag("automaticSpotChecks"), onCheckedChange = { on -> ui.write { ui.api.updateSpace(space.text("id")!!, buildJsonObject { put("automaticSpotChecks", on) }) } }, enabled = enabled && mode == "automatic")
        }
        Text("Always asks you, in any mode: principles, anything a session proposed after reading the web, and changes to entries you wrote or confirmed. A run that would change more than 10% of the wiki stops.", style = MaterialTheme.typography.bodySmall)
        WikiHeading("Maintenance")
        Text(if (maintenance.flag("enabled")) "On" else "Off")
        if (maintenance.flag("enabled")) {
            val options = ui.page.extras["options"]
            Text("Workspace · ${options?.objects("workspaces")?.firstOrNull { it.text("id") == maintenance.text("workspaceId") }?.text("name") ?: maintenance.text("workspaceId") ?: "—"}")
            Text("Provider · ${maintenance.text("provider") ?: "local-vllm"}")
            Text("${maintenance.number("dailyRunLimit") ?: 8} runs a day")
            Text("Look back · ${when { maintenance["lookbackDays"] == JsonNull -> "All history"; maintenance.number("lookbackDays") == 0 -> "From now on"; else -> "Last ${maintenance.number("lookbackDays") ?: 14} days" }}")
            TextButton(onClick = { editing = true }, enabled = enabled) { Text("Edit maintenance…") }
            TextButton(onClick = { ui.write { ui.api.updateSpace(space.text("id")!!, buildJsonObject { putJsonObject("maintenance") { put("enabled", false) } }) } }, enabled = enabled) { Text("Turn off") }
        } else TextButton(onClick = { editing = true }, enabled = enabled, modifier = Modifier.testTag("wiki-maintenance-setup")) { Text("Set up") }
    }
    if (editing) ModalBottomSheet(onDismissRequest = { if (!ui.busy) editing = false }) {
        WikiMaintenanceForm(maintenance, ui) { editing = false }
    }
}

@Composable private fun WikiMaintenanceForm(initial: JsonObject, ui: WikiUi, close: () -> Unit) {
    var workspace by rememberSaveable { mutableStateOf(initial.text("workspaceId")) }
    var provider by rememberSaveable { mutableStateOf(initial.text("provider") ?: "local-vllm") }
    var limit by rememberSaveable { mutableStateOf((initial.number("dailyRunLimit") ?: 8).toString()) }
    var lookback by rememberSaveable { mutableStateOf(when { initial["lookbackDays"] == JsonNull -> "all"; initial.number("lookbackDays") == 0 -> "now"; else -> "days" }) }
    var days by rememberSaveable { mutableStateOf((initial.number("lookbackDays")?.takeIf { it > 0 } ?: 14).toString()) }
    val options = ui.page.extras["options"]
    val workspaces = options?.objects("workspaces").orEmpty()
    val providers = options?.objects("providers").orEmpty().filter { it.text("runtime") == "claude" }
    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        WikiHeading("Maintenance")
        WikiChoice("Workspace", workspace, workspaces.mapNotNull { row -> row.text("id")?.let { it to (row.text("name") ?: it) } }) { workspace = it }
        WikiChoice("Provider", provider, (providers.mapNotNull { row -> row.text("slug")?.let { it to (row.text("name") ?: it) } } + listOf(provider to provider)).distinctBy { it.first }) { provider = it }
        OutlinedTextField(limit, { limit = it }, Modifier.fillMaxWidth().testTag("wiki-daily-limit"), label = { Text("Daily run limit (1–48)") })
        WikiChoice("Look back", lookback, listOf("days" to "Last days", "now" to "From now on", "all" to "All history")) { lookback = it }
        if (lookback == "days") OutlinedTextField(days, { days = it }, Modifier.fillMaxWidth(), label = { Text("Days (1–365)") })
        Text("The first start sets the cursor. Changing this setting does not rewind an existing cursor.", style = MaterialTheme.typography.bodySmall)
        val valid = workspace != null && workspaces.any { it.text("id") == workspace } && limit.toIntOrNull() in 1..48 && (lookback != "days" || days.toIntOrNull() in 1..365)
        Button(onClick = { ui.write {
            ui.api.updateSpace(ui.spaceId!!, buildJsonObject { putJsonObject("maintenance") {
                put("enabled", true); put("workspaceId", workspace); put("provider", provider); put("dailyRunLimit", limit.toInt())
                put("lookbackDays", if (lookback == "all") JsonNull else JsonPrimitive(if (lookback == "now") 0 else days.toInt()))
            } }); close()
        } }, enabled = ui.fresh && !ui.busy && valid, modifier = Modifier.testTag("wiki-settings-save")) { Text(if (initial.flag("enabled")) "Save" else "Turn on") }
        TextButton(onClick = close, enabled = !ui.busy) { Text("Cancel") }
    }
}

@Composable internal fun WikiChoice(label: String, selected: String?, options: List<Pair<String, String>>, choose: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { expanded = true }) { Text("$label · ${options.firstOrNull { it.first == selected }?.second ?: "Choose"}") }
        DropdownMenu(expanded, { expanded = false }) { options.forEach { (value, title) -> DropdownMenuItem(text = { Text(title) }, onClick = { expanded = false; choose(value) }) } }
    }
}
