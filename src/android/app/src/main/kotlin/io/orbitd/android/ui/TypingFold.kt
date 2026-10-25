package io.orbitd.android.ui

import androidx.compose.foundation.layout.height
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp

/**
 * A card while a phone's composer holds the keyboard (iOS `ConsoleView.TypingFold`): folded to no height, not
 * removed, so an open list, the branch bar's sheet host and a "View tasks ›" press made meanwhile all keep their
 * state, and the cards come back as they were when the keyboard goes. A wide page never folds.
 */
internal fun Modifier.typingFold(folded: Boolean): Modifier =
    if (!folded) this else height(0.dp).clipToBounds().clearAndSetSemantics { }
