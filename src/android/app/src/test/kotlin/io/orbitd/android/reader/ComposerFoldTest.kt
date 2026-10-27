package io.orbitd.android.reader

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A08l (A15 F-48): the composer gives a card's form the page while the keyboard is up for it, wherever the keyboard is reported.
 * The numbers are the session page's at 360x640 dp, read on API 35 and 36 emulators with the x1 card's "Mark this item as
 * handled?" form focused: 253 dp above a 598 px keyboard, 528 dp without one.
 */
class ComposerFoldTest {
    @Test fun aCardFormKeepsThePageWhileItsKeyboardIsUp() {
        assertEquals("API 36, and API 35 in the window it started with: Compose's inset says so",
            0.dp, ComposerFold.height(253.dp, imeBottom = 598, windowIme = true, composerFocused = false))
        assertEquals("API 35 after Activity.recreate: the window fits the keyboard itself, Compose's inset stays 0",
            0.dp, ComposerFold.height(253.dp, imeBottom = 0, windowIme = true, composerFocused = false))
    }

    @Test fun theComposersOwnKeyboardKeepsTheComposer() {
        assertEquals(253.dp, ComposerFold.height(253.dp, imeBottom = 598, windowIme = true, composerFocused = true))
        assertEquals(253.dp, ComposerFold.height(253.dp, imeBottom = 0, windowIme = true, composerFocused = true))
        assertEquals(400.dp * 0.65f, ComposerFold.height(400.dp, imeBottom = 0, windowIme = true, composerFocused = true))
    }

    @Test fun withNoKeyboardTheComposerTakesItsShare() {
        assertEquals(528.dp * 0.65f, ComposerFold.height(528.dp, imeBottom = 0, windowIme = false, composerFocused = false))
        assertEquals(528.dp * 0.65f, ComposerFold.height(528.dp, imeBottom = 0, windowIme = false, composerFocused = true))
        assertEquals("a short page is all the composer's", 300.dp, ComposerFold.height(300.dp, imeBottom = 0, windowIme = false, composerFocused = false))
    }
}
