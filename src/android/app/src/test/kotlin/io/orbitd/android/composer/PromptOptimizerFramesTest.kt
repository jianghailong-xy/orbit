package io.orbitd.android.composer

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.test.ext.junit.rules.ActivityScenarioRule
import io.orbitd.android.core.promptoptimizer.PromptOptimizerCopy
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog

/** Frames of the prompt optimizer as Robolectric draws them, beside iOS's iPhone frames: the activity's window, with an open sheet's
 * window drawn over it. They go to `src/android/build/evidence/prompt-optimizer-android/`. */
internal object PromptOptimizerFrames {
    val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/prompt-optimizer-android").also { it.mkdirs() }
    }

    fun <A : ComponentActivity> shot(compose: AndroidComposeTestRule<ActivityScenarioRule<A>, A>, name: String, sheet: Boolean = false) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(Int.MAX_VALUE))
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        view.draw(canvas)
        if (sheet) ShadowDialog.getLatestDialog()?.window?.decorView?.let { dialog ->
            val at = IntArray(2).also(dialog::getLocationOnScreen)
            canvas.save(); canvas.translate(at[0].toFloat(), at[1].toFloat()); dialog.draw(canvas); canvas.restore()
        }
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name: the shot is blank", pixels.any { it != 0 })
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name ${bitmap.width}×${bitmap.height} -> ${File(output, "$name.png")}")
        bitmap.recycle()
    }
}

/** Board frames 2–6 on Android, in the order iOS's PromptOptimizerTests UI run takes them: the button, the busy press, the sheet and
 * its gloss, after Use and after Undo, and the failure line. */
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xxhdpi")
class PromptOptimizerFramesTest : ComposerShellTest() {
    private val button = hasTestTag("composer-optimize")

    @Test fun frames2To5() {
        val gate = CompletableDeferred<Unit>()
        PromptOptimizerFixture.install()
        ComposerShell.gates[PromptOptimizerFixture.CALL] = gate
        signIn(); openSession()
        compose.onNodeWithTag("composer-input").performTextInput(PromptOptimizerFixture.DRAFT)
        await { has(button) }
        // The keyboard is not up in Robolectric, so the box sits where the phone's would with the keyboard down, as on iOS's frames.
        PromptOptimizerFrames.shot(compose, "2-button")
        compose.onNode(button).performClick()
        await { has(button and hasText(PromptOptimizerCopy.OPTIMIZING, substring = true)) }
        PromptOptimizerFrames.shot(compose, "3-optimizing")
        gate.complete(Unit)
        await { has(hasTestTag("composer-optimization-card")) }
        PromptOptimizerFrames.shot(compose, "4-suggestion", sheet = true)
        compose.onNodeWithTag("composer-optimization-gloss").performClick()
        await { has(hasText(PromptOptimizerFixture.GLOSS)) }
        PromptOptimizerFrames.shot(compose, "4b-gloss", sheet = true)
        compose.onNodeWithTag("composer-optimization-use").performClick()
        await { has(hasTestTag("composer-optimization-undo-toast")) }
        PromptOptimizerFrames.shot(compose, "5-after-use")
        compose.onNodeWithTag("composer-optimization-undo").performClick()
        await { !has(hasTestTag("composer-optimization-undo-toast")) }
        PromptOptimizerFrames.shot(compose, "5b-undone")
    }

    @Test fun frame6() {
        PromptOptimizerFixture.install { io.orbitd.android.core.net.ApiResponse(422,
            """{"code":"PROMPT_OPTIMIZATION_FAILED","reason":"TIMEOUT"}""".encodeToByteArray()) }
        signIn(); openSession()
        compose.onNodeWithTag("composer-input").performTextInput(PromptOptimizerFixture.DRAFT)
        await { has(button) }
        compose.onNode(button).performClick()
        await { has(hasTestTag("composer-optimization-failed")) }
        PromptOptimizerFrames.shot(compose, "6-failure")
    }
}
