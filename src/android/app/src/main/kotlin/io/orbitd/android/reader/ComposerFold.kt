package io.orbitd.android.reader

import android.view.View
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The composer's share of the session page (c18124ccb): none while the keyboard is up for another input — a card's form in the
 * transcript — so the form keeps the room above the keyboard; otherwise up to 65 % of the page, or all of a short one.
 *
 * The keyboard is up when Compose's IME inset says so, or when the window's own insets do (A08l, A15 F-48). Android 15's first
 * release keeps the window across `Activity.recreate()` and leaves the kept window fitting the system bars and the keyboard itself
 * (`PhoneWindow`'s preserved-window constructor applies the default decor fitting, which an edge-to-edge app can no longer turn
 * off): the content view is padded above the keyboard, Compose's IME inset stays 0, and only the window still reports it shown.
 */
internal object ComposerFold {
    fun height(maxHeight: Dp, imeBottom: Int, windowIme: Boolean, composerFocused: Boolean): Dp =
        if ((imeBottom > 0 || windowIme) && !composerFocused) 0.dp else if (maxHeight < 320.dp) maxHeight else maxHeight * 0.65f

    /** Whether [view]'s window reports the keyboard shown. Read as the page's box composes: a window that fits the keyboard itself
     * resizes the box as the keyboard comes and goes, which composes it again. */
    fun windowIme(view: View): Boolean = ViewCompat.getRootWindowInsets(view)?.isVisible(WindowInsetsCompat.Type.ime()) == true
}
