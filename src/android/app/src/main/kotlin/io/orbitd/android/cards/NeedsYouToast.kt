package io.orbitd.android.cards

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.TerminalRequest
import io.orbitd.android.directory.TrashingSessions
import io.orbitd.android.management.TerminalNeedsYou
import io.orbitd.android.management.TerminalRequestStore
import io.orbitd.android.management.rememberLiveTerminalRequests
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonObject
import kotlin.math.roundToInt

/**
 * What is noticed as it starts waiting on the reader (iOS `AppModel.noticeNewlyWaiting`; the owner, 2026-11-15,
 * `docs/mocks/needs-you-capsule/12-once`): each wait not seen at the last look becomes one notice. The first look — after sign-in,
 * or back in the foreground ([retake]) — only takes stock. A notice whose conversation stopped waiting goes. It replaced a resident
 * needs-you bar ("2 sessions need you") and the approval push's bottom snackbar: "if it is a toast, it is a notice that happened once".
 * A terminal asking to be approved is noticed the same way (the owner, 2026-11-16, in place of the bar's line of board
 * waiting-on-you-removal 02 ③): once per request id, never again for that id, and gone when the request is answered or expires.
 */
internal class NeedsYouNotices {
    val toasts = mutableStateListOf<NeedsYouToast>()
    /** How many started waiting beyond the [NeedsYouLogic.toastLimit] shown: "and N more". */
    var more by mutableIntStateOf(0)
        private set
    private var seen: Set<String>? = null
    private var seenTerminals: Set<String>? = null
    /** Every terminal request already noticed or taken stock of: one notice per request id, whatever the looks after. */
    private val known = mutableSetOf<String>()

    /** A look at the Open rows, [focused] the conversation on screen. */
    fun look(open: List<JsonObject>, focused: String?) {
        val waiting = open.filter(NeedsYouLogic::needsYou)
        val keys = waiting.map(NeedsYouLogic::waitKey).toSet()
        val before = seen
        seen = keys
        if (before != null) NeedsYouLogic.newlyWaiting(waiting, before, focused).forEach { notice ->
            if (toasts.size < NeedsYouLogic.toastLimit) toasts += notice else more++
        }
        toasts.removeAll { it.terminalRequest == null && it.id !in keys }
        if (toasts.isEmpty()) more = 0
    }

    /** A look at the terminal requests still answerable ([live], oldest first, after the store's first answer). The first look takes
     * stock; a request not known before is noticed once, at the head of the column, and its notice goes when it is answered. */
    fun lookTerminals(live: List<TerminalRequest>) {
        val ids = live.map { it.id }.toSet()
        val before = seenTerminals
        seenTerminals = ids
        if (before == null) known += ids
        else live.filter { it.id !in known }.forEach { request ->
            known += request.id
            if (toasts.size < NeedsYouLogic.toastLimit) toasts.add(0, TerminalNeedsYou.toast(request)) else more++
        }
        toasts.removeAll { it.terminalRequest != null && it.terminalRequest !in ids }
        if (toasts.isEmpty()) more = 0
    }

    /** Back in the foreground: what waits now is taken as it stands, not announced. */
    fun retake() { seen = null; seenTerminals = null }

    /** Flicked away, pressed, or its time is up. */
    fun dismiss(id: String) {
        toasts.removeAll { it.id == id }
        if (toasts.isEmpty()) more = 0
    }
}

/**
 * The notices, first in the toast host's column (iOS `ToastHost`): read off the Open snapshot the directory already holds, so they
 * cost no request, and gone on their own after [NeedsYouLogic.toastMillis]. A press opens the conversation at the card it waits
 * on ([open]).
 */
@Composable
internal fun NeedsYouToasts(app: OrbitApplication, handle: SessionHandle, open: (OrbitRoute) -> Unit) {
    val notices = remember(handle) { NeedsYouNotices() }
    val requests = remember(handle) { OwnerRequestStore.of(app.session, handle, app.processScope) }
    val look by remember(app, handle) {
        app.realtime.state.map { live ->
            // Nothing is looked at until the Open list has answered: an empty list is not "nothing waits".
            val open = if (live.handle === handle) live.directory?.sessions?.get("open") else null
            open?.let { it to live.session?.id }
        }.distinctUntilChanged()
    }.collectAsState(null)
    // A session on its way to Trash is waiting on nobody (A05-9), as it is in none of the lists.
    val trashing by app.trashing.ids.collectAsState()
    LaunchedEffect(notices, look, trashing) {
        val (rows, focused) = look ?: return@LaunchedEffect
        notices.look(TrashingSessions.without(rows, trashing) { it.text("id") }, focused)
    }
    // Terminals asking to be approved: the store Machines & models reads, read every 20 s while this is drawn and again on each
    // terminals.changed (MainActivity).
    val terminalStore = remember(app, handle) { TerminalRequestStore.of(app.session, handle, app.processScope) }
    val liveTerminals = rememberLiveTerminalRequests(terminalStore)
    val terminalsRead by terminalStore.loaded.collectAsState()
    LaunchedEffect(notices, liveTerminals, terminalsRead) { if (terminalsRead) notices.lookTerminals(liveTerminals) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, notices) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) notices.retake() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val haptics = LocalHapticFeedback.current
    var felt by remember { mutableIntStateOf(0) }
    LaunchedEffect(notices.toasts.size) {
        if (notices.toasts.size > felt) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        felt = notices.toasts.size
    }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        notices.toasts.forEach { notice ->
            key(notice.id) {
                LaunchedEffect(Unit) { delay(NeedsYouLogic.toastMillis); notices.dismiss(notice.id) }
                val shown = remember { MutableTransitionState(false) }.apply { targetState = true }
                AnimatedVisibility(shown, enter = slideInVertically { -it / 2 } + fadeIn(),
                    exit = slideOutVertically { -it / 2 } + fadeOut() + shrinkVertically()) {
                    NeedsYouToastCard(notice, dismiss = { notices.dismiss(notice.id) }) {
                        notices.dismiss(notice.id)
                        // A terminal's opens its machine's Terminals to approve, its card lit.
                        val terminal = notice.terminalRequest?.let { id -> liveTerminals.firstOrNull { it.id == id } }
                        if (terminal != null) open(TerminalNeedsYou.machineRoute(terminal))
                        else if (notice.terminalRequest == null) openNeedsYou(notice.target, notice.ownerItem, requests.state.value, open)
                    }
                }
            }
        }
        if (notices.more > 0) NeedsYouToastMore(notices.more)
    }
}

/** A press on a notice: one of the five owner items opens the card it names; an owner request the conversation that asked, at
 * its oldest pending request's card, as its push does (docs/mocks/waiting-on-you-removal: there is no inbox); anything else the
 * session. */
private fun openNeedsYou(target: JsonObject, item: OwnerItem?, requests: OwnerRequestStore.State, open: (OrbitRoute) -> Unit) {
    val id = target.text("id") ?: return
    val workspace = target.obj("agent")?.text("id") ?: target.text("agentId") ?: target.text("workspaceId")
    if (item == null && target.text("waitingKind") == "OWNER_REQUEST") {
        // Not read on this device yet: the conversation alone, whose reader reads its requests and draws the card.
        OwnerRequests.oldestPending(id, requests.list(OwnerRequestStore.ALL), requests.open)
            ?.let { CardFocus.request(id, CardFocus.ownerRequest(it.id)) }
        open(OrbitRoute(Destination.SESSION, id, workspace)); return
    }
    // A merge into main waiting on the reader is answered on its project's sessions page, where its card is (iOS 6b4bef713).
    val project = target.obj("projectMembership")?.text("projectId")
    if (item?.kind == "PROMOTION_APPROVAL" && project != null) {
        open(OrbitRoute(Destination.PROJECT_SESSIONS, project, workspace, origin = Origin.LIST)); return
    }
    item?.let { CardFocus.request(id, NeedsYouLogic.cardKey(it)) }
    open(OrbitRoute(Destination.SESSION, id, workspace))
}

/** One notice (iOS `NeedsYouToastCard`): the amber circle with the mark of what waits, the conversation, then what it waits on and
 * its workspace. The whole card is the press; flicked up it goes. The toast host's surface, ringed amber. */
@Composable
internal fun NeedsYouToastCard(notice: NeedsYouToast, dismiss: () -> Unit, press: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val amber = LocalOrbitColors.current.needsYou
    val colors = MaterialTheme.colorScheme
    var travel by remember(notice.id) { mutableFloatStateOf(0f) }
    val away = with(LocalDensity.current) { 32.dp.toPx() }
    Row(Modifier.fillMaxWidth().offset { IntOffset(0, travel.roundToInt()) }
        .pointerInput(notice.id) {
            detectVerticalDragGestures(onDragEnd = { travel = 0f }, onDragCancel = { travel = 0f }) { change, amount ->
                travel = (travel + amount).coerceAtMost(0f)
                if (travel < -away) { change.consume(); dismiss() }
            }
        }
        .surface(CardShape, colors.surface, colors.onSurface)
        .border(1.5.dp, amber.copy(alpha = 0.7f), CardShape)
        .clickable(onClickLabel = when {
            notice.terminalRequest != null -> TerminalNeedsYou.hint
            notice.ownerItem == null -> NeedsYouLogic.sessionHint
            else -> NeedsYouLogic.itemHint
        }, role = Role.Button) {
            haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); press()
        }
        .semantics { customActions = listOf(CustomAccessibilityAction(NeedsYouLogic.dismissLabel) { dismiss(); true }) }
        .padding(horizontal = 14.dp, vertical = 12.dp).testTag("needs-you-toast"),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(38.dp).background(amber.copy(alpha = 0.15f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(painterResource(notice.glyph.drawable), null, Modifier.size(20.dp).testTag("needs-you-toast-glyph:${notice.glyph.name}"), tint = amber)
        }
        Column(Modifier.weight(1f)) {
            Text(notice.title, Modifier.testTag("needs-you-toast-title"), style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(notice.line, Modifier.testTag("needs-you-toast-line"), style = MaterialTheme.typography.bodySmall,
                color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** "and 2 more", under the third notice when more started waiting at once. */
@Composable
private fun NeedsYouToastMore(count: Int) {
    val colors = MaterialTheme.colorScheme
    Text("and $count more", Modifier.surface(RoundedCornerShape(percent = 50), colors.surface, colors.onSurface)
        .padding(horizontal = 12.dp, vertical = 5.dp).testTag("needs-you-toast-more"),
        style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = colors.onSurfaceVariant)
}

/** The menu button's icon, carrying how many are waiting on you (iOS `DrawerToggleButton`): the count is the lists' to say, the
 * notices only say what started. */
@Composable
internal fun NeedsYouMenuIcon(app: OrbitApplication, description: String) {
    val openRows by remember(app) {
        app.realtime.state.map { it.directory?.sessions?.get("open").orEmpty() }.distinctUntilChanged()
    }.collectAsState(emptyList())
    val trashing by app.trashing.ids.collectAsState()
    val waiting = remember(openRows, trashing) {
        TrashingSessions.without(openRows, trashing) { it.text("id") }.count(NeedsYouLogic::needsYou)
    }
    if (waiting == 0) {
        Icon(painterResource(R.drawable.ic_menu), description)
        return
    }
    BadgedBox(badge = {
        Badge(Modifier.testTag("needs-you-menu-badge"), containerColor = LocalOrbitColors.current.needsYou, contentColor = Color.White) {
            Text("$waiting")
        }
    }) { Icon(painterResource(R.drawable.ic_menu), description) }
}

private val CardShape = RoundedCornerShape(22.dp)

/** The toast host's surface (`ToastHost`'s `surface`): a soft shadow, a hairline edge that inverts with the appearance. */
private fun Modifier.surface(shape: Shape, color: Color, ink: Color) = shadow(8.dp, shape, clip = false)
    .background(color, shape).border(0.7.dp, ink.copy(alpha = 0.08f), shape).clip(shape)

/** The drawable for each mark (iOS `NeedsYouGlyph.symbol`). */
internal val NeedsYouGlyph.drawable: Int get() = when (this) {
    NeedsYouGlyph.MERGE -> R.drawable.ic_merge
    NeedsYouGlyph.QUESTION -> R.drawable.ic_question_bubble
    NeedsYouGlyph.WARNING -> R.drawable.ic_warning
    NeedsYouGlyph.PAUSE -> R.drawable.ic_pause
    NeedsYouGlyph.HAND -> R.drawable.ic_permission
    NeedsYouGlyph.TERMINAL -> R.drawable.ic_terminal
}
