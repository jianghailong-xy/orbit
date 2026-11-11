package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.SessionMessageClamp
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Another session's words under its card (web SessionMessageCard.clamp.test.tsx, design docs/mocks/session-message-clamp/): whole when
 * short, their first lines and "Show more" when long, whole again on "Show more", folded again on "Show less", and opened by a record a
 * link landed on.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class SessionMessageBodyTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val short = "The landing on criterion 3 needs a merge decision."
    private val long = (1..60).joinToString("\n\n") { "Line $it of the 0.1.252 runner release plan." }

    private fun show(words: String, revealed: Boolean = false) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { SessionMessageBody(words, open = {}, revealed = revealed) } } }
        compose.waitForIdle()
    }

    @Test fun aShortMessageShowsWholeWithNoToggle() {
        show(short)
        compose.onNodeWithTag("session-message:whole").assertExists()
        compose.onAllNodesWithTag("session-message:toggle").assertCountEquals(0)
    }

    @Test fun aLongMessageFoldsOpensAndFoldsAgain() {
        show(long)
        compose.onNodeWithTag("session-message:clamped").assertExists()
        compose.onNodeWithText(SessionMessageClamp.SHOW_MORE).assertIsDisplayed().performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithTag("session-message:whole").assertExists()
        // Opened, sixty lines run past the screen: press the toggle by its action, not by a tap where nothing is drawn.
        compose.onNodeWithText(SessionMessageClamp.SHOW_LESS).assertExists().performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithTag("session-message:clamped").assertExists()
    }

    @Test fun aRecordLandingInItOpensIt() {
        show(long, revealed = true)
        compose.onNodeWithTag("session-message:whole").assertExists()
        compose.onNodeWithText(SessionMessageClamp.SHOW_LESS).assertExists()
    }
}
