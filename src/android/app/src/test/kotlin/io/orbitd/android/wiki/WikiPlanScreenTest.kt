package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitNavigation
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The plan's screen over a real store and an in-memory server (iOS `WikiPlanScreen`): what it reads, the requests each
 * write makes on the owner's door, and what the owner is told — a toast, the refusal alert, the gate's errors on a card. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1400dp")
class WikiPlanScreenTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private var navigation = OrbitNavigation().select("Wiki", OrbitRoute(Destination.WIKI))
    private val space = """{"id":"sp1","slug":"orbit","settings":{"maintenance":{"enabled":true,"workspaceId":"w1","provider":"local-vllm"}}}"""
    private var plan: Pair<Int, String> = 200 to WikiPlanFixture.read("draftReady").toString()
    /** What the server answers a write, by its path's last word. */
    private val writes = mutableMapOf<String, Pair<Int, String>>()
    private val rig = WikiTestRig { request -> answer(request) }

    @Before fun quiet() { WikiToast.text = null }

    private fun answer(request: ApiRequest): Pair<Int, String>? {
        val path = request.path.joinToString("/")
        if (request.method != HttpMethod.GET) return writes[request.path.last()] ?: (200 to "{}")
        return when (path) {
            "wiki/spaces" -> 200 to "[$space]"
            "wiki/spaces/sp1/plan" -> plan
            "wiki/spaces/sp1/plan/versions" -> 200 to buildJsonObject { put("versions", WikiPlanFixture.plan.obj("versionRows").arr("versions")) }.toString()
            "wiki/spaces/sp1/docs" -> 200 to WikiPlanFixture.shared.obj("docs").obj("directory").obj("read").toString()
            else -> null
        }
    }

    private fun screen(route: OrbitRoute) {
        val store = rig.store()
        navigation = navigation.push(route)
        val nav = WikiNav({ navigation = navigation.push(it) }, { change -> navigation = change(navigation) }, "https://wiki.test") {}
        // The shell's bar: the actions the page binds to its route (Contents, Edit).
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme { Box {
            Column { Row { PageBar.Actions(route, this) }; WikiPlanScreen(store, route, DirectoryData(), nav) }
            WikiToast.Host()
        } } } }
        compose.waitForIdle()
    }
    private fun writes() = rig.requests.filter { it.method != HttpMethod.GET }.map { rig.line(it) }
    private fun scrollTo(tag: String) = compose.onNodeWithTag("wiki-plan-page").performScrollToNode(hasTestTag(tag))

    @Test fun aSpaceWithNoPlanSaysSo() {
        plan = 404 to """{"message":"no plan"}"""
        screen(OrbitRoute(Destination.WIKI_PLAN))
        compose.onNodeWithTag("wiki-plan-missing").assertExists()
        compose.onNodeWithText(WikiPlanCopy.none).assertIsDisplayed()
    }

    @Test fun confirmPlanConfirmsTheVersionShownAndGoesBackToThePlanInForce() {
        writes["confirm"] = 200 to """{"id":"v2","version":2,"status":"confirmed"}"""
        val route = OrbitRoute(Destination.WIKI_PLAN, wikiVersion = 2)
        screen(route)
        compose.onNodeWithTag("wiki-plan-confirm").performClick()
        compose.waitForIdle()
        assertEquals(listOf("POST /api/wiki/spaces/sp1/plan/versions/2/confirm"), writes())
        assertEquals(WikiPlanCopy.confirmed(2), WikiToast.text)
        // A version asked for by number gives way to the page's own once it is confirmed.
        assertEquals(OrbitRoute(Destination.WIKI_PLAN), navigation.current)
    }

    @Test fun aConfirmationTheGateRefusedSaysEveryError() {
        writes["confirm"] = 422 to """{"code":"WIKI_PLAN_GATE","message":"2 errors","errors":[
            {"check":"docCount","path":"plan.docs","message":"the plan has 3 documents; it must have 20 to 35"},
            {"check":"references","path":"plan.docs[0].sections[1].sources.code[0]","message":"no such file"}]}"""
        screen(OrbitRoute(Destination.WIKI_PLAN))
        compose.onNodeWithTag("wiki-plan-confirm").performClick()
        compose.waitForIdle()
        compose.onNodeWithText(WikiCopy.refused).assertExists()
        compose.onNodeWithText("plan.docs the plan has 3 documents; it must have 20 to 35\nplan.docs[0].sections[1].sources.code[0] no such file").assertExists()
        compose.onNodeWithTag("wiki-refusal-ok").performClick()
        compose.onAllNodesWithText(WikiCopy.refused).assertCountEquals(0)
        assertNull(WikiToast.text)
    }

    @Test fun acceptWithNoDraftWaitingConfirmsTheDraftItMade() {
        plan = 200 to WikiPlanFixture.read("changes").toString()
        writes["decide"] = 200 to """{"proposal":{"id":"pp2","status":"accepted"},"draft":{"id":"v2","version":2,"status":"draft"}}"""
        writes["confirm"] = 200 to """{"id":"v2","version":2,"status":"confirmed"}"""
        screen(OrbitRoute(Destination.WIKI_PLAN))
        scrollTo("wiki-plan-accept:pp2")
        compose.onNodeWithTag("wiki-plan-accept:pp2").performClick()
        compose.waitForIdle()
        assertEquals(listOf("POST /api/wiki/plan-proposals/pp2/decide", "POST /api/wiki/spaces/sp1/plan/versions/2/confirm"), writes())
        assertEquals(buildJsonObject { put("action", "accept") }, rig.body(rig.requests.first { it.method != HttpMethod.GET }))
        assertEquals(WikiPlanCopy.confirmed(2), WikiToast.text)
    }

    @Test fun anAcceptanceTheGateRefusedKeepsTheChangeWithItsErrors() {
        plan = 200 to WikiPlanFixture.read("changes").toString()
        writes["decide"] = 422 to """{"code":"WIKI_PLAN_GATE","message":"1 error","errors":[{"check":"protected","path":"plan.docs[1]","message":"session-runtime is protected"}]}"""
        screen(OrbitRoute(Destination.WIKI_PLAN))
        scrollTo("wiki-plan-accept:pp1")
        compose.onNodeWithTag("wiki-plan-accept:pp1").performClick()
        compose.waitForIdle()
        // Nothing was confirmed: one request, and the card says why.
        assertEquals(listOf("POST /api/wiki/plan-proposals/pp1/decide"), writes())
        scrollTo("wiki-plan-change-refused:pp1")
        assertTrue(compose.onAllNodes(hasAnyAncestor(hasTestTag("wiki-plan-change-refused:pp1")) and hasText("plan.docs[1] session-runtime is protected"),
            useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        assertNull(WikiToast.text)
    }

    @Test fun editAcceptsOnlyAndOpensTheDocumentToEdit() {
        plan = 200 to WikiPlanFixture.read("changes").toString()
        writes["decide"] = 200 to """{"draft":{"id":"v2","version":2,"status":"draft"}}"""
        screen(OrbitRoute(Destination.WIKI_PLAN))
        scrollTo("wiki-plan-edit:pp1")
        compose.onNodeWithTag("wiki-plan-edit:pp1").performClick()
        compose.waitForIdle()
        assertEquals(listOf("POST /api/wiki/plan-proposals/pp1/decide"), writes())
        assertEquals(WikiPlanCopy.changeAdded(2), WikiToast.text)
        compose.onNodeWithTag("wiki-plan-edit-sheet").assertExists()
        compose.onNodeWithText(WikiPlanCopy.editTitle("2.1")).assertExists()
    }

    @Test fun rejectSaysTheChangeWasRejected() {
        plan = 200 to WikiPlanFixture.read("changes").toString()
        screen(OrbitRoute(Destination.WIKI_PLAN))
        scrollTo("wiki-plan-reject:pp2")
        compose.onNodeWithTag("wiki-plan-reject:pp2").performClick()
        compose.waitForIdle()
        assertEquals(listOf("POST /api/wiki/plan-proposals/pp2/decide"), writes())
        assertEquals(buildJsonObject { put("action", "reject") }, rig.body(rig.requests.first { it.method != HttpMethod.GET }))
        assertEquals(WikiPlanCopy.changeRejected, WikiToast.text)
    }

    @Test fun redraftSendsTheOwnersWordsAndSaysTheDraftIsOnItsWay() {
        plan = 200 to WikiPlanFixture.read("inForce").toString()
        writes["redraft"] = 200 to """{"created":true,"job":{"id":"j","kind":"revise","state":"queued"}}"""
        screen(OrbitRoute(Destination.WIKI_PLAN))
        compose.onNodeWithTag("wiki-plan-redraft").performClick()
        compose.onNodeWithText(WikiPlanCopy.redraftNote("local-vllm", 1 to true)).assertExists()
        compose.onNodeWithText(WikiPlanCopy.protectedKept(listOf("2.1"))).assertExists()
        compose.onNodeWithTag("wiki-plan-redraft-words").performTextInput("  merge the session documents  ")
        compose.onNodeWithTag("wiki-plan-redraft-go").performClick()
        compose.waitForIdle()
        assertEquals(listOf("POST /api/wiki/spaces/sp1/plan/redraft"), writes())
        assertEquals(buildJsonObject { put("instructions", "merge the session documents") }, rig.body(rig.requests.first { it.method != HttpMethod.GET }))
        assertEquals(WikiPlanCopy.redraftAsked, WikiToast.text)
        compose.onAllNodesWithTag("wiki-plan-redraft-sheet").assertCountEquals(0)
    }

    @Test fun aVersionPickedFromTheMenuTakesThePagesPlace() {
        screen(OrbitRoute(Destination.WIKI_PLAN))
        compose.onNodeWithTag("wiki-plan-version-menu").performClick()
        compose.onNodeWithTag("wiki-plan-version:1").performClick()
        assertEquals(OrbitRoute(Destination.WIKI_PLAN, wikiVersion = 1), navigation.current)
        assertEquals(2, navigation.frames.size)
    }

    @Test fun aDocumentsEditIsSavedAsANewDraft() {
        writes["edits"] = 200 to """{"id":"v3","version":3,"status":"draft"}"""
        screen(OrbitRoute(Destination.WIKI_PLAN_DOC, "agent-tests"))
        compose.onNodeWithTag("wiki-plan-doc-title").assertTextContains("3.1 测试怎么跑", substring = true)
        // The draft waiting is the newest version: its documents are edited, from the Edit the page puts in the bar.
        compose.onNodeWithTag("wiki-plan-doc-edit").performClick()
        compose.onNodeWithText(WikiPlanCopy.editTitle("3.1")).assertExists()
        compose.onNodeWithText(WikiPlanCopy.saveNote(3)).assertExists()
        compose.onNodeWithTag("wiki-plan-edit-title").performTextReplacement("测试与依赖")
        compose.onNodeWithTag("wiki-plan-edit-save").performClick()
        compose.waitForIdle()
        assertEquals(listOf("POST /api/wiki/spaces/sp1/plan/edits"), writes())
        val body = rig.body(rig.requests.first { it.method != HttpMethod.GET })!!
        assertEquals(2, body.int("baseVersion"))
        assertEquals("agent-tests", body.str("docSlug"))
        assertEquals("测试与依赖", body.obj("doc").str("title"))
        assertFalse(body.toString(), body.toString().contains("\"position\""))
        assertEquals(WikiPlanCopy.draftSaved(3), WikiToast.text)
        compose.onAllNodesWithTag("wiki-plan-edit-sheet").assertCountEquals(0)
    }

    @Test fun aDocumentOrSectionThePlanDoesNotHaveSaysSo() {
        screen(OrbitRoute(Destination.WIKI_PLAN_DOC, "no-such-doc"))
        compose.onNodeWithText("That document is not in this version of the plan.").assertExists()
        screen(OrbitRoute(Destination.WIKI_PLAN_SECTION, "agent-tests", wikiPart = 9))
        compose.onNodeWithText("That section is not in this document.").assertExists()
        screen(OrbitRoute(Destination.WIKI_PLAN_SECTION, "agent-tests", wikiPart = 0))
        compose.onNodeWithTag("wiki-plan-section-title").assertTextEquals("§1 铺依赖")
    }
}
