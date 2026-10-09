package io.orbitd.android.management

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** AgentDefaults.efforts(for:model:catalog:) and Effort.label, for the workspace form's picker. */
internal object WorkspaceEffort {
    private fun static(provider: String) = when (provider) {
        "codex" -> listOf("", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
        "kimi" -> listOf("", "low", "high", "max")
        "opencode" -> listOf("", "minimal", "low", "medium", "high", "xhigh", "max")
        "antigravity" -> listOf("", "low", "medium", "high")
        else -> listOf("", "low", "medium", "high", "xhigh", "max", "ultra")
    }
    private val antigravityAliases = mapOf("none" to "low", "minimal" to "low", "xhigh" to "high", "max" to "high", "ultra" to "high")

    fun label(effort: String) = when (effort) { "" -> "Default"; "xhigh" -> "xHigh"; else -> effort.replaceFirstChar { it.uppercase() } }

    /** The provider's runner-reported levels for its default model; the static list when the catalog has no row. */
    fun options(provider: String, runner: JsonObject?): List<String> {
        if (provider !in setOf("codex", "opencode", "kimi", "antigravity")) return static(provider)
        val model = runner?.obj("runtimeDefaultModels")?.str(provider)
        val row = runner?.obj("modelCatalog")?.list(provider)?.firstOrNull { it.str("value") == model } ?: return static(provider)
        return listOf("") + (row["reasoningLevels"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            .filter { it.isNotEmpty() }.distinct()
    }

    /** normalizeEffort: a level carried across runtimes maps onto the smaller vocabulary. */
    fun normalize(effort: String, provider: String) = when (provider) {
        "kimi" -> when (effort) { "minimal" -> "low"; "medium" -> "high"; "xhigh" -> "max"; else -> effort }
        "antigravity" -> antigravityAliases[effort] ?: effort
        else -> effort
    }
}

/**
 * The workspace edit form (iOS AgentSettingsSheet / AgentFormContent): name, effort, enabled, instructions,
 * working directory, smart model selection for task runs, a read-only environment, and Delete. Cancel writes
 * nothing; Done saves only when something changed and the name is not blank. Blank instructions or path
 * mean "unchanged", as on iOS and the web.
 */
@Composable
fun WorkspaceSettings(api: ManagementApi, workspaceId: String?, revision: Long, done: () -> Unit, deleted: () -> Unit, changed: () -> Unit) {
    val id = workspaceId ?: return
    // The record as this opening of the form found it (iOS prefill): the fields start from it and Done compares with it,
    // so a change made elsewhere meanwhile is neither shown as an edit here nor written back over.
    var prefill by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var runner by remember(id) { mutableStateOf<JsonObject?>(null) }
    var failure by remember(id) { mutableStateOf<String?>(null) }
    var saving by remember(id) { mutableStateOf(false) }
    var confirmingDelete by remember(id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(id, revision) {
        try {
            val loaded = api.get("workspaces/$id").jsonObject
            if (prefill == null) prefill = loaded.toString()
            runner = try { providerObjects(api.get("runners")).firstOrNull { ObjectId.same(it.text("id"), loaded.text("runnerId")) } }
                catch (e: CancellationException) { throw e } catch (_: Exception) { null }
            failure = null
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { failure = personalFailure(e) }
    }
    val saved = remember(prefill) { prefill?.let { Json.parseToJsonElement(it).jsonObject } }
    if (saved == null) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(failure ?: "Loading…", color = Ink.muted)
        }
        return
    }
    val provider = saved.str("lastProvider") ?: saved.str("provider") ?: "claude"
    val prefilledEffort = WorkspaceEffort.normalize(saved.str("effort").orEmpty(), provider)
    var name by rememberSaveable(id) { mutableStateOf(saved.text("name")) }
    var effort by rememberSaveable(id) { mutableStateOf(prefilledEffort) }
    var instructions by rememberSaveable(id) { mutableStateOf(saved.text("appendSystemPrompt")) }
    var workDir by rememberSaveable(id) { mutableStateOf(saved.text("workDir")) }
    var enabled by rememberSaveable(id) { mutableStateOf(saved.bool("enabled") ?: true) }
    var modelRouting by rememberSaveable(id) { mutableStateOf(saved.bool("modelRouting") ?: false) }
    val dirty = name != saved.text("name") || effort != prefilledEffort || instructions != saved.text("appendSystemPrompt") ||
        workDir != saved.text("workDir") || enabled != (saved.bool("enabled") ?: true) || modelRouting != (saved.bool("modelRouting") ?: false)
    val options = WorkspaceEffort.options(provider, runner).let { if (effort in it) it else listOf(effort) + it }
    fun commit() {
        if (!dirty || name.isBlank()) { done(); return }
        saving = true; failure = null
        scope.launch {
            try {
                api.patch("workspaces/$id", workspacePatch(saved, name, effort, instructions, workDir, enabled, modelRouting))
                changed(); done()
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { failure = personalFailure(e) }
            finally { saving = false }
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = done, enabled = !saving) { Text("Cancel") }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = ::commit, enabled = !saving) { Text("Done") }
        }
        failure?.let { Text(it, color = Ink.red, style = MaterialTheme.typography.labelMedium) }
        FormSection {
            OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().padding(vertical = 6.dp), label = { Text("Name") },
                placeholder = { Text("e.g. tea-cli builder") }, singleLine = true)
            var expanded by remember { mutableStateOf(false) }
            Box {
                Row(Modifier.fillMaxWidth().clickable(role = Role.DropdownList) { expanded = true }.padding(vertical = 12.dp)) {
                    Text("Effort", Modifier.weight(1f)); Text(WorkspaceEffort.label(effort), color = Ink.muted)
                }
                DropdownMenu(expanded, { expanded = false }) {
                    options.forEach { value ->
                        DropdownMenuItem(text = { Text(WorkspaceEffort.label(value)) }, trailingIcon = if (value == effort) { { Text("✓") } } else null,
                            onClick = { expanded = false; effort = value })
                    }
                }
            }
            HorizontalDivider()
            Row(Modifier.fillMaxWidth().toggleable(enabled, role = Role.Switch) { enabled = it }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Enabled", Modifier.weight(1f)); Switch(checked = enabled, onCheckedChange = null)
            }
        }
        FormSection("Instructions") {
            OutlinedTextField(instructions, { instructions = it }, Modifier.fillMaxWidth().heightIn(min = 90.dp).padding(vertical = 6.dp))
            Text("Added to this agent's system prompt on every run (optional).", style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        }
        FormSection("Working directory") {
            OutlinedTextField(workDir, { workDir = it }, Modifier.fillMaxWidth().padding(vertical = 6.dp), label = { Text("Path") },
                placeholder = { Text("/path/to/project on the runner (optional)") }, singleLine = true)
        }
        // Off by default, and only the owner's to turn on (docs/model-routing-design.md §7.2). With the account's switch off the
        // Agent has no switch of its own; its stored value is left alone, since Done sends it only when it moved (iOS 9fb3ae6ee).
        if (LocalSmartSelection.current) FormSection("Task runs") {
            Row(Modifier.fillMaxWidth().toggleable(modelRouting, role = Role.Switch) { modelRouting = it }.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("Smart model selection for tasks")
                    Text("Task runs use the model and effort of the tier suggested for the task, and go one tier up after a " +
                        "failed run. Tasks with no suggestion start on this Agent's model. A model pinned on a task always " +
                        "wins. Sessions you open yourself are not affected.", style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                }
                Switch(checked = modelRouting, onCheckedChange = null)
            }
        }
        val env = (saved["env"] as? JsonObject)?.entries?.sortedBy { it.key }.orEmpty()
        if (env.isNotEmpty()) FormSection("Environment") {
            env.forEach { (key, value) ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                    Text(key, Modifier.weight(1f)); SelectionContainer { Text((value as? JsonPrimitive)?.contentOrNull.orEmpty(), color = Ink.muted) }
                }
            }
            Text("Env editing is coming in a follow-up.", style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        }
        FormSection {
            TextButton(onClick = { confirmingDelete = true }, enabled = !saving) { Text("Delete agent", color = Ink.red) }
        }
        Spacer(Modifier.height(48.dp))
    }
    if (confirmingDelete) AlertDialog(onDismissRequest = { confirmingDelete = false }, title = { Text("Delete ${saved.text("name")}?") },
        text = { Text("This removes the workspace from your Workspaces list. Its sessions are kept.") }, confirmButton = {
            TextButton(onClick = {
                confirmingDelete = false
                scope.launch {
                    try { api.delete("workspaces/$id"); changed(); deleted() }
                    catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e) }
                }
            }) { Text("Delete agent", color = Ink.red) }
        }, dismissButton = { TextButton(onClick = { confirmingDelete = false }) { Text("Cancel") } })
}

/** UpdateAgentRequest as iOS sends it: name trimmed, effort and enabled always, the rest only when they mean a change. */
internal fun workspacePatch(saved: JsonObject, name: String, effort: String, instructions: String, workDir: String,
                            enabled: Boolean, modelRouting: Boolean) = buildJsonObject {
    put("name", name.trim())
    if (instructions.isNotEmpty()) put("appendSystemPrompt", instructions)
    put("effort", effort)
    if (workDir.isNotEmpty()) put("workDir", workDir)
    put("enabled", enabled)
    if (modelRouting != (saved.bool("modelRouting") ?: false)) put("modelRouting", modelRouting)
}
