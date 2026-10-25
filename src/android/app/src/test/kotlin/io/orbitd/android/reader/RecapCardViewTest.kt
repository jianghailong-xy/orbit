package io.orbitd.android.reader

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.directory.RecapCard
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The conversation's Recap card as it is drawn (iOS `RecapCardView`): its head says the word and when the recap was written, its
 * body the recap whole, and its refresh — named for TalkBack — asks once and cannot be pressed again while it is asking. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class RecapCardViewTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val card = RecapCard("Research done: integrate Copilot CLI first.", "Sat, Oct 17, 1:44 PM")

    @Test fun theCardSaysTheRecapWholeAndWhenItWasWritten() {
        var asked = 0
        compose.setContent { OrbitTheme { RecapCardView(card, refreshing = false) { asked++ } } }
        compose.onNodeWithTag("recap-card-head", useUnmergedTree = true).assertTextEquals("Recap · Sat, Oct 17, 1:44 PM")
        compose.onNodeWithTag("recap-card-text", useUnmergedTree = true).assertTextEquals("Research done: integrate Copilot CLI first.")
        compose.onNodeWithContentDescription("Refresh recap").performClick()
        assertEquals(1, asked)
    }

    @Test fun aRecapWithNoTimeSaysTheWordAloneAndARefreshInFlightCannotBePressedAgain() {
        compose.setContent { OrbitTheme { RecapCardView(card.copy(whenWritten = null), refreshing = true) {} } }
        compose.onNodeWithTag("recap-card-head", useUnmergedTree = true).assertTextEquals("Recap")
        compose.onNodeWithTag("recap-refresh").assertIsNotEnabled()
    }
}
