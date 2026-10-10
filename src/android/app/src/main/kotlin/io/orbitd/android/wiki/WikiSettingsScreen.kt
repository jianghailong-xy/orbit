package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.toast.OrbitToasts
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

// Wiki settings (iOS `WikiSettingsView.swift`; criterion 8, mock 20): which review mode the space runs in, whether
// Automatic sends spot checks, and the space's Wiki maintenance run — pushed from the Wiki home's gear. The app's own
// settings form: inset-grouped sections, a header and a footer each. The sections are `WikiModeLogic.SettingsSection`
// in its order, which is the web page's; the modes are `WikiModeLogic.modes`; every word is `WikiModeCopy`'s.

/** Where a press on the settings page goes (iOS `WikiSettingsActions`). */
internal class WikiSettingsActions(
    val setMode: (String) -> Unit = {},
    val setSpotChecks: (Boolean) -> Unit = {},
    /** Set up… when maintenance is off, Edit… when it is on: the same sheet. */
    val setUp: () -> Unit = {},
    val turnOff: () -> Unit = {},
)

/** The settings page, drawn from the space as the server kept it. [workspaceLabel]: a workspace's name and runner, by
 * id, when this client holds the workspace. [server]: the deployment's System model while the server executes the
 * account's wiki (mock 35 ①②, P9) — there is then no provider to pick, the workspace reads as where the repository is
 * read from, and one sentence says where the wiki's material goes; nil under runner, which draws what it always did.
 * Every control is off while a write is in flight ([busy]). */
@Composable
internal fun WikiSettingsPage(route: OrbitRoute, space: WikiSpace, workspaceLabel: (String) -> String? = { null },
    server: WikiSystemModelStatus? = null, busy: Boolean = false, actions: WikiSettingsActions = WikiSettingsActions()) {
    val mode = WikiModeLogic.mode(space.settings)
    val maintenance = space.settings?.maintenance ?: WikiMaintenanceSettings.default
    PageBar.Bind(route, WikiModeCopy.settingsTitle)
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-settings-page"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "space") {
            Text(listOfNotNull(space.slug, space.repoUrlNorm).joinToString(" · "), Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp)
                .testTag("wiki-settings-space"), style = WikiType.label, color = WikiPalette.secondary)
        }
        // The space sent itself back to a mode the owner did not choose: say when and why.
        WikiModeLogic.modeFallback(space.settings)?.let { fallback -> item(key = "fallback") { SettingsFallbackBanner(fallback) } }
        WikiModeLogic.SettingsSection.entries.forEach { section ->
            when (section) {
                WikiModeLogic.SettingsSection.REVIEW_MODE -> {
                    item(key = "review-mode-header") { WikiPlanSectionHead(section.title) }
                    item(key = "review-mode") {
                        WikiCard(Modifier.testTag("wiki-settings-review-mode")) {
                            WikiModeLogic.modes.forEach { value ->
                                SettingsModeRow(value, mode, server != null, busy) { if (value != mode) actions.setMode(value) }
                                HorizontalDivider(Modifier.padding(start = 16.dp))
                            }
                            // Automatic's own switch, in the same section, and greyed while another mode is on.
                            val spotChecks = space.settings?.automaticSpotChecks == true
                            val enabled = mode == "automatic" && !busy
                            Row(Modifier.fillMaxWidth().toggleable(spotChecks, enabled = enabled, role = Role.Switch) { actions.setSpotChecks(it) }
                                .padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-settings-spot-checks"), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    Text(WikiModeCopy.spotCheck, style = WikiType.prose,
                                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else 0.38f))
                                    Text(WikiModeCopy.spotCheckNote, style = WikiType.label, color = WikiPalette.secondary)
                                }
                                Spacer(Modifier.width(12.dp))
                                Switch(checked = spotChecks, onCheckedChange = null, enabled = enabled)
                            }
                        }
                    }
                    item(key = "review-mode-footer") {
                        Text(buildAnnotatedString {
                            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(WikiModeCopy.floorsLead) }
                            append(" " + WikiModeCopy.floorsNote)
                        }, Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 4.dp).testTag("wiki-settings-floors"), style = WikiType.label,
                            color = WikiPalette.secondary)
                    }
                }
                WikiModeLogic.SettingsSection.MAINTENANCE -> {
                    item(key = "maintenance-header") { WikiPlanSectionHead(section.title) }
                    item(key = "maintenance") {
                        WikiCard(Modifier.testTag("wiki-settings-maintenance")) {
                            if (maintenance.enabled) {
                                SettingsValueRow(WikiModeCopy.status, "wiki-settings-status") {
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                        Box(Modifier.size(7.dp).background(LocalOrbitColors.current.success, CircleShape))
                                        Text(WikiModeCopy.on, style = WikiType.prose, color = WikiPalette.secondary)
                                    }
                                }
                                val place = maintenance.workspaceId?.let(workspaceLabel) ?: maintenance.workspaceId ?: "—"
                                if (server != null) {
                                    SettingsValueRow(WikiModeCopy.repoFrom, "wiki-settings-workspace-row", place)
                                    SettingsValueRow(WikiModeCopy.model, "wiki-settings-model-row") { WikiModelValue(server) }
                                } else {
                                    SettingsValueRow(WikiModeCopy.workspace, "wiki-settings-workspace-row", place)
                                    SettingsValueRow(WikiModeCopy.provider, "wiki-settings-provider-row", maintenance.provider)
                                }
                                SettingsValueRow(WikiModeCopy.dailyLimit, "wiki-settings-daily-row", WikiModeCopy.runsADay(maintenance.dailyRunLimit))
                                SettingsValueRow(WikiModeCopy.lookback, "wiki-settings-lookback-row", WikiModeCopy.lookbackLabel(maintenance.lookbackDays), divider = false)
                            } else {
                                SettingsValueRow(WikiModeCopy.maintenanceName, "wiki-settings-off-row", WikiModeCopy.off)
                                SettingsButtonRow(WikiModeCopy.setUp, "wiki-settings-set-up", busy, onClick = actions.setUp)
                            }
                        }
                    }
                    if (server != null) item(key = "maintenance-privacy") {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (!maintenance.enabled) WikiPlanFootnoteText(WikiModeCopy.maintenanceNoteServer, "wiki-settings-note-server")
                            WikiPlanFootnoteText(WikiModeCopy.privacyNote, "wiki-settings-privacy")
                        }
                    } else if (!maintenance.enabled) item(key = "maintenance-footer") { WikiPlanFootnote(WikiModeCopy.maintenanceNote) }
                    if (maintenance.enabled) item(key = "maintenance-actions") {
                        WikiCard {
                            SettingsButtonRow(WikiModeCopy.maintenanceEdit + "…", "wiki-settings-edit", busy, onClick = actions.setUp)
                            HorizontalDivider(Modifier.padding(start = 16.dp))
                            SettingsButtonRow(WikiModeCopy.turnOff, "wiki-settings-turn-off", busy, destructive = true, onClick = actions.turnOff)
                        }
                    }
                }
            }
        }
    }
}

/** One mode: its name (Tiered tagged default) and its sentence, ticked on the right when it is the space's — the system's
 * own single-choice list. */
@Composable
private fun SettingsModeRow(value: String, mode: String, server: Boolean, busy: Boolean, choose: () -> Unit) {
    Row(Modifier.fillMaxWidth().selectable(selected = value == mode, enabled = !busy, role = Role.RadioButton, onClick = choose)
        .heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-settings-mode:$value"),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(WikiModeCopy.modeLabel(value), Modifier.alignByBaseline(), style = WikiType.prose,
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (busy) 0.38f else 1f))
                if (value == WikiModeLogic.defaultMode) Text(WikiModeCopy.modeDefault, Modifier.alignByBaseline(), style = WikiType.label,
                    color = WikiPalette.secondary)
            }
            Text(WikiModeCopy.modeNote(value, server), style = WikiType.label, color = WikiPalette.secondary)
        }
        if (value == mode) Icon(painterResource(R.drawable.ic_check), null, Modifier.size(22.dp).align(Alignment.CenterVertically),
            tint = MaterialTheme.colorScheme.primary)
    }
}

/** iOS `LabeledContent`: the name on the left, what it is on the right. */
@Composable
private fun SettingsValueRow(label: String, tag: String, value: String, divider: Boolean = true) =
    SettingsValueRow(label, tag, divider) { Text(value, style = WikiType.prose, color = WikiPalette.secondary, textAlign = TextAlign.End) }

@Composable
private fun SettingsValueRow(label: String, tag: String, divider: Boolean = true, value: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 16.dp, vertical = 10.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = WikiType.prose)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) { value() }
    }
    if (divider) HorizontalDivider(Modifier.padding(start = 16.dp))
}

@Composable
private fun SettingsButtonRow(title: String, tag: String, busy: Boolean, destructive: Boolean = false, onClick: () -> Unit) {
    val tint = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    WikiRowButton(tag, enabled = !busy, onClick = onClick) {
        Text(title, style = WikiType.prose, color = tint.copy(alpha = if (busy) 0.38f else 1f))
    }
}

@Composable
private fun SettingsFallbackBanner(text: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).background(WikiPalette.amberWash, RoundedCornerShape(10.dp))
        .padding(12.dp).testTag("wiki-settings-fallback"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(18.dp), tint = WikiPalette.amber)
        Text(text, style = WikiType.label)
    }
}

// MARK: - Set up maintenance

/** One choice in a Set up picker: a workspace or a provider, and the words it is listed by. */
internal data class WikiPickerOption(val id: String, val label: String)

/** What Set up / Edit writes: where the runs take place, on what, how many a day, and how far back the first one reads —
 * a pick, and the days `Last … days` reads. While the server executes the account's wiki the provider is not written:
 * what the space names stays, for a return to runner (P9). */
internal data class WikiMaintenanceChoice(val workspaceId: String?, val provider: String, val dailyRunLimit: Int,
    val lookback: WikiModeLogic.LookbackChoice, val lookbackDays: Int)

private val choiceSaver = listSaver<WikiMaintenanceChoice, Any?>(
    save = { listOf(it.workspaceId, it.provider, it.dailyRunLimit, it.lookback.name, it.lookbackDays) },
    restore = { WikiMaintenanceChoice(it[0] as String?, it[1] as String, it[2] as Int, WikiModeLogic.LookbackChoice.valueOf(it[3] as String), it[4] as Int) })

/** Set up maintenance (mock 20 ②): the workspace, the provider it is pinned to, the daily limit and the look-back — then
 * Turn on (or Save for one already on). A sheet form: Cancel on the left, the answer on the right. [submit] is the write;
 * true when it landed and the sheet can close. While the server runs the wiki (mock 35 ②) the System model stands where
 * the provider was, read-only, and the form ends on where the wiki's material goes. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiMaintenanceForm(workspaces: List<WikiPickerOption>, providers: List<WikiPickerOption>, initial: WikiMaintenanceChoice,
    enabled: Boolean, server: WikiSystemModelStatus? = null, busy: Boolean = false, close: () -> Unit,
    submit: suspend (WikiMaintenanceChoice) -> Boolean) {
    var choice by rememberSaveable(stateSaver = choiceSaver) { mutableStateOf(initial) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // The providers offered: the one the space names stays listed even when it is not configured yet.
    val providerOptions = if (providers.any { it.id == choice.provider }) providers else listOf(WikiPickerOption(choice.provider, choice.provider)) + providers
    WikiSheet(saving, close, Modifier.testTag("wiki-settings-form")) {
        SheetBar(WikiModeCopy.setUpTitle, WikiModeCopy.cancel, if (enabled) WikiModeCopy.save else WikiModeCopy.turnOn,
            confirmEnabled = !saving && !busy && choice.workspaceId != null, confirmTag = "wiki-settings-form-submit", cancel = close,
            cancelEnabled = !saving) {
            saving = true
            val chosen = choice
            scope.launch { val landed = submit(chosen); saving = false; if (landed) close() }
        }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            WikiPlanFootnoteText(if (server != null) WikiModeCopy.maintenanceNoteServer else WikiModeCopy.maintenanceNote, "wiki-settings-form-note")
            WikiPlanSectionHead(if (server != null) WikiModeCopy.repoFrom else WikiModeCopy.workspace)
            WikiCard {
                val picked = choice.workspaceId
                val label = if (picked == null) WikiModeCopy.noWorkspace else workspaces.firstOrNull { sameWikiId(it.id, picked) }?.label ?: picked
                SettingsPickerRow(if (server != null) WikiModeCopy.repoFrom else WikiModeCopy.workspace, label, "wiki-settings-workspace") { done ->
                    if (picked == null) SettingsPickerItem(WikiModeCopy.noWorkspace, true, "wiki-settings-workspace:none") { done() }
                    workspaces.forEach { option ->
                        SettingsPickerItem(option.label, picked != null && sameWikiId(option.id, picked), "wiki-settings-workspace:${option.id}") {
                            done(); choice = choice.copy(workspaceId = option.id)
                        }
                    }
                }
            }
            WikiPlanFootnote(if (server != null) WikiModeCopy.repoFromNote else WikiModeCopy.workspaceNote)
            if (server != null) {
                // Set by the deployment: shown, never picked, and nothing here writes the provider.
                WikiPlanSectionHead(WikiModeCopy.model)
                WikiCard { SettingsValueRow(WikiModeCopy.model, "wiki-settings-form-model") { WikiModelValue(server) } }
                WikiPlanFootnote(WikiModeCopy.modelNote)
            } else {
                WikiPlanSectionHead(WikiModeCopy.provider)
                WikiCard {
                    SettingsPickerRow(WikiModeCopy.provider, providerOptions.firstOrNull { it.id == choice.provider }?.label ?: choice.provider,
                        "wiki-settings-provider") { done ->
                        providerOptions.forEach { option ->
                            SettingsPickerItem(option.label, option.id == choice.provider, "wiki-settings-provider:${option.id}") {
                                done(); choice = choice.copy(provider = option.id)
                            }
                        }
                    }
                }
                WikiPlanFootnote(WikiModeCopy.providerNote)
            }
            WikiPlanSectionHead(WikiModeCopy.dailyLimit)
            WikiCard {
                SettingsStepperRow(WikiModeCopy.runsADay(choice.dailyRunLimit), choice.dailyRunLimit, WikiMaintenanceSettings.dailyRunLimitRange,
                    "wiki-settings-daily") { choice = choice.copy(dailyRunLimit = it) }
            }
            WikiPlanFootnote(WikiModeCopy.dailyLimitNote)
            WikiPlanSectionHead(WikiModeCopy.lookback)
            WikiCard {
                SettingsPickerRow(WikiModeCopy.lookback, WikiModeCopy.lookbackLabel(WikiModeLogic.lookbackDays(choice.lookback, choice.lookbackDays)),
                    "wiki-settings-lookback") { done ->
                    WikiModeLogic.LookbackChoice.entries.forEach { pick ->
                        SettingsPickerItem(WikiModeCopy.lookbackLabel(WikiModeLogic.lookbackDays(pick, choice.lookbackDays)), pick == choice.lookback,
                            "wiki-settings-lookback:${pick.name.lowercase()}") { done(); choice = choice.copy(lookback = pick) }
                    }
                }
                if (choice.lookback == WikiModeLogic.LookbackChoice.DAYS) {
                    HorizontalDivider(Modifier.padding(start = 16.dp))
                    SettingsStepperRow(WikiModeCopy.lookbackLabel(choice.lookbackDays), choice.lookbackDays,
                        1..WikiMaintenanceSettings.lookbackDaysRange.last, "wiki-settings-lookback-days") { choice = choice.copy(lookbackDays = it) }
                }
            }
            WikiPlanFootnote(WikiModeCopy.lookbackNote)
            if (server != null) WikiPlanFootnoteText(WikiModeCopy.privacyNote, "wiki-settings-form-privacy")
        }
    }
}

/** iOS's menu-style `Picker` in a form: the name on the left, the pick on the right, the choices in a menu. */
@Composable
private fun SettingsPickerRow(label: String, value: String, tag: String, menu: @Composable ColumnScope.(close: () -> Unit) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.DropdownList) { expanded = true }.heightIn(min = 48.dp)
            .padding(horizontal = 16.dp, vertical = 10.dp).testTag(tag), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(label, style = WikiType.prose)
            Text(value, Modifier.weight(1f), style = WikiType.prose, color = WikiPalette.secondary, textAlign = TextAlign.End)
            Icon(painterResource(R.drawable.ic_chevron_updown), null, Modifier.size(14.dp), tint = WikiPalette.secondary)
        }
        DropdownMenu(expanded, { expanded = false }) { menu { expanded = false } }
    }
}

@Composable
private fun SettingsPickerItem(text: String, picked: Boolean, tag: String, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(text) }, onClick = onClick, modifier = Modifier.semantics { selected = picked }.testTag(tag),
        leadingIcon = { if (picked) Icon(painterResource(R.drawable.ic_check), null) else Spacer(Modifier.size(24.dp)) })
}

/** iOS's `Stepper`: what it says, and − and + within its range. */
@Composable
private fun SettingsStepperRow(text: String, value: Int, range: IntRange, tag: String, change: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 16.dp, end = 8.dp).testTag(tag), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f).testTag("$tag-value"), style = WikiType.prose)
        IconButton(onClick = { change(value - 1) }, enabled = value > range.first, modifier = Modifier.testTag("$tag-minus")) {
            Icon(painterResource(R.drawable.ic_minus), "Decrement")
        }
        IconButton(onClick = { change(value + 1) }, enabled = value < range.last, modifier = Modifier.testTag("$tag-plus")) {
            Icon(painterResource(R.drawable.ic_plus), "Increment")
        }
    }
}

// MARK: - what the page writes (`PATCH /api/wiki/spaces/:id`, iOS `WikiSpaceUpdate`): a key left out is left as it was

internal fun wikiReviewModeUpdate(mode: String) = buildJsonObject { put("reviewMode", mode) }
internal fun wikiSpotChecksUpdate(on: Boolean) = buildJsonObject { put("automaticSpotChecks", on) }
internal fun wikiMaintenanceOff() = buildJsonObject { putJsonObject("maintenance") { put("enabled", false) } }
/** Set up / Edit: maintenance on, where, on what, how often, and the look-back — all of history sent as null, which is a
 * value, never a key left out (it would leave the look-back as it was). Under server execution the provider is left out
 * as well: the deployment sets the System model, and what the space names stays for a return to runner (P9). */
internal fun wikiMaintenanceUpdate(choice: WikiMaintenanceChoice, includeProvider: Boolean = true) = buildJsonObject {
    putJsonObject("maintenance") {
        put("enabled", true)
        choice.workspaceId?.let { put("workspaceId", it) }
        if (includeProvider) put("provider", choice.provider)
        put("dailyRunLimit", choice.dailyRunLimit)
        put("lookbackDays", WikiModeLogic.lookbackDays(choice.lookback, choice.lookbackDays)?.let(::JsonPrimitive) ?: JsonNull)
    }
}

// MARK: - where the form's choices come from

/** The account's workspaces, runners and providers, read when the page opens: iOS lists them from the app's agents model
 * (`model.agents`), which this client keeps only for the directory — without the runners' display names or the providers. */
internal data class WikiMaintenanceReads(val workspaces: JsonArray? = null, val runners: JsonArray? = null, val providers: JsonArray? = null)

internal suspend fun wikiMaintenanceReads(client: WikiClient) = coroutineScope {
    val workspaces = async { optional { client.workspaces() } }
    val runners = async { optional { client.runners() } }
    val providers = async { optional { client.providers() } }
    WikiMaintenanceReads(workspaces.await(), runners.await(), providers.await())
}

/** A workspace the form can run maintenance in: its name, and the option it is listed as. */
internal data class WikiWorkspaceRow(val name: String?, val option: WikiPickerOption)

/** The owner's workspaces as the picker lists them: the name, and the runner it lives on — by the runner's display name
 * when it has one, as iOS's `runnerNames`. Until the reads come back, or when they fail, the directory this client holds. */
internal fun wikiWorkspaceRows(reads: WikiMaintenanceReads, data: DirectoryData): List<WikiWorkspaceRow> {
    val names: Map<String, String> = reads.runners?.filterIsInstance<JsonObject>()?.mapNotNull { runner ->
        runner["id"].text()?.let { id -> id to (runner["displayName"].text() ?: runner["name"].text() ?: id) }
    }?.toMap() ?: data.runners.associate { it.id to it.name }
    val rows: List<Triple<String, String?, String?>> = reads.workspaces?.filterIsInstance<JsonObject>()?.mapNotNull { workspace ->
        workspace["id"].text()?.let { Triple(it, workspace["name"].text(), workspace["runnerId"].text()) }
    } ?: data.workspaces.map { Triple(it.id, it.name, it.runnerId) }
    return rows.map { (id, name, runner) -> WikiWorkspaceRow(name, WikiPickerOption(id, WikiModeLogic.workspaceLabel(name, runner?.let(names::get)))) }
}

/** The providers the server takes for maintenance, by their default model: the keys Claude Code runs, by the compatibility table
 * (each key's `engines`, docs/provider-engine-contract.md §3.5) — a maintenance run starts a clean Claude Code, and a DeepSeek key
 * runs there as well as on DeepSeek Harness. A Claude subscription token is one of them; a key no engine of Claude's protocol speaks
 * is not. */
internal fun wikiProviderOptions(providers: JsonArray?): List<WikiPickerOption> = providers.orEmpty().filterIsInstance<JsonObject>()
    .let { rows -> rows.filter { ProviderEngines.CLAUDE in ProviderEngines.providerEngines(it["slug"].text(), rows) } }.mapNotNull { provider ->
        provider["slug"].text()?.let { slug ->
            WikiPickerOption(slug, WikiModeLogic.providerLabel(slug, provider["defaultModel"].text() ?: (provider["models"] as? JsonArray)?.firstOrNull()["value"].text()))
        }
    }

/** The screen: the space on the Wiki home, its settings page, and the Set up sheet (iOS `WikiSettingsView`). */
@Composable
internal fun WikiSettingsScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var settingUp by rememberSaveable { mutableStateOf(false) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    var reads by remember { mutableStateOf(WikiMaintenanceReads()) }
    LaunchedEffect(store) { store.loadSpaces() }
    LaunchedEffect(store) { store.loadSystemModel() }
    LaunchedEffect(store) { reads = wikiMaintenanceReads(store.client) }
    val space = state.currentSpace
    if (space == null) {
        PageBar.Bind(route, WikiModeCopy.settingsTitle)
        Box(Modifier.fillMaxSize().testTag("wiki-settings-loading"), contentAlignment = Alignment.Center) { LoadingMessage("Loading…") }
        return
    }
    val workspaceRows = wikiWorkspaceRows(reads, data)
    val workspaces = workspaceRows.map { it.option }
    fun finish(answer: String?) { if (answer != null) notice = answer else OrbitToasts.show(WikiCopy.settingsSaved) }
    val server = state.systemModel?.takeIf { state.serverExecutes }
    WikiSettingsPage(route, space, workspaceLabel = { id -> workspaces.firstOrNull { sameWikiId(it.id, id) }?.label }, server = server, busy = state.busy,
        actions = WikiSettingsActions(
            setMode = { mode -> scope.launch { finish(store.updateSpace(space, wikiReviewModeUpdate(mode))) } },
            setSpotChecks = { on -> scope.launch { finish(store.updateSpace(space, wikiSpotChecksUpdate(on))) } },
            setUp = { settingUp = true },
            turnOff = { scope.launch { finish(store.updateSpace(space, wikiMaintenanceOff())) } }))
    if (settingUp) {
        val current = space.settings?.maintenance ?: WikiMaintenanceSettings.default
        // A space names a codebase, and so does a workspace's name more often than not: the one called what the space
        // is called is the one first offered.
        val named = workspaceRows.firstOrNull { it.name == space.slug }?.option?.id
        WikiMaintenanceForm(workspaces, wikiProviderOptions(reads.providers),
            WikiMaintenanceChoice(current.workspaceId ?: named, current.provider, current.dailyRunLimit,
                WikiModeLogic.lookbackChoice(current.lookbackDays), WikiModeLogic.lookbackDaysOffered(current.lookbackDays)),
            current.enabled, server, state.busy, close = { settingUp = false }) { choice ->
            val answer = store.updateSpace(space, wikiMaintenanceUpdate(choice, includeProvider = server == null))
            finish(answer)
            answer == null
        }
    }
    WikiRefusalAlert(WikiCopy.settingsSaveFailed, notice) { notice = null }
}
