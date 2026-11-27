package io.orbitd.android.management

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import io.orbitd.android.cards.LocalSettingsAnchor
import io.orbitd.android.cards.SettingChangedLine
import io.orbitd.android.cards.settingRow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.BuildConfig
import io.orbitd.android.R
import io.orbitd.android.core.promptoptimizer.PromptOptimizer
import io.orbitd.android.core.promptoptimizer.PromptOptimizerCopy
import io.orbitd.android.core.translation.Translation
import io.orbitd.android.composer.ManagementGithub
import io.orbitd.android.navigation.*
import io.orbitd.android.translation.TranslationCopy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** Settings' own pages; "workspace" is the workspace list's gear, "profile" the header's edit card and "account" the Profile row's page;
 * "machines" and "providers" are the two halves of the Machines & models page, whose pool and key pages ("machines-and-models" with a
 * record) are one push further. */
@Composable
fun SettingsScreen(api: ManagementApi, route: OrbitRoute, revision: Long, open: (OrbitRoute) -> Unit, back: () -> Unit,
    logout: () -> Unit, changed: () -> Unit, workspaceDeleted: () -> Unit, deviceAlerts: () -> Boolean?,
    notifications: @Composable () -> Unit, about: @Composable () -> Unit) {
    // An `orbit-settings:` link names the row it opened Settings for (route.recordId): its page scrolls to it and flashes it.
    CompositionLocalProvider(LocalSettingsAnchor provides route.recordId) { SettingsPages(api, route, revision, open, back, logout, changed,
        workspaceDeleted, deviceAlerts, notifications, about) }
}

@Composable
private fun SettingsPages(api: ManagementApi, route: OrbitRoute, revision: Long, open: (OrbitRoute) -> Unit, back: () -> Unit,
    logout: () -> Unit, changed: () -> Unit, workspaceDeleted: () -> Unit, deviceAlerts: () -> Boolean?,
    notifications: @Composable () -> Unit, about: @Composable () -> Unit) {
    when (route.id) {
        "profile" -> EditProfile(api, revision, back)
        "account" -> ProfileSettingsPage(api, revision, open)
        "password" -> ChangePassword(api)
        "machines-and-models" -> MachinesAndModelsSettings(api, revision, route.recordId, open, back)
        "machines" -> MachinesAndModelsPage(api, revision, open, MachinesAndModelsPart.MACHINES)
        "providers" -> MachinesAndModelsPage(api, revision, open, MachinesAndModelsPart.PROVIDERS)
        "sessions" -> SessionSettingsPage(api, revision)
        "workspace" -> WorkspaceSettings(api, route.workspaceId, revision, back, workspaceDeleted, changed, open)
        "sharing" -> SharingSettings(api, revision, open)
        "github" -> GithubSettingsPage(remember(api) { ManagementGithub(api) }, revision)
        "access-tokens" -> AccessTokensSettings(api, revision)
        // The account-wide Terminals page is gone (docs/mocks/terminals-on-machine-page): each machine's page lists its own, so an old
        // route to it opens Machines & models.
        "terminals" -> MachinesAndModelsSettings(api, revision, null, open, back)
        "share" -> route.recordId?.split(':', limit = 2)?.takeIf { it.size == 2 }?.let { (kind, id) -> ShareResourceSettings(api, revision, kind, id) }
        "admin" -> AdminSettings(api, revision, route.recordId, open, back)
        "notifications" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            notifications()
            NotificationsPreferences(api, revision)
        }
        // Android only: the installed version and its updates from GitHub (iOS updates through TestFlight).
        // Build information sits here since the list lost its version line (iOS's Settings has none).
        "about" -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            about()
            TextButton(onClick = { open(OrbitRoute(Destination.BUILD)) }) { Text("Build information") }
        }
        else -> SettingsHome(api, revision, open, logout, deviceAlerts)
    }
}

fun settingsTitle(page: String?, record: String? = null): String = when (page) {
    "share" -> ShareCopy.title(record?.substringBefore(':') ?: "SESSION")
    "profile" -> "Edit profile"; "account" -> SETTINGS_PROFILE; "password" -> "Change password"
    // A pool's page and a DeepSeek key's are titled by its name once read, as iOS titles them.
    "machines-and-models" -> when {
        record?.startsWith("key:") == true -> providerKeyTitle(record.removePrefix("key:"))
        record?.startsWith("cursor-key:") == true -> providerKeyTitle(record.removePrefix("cursor-key:"))
        record != null -> poolTitle(record.substringAfter(':'))
        else -> null
    } ?: MachinesAndModels.TITLE
    "machines" -> MachinesAndModels.MACHINES; "providers" -> SETTINGS_PROVIDERS
    "sessions" -> GENERAL; "workspace" -> "Workspace settings"; "sharing" -> "Shared links"; "access-tokens" -> AccessTokens.TITLE
    "terminals" -> MachinesAndModels.TITLE; "github" -> GithubCopy.TITLE; "admin" -> "Admin"; "notifications" -> "Notifications"; "about" -> "About"; else -> "Settings"
}

/** SettingsHome.runnersValue: "3 of 4 online" — how many of the account's machines can take work right now. */
internal fun settingsRunnersValue(runners: List<JsonObject>): String =
    if (runners.isEmpty()) "None" else "${runners.count { it.flag("online") }} of ${runners.size} online"

internal fun settingsSharedLinksValue(active: Int): String = if (active > 0) "$active active" else "None"

/** SettingsHome.accessTokensValue: "3 active" — the tokens that still work. */
internal fun settingsAccessTokensValue(active: Int): String = if (active > 0) "$active active" else "None"

/** SettingsHome.title(.general): Personal's first row, which opens the account's five session settings, and that page's title (the
 * web nav's label). The route keeps its old id, "sessions". */
internal const val GENERAL = "General"

/** SettingsHome.header(.personal): the one group with a header; Machines and Providers each hold the one row that says the name. */
internal const val SETTINGS_PERSONAL = "Personal"
/** SettingsHome.title(.profile): the row opening the email and Change password, and that page's title. */
internal const val SETTINGS_PROFILE = "Profile"
/** SettingsHome.title(.providers): the row opening the pools' half of the Machines & models page, and that page's title. */
internal const val SETTINGS_PROVIDERS = "Providers"

/** SettingsHome.needsYouValue: "1 needs you", "3 need you" — null with none. */
internal fun settingsNeedsYouValue(count: Int): String? = when { count <= 0 -> null; count == 1 -> "1 needs you"; else -> "$count need you" }

/** SettingsCopy's hints for the Sessions page's other rows, each its row's footer there, in the web Settings page's words. */
internal const val DEFAULT_PERMISSION_HINT = "The mode a new session starts in, unless the composer picks another. Account-wide: the mode is a property of the run, not of the workspace it runs in."
internal const val SESSION_ORCHESTRATION_HINT = "Sessions in every workspace can start and manage other sessions, and manage your agents and runners, through the orbit MCP tools and CLI: create, change and delete agents, install engines on runners and delete them. Off → those tools are hidden and refused."
internal const val SUGGESTED_REPLIES = "Suggested replies"
internal const val SUGGESTED_REPLIES_HINT = "When a Claude turn ends, the empty message box offers what you'd probably type next. Each suggestion is one more request on that session's Claude account."

/** SettingsCopy's smart model selection switch: its name doesn't say what it does, so the web's hint is its footer on the Sessions
 * page. */
internal const val SMART_MODEL_SELECTION = "Route by tier"
internal const val SMART_MODEL_SELECTION_HINT = "Coordinators suggest a tier for each task, and a SubAgent's size sets its own. Task runs and SubAgents run on a model of that tier from your providers. Off: tasks keep their Agent's model and SubAgents their parent session's."

/** UserPreferences.smartModelSelection: off only for an explicit boolean false; absent, or anything else, reads as on. */
internal fun smartModelSelection(preferences: JsonObject?): Boolean =
    (preferences?.get("modelRouting") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull != false

/** SettingsCopy's Optimize For row, directly below Smart model selection (board docs/mocks/routing-mode-account/01-account-wide-optimize-for.png):
 * the account-wide preference `preferences.optimizeFor`, one segmented control for every Agent at once. */
internal const val OPTIMIZE_FOR = "Optimize For"
internal const val OPTIMIZE_FOR_DETAIL = "What to favour when a model is picked at a tier."
internal val OPTIMIZE_FOR_VALUES = listOf("cost", "balance", "intelligence")

/** UserPreferences.optimizeFor: one of cost, balance, intelligence; absent — or a value this build cannot read — means balance. */
internal fun optimizeFor(preferences: JsonObject?): String =
    preferences?.str("optimizeFor")?.takeIf { it in OPTIMIZE_FOR_VALUES } ?: "balance"

/** SettingsCopy's session recaps switch (SettingsHome.sessionRecaps): what a session list shows instead of the raw last reply. */
internal const val SESSION_RECAPS = "Session recaps"
internal const val SESSION_RECAPS_HINT = "Session lists show the one-line summary the server writes for each conversation, in place of its raw last reply, and the conversation ends with it. Off: the raw last reply, and no summary in the conversation."

/** UserPreferences.showRecaps: on unless the account turned it off; absent — or a value this build cannot read — means on, so
 * only opting out is ever written. */
internal fun sessionRecapsEnabled(preferences: JsonObject?): Boolean =
    (preferences?.get("recaps") as? JsonPrimitive)?.booleanOrNull != false

/** SettingsHome.signOutTitle: no server name — the instance is the app's business, and the account is on the screen behind it. */
internal const val SETTINGS_SIGN_OUT_TITLE = "Sign out?"

/** One preference key written alone, as Settings and its Sessions page write theirs. What the server then has, read back after the
 * write, is what the whole app follows: the theme, smart model selection and session recaps each have a page-wide answer. */
@Composable
private fun rememberPreferenceWrite(api: ManagementApi, record: PersonalRecord): (String, JsonPrimitive) -> Unit {
    val appearance = LocalAppearanceChanged.current
    val smartSelectionChanged = LocalSmartSelectionChanged.current
    val recapsChanged = LocalSessionRecapsChanged.current
    val translationChanged = LocalTranslationChanged.current
    val promptOptimizerChanged = LocalPromptOptimizerChanged.current
    val scope = rememberCoroutineScope()
    return { key, value ->
        scope.launch {
            if (!record.mutate { api.patch("users/me/preferences", buildJsonObject { put(key, value) }) }) return@launch
            val saved = (record.value as? JsonObject)?.get("preferences") as? JsonObject
            when (key) {
                "theme" -> appearance(saved?.text("theme")?.ifBlank { null } ?: "system")
                "modelRouting" -> smartSelectionChanged(smartModelSelection(saved))
                "recaps" -> recapsChanged(sessionRecapsEnabled(saved))
                "translationEnabled", "translationLanguage", "translationAgentLanguage", "translationBilingual" -> translationChanged(AccountTranslation.of(record.value as? JsonObject))
                "promptOptimizer" -> promptOptimizerChanged(PromptOptimizer.isOn(record.value as? JsonObject))
            }
        }
    }
}

/** The account, then SettingsHome's groups — Personal, then Machines, then Providers, the web Settings nav's — then About (Android
 * only: its updates) and Sign out: iOS's Settings list (docs/mocks/ios-settings-web-groups, 1A 2A 3A). */
@Composable
private fun SettingsHome(api: ManagementApi, revision: Long, open: (OrbitRoute) -> Unit, logout: () -> Unit,
    deviceAlerts: () -> Boolean?) {
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val preference = rememberPreferenceWrite(api, record)
    val user = record.value as? JsonObject
    val preferences = user?.get("preferences") as? JsonObject ?: JsonObject(emptyMap())
    val photo = rememberAccountPhoto(api, user)
    // The Machines and Providers rows' values are what their pages' Needs you holds: the machines, and the pools — a Codex one of the
    // account's own with its people and keys, which say whether it can run. Machines' is shown once the machines are read, as on iOS.
    var runners by remember(api) { mutableStateOf<List<JsonObject>?>(null) }
    // Read with the machines: a machine with no coding CLI signed in needs you unless a workspace there runs on a key.
    var workspaces by remember(api) { mutableStateOf<List<JsonObject>>(emptyList()) }
    val machinesAndModels = remember(api) { MachinesAndModelsModel(api) }
    val terminalRequests = rememberLiveTerminalRequests(remember(api) { TerminalRequestStore.of(api) })
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
            try {
                val machines = providerObjects(api.get("runners"))
                workspaces = try { providerObjects(api.get("workspaces")) } catch (e: CancellationException) { throw e } catch (_: Exception) { workspaces }
                runners = machines
            }
            catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
        launch { machinesAndModels.loadPools() }
        launch { machinesAndModels.loadShared() }
        launch {
            try { sharedLinks = settingsSharedLinksValue(sharingLinks(api).count { it.text("state") == "ACTIVE" }) }
            catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
        launch {
            try { accessTokens = settingsAccessTokensValue(AccessTokens.tokens(accessTokenList(api.get("access-tokens")), AccessTokens.Tab.ACTIVE).size) }
            catch (e: CancellationException) { throw e } catch (_: Exception) { }
        }
    }
    fun page(id: String) = open(OrbitRoute(Destination.SETTINGS, id))
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
        SettingsGroup(SETTINGS_PERSONAL) {
            // The account's session settings are a page of their own, as on iOS (SessionSettings).
            SettingsLink(GENERAL, R.drawable.ic_settings) { page("sessions") }
            SettingsLink("Notifications", R.drawable.ic_bell, when (alerts) { true -> "On"; false -> "Off"; null -> "Unavailable" }) { page("notifications") }
            SettingsPicker("Appearance", R.drawable.ic_appearance, preferences.text("theme").ifBlank { "system" },
                listOf("system" to "System", "light" to "Light", "dark" to "Dark"), record.ready,
                Modifier.settingRow("theme")) { preference("theme", JsonPrimitive(it)) }
            SettingChangedLine("theme", user, preference)
            SettingsLink(SETTINGS_PROFILE, R.drawable.ic_person) { page("account") }
            SettingsLink("Shared links", R.drawable.ic_link, sharedLinks) { page("sharing") }
            SettingsLink(AccessTokens.TITLE, R.drawable.ic_key, accessTokens) { page("access-tokens") }
        }
        // Integrations → GitHub, between Personal and Machines as the web's settings nav groups it (docs/github-workspace-design.md §8).
        SettingsGroup(GithubCopy.INTEGRATIONS, footer = GithubCopy.GITHUB_ROW_HINT) {
            SettingsLink(GithubCopy.TITLE, R.drawable.ic_github) { page("github") }
        }
        // No header over either: each group's one row says its name (SettingsHome.header). What needs a person is said in amber.
        val now = System.currentTimeMillis()
        SettingsGroup(null) {
            // Terminals asking to be approved count with the machines (docs/mocks/waiting-on-you-removal/02 ①); there is no Settings ›
            // Terminals row: each machine's page lists its own (docs/mocks/terminals-on-machine-page).
            val needsYou = runners?.let { machinesAndModels.attention(it, workspaces, now).count { item -> item.isMachine } + terminalRequests.size } ?: 0
            SettingsLink(MachinesAndModels.MACHINES, R.drawable.ic_runner, runners?.let { MachinesAndModels.settingsValue(needsYou, it) },
                valueColor = if (needsYou > 0) Ink.amber else null) { page("machines") }
        }
        SettingsGroup(null) {
            // Only once both pool lists have answered, and only what needs you: the pools have no count of their own to show.
            val needsYou = if (machinesAndModels.poolsSettled)
                settingsNeedsYouValue(machinesAndModels.attention(runners.orEmpty(), workspaces, now).count { !it.isMachine }) else null
            SettingsLink(SETTINGS_PROVIDERS, R.drawable.ic_cloud, needsYou, valueColor = Ink.amber) { page("providers") }
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
    }
    if (signingOut) AlertDialog(onDismissRequest = { signingOut = false }, title = { Text(SETTINGS_SIGN_OUT_TITLE) },
        confirmButton = { TextButton(onClick = { signingOut = false; logout() }) { Text("Sign out", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = { signingOut = false }) { Text("Cancel") } })
}

/** iOS's Profile page (ProfileSettingsPage): the email the account signs in with, read-only, and Change password, which opens its page.
 * The name and photo are the header's edit card. */
@Composable
private fun ProfileSettingsPage(api: ManagementApi, revision: Long, open: (OrbitRoute) -> Unit) {
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val user = record.value as? JsonObject
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        if (record.busy || record.stale || record.error != null) PersonalRecordStatus(record)
        SettingsGroup(null) { SettingsValue("Email", R.drawable.ic_mail, user?.text("email").orEmpty()) }
        SettingsGroup(null) { SettingsLink("Change password", R.drawable.ic_password) { open(OrbitRoute(Destination.SETTINGS, "password")) } }
    }
}

/** iOS's General page (SessionSettings): the account's session settings, in iOS's order, each in a group of its own with the
 * web's hint as its footer (docs/mocks/ios-settings-order, 2A), and the account-wide Optimize For below Smart model selection
 * (docs/mocks/routing-mode-account/01-account-wide-optimize-for.png). Each is written alone the moment it moves; absent on the
 * server means on. */
@Composable
private fun SessionSettingsPage(api: ManagementApi, revision: Long) {
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val preference = rememberPreferenceWrite(api, record)
    val preferences = (record.value as? JsonObject)?.get("preferences") as? JsonObject ?: JsonObject(emptyMap())
    fun on(key: String) = (preferences[key] as? JsonPrimitive)?.booleanOrNull != false
    val user = record.value as? JsonObject
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        if (record.busy || record.stale || record.error != null) PersonalRecordStatus(record)
        SettingsGroup(null, footer = DEFAULT_PERMISSION_HINT) {
            SettingsPicker("Default permission", null, preferences.text("defaultPermissionMode").ifBlank { "auto" }, personalPermissions,
                record.ready, Modifier.settingRow("defaultPermissionMode")) { preference("defaultPermissionMode", JsonPrimitive(it)) }
            SettingChangedLine("defaultPermissionMode", user, preference)
        }
        // Settings › Translation (docs/mocks/session-translation, frame 9): one account-wide switch, absent = off, and the language
        // the owner writes and reads in, and the one agents work in, both picked from the one list.
        TranslationGroup(record.value as? JsonObject, record.ready) { key, value -> preference(key, value) }
        SettingsGroup(null, footer = SESSION_ORCHESTRATION_HINT) {
            SettingsSwitch("Session orchestration", on("enableOrchestration"), record.ready, Modifier.settingRow("enableOrchestration")) { preference("enableOrchestration", JsonPrimitive(it)) }
            SettingChangedLine("enableOrchestration", user, preference)
        }
        // On unless the account turned it off; written alone (iOS 9fb3ae6ee).
        SettingsGroup(null, footer = SMART_MODEL_SELECTION_HINT) {
            SettingsSwitch(SMART_MODEL_SELECTION, smartModelSelection(preferences), record.ready, Modifier.settingRow("modelRouting")) { preference("modelRouting", JsonPrimitive(it)) }
            SettingChangedLine("modelRouting", user, preference)
        }
        // Account-wide, one answer for every Agent (docs/mocks/routing-mode-account/01-account-wide-optimize-for.png): absent reads
        // as Balance, and a segment writes the preference alone the moment it moves, as the switch above does. Only smart model
        // selection reads it, so it shows only while that is on (owner, 2026-11-20); the saved value is kept while it is off.
        if (smartModelSelection(preferences)) SettingsGroup(null) {
            ListItem(headlineContent = { Text(OPTIMIZE_FOR) }, colors = settingsRowColors(), modifier = Modifier.settingRow("optimizeFor"),
                supportingContent = { Text(OPTIMIZE_FOR_DETAIL) })
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                OPTIMIZE_FOR_VALUES.forEachIndexed { index, value ->
                    SegmentedButton(selected = optimizeFor(preferences) == value, onClick = { preference("optimizeFor", JsonPrimitive(value)) },
                        enabled = record.ready, shape = SegmentedButtonDefaults.itemShape(index, OPTIMIZE_FOR_VALUES.size), icon = {},
                        // M3's 12dp a side clips "Intelligence" on a 393dp phone.
                        contentPadding = PaddingValues(horizontal = 4.dp)) {
                        Text(value.replaceFirstChar { it.uppercase() }, maxLines = 1)
                    }
                }
            }
            SettingChangedLine("optimizeFor", user, preference)
        }
        // The engine's guess at the next message after a Claude turn (docs/prompt-suggestions-design.md).
        SettingsGroup(null, footer = SUGGESTED_REPLIES_HINT) {
            SettingsSwitch(SUGGESTED_REPLIES, on("promptSuggestions"), record.ready, Modifier.settingRow("promptSuggestions")) { preference("promptSuggestions", JsonPrimitive(it)) }
            SettingChangedLine("promptSuggestions", user, preference)
        }
        // Prompt optimizer (docs/mocks/prompt-optimizer, frame 1): under Suggested replies, off by default; a server without a DeepSeek
        // key draws it disabled with frame 1b's notice (iOS SessionSettings' promptOptimizerSection).
        PromptOptimizerGroup(record.value as? JsonObject, record.ready, undo = preference) { preference("promptOptimizer", JsonPrimitive(it)) }
        // The server's rolling recap on a session's list row (0418). One switch for the whole account, so turning it off holds on
        // the phone and on the web at once — the moment the server has taken the change, the lists behind Settings redraw without it.
        SettingsGroup(null, footer = SESSION_RECAPS_HINT) {
            SettingsSwitch(SESSION_RECAPS, sessionRecapsEnabled(preferences), record.ready, Modifier.settingRow("recaps")) { preference("recaps", JsonPrimitive(it)) }
            SettingChangedLine("recaps", user, preference)
        }
    }
}

/** A row's glyph, in the label colour as iOS draws it. */
@Composable
private fun SettingsIcon(icon: Int) = Icon(painterResource(icon), null, tint = MaterialTheme.colorScheme.onSurface)

@Composable
private fun settingsRowColors() = ListItemDefaults.colors(containerColor = Color.Transparent)

/** A group of rows under its header — none where its one row says the name (SettingsHome.header) — and, where it has one, the line
 * under it (SettingsHome.footer). */
@Composable
private fun SettingsGroup(title: String?, footer: String? = null, rows: @Composable ColumnScope.() -> Unit) {
    if (title != null) {
        Text(title, Modifier.padding(start = 16.dp, top = 20.dp, bottom = 6.dp).semantics { heading() },
            style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    } else {
        Spacer(Modifier.height(20.dp))
    }
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Column(content = rows)
    }
    footer?.let { Text(it, Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp), style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

@Composable
private fun SettingsLink(title: String, icon: Int, value: String? = null, valueColor: Color? = null, open: () -> Unit) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(), leadingContent = { SettingsIcon(icon) },
        trailingContent = value?.let { { Text(it, color = valueColor ?: MaterialTheme.colorScheme.onSurfaceVariant) } },
        modifier = Modifier.clickable(role = Role.Button, onClick = open))
}

@Composable
private fun SettingsValue(title: String, icon: Int, value: String) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(), leadingContent = { SettingsIcon(icon) },
        trailingContent = { SelectionContainer { Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant) } })
}

/** A menu on the row itself, as iOS's pickers are; a write goes out only for a different value. No glyph on the Sessions page, as
 * iOS draws none there. */
@Composable
private fun SettingsPicker(title: String, icon: Int?, current: String, options: List<Pair<String, String>>, enabled: Boolean,
    modifier: Modifier = Modifier, select: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier) {
        ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(), leadingContent = icon?.let { { SettingsIcon(it) } },
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

/** The Sessions page's switch: the row is the switch, its hint the group's footer. */
@Composable
private fun SettingsSwitch(title: String, checked: Boolean, enabled: Boolean, modifier: Modifier = Modifier, change: (Boolean) -> Unit) {
    ListItem(headlineContent = { Text(title) }, colors = settingsRowColors(),
        trailingContent = { Switch(checked = checked, onCheckedChange = null, enabled = enabled) },
        modifier = modifier.toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = change))
}

/**
 * The Sessions page's Translation group (board frame 9; web SettingsPage's Translation card, iOS SessionSettings' Translation
 * section): the switch with what it does under it — naming the agent language — then Your language and Agents work in, each a
 * bottom sheet over the one shared list (Translation.LANGUAGES). A server without a DeepSeek key cannot translate ([user]'s `translationAvailable`): every row is drawn disabled under
 * frame 2's notice, whatever the preference says. Each row is written alone the moment it moves.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TranslationGroup(user: JsonObject?, ready: Boolean, write: (String, JsonPrimitive) -> Unit) {
    val preferences = user?.get("preferences") as? JsonObject
    val unavailable = user != null && !Translation.available(user)
    val enabled = ready && !unavailable
    val language = Translation.language(preferences)
    val agentLanguage = Translation.agentLanguage(preferences)
    // Which picker's sheet is open: the preference key it writes, or null.
    var picking by remember { mutableStateOf<String?>(null) }
    SettingsGroup(TranslationCopy.TITLE, footer = TranslationCopy.BILINGUAL_FOOTER + " " + TranslationCopy.FOOTER) {
        val on = !unavailable && Translation.enabled(preferences)
        ListItem(headlineContent = { Text(TranslationCopy.TRANSLATE_CONVERSATIONS) }, colors = settingsRowColors(),
            supportingContent = { Text(TranslationCopy.translateConversationsHint(agentLanguage)) },
            trailingContent = { Switch(checked = on, onCheckedChange = null, enabled = enabled) },
            modifier = Modifier.settingRow("translationEnabled").toggleable(value = on, enabled = enabled, role = Role.Switch) { write("translationEnabled", JsonPrimitive(it)) })
        SettingChangedLine("translationEnabled", user, write)
        if (unavailable) Text(TranslationCopy.UNAVAILABLE, Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(8.dp)).padding(10.dp).testTag("translation-unavailable"),
            color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
        ListItem(headlineContent = { Text(TranslationCopy.YOUR_LANGUAGE) }, colors = settingsRowColors(),
            supportingContent = { Text(Translation.name(language)) },
            modifier = Modifier.settingRow("translationLanguage").clickable(enabled = enabled, role = Role.DropdownList) { picking = "translationLanguage" }.alpha(if (unavailable) 0.5f else 1f))
        SettingChangedLine("translationLanguage", user, write)
        ListItem(headlineContent = { Text(TranslationCopy.AGENTS_WORK_IN) }, colors = settingsRowColors(),
            supportingContent = { Text(Translation.name(agentLanguage)) },
            modifier = Modifier.settingRow("translationAgentLanguage").clickable(enabled = enabled, role = Role.DropdownList) { picking = "translationAgentLanguage" }.alpha(if (unavailable) 0.5f else 1f))
        SettingChangedLine("translationAgentLanguage", user, write)
        // "Show both languages" (02-bilingual.png, mark A): only while translation is on.
        if (on) {
            val both = Translation.bilingual(preferences)
            ListItem(headlineContent = { Text(TranslationCopy.SHOW_BOTH_LANGUAGES) }, colors = settingsRowColors(),
                trailingContent = { Switch(checked = both, onCheckedChange = null, enabled = enabled) },
                modifier = Modifier.testTag("translation-bilingual").settingRow("translationBilingual")
                    .toggleable(value = both, enabled = enabled, role = Role.Switch) { write("translationBilingual", JsonPrimitive(it)) })
            SettingChangedLine("translationBilingual", user, write)
        }
    }
    val key = picking ?: return
    val (title, current) = if (key == "translationAgentLanguage") TranslationCopy.AGENTS_WORK_IN to agentLanguage else TranslationCopy.YOUR_LANGUAGE to language
    ModalBottomSheet(onDismissRequest = { picking = null }) {
        Text(title, Modifier.padding(horizontal = 24.dp, vertical = 8.dp).semantics { heading() },
            style = MaterialTheme.typography.titleMedium)
        Column(Modifier.selectableGroup().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            Translation.LANGUAGES.forEach { (value, name) ->
                Row(Modifier.fillMaxWidth().selectable(value == current, role = Role.RadioButton) {
                    picking = null
                    if (value != current) write(key, JsonPrimitive(value))
                }.padding(horizontal = 24.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = value == current, onClick = null)
                    Text(name, Modifier.padding(start = 16.dp))
                }
            }
        }
    }
}

/**
 * The Sessions page's Prompt optimizer group (board frames 1 and 1b; iOS SessionSettings' promptOptimizerSection): one account-wide
 * switch, absent = on (only false turns it off), with what it does as the group's footer. A server without a DeepSeek key ([user]'s `promptOptimizerAvailable`
 * false) draws it off and disabled with the notice under it, whatever the preference says. No NEW badge.
 */
@Composable
internal fun PromptOptimizerGroup(user: JsonObject?, ready: Boolean, undo: (String, JsonPrimitive) -> Unit = { _, _ -> }, write: (Boolean) -> Unit) {
    val unavailable = PromptOptimizer.unavailable(user)
    val enabled = ready && !unavailable
    val on = !unavailable && PromptOptimizer.enabled(user?.get("preferences") as? JsonObject)
    SettingsGroup(null, footer = PromptOptimizerCopy.HINT) {
        ListItem(headlineContent = { Text(PromptOptimizerCopy.TITLE) }, colors = settingsRowColors(),
            trailingContent = { Switch(checked = on, onCheckedChange = null, enabled = enabled) },
            modifier = Modifier.testTag("settings-prompt-optimizer").settingRow("promptOptimizer").toggleable(value = on, enabled = enabled, role = Role.Switch, onValueChange = write))
        SettingChangedLine("promptOptimizer", user, undo)
        if (unavailable) Text(PromptOptimizerCopy.UNAVAILABLE, Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)
            .testTag("prompt-optimizer-unavailable"), color = Ink.amber, style = MaterialTheme.typography.bodySmall)
    }
}
