package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
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
import io.orbitd.android.projects.ProjectApi
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
 * session the directory does not list, nor the Completed or Trash list the reader came from ([listedElsewhere]), is asked for once
 * (a landing link reaches its subject before the session row exists, and a flat list never carries a landing), so the answer is the
 * server's, never a guess from an id. When that one read fails, an id an
 * integration read named as a landing job's ([LandingJobSnapshots]) still opens that job's project's window, whose card draws the job
 * frozen; any other id gets the reader. Every way into a landing — Open landing ›, the coordinator's cards, the task page's Landing
 * section, the source session's chip, an orbit-session link — comes through here.
 */
@Composable
fun SessionDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, api: DirectoryApi, data: DirectoryData,
    open: (OrbitRoute) -> Unit, listedElsewhere: (String) -> Boolean = { false }, leave: () -> Unit = {}) {
    val id = route.id ?: return
    val listed = remember(data.sessions, id) { data.sessions.values.any { rows -> rows.any { ObjectId.same(it.id, id) } } || listedElsewhere(id) }
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

/** How a landing's line says it stands. */
internal enum class LandingLineKind { OK, MERGE, QUIET, FAILED, RUNNING }

/** The tag a card's task name keeps, as the window's tests and the device rounds read it. */
private const val CARD_NAME_TAG = "landing:task-name"

/** Where what a line carries hangs: under its title, off its mark. */
internal val LANDING_LINE_INDENT = 22.dp

/**
 * A landing as the session chat's background-job line (owner 2026-11-11, docs/mocks/landings-chat-tools-native;
 * `BackgroundWakeViews`), on two lines as a phone has room for: the mark, how it ended (red when it failed), a short fact on a chip,
 * when, and `Details ›`; under them the task's name, up to two lines. Web: `LandingLine`; iOS: `LandingLineView`.
 */
@Composable
internal fun LandingLine(kind: LandingLineKind, title: String, name: String?, status: String?, time: String?, open: Boolean,
    modifier: Modifier = Modifier, nameTag: String = "landing-line:name", titleTag: String = "landing-line:title",
    statusTag: String = "landing-line:status", markTag: String? = null) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val red = MaterialTheme.colorScheme.error
    val label = MaterialTheme.typography.bodyMedium
    Column(modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.width(16.dp).then(markTag?.let { Modifier.testTag(it) } ?: Modifier), contentAlignment = Alignment.Center) {
                when (kind) {
                    LandingLineKind.OK -> Icon(painterResource(R.drawable.ic_check_circle), null, Modifier.size(15.dp), tint = LocalOrbitColors.current.success)
                    LandingLineKind.FAILED -> Icon(painterResource(R.drawable.ic_x_circle), null, Modifier.size(15.dp), tint = red)
                    LandingLineKind.QUIET -> Icon(painterResource(R.drawable.ic_minus), null, Modifier.size(15.dp), tint = muted)
                    LandingLineKind.RUNNING -> Icon(painterResource(R.drawable.ic_clock), null, Modifier.size(15.dp), tint = muted)
                    LandingLineKind.MERGE -> Text("⇢", style = label, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
                }
            }
            Text(title, Modifier.weight(1f, fill = false).testTag(titleTag), style = label,
                color = if (kind == LandingLineKind.FAILED) red else muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            status?.takeIf { it.isNotEmpty() }?.let {
                Text(it, Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f), RoundedCornerShape(4.dp))
                    .padding(horizontal = 5.dp, vertical = 1.dp).testTag(statusTag),
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = muted, maxLines = 1, softWrap = false)
            }
            time?.takeIf { it.isNotEmpty() }?.let {
                Text(it, Modifier.testTag("landing-line:time"), style = MaterialTheme.typography.labelSmall.copy(fontFeatureSettings = "tnum"),
                    color = muted, maxLines = 1, softWrap = false)
            }
            Text(LandingStepCopy.DETAILS, style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, softWrap = false)
            Icon(painterResource(R.drawable.ic_chevron_forward), null,
                Modifier.size(12.dp).rotate(if (open) 90f else 0f).testTag(if (open) "landing:open-arrow" else "landing-line:caret"),
                tint = muted.copy(alpha = 0.6f))
        }
        name?.takeIf { it.isNotEmpty() }?.let {
            Text(it, Modifier.padding(start = LANDING_LINE_INDENT).testTag(nameTag), style = label,
                color = if (kind == LandingLineKind.MERGE) muted else MaterialTheme.colorScheme.onSurface, maxLines = 2,
                overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * A landing still in hand (the old landing page's card, mockups v4 05; owner 2026-11-11, docs/mocks/landings-chat-tools-native): its
 * line — how its newest attempt stands, the task's name under it — and what it carries hung under the line's mark: V6's step clock,
 * budget bar and liveness while it moves; what stopped it while it waits; the outcome once it settled. No card of its own. A timed-out
 * attempt keeps its own doors (Retry, Re-run the check, Abandon); a landing that waits for a decision carries [waitDoors], the doors to
 * the people who decide (board 02 d), the first the primary, under who decides. [modifier] is the window's press on the line; [expanded]
 * turns its caret.
 */
@Composable
internal fun LandingStatusCard(state: LandingSessionRead, view: LandingView?, card: LandingAttemptCard?, outcome: LandingOutcomeCard?,
    now: Instant, onPress: (LandingMenuAction) -> Unit, modifier: Modifier = Modifier, taskName: String? = null, expanded: Boolean = false,
    waitDoors: List<LandingMenuAction> = emptyList()) {
    val success = LocalOrbitColors.current.success
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // A round's word (Merge check, Merge to main) says which of its jobs this is.
    val word = if (view?.subject == "PROMOTION" && card != null && !card.rightIsClock) card.word else null
    val name = listOfNotNull(word, taskName).filter { it.isNotEmpty() }.joinToString(" · ").takeIf { it.isNotEmpty() }
    Column(Modifier.fillMaxWidth().testTag("landing-status-card"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (view == null) {
            // A first read that failed draws the job an integration read last described, frozen at that read, with no door
            // (iOS `offlineCard`); with none kept, the line says only that the update is unavailable.
            val frozen = state.offline?.let { kept ->
                LandingSessionModel.attemptCard(LandingSessionModel.offlinePlaceholder(kept.job.text("landingSessionId").orEmpty(), kept.job),
                    now, kept.readAt, failed = true, kept.facts)
            }
            if (frozen != null) {
                LandingLine(LandingLineKind.RUNNING, if (frozen.rightIsClock) frozen.word else frozen.right, taskName,
                    if (frozen.rightIsClock) frozen.right else null, null, expanded, modifier, CARD_NAME_TAG,
                    titleTag = if (frozen.rightIsClock) "landing-head:title" else "landing-head:right", statusTag = "landing-head:right")
                Text(frozen.detail, Modifier.padding(start = LANDING_LINE_INDENT).testTag("landing-head:detail"),
                    style = MaterialTheme.typography.bodySmall, color = muted.copy(alpha = 0.7f))
                frozen.live?.let { Text(it, Modifier.padding(start = LANDING_LINE_INDENT).testTag("landing:live"),
                    style = MaterialTheme.typography.bodySmall, color = muted) }
            } else LandingLine(LandingLineKind.RUNNING, if (state.failed) LandingSessionCopy.UPDATE_UNAVAILABLE else LandingSessionCopy.LOADING_LANDING,
                taskName, null, null, expanded, modifier.testTag("landing:status-note"), CARD_NAME_TAG)
            return@Column
        }
        when {
            outcome != null -> LandingLine(if (outcome.ok) LandingLineKind.OK else LandingLineKind.QUIET, outcome.title, taskName,
                outcome.right, null, expanded, modifier, CARD_NAME_TAG, titleTag = "landing-head:title", statusTag = "landing-head:right",
                markTag = if (outcome.ok) "landing-head:done" else null)
            card == null -> LandingLine(LandingLineKind.RUNNING, LandingSessionCopy.QUEUED, taskName, null, null, expanded, modifier, CARD_NAME_TAG)
            // The old head's tags, on the parts that now say the same: the word (or, when its right slot holds a word, that word),
            // the clock, the failure's or the timeout's mark.
            else -> LandingLine(if (card.stoppedOnFailure || card.timedOut) LandingLineKind.FAILED else LandingLineKind.RUNNING,
                if (card.rightIsClock) card.word else card.right, name, if (card.rightIsClock) card.right else null, null, expanded, modifier,
                CARD_NAME_TAG, titleTag = if (card.rightIsClock) "landing-head:title" else "landing-head:right", statusTag = "landing-head:right",
                markTag = when {
                    card.timedOut -> "landing-head:timed-out"
                    card.stoppedOnFailure -> "landing-head:failed"
                    card.running -> "landing-ring:running"
                    else -> null
                })
        }
        Column(Modifier.fillMaxWidth().padding(start = LANDING_LINE_INDENT), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (outcome != null) {
                outcome.detail?.takeIf { it.isNotEmpty() }?.let { Text(it, Modifier.testTag("landing-head:detail"), style = MaterialTheme.typography.bodySmall, color = muted) }
                outcome.tasksHeading?.let { Text(it, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold) }
                outcome.tasks.forEach { title ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("•", color = muted)
                        Text(title, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                outcome.checkLine?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = success) }
                outcome.treeLine?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
            } else if (card != null) {
                card.detail.takeIf { it.isNotEmpty() }?.let {
                    Text(it, Modifier.testTag("landing-head:detail"), style = MaterialTheme.typography.bodySmall, color = muted.copy(alpha = 0.7f))
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
            // A landing that waits for a decision names who decides, then the doors to them: the coordinator first, then the task or
            // the round's card — on a quiet panel, as the chat's own waiting cards stand.
            if (waitDoors.isNotEmpty()) Column(Modifier.fillMaxWidth().background(muted.copy(alpha = 0.08f), RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp).testTag("landing:wait"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (LandingMenuAction.OPEN_COORDINATOR in waitDoors) Row(verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    Icon(painterResource(R.drawable.ic_person), null, Modifier.size(14.dp), tint = muted)
                    Text(LandingSessionCopy.DECISIONS_THE_COORDINATOR, Modifier.testTag("landing:wait-line"),
                        style = MaterialTheme.typography.bodySmall, color = muted)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    waitDoors.forEachIndexed { index, action ->
                        val label = when (action) {
                            LandingMenuAction.OPEN_COORDINATOR -> LandingSessionCopy.OPEN_COORDINATOR
                            LandingMenuAction.OPEN_TASK -> LandingSessionCopy.OPEN_TASK
                            else -> LandingSessionCopy.REVIEW_CARD
                        }
                        val tag = Modifier.testTag("landing:wait:${action.name.lowercase()}")
                        if (index == 0) Button(onClick = { onPress(action) }, modifier = tag) { Text(label) }
                        else OutlinedButton(onClick = { onPress(action) }, modifier = tag) { Text(label) }
                    }
                }
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

/** One attempt as the chat's tool rows (owner 2026-11-11, docs/mocks/landings-chat-tools-native): its heading only when there are several,
 *  then its lines gathered into steps (`LandingSteps`), each a tool row. A step opens to its own lines, the server's sentences as they
 *  were, a check's to its output too; a step that failed or runs now starts open. */
@Composable
private fun LandingTimelineSectionView(section: LandingSection, view: LandingView, now: Instant, zone: ZoneId,
    onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val current = section.jobId == view.currentAttempt?.jobId
    val attempt = view.currentAttempt
    val live = current && attempt?.state == "RUNNING" && !attempt.timedOut
    var openLog by remember(section.jobId) { mutableStateOf<LandingLogSelectors?>(null) }
    val steps = remember(section) { LandingSteps.steps(section.entries, section.kind) }
    Column(Modifier.fillMaxWidth().testTag("landing:section:${section.jobId}"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        if ((view.timeline?.sections?.size ?: 0) > 1) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(section.title, Modifier.testTag("landing:section-title:${section.jobId}"), style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold)
            LandingSessionModel.sectionState(section.state)?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = muted)
            }
        }
        val liveCheck = @Composable {
            val check = attempt?.check
            if (live && check != null) {
                val selector = LandingLogSelectors(attempt.jobId, attempt.claim, attempt.round, check.index)
                LandingLiveCheck(selector, "${LandingSessionModel.checkLabel(check.name)} · live " +
                    ProjectPage.landingClock(max(0.0, ProjectTime.between(ProjectTime.parse(check.startedAt) ?: now, now))), onLog)
            }
        }
        steps.forEachIndexed { index, step ->
            val last = index == steps.lastIndex
            val status = when {
                LandingSteps.failed(step, section.kind) -> StepStatus.FAILED
                last && live -> StepStatus.RUNNING
                last && current && attempt?.state == "QUEUED" -> StepStatus.PENDING
                else -> StepStatus.OK
            }
            key(step.key) {
                LandingStepRow(section, step, status) {
                    step.entries.forEach { (entryIndex, entry) ->
                        LandingEntryLine(section, entryIndex, entry, zone, openLog, { openLog = it }, onLog)
                    }
                    if (status == StepStatus.RUNNING) liveCheck()
                }
            }
        }
        // A check streaming before its attempt wrote any line has no step to sit in.
        if (steps.isEmpty()) liveCheck()
        if (current) LandingSessionModel.noReportBand(view, zone)?.let {
            Text(it, Modifier.fillMaxWidth().background(muted.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 6.dp)
                .testTag("landing:no-report"), style = MaterialTheme.typography.bodySmall, color = muted)
        }
    }
}

private enum class StepStatus { OK, FAILED, RUNNING, PENDING }

/** One step as the session chat's tool row on Android: the tone bar, the caret, its name in the mono face, its summary line and the
 *  word that says how it stands (`Complete`, `Failed`, `Running`), as the chat's own tool rows say it. No time on a phone's row; the
 *  lines it opens to carry theirs. */
@Composable
private fun LandingStepRow(section: LandingSection, step: LandingStep, status: StepStatus, content: @Composable ColumnScope.() -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    var pressed by remember(section.jobId, step.key) { mutableStateOf<Boolean?>(null) }
    val open = pressed ?: (status == StepStatus.FAILED || status == StepStatus.RUNNING)
    val tone = when (step.key) {
        "queue" -> muted
        "claim", "sync" -> Color(0xFF5E9BFF)
        "push" -> Color(0xFFFF9F0A)
        else -> Color(0xFF14B8A6)
    }
    val shape = RoundedCornerShape(if (open) 8.dp else 0.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(if (open) muted.copy(alpha = 0.06f) else Color.Transparent)
        .drawBehind { drawRect(tone, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height)) }
        .testTag(if (open) "landing:step-open:${step.key}" else "landing:step:${step.key}")) {
        Row(Modifier.fillMaxWidth().clickable(onClickLabel = step.name) { pressed = !open }
            .padding(start = 11.dp, end = 8.dp, top = 6.dp, bottom = 6.dp).testTag("landing:step-row:${step.key}"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp).rotate(if (open) 90f else 0f), tint = muted.copy(alpha = 0.6f))
            Text(step.name, Modifier.testTag("landing:step-name"), style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                fontWeight = FontWeight.SemiBold, maxLines = 1, softWrap = false)
            Text(step.summary.text, Modifier.weight(1f).testTag("landing:step-summary"), style = MaterialTheme.typography.bodyMedium, color = muted,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(when (status) {
                StepStatus.FAILED -> LandingStepWords.FAILED
                StepStatus.RUNNING -> LandingStepWords.RUNNING
                StepStatus.PENDING -> LandingStepWords.QUEUED
                StepStatus.OK -> LandingStepWords.COMPLETE
            }, Modifier.testTag("landing:step-status"), style = MaterialTheme.typography.bodySmall,
                color = if (status == StepStatus.FAILED) MaterialTheme.colorScheme.error else muted, maxLines = 1, softWrap = false)
        }
        if (open) Column(Modifier.fillMaxWidth().padding(start = 28.dp, end = 8.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp),
            content = content)
    }
}

/** The status words the chat's own tool rows end in on Android (`TranscriptRowView`). */
internal object LandingStepWords {
    const val COMPLETE = "Complete"
    const val FAILED = "Failed"
    const val RUNNING = "Running"
    const val QUEUED = "Queued"
}

/** One of the server's lines, as it was: its time, its mark and its sentence; a finished check's `Log ›` and, when it failed, the tail
 *  it died on (05 g). */
@Composable
private fun LandingEntryLine(section: LandingSection, index: Int, entry: LandingEntry, zone: ZoneId, openLog: LandingLogSelectors?,
    setOpenLog: (LandingLogSelectors?) -> Unit, onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
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
                TextButton(onClick = { setOpenLog(if (openLog == selectors) null else selectors) },
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

/** The check running now: its last few printed lines, polled with the page while it runs — no event announces them (§2.9 LS6) — and
 * only while the Activity is started. */
@Composable
private fun LandingLiveCheck(selectors: LandingLogSelectors, title: String, onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    var text by remember(selectors) { mutableStateOf("") }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(selectors, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                onLog(selectors, null)?.let { page -> text = LandingSessionModel.tail(page.entries.joinToString("") { it.text }) }
                delay(4_000)
            }
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
