package io.orbitd.android.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.R
import kotlinx.coroutines.launch
import java.time.Instant

// Contract revision 42, part two, as the owner ruled it on the board (docs/mocks/landing-measured, D1–D9 all as recommended): the
// landing check's three values and who set it, a task's exemption from it, and the coordinator's changes with the owner's Revert.
// Android follows the board's iPhone frames.

/** The words of revision 42 part two, as the board writes them. */
object LandingMeasuredCopy {
    // ① How it runs on a request that names no line (§12.15 P-M2, ruling D1): this one line in place of the line and the landing
    // check, and no control to choose a line. New on every client at once, so OrbitKit's sources do not hold it yet.
    const val landsWhenATaskCommits = "Lands on the project’s branch when a task commits"

    // ③ The landing check's three values (D4) and who set it (D3, D9).
    const val mergeCheck = "Merge check"
    const val command = "Command"
    const val noCheck = "No check"
    const val noCheckLead = "No check."
    const val noCheckBody = "Tasks land with only their own acceptance."
    const val noCheckMain = "The merge check still runs before main."
    const val hintChanges = "Changes the coordinator makes are listed under"
    const val whoOwner = "You"
    const val whoCoordinator = "Coordinator"
    const val whoCard = "Approved on a card"
    const val whoStart = "Set at start"
    fun setAgo(setBy: String?, ago: String) = when (setBy) { "CARD" -> "confirmed $ago"; "START" -> ago; else -> "set $ago" }
    fun who(setBy: String?) = when (setBy) { "OWNER" -> whoOwner; "CARD" -> whoCard; "START" -> whoStart; else -> whoCoordinator }
    /** Under No check: who can set the landing check, each pill and what it means, in web's order and words
     *  (`LANDING_CHECK_ORIGIN_NOTES`, OrbitKit `LandingProvenanceCopy.originNotes`). */
    const val whoCanSet = "Who can set it"
    val originNotes = listOf(
        "OWNER" to "Anything you set; the coordinator then needs a card to change it.",
        "COORDINATOR" to "No card, while the merge check exists.",
        "CARD" to "A change you confirmed on a card.",
        "START" to "The coordinator proposed it and you pressed Start; it may still change without a card. A value you typed on the start card reads as You.",
    )

    // ④ A task exempt from the landing check (D5).
    const val exempt = "Exempt"
    const val removeExemption = "Remove exemption"
    fun markedAgo(ago: String) = "marked $ago"
    const val skipped = "Skipped"
    // Web's TASK_EXEMPT_COPY and OrbitKit's landing page say these under an exempt task's check list; Android does not draw them yet.
    const val mergeCheckBeforeMain = "Merge check before main"
    const val stillRuns = "Still runs"
    fun skippedCheck(label: String) = "$label · $skipped"
    fun exemptBecause(reason: String?) = if (reason.isNullOrBlank()) exempt else "$exempt: $reason"

    // ⑤ The coordinator's changes (D6) and the owner's Revert (D7).
    const val changesTitle = "Coordinator’s changes"
    fun changesCount(count: Int) = when (count) { 0 -> "No changes"; 1 -> "1 change"; else -> "$count changes" }
    const val changesIntro = "What the coordinator changed on its own since the project started. Revert puts the old value back and " +
        "takes the field away from the coordinator: it needs a card from then on."
    const val changesEmpty = "The coordinator has not changed anything on its own."
    const val fieldLandingCheck = "Landing check"
    const val fieldExempt = "Check exempt"
    const val usesMergeCheck = "Uses merge check"
    const val notExempt = "not exempt"
    const val exemptValue = "exempt"
    const val revert = "Revert"
    const val cancel = "Cancel"
    // Web's CHANGES_COPY.YOUR_CHANGE, the label alone; the row says it with what follows ([yourChange]).
    const val yourChangeLabel = "Your change"
    const val yourChange = "$yourChangeLabel · nothing to revert"
    fun revertedBy(ago: String) = "Reverted by you · $ago · coordinator needs a card for this field"
    const val revertTitle = "Revert this change?"
    fun revertBody(field: String) = "$field goes back from"
    const val revertTo = "to"
    const val revertNote = "The coordinator can no longer change this field without a card."
    const val notReverted = "That change was not reverted"
    /** On an exemption's row: the task it is about (web's list links it, OrbitKit's row opens it). */
    const val openTask = "Open task"
}

/** A pill's two inks: the board's light ones, and the same hue on a dark page. */
private data class PillInk(val fill: Color, val ink: Color)

@Composable
private fun dark() = MaterialTheme.colorScheme.surface.luminance() < 0.5f

/** "You" black, "Coordinator" amber, "Approved on a card" blue, "Set at start" purple (board .lm-who). */
@Composable
private fun whoInk(setBy: String?): PillInk {
    val dark = dark()
    return when (setBy) {
        "OWNER" -> if (dark) PillInk(Color(0xFFF1F1F4), Color(0xFF16161A)) else PillInk(Color(0xFF16161A), Color.White)
        "CARD" -> if (dark) PillInk(Color(0xFF14428F).copy(alpha = 0.55f), Color(0xFFD6E4FF)) else PillInk(Color(0xFFD6E4FF), Color(0xFF14428F))
        "START" -> if (dark) PillInk(Color(0xFF3B2FA0).copy(alpha = 0.6f), Color(0xFFE3E0FF)) else PillInk(Color(0xFFE3E0FF), Color(0xFF3B2FA0))
        else -> if (dark) PillInk(Color(0xFF8A4B00).copy(alpha = 0.55f), Color(0xFFFFE8C7)) else PillInk(Color(0xFFFFE8C7), Color(0xFF8A4B00))
    }
}

@Composable
private fun Pill(text: String, ink: PillInk, tag: String) = Text(text, Modifier.background(ink.fill, RoundedCornerShape(50))
    .padding(horizontal = 8.dp, vertical = 1.dp).testTag(tag), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = ink.ink)

/** Who wrote a value — one of the four pills — and when, under the value (D3). */
@Composable
internal fun WhoLine(setBy: String?, `when`: String?, tag: String) {
    Row(Modifier.testTag(tag), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Pill(LandingMeasuredCopy.who(setBy), whoInk(setBy), "$tag:who")
        `when`?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** Under No check (web's `project-landing-who`, OrbitKit's `landing-check-who-can-set`): who can set the landing check — each of the
 * four pills and what it means. */
@Composable
internal fun WhoCanSet(tag: String) {
    Column(Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(LandingMeasuredCopy.whoCanSet, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
        LandingMeasuredCopy.originNotes.forEach { (by, note) -> WhoLine(by, note, "$tag:$by") }
    }
}

/** The amber "Exempt" chip (board .lm-skipchip). */
@Composable
internal fun ExemptChip(tag: String) = Pill(LandingMeasuredCopy.exempt,
    if (dark()) PillInk(Color(0xFF7A5300).copy(alpha = 0.6f), Color(0xFFFFE08A)) else PillInk(Color(0xFFFFF1C2), Color(0xFF7A5300)), tag)

/** The landing check's three values side by side, one of them chosen (D4): the platform's segmented control. */
@Composable
internal fun LandingCheckSegments(mode: ProjectLandingCheck.Mode, enabled: Boolean, tag: String, pick: (ProjectLandingCheck.Mode) -> Unit) {
    val options = listOf(ProjectLandingCheck.Mode.MERGE_CHECK to LandingMeasuredCopy.mergeCheck, ProjectLandingCheck.Mode.COMMAND to LandingMeasuredCopy.command,
        ProjectLandingCheck.Mode.NONE to LandingMeasuredCopy.noCheck)
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().testTag(tag)) {
        options.forEachIndexed { index, (value, label) ->
            SegmentedButton(selected = mode == value, onClick = { if (mode != value) pick(value) }, enabled = enabled,
                shape = SegmentedButtonDefaults.itemShape(index, options.size), icon = {},
                modifier = Modifier.testTag("$tag:${value.name}")) { Text(label, maxLines = 1, style = MaterialTheme.typography.labelMedium) }
        }
    }
}

/** A command, monospaced, in the hairline box the board draws it in; a press opens its editor where there is one. The tag and the
 * press are one node, so the box reads as itself. */
@Composable
internal fun CommandBox(command: String, tag: String, enabled: Boolean = true, open: (() -> Unit)? = null) = Text(command, Modifier.fillMaxWidth()
    .then(if (open != null) Modifier.clickable(enabled = enabled, role = Role.Button, onClick = open) else Modifier)
    .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.3f), RoundedCornerShape(8.dp)).padding(horizontal = 9.dp, vertical = 6.dp).testTag(tag),
    style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)

/** "No check." and what it means, under the switch when it is the value. */
@Composable
internal fun NoCheckSays(tag: String) = Text(buildAnnotatedString {
    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(LandingMeasuredCopy.noCheckLead) }
    append(" ${LandingMeasuredCopy.noCheckBody} ")
    withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append(LandingMeasuredCopy.noCheckMain) }
}, Modifier.testTag(tag), style = MaterialTheme.typography.bodySmall)

/** The task page's exemption, in its Landing section (D5): "Landing check" and the chip, the reason whole, who marked it and when,
 * and the owner's Remove exemption. [change] is the newest recorded write of it, when the project's list has one. */
@Composable
internal fun TaskExemptionRow(exemption: TaskLandingExemption, change: ProjectSettingChanges.Change?, now: Instant, enabled: Boolean, remove: () -> Unit) {
    Column(Modifier.fillMaxWidth().testTag("task-landing-exempt"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(io.orbitd.android.core.cards.LandingCheckCopy.label, Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            ExemptChip("task-landing-exempt-chip")
        }
        exemption.reason?.takeIf { it.isNotBlank() }?.let {
            Text(it, Modifier.testTag("task-landing-exempt-reason"), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
        }
        // Who marked it is the record's origin, read as web reads it (Coordinator, Approved on a card, else You); with no record,
        // the task's own fields: the owner's write names no session, a coordinator's names its own.
        val setBy = change?.origin?.let { if (it == "COORDINATOR" || it == "CARD") it else "OWNER" }
            ?: if (exemption.bySessionId == null) "OWNER" else "COORDINATOR"
        WhoLine(setBy, change?.createdAt?.let { ProjectTime.ago(it, now) }?.let(LandingMeasuredCopy::markedAgo), "task-landing-exempt-by")
        FilledTonalButton(onClick = remove, enabled = enabled, modifier = Modifier.padding(top = 4.dp).heightIn(min = 36.dp).testTag("task-landing-exempt-remove"),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 4.dp)) { Text(LandingMeasuredCopy.removeExemption) }
    }
}

/** How a change's value reads in its row: the command, No check, Uses merge check — or exempt, not exempt. */
internal fun changeValue(value: ProjectSettingChanges.Value?): String = when (value) {
    is ProjectSettingChanges.Value.LandingCheck -> when { value.none -> LandingMeasuredCopy.noCheck; value.command == null -> LandingMeasuredCopy.usesMergeCheck; else -> value.command }
    is ProjectSettingChanges.Value.Exempt -> if (value.exempt) LandingMeasuredCopy.exemptValue else LandingMeasuredCopy.notExempt
    null -> "—"
}
private fun isCode(value: ProjectSettingChanges.Value?) = value is ProjectSettingChanges.Value.LandingCheck && !value.none && value.command != null

/** The field a change wrote, as its row heads it: the landing check, or "Check exempt · <task>". */
internal fun changeField(change: ProjectSettingChanges.Change, taskTitle: (String) -> String?): String =
    if (change.field == "LANDING_CHECK") LandingMeasuredCopy.fieldLandingCheck
    else listOfNotNull(LandingMeasuredCopy.fieldExempt, change.taskId?.let(taskTitle)).joinToString(" · ")

/** The page Settings' Coordinator’s changes row opens (D6), over the project page: every change newest first, from what to what, why,
 * who and when; Revert on each one the server says the owner may still put back (D7), asked first. [revert] answers a refusal's
 * sentence, null once it went through. */
@Composable
internal fun CoordinatorChangesPage(projectTitle: String, changes: List<ProjectSettingChanges.Change>, taskTitle: (String) -> String?, now: Instant,
    enabled: Boolean, close: () -> Unit, revert: suspend (ProjectSettingChanges.Change) -> String?, openTask: ((String) -> Unit)? = null) {
    var asking by remember { mutableStateOf<ProjectSettingChanges.Change?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().testTag("coordinator-changes"), color = MaterialTheme.colorScheme.background) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = close, modifier = Modifier.testTag("coordinator-changes-back")) {
                        Icon(androidx.compose.ui.res.painterResource(R.drawable.ic_back), "Back")
                    }
                    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(LandingMeasuredCopy.changesTitle, style = MaterialTheme.typography.titleMedium)
                        Text(projectTitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                    Spacer(Modifier.width(48.dp))
                }
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
                    item(key = "intro") {
                        Text(LandingMeasuredCopy.changesIntro, Modifier.padding(horizontal = 2.dp, vertical = 6.dp), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    error?.let { item(key = "error") { Text(it, Modifier.testTag("coordinator-changes-error"), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error) } }
                    if (changes.isEmpty()) item(key = "empty") { Text(LandingMeasuredCopy.changesEmpty, Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    itemsIndexed(changes, key = { _, change -> change.id }) { index, change ->
                        val first = index == 0; val last = index == changes.lastIndex
                        val shape = RoundedCornerShape(topStart = if (first) 13.dp else 0.dp, topEnd = if (first) 13.dp else 0.dp,
                            bottomStart = if (last) 13.dp else 0.dp, bottomEnd = if (last) 13.dp else 0.dp)
                        Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (dark()) 1f else 0.6f), shape)) {
                            ChangeRow(change, taskTitle, now, enabled, openTask) { error = null; asking = change }
                            if (!last) HorizontalDivider(Modifier.padding(start = 13.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
                        }
                    }
                }
            }
        }
        asking?.let { change -> RevertSheet(change, taskTitle, close = { asking = null }) { revert(change).also { error = it } } }
    }
}

/** One change: its field and time, old struck through → new, the reason, then who and the row's one door or why there is none. A
 * reverted row is greyed and says so; so is one changed again since, which has nothing current to put back. */
@Composable
private fun ChangeRow(change: ProjectSettingChanges.Change, taskTitle: (String) -> String?, now: Instant, enabled: Boolean,
    openTask: ((String) -> Unit)?, ask: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val reverted = change.revertedAt != null
    val stale = !reverted && !change.revertible && change.origin == "COORDINATOR"
    Column(Modifier.fillMaxWidth().alpha(if (reverted || stale) 0.62f else 1f).padding(horizontal = 13.dp, vertical = 11.dp).testTag("change:${change.id}"),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(changeField(change, taskTitle), Modifier.weight(1f), fontWeight = FontWeight.SemiBold, maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            ProjectTime.ago(change.createdAt, now)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
        }
        Text(buildAnnotatedString {
            val code = SpanStyle(fontFamily = FontFamily.Monospace)
            withStyle(SpanStyle(color = muted, textDecoration = TextDecoration.LineThrough)) {
                if (isCode(change.old)) withStyle(code) { append(changeValue(change.old)) } else append(changeValue(change.old))
            }
            withStyle(SpanStyle(color = muted)) { append("  →  ") }
            if (isCode(change.new)) withStyle(code) { append(changeValue(change.new)) }
            else withStyle(SpanStyle(fontWeight = if (change.field == "LANDING_CHECK") FontWeight.SemiBold else FontWeight.Normal)) { append(changeValue(change.new)) }
        }, Modifier.testTag("change:${change.id}:values"), style = MaterialTheme.typography.bodySmall)
        change.reason?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        // An exemption's row opens the task it is about (web's "Open task" link, OrbitKit's button).
        if (change.field == "TASK_LANDING_CHECK_EXEMPT" && openTask != null) change.taskId?.let { taskId ->
            TextButton(onClick = { openTask(taskId) }, Modifier.testTag("change:${change.id}:open-task"), contentPadding = PaddingValues(0.dp)) {
                Text(LandingMeasuredCopy.openTask, style = MaterialTheme.typography.bodySmall)
            }
        }
        Row(Modifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Pill(LandingMeasuredCopy.who(change.origin), whoInk(change.origin), "change:${change.id}:who")
            // As web's list and OrbitKit's rows: Revert where the server allows it; the owner's own and a card's say there is nothing
            // to revert; a coordinator's change that moved on since says nothing.
            val note = when {
                reverted -> LandingMeasuredCopy.revertedBy(ProjectTime.ago(change.revertedAt, now) ?: "just now")
                change.revertible -> null
                change.origin != "COORDINATOR" -> LandingMeasuredCopy.yourChange
                else -> null
            }
            if (note != null) Text(note, Modifier.weight(1f).testTag("change:${change.id}:note"), style = MaterialTheme.typography.bodySmall, color = muted)
            else if (change.revertible) FilledTonalButton(onClick = ask, enabled = enabled, modifier = Modifier.heightIn(min = 32.dp).testTag("change:${change.id}:revert"),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 2.dp),
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.error.copy(alpha = 0.11f),
                    contentColor = MaterialTheme.colorScheme.error)) { Text(LandingMeasuredCopy.revert, fontWeight = FontWeight.SemiBold) }
        }
    }
}

/** Revert, asked first (D7): what goes back to what, and that the field is the owner's from then on. A refusal keeps the sheet up
 * with the door's words under it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RevertSheet(change: ProjectSettingChanges.Change, taskTitle: (String) -> String?, close: () -> Unit, press: suspend () -> String?) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var refused by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = { if (!busy) close() }, modifier = Modifier.testTag("revert-sheet")) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(LandingMeasuredCopy.revertTitle, style = MaterialTheme.typography.titleMedium)
            Text(buildAnnotatedString {
                val code = SpanStyle(fontFamily = FontFamily.Monospace, background = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
                append("${LandingMeasuredCopy.revertBody(changeField(change, taskTitle))} ")
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { if (isCode(change.new)) withStyle(code) { append(changeValue(change.new)) } else append(changeValue(change.new)) }
                append(" ${LandingMeasuredCopy.revertTo} ")
                if (isCode(change.old)) withStyle(code) { append(changeValue(change.old)) } else withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(changeValue(change.old)) }
                append(".")
            }, Modifier.testTag("revert-sheet-body"), style = MaterialTheme.typography.bodyMedium)
            Text(LandingMeasuredCopy.revertNote, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            refused?.let { Text(it, Modifier.testTag("revert-sheet-error"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = {
                    busy = true
                    scope.launch { try { val failure = press(); if (failure == null) close() else refused = failure } finally { busy = false } }
                }, Modifier.weight(1f).heightIn(min = 44.dp).testTag("revert-sheet-confirm"), enabled = !busy,
                    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.error),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                    Text(LandingMeasuredCopy.revert, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center) }
                FilledTonalButton(onClick = close, Modifier.weight(1f).heightIn(min = 44.dp).testTag("revert-sheet-cancel"), enabled = !busy) {
                    Text(LandingMeasuredCopy.cancel) }
            }
        }
    }
}

/** The entry row to the list, in Settings (D6): "Coordinator’s changes", the count and the ›. */
@Composable
internal fun CoordinatorChangesRow(count: Int, open: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).testTag("project-coordinator-changes"),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(LandingMeasuredCopy.changesTitle, Modifier.weight(1f))
            Text("${LandingMeasuredCopy.changesCount(count)}  ›", Modifier.testTag("project-coordinator-changes-count"),
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
