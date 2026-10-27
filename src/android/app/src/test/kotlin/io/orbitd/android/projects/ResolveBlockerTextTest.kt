package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A15 F-44: "Review this blocker" with the keyboard up. On a 360×640 dp phone running Android 11 the dialog's window is laid out
 * above the keyboard and its words and reason field get about 272×90 dp — given here as that box, since a Robolectric dialog window
 * shorter than its content never settles. The field keeps its own height in that room, comes into view to be typed in, and takes
 * what is typed. Unscrolled it was measured to nothing (the A15 device frames: no field, typing landing out of sight). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class ResolveBlockerTextTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val blocker = Json.parseToJsonElement("""{"id":"blk1","kind":"DELIVERY_REVIEW","owner":"USER","severity":"WARNING",
        "requiredAction":"Review the files this delivery changed outside its declared scope.","subjectTitle":"A11 project delivery",
        "detail":{"reason":"OUTSIDE_DECLARED_SCOPE","paths":["src/android/app/build.gradle.kts"]}}""").jsonObject

    @Test fun theReasonFieldKeepsItsHeightAndComesIntoViewInTheRoomAboveTheKeyboard() {
        val reason = mutableStateOf("")
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Box(Modifier.size(272.dp, 90.dp)) { ResolveBlockerText(blocker, reason.value) { reason.value = it } }
        } } }
        val field = compose.onNodeWithTag("blocker-reason")
        field.assertHeightIsAtLeast(48.dp)
        // A person scrolls the words up to the field and taps it.
        field.performScrollTo().performClick()
        field.assertIsFocused().assertIsDisplayed()
        field.performTextInput("Both files belong to the shell change")
        assertEquals("Both files belong to the shell change", reason.value)
        // The words are still there to read, above it.
        compose.onNodeWithText("Files this blocker names", substring = true).performScrollTo().assertIsDisplayed()
    }
}
