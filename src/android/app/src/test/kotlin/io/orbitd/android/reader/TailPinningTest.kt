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
