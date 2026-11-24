package io.orbitd.android.management

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
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
 * Default's Sign out… on an engine page, over the controlled server (the web's RunnerEngines.defaultSignOut.test.tsx on Android): the ⋯ menu
 * of a signed-in Default on a runner that declared the capability offers it — and nothing else's does — disabled offline; it asks first
 * in the web's words and POSTs without force; the runner's refusal over sessions asks again and resends with force; the row then shows
 * signed out with Sign in. NATIVE frames go to `src/android/build/evidence/default-sign-out-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DefaultSignOutPageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset(); fixture.runnerAlias = "wikova" }

    private var record by mutableStateOf<String?>(null)
    private var revision by mutableLongStateOf(0L)
    private var shownOnce = false
    private fun page(where: String? = "engine:claude") {
        record = where; revision++
        if (!shownOnce) {
            shownOnce = true
            val session = fixture.session()
            runBlocking { fixture.signIn(session) }
            val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
            compose.setContent { RunnerScreen(api, fixture.RUNNER, record, revision, {}, {}, {}) }
        }
        compose.waitForIdle()
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun shown(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(60_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun menu(account: String) = click(hasContentDescription("More for $account"))
    private val item = hasTestTag("account-sign-out")
    private fun confirm(button: String) {
        compose.waitUntil(60_000) { compose.onAllNodes(hasText(button) and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText(button) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }
    private val path = "runners/${fixture.RUNNER}/accounts/claude/default/sign-out"
    private fun writes() = fixture.writes(path)
    private fun sent() = fixture.bodies.filter { it.startsWith("POST $path ") }.map { it.substringAfter("$path ") }

    private fun default(auth: String) = """{"id":"default","home":"/root/.claude","auth":"$auth"}"""
    private fun claude(auth: String, vararg more: String) =
        """[{"engine":"claude","installed":true,"version":"2.1.42 (Claude Code)","auth":"$auth","accounts":[${(listOf(default(auth)) + more).joinToString(",")}]}]"""
    private val declared = ""","capabilities":["claude-default-sign-out/v1"]"""
    private fun refused(count: Int) = ""","accountRemove":{"engine":"claude","account":"default","status":"failed","message":"in use","sessions":[""" +
        (1..count).joinToString(",") { """{"id":"s-$it","title":"Turn $it","status":"RUNNING"}""" } + "]}"

    @Test fun aLoneDefaultAsksFirstThenSendsWithoutForceAndShowsSignIn() {
        fixture.runnerEngines = claude("yes")
        fixture.runnerExtra = declared
        fixture.onAccountWrite = { fixture.runnerEngines = claude("no") }
        page()
        await("Default")
        menu("Default")
        await(RunnerAccountCopy.DEFAULT_SIGN_OUT)
        compose.onNode(item).assertIsEnabled()
        shot("1-menu")
        click(item)
        await("Sign out of Default?")
        await("Its login is deleted from wikova. Its history and settings stay. claude in a terminal on wikova is signed out too.")
        assertTrue("asked first", writes().isEmpty())
        shot("2-confirmation")
        confirm(RunnerAccountCopy.DEFAULT_SIGN_OUT_CONFIRM)
        compose.waitUntil(60_000) { writes().isNotEmpty() }
        assertEquals(listOf("POST $path"), writes())
        assertEquals("""{"force":false}""", sent().single())
        await(RunnerCopy.SIGN_IN)
        shot("3-signed-out")
    }

    @Test fun aGroupedDefaultOffersItToo() {
        fixture.runnerEngines = claude("yes", """{"id":"3fa91c2e","name":"Work","home":"/root/.orbit/claude-accounts/3fa91c2e","auth":"yes"}""")
        fixture.runnerExtra = declared
        page()
        await("Work")
        menu("Work")
        await(AccountCopy.RENAME)
        assertEquals("an added account is not signed out", 0, compose.onAllNodes(item).fetchSemanticsNodes().size)
        menu("Default")
        await(RunnerAccountCopy.DEFAULT_SIGN_OUT)
        shot("4-grouped-menu")
    }

    @Test fun aSessionsRefusalAsksAgainAndResendsWithForce() {
        fixture.runnerEngines = claude("yes")
        fixture.runnerExtra = declared
        fixture.onAccountWrite = { fixture.runnerExtra = declared + refused(2) }
        page()
        await("Default")
        menu("Default")
        click(item)
        confirm(RunnerAccountCopy.DEFAULT_SIGN_OUT_CONFIRM)
        await("2 sessions are running on Default. Sign out anyway?")
        await(RunnerAccountCopy.DEFAULT_SIGN_OUT_RUNNING_DETAIL)
        assertEquals(listOf("""{"force":false}"""), sent())
        shot("5-sessions-confirmation")
        fixture.onAccountWrite = { fixture.runnerEngines = claude("no"); fixture.runnerExtra = declared }
        confirm(RunnerAccountCopy.DEFAULT_SIGN_OUT_CONFIRM)
        compose.waitUntil(60_000) { sent().size == 2 }
        assertEquals(listOf("""{"force":false}""", """{"force":true}"""), sent())
    }

    @Test fun anOldRunnerASignedOutDefaultAndAnotherEngineAreNotOffered() {
        fixture.runnerEngines = claude("yes")
        page()
        await("Default")
        menu("Default")
        await(AccountCopy.RENAME)
        assertEquals("no capability declared", 0, compose.onAllNodes(item).fetchSemanticsNodes().size)
        val line = RunnerPage.AccountLine("default", "Default", null, "yes", null, null)
        val runner = Json.parseToJsonElement("""{"capabilities":["claude-default-sign-out/v1"]}""").jsonObject
        assertTrue(RunnerPage.offersSignOut("claude", line, runner))
        assertFalse("another engine's capability", RunnerPage.offersSignOut("codex", line, runner))
        assertFalse("signed out", RunnerPage.offersSignOut("claude", line.copy(auth = "no"), runner))
        assertFalse("an added account", RunnerPage.offersSignOut("claude", line.copy(id = "3fa91c2e"), runner))
    }

    @Test fun itIsDisabledOfflineAndWhileOneIsInFlightAndNamesTheCliOnlyForClaudeAndCodex() {
        assertTrue(RunnerPage.canSignOut(offline = false, pending = false))
        assertFalse(RunnerPage.canSignOut(offline = true, pending = false))
        assertFalse(RunnerPage.canSignOut(offline = false, pending = true))
        val runner = Json.parseToJsonElement("""{"displayName":"Mini"}""").jsonObject
        val line = RunnerPage.AccountLine("default", "Default", null, "yes", null, null)
        assertEquals("Sign out of Default?" to "Its login is deleted from Mini. Its history and settings stay. codex in a terminal on Mini is signed out too.",
            RunnerPage.signOutQuestion(runner, "codex", line))
        assertEquals("Its login is deleted from Mini. Its history and settings stay.", RunnerPage.signOutQuestion(runner, "cursor", line).second)
        assertEquals("1 session is running on Default. Sign out anyway?", RunnerPage.signOutAgainQuestion(line, 1).first)
        assertEquals("3 sessions are running on Default. Sign out anyway?", RunnerPage.signOutAgainQuestion(line, 3).first)
    }

    @Test fun aRefusalIsSaidInTheServersWords() {
        fixture.runnerEngines = claude("yes")
        fixture.runnerExtra = declared
        fixture.signOutRefusal = "The runner on Mini is too old to sign Claude Code out."
        page()
        await("Default")
        menu("Default")
        click(item)
        confirm(RunnerAccountCopy.DEFAULT_SIGN_OUT_CONFIRM)
        await("Couldn’t sign out of Default — The runner on Mini is too old to sign Claude Code out.")
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/default-sign-out-android").also { it.mkdirs() }
    }

    /** Every window the app has open, the activity's first: a menu and a dialog are windows of their own. */
    private fun windows(): List<View> {
        val global = Class.forName("android.view.WindowManagerGlobal")
        val manager = global.getMethod("getInstance").invoke(null)
        val views = (global.getDeclaredField("mViews").apply { isAccessible = true }.get(manager) as List<*>).filterIsInstance<View>()
        val decor = compose.activity.window.decorView
        return listOf(decor) + views.filter { it !== decor && it.isAttachedToWindow && it.isShown && it.width > 0 }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = Int.MAX_VALUE))
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        windows().forEach { view ->
            val at = (view.layoutParams as? WindowManager.LayoutParams)?.takeIf { view !== decor }
            canvas.save()
            at?.let {
                // A dialog is centred by its gravity and dims what is behind it; a menu's popup says where it is in x and y.
                if (it.flags and WindowManager.LayoutParams.FLAG_DIM_BEHIND != 0) canvas.drawColor(android.graphics.Color.argb((it.dimAmount * 255).toInt(), 0, 0, 0))
                val centred = it.gravity and android.view.Gravity.VERTICAL_GRAVITY_MASK == android.view.Gravity.CENTER_VERTICAL
                canvas.translate(if (centred) (decor.width - view.width) / 2f else it.x.toFloat(), if (centred) (decor.height - view.height) / 2f else it.y.toFloat())
            }
            view.draw(canvas)
            canvas.restore()
        }
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    companion object {
        const val WORK = "3fa91c2e"
    }
}
