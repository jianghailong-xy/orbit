package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.ui.composed
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.lazy.LazyListState
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.directory.TrashingSessions
import io.orbitd.android.management.TerminalNeedsYou
import io.orbitd.android.management.TerminalRequestStore
import io.orbitd.android.management.rememberLiveTerminalRequests
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.tasks.TaskTime
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import java.time.Instant

/** Whether the bar was last shown, whether it has shown yet, and its last measured height: what the list is scrolled
 * by when the bar comes or goes, so the line being read stays where it was (the sticky header's `HeaderShift`). */
private class BarShift { var shown = false; var seen = false; var height = 0f }

/**
 * The bar over a session list (iOS `NeedsYouBannerView`): what waits elsewhere, the session [sessionId] left out of it. A
 * conversation carries none since 2026-11-15 (`docs/mocks/needs-you-capsule/07-console-one-capsule`): what waits in it is its
 * header capsule's to say (`WaitingCapsule`). A session list shows no single session, so its [sessionId] is null.
 */
@Composable
internal fun SessionNeedsYouBar(app: OrbitApplication, handle: SessionHandle, sessionId: String?, list: LazyListState,
    open: (OrbitRoute) -> Unit) {
    val openRows by remember(app, handle) {
        app.realtime.state.map { live -> if (live.handle === handle) live.directory?.sessions?.get("open").orEmpty() else emptyList() }
            .distinctUntilChanged()
    }.collectAsState(emptyList())
    // A session on its way to Trash is waiting on nobody (A05-9), as it is in none of the lists.
    val trashing by app.trashing.ids.collectAsState()
    // Terminals asking to be approved lead: a request lives ten minutes (board waiting-on-you-removal 02 ③).
    val liveTerminals = rememberLiveTerminalRequests(remember(app, handle) {
        TerminalRequestStore.of(app.session, handle, app.processScope)
    })
    val terminals = TerminalNeedsYou.banner(liveTerminals)
    val terminalIds = remember(liveTerminals) { liveTerminals.map { it.id } }
    // Swiped away (the owner, 2026-11-15, `docs/mocks/needs-you-capsule/06-list-floats`): gone until something new is waiting,
    // the terminal line with it — another terminal asking counts as new.
    val context = LocalContext.current
    val dismissed by remember(context) { NeedsYouDismissal.keys(context) }.collectAsState()
    val banner = remember(openRows, sessionId, trashing, terminals, terminalIds, dismissed) {
        val rows = TrashingSessions.without(openRows, trashing) { it.text("id") }
        if (NeedsYouLogic.isDismissed(rows, sessionId, dismissed, terminalIds)) null
        else NeedsYouLogic.banner(rows, sessionId).let { sessions -> terminals?.copy(count = 1 + (sessions?.count ?: 0)) ?: sessions }
    }
    val shift = remember(list) { BarShift() }
    var unfolded by remember { mutableStateOf(false) }
    val shown = banner != null
    LaunchedEffect(shift, shown) {
        if (shown == shift.shown) return@LaunchedEffect
        shift.shown = shown
        // Its first showing is the conversation opening: the place it restores was not read under a bar.
        if (shown && !shift.seen) { shift.seen = true; return@LaunchedEffect }
        if (shift.height > 0f) list.dispatchRawDelta(if (shown) shift.height else -shift.height)
    }
    if (!shown) return
    val measured = Modifier.onSizeChanged { shift.height = it.height.toFloat() }
    val waiting = banner ?: return
    // One of the five owner items opens the card it names; anything else the session. Folds the bar again on the way out.
    fun go(entry: NeedsYouBanner) {
        unfolded = false
        // Terminals: Settings › Machines & models, on its Needs you section, the oldest card lit.
        entry.terminalRequest?.let { open(TerminalNeedsYou.route(it)); return }
        val target = entry.target.text("id") ?: return
        val workspace = entry.target.obj("agent")?.text("id") ?: entry.target.text("agentId") ?: entry.target.text("workspaceId")
        // A merge into main waiting on the reader is answered on its project's sessions page, where its card is (iOS 6b4bef713).
        val project = entry.target.obj("projectMembership")?.text("projectId")
        if (entry.ownerItem?.kind == "PROMOTION_APPROVAL" && project != null) {
            open(OrbitRoute(Destination.PROJECT_SESSIONS, project, workspace, origin = Origin.LIST)); return
        }
        // One of the other owner items opens the CARD it names in its coordinator conversation; anything else the session.
        entry.ownerItem?.let { CardFocus.request(target, NeedsYouLogic.cardKey(it)) }
        open(OrbitRoute(Destination.SESSION, target, workspace))
    }
    // Several waiting, unfolded (the owner, 2026-11-13, option B of `docs/mocks/needs-you-capsule/03-expand.html`): one capsule
    // per conversation, the first the one the folded bar names, standing where the folded bar stood and carrying the ↑ that folds
    // them. Since 2026-11-15 (`04-floating.html`) they hang over the page on a scrim instead of pushing it down: the folded bar
    // keeps its place, unseen, so the page under it never moves, and the stack is a popup over everything from there down.
    val several = waiting.count > 1
    val entries = if (unfolded && several) remember(openRows, sessionId, trashing, terminals) {
        listOfNotNull(terminals) + NeedsYouLogic.entries(TrashingSessions.without(openRows, trashing) { it.text("id") }, sessionId)
    } else emptyList()
    val stacked = entries.size > 1
    var top by remember { mutableStateOf(0) }
    NeedsYouBar(waiting.text, if (several) NeedsYouLogic.unfoldHint(waiting.count) else hint(waiting), measured.onGloballyPositioned { top = it.positionInWindow().y.toInt() }
        .then(if (stacked) Modifier.alpha(0f).clearAndSetSemantics {} else Modifier),
        detail = waiting.detail, since = waiting.since, more = waiting.more, glyph = waiting.glyph, deck = several,
        onSwipeAway = { NeedsYouDismissal.dismiss(context, NeedsYouLogic.dismissalKeys(TrashingSessions.without(openRows, trashing) { it.text("id") }, terminalIds)) }) {
        if (several) unfolded = true else go(waiting)
    }
    if (stacked) NeedsYouStack(top, { unfolded = false }) {
        // At most five; the last says "+N" for the ones behind it, as the folded bar does.
        val shown = entries.take(NeedsYouLogic.unfoldedLimit)
        shown.forEachIndexed { index, entry ->
            NeedsYouBar(entry.text, hint(entry),
                detail = entry.detail, since = entry.since, glyph = entry.glyph,
                more = if (index == shown.lastIndex) entries.size - shown.size else 0,
                onFold = if (index == 0) ({ unfolded = false }) else null) { go(entry) }
        }
    }
}

/** The unfolded capsules over everything from [top] (the folded bar's place in the window) down, on a scrim a press on which folds
 * them — never reaching the row under it. */
@Composable
private fun NeedsYouStack(top: Int, fold: () -> Unit, capsules: @Composable ColumnScope.() -> Unit) {
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    Popup(popupPositionProvider = WholeWindow, onDismissRequest = fold, properties = PopupProperties(focusable = true)) {
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = if (dark) 0.55f else 0.18f))
            .clickable(remember { MutableInteractionSource() }, null, onClickLabel = NeedsYouLogic.foldLabel, onClick = fold)
            .testTag("needs-you-scrim")) {
            Column(Modifier.offset { IntOffset(0, top) }.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(0.dp), content = capsules)
        }
    }
}

/** The popup laid over the whole window, so its scrim covers the page and its capsules stand where the bar's window position says. */
private object WholeWindow : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize) =
        IntOffset.Zero
}

/** What a press on one line does, for TalkBack. */
private fun hint(entry: NeedsYouBanner) = when {
    entry.terminalRequest != null -> TerminalNeedsYou.hint
    entry.ownerItem == null -> NeedsYouLogic.sessionHint
    else -> NeedsYouLogic.itemHint
}

/**
 * The needs-you bar (iOS `NeedsYouBannerView`): a capsule over the session list saying something is waiting on the reader in
 * another session — or an owner item's card — and taking them to it; the whole capsule is the press. Deliberately still — no
 * pulse — since what it names can wait for hours.
 *
 * A capsule, not a band (the owner, 2026-10-21, `docs/mocks/needs-you-capsule`): the amber is one 30 dp circle — the landing
 * head's (`ProjectLandingHead`) — whose mark says which kind is waiting, never a wash under the words; the words are two lines,
 * [text] what and [detail] where, with how long it has waited ([since]) and how many wait behind it ([more]). Material has no
 * glass, so the capsule is the raised surface the reader's cards use, on the page's own surface: the transcript scrolls under
 * the bar, and the gap around the capsule must not show it.
 */
@Composable
internal fun NeedsYouBar(text: String, hint: String, modifier: Modifier = Modifier, detail: String? = null,
    since: String? = null, more: Int = 0, glyph: NeedsYouGlyph = NeedsYouGlyph.QUESTION, deck: Boolean = false,
    onFold: (() -> Unit)? = null, onSwipeAway: (() -> Unit)? = null, onPress: () -> Unit) {
    val haptics = LocalHapticFeedback.current
    val amber = LocalOrbitColors.current.needsYou
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val press = { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); onPress() }
    // Nothing under it: the rows go on behind the capsule, which a shadow lifts off them (04-floating). Several waiting, two edges
    // of the capsules behind it show under it as a stack of notifications does, and the bar keeps their room.
    Box(modifier.fillMaxWidth().then(if (onSwipeAway != null) Modifier.swipesAway(onSwipeAway) else Modifier)
        .padding(start = 16.dp, end = 16.dp, bottom = 6.dp + if (deck) DECK_REACH else 0.dp)
        .testTag("needs-you-bar")) {
        if (deck) NeedsYouDeck()
        // Read as its words, a button, and what the press does (iOS `accessibilityHint`).
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).shadow(8.dp, CircleShape).clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
            verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).heightIn(min = 44.dp).clickable(onClickLabel = hint, role = Role.Button, onClick = press)
                .padding(start = 7.dp, end = if (onFold == null) 16.dp else 0.dp, top = 5.dp, bottom = 5.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                // The one place the amber is; the words stay the surface's own — amber words on amber were the band's trap.
                Box(Modifier.size(30.dp).background(amber.copy(alpha = 0.15f), CircleShape), contentAlignment = Alignment.Center) {
                    Icon(painterResource(glyph.drawable), null, Modifier.size(16.dp).testTag("needs-you-bar-glyph:${glyph.name}"), tint = amber)
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(text, Modifier.weight(1f).testTag("needs-you-bar-text"), color = MaterialTheme.colorScheme.onSurface,
                            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        // "+N" for those behind it; that a press unfolds them is the deck's to say.
                        if (more > 0) Text("+$more", Modifier.background(muted.copy(alpha = 0.14f), CircleShape).padding(horizontal = 6.dp)
                            .testTag("needs-you-bar-more"), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = muted)
                        since?.let { NeedsYouAge(it) }
                    }
                    detail?.let {
                        Text(it, Modifier.testTag("needs-you-bar-detail"), style = MaterialTheme.typography.bodySmall, color = muted,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            // The ↑ on the first capsule of the unfolded stack: a press of its own, folding them back.
            onFold?.let { fold ->
                Box(Modifier.size(48.dp).clickable(onClickLabel = NeedsYouLogic.foldLabel, role = Role.Button) {
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove); fold()
                }.testTag("needs-you-bar-fold"), contentAlignment = Alignment.Center) {
                    Icon(painterResource(R.drawable.ic_chevron_down), NeedsYouLogic.foldLabel, Modifier.size(14.dp).rotate(180f), tint = muted)
                }
            }
        }
    }
}

/** Pushed up, the bar goes away (iOS `SwipeAway`): it follows the finger up and fades, and past 22 dp — or flicked — it is put away
 * until something new is waiting; short of that it springs back. A tap is still the press. TalkBack gets a Dismiss action. */
private fun Modifier.swipesAway(dismiss: () -> Unit): Modifier = composed {
    val density = LocalDensity.current
    val lift = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val far = with(density) { 22.dp.toPx() }
    val fade = with(density) { 60.dp.toPx() }
    this.offset { IntOffset(0, lift.value.roundToInt()) }
        .graphicsLayer { alpha = 1f - (-lift.value / fade).coerceIn(0f, 0.8f) }
        .draggable(rememberDraggableState { delta -> scope.launch { lift.snapTo((lift.value + delta).coerceAtMost(0f)) } },
            Orientation.Vertical, onDragStopped = { velocity ->
                if (lift.value < -far || velocity < -1200f) {
                    lift.animateTo(-fade * 1.4f, spring())
                    dismiss()
                    lift.snapTo(0f)
                } else lift.animateTo(0f, spring())
            })
        .semantics { customActions = listOf(CustomAccessibilityAction(NeedsYouLogic.dismissLabel) { dismiss(); true }) }
}

/** What the bar was swiped away from (`NeedsYouLogic.dismissalKeys`), kept on this device only — a swipe tells the server nothing. */
internal object NeedsYouDismissal {
    private const val PREFS = "orbit.needs-you"
    private const val KEY = "dismissed"
    private var owner: Context? = null
    private val state = MutableStateFlow<Set<String>>(emptySet())

    fun keys(context: Context): StateFlow<Set<String>> {
        val app = context.applicationContext
        if (owner !== app) {
            owner = app
            state.value = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet(KEY, emptySet()).orEmpty().toSet()
        }
        return state
    }

    fun dismiss(context: Context, keys: Set<String>) {
        keys(context)
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet(KEY, keys).apply()
        state.value = keys
    }
}

/** The menu button's icon, carrying how many are waiting on you while the bar is swiped away (iOS `DrawerToggleButton`), so what
 * the bar said is not lost. */
@Composable
internal fun NeedsYouMenuIcon(app: OrbitApplication, description: String) {
    val context = LocalContext.current
    val openRows by remember(app) {
        app.realtime.state.map { it.directory?.sessions?.get("open").orEmpty() }.distinctUntilChanged()
    }.collectAsState(emptyList())
    val trashing by app.trashing.ids.collectAsState()
    val dismissed by remember(context) { NeedsYouDismissal.keys(context) }.collectAsState()
    val waiting = remember(openRows, trashing, dismissed) {
        val rows = TrashingSessions.without(openRows, trashing) { it.text("id") }
        if (NeedsYouLogic.isDismissed(rows, null, dismissed)) rows.count(NeedsYouLogic::needsYou) else 0
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

/** How far the deck shows below the capsule (iOS `deckReach`). */
private val DECK_REACH = 13.dp

/** The two edges under the capsule while several are waiting: 7 and 13 dp below it, standing in 12 and 26 dp from its ends. */
@Composable
private fun BoxScope.NeedsYouDeck() {
    // The capsule's own surface, a step and two steps back towards the page's.
    val capsule = MaterialTheme.colorScheme.surfaceVariant
    val page = MaterialTheme.colorScheme.surface
    Box(Modifier.matchParentSize().padding(horizontal = 26.dp).offset(y = DECK_REACH).clip(CircleShape)
        .background(lerp(capsule, page, 0.6f)).testTag("needs-you-bar-deck"))
    Box(Modifier.matchParentSize().padding(horizontal = 12.dp).offset(y = 7.dp).shadow(4.dp, CircleShape).clip(CircleShape)
        .background(lerp(capsule, page, 0.3f)))
}

/** How long the thing the bar names has waited — "12m", "2h" — kept current while it sits there: the words of a duration still
 * running (`TaskTime.elapsed`, iOS `RelativeTime.elapsed`), not of an event. */
@Composable
private fun NeedsYouAge(since: String) {
    val now by produceState(Instant.now(), since) { while (true) { delay(30_000); value = Instant.now() } }
    TaskTime.elapsed(since, now)?.let {
        Text(it, Modifier.testTag("needs-you-bar-age"), style = MaterialTheme.typography.bodySmall.copy(fontFeatureSettings = "tnum"),
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false)
    }
}

/** The drawable for each mark (iOS `NeedsYouGlyph.symbol`). */
internal val NeedsYouGlyph.drawable: Int get() = when (this) {
    NeedsYouGlyph.MERGE -> R.drawable.ic_merge
    NeedsYouGlyph.QUESTION -> R.drawable.ic_question_bubble
    NeedsYouGlyph.WARNING -> R.drawable.ic_warning
    NeedsYouGlyph.PAUSE -> R.drawable.ic_pause
    NeedsYouGlyph.HAND -> R.drawable.ic_permission
    NeedsYouGlyph.TERMINAL -> R.drawable.ic_terminal
}
