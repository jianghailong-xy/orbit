package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastHost
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The wiki's Trash (docs/mocks/wiki-trash ②) over a real store and an in-memory server: the page — each wiki in it with
 * when it went, what it holds and when it goes, then Restore and Delete permanently… — and the home's two ways to it, the
 * space picker's item and the first-wiki card's line. What each sentence SAYS is `WikiSettingsFixtureTest`'s, from the
 * shared fixture; here it is drawn, and what reaches the server is the claim. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1400dp")
@OptIn(ExperimentalTestApi::class)
class WikiTrashPageTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val pushed = mutableListOf<OrbitRoute>()

    @Before fun quiet() { OrbitToasts.clear() }

    private fun show(content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme { Box { content(); ToastHost({}, {}, {}) } } } }
        compose.waitForIdle()
    }
    private fun says(tag: String, vararg texts: String) = texts.forEach { text ->
        assertTrue("$tag does not say “$text”", compose.onAllNodes((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and
            hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }
    private fun shown(tag: String) = compose.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    private fun awaitTag(tag: String) = compose.waitUntil(10_000) { shown(tag) }
    private fun top(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().positionInRoot.y
    private fun press(tag: String) { compose.onNodeWithTag(tag).performClick(); compose.waitForIdle() }

    // MARK: the server

    /** Trash, the newest move first, as `GET /wiki/trash` lists it: what a restore or a purge takes leaves it. */
    private val trash = mutableListOf(
        WikiTrashRow("sp9", "orbit-vllm-preview", "orbit · vLLM preview", null, "2026-11-07T12:00:00.000Z", "2027-11-07T12:00:00.000Z", 11138),
        WikiTrashRow("sp8", "orbit", "orbit", "github.com/acme/orbit", "2026-10-02T12:00:00.000Z", "2027-10-02T12:00:00.000Z", 1))
    private var trashStatus = 200
    /** The wikis in use, as `GET /wiki/spaces` lists them: a restored one joins them. */
    private val spaces = mutableListOf<String>()
    /** What a restore, and a purge, answers while it is set: a refusal. */
    private var restoreRefusal: Pair<Int, String>? = null
    private var purgeRefusal: Pair<Int, String>? = null
    private val rig = WikiTestRig { request -> answer(request) }
    private fun answer(request: ApiRequest): Pair<Int, String>? {
        val path = request.path
        val row = path.getOrNull(2)?.let { id -> trash.firstOrNull { it.id == id } }
        return when {
            path == listOf("wiki", "trash") -> trashStatus to Wire.json.encodeToString(WikiTrash.serializer(), WikiTrash(trash.toList()))
            path == listOf("wiki", "spaces") -> 200 to "[${spaces.joinToString(",")}]"
            path.size == 4 && path[3] == "restore" -> restoreRefusal ?: row?.let {
                trash.remove(it)
                val space = """{"id":"${it.id}","slug":"${it.slug}","title":"${it.title}","settings":{}}"""
                spaces += space
                200 to space
            }
            path.size == 4 && path[3] == "purge" -> purgeRefusal ?: row?.let { trash.remove(it); 200 to """{"spaceId":"${it.id}"}""" }
            else -> null
        }
    }
    private fun writes() = rig.requests.filter { it.method != HttpMethod.GET }.map { rig.line(it) }
    private fun trashReads() = rig.requests.count { it.path == listOf("wiki", "trash") }
    private fun trashScreen(): WikiStore {
        val store = rig.store()
        show { WikiTrashScreen(store, OrbitRoute(Destination.WIKI_TRASH)) }
        return store
    }

    // MARK: the page

    @Test fun trashListsEachWikiWithWhenItWentWhatItHoldsAndWhenItGoes() {
        trashScreen()
        compose.onNodeWithTag("wiki-trash-lead").assertTextEquals(WikiModeCopy.trashLead)
        says("wiki-trash-row:sp9", "orbit · vLLM preview", "Moved to Trash Nov 7, 2026 · 11,138 entries · deleted for good Nov 7, 2027")
        says("wiki-trash-row:sp8", "orbit", "Moved to Trash Oct 2, 2026 · 1 entry · deleted for good Oct 2, 2027")
        // The newest move first, as the server lists them, and the lead over them.
        assertTrue(top("wiki-trash-lead") < top("wiki-trash-row:sp9"))
        assertTrue(top("wiki-trash-row:sp9") < top("wiki-trash-row:sp8"))
        compose.onNodeWithTag("wiki-trash-restore:sp9").assertTextEquals(WikiModeCopy.restore)
        compose.onNodeWithTag("wiki-trash-delete:sp9").assertTextEquals(WikiModeCopy.deletePermanently)
        // A row's words are one stop to TalkBack; its two buttons are one each.
        compose.onNodeWithTag("wiki-trash-row:sp9")
            .assertTextEquals("orbit · vLLM preview", "Moved to Trash Nov 7, 2026 · 11,138 entries · deleted for good Nov 7, 2027")
        assertEquals(emptyList<String>(), writes())
    }

    @Test fun anEmptyTrashSaysSo() {
        trash.clear()
        trashScreen()
        says("wiki-trash-empty", WikiModeCopy.trashEmpty)
        compose.onNodeWithTag("wiki-trash-lead").assertTextEquals(WikiModeCopy.trashLead)
    }

    /** A read that failed never reads as an empty Trash; Retry reads it again. */
    @Test fun aTrashThatCouldNotBeReadSaysSoAndReadsAgain() {
        trashStatus = 500
        trashScreen()
        compose.onNodeWithText("Trash couldn't be loaded").assertExists()
        compose.onAllNodesWithText(WikiModeCopy.trashEmpty).assertCountEquals(0)
        trashStatus = 200
        compose.onNodeWithText("Retry").performClick()
        awaitTag("wiki-trash-row:sp9")
    }

    @Test fun restoreBringsTheWikiBackTakesItsRowOutAndSaysSo() {
        val store = trashScreen()
        press("wiki-trash-restore:sp9")
        assertEquals(listOf("POST /api/wiki/spaces/sp9/restore"), writes())
        assertEquals("Restored wiki “orbit · vLLM preview”", OrbitToasts.feed.value.transient?.message)
        compose.waitUntil(5_000) { !shown("wiki-trash-row:sp9") }
        compose.onNodeWithTag("wiki-trash-row:sp8").assertExists()
        // The wikis are read again, the restored one among them.
        assertEquals(listOf("sp9"), store.state.value.spaces.map { it.id })
    }

    @Test fun aRestoreRefusedWhileANewerWikiHoldsTheRepositorySaysTheServersSentence() {
        val why = "A newer wiki for github.com/acme/orbit is in your wikis now. Move it to Trash first, then restore this one."
        restoreRefusal = 409 to """{"message":"$why","error":"Conflict","statusCode":409}"""
        trashScreen()
        press("wiki-trash-restore:sp8")
        compose.onNodeWithText(WikiModeCopy.restoreFailed).assertExists()
        compose.onNodeWithText(why).assertExists()
        press("wiki-refusal-ok")
        compose.onNodeWithTag("wiki-trash-row:sp8").assertExists()
        assertNull(OrbitToasts.feed.value.transient)
    }

    @Test fun deletePermanentlyAsksFirstAndCancelDeletesNothing() {
        trashScreen()
        press("wiki-trash-delete:sp9")
        compose.onNodeWithText(WikiModeCopy.purgeQuestion).assertExists()
        compose.onNodeWithText("Its 11,138 entries and their history will be permanently deleted. This cannot be undone.").assertExists()
        compose.onNodeWithTag("wiki-trash-purge-confirm").assertTextEquals(WikiModeCopy.purgeConfirm)
        press("wiki-trash-purge-cancel")
        compose.onNodeWithTag("wiki-trash-purge-dialog").assertDoesNotExist()
        compose.onNodeWithTag("wiki-trash-row:sp9").assertExists()
        assertEquals(emptyList<String>(), writes())
    }

    @Test fun deletePermanentlyTakesTheWikiOutOfTrashAtOnce() {
        trashScreen()
        press("wiki-trash-delete:sp8")
        compose.onNodeWithText("Its 1 entry and its history will be permanently deleted. This cannot be undone.").assertExists()
        press("wiki-trash-purge-confirm")
        assertEquals(listOf("DELETE /api/wiki/spaces/sp8/purge"), writes())
        compose.waitUntil(5_000) { !shown("wiki-trash-row:sp8") }
        compose.onNodeWithTag("wiki-trash-row:sp9").assertExists()
    }

    @Test fun aRefusedPurgeSaysWhyAndKeepsTheRow() {
        purgeRefusal = 503 to """{"code":"TRANSIENT_DB_CONFLICT","message":"The server was busy. Nothing was deleted."}"""
        trashScreen()
        press("wiki-trash-delete:sp9")
        press("wiki-trash-purge-confirm")
        compose.onNodeWithText(WikiModeCopy.purgeFailed).assertExists()
        compose.onNodeWithText("The server was busy. Nothing was deleted.").assertExists()
        press("wiki-refusal-ok")
        compose.onNodeWithTag("wiki-trash-row:sp9").assertExists()
    }

    // MARK: the home's ways to Trash

    private fun space(id: String, slug: String) = """{"id":"$id","slug":"$slug","repoUrlNorm":"github.com/acme/$slug","settings":{}}"""
    private fun home() {
        val store = rig.store()
        show { WikiHomeScreen(store, OrbitRoute(Destination.WIKI), DirectoryData(), WikiNav({ pushed += it }, {}, "https://wiki.test") {}) }
    }
    private fun link(tag: String): (AnnotatedString.Range<LinkAnnotation>) -> Boolean = { (it.item as? LinkAnnotation.Clickable)?.tag == tag }

    /** With several wikis the picker is a menu that ends at Manage spaces: Trash is not in it, however much Trash holds — it
     *  opens from Wiki settings (docs/mocks/wiki-trash/02-trash-entry). */
    @Test fun thePickerEndsAtManageSpacesWithNoTrashItem() {
        spaces += listOf(space("sp1", "orbit"), space("sp2", "wikova"))
        val reads = trashReads()
        home()
        awaitTag("wiki-space-picker")
        compose.waitUntil(5_000) { trashReads() > reads }
        press("wiki-space-picker")
        compose.onNodeWithTag("wiki-space-manage").assertExists()
        compose.onAllNodesWithTag("wiki-space-trash").assertCountEquals(0)
        compose.onAllNodes(hasText(WikiModeCopy.trash)).assertCountEquals(0)
    }

    /** No wiki left: the first-wiki card says, under its lead, what Trash holds, and opens it. */
    @Test fun anAccountWithNoWikiLeftIsToldWhatTrashHoldsAndOpensIt() {
        home()
        awaitTag("wiki-home-first-trash")
        compose.onNodeWithTag("wiki-home-first-trash").assertTextContains("2 wikis are in Trash. ${WikiModeCopy.openTrash}")
        assertTrue(top("wiki-home-start-lead") < top("wiki-home-first-trash"))
        assertTrue(top("wiki-home-first-trash") < top("wiki-home-start"))
        compose.onNodeWithTag("wiki-home-first-trash").performFirstLinkClick(link("open-trash"))
        compose.waitForIdle()
        assertEquals(listOf(OrbitRoute(Destination.WIKI_TRASH)), pushed)
        trash.removeAt(1)
        home()
        awaitTag("wiki-home-first-trash")
        compose.onNodeWithTag("wiki-home-first-trash").assertTextContains("1 wiki is in Trash. ${WikiModeCopy.openTrash}")
        trash.clear()
        val reads = trashReads()
        home()
        awaitTag("wiki-home-first")
        assertTrue("the home read Trash", trashReads() > reads)
        compose.onAllNodesWithTag("wiki-home-first-trash").assertCountEquals(0)
    }
}
