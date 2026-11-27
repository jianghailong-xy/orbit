package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import io.orbitd.android.text.MarkdownText
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

/** NATIVE frames of the settings-change card (pending, the three folds), the Open in Settings row and the Settings row line, drawn by the
 * production composables over the real wire, written under `src/android/build/evidence/settings-change-android/`. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsChangeShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val fixture = OwnerRequestFixture()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var store: OwnerRequestStore
    private val id = OwnerRequestFixture.SETTINGS_ID

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/settings-change-android").also { it.mkdirs() }
    }

    @Before fun setUp() {
        OwnerRequestSnoozes.reset(RuntimeEnvironment.getApplication())
        fixture.hold(OwnerRequestFixture.settingsChange())
        store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
        store.load(OwnerRequestStore.OPEN, OwnerRequestStore.ALL)
        compose.waitUntil(10_000) { store.state.value.list(OwnerRequestStore.ALL).size == 1 }
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

    @Composable private fun Card() {
        val state by store.state.collectAsState()
        Column(Modifier.fillMaxWidth().padding(16.dp)) { state.find(id)?.let { OwnerRequestInConversation(it, store, { "mac-mini" }, {}) } }
    }

    private fun tag(part: String) = compose.onNodeWithTag("owner-request:$id:$part", useUnmergedTree = true)
    private fun waitFor(part: String) = compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:$part", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    @Test fun theFrames() {
        // The marks the apply writes, for the folded line's Undo and the Settings row line.
        val marked = buildJsonObject {
            put("id", "u"); put("name", "U")
            putJsonObject("changedBy") { listOf("translationEnabled" to JsonPrimitive(false), "translationLanguage" to JsonPrimitive("en")).forEach { (k, from) ->
                putJsonObject(k) { put("sessionId", OwnerRequestFixture.SESSION); put("requestId", id); put("at", Instant.now().minusSeconds(120).toString())
                    put("from", from); put("sessionTitle", "Translate the docs") } } }
        }
        show { Card() }
        waitFor("primary")
        shot("1-card-pending")
        fixture.me = marked
        tag("primary").performClick()
        waitFor("undo")
        shot("2-folded-changed-undo")
        tag("undo").performClick()
        waitFor("undone")
        shot("3-folded-undone")

        show { SettingsLinkRowShot() }
        shot("4-open-in-settings-row")
        show { Surface(Modifier.padding(16.dp), shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant) {
            Column {
                androidx.compose.material3.ListItem(headlineContent = { androidx.compose.material3.Text("Translate conversations") },
                    supportingContent = { androidx.compose.material3.Text("Agents work in English") },
                    colors = androidx.compose.material3.ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent))
                SettingChangedLine("translationEnabled", marked) { _, _ -> }
            }
        } }
        shot("5-settings-row-line")
    }

    @Test fun theStaleAndDeclinedFolds() {
        fixture.staleApply = true
        show { Card() }
        waitFor("primary")
        tag("primary").performClick()
        waitFor("stale")
        shot("6-folded-stale")
        fixture.staleApply = false
        compose.onNodeWithText("Decline", useUnmergedTree = true).performClick()
        waitFor("outcome")
        shot("7-folded-declined")
    }

    @Composable private fun SettingsLinkRowShot() = Column(Modifier.padding(16.dp)) {
        MarkdownText("I can turn that on for you:\n\n[Translate conversations](orbit-settings:translationEnabled)")
    }
}
