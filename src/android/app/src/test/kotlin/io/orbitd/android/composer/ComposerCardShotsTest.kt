package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.ui.test.*
import io.orbitd.android.core.auth.AuthState
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The composer card as a 360 dp phone draws it (board docs/mocks/android-composer-parity, A③ B① B② D①): PNGs under
 * app/build/evidence/android-composer-parity, not committed. A shot that drew nothing fails.
 */
@Config(qualifiers = "w360dp-h780dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ComposerCardShotsTest : ComposerShellTest() {
    private fun running() {
        ComposerShell.session = ComposerShell.fields("""{"status":"RUNNING","runState":"RUNNING","permissionMode":"acceptEdits","effort":"high"}""")
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Make the gauge a ring"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-0","payload":{"text":"Working on it.","contextTokens":144499,"contextWindow":1000000}}"""))
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        val file = File(System.getProperty("user.dir"), "build/evidence/android-composer-parity/$name.png").also { it.parentFile?.mkdirs() }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name -> $file")
    }

    @Test fun runningWithNothingTyped() {
        running()
        signIn(); openSession()
        await { has(hasTestTag("composer-send") and hasContentDescription("Stop")) }
        // The ring reads the share the turn reported: 144,499 of 1,000,000.
        compose.onNodeWithTag("composer-context").assertContentDescriptionEquals("Context 14% used")
        shot("a3-running-light")
    }

    @Config(qualifiers = "+night")
    @Test fun runningWithNothingTypedDark() {
        running()
        signIn(); openSession()
        await { has(hasTestTag("composer-send") and hasContentDescription("Stop")) }
        shot("a3-running-dark")
    }

    @Test fun typingWithOptimizeOnTheRow() {
        PromptOptimizerFixture.install()
        ComposerShell.session = mapOf("permissionMode" to JsonPrimitive("acceptEdits"), "effort" to JsonPrimitive("high"))
        signIn(); openSession()
        compose.onNodeWithTag("composer-input").performTextInput("Make the composer's context line a ring, and keep the Compact action in the sheet")
        await { has(hasTestTag("composer-optimize")) }
        shot("b2-typing-optimize")
    }

    @Config(qualifiers = "+night")
    @Test fun attachmentsInsideTheCard() {
        // Uploads that land, but slowly, so the shot shows the chips with their progress.
        var next = 0
        ComposerShell.answers["POST attachments"] = { Thread.sleep(300); io.orbitd.android.core.net.ApiResponse(200, """{"id":"att-${next++}"}""".encodeToByteArray()) }
        signIn(); openSession()
        val handle = (app().session.state.value as AuthState.SignedIn).handle
        val model = app().composer(handle, ComposerShell.SESSION)
        val png = ByteArrayOutputStream().also { out ->
            Bitmap.createBitmap(120, 120, Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF4F7DF3.toInt()) }.compress(Bitmap.CompressFormat.PNG, 100, out)
        }.toByteArray()
        compose.runOnIdle {
            model.importAttachment(StagedAttachment("p1", "screenshot.png", "image/png"), { StagedAttachment("p1", "screenshot.png", "image/png", png.size) to png }, {})
            model.importAttachment(StagedAttachment("f1", "notes.pdf", "application/pdf"), { StagedAttachment("f1", "notes.pdf", "application/pdf", 212_000) to ByteArray(212_000) }, {})
        }
        await { has(hasTestTag("composer-attachment:f1")) }
        compose.onNodeWithTag("composer-input").performTextInput("Why does the second screenshot overlap?")
        shot("d1-attachments-dark")
    }
}
