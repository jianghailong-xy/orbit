package io.orbitd.android.cards

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryRunner
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
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

/**
 * The CHANGE card (docs/design/owner-request-change.md §3) drawn from what a real apiserver sent: the bodies under
 * `test/resources/owner-request-change` (see its README) are served verbatim, and the runner rows are decoded by the app's own
 * decoder. Shots to build/evidence/owner-request-change: (a) pending, (b) the live value moved, (c) ended.
 */
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

    private fun real(name: String) = javaClass.classLoader!!.getResourceAsStream("owner-request-change/$name.json")!!.readBytes().decodeToString()
    private fun requestsIn(name: String): List<JsonObject> = Json.parseToJsonElement(real(name)).jsonObject["requests"]!!.jsonArray.map { it.jsonObject }
    private fun runners(name: String): List<DirectoryRunner> = Wire.decode(real(name).encodeToByteArray(), ListSerializer(DirectoryRunner.serializer()))
    private lateinit var id: String

    @Before fun setUp() { OwnerRequestSnoozes.reset(RuntimeEnvironment.getApplication()) }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    /** Starts from the real list read [list] (its rows held as they were sent) and draws every request with [runners] as the runner list. */
    private fun draw(list: String, runners: List<DirectoryRunner>) {
        val rows = requestsIn(list)
        id = rows.single()["id"]!!.jsonPrimitive.content
        fixture.hold(*rows.toTypedArray())
        store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
        store.load(OwnerRequestStore.OPEN, OwnerRequestStore.ALL)
        compose.waitUntil(10_000) { store.state.value.list(OwnerRequestStore.ALL).size == 1 }
        compose.setContent { OrbitTheme(darkTheme = false) { CompositionLocalProvider(LocalChangeRunners provides runners) {
            val state by store.state.collectAsState()
            Column(Modifier.padding(16.dp)) {
                state.list(OwnerRequestStore.ALL).forEach { OwnerRequestInConversation(it, store, runnerNames(runners), {}, null) }
            }
        } } }
        compose.waitForIdle()
    }

    private fun tag(part: String) = compose.onNodeWithTag("owner-request:$id:$part", useUnmergedTree = true)
    private fun gone(part: String) = compose.onAllNodesWithTag("owner-request:$id:$part", useUnmergedTree = true).assertCountEquals(0)

    @Test fun theServersChangeSpecAndRunnerRowDecode() {
        val request = Wire.decode(real("apply-3").encodeToByteArray(), OwnerRequest.serializer())
        assertEquals("CHANGE", request.kind)
        assertEquals(2, request.changeSpec?.requested); assertEquals(4, request.changeSpec?.before)
        assertEquals(3, request.answer?.applied); assertEquals(5, request.answer?.actualBefore)
        assertEquals(4, runners("runners-pending").single().maxConcurrent); assertEquals(3, runners("runners-pending").single().activeSessions)
        assertEquals(request.changeSpec?.runnerId, runners("runners-pending").single().id)
    }

    @Test fun aPendingCardShowsTheLiveValueTheAskedNumberAndWhatRunsNow() {
        draw("owner-requests-pending", runners("runners-pending"))
        tag("kind").assertTextEquals("SETTING")
        tag("change-setting").assertTextEquals("mac-mini · Max Concurrent")
        tag("change-live").assertTextEquals("4")
        tag("change-value").assertTextEquals("2")
        tag("change-running").assertTextEquals("3 running now")
        tag("change-effect").assertTextEquals("Nothing running stops. New sessions wait until fewer than 2 run.")
        gone("change-was")
        compose.onNodeWithText("Apply", useUnmergedTree = true).assertExists()
        shot("a-pending")
    }

    @Test fun whenTheLiveValueMovedTheCardSaysWhatItWasWhenAsked() {
        draw("owner-requests-moved", runners("runners-moved"))
        tag("change-live").assertTextEquals("5")
        tag("change-value").assertTextEquals("2")
        tag("change-was").assertTextEquals("Was 4 when asked.")
        tag("change-effect").assertTextEquals("Nothing running stops. New sessions wait until fewer than 2 run.")
        shot("b-moved")
    }

    @Test fun applyPostsTheStepperNumberAndTheCardEndsOnTheServersAnswer() {
        fixture.applyReply = real("apply-3")
        draw("owner-requests-moved", runners("runners-moved"))
        tag("change-plus").performClick()
        tag("change-value").assertTextEquals("3")
        tag("primary").performClick()
        compose.waitUntil(10_000) { fixture.posts().any { it.path == "/api/owner-requests/$id/apply" } }
        assertEquals(JsonPrimitive(3), Json.parseToJsonElement(fixture.posts().single().body).jsonObject["maxConcurrent"])
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("owner-request:$id:outcome", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        tag("outcome").assertTextEquals("Applied: mac-mini Max Concurrent 5 → 3 (asked for 2)")
        shot("c-ended")
    }

    @Test fun anEndedCardDrawnFromTheServersList() {
        draw("owner-requests-done", runners("runners-applied"))
        tag("outcome").assertTextEquals("Applied: mac-mini Max Concurrent 5 → 3 (asked for 2)")
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
