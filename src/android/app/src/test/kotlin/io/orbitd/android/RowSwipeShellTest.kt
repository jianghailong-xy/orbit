package io.orbitd.android

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.auth.AuthState
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

/** A session row's swipe on the production Activity, store and list over [NavShell]: iOS's `SessionRowActions` and `CircleSwipeRow`,
 * driven by touches on the row (docs/mocks/android-row-swipe). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = NavShellApplication::class, qualifiers = "w411dp-h891dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class, ExperimentalTestApi::class)
class RowSwipeShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = NavShell.reset()

    private val plain = hasRowMenu("Options for Plain notes")
    private val review = hasRowMenu("Options for Review navigation")
    private fun button(title: String) = hasTestTag("row-action:$title")
    private val anyButton = SemanticsMatcher("a row's swipe button") { node ->
        node.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.startsWith("row-action:") == true
    }

    @Test fun leftShowsShareMoveDeleteAndRightCompleteAndPin() {
        signIn(); await { exists(plain) }
        swipe(plain, 0.8f, 0.3f)
        await { exists(button("Delete")) }
        val order = listOf("Share", "Move", "Delete").map { compose.onNode(button(it)).fetchSemanticsNode().boundsInRoot.left }
        assertEquals("left to right the row reads Share · Move · Delete", order.sorted(), order)
        assertFalse(exists(button("Complete")))
        tap(review)
        await { !exists(anyButton) }
        swipe(plain, 0.2f, 0.6f)
        await { exists(button("Complete")) && exists(button("Pin")) }
        assertTrue(compose.onNode(button("Complete")).fetchSemanticsNode().boundsInRoot.left < compose.onNode(button("Pin")).fetchSemanticsNode().boundsInRoot.left)
    }

    /** However far and fast the row is pulled left, it comes to rest open and fires nothing: Delete is a press. */
    @Test fun aLongSwipeLeftOpensAndNeverDeletes() {
        signIn(); await { exists(plain) }
        swipe(plain, 0.95f, 0.02f, durationMillis = 120)
        await { exists(button("Delete")) }
        assertFalse(NavShell.calls.any { it.startsWith("DELETE") })
        compose.onNode(button("Delete")).performClick()
        await { NavShell.calls.any { it == "DELETE sessions/${NavShell.PLAIN}" } }
        await { toastShows("Moved to Trash") }
    }

    @Test fun aFullSwipeRightCompletes() {
        signIn(); await { exists(plain) }
        swipe(plain, 0.1f, 0.95f)
        await { NavShell.calls.any { it == "POST sessions/${NavShell.PLAIN}/complete" } }
        await { toastShows("Session completed") }
    }

    /** One open at a time; while one is open a tap on any row only shuts it, and opens no session. */
    @Test fun aTapWhileARowIsOpenOnlyShutsIt() {
        signIn(); await { exists(plain) }
        swipe(plain, 0.8f, 0.3f)
        await { exists(button("Delete")) }
        swipe(review, 0.2f, 0.6f)
        await { exists(button("Complete")) && !exists(button("Delete")) }
        tap(plain)
        await { !exists(anyButton) }
        assertTrue("the tap opened nothing", exists(plain) && exists(review))
        assertFalse(NavShell.calls.any { it.startsWith("GET sessions/${NavShell.PLAIN}/") })
        // With nothing open, a tap opens it.
        tap(plain)
        await { NavShell.calls.any { it.startsWith("GET sessions/${NavShell.PLAIN}") } }
    }

    /** Back shuts an open row first, as it does an open drawer; the list stays. */
    @Test fun backShutsAnOpenRowFirst() {
        signIn(); await { exists(plain) }
        swipe(plain, 0.8f, 0.3f)
        await { exists(button("Delete")) }
        compose.runOnUiThread { compose.activity.onBackPressedDispatcher.onBackPressed() }
        await { !exists(anyButton) }
        assertTrue(exists(plain))
        assertFalse(compose.activity.isFinishing)
    }

    /** A drag more up than across is the list's. One that starts in the edge strip is the drawer's, and the row stays shut. */
    @Test fun aVerticalDragOrOneFromTheEdgeLeavesTheRowShut() {
        signIn(); await { exists(plain) }
        compose.onNode(plain).performTouchInput { swipe(Offset(width * 0.7f, centerY), Offset(width * 0.75f, centerY - 400f), 200) }
        compose.waitForIdle()
        assertFalse(exists(anyButton))
        assertFalse("the drawer starts shut", drawerOpen())
        compose.onNode(plain).performTouchInput { swipe(Offset(6.dp.toPx(), centerY), Offset(width * 0.85f, centerY), 250) }
        await { drawerOpen() }
        assertFalse(exists(anyButton))
    }

    @Test fun completedAndTrashOfferTheirOwnSides() {
        NavShell.lifecycle = mapOf(NavShell.SESSION to "COMPLETED", NavShell.PLAIN to "TRASH")
        signIn(); await { exists(hasText("No open sessions")) }
        compose.pickFromSessionOptions("Completed")
        await { exists(review) }
        swipe(review, 0.2f, 0.6f)
        await { exists(button("Move to Open")) && exists(button("Pin")) }
        // Move to Open's slot is wider than the default one: the row rests clear of both buttons once they are measured.
        await { clearOf(review, "Pin", leading = true) }
        tap(review); await { !exists(anyButton) }
        swipe(review, 0.8f, 0.3f)
        await { exists(button("Share")) && exists(button("Move")) && exists(button("Delete")) }
        tap(review); await { !exists(anyButton) }
        compose.pickFromSessionOptions("Trash")
        await { exists(plain) }
        swipe(plain, 0.2f, 0.6f)
        await { exists(button("Move to Open")) && !exists(button("Pin")) }
        tap(plain); await { !exists(anyButton) }
        swipe(plain, 0.95f, 0.02f, durationMillis = 120)
        await { exists(button("Delete Permanently")) && !exists(button("Share")) }
        await { clearOf(plain, "Delete Permanently", leading = false) }
        assertFalse("a full swipe never purges", NavShell.calls.any { it.endsWith("/purge") })
        compose.onNode(button("Delete Permanently")).performClick()
        await { exists(hasText("Delete permanently?")) }
        assertFalse("it asks first", NavShell.calls.any { it.endsWith("/purge") })
    }

    /** TalkBack is offered the swipe's actions on the row itself, and its long press is still the menu. */
    @Test fun theRowCarriesItsSwipeActionsForAScreenReader() {
        signIn(); await { exists(plain) }
        val node = compose.onNode(plain).fetchSemanticsNode()
        assertEquals(listOf("Complete", "Pin", "Delete", "Move", "Share"), node.config.getOrNull(SemanticsActions.CustomActions)?.map { it.label })
        assertEquals("Options for Plain notes", node.config.getOrNull(SemanticsActions.OnLongClick)?.label)
        compose.onNode(plain).performCustomAccessibilityActionWithLabel("Pin")
        await { NavShell.calls.any { it == "POST sessions/${NavShell.PLAIN}/pin" } }
        compose.onNode(plain).performCustomAccessibilityActionWithLabel("Share")
        await { exists(hasText("Share session")) }
    }

    @Test fun theLongPressIsTheSameListInIosWords() {
        signIn(); await { exists(plain) }
        compose.onNode(plain).openRowMenu()
        await { exists(hasText("Rename…") and hasAnyAncestor(isDialog())) }
        val items = compose.onAllNodes(hasClickAction() and hasAnyAncestor(isDialog())).fetchSemanticsNodes()
            .mapNotNull { it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.Text)?.joinToString("") { t -> t.text } }
        assertEquals(listOf("Rename…", "Pin", "Tags…", "Complete", "Share…", "Move…", "Delete", "Close"), items)
        assertFalse(exists(hasText("This action isn't available", substring = true)))
    }

    private fun swipe(row: SemanticsMatcher, from: Float, to: Float, durationMillis: Long = 250) {
        compose.onNode(row).performScrollTo().performTouchInput { swipe(Offset(width * from, centerY), Offset(width * to, centerY), durationMillis) }
        compose.waitForIdle()
    }
    private fun tap(row: SemanticsMatcher) { compose.onNode(row).performTouchInput { click() }; compose.waitForIdle() }
    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    /** The closed drawer stays composed off screen: open is its rows' position on screen (bounds are clipped, so read 0 off screen too). */
    private fun drawerOpen() = compose.onAllNodes(hasText("Tasks")).fetchSemanticsNodes().any { it.positionInRoot.x >= 0f }
    /** The slid row has cleared the button's slot: its edge is past the button's. */
    private fun clearOf(row: SemanticsMatcher, title: String, leading: Boolean): Boolean {
        val slid = compose.onNode(row).fetchSemanticsNode().boundsInRoot
        val shown = compose.onNode(button(title)).fetchSemanticsNode().boundsInRoot
        return if (leading) slid.left >= shown.right else slid.right <= shown.left
    }
    private fun toastShows(text: String) = exists(hasText(text) and hasAnyAncestor(hasTestTag("toast")))
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { NavShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000) { compose.waitForIdle(); condition() }
}
