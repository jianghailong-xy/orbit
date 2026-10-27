package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.number
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.projects.LandingHead
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.ProjectLandingHead
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlinx.serialization.json.JsonObject

// A landing session's pieces (contract §2.9 LS1, LS6, LS7; design §3; mockups v4 05 and 07): the status card over its newest attempt,
// the server's timeline, the check output a line opens, and the owner doors the landing view's facts allow. Since revision 28 (owner
// 2026-10-27, docs/mocks/landings-one-window) they are drawn inside the project's Landings window (ProjectLandingsWindow.kt), one card
// or row per landing: a landing session id opens that window focused on it, and no landing has a page of its own. A reading surface,
// not a conversation: no composer, no engine, no model, no rename, fork, share or merge bar, and no session events (each card polls
// §2.7a's cadence instead). Every word and every door condition is LandingSessionModel's, tested on the JVM; this file only lays
// them out.

/**
 * `Destination.SESSION`'s two renderers, chosen by the DETAIL's `sessionKind` (LS6): a landing opens its project's Landings window
 * (the project the detail's `landing.projectId` names), focused on that landing — scrolled to, opened and outlined — and never the
 * reader: no composer, no session menu and no `sessions/:id/events` subscription. A conversation gets the reader as it always did. A
 * session the directory does not list is asked for once (a landing link reaches its subject before the session row exists, and a
 * flat list never carries a landing), so the answer is the server's, never a guess from an id. When that one read fails, an id an
 * integration read named as a landing job's ([LandingJobSnapshots]) still opens that job's project's window, whose card draws the job
 * frozen; any other id gets the reader. Every way into a landing — Open landing ›, the coordinator's cards, the task page's Landing
 * section, the source session's chip, an orbit-session link — comes through here.
 */
@Composable
fun SessionDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, api: DirectoryApi, data: DirectoryData,
    open: (OrbitRoute) -> Unit, leave: () -> Unit = {}) {
    val id = route.id ?: return
    val listed = remember(data.sessions, id) { data.sessions.values.any { rows -> rows.any { ObjectId.same(it.id, id) } } }
    var kind by remember(id) { mutableStateOf<SessionKind?>(if (listed) SessionKind.Conversation else null) }
    LaunchedEffect(id, listed) {
        if (listed) { kind = SessionKind.Conversation; return@LaunchedEffect }
        if (kind != null) return@LaunchedEffect
        kind = try { SessionKind.of(api.objectRead(listOf("sessions", id))) }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { app.landingJobs.snapshot(handle, id)?.let { SessionKind.Landing(it.projectId, null) } ?: SessionKind.Conversation }
    }
    when (val shown = kind) {
        null -> Box(Modifier.fillMaxSize().testTag("session-opening"), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        is SessionKind.Landing -> if (shown.projectId.isEmpty()) {
            // A landing view that names no project has no window to open: say so rather than read every project's sessions.
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(LandingSessionCopy.UPDATE_UNAVAILABLE, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else ProjectLandingsWindow(app, handle, route, api, shown.projectId, id, open, shown.detail)
        SessionKind.Conversation -> SessionReader(app, handle, route, api, data, open, leave)
    }
}

/** What a session id turned out to be: a conversation, or a landing of a project (with the detail that said so, when it was read). */
internal sealed interface SessionKind {
    data object Conversation : SessionKind
    data class Landing(val projectId: String, val detail: JsonObject?) : SessionKind

    companion object {
        fun of(detail: JsonObject): SessionKind = if (!LandingSessionModel.isLanding(detail)) Conversation
            else Landing(LandingSessionModel.view(detail)?.projectId?.takeIf { it.isNotEmpty() }
                ?: detail.obj("projectMembership")?.text("projectId").orEmpty(), detail)
    }
}

/** What a landing's card holds between reads: the session detail and its landing view, when this device last got an answer, the
 *  project facts the head and the gates take (V6's step start and usual duration, the main branch, the coordinator and the
 *  round's candidate), a refusal the server wrote for the last press, and — while no read has answered and the last one
 *  failed — the job an integration read last described, which the card draws frozen. */
internal data class LandingSessionRead(
    val view: LandingView? = null,
    val rowTitle: String? = null,
    val taskTitle: String? = null,
    val updatedAt: Instant? = null,
    val failed: Boolean = false,
    val integration: JsonObject? = null,
    val coordinator: JsonObject? = null,
    val promotion: JsonObject? = null,
    val mergedPromotions: List<JsonObject> = emptyList(),
    val refusal: String? = null,
    val acting: Boolean = false,
    val offline: LandingJobSnapshot? = null,
) {
    /** The coordinator conversation that decides this work, when the project has a live one to open. */
    val coordinatorId: String? get() = coordinator?.obj("coordination")?.obj("session")?.text("id")

    /** The candidate the round is about: the one on offer while it runs, the merged receipt once the round settled. */
    fun currentPromotion(): JsonObject? = view?.let { landing ->
        if (landing.subject != "PROMOTION") null
        else if (landing.settledAt != null) mergedPromotions.firstOrNull { it.text("promotionId") == landing.promotionId }
        else promotion
    }

    /** The V6 facts the landing view does not carry: the in-flight job's step start and usual duration, and the main branch. */
    fun facts(): LandingFacts {
        val jobId = view?.currentAttempt?.jobId
        val job = integration?.let { view -> ProjectPage.inFlightJobs(view)?.firstOrNull { it.text("jobId") == jobId } }
        return LandingFacts(job?.text("stepStartedAt"), job?.number("typicalMs"), RunSettings.mainBranchName(integration?.text("upstreamRef")))
    }
}

/** The reads a landing's card makes each round: its own detail, then the project facts beside it (iOS `refresh`). */
internal object LandingSessionReads {
    private suspend fun <T> attempt(read: suspend () -> T): T? =
        try { read() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }

    suspend fun read(api: DirectoryApi, projects: ProjectApi, id: String, state: LandingSessionRead, snapshots: LandingJobSnapshots,
        handle: SessionHandle, publish: (LandingSessionRead) -> Unit) {
        val readAt = Instant.now()
        val detail = attempt { api.objectRead(listOf("sessions", id)) }
        var next = if (detail != null) state.copy(view = LandingSessionModel.view(detail) ?: state.view,
            rowTitle = detail.text("title") ?: state.rowTitle, updatedAt = readAt, failed = false, offline = null)
        else state.copy(failed = true, offline = if (state.view == null) snapshots.snapshot(handle, id) else null)
        publish(next)
        val landing = next.view ?: return
        if (landing.projectId.isEmpty()) return
        if (landing.settledAt == null) {
            attempt { projects.integration(landing.projectId) }?.let { snapshots.remember(handle, landing.projectId, it); next = next.copy(integration = it) }
            attempt { projects.coordinator(landing.projectId) }?.let { next = next.copy(coordinator = it) }
            if (landing.subject == "PROMOTION") attempt { projects.currentPromotion(landing.projectId) }?.let { next = next.copy(promotion = it) }
        } else if (landing.subject == "PROMOTION") {
            attempt { projects.mergedPromotions(landing.projectId) }?.let { next = next.copy(mergedPromotions = it) }
        }
        // A landing whose row is not inserted yet (LS1) has no title of its own: its task's names it.
        if (landing.subject == "TASK" && next.rowTitle.isNullOrEmpty() && next.taskTitle == null && !landing.taskId.isNullOrEmpty()) {
            attempt { api.objectRead(listOf("tasks", landing.taskId)).text("title") }?.let { next = next.copy(taskTitle = it) }
        }
        publish(next)
    }

    /** One page of one check's output; null when the read failed, which the log block says in its own words. */
    suspend fun log(api: DirectoryApi, sessionId: String, selectors: LandingLogSelectors, cursor: String?): LandingLogPage? =
        attempt {
            val query = buildList {
                add("jobId" to selectors.jobId)
                selectors.claim?.let { add("claim" to "$it") }
                selectors.round?.let { add("round" to "$it") }
                selectors.check?.let { add("check" to "$it") }
                cursor?.takeIf { it.isNotBlank() }?.let { add("cursor" to it) }
            }
            LandingSessionModel.logPage(api.read(listOf("sessions", sessionId, "landing", "log"), JsonObject.serializer(), query))
        }
}

/** The menu a landing's long-press opens — the old landing page's ⋯, row for row: the ways to look at this work, then the doors the
 *  landing view's facts open (design §3, LS6). No Copy Link. A landing whose view has not been read yet ([items] null) has one row,
 *  saying so, until the read lands. */
@Composable
internal fun LandingEntryMenu(expanded: Boolean, items: List<LandingMenuItem>?, onDismiss: () -> Unit, onPress: (LandingMenuAction) -> Unit) {
    DropdownMenu(expanded, onDismiss, Modifier.testTag("landing-menu")) {
        if (items == null) DropdownMenuItem(text = { Text(LandingSessionCopy.LOADING_LANDING) }, onClick = {}, enabled = false,
            modifier = Modifier.testTag("landing-menu:loading"))
        else items.forEachIndexed { index, item ->
            if (item.danger && index > 0 && !items[index - 1].danger) HorizontalDivider()
            DropdownMenuItem(text = {
                Column {
                    Text(item.label, color = if (item.danger) MaterialTheme.colorScheme.error else Color.Unspecified)
                    item.sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }, onClick = { onDismiss(); onPress(item.action) }, modifier = Modifier.testTag("landing-menu:${item.key}"))
        }
    }
}

/** A landing's record, as its row or card opens to it in the window: the server's timeline — its facts, then one section per attempt
 *  (a task segment's generation, or a merge round's check and merge) with the check a finished line opens — and the line that says
 *  older attempts are not shown. */
@Composable
internal fun LandingRecord(view: LandingView, now: Instant, zone: ZoneId, onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    val timeline = view.timeline ?: return
    Column(Modifier.fillMaxWidth().testTag("landing:record"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // The current round's state is the status card's to say; the board's timeline does not repeat it as a fact (05 c).
        timeline.facts.filter { it.kind != "PROMOTION_STATE" }.forEachIndexed { index, fact ->
            Text(fact.text, Modifier.testTag("landing:fact:$index"), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        timeline.sections.forEach { section -> key(section.jobId) { LandingTimelineSectionView(section, view, now, zone, onLog) } }
        if (timeline.truncated) Text(LandingSessionCopy.OLDER_ATTEMPTS_HIDDEN, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** An open entry's up arrow, at the right of its head (board 03 e): pressing the entry again folds it. */
@Composable
internal fun LandingUpArrow() {
    Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(14.dp).rotate(180f).testTag("landing:open-arrow"),
        tint = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** The status card's head with the line the window adds under it — the task's name — and, while the entry is open, its up arrow. */
@Composable
private fun LandingCardHead(taskName: String?, expanded: Boolean, head: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            head()
            taskName?.takeIf { it.isNotEmpty() }?.let {
                Text(it, Modifier.testTag("landing:task-name"), style = MaterialTheme.typography.bodyMedium, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
            }
        }
        if (expanded) Box(Modifier.padding(top = 8.dp)) { LandingUpArrow() }
    }
}

/**
 * A landing's status card (the old landing page's card, mockups v4 05): the head over its newest attempt — V6's step clock, budget bar
 * and liveness while it moves; what stopped it while it waits; the outcome once it settled — with [taskName], the line the Landings
 * window adds under the head. A timed-out attempt keeps its own doors (Retry, Re-run the check, Abandon); a landing that waits for a
 * decision carries [waitDoors], the doors to the people who decide (board 02 d), the first of them the primary. [modifier] is the
 * window's press on the card; [expanded] draws the open entry's up arrow.
 */
@Composable
internal fun LandingStatusCard(state: LandingSessionRead, view: LandingView?, card: LandingAttemptCard?, outcome: LandingOutcomeCard?,
    now: Instant, onPress: (LandingMenuAction) -> Unit, modifier: Modifier = Modifier, taskName: String? = null, expanded: Boolean = false,
    waitDoors: List<LandingMenuAction> = emptyList()) {
    val warning = LocalOrbitColors.current.needsYou
    val success = LocalOrbitColors.current.success
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = RoundedCornerShape(14.dp)
    val wash = when {
        outcome?.ok == true -> success.copy(alpha = 0.08f)
        card?.timedOut == true -> warning.copy(alpha = 0.08f)
        else -> muted.copy(alpha = 0.1f)
    }
    val stroke = when {
        outcome?.ok == true -> success.copy(alpha = 0.3f)
        card?.timedOut == true -> warning.copy(alpha = 0.3f)
        else -> Color.Transparent
    }
    Column(Modifier.fillMaxWidth().clip(shape).background(wash, shape).border(1.dp, stroke, shape).then(modifier).padding(12.dp)
        .testTag("landing-status-card"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (view == null) {
            // A first read that failed draws the job an integration read last described, frozen at that read, with no door
            // (iOS `offlineCard`); with none kept, the note says only that the update is unavailable.
            val frozen = state.offline?.let { kept ->
                LandingSessionModel.attemptCard(LandingSessionModel.offlinePlaceholder(kept.job.text("landingSessionId").orEmpty(), kept.job),
                    now, kept.readAt, failed = true, kept.facts)
            }
            if (frozen != null) {
                LandingCardHead(taskName, expanded) {
                    ProjectLandingHead(frozen.word, LandingHead(frozen.right, frozen.rightIsClock, frozen.detail), running = false, timedOut = false)
                }
                frozen.live?.let { Text(it, Modifier.testTag("landing:live"), style = MaterialTheme.typography.bodySmall, color = muted) }
            } else LandingCardHead(taskName, expanded) {
                Text(if (state.failed) LandingSessionCopy.UPDATE_UNAVAILABLE else LandingSessionCopy.LOADING_LANDING, Modifier.testTag("landing:status-note"),
                    style = MaterialTheme.typography.bodyMedium, color = muted)
            }
        } else if (outcome != null) {
            // A settled success wears the green ✓ the merge card's `Merged into main` row wears (mockup 05 c).
            LandingCardHead(taskName, expanded) {
                ProjectLandingHead(outcome.title, LandingHead(outcome.right, false, outcome.detail.orEmpty()), running = false, timedOut = false,
                    ok = outcome.ok)
            }
            outcome.tasksHeading?.let { Text(it, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold) }
            outcome.tasks.forEach { title ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("•", color = muted)
                    Text(title, style = MaterialTheme.typography.bodyMedium)
                }
            }
            outcome.checkLine?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = success) }
            outcome.treeLine?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
        } else if (card == null) {
            LandingCardHead(taskName, expanded) {
                Text(LandingSessionCopy.QUEUED, style = MaterialTheme.typography.bodyMedium, color = muted)
            }
        } else {
            // The head's one line is the card's on a narrow landing row; a card has room for the claim, the round and a takeover's
            // first start in full (mockups v4 05 h–j).
            LandingCardHead(taskName, expanded) {
                ProjectLandingHead(card.word, LandingHead(card.right, card.rightIsClock, card.detail), card.running, card.timedOut, detailLines = 3,
                    failed = card.stoppedOnFailure)
            }
            card.budget?.let { budget ->
                Text(budget, Modifier.testTag("landing:budget"), style = MaterialTheme.typography.bodySmall, color = muted)
                card.progress?.let { LandingBudgetMeter(it, card.usualProgress) }
            }
            card.live?.let { live ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (card.fresh) Box(Modifier.size(7.dp).background(success, CircleShape).testTag("landing:live-dot"))
                    Text(live, Modifier.testTag("landing:live"), style = MaterialTheme.typography.bodySmall, color = muted)
                }
            }
            val attempt = view.currentAttempt
            if (card.timedOut && attempt != null) {
                Text(LandingSessionModel.timeoutLine(attempt, state.facts().mainBranch), Modifier.testTag("landing:timeout-line"),
                    style = MaterialTheme.typography.bodySmall, color = muted)
                LandingSessionModel.pushSentence(view, attempt)?.let {
                    Text(it, Modifier.testTag("landing:push-sentence"), style = MaterialTheme.typography.bodySmall, color = muted)
                }
            }
            if (view.subject == "PROMOTION" && view.settledAt == null && card.running &&
                attempt?.kind == "CHECK_PROMOTION") {
                state.currentPromotion()?.let { promotion ->
                    io.orbitd.android.core.cards.PromotionCards.onPassLine(promotion)?.let {
                        Text(it, Modifier.testTag("landing:on-pass"), style = MaterialTheme.typography.bodySmall, color = muted)
                    }
                }
            }
            card.failure?.let { Text(it, Modifier.testTag("landing:failure"), style = MaterialTheme.typography.bodySmall, color = muted) }
            if (card.timedOut) {
                val gates = LandingSessionModel.gates(view, now, state.updatedAt, state.failed)
                val push = attempt?.let { LandingSessionModel.pushSentence(view, it) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (gates.retry) Button(onClick = { onPress(LandingMenuAction.RETRY) }, enabled = !state.acting,
                        modifier = Modifier.testTag("landing:retry")) { Text(LandingSessionCopy.RETRY) }
                    if (gates.recheck) Button(onClick = { onPress(LandingMenuAction.RERUN_THE_CHECK) }, enabled = !state.acting,
                        modifier = Modifier.testTag("landing:rerun")) { Text(LandingSessionCopy.RERUN_THE_CHECK) }
                    if (gates.abandon) AbandonButton({ onPress(LandingMenuAction.ABANDON) }, !state.acting, Modifier.testTag("landing:abandon"))
                }
                doorHint(gates, push, attempt)?.let {
                    Text(it, Modifier.testTag("landing:door-hint"), style = MaterialTheme.typography.bodySmall, color = muted)
                }
            }
        }
        // A landing that waits for a decision names the people who make it: the coordinator first, then the task or the round's card.
        if (waitDoors.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            waitDoors.forEachIndexed { index, action ->
                val label = when (action) {
                    LandingMenuAction.OPEN_COORDINATOR -> LandingSessionCopy.OPEN_COORDINATOR
                    LandingMenuAction.OPEN_TASK -> LandingSessionCopy.OPEN_TASK
                    else -> LandingSessionCopy.REVIEW_CARD
                }
                val tag = Modifier.testTag("landing:wait:${action.name.lowercase()}")
                if (index == 0) Button(onClick = { onPress(action) }, modifier = tag) { Text(label) }
                else FilledTonalButton(onClick = { onPress(action) }, modifier = tag) { Text(label) }
            }
        }
    }
}

/** Abandon beside a timed-out attempt's solid door, on this page's card and the merge card: boards v4 04 and 05's light red
 *  secondary (`cap4.red`) — a red wash and red ink, no outline. */
@Composable
internal fun AbandonButton(onClick: () -> Unit, enabled: Boolean, modifier: Modifier = Modifier) {
    FilledTonalButton(onClick = onClick, enabled = enabled, modifier = modifier, colors = ButtonDefaults.filledTonalButtonColors(
        containerColor = MaterialTheme.colorScheme.error.copy(alpha = 0.12f), contentColor = MaterialTheme.colorScheme.error)) {
        Text(LandingSessionCopy.ABANDON)
    }
}

/** The hint under a timed-out card's doors: what a Re-run ends, that a confirmed merge has no Retry, or an older
 *  runner's may-have-been sentence (web's `hintText`). */
private fun doorHint(gates: LandingGates, pushSentence: String?, attempt: LandingAttempt?): String? = when {
    gates.recheck -> "${LandingSessionCopy.RERUN_END} ${LandingSessionCopy.ABANDON_END}"
    attempt?.kind == "LAND_PROMOTION" -> LandingSessionCopy.NO_RETRY_MERGE
    gates.retry && pushSentence == LandingSessionCopy.MAY_HAVE_PUSHED_SENTENCE -> LandingSessionCopy.LEGACY_PUSH_VARIANT
    else -> null
}

/** How far the step is through its budget, with the check's usual duration as the board's little tick. */
@Composable
private fun LandingBudgetMeter(progress: Float, usual: Float?) {
    Box(Modifier.fillMaxWidth().height(4.dp).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.2f), CircleShape)
        .testTag("landing:meter"), contentAlignment = Alignment.CenterStart) {
        Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).fillMaxHeight().background(MaterialTheme.colorScheme.primary.copy(alpha = 0.6f), CircleShape))
        usual?.let {
            Box(Modifier.fillMaxWidth(it.coerceIn(0f, 1f)).height(4.dp), contentAlignment = Alignment.CenterEnd) {
                Box(Modifier.width(1.5.dp).fillMaxHeight().background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)))
            }
        }
    }
}

@Composable
private fun LandingTimelineSectionView(section: LandingSection, view: LandingView, now: Instant, zone: ZoneId,
    onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val current = section.jobId == view.currentAttempt?.jobId
    var openLog by remember(section.jobId) { mutableStateOf<LandingLogSelectors?>(null) }
    Column(Modifier.fillMaxWidth().testTag("landing:section:${section.jobId}"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(section.title, Modifier.testTag("landing:section-title:${section.jobId}"), style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold)
            LandingSessionModel.sectionState(section.state)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = muted)
            }
        }
        section.entries.forEachIndexed { index, entry ->
            val selectors = if (entry.kind == "CHECK_FINISHED") LandingLogSelectors(section.jobId, entry.claim, entry.round, entry.checkIndex) else null
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
                    ProjectTime.parse(entry.at)?.let {
                        Text(ProjectPage.landingClockTime(it, zone), Modifier.testTag("landing:entry-time:$index"),
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = muted)
                    }
                    val mark = landingMark(entry, section.kind, section.entries, index)
                    Text(mark.first, Modifier.width(16.dp).testTag("landing:mark:$index"), style = MaterialTheme.typography.bodySmall,
                        color = mark.second)
                    Text(entry.text, Modifier.weight(1f).testTag("landing:entry:$index"), style = MaterialTheme.typography.bodyMedium)
                    if (selectors != null) {
                        TextButton(onClick = { openLog = if (openLog == selectors) null else selectors },
                            modifier = Modifier.testTag("landing:log:$index")) { Text("${LandingSessionCopy.LOG} ›", style = MaterialTheme.typography.bodySmall) }
                    }
                }
                entry.reason?.takeIf { it.isNotEmpty() && !entry.text.contains(it) }?.let {
                    Text(it, Modifier.padding(start = 24.dp), style = MaterialTheme.typography.bodySmall, color = muted)
                }
                when {
                    selectors != null && openLog == selectors -> LandingLogBlock(selectors, onLog)
                    selectors != null && !LandingSessionModel.checkPassed(entry) -> LandingInlineOutput(selectors, onLog)
                }
            }
        }
        if (current && view.currentAttempt?.state == "RUNNING" && !view.currentAttempt.timedOut && view.currentAttempt.check != null) {
            val attempt = view.currentAttempt
            val check = attempt.check!!
            val selector = LandingLogSelectors(attempt.jobId, attempt.claim, attempt.round, check.index)
            LandingLiveCheck(selector, "${LandingSessionModel.checkLabel(check.name)} · live " +
                ProjectPage.landingClock(max(0.0, ProjectTime.between(ProjectTime.parse(check.startedAt) ?: now, now))), onLog)
        }
        if (current) LandingSessionModel.noReportBand(view, zone)?.let {
            Text(it, Modifier.fillMaxWidth().background(muted.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 6.dp)
                .testTag("landing:no-report"), style = MaterialTheme.typography.bodySmall, color = muted)
        }
    }
}

/** What a timeline mark says, and the ink it says it in (mockups 05 a/e/i). */
private fun landingMark(entry: LandingEntry, jobKind: String, entries: List<LandingEntry>, index: Int): Pair<String, Color> = when (entry.kind) {
    "TAKEN_OVER" -> "↗" to Color(0xFF0066BE)
    "CHECK_FINISHED", "RESULT", "RESULT_FALLBACK" ->
        if (LandingSessionModel.entryOk(entry, jobKind)) "✓" to Color(0xFF247344) else "✗" to Color(0xFFB3261E)
    "STOP_REQUESTED", "CANCELLED", "ABANDONED", "TIMED_OUT", "PUSH_REFUSED" -> "✗" to Color(0xFFB3261E)
    "ENQUEUED", "REQUEUED", "NEXT_GENERATION", "SKIPPED_CHECK", "FIX_TASK" -> "≡" to Color.Unspecified
    "RELEASED" -> "↩" to Color.Unspecified
    "STEP" -> {
        val later = entries.drop(index + 1).any { it.kind in setOf("STEP", "CHECK_STARTED", "TAKEN_OVER", "RESULT", "CHECK_FINISHED", "CANCELLED", "TIMED_OUT") }
        if (later) "✓" to Color(0xFF247344) else "↻" to Color(0xFF0066BE)
    }
    else -> "↻" to Color(0xFF0066BE)
}

/** One finished check's output as `Log ›` opens it: read page by page, in the theme's own ink. */
@Composable
private fun LandingLogBlock(selectors: LandingLogSelectors, onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    var page by remember(selectors) { mutableStateOf<LandingLogPage?>(null) }
    var failed by remember(selectors) { mutableStateOf(false) }
    var loading by remember(selectors) { mutableStateOf(false) }
    suspend fun load(cursor: String?) {
        loading = true
        val answer = onLog(selectors, cursor)
        if (answer == null) failed = true else {
            failed = false
            page = if (cursor != null && page != null) LandingLogPage(answer.jobId, page!!.entries + answer.entries, answer.nextCursor) else answer
        }
        loading = false
    }
    val scope = rememberCoroutineScope()
    LaunchedEffect(selectors) { load(null) }
    LandingLogBody(page, failed, loading) { cursor -> scope.launch { load(cursor) } }
}

/** The check running now: its last few printed lines, polled with the page while it runs. */
@Composable
private fun LandingLiveCheck(selectors: LandingLogSelectors, title: String, onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    var text by remember(selectors) { mutableStateOf("") }
    LaunchedEffect(selectors) {
        while (isActive) {
            onLog(selectors, null)?.let { page -> text = LandingSessionModel.tail(page.entries.joinToString("") { it.text }) }
            delay(4_000)
        }
    }
    Column(Modifier.padding(start = 24.dp).testTag("landing:live-check"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (text.isNotEmpty()) LandingDarkOutput(text)
    }
}

/** A failed check's last lines, inline: the failure's own words, read once from the log `Log ›` opens, in the dark block the
 *  running check wears (mockup 05 g; iOS and web `LandingInlineOutput`). A read that fails or finds nothing draws nothing here;
 *  `Log ›` still opens the whole log. */
@Composable
private fun LandingInlineOutput(selectors: LandingLogSelectors, onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    var text by remember(selectors) { mutableStateOf("") }
    LaunchedEffect(selectors) { onLog(selectors, null)?.let { page -> text = LandingSessionModel.tail(page.entries.joinToString("") { it.text }) } }
    if (text.isNotEmpty()) Box(Modifier.padding(start = 24.dp).testTag("landing:inline-output")) { LandingDarkOutput(text) }
}

@Composable
private fun LandingLogBody(page: LandingLogPage?, failed: Boolean, loading: Boolean, more: (String) -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // The theme's own ink on a faint wash of it, as iOS's `Color.primary` does: readable on a dark theme as on a light one.
    val ink = MaterialTheme.colorScheme.onSurface
    Column(Modifier.padding(start = 24.dp).fillMaxWidth().background(ink.copy(alpha = 0.04f), RoundedCornerShape(8.dp)).padding(8.dp)
        .testTag("landing:log-block"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when {
            failed -> Text("${LandingSessionCopy.LOG_UNAVAILABLE}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            page == null -> Text(LandingSessionCopy.LOADING_LOG, style = MaterialTheme.typography.bodySmall, color = muted)
            page.entries.isEmpty() -> Text(LandingSessionCopy.LOG_EMPTY, style = MaterialTheme.typography.bodySmall, color = muted)
            else -> page.entries.forEach { entry ->
                if (entry.truncatedBytes > 0) Text(LandingSessionCopy.bytesOmitted(entry.truncatedBytes), style = MaterialTheme.typography.bodySmall, color = muted)
                Text(entry.text, Modifier.testTag("landing:log-text"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = ink)
            }
        }
        if (page?.nextCursor != null) TextButton(onClick = { more(page.nextCursor) }, enabled = !loading,
            modifier = Modifier.testTag("landing:log-more")) { Text(LandingSessionCopy.SHOW_MORE) }
    }
}

@Composable
private fun LandingDarkOutput(text: String) {
    Text(text, Modifier.fillMaxWidth().background(Color(0xFF1F1F1F), RoundedCornerShape(8.dp)).padding(10.dp).testTag("landing:output"),
        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace), color = Color(0xFFEBEBEB))
}
