package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

internal data class SkillsGroup(val id: String, val title: String, val runner: String,
    val online: Boolean, val shared: Boolean, val skills: List<JsonObject>, val commands: List<JsonObject>)

/** Matches OrbitKit SkillsLogic: owner groups first, host-level Shared last, on every runner. */
internal fun skillsGroups(runners: List<JsonObject>, agents: List<JsonObject>, query: String): List<SkillsGroup> {
    val search = query.trim().lowercase()
    return runners.flatMap { runner ->
        fun matching(name: String) = runner.list(name).filter { item ->
            search.isEmpty() || item.text("name").lowercase().contains(search) || item.text("description").lowercase().contains(search)
        }
        val skills = matching("skills")
        val commands = matching("commands")
        (skills + commands).map { it.text("agentId") }.distinct().map { owner ->
            SkillsGroup("${runner.text("id")}:${owner.ifBlank { "shared" }}",
                if (owner.isBlank()) "Shared" else agents.firstOrNull { ObjectId.same(it.text("id"), owner) }?.text("name") ?: owner,
                runner.text("displayName").ifBlank { runner.text("name") }, runner.flag("online"), owner.isBlank(),
                skills.filter { it.text("agentId") == owner }, commands.filter { it.text("agentId") == owner })
        }
    }.sortedWith(compareBy<SkillsGroup> { it.shared }.thenBy { it.title.lowercase() }.thenBy { it.runner.lowercase() })
}

@Composable
fun SkillsManagement(api: ManagementApi, revision: Long) {
    var runners by remember(api) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var agents by remember(api) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var ready by remember(api) { mutableStateOf(false) }
    var loading by remember(api) { mutableStateOf(false) }
    var error by remember(api) { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val owner = LocalLifecycleOwner.current
    val generation = remember(api) { intArrayOf(0) }
    suspend fun load() {
        val ticket = ++generation[0]
        loading = true
        try {
            val loadedRunners = providerObjects(api.get("runners"))
            val loadedAgents = providerObjects(api.get("agents"))
            if (ticket != generation[0]) return
            runners = loadedRunners; agents = loadedAgents; ready = true; error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            if (ticket == generation[0]) {
                error = providerError(failure)
                if (failure is io.orbitd.android.core.net.ApiError && failure.status in setOf(401, 403, 404)) { runners = emptyList(); agents = emptyList(); ready = false }
            }
        } finally { if (ticket == generation[0]) loading = false }
    }
    DisposableEffect(api, owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) scope.launch { load() }
            if (event == Lifecycle.Event.ON_PAUSE) { generation[0]++; loading = false }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { generation[0]++; owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(api, revision) { load() }
    val groups = skillsGroups(runners, agents, query)
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Skills", style = MaterialTheme.typography.headlineSmall)
            Text("Skills and commands reported by your remote runners.")
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text("Search skills and commands") }, singleLine = true)
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (error != null && runners.isNotEmpty()) Text("Showing earlier runner reports.")
            TextButton({ scope.launch { load() } }, enabled = !loading) { Text("Refresh skills") }
            if (ready && error == null && groups.isEmpty()) Text(if (query.isBlank()) "No skills" else "No matching skills")
        }
        items(groups, key = { it.id }) { group ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("${group.title} · ${group.runner} · ${group.skills.size + group.commands.size}${if (group.online) "" else " · Offline"}", style = MaterialTheme.typography.titleMedium)
                if (!group.online) Text("Last reported on this runner; unavailable while it is offline.")
                (group.skills.map { it to "Skill" } + group.commands.map { it to "Command" }).forEach { (item, kind) ->
                    Text("/${item.text("name")} · $kind")
                    if (item.text("description").isNotBlank()) Text(item.text("description"), style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider()
            }
        }
    }
}
