package io.orbitd.android.auth

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performTextReplacement

/**
 * The login page keeps its server behind the logo (iOS fdeb033ad): the logo's "Change server" action opens the Server dialog,
 * the address replaces the one there, and Save keeps it. Device journeys sign in through it as a person does.
 */
@OptIn(ExperimentalTestApi::class)
fun ComposeTestRule.chooseServer(address: String) {
    waitUntil(10_000) { onAllNodesWithContentDescription("Orbit").fetchSemanticsNodes().isNotEmpty() }
    onNodeWithContentDescription("Orbit").performCustomAccessibilityActionWithLabel("Change server")
    onNodeWithText("Server address").performTextReplacement(address)
    onNodeWithText("Save").performClick()
    waitUntil(10_000) { onAllNodesWithText("Server address").fetchSemanticsNodes().isEmpty() }
}
