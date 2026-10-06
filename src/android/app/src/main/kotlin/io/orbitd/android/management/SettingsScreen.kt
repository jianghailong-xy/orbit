package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.orbitd.android.navigation.*
import kotlinx.serialization.json.JsonObject

@Composable
fun SettingsScreen(api: ManagementApi, route: OrbitRoute, revision: Long, open: (OrbitRoute) -> Unit,
    logout: () -> Unit, changed: () -> Unit, notifications: @Composable () -> Unit) {
    val appearance = LocalAppearanceChanged.current
    val runner: (String) -> Unit = { open(OrbitRoute(Destination.RUNNER, it)) }
    when (route.id) {
        "profile" -> PersonalSettings(api, revision, appearance)
        "providers" -> ProviderManagement(api, revision, runner)
        "skills" -> SkillsManagement(api, revision)
        "workspace" -> WorkspaceManagement(api, route.workspaceId, revision, changed, runner)
        "runners" -> RunnerManagement(api, null, revision, changed,
            onWorkspace = { open(OrbitRoute(Destination.SETTINGS, id = "workspace", workspaceId = it)) })
        "sharing" -> SharingSettings(api, revision)
        "admin" -> AdminSettings(api, revision)
        "notifications" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            notifications()
            NotificationsPreferences(api, revision)
        }
        else -> SettingsHome(api, revision, open, logout)
    }
}

@Composable
private fun SettingsHome(api: ManagementApi, revision: Long, open: (OrbitRoute) -> Unit, logout: () -> Unit) {
    val record = remember(api) { PersonalRecord { api.get("users/me") as JsonObject } }
    PersonalRecordLifecycle(record, revision)
    val user = record.value as? JsonObject
    fun page(id: String) { open(OrbitRoute(Destination.SETTINGS, id)) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        user?.let { Text(it.text("name"), style = MaterialTheme.typography.headlineMedium) }
        PersonalRecordStatus(record)
        TextButton(onClick = { page("profile") }) { Text("Edit profile") }
        Text("Sessions", style = MaterialTheme.typography.titleMedium)
        TextButton(onClick = { page("profile") }) { Text("Default permission & session orchestration") }
        Text("Machines & models", style = MaterialTheme.typography.titleMedium)
        TextButton(onClick = { page("runners") }) { Text("Runners") }
        TextButton(onClick = { page("workspace") }) { Text("Manage workspaces") }
        TextButton(onClick = { page("providers") }) { Text("Providers") }
        TextButton(onClick = { page("skills") }) { Text("Skills") }
        Text("Preferences", style = MaterialTheme.typography.titleMedium)
        TextButton(onClick = { page("notifications") }) { Text("Notifications") }
        TextButton(onClick = { page("profile") }) { Text("Appearance") }
        Text("Account", style = MaterialTheme.typography.titleMedium)
        user?.let { Text(it.text("email")) }
        Text(api.handle.account.server)
        TextButton(onClick = { page("sharing") }) { Text("Shared links") }
        TextButton(onClick = { page("profile") }) { Text("Change password") }
        if (record.ready && user?.text("role") == "ADMIN") TextButton(onClick = { page("admin") }) { Text("Admin") }
        TextButton(onClick = { open(OrbitRoute(Destination.BUILD)) }) { Text("Build information") }
        TextButton(onClick = logout) { Text("Sign out") }
    }
}
