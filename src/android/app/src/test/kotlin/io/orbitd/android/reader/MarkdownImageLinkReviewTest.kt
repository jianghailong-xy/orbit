package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.text.MarkdownText
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class MarkdownImageLinkReviewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val source = "orbit-attachment:01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private fun exercise(destination: String?) {
        val opened = mutableListOf<String>()
        val image = "![preview]($source)"
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
            MarkdownText(if (destination == null) image else "[$image]($destination)", open = opened::add)
        } } }
        if (destination != null) {
            compose.onNodeWithText("Open link").assertIsDisplayed().performClick()
            assertEquals(listOf(destination), opened)
        } else compose.onNodeWithText("Open link").assertDoesNotExist()
        compose.onNodeWithText("Open image").performClick()
        assertEquals(if (destination == null) listOf(source) else listOf(destination, source), opened)
    }
    @Test fun linkedImageOpensItsOrbitDestination() = exercise("orbit-task:01a0cca7-8609-70ed-a0e2-d4b55b832b61")
    @Test fun linkedImageOpensItsHttpsDestination() = exercise("https://example.test/related")
    @Test fun unlinkedImageStillOpensOnlyItsSource() = exercise(null)
}
