package io.orbitd.android.reader

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.cards.PromotionReceiptSheet
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.LandingsWindow
import io.orbitd.android.directory.LandingsWindowCard
import io.orbitd.android.directory.LandingsWindowRow
import io.orbitd.android.directory.LandingsWindowTone
import io.orbitd.android.directory.ProjectMergeModel
import io.orbitd.android.directory.ProjectMergeReviewSheet
import io.orbitd.android.directory.SessionLandingSummary
import io.orbitd.android.directory.SessionLandingsCopy
import io.orbitd.android.directory.SessionProjectCopy
import io.orbitd.android.directory.SessionProjectLandings
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.failureReason
import io.orbitd.android.taskprojects.canWrite
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.wiki.PageBar
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject

// A project's Landings window (owner 2026-10-27, docs/mocks/landings-one-window; contract §2.9 LS6 and §3.6, revision 28; web
// `ProjectLandingsWindow.tsx`): every landing the project has had, read like a conversation — the settled ones by day, oldest at the
// top, and the ones still in hand under `Now` at the bottom, where the window opens. A landing session id opens this window on its
// landing: scrolled to, opened and outlined for a moment.

/** How long a landing the window was opened on stays outlined (board 03 f). */
private const val FOCUS_OUTLINE_MS = 1_500L
/** How often the two lists are read again while the window shows (the web's 15 s), and the merges into main (its 60 s). */
private const val LISTS_READ_MS = 15_000L
private const val MERGES_READ_MS = 60_000L

/** What the window holds between reads — all of it the window's own, so a card or a row scrolled away keeps its read and its place. */
@Stable
internal class LandingsWindowState(focus: JsonObject?) {
    /** The project's LANDING rows, from both lists (`includeLanding=1`). */
    var rows by mutableStateOf<List<DirectorySession>>(emptyList())
    /** Its merges into main (`promotions/merged`). */
    var merged by mutableStateOf<List<JsonObject>>(emptyList())
    /** Both lists have answered once; the last read of them failed. */
    var listed by mutableStateOf(false)
    var listFailed by mutableStateOf(false)
    /** The merges into main have been read once, answered or not: the window is placed only after, so their rows never arrive
     *  above the place it stood on. */
    var mergesRead by mutableStateOf(false)
    var projectTitle by mutableStateOf<String?>(null)
    var coordinator by mutableStateOf<JsonObject?>(null)
    /** The detail of the landing the window was opened on, and whether reading it failed. */
    var focus by mutableStateOf(focus)
    var focusFailed by mutableStateOf(false)
    /** Each card's read, polled on §2.7a's cadence; each settled row's, read once when it is opened or long-pressed. */
    val cards = mutableStateMapOf<String, LandingSessionRead>()
    val records = mutableStateMapOf<String, LandingSessionRead>()
    /** The entries open in place, the one outlined for a moment, and the one whose menu is up. */
    val expanded = mutableStateListOf<String>()
    var outlined by mutableStateOf<String?>(null)
    var placed by mutableStateOf(false)
    var menu by mutableStateOf<String?>(null)

    /** The coordinator conversation that decides the project's landings, when it has a live one to open. */
    val coordinatorId: String? get() = coordinator?.obj("coordination")?.obj("session")?.text("id")?.takeIf { it.isNotEmpty() }
}

/** One item of the window's list: a day's heading, a settled landing, `Now`'s heading or a landing in hand, or the note a window says
 *  before its lists have answered. [landingId] is the landing an item is, for the focus to find. */
private sealed interface WindowItem {
    val key: String
    val landingId: String? get() = null

    data class Note(val failed: Boolean) : WindowItem { override val key get() = "note" }
    data class Day(val title: String, val now: Boolean = false) : WindowItem { override val key get() = if (now) "now" else "day:$title" }
    data class Settled(val row: LandingsWindowRow) : WindowItem {
        override val key get() = "row:${row.key}"
        override val landingId get() = row.id
    }
    data class InHand(val card: LandingsWindowCard) : WindowItem {
        override val key get() = "card:${card.sessionId}"
        override val landingId get() = card.sessionId
    }
}

private fun windowItems(window: LandingsWindow, listed: Boolean, listFailed: Boolean): List<WindowItem> = buildList {
    if (!listed) add(WindowItem.Note(listFailed))
    window.days.forEach { day ->
        add(WindowItem.Day(day.title))
        day.rows.forEach { add(WindowItem.Settled(it)) }
    }
    if (window.now.isNotEmpty()) {
        add(WindowItem.Day(SessionLandingsCopy.now, now = true))
        window.now.forEach { add(WindowItem.InHand(it)) }
    }
}

/**
 * A project's Landings window: the old landing session page's shell — `Landings`, `Run by Orbit · <project>`, a ⋯ with the coordinator
 * and the project, the read-only footer and no composer (LS6) — over every landing the project has had. Each landing carries what that
 * page drew: a card still in hand is its status card, polled on §2.7a's cadence (the one part of the window that polls a landing); a
 * settled row opens in place to its record, read once and never polled; a merge into main opens to its receipt first. The doors the
 * page's ⋯ held are each landing's own: a long-press on it.
 *
 * Nothing here is a new read: the two the project's sessions page already makes (its LANDING rows, open and completed, and its merges
 * into main), the coordinator's status, and each landing's own view when it is drawn as a card or opened. [focusId] is the landing the
 * window was opened on, and [focusDetail] its detail when the opener has read it already.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun ProjectLandingsWindow(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, api: DirectoryApi, projectId: String,
    focusId: String?, open: (OrbitRoute) -> Unit, focusDetail: JsonObject? = null) {
    val projects = remember(handle) { ProjectApi(app.session, handle) { app.canWrite(handle) } }
    val state = remember(handle, projectId, focusId) { LandingsWindowState(focusDetail) }
    val scope = rememberCoroutineScope()
    val zone = remember { ZoneId.systemDefault() }
    val list = rememberLazyListState()
    var now by remember { mutableStateOf(Instant.now()) }
    var barMenu by remember { mutableStateOf(false) }
    // A round still in hand opens its candidate's review; a merged one its receipt.
    var review by remember(projectId) { mutableStateOf<String?>(null) }
    var receipt by remember(projectId) { mutableStateOf<JsonObject?>(null) }
    val merge = remember(handle, projectId) { ProjectMergeModel(projects, projectId) }
    val reading = remember(state) { mutableSetOf<String>() }

    suspend fun <T> attempt(read: suspend () -> T): T? =
        try { read() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
    suspend fun readLists() {
        suspend fun read(view: String) = api.read(listOf("sessions"), ListSerializer(DirectorySession.serializer()),
            listOf("view" to view, "projectId" to projectId, "includeLanding" to "1"))
        try {
            val (openRows, completedRows) = coroutineScope {
                val openRead = async { read("open") }; val completedRead = async { read("completed") }
                openRead.await() to completedRead.await()
            }
            // A landing that moved from Open to Completed between the two reads is the Completed read's.
            state.rows = (completedRows + openRows).filter { row ->
                row.isLanding && row.landing != null && row.projectMembership?.projectId?.let { ObjectId.same(it, projectId) } != false
            }.distinctBy { ObjectId.canonical(it.id) ?: it.id }
            (openRows + completedRows).firstNotNullOfOrNull { it.projectMembership?.projectTitle?.takeIf(String::isNotEmpty) }
                ?.let { state.projectTitle = it }
            state.listed = true; state.listFailed = false
        } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { state.listFailed = true }
        attempt { projects.coordinator(projectId) }?.let { state.coordinator = it }
        if (state.projectTitle == null) attempt { projects.document(projectId) }?.text("title")?.takeIf { it.isNotEmpty() }?.let { state.projectTitle = it }
    }
    suspend fun readMerged() {
        attempt { projects.mergedPromotions(projectId) }?.let { state.merged = it }
        state.mergesRead = true
    }
    /** A card whose read says it settled moves into its day: the lists and the merges are read again at once. */
    fun settled() { scope.launch { coroutineScope { launch { readLists() }; launch { readMerged() } } } }

    LaunchedEffect(state) {
        if (focusId != null && state.focus == null) launch {
            val detail = attempt { api.objectRead(listOf("sessions", focusId)) }
            if (detail != null) state.focus = detail else state.focusFailed = true
        }
        launch { while (true) { readLists(); delay(LISTS_READ_MS) } }
        launch { while (true) { readMerged(); delay(MERGES_READ_MS) } }
        launch { while (true) { delay(1_000); now = Instant.now() } }
    }

    // The landing the window was opened on, when no list carries it: a landing whose row is not inserted yet (LS1's pre-generated id),
    // its subject read off its own view — or, when this device cannot read that view, the job an integration read last described,
    // drawn frozen as a card.
    val focusRow: DirectorySession? = focusId?.takeIf { id -> state.rows.none { ObjectId.same(it.id, id) } }?.let { id ->
        val card = state.cards[id]
        val view = card?.view ?: state.focus?.let(LandingSessionModel::view)
        if (view != null) {
            if (view.projectId.isNotEmpty() && !ObjectId.same(view.projectId, projectId)) null
            else DirectorySession(id, title = card?.rowTitle ?: state.focus?.text("title")
                ?: LandingSessionModel.headerTitle(view, null, card?.taskTitle), createdAt = view.openedAt, sessionKind = "LANDING",
                landing = SessionLandingSummary(view.subject, if (view.settledAt != null) "SETTLED" else "IN_FLIGHT", view.settledAs, view.settledAt))
        } else if (state.focusFailed) app.landingJobs.snapshot(handle, id)?.let { kept ->
            DirectorySession(id, title = kept.job.text("taskTitle")?.let { "${LandingSessionCopy.LAND} · $it" }, createdAt = kept.job.text("startedAt"),
                sessionKind = "LANDING", landing = SessionLandingSummary(if (kept.job.text("taskId").isNullOrEmpty()) "PROMOTION" else "TASK", "IN_FLIGHT"))
        } else null
    }
    val rows = state.rows + listOfNotNull(focusRow)
    // The day sections move with the calendar, not the second: the window is read again each minute, the cards' clocks every second.
    val minute = now.epochSecond / 60
    val window = remember(rows, state.merged, minute) { SessionProjectLandings.window(rows, state.merged, now, zone) }
    val entries = windowItems(window, state.listed, state.listFailed)

    // Only cards poll: each one's own view, on the landing page's cadence (RUNNING 4 s, QUEUED 15 s, nothing once settled).
    val cardIds = window.now.map { it.sessionId }
    LaunchedEffect(cardIds) {
        for (id in cardIds) launch {
            while (true) {
                LandingSessionReads.read(api, projects, id, state.cards[id] ?: LandingSessionRead(), app.landingJobs, handle) { read ->
                    // A read carries the card as it was when it left: one that left before a press, or while one was out, must neither
                    // let the doors up under it nor hold them down after it.
                    state.cards[id] = read.copy(acting = state.cards[id]?.acting ?: false)
                }
                val view = state.cards[id]?.view
                if (view?.settledAt != null) { settled(); break }
                delay(LandingSessionModel.nextReadMs(view) ?: break)
            }
        }
    }

    /** A settled landing's record: read once — or already read, as a card, or as the landing the window was opened on. */
    fun recordOf(id: String): LandingSessionRead? = state.records[id] ?: state.cards[id]?.takeIf { it.view != null }
        ?: state.focus?.takeIf { focusId != null && ObjectId.same(id, focusId) }?.let { detail ->
            LandingSessionModel.view(detail)?.let { LandingSessionRead(view = it, rowTitle = detail.text("title")) }
        }
    fun readRecord(id: String) {
        if (recordOf(id)?.view != null || !reading.add(id)) return
        scope.launch {
            try {
                val detail = attempt { api.objectRead(listOf("sessions", id)) }
                state.records[id] = if (detail != null) LandingSessionRead(view = LandingSessionModel.view(detail), rowTitle = detail.text("title"),
                    updatedAt = Instant.now()) else LandingSessionRead(failed = true)
            } finally { reading.remove(id) }
        }
    }
    fun toggle(id: String) { if (id in state.expanded) state.expanded.remove(id) else state.expanded.add(id) }

    // Placed once, after the lists, the merges into main and the cards have answered — and the landing it was opened on, its record —
    // so everything above and below the place it stands is drawn at its height: at the bottom like a conversation, or on that landing:
    // opened first, then scrolled to, so what opening adds is under it and not over it, and outlined for a moment.
    val cardsRead = cardIds.all { id -> state.cards[id]?.let { it.view != null || it.failed } == true }
    val focusRead = focusId == null || state.focus != null || state.focusFailed
    val placeable = (state.listed || state.listFailed) && state.mergesRead && cardsRead && focusRead
    LaunchedEffect(placeable, entries) {
        if (state.placed || !placeable) return@LaunchedEffect
        if (focusId != null) {
            val index = entries.indexOfFirst { item -> item.landingId?.let { ObjectId.same(it, focusId) } == true }
            if (index < 0) return@LaunchedEffect
            val id = entries[index].landingId!!
            state.placed = true
            if (id !in state.expanded) state.expanded.add(id)
            list.scrollToItem(index)
            state.outlined = id
        } else if (entries.isNotEmpty()) {
            state.placed = true
            list.scrollToItem(entries.lastIndex)
        }
    }
    LaunchedEffect(state.outlined) { if (state.outlined != null) { delay(FOCUS_OUTLINE_MS); state.outlined = null } }

    /** A door on a card in hand (design §3, LS6): the press reads the card's live state, never a composition's snapshot, and the doors
     *  stay down until the card has read the press back — pressed before then, a door goes out over the claim this press has just moved
     *  on, and the server refuses it (A15 F-22's kind). A refusal comes back in the server's own words. */
    fun press(id: String, action: LandingMenuAction) {
        val landing = state.cards[id]?.view ?: return
        val attempt = landing.currentAttempt
        scope.launch {
            if (state.cards[id]?.acting == true) return@launch
            state.cards[id]?.let { state.cards[id] = it.copy(acting = true) }
            var refusal: String? = null
            try {
                when (action) {
                    LandingMenuAction.STOP -> landing.taskId?.let { projects.stopTaskIntegration(landing.projectId, it) }
                    LandingMenuAction.CANCEL -> landing.promotionId?.let { projects.cancelPromotion(landing.projectId, it) }
                    LandingMenuAction.ABANDON -> attempt?.jobId?.let { projects.abandonJob(landing.projectId, it) }
                    LandingMenuAction.RETRY -> attempt?.jobId?.let { projects.retryJob(landing.projectId, it) }
                    LandingMenuAction.RERUN_THE_CHECK -> landing.promotionId?.let {
                        projects.recheckPromotion(landing.projectId, it, LandingSessionCopy.RERUN_LANDING_CHECK_REASON)
                    }
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
            state.cards[id]?.let { state.cards[id] = it.copy(refusal = refusal) }
            try {
                LandingSessionReads.read(api, projects, id, state.cards[id] ?: LandingSessionRead(), app.landingJobs, handle) { read ->
                    state.cards[id] = read.copy(acting = state.cards[id]?.acting ?: false)
                }
            } finally { state.cards[id]?.let { state.cards[id] = it.copy(acting = false) } }
        }
    }
    /** What a menu row or a door does: the ways to look at a landing's work navigate; Review card opens the round's card — its live
     *  candidate while the round is in hand, its receipt once it merged; the owner doors press. */
    fun act(id: String, view: LandingView?, coordinator: String?, promotion: JsonObject?, action: LandingMenuAction) {
        when (action) {
            LandingMenuAction.OPEN_TASK -> view?.taskId?.let { open(OrbitRoute(Destination.TASK, it, origin = Origin.LINK)) }
            LandingMenuAction.OPEN_SOURCE_SESSION -> view?.currentAttempt?.sourceSessionId?.let { open(OrbitRoute(Destination.SESSION, it, origin = Origin.LINK)) }
            LandingMenuAction.OPEN_COORDINATOR -> coordinator?.let { open(OrbitRoute(Destination.SESSION, it, origin = Origin.LINK)) }
            LandingMenuAction.REVIEW_CARD -> if (view == null || view.settledAt != null) receipt = promotion
                else view.promotionId?.let { review = it; scope.launch { merge.load(force = true) } }
            else -> press(id, action)
        }
    }

    val subtitle = state.projectTitle?.let { "${LandingSessionCopy.RUN_BY_ORBIT} · $it" } ?: LandingSessionCopy.RUN_BY_ORBIT
    PageBar.Bind(route, SessionLandingsCopy.title, subtitle) {
        // The window's own ⋯ has the two ways out of it, and no landing's doors: those are each landing's own.
        Box {
            IconButton(onClick = { barMenu = true }, modifier = Modifier.testTag("landings-more")) {
                Icon(painterResource(R.drawable.ic_more), "More actions")
            }
            DropdownMenu(barMenu, { barMenu = false }, Modifier.testTag("landings-menu")) {
                state.coordinatorId?.let { id ->
                    DropdownMenuItem(text = { Text(LandingSessionCopy.OPEN_COORDINATOR) }, modifier = Modifier.testTag("landings-menu:coordinator"),
                        onClick = { barMenu = false; open(OrbitRoute(Destination.SESSION, id, origin = Origin.LINK)) })
                }
                DropdownMenuItem(text = { Text(SessionProjectCopy.openProject) }, modifier = Modifier.testTag("landings-menu:project"),
                    onClick = { barMenu = false; open(OrbitRoute(Destination.PROJECT, projectId)) })
            }
        }
    }
    val onLog: (String) -> (suspend (LandingLogSelectors, String?) -> LandingLogPage?) = { id ->
        { selectors, cursor -> LandingSessionReads.log(api, id, selectors, cursor) }
    }
    Column(Modifier.fillMaxSize().testTag("landings-window")) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("landings-window-list"), state = list,
            contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 16.dp)) {
            items(entries, key = { it.key }) { item ->
                when (item) {
                    is WindowItem.Note -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        if (item.failed) Text(LandingSessionCopy.UPDATE_UNAVAILABLE, Modifier.testTag("landings:note"),
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else CircularProgressIndicator(Modifier.size(20.dp).testTag("landings:loading"), strokeWidth = 2.dp)
                    }
                    is WindowItem.Day -> DayHeading(item.title, item.now)
                    is WindowItem.Settled -> {
                        val row = item.row
                        val record = row.sessionId?.let(::recordOf)
                        val expanded = row.id in state.expanded
                        LaunchedEffect(expanded, row.sessionId) { if (expanded) row.sessionId?.let(::readRecord) }
                        val coordinator = state.coordinatorId
                        // A settled landing has no doors, only the ways to look; a merge older than landing sessions has no view to
                        // read, and keeps its round's two ways in.
                        val menuItems = if (row.sessionId == null) listOfNotNull(
                                coordinator?.let { LandingMenuItem("coordinator", LandingMenuAction.OPEN_COORDINATOR, LandingSessionCopy.OPEN_COORDINATOR) },
                                row.promotion?.let { LandingMenuItem("review", LandingMenuAction.REVIEW_CARD, LandingSessionCopy.REVIEW_CARD) })
                            else record?.view?.let { LandingSessionModel.menuItems(it, LandingGates(), coordinator != null, row.promotion != null,
                                nothingPushed = false) }
                        LandingWindowRow(row, record, expanded, state.outlined == row.id, state.menu == row.id, menuItems, now, zone,
                            onToggle = { toggle(row.id) },
                            onMenu = { row.sessionId?.let(::readRecord); if (menuItems?.isEmpty() != true) state.menu = row.id },
                            onMenuDismiss = { state.menu = null },
                            onAction = { action -> act(row.id, record?.view, coordinator, row.promotion, action) },
                            onLog = onLog(row.sessionId ?: row.key))
                    }
                    is WindowItem.InHand -> {
                        val card = item.card
                        val read = state.cards[card.sessionId] ?: LandingSessionRead()
                        LandingWindowCard(card, read, card.sessionId in state.expanded, state.outlined == card.sessionId,
                            state.menu == card.sessionId, state.coordinatorId ?: read.coordinatorId, now, zone,
                            onToggle = { toggle(card.sessionId) },
                            onMenu = { state.menu = card.sessionId },
                            onMenuDismiss = { state.menu = null },
                            onAction = { action -> act(card.sessionId, read.view, state.coordinatorId ?: read.coordinatorId, read.currentPromotion(), action) },
                            onLog = onLog(card.sessionId))
                    }
                }
            }
        }
        LandingsFooter(state.coordinatorId) { state.coordinatorId?.let { open(OrbitRoute(Destination.SESSION, it, origin = Origin.LINK)) } }
    }
    review?.let { promotionId -> ProjectMergeReviewSheet(merge, promotionId, null) { review = null } }
    receipt?.let { record -> PromotionReceiptSheet(record) { receipt = null } }
}

/** A day's heading in the window — the session list's own words, centred like a conversation's — and `Now`'s, in the accent. */
@Composable
private fun DayHeading(title: String, now: Boolean) {
    Text(title, Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 6.dp).semantics { heading() }.testTag("landings:day:$title"),
        textAlign = TextAlign.Center, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
        color = if (now) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
}

/** The outline the landing the window was opened on wears for a moment (board 03 f), fading in and out. */
@Composable
private fun outline(outlined: Boolean): Modifier {
    val ink by animateColorAsState(if (outlined) MaterialTheme.colorScheme.primary else Color.Transparent, tween(300), label = "landing-outline")
    return Modifier.border(2.dp, ink, RoundedCornerShape(14.dp))
}

/**
 * One settled landing (board 02 d): the merged line's head — the mark that says how it ended, the task's name, the moment it settled
 * and one line under them — that opens in place to its record, the old landing page's timeline (board 03 e, f); a merge into main
 * opens to its receipt first. An open row shows an up arrow; pressed again it folds. A long-press opens its menu.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun LandingWindowRow(row: LandingsWindowRow, record: LandingSessionRead?, expanded: Boolean, outlined: Boolean, menuOpen: Boolean,
    menuItems: List<LandingMenuItem>?, now: Instant, zone: ZoneId, onToggle: () -> Unit, onMenu: () -> Unit, onMenuDismiss: () -> Unit,
    onAction: (LandingMenuAction) -> Unit, onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val ink = when (row.tone) {
        LandingsWindowTone.OK -> LocalOrbitColors.current.success
        LandingsWindowTone.MERGE -> MaterialTheme.colorScheme.primary
        LandingsWindowTone.QUIET -> muted
    }
    val view = record?.view
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp).then(outline(outlined)).testTag("landing-entry:${row.id}")) {
        if (outlined) Box(Modifier.size(0.dp).testTag("landing:outlined"))
        Box {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp))
                .background(if (expanded) muted.copy(alpha = 0.08f) else Color.Transparent)
                .combinedClickable(role = Role.Button, onLongClickLabel = "Landing actions", onClick = onToggle, onLongClick = onMenu)
                .padding(horizontal = 8.dp, vertical = 10.dp).testTag("landing-row:${row.id}"),
                verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                Box(Modifier.size(30.dp).background(ink.copy(alpha = 0.14f), CircleShape), contentAlignment = Alignment.Center) {
                    Text(when (row.tone) { LandingsWindowTone.OK -> "✓"; LandingsWindowTone.MERGE -> "⇢"; LandingsWindowTone.QUIET -> "◌" },
                        Modifier.testTag("landing-row:mark"), fontWeight = FontWeight.SemiBold, color = ink)
                }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(row.title, Modifier.weight(1f).testTag("landing-row:title"), fontWeight = FontWeight.SemiBold, maxLines = 1,
                            overflow = TextOverflow.Ellipsis)
                        if (row.time.isNotEmpty()) Text(row.time, Modifier.testTag("landing-row:time"), style = MaterialTheme.typography.labelMedium,
                            color = muted, maxLines = 1, softWrap = false)
                        if (expanded) LandingUpArrow()
                    }
                    Text(row.detail, Modifier.testTag("landing-row:detail"), style = MaterialTheme.typography.bodyMedium, color = muted,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            LandingEntryMenu(menuOpen && menuItems?.isEmpty() != true, menuItems, onMenuDismiss, onAction)
        }
        if (expanded) Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 6.dp, bottom = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (row.tone == LandingsWindowTone.MERGE) LandingReceiptBlock(LandingSessionModel.mergeReceipt(row.promotion, view))
            if (row.sessionId != null) {
                if (view != null) {
                    LandingRecord(view, now, zone, onLog)
                    LandingEntryLinks(view, onAction)
                } else Text(if (record?.failed == true) LandingSessionCopy.UPDATE_UNAVAILABLE else LandingSessionCopy.LOADING_LANDING,
                    Modifier.testTag("landing:status-note"), style = MaterialTheme.typography.bodyMedium, color = muted)
            }
        }
    }
}

/**
 * One landing still in hand, under `Now` (board 02 d): the old landing page's status card over its newest attempt — V6's step clock,
 * budget bar and liveness while it moves; what stopped it, and the doors to the people who decide, while it waits — with the task's name
 * under its head. A tap opens its record under it; a long-press, anywhere on it, its menu.
 */
@Composable
private fun LandingWindowCard(card: LandingsWindowCard, read: LandingSessionRead, expanded: Boolean, outlined: Boolean, menuOpen: Boolean,
    coordinatorId: String?, now: Instant, zone: ZoneId, onToggle: () -> Unit, onMenu: () -> Unit, onMenuDismiss: () -> Unit,
    onAction: (LandingMenuAction) -> Unit, onLog: suspend (LandingLogSelectors, String?) -> LandingLogPage?) {
    val view = read.view
    val attemptCard = view?.let { LandingSessionModel.attemptCard(it, now, read.updatedAt, read.failed, read.facts(), zone) }
    val outcome = view?.let { LandingSessionModel.outcomeCard(it, read.currentPromotion(), zone) }
    val attempt = view?.currentAttempt
    val gates = view?.let { LandingSessionModel.gates(it, now, read.updatedAt, read.failed) } ?: LandingGates()
    // J12: a check never pushes, and a v2 claim that recorded no PUSH proves none happened.
    val nothingPushed = view != null && attempt != null && (attempt.kind == "CHECK_PROMOTION" ||
        (attempt.timedOut && LandingSessionModel.pushSentence(view, attempt) == LandingSessionCopy.NOTHING_PUSHED_SENTENCE))
    val menuItems = view?.let { LandingSessionModel.menuItems(it, gates, coordinatorId != null, read.currentPromotion() != null, nothingPushed) }
    // A landing that waits for a decision carries the doors to the people who make it (board 02 d): the coordinator, and the task (or
    // the round's own card). A timed-out one has its own doors.
    val waitDoors = if (view == null || card.state != "AWAITING_DECISION" || view.settledAt != null || attemptCard?.timedOut == true) emptyList()
        else listOfNotNull(
            LandingMenuAction.OPEN_COORDINATOR.takeIf { coordinatorId != null },
            LandingMenuAction.OPEN_TASK.takeIf { view.subject == "TASK" && !view.taskId.isNullOrEmpty() },
            LandingMenuAction.REVIEW_CARD.takeIf { view.subject == "PROMOTION" && read.currentPromotion() != null })
    val toggle by rememberUpdatedState(onToggle)
    val menu by rememberUpdatedState(onMenu)
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp).then(outline(outlined)).testTag("landing-entry:${card.sessionId}"),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (outlined) Box(Modifier.size(0.dp).testTag("landing:outlined"))
        Box {
            // The whole card is the press, and a long-press anywhere on it the menu; its own doors keep their presses.
            LandingStatusCard(read, view, attemptCard, outcome, now, onAction,
                Modifier.pointerInput(Unit) { detectTapGestures(onTap = { toggle() }, onLongPress = { menu() }) }
                    .semantics {
                        onClick { toggle(); true }
                        onLongClick("Landing actions") { menu(); true }
                    },
                taskName = card.title, expanded = expanded, waitDoors = waitDoors)
            LandingEntryMenu(menuOpen && menuItems?.isEmpty() != true, menuItems, onMenuDismiss, onAction)
        }
        read.refusal?.let { refusal ->
            Text(refusal, Modifier.padding(horizontal = 4.dp).testTag("landing:refusal"), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error)
        }
        if (expanded && view != null) Column(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 4.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            LandingRecord(view, now, zone, onLog)
            LandingEntryLinks(view, onAction)
        }
    }
}

/** `Open task ›` and `Open source session ›`, under a task segment's open record (board 03 f). */
@Composable
private fun LandingEntryLinks(view: LandingView, onAction: (LandingMenuAction) -> Unit) {
    if (view.subject != "TASK") return
    val source = view.currentAttempt?.sourceSessionId?.takeIf { it.isNotEmpty() }
    if (view.taskId.isNullOrEmpty() && source == null) return
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (!view.taskId.isNullOrEmpty()) TextButton(onClick = { onAction(LandingMenuAction.OPEN_TASK) }, modifier = Modifier.testTag("landing:link:task")) {
            Text("${LandingSessionCopy.OPEN_TASK} ›", fontWeight = FontWeight.SemiBold)
        }
        if (source != null) TextButton(onClick = { onAction(LandingMenuAction.OPEN_SOURCE_SESSION) }, modifier = Modifier.testTag("landing:link:source")) {
            Text("${LandingSessionCopy.OPEN_SOURCE_SESSION} ›", fontWeight = FontWeight.SemiBold)
        }
    }
}

/** The receipt a merge row opens to (board 03 e): what is now on main, the check that passed on the combined tree and the tree that
 *  landed — in the green the settled round's card wears. */
@Composable
private fun LandingReceiptBlock(receipt: LandingMergeReceipt) {
    val success = LocalOrbitColors.current.success
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.fillMaxWidth().background(success.copy(alpha = 0.08f), shape).border(1.dp, success.copy(alpha = 0.3f), shape).padding(12.dp)
        .testTag("landing:receipt"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(receipt.heading, Modifier.testTag("landing:receipt-heading"), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
        receipt.tasks.forEach { title ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("•", color = muted)
                Text(title, style = MaterialTheme.typography.bodyMedium)
            }
        }
        receipt.checkLine?.let { Text(it, Modifier.testTag("landing:receipt-check"), style = MaterialTheme.typography.bodySmall, color = success) }
        receipt.treeLine?.let { Text(it, Modifier.testTag("landing:receipt-tree"), style = MaterialTheme.typography.bodySmall, color = muted) }
    }
}

/** The window's read-only footer (LS6): what this window is, who decides, and the way to them. No composer. */
@Composable
private fun LandingsFooter(coordinatorId: String?, onOpenCoordinator: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val words = SessionLandingsCopy.orbitRunsTheseLandings
    val cut = words.indexOf(" — ")
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
        .padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp).testTag("landings:footer"), verticalArrangement = Arrangement.spacedBy(0.dp)) {
        Text(buildAnnotatedString {
            if (cut < 0) append(words) else {
                append(words.substring(0, cut + 3))
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)) { append(words.substring(cut + 3)) }
            }
        }, Modifier.testTag("landings:footer-line"), style = MaterialTheme.typography.bodySmall, color = muted)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(LandingSessionCopy.DECISIONS_THE_COORDINATOR, style = MaterialTheme.typography.bodySmall, color = muted)
            if (coordinatorId != null) {
                Text(" · ", style = MaterialTheme.typography.bodySmall, color = muted)
                TextButton(onClick = onOpenCoordinator, contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                    modifier = Modifier.heightIn(min = 0.dp).testTag("landings:open-coordinator")) {
                    Text("${LandingSessionCopy.OPEN_COORDINATOR} ›", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
