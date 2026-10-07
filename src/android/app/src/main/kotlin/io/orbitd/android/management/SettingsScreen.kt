package io.orbitd.android.management

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.BuildConfig
import io.orbitd.android.navigation.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Settings' own pages; "workspace" is the workspace list's gear and "runners" the Runners row. */
@Composable
fun SettingsScreen(api: ManagementApi, route: OrbitRoute, revision: Long, open: (OrbitRoute) -> Unit, back: () -> Unit,
    logout: () -> Unit, changed: () -> Unit, workspaceDeleted: () -> Unit, deviceAlerts: () -> Boolean?,
    notifications: @Composable () -> Unit) {
    val runner: (String) -> Unit = { open(OrbitRoute(Destination.RUNNER, it)) }
    when (route.id) {
        "profile" -> EditProfile(api, revision, back)
        "password" -> ChangePassword(api)
        "providers" -> ProviderManagement(api, revision, route.recordId, open, back)
        "workspace" -> WorkspaceSettings(api, route.workspaceId, revision, back, workspaceDeleted, changed)
        "runners" -> RunnersList(api, revision, runner)
        "sharing" -> SharingSettings(api, revision)
        "admin" -> AdminSettings(api, revision)
        "notifications" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            notifications()
            NotificationsPreferences(api, revision)
        }
        else -> SettingsHome(api, revision, open, logout, deviceAlerts)
    }
}

fun settingsTitle(page: String?): String = when (page) {
    "profile" -> "Edit profile"; "password" -> "Change password"; "providers" -> "Providers"
    "workspace" -> "Workspace settings"; "runners" -> "Runners"; "sharing" -> "Shared links"
    "admin" -> "Admin"; "notifications" -> "Notifications"; else -> "Settings"
}

/** SettingsHome: "3 of 4 online" — how many of the account's machines can take work right now. */
internal fun settingsRunnersValue(runners: List<JsonObject>): String =
    if (runners.isEmpty()) "None" else "${runners.count { it.flag("online") }} of ${runners.size} online"

internal fun settingsSharedLinksValue(active: Int): String = if (active > 0) "$active active" else "None"

/** The server as the sign-in screen asked for it: the host, and the port when it is not the scheme's own. */
internal fun settingsInstanceName(server: String): String? = server.toHttpUrlOrNull()?.let {
    if (it.port == HttpUrl.defaultPort(it.scheme)) it.host else "${it.host}:${it.port}"
}

internal fun settingsSignOutTitle(instance: String?) = instance?.let { "Sign out of $it?" } ?: "Sign out?"

/** The account, then SettingsHome's groups, then Sign out and the build — iOS's Settings list. */
@Composable
private fun SettingsHome(api: ManagementApi, revision: Long, open: (OrbitRoute) -> Unit, logout: () -> Unit,
    deviceAlerts: () -> Boolean?) {
    val appearance = LocalAppearanceChanged.current
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val scope = rememberCoroutineScope()
    val user = record.value as? JsonObject
    val preferences = user?.get("preferences") as? JsonObject ?: JsonObject(emptyMap())
    val photo = rememberAccountPhoto(api, user)
    val instance = remember(api) { settingsInstanceName(api.handle.account.server) }
    var runners by remember(api) { mutableStateOf<String?>(null) }
    var sharedLinks by remember(api) { mutableStateOf<String?>(null) }
    var alerts by remember { mutableStateOf(deviceAlerts()) }
    var signingOut by remember { mutableStateOf(false) }
    var resumed by remember { mutableIntStateOf(0) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) resumed++ }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(api, revision, resumed) {
        alerts = deviceAlerts()
        // Each row's value is its own read; only an answer the server gave is shown.
        launch {
            try { runners = settingsRunnersValue(providerObjects(api.get("runners"))) }
            catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
        launch {
            try { sharedLinks = settingsSharedLinksValue(sharingList(api.get("share-links")).list("links").count { it.text("state") == "ACTIVE" }) }
            catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
    }
    fun page(id: String) = open(OrbitRoute(Destination.SETTINGS, id))
    fun preference(key: String, value: JsonPrimitive) {
        scope.launch {
            if (record.mutate { api.patch("users/me/preferences", buildJsonObject { put(key, value) }) } && key == "theme")
                appearance(((record.value as? JsonObject)?.get("preferences") as? JsonObject)?.text("theme")?.ifBlank { null } ?: "system")
        }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        val name = user?.text("name")?.ifBlank { null } ?: user?.text("email").orEmpty()
        Column(Modifier.fillMaxWidth().clickable(enabled = user != null, role = Role.Button) { page("profile") }
            .semantics(mergeDescendants = true) { contentDescription = "Edit profile"; stateDescription = name }
            .padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            AccountAvatar(name, photo, 72.dp)
            Text(name, style = MaterialTheme.typography.titleMedium, maxLines = 1)
        }
        if (record.busy || record.stale || record.error != null) PersonalRecordStatus(record)
        if (alerts == false) Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.secondaryContainer,
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("Notifications are off", style = MaterialTheme.typography.titleMedium)
                    Text("Hear when a session finishes or an agent asks for you.", style = MaterialTheme.typography.bodySmall)
                }
                Button(onClick = { page("notifications") }) { Text("Turn on") }
            }
        }
        SettingsGroup("Sessions") {
            SettingsPicker("Default permission", preferences.text("defaultPermissionMode").ifBlank { "auto" }, personalPermissions,
                record.ready) { preference("defaultPermissionMode", JsonPrimitive(it)) }
            SettingsSwitch("Session orchestration", (preferences["enableOrchestration"] as? JsonPrimitive)?.booleanOrNull != false,
                record.ready) { preference("enableOrchestration", JsonPrimitive(it)) }
        }
        SettingsGroup("Machines & models") {
            SettingsLink("Runners", runners) { page("runners") }
            SettingsLink("Providers") { page("providers") }
        }
        SettingsGroup("Preferences") {
            SettingsLink("Notifications", when (alerts) { true -> "On"; false -> "Off"; null -> "Unavailable" }) { page("notifications") }
            SettingsPicker("Appearance", preferences.text("theme").ifBlank { "system" },
                listOf("system" to "System", "light" to "Light", "dark" to "Dark"), record.ready) { preference("theme", JsonPrimitive(it)) }
        }
        SettingsGroup("Account") {
            SettingsValue("Email", user?.text("email").orEmpty())
            SettingsValue("Instance", instance.orEmpty())
            SettingsLink("Shared links", sharedLinks) { page("sharing") }
            SettingsLink("Change password") { page("password") }
            if (user?.text("role") == "ADMIN") SettingsLink("Admin") { page("admin") }
        }
        Spacer(Modifier.height(20.dp))
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
            ListItem(headlineContent = { Text("Sign out", color = MaterialTheme.colorScheme.error) }, colors = settingsRowColors(),
                modifier = Modifier.clickable(role = Role.Button) { signingOut = true })
        }
        Text("Orbit ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", Modifier.fillMaxWidth().padding(top = 12.dp),
            textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = { open(OrbitRoute(Destination.BUILD)) }, Modifier.align(Alignment.CenterHorizontally)) { Text("Build information") }
    }
    if (signingOut) AlertDialog(onDismissRequest = { signingOut = false }, title = { Text(settingsSignOutTitle(instance)) },
        confirmButton = { TextButton(onClick = { signingOut = false; logout() }) { Text("Sign out", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { signingOut = false }) { Text("Cancel") } })
}

@Composable
private fun settingsRowColors() = ListItemDefaults.colors(containerColor = Color.Transparent)

@Composable
private fun SettingsGroup(title: String, rows: @Composable ColumnScope.() -> Unit) {
    Text(title, Modifier.padding(start = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
        style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Column(content = rows)
    }
}

@Composable
private fun SettingsLink(title: String, value: String? = null, open: () -> Unit) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(),
        trailingContent = value?.let { { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
        modifier = Modifier.clickable(role = Role.Button, onClick = open))
}

@Composable
private fun SettingsValue(title: String, value: String) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(),
        trailingContent = { SelectionContainer { Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant) } })
}

/** A menu on the row itself, as iOS's pickers are; a write goes out only for a different value. */
@Composable
private fun SettingsPicker(title: String, current: String, options: List<Pair<String, String>>, enabled: Boolean, select: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(),
            trailingContent = { Text(options.firstOrNull { it.first == current }?.second ?: current, color = MaterialTheme.colorScheme.onSurfaceVariant) },
            modifier = Modifier.clickable(enabled = enabled, role = Role.DropdownList) { expanded = true })
        DropdownMenu(expanded, { expanded = false }) {
            options.forEach { (value, label) ->
                DropdownMenuItem(text = { Text(label) }, trailingIcon = if (value == current) { { Text("✓") } } else null,
                    onClick = { expanded = false; if (value != current) select(value) })
            }
        }
    }
}

@Composable
private fun SettingsSwitch(title: String, checked: Boolean, enabled: Boolean, change: (Boolean) -> Unit) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(),
        trailingContent = { Switch(checked = checked, onCheckedChange = null, enabled = enabled) },
        modifier = Modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = change))
}
