package io.orbitd.android.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.taskprojects.canWrite
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.Instant

// "Is this project done?", its receipt, and the terminal "This project is done · recorded by Orbit" — the closing cards
// (iOS ProjectDoneCards.swift), drawn from what they are given and from nothing else: the coordinator conversation draws them
// (`CoordinatorDoneCard`) and the project page's Review / Record as done… opens the same card over the page (`ProjectDoneSheet`).
// Every word is `ProjectDone`'s; every number is the server's (`derivedDone.counts`), and nothing here counts anything itself.

/** "Is this project done?" — the coordinator's call, Done when, what Orbit can't prove, what Orbit checked and the two answers —
 * or, once the project is recorded done, its receipt. The whole card wherever it is drawn, never a preview that opens a review.
 * `request` is the coordinator's open DONE_REQUEST row (null for a card nobody asked for: Orbit then fills in the gaps); `record`
 * is what a press here recorded before the reads caught up; the press is dead until a seal has been read (`sealRead`). */
@Composable
internal fun ProjectDoneCard(doc: JsonObject, request: JsonObject?, confirmedAt: String?, openItems: Int, running: Int, record: JsonObject?,
    sealRead: Boolean, now: Instant, enabled: Boolean, error: String?, tag: String, onRecord: suspend () -> Unit,
    onNotYet: (suspend (String) -> Boolean)?, onReopen: (suspend () -> Unit)?, trailing: @Composable () -> Unit = {}) {
    if (ProjectDone.recorded(doc, record)) ProjectDoneReceipt(doc, record, enabled, error, tag, onReopen, trailing)
    else ProjectDoneQuestion(doc, request, confirmedAt, openItems, running, sealRead, now, enabled, error, tag, onRecord, onNotYet, trailing)
}

@Composable
private fun ProjectDoneQuestion(doc: JsonObject, request: JsonObject?, confirmedAt: String?, openItems: Int, running: Int, sealRead: Boolean,
    now: Instant, enabled: Boolean, error: String?, tag: String, onRecord: suspend () -> Unit, onNotYet: (suspend (String) -> Boolean)?,
    trailing: @Composable () -> Unit) {
    val counts = ProjectDone.counts(doc)
    val asked = request?.obj("doneRequest")
    var recording by remember { mutableStateOf(false) }
    // "Not yet…" and the note it asks for, kept while the card is up.
    var notYetOpen by rememberSaveable(tag) { mutableStateOf(false) }
    var note by rememberSaveable(tag) { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var criteriaOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val accent = MaterialTheme.colorScheme.primary
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("✓", Modifier.clearAndSetSemantics {}, color = accent, style = MaterialTheme.typography.titleMedium)
            Text(ProjectDone.heading, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = accent)
            trailing()
        }
        // Which project, and who asked and how long it has waited — or that nobody did.
        Text(ProjectDone.meta(doc.text("title").orEmpty(), asked != null, if (asked != null) ProjectDone.requestWaiting(request.text("waitingSince"), now) else null),
            Modifier.testTag("$tag-meta"), style = MaterialTheme.typography.labelMedium, color = muted)
        asked?.let { DoneHead(ProjectDone.coordinatorCall); DonePanel { Text(it.text("judgment").orEmpty(), Modifier.padding(12.dp).testTag("$tag-judgment")) } }
        // Done when: the three counts, and every criterion one press away.
        val criteria = ProjectDone.criteria(doc)
        val count = counts?.number("criteria") ?: criteria.size
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { DoneHead(ProjectDone.doneWhenHead(count)) }
            if (count > 0) Text(if (criteriaOpen) ProjectDone.showLess else ProjectDone.showAll(count),
                Modifier.padding(top = 6.dp).clickable(role = Role.Button) { criteriaOpen = !criteriaOpen }.testTag("$tag-criteria"),
                style = MaterialTheme.typography.labelMedium, color = accent)
        }
        Text(ProjectDone.cardTally(counts), Modifier.testTag("$tag-tally"), style = MaterialTheme.typography.labelMedium, color = muted)
        if (criteriaOpen) DonePanel {
            criteria.forEachIndexed { index, criterion ->
                if (index > 0) HorizontalDivider()
                Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DoneOrdinal("${criterion.ordinal ?: index + 1}")
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(criterion.text, style = MaterialTheme.typography.bodySmall)
                        Text(ProjectDone.criterionState(criterion), style = MaterialTheme.typography.labelMedium, color = muted)
                    }
                }
            }
        }
        ProjectDoneGapList(doc, ProjectDone.gaps(doc, asked), tag)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("✓", Modifier.clearAndSetSemantics {}, style = MaterialTheme.typography.labelMedium, color = LocalOrbitColors.current.success)
            Text(ProjectDone.orbitCheckedLine(counts, confirmedAt, openItems, running), Modifier.testTag("$tag-orbit-checked"),
                style = MaterialTheme.typography.labelMedium, color = muted)
        }
        Text(ProjectDone.recordingExplanation, style = MaterialTheme.typography.bodyMedium)
        error?.let { Text(it, Modifier.testTag("$tag-error"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
        if (notYetOpen && onNotYet != null) {
            OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth().testTag("$tag-note"), enabled = !sending,
                placeholder = { Text(ProjectDone.missingBeforeDone) }, minLines = 2, maxLines = 5)
            Text(ProjectDone.notYetHint, style = MaterialTheme.typography.labelMedium, color = muted)
            Button(onClick = {
                val text = ProjectDone.declineNote(note) ?: return@Button
                if (sending) return@Button
                sending = true
                scope.launch { try { if (onNotYet(text)) { note = ""; notYetOpen = false } } finally { sending = false } }
            }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag-send"), enabled = enabled && !sending && ProjectDone.declineNote(note) != null) {
                Text(ProjectDone.sendToCoordinator) }
            OutlinedButton(onClick = { notYetOpen = false }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag-back"), enabled = !sending) {
                Text(ProjectDone.back) }
        } else {
            // One press, one write: the seal and the gaps the card shows.
            Button(onClick = {
                if (!sealRead || recording) return@Button
                recording = true
                scope.launch { try { onRecord() } finally { recording = false } }
            }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag-record"), enabled = enabled && sealRead && !recording) { Text(ProjectDone.recordLabel(counts)) }
            if (asked != null && onNotYet != null) OutlinedButton(onClick = { notYetOpen = true }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag-not-yet"),
                enabled = !recording) { Text(ProjectDone.notYet) }
        }
    }
}

/** What Orbit can't prove: each gap under the criterion it names, why Orbit cannot prove it, and what the coordinator checked
 * instead — three at a time, the rest one press away. */
@Composable
private fun ProjectDoneGapList(doc: JsonObject, gaps: List<JsonObject>, tag: String) {
    var expanded by remember { mutableStateOf(false) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val success = LocalOrbitColors.current.success
    DoneHead(ProjectDone.gapsHead(gaps.size))
    if (gaps.isEmpty()) { Text(ProjectDone.noGaps, style = MaterialTheme.typography.labelMedium, color = muted); return }
    val shown = if (expanded) gaps else gaps.take(3)
    DonePanel {
        shown.forEachIndexed { index, gap ->
            if (index > 0) HorizontalDivider()
            val key = gap.text("criterionKey").orEmpty()
            val item = ProjectDone.criterion(doc, key)
            Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp).testTag("$tag-gap:$key"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                DoneOrdinal("${item?.number("ordinal") ?: index + 1}")
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(gap.text("title") ?: item?.text("text") ?: key, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    gap.text("whyNotProven")?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = muted) }
                    ProjectDone.checkedLine(gap)?.let { checked -> Text(buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = success)) { append("✓ ${ProjectDone.coordinatorChecked}: ") }
                        append(checked)
                    }, style = MaterialTheme.typography.labelMedium) }
                }
            }
        }
    }
    if (!expanded && gaps.size > shown.size) Text(ProjectDone.showAll(gaps.size), Modifier.clickable(role = Role.Button) { expanded = true }.testTag("$tag-gaps-all"),
        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
}

/** The record a press leaves — "This project is done", who recorded it and when, what was accepted, and the way back: Reopen project. */
@Composable
private fun ProjectDoneReceipt(doc: JsonObject, record: JsonObject?, enabled: Boolean, error: String?, tag: String, onReopen: (suspend () -> Unit)?,
    trailing: @Composable () -> Unit) {
    var reopening by remember { mutableStateOf(false) }
    var acceptedOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val accepted = ProjectDone.accepted(doc, record)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag("$tag-receipt"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        DoneSettledHead(ProjectDone.provenanceBadge, trailing)
        Text(ProjectDone.receiptMeta(doc, record), Modifier.testTag("$tag-receipt-meta"), style = MaterialTheme.typography.labelMedium, color = muted)
        Text(ProjectDone.receiptLine(doc, record), Modifier.testTag("$tag-receipt-line"), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        Text(ProjectDone.receiptTally(doc, record), Modifier.testTag("$tag-receipt-tally"), style = MaterialTheme.typography.labelMedium, color = muted)
        if (accepted.isNotEmpty()) {
            Text(if (acceptedOpen) ProjectDone.showLess else ProjectDone.seeWhatAccepted, Modifier.clickable(role = Role.Button) { acceptedOpen = !acceptedOpen }
                .testTag("$tag-accepted"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            if (acceptedOpen) ProjectDoneGapList(doc, accepted, tag)
        }
        error?.let { Text(it, Modifier.testTag("$tag-error"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
        onReopen?.let { reopen -> OutlinedButton(onClick = {
            if (reopening) return@OutlinedButton
            reopening = true
            scope.launch { try { reopen() } finally { reopening = false } }
        }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag-reopen"), enabled = enabled && !reopening) { Text(ProjectDone.reopenProject) } }
    }
}

/** A project Orbit recorded done itself: the old question's terminal state, "This project is done · recorded by Orbit", and how its
 * criteria ended — the only part of "Why is this project not done?" a conversation still draws. */
@Composable
private fun ProjectSettledCard(doc: JsonObject, tag: String) {
    Column(Modifier.fillMaxWidth().testTag("$tag-settled"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        DoneSettledHead(ProjectDone.settledBadge(doc.text("doneBy"))) {}
        Text(ProjectDone.whyNotDoneTally(doc), Modifier.testTag("$tag-settled-tally"), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DoneSettledHead(badge: String, trailing: @Composable () -> Unit) {
    val success = LocalOrbitColors.current.success
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("✓", Modifier.clearAndSetSemantics {}, color = success, style = MaterialTheme.typography.titleMedium)
        Text(ProjectDone.thisProjectIsDone, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = success)
        Text(badge, Modifier.background(success.copy(alpha = 0.14f), RoundedCornerShape(5.dp)).padding(horizontal = 6.dp, vertical = 1.dp),
            style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = success)
        trailing()
    }
}

/** A section's head on the done cards: small, upper-cased, secondary. */
@Composable
private fun DoneHead(title: String) = Text(title.uppercase(), Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelSmall,
    fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** The grouped panel the done cards' sections sit in, rows divided by hairlines — the start card's own panel. */
@Composable
private fun DonePanel(content: @Composable ColumnScope.() -> Unit) = Column(Modifier.fillMaxWidth()
    .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
    .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.18f), RoundedCornerShape(12.dp)), content = content)

/** A criterion's number, in the dark disc the cards number their rows with. */
@Composable
private fun DoneOrdinal(text: String) = Box(Modifier.defaultMinSize(18.dp, 18.dp).background(MaterialTheme.colorScheme.onSurface, CircleShape)
    .padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
    Text(text, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.surface)
}

/** The closing card in a coordinator conversation (iOS `ProjectDoneCardView` and its terminal `ProjectNotDoneCardView`): which one
 * is re-derived from the session read on every render (`ProjectDone.slot`) — the question while the coordinator's request stands or
 * the row says Record as done…, its receipt once the project is recorded, Orbit's own DONE as the terminal card, and nothing
 * otherwise. Pressed at the project's own doors; the question turns into its receipt in place, from the record the press came back
 * with until the read catches up — and a read after the press that still says the project is not DONE means it was reopened since,
 * and the press no longer stands. A refusal stays on the card in the door's words. */
@Composable
fun CoordinatorDoneCard(app: OrbitApplication, handle: SessionHandle, sessionId: String, projectId: String, detail: JsonObject,
    reads: Map<String, JsonElement>, fresh: Boolean) {
    val doc = reads["project"] as? JsonObject
    val openItems = reads["openItems"] as? JsonObject
    val confirmation = reads["acceptanceConfirmation"] as? JsonObject
    var record by remember(handle, sessionId) { mutableStateOf<JsonObject?>(null) }
    var readsAtRecord by remember(handle, sessionId) { mutableStateOf<Map<String, JsonElement>?>(null) }
    var error by remember(handle, sessionId) { mutableStateOf<String?>(null) }
    LaunchedEffect(reads) {
        if (record != null && reads !== readsAtRecord && doc != null && ProjectDoc.status(doc) != "DONE") { record = null; readsAtRecord = null }
    }
    val live = ProjectDone.live(openItems, doc?.let(ProjectDoc::status))
    val slot = ProjectDone.slot(doc, live, detail.text("waitingKind"), record)
    if (doc == null || slot == ProjectDone.Slot.None) return
    val api = remember(handle) { ProjectApi(app.session, handle) { app.canWrite(handle) } }
    val tag = "done:$projectId"
    /** One write at the project's door, owned by the app rather than this card; the conversation is read again either way. */
    suspend fun write(refusal: String, body: suspend () -> Unit): Boolean = app.processScope.async {
        try { body(); error = null; true }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = "$refusal — ${failureReason(failure)}."; false }
        finally { app.realtime.refreshSession(); app.realtime.refreshDirectory() }
    }.await()
    val itemId = live?.text("itemId")
    val notYet: (suspend (String) -> Boolean)? = if (itemId == null) null else { note -> write(ProjectDone.notDeclined) { api.declineDone(projectId, itemId, note) } }
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
        color = if (slot is ProjectDone.Slot.Done && !ProjectDone.recorded(doc, record)) MaterialTheme.colorScheme.surfaceVariant
            else LocalOrbitColors.current.success.copy(alpha = 0.08f).compositeOver(MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(16.dp)) {
            when (slot) {
                ProjectDone.Slot.NotDone -> ProjectSettledCard(doc, tag)
                is ProjectDone.Slot.Done -> ProjectDoneCard(doc, live, confirmation?.obj("confirmation")?.text("confirmedAt"), ProjectDone.openItemsCount(openItems),
                    ProjectDone.runningCount(doc), record, sealRead = live?.obj("doneRequest") != null || confirmation?.obj("currentVersion")?.text("digest") != null,
                    now = Instant.now(), enabled = fresh, error = error, tag = tag,
                    onRecord = {
                        val body = ProjectDone.body(doc, live?.text("itemId"), live?.obj("doneRequest"), confirmation?.obj("currentVersion")?.text("digest"))
                        if (body != null) write(ProjectDone.notRecorded) { api.done(projectId, body)?.let { record = it; readsAtRecord = reads } }
                    },
                    onNotYet = notYet,
                    onReopen = { if (write(ProjectDone.notReopened) { api.setStatus(projectId, "OPEN", "reopen:${doc.text("updatedAt")}") }) { record = null; readsAtRecord = null } })
                ProjectDone.Slot.None -> Unit
            }
        }
    }
}
