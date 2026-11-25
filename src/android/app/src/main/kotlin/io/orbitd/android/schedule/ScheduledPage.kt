package io.orbitd.android.schedule

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.core.schedule.ConditionWaitingItem
import io.orbitd.android.core.schedule.ConditionCopy
import io.orbitd.android.core.schedule.ConditionDisplay
import io.orbitd.android.core.schedule.ConditionEventView
import io.orbitd.android.core.schedule.ConditionView
import io.orbitd.android.core.schedule.ScheduleChangeRecord
import io.orbitd.android.core.schedule.ScheduleCopy
import io.orbitd.android.core.schedule.ScheduleCopy as SC
import io.orbitd.android.core.schedule.ScheduleDetailResponse
import io.orbitd.android.core.schedule.ScheduleDisplay
import io.orbitd.android.core.schedule.ScheduleRule
import io.orbitd.android.core.schedule.ScheduleRunView
import io.orbitd.android.core.schedule.ScheduleView
import io.orbitd.android.core.schedule.ScheduleWaitingItem
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

// The Scheduled page on a phone (docs/mocks/scheduled-tasks/01-board.png ② ③ ⑧, 02-agent-first.png ③; iOS `ScheduledPage`): a
// timeline in the manner of Reminders' Scheduled list — grouped by the day each schedule next runs, the circle its state — a detail
// sheet from the bottom for a row, and a line at the end that takes one sentence. Every word and rule is the shared contract's.


@Composable
internal fun scheduleRed() = MaterialTheme.colorScheme.error
@Composable
internal fun scheduleWarn() = LocalOrbitColors.current.needsYou
@Composable
internal fun scheduleGreen() = LocalOrbitColors.current.success

/** A row's state as a circle (board 01 ② 2): open is to come, the blue arc runs, a grey tick did nothing new, a green tick found
 * something, red failed, amber is held, dashed is a draft, faint is paused. */
@Composable
fun ScheduleCircleGlyph(view: ScheduleDisplay.CircleView, size: Dp = 22.dp) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val accent = MaterialTheme.colorScheme.primary
    val red = scheduleRed(); val warn = scheduleWarn(); val green = scheduleGreen()
    if (view.gauge) {
        // A condition's row (condition-triggers board ④ ③): a gauge in place of the circle, amber when it cannot be read, faint
        // when paused.
        val tint = when (view.circle) {
            ScheduleDisplay.Circle.held -> warn
            ScheduleDisplay.Circle.paused -> secondary.copy(alpha = 0.5f)
            else -> accent
        }
        Icon(painterResource(R.drawable.ic_gauge), null, Modifier.size(size).testTag("schedule-gauge").clearAndSetSemantics { }, tint = tint)
        return
    }
    Box(Modifier.size(size).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val w = 1.5.dp.toPx()
            val inset = w / 2
            val arcSize = Size(this.size.width - w, this.size.height - w)
            fun ring(color: Color, effect: PathEffect? = null) =
                drawArc(color, 0f, 360f, false, Offset(inset, inset), arcSize, style = Stroke(w, pathEffect = effect))
            when (view.circle) {
                ScheduleDisplay.Circle.open, ScheduleDisplay.Circle.done -> ring(secondary.copy(alpha = 0.45f))
                ScheduleDisplay.Circle.running -> {
                    ring(secondary.copy(alpha = 0.25f))
                    drawArc(accent, -90f, 108f, false, Offset(inset, inset), arcSize, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round))
                }
                ScheduleDisplay.Circle.new -> drawCircle(green)
                ScheduleDisplay.Circle.failed -> drawCircle(red)
                ScheduleDisplay.Circle.held -> ring(warn)
                ScheduleDisplay.Circle.draft -> ring(secondary.copy(alpha = 0.6f), PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.5.dp.toPx())))
                ScheduleDisplay.Circle.paused -> ring(secondary.copy(alpha = 0.22f))
                ScheduleDisplay.Circle.muted -> ring(secondary.copy(alpha = 0.25f))
            }
        }
        view.mark?.let { mark ->
            val tint = when (view.circle) {
                ScheduleDisplay.Circle.new, ScheduleDisplay.Circle.failed -> Color.White
                ScheduleDisplay.Circle.held -> warn
                ScheduleDisplay.Circle.muted -> secondary.copy(alpha = 0.5f)
                else -> secondary
            }
            when (mark) {
                ScheduleDisplay.Mark.check -> Icon(painterResource(R.drawable.ic_check), null, Modifier.size(size * 0.6f), tint = tint)
                // A queued run: clock hands inside the ring, which is the clock's face.
                ScheduleDisplay.Mark.clock -> Icon(painterResource(R.drawable.ic_clock_hands), null, Modifier.size(size * 0.6f), tint = tint)
                ScheduleDisplay.Mark.alert -> Text("!", color = tint, fontWeight = FontWeight.Black, fontSize = (size.value * 0.55f).sp)
            }
        }
    }
}

@Composable
internal fun tagColor(tone: ScheduleDisplay.TagTone): Color = when (tone) {
    ScheduleDisplay.TagTone.new -> scheduleGreen()
    ScheduleDisplay.TagTone.fail -> scheduleRed()
    ScheduleDisplay.TagTone.held -> scheduleWarn()
    ScheduleDisplay.TagTone.mute -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** "02:00": a row's time column, 24-hour, in the viewer's zone. */
internal fun scheduleClock(iso: String?, timezone: String): String =
    iso?.let(ScheduleDisplay::parse)?.let { ScheduleDisplay.localParts(it, timezone).time }.orEmpty()

/** One row of the timeline. */
private data class ScheduleRowModel(val id: String, val circle: ScheduleDisplay.CircleView, val title: String, val line: String,
    val repeats: Boolean, val time: String, val draft: Boolean, val paused: Boolean,
    /** A condition's row: the newest reading and its age, where a timed row shows its time (board ④ ②). */
    val reading: ConditionDisplay.RowReading? = null,
    /** The planned end, on its own line so the row's line never cuts it off. */
    val end: String? = null,
    /** A schedule's own row, which a long press opens the menu of, with its last run's session. */
    val schedule: ScheduleView? = null, val lastSession: String? = null, val open: () -> Unit)

/**
 * The Scheduled page: "Scheduled 6" and the workspace filter, the timeline's groups, the line at the end, and the detail sheet of
 * the row pressed. [focused] — a schedule a push or a card named — opens its sheet. [workspaces] are the quick-add line's choices,
 * [preferredWorkspace] is the initial choice. [openSession] opens a draft's conversation, and [openRun] opens a run's session.
 * [change] opens the schedule's draft change conversation (§8.2).
 */
@Composable
fun ScheduledPage(store: ScheduledStore, workspaces: List<Pair<String, String>>, preferredWorkspace: String?, focused: String?,
    openSession: (String) -> Unit, openRun: (String) -> Unit, change: (ScheduleView) -> Unit, openTask: (String) -> Unit = {},
    waiting: List<ScheduleWaitingItem> = emptyList(), conditionWaiting: List<ConditionWaitingItem> = emptyList(), answered: () -> Unit = {}) {
    val state by store.state.collectAsState()
    val zone = store.timezone
    LaunchedEffect(store) { store.loadNow() }
    LaunchedEffect(focused) { focused?.let { store.inspect(it); store.loadDetail(it) } }
    // No event names schedules: a page left open reads them again now and then, as the iPhone's floor does.
    LaunchedEffect(store) { while (true) { delay(60_000); store.loadNow() } }
    val now = Instant.now()
    val groups = remember(state, now.epochSecond / 60) { state.timeline(now, zone) }
    val empty = state.loaded && state.shownSchedules.isEmpty() && state.drafts.isEmpty() && state.shownWaitingTasks.isEmpty() &&
        state.workspaceFilter == null
    var typed by rememberSaveable { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    // The schedule a row's menu asked to rename or delete, while the question is up.
    var renaming by rememberSaveable(stateSaver = RenamingSaver) { mutableStateOf<Renaming?>(null) }
    var deleting by remember { mutableStateOf<ScheduleView?>(null) }
    val menu = ScheduleMenu(
        runNow = { s -> scope.launch { store.runNow(s.id) } },
        toggle = { s -> scope.launch { if (s.state == "PAUSED" || s.state == "HELD") store.resume(s.id) else store.pause(s.id) } },
        rename = { s -> renaming = Renaming(s.id, s.title) },
        change = { s -> store.inspect(null); change(s) },
        openLastRun = openRun,
        delete = { s -> deleting = s },
    )
    LazyColumn(Modifier.fillMaxSize().testTag("scheduled-page"), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
        item(key = "header") { ScheduledHeader(store, state) }
        // A condition's items (the can't-read card and the 30-day question, condition-triggers board ⑥ ①) and a scheduled task's
        // (failed, held, a run's approval, a run asking for more), whole, under the head: each answers at its own doors. There is no
        // Waiting on you page (docs/mocks/waiting-on-you-removal; the owner, 2026-11-16); the run's session draws its own.
        items(conditionWaiting, key = { "condition-waiting:${it.id}" }) { item ->
            Box(Modifier.padding(vertical = 6.dp).testTag("scheduled-waiting:${item.id}")) {
                ConditionWaitingCard(item, store, openSchedule = { id -> store.inspect(id); store.loadDetail(id) }, openTask = openTask,
                    answered = answered)
            }
        }
        items(waiting, key = { "schedule-waiting:${it.id}" }) { item ->
            val openSchedule: (String) -> Unit = { id -> store.inspect(id); store.loadDetail(id) }
            Box(Modifier.padding(vertical = 6.dp).testTag("scheduled-waiting:${item.id}")) {
                ScheduleWaitingCard(item, store, openSession = openRun, openSchedule = openSchedule,
                    openAgentSettings = { openSchedule(item.scheduleId) }, answered = answered)
            }
        }
        if (empty) {
            item(key = "lead") {
                Text(SC.Empty.lead, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item(key = "quick-add") { QuickAddLine(store, typed, { typed = it }, workspaces, preferredWorkspace) }
            items(SC.Empty.examples, key = { "example-$it" }) { example ->
                Text(example, Modifier.fillMaxWidth().clickable { typed = example }.padding(vertical = 8.dp),
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
            }
        } else {
            groups.forEach { group ->
                item(key = "group-${group.id}") { GroupHeader(group) }
                val rows = rows(group, state, store, zone, now, openRun, openTask, state.pageRuns)
                items(rows, key = { it.id }) { row -> ScheduleRow(row, menu) }
            }
            item(key = "quick-add") { QuickAddLine(store, typed, { typed = it }, workspaces, preferredWorkspace) }
        }
        state.errorText?.let { error -> item(key = "error") { Text(error, color = scheduleRed(), style = MaterialTheme.typography.bodySmall) } }
    }
    state.inspectedId?.let { id ->
        ScheduleDetailSheet(store, id, close = { store.inspect(null) }, openSession = { session -> store.inspect(null); openRun(session) },
            change = { s -> store.inspect(null); change(s) })
    }
    state.draftPanel?.let { panel ->
        ScheduleDraftSheet(store, panel, close = store::closeDraftPanel) { store.closeDraftPanel(); openSession(panel.sessionId) }
    }
    renaming?.let { ScheduleRenameDialog(store, it) { renaming = null } }
    deleting?.let { ScheduleDeleteDialog(store, it) { deleting = null } }
}

/** The schedule being renamed and the name it had when asked. */
private data class Renaming(val id: String, val title: String)

private val RenamingSaver = listSaver<Renaming?, String>(save = { r -> r?.let { listOf(it.id, it.title) }.orEmpty() },
    restore = { Renaming(it[0], it[1]) })

/** What a schedule row's long-press menu does. */
private class ScheduleMenu(val runNow: (ScheduleView) -> Unit, val toggle: (ScheduleView) -> Unit, val rename: (ScheduleView) -> Unit,
    val change: (ScheduleView) -> Unit, val openLastRun: (String) -> Unit, val delete: (ScheduleView) -> Unit)

@Composable
private fun MenuItem(title: String, icon: Int, tag: String, danger: Boolean = false, press: () -> Unit) {
    val color = if (danger) scheduleRed() else MaterialTheme.colorScheme.onSurface
    DropdownMenuItem(text = { Text(title, color = color) }, onClick = press, modifier = Modifier.testTag(tag),
        leadingIcon = { Icon(painterResource(icon), null, Modifier.size(20.dp), tint = color) })
}

/** A schedule row's long-press menu, as the iPhone's (`ScheduleRowActions`): Run now (not while held), Pause or Resume,
 * Rename…, Change…, Open last run, then Delete, which asks first. */
@Composable
private fun ColumnScope.ScheduleRowMenu(s: ScheduleView, lastSession: String?, menu: ScheduleMenu, dismiss: () -> Unit) {
    fun pick(press: () -> Unit) { dismiss(); press() }
    val resumes = s.state == "PAUSED" || s.state == "HELD"
    // A held schedule's Run now is refused until it is resumed (SCHEDULE_HELD).
    if (s.state != "HELD") MenuItem(SC.Actions.runNow, R.drawable.ic_bolt, "schedule-menu-run-now") { pick { menu.runNow(s) } }
    MenuItem(if (resumes) SC.Actions.resume else SC.Actions.pause, if (resumes) R.drawable.ic_play else R.drawable.ic_pause,
        "schedule-menu-toggle") { pick { menu.toggle(s) } }
    MenuItem(SC.Actions.rename, R.drawable.ic_edit, "schedule-menu-rename") { pick { menu.rename(s) } }
    MenuItem(SC.Actions.change, R.drawable.ic_sessions, "schedule-menu-change") { pick { menu.change(s) } }
    lastSession?.let { session ->
        MenuItem(SC.Actions.openLastRun, R.drawable.ic_arrow_forward, "schedule-menu-open-last-run") { pick { menu.openLastRun(session) } }
    }
    HorizontalDivider()
    MenuItem(SC.Actions.delete, R.drawable.ic_trash, "schedule-menu-delete", danger = true) { pick { menu.delete(s) } }
}

/** Rename… (§8.4, board schedule-rename 01-board-2; the iPhone's alert): one field holding the current name, selected,
 * Save off while it is empty or unchanged. */
@Composable
private fun ScheduleRenameDialog(store: ScheduledStore, renaming: Renaming, dismiss: () -> Unit) {
    var draft by rememberSaveable(renaming.id, stateSaver = TextFieldValue.Saver) {
        mutableStateOf(TextFieldValue(renaming.title, TextRange(0, renaming.title.length)))
    }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    val savable = ScheduleDisplay.renameTitle(draft.text, renaming.title) != null
    fun save() {
        if (!savable) return
        val text = draft.text
        dismiss()
        // On the store's scope: the dialog, and with it this scope, is gone once pressed.
        store.renameNow(renaming.id, text, renaming.title)
    }
    AlertDialog(onDismissRequest = dismiss, modifier = Modifier.testTag("schedule-rename-dialog"),
        title = { Text(SC.RenameAlert.title) },
        text = {
            // Scrolls, so a keyboard that squeezes the dialog can't set the field relaying out every frame (API 30).
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(SC.RenameAlert.body)
                OutlinedTextField(draft, { draft = it }, Modifier.fillMaxWidth().focusRequester(focus).testTag("schedule-rename-field"),
                    label = { Text(SC.History.fields.getValue("title")) }, singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { save() }))
                LaunchedEffect(Unit) { focus.requestFocus() }
            }
        },
        confirmButton = { TextButton(::save, Modifier.testTag("schedule-rename-save"), enabled = savable) { Text(SC.RenameAlert.save) } },
        dismissButton = { TextButton(dismiss, Modifier.testTag("schedule-rename-cancel")) { Text(SC.RenameAlert.cancel) } })
}

@Composable
private fun ScheduleDeleteDialog(store: ScheduledStore, s: ScheduleView, dismiss: () -> Unit) {
    AlertDialog(onDismissRequest = dismiss,
        title = { Text(ScheduleDisplay.deleteTitle(s.title)) }, text = { Text(SC.DeleteConfirm.body) },
        confirmButton = { TextButton(onClick = { dismiss(); store.deleteNow(s.id) }) { Text(SC.DeleteConfirm.confirm, color = scheduleRed()) } },
        dismissButton = { TextButton(onClick = dismiss) { Text(SC.DeleteConfirm.cancel) } })
}

/** "Scheduled 6" in the boards' blue, the ⋯ menu with Show past runs, and the workspace filter under it (board 01 ②). */
@Composable
private fun ScheduledHeader(store: ScheduledStore, state: ScheduledStore.State) {
    var filterOpen by remember { mutableStateOf(false) }
    var moreOpen by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(SC.Page.title, Modifier.weight(1f), style = MaterialTheme.typography.headlineLarge.copy(fontSize = 32.sp, lineHeight = 38.sp),
                color = MaterialTheme.colorScheme.primary)
            Text("${state.shownSchedules.size + state.shownWaitingTasks.size}", Modifier.testTag("scheduled-count"), style = MaterialTheme.typography.headlineLarge.copy(
                fontSize = 32.sp, lineHeight = 38.sp, fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
            Box {
                IconButton(onClick = { moreOpen = true }, Modifier.testTag("scheduled-more")) { Icon(painterResource(R.drawable.ic_more), "More") }
                DropdownMenu(moreOpen, { moreOpen = false }) {
                    DropdownMenuItem(text = { Text(SC.Page.showPastRuns) }, onClick = { store.showPastRuns(!state.showPastRuns); moreOpen = false },
                        leadingIcon = { Checkbox(state.showPastRuns, null) }, modifier = Modifier.testTag("scheduled-show-past-runs"))
                }
            }
        }
        Box {
            val name = state.workspaceFilter?.let { id -> state.workspaces.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it.first, id) }?.second }
                ?: SC.Page.allWorkspaces
            Row(Modifier.border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f), RoundedCornerShape(50)).clickable { filterOpen = true }
                .padding(horizontal = 10.dp, vertical = 5.dp).testTag("scheduled-filter"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(name, style = MaterialTheme.typography.bodySmall)
                Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(12.dp))
            }
            DropdownMenu(filterOpen, { filterOpen = false }) {
                DropdownMenuItem(text = { Text(SC.Page.allWorkspaces) }, onClick = { store.filter(null); filterOpen = false })
                state.workspaces.forEach { (id, label) -> DropdownMenuItem(text = { Text(label) }, onClick = { store.filter(id); filterOpen = false }) }
            }
        }
    }
}

/** "Today  Fri, Nov 14"; Paused in grey. No group is red: there is no Needs you group (owner 2026-11-19). */
@Composable
private fun GroupHeader(group: ScheduleDisplay.TimelineGroup) {
    val color = when (group.key) {
        ScheduleDisplay.GroupKey.paused -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> MaterialTheme.colorScheme.onSurface
    }
    Column(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 2.dp).testTag("scheduled-group:${group.id}")) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(group.title, style = MaterialTheme.typography.titleLarge, color = color)
            group.subtitle?.let { Text(it, Modifier.padding(bottom = 2.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        HorizontalDivider(Modifier.padding(top = 6.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f))
    }
}

private fun rows(group: ScheduleDisplay.TimelineGroup, state: ScheduledStore.State, store: ScheduledStore, zone: String,
    now: Instant, openRun: (String) -> Unit, openTask: (String) -> Unit, runs: List<ScheduleRunView>): List<ScheduleRowModel> = group.items.map { item ->
    when (item) {
        // A task that starts when its condition holds (board ④ ①): "Task · once, when 3 or more OSDs are in · HPC".
        is ScheduleDisplay.TimelineItem.Task -> {
            val t = item.task
            ScheduleRowModel("${group.id}-${item.id}", ConditionDisplay.circle(t.condition.cantRead), t.title, ConditionDisplay.taskRowLine(t),
                repeats = false, time = "", draft = false, paused = false,
                reading = if (t.condition.cantRead) null else ConditionDisplay.rowReading(t.condition, now)) { openTask(t.id) }
        }
        is ScheduleDisplay.TimelineItem.Draft -> {
            val card = item.card
            val rule = card.`when`?.rule ?: ScheduleRule.Daily("")
            ScheduleRowModel("${group.id}-${item.id}", ScheduleDisplay.scheduleCircle("ACTIVE", 0, draft = true), card.title.orEmpty(),
                ScheduleDisplay.phoneRowLine(rule, card.runsIn?.workspaceName, card.may?.accessLevel ?: "CHECK_ONLY", "ACTIVE", null, draft = true),
                ScheduleDisplay.ruleRepeats(rule), scheduleClock(item.at, zone), draft = true, paused = false) {
                store.openDraftPanel(card.askedBySessionId ?: card.id, card.intent.orEmpty())
            }
        }
        is ScheduleDisplay.TimelineItem.Run -> {
            val s = item.schedule; val run = item.run
            val underWay = run.state in setOf("QUEUED", "RUNNING", "AWAITING_APPROVAL")
            val facts = ScheduleDisplay.runFindingFacts(run, state.detail(s.id)?.findings.orEmpty())
            val minutes = if (run.state == "RUNNING") run.startedAt?.let(ScheduleDisplay::parse)
                ?.let { maxOf(0L, (now.epochSecond - it.epochSecond) / 60).toInt() } else null
            ScheduleRowModel("${group.id}-${item.id}", ScheduleDisplay.runCircle(run.state, facts.newFinding), s.title,
                if (underWay) ScheduleDisplay.phoneRowLine(s.rule, s.workspaceName, s.accessLevel, s.state, s.heldReason, runningMinutes = minutes)
                else ScheduleDisplay.runLine(run.state, run.summary, run.failureReason, run.reasonText, facts.notified),
                underWay && ScheduleDisplay.ruleRepeats(s.rule), scheduleClock(run.plannedAt, zone), draft = false, paused = false) {
                val session = run.sessionId
                if (session != null) openRun(session)
                else { store.inspect(s.id); store.loadDetail(s.id) }
            }
        }
        // A streak of missed slots as one row: "16 slots missed, 01:00–08:30".
        is ScheduleDisplay.TimelineItem.Missed -> {
            val s = item.schedule
            ScheduleRowModel("${group.id}-${item.id}", ScheduleDisplay.runCircle("MISSED"), s.title,
                ScheduleDisplay.missedText(item.runs, zone), repeats = false, time = scheduleClock(item.at, zone), draft = false, paused = false) {
                store.inspect(s.id); store.loadDetail(s.id)
            }
        }
        is ScheduleDisplay.TimelineItem.Schedule -> {
            val s = item.schedule
            val inPaused = group.key == ScheduleDisplay.GroupKey.paused
            // Tagged on its own row (owner 2026-11-19): Failed, unless a run of it is under way; held, in Paused.
            val circle = ScheduleDisplay.rowCircle(s, runs)
            val time = if (inPaused) "" else scheduleClock(item.at, zone)
            val pausedAt = s.pausedAt?.let(ScheduleDisplay::parse) ?: pausedAt(state.detail(s.id))
            if (s.rule is ScheduleRule.When) {
                // A WHEN rule (board ④): "↻ When raw used above 90% · HPC", a gauge, and the newest reading with its age where a
                // timed row has its time; "Can't read" at the head of Waiting for a condition.
                val parts = mutableListOf(ScheduleDisplay.ruleText(s.rule, ScheduleDisplay.RuleForm.long))
                s.workspaceName?.takeIf { it.isNotEmpty() }?.let { parts += it }
                if (s.accessLevel != "CHECK_ONLY") parts += ScheduleDisplay.accessCopy(s.accessLevel).label
                val cantRead = s.condition?.cantRead == true
                return@map ScheduleRowModel("${group.id}-${item.id}", circle, s.title,
                    parts.joinToString(SC.separator), repeats = true, time = "", draft = false, paused = inPaused,
                    reading = if (cantRead || inPaused) null else s.condition?.let { ConditionDisplay.rowReading(it, now) },
                    schedule = s, lastSession = lastSession(state, s)) {
                    store.inspect(s.id); store.loadDetail(s.id)
                }
            }
            val line = ScheduleDisplay.phoneRowLine(s.rule, s.workspaceName, s.accessLevel, s.state, s.heldReason, pausedAt, zone)
            ScheduleRowModel("${group.id}-${item.id}", circle, s.title, line,
                ScheduleDisplay.ruleRepeats(s.rule), time, draft = false, paused = inPaused, end = ScheduleDisplay.endText(s, now, zone),
                schedule = s, lastSession = lastSession(state, s)) {
                store.inspect(s.id); store.loadDetail(s.id)
            }
        }
    }
}

private fun lastSession(state: ScheduledStore.State, s: ScheduleView): String? = (state.detail(s.id)?.lastRun ?: s.lastRun)?.sessionId

/** When a schedule was paused: its newest revision that paused it. */
private fun pausedAt(detail: ScheduleDetailResponse?): Instant? = detail?.history
    ?.firstOrNull { (it.after["state"] as? JsonPrimitive)?.contentOrNull == "PAUSED" }?.let { ScheduleDisplay.parse(it.createdAt) }

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ScheduleRow(row: ScheduleRowModel, menu: ScheduleMenu) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    var menuOpen by remember { mutableStateOf(false) }
    val press = if (row.schedule == null) Modifier.clickable(onClick = row.open) else Modifier.combinedClickable(
        onLongClickLabel = "Options for ${row.title}", onLongClick = { menuOpen = true }, onClick = row.open)
    Column(Modifier.fillMaxWidth().then(press).padding(vertical = 8.dp).testTag("schedule-row")) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.padding(top = 1.dp)) { ScheduleCircleGlyph(row.circle) }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                // The title's line carries the tag and the time at its end (board 01 ②: "Failed ×3  02:00").
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(row.title, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge,
                        fontStyle = if (row.draft) FontStyle.Italic else FontStyle.Normal,
                        color = if (row.draft || row.paused) secondary else MaterialTheme.colorScheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    val tag = row.circle.tag
                    if (tag != null && row.circle.circle != ScheduleDisplay.Circle.done && row.circle.circle != ScheduleDisplay.Circle.muted)
                        Text(tag.text, style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold), color = tagColor(tag.tone), maxLines = 1)
                    val reading = row.reading
                    // "6.9% · 1 min ago": how far from firing, and whether the probe is still alive.
                    if (reading != null) Text(buildAnnotatedString {
                        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)) { append(reading.value) }
                        reading.age?.let { append("${SC.separator}$it") }
                    }, Modifier.testTag("schedule-row-reading"), style = MaterialTheme.typography.bodySmall, color = secondary, maxLines = 1)
                    else if (row.time.isNotEmpty()) Text(row.time, style = MaterialTheme.typography.bodySmall, color = secondary, maxLines = 1)
                }
                // One line, the phone's short grammar; the tail gives way if it must.
                Text((if (row.repeats) "↻ " else "") + row.line, style = MaterialTheme.typography.bodySmall, color = secondary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                // The planned end on its own line: "until 23:00 today · 3 runs left" is the part a reader must not lose.
                row.end?.let { Text(it, Modifier.testTag("schedule-row-end"), style = MaterialTheme.typography.bodySmall, color = secondary) }
            }
        }
        row.schedule?.let { s -> DropdownMenu(menuOpen, { menuOpen = false }) { ScheduleRowMenu(s, row.lastSession, menu) { menuOpen = false } } }
    }
}

/** The line at the end (board 01 ② 3, ⑧): one sentence and the workspace it goes to. Not a form: an agent sets the schedule up from
 * it in an ordinary conversation, and its card comes back here as a draft. */
@Composable
private fun QuickAddLine(store: ScheduledStore, typed: String, type: (String) -> Unit, workspaces: List<Pair<String, String>>,
    preferred: String?) {
    val scope = rememberCoroutineScope()
    var asking by remember { mutableStateOf(false) }
    var chosen by rememberSaveable { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    val workspace = workspaces.firstOrNull { it.first == chosen } ?: workspaces.firstOrNull { io.orbitd.android.navigation.ObjectId.same(it.first, preferred) }
        ?: workspaces.firstOrNull()
    fun send() {
        val sentence = typed.trim()
        if (sentence.isEmpty() || workspace == null || asking) return
        asking = true
        scope.launch { if (store.ask(sentence, workspace.first)) type(""); asking = false }
    }
    Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Icon(painterResource(R.drawable.ic_add_circle), null, Modifier.size(24.dp), tint = MaterialTheme.colorScheme.primary)
        TextField(typed, type, Modifier.weight(1f).testTag("schedule-quick-add"), enabled = !asking, singleLine = true,
            placeholder = { Text(SC.QuickAdd.placeholder) }, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { send() }),
            colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                disabledContainerColor = Color.Transparent))
        if (workspace != null) Box {
            Text(workspace.second, Modifier.border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f), RoundedCornerShape(50))
                .clickable { menu = true }.padding(horizontal = 8.dp, vertical = 3.dp).testTag("schedule-quick-add-workspace"),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            DropdownMenu(menu, { menu = false }) {
                workspaces.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { chosen = id; menu = false }) }
            }
        }
    }
}

// MARK: - The detail sheet (board 01 ③, 02 ③)

/** A schedule's detail, from the bottom: what was asked, notes for the next run, this month's use and the history, with Run now,
 * Pause and Change… (a conversation, not a form). Delete is behind ⋯ and asks first. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScheduleDetailSheet(store: ScheduledStore, id: String, close: () -> Unit, openSession: (String) -> Unit, change: (ScheduleView) -> Unit) {
    val state by store.state.collectAsState()
    val scope = rememberCoroutineScope()
    var confirmingDelete by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var more by remember { mutableStateOf(false) }
    var renaming by rememberSaveable(id, stateSaver = RenamingSaver) { mutableStateOf<Renaming?>(null) }
    LaunchedEffect(id) { store.loadDetail(id) }
    val s = state.schedule(id)
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceVariant, contentColor = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.testTag("schedule-detail-panel")) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = close, contentPadding = PaddingValues(0.dp)) { Text("Close") }
                Spacer(Modifier.weight(1f))
                Box {
                    IconButton(onClick = { more = true }, Modifier.testTag("schedule-detail-more")) { Icon(painterResource(R.drawable.ic_more), "More") }
                    DropdownMenu(more, { more = false }) {
                        MenuItem(SC.Actions.rename, R.drawable.ic_edit, "schedule-detail-rename") {
                            more = false
                            s?.let { renaming = Renaming(it.id, it.title) }
                        }
                        HorizontalDivider()
                        MenuItem(SC.Actions.delete, R.drawable.ic_trash, "schedule-detail-delete", danger = true) {
                            more = false; confirmingDelete = true
                        }
                    }
                }
            }
            if (s == null) { CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally)); return@Column }
            val detail = state.detail(id)
            val zone = store.timezone
            val now = Instant.now()
            val lastRun = detail?.lastRun ?: s.lastRun
            val lastFacts = lastRun?.let { ScheduleDisplay.runFindingFacts(it, detail?.findings.orEmpty()) }
            val conditionId = (s.rule as? ScheduleRule.When)?.conditionId ?: s.condition?.id
            val condition = state.condition(conditionId)
            LaunchedEffect(conditionId) { conditionId?.let(store::loadCondition) }
            // A WHEN rule has no time, so its zone says nothing.
            val meta = listOfNotNull(ScheduleDisplay.ruleText(s.rule, ScheduleDisplay.RuleForm.short), s.timezone.takeIf { conditionId == null },
                s.workspaceName, ScheduleDisplay.accessCopy(s.accessLevel).label, ScheduleDisplay.endText(s, now, zone)).joinToString(SC.separator)
            val next = s.nextDueAt?.let(ScheduleDisplay::parse)?.let { ScheduleDisplay.whenText(it, now, zone) } ?: "—"
            val lastLine = lastRun?.let { run ->
                val at = ScheduleDisplay.parse(run.startedAt ?: run.plannedAt)?.let { ScheduleDisplay.whenText(it, now, zone) }.orEmpty()
                val what = ScheduleDisplay.runLine(run.state, run.summary, run.failureReason, run.reasonText, lastFacts?.notified ?: false)
                listOf(SC.Inspector.last, at, what).joinToString(SC.separator)
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(s.title, style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold))
                Text((if (ScheduleDisplay.ruleRepeats(s.rule)) "↻ " else "") + meta, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (conditionId != null) {
                // A WHEN rule (board ⑥ ② ③): how far the reading is from firing, and how it is checked, in place of the next run.
                if (condition != null) ConditionBlocks(condition, zone, now)
                else CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
                lastLine?.let { Text(it, Modifier.padding(start = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } else Block {
                Text(SC.Inspector.nextRun, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(next, style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold))
                lastLine?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            fun door(press: suspend () -> Unit) { busy = true; scope.launch { press(); busy = false } }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                DoorButton(SC.Actions.runNow, Modifier.weight(1f), prominent = true, enabled = !busy) { door { store.runNow(s.id) } }
                if (s.state == "PAUSED" || s.state == "HELD") DoorButton(SC.Actions.resume, Modifier.weight(1f), enabled = !busy) { door { store.resume(s.id) } }
                else DoorButton(SC.Actions.pause, Modifier.weight(1f), enabled = !busy) { door { store.pause(s.id) } }
                DoorButton(SC.Actions.change, Modifier.weight(1f), enabled = !busy) { change(s) }
            }
            state.errorText?.let { Text(it, color = scheduleRed(), style = MaterialTheme.typography.bodySmall) }
            Section(SC.Inspector.whatWasAsked) { Text(s.intent, style = MaterialTheme.typography.bodyMedium) }
            s.note?.takeIf { it.isNotEmpty() }?.let { note ->
                Section(SC.Inspector.notesForNextRun) {
                    Text(note, style = MaterialTheme.typography.bodyMedium)
                    lastRun?.let { ScheduleDisplay.parse(it.plannedAt) }?.let { at ->
                        Text(ScheduleDisplay.fill(SC.Inspector.leftByRunOf, mapOf("date" to ScheduleDisplay.dateText(at, zone))),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Section(SC.Inspector.thisMonth) {
                detail?.usage?.let { Text(ScheduleDisplay.usageText(it.runs, it.minutes), style = MaterialTheme.typography.bodyMedium) }
                Text(ScheduleDisplay.allowedText(s.envelope.runsPerWeek, s.envelope.runLimitMinutes), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HistorySection(store, s, detail, condition, now, zone, openSession)
        }
    }
    renaming?.let { ScheduleRenameDialog(store, it) { renaming = null } }
    if (confirmingDelete && s != null) ScheduleDeleteDialog(store, s) { confirmingDelete = false }
}

@Composable
private fun DoorButton(title: String, modifier: Modifier, prominent: Boolean = false, enabled: Boolean = true, press: () -> Unit) {
    val colors = if (prominent) ButtonDefaults.buttonColors() else ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.primary)
    Button(onClick = press, modifier.testTag("schedule-door-$title"), enabled = enabled, colors = colors, shape = RoundedCornerShape(10.dp),
        contentPadding = PaddingValues(horizontal = 4.dp, vertical = 9.dp)) { Text(title, maxLines = 1) }
}

@Composable
internal fun Block(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
}

@Composable
internal fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title.uppercase(), Modifier.padding(start = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Block(content)
    }
}

private sealed class HistoryEntry {
    abstract val at: String
    abstract val id: String
    data class Run(val run: ScheduleRunView) : HistoryEntry() { override val at get() = run.startedAt ?: run.plannedAt; override val id get() = "run-${run.id}" }
    data class Record(val record: ScheduleChangeRecord) : HistoryEntry() { override val at get() = record.createdAt; override val id get() = "rev-${record.revision}" }
    /** A condition's line (board ⑥ ③): Fired, Ready again; a FIRED's run is drawn by its line, not twice. */
    data class Event(val event: ConditionEventView, val line: ConditionDisplay.HistoryLine, val index: Int) : HistoryEntry() {
        override val at get() = event.at; override val id get() = "event-$index-${event.at}"
    }
}

@Composable
private fun HistorySection(store: ScheduledStore, s: ScheduleView, detail: ScheduleDetailResponse?, condition: ConditionView?, now: Instant,
    zone: String, openSession: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val events = condition?.events.orEmpty().mapIndexedNotNull { index, e ->
        ConditionDisplay.historyLine(e, condition!!)?.let { HistoryEntry.Event(e, it, index) }
    }
    val firedRuns = condition?.events.orEmpty().mapNotNull { it.runId?.let(ScheduledStore::key) }.toSet()
    val runs = detail?.recentRuns.orEmpty().filter { ScheduledStore.key(it.id) !in firedRuns }
    val entries = (runs.map { HistoryEntry.Run(it) } + events + detail?.history.orEmpty().map { HistoryEntry.Record(it) })
        .sortedByDescending { ScheduleDisplay.parse(it.at) ?: Instant.MIN }
    if (entries.isEmpty()) return
    Section(SC.Inspector.history) {
        entries.forEachIndexed { index, entry ->
            if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = 0.2f))
            val whenText = ScheduleDisplay.parse(entry.at)?.let { ScheduleDisplay.whenText(it, now, zone) }.orEmpty()
            when (entry) {
                is HistoryEntry.Run -> {
                    val run = entry.run
                    val facts = ScheduleDisplay.runFindingFacts(run, detail?.findings.orEmpty())
                    val view = ScheduleDisplay.runCircle(run.state, facts.newFinding)
                    val late = run.startedAt?.let(ScheduleDisplay::parse)?.let { started ->
                        ScheduleDisplay.parse(run.plannedAt)?.let { started.epochSecond - it.epochSecond > 15 * 60 } } ?: false
                    Row(Modifier.fillMaxWidth().clickable(enabled = run.sessionId != null) { run.sessionId?.let(openSession) }.testTag("schedule-history-run"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(whenText + if (late) "${SC.separator}${SC.Inspector.late}" else "", style = MaterialTheme.typography.bodyMedium)
                            Text(ScheduleDisplay.runLine(run.state, run.summary, run.failureReason, run.reasonText, facts.notified),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                        }
                        view.tag?.let { Chip(it.text, it.tone) }
                        if (run.sessionId != null) Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
                    }
                }
                is HistoryEntry.Event -> {
                    val line = entry.line
                    val run = line.runId?.let { id -> detail?.recentRuns?.firstOrNull { ScheduledStore.key(it.id) == ScheduledStore.key(id) } }
                    val at = ScheduleDisplay.parse(entry.event.at)?.let { "${ScheduleDisplay.dateText(it, zone)} ${ScheduleDisplay.localParts(it, zone).time}" }.orEmpty()
                    val sub = listOfNotNull(at, run?.let { ScheduleDisplay.capitalizedRunOf(it.plannedAt, zone) }).joinToString(SC.separator)
                    Row(Modifier.fillMaxWidth().clickable(enabled = run?.sessionId != null) { run?.sessionId?.let(openSession) }
                        .testTag("schedule-history-event"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(line.text, style = MaterialTheme.typography.bodyMedium)
                            Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (line.runId != null) {
                            val accent = MaterialTheme.colorScheme.primary
                            Text(line.chip, Modifier.background(accent.copy(alpha = 0.12f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
                                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium), color = accent)
                        } else Chip(line.chip, ScheduleDisplay.TagTone.mute)
                    }
                }
                is HistoryEntry.Record -> {
                    val record = entry.record
                    val who = ScheduleDisplay.historyWho(record.changedBy, record.before, record.after)
                    Row(Modifier.fillMaxWidth().testTag("schedule-history-record"), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(ScheduleDisplay.renamedText(record) ?: ScheduleDisplay.recordText(record), style = MaterialTheme.typography.bodyMedium)
                            Text(whenText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            // Asked for in the schedule's change conversation (§8.2): the person's words, opening it.
                            record.askedText?.takeIf { record.sessionId != null }?.let { asked ->
                                Text("“$asked”${SC.separator}${SC.ChangeConversation.conversation}",
                                    Modifier.clickable { record.sessionId?.let(openSession) }.testTag("schedule-history-asked"),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                        Chip(who.text, if (who.who == "USER" || who.who == "ALLOWED") ScheduleDisplay.TagTone.new else ScheduleDisplay.TagTone.mute)
                        if (ScheduleDisplay.recordUndoable(record)) TextButton(onClick = { scope.launch { store.undo(s.id, record.revision) } },
                            contentPadding = PaddingValues(horizontal = 4.dp)) { Text(SC.Actions.undo) }
                    }
                }
            }
        }
    }
}

@Composable
internal fun Chip(text: String, tone: ScheduleDisplay.TagTone) {
    val color = tagColor(tone)
    Text(text, Modifier.background(color.copy(alpha = 0.12f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Medium), color = color)
}

// MARK: - The draft sheet (board 01 ⑧ ②)

/** What one sentence on the quick-add line became: "You typed: …", the create card its agent drafted (Create is all there is to
 * it), and the conversation to talk it over in. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScheduleDraftSheet(store: ScheduledStore, panel: ScheduledStore.DraftPanel, close: () -> Unit, openConversation: () -> Unit) {
    val state by store.state.collectAsState()
    val card = state.draft(panel.sessionId)
    // The agent drafts the card in its conversation; read until it is there.
    LaunchedEffect(panel.sessionId, card == null) { while (card == null) { store.loadNow(); delay(3_000) } }
    ModalBottomSheet(onDismissRequest = close, modifier = Modifier.testTag("schedule-draft-panel")) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (card != null) {
                card.runsIn?.workspaceName?.let { Text(ScheduleDisplay.fill(SC.Inspector.draftMeta, mapOf("workspace" to it)),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Text("“${card.intent ?: panel.typed}”", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                ScheduleCreateCard(card, panel = true) { allow ->
                    val result = if (allow) store.allow(card) else store.decline(card)
                    if (result == ScheduledStore.PressResult.Done) store.closeDraftPanel()
                    result
                }
            } else {
                Text("“${panel.typed}”", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally))
            }
            TextButton(onClick = openConversation, Modifier.align(Alignment.CenterHorizontally)) { Text(SC.Actions.openConversation) }
        }
    }
}

/** The drawer's number beside Scheduled (board 01 ① 2): the schedules that need the owner — held, failing with no run under way,
 * or a condition that cannot be read — in the orange the Projects row writes its own in, and nothing at zero. */
@Composable
fun ScheduledDrawerCount(count: Int) {
    if (count > 0) Text("$count", Modifier.testTag("scheduled-drawer-count").semantics { contentDescription = "$count need you" },
        color = Color(0xFFFF9500), style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold))
}
