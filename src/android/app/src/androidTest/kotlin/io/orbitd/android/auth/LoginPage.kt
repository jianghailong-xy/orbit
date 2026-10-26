package io.orbitd.android.auth

import android.content.res.Configuration
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performCustomAccessibilityActionWithLabel
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage

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

/** Presses the login page's Sign In once the keyboard its fields asked for is up ([awaitKeyboardForSignIn]). */
fun ComposeTestRule.pressSignIn() {
    awaitKeyboardForSignIn()
    onNodeWithText("Sign In").performScrollTo().performClick()
}

/**
 * Waits, up to 15 s, for the soft keyboard the typed fields asked for (A15 F-24/F-33, A05j). A person types on it, so it is up
 * before Sign In; text set through semantics is not. Pressed before the first keyboard since a boot is up, Sign In's hide is
 * dropped on Android 11–13 and the keyboard comes up over the next page with nothing focused. A device that keeps the soft
 * keyboard down — a hardware keyboard exposed and show_ime_with_hard_keyboard off, as on the API 36 AVD — is not waited on.
 */
fun ComposeTestRule.awaitKeyboardForSignIn() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    val config = context.resources.configuration
    // Read as the app reads it, not through the shell: a UiAutomation taken without flags turns TalkBack off.
    if (config.keyboard != Configuration.KEYBOARD_NOKEYS && config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO &&
        Settings.Secure.getInt(context.contentResolver, "show_ime_with_hard_keyboard", 0) == 0) {
        Log.i("OrbitSignIn", "keyboard before Sign In: not waited for, a hardware keyboard keeps it down")
        return
    }
    fun shown(): Boolean {
        var up = false
        instrumentation.runOnMainSync {
            up = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .any { ViewCompat.getRootWindowInsets(it.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true }
        }
        return up
    }
    val start = SystemClock.uptimeMillis()
    val up = runCatching { waitUntil(15_000) { shown() } }.isSuccess
    Log.i("OrbitSignIn", "keyboard before Sign In: up=$up after ${SystemClock.uptimeMillis() - start} ms")
}
