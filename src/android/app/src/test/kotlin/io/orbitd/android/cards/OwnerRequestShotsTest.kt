package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * NATIVE frames of the owner request card on a phone (the task's mockup, panels 1–4): the SECRET, MANUAL_STEP and DECISION cards and a
 * resolved line. Each is drawn by the production composable over the real
 * wire and written under `src/android/build/evidence/owner-requests-android/` beside its semantics tree.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OwnerRequestShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val fixture = OwnerRequestFixture()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var store: OwnerRequestStore

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/owner-requests-android").also { it.mkdirs() }
    }

    @Before fun setUp() {
        OwnerRequestSnoozes.reset(RuntimeEnvironment.getApplication())
        val day = Instant.now().minusSeconds(86_400 + 3_600).toString()
        val twoTasks = buildJsonArray { add(OwnerRequestFixture.TASK); add("01a0d6a9-d763-70e1-b4cf-8793e971b5cc") }
        fixture.hold(OwnerRequestFixture.secret(),
            JsonObject(OwnerRequestFixture.steps() + mapOf("createdAt" to JsonPrimitive(day), "blocksTaskIds" to twoTasks)),
            OwnerRequestFixture.decision(),
            JsonObject(OwnerRequestFixture.confirm() + buildJsonObject {
                put("state", "DONE"); put("resolvedAt", Instant.now().minusSeconds(600).toString()); put("resolvedByUserId", "u")
                put("resolvedClient", "android")
            }))
        store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
        store.load(OwnerRequestStore.OPEN, OwnerRequestStore.ALL)
        compose.waitUntil(10_000) { store.state.value.list(OwnerRequestStore.ALL).size == 4 && store.state.value.taskTitles.isNotEmpty() }
    }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(color = MaterialTheme.colorScheme.background) { content() }
        } } }
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    @Composable private fun Card(id: String) {
        val state by store.state.collectAsState()
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            state.find(id)?.let { OwnerRequestInConversation(it, store, { "mac-mini" }, {}) }
        }
    }

    @Test fun theCards() {
        show { Card(OwnerRequestFixture.SECRET_ID) }
        compose.onNodeWithText("Provide key", useUnmergedTree = true).assertExists()
        shot("secret-card")
        show { Card(OwnerRequestFixture.STEPS_ID) }
        compose.onNodeWithText("Mark done", useUnmergedTree = true).assertExists()
        shot("steps-card")
        show { Card(OwnerRequestFixture.DECISION_ID) }
        compose.onNodeWithText("Send answer", useUnmergedTree = true).assertExists()
        shot("decision-card")
        show { Card(OwnerRequestFixture.CONFIRM_ID) }
        compose.onNodeWithTag("owner-request:${OwnerRequestFixture.CONFIRM_ID}:outcome", useUnmergedTree = true).assertTextEquals("Confirmed")
        shot("resolved-line")
    }
}
