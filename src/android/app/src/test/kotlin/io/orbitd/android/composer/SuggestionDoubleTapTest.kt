package io.orbitd.android.composer

import androidx.activity.compose.setContent
import androidx.compose.material3.OutlinedTextField
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The engine's guess in the empty box on a touch screen (docs/prompt-suggestions-design.md §4.3, §9 补充二): no Use button, a
 * double-tap on the field takes it, and "Double-tap to use" follows the words until that has worked once on this device. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class SuggestionDoubleTapTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun theHintFollowsTheWordsUntilLearnedAndTalkBackSkipsIt() {
        var learned by mutableStateOf(false)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) { SuggestionPlaceholder("run the tests", showsHint = !learned) } } }
        compose.waitForIdle()
        compose.onNodeWithText("run the tests").assertExists()
        compose.onNodeWithTag("composer-suggestion-hint", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithText("Double-tap to use", useUnmergedTree = true).assertCountEquals(0)
        learned = true
        compose.waitForIdle()
        compose.onAllNodesWithTag("composer-suggestion-hint", useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithText("run the tests").assertExists()
    }

    private var value by mutableStateOf("")
    private var focused by mutableStateOf(false)
    private var uses = 0
    private var focusesHandedOn = 0
    private val focus = FocusRequester()

    private fun field(enabled: Boolean = true) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            OutlinedTextField(value, { value = it }, Modifier.testTag("field").focusRequester(focus)
                .onFocusChanged { focused = it.isFocused }
                .doubleTapToUse(enabled, focused, { focusesHandedOn++ }, { uses++; value = "run the tests" }))
        } } }
        compose.waitForIdle()
    }

    @Test fun aDoubleTapOnTheIdleFieldTakesItWithoutTheFieldEverTakingTheFirstTap() {
        field()
        compose.onNodeWithTag("field").performTouchInput { doubleClick() }
        compose.waitForIdle()
        assertEquals(1, uses)
        assertEquals("run the tests", value)
        assertEquals("the first tap was held, so nothing was handed on", 0, focusesHandedOn)
        compose.onNodeWithTag("field").assertIsNotFocused()
    }

    @Test fun aSingleTapOnTheIdleFieldIsHandedOnOnceTheDoubleTapTimeoutPasses() {
        field()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithTag("field").performTouchInput { click() }
        compose.mainClock.advanceTimeBy(100)
        compose.onNodeWithTag("field").assertIsNotFocused()
        assertEquals("still inside the double-tap window", 0, focusesHandedOn)
        compose.mainClock.advanceTimeBy(400)
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertEquals(1, focusesHandedOn)
        assertEquals(0, uses)
        assertEquals("", value)
    }

    @Test fun aFocusedFieldKeepsItsFirstTapAndADoubleTapStillTakesIt() {
        field()
        compose.runOnUiThread { focus.requestFocus() }
        compose.waitForIdle()
        compose.onNodeWithTag("field").assertIsFocused()
        compose.onNodeWithTag("field").performTouchInput { doubleClick() }
        compose.waitForIdle()
        assertEquals(1, uses)
        assertEquals(0, focusesHandedOn)
        compose.onNodeWithTag("field").assertIsFocused()
    }

    @Test fun withNoGuessTheFieldsTapsAreItsOwn() {
        field(enabled = false)
        compose.onNodeWithTag("field").performTouchInput { doubleClick() }
        compose.waitForIdle()
        assertEquals(0, uses)
        assertEquals(0, focusesHandedOn)
        compose.onNodeWithTag("field").assertIsFocused()
    }
}
