package io.orbitd.android.projects

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.ProjectShell
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.cards.CardBody
import io.orbitd.android.cards.ExceptionCard
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.*
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Native Compose frames of the production settings, confirmation and baseline card over fixture reads. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1000dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LandingCheckShotsTest {
    @get:Rule(order = 0) val dispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()
    @Before fun reset() = ProjectShell.reset()
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            Surface { Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) { content() } }
        } } }
        compose.waitForIdle()
    }
    private fun shot(name: String) {
        compose.waitForIdle()
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        val output = File(root, "src/android/build/evidence/landing-check").also { it.mkdirs() }
        val view = compose.activity.window.decorView
        Assert.assertTrue(view.width > 0 && view.height > 0)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        println("Captured production Compose frame: $name")
    }
    @Test fun settings() {
        val state = ProjectPageState().apply { integration = json("""{"line":"PROJECT_BRANCH","locked":true,
          "mergeCheckCommand":"make test-all","mergeCheckTimeoutSeconds":3600,"landingCheckCommand":null,
          "landingCheckTimeoutSeconds":null,"escalationSeconds":7200}""") }
        show { RunSettingsSection(state, json("""{"coordinatorEnabled":true,"maxConcurrentTasks":3}"""), Instant.now(),
            true, {}, {}, {}, {}, {}) }
        compose.onNodeWithText("Landing check").assertExists()
        compose.onNodeWithText("Uses merge check: make test-all").assertExists()
        shot("settings")
    }
    @Test fun confirmation() {
        val source = json("""{"toolName":"orbit_project_update_integration","input":{"projectTitle":"Payments",
          "currentLandingCheckCommand":null,"currentLandingCheckTimeoutSeconds":null,
          "currentMergeCheckCommand":"make test-all","currentMergeCheckTimeoutSeconds":3600,
          "landingCheckCommand":"make test-fast","landingCheckTimeoutSeconds":900}}""")
        val card = InteractionCard("approval:a1", CardFamily.TOOL, LandingCheckCopy.confirmTitle, source, "s1", "p1", "a1", "fixture")
        show { Text(LandingCheckCopy.confirmTitle, style = MaterialTheme.typography.titleMedium); CardBody(card, {}) }
        compose.onNodeWithText("Landing check").assertExists()
        compose.onNodeWithText("Merge check").assertExists()
        compose.onNodeWithText("Applies to the next claimed landing job.").assertExists()
        shot("confirmation")
    }
    @Test fun baseline() {
        val row = json("""{"itemId":"b1","kind":"INTEGRATION_CHECK_FAILED","title":"Baseline red",
          "assignee":"OWNER","assigneeReason":"ESCALATED","waitingSince":"2026-11-11T09:00:00Z","actions":[],
          "baseline":{"upstreamSha":"c81d795","targetSha":"3c25e06","mergeTreeSha":"b1719dc","check":{"command":"make test-fast"}},
          "heldTaskIds":["t1","t2"],"facts":{"targetRef":"refs/heads/project/payments"}}""")
        val card = CardCatalog.project("s1", "p1", mapOf("project" to json("""{"id":"p1"}"""),
            "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row) }; putJsonArray("withCoordinator") {} })).single()
        show { ExceptionCard(card, true, CardActionState(), null, {}, null, {}) { _, _ -> } }
        compose.onNodeWithText("Baseline checks failing on project/payments").assertExists()
        compose.onNodeWithText("Landings on hold").assertExists()
        compose.onNodeWithText("View held tasks").assertExists()
        shot("baseline")
    }
}
