package io.orbitd.android.projects

import android.graphics.BitmapFactory
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.time.Instant

// The done card's and the criteria card's follow-ups (web ProjectSettlementCard's NonCodeBanner and DoneFindings,
// MoveCriterionDialog, ConfirmCriterionDialog and ProjectAcceptanceCard's confirmation rows): drawn from the reads they are given,
// every word `DoneCopy`'s and every decision `DoneFollowUps`'.

/** How many criteria the Done when list shows open before it folds behind Show all (web `DONE_WHEN_OPEN_UP_TO`). */
internal const val DONE_WHEN_OPEN_UP_TO = 12

/** What a done card or the criteria card can do beyond recording: open a task, a project or a conversation, change the mark, and
 * the owner's doors on a criterion — each write throws the door's refusal. The two dialogs it opens are its own state. */
class CriteriaActions(
    val projectId: String,
    val openTask: (String) -> Unit,
    val openProject: (String) -> Unit,
    val openSession: (String) -> Unit,
    val changeMark: (() -> Unit)?,
    val projects: suspend () -> List<JsonObject>,
    val move: suspend (String, JsonObject) -> Unit,
    val confirm: suspend (String, JsonObject) -> Unit,
    val upload: suspend (String, String, ByteArray) -> String,
    val image: suspend (String) -> ByteArray,
    val withdraw: suspend (String) -> Unit = {},
    val check: suspend (String) -> Unit = {},
    /** Answers the server's hold notice, when a change of mode waits for a decision. */
    val setMode: suspend (JsonObject) -> String? = { null },
) {
    var moving by mutableStateOf<DoneFollowUps.MoveSubject?>(null)
    /** The criterion (an `acceptanceCriteriaItems` row) the Confirm sheet is open for. */
    var confirming by mutableStateOf<JsonObject?>(null)
    fun startConfirm(item: JsonObject) { confirming = item }
}

/** The two sheets the actions open, wherever they are drawn from. */
@Composable
internal fun CriteriaDialogs(actions: CriteriaActions) {
    actions.moving?.let { subject -> MoveCriterionDialog(subject, actions) { actions.moving = null } }
    actions.confirming?.let { item -> ConfirmCriterionDialog(item, actions) { actions.confirming = null } }
}

/** The non-code banner (decided board ③ A): what the mark means, who set it and when, its reason, and Change. */
@Composable
internal fun NonCodeBanner(doc: JsonObject, tag: String, change: (() -> Unit)?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val accent = MaterialTheme.colorScheme.primary
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(10.dp))
        .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.25f), RoundedCornerShape(10.dp)).padding(10.dp).testTag(tag),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(16.dp).border(1.dp, muted, CircleShape).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
            Text("i", style = MaterialTheme.typography.labelSmall, color = muted)
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)) { append(DoneCopy.NON_CODE_LEAD) }
                append(" ${DoneCopy.NON_CODE_BODY}")
                DoneFollowUps.provenance(doc)?.let { append(" $it") }
                if (change != null) {
                    append(" · ")
                    withLink(LinkAnnotation.Clickable("change", TextLinkStyles(SpanStyle(color = accent))) { change() }) { append(DoneCopy.NON_CODE_CHANGE) }
                }
            }, style = MaterialTheme.typography.labelMedium, color = muted)
            DoneFollowUps.reasonLine(doc)?.let { Text(it, Modifier.testTag("$tag-reason"), style = MaterialTheme.typography.labelMedium, color = muted) }
        }
    }
}

/** One criterion on the done card: its number and words, who confirmed it, and its state — met in green, not met in red, a
 * branchless or stale one in amber — with Confirm… on an unmet criterion met by confirmation. */
@Composable
internal fun DoneCriterionRow(doc: JsonObject, criterion: ProjectDone.Criterion, ordinal: String, nonCode: Boolean, main: String, tag: String,
    confirm: ((JsonObject) -> Unit)?) {
    val state = DoneFollowUps.rowState(criterion.derived, nonCode, main)
    val byConfirmation = DoneFollowUps.byConfirmation(criterion.derived)
    val ink = when { state.warn -> LocalOrbitColors.current.needsYou; criterion.satisfied -> LocalOrbitColors.current.success
        else -> MaterialTheme.colorScheme.error }
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp).testTag(tag), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(ordinal, Modifier.width(14.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(criterion.text, style = MaterialTheme.typography.bodySmall)
            if (byConfirmation && criterion.satisfied) DoneFollowUps.confirmationLine(criterion.derived.obj("confirmation")?.obj("current"))?.let {
                Text(it, Modifier.testTag("$tag-confirmed"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(state.text, Modifier.widthIn(max = 150.dp).testTag("$tag-state"), style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold, color = ink, textAlign = TextAlign.End)
            if (byConfirmation && !criterion.satisfied && confirm != null && criterion.item != null)
                SmallPress(if (criterion.derived.obj("confirmation")?.text("state") == "STALE") DoneCopy.CRITERION_CONFIRM_AGAIN else DoneCopy.CRITERION_CONFIRM,
                    "$tag-confirm") { confirm(criterion.item) }
        }
    }
}

/** Board 02 G: "Criterion 4 moved to <project> by you · <when>", the project's name a link. */
@Composable
internal fun MovedOutLines(movedOut: List<JsonObject>, tag: String, openProject: ((String) -> Unit)?) {
    if (movedOut.isEmpty()) return
    val accent = MaterialTheme.colorScheme.primary
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.04f), RoundedCornerShape(8.dp)).padding(10.dp).testTag(tag),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        movedOut.forEach { moved ->
            Text(buildAnnotatedString {
                append("${DoneFollowUps.movedOutLead(moved)} ")
                val to = moved.text("toProjectId").orEmpty()
                if (openProject != null) withLink(LinkAnnotation.Clickable("project:$to", TextLinkStyles(SpanStyle(color = accent))) { openProject(to) }) {
                    append(moved.text("toProjectTitle").orEmpty()) }
                else append(moved.text("toProjectTitle").orEmpty())
                append(" ${DoneFollowUps.movedBy(moved.text("movedAt"))}")
            }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** What the done check found, grouped as the decided board ③ draws it: what stands in the way — each unmet criterion naming its
 * open tasks with Open, and Move to a follow-up… — then, apart, what Orbit can't prove about where work landed, and what
 * recording it anyway keeps. An unmet criterion is never also reported unlanded (the server's rule). */
@Composable
internal fun DoneFindings(doc: JsonObject, findings: List<JsonObject>, tag: String, actions: CriteriaActions?) {
    val groups = DoneFollowUps.group(findings)
    val main = ProjectDone.mainBranch(doc)
    val red = MaterialTheme.colorScheme.error
    val amber = LocalOrbitColors.current.needsYou
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    if (groups.blocking.isNotEmpty()) Column(Modifier.fillMaxWidth().background(red.copy(alpha = 0.06f), RoundedCornerShape(10.dp))
        .border(1.dp, red.copy(alpha = 0.3f), RoundedCornerShape(10.dp)).padding(10.dp).testTag("$tag-blockers"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(DoneFollowUps.standsInWay(groups.blocking.size), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        groups.unmet.forEach { finding ->
            val ordinal = finding.obj("criterion")?.number("ordinal")
            Column(Modifier.testTag("$tag-unmet:$ordinal"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${ordinal ?: ""}", Modifier.width(14.dp), style = MaterialTheme.typography.labelMedium, color = muted)
                    Text(ProjectDone.findingLine(finding, main, DoneFollowUps.findingByConfirmation(doc, finding)), style = MaterialTheme.typography.labelMedium)
                }
                finding.objects("tasks").forEach { task ->
                    Row(Modifier.fillMaxWidth().padding(start = 22.dp).background(MaterialTheme.colorScheme.surface, RoundedCornerShape(8.dp))
                        .border(1.dp, red.copy(alpha = 0.2f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("●", Modifier.clearAndSetSemantics {}, style = MaterialTheme.typography.labelSmall, color = amber)
                        Text(task.text("title").orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.labelMedium)
                        if (actions != null) task.text("taskId")?.let { taskId -> SmallPress(DoneCopy.DONE_CARD_OPEN, "$tag-open:$taskId") { actions.openTask(taskId) } }
                    }
                }
                if (actions != null) DoneFollowUps.moveSubject(doc, finding)?.let { subject ->
                    Row(Modifier.padding(start = 22.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SmallPress(DoneCopy.DONE_CARD_MOVE_TO_FOLLOW_UP, "$tag-move:$ordinal") { actions.moving = subject }
                        Text(DoneFollowUps.moveHint(ordinal), Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = muted)
                    }
                }
            }
        }
        groups.otherRefusals.forEach { Text(ProjectDone.findingLine(it, main), style = MaterialTheme.typography.labelMedium) }
    }
    if (groups.warnings.isNotEmpty()) Column(Modifier.fillMaxWidth().background(amber.copy(alpha = 0.10f), RoundedCornerShape(10.dp))
        .border(1.dp, amber.copy(alpha = 0.35f), RoundedCornerShape(10.dp)).padding(10.dp).testTag("$tag-findings"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(DoneFollowUps.cantProve(groups.warnings.size), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold)
        groups.warnings.forEach { Text(ProjectDone.findingLine(it, main), style = MaterialTheme.typography.labelMedium) }
    }
    Text(DoneFollowUps.anywayKeeps(groups), Modifier.testTag("$tag-keeps"), color = muted, style = MaterialTheme.typography.labelMedium)
}

/** A press drawn as a link, in the row's own size (web's `variant="text"` buttons). */
@Composable
private fun TextLink(label: String, tag: String, enabled: Boolean = true, press: () -> Unit) =
    Text(label, Modifier.clickable(enabled = enabled, role = Role.Button, onClick = press).padding(vertical = 6.dp).testTag(tag),
        style = MaterialTheme.typography.labelMedium, color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)

/** A small outlined press, the cards' secondary action. */
@Composable
internal fun SmallPress(label: String, tag: String, enabled: Boolean = true, press: () -> Unit) =
    OutlinedButton(onClick = press, enabled = enabled, modifier = Modifier.heightIn(min = 32.dp).testTag(tag),
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 2.dp)) { Text(label, style = MaterialTheme.typography.labelMedium) }

/** A sheet's top bar, as iOS's navigation bar draws it: the way out, the title, and the step forward. */
@Composable
private fun SheetBar(leading: String, title: String, trailing: String?, trailingEnabled: Boolean, tag: String, back: () -> Unit, forward: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = back, modifier = Modifier.testTag("$tag-leading")) { Text(leading) }
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
        if (trailing != null) TextButton(onClick = forward, enabled = trailingEnabled, modifier = Modifier.testTag("$tag-trailing")) { Text(trailing, fontWeight = FontWeight.Bold) }
        else Spacer(Modifier.width(64.dp))
    }
}

@Composable
private fun SheetLabel(text: String) = Text(text.uppercase(), Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelSmall,
    fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun SheetSurface(tag: String, dismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) =
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth(0.94f).testTag(tag), shape = MaterialTheme.shapes.large) {
            Column(Modifier.heightIn(max = 720.dp).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
        }
    }

/** "Move to a follow-up…" (board 02 ②–④, web `MoveCriterionDialog`): one sheet, two steps. The first says what moves, what stays
 * and where to; the second what each project becomes, and its press is the move — refused in the door's words while a moving task
 * runs. The owner's alone. */
@Composable
internal fun MoveCriterionDialog(subject: DoneFollowUps.MoveSubject, actions: CriteriaActions, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var confirmStep by remember { mutableStateOf(false) }
    var newProject by remember { mutableStateOf(true) }
    var title by remember { mutableStateOf(DoneCopy.MOVE_FOLLOW_UP_TITLE.replace("{title}", subject.projectTitle)) }
    var search by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf<JsonObject?>(null) }
    var projects by remember { mutableStateOf<List<JsonObject>?>(null) }
    var moving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(newProject) {
        if (!newProject && projects == null) try { projects = actions.projects() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { projects = emptyList() }
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val ready = if (newProject) title.isNotBlank() else picked != null
    val destination = if (newProject) title.trim() else picked?.text("title").orEmpty()
    SheetSurface("move-criterion", dismiss = { if (!moving) close() }) {
        if (!confirmStep) {
            SheetBar(DoneCopy.MOVE_CANCEL, DoneCopy.MOVE_TITLE, DoneCopy.MOVE_NEXT, ready, "move-criterion", close) { confirmStep = true }
            SheetLabel(DoneCopy.MOVE_MOVES)
            DonePanel {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        DoneOrdinal("${subject.ordinal}")
                        Text(subject.text, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    }
                    if (subject.openTasks.isNotEmpty()) {
                        Text(DoneFollowUps.moveTasksPhrase(subject.openTasks.size), style = MaterialTheme.typography.labelMedium, color = muted)
                        subject.openTasks.forEach { task -> Text("● ${task.text("title").orEmpty()}", style = MaterialTheme.typography.labelMedium) }
                    }
                }
            }
            Text("${DoneCopy.MOVE_STAYS} ${DoneFollowUps.moveKeeps(subject)}", style = MaterialTheme.typography.labelMedium, color = muted)
            SheetLabel(DoneCopy.MOVE_TO)
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                SegmentedButton(newProject, { newProject = true }, SegmentedButtonDefaults.itemShape(0, 2), Modifier.testTag("move-new")) { Text(DoneCopy.MOVE_NEW_PROJECT) }
                SegmentedButton(!newProject, { newProject = false }, SegmentedButtonDefaults.itemShape(1, 2), Modifier.testTag("move-existing")) { Text(DoneCopy.MOVE_EXISTING_PROJECT) }
            }
            if (newProject) {
                OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth().testTag("move-title"), singleLine = true)
                Text(DoneCopy.MOVE_NEW_HINT, style = MaterialTheme.typography.labelMedium, color = muted)
            } else {
                OutlinedTextField(search, { search = it }, Modifier.fillMaxWidth().testTag("move-search"), singleLine = true, placeholder = { Text(DoneCopy.MOVE_SEARCH) })
                val candidates = DoneFollowUps.moveCandidates(projects.orEmpty(), subject.projectId, search)
                if (candidates.isNotEmpty()) DonePanel {
                    candidates.forEachIndexed { index, row ->
                        if (index > 0) HorizontalDivider()
                        val chosen = picked?.text("id") == row.text("id")
                        Row(Modifier.fillMaxWidth().clickable(role = Role.RadioButton) { picked = row }
                            .background(if (chosen) MaterialTheme.colorScheme.primary.copy(alpha = 0.08f) else MaterialTheme.colorScheme.surface)
                            .padding(horizontal = 12.dp, vertical = 10.dp).testTag("move-project:${row.text("id")}"), verticalAlignment = Alignment.CenterVertically) {
                            Text(row.text("title").orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                            row.obj("_count")?.number("tasks")?.let { Text(DoneCopy.MOVE_PROJECT_TASKS.replace("{n}", "$it"), style = MaterialTheme.typography.labelSmall, color = muted) }
                            if (chosen) Text("  ✓", color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
                Text(if (projects != null && candidates.isEmpty()) DoneCopy.MOVE_NO_OPEN_PROJECTS else DoneCopy.MOVE_OPEN_ONLY,
                    style = MaterialTheme.typography.labelMedium, color = muted)
            }
        } else {
            SheetBar(DoneCopy.MOVE_BACK, DoneCopy.MOVE_TITLE, null, false, "move-criterion", { if (!moving) confirmStep = false }) {}
            Text(DoneCopy.MOVE_CONFIRM_TITLE.replace("{n}", "${subject.ordinal}").replace("{project}", destination), Modifier.testTag("move-confirm-title"),
                style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            DonePanel {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(subject.projectTitle) } },
                        style = MaterialTheme.typography.bodySmall)
                    Text(DoneFollowUps.moveConfirmThis(subject), style = MaterialTheme.typography.labelMedium, color = muted)
                    HorizontalDivider()
                    Text(DoneFollowUps.moveConfirmThere(subject, newProject, destination), style = MaterialTheme.typography.labelMedium)
                }
            }
            Text(DoneCopy.MOVE_CONFIRM_RECORD, style = MaterialTheme.typography.labelMedium, color = muted)
            error?.let { Text("${DoneCopy.MOVE_NOT_MOVED} — $it", Modifier.testTag("move-error"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
            Button(onClick = {
                if (moving) return@Button
                moving = true
                scope.launch {
                    try { actions.move(subject.criterionKey, DoneFollowUps.moveBody(subject, newProject, title, picked?.text("id"))); close() }
                    catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { error = failureReason(failure) }
                    finally { moving = false }
                }
            }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("move-confirm"), enabled = !moving) {
                Text(DoneCopy.MOVE_CONFIRM_ACTION.replace("{n}", "${subject.ordinal}")) }
            OutlinedButton(onClick = close, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !moving) { Text(DoneCopy.MOVE_CANCEL) }
        }
    }
}

/** An image the reader picked, read off its content URI: its name, type and bytes — or why it can't be sent. */
private class Picked(val name: String, val mime: String, val bytes: ByteArray)

/** The Confirm sheet (board 03 ④, web `ConfirmCriterionDialog`): the criterion and how it is checked on top, then the optional
 * "What did you check?" and one optional screenshot, uploaded when picked. The owner's door; the server keeps who and when. */
@Composable
internal fun ConfirmCriterionDialog(item: JsonObject, actions: CriteriaActions, close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var note by remember { mutableStateOf("") }
    var shot by remember { mutableStateOf<Pair<String, ImageBitmap?>?>(null) }
    var uploading by remember { mutableStateOf(false) }
    var shotError by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null || uploading) return@rememberLauncherForActivityResult
        uploading = true
        scope.launch {
            try {
                val picked = withContext(Dispatchers.IO) {
                    val resolver = context.contentResolver
                    val mime = resolver.getType(uri).orEmpty()
                    val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "screenshot"
                    Picked(name, mime, resolver.openInputStream(uri)?.use { it.readBytes() } ?: ByteArray(0))
                }
                if (picked.mime !in setOf("image/png", "image/jpeg", "image/gif", "image/webp") || picked.bytes.isEmpty()) { shotError = DoneCopy.CONFIRM_SHEET_NOT_AN_IMAGE; return@launch }
                val id = actions.upload(picked.name, picked.mime, picked.bytes)
                shot = id to BitmapFactory.decodeByteArray(picked.bytes, 0, picked.bytes.size)?.asImageBitmap()
                shotError = null
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { shotError = "${DoneCopy.CONFIRM_SHEET_NOT_UPLOADED} — ${failureReason(failure)}" }
            finally { uploading = false }
        }
    }
    val ordinal = "${item.number("ordinal") ?: ""}"
    fun press() {
        if (confirming || uploading) return
        confirming = true
        scope.launch {
            try { actions.confirm(item.text("id").orEmpty(), DoneFollowUps.confirmBody(note, item.number("revision"), shot?.first)); close() }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = failureReason(failure) }
            finally { confirming = false }
        }
    }
    SheetSurface("confirm-criterion", dismiss = { if (!confirming) close() }) {
        SheetBar(DoneCopy.CONFIRM_SHEET_CANCEL, DoneCopy.CONFIRM_SHEET_TITLE.replace("{n}", ordinal), DoneCopy.CONFIRM_SHEET_CONFIRM, !confirming && !uploading,
            "confirm-criterion", { if (!confirming) close() }) { press() }
        DonePanel {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(item.text("text").orEmpty(), style = MaterialTheme.typography.bodySmall)
                item.text("verificationMethod")?.takeIf { it.isNotEmpty() }?.let {
                    Text("${DoneCopy.CONFIRM_SHEET_HOW_CHECKED} $it", style = MaterialTheme.typography.labelMedium, color = muted) }
            }
        }
        SheetLabel("${DoneCopy.CONFIRM_SHEET_WHAT_CHECKED} · ${DoneCopy.CONFIRM_SHEET_OPTIONAL}")
        OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth().testTag("confirm-note"), enabled = !confirming, minLines = 2, maxLines = 6,
            placeholder = { Text(DoneCopy.CONFIRM_SHEET_PLACEHOLDER) })
        SheetLabel("${DoneCopy.CONFIRM_SHEET_SCREENSHOT} · ${DoneCopy.CONFIRM_SHEET_OPTIONAL}")
        val current = shot
        if (current != null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            current.second?.let { Image(it, DoneCopy.CONFIRM_SHEET_SCREENSHOT, Modifier.size(56.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)),
                contentScale = ContentScale.Crop) }
            TextButton(onClick = { shot = null }, enabled = !confirming, modifier = Modifier.testTag("confirm-remove")) { Text(DoneCopy.CONFIRM_SHEET_REMOVE) }
        } else TextButton(onClick = { picker.launch("image/*") }, enabled = !uploading && !confirming, modifier = Modifier.testTag("confirm-attach")) {
            Text(if (uploading) DoneCopy.CONFIRM_SHEET_UPLOADING else "+ ${DoneCopy.CONFIRM_SHEET_ATTACH}")
        }
        shotError?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
        Text(DoneCopy.CONFIRM_SHEET_FOOTNOTE, style = MaterialTheme.typography.labelMedium, color = muted)
        error?.let { Text("${DoneCopy.CONFIRM_SHEET_NOT_RECORDED} — $it", Modifier.testTag("confirm-error"), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.error) }
        Button(onClick = { press() }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("confirm-press"), enabled = !confirming && !uploading) {
            Text(DoneCopy.CONFIRM_SHEET_CONFIRM) }
    }
}

/** A criterion met by confirmation on the criteria card (board 03 ⑤): its state sentence and when, the run or conversation, what
 * was said, the screenshot, and the owner's presses — Withdraw on a standing confirmation; Confirm… (again), an Agent check and,
 * for an earlier wording, What changed on an unmet one. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ConfirmationWorkView(item: JsonObject, actions: CriteriaActions?, now: Instant, tag: String) {
    val work = DoneFollowUps.confirmationWork(item, now)
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var comparing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val accent = MaterialTheme.colorScheme.primary
    val ink = when { work.met -> LocalOrbitColors.current.success; work.state == "STALE" -> LocalOrbitColors.current.needsYou
        work.running -> MaterialTheme.colorScheme.onSurface; else -> MaterialTheme.colorScheme.error }
    fun press(body: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            try { body(); error = null } catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { error = failureReason(failure) }
            finally { busy = false }
        }
    }
    Column(Modifier.testTag(tag), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = ink)) { append(work.sentence) }
            work.whenText?.let { withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append(" · $it") } }
        }, Modifier.testTag("$tag-state"), style = MaterialTheme.typography.labelMedium)
        work.note?.let { Text(it, Modifier.testTag("$tag-note"), style = MaterialTheme.typography.labelMedium,
            color = if (work.failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
        if (work.shots.isNotEmpty() && actions != null) ConfirmationShots(work.shots, actions)
        if (actions != null) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp),
                itemVerticalAlignment = Alignment.CenterVertically) {
                if (work.met) SmallPress(DoneCopy.CRITERION_WITHDRAW, "$tag-withdraw", !busy) { press { actions.withdraw(item.text("id").orEmpty()) } }
                else {
                    SmallPress(if (work.state == "STALE") DoneCopy.CRITERION_CONFIRM_AGAIN else DoneCopy.CRITERION_CONFIRM, "$tag-confirm", !busy) { actions.startConfirm(item) }
                    if (!work.running) TextLink(if (work.failed) DoneCopy.CRITERION_RUN_CHECK_AGAIN else DoneCopy.CRITERION_RUN_CHECK, "$tag-check", !busy) {
                        press { actions.check(item.text("id").orEmpty()) } }
                    if (work.stale != null) TextLink(if (comparing) DoneCopy.CRITERION_HIDE_CHANGES else DoneCopy.CRITERION_WHAT_CHANGED, "$tag-what-changed") {
                        comparing = !comparing }
                }
                work.runSessionId?.let { run -> TextLink(DoneCopy.CRITERION_VIEW_RUN, "$tag-run") { actions.openSession(run) } }
                work.conversationId?.let { session -> TextLink(DoneCopy.CRITERION_OPEN_CONVERSATION, "$tag-conversation") { actions.openSession(session) } }
            }
            if (comparing) work.stale?.let { WhatChanged(item, it, "$tag-changes") }
            error?.let { Text("${DoneCopy.CRITERION_ACTION_FAILED} — $it", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
        }
    }
}

/** The screenshot a confirmation was given with: a thumbnail, and how many. */
@Composable
private fun ConfirmationShots(ids: List<String>, actions: CriteriaActions) {
    var images by remember(ids) { mutableStateOf<Map<String, ImageBitmap>>(emptyMap()) }
    LaunchedEffect(ids) {
        ids.forEach { id ->
            try {
                val bytes = actions.image(id)
                withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }?.let { images = images + (id to it) }
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ids.forEach { id ->
            val image = images[id]
            if (image != null) Image(image, DoneCopy.CRITERION_SCREENSHOT, Modifier.size(36.dp), contentScale = ContentScale.Crop)
            else Box(Modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(4.dp)))
        }
        DoneFollowUps.screenshotCount(ids.size)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** Board 03 J's What changed: the wording that was confirmed beside the wording now. */
@Composable
private fun WhatChanged(item: JsonObject, confirmed: JsonObject, tag: String) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val thenText = confirmed.text("criterionText")
    val thenMethod = confirmed.text("criterionVerificationMethod").orEmpty()
    val methodMoved = thenText != null && thenMethod != item.text("verificationMethod").orEmpty()
    Column(Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.error.copy(alpha = 0.05f), RoundedCornerShape(8.dp)).padding(8.dp)) {
            Text(DoneCopy.CRITERION_WORDING_CONFIRMED.replace("{r}", "${confirmed.number("revision") ?: ""}"), style = MaterialTheme.typography.labelSmall, color = muted)
            if (thenText != null) {
                Text(thenText, style = MaterialTheme.typography.labelMedium)
                if (methodMoved && thenMethod.isNotEmpty()) Text("${DoneCopy.CONFIRM_SHEET_HOW_CHECKED} $thenMethod", style = MaterialTheme.typography.labelSmall, color = muted)
            } else Text(DoneCopy.CRITERION_WORDING_NOT_KEPT, style = MaterialTheme.typography.labelMedium, color = muted)
        }
        Column(Modifier.fillMaxWidth().background(LocalOrbitColors.current.success.copy(alpha = 0.06f), RoundedCornerShape(8.dp)).padding(8.dp)) {
            Text(DoneCopy.CRITERION_WORDING_NOW.replace("{r}", "${item.number("revision") ?: ""}"), style = MaterialTheme.typography.labelSmall, color = muted)
            Text(item.text("text").orEmpty(), style = MaterialTheme.typography.labelMedium)
            item.text("verificationMethod")?.takeIf { methodMoved && it.isNotEmpty() }?.let {
                Text("${DoneCopy.CONFIRM_SHEET_HOW_CHECKED} $it", style = MaterialTheme.typography.labelSmall, color = muted) }
        }
    }
}

/** "Met by" (board 03 ③): the row's ⋯ opens how the criterion is met — its tasks or confirmation, each with what it means — and,
 * for an unmet criterion met by confirmation, Confirm… and Run an Agent check. A change of mode is a criteria change: the server may
 * hold it for a decision, and then says so under the row. */
@Composable
internal fun CriterionModeMenu(item: JsonObject, items: List<JsonObject>, actions: CriteriaActions, tag: String) {
    var open by remember { mutableStateOf(false) }
    var held by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val mode = item.text("satisfiedBy") ?: "TASKS"
    val unconfirmed = mode == "CONFIRMATION" && item.obj("confirmation")?.text("state") != "CONFIRMED"
    fun choose(next: String) {
        open = false
        if (next == mode) return
        scope.launch {
            try { held = actions.setMode(DoneFollowUps.modeBody(items, item.text("id").orEmpty(), next)); error = null }
            catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { error = failureReason(failure) }
        }
    }
    Column {
        Box {
            Text("${DoneCopy.CRITERION_MET_BY}: ${if (mode == "CONFIRMATION") DoneCopy.CRITERION_MET_BY_CONFIRMATION else DoneCopy.CRITERION_MET_BY_TASKS} ▾",
                Modifier.clickable(role = Role.Button) { open = true }.padding(vertical = 2.dp).testTag(tag),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            DropdownMenu(open, { open = false }, Modifier.testTag("$tag-menu")) {
                Text(DoneCopy.CRITERION_MET_BY, Modifier.padding(horizontal = 12.dp, vertical = 4.dp), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                listOf(Triple("TASKS", DoneCopy.CRITERION_MODE_TASKS, DoneCopy.CRITERION_MODE_TASKS_HINT),
                    Triple("CONFIRMATION", DoneCopy.CRITERION_MODE_CONFIRMATION, DoneCopy.CRITERION_MODE_CONFIRMATION_HINT)).forEach { (value, title, hint) ->
                    DropdownMenuItem(text = { Column(Modifier.widthIn(max = 260.dp)) {
                        Text(title, fontWeight = FontWeight.SemiBold)
                        Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } }, trailingIcon = { if (mode == value) Text("✓", color = MaterialTheme.colorScheme.primary) }, onClick = { choose(value) },
                        modifier = Modifier.testTag("$tag-$value"))
                }
                if (unconfirmed) {
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text(DoneCopy.CRITERION_CONFIRM) }, onClick = { open = false; actions.startConfirm(item) })
                    if (item.obj("confirmation")?.obj("checkRunning") == null) DropdownMenuItem(text = { Text(DoneCopy.CRITERION_RUN_CHECK) }, onClick = {
                        open = false
                        scope.launch { try { actions.check(item.text("id").orEmpty()) } catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { error = failureReason(failure) } }
                    })
                }
            }
        }
        held?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = LocalOrbitColors.current.needsYou) }
        error?.let { Text("${DoneCopy.CRITERION_MODE_NOT_CHANGED} — $it", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error) }
    }
}

/** Board 02 I: "Moved from <project> by you · Nov 11" under a criterion that came from another project. */
@Composable
internal fun MovedFromLine(moved: JsonObject, openProject: ((String) -> Unit)?) {
    val accent = MaterialTheme.colorScheme.primary
    Text(buildAnnotatedString {
        append("${DoneCopy.MOVED_FROM} ")
        val from = moved.text("fromProjectId").orEmpty()
        if (openProject != null) withLink(LinkAnnotation.Clickable("project:$from", TextLinkStyles(SpanStyle(color = accent))) { openProject(from) }) {
            append(moved.text("fromProjectTitle").orEmpty()) }
        else append(moved.text("fromProjectTitle").orEmpty())
        append(" ${DoneFollowUps.movedBy(moved.text("movedAt")) { ProjectDone.date(it) }}")
    }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
