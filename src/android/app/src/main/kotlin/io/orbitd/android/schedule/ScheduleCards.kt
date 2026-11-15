package io.orbitd.android.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.schedule.ScheduleCard
import io.orbitd.android.core.schedule.ScheduleChangeRecord
import io.orbitd.android.core.schedule.ScheduleCopy
import io.orbitd.android.core.schedule.ScheduleCopy as SC
import io.orbitd.android.core.schedule.ScheduleDisplay
import io.orbitd.android.core.schedule.ScheduleFindingView
import io.orbitd.android.core.schedule.ScheduleRule
import io.orbitd.android.core.schedule.ScheduleRunView
import io.orbitd.android.core.schedule.ScheduleView
import io.orbitd.android.core.schedule.ScheduleWaitingItem
import java.time.Instant
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

// The scheduled tasks' cards (docs/scheduled-tasks-design.md §8.1, §4, §7.4; iOS `ScheduleCards.swift`): the create card and the
// envelope card a conversation asks, the change line a change inside the envelope leaves, a run's strip and report at the head and the
// end of its own session, and the four Waiting on you cards. No card has an editable field: what is wrong is said in the conversation.


/** "When  Daily 10:00 · Asia/Shanghai": a card's label column and its value. */
@Composable
private fun FactRow(label: String, value: @Composable ColumnScope.() -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.width(72.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp), content = value)
    }
}

private fun bold(lead: String, rest: String): AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(lead) }
    append(rest)
}

/** "Check only · reads and reports, edits nothing", the label in bold. */
internal fun mayText(level: String): AnnotatedString = ScheduleDisplay.accessCopy(level).let { bold(it.label, "${SC.separator}${it.detail}") }

/** "Up to 7 runs a week, 30 min each", the runs in bold. */
internal fun costsText(runsPerWeek: Int, runLimitMinutes: Int): AnnotatedString {
    val parts = ScheduleDisplay.costsParts(runsPerWeek, runLimitMinutes)
    return buildAnnotatedString { append(parts.before); withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(parts.emphasis) }; append(parts.after) }
}

/** The two buttons at a card's foot: decline in the accent's words, allow filled. */
@Composable
private fun CardFoot(decline: String, allow: String, busy: Boolean, tag: String, onDecline: () -> Unit, onAllow: () -> Unit) {
    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        TextButton(onClick = onDecline, Modifier.weight(1f).testTag("$tag-decline"), enabled = !busy, shape = RoundedCornerShape(0.dp),
            contentPadding = PaddingValues(vertical = 11.dp)) { Text(decline, fontWeight = FontWeight.Medium) }
        Button(onClick = onAllow, Modifier.weight(1f).fillMaxHeight().testTag("$tag-allow"), enabled = !busy, shape = RoundedCornerShape(0.dp),
            contentPadding = PaddingValues(vertical = 11.dp)) { Text(allow, fontWeight = FontWeight.SemiBold) }
    }
}

@Composable
private fun CardBox(warn: Boolean = false, tag: String, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    val border = if (warn) scheduleWarn().copy(alpha = 0.6f) else MaterialTheme.colorScheme.outline.copy(alpha = 0.25f)
    Column(Modifier.fillMaxWidth().clip(shape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.03f)).border(1.dp, border, shape)
        .testTag(tag), content = content)
}

/** A press on a card's buttons: busy while it goes, what it said under the card, and the buttons gone once it settled. */
@Stable
private class CardPress {
    var busy by mutableStateOf(false)
    var said by mutableStateOf<String?>(null)
    var pressed by mutableStateOf(false)
}

/**
 * The create card (board 02 ①): what it is called and its read-back, When, Runs in, May, Costs and Today, the notice built from the
 * `findings` noun, and Not now / Create. Create on a card naming no zone sends the device's ([ScheduledStore.allow]); a card the server
 * withdrew says so, and is not pressed again.
 */
@Composable
fun ScheduleCreateCard(card: ScheduleCard, panel: Boolean = false, decide: suspend (Boolean) -> ScheduledStore.PressResult) {
    val scope = rememberCoroutineScope()
    val press = remember(card.id) { CardPress() }
    val zone = java.util.TimeZone.getDefault().id
    val whenText = card.`when`?.let { ScheduleDisplay.createWhen(it, Instant.now(), zone) }
    CardBox(tag = "schedule-create-card") {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(painterResource(R.drawable.ic_calendar), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                Text(SC.CreateCard.title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
            }
            if (!panel) card.title?.let { Text(it, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold)) }
            card.readBack?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                whenText?.let { w ->
                    FactRow(SC.CreateCard.`when`) {
                        Text(listOf(w.rule, w.zone).joinToString(SC.separator), style = MaterialTheme.typography.bodyMedium)
                        w.firstRun?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
                card.runsIn?.let { r ->
                    FactRow(SC.CreateCard.runsIn) { Text(ScheduleDisplay.runsInText(r.workspaceName ?: r.workspaceId, r.engine), style = MaterialTheme.typography.bodyMedium) }
                }
                card.may?.let { m -> FactRow(SC.CreateCard.may) { Text(mayText(m.accessLevel), style = MaterialTheme.typography.bodyMedium) } }
                card.costs?.let { c -> FactRow(SC.CreateCard.costs) { Text(costsText(c.runsPerWeek, c.runLimitMinutes), style = MaterialTheme.typography.bodyMedium) } }
                card.today?.let { t -> FactRow(SC.CreateCard.today) { Text(t.summary ?: t.key, style = MaterialTheme.typography.bodyMedium) } }
            }
            Text(card.notice ?: ScheduleDisplay.createNotice(null), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            press.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheduleRed()) }
        }
        if (card.isPending && !press.pressed) CardFoot(SC.Actions.notNow, SC.Actions.create, press.busy, "schedule-create-${card.id}",
            onDecline = { pressCard(scope, press, false, decide) }, onAllow = { pressCard(scope, press, true, decide) })
    }
}

private fun pressCard(scope: kotlinx.coroutines.CoroutineScope, press: CardPress, allow: Boolean, decide: suspend (Boolean) -> ScheduledStore.PressResult) {
    press.busy = true
    scope.launch {
        val result = decide(allow)
        press.said = result.said
        press.pressed = result.settled
        press.busy = false
    }
}

/** An envelope card (board 02 ②): "Let Codex stable check open PRs?", Now and Asked, the note, and Keep … / Allow. */
@Composable
fun ScheduleEnvelopeCard(card: ScheduleCard, scheduleTitle: String?, ruleNow: ScheduleRule?, decide: suspend (Boolean) -> ScheduledStore.PressResult) {
    val text = ScheduleDisplay.envelopeCard(card, scheduleTitle, ruleNow) ?: return
    val scope = rememberCoroutineScope()
    val press = remember(card.id) { CardPress() }
    val warn = scheduleWarn()
    CardBox(warn = true, tag = "schedule-envelope-card") {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(18.dp), tint = warn)
                Text(text.title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold), color = warn)
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                text.now?.let { now -> FactRow(SC.EnvelopeCard.now) { Text(now.text, style = MaterialTheme.typography.bodyMedium) } }
                FactRow(SC.EnvelopeCard.asked) {
                    val asked = text.asked
                    Text(if (asked.lead.isNotEmpty() && asked.text.startsWith(asked.lead)) bold(asked.lead, asked.text.removePrefix(asked.lead))
                        else AnnotatedString(asked.text), style = MaterialTheme.typography.bodyMedium)
                }
            }
            Text(text.note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            press.said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheduleRed()) }
        }
        if (card.isPending && !press.pressed) CardFoot(text.keep, SC.Actions.allow, press.busy, "schedule-envelope-${card.id}",
            onDecline = { pressCard(scope, press, false, decide) }, onAllow = { pressCard(scope, press, true, decide) })
    }
}

/** The change line a change inside the envelope leaves (board 01 ⑤ 1): "Changed **Codex stable check**: time 10:00 → 09:00", with
 * Undo while it still applies, and Open for the schedule. */
@Composable
fun ScheduleRecordLine(record: ScheduleChangeRecord, undo: (suspend () -> String?)?, open: (() -> Unit)?) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var undone by remember { mutableStateOf(false) }
    var said by remember { mutableStateOf<String?>(null) }
    val parts = ScheduleDisplay.changeLineParts(record)
    val undoable = ScheduleDisplay.recordUndoable(record) && !undone
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f), RoundedCornerShape(10.dp))
        .padding(horizontal = 12.dp, vertical = 10.dp).testTag("schedule-record-line"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(painterResource(R.drawable.ic_calendar), null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary)
            Text(buildAnnotatedString {
                append(parts.lead); withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(parts.title) }; append(parts.rest)
            }, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                color = if (undoable || record.undo == null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            if (record.undo != null && undo != null) TextButton(onClick = {
                busy = true
                scope.launch { said = undo(); undone = said == null; busy = false }
            }, enabled = undoable && !busy, contentPadding = PaddingValues(horizontal = 4.dp), modifier = Modifier.testTag("schedule-record-undo-${record.revision}")) {
                Text(SC.Actions.undo)
            }
            if (open != null) TextButton(onClick = open, contentPadding = PaddingValues(horizontal = 4.dp)) { Text(SC.Actions.open) }
        }
        said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheduleRed()) }
    }
}

/** A run's head (board 01 ⑦): "‹ Codex stable check", "Run of Nov 13", "Open · Codex agent · 4 min", and the strip that says it is a
 * scheduled run and not in the session list. */
@Composable
fun ScheduleRunStrip(schedule: ScheduleView, run: ScheduleRunView, sessionState: String?, sessionEngine: String?, openSchedule: () -> Unit) {
    val zone = java.util.TimeZone.getDefault().id
    val head = ScheduleDisplay.runHeadText(sessionState, ScheduleDisplay.runAgentName(schedule.engine, sessionEngine), run.startedAt, run.endedAt, Instant.now())
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).testTag("schedule-run-strip"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.clickable(onClick = openSchedule).testTag("schedule-run-crumb"), verticalAlignment = Alignment.CenterVertically) {
            Text("‹ ", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium)
            Text(schedule.title, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Text(ScheduleDisplay.capitalizedRunOf(run.plannedAt, zone), style = MaterialTheme.typography.titleLarge)
        if (head.isNotEmpty()) Text(head, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(painterResource(R.drawable.ic_calendar), null, Modifier.size(16.dp).padding(top = 2.dp), tint = MaterialTheme.colorScheme.primary)
            Text(ScheduleDisplay.runStripText(run.plannedAt, run.startedAt, schedule.accessLevel, zone), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** What a run reported, after its end (board 01 ⑦ 2): "Reported: Changed · codex@0.49.0" and its summary, or the failure's line. */
@Composable
fun ScheduleRunReport(run: ScheduleRunView, findings: List<ScheduleFindingView>) {
    val failed = ScheduleDisplay.runReportFailed(run.state)
    val facts = ScheduleDisplay.runFindingFacts(run, findings)
    val head = if (failed) ScheduleDisplay.runLine(run.state, run.summary, run.failureReason, run.reasonText)
        else ScheduleDisplay.reportedText(run.state, run.key, facts.notified)
    val tint = if (failed) scheduleRed() else scheduleGreen()
    val shape = RoundedCornerShape(10.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(tint.copy(alpha = 0.06f)).height(IntrinsicSize.Min).testTag("schedule-run-report")) {
        Box(Modifier.width(3.dp).fillMaxHeight().background(tint))
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(painterResource(if (failed) R.drawable.ic_warning else R.drawable.ic_check_circle), null, Modifier.size(16.dp), tint = tint)
                Text(head, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            }
            if (!failed) run.summary?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        }
    }
}

// MARK: - In a conversation

/** One thing the schedules put in a conversation, at its own moment: a card it asked, a change it made, or — in a run's own session —
 * the run's strip (at its planned time) and its report (at its end). */
sealed class ScheduleInsert {
    abstract val at: String
    abstract val key: String
    data class Card(val card: ScheduleCard) : ScheduleInsert() { override val at get() = card.createdAt; override val key get() = "schedule-card-${card.id}" }
    data class Record(val record: ScheduleChangeRecord) : ScheduleInsert() {
        override val at get() = record.createdAt; override val key get() = "schedule-record-${record.scheduleId}@${record.revision}"
    }
    data class RunStrip(val context: ScheduledStore.RunContext) : ScheduleInsert() {
        override val at get() = context.run.plannedAt; override val key get() = "schedule-run-strip-${context.run.id}"
    }
    data class RunReport(val context: ScheduledStore.RunContext, override val at: String) : ScheduleInsert() {
        override val key get() = "schedule-run-report-${context.run.id}"
    }

    companion object {
        /** What [sessionId]'s read and its run put in it, oldest first. */
        fun of(state: ScheduledStore.State, sessionId: String): List<ScheduleInsert> {
            val read = state.session(sessionId)
            val run = state.run(sessionId)
            val all = read?.cards.orEmpty().map { Card(it) } + read?.records.orEmpty().map { Record(it) } +
                listOfNotNull(run?.let { RunStrip(it) }) +
                listOfNotNull(run?.takeIf { ScheduleDisplay.runEnded(it.run.state) }?.run?.endedAt?.let { RunReport(run, it) })
            return all.sortedBy { ScheduleDisplay.parse(it.at) ?: Instant.MIN }
        }

        /** Where each goes in a conversation (as owner requests are placed): after the last row stamped at or before it, by the row's
         * index, or -1 ahead of every row. One with no readable moment is left out. */
        fun place(rowTimes: List<String?>, inserts: List<ScheduleInsert>): Map<Int, List<ScheduleInsert>> {
            val times = rowTimes.map { it?.let(ScheduleDisplay::parse) }
            return inserts.mapNotNull { insert ->
                val at = ScheduleDisplay.parse(insert.at) ?: return@mapNotNull null
                times.indexOfLast { it != null && !it.isAfter(at) } to insert
            }.groupBy({ it.first }, { it.second })
        }
    }
}

/** One [ScheduleInsert] drawn in its conversation. [sessionState] and [sessionEngine] are the session's own read, for a run's head. */
@Composable
fun ScheduleConversationInsert(insert: ScheduleInsert, store: ScheduledStore, sessionId: String, sessionState: String?, sessionEngine: String?,
    openSchedule: (String) -> Unit) {
    val state by store.state.collectAsState()
    when (insert) {
        is ScheduleInsert.Card -> {
            val card = state.card(insert.card.id)?.takeIf { it.state != insert.card.state || !it.isPending } ?: insert.card
            val decide: suspend (Boolean) -> ScheduledStore.PressResult = { allow ->
                val result = if (allow) store.allow(card) else store.decline(card)
                store.loadSessionNow(sessionId)
                result
            }
            if (card.isCreate) ScheduleCreateCard(card, decide = decide)
            else {
                val schedule = card.scheduleId?.let(state::schedule)
                LaunchedEffect(card.scheduleId, schedule == null) { if (schedule == null) card.scheduleId?.let(store::loadDetail) }
                ScheduleEnvelopeCard(card, schedule?.title, schedule?.rule, decide)
            }
        }
        is ScheduleInsert.Record -> ScheduleRecordLine(insert.record,
            undo = {
                val said = store.undo(insert.record.scheduleId, insert.record.revision)
                store.loadSessionNow(sessionId)
                said
            }, open = { openSchedule(insert.record.scheduleId) })
        is ScheduleInsert.RunStrip -> ScheduleRunStrip(insert.context.schedule, insert.context.run, sessionState, sessionEngine) {
            openSchedule(insert.context.schedule.id)
        }
        is ScheduleInsert.RunReport -> ScheduleRunReport(insert.context.run, insert.context.detail?.findings.orEmpty())
    }
}

// MARK: - Waiting on you (board 01 ⑥, 02 ⑤)

private data class WaitingContent(val kind: String, val title: String, val body: String, val command: String? = null, val note: String? = null)

/**
 * One of the four Waiting on you items no session can file (SCHEDULE_FAILED, _HELD, _APPROVAL, _WIDEN), whole, its buttons on it:
 * each answers at the schedule's own doors. Only a failure is the owner's to dismiss here, by pausing.
 */
@Composable
fun ScheduleWaitingCard(item: ScheduleWaitingItem, store: ScheduledStore, openSession: (String) -> Unit, openSchedule: (String) -> Unit,
    openAgentSettings: () -> Unit, answered: () -> Unit) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var busy by remember(item.id) { mutableStateOf(false) }
    var said by remember(item.id) { mutableStateOf<String?>(null) }
    val schedule = state.schedule(item.scheduleId)
    LaunchedEffect(item.id) {
        if (schedule == null) store.loadNow()
        item.scheduleChangeRequestId?.let(store::loadCard)
        val session = item.askedBySessionId
        if (item.approvalId != null && session != null) store.loadApproval(session, item.approvalId!!)
    }
    val zone = store.timezone
    val now = Instant.now()
    val warn = scheduleWarn()
    val card = item.scheduleChangeRequestId?.let(state::card)
    val approval = item.approvalId?.let { state.approvals[ScheduledStore.key(it)] }
    val content = waitingContent(item, schedule, card, approval, zone, now)
    fun run(action: suspend () -> String?) {
        busy = true
        scope.launch { said = action(); busy = false; if (said == null) answered() }
    }
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(warn.copy(alpha = 0.03f)).border(1.dp, warn.copy(alpha = 0.45f), shape)
        .testTag("schedule-waiting-${item.kind}")) {
        Row(Modifier.fillMaxWidth().background(warn.copy(alpha = 0.10f)).padding(horizontal = 14.dp, vertical = 8.dp)) {
            Text(content.kind, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold), color = warn)
            Text(ScheduleDisplay.parse(item.createdAt)?.let { ScheduleDisplay.whenText(it, now, zone) }.orEmpty(),
                style = MaterialTheme.typography.bodySmall, color = warn.copy(alpha = 0.8f))
        }
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(content.title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
            content.command?.let { Text(it, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis) }
            Text(content.body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            said?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = scheduleRed()) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                when (item.kind) {
                    "SCHEDULE_FAILED" -> {
                        WaitingButton(SC.Actions.openRun, primary = true, busy) {
                            val session = schedule?.lastRun?.sessionId
                            if (session != null) openSession(session) else openSchedule(item.scheduleId)
                        }
                        WaitingButton(SC.Actions.pauseSchedule, primary = false, busy) { run { store.pauseAndDismiss(item.scheduleId, item.id) } }
                    }
                    "SCHEDULE_HELD" -> {
                        val agent = schedule?.heldReason == "AGENT_DISABLED" || schedule?.heldReason == "AGENT_MISSING"
                        WaitingButton(if (agent) SC.Actions.openAgentSettings else SC.Actions.openSchedule, primary = true, busy) {
                            if (agent) openAgentSettings() else openSchedule(item.scheduleId)
                        }
                        WaitingButton(SC.Actions.resume, primary = false, busy) { run { store.resume(item.scheduleId) } }
                    }
                    "SCHEDULE_APPROVAL" -> {
                        val session = item.askedBySessionId
                        val approvalId = item.approvalId
                        fun decide(allow: Boolean, always: Boolean) = run {
                            if (session == null || approvalId == null) null else store.decideApproval(session, approvalId, allow, always)
                        }
                        WaitingButton(SC.Actions.deny, primary = false, busy, Modifier.weight(1f)) { decide(false, false) }
                        WaitingButton(SC.Actions.allowOnce, primary = false, busy, Modifier.weight(1f)) { decide(true, false) }
                        WaitingButton(SC.Actions.alwaysAllow, primary = true, busy, Modifier.weight(1f)) { decide(true, true) }
                    }
                    else -> {
                        val keep = card?.let { ScheduleDisplay.envelopeCard(it, schedule?.title, schedule?.rule)?.keep } ?: SC.keep["other"].orEmpty()
                        WaitingButton(keep, primary = false, busy, Modifier.weight(1f)) {
                            run { card?.let { store.decline(it).said } }
                        }
                        WaitingButton(SC.Actions.allow, primary = true, busy, Modifier.weight(1f)) {
                            run { card?.let { store.allow(it).said } }
                        }
                    }
                }
            }
            content.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@Composable
private fun WaitingButton(title: String, primary: Boolean, busy: Boolean, modifier: Modifier = Modifier, press: () -> Unit) {
    val tag = Modifier.testTag("schedule-waiting-$title")
    if (primary) Button(onClick = press, modifier.then(tag), enabled = !busy, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
    } else FilledTonalButton(onClick = press, modifier.then(tag), enabled = !busy, contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

private fun waitingContent(item: ScheduleWaitingItem, schedule: ScheduleView?, card: ScheduleCard?, approval: kotlinx.serialization.json.JsonObject?,
    zone: String, now: Instant): WaitingContent {
    val title = schedule?.title ?: item.title
    return when (item.kind) {
        "SCHEDULE_FAILED" -> {
            val run = schedule?.lastRun
            val t = ScheduleDisplay.failedWaiting(title, maxOf(schedule?.consecutiveFailures ?: 1, 1), run?.failureReason, run?.reasonText,
                run?.summary, run?.plannedAt ?: item.createdAt, zone)
            WaitingContent(t.kind, t.title, t.body)
        }
        "SCHEDULE_HELD" -> {
            val t = ScheduleDisplay.heldWaiting(title, schedule?.heldReason, schedule?.nextDueAt ?: schedule?.lastRun?.plannedAt ?: item.createdAt,
                schedule?.agentName, schedule?.workspaceName, now, zone)
            WaitingContent(t.kind, t.title, t.body)
        }
        "SCHEDULE_APPROVAL" -> {
            val rules = approval?.let(ScheduledStore::approvalRules).orEmpty()
            val deadline = ScheduleDisplay.parse(item.createdAt)?.plus(ScheduleDisplay.approvalTimeout)?.toString() ?: item.createdAt
            val t = ScheduleDisplay.approvalWaiting(title, deadline, schedule?.nextDueAt, ScheduledStore.ruleNames(rules),
                schedule?.workspaceName.orEmpty(), now, zone)
            val command = ((approval?.get("input") as? kotlinx.serialization.json.JsonObject)?.get("command") as? JsonPrimitive)?.contentOrNull
            WaitingContent(t.kind, t.title, t.body, command, if (rules.isEmpty()) null else t.alwaysAllow)
        }
        else -> {
            val envelope = card?.envelope
            val text = card?.let { ScheduleDisplay.envelopeCard(it, schedule?.title, schedule?.rule) }
            if (envelope == null || text == null) WaitingContent(SC.Waiting.kindsSchedule, item.title, item.why)
            else {
                val names = listOfNotNull(envelope.now, envelope.asked).mapNotNull { l -> l.runsIn.workspaceName?.let { l.runsIn.workspaceId to it } }.toMap()
                WaitingContent(SC.Waiting.kindsSchedule, text.title, ScheduleDisplay.widenWaitingText(item.why, envelope.widens, envelope.now?.envelope,
                    envelope.asked.envelope, schedule?.rule, ScheduleRule.parse(card.proposed?.get("rule")), names))
            }
        }
    }
}
