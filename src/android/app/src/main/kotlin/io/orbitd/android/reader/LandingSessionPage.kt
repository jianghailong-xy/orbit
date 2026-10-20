package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
import io.orbitd.android.core.cards.objects
import io.orbitd.android.core.cards.text
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.ProjectMergeModel
import io.orbitd.android.directory.ProjectMergeReviewSheet
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.projects.LandingHead
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.ProjectLandingHead
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.projects.failureReason
import io.orbitd.android.taskprojects.canWrite
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.wiki.PageBar
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlinx.serialization.json.JsonObject

// The landing session page (contract §2.9 LS1, LS6, LS7; design §3; mockups v4 05 and 07): a session the platform drives,
// drawn as its own reader — the status card over the newest attempt, the server's timeline, the check output a line opens,
// and the owner doors the landing view's facts allow. A reading surface, not a conversation: no composer, no engine, no
// model, no rename, fork, share or merge bar, and no session events (the page polls §2.7a's cadence instead). Every word and
// every door condition is LandingSessionModel's, tested on the JVM; this file only lays them out and presses them.

/**
 * `Destination.SESSION`'s two renderers, chosen by the DETAIL's `sessionKind` (LS6): a landing gets the landing page and
 * never the reader — its own poll, no composer, no session menu and no `sessions/:id/events` subscription — and a
 * conversation gets the reader as it always did. A session the directory does not list is asked for once (a landing link
 * reaches its subject before the session row exists, and a flat list never carries a landing), so the answer is the
 * server's, never a guess from an id.
 */
@Composable
fun SessionDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, api: DirectoryApi, data: DirectoryData,
    open: (OrbitRoute) -> Unit, leave: () -> Unit = {}) {
    val id = route.id ?: return
    val listed = remember(data.sessions, id) { data.sessions.values.any { rows -> rows.any { ObjectId.same(it.id, id) } } }
    var landing by remember(id) { mutableStateOf<Boolean?>(if (listed) false else null) }
    LaunchedEffect(id, listed) {
        if (listed) { landing = false; return@LaunchedEffect }
        if (landing != null) return@LaunchedEffect
        landing = try { LandingSessionModel.isLanding(api.objectRead(listOf("sessions", id))) }
        catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { false }
    }
    when (landing) {
        null -> Box(Modifier.fillMaxSize().testTag("session-opening"), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        true -> LandingSessionPage(app, handle, route, api, open)
        false -> SessionReader(app, handle, route, api, data, open, leave)
    }
}

/** What the page holds between reads: the session detail and its landing view, when this device last got an answer, the
 *  project facts the head and the gates take (V6's step start and usual duration, the main branch, the coordinator and the
 *  round's candidate), and a refusal the server wrote for the last press. */
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

@Composable
internal fun LandingSessionPage(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, api: DirectoryApi,
    open: (OrbitRoute) -> Unit) {
    val id = route.id ?: return
    val projects = remember(handle) { ProjectApi(app.session, handle) { app.canWrite(handle) } }
    var state by remember(id) { mutableStateOf(LandingSessionRead()) }
    var now by remember(id) { mutableStateOf(Instant.now()) }
    var menuExpanded by remember(id) { mutableStateOf(false) }
    var reviewPromotion by remember(id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val zone = remember { ZoneId.systemDefault() }

    suspend fun readOnce() = LandingSessionReads.read(api, projects, id, state) { state = it }

    LaunchedEffect(id) {
        while (isActive) {
            LandingSessionReads.read(api, projects, id, state) { state = it }
            val next = LandingSessionModel.nextReadMs(state.view) ?: break
            delay(next)
        }
    }
    // The head's clock, the freshness and the quiet meter move with the local clock between reads.
    LaunchedEffect(id) { while (isActive) { delay(1_000); now = Instant.now() } }

    val view = state.view
    val gates = view?.let { LandingSessionModel.gates(it, now, state.updatedAt, state.failed) } ?: LandingGates()
    val attempt = view?.currentAttempt
    val nothingPushed = attempt != null && (attempt.kind == "CHECK_PROMOTION" ||
        (attempt.timedOut && view?.let { LandingSessionModel.pushSentence(it, attempt) } == LandingSessionCopy.NOTHING_PUSHED_SENTENCE))
    val items = view?.let {
        LandingSessionModel.menuItems(it, gates, state.coordinatorId != null, state.currentPromotion() != null, nothingPushed)
    }.orEmpty()

    // The press reads the page's live state, never a composition's snapshot: the bar keeps the one lambda it was first given
    // (Compose skips re-binding an unchanged call), and an action must still act on what the page now shows.
    fun press(action: LandingMenuAction) {
        val landing = state.view ?: return
        val attempt = landing.currentAttempt
        when (action) {
            LandingMenuAction.OPEN_TASK -> landing.taskId?.let { open(OrbitRoute(Destination.TASK, it, origin = Origin.LINK)) }
            LandingMenuAction.OPEN_SOURCE_SESSION -> attempt?.sourceSessionId?.let { open(OrbitRoute(Destination.SESSION, it, origin = Origin.LINK)) }
            LandingMenuAction.OPEN_COORDINATOR -> state.coordinatorId?.let { open(OrbitRoute(Destination.SESSION, it, origin = Origin.LINK)) }
            LandingMenuAction.REVIEW_CARD -> landing.promotionId?.let { reviewPromotion = it }
            else -> scope.launch {
                if (state.acting) return@launch
                state = state.copy(acting = true)
                var refusal: String? = null
                try {
                    when (action) {
                        LandingMenuAction.STOP -> landing.taskId?.let { projects.stopTaskIntegration(landing.projectId, it) }
                        LandingMenuAction.CANCEL -> landing.promotionId?.let { projects.cancelPromotion(landing.projectId, it) }
                        LandingMenuAction.ABANDON -> attempt?.jobId?.let { projects.abandonJob(landing.projectId, it) }
                        LandingMenuAction.RETRY -> attempt?.jobId?.let { projects.retryJob(landing.projectId, it) }
                        LandingMenuAction.RERUN_THE_CHECK -> landing.promotionId?.let { projects.recheckPromotion(landing.projectId, it) }
                        else -> Unit
                    }
                } catch (cancel: CancellationException) { throw cancel }
                catch (failure: Exception) {
                    val label = when (action) {
                        LandingMenuAction.STOP -> LandingSessionCopy.STOP_FAILED
                        LandingMenuAction.CANCEL -> LandingSessionCopy.CANCEL_FAILED
                        LandingMenuAction.ABANDON -> LandingSessionCopy.ABANDON_FAILED
                        LandingMenuAction.RETRY -> LandingSessionCopy.RETRY_FAILED
                        else -> LandingSessionCopy.RERUN_FAILED
                    }
                    refusal = "$label — ${failureReason(failure).trimEnd('.')}."
                }
                state = state.copy(acting = false, refusal = refusal)
                readOnce()
            }
        }
    }

    // The bar keeps the first lambda it is handed (the call is skipped once its parameters compare equal), so what changes
    // lives behind a state the lambda reads when it draws: the rows, and the press reading the page's live state above.
    val barItems = remember(id) { mutableStateOf(emptyList<LandingMenuItem>()) }
    SideEffect { barItems.value = items }
    PageBar.Bind(route, null) {
        LandingSessionMenu(barItems.value, menuExpanded, { menuExpanded = it }, ::press)
    }
    val merge = remember(handle, view?.projectId) {
        view?.projectId?.takeIf { it.isNotEmpty() }?.let { ProjectMergeModel(projects, it) }
    }
    LandingSessionContent(state, now, zone, ::press,
        onReview = { view?.promotionId?.let { reviewPromotion = it; merge?.let { model -> scope.launch { model.load(force = true) } } } },
        onOpenCoordinator = { state.coordinatorId?.let { open(OrbitRoute(Destination.SESSION, it, origin = Origin.LINK)) } },
        onLog = { selectors, cursor -> LandingSessionReads.log(api, id, selectors, cursor) })
    LaunchedEffect(merge, state.promotion?.text("promotionId"), state.mergedPromotions.size) {
        // The review sheet reads the candidate and its open items from this model; it is filled as soon as the round has one.
        if (merge != null && state.currentPromotion() != null) merge.load(force = true)
    }
    reviewPromotion?.let { promotionId ->
        merge?.let { ProjectMergeReviewSheet(it, promotionId, null) { reviewPromotion = null } }
    }
}

/** The reads a landing page makes each round: its own detail, then the project facts beside it (iOS `refresh`). */
internal object LandingSessionReads {
    private suspend fun <T> attempt(read: suspend () -> T): T? =
        try { read() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }

    suspend fun read(api: DirectoryApi, projects: ProjectApi, id: String, state: LandingSessionRead,
        publish: (LandingSessionRead) -> Unit) {
        val readAt = Instant.now()
        val detail = attempt { api.objectRead(listOf("sessions", id)) }
        var next = if (detail != null) state.copy(view = LandingSessionModel.view(detail) ?: state.view,
            rowTitle = detail.text("title") ?: state.rowTitle, updatedAt = readAt, failed = false)
        else state.copy(failed = true)
        publish(next)
        val landing = next.view ?: return
        if (landing.projectId.isEmpty()) return
        if (landing.settledAt == null) {
            attempt { projects.integration(landing.projectId) }?.let { next = next.copy(integration = it) }
            attempt { projects.coordinator(landing.projectId) }?.let { next = next.copy(coordinator = it) }
            if (landing.subject == "PROMOTION") attempt { projects.currentPromotion(landing.projectId) }?.let { next = next.copy(promotion = it) }
        } else if (landing.subject == "PROMOTION") {
            attempt { projects.mergedPromotions(landing.projectId) }?.let { next = next.copy(mergedPromotions = it) }
        }
        if (landing.subject == "TASK" && next.taskTitle == null && !landing.taskId.isNullOrEmpty()) {
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

/** The page's ⋯ in the bar: the ways to look at this work, then the doors (design §3, LS6). No Copy Link. */
@Composable
private fun LandingSessionMenu(items: List<LandingMenuItem>, expanded: Boolean, onExpanded: (Boolean) -> Unit,
    onPress: (LandingMenuAction) -> Unit) {
    if (items.isEmpty()) return
    Box {
        IconButton(onClick = { onExpanded(true) }, modifier = Modifier.testTag("landing-more")) {
            Icon(painterResource(R.drawable.ic_more), "Landing actions")
        }
        DropdownMenu(expanded, { onExpanded(false) }, Modifier.testTag("landing-menu")) {
            items.forEachIndexed { index, item ->
                if (item.danger && index > 0 && !items[index - 1].danger) HorizontalDivider()
                DropdownMenuItem(text = {
                    Column {
                        Text(item.label, color = if (item.danger) MaterialTheme.colorScheme.error else Color.Unspecified)
                        item.sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }, onClick = { onExpanded(false); onPress(item.action) }, modifier = Modifier.testTag("landing-menu:${item.key}"))
            }
        }
    }
}

/**
 * The page as drawn: the title and the read-only footer, the status card over the newest attempt, the server's timeline,
 * and the refusal a press came back with. Each state is written to a PNG by LandingSessionViewTest.
 */
@Composable
internal fun LandingSessionContent(state: LandingSessionRead, now: Instant, zone: ZoneId = ZoneId.systemDefault(),
    onPress: (LandingMenuAction) -> Unit = {}, onReview: () -> Unit = {}, onOpenCoordinator: () -> Unit = {},
    onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage? = { _, _ -> null }) {
    val view = state.view
    val card = view?.let { LandingSessionModel.attemptCard(it, now, state.updatedAt, state.failed, state.facts(), zone) }
    val outcome = view?.let { LandingSessionModel.outcomeCard(it, state.currentPromotion(), zone) }
    val footer = view?.let { LandingSessionModel.footer(it, state.currentPromotion()?.text("onPass")) }
    Column(Modifier.fillMaxSize().testTag("landing-page")) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("landing-page-list"), contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item(key = "head") {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(LandingSessionModel.headerTitle(view, state.rowTitle, state.taskTitle), Modifier.weight(1f).testTag("landing:title"),
                            style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(LandingSessionCopy.CHIP, Modifier.background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.12f), CircleShape)
                            .padding(horizontal = 8.dp, vertical = 2.dp).testTag("landing:chip"), style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(LandingSessionModel.headerSub(view, zone), Modifier.testTag("landing:sub"), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            item(key = "card") { LandingStatusCard(state, view, card, outcome, now, onPress) }
            state.refusal?.let { refusal ->
                item(key = "refusal") {
                    Text(refusal, Modifier.testTag("landing:refusal"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            }
            if (view != null) {
                val timeline = view.timeline
                timeline?.facts?.filter { it.kind != "PROMOTION_STATE" }?.forEachIndexed { index, fact ->
                    item(key = "fact:$index") { Text(fact.text, Modifier.testTag("landing:fact:$index"), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                timeline?.sections?.forEach { section ->
                    item(key = "section:${section.jobId}") {
                        LandingTimelineSectionView(section, view, now, zone, onLog)
                    }
                }
                if (timeline?.truncated == true) item(key = "truncated") {
                    Text(LandingSessionCopy.OLDER_ATTEMPTS_HIDDEN, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        footer?.let { LandingFooterView(it, state.coordinatorId, state.currentPromotion() != null, onReview, onOpenCoordinator) }
    }
}

@Composable
private fun LandingStatusCard(state: LandingSessionRead, view: LandingView?, card: LandingAttemptCard?, outcome: LandingOutcomeCard?,
    now: Instant, onPress: (LandingMenuAction) -> Unit) {
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
    Column(Modifier.fillMaxWidth().background(wash, shape).border(1.dp, stroke, shape).padding(12.dp).testTag("landing-status-card"),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (view == null) {
            val text = if (state.failed) LandingSessionCopy.UPDATE_UNAVAILABLE else LandingSessionCopy.LOADING_LANDING
            Text(text, Modifier.testTag("landing:status-note"), style = MaterialTheme.typography.bodyMedium, color = muted)
            return@Column
        }
        if (outcome != null) {
            ProjectLandingHead(outcome.title, LandingHead(outcome.right, false, outcome.detail.orEmpty()), running = false, timedOut = false)
            outcome.tasksHeading?.let { Text(it, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold) }
            outcome.tasks.forEach { title ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("•", color = muted)
                    Text(title, style = MaterialTheme.typography.bodyMedium)
                }
            }
            outcome.checkLine?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = success) }
            outcome.treeLine?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
            return@Column
        }
        if (card == null) {
            Text(LandingSessionCopy.QUEUED, style = MaterialTheme.typography.bodyMedium, color = muted)
            return@Column
        }
        // The head's one line is the card's on a narrow landing row; this page has room for the claim, the round and a
        // takeover's first start in full (mockups v4 05 h–j).
        ProjectLandingHead(card.word, LandingHead(card.right, card.rightIsClock, card.detail), card.running, card.timedOut, detailLines = 3)
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
                if (gates.abandon) OutlinedButton(onClick = { onPress(LandingMenuAction.ABANDON) }, enabled = !state.acting,
                    modifier = Modifier.testTag("landing:abandon"), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                    Text(LandingSessionCopy.ABANDON)
                }
            }
            doorHint(gates, push, attempt)?.let {
                Text(it, Modifier.testTag("landing:door-hint"), style = MaterialTheme.typography.bodySmall, color = muted)
            }
        }
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
                    val mark = landingMark(entry, section.entries, index)
                    Text(mark.first, Modifier.width(16.dp), style = MaterialTheme.typography.bodySmall, color = mark.second)
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
                    selectors != null && !entry.text.contains("passed") -> LandingLogBlock(selectors, onLog)
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
private fun landingMark(entry: LandingEntry, entries: List<LandingEntry>, index: Int): Pair<String, Color> = when (entry.kind) {
    "TAKEN_OVER" -> "↗" to Color(0xFF0066BE)
    "CHECK_FINISHED", "RESULT", "RESULT_FALLBACK" -> {
        val ok = entry.text.contains("passed") || listOf("Landed", "Already", "Nothing to push", "Merged").any { entry.text.startsWith(it) }
        if (ok) "✓" to Color(0xFF247344) else "✗" to Color(0xFFB3261E)
    }
    "STOP_REQUESTED", "CANCELLED", "ABANDONED", "TIMED_OUT", "PUSH_REFUSED" -> "✗" to Color(0xFFB3261E)
    "ENQUEUED", "REQUEUED", "NEXT_GENERATION", "SKIPPED_CHECK", "FIX_TASK" -> "≡" to Color.Unspecified
    "RELEASED" -> "↩" to Color.Unspecified
    "STEP" -> {
        val later = entries.drop(index + 1).any { it.kind in setOf("STEP", "CHECK_STARTED", "TAKEN_OVER", "RESULT", "CHECK_FINISHED", "CANCELLED", "TIMED_OUT") }
        if (later) "✓" to Color(0xFF247344) else "↻" to Color(0xFF0066BE)
    }
    else -> "↻" to Color(0xFF0066BE)
}

/** One finished check's tail, loaded once and shown dark; the block a failed check dies on (mockup 05 g). */
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
            onLog(selectors, null)?.let { page -> text = tail(page.entries.joinToString("") { it.text }) }
            delay(4_000)
        }
    }
    Column(Modifier.padding(start = 24.dp).testTag("landing:live-check"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (text.isNotEmpty()) LandingDarkOutput(text)
    }
}

private fun tail(text: String): String = text.replace("\r", "").split("\n").filter { it.isNotBlank() }.takeLast(6).joinToString("\n")

@Composable
private fun LandingLogBody(page: LandingLogPage?, failed: Boolean, loading: Boolean, more: (String) -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.padding(start = 24.dp).fillMaxWidth().background(Color.Black.copy(alpha = 0.04f), RoundedCornerShape(8.dp)).padding(8.dp)
        .testTag("landing:log-block"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when {
            failed -> Text("${LandingSessionCopy.LOG_UNAVAILABLE}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            page == null -> Text(LandingSessionCopy.LOADING_LOG, style = MaterialTheme.typography.bodySmall, color = muted)
            page.entries.isEmpty() -> Text(LandingSessionCopy.LOG_EMPTY, style = MaterialTheme.typography.bodySmall, color = muted)
            else -> page.entries.forEach { entry ->
                if (entry.truncatedBytes > 0) Text(LandingSessionCopy.bytesOmitted(entry.truncatedBytes), style = MaterialTheme.typography.bodySmall, color = muted)
                Text(entry.text, Modifier.testTag("landing:log-text"), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = Color(0xFF1A1A1A))
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

/** The read-only footer (LS6): what this page is, who decides, and the way to them. */
@Composable
private fun LandingFooterView(footer: LandingFooter, coordinatorId: String?, hasReview: Boolean, onReview: () -> Unit,
    onOpenCoordinator: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)).padding(horizontal = 16.dp, vertical = 8.dp)
        .testTag("landing:footer"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(footer.line, Modifier.testTag("landing:footer-line"), style = MaterialTheme.typography.bodySmall, color = muted)
        Row(verticalAlignment = Alignment.CenterVertically) {
            footer.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, color = muted) }
            when {
                footer.link == LandingFooterLink.COORDINATOR && coordinatorId != null ->
                    TextButton(onClick = onOpenCoordinator, modifier = Modifier.heightIn(min = 0.dp).testTag("landing:open-coordinator")) {
                        Text("${LandingSessionCopy.OPEN_COORDINATOR} ›", style = MaterialTheme.typography.bodySmall)
                    }
                footer.link == LandingFooterLink.REVIEW_CARD && hasReview ->
                    TextButton(onClick = onReview, modifier = Modifier.heightIn(min = 0.dp).testTag("landing:open-review")) {
                        Text("${LandingSessionCopy.REVIEW_CARD} ›", style = MaterialTheme.typography.bodySmall)
                    }
            }
        }
        footer.next?.let { Text(it, Modifier.testTag("landing:footer-next"), style = MaterialTheme.typography.bodySmall, color = muted) }
    }
}
