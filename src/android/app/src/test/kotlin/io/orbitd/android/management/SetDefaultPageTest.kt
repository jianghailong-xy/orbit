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
 * Set as default on Claude Code's engine page, over the controlled server (the web's RunnerEngines.setDefault.test.tsx on Android): an
 * added account's ⋯ menu offers it with what it does under its name — Default's and a Codex account's do not — or why it can't be chosen
 * (offline, a runner too old to swap logins, a swap under way); the question says the web's sentence and Make default POSTs the route;
 * while the swap waits the account says how many sessions' turns it waits on, and a terminal Claude Code too; a failed swap shows the
 * machine's reason and that both logins are as they were; and a refusal is said in the server's words. NATIVE frames of the menu, the
 * question and the waiting line go to `src/android/build/evidence/set-default-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SetDefaultPageTest {
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
    private val item = hasTestTag("account-set-default")
    /** The question's own button, pressed through its semantics: a dialog's buttons take no injected touch while it settles. */
    private fun confirm(button: String) {
        compose.waitUntil(60_000) { compose.onAllNodes(hasText(button) and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText(button) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }
    private fun writes() = fixture.writes("runners/${fixture.RUNNER}/accounts/claude/$WORK/set-default")

    private val default = """{"id":"default","home":"/root/.claude","auth":"yes"}"""
    private val work = """{"id":"$WORK","name":"Work","home":"/root/.orbit/claude-accounts/$WORK","auth":"yes"}"""
    private fun claude(vararg accounts: String) =
        """[{"engine":"claude","installed":true,"version":"2.1.42 (Claude Code)","auth":"yes","accounts":[${accounts.joinToString(",")}]}]"""
    private val swaps = ""","capabilities":["claude-account-swap/v1","claude-account-move/v1"]"""
    private fun swap(status: String, waiting: Int = 0, terminal: Boolean = false, message: String? = null) =
        ""","claudeAccountSwap":{"account":"$WORK","status":"$status","message":${message?.let { "\"$it\"" } ?: "null"},""" +
            """"waitingOn":[${(1..waiting).joinToString(",") { """{"id":"s-$it","title":"Turn $it","status":"RUNNING"}""" }}],""" +
            """"foreignProcesses":[${if (terminal) """{"pid":4121,"command":"claude"}""" else ""}]}"""

    @Test fun anAddedAccountOffersItAsksInTheWebsWordsAndSaysWhatItWaitsOn() {
        fixture.runnerEngines = claude(default, work)
        fixture.runnerExtra = swaps
        fixture.onAccountWrite = { fixture.runnerExtra = swaps + swap("pending", waiting = 2) }
        page()
        await("Work")
        menu("Work")
        await(RunnerAccountCopy.SET_DEFAULT)
        await("Moves this login into ~/.claude, so the terminal uses it too")
        compose.onNode(item).assertIsEnabled()
        shot("1-menu")
        click(item)
        await("Make Work the default?")
        await("Work’s login moves to ~/.claude, and Default’s to ~/.orbit/claude-accounts/$WORK. Claude Code in a terminal on wikova uses " +
            "Work from then on — restart any that are open. Sessions stay on their accounts, and a turn in progress finishes first. " +
            "Workspaces keep their account.")
        assertTrue("asked first", writes().isEmpty())
        shot("2-confirmation")
        confirm(RunnerAccountCopy.SET_DEFAULT_CONFIRM)
        await("Making Work the default — waiting for 2 sessions to finish their turns")
        assertEquals(listOf("POST runners/${fixture.RUNNER}/accounts/claude/$WORK/set-default"), writes())
        shot("3-waiting")
        // One swap per runner at a time: while it waits, the item says so.
        menu("Work")
        await(RunnerAccountCopy.SET_DEFAULT_BUSY)
        compose.onNode(item).assertIsNotEnabled()
    }

    @Test fun defaultsMenuAndACodexAccountsOfferNone() {
        fixture.runnerEngines = claude(default, work)
        fixture.runnerExtra = swaps
        page()
        await("Work")
        menu("Default")
        await(AccountCopy.RENAME)
        assertEquals(0, compose.onAllNodes(item).fetchSemanticsNodes().size)
        assertTrue(RunnerPage.offersSetDefault("claude", RunnerPage.AccountLine(WORK, "Work", null, "yes", WORK, null)))
        assertFalse(RunnerPage.offersSetDefault("codex", RunnerPage.AccountLine(WORK, "Work", null, "yes", WORK, null)))
        assertFalse(RunnerPage.offersSetDefault("claude", RunnerPage.AccountLine("default", "Default", null, "yes", null, null)))
    }

    @Test fun itSaysWhyItCantBeChosen() {
        fixture.runnerEngines = claude(default, work)
        page()
        await("Work")
        menu("Work")
        await(RunnerAccountCopy.SET_DEFAULT_UPDATE)
        compose.onNode(item).assertIsNotEnabled()
        assertEquals("its hint gives way", 0, shown(RunnerAccountCopy.SET_DEFAULT_HINT))
        // Offline, and while this page's own request is on its way, it says so too.
        val runner = Json.parseToJsonElement("{" + swaps.removePrefix(",") + "}").jsonObject
        assertEquals(RunnerAccountCopy.SET_DEFAULT_OFFLINE, RunnerPage.setDefaultBlocked(runner, offline = true, pressing = false))
        assertEquals(RunnerAccountCopy.SET_DEFAULT_BUSY, RunnerPage.setDefaultBlocked(runner, offline = false, pressing = true))
        assertNull(RunnerPage.setDefaultBlocked(runner, offline = false, pressing = false))
    }

    @Test fun theWaitingLineCountsTheTurnsAndATerminal() {
        fixture.runnerEngines = claude(default, work)
        fixture.runnerExtra = swaps + swap("pending")
        page()
        await("Making Work the default")
        assertEquals("no turn to wait for", 0, shown("waiting for"))
        fixture.runnerExtra = swaps + swap("pending", waiting = 1, terminal = true)
        page()
        await("Making Work the default — waiting for 1 session to finish its turn It also waits for Claude Code running in a terminal there to exit.")
    }

    @Test fun aFailedSwapSaysTheMachinesReasonAndThatNothingChanged() {
        fixture.runnerEngines = claude(default, work)
        fixture.runnerExtra = swaps + swap("failed", message = "the Keychain refused the write")
        page()
        await("Couldn’t make Work the default")
        await("the Keychain refused the write")
        await(RunnerAccountCopy.SET_DEFAULT_UNCHANGED)
        assertEquals("no waiting line", 0, shown("Making Work"))
        shot("4-failed")
        // Done: the list as the runner now reports it, nothing more said.
        fixture.runnerExtra = swaps + swap("done")
        page()
        compose.waitUntil(60_000) { shown("Couldn’t make") == 0 }
        assertEquals(0, shown("Making Work"))
    }

    @Test fun aRefusalIsSaidInTheServersWords() {
        fixture.runnerEngines = claude(default, work)
        fixture.runnerExtra = swaps
        fixture.setDefaultRefusal = "A default is already being set on this runner."
        page()
        await("Work")
        menu("Work")
        click(item)
        confirm(RunnerAccountCopy.SET_DEFAULT_CONFIRM)
        await("Couldn’t make Work the default — A default is already being set on this runner.")
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/set-default-android").also { it.mkdirs() }
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
