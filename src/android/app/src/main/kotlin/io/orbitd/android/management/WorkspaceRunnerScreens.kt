package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

private data class WRConfirmation(val explanation: String, val action: suspend () -> Unit)
private typealias WRPerform = (String?, suspend () -> Unit) -> Unit

/** Failed/backgrounded snapshots stay visibly stale; no stale snapshot authorizes a write. */
@Composable
private fun WRPage(api: ManagementApi, identity: String, revision: Long, title: String,
                   load: suspend () -> JsonObject,
                   content: @Composable (JsonObject, Boolean, Long, WRPerform) -> Unit) {
    var data by remember(api, identity) { mutableStateOf<JsonObject?>(null) }
    var error by remember(api, identity) { mutableStateOf<String?>(null) }
    var actionError by remember(api, identity) { mutableStateOf<String?>(null) }
    var busy by remember(api, identity) { mutableStateOf(false) }
    var fresh by remember(api, identity) { mutableStateOf(false) }
    var loadedRevision by remember(api, identity) { mutableStateOf<Long?>(null) }
    var refreshing by remember(api, identity) { mutableStateOf(false) }
    var tick by remember(api, identity) { mutableLongStateOf(System.currentTimeMillis()) }
    var refreshKey by remember(api, identity) { mutableIntStateOf(0) }
    var generation by remember(api, identity) { mutableLongStateOf(0) }
    var confirming by remember(api, identity) { mutableStateOf<WRConfirmation?>(null) }
    var mutation by remember(api, identity) { mutableStateOf<Job?>(null) }
    val owner = LocalLifecycleOwner.current
    var resumed by remember(owner) { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    val scope = rememberCoroutineScope()
    val latestLoad by rememberUpdatedState(load)
    DisposableEffect(owner, api, identity) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) { resumed = true; refreshKey++ }
            if (event == Lifecycle.Event.ON_PAUSE) { generation++; resumed = false; fresh = false; confirming = null; mutation?.cancel() }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(api, identity, revision, refreshKey, resumed) {
        fresh = false
        if (!resumed) return@LaunchedEffect
        generation++
        while (true) {
            if (!busy) {
                val readGeneration = generation
                refreshing = true
                try {
                    val loaded = latestLoad()
                    if (readGeneration == generation && resumed && !busy) {
                        data = loaded; error = null; loadedRevision = revision; fresh = true
                    }
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) {
                    fresh = false
                    if (failure is RunnerUnavailable || failure is ApiError && failure.status in setOf(401, 403, 404)) data = null
                    error = if (failure is IllegalStateException) failure.message else directoryError(failure)
                } finally { refreshing = false }
            }
            tick = System.currentTimeMillis()
            delay(10_000)
        }
    }
    fun perform(action: suspend () -> Unit) {
        if (busy || !fresh || !resumed || loadedRevision != revision) return
        generation++; busy = true; fresh = false; actionError = null
        mutation = scope.launch {
            try { action(); error = null }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (failure: Exception) {
                if (failure is RunnerUnavailable || failure is ApiError && failure.status in setOf(401, 403, 404)) data = null
                actionError = when {
                    failure is ApiError && failure.status in setOf(400, 409) && failure.messages.isNotEmpty() -> failure.messages.joinToString("\n")
                    failure is IllegalStateException || failure is IllegalArgumentException -> failure.message
                    else -> directoryError(failure)
                }
            } finally { busy = false; refreshKey++ }
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, style = MaterialTheme.typography.headlineSmall)
        TextButton(onClick = { fresh = false; refreshKey++ }, enabled = !busy) { Text("Refresh") }
        if (busy || refreshing) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        actionError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (!fresh && data != null) Text("Status needs refreshing. Management actions are disabled.")
        data?.let { snapshot ->
            content(snapshot, fresh && !busy && resumed && loadedRevision == revision, tick) { explanation, action ->
                if (explanation == null) perform(action) else confirming = WRConfirmation(explanation, action)
            }
        }
    }
    confirming?.let { confirmation ->
        AlertDialog(onDismissRequest = { confirming = null }, title = { Text("Confirm remote management") },
            text = { Text(confirmation.explanation) }, confirmButton = {
                TextButton(onClick = { confirming = null; perform(confirmation.action) }, enabled = fresh && !busy && resumed && loadedRevision == revision) { Text("Confirm") }
            }, dismissButton = { TextButton(onClick = { confirming = null }) { Text("Cancel") } })
    }
}

@Composable
fun WorkspaceManagement(api: ManagementApi, workspaceId: String?, revision: Long, onChanged: () -> Unit,
                        onRunner: (String) -> Unit = {}) {
    var selected by remember(api, workspaceId) { mutableStateOf(workspaceId) }
    val actions = remember(api) { WorkspaceRunnerActions(api) }
    val id = selected
    if (id == null) {
        WRPage(api, "workspaces", revision, "Workspace settings", load = {
            buildJsonObject { put("items", api.get("workspaces")) }
        }) { data, _, _, _ ->
            if (data.list("items").isEmpty()) Text("No workspaces. Register a workspace on your remote Runner.")
            data.list("items").forEach { workspace ->
                TextButton(onClick = { selected = workspace.text("id") }) { Text(workspace.text("name")) }
            }
        }
    } else {
        WRPage(api, "workspace:$id", revision, "Workspace settings", load = {
            buildJsonObject {
                put("workspace", api.get("workspaces/$id")); put("runners", api.get("runners"))
                put("rules", api.get("workspaces/$id/permission-rules"))
            }
        }) { data, enabled, now, perform ->
            val workspace = data["workspace"]!!.jsonObject
            val runner = data.list("runners").firstOrNull { ObjectId.same(it.text("id"), workspace.text("runnerId")) }
            if (workspaceId == null) TextButton(onClick = { selected = null }) { Text("All workspaces") }
            WorkspaceForm(workspace, runner, enabled) { patch -> perform(null) { api.patch("workspaces/$id", patch); onChanged() } }
            runner?.let {
                TextButton(onClick = { onRunner(it.text("id")) }) { Text("Manage Runner: ${it.text("displayName").ifEmpty { it.text("name") }}") }
            }
            Text("Repository status", style = MaterialTheme.typography.titleMedium)
            val health = workspace["repoHealth"] as? JsonObject
            Text(health?.text("state")?.ifEmpty { "Unknown" } ?: "Unknown — no checkout report")
            health?.text("branch")?.takeIf { it.isNotEmpty() }?.let { Text("Branch: $it") }
            health?.text("root")?.takeIf { it.isNotEmpty() }?.let { Text("Checkout: $it") }
            val cleanup = workspace["repoCleanup"] as? JsonObject
            cleanup?.let { Text("Cleanup: ${it.text("status")} ${it.text("branch")} ${it.text("message")}") }
            if (health?.text("state") in setOf("unmerged", "merge", "rebase", "cherry-pick", "revert")) {
                Button(enabled = enabled && runner != null && WorkspaceRunnerPolicy.remoteRefusal(runner, now) == null && cleanup?.text("status") != "pending", onClick = {
                    perform("Rescue the current checkout onto a branch, abort its interrupted operation, and return it to HEAD on the remote machine?") {
                        actions.cleanUpWorkspace(id); onChanged()
                    }
                }) { Text("Clean up checkout") }
            }
            Text("Standing permission grants", style = MaterialTheme.typography.titleMedium)
            Text("Revoking a grant makes future dispatches ask again. Already running processes retain their current permissions.")
            if (data.list("rules").isEmpty()) Text("No standing grants.")
            data.list("rules").forEach { rule ->
                Text("${rule.text("toolName")} · ${rule.text("ruleContent")}")
                TextButton(enabled = enabled, onClick = {
                    perform("Revoke this workspace's standing permission grant?") {
                        api.delete("workspaces/$id/permission-rules/${rule.text("id")}"); onChanged()
                    }
                }) { Text("Revoke grant") }
            }
            TextButton(enabled = enabled, onClick = {
                perform("Remove ${workspace.text("name")} from your workspace list? Sessions are retained. A workspace coordinating projects cannot be deleted.") {
                    api.delete("workspaces/$id"); selected = null; onChanged()
                }
            }) { Text("Delete workspace") }
        }
    }
}

@Composable
private fun WorkspaceForm(workspace: JsonObject, runner: JsonObject?, enabled: Boolean, save: (JsonObject) -> Unit) {
    val id = workspace.text("id")
    var name by remember(id) { mutableStateOf(workspace.text("name")) }
    var instructions by remember(id) { mutableStateOf(workspace.text("appendSystemPrompt")) }
    var directory by remember(id) { mutableStateOf(workspace.text("workDir")) }
    var effort by remember(id) { mutableStateOf(workspace.text("effort")) }
    var active by remember(id) { mutableStateOf(workspace["enabled"] != JsonPrimitive(false)) }
    var routing by remember(id) { mutableStateOf(workspace.flag("modelRouting")) }
    var routingProviders by remember(id) { mutableStateOf((workspace["modelRoutingProviders"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.toSet()) }
    var codexAccount by remember(id) { mutableStateOf(workspace.text("codexAccount").ifEmpty { null }) }
    var claudeAccount by remember(id) { mutableStateOf(workspace.text("claudeAccount").ifEmpty { null }) }
    var baseline by remember(id) { mutableStateOf(workspace) }
    WRField("Workspace name", name, enabled) { name = it }
    WRField("Instructions", instructions, enabled, singleLine = false) { instructions = it }
    WRField("Working directory on remote Runner", directory, enabled) { directory = it }
    Text("Blank instructions or directory keep the existing value, matching the iOS form.")
    val provider = workspace.text("lastProvider").ifEmpty { "claude" }
    val model = (runner?.get("runtimeDefaultModels") as? JsonObject)?.text(provider).orEmpty()
    val models = (runner?.get("modelCatalog") as? JsonObject)?.list(provider).orEmpty()
    val reported = (models.firstOrNull { it.text("value") == model }?.get("reasoningLevels") as? JsonArray)
        .orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    val options = (listOf("") + reported + effort).distinct()
    Text("Default reasoning effort")
    options.forEach { value ->
        Row { RadioButton(selected = effort == value, enabled = enabled, onClick = { effort = value },
            modifier = Modifier.semantics { contentDescription = "Default reasoning effort: ${value.ifEmpty { "Model default" }}" }); Text(value.ifEmpty { "Model default" }) }
    }
    if (reported.isEmpty()) Text("Runner has not reported reasoning choices for $provider. Current effort is preserved.")
    WRToggle("Enabled", active, enabled) { active = it }
    WRToggle("Smart model selection for task runs", routing, enabled) { routing = it }
    Text("Additional engines permitted for smart selection")
    listOf("claude", "codex").forEach { runtime ->
        WRToggle(runtime, runtime in routingProviders, enabled && routing) { checked ->
            routingProviders = if (checked) routingProviders + runtime else routingProviders - runtime
        }
    }
    Text("Per-session provider and model remain in the composer. Account selection is workspace-wide.")
    WorkspaceAccountChoice("codex", runner, codexAccount, enabled) { codexAccount = it }
    WorkspaceAccountChoice("claude", runner, claudeAccount, enabled) { claudeAccount = it }
    val env = workspace["env"] as? JsonObject
    if (!env.isNullOrEmpty()) {
        Text("Environment (read only)", style = MaterialTheme.typography.titleMedium)
        env.forEach { (key, value) -> SelectionContainer { Text("$key: ${(value as? JsonPrimitive)?.content.orEmpty()}") } }
    }
    val patch = if (name.isBlank()) JsonObject(emptyMap()) else buildJsonObject {
        WorkspaceRunnerPolicy.workspacePatch(baseline, name, instructions, directory, effort, active, routing).forEach { (key, value) -> put(key, value) }
        // An old or removed selection is displayed intact until the user explicitly changes it.
        if (codexAccount != baseline.text("codexAccount").ifEmpty { null }) WorkspaceRunnerPolicy.accountPatch(baseline, "codex", codexAccount).forEach { (key, value) -> put(key, value) }
        if (claudeAccount != baseline.text("claudeAccount").ifEmpty { null }) WorkspaceRunnerPolicy.accountPatch(baseline, "claude", claudeAccount).forEach { (key, value) -> put(key, value) }
        val before = (baseline["modelRoutingProviders"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.toSet()
        if (routingProviders != before) put("modelRoutingProviders", JsonArray(routingProviders.sorted().map(::JsonPrimitive)))
    }
    LaunchedEffect(workspace) {
        if (patch.isNotEmpty() && patch.all { (key, value) -> workspace[key] == value }) baseline = workspace
    }
    val conflicts = patch.keys.filter { workspace[it] != baseline[it] && workspace[it] != patch[it] }
    if (conflicts.isNotEmpty()) Text("These settings changed on another client: ${conflicts.joinToString()}. Reset the draft to server values before editing again.", color = MaterialTheme.colorScheme.error)
    Button(enabled = enabled && name.isNotBlank() && patch.isNotEmpty() && conflicts.isEmpty(), onClick = {
        save(patch)
        // Preserve the draft if the write fails. New server state is read by WRPage.
    }) { Text("Save workspace") }
    TextButton(onClick = {
        baseline = workspace; name = workspace.text("name"); instructions = workspace.text("appendSystemPrompt")
        directory = workspace.text("workDir"); effort = workspace.text("effort")
        active = workspace["enabled"] != JsonPrimitive(false); routing = workspace.flag("modelRouting")
        codexAccount = workspace.text("codexAccount").ifEmpty { null }; claudeAccount = workspace.text("claudeAccount").ifEmpty { null }
        routingProviders = (workspace["modelRoutingProviders"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.toSet()
    }) { Text("Reset draft to server values") }
}

@Composable
private fun WorkspaceAccountChoice(engine: String, runner: JsonObject?, selected: String?, enabled: Boolean, change: (String?) -> Unit) {
    Text("$engine account", style = MaterialTheme.typography.titleMedium)
    val accounts = runner?.list("engines")?.firstOrNull { it.text("engine") == engine }?.list("accounts").orEmpty()
    Row { RadioButton(selected = selected == null, enabled = enabled, onClick = { change(null) },
        modifier = Modifier.semantics { contentDescription = "$engine account: Automatic" }); Text("Automatic — Runner chooses an available account") }
    accounts.forEach { account ->
        val id = account.text("id")
        val paused = runCatching { java.time.Instant.parse(account.text("pausedUntil")).toEpochMilli() > System.currentTimeMillis() }.getOrDefault(false)
        Row {
            RadioButton(selected = selected == id, enabled = enabled && account.text("auth") == "yes" && !paused, onClick = { change(id) },
                modifier = Modifier.semantics { contentDescription = "$engine account: ${account.text("name").ifEmpty { id }}" })
            Text("${account.text("name").ifEmpty { if (id == "default") "Default" else id }} · ${accountAuth(account.text("auth"))}${if (paused) " · Paused" else ""}")
        }
    }
    if (selected != null && accounts.none { it.text("id") == selected }) Text("Selected account $selected is not reported on this Runner. Select Automatic or a signed-in account.")
    if (accounts.isEmpty()) Text("Runner has not reported account slots. No account is assumed to be signed in.")
    if (runner != null && selected != null) RunnerQuota(WorkspaceRunnerPolicy.quota(runner, engine, selected))
}

@Composable
private fun WRField(label: String, value: String, enabled: Boolean, singleLine: Boolean = true, change: (String) -> Unit) {
    OutlinedTextField(value = value, onValueChange = change, label = { Text(label) }, enabled = enabled,
        singleLine = singleLine, modifier = Modifier.fillMaxWidth())
}

@Composable
private fun WRToggle(label: String, value: Boolean, enabled: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, Modifier.weight(1f)); Switch(checked = value, onCheckedChange = change, enabled = enabled,
            modifier = Modifier.semantics { contentDescription = label })
    }
}

@Composable
fun RunnerManagement(api: ManagementApi, runnerId: String?, revision: Long, onChanged: () -> Unit,
                     onWorkspace: (String) -> Unit = {}) {
    var selected by remember(api, runnerId) { mutableStateOf(runnerId) }
    val actions = remember(api) { WorkspaceRunnerActions(api) }
    val id = selected
    if (id == null) {
        WRPage(api, "runners", revision, "Remote Runners", load = { buildJsonObject { put("runners", api.get("runners")) } }) { data, enabled, now, perform ->
            Text("Orbit runs on your remote machines. This phone does not host a Runner.")
            data.list("runners").forEach { runner ->
                TextButton(onClick = { selected = runner.text("id") }) {
                    Text("${runner.text("displayName").ifEmpty { runner.text("name") }} · ${if (WorkspaceRunnerPolicy.remoteRefusal(runner, now) == null) "Online" else "Offline / unavailable"}")
                }
            }
            RunnerEnrollment(api, enabled, perform, onChanged)
        }
    } else {
        WRPage(api, "runner:$id", revision, "Runner management", load = {
            buildJsonObject {
                put("runner", actions.runner(id)); put("login", api.get("runners/$id/login"))
                put("workspaces", api.get("workspaces"))
            }
        }) { data, enabled, now, perform ->
            if (runnerId == null) TextButton(onClick = { selected = null }) { Text("All Runners") }
            val runner = data["runner"]!!.jsonObject
            RunnerDetails(api, actions, runner, data["login"]!!.jsonObject, enabled, now, perform, onChanged) {
                selected = null; onChanged()
            }
            Text("Workspaces on this Runner", style = MaterialTheme.typography.titleMedium)
            data.list("workspaces").filter { ObjectId.same(it.text("runnerId"), id) }.forEach { workspace ->
                TextButton(onClick = { onWorkspace(workspace.text("id")) }) { Text("${workspace.text("name")} · ${workspace.text("workDir")}") }
                (workspace["repoHealth"] as? JsonObject)?.let { health ->
                    Text("${health.text("state")} · ${health.text("branch")}")
                }
                if (workspace.text("workDirFreeBytes").isNotEmpty() && workspace.text("workDirTotalBytes").isNotEmpty())
                    Text("Disk: ${workspace.text("workDirFreeBytes")} free / ${workspace.text("workDirTotalBytes")} total bytes")
            }
        }
    }
}

@Composable
private fun RunnerDetails(api: ManagementApi, actions: WorkspaceRunnerActions, runner: JsonObject, login: JsonObject,
                          enabled: Boolean, now: Long, perform: WRPerform, onChanged: () -> Unit, removed: () -> Unit) {
    val id = runner.text("id")
    var name by remember(id) { mutableStateOf(runner.text("displayName")) }
    var concurrent by remember(id) { mutableStateOf(runner.text("maxConcurrent")) }
    var reserve by remember(id) { mutableStateOf(runner.text("minFreeDiskMb")) }
    var baseline by remember(id) { mutableStateOf(runner) }
    var token by remember(id) { mutableStateOf<String?>(null) }
    var code by remember(id, login.text("status")) { mutableStateOf("") }
    val lifecycle = LocalLifecycleOwner.current
    DisposableEffect(lifecycle, id) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_PAUSE) { token = null; code = "" } }
        lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer) }
    }
    val refusal = WorkspaceRunnerPolicy.remoteRefusal(runner, now)
    val remoteEnabled = enabled && refusal == null
    Text(runner.text("displayName").ifEmpty { runner.text("name") }, style = MaterialTheme.typography.titleLarge)
    Text(refusal ?: "Online")
    Text("${runner.text("activeSessions")} / ${runner.text("maxConcurrent")} sessions active")
    listOf("hostname" to "Host", "version" to "Version", "lastHeartbeatAt" to "Last check-in", "enrolledAt" to "Registered", "reposRoot" to "Repositories folder").forEach { (field, label) ->
        Text("$label: ${runner.text(field).ifEmpty { "Unknown" }}")
    }
    val root = (runner["runsAsRoot"] as? JsonPrimitive)?.booleanOrNull
    Text("Runs as: ${when (root) { true -> "root — Bypass is unavailable"; false -> "regular user"; null -> "Unknown" }}")
    WRField("Display name (blank uses machine name)", name, enabled) { name = it.take(60) }
    WRField("Maximum concurrent sessions (1–64)", concurrent, enabled) { concurrent = it }
    WRField("Keep free (MB; blank removes the floor)", reserve, enabled) { reserve = it }
    val max = concurrent.toIntOrNull()
    val min = reserve.toIntOrNull()
    val settings = buildJsonObject {
        if (name.trim() != baseline.text("displayName")) put("displayName", name.trim())
        if (max != null && max != baseline.text("maxConcurrent").toIntOrNull()) put("maxConcurrent", max)
        if (reserve.isBlank() && baseline.text("minFreeDiskMb").isNotEmpty()) put("minFreeDiskMb", JsonNull)
        else if (min != null && min != baseline.text("minFreeDiskMb").toIntOrNull()) put("minFreeDiskMb", min)
    }
    LaunchedEffect(runner) {
        if (settings.isNotEmpty() && settings.all { (key, value) -> runner[key] == value || key == "displayName" && value == JsonPrimitive("") && runner.text(key).isEmpty() }) baseline = runner
    }
    val settingsConflict = settings.keys.any { runner[it] != baseline[it] && runner[it] != settings[it] }
    if (settingsConflict) Text("Runner settings changed on another client. Reset the draft before editing again.", color = MaterialTheme.colorScheme.error)
    Button(enabled = enabled && !settingsConflict && settings.isNotEmpty() && max != null && max in 1..64 && (reserve.isBlank() || (min != null && min > 0)), onClick = {
        perform(null) {
            actions.runner(id)
            api.patch("runners/$id", settings); onChanged()
        }
    }) { Text("Save Runner settings") }
    TextButton(onClick = {
        baseline = runner; name = runner.text("displayName"); concurrent = runner.text("maxConcurrent"); reserve = runner.text("minFreeDiskMb")
    }) { Text("Reset Runner draft to server values") }
    Text("Capacity and names are server settings and can be saved while the remote machine is offline.")
    Text("Engines", style = MaterialTheme.typography.titleMedium)
    if (runner["engines"] !is JsonArray) Text("This Runner has not reported its engines. Installation and authentication are unknown.")
    runner.list("engines").forEach { engine -> RunnerEngine(api, actions, runner, engine, enabled, now, perform, onChanged) }
    val install = runner["install"] as? JsonObject
    install?.text("status")?.takeIf { it.isNotEmpty() }?.let {
        Text("Engine operation: $it · ${install.text("engine")} ${install.text("message")}")
        if (it in setOf("pending", "running")) {
            TextButton(enabled = enabled, onClick = { perform("Cancel the current engine operation?") { api.delete("runners/$id/install"); onChanged() } }) { Text("Cancel engine operation") }
        }
    }
    Button(enabled = remoteEnabled && install?.text("status") !in setOf("pending", "running"), onClick = {
        perform("Update engine CLIs on this remote machine? Engines in use may be skipped by the Runner.") { actions.remote(id, "engine-update"); onChanged() }
    }) { Text("Update engines now") }
    TextButton(enabled = remoteEnabled, onClick = { perform(null) { actions.remote(id, "refresh-models"); onChanged() } }) { Text("Refresh model lists") }
    (runner["accountRemove"] as? JsonObject)?.takeIf { it.text("status").isNotEmpty() }?.let {
        Text("Account removal: ${it.text("engine")} ${it.text("account")} · ${it.text("status")} ${it.text("message")}")
    }
    if (login.text("status").isNotEmpty()) {
        HorizontalDivider()
        Text("Sign-in: ${login.text("engine")} · ${login.text("status")}", style = MaterialTheme.typography.titleMedium)
        Text(login.text("message"))
        if (login.text("userCode").isNotEmpty()) SelectionContainer { Text("Device code: ${login.text("userCode")}") }
        val uri = LocalUriHandler.current
        val url = login.text("url")
        val safeUrl = runCatching { java.net.URI(url) }.getOrNull()?.let { it.scheme == "https" && !it.host.isNullOrEmpty() && it.userInfo == null } == true
        if (safeUrl) TextButton(onClick = { runCatching { uri.openUri(url) } }) { Text("Open provider sign-in") }
        if (login.text("status") == "awaiting_code") {
            WRField("One-time authorization code", code, remoteEnabled) { code = it }
            Button(enabled = remoteEnabled && code.isNotBlank(), onClick = {
                val submitted = code.trim(); code = ""
                perform(null) {
                    val latest = actions.runner(id)
                    check(WorkspaceRunnerPolicy.remoteRefusal(latest) == null) { WorkspaceRunnerPolicy.remoteRefusal(latest).orEmpty() }
                    api.post("runners/$id/login/code", buildJsonObject { put("code", submitted) }); onChanged()
                }
            }) { Text("Submit code") }
        }
        TextButton(enabled = enabled, onClick = { code = ""; perform(null) { api.delete("runners/$id/login"); onChanged() } }) { Text("Cancel sign-in") }
    }
    HorizontalDivider()
    TextButton(enabled = enabled, onClick = {
        perform("Rotate this Runner's credential? Its old token stops working immediately. Update ~/.orbit/config.json on that machine and restart it. The replacement is shown once.") {
            actions.runner(id)
            val rotated = api.post("runners/$id/rotate-token").jsonObject.text("token")
            if (lifecycle.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) token = rotated
            onChanged()
        }
    }) { Text("Rotate Runner token") }
    token?.let { value ->
        AlertDialog(onDismissRequest = { token = null }, title = { Text("New Runner token — shown once") },
            text = { SelectionContainer { Text(value) } }, confirmButton = { TextButton(onClick = { token = null }) { Text("Close") } })
    }
    TextButton(enabled = enabled, onClick = {
        perform("Remove this Runner and its workspaces from your account? It will no longer authenticate. Register the remote machine again to add it back.") {
            actions.runner(id); api.delete("runners/$id"); removed()
        }
    }) { Text("Remove Runner") }
}

@Composable
private fun RunnerEngine(api: ManagementApi, actions: WorkspaceRunnerActions, runner: JsonObject, health: JsonObject,
                         enabled: Boolean, now: Long, perform: WRPerform, onChanged: () -> Unit) {
    val id = runner.text("id")
    val engine = health.text("engine")
    var expanded by remember(id, engine) { mutableStateOf(false) }
    var adding by remember(id, engine) { mutableStateOf("") }
    val installed = (health["installed"] as? JsonPrimitive)?.booleanOrNull
    val remote = enabled && WorkspaceRunnerPolicy.remoteRefusal(runner, now) == null
    val signIn = enabled && WorkspaceRunnerPolicy.loginRefusal(runner, engine, now) == null
    TextButton(onClick = { expanded = !expanded }) {
        Text("$engine · ${health.text("version").ifEmpty { when (installed) { true -> "Installed"; false -> "Not installed"; null -> "Unknown" } }} · ${accountAuth(health.text("auth"))}")
    }
    if (!expanded) return
    (health["update"] as? JsonObject)?.let { update ->
        Text("Update: ${update.text("status").ifEmpty { "Unknown" }} · ${update.text("at")} ${update.text("message")}")
        if (update.text("behindSince").isNotEmpty()) Text("Behind latest ${update.text("latest")} since ${update.text("behindSince")}")
    }
    if (engine in WorkspaceRunnerPolicy.loginEngines && installed == false) {
        Button(enabled = remote && (engine != "antigravity" || (runner["antigravity"] as? JsonObject)?.flag("supported") == true), onClick = {
            perform("Install $engine on this remote Runner?") { actions.remote(id, "install", engine); onChanged() }
        }) { Text("Install $engine") }
    }
    if (installed == true && engine in WorkspaceRunnerPolicy.loginEngines) {
        val accounts = if (engine in WorkspaceRunnerPolicy.accountEngines) health.list("accounts") else emptyList()
        if (accounts.isEmpty()) {
            Text("Default · ${accountAuth(health.text("auth"))}")
            Button(enabled = signIn, onClick = { perform("Start $engine sign-in on this remote Runner? An existing sign-in attempt will be replaced.") { actions.startLogin(id, engine); onChanged() } }) { Text("Sign in") }
            RunnerQuota(WorkspaceRunnerPolicy.quota(runner, engine, "default"))
        }
        accounts.forEach { account ->
            RunnerAccount(api, actions, runner, engine, account, enabled, now, perform, onChanged)
        }
        if (engine in WorkspaceRunnerPolicy.accountEngines) {
            WRField("New $engine account name", adding, signIn) { adding = it.take(60) }
            Button(enabled = signIn && adding.isNotBlank(), onClick = {
                perform("Sign in a new $engine account on this Runner? An existing sign-in attempt will be replaced.") {
                    actions.startLogin(id, engine, accountName = adding); adding = ""; onChanged()
                }
            }) { Text("Add account") }
        }
        WorkspaceRunnerPolicy.loginRefusal(runner, engine, now)?.let { Text(it) }
    }
    val models = (runner["modelCatalog"] as? JsonObject)?.list(engine).orEmpty()
    Text("Models: ${if (models.isEmpty()) "No catalog reported" else models.joinToString { it.text("label").ifEmpty { it.text("value") } }}")
}

@Composable
private fun RunnerAccount(api: ManagementApi, actions: WorkspaceRunnerActions, runner: JsonObject, engine: String,
                          account: JsonObject, enabled: Boolean, now: Long, perform: WRPerform, onChanged: () -> Unit) {
    val runnerId = runner.text("id")
    val id = account.text("id")
    var name by remember(runnerId, engine, id) { mutableStateOf(account.text("name").ifEmpty { if (id == "default") "Default" else id }) }
    Text("${account.text("name").ifEmpty { id }} · ${accountAuth(account.text("auth"))}")
    account.text("pausedUntil").takeIf { it.isNotEmpty() }?.let { Text("Paused until $it") }
    account.text("fingerprintPrefix").takeIf { it.isNotEmpty() }?.let { Text("Account fingerprint: $it") }
    WRField("Account name", name, enabled) { name = it.take(60) }
    TextButton(enabled = enabled && name.isNotBlank(), onClick = {
        perform(null) { api.patch("runners/$runnerId/accounts/$engine/$id", buildJsonObject { put("name", name.trim()) }); onChanged() }
    }) { Text("Rename account") }
    Button(enabled = enabled && WorkspaceRunnerPolicy.loginRefusal(runner, engine, now) == null, onClick = {
        perform("Sign in $engine account ${account.text("name").ifEmpty { id }} again on this remote Runner?") { actions.startLogin(runnerId, engine, account = id); onChanged() }
    }) { Text(if (account.text("auth") == "yes") "Sign in again" else "Sign in / renew account") }
    Row {
        TextButton(enabled = enabled, onClick = { perform(null) { api.post("runners/$runnerId/accounts/$engine/$id/pause", buildJsonObject { put("durationMinutes", 60) }); onChanged() } }) { Text("Pause 1 hour") }
        TextButton(enabled = enabled && account.text("pausedUntil").isNotEmpty(), onClick = { perform(null) { api.post("runners/$runnerId/accounts/$engine/$id/pause", buildJsonObject { put("durationMinutes", JsonNull) }); onChanged() } }) { Text("Resume account") }
    }
    RunnerQuota(WorkspaceRunnerPolicy.quota(runner, engine, id))
    if (id != "default") {
        val refusal = WorkspaceRunnerPolicy.removalRefusal(runner, engine, id, now)
        TextButton(enabled = enabled && refusal == null, onClick = {
            perform("Remove this account's login directory from the remote machine? Workspaces pinned to this account will need another account.") { actions.removeAccount(runnerId, engine, id); onChanged() }
        }) { Text("Remove account") }
        refusal?.let { Text(it) }
    } else Text("Default is shared with the remote machine's CLI and cannot be removed.")
}

private fun accountAuth(value: String) = when (value) { "yes" -> "Signed in"; "no" -> "Signed out / expired"; else -> "Authentication unknown" }

@Composable
private fun RunnerQuota(snapshot: JsonObject?) {
    if (snapshot == null) { Text("Usage not reported for this account."); return }
    Text("Usage updated: ${snapshot.text("fetchedAt").ifEmpty { "Unknown" }}")
    val blocks = snapshot.list("rateLimits").ifEmpty { listOf(snapshot) }
    blocks.forEach { block ->
        listOf("fiveHour", "sevenDay", "sevenDayOpus", "sevenDaySonnet", "primary", "secondary").forEach { key ->
            (block[key] as? JsonObject)?.let { window ->
                val utilization = (window["utilization"] as? JsonPrimitive)?.doubleOrNull
                if (utilization != null) Text("${block.text("limitName")} ${window.text("label").ifEmpty { key }}: ${utilization.toInt()}% · resets ${window.text("resetsAt").ifEmpty { "Unknown" }}")
            }
        }
    }
}

@Composable
private fun RunnerEnrollment(api: ManagementApi, enabled: Boolean, perform: WRPerform, onChanged: () -> Unit) {
    var code by remember(api) { mutableStateOf("") }
    var lookedUp by remember(api) { mutableStateOf<JsonObject?>(null) }
    val normalized = code.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }.takeIf { it.length == 10 }?.let { "${it.take(5)}-${it.drop(5)}" }
    Text("Add a remote Runner", style = MaterialTheme.typography.titleMedium)
    Text("Run the installer on your remote computer, then approve the code it prints here.")
    val origin = api.handle.account.server.trimEnd('/')
    SelectionContainer { Text("macOS / Linux: curl -fsSL $origin/install.sh | bash\nWindows: irm $origin/install.ps1 | iex") }
    WRField("Remote machine's approval code", code, enabled) { code = it; lookedUp = null }
    TextButton(enabled = enabled && normalized != null, onClick = {
        perform(null) { lookedUp = api.get("runners/device/$normalized").jsonObject }
    }) { Text("Look up machine") }
    lookedUp?.takeIf { it.text("userCode") == normalized }?.let { device ->
        Text("${device.text("name")} · ${device.text("hostname")} · ${device.text("status")}")
        if (device.flag("nameConflict")) Text("This name is already registered. Approval will replace that Runner's credential.", color = MaterialTheme.colorScheme.error)
        Button(enabled = enabled && device.text("status") == "PENDING", onClick = {
            perform("Approve ${device.text("name")} (${device.text("hostname")})?${if (device.flag("nameConflict")) " This replaces the existing Runner's credential." else ""}") {
                api.post("runners/device/$normalized/approve"); lookedUp = null; code = ""; onChanged()
            }
        }) { Text("Approve remote machine") }
    }
}
