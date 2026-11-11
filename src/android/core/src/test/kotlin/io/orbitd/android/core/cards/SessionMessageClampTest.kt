package io.orbitd.android.core.cards

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When another session's message folds, and to what (web `SessionMessageCard`, docs/mocks/session-message-clamp/). */
class SessionMessageClampTest {
    @Test fun foldsOnlyPastTwelveLinesAndToEight() {
        assertFalse(SessionMessageClamp.folds(contentPx = 240, linePx = 20f))
        assertTrue(SessionMessageClamp.folds(contentPx = 241, linePx = 20f))
        assertFalse("no line height to read, nothing folds", SessionMessageClamp.folds(contentPx = 5000, linePx = 0f))
        assertEquals(160f, SessionMessageClamp.foldedPx(20f))
    }

    @Test fun theToggleSaysWhatItWillDo() {
        assertEquals("Show more", SessionMessageClamp.toggle(expanded = false))
        assertEquals("Show less", SessionMessageClamp.toggle(expanded = true))
    }
}
