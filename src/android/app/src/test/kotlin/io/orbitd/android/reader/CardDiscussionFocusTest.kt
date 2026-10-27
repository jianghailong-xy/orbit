package io.orbitd.android.reader

import android.view.View
import android.view.inputmethod.InputMethodManager
import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellApplication
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.cards.CardPreviews
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowViewRootImpl

/**
 * A08i (A15b's API 36 finding): "Chat about this" in a card's review hands the question to the composer and closes the review, and
 * the composer takes the typing once the review has gone. On a device the review's sheet holds the window focus until it is gone,
 * and a keyboard asked for from a window without focus is dropped — here, as on API 29, by `SoftwareKeyboardControllerCompat`, which
 * shows nothing for a view whose window has no focus. Robolectric moves no window focus between windows, so the test does what the
 * platform does: the page's window loses it while the sheet is up and gets it back after the sheet has gone.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp")
class CardDiscussionFocusTest : ComposerShellTest() {
    private val project = "34A08iChatAboutProjct1"

    @Test fun chatAboutThisInAReviewFocusesTheComposerOnceTheReviewHasGone() {
        ComposerShell.session = mapOf("projectId" to JsonPrimitive(project))
        ComposerShell.answers["GET projects/$project"] = { ok("""{"id":"$project","title":"Composer discussion",
            "acceptanceCriteriaItems":[{"ordinal":0,"text":"Keep the discussion draft"}]}""") }
        ComposerShell.answers["GET projects/$project/acceptance/confirmation"] = {
            ok("""{"state":"UNCONFIRMED","currentVersion":{"digest":"fixture-criteria-seal"}}""") }
        signIn(); openSession()
        val keyboard = shadowOf(compose.activity.getSystemService(InputMethodManager::class.java))
        val input = hasTestTag("composer-input")
        assertTrue(compose.activity.hasWindowFocus())
        assertFalse("nothing typed yet", has(input and isFocused()) || keyboard.isSoftInputVisible)

        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText(CardPreviews.viewDetailsAndAct))
        compose.onNodeWithText(CardPreviews.viewDetailsAndAct).performClick()
        await { has(hasTestTag("card-review")) && has(hasText("Chat about this") and hasClickAction()) }
        // The sheet's window has the focus while it is up.
        windowFocus(false)
        compose.onNodeWithText("Chat about this").performScrollTo().performClick()
        await { !has(hasTestTag("card-review")) && has(input and hasText("About the acceptance criteria of", substring = true)) }

        // A moment after the sheet's window goes, the page's window has the focus back: the composer takes it, with its keyboard.
        windowFocus(true)
        await { has(input and isFocused()) }
        compose.waitForIdle()
        assertTrue("the composer's keyboard, asked for once the page's window has the focus", keyboard.isSoftInputVisible)
        assertTrue("nothing was sent", ComposerShell.bodies.none { it.first.endsWith("/turns") })
    }

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    /** What Android does to the Activity's window as a sheet's window above it comes and goes. */
    private fun windowFocus(focused: Boolean) {
        compose.runOnUiThread {
            val root = View::class.java.getMethod("getViewRootImpl").invoke(compose.activity.window.decorView)
            Shadow.extract<ShadowViewRootImpl>(root).callWindowFocusChanged(focused)
        }
        compose.waitForIdle()
        assertEquals(focused, compose.activity.hasWindowFocus())
    }
}
