package io.orbitd.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class MainActivityTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun launcherDisplaysTheShell() {
        compose.onNodeWithText("Orbit Android").assertIsDisplayed()
        compose.onNodeWithText("Android foundation").assertIsDisplayed()
    }

    @Test
    fun buildInformationShowsTheInstalledIdentityAndReturnsHome() {
        compose.onNodeWithText("Build information").performClick()

        compose.onNodeWithText(BuildConfig.APPLICATION_ID).assertIsDisplayed()
        compose.onNodeWithText(BuildConfig.SOURCE_SHA).assertIsDisplayed()
        compose.onNodeWithText(if (BuildConfig.SOURCE_DIRTY) "modified" else "clean").assertIsDisplayed()

        compose.onNodeWithText("Back").performClick()
        compose.onNodeWithText("Android foundation").assertIsDisplayed()
    }

    @Test
    fun recreationPreservesTheNavigationDestination() {
        compose.onNodeWithText("Build information").performClick()

        compose.activityRule.scenario.recreate()

        compose.onNodeWithText(BuildConfig.APPLICATION_ID).assertIsDisplayed()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.onNodeWithText("Android foundation").assertIsDisplayed()
    }
}
