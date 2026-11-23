package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Every conversation card ends on [ConversationCardWidth.DP] on a wide column, and fills a phone's. Pictures: build/evidence/conversation-card-width. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w1100dp-h700dp")
class ConversationCardWidthShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun card(suffix: String, family: CardFamily, source: JsonObject = buildJsonObject { put("title", "A card"); put("reason", "Why it is here") }) =
        InteractionCard("e1:$suffix", family, "Card $suffix", source, "s1", objectId = "o$suffix", binding = suffix)

    private val kinds = listOf(
        "taskStart" to card("taskStart", CardFamily.BACKGROUND),
        "projectStarted" to card("projectStarted", CardFamily.START,
            buildJsonObject { put("by", "CONFIRMATION"); put("projectId", "p1"); put("projectTitle", "A project") }),
        "confirmationReviewRequest" to card("confirmationReviewRequest", CardFamily.REVIEW),
        "confirmationReturn" to card("confirmationReturn", CardFamily.REVIEW),
        "generic notice" to card("evidenceReceipt", CardFamily.EVIDENCE),
        "evidenceReview" to card("evidenceReview", CardFamily.EVIDENCE),
    )

    private fun draw(dark: Boolean = false) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) { Surface(Modifier.fillMaxSize()) {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                kinds.forEach { (name, card) -> Column(Modifier.testTag("w:$name")) { TranscriptCardView(card, open = {}) } }
            }
        } } } }
        compose.waitForIdle()
    }

    private fun widths(): Map<String, Float> = kinds.associate { (name, _) ->
        name to compose.onNodeWithTag("w:$name").fetchSemanticsNode().size.width / compose.activity.resources.displayMetrics.density
    }

    @Test fun wideColumnEndsEveryCardOnOneLine() {
        draw(); shot("wide")
        val w = widths()
        println("WIDTHS wide: $w")
        w.forEach { (name, dp) -> assertEquals(name, ConversationCardWidth.DP.toFloat(), dp, 1f) }
    }

    @Test @Config(qualifiers = "w411dp-h891dp") fun phoneColumnIsFilledByEveryCard() {
        draw(); shot("phone")
        val w = widths()
        println("WIDTHS phone: $w")
        w.forEach { (name, dp) -> assertEquals(name, 411f - 32f, dp, 1f) }
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/conversation-card-width").also { it.mkdirs() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        assertTrue(view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
