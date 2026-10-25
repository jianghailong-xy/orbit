package io.orbitd.android.wiki

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.toast.OrbitToasts
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** A12f (A12-5, iOS 2ba6765d9): a wiki space's public link, from the Wiki home's bar, in the real shell over the controlled
 * server ([WikiShell]). The bar is Contents · Activity · Share · Settings; the globe reads the space's link once as each
 * space opens, says "Share…" — and "Live link", in green, while the space has a link open — and opens the one Share panel
 * as "Share wiki": the space's Documents, always, and its Footnotes, off until they are turned on. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = WikiShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class WikiShareShellTest {
    private val main = UnconfinedTestDispatcher()
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(main) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()
    private val shell = WikiShell
    private val orbitShare = "GET wiki/spaces/${WikiShell.SPACE}/share"
    private val wikovaShare = "GET wiki/spaces/${WikiShell.OTHER_SPACE}/share"

    @Before fun start() { shell.reset(); OrbitToasts.clear() }

    /** The globe sits between Activity and Settings and says whether the space on screen has a link open: read once as the
     * home opens, once more for each space picked, each read saying it for its own space. */
    @Test fun theGlobeSitsBeforeSettingsAndSaysWhetherEachSpaceHasALiveLink() {
        shell.shares[WikiShell.OTHER_SPACE] = shell.wikiLink(WikiShell.OTHER_SPACE)
        homeOfOrbit()
        compose.waitForIdle()
        assertEquals("one read as the home opens", 1, shell.count(orbitShare))
        val left = listOf("wiki-bar-contents", "wiki-bar-activity", "wiki-bar-share", "wiki-bar-settings")
            .map { compose.onNodeWithTag(it).fetchSemanticsNode().boundsInRoot.left }
        assertEquals("Contents · Activity · Share · Settings", left.sorted(), left)
        compose.onNodeWithTag("wiki-bar-share").assert(hasContentDescription("Share…")).assert(hasClickAction())
        assertNull("orbit has no link", liveState())
        // wikova has one: its own read, once, and the globe says so.
        pick("wikova")
        awaitThat("wikova's live link") { liveState() == "Live link" }
        // orbit again: read again, and it has none.
        pick("orbit")
        awaitThat("orbit's link read again") { shell.count(orbitShare) == 2 }
        awaitThat("orbit's quiet globe") { liveState() == null }
        compose.waitForIdle()
        assertEquals(2, shell.count(orbitShare))
        assertEquals(1, shell.count(wikovaShare))
    }

    /** The globe opens "Share wiki": a public link made with the defaults, the space's Documents — always included, with how
     * many — and its Footnotes, off, with what they show and the fixed risk sentence; turned on, one PUT of that layer. What
     * the panel last heard is what the globe says once it closes, and turning the link off quiets it again. */
    @Test fun theGlobeOpensShareWikiWithTheSpacesDocumentsAndFootnotes() {
        homeOfOrbit()
        press("wiki-bar-share")
        awaitTag("share-sheet")
        sheet(hasText("Share wiki")).assertExists()
        awaitText("Only you can open it, signed in. Choose “Anyone with the link” to make a public link.")
        press(inSheet(hasText("Anyone with the link") and isSelectable()))
        awaitText("486 footnotes")
        sheet(hasText("Anyone with the link can view — no sign-in. They can’t change anything.")).assertExists()
        sheet(hasText("Documents")).assertExists()
        sheet(hasText("The wiki’s home and every document written so far")).assertExists()
        sheet(hasText("12 documents")).assertExists()
        // Documents has no switch: every link includes it.
        compose.onAllNodes(hasText("Documents") and isToggleable()).assertCountEquals(0)
        val footnotes = inSheet(hasText("Footnotes") and isToggleable())
        sheet(footnotes).assert(hasText("The quotes and code each sentence cites, with file paths and lines. Can include command output and file contents."))
            .assert(hasText("486 footnotes")).assertIsOff()
        press(footnotes)
        awaitThat("Footnotes on") { compose.onAllNodes(footnotes and isOn()).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(listOf("PUT ${WikiShell.SPACE} {}", """PUT ${WikiShell.SPACE} {"include":{"footnotes":true}}"""), shell.shareWrites.toList())
        press(inSheet(hasText("Done") and hasClickAction()))
        awaitThat("the panel closed") { compose.onAllNodesWithTag("share-sheet").fetchSemanticsNodes().isEmpty() }
        awaitThat("the live globe") { liveState() == "Live link" }
        // Only you: asked first, then turned off.
        press("wiki-bar-share")
        awaitTag("share-sheet")
        awaitText("486 footnotes")
        press(inSheet(hasText("Only you") and isSelectable()))
        awaitText("Turn off this link?")
        press(hasText("Turn off") and hasClickAction())
        awaitThat("the link turned off") { shell.shareWrites.lastOrNull() == "DELETE ${WikiShell.SPACE}" }
        awaitText("Only you can open it, signed in. Choose “Anyone with the link” to make a public link.")
        press(inSheet(hasText("Done") and hasClickAction()))
        awaitThat("the quiet globe") { liveState() == null }
    }

    /** Green while the space has a link open — the theme's green, as the Wiki's own green marks — and the bar's colour when it
     * has none. Drawn with Robolectric's native graphics, the globe's own pixels. */
    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE) fun theGlobeIsGreenOnlyWhileTheSpaceHasALiveLink() {
        shell.shares[WikiShell.OTHER_SPACE] = shell.wikiLink(WikiShell.OTHER_SPACE)
        homeOfOrbit()
        val quiet = globe()
        pick("wikova")
        awaitThat("wikova's live link") { liveState() == "Live link" }
        val live = globe()
        println("globe pixels: quiet inked=${quiet.count(::inked)} green=${quiet.count(::green)}; live inked=${live.count(::inked)} green=${live.count(::green)}")
        assertTrue("the globe is drawn: ${quiet.count(::inked)} inked pixels", quiet.count(::inked) > 20)
        assertEquals("no green without a link", 0, quiet.count(::green))
        assertTrue("green with a link: ${live.count(::green)} of ${live.count(::inked)} inked pixels", live.count(::green) > 20)
    }

    // MARK: helpers (WikiShellTest's)

    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { shell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    /** Signed in, on orbit's home, with its link read. */
    private fun homeOfOrbit() {
        signIn()
        open("orbit://wiki/${WikiShell.SPACE}")
        awaitTag("wiki-home-list")
        awaitThat("orbit's link read") { shell.count(orbitShare) >= 1 }
    }
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    /** The space picked in the home's menu, by its name. */
    private fun pick(name: String) {
        press("wiki-space-picker")
        press("wiki-space:$name")
        awaitThat("$name's home") { picker().contains(name) }
    }
    private fun inSheet(matcher: SemanticsMatcher) = matcher and hasAnyAncestor(hasTestTag("share-sheet"))
    private fun sheet(matcher: SemanticsMatcher) = compose.onNode(inSheet(matcher))
    private fun press(tag: String) = press(hasTestTag(tag))
    /** A press once its node is there and enabled. */
    private fun press(matcher: SemanticsMatcher) {
        awaitThat("$matcher") { compose.onAllNodes(matcher and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(matcher).performClick()
        compose.waitForIdle()
    }
    /** What the globe says after "Share…" — "Live link", or nothing. */
    private fun liveState(): String? = compose.onAllNodesWithTag("wiki-bar-share").fetchSemanticsNodes().firstOrNull()
        ?.config?.getOrNull(SemanticsProperties.StateDescription)
    private fun picker(): String = compose.onAllNodesWithTag("wiki-space-picker").fetchSemanticsNodes().firstOrNull()
        ?.let { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { text -> text.text } }.orEmpty()

    /** The globe's pixels as the window draws them. */
    private fun globe(): IntArray {
        compose.waitForIdle()
        val bounds = compose.onNodeWithTag("wiki-bar-share").fetchSemanticsNode().boundsInWindow
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val left = bounds.left.toInt(); val top = bounds.top.toInt()
        val width = bounds.width.toInt().coerceAtMost(bitmap.width - left); val height = bounds.height.toInt().coerceAtMost(bitmap.height - top)
        return IntArray(width * height).also { bitmap.getPixels(it, 0, width, left, top, width, height); bitmap.recycle() }
    }
    private fun rgb(pixel: Int) = Triple(pixel shr 16 and 0xFF, pixel shr 8 and 0xFF, pixel and 0xFF)
    /** Darker than the bar it sits on: the glyph's stroke, in whatever colour. */
    private fun inked(pixel: Int) = rgb(pixel).let { (r, g, b) -> r + g + b < 600 }
    /** The theme's green (#247344 in light) or its blend into the bar: green well above red and blue. */
    private fun green(pixel: Int) = rgb(pixel).let { (r, g, b) -> g - r > 30 && g - b > 20 }

    private fun awaitTag(tag: String) = awaitThat(tag) { compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitText(text: String) = awaitThat(text) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitThat(what: String, condition: () -> Boolean) {
        try { compose.waitUntil(60_000) { compose.waitForIdle(); condition() } }
        catch (timeout: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError("waited for $what; on screen: '${screenText()}'; share writes=${shell.shareWrites}; " +
                "last calls=${shell.calls.takeLast(30)}", timeout)
        }
    }
    /** What the screen says, for a wait that ran out. */
    private fun screenText(): String = compose.onAllNodes(hasText("", substring = true)).fetchSemanticsNodes().take(40)
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text } }.joinToString(" | ")
}
