package io.orbitd.android.directory

import android.view.View
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.EaseOut
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Where a swiped row goes under the finger and when it is let go: OrbitKit `RowSwipeGeometry`, in dp where iOS has points. Offsets are
 * the row's displacement: positive slides it toward the end to show the leading actions, negative toward the start to show the
 * trailing ones. A side's width is how far the row slides to show all of its buttons, margins included ([openWidth]).
 */
internal data class RowSwipeGeometry(val leadingWidth: Double, val trailingWidth: Double, val rowWidth: Double, val leadingFullSwipe: Boolean) {
    enum class Rest { CLOSED, LEADING, TRAILING, FULL_SWIPE }

    /** One-to-one up to either side's width, and past it only grudgingly, except toward a full swipe, which follows the finger. */
    fun dragged(raw: Double): Double = when {
        raw > leadingWidth -> if (leadingFullSwipe && leadingWidth > 0) raw else leadingWidth + (raw - leadingWidth) * RESISTANCE
        raw < -trailingWidth -> -trailingWidth + (raw + trailingWidth) * RESISTANCE
        else -> raw
    }

    /** Past this, letting go performs the first leading action: over halfway across, and never before a slot beyond the open buttons. */
    val fullSwipePoint: Double get() = max(leadingWidth + SLOT, rowWidth * 0.6)

    fun isFullSwipe(offset: Double) = leadingFullSwipe && leadingWidth > 0 && offset >= fullSwipePoint

    /** Open if it was more than half way out or flicked outward, shut if it was flicked back or barely moved. */
    fun rest(offset: Double, velocity: Double): Rest {
        if (isFullSwipe(offset)) return Rest.FULL_SWIPE
        if (offset > 0 && leadingWidth > 0) {
            if (velocity > FLICK) return Rest.LEADING
            if (velocity < -FLICK) return Rest.CLOSED
            return if (offset > leadingWidth / 2) Rest.LEADING else Rest.CLOSED
        }
        if (offset < 0 && trailingWidth > 0) {
            if (velocity < -FLICK) return Rest.TRAILING
            if (velocity > FLICK) return Rest.CLOSED
            return if (-offset > trailingWidth / 2) Rest.TRAILING else Rest.CLOSED
        }
        return Rest.CLOSED
    }

    /** The offset a rest is drawn at; a full swipe carries the row off the screen. */
    fun offset(at: Rest): Double = when (at) {
        Rest.CLOSED -> 0.0
        Rest.LEADING -> leadingWidth
        Rest.TRAILING -> -trailingWidth
        Rest.FULL_SWIPE -> rowWidth
    }

    companion object {
        /** Each button sits in a slot this wide (wider only for a title that needs it), [GAP] from the edge, its neighbour and the row. */
        const val SLOT = 60.0
        const val GAP = 10.0
        /** The distance over which a button grows in. */
        const val GROWTH = 30.0
        /** How much of a drag past a side's width still moves the row. */
        private const val RESISTANCE = 0.3
        /** A lift faster than this, in dp per second, decides the rest by its direction alone. */
        private const val FLICK = 400.0

        /** Two 60 dp slots make 150, three make 220. */
        fun openWidth(slots: List<Double>): Double = if (slots.isEmpty()) 0.0 else slots.sum() + GAP * (slots.size + 1)

        /** How far a side's button has grown in, 0 to 1: button [index], counted from the screen edge inward, grows from a dot over the
         * last [GROWTH] before its slot is clear of the row, so the outermost comes first. */
        fun reveal(index: Int, slots: List<Double>, revealed: Double): Double {
            if (index !in slots.indices) return 0.0
            val clear = openWidth(slots.take(index + 1))
            return min(1.0, max(0.0, (revealed - (clear - GROWTH)) / GROWTH))
        }

        /** A button fades in a little ahead of its size. */
        fun revealOpacity(reveal: Double): Double = if (reveal <= 0) 0.0 else min(1.0, 0.15 + 0.85 * reveal)
    }
}

/** A row's action as a swipe's button, a screen reader's custom action and, with its menu's title, a long press's item (iOS `RowSwipeAction`). */
internal class RowAction(val title: String, val icon: Int, val tint: RowActionTint, val enabled: Boolean = true, val perform: () -> Unit)

/** The colours iOS 26 draws these in, read off its frames (docs/mocks/android-row-swipe). */
internal enum class RowActionTint(val light: Long, val dark: Long) {
    GREEN(0xFF34C759, 0xFF30D158), BLUE(0xFF0088FF, 0xFF0091FF), INDIGO(0xFF6155F5, 0xFF6D7CFF), RED(0xFFFF383C, 0xFFFF4245)
}

/** A row's swipe actions and full swipe, with what a screen reader gets of them: the ones that are enabled (iOS `accessibilityActions`). */
internal class RowActions(val leading: List<RowAction>, val trailing: List<RowAction>, val leadingFullSwipe: Boolean) {
    val accessibility: List<CustomAccessibilityAction> = (leading + trailing).filter { it.enabled }
        .map { action -> CustomAccessibilityAction(action.title) { action.perform(); true } }
}

/** The list's half of the swipe (iOS `RowSwipeState`): which row is open. Opening another shuts it, and while one is open a tap on any row
 * only shuts it. */
@Stable
internal class RowSwipeState {
    var openId by mutableStateOf<Any?>(null)
    fun hidesDivider(id: Any, below: Any?) = openId != null && (openId == id || openId == below)
}

/** System Back shuts an open row first, as it does an open drawer. */
@Composable
internal fun RowSwipeBack(swipe: RowSwipeState) {
    BackHandler(enabled = swipe.openId != null) { swipe.openId = null }
}

private enum class RowSide { LEADING, TRAILING }

/** What a row's swipe holds while it is out, in dp. */
@Stable
private class SlidingRow(private val id: Any, private val swipe: RowSwipeState, private val scope: CoroutineScope) {
    var offset by mutableFloatStateOf(0f)
    /** [offset] when the finger came down; null while no finger is on the row. */
    var dragStart by mutableStateOf<Float?>(null)
    /** The side whose buttons are drawn: the one the row is slid toward, kept until it has shut so the buttons can shrink away with it. */
    var shownSide by mutableStateOf<RowSide?>(null)
    var rowWidth by mutableFloatStateOf(0f)
    val slotWidths = mutableStateMapOf<String, Float>()
    var actions by mutableStateOf(RowActions(emptyList(), emptyList(), false))
    /** Carried off by a full swipe: it has let go of being the list's open row, and nothing but its own return puts it back. */
    var leaving by mutableStateOf(false)
    /** The side the row came to rest open on: a slot measured only once the row was out (a title wider than the slot) widens it. */
    private var rest: RowSwipeGeometry.Rest? = null
    private var motion: Job? = null

    fun slots(side: List<RowAction>) = side.map { (slotWidths[it.title] ?: RowSwipeGeometry.SLOT.toFloat()).toDouble() }
    val geometry: RowSwipeGeometry get() = RowSwipeGeometry(RowSwipeGeometry.openWidth(slots(actions.leading)), RowSwipeGeometry.openWidth(slots(actions.trailing)),
        rowWidth.toDouble(), actions.leadingFullSwipe && actions.leading.firstOrNull()?.enabled == true)

    private fun claimOpen() { if (swipe.openId != id) swipe.openId = id }

    fun began() {
        motion?.cancel()
        leaving = false
        rest = null
        dragStart = offset
        claimOpen()
    }

    fun moved(dx: Float) {
        val start = dragStart ?: return
        offset = geometry.dragged((start + dx).toDouble()).toFloat()
        if (offset != 0f) shownSide = if (offset > 0) RowSide.LEADING else RowSide.TRAILING
    }

    fun ended(dx: Float, velocity: Float) {
        val start = dragStart ?: return
        val lifted = geometry.dragged((start + dx).toDouble())
        dragStart = null
        settle(geometry.rest(lifted, velocity.toDouble()))
    }

    private fun slide(to: Float, spec: AnimationSpec<Float>, then: suspend () -> Unit = {}) {
        motion?.cancel()
        motion = scope.launch {
            animate(offset, to, animationSpec = spec) { value, _ -> offset = value }
            then()
        }
    }

    private fun putAway() {
        if (offset != 0f) return
        leaving = false
        shownSide = null
        if (swipe.openId == id) swipe.openId = null
    }

    /** Back to where the side it is open on now rests, once its buttons' widths are known. */
    fun refit() {
        val open = rest ?: return
        if (dragStart != null || leaving) return
        val target = geometry.offset(open).toFloat()
        if (abs(target - offset) > 0.5f) slide(target, SNAPPY)
    }

    fun settle(rest: RowSwipeGeometry.Rest) {
        val target = geometry.offset(rest).toFloat()
        this.rest = rest.takeIf { it == RowSwipeGeometry.Rest.LEADING || it == RowSwipeGeometry.Rest.TRAILING }
        when (rest) {
            RowSwipeGeometry.Rest.LEADING, RowSwipeGeometry.Rest.TRAILING -> {
                claimOpen()
                shownSide = if (rest == RowSwipeGeometry.Rest.LEADING) RowSide.LEADING else RowSide.TRAILING
                slide(target, SNAPPY)
            }
            RowSwipeGeometry.Rest.CLOSED -> slide(0f, SHUTTING) { putAway() }
            RowSwipeGeometry.Rest.FULL_SWIPE -> {
                leaving = true
                if (swipe.openId == id) swipe.openId = null
                val action = actions.leading[0]
                motion?.cancel()
                motion = scope.launch {
                    // The action runs once the row is off, and runs even if a touch stops the slide first: the swipe was made.
                    try { animate(offset, target, animationSpec = SNAPPY_SHORT) { value, _ -> offset = value } } finally { action.perform() }
                    // A completed or reopened row leaves the list; one that stays (the request failed) comes back once the list has had its chance to drop it.
                    delay(500)
                    slide(0f, SHUTTING) { putAway() }
                }
            }
        }
    }

    fun forget() {
        if (swipe.openId == id) swipe.openId = null
    }

    private companion object {
        // SwiftUI's springs by their response r: stiffness (2π/r)², damping as given. `.snappy` is r 0.5 with bounce 0.15, `.smooth(0.35)` no bounce.
        val SNAPPY = spring<Float>(dampingRatio = 0.85f, stiffness = 158f, visibilityThreshold = 0.1f)
        val SNAPPY_SHORT = spring<Float>(dampingRatio = 0.85f, stiffness = 632f, visibilityThreshold = 0.1f)
        val SHUTTING = spring<Float>(dampingRatio = 1f, stiffness = 322f, visibilityThreshold = 0.1f)
    }
}

/** How far from the edge the drawer keeps a right swipe, past what the system's gesture takes (iOS's open strip is 18 pt). */
private val EDGE_STRIP = 18.dp

/**
 * A row that slides aside to show its actions as round buttons (iOS `CircleSwipeRow`): 60 dp slots 10 dp apart, a rounded card of the row
 * sliding clear of them, and under each slot a circle over its title, growing in from a dot as the row slides. Only a drag that
 * moves more across than up or down starts it, so the list keeps its scroll; one that starts takes the touch from the row's tap, the
 * list and the drawer. One that starts in the screen's edge leaves the touch to the system's Back and the drawer behind it.
 * A row with no actions is drawn alone: a drag on it is the drawer's.
 */
@Composable
internal fun SwipeRow(id: Any, swipe: RowSwipeState, actions: RowActions, content: @Composable () -> Unit) {
    if (actions.leading.isEmpty() && actions.trailing.isEmpty()) return content()
    val scope = rememberCoroutineScope()
    val row = remember(id, swipe) { SlidingRow(id, swipe, scope) }
    row.actions = actions
    val density = LocalDensity.current
    val view = LocalView.current
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val haptics = LocalHapticFeedback.current
    val slid by remember(row) { derivedStateOf { row.offset != 0f } }
    val armed by remember(row) { derivedStateOf { row.dragStart != null && row.geometry.isFullSwipe(row.offset.toDouble()) } }
    var placed by remember { mutableStateOf<LayoutCoordinates?>(null) }

    LaunchedEffect(armed) { if (armed) haptics.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate) }
    // Another row opened, or a tap anywhere shut this one.
    if (slid) LaunchedEffect(swipe.openId) { if (swipe.openId != id && row.dragStart == null && !row.leaving) row.settle(RowSwipeGeometry.Rest.CLOSED) }
    if (slid) LaunchedEffect(row) { snapshotFlow { row.geometry.leadingWidth to row.geometry.trailingWidth }.collect { row.refit() } }
    DisposableEffect(row) { onDispose { row.forget() } }

    val card = rowCardColor()
    val cardShown by remember(row) { derivedStateOf { row.offset != 0f || row.shownSide != null } }
    val cardAlpha by animateFloatAsState(if (cardShown) 1f else 0f, if (cardShown) snap() else tween(150, easing = EaseOut), label = "card")
    Box(Modifier.fillMaxWidth().clipToBounds()
        .onSizeChanged { row.rowWidth = it.width / density.density }
        .onPlaced { placed = it }
        // The list moved under an open row, so the row shuts.
        .then(if (slid) Modifier.shutsWhenMoved(row) else Modifier)
        .pointerInput(row, rtl) { swipeGesture(row, rtl) { position -> startsInEdge(placed, position, view, rtl, density) } }) {
        row.shownSide?.let { side ->
            val listed = if (side == RowSide.LEADING) actions.leading else actions.trailing
            SwipeButtons(row, listed, side, armed, Modifier.matchParentSize())
        }
        Box(Modifier.offset { IntOffset((row.offset * density.density).roundToInt(), 0) }
            .drawBehind { if (cardAlpha > 0f) drawRoundRect(card, alpha = cardAlpha, cornerRadius = CornerRadius(24.dp.toPx())) }
            .pointerInput(swipe) { shutsOnTap(swipe) }) { content() }
    }
}

/** What the slid row's card is filled with: iOS's `systemGray5`, read off its frames. */
@Composable
private fun rowCardColor(): Color = if (MaterialTheme.colorScheme.surface.luminance() < 0.5f) Color(0xFF2C2C2E) else Color(0xFFE5E5EA)

private fun Modifier.shutsWhenMoved(row: SlidingRow): Modifier {
    var top: Float? = null
    return onGloballyPositioned { coordinates ->
        val now = coordinates.positionInWindow().y
        val was = top
        top = now
        if (was != null && abs(now - was) > 0.5f && row.dragStart == null && !row.leaving) row.settle(RowSwipeGeometry.Rest.CLOSED)
    }
}

private fun startsInEdge(placed: LayoutCoordinates?, position: Offset, view: View, rtl: Boolean, density: Density): Boolean {
    val x = placed?.takeIf { it.isAttached }?.localToWindow(position)?.x ?: return false
    val gestures = ViewCompat.getRootWindowInsets(view)?.getInsets(WindowInsetsCompat.Type.systemGestures())
    val left = gestures?.left ?: 0
    val right = gestures?.right ?: 0
    val strip = with(density) { EDGE_STRIP.toPx() }
    return if (rtl) x >= view.width - right - strip || x < left else x < left + strip || x >= view.width - right
}

/** While a row is open, a tap on a row only shuts it, so the tap that puts the buttons away never opens a session. */
private suspend fun PointerInputScope.shutsOnTap(swipe: RowSwipeState) = awaitEachGesture {
    awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
    if (swipe.openId == null) return@awaitEachGesture
    val up = waitForUpOrCancellation(PointerEventPass.Initial) ?: return@awaitEachGesture
    up.consume()
    swipe.openId = null
}

private suspend fun PointerInputScope.swipeGesture(row: SlidingRow, rtl: Boolean, startsInEdge: (Offset) -> Boolean) = awaitEachGesture {
    val down = awaitFirstDown(requireUnconsumed = false)
    if (startsInEdge(down.position)) return@awaitEachGesture
    val slop = viewConfiguration.touchSlop
    var moved = Offset.Zero
    // Whichever of the row and the list sees its slop passed first has the touch; a drag more up or down than across is the list's.
    while (true) {
        val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: return@awaitEachGesture
        if (change.isConsumed || !change.pressed) return@awaitEachGesture
        moved += change.positionChange()
        if (abs(moved.y) > slop && abs(moved.y) >= abs(moved.x)) return@awaitEachGesture
        if (abs(moved.x) > slop && abs(moved.x) > abs(moved.y)) { change.consume(); break }
    }
    val sign = if (rtl) -1f else 1f
    val tracker = VelocityTracker()
    tracker.addPosition(down.uptimeMillis, down.position)
    var dx = (moved.x - (if (moved.x > 0) slop else -slop)) * sign
    row.began()
    row.moved(dx / density)
    while (true) {
        val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
        if (!change.pressed) break
        tracker.addPosition(change.uptimeMillis, change.position)
        dx += change.positionChange().x * sign
        change.consume()
        row.moved(dx / density)
    }
    row.ended(dx / density, tracker.calculateVelocity().x * sign / density)
}

/** One side's buttons, left to right, with the gap at either end that [RowSwipeGeometry.openWidth] counts. A side lists its actions from
 * the screen edge inward, so the trailing side lays them out reversed. */
@Composable
private fun SwipeButtons(row: SlidingRow, actions: List<RowAction>, side: RowSide, armed: Boolean, modifier: Modifier) {
    val density = LocalDensity.current
    Box(modifier, contentAlignment = if (side == RowSide.LEADING) Alignment.CenterStart else Alignment.CenterEnd) {
        Row(Modifier.padding(horizontal = RowSwipeGeometry.GAP.dp), horizontalArrangement = Arrangement.spacedBy(RowSwipeGeometry.GAP.dp), verticalAlignment = Alignment.CenterVertically) {
            (if (side == RowSide.LEADING) actions else actions.asReversed()).forEach { action ->
                key(action.title) {
                    val index = actions.indexOf(action)
                    val fullSwipeTarget = armed && side == RowSide.LEADING && index == 0
                    val reveal by remember(row, index, actions) { derivedStateOf { RowSwipeGeometry.reveal(index, row.slots(actions), abs(row.offset).toDouble()).toFloat() } }
                    // Like the system's, a button springs after the size the row's position gives it: trailing a fast pull, and overshooting as it lands whole.
                    val shown by animateFloatAsState(reveal, if (reveal >= 1f) LANDING else FOLLOWING, label = "reveal")
                    SwipeButton(action, shown, grown = fullSwipeTarget, hidden = armed && !fullSwipeTarget,
                        onWidth = { row.slotWidths[action.title] = it / density.density }) {
                        row.settle(RowSwipeGeometry.Rest.CLOSED)
                        action.perform()
                    }
                }
            }
        }
    }
}

// How a button follows the size the row's position gives it, and how it lands once whole: SwiftUI's spring(response: 0.28) and (0.3, 0.72).
private val FOLLOWING = spring<Float>(dampingRatio = 1f, stiffness = 503f)
private val LANDING = spring<Float>(dampingRatio = 0.72f, stiffness = 439f)
private val CIRCLE = 40.dp
private val TITLE = TextStyle(fontSize = 12.sp, lineHeight = 14.sp)

/** A button's face: the circle of its colour with its symbol, over its title. It dims and shrinks a touch under the finger, and fades when its action is off.
 * The circle takes the share of the row iOS's does: 40 dp of a 63.5 dp row, where iOS has 47 pt of 75.3. */
@Composable
private fun SwipeButton(action: RowAction, reveal: Float, grown: Boolean, hidden: Boolean, onWidth: (Int) -> Unit, press: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val dark = MaterialTheme.colorScheme.surface.luminance() < 0.5f
    val growth by animateFloatAsState(if (grown) 1.12f else 1f, tween(200), label = "grown")
    val neighbour by animateFloatAsState(if (hidden) 0f else 1f, tween(200), label = "neighbour")
    Column(Modifier.widthIn(min = RowSwipeGeometry.SLOT.dp)
        .onSizeChanged { onWidth(it.width) }
        .graphicsLayer {
            val size = maxOf(reveal, 0.01f) * (if (pressed) 0.94f else 1f)
            scaleX = size; scaleY = size
            alpha = neighbour * RowSwipeGeometry.revealOpacity(reveal.toDouble()).toFloat() * (if (!action.enabled) 0.4f else if (pressed) 0.7f else 1f)
        }
        .clickable(source, indication = null, enabled = action.enabled, role = Role.Button, onClick = press)
        .testTag("row-action:${action.title}"),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Box(Modifier.size(CIRCLE).graphicsLayer { scaleX = growth; scaleY = growth }
            .background(Color(if (dark) action.tint.dark else action.tint.light), CircleShape), contentAlignment = Alignment.Center) {
            Icon(painterResource(action.icon), null, Modifier.size(20.dp), tint = Color.White)
        }
        Text(action.title, style = TITLE, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
    }
}
