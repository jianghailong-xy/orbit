package io.orbitd.android.management

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.Origin
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.coroutines.runBlocking
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
 * Fix with an agent over the controlled server (agent-fix contract; boards board-attention.png and install-failed-board.png): the
 * Codex update card offers it after Update Engines Now and before its Dismiss link; one press POSTs
 * runners/:id/attention/engineNotUpdating/fix with the engine, the runners are read again, and the button gives way to "An agent is
 * fixing this in orbit-dev · Open session", which opens that session. Blocked, the button is drawn disabled over the server's reason. A
 * failed install's section on the engine page does the same with installFailed, its grey line saying where the session starts, and a
 * signed-out engine's reason adds where to sign in. Each state is drawn to `src/android/build/evidence/agent-fix-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AgentFixPageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    private val opened = mutableListOf<OrbitRoute>()

    @Before fun start() { fixture.reset(); fixture.runnerAlias = "aivps-sg"; opened.clear() }

    private fun page(record: String?) {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.setContent { OrbitTheme(darkTheme = false) { Surface(color = MaterialTheme.colorScheme.background) {
            RunnerScreen(api, fixture.RUNNER, record, 0, { opened += it }, {}, {})
        } } }
        compose.waitForIdle()
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun shown(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size
    /** The Fix with an agent button inside [tag]'s box. */
    private fun fixButton(tag: String) = hasText(RunnerCopy.FIX_WITH_AGENT) and hasClickAction() and hasAnyAncestor(hasTestTag(tag))
    private fun buttons(tag: String) = compose.onAllNodes(fixButton(tag)).fetchSemanticsNodes().size
    private fun line(tag: String) = hasAnyAncestor(hasTestTag(tag)) or hasTestTag(tag)
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(60_000) { compose.onAllNodes(matcher and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun scrollTo(tag: String) { try { compose.onNodeWithTag(tag).performScrollTo() } catch (_: AssertionError) { }; compose.waitForIdle() }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/agent-fix-android").also { it.mkdirs() }
    }
    private fun shot(name: String) {
        compose.waitForIdle()
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    /** Codex 13 days behind 0.169.0, its last update failed half an hour ago: the engineNotUpdating card. */
    private val codexBehind: String get() {
        val now = Instant.now()
        return """[{"engine":"claude","installed":true,"version":"2.1.290 (Claude Code)","auth":"yes"},
            {"engine":"codex","installed":true,"version":"codex-cli 0.159.2","auth":"yes","update":{"status":"failed",
              "at":"${now.minusSeconds(1_800)}","okAt":"${now.minusSeconds(20 * 86_400L)}","latest":"0.169.0",
              "behindSince":"${now.minusSeconds(13 * 86_400L + 3_600)}","message":"npm isn't on this runner's PATH."}}]"""
    }
    /** Codex not installed, its install failed: the engine page's Install failed section. */
    private val codexMissing = """[{"engine":"claude","installed":true,"version":"2.1.290 (Claude Code)","auth":"yes"},
        {"engine":"codex","installed":false,"auth":"unknown"}]"""
    private val installFailed = ""","install":{"engine":"codex","mode":"install","status":"failed","message":"exit status 127: sh: 1: npm: not found"}"""

    private fun fixing(kind: String, engine: String?) = """{"kind":"$kind","engine":${engine?.let { "\"$it\"" } ?: "null"},
        "sessionId":"${fixture.SESSION}","workspaceId":"${fixture.WORKSPACE}","workspaceName":"orbit-dev"}"""
    private fun agentFix(blocked: String? = null, message: String = "", fixing: String = "") =
        ""","agentFix":{"workspaceId":"${fixture.WORKSPACE}","workspaceName":"orbit-dev","engine":"claude","engineName":"Claude Code",
        "blocked":${blocked?.let { """{"code":"$it","message":"$message"}""" } ?: "null"},"fixing":[$fixing]}"""

    private val card = "attention-fix:engineNotUpdating:codex"
    private val install = "install-fix:codex"

    @Test fun theCardsPressStartsTheSessionAndTheLineThenOpensIt() {
        fixture.runnerEngines = codexBehind
        fixture.runnerExtra = agentFix()
        fixture.onAgentFix = { fixture.runnerExtra = agentFix(fixing = fixing("engineNotUpdating", "codex")) }
        page(null)
        await("Codex update failed")
        compose.waitUntil(60_000) { compose.onAllNodes(fixButton(card) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        assertEquals("Dismiss stays beside it", 1, shown("Dismiss until next Codex release"))
        assertEquals("no line while a press can start", 0, compose.onAllNodesWithTag("$card:line").fetchSemanticsNodes().size)
        shot("card-button")
        assertTrue("nothing sent before the press", fixture.agentFixBodies.isEmpty())

        click(fixButton(card))
        await("An agent is fixing this in orbit-dev")
        assertEquals(listOf("""engineNotUpdating {"engine":"codex"}"""), fixture.agentFixBodies.toList())
        assertEquals("the button is gone", 0, buttons(card))
        assertEquals("Dismiss stays", 1, shown("Dismiss until next Codex release"))
        assertTrue("no navigation on success", opened.isEmpty())
        shot("card-fixing")

        click(hasText(RunnerCopy.OPEN_SESSION) and hasAnyAncestor(hasTestTag("$card:line")))
        assertEquals(listOf(OrbitRoute(Destination.SESSION, fixture.SESSION, origin = Origin.LINK)), opened)
    }

    @Test fun aBlockedCardDrawsTheButtonDisabledOverTheReason() {
        fixture.runnerEngines = codexBehind
        val reason = "An agent can't run here: orbit-dev uses Claude Code, which is signed out on this machine."
        fixture.runnerExtra = agentFix("engineSignedOut", reason)
        page(null)
        await(reason)
        compose.onNode(fixButton(card)).assertIsNotEnabled()
        assertEquals("the card names no sign-in of its own", 0, shown("above to use this"))
        shot("card-blocked")
    }

    @Test fun noWorkspaceIsTheSameDisabledButtonAndLine() {
        fixture.runnerEngines = codexBehind
        fixture.runnerExtra = agentFix("noWorkspace", "No workspace runs on this machine yet.")
        page(null)
        await("No workspace runs on this machine yet.")
        compose.onNode(fixButton(card)).assertIsNotEnabled()
    }

    @Test fun aRefusalSaysTheServersWordsAndReadsTheRunnersAgain() {
        fixture.runnerEngines = codexBehind
        fixture.runnerExtra = agentFix()
        fixture.agentFixRefusal = "An agent is already fixing this."
        page(null)
        val reads = { fixture.calls.count { it == "GET runners" } }
        compose.waitUntil(60_000) { compose.onAllNodes(fixButton(card) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        val before = reads()
        click(fixButton(card))
        await("An agent is already fixing this.")
        assertTrue("runners read again after a 409", reads() > before)
    }

    @Test fun anOlderServerWithoutAgentFixDrawsNoButton() {
        fixture.runnerEngines = codexBehind
        page(null)
        await("Codex update failed")
        await("Dismiss until next Codex release")
        assertEquals(0, shown(RunnerCopy.FIX_WITH_AGENT))
    }

    @Test fun aFailedInstallsSectionSaysWhereTheSessionStartsAndPressesInstallFailed() {
        fixture.runnerEngines = codexMissing
        fixture.runnerExtra = installFailed + agentFix()
        fixture.onAgentFix = { fixture.runnerExtra = installFailed + agentFix(fixing = fixing("installFailed", "codex")) }
        page("engine:codex")
        await("exit status 127")
        await("Starts a session in orbit-dev on this machine, with Claude Code.")
        compose.waitUntil(60_000) { compose.onAllNodes(fixButton(install) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        scrollTo(install)
        shot("install-button")

        click(fixButton(install))
        await("An agent is fixing this in orbit-dev")
        assertEquals(listOf("""installFailed {"engine":"codex"}"""), fixture.agentFixBodies.toList())
        assertEquals(0, buttons(install))
        assertEquals("Retry stays", 1, compose.onAllNodes(hasText(MachinesAndModels.RETRY) and hasClickAction()).fetchSemanticsNodes().size)
        assertEquals(0, shown("Starts a session in"))
        shot("install-fixing")
        click(hasText(RunnerCopy.OPEN_SESSION) and line("$install:line"))
        assertEquals(listOf(OrbitRoute(Destination.SESSION, fixture.SESSION, origin = Origin.LINK)), opened)
    }

    @Test fun aSignedOutEnginesReasonOnTheInstallSectionSaysWhereToSignIn() {
        fixture.runnerEngines = codexMissing
        fixture.runnerExtra = installFailed + agentFix("engineSignedOut",
            "An agent can't run here: orbit-dev uses Claude Code, which is signed out on this machine.")
        page("engine:codex")
        await("which is signed out on this machine. Sign in to Claude Code above to use this.")
        compose.onNode(fixButton(install)).assertIsNotEnabled()
        scrollTo(install)
        shot("install-blocked")
    }

    @Test fun anOfflineMachinesInstallSectionSaysSoWithTheButtonOff() {
        fixture.runnerOnline = false
        fixture.runnerEngines = codexMissing
        fixture.runnerExtra = installFailed + agentFix("offline", "This machine is offline.")
        page("engine:codex")
        await("This machine is offline.")
        compose.onNode(fixButton(install)).assertIsNotEnabled()
    }
}
