package io.orbitd.android.management

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
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
import io.orbitd.android.R
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
    notifications: @Composable () -> Unit, about: @Composable () -> Unit) {
    val runner: (String) -> Unit = { open(OrbitRoute(Destination.RUNNER, it)) }
    when (route.id) {
        "profile" -> EditProfile(api, revision, back)
        "password" -> ChangePassword(api)
        "providers" -> ProviderManagement(api, revision, route.recordId, open, back)
        "workspace" -> WorkspaceSettings(api, route.workspaceId, revision, back, workspaceDeleted, changed)
        "runners" -> RunnersList(api, revision, runner)
        "sharing" -> SharingSettings(api, revision)
        "access-tokens" -> AccessTokensSettings(api, revision)
        "share" -> route.recordId?.split(':', limit = 2)?.takeIf { it.size == 2 }?.let { (kind, id) -> ShareResourceSettings(api, revision, kind, id) }
        "admin" -> AdminSettings(api, revision, route.recordId, open, back)
        "notifications" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            notifications()
            NotificationsPreferences(api, revision)
        }
        // Android only: the installed version and its updates from GitHub (iOS updates through TestFlight).
        "about" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) { about() }
        else -> SettingsHome(api, revision, open, logout, deviceAlerts)
    }
}

fun settingsTitle(page: String?, record: String? = null): String = when (page) {
    "share" -> ShareCopy.title(record?.substringBefore(':') ?: "SESSION")
    "profile" -> "Edit profile"; "password" -> "Change password"
    "providers" -> record?.takeIf { it.startsWith("key:") }?.let { providerKeyTitle(it.removePrefix("key:")) } ?: "Providers"
    "workspace" -> "Workspace settings"; "runners" -> "Runners"; "sharing" -> "Shared links"; "access-tokens" -> AccessTokens.TITLE
    "admin" -> "Admin"; "notifications" -> "Notifications"; "about" -> "About"; else -> "Settings"
}

/** SettingsHome: "3 of 4 online" — how many of the account's machines can take work right now. */
internal fun settingsRunnersValue(runners: List<JsonObject>): String =
    if (runners.isEmpty()) "None" else "${runners.count { it.flag("online") }} of ${runners.size} online"

internal fun settingsSharedLinksValue(active: Int): String = if (active > 0) "$active active" else "None"

/** SettingsHome.accessTokensValue: "3 active" — the tokens that still work. */
internal fun settingsAccessTokensValue(active: Int): String = if (active > 0) "$active active" else "None"

/** The server as the sign-in screen asked for it: the host, and the port when it is not the scheme's own. */
internal fun settingsInstanceName(server: String): String? = server.toHttpUrlOrNull()?.let {
    if (it.port == HttpUrl.defaultPort(it.scheme)) it.host else "${it.host}:${it.port}"
}

/** SettingsHome.signOutTitle: no server name — the instance is the app's business, and the account is on the screen behind it. */
internal const val SETTINGS_SIGN_OUT_TITLE = "Sign out?"

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
    var accessTokens by remember(api) { mutableStateOf<String?>(null) }
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
        launch {
            try { accessTokens = settingsAccessTokensValue(AccessTokens.tokens(accessTokenList(api.get("access-tokens")), AccessTokens.Tab.ACTIVE).size) }
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
            Box {
                AccountAvatar(name, photo, 72.dp)
                // EditBadge: a grey disc rimmed in the page's colour, set into the avatar's corner.
                Surface(Modifier.align(Alignment.BottomEnd).offset(x = 4.dp, y = 2.dp).size(30.dp), shape = CircleShape,
                    color = MaterialTheme.colorScheme.surfaceVariant, border = BorderStroke(2.dp, MaterialTheme.colorScheme.background)) {
                    Icon(painterResource(R.drawable.ic_edit), null, Modifier.padding(7.dp))
                }
            }
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
            SettingsPicker("Default permission", R.drawable.ic_permission, preferences.text("defaultPermissionMode").ifBlank { "auto" }, personalPermissions,
                record.ready) { preference("defaultPermissionMode", JsonPrimitive(it)) }
            SettingsSwitch("Session orchestration", R.drawable.ic_orchestration, (preferences["enableOrchestration"] as? JsonPrimitive)?.booleanOrNull != false,
                record.ready) { preference("enableOrchestration", JsonPrimitive(it)) }
            // The engine's guess at the next message after a Claude turn (docs/prompt-suggestions-design.md); absent means on.
            SettingsSwitch("Suggested replies", R.drawable.ic_suggestion, (preferences["promptSuggestions"] as? JsonPrimitive)?.booleanOrNull != false,
                record.ready) { preference("promptSuggestions", JsonPrimitive(it)) }
        }
        SettingsGroup("Machines & models") {
            SettingsLink("Runners", R.drawable.ic_runner, runners) { page("runners") }
            SettingsLink("Providers", R.drawable.ic_provider) { page("providers") }
        }
        SettingsGroup("Preferences") {
            SettingsLink("Notifications", R.drawable.ic_bell, when (alerts) { true -> "On"; false -> "Off"; null -> "Unavailable" }) { page("notifications") }
            SettingsPicker("Appearance", R.drawable.ic_appearance, preferences.text("theme").ifBlank { "system" },
                listOf("system" to "System", "light" to "Light", "dark" to "Dark"), record.ready) { preference("theme", JsonPrimitive(it)) }
        }
        SettingsGroup("Account") {
            SettingsValue("Email", R.drawable.ic_mail, user?.text("email").orEmpty())
            SettingsValue("Instance", R.drawable.ic_globe, instance.orEmpty())
            SettingsLink("Shared links", R.drawable.ic_link, sharedLinks) { page("sharing") }
            SettingsLink(AccessTokens.TITLE, R.drawable.ic_key, accessTokens) { page("access-tokens") }
            SettingsLink("Change password", R.drawable.ic_password) { page("password") }
            if (user?.text("role") == "ADMIN") SettingsLink("Admin", R.drawable.ic_admin) { page("admin") }
        }
        Spacer(Modifier.height(20.dp))
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
            SettingsLink("About", R.drawable.ic_info, BuildConfig.VERSION_NAME) { page("about") }
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
    if (signingOut) AlertDialog(onDismissRequest = { signingOut = false }, title = { Text(SETTINGS_SIGN_OUT_TITLE) },
        confirmButton = { TextButton(onClick = { signingOut = false; logout() }) { Text("Sign out", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { signingOut = false }) { Text("Cancel") } })
}

/** A row's glyph, in the label colour as iOS draws it. */
@Composable
private fun SettingsIcon(icon: Int) = Icon(painterResource(icon), null, tint = MaterialTheme.colorScheme.onSurface)

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
private fun SettingsLink(title: String, icon: Int, value: String? = null, open: () -> Unit) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(), leadingContent = { SettingsIcon(icon) },
        trailingContent = value?.let { { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
        modifier = Modifier.clickable(role = Role.Button, onClick = open))
}

@Composable
private fun SettingsValue(title: String, icon: Int, value: String) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(), leadingContent = { SettingsIcon(icon) },
        trailingContent = { SelectionContainer { Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant) } })
}

/** A menu on the row itself, as iOS's pickers are; a write goes out only for a different value. */
@Composable
private fun SettingsPicker(title: String, icon: Int, current: String, options: List<Pair<String, String>>, enabled: Boolean, select: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(), leadingContent = { SettingsIcon(icon) },
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
private fun SettingsSwitch(title: String, icon: Int, checked: Boolean, enabled: Boolean, change: (Boolean) -> Unit) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(), leadingContent = { SettingsIcon(icon) },
        trailingContent = { Switch(checked = checked, onCheckedChange = null, enabled = enabled) },
        modifier = Modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = change))
}
