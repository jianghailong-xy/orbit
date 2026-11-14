package io.orbitd.android

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction

/** A list row's menu is its long press, as on iOS: what a screen reader is offered by this name. */
internal fun hasRowMenu(name: String, substring: Boolean = false) = SemanticsMatcher("offers the row menu \"$name\"") { node ->
    node.config.getOrNull(SemanticsActions.OnLongClick)?.label?.let { if (substring) name in it else it == name } == true
}

internal fun SemanticsNodeInteraction.openRowMenu() = performSemanticsAction(SemanticsActions.OnLongClick)

/** A press on one of the rows of the list's ≡. */
internal fun SemanticsNodeInteractionsProvider.pickFromSessionOptions(row: String) {
    onNode(hasContentDescription("Session scope", substring = true)).performClick()
    onNode(hasText(row) and hasAnyAncestor(isPopup())).performClick()
}

/** A workspace's list from the drawer: a launch lands on the one used last, else the first. */
internal fun SemanticsNodeInteractionsProvider.openWorkspaceInDrawer(name: String) {
    onAllNodes(hasContentDescription("Open navigation")).onFirst().performClick()
    onNode(hasText(name) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).performScrollTo().performClick()
}

/** The list bar's ✎, once the list is there. */
internal fun ComposeTestRule.startNewSession(timeoutMs: Long = 30_000) {
    val button = hasContentDescription("Start a new session", substring = true)
    waitUntil(timeoutMs) { onAllNodes(button).fetchSemanticsNodes().isNotEmpty() }
    onNode(button).performClick()
}

/** A project's sessions page off its row in the list. The row's tap opens the coordinator's conversation (owner 2026-11-11,
 * docs/mocks/project-sessions-column board 5); its menu's Sessions still opens the page, which is what a test of the page's own
 * content wants. */
internal fun ComposeTestRule.openProjectSessionsPage(projectId: String) {
    onNodeWithTag("project-row:$projectId").openRowMenu()
    val sessions = hasText("Sessions") and hasAnyAncestor(isDialog())
    waitUntil(60_000) { onAllNodes(sessions).fetchSemanticsNodes().isNotEmpty() }
    onNode(sessions).performClick()
}
