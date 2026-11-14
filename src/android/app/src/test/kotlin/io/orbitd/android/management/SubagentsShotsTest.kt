package io.orbitd.android.management

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
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
import java.io.File

/** NATIVE frames of the SubAgents group, its Providers list and Model tiers with the mock's data (docs/mocks/subagent/05.png), written
 * under `src/android/build/evidence/subagent-android/`; a dialog's or a menu's window is drawn over the page it opened on. */
abstract class SubagentsShots {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    abstract val suffix: String

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }.first { File(it, "src/android").isDirectory }
        File(root, "src/android/build/evidence/subagent-android").also { it.mkdirs() }
    }

    @Before fun start() { fixture.reset(); fixture.subagentTiers = SubagentFixtures.TIERS; fixture.subagentBlocked = listOf("team-codex") }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun await(text: String) = compose.waitUntil(60_000) {
        compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    }

    private fun windows(): List<View> {
        val global = Class.forName("android.view.WindowManagerGlobal")
        val manager = global.getMethod("getInstance").invoke(null)
        val views = (global.getDeclaredField("mViews").apply { isAccessible = true }.get(manager) as List<*>).filterIsInstance<View>()
        val decor = compose.activity.window.decorView
        return listOf(decor) + views.filter { it !== decor && it.isAttachedToWindow && it.isShown && it.width > 0 }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        windows().forEach { view ->
            val at = (view.layoutParams as? WindowManager.LayoutParams)?.takeIf { view !== decor }
            canvas.save()
            at?.let { canvas.translate(it.x.toFloat(), it.y.toFloat()) }
            view.draw(canvas)
            canvas.restore()
        }
        val pixels = IntArray(bitmap.width * bitmap.height).also { bitmap.getPixels(it, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height) }
        assertTrue("$name is blank", pixels.distinct().size > 2)
        val file = File(output, "$name$suffix.png")
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        println("shot $name -> $file")
        bitmap.recycle()
    }

    private fun page(content: @androidx.compose.runtime.Composable () -> Unit) = compose.setContent {
        OrbitTheme(darkTheme = false) { Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() } }
    }

    @Test fun subagentsGroupAndItsProvidersList() {
        val api = api()
        page {
            Column(Modifier.padding(horizontal = 16.dp)) {
                SubagentsSection(api, true, {}, "cost", {}, 4, {})
            }
        }
        await("5 of 6 · Edit")
        shot("a-subagents-group")
        compose.onNodeWithTag("subagent-providers").performClick()
        await("Team Codex")
        shot("b-providers-list")
    }

    @Test fun modelTiers() {
        val api = api()
        page { Column(Modifier.padding(horizontal = 16.dp)) { ModelTiersSection(api, 0) } }
        await("qwen-coder")
        shot("c-model-tiers")
        compose.onNodeWithTag("tier:qwen-coder", useUnmergedTree = true).performClick()
        compose.waitUntil(60_000) { compose.onAllNodesWithText("XL").fetchSemanticsNodes().isNotEmpty() }
        shot("d-model-tier-menu")
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w393dp-h852dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SubagentsPhoneShotsTest : SubagentsShots() { override val suffix = "-phone" }

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w800dp-h700dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SubagentsTabletShotsTest : SubagentsShots() { override val suffix = "-tablet" }
