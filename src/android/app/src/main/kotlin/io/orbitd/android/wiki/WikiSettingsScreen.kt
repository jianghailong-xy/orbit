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
import androidx.compose.ui.graphics.Color
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
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.LoadingMessage
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.toast.OrbitToasts
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.time.Instant

// Wiki settings (iOS `WikiSettingsView.swift`; criterion 8, mock 20): which review mode the space runs in, whether
// Automatic sends spot checks, the space's Wiki maintenance run, and moving the wiki to Trash (docs/mocks/wiki-trash) —
// pushed from the Wiki home's gear. The app's own
// settings form: inset-grouped sections, a header and a footer each. The sections are `WikiModeLogic.SettingsSection`
// in its order, which is the web page's; the modes are `WikiModeLogic.modes`; every word is `WikiModeCopy`'s.

/** Where a press on the settings page goes (iOS `WikiSettingsActions`). */
internal class WikiSettingsActions(
    val setMode: (String) -> Unit = {},
    val setSpotChecks: (Boolean) -> Unit = {},
    /** A workspace, and whether it is to be in the wiki: a row's switch, and Add workspace's menu. */
    val setWorkspace: (String, Boolean) -> Unit = { _, _ -> },
    /** Set up… when maintenance is off, Edit… when it is on: the same sheet. */
    val setUp: () -> Unit = {},
    val turnOff: () -> Unit = {},
    /** Move to Trash…, which asks first. */
    val moveToTrash: () -> Unit = {},
    /** The Trash row: Trash's own page. */
    val openTrash: () -> Unit = {},
    /** Check again and run now (false), or Use this folder once confirmed (true): docs/wiki-repo-tiers-design.md §7.3. */
    val runNow: (Boolean) -> Unit = {},
)

/** The settings page, drawn from the space as the server kept it: the workspace is where the repository is read from,
 * and there is no provider to pick. [workspaceLabel]: a workspace's name and runner, by id, when this client holds the
 * workspace. [server]: the deployment's System model while the server executes the account's wiki (mock 35 ①②, P9),
 * drawn read-only with its state, and one sentence says where the wiki's material goes; null while the read does not
 * say so (still loading, or a control plane from before it), which draws neither.
 * [workspaces]: who is in the wiki and who can be added (mock 38); null until it has been read. [trashed]: how many wikis
 * Trash holds — its row, under Move to Trash…, is drawn while it holds one.
 * Every control is off while a write is in flight ([busy]). */
@Composable
internal fun WikiSettingsPage(route: OrbitRoute, space: WikiSpace, workspaceLabel: (String) -> String? = { null },
    server: WikiSystemModelStatus? = null, busy: Boolean = false, actions: WikiSettingsActions = WikiSettingsActions(),
    workspaces: WikiSpaceWorkspaces? = null, trashed: Int = 0, health: WikiSpaceHealth? = null, now: Instant = Instant.now()) {
    val mode = WikiModeLogic.mode(space.settings)
    val repoCard = health?.let { WikiRepoCardLogic.card(it, now) }
    var confirmingFolder by remember { mutableStateOf(false) }
    if (confirmingFolder) {
        AlertDialog(onDismissRequest = { confirmingFolder = false }, modifier = Modifier.testTag("wiki-use-folder-dialog"),
            title = { Text(WikiRepoCardCopy.useFolderTitle) },
            text = { Text(WikiRepoCardCopy.useFolderNote) },
            confirmButton = {
                TextButton(onClick = { confirmingFolder = false; actions.runNow(true) }, modifier = Modifier.testTag("wiki-use-folder-confirm")) {
                    Text(WikiRepoCardCopy.useFolder)
                }
            },
            dismissButton = { TextButton(onClick = { confirmingFolder = false }) { Text(WikiModeCopy.cancel) } })
    }
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
                                SettingsModeRow(value, mode, busy) { if (value != mode) actions.setMode(value) }
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
                WikiModeLogic.SettingsSection.WORKSPACES -> {
                    item(key = "workspaces-header") { WikiPlanSectionHead(section.title) }
                    if (workspaces != null) item(key = "workspaces") {
                        WikiCard(Modifier.testTag("wiki-settings-workspaces")) {
                            if (workspaces.workspaces.isEmpty()) Text(WikiModeCopy.workspacesEmpty,
                                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).testTag("wiki-settings-workspaces-empty"),
                                style = WikiType.prose, color = WikiPalette.secondary)
                            workspaces.workspaces.forEachIndexed { index, row ->
                                if (index > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                                SettingsWorkspaceRow(row, busy) { inWiki -> actions.setWorkspace(row.id, inWiki) }
                            }
                            if (workspaces.addable.isNotEmpty()) {
                                HorizontalDivider(Modifier.padding(start = 16.dp))
                                SettingsAddWorkspaceRow(workspaces.addable, busy) { id -> actions.setWorkspace(id, true) }
                            }
                        }
                    }
                    item(key = "workspaces-footer") {
                        Column(Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            WikiPlanFootnoteText(WikiModeCopy.workspacesLead, "wiki-settings-workspaces-lead")
                            WikiPlanFootnoteText(if (space.repoUrlNorm == null) WikiModeCopy.workspacesJoinNoRepository else WikiModeCopy.workspacesJoin,
                                "wiki-settings-workspaces-join")
                        }
                    }
                }
                WikiModeLogic.SettingsSection.MAINTENANCE -> {
                    item(key = "maintenance-header") { WikiPlanSectionHead(section.title) }
                    item(key = "maintenance") {
                        WikiCard(Modifier.testTag("wiki-settings-maintenance")) {
                            if (maintenance.enabled) {
                                repoCard?.let { card ->
                                    SettingsRepoRows(card, busy, actions.runNow, actions.setUp) { confirmingFolder = true }
                                    HorizontalDivider(Modifier.padding(start = 16.dp))
                                }
                                SettingsValueRow(WikiModeCopy.status, "wiki-settings-status") {
                                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                                        Box(Modifier.size(7.dp).background(LocalOrbitColors.current.success, CircleShape))
                                        Text(WikiModeCopy.on, style = WikiType.prose, color = WikiPalette.secondary)
                                    }
                                }
                                val place = maintenance.workspaceId?.let(workspaceLabel) ?: maintenance.workspaceId ?: "—"
                                SettingsValueRow(WikiModeCopy.repoFrom, "wiki-settings-workspace-row", place)
                                if (server != null) SettingsValueRow(WikiModeCopy.model, "wiki-settings-model-row") { WikiModelValue(server) }
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
                    } else if (!maintenance.enabled) item(key = "maintenance-footer") { WikiPlanFootnote(WikiModeCopy.maintenanceNoteServer) }
                    if (maintenance.enabled) item(key = "maintenance-actions") {
                        WikiCard {
                            SettingsButtonRow(WikiModeCopy.maintenanceEdit + "…", "wiki-settings-edit", busy, onClick = actions.setUp)
                            HorizontalDivider(Modifier.padding(start = 16.dp))
                            SettingsButtonRow(WikiModeCopy.turnOff, "wiki-settings-turn-off", busy, destructive = true, onClick = actions.turnOff)
                        }
                    }
                }
                WikiModeLogic.SettingsSection.TRASH -> {
                    item(key = "trash-header") { WikiPlanSectionHead(section.title) }
                    item(key = "trash") {
                        WikiCard(Modifier.testTag("wiki-settings-move-to-trash")) {
                            SettingsButtonRow(WikiModeCopy.trashOpen, "wiki-settings-move-to-trash-open", busy, destructive = true, onClick = actions.moveToTrash)
                        }
                    }
                    item(key = "trash-footer") { WikiPlanFootnote(WikiModeCopy.trashNote) }
                    // The way to Trash while it holds a wiki: a card of its own under the note, as Edit… and Turn off stand
                    // under Maintenance's, with no heading of its own, so the page's sections stay the web's.
                    if (trashed > 0) item(key = "trash-row") {
                        WikiCard {
                            WikiRowButton("wiki-settings-trash", onClick = actions.openTrash) {
                                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Text(WikiModeCopy.trash, Modifier.weight(1f), style = WikiType.prose)
                                    Text(WikiModeCopy.trashRowCount(trashed), style = WikiType.prose, color = WikiPalette.secondary)
                                    Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp), tint = WikiPalette.secondary)
                                }
                            }
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
private fun SettingsModeRow(value: String, mode: String, busy: Boolean, choose: () -> Unit) {
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
            Text(WikiModeCopy.modeNote(value), style = WikiType.label, color = WikiPalette.secondary)
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
private fun SettingsRepoRows(card: WikiRepoCard, busy: Boolean, runNow: (Boolean) -> Unit, change: () -> Unit, useFolder: () -> Unit) {
    val tint = when (card.tone) {
        WikiRepoCard.Tone.MUTED -> WikiPalette.secondary
        WikiRepoCard.Tone.WARN -> WikiPalette.amber
        WikiRepoCard.Tone.ERROR -> MaterialTheme.colorScheme.error
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).testTag("wiki-settings-repo"),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(card.tag, style = WikiType.label, color = tint, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("wiki-settings-repo-tag"))
        Text(card.line, style = WikiType.label, color = WikiPalette.secondary, modifier = Modifier.testTag("wiki-settings-repo-line"))
    }
    HorizontalDivider(Modifier.padding(start = 16.dp))
    SettingsButtonRow(WikiRepoCardCopy.checkAndRun, "wiki-settings-run-now", busy || !card.canRun) { runNow(false) }
    card.blocked?.let {
        Text(it, Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp).testTag("wiki-settings-run-blocked"),
            style = WikiType.label, color = WikiPalette.secondary)
    }
    HorizontalDivider(Modifier.padding(start = 16.dp))
    SettingsButtonRow(WikiRepoCardCopy.changeWorkspace, "wiki-settings-change-workspace", busy, onClick = change)
    if (card.useFolder) {
        HorizontalDivider(Modifier.padding(start = 16.dp))
        SettingsButtonRow(WikiRepoCardCopy.useFolder, "wiki-settings-use-folder", busy || !card.canRun, onClick = useFolder)
    }
}

/** The probe's answer under the workspace picker (mock 44 ⑤), in the server's words and its tone's colour. */
@Composable
private fun WikiProbeAnswerBox(answer: WikiRepoProbeAnswer?, checking: Boolean) {
    val colors = LocalOrbitColors.current
    val tint = when (answer?.tone) {
        "ok" -> colors.success
        "folder" -> Color(0xFF6639BA)
        "paused" -> WikiPalette.amber
        "wrong" -> MaterialTheme.colorScheme.error
        else -> WikiPalette.secondary
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).background(tint.copy(alpha = 0.12f), RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp).testTag("wiki-settings-probe:${answer?.tone ?: if (checking) "checking" else "failed"}")) {
        Text(answer?.title ?: if (checking) WikiRepoCardCopy.probeChecking else WikiRepoCardCopy.probeFailed, style = WikiType.label, color = tint,
            fontWeight = if (answer != null) FontWeight.SemiBold else FontWeight.Normal)
        answer?.note?.let { Text(it, style = WikiType.label, color = tint) }
    }
}

@Composable
private fun SettingsButtonRow(title: String, tag: String, busy: Boolean, destructive: Boolean = false, onClick: () -> Unit) {
    val tint = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    WikiRowButton(tag, enabled = !busy, onClick = onClick) {
        Text(title, style = WikiType.prose, color = tint.copy(alpha = if (busy) 0.38f else 1f))
    }
}

/** One workspace: its name over its machine, and the switch that says whether it is in the wiki. One left out stays on
 * the list, greyed, and says it will not come back by itself. */
@Composable
private fun SettingsWorkspaceRow(row: WikiSpaceWorkspaceRow, busy: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().toggleable(row.inWiki, enabled = !busy, role = Role.Switch, onValueChange = change)
        .padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-settings-workspace-row:${row.id}"), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(row.name, style = WikiType.prose, color = if (row.inWiki) MaterialTheme.colorScheme.onSurface else WikiPalette.secondary)
            row.runner?.let { Text(it, style = WikiType.label, color = WikiPalette.secondary) }
            if (!row.inWiki) Text(WikiModeCopy.workspaceLeftOut, style = WikiType.label, color = WikiPalette.secondary)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = row.inWiki, onCheckedChange = null, enabled = !busy)
    }
}

/** The workspaces with no repository, in a menu: a press adds the one picked, at once. */
@Composable
private fun SettingsAddWorkspaceRow(addable: List<WikiSpaceWorkspaceRow>, busy: Boolean, add: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        SettingsButtonRow(WikiModeCopy.addWorkspace, "wiki-settings-add-workspace", busy) { expanded = true }
        DropdownMenu(expanded, { expanded = false }) {
            Text(WikiModeCopy.addWorkspaceGroup, Modifier.padding(horizontal = 12.dp, vertical = 6.dp), style = WikiType.label, color = WikiPalette.secondary)
            addable.forEach { row ->
                DropdownMenuItem(text = {
                    Column {
                        Text(row.name)
                        row.runner?.let { Text(it, style = WikiType.label, color = WikiPalette.secondary) }
                    }
                }, onClick = { expanded = false; add(row.id) }, modifier = Modifier.testTag("wiki-settings-add-workspace:${row.id}"))
            }
        }
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

/** One choice in a Set up picker: a workspace, the words it is listed by, whether its runner is offline — listed last and said
 * so — and the heading it is listed under in the form that makes a wiki: its repository. */
internal data class WikiPickerOption(val id: String, val label: String, val offline: Boolean = false, val group: String? = null)

/** What Set up / Edit writes: where the repository is read from, how many runs a day, and how far back the first one
 * reads — a pick, and the days `Last … days` reads. No provider: the deployment sets the System model (P11). */
internal data class WikiMaintenanceChoice(val workspaceId: String?, val dailyRunLimit: Int,
    val lookback: WikiModeLogic.LookbackChoice, val lookbackDays: Int)

private val choiceSaver = listSaver<WikiMaintenanceChoice, Any?>(
    save = { listOf(it.workspaceId, it.dailyRunLimit, it.lookback.name, it.lookbackDays) },
    restore = { WikiMaintenanceChoice(it[0] as String?, it[1] as Int, WikiModeLogic.LookbackChoice.valueOf(it[2] as String), it[3] as Int) })

/** The form Set up maintenance and Create wiki share (mock 20 ②, mock 35 ②, mock 41): the workspace the repository is read
 * from, the daily limit and the look-back — then [submitLabel]. A sheet form: Cancel on the left, the answer on the right.
 * [workspaceDefault] is the workspace it stands on until one is picked, worked out anew each time so that reads landing after
 * it opened still pick for the reader; [workspaceNote] says what is under the workspace, by the one it stands on. [submit] is
 * the write; true when it landed and the sheet can close; a [refusal] stays in the sheet, under its bar, where it is in view
 * however far the form is scrolled. While the server executes the account's wiki ([server]) the System model is shown,
 * read-only, and the form ends on where the wiki's material goes. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiMaintenanceForm(title: String, note: String, submitLabel: String, workspaces: List<WikiPickerOption>, workspaceDefault: String?,
    workspaceNote: (String?) -> String, initial: WikiMaintenanceChoice, server: WikiSystemModelStatus?, busy: Boolean, refusal: String? = null,
    probe: (suspend (String) -> WikiRepoProbeAnswer?)? = null,
    close: () -> Unit, submit: suspend (WikiMaintenanceChoice) -> Boolean) {
    var choice by rememberSaveable(stateSaver = choiceSaver) { mutableStateOf(initial) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val picked = choice.workspaceId ?: workspaceDefault
    // The chosen workspace's folder, asked of its runner as it is chosen (docs/wiki-repo-tiers-design.md §7.3).
    var probed by remember { mutableStateOf<WikiRepoProbeAnswer?>(null) }
    var probing by remember { mutableStateOf(false) }
    LaunchedEffect(picked) {
        probed = null
        if (probe != null && picked != null) { probing = true; probed = probe(picked); probing = false }
    }
    WikiSheet(saving, close, Modifier.testTag("wiki-settings-form")) {
        SheetBar(title, WikiModeCopy.cancel, submitLabel, confirmEnabled = !saving && !busy && picked != null && probed?.canTurnOn != false,
            confirmTag = "wiki-settings-form-submit",
            cancel = close, cancelEnabled = !saving) {
            saving = true
            val chosen = choice.copy(workspaceId = picked)
            scope.launch { val landed = submit(chosen); saving = false; if (landed) close() }
        }
        refusal?.let { PlanRefusedLines(listOf(it), "wiki-settings-form-refused") }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            WikiPlanFootnoteText(note, "wiki-settings-form-note")
            WikiPlanSectionHead(WikiModeCopy.repoFrom)
            WikiCard {
                val label = if (picked == null) WikiModeCopy.noWorkspace else workspaces.firstOrNull { sameWikiId(it.id, picked) }?.label ?: picked
                SettingsPickerRow(WikiModeCopy.repoFrom, label, "wiki-settings-workspace") { done ->
                    if (picked == null) SettingsPickerItem(WikiModeCopy.noWorkspace, true, "wiki-settings-workspace:none") { done() }
                    workspaces.forEachIndexed { index, option ->
                        if (option.group != null && option.group != workspaces.getOrNull(index - 1)?.group)
                            Text(option.group, Modifier.padding(horizontal = 12.dp, vertical = 6.dp), style = WikiType.label, color = WikiPalette.secondary)
                        SettingsPickerItem(option.label, picked != null && sameWikiId(option.id, picked), "wiki-settings-workspace:${option.id}", option.offline) {
                            done(); choice = choice.copy(workspaceId = option.id)
                        }
                    }
                }
            }
            if (probe != null && picked != null) WikiProbeAnswerBox(probed, probing)
            WikiPlanFootnoteText(workspaceNote(picked), "wiki-settings-workspace-note")
            if (server != null) {
                // Set by the deployment: shown, never picked, and nothing here writes the provider.
                WikiPlanSectionHead(WikiModeCopy.model)
                WikiCard { SettingsValueRow(WikiModeCopy.model, "wiki-settings-form-model") { WikiModelValue(server) } }
                WikiPlanFootnote(WikiModeCopy.modelNote)
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
private fun SettingsPickerItem(text: String, picked: Boolean, tag: String, offline: Boolean = false, onClick: () -> Unit) {
    DropdownMenuItem(text = { Text(text, color = if (offline) WikiPalette.secondary else Color.Unspecified) }, onClick = onClick,
        modifier = Modifier.semantics { selected = picked }.testTag(tag),
        leadingIcon = { if (picked) Icon(painterResource(R.drawable.ic_check), null) else Spacer(Modifier.size(24.dp)) },
        trailingIcon = if (offline) ({ Text(WikiStartCopy.workspaceOffline, style = WikiType.label, color = WikiPalette.secondary) }) else null)
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
/** Set up / Edit: maintenance on, where, how often, and the look-back — all of history sent as null, which is a value,
 * never a key left out (it would leave the look-back as it was). No provider: the deployment sets the System model, and
 * the server drops one a write names (contract `space.settings.maintenance.keys.provider`, P11). */
internal fun wikiMaintenanceUpdate(choice: WikiMaintenanceChoice) = buildJsonObject {
    putJsonObject("maintenance") {
        put("enabled", true)
        choice.workspaceId?.let { put("workspaceId", it) }
        put("dailyRunLimit", choice.dailyRunLimit)
        put("lookbackDays", WikiModeLogic.lookbackDays(choice.lookback, choice.lookbackDays)?.let(::JsonPrimitive) ?: JsonNull)
    }
}

/** Create wiki (`POST /api/wiki/spaces`): its name, its repository, and its maintenance from the start, as Set up writes it. */
internal fun wikiSpaceCreate(title: String, repoUrl: String, choice: WikiMaintenanceChoice) = buildJsonObject {
    put("title", title); put("repoUrl", repoUrl)
    wikiMaintenanceUpdate(choice).forEach { (key, value) -> put(key, value) }
}

// MARK: - where the form's choices come from

/** The account's workspaces and runners, read when the page opens: iOS lists them from the app's agents model
 * (`model.agents`), which this client keeps only for the directory — without the runners' display names. */
internal data class WikiMaintenanceReads(val workspaces: JsonArray? = null, val runners: JsonArray? = null)

internal suspend fun wikiMaintenanceReads(client: WikiClient) = coroutineScope {
    val workspaces = async { optional { client.workspaces() } }
    val runners = async { optional { client.runners() } }
    WikiMaintenanceReads(workspaces.await(), runners.await())
}

/** The owner's workspaces as the two forms offer them (`useWikiWorkspaceChoices`): the name and the runner it lives on — by
 * the runner's display name when it has one, as iOS's `runnerNames` — its repository, and whether that runner is known to be
 * offline. Until the reads come back, or when they fail, the directory this client holds. */
internal fun wikiWorkspaceRows(reads: WikiMaintenanceReads, data: DirectoryData): List<WikiWorkspaceChoice> {
    class Machine(val id: String, val name: String, val online: Boolean)
    class Workspace(val id: String, val name: String?, val runner: String?, val repoUrl: String?)
    val machines = reads.runners?.filterIsInstance<JsonObject>()?.mapNotNull { runner ->
        runner["id"].text()?.let { id -> Machine(id, runner["displayName"].text() ?: runner["name"].text() ?: id, runner["online"].bool() == true) }
    } ?: data.runners.map { Machine(it.id, it.name, it.online == true) }
    val rows = reads.workspaces?.filterIsInstance<JsonObject>()?.mapNotNull { workspace ->
        workspace["id"].text()?.let { Workspace(it, workspace["name"].text(), workspace["runnerId"].text(), workspace["repoUrl"].text()) }
    } ?: data.workspaces.map { Workspace(it.id, it.name, it.runnerId, it.repoUrl) }
    return rows.map { row ->
        val machine = row.runner?.let { id -> machines.firstOrNull { sameWikiId(it.id, id) } }
        WikiWorkspaceChoice(row.id, WikiModeLogic.workspaceLabel(row.name, machine?.name), WikiStartLogic.repositoryName(row.repoUrl), row.repoUrl, machine?.online ?: true)
    }
}

/** The workspaces, and whether their first read is still out. */
internal data class WikiWorkspaceChoices(val choices: List<WikiWorkspaceChoice>, val loading: Boolean)

/** The workspaces the two forms offer, read as the caller comes on screen; the directory stands in until they are. */
@Composable
internal fun rememberWikiWorkspaceChoices(store: WikiStore, data: DirectoryData): WikiWorkspaceChoices {
    var reads by remember(store) { mutableStateOf<WikiMaintenanceReads?>(null) }
    LaunchedEffect(store) { reads = wikiMaintenanceReads(store.client) }
    return WikiWorkspaceChoices(wikiWorkspaceRows(reads ?: WikiMaintenanceReads(), data), reads?.workspaces == null)
}

/** Set up maintenance over the store, from Wiki settings' Maintenance and from the home's first step alike, where the reader
 * is (the web's `WikiSetUpDialog`). It offers this wiki's own workspaces and stands on one for the reader
 * ([WikiStartLogic.setUpChoices], [WikiStartLogic.workspaceDefault]), so that one press is enough. */
@Composable
internal fun WikiSetUpSheet(store: WikiStore, space: WikiSpace, data: DirectoryData, close: () -> Unit) {
    val state by store.state.collectAsState()
    val choices = rememberWikiWorkspaceChoices(store, data).choices
    var members by remember { mutableStateOf<WikiSpaceWorkspaces?>(null) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(store, space.id) { members = optional { store.client.spaceWorkspaces(space.id) } }
    LaunchedEffect(store) { store.loadSystemModel() }
    val maintenance = space.settings?.maintenance ?: WikiMaintenanceSettings.default
    val offered = WikiStartLogic.setUpChoices(choices, members?.workspaces.orEmpty(), maintenance.workspaceId)
    val current = choices.firstOrNull { sameWikiId(it.id, maintenance.workspaceId) }?.id ?: maintenance.workspaceId
    WikiMaintenanceForm(WikiModeCopy.setUpTitle, WikiModeCopy.maintenanceNoteServer, if (maintenance.enabled) WikiModeCopy.save else WikiModeCopy.turnOn,
        offered.map { it.option() }, WikiStartLogic.workspaceDefault(offered, current, state.fromWorkspaceId), { WikiModeCopy.repoFromNote },
        WikiMaintenanceChoice(null, maintenance.dailyRunLimit, WikiModeLogic.lookbackChoice(maintenance.lookbackDays),
            WikiModeLogic.lookbackDaysOffered(maintenance.lookbackDays)),
        state.systemModel?.takeIf { state.serverExecutes }, state.busy,
        probe = { id -> optional { store.client.probeMaintenance(space.id, id) } }, close = close) { choice ->
        val answer = store.updateSpace(space, wikiMaintenanceUpdate(choice))
        if (answer != null) notice = answer else OrbitToasts.show(WikiCopy.settingsSaved)
        answer == null
    }
    WikiRefusalAlert(WikiCopy.settingsSaveFailed, notice) { notice = null }
}

/** Create wiki (the web's `WikiCreateDialog`, mock 41): the same form, its workspaces under their repositories. Choosing the
 * workspace chooses the repository, so there is no second field; a workspace on no repository has nothing to describe and is
 * not offered. The server makes the space, turns maintenance on and asks for the plan's first draft in the one request, which
 * is what the home then shows. */
@Composable
internal fun WikiCreateSheet(store: WikiStore, data: DirectoryData, close: () -> Unit) {
    val state by store.state.collectAsState()
    val choices = rememberWikiWorkspaceChoices(store, data).choices
    var refusal by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(store) { store.loadSystemModel() }
    val groups = WikiStartLogic.repositoryGroups(choices)
    val offered = groups.flatMap { it.choices }
    val maintenance = WikiMaintenanceSettings.default
    fun workspace(id: String?) = offered.firstOrNull { sameWikiId(it.id, id) }
    WikiMaintenanceForm(WikiStartCopy.create, WikiStartCopy.createNote, WikiStartCopy.createSubmit,
        groups.flatMap { group -> group.choices.map { it.option(group.repository) } },
        WikiStartLogic.workspaceDefault(offered, null, state.fromWorkspaceId),
        { id -> workspace(id)?.repository?.let(WikiStartCopy::createRepositoryNote) ?: WikiModeCopy.repoFromNote },
        WikiMaintenanceChoice(null, maintenance.dailyRunLimit, WikiModeLogic.lookbackChoice(maintenance.lookbackDays),
            WikiModeLogic.lookbackDaysOffered(maintenance.lookbackDays)),
        state.systemModel?.takeIf { state.serverExecutes }, state.busy, refusal, close = close) { choice ->
        val picked = workspace(choice.workspaceId)
        val repository = picked?.repository
        val repoUrl = picked?.repoUrl
        if (repository == null || repoUrl == null) false else {
            val title = WikiStartLogic.repositoryTitle(repository)
            refusal = store.createSpace(title, wikiSpaceCreate(title, repoUrl, choice))
            refusal == null
        }
    }
}

/** The screen: the space on the Wiki home, its settings page, and the Set up sheet (iOS `WikiSettingsView`). */
@Composable
internal fun WikiSettingsScreen(store: WikiStore, route: OrbitRoute, data: DirectoryData, nav: WikiNav) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var settingUp by rememberSaveable { mutableStateOf(false) }
    var notice by rememberSaveable { mutableStateOf<String?>(null) }
    var members by remember { mutableStateOf<WikiSpaceWorkspaces?>(null) }
    var confirmingTrash by rememberSaveable { mutableStateOf(false) }
    var trashRefusal by rememberSaveable { mutableStateOf<String?>(null) }
    /** What Move to Trash's question counts, read with the page; null until then, or when the read fails. */
    var trashEntries by remember { mutableStateOf<Int?>(null) }
    suspend fun readMembers(id: String) { optional { store.client.spaceWorkspaces(id) }?.let { members = it } }
    LaunchedEffect(store, state.currentSpace?.id) { state.currentSpace?.let { readMembers(it.id) } }
    /** The space's health: the maintenance card's repository part (docs/wiki-repo-tiers-design.md §7.3). */
    var health by remember { mutableStateOf<WikiSpaceHealth?>(null) }
    LaunchedEffect(store, state.currentSpace?.id, settingUp) {
        health = state.currentSpace?.let { optional { store.client.health(it.id) } }
        trashEntries = health?.entries
    }
    LaunchedEffect(store) { store.loadSpaces() }
    LaunchedEffect(store) { store.loadSystemModel() }
    LaunchedEffect(store) { store.loadTrash() }
    val choices = rememberWikiWorkspaceChoices(store, data).choices
    val space = state.currentSpace
    if (space == null) {
        PageBar.Bind(route, WikiModeCopy.settingsTitle)
        Box(Modifier.fillMaxSize().testTag("wiki-settings-loading"), contentAlignment = Alignment.Center) { LoadingMessage("Loading…") }
        return
    }
    fun finish(answer: String?) { if (answer != null) notice = answer else OrbitToasts.show(WikiCopy.settingsSaved) }
    val server = state.systemModel?.takeIf { state.serverExecutes }
    WikiSettingsPage(route, space, workspaceLabel = { id -> choices.firstOrNull { sameWikiId(it.id, id) }?.label }, server = server, busy = state.busy,
        actions = WikiSettingsActions(
            setMode = { mode -> scope.launch { finish(store.updateSpace(space, wikiReviewModeUpdate(mode))) } },
            setSpotChecks = { on -> scope.launch { finish(store.updateSpace(space, wikiSpotChecksUpdate(on))) } },
            setWorkspace = { id, inWiki -> scope.launch {
                val answer = store.setWorkspace(space, id, inWiki)
                readMembers(space.id)
                finish(answer)
            } },
            setUp = { settingUp = true },
            turnOff = { scope.launch { finish(store.updateSpace(space, wikiMaintenanceOff())) } },
            moveToTrash = { confirmingTrash = true },
            openTrash = { nav.open(OrbitRoute(Destination.WIKI_TRASH)) },
            runNow = { acceptFolder -> scope.launch {
                val answer = store.runMaintenanceNow(space, acceptFolder)
                health = optional { store.client.health(space.id) } ?: health
                if (answer != null) notice = answer else OrbitToasts.show(WikiRepoCardCopy.runStarted)
            } }),
        workspaces = members, trashed = state.trash.size, health = health)
    if (settingUp) WikiSetUpSheet(store, space, data, close = { settingUp = false })
    WikiRefusalAlert(WikiCopy.settingsSaveFailed, notice) { notice = null }
    if (confirmingTrash) {
        val name = WikiSpaceLogic.names(state.spaces)[space.id] ?: space.title ?: space.slug
        AlertDialog(onDismissRequest = { confirmingTrash = false }, modifier = Modifier.testTag("wiki-move-to-trash-dialog"),
            title = { Text(WikiModeCopy.trashQuestion(name)) },
            text = { Text(WikiModeCopy.trashMessage(trashEntries, space.docs?.written ?: 0, space.repoUrlNorm)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmingTrash = false
                    scope.launch {
                        // The page goes as soon as the wiki does, back to the one the Wiki opens now, or to its empty state.
                        trashRefusal = store.moveToTrash(space) {
                            nav.back()
                            OrbitToasts.show(WikiModeCopy.movedToTrash(name))
                        }
                    }
                }, modifier = Modifier.testTag("wiki-move-to-trash-confirm")) { Text(WikiModeCopy.trashConfirm, color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmingTrash = false }, modifier = Modifier.testTag("wiki-move-to-trash-cancel")) { Text(WikiModeCopy.cancel) }
            })
    }
    WikiRefusalAlert(WikiModeCopy.trashFailed, trashRefusal) { trashRefusal = null }
}

// MARK: - Trash

/** Trash (docs/mocks/wiki-trash ②, the web's Trash dialog), pushed from Wiki settings' Trash row, the space picker and the
 * first-wiki card: how long Trash keeps a wiki, then each wiki in it, the newest move first, with Restore and Delete
 * permanently… under it. Delete permanently asks first, as the sessions' Trash does; a write the server refuses says why in
 * an alert, in the server's own words — a restore while a newer wiki holds the repository among them. */
@Composable
internal fun WikiTrashScreen(store: WikiStore, route: OrbitRoute) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    /** The wiki Delete permanently is asking about, by id. */
    var purging by rememberSaveable { mutableStateOf<String?>(null) }
    var restoreRefusal by rememberSaveable { mutableStateOf<String?>(null) }
    var purgeRefusal by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(store) { store.loadTrash() }
    PageBar.Bind(route, WikiModeCopy.trash)
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-trash-page"), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
        item(key = "lead") { WikiPlanFootnoteText(WikiModeCopy.trashLead, "wiki-trash-lead") }
        item(key = "rows") {
            when (presentation(state.trashState, state.trash.isEmpty())) {
                LoadPresentation.LOADING -> LoadingMessage("Loading…")
                LoadPresentation.FAILED -> StatusMessage("Trash couldn't be loaded", "Check the connection, then try again.") { scope.launch { store.loadTrash() } }
                LoadPresentation.EMPTY -> WikiCard(Modifier.testTag("wiki-trash-empty")) {
                    Text(WikiModeCopy.trashEmpty, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), style = WikiType.prose,
                        color = WikiPalette.secondary)
                }
                LoadPresentation.CONTENT, LoadPresentation.CONTENT_WITH_ERROR -> WikiCard(Modifier.testTag("wiki-trash-rows")) {
                    state.trash.forEachIndexed { index, row ->
                        if (index > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                        TrashRow(row, state.busy, restore = {
                            scope.launch {
                                val refusal = store.restore(row)
                                if (refusal != null) restoreRefusal = refusal else OrbitToasts.show(WikiModeCopy.restored(row.name))
                            }
                        }, purge = { purging = row.id })
                    }
                }
            }
        }
    }
    state.trash.firstOrNull { it.id == purging }?.let { row ->
        AlertDialog(onDismissRequest = { purging = null }, modifier = Modifier.testTag("wiki-trash-purge-dialog"),
            title = { Text(WikiModeCopy.purgeQuestion) },
            text = { Text(WikiModeCopy.purgeBody(row.entries)) },
            confirmButton = {
                TextButton(onClick = {
                    purging = null
                    scope.launch { purgeRefusal = store.purge(row) }
                }, modifier = Modifier.testTag("wiki-trash-purge-confirm")) { Text(WikiModeCopy.purgeConfirm, color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { purging = null }, modifier = Modifier.testTag("wiki-trash-purge-cancel")) { Text(WikiModeCopy.cancel) }
            })
    }
    WikiRefusalAlert(WikiModeCopy.restoreFailed, restoreRefusal) { restoreRefusal = null }
    WikiRefusalAlert(WikiModeCopy.purgeFailed, purgeRefusal) { purgeRefusal = null }
}

/** One wiki in Trash: its name over when it was moved, what it holds and when it is deleted for good — one stop to
 * TalkBack — then Restore and Delete permanently…, each a stop of its own. */
@Composable
private fun TrashRow(row: WikiTrashRow, busy: Boolean, restore: () -> Unit, purge: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp).semantics(mergeDescendants = true) {}
        .testTag("wiki-trash-row:${row.id}"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(row.name, style = WikiType.prose)
        Text(WikiModeCopy.trashRowLine(row.deletedAt, row.purgeAt, row.entries), style = WikiType.subtext, color = WikiPalette.secondary)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = restore, enabled = !busy, modifier = Modifier.testTag("wiki-trash-restore:${row.id}")) { Text(WikiModeCopy.restore) }
            TextButton(onClick = purge, enabled = !busy, modifier = Modifier.testTag("wiki-trash-delete:${row.id}")) {
                Text(WikiModeCopy.deletePermanently, color = MaterialTheme.colorScheme.error.copy(alpha = if (busy) 0.38f else 1f))
            }
        }
    }
}
