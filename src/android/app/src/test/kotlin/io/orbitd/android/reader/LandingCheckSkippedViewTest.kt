package io.orbitd.android.reader

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A landing check not run because its task is exempt (D5), in a landing's check list, as the web's `ProjectLandingsWindow.test.tsx`
 * holds it: `Landing check · Skipped` with `Exempt: <reason>` on its own line, never as failed, and no status word beside a name that
 * already says how it stands (this project's row, board docs/mocks/landing-measured ④); Task acceptance beside it still passed;
 * opened, its line wears the skipped arrow and no inline output is read for it. Ported from main's second Android port (33b4952524). Frames light and dark under
 * `src/android/build/evidence/task-landing-exempt-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LandingCheckSkippedViewTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/task-landing-exempt-android").also { it.mkdirs() }
    }

    private val reason = "Only moves cron entries; the landing check needs a database this task cannot reach."
    private val at = "2026-11-20T14:58:00.000Z"

    private fun landing(): LandingView = LandingSessionModel.read(Wire.json.parseToJsonElement("""{"sessionId":"L1","projectId":"P1",
        "subject":"TASK","taskId":"t1","promotionId":null,"episode":1,"openedAt":"$at","settledAt":"$at","settledAs":"LANDED","checks":[],
        "currentAttempt":null,"timeline":{"sections":[{"title":"Landing · 1","jobId":"job-1","kind":"LAND_TASK","generation":1,"state":"LANDED",
        "entries":[
          {"kind":"CHECK_FINISHED","at":"$at","claim":1,"round":1,"check":{"name":"TASK_ACCEPTANCE","index":1},"phase":"CHECK","reason":null,
           "data":{"exitCode":0,"expectedExitCode":0,"timedOut":false},"text":"Task acceptance passed · 14s"},
          {"kind":"CHECK_FINISHED","at":"$at","claim":1,"round":1,"check":{"name":"LANDING_CHECK","index":2},"phase":"CHECK","reason":null,
           "data":{"skipped":"TASK_EXEMPT","reason":"$reason","exitCode":null,"timedOut":false},
           "text":"Landing check skipped · this task is exempt: $reason"}]}],"facts":[],"truncated":false}}""").jsonObject)

    private val logReads = mutableListOf<LandingLogSelectors>()

    private val dark = androidx.compose.runtime.mutableStateOf(false)

    private fun show() {
        val view = landing()
        compose.setContent { OrbitTheme(darkTheme = dark.value) { Surface {
            androidx.compose.foundation.layout.Box(Modifier.padding(12.dp)) {
                LandingTimelineSectionView(view.timeline!!.sections.single(), view, Instant.parse(at), ZoneOffset.UTC) { selectors, _ ->
                    logReads += selectors; null
                }
            }
        } } }
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val base = compose.activity.window.decorView
        val full = Bitmap.createBitmap(base.width, base.height, Bitmap.Config.ARGB_8888)
        base.draw(Canvas(full))
        val bounds = compose.onNodeWithTag("landing:section:job-1").fetchSemanticsNode().boundsInWindow
        val pad = (12 * compose.density.density).toInt()
        val bottom = minOf(full.height, bounds.bottom.toInt() + pad)
        File(output, "$name.png").outputStream().use { Bitmap.createBitmap(full, 0, 0, full.width, bottom).compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun inStep(key: String) = hasAnyAncestor(hasTestTag("landing:step:$key") or hasTestTag("landing:step-open:$key"))

    @Test fun anExemptTasksLandingCheckReadsSkippedWithItsReasonNeverFailed() {
        show()
        listOf(false, true).forEach { dark ->
            this.dark.value = dark
            compose.waitForIdle()
            // Each theme starts folded: the press below opened it in the last one.
            if (dark) compose.onNodeWithTag("landing:step-row:check:LANDING_CHECK").performClick()
            // Skipped is not a failure: the step stays folded, as a passed one does.
            compose.onNodeWithTag("landing:step:check:LANDING_CHECK").assertExists()
            compose.onNode(hasTestTag("landing:step-name") and inStep("check:LANDING_CHECK"), useUnmergedTree = true).assertTextEquals("Landing check · Skipped")
            compose.onNode(hasTestTag("landing:step-summary") and inStep("check:LANDING_CHECK"), useUnmergedTree = true).assertTextEquals("Exempt: $reason")
            compose.onNode(hasTestTag("landing:step-status") and inStep("check:LANDING_CHECK"), useUnmergedTree = true).assertDoesNotExist()
            compose.onAllNodesWithText("Failed", useUnmergedTree = true).assertCountEquals(0)
            // Task acceptance beside it still passed.
            compose.onNode(hasTestTag("landing:step-status") and inStep("check:TASK_ACCEPTANCE"), useUnmergedTree = true).assertTextEquals("Complete")
            shot(if (dark) "skipped-folded-dark" else "skipped-folded-light")

            // Opened, its line wears the skipped arrow, and no inline output was read for it.
            compose.onNodeWithTag("landing:step-row:check:LANDING_CHECK").performClick()
            compose.onNodeWithTag("landing:step-open:check:LANDING_CHECK").assertExists()
            compose.onNode(hasTestTag("landing:mark:1") and inStep("check:LANDING_CHECK"), useUnmergedTree = true).assertTextEquals("→")
            compose.waitForIdle()
            assertEquals(emptyList<LandingLogSelectors>(), logReads)
            shot(if (dark) "skipped-open-dark" else "skipped-open-light")
        }
    }
}
