package io.orbitd.android.composer

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Before
import org.junit.Rule
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The production app over [ComposerShell]: sign in, open the session (or a new session in its workspace), and read what the
 * composer and the transcript draw. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ComposerShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
abstract class ComposerShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun startShell() = ComposerShell.reset()

    protected fun app() = compose.activity.application as OrbitApplication
    /** Waits up to a minute; a wait that fails prints what the screen held, and the requests made, so the report says why. */
    protected fun await(condition: () -> Boolean) = try { compose.waitUntil(60_000, condition) } catch (timeout: ComposeTimeoutException) {
        println("--- screen ---")
        compose.onAllNodes(isRoot()).fetchSemanticsNodes().indices.forEach { println(compose.onAllNodes(isRoot())[it].printToString(Int.MAX_VALUE)) }
        println("--- requests ---\n" + ComposerShell.calls.joinToString("\n"))
        throw timeout
    }
    protected fun has(matcher: SemanticsMatcher, unmerged: Boolean = false) =
        compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty()
    protected fun shows(text: String) = has(hasText(text))
    protected fun awaitText(text: String) = await { shows(text) }

    protected fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ComposerShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }

    /** A link as Android delivers one to the running Activity; the launch intent is put back for ActivityScenario. */
    protected fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }

    protected fun openSession() {
        open("orbit-session:${ComposerShell.SESSION}")
        await { has(hasTestTag("composer-model") and isEnabled()) }
    }

    /** A new session in the workspace, from its page's New session. */
    protected fun openDraft() {
        await { has(hasText("Alpha") and hasClickAction()) }
        compose.onAllNodes(hasText("Alpha") and hasClickAction())[0].performClick()
        val newSession = hasText("New session") and hasClickAction() and isEnabled()
        await { has(newSession) }
        // The page's own, not the closed drawer's off to the left.
        val onScreen = compose.onAllNodes(newSession).fetchSemanticsNodes().indexOfFirst { it.boundsInRoot.left >= 0 }
        compose.onAllNodes(newSession)[onScreen].performClick()
        await { has(hasTestTag("composer-model") and isEnabled()) }
    }

    /** The model chip's dialog, once the runner and the providers are read. */
    protected fun openModelMenu() {
        compose.onNodeWithTag("composer-model").performClick()
        await { has(hasText("Provider") and hasAnyAncestor(isDialog())) }
    }

    /** Every pressable line of the open dialog, top to bottom, as its text reads. */
    protected fun dialogButtons(): List<String> = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text } }

    /** Every row of the open dialog, top to bottom — a button's texts on lines of their own. */
    protected fun dialogLines(): List<String> = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasText("", substring = true))
        .fetchSemanticsNodes().mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString("\n") { it.text } }

    /** The dialog's lines after the [heading] line, up to the first of [until]. */
    protected fun section(heading: String, until: Set<String>): List<String> =
        dialogLines().dropWhile { it != heading }.drop(1).takeWhile { it !in until }
}
