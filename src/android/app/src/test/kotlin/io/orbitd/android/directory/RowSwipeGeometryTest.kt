package io.orbitd.android.directory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** OrbitKit's RowSwipeGeometryTests, case for case: the Android row moves by the same numbers, in dp where iOS has points. */
class RowSwipeGeometryTest {
    /** An Open-tab session row on a 393-wide phone: Complete and Pin on the leading side, Delete on the trailing one, and a full swipe
     * right completes. */
    private val open = RowSwipeGeometry(leadingWidth = 150.0, trailingWidth = 80.0, rowWidth = 393.0, leadingFullSwipe = true)

    @Test fun theSlotsAreTheSystemsOwn() {
        assertEquals(150.0, RowSwipeGeometry.openWidth(listOf(60.0, 60.0)), 0.0)
        assertEquals(80.0, RowSwipeGeometry.openWidth(listOf(60.0)), 0.0)
        // A third button costs a slot and a gap.
        assertEquals(220.0, RowSwipeGeometry.openWidth(listOf(60.0, 60.0, 60.0)), 0.0)
        // A title wider than the slot widens only its own.
        assertEquals(174.0, RowSwipeGeometry.openWidth(listOf(84.0, 60.0)), 0.0)
        assertEquals(0.0, RowSwipeGeometry.openWidth(emptyList()), 0.0)
    }

    @Test fun theRowFollowsTheFingerUpToEachSide() {
        assertEquals(0.0, open.dragged(0.0), 0.0)
        assertEquals(120.0, open.dragged(120.0), 0.0)
        assertEquals(-80.0, open.dragged(-80.0), 0.0)
    }

    @Test fun pastTheButtonsTheRowGivesGrudgingly() {
        // Delete has no full swipe: 20 past it moves the row 6.
        assertEquals(-86.0, open.dragged(-100.0), 1e-9)
        val noFull = RowSwipeGeometry(150.0, 80.0, 393.0, leadingFullSwipe = false)
        assertEquals(165.0, noFull.dragged(200.0), 1e-9)
        // A side with no buttons at all gives only that little.
        val leadingOnly = RowSwipeGeometry(150.0, 0.0, 393.0, leadingFullSwipe = true)
        assertEquals(-12.0, leadingOnly.dragged(-40.0), 1e-9)
    }

    @Test fun aFullSwipeFollowsTheFingerAndCompletes() {
        assertEquals(300.0, open.dragged(300.0), 0.0)
        // Over halfway across the row: 0.6 × 393.
        assertEquals(235.8, open.fullSwipePoint, 1e-9)
        assertFalse(open.isFullSwipe(230.0))
        assertTrue(open.isFullSwipe(240.0))
        assertEquals(RowSwipeGeometry.Rest.FULL_SWIPE, open.rest(240.0, 0.0))
        assertEquals(393.0, open.offset(RowSwipeGeometry.Rest.FULL_SWIPE), 0.0)
    }

    @Test fun aNarrowRowStillNeedsASlotPastTheButtons() {
        assertEquals(210.0, RowSwipeGeometry(150.0, 80.0, 300.0, true).fullSwipePoint, 0.0)
    }

    @Test fun withoutAFullSwipeALongSwipeJustOpens() {
        val noFull = RowSwipeGeometry(150.0, 80.0, 393.0, leadingFullSwipe = false)
        assertFalse(noFull.isFullSwipe(300.0))
        assertEquals(RowSwipeGeometry.Rest.LEADING, noFull.rest(165.0, 0.0))
    }

    @Test fun aLetGoRowOpensPastHalfway() {
        assertEquals(RowSwipeGeometry.Rest.LEADING, open.rest(80.0, 0.0))
        assertEquals(RowSwipeGeometry.Rest.CLOSED, open.rest(70.0, 0.0))
        assertEquals(RowSwipeGeometry.Rest.TRAILING, open.rest(-50.0, 0.0))
        assertEquals(RowSwipeGeometry.Rest.CLOSED, open.rest(-30.0, 0.0))
    }

    @Test fun aFlickDecidesByItsDirection() {
        assertEquals(RowSwipeGeometry.Rest.LEADING, open.rest(20.0, 800.0))
        assertEquals(RowSwipeGeometry.Rest.CLOSED, open.rest(140.0, -800.0))
        assertEquals(RowSwipeGeometry.Rest.TRAILING, open.rest(-20.0, -800.0))
        assertEquals(RowSwipeGeometry.Rest.CLOSED, open.rest(-75.0, 800.0))
    }

    @Test fun aSideWithoutButtonsNeverOpens() {
        val leadingOnly = RowSwipeGeometry(150.0, 0.0, 393.0, leadingFullSwipe = true)
        assertEquals(RowSwipeGeometry.Rest.CLOSED, leadingOnly.rest(-12.0, -800.0))
        assertEquals(RowSwipeGeometry.Rest.CLOSED, open.rest(0.0, 0.0))
    }

    @Test fun aLoneButtonGrowsInOverItsLastThirty() {
        val delete = listOf(60.0)
        assertEquals(0.0, RowSwipeGeometry.reveal(0, delete, 50.0), 0.0)
        assertEquals(0.2, RowSwipeGeometry.reveal(0, delete, 56.0), 1e-9)
        assertEquals(0.5, RowSwipeGeometry.reveal(0, delete, 65.0), 1e-9)
        assertEquals(1.0, RowSwipeGeometry.reveal(0, delete, 80.0), 0.0)
        // Pulled on past its slot, it stays whole.
        assertEquals(1.0, RowSwipeGeometry.reveal(0, delete, 140.0), 0.0)
    }

    @Test fun buttonsGrowInFromTheEdgeInward() {
        val leading = listOf(60.0, 60.0)
        assertEquals(1.0, RowSwipeGeometry.reveal(0, leading, 103.0), 0.0)
        assertEquals(0.0, RowSwipeGeometry.reveal(1, leading, 103.0), 0.0)
        assertEquals(0.5, RowSwipeGeometry.reveal(1, leading, 135.0), 1e-9)
        assertEquals(1.0, RowSwipeGeometry.reveal(1, leading, 150.0), 0.0)
        // A wide slot pushes the next one's start out with it.
        assertEquals(0.2, RowSwipeGeometry.reveal(1, listOf(84.0, 60.0), 150.0), 1e-9)
        assertEquals("no third button", 0.0, RowSwipeGeometry.reveal(2, leading, 150.0), 0.0)
    }

    @Test fun aButtonFadesInAheadOfItsSize() {
        assertEquals(0.0, RowSwipeGeometry.revealOpacity(0.0), 0.0)
        assertEquals(0.32, RowSwipeGeometry.revealOpacity(0.2), 1e-9)
        assertEquals(1.0, RowSwipeGeometry.revealOpacity(1.0), 0.0)
    }

    @Test fun eachRestHasItsOffset() {
        assertEquals(0.0, open.offset(RowSwipeGeometry.Rest.CLOSED), 0.0)
        assertEquals(150.0, open.offset(RowSwipeGeometry.Rest.LEADING), 0.0)
        assertEquals(-80.0, open.offset(RowSwipeGeometry.Rest.TRAILING), 0.0)
    }
}
