package io.orbitd.android.reader

import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlin.math.abs

/**
 * Whether a pinned transcript is carried back to its tail because the VIEWPORT changed size under it —
 * the keyboard rising over the last line, the composer growing a line, the system bars or the sticky
 * question header moving — OrbitKit's `TailPinning.followsResize` (iOS 50eb1b9b1, web's ResizeObserver).
 * Following answers "did the reader leave the tail?"; nothing re-anchors the bottom when the list itself
 * shrinks, so the last line would sit below the fold until the next message happened to re-pin it.
 * 0 is "not measured yet", which no real viewport is: an unknown is never a resize.
 */
internal object TailPinning {
    fun followsResize(wasPinned: Boolean, previousHeight: Int, currentHeight: Int): Boolean =
        wasPinned && previousHeight > 0 && currentHeight > 0 && currentHeight != previousHeight

    /** Within this far of the end the tail is still followed (OrbitKit's `nearBottom`, web's 80px). */
    val nearBottom = 80.dp
    /** Play in where the offset ends up: this far from where the geometry carried it is still the geometry's doing. */
    val slop = 2.dp
    /** Under a pixel at any density: a tail this close is in place, and no rounding reads as a gap. */
    val subpixel = 0.25.dp

    /**
     * Whether a pinned transcript is carried back to its tail because the scroll GEOMETRY changed under it while nothing was
     * moving it: rows growing under the viewport — a running agent's line arriving, a picture or a row measured again — push the
     * tail out of view with the list standing still (OrbitKit `TailPinning.followsGeometry`, iOS 900e1810d and 66c42e852). The
     * viewport's own changes are [followsResize]'s; a bar arriving over the list is one of those here, since the sticky header
     * sits above the list rather than in its inset.
     *
     * The offset may move only as far as the geometry carried it — not at all while rows grow under a still viewport. A
     * movement past [slop] is a scroll, and a scroll is never followed, whoever made it; the one other movement allowed is a
     * re-pin of this rule's own landing, which leaves the tail within [slop]. And only a tail within [nearBottom] is followed:
     * further than that the transcript was carried off by a jump or a scroll, not by its rows. A tail within [subpixel] is in place.
     */
    fun followsGeometry(pinned: Boolean, from: TailSample, to: TailSample, moving: Boolean, density: Density): Boolean = with(density) {
        val gap = to.bottomGap ?: return false
        if (!pinned || moving || gap <= subpixel.toPx() || gap > nearBottom.toPx()) return false
        if (gap == from.bottomGap) return false
        val carried = if (to.anchor == from.anchor) abs(to.anchorOffset - from.anchorOffset).toFloat() else Float.POSITIVE_INFINITY
        carried <= slop.toPx() || gap <= slop.toPx()
    }
}

/**
 * Carries a pinned [list] back to its tail whenever [TailPinning.followsGeometry] says its rows grew under it (A06-13): asked on
 * every layout. [pinned] is the reader's own pin, [moving] a scroll of the reader's own in flight; [positioning] is told while the
 * re-pin runs, so the reader's observers know it was not the person. [key] starts the readings over (another session).
 */
@Composable
internal fun FollowsTailGeometry(list: LazyListState, key: Any, pinned: () -> Boolean, moving: () -> Boolean, positioning: (Boolean) -> Unit) {
    val density by rememberUpdatedState(LocalDensity.current)
    val isPinned by rememberUpdatedState(pinned)
    val isMoving by rememberUpdatedState(moving)
    val position by rememberUpdatedState(positioning)
    val sizes = remember(key) { TailSizes() }
    LaunchedEffect(key, list) {
        var previous: TailSample? = null
        snapshotFlow { list.layoutInfo }.collect { info ->
            val sample = TailSample.of(info, sizes)
            val was = previous
            previous = sample
            if (was == null || sample == null) return@collect
            if (TailPinning.followsGeometry(isPinned(), was, sample, moving = list.isScrollInProgress || isMoving(), density)) {
                position(true)
                // A scroll that takes over (a touch, the next follow) cancels this one, not the reading that goes on.
                try { list.scrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)) }
                catch (taken: CancellationException) { currentCoroutineContext().ensureActive() }
                finally { position(false) }
            }
        }
    }
}

/**
 * One reading of the transcript list's geometry (OrbitKit `TailScrollSample`, in a lazy list's terms): the row the viewport's top
 * rests on and that row's offset — what a scroll moves and growing rows below it do not — and how far the tail row's bottom lies
 * below the viewport's content edge, 0 at the tail; null when a row between the last one drawn and the tail was never measured.
 */
internal data class TailSample(val anchor: Int, val anchorOffset: Int, val bottomGap: Int?) {
    companion object {
        fun of(info: LazyListLayoutInfo, sizes: TailSizes): TailSample? {
            val visible = info.visibleItemsInfo
            val first = visible.firstOrNull() ?: return null
            sizes.measured(info.totalItemsCount, visible)
            val last = visible.last()
            // Rows a push carried past the bottom edge are no longer drawn: they count at the heights they last had.
            var bottom = last.offset + last.size
            for (index in last.index + 1 until info.totalItemsCount) bottom += info.mainAxisItemSpacing + (sizes[index] ?: return TailSample(first.index, first.offset, null))
            return TailSample(first.index, first.offset, bottom - (info.viewportEndOffset - info.afterContentPadding))
        }
    }
}

/** Each row's last measured height by its place in the list, forgotten once the rows change in number. */
internal class TailSizes {
    private var count = -1
    private val sizes = HashMap<Int, Int>()
    fun measured(total: Int, visible: List<LazyListItemInfo>) {
        if (total != count) { sizes.clear(); count = total }
        visible.forEach { sizes[it.index] = it.size }
    }
    operator fun get(index: Int): Int? = sizes[index]
}

/** The transcript viewport's last measured height, asked on every measure whether a pinned reader must follow it. */
internal class TranscriptViewport {
    private var height = 0
    fun resized(next: Int, pinned: Boolean): Boolean {
        val previous = height
        height = next
        return TailPinning.followsResize(pinned, previous, next)
    }
}

/** The in-list card rail's last height. A card arrives whole and at any height, so a rail that grows under a pinned reader asks for
 * the tail again, as a publish does on iOS (`stateRevision`); the geometry rule above keeps to its slack. */
internal class RailHeight {
    private var height = 0
    fun grew(next: Int): Boolean = (next > height).also { height = next }
}
