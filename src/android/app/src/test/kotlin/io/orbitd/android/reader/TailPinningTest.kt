package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A06-5 (iOS 50eb1b9b1): a reader at the bottom stays at the bottom when the viewport itself changes size. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class TailPinningTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    /** OrbitKit's TailPinningTests for `followsResize`. */
    @Test fun aPinnedTranscriptFollowsAnyResizeAndAnUnpinnedOneNone() {
        assertTrue("the keyboard rising", TailPinning.followsResize(true, 900, 600))
        assertTrue("the composer growing a line", TailPinning.followsResize(true, 600, 578))
        assertTrue("the chrome folding away", TailPinning.followsResize(true, 600, 700))
        assertFalse("a reader away from the tail keeps their place", TailPinning.followsResize(false, 900, 600))
        assertFalse("no change is no resize", TailPinning.followsResize(true, 600, 600))
        assertFalse("not measured yet is never a resize", TailPinning.followsResize(true, 0, 600))
        assertFalse(TailPinning.followsResize(true, 600, 0))
        val viewport = TranscriptViewport()
        assertFalse("the first measure only records", viewport.resized(800, true))
        assertTrue(viewport.resized(500, true))
        assertFalse(viewport.resized(500, true))
        assertFalse(viewport.resized(800, false))
        assertTrue(viewport.resized(700, true))
    }

    // A06-13: OrbitKit's TailPinningTests for `followsGeometry` (iOS 900e1810d, 66c42e852), in a lazy list's terms: the row the
    // viewport's top rests on, its offset, and how far the tail lies below the viewport. Density 1, so a pixel is a dp.
    private val one = androidx.compose.ui.unit.Density(1f)
    private val atTail = TailSample(anchor = 40, anchorOffset = -20, bottomGap = 0)
    private fun follows(to: TailSample, from: TailSample = atTail, pinned: Boolean = true, moving: Boolean = false,
        density: androidx.compose.ui.unit.Density = one) = TailPinning.followsGeometry(pinned, from, to, moving, density)

    @Test fun rowsGrowingUnderAPinnedTranscriptAreFollowed() {
        // A running agent's line arriving, a picture measured: the content grows under a viewport that did not move.
        assertTrue(follows(TailSample(40, -20, 44)))
        assertTrue("the last pixels of a push are followed to the point", follows(TailSample(40, -20, 2)))
        assertTrue("a pixel short is short at any density", follows(TailSample(40, -20, 1), density = androidx.compose.ui.unit.Density(3f)))
    }

    @Test fun aGeometryChangeThatLeftTheTailInPlaceAsksForNothing() {
        // A follow on the same change already landed: nothing is out of view, so nothing is asked.
        assertFalse(follows(TailSample(42, -5, 0)))
        assertFalse("nothing moved the tail", follows(TailSample(40, -20, 30), from = TailSample(40, -20, 30)))
    }

    @Test fun theRulesOwnRepinLandingWithTheNextFrameIsStillFollowed() =
        assertTrue(follows(TailSample(41, -7, 2), from = TailSample(40, -20, 11)))

    @Test fun aReaderAwayFromTheTailIsNotCarriedBack() {
        assertFalse("un-pinned", follows(TailSample(40, -20, 44), pinned = false))
        assertFalse("a finger on the list, or its coast", follows(TailSample(40, -20, 44), moving = true))
    }

    @Test fun aScrollIsNeverFollowed() {
        // Inside the slack, a reader 40 up — the offset moved by more than the geometry carried, and that is a scroll.
        assertFalse(follows(TailSample(40, 20, 40)))
        assertFalse("a scroll that uncovered a row measured in the same reading", follows(TailSample(40, 16, 40)))
        assertFalse("a scroll onto another row", follows(TailSample(39, -300, 40)))
    }

    @Test fun onlyATailWithinTheSlackIsFollowed() {
        // Further than 80 the transcript was carried off by a jump or a scroll; a card arriving whole follows by the rail's size.
        assertTrue(follows(TailSample(40, -20, 80)))
        assertFalse(follows(TailSample(40, -20, 81)))
        assertFalse(follows(TailSample(40, -20, 424)))
        assertFalse("a tail whose rows were never measured", follows(TailSample(40, -20, null)))
    }

    @Test fun theRailFollowsOnlyWhenItGrows() {
        val rail = RailHeight()
        assertFalse("no card yet", rail.grew(0))
        assertTrue("a card arrived", rail.grew(280))
        assertFalse(rail.grew(280))
        assertFalse("answered and gone", rail.grew(0))
        assertTrue(rail.grew(120))
    }

    /**
     * The follower SessionReader runs (A06-13): a row that grows under a pinned, still list is followed back to the tail; one
     * that grows past the 80 dp slack, or under a reader who is not pinned, leaves the list where it is.
     */
    @Test fun rowsThatGrowUnderAPinnedListAreFollowedBackToTheTail() {
        val heights = mutableStateMapOf<Int, androidx.compose.ui.unit.Dp>()
        var pinned by mutableStateOf(true)
        lateinit var list: androidx.compose.foundation.lazy.LazyListState
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
            list = rememberLazyListState(initialFirstVisibleItemIndex = 60)
            var positioning by remember { mutableStateOf(false) }
            FollowsTailGeometry(list, Unit, pinned = { pinned }, moving = { positioning }) { positioning = it }
            LazyColumn(Modifier.height(600.dp), state = list, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                items((1..60).toList(), key = { it }) { Text("Message $it", Modifier.height(heights[it] ?: 64.dp)) }
                item(key = "tail") { Spacer(Modifier.fillMaxWidth().height(21.dp)) }
            }
        } } }
        /** How far the tail lies below the viewport's bottom, in dp, read off the last message (the 21 dp tail under it may be
         * pushed out of view whole); MAX when the last message is not drawn either. */
        fun gap(): Float {
            var gap = Float.MAX_VALUE
            compose.runOnIdle {
                val info = list.layoutInfo
                info.visibleItemsInfo.firstOrNull { it.key == 60 }?.let { last ->
                    gap = (last.offset + last.size + info.mainAxisItemSpacing - (info.viewportEndOffset - info.afterContentPadding)) /
                        compose.density.density + 21f
                }
            }
            return gap
        }
        compose.waitForIdle()
        assertEquals("opened at the tail", 0f, gap(), 0.5f)
        compose.runOnIdle { heights[59] = 104.dp }
        compose.waitForIdle()
        assertEquals("a row that grew 40 dp is followed back to the tail", 0f, gap(), 0.5f)
        compose.runOnIdle { heights[58] = 264.dp }
        compose.waitForIdle()
        assertTrue("a push past the slack is left alone: ${gap()}", gap() > 80f)
        compose.runOnIdle { list.requestScrollToItem(60) }
        compose.waitForIdle()
        assertEquals(0f, gap(), 0.5f)
        compose.runOnIdle { pinned = false; heights[57] = 104.dp }
        compose.waitForIdle()
        assertEquals("a reader who is not pinned stays where they are", 40f, gap(), 0.5f)
    }

    /** The same wiring SessionReader uses: the list's own measure asks, and a pinned reader is put back on the tail. */
    @Test fun theLastLineStaysInViewWhenTheListShrinksUnderAPinnedReader() {
        var height by mutableStateOf(700.dp)
        var pinned by mutableStateOf(true)
        lateinit var list: androidx.compose.foundation.lazy.LazyListState
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
            list = rememberLazyListState(initialFirstVisibleItemIndex = 59)
            val viewport = remember { TranscriptViewport() }
            var repin by remember { mutableIntStateOf(0) }
            LaunchedEffect(repin) { if (repin > 0) list.scrollToItem(list.layoutInfo.totalItemsCount - 1) }
            Column(Modifier.height(height)) {
                LazyColumn(Modifier.weight(1f).testTag("transcript-list").onSizeChanged { if (viewport.resized(it.height, pinned)) repin++ }, state = list) {
                    items((1..60).toList(), key = { it }) { Text("Message $it", Modifier.height(64.dp)) }
                }
            }
        } } }
        fun lastVisible(): Any? { var key: Any? = null; compose.runOnIdle { key = list.layoutInfo.visibleItemsInfo.last { it.offset + it.size <= list.layoutInfo.viewportEndOffset }.key }; return key }
        compose.waitForIdle()
        assertEquals(60, lastVisible())
        compose.runOnIdle { height = 300.dp }
        compose.waitForIdle()
        assertEquals("the keyboard rose over a pinned reader: the tail follows", 60, lastVisible())
        compose.runOnIdle { pinned = false; height = 200.dp }
        compose.waitForIdle()
        assertNotEquals("a reader away from the tail keeps their place", 60, lastVisible())
    }
}
