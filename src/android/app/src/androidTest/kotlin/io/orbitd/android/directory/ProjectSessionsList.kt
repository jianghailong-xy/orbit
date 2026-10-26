package io.orbitd.android.directory

import android.os.SystemClock
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToNode

/**
 * Whether the project's sessions page lists [matcher], scrolled to it. The page is a lazy list: on a 360×640 dp phone it composes
 * only the rows on screen, so a row below the fold exists for a test only once the list is scrolled to it.
 */
fun ComposeTestRule.listed(matcher: SemanticsMatcher) =
    try { onNodeWithTag("project-sessions-list").performScrollToNode(matcher); true } catch (_: AssertionError) { false }

/** Scrolls the project's sessions page to [matcher] once a read draws it. */
fun ComposeTestRule.awaitListed(matcher: SemanticsMatcher, timeoutMillis: Long = 30_000) {
    val deadline = SystemClock.uptimeMillis() + timeoutMillis
    while (!listed(matcher)) {
        if (SystemClock.uptimeMillis() > deadline) throw AssertionError("The project's sessions page never listed $matcher")
        SystemClock.sleep(250); waitForIdle()
    }
}
