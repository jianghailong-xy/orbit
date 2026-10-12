package io.orbitd.android.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.time.Instant

// How it runs on the project page, the merge check's own sheet and the owner's own Start… —
// ProjectsView.swift's `runSettingsSection`, `MergeCheckEditor` and `OwnerStartProjectSheet` (whose card is
// StartProjectCard.kt), with OrbitKit's words (`RunSettings`, `StartProject`).

/** Each control writes as it is changed; a write the door refuses says so over its own words (`runSettingsSection`). */
@Composable
internal fun RunSettingsSection(state: ProjectPageState, doc: JsonObject, now: Instant, enabled: Boolean, editMergeCheck: () -> Unit,
    integration: (JsonObject?) -> Unit, automatic: (Boolean) -> Unit, stepConcurrency: (Int) -> Unit, pause: (Boolean) -> Unit) {
    Column(Modifier.testTag("project-settings"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        SectionHead(StartProjectCopy.howItRuns, RunSettings.appliesFromNextTask)
        val view = state.integration
        when {
            view != null -> {
                // The project's main branch — none for a project with no repository, which has no row for it — and the branch
                // every sentence about where work goes names: that one, or main.
                val stored = ProjectMainBranch.stored(view)
                val main = stored ?: RunSettings.defaultMainBranch
                LineSetting(view, doc, now, enabled, stored != null, main, integration)
                stored?.let { HorizontalDivider(); MainBranchSetting(view, it, now, enabled, integration) }
                HorizontalDivider()
                AutomaticSetting(view, doc, enabled, main, automatic)
                HorizontalDivider()
                AtMostSetting(state, doc, enabled, stepConcurrency)
                HorizontalDivider()
                MergeCheckSetting(view, doc, enabled, main, editMergeCheck)
                view.number("escalationSeconds")?.let { seconds -> HorizontalDivider(); EscalationSetting(view, seconds, enabled, integration) }
                HorizontalDivider()
                val paused = doc.text("pausedAt") != null
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { pause(!paused) }, enabled = enabled, modifier = Modifier.testTag("project-pause"),
                        contentPadding = PaddingValues(0.dp)) { Text(if (paused) RunSettings.resume else RunSettings.pause) }
                    Note(RunSettings.pauseFootnote(doc.text("pausedAt"), now, main))
                }
            }
            state.integrationReadFailed -> Text(RunSettings.notLoaded, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
            else -> CircularProgressIndicator(Modifier.size(20.dp).align(Alignment.CenterHorizontally))
        }
    }
}

@Composable
private fun Note(text: String, color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onSurfaceVariant) =
    Text(text, style = MaterialTheme.typography.labelMedium, color = color)

/** Tasks land on: the two lines while nothing has landed; once something has, the line, locked, and why — under Main branch
 * instead when the project has that row ([hasMainBranch]), since the two lock together. */
@Composable
private fun LineSetting(view: JsonObject, doc: JsonObject, now: Instant, enabled: Boolean, hasMainBranch: Boolean, main: String, write: (JsonObject?) -> Unit) {
    val id = doc.text("id").orEmpty()
    val branch = if (view.text("line") == "PROJECT_BRANCH") view.text("ref") ?: "project/$id" else "project/$id"
    if (view.flag("locked")) Column(Modifier.testTag("project-line-locked"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(RunSettings.tasksLandOn); Spacer(Modifier.weight(1f).widthIn(min = 8.dp))
            Text("🔒 ${if (view.text("line") == "MAIN") RunSettings.lineMain(main) else RunSettings.shortBranch(branch)}", color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (!hasMainBranch) Note(RunSettings.lineLocked(view.text("startedAt")?.let { ProjectTime.ago(it, now) }))
    } else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(RunSettings.tasksLandOn)
        LineOption(view, "PROJECT_BRANCH", RunSettings.lineProjectBranch, RunSettings.shortBranch(branch), RunSettings.lineProjectBranchHint, enabled, write)
        LineOption(view, "MAIN", RunSettings.lineMain(main), null, RunSettings.lineMainHint(main), enabled, write)
    }
}

/** Main branch: which branch main is for this project — where its tasks start and its work ends up. Picking one writes it, as the
 * line does (no Save), and is also what new projects in the repository start with. Once integration starts it locks with the line,
 * and why is said here. */
@Composable
private fun MainBranchSetting(view: JsonObject, main: String, now: Instant, enabled: Boolean, write: (JsonObject?) -> Unit) {
    val repository = ProjectMainBranch.repository(view) ?: return
    if (view.flag("locked")) Column(Modifier.testTag("project-main-branch-locked"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(RunSettings.mainBranch); Spacer(Modifier.weight(1f).widthIn(min = 8.dp))
            Text("🔒 $main", fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Note(RunSettings.mainBranchLocked(view.text("startedAt")?.let { ProjectTime.ago(it, now) }, main))
    } else {
        var picking by remember { mutableStateOf(false) }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(RunSettings.mainBranch, Modifier.weight(1f))
                MainBranchValue(main, enabled, "project-main-branch") { picking = true }
            }
            Note("${RunSettings.mainBranchHint} ${RunSettings.mainBranchRemembers(repository)}")
        }
        if (picking) MainBranchPicker(main, ProjectMainBranch.branches(view), ProjectMainBranch.lastChoice(view)?.branch, "project-main-branch",
            close = { picking = false }) { picking = false; write(RunSettings.mainBranchWrite(view, it)) }
    }
}

/** One of the two lines, ticked when it is the one — a line nobody has decided ticks neither. */
@Composable
private fun LineOption(view: JsonObject, line: String, title: String, branch: String?, hint: String, enabled: Boolean, write: (JsonObject?) -> Unit) {
    val chosen = view.text("line") == line
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.RadioButton) { write(RunSettings.lineWrite(view, line)) }.testTag("project-line:$line"),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        RadioButton(chosen, null, enabled = enabled)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row { Text(title, fontWeight = FontWeight.SemiBold); branch?.let { Text(" · $it", fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis) } }
            Note(hint)
        }
    }
}

/** Automatic writes `automatic` and nothing else: switching it off no longer stops the project. */
@Composable
private fun AutomaticSetting(view: JsonObject, doc: JsonObject, enabled: Boolean, main: String, write: (Boolean) -> Unit) {
    val known = doc["coordinatorEnabled"] is JsonPrimitive && doc.text("configRevision") != null
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(RunSettings.automatic, Modifier.weight(1f))
            Switch(doc.flag("coordinatorEnabled"), { write(it) }, enabled = enabled && known, modifier = Modifier.testTag("project-automatic")
                .semantics { contentDescription = RunSettings.automatic })
        }
        Note(RunSettings.automaticHint(if (view.text("line") == "MAIN") "MAIN" else "PROJECT_BRANCH", main))
    }
}

/** At most: the number moves with each press, and one write carries where the presses stopped. */
@Composable
private fun AtMostSetting(state: ProjectPageState, doc: JsonObject, enabled: Boolean, step: (Int) -> Unit) {
    val count = state.pendingConcurrency ?: doc.number("maxConcurrentTasks") ?: 1
    val known = doc.number("maxConcurrentTasks") != null && doc.text("configRevision") != null
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(RunSettings.atMost)
        Spacer(Modifier.weight(1f))
        Text("$count ${RunSettings.tasksAtATime(count)}", Modifier.testTag("project-at-most"), color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        Stepper(count, 1..StartProjectCopy.maxConcurrentTasks, enabled && known, "project-at-most", step)
    }
}

/** The platform stepper's two presses, bounded. */
@Composable
internal fun Stepper(value: Int, range: IntRange, enabled: Boolean, tag: String, change: (Int) -> Unit) {
    Row(Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))) {
        TextButton(onClick = { change(value - 1) }, enabled = enabled && value > range.first, modifier = Modifier.testTag("$tag-minus")
            .semantics { contentDescription = "${RunSettings.atMost}: fewer" }) { Text("−") }
        TextButton(onClick = { change(value + 1) }, enabled = enabled && value < range.last, modifier = Modifier.testTag("$tag-plus")
            .semantics { contentDescription = "${RunSettings.atMost}: more" }) { Text("+") }
    }
}

/** The merge check: the command or that there is none — amber while Automatic would merge with nothing run. Edited on its own sheet. */
@Composable
private fun MergeCheckSetting(view: JsonObject, doc: JsonObject, enabled: Boolean, main: String, edit: () -> Unit) {
    val missing = RunSettings.mergeCheckMissing(view.text("line"), doc.flag("coordinatorEnabled"), view.text("mergeCheckCommand"))
    val warning = LocalOrbitColors.current.needsYou
    Column(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = edit).testTag("project-merge-check"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(RunSettings.mergeCheck, Modifier.weight(1f), color = if (missing) warning else MaterialTheme.colorScheme.onSurface)
            Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        view.text("mergeCheckCommand")?.let { Text(it, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2,
            overflow = TextOverflow.Ellipsis) } ?: Note(RunSettings.mergeCheckPlaceholder)
        Note(RunSettings.mergeCheckHint(main))
        if (missing) Note("⚠ ${RunSettings.noMergeCheckWarning(main)}", warning)
    }
}

/** Escalate after: the window's points, and the project's own when it is none of them. */
@Composable
private fun EscalationSetting(view: JsonObject, seconds: Int, enabled: Boolean, write: (JsonObject?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(RunSettings.escalateAfter, Modifier.weight(1f))
            Box {
                TextButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.testTag("project-escalation")) { Text("${RunSettings.escalationLabel(seconds)} ▾") }
                DropdownMenu(open, { open = false }) {
                    RunSettings.escalationOptions(seconds).forEach { (value, label) ->
                        DropdownMenuItem(text = { Text(if (value == seconds) "✓ $label" else label) }, onClick = { open = false; write(RunSettings.escalationWrite(view, value)) })
                    }
                }
            }
        }
        Note(RunSettings.escalateHint)
    }
}

/** The merge check where a command has room. A refused save keeps the sheet up, the command as typed, the door's words under it. */
@Composable
internal fun MergeCheckEditor(view: JsonObject, automatic: Boolean, enabled: Boolean, close: () -> Unit, save: suspend (JsonObject?) -> String?) {
    // The draft lives and dies with this editor.
    var command by remember { mutableStateOf(view.text("mergeCheckCommand").orEmpty()) }
    var refused by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val missing = RunSettings.mergeCheckMissing(view.text("line"), automatic, command)
    val main = ProjectMainBranch.stored(view) ?: RunSettings.defaultMainBranch
    AlertDialog(onDismissRequest = { if (!saving) close() }, modifier = Modifier.testTag("merge-check-editor"), title = { Text(RunSettings.mergeCheck) },
        text = { Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(command, { command = it }, Modifier.fillMaxWidth().testTag("merge-check-command"), placeholder = { Text(RunSettings.mergeCheckPlaceholder) },
                textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace), enabled = !saving)
            Note(RunSettings.mergeCheckHint(main))
            if (missing) Note("⚠ ${RunSettings.noMergeCheckWarning(main)}", LocalOrbitColors.current.needsYou)
            refused?.let { Note(it, MaterialTheme.colorScheme.error) }
        } },
        confirmButton = { TextButton(onClick = {
            saving = true
            scope.launch { try { val failure = save(RunSettings.mergeCheckWrite(view, command)); if (failure == null) close() else refused = failure } finally { saving = false } }
        }, enabled = enabled && !saving && RunSettings.mergeCheckWrite(view, command) != null, modifier = Modifier.testTag("merge-check-save")) { Text(RunSettings.save) } },
        dismissButton = { TextButton(onClick = close, enabled = !saving) { Text("Cancel") } })
}

/** "Start…" — the start card over the project page for a project whose coordinator has not asked: the default rule's
 * settings, the same door, no request to answer, nobody quoted and no Chat about this (`OwnerStartProjectSheet`). */
@Composable
internal fun OwnerStartSheet(api: ProjectApi, id: String, state: ProjectPageState, enabled: Boolean, viewTasks: () -> Unit, close: () -> Unit,
    start: suspend (JsonObject) -> String?) {
    var confirmation by remember { mutableStateOf<JsonObject?>(null) }
    var unread by remember { mutableStateOf(false) }
    // While the start is being sent the sheet cannot be cancelled away from it (iOS keeps its card up).
    var starting by remember { mutableStateOf(false) }
    LaunchedEffect(id) {
        try { confirmation = api.confirmation(id); unread = false } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { unread = true }
    }
    Dialog(onDismissRequest = { if (!starting) close() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth(0.94f).testTag("project-start-sheet"), shape = MaterialTheme.shapes.large) {
            Column(Modifier.heightIn(max = 720.dp).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val cancel: @Composable () -> Unit = { TextButton(onClick = close, enabled = !starting, modifier = Modifier.testTag("project-start-cancel")) { Text("Cancel") } }
                val doc = state.document
                val digest = confirmation?.obj("currentVersion")?.text("digest")
                // Drawn once the document, the seal and the line the project may already be on have answered: a card set before
                // the line was read would suggest one over it.
                if (doc != null && digest != null && state.integration != null) OwnerStartCard(doc, digest, state, enabled, starting, { starting = it },
                    viewTasks, start, close, cancel)
                else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("▶ ${StartProjectCopy.title}", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary)
                        cancel()
                    }
                    if (unread || state.integrationReadFailed) Note(StartProjectCopy.unreadSeal)
                    else CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                }
            }
        }
    }
}

@Composable
private fun OwnerStartCard(doc: JsonObject, digest: String, state: ProjectPageState, enabled: Boolean, starting: Boolean, setStarting: (Boolean) -> Unit,
    viewTasks: () -> Unit, start: suspend (JsonObject) -> String?, close: () -> Unit, cancel: @Composable () -> Unit) {
    val graph = state.graph?.let(DependencyGraph::of)
    val settings = StartProjectCopy.defaultSettings(state.integration, doc.number("maxConcurrentTasks"), graph)
    val request = StartProjectCopy.ownerRequest(settings, digest)
    // The owner's edits live and die with this sheet; until there are any, the default rule's settings as the reads resolve them —
    // the main branch among them, by the start's order (`StartProjectCopy.startMainBranch`).
    var edited by remember(digest) { mutableStateOf<StartProjectCopy.Draft?>(null) }
    val draft = edited ?: StartProjectCopy.Draft.of(settings, state.integration)
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val criteria = doc.objects("acceptanceCriteriaItems").sortedBy { it.number("ordinal") ?: 0 }.map { StartCriterion(it.number("ordinal") ?: 0, it.text("text").orEmpty()) }
    StartProjectCard(doc.text("id").orEmpty(), doc.text("title").orEmpty(), asked = false, askedAgo = null, request = request, criteria = criteria,
        plan = StartProjectCopy.planView(graph, ProjectDoc.taskCount(doc)),
        // A project nobody coordinates yet gets its first coordinator from a start with Automatic on, and the card says so.
        hasCoordinator = doc.text("coordinatorSessionId") != null,
        escalationSeconds = state.integration?.number("escalationSeconds") ?: doc.obj("integration")?.number("escalationSeconds") ?: StartProjectCopy.defaultEscalationSeconds,
        draft = draft, onDraft = { edited = it },
        // A project started at another end meanwhile is the door's to refuse, 409, said over the door's words.
        standing = StartProjectCopy.Standing.LIVE, enabled = enabled, starting = starting, error = error, tag = "project-start", startTag = "project-start-confirm",
        onStart = {
            if (draft.complete && !starting) {
                setStarting(true)
                scope.launch {
                    try { val failure = start(StartProjectCopy.body(request, draft, requestId = null)); if (failure == null) close() else error = failure }
                    finally { setStarting(false) }
                }
            }
        }, onViewTasks = viewTasks, branches = ProjectMainBranch.branches(state.integration), lastChoice = ProjectMainBranch.lastChoice(state.integration),
        trailing = cancel)
}

/** "Review and start" — the coordinator's request to start, over the project's sessions page (`RequestedStartProjectSheet`, A05-7):
 * the card its conversation draws, read afresh as the sheet opens; Start answers the request at the start door, and a request that
 * stopped standing before the sheet could draw it is said, not drawn blank. [start] answers a refusal's sentence, null when it went through. */
@Composable
internal fun RequestedStartSheet(api: ProjectApi, id: String, enabled: Boolean, viewTasks: () -> Unit, close: () -> Unit,
    start: suspend (JsonObject) -> String?) {
    var document by remember { mutableStateOf<JsonObject?>(null) }
    var confirmation by remember { mutableStateOf<JsonObject?>(null) }
    var openItems by remember { mutableStateOf<JsonObject?>(null) }
    var graph by remember { mutableStateOf<JsonObject?>(null) }
    // The project's main branch as it stands, this account's last choice for its repository and the branches to choose from: the
    // card waits for this read too, so it does not open on main and move; one that failed offers no main branch.
    var integration by remember { mutableStateOf<JsonObject?>(null) }
    var integrationAnswered by remember { mutableStateOf(false) }
    var unread by remember { mutableStateOf(false) }
    // The request as first drawn: a press in flight keeps its card while the reads catch up.
    var held by remember { mutableStateOf<JsonObject?>(null) }
    var edited by remember { mutableStateOf<StartProjectCopy.Draft?>(null) }
    var starting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    // Read as the sheet opens; a read that did not answer is asked again every 4 s, as the page's own reads are, until the card can
    // be drawn — this sheet holds nothing from before it opened to fall back on.
    LaunchedEffect(id) {
        suspend fun <T> read(block: suspend () -> T): T? = try { block() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        while (document == null || openItems == null || confirmation == null) {
            coroutineScope {
                val doc = async { document ?: read { api.document(id) } }; val items = async { openItems ?: read { api.openItems(id) } }
                val plan = async { graph ?: read { api.graph(id) } }; val seal = async { confirmation ?: read { api.confirmation(id) } }
                val line = async { if (integrationAnswered) integration else read { api.integration(id) } }
                document = doc.await(); openItems = items.await(); graph = plan.await(); confirmation = seal.await()
                integration = line.await(); integrationAnswered = true
                unread = confirmation == null
            }
            if (document == null || openItems == null || confirmation == null) delay(4_000)
        }
    }
    Dialog(onDismissRequest = { if (!starting) close() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth(0.94f).testTag("project-start-request-sheet"), shape = MaterialTheme.shapes.large) {
            Column(Modifier.heightIn(max = 720.dp).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                val cancel: @Composable () -> Unit = { TextButton(onClick = close, enabled = !starting, modifier = Modifier.testTag("project-start-request-cancel")) { Text("Cancel") } }
                val doc = document
                val row = doc?.let { StartProjectCopy.live(openItems, ProjectDoc.started(it)) } ?: held
                val request = StartProjectCopy.request(row)
                if (doc != null && confirmation != null && row != null && request != null && integrationAnswered) {
                    LaunchedEffect(row) { if (held == null) held = row }
                    val draft = edited ?: StartProjectCopy.Draft.of(request.settings, integration)
                    val itemId = row.text("itemId").orEmpty()
                    val criteria = doc.objects("acceptanceCriteriaItems").sortedBy { it.number("ordinal") ?: 0 }
                        .map { StartCriterion(it.number("ordinal") ?: 0, it.text("text").orEmpty()) }
                    StartProjectCard(id, doc.text("title").orEmpty(), asked = true, askedAgo = ProjectTime.ago(row.text("waitingSince"), Instant.now()),
                        request = request, criteria = criteria, plan = StartProjectCopy.planView(graph?.let(DependencyGraph::of), ProjectDoc.taskCount(doc)),
                        hasCoordinator = true, escalationSeconds = doc.obj("integration")?.number("escalationSeconds") ?: StartProjectCopy.defaultEscalationSeconds,
                        draft = draft, onDraft = { edited = it },
                        standing = if (starting) StartProjectCopy.Standing.LIVE else StartProjectCopy.standing(itemId, request, openItems, confirmation, ProjectDoc.started(doc)),
                        enabled = enabled, starting = starting, error = error, tag = "project-start-request", startTag = "project-start-request-confirm",
                        onStart = {
                            if (draft.complete && !starting) {
                                starting = true; error = null
                                scope.launch {
                                    try { val failure = start(StartProjectCopy.body(request, draft, requestId = itemId)); if (failure == null) close() else error = failure }
                                    finally { starting = false }
                                }
                            }
                        }, onViewTasks = viewTasks, branches = ProjectMainBranch.branches(integration), lastChoice = ProjectMainBranch.lastChoice(integration),
                        trailing = cancel)
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("▶ ${StartProjectCopy.title}", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary)
                        cancel()
                    }
                    when {
                        doc != null && confirmation != null && openItems != null && integrationAnswered -> Note(StartProjectCopy.requestGone)
                        unread -> Note(StartProjectCopy.unreadSeal)
                        else -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                    }
                }
            }
        }
    }
}

/** "Is this project done?" over the project page — Review on the coordinator's request, or the owner's own Record as done… — the
 * same card the coordinator conversation draws (iOS main `ProjectDoneSheet`): pressed at the owner's done door it turns into its
 * receipt in place, with Done where Cancel was; "Not yet…" sends the note and the sheet goes down, and so does Reopen project. A
 * refusal stays on the card in the door's words. */
@Composable
internal fun ProjectDoneSheet(api: ProjectApi, id: String, state: ProjectPageState, now: Instant, enabled: Boolean, close: () -> Unit,
    write: suspend (String, suspend () -> Unit) -> String?) {
    val doc = state.document ?: return
    val row = ProjectDone.live(state.openItems, ProjectDoc.status(doc))
    var confirmation by remember { mutableStateOf<JsonObject?>(null) }
    var unread by remember { mutableStateOf(false) }
    var record by remember { mutableStateOf<JsonObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    // While a press is out the sheet cannot be put away from it.
    var writing by remember { mutableStateOf(false) }
    LaunchedEffect(id) {
        try { confirmation = api.confirmation(id); unread = false } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { unread = true }
    }
    val digest = confirmation?.obj("currentVersion")?.text("digest")
    suspend fun press(refusal: String, body: suspend () -> Unit): Boolean {
        writing = true
        try { error = write(refusal, body); return error == null } finally { writing = false }
    }
    val itemId = row?.text("itemId")
    val notYet: (suspend (String) -> Boolean)? = if (itemId == null) null else { note ->
        press("${ProjectDone.notDeclined} — ") { api.declineDone(id, itemId, note) }.also { if (it) close() }
    }
    Dialog(onDismissRequest = { if (!writing) close() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth(0.94f).testTag("project-done-sheet"), shape = MaterialTheme.shapes.large) {
            Column(Modifier.heightIn(max = 720.dp).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                ProjectDoneCard(doc, row, confirmation?.obj("confirmation")?.text("confirmedAt"), ProjectDone.openItemsCount(state.openItems),
                    ProjectDone.runningCount(doc), record, sealRead = row?.obj("doneRequest") != null || digest != null, now = now, enabled = enabled,
                    error = error, tag = "project-done",
                    onRecord = {
                        val body = ProjectDone.body(doc, itemId, row?.obj("doneRequest"), digest)
                        var answer: JsonObject? = null
                        if (body != null && press("${ProjectDone.notRecorded} — ") { answer = api.done(id, body) }) record = answer ?: buildJsonObject { put("status", "DONE") }
                    },
                    onNotYet = notYet,
                    onReopen = { if (press("${ProjectDone.notReopened} — ") { api.setStatus(id, "OPEN", "reopen:${doc.text("updatedAt")}") }) { record = null; close() } },
                    trailing = { TextButton(onClick = close, enabled = !writing, modifier = Modifier.testTag("project-done-cancel")) {
                        Text(if (record == null) "Cancel" else "Done") } })
                if (unread && row == null) Note(StartProjectCopy.unreadSeal)
            }
        }
    }
}
