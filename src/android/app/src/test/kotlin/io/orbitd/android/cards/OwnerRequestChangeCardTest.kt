package io.orbitd.android.cards

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The CHANGE card (docs/design/owner-request-change.md §3): its setting block, the − / + stepper starting at the asked-for value,
 * Apply posting `{ maxConcurrent }` to the apply door, and the card's one resolved line. Shot to build/evidence/owner-request-change. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w393dp-h852dp-notnight-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OwnerRequestChangeCardTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    private val fixture = OwnerRequestFixture()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var store: OwnerRequestStore
    private val id = OwnerRequestFixture.CHANGE_ID

    @Before fun setUp() {
        OwnerRequestSnoozes.reset(RuntimeEnvironment.getApplication())
        fixture.hold(OwnerRequestFixture.change())
        store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
        store.load(OwnerRequestStore.OPEN, OwnerRequestStore.ALL)
        compose.waitUntil(10_000) { store.state.value.open.size == 1 }
        compose.setContent { OrbitTheme(darkTheme = false) {
            val state by store.state.collectAsState()
            Column(Modifier.padding(16.dp)) { state.list(OwnerRequestStore.ALL).forEach { OwnerRequestInConversation(it, store, { "mac-mini" }, {}, null) } }
        } }
        compose.waitForIdle()
    }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    private fun tag(part: String) = compose.onNodeWithTag("owner-request:$id:$part", useUnmergedTree = true)

    @Test fun theCardStartsAtTheAskedValueAndApplyPostsTheNumber() {
        tag("kind").assertTextEquals("SETTING")
        tag("change-setting").assertTextEquals("mac-mini · Max Concurrent")
        tag("change-live").assertTextEquals("4")
        tag("change-value").assertTextEquals("6")
        tag("change-effect").assertTextEquals("Up to 6 sessions can run at once on this machine.")
        compose.onAllNodesWithTag("owner-request:$id:change-was", useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithText("Apply", useUnmergedTree = true).assertExists()
        shot("pending")
        tag("change-minus").performClick(); tag("change-minus").performClick(); tag("change-minus").performClick()
        tag("change-value").assertTextEquals("3")
        tag("change-effect").assertTextEquals("Nothing running stops. New sessions wait until fewer than 3 run.")
        tag("change-plus").performClick()
        tag("primary").performClick()
        compose.waitUntil(10_000) { fixture.posts().any { it.path == "/api/owner-requests/$id/apply" } }
        assertEquals(JsonPrimitive(4), Json.parseToJsonElement(fixture.posts().first { it.path.endsWith("/apply") }.body).jsonObject["maxConcurrent"])
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:outcome", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        tag("outcome").assertTextEquals("Applied: mac-mini Max Concurrent 4 → 4 (asked for 6)")
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }.first { File(it, "src/android").isDirectory }
        val output = File(root, "src/android/build/evidence/owner-request-change").also { it.mkdirs() }
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
