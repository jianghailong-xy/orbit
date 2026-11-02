package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The plan's pages over the shared fixture's states (`wiki-docs.fixture.json` `plan`): what each state draws, and that
 * every press calls the action the screen wires (iOS `WikiPlanPage`, `WikiPlanDocPage`, `WikiPlanSectionPage` and the
 * Redraft… and Edit sheets). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1400dp")
class WikiPlanPageTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val route = OrbitRoute(Destination.WIKI_PLAN)
    private val calls = mutableListOf<String>()
    private val actions = WikiPlanActions(
        draft = { calls += "draft" }, redraft = { calls += "redraft" }, startOver = { calls += "start over v$it" }, confirm = { calls += "confirm v$it" },
        pickVersion = { calls += "pick v$it" }, openDoc = { calls += "doc $it" }, openSection = { slug, at -> calls += "section $slug $at" },
        editDoc = { calls += "edit $it" }, editSection = { slug, at -> calls += "edit $slug §$at" },
        accept = { proposal, edit -> calls += "${if (edit) "edit" else "accept"} ${proposal.id}" }, reject = { calls += "reject ${it.id}" },
        openRun = { calls += "run $it" }, openSettings = { calls += "settings" }, openRunners = { calls += "runners" },
        openContents = { calls += "contents" }, openEntry = { calls += "entry $it" })

    /** [content] under the bar's actions for [bar], the route the page binds them to. */
    private fun show(bar: OrbitRoute = route, content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme { Column { Row { PageBar.Actions(bar, this) }; content() } } } }
        compose.waitForIdle()
    }

    /** The plan page for one of the fixture's states, read the way the screen reads it. */
    private fun page(name: String, busy: Boolean = false, refused: Map<String, List<WikiPlanGateError>> = emptyMap(),
        versions: List<WikiPlanLogic.VersionRow> = emptyList()) = page(WikiPlanFixture.state(name), WikiPlanFixture.online(name), busy, refused, versions)
    private fun page(state: WikiPlanState, online: Boolean?, busy: Boolean = false, refused: Map<String, List<WikiPlanGateError>> = emptyMap(),
        versions: List<WikiPlanLogic.VersionRow> = emptyList()) {
        val shown = WikiPlanLogic.defaultShown(state)
        val inForce = shown?.status == WikiPlanLogic.ShownStatus.CONFIRMED && state.confirmed?.version == shown.version
        val card = WikiPlanLogic.jobCard(state.job, WikiPlanFixture.now, online,
            WikiPlanLogic.failedJob(state)?.let { it to state }, inForce, if (state.confirmed != null) WikiPlanFixture.directory else null)
        show {
            WikiPlanPage(route, state, shown, shown?.let { WikiPlanLogic.base(it, state) }, versions, card, if (state.confirmed != null) 3 to 5 else null,
                WikiPlanFixture.now, busy, refused, actions = actions)
        }
    }
    private fun scrollTo(tag: String) = compose.onNodeWithTag("wiki-plan-page").performScrollToNode(hasTestTag(tag))
    /** The colour the gate's report sets [text] in, as its layout was given it. */
    private fun gateTextColour(text: String): Color {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNode(hasText(text) and hasAnyAncestor(hasTestTag("wiki-plan-gate")), useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        return layouts.single().layoutInput.style.color
    }
    /** A block that is not one node to TalkBack (a card, a field) says each of [texts] in one of its lines. */
    private fun says(tag: String, vararg texts: String) = texts.forEach { text ->
        assertTrue("$tag does not say “$text”", compose.onAllNodes((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and
            hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }

    @Test fun aDraftWaitingOffersConfirmPlanAndRedraftAndTheyCallTheirActions() {
        page("draftReady")
        compose.onNodeWithTag("wiki-plan-title").assertTextEquals(WikiPlanCopy.title)
        compose.onNodeWithTag("wiki-plan-version-menu").assertTextContains("v2", substring = true)
        compose.onNodeWithTag("wiki-plan-meta").assertTextContains("Redrafted from v1 at your request", substring = true)
        compose.onNodeWithTag("wiki-plan-confirm").assertIsEnabled().performClick()
        compose.onNodeWithTag("wiki-plan-redraft").assertIsEnabled().performClick()
        assertEquals(listOf("confirm v2", "redraft"), calls)
        // A draft's gate passed: the green head, and no rows.
        says("wiki-plan-gate", WikiPlanCopy.passed)
        compose.onAllNodesWithTag("wiki-plan-gate-row:docCount").assertCountEquals(0)
        compose.onNodeWithTag("wiki-plan-contents").performClick()
        assertEquals("contents", calls.last())
    }

    @Test fun theVersionInForceHasNoConfirmAndSaysHowFarItsDocumentsAreWritten() {
        page("inForce")
        compose.onAllNodesWithTag("wiki-plan-confirm").assertCountEquals(0)
        compose.onNodeWithTag("wiki-plan-redraft").assertIsEnabled()
        compose.onNodeWithTag("wiki-plan-meta").assertTextContains("3 categories · 5 documents · 10 sections · 3 written, 2 to write", substring = true)
        compose.onAllNodesWithTag("wiki-plan-gate").assertCountEquals(0)
        compose.onAllNodesWithTag("wiki-plan-job").assertCountEquals(0)
        scrollTo("wiki-plan-doc:session-runtime")
        compose.onNodeWithTag("wiki-plan-doc:session-runtime").assertTextContains("2.1", substring = true)
            .assertTextContains("4 sections · 3,000–4,500 chars", substring = true).performClick()
        assertEquals(listOf("doc session-runtime"), calls)
    }

    @Test fun theVersionMenuListsEveryVersionAndPicksAnother() {
        val rows = WikiPlanFixture.plan.fobj("versionRows")
        val versions = WikiPlanLogic.versionRows(rows.farr("versions").decode(kotlinx.serialization.builtins.ListSerializer(WikiPlanVersionSummary.serializer())))
        page("draftReady", versions = versions)
        compose.onNodeWithTag("wiki-plan-version-menu").performClick()
        compose.onNodeWithTag("wiki-plan-version:2").assertTextContains("v2 · Draft", substring = true)
        compose.onNodeWithTag("wiki-plan-version:1").assertTextContains("v1 · Confirmed", substring = true).assertIsNotSelected()
        compose.onNodeWithTag("wiki-plan-version:2").assertIsSelected()
        compose.onNodeWithTag("wiki-plan-version:1").performClick()
        assertEquals(listOf("pick v1"), calls)
        // The version shown is ticked; picking it again goes nowhere.
        compose.onNodeWithTag("wiki-plan-version-menu").performClick()
        compose.onNodeWithTag("wiki-plan-version:2").performClick()
        assertEquals(listOf("pick v1"), calls)
    }

    /** A stored draft with things to look at: amber, each note after its check's row, the references once — and Confirm plan
     * all the same. */
    @Test fun aStoredDraftSaysWhatToLookAtAndIsConfirmedAllTheSame() {
        page("draftNoted")
        compose.onNodeWithTag("wiki-plan-confirm").assertIsEnabled().performClick()
        compose.onNodeWithTag("wiki-plan-redraft").assertIsEnabled().performClick()
        assertEquals(listOf("confirm v2", "redraft"), calls)
        scrollTo("wiki-plan-gate")
        says("wiki-plan-gate", WikiPlanCopy.ready, "4 to look at · references checked at 99cd3c4 · attempt 2")
        assertEquals("the report's title is amber", Color(0xFFB35C00), gateTextColour(WikiPlanCopy.ready))
        compose.onAllNodesWithTag("wiki-plan-gate-row:docCount").assertCountEquals(2)
        says("wiki-plan-gate-row:docCount", "3 documents — within 3–5", "Search ranking was left out: nothing was written for it.")
        compose.onAllNodesWithTag("wiki-plan-gate-row:references").assertCountEquals(2)
        says("wiki-plan-gate-row:references", "A topic isn’t this wiki’s and was left out: invented.",
            "5,564 of 5,566 found at 99cd3c4 — the rest stay on their sections, and a document is written without any that’s still missing")
        compose.onNodeWithTag("wiki-plan-gate-ref:0").assertTextContains("2.1 §2 Symbol src/runner-go/runloop.go: runLoop() — not in the file", substring = true)
        compose.onNodeWithTag("wiki-plan-gate-ref:1").assertTextContains("1.1 §2 Doc section docs/architecture.md § 1. Why — no such heading", substring = true)
        compose.onAllNodesWithTag("wiki-plan-gate-more").assertCountEquals(0)
        scrollTo("wiki-plan-doc:session-runtime")
        compose.onNodeWithTag("wiki-plan-doc:session-runtime").assertTextContains("1 not found · 4 sections · 3,000–4,500 chars", substring = true)
        scrollTo("wiki-plan-doc:agent-tests")
        compose.onNodeWithTag("wiki-plan-doc:agent-tests").assert(!hasText("not found", substring = true))
    }

    @Test fun aCountOutsideItsTargetIsOneThingToLookAt() {
        page("draftOutside")
        says("wiki-plan-gate", WikiPlanCopy.ready, "1 to look at · references checked at 99cd3c4 · attempt 2")
        says("wiki-plan-gate-row:docCount", "3 documents — the plan asks for 20–35. Confirm it as it is, or Redraft with what to merge or split.")
        compose.onNodeWithTag("wiki-plan-confirm").assertIsEnabled()
    }

    @Test fun aRedraftThatLeftNoDraftIsOneCardOverTheVersionThatStands() {
        page("draftFailed")
        says("wiki-plan-job", WikiPlanCopy.redraftFailed, "The model’s catalogue couldn’t be read. v1 stays in force.")
        compose.onNodeWithTag("wiki-plan-job-link").assertTextEquals(WikiPlanCopy.viewRun).performClick()
        compose.onNodeWithTag("wiki-plan-version-menu").assertTextContains("v1", substring = true)
        compose.onAllNodesWithTag("wiki-plan-gate").assertCountEquals(0)
        compose.onAllNodesWithTag("wiki-plan-confirm").assertCountEquals(0)
        compose.onNodeWithTag("wiki-plan-redraft").assertIsEnabled().performClick()
        assertEquals(listOf("run se-job", "redraft"), calls)
        scrollTo("wiki-plan-doc:session-runtime")
        compose.onNodeWithTag("wiki-plan-doc:session-runtime").assertExists()
    }

    @Test fun aDraftWaitingStandsWhenARedraftOfItLeftNone() {
        page("draftFailedOver")
        says("wiki-plan-job", WikiPlanCopy.redraftFailed, "The model’s catalogue couldn’t be read. Draft v2 is unchanged.")
        says("wiki-plan-gate", WikiPlanCopy.passed)
        compose.onNodeWithTag("wiki-plan-confirm").assertIsEnabled()
        compose.onNodeWithTag("wiki-plan-redraft").assertIsEnabled()
    }

    /** No version and no job on its way: the job's head, its card and Redraft, with no version made up for it. */
    @Test fun aFirstDraftThatLeftNothingIsItsCardAndRedraft() {
        page("noneFailed")
        compose.onNodeWithTag("wiki-plan-meta").assertTextContains("Redraft · you asked", substring = true)
        says("wiki-plan-job", WikiPlanCopy.jobFailed, "The model’s catalogue couldn’t be read. Nothing was saved.")
        compose.onAllNodesWithTag("wiki-plan-version-menu").assertCountEquals(0)
        compose.onAllNodesWithTag("wiki-plan-empty").assertCountEquals(0)
        compose.onAllNodesWithTag("wiki-plan-draft").assertCountEquals(0)
        compose.onAllNodesWithTag("wiki-plan-confirm").assertCountEquals(0)
        compose.onAllNodesWithTag("wiki-plan-more").assertCountEquals(0)
        compose.onNodeWithTag("wiki-plan-redraft").assertIsEnabled().performClick()
        assertEquals(listOf("redraft"), calls)
    }

    @Test fun theJobCardSaysQueuedDraftingHeldAndWritingAndItsLinkGoesWhereItSays() {
        page("noneQueued")
        compose.onNodeWithTag("wiki-plan-meta").assertTextEquals("First draft · asked when the space was made")
        says("wiki-plan-job", WikiPlanCopy.queued, WikiPlanCopy.queuedText)
        compose.onAllNodesWithTag("wiki-plan-empty").assertCountEquals(0)
        compose.onAllNodesWithTag("wiki-plan-redraft").assertCountEquals(0)
        // A queued job has no run of its own yet: nothing to open.
        compose.onAllNodesWithTag("wiki-plan-job-link").assertCountEquals(0)
        page("noneDrafting")
        says("wiki-plan-job", "${WikiPlanCopy.drafterServer} · attempt 1 of 3 · started 12m ago")
        compose.onNodeWithTag("wiki-plan-job-link").assertTextEquals(WikiPlanCopy.viewRun).performClick()
        page("noneHeld")
        says("wiki-plan-job", WikiPlanCopy.held, "No maintenance workspace is set up — a draft runs where maintenance runs.")
        compose.onNodeWithTag("wiki-plan-job-link").assertTextEquals(WikiPlanCopy.setUp).performClick()
        page("noneOffline")
        compose.onNodeWithTag("wiki-plan-job-link").assertTextEquals(WikiPlanCopy.viewRunners).performClick()
        page("writing")
        says("wiki-plan-job", WikiPlanCopy.writing, "2 of 5 written · started 40m ago", "${WikiPlanCopy.writingNow} 3.2 会话状态生命周期")
        compose.onNodeWithTag("wiki-plan-job-progress").assertExists()
        assertEquals(listOf("run se-job", "settings", "runners"), calls)
    }

    /** No plan: what a plan is, with the System model as who drafts it, Draft plan, and where and how long it runs. */
    @Test fun noPlanSaysSoAndOffersDraftPlan() {
        page("none")
        compose.onNodeWithTag("wiki-plan-meta").assertTextEquals(WikiPlanCopy.none)
        says("wiki-plan-empty", WikiPlanCopy.emptyTitle, WikiPlanCopy.emptyText, WikiPlanCopy.emptyNoteServer)
        compose.onNodeWithText(WikiPlanCopy.emptyText).assertExists()
        compose.onAllNodesWithTag("wiki-plan-version-menu").assertCountEquals(0)
        compose.onNodeWithTag("wiki-plan-draft").assertIsEnabled().performClick()
        assertEquals(listOf("draft"), calls)
    }

    @Test fun theChangesProposedAreAcceptedEditedOrRejected() {
        page("changes")
        scrollTo("wiki-plan-change:pp1")
        says("wiki-plan-change:pp1", "ADD SECTION", "Add §3 “自己的 Codex 池：用 ChatGPT 登录，登录由服务器保管”", "§3–4 become §4–5", "Accepting confirms plan v2 · Wiki maintenance writes the section next", WikiPlanCopy.andMore(2))
        scrollTo("wiki-plan-accept:pp1")
        compose.onNodeWithTag("wiki-plan-accept:pp1").performClick()
        compose.onNodeWithTag("wiki-plan-edit:pp1").performClick()
        compose.onNodeWithTag("wiki-plan-reject:pp1").performClick()
        compose.onNodeWithTag("wiki-plan-fact:e90").performClick()
        scrollTo("wiki-plan-reject:pp2")
        compose.onNodeWithTag("wiki-plan-reject:pp2").performClick()
        assertEquals(listOf("accept pp1", "edit pp1", "reject pp1", "entry e90", "reject pp2"), calls)
    }

    @Test fun anAcceptanceTheGateRefusedShowsItsErrorsOnTheCard() {
        val errors = listOf(WikiPlanGateError("references", "plan.docs[1].sections[2].sources.code[0]", "no such file"),
            WikiPlanGateError("protected", "plan.docs[1]", "session-runtime is protected"))
        page("changes", refused = mapOf("pp1" to errors))
        scrollTo("wiki-plan-change-refused:pp1")
        says("wiki-plan-change-refused:pp1", WikiPlanCopy.acceptRefused, "plan.docs[1].sections[2].sources.code[0] no such file", "plan.docs[1] session-runtime is protected")
        // The other change still passed.
        compose.onAllNodesWithTag("wiki-plan-change-refused:pp2").assertCountEquals(0)
        says("wiki-plan-change:pp2", WikiPlanCopy.passed)
    }

    @Test fun aWriteInFlightTakesNoSecondPress() {
        page("draftReady", busy = true)
        compose.onNodeWithTag("wiki-plan-confirm").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-plan-redraft").assertIsNotEnabled()
        scrollTo("wiki-plan-accept:pp1")
        compose.onNodeWithTag("wiki-plan-accept:pp1").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-plan-edit:pp1").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-plan-reject:pp1").assertIsNotEnabled()
        page("none", busy = true)
        compose.onNodeWithTag("wiki-plan-draft").assertIsNotEnabled()
    }

    /** A draft's document says how many references weren't found, and its section marks which. */
    @Test fun aDocumentsPageListsItsFieldsAndSectionsAndWhatWasNotFound() {
        val shown = WikiPlanLogic.defaultShown(WikiPlanFixture.state("draftNoted"))!!
        val doc = shown.docs.first { it.slug == "session-runtime" }
        val docRoute = OrbitRoute(Destination.WIKI_PLAN_DOC, doc.slug)
        show(docRoute) { WikiPlanDocPage(docRoute, shown, doc, canEdit = false, actions = actions) }
        compose.onNodeWithTag("wiki-plan-doc-title").assertTextContains("2.1 会话运行模型与长连接", substring = true)
        compose.onNodeWithTag("wiki-plan-doc-meta").assertTextEquals("v2 · Draft · 1 not found · 4 sections · 3,000–4,500 chars")
        says("wiki-plan-field:protected", WikiPlanCopy.protectedNote)
        compose.onNodeWithTag("wiki-plan-doc-page").performScrollToNode(hasTestTag("wiki-plan-section:1"))
        compose.onNodeWithTag("wiki-plan-section:1").performClick()
        assertEquals(listOf("section session-runtime 1"), calls)
        val sectionRoute = OrbitRoute(Destination.WIKI_PLAN_SECTION, doc.slug, wikiPart = 1)
        show(sectionRoute) { WikiPlanSectionPage(sectionRoute, shown, doc, 1, actions = actions) }
        compose.onNodeWithTag("wiki-plan-section-page").performScrollToNode(hasTestTag("wiki-plan-source:code:0"))
        compose.onNodeWithTag("wiki-plan-source:code:0").assertTextContains("runLoop() · claimRetryDelayAfter() ${WikiPlanCopy.notFound}", substring = true)
        compose.onNodeWithTag("wiki-plan-source:code:1").assertTextContains(WikiPlanCopy.found, substring = true)
    }

    @Test fun theVersionInForcesDocumentAndSectionAreEditedFromTheBar() {
        val state = WikiPlanFixture.state("inForce")
        val shown = WikiPlanLogic.defaultShown(state)!!
        val doc = shown.docs.first { it.slug == "session-runtime" }
        val docRoute = OrbitRoute(Destination.WIKI_PLAN_DOC, doc.slug)
        show(docRoute) { WikiPlanDocPage(docRoute, shown, doc, canEdit = true, actions = actions) }
        says("wiki-plan-field:not-covered", "• session 的 runState / lifecycleState 三维度状态模型 → 2.2")
        compose.onNodeWithTag("wiki-plan-doc-edit").performClick()
        val sectionRoute = OrbitRoute(Destination.WIKI_PLAN_SECTION, doc.slug, wikiPart = 1)
        show(sectionRoute) { WikiPlanSectionPage(sectionRoute, shown, doc, 1, canEdit = true, actions = actions) }
        compose.onNodeWithTag("wiki-plan-section-title").assertTextEquals("§2 turn 投递与 inbox 领取：long-poll 与心跳")
        compose.onNodeWithTag("wiki-plan-section-meta").assertTextEquals(WikiPlanLogic.sectionMeta(shown, doc.sections[1]))
        val found = WikiPlanLogic.sourceFound(shown, doc, 1, "code", 0)
        compose.onNodeWithTag("wiki-plan-section-page").performScrollToNode(hasTestTag("wiki-plan-source:code:0"))
        compose.onNodeWithTag("wiki-plan-source:code:0").assertTextEquals("src/runner-go/runloop.go runLoop() · claimRetryDelayAfter()" +
            (found?.let { " " + if (it) WikiPlanCopy.found else WikiPlanCopy.notFound } ?: ""))
        compose.onNodeWithTag("wiki-plan-section-edit").performClick()
        assertEquals(listOf("edit session-runtime", "edit session-runtime §1"), calls)
    }

    @Test fun aSectionsWhereToLookInSessionsListsItsConditions() {
        val state = WikiPlanFixture.state("inForce")
        val shown = WikiPlanLogic.defaultShown(state)!!
        val doc = shown.docs.first { it.slug == "session-runtime" }
        val sectionRoute = OrbitRoute(Destination.WIKI_PLAN_SECTION, doc.slug, wikiPart = 2)
        show(sectionRoute) { WikiPlanSectionPage(sectionRoute, shown, doc, 2, actions = actions) }
        compose.onNodeWithTag("wiki-plan-section-page").performScrollToNode(hasTestTag("wiki-plan-sessions"))
        says("wiki-plan-sessions", WikiPlanCopy.sessionProjects, "会话合并", "2026-08-19 → now", "superseded", "合并被判 superseded 的原话")
        compose.onAllNodesWithTag("wiki-plan-section-edit").assertCountEquals(0)
    }

    @Test fun redraftSendsTheOwnersWordsAndKeepsThemWhenRefused() {
        val sent = mutableListOf<String>()
        var closed = 0
        var answer = false
        show {
            WikiPlanRedraftSheet(WikiPlanFixture.state("inForce"), WikiPlanCopy.redraftNote(1 to true), listOf("2.1"), close = { closed++ }) { words -> sent += words; answer }
        }
        compose.onNodeWithText(WikiPlanCopy.redraftNote(1 to true)).assertExists()
        compose.onNodeWithText(WikiPlanCopy.protectedKept(listOf("2.1"))).assertExists()
        compose.onNodeWithTag("wiki-plan-redraft-words").performTextInput("merge 2.1 and 2.2")
        compose.onNodeWithTag("wiki-plan-redraft-go").performClick()
        compose.waitForIdle()
        assertEquals(listOf("merge 2.1 and 2.2"), sent)
        assertEquals("a refused redraft keeps the sheet and the words", 0, closed)
        compose.onNodeWithTag("wiki-plan-redraft-words").assertTextContains("merge 2.1 and 2.2")
        answer = true
        compose.onNodeWithTag("wiki-plan-redraft-go").performClick()
        compose.waitForIdle()
        assertEquals(1, closed)
    }

    @Test fun withAStoredVersionRedraftWaitsForWords() {
        show { WikiPlanRedraftSheet(WikiPlanFixture.state("inForce"), WikiPlanCopy.redraftNote(1 to true), emptyList(), close = {}) { true } }
        compose.onNodeWithText(WikiPlanCopy.redraftPlaceholder).assertExists()
        compose.onNodeWithTag("wiki-plan-redraft-go").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-plan-redraft-words").performTextInput("   ")
        compose.onNodeWithTag("wiki-plan-redraft-go").assertIsNotEnabled()
        compose.onNodeWithTag("wiki-plan-redraft-words").performTextInput("merge")
        compose.onNodeWithTag("wiki-plan-redraft-go").assertIsEnabled()
    }

    @Test fun withNoStoredVersionRedraftMayGoEmpty() {
        show { WikiPlanRedraftSheet(WikiPlanFixture.state("none"), WikiPlanCopy.redraftNote(null), emptyList(), close = {}) { true } }
        compose.onNodeWithTag("wiki-plan-redraft-go").assertIsEnabled()
    }

    @Test fun afterAFailedRunTheBoxOpensHoldingItsWords() {
        val state = WikiPlanFixture.state("draftFailed")
        show { WikiPlanRedraftSheet(state, WikiPlanCopy.redraftNote(1 to true), emptyList(), close = {}) { true } }
        compose.onNodeWithTag("wiki-plan-redraft-words").assertTextContains(state.job!!.instructions!!)
        compose.onNodeWithTag("wiki-plan-redraft-go").assertIsEnabled()
    }

    @Test fun startOverIsInTheMenuOnlyWithAStoredVersionAndNoDraftJobOpen() {
        page("draftReady")
        compose.onNodeWithTag("wiki-plan-more").assertContentDescriptionEquals(WikiPlanCopy.more).performClick()
        compose.onNodeWithTag("wiki-plan-start-over").assertTextEquals(WikiPlanCopy.startOver).performClick()
        assertEquals(listOf("start over v2"), calls)
        // A version stored and a draft on its way: nothing to ask for yet.
        page(WikiPlanFixture.state("inForce").copy(job = WikiPlanFixture.state("noneDrafting").job), online = true)
        compose.onNodeWithTag("wiki-plan-redraft").assertIsNotEnabled()
        compose.onAllNodesWithTag("wiki-plan-more").assertCountEquals(0)
        page("none")
        compose.onAllNodesWithTag("wiki-plan-more").assertCountEquals(0)
    }

    @Test fun editSendsTheDocumentInTheDraftsShapeAndShowsWhyItWasRefused() {
        val stored = WikiPlanFixture.version("v1").docs!!.first { it.slug == "session-runtime" }
        val sent = mutableListOf<WikiPlanDocInput>()
        var closed = 0
        show {
            WikiPlanEditSheet("2.1", stored, 2, close = { closed++ }) { input -> sent += input; listOf("plan.docs[1] session-runtime is protected") }
        }
        compose.onNodeWithText(WikiPlanCopy.saveNote(2)).assertExists()
        compose.onNodeWithTag("wiki-plan-edit-title").performTextReplacement("会话运行模型")
        // Take out the overview, move the pitfalls up, add a section with a title of its own and a kind.
        compose.onNodeWithTag("wiki-plan-edit-remove:0").performClick()
        // Move up, the row's TalkBack action (the drag itself is WikiPlanEditDragTest's).
        compose.runOnIdle { compose.onNodeWithTag("wiki-plan-edit-row:1").fetchSemanticsNode().config[SemanticsActions.CustomActions]
            .first { it.label == WikiPlanCopy.moveUp }.action() }
        compose.onNodeWithTag("wiki-plan-edit-add").performClick()
        compose.onNodeWithTag("wiki-plan-edit-row-title:3").performTextInput("新的一节")
        compose.onNodeWithTag("wiki-plan-edit-kind:3").performClick()
        compose.onNodeWithTag("wiki-plan-edit-kind:3:decisions").performClick()
        compose.onNodeWithTag("wiki-plan-edit-protected").performClick()
        compose.onNodeWithTag("wiki-plan-edit-save").performClick()
        compose.waitForIdle()
        val form = WikiPlanLogic.docForm(stored).let { form ->
            form.copy(title = "会话运行模型", protected = false, sections = listOf(form.sections[2], form.sections[1], form.sections[3],
                WikiPlanLogic.DocForm.Section(null, "新的一节", "decisions")))
        }
        assertEquals(listOf(WikiPlanLogic.docEdit(stored, form)), sent)
        assertEquals(0, closed)
        compose.onNodeWithTag("wiki-plan-edit-list").performScrollToNode(hasTestTag("wiki-plan-edit-refused"))
        says("wiki-plan-edit-refused", "plan.docs[1] session-runtime is protected")
        compose.onNodeWithTag("wiki-plan-edit-title").assertTextContains("会话运行模型")
    }

    @Test fun aSectionIsEditedFromItsOwnPage() {
        val stored = WikiPlanFixture.version("v1").docs!!.first { it.slug == "session-runtime" }.sections!![1]
        val sent = mutableListOf<String>()
        var closed = 0
        show {
            WikiPlanSectionEditSheet(1, stored, 2, close = { closed++ }) { title, kind, covers, length -> sent += "$title|$kind|$covers|$length"; null }
        }
        compose.onNodeWithText(WikiPlanCopy.editTitle("§2")).assertExists()
        compose.onNodeWithTag("wiki-plan-section-edit-kind").performClick()
        compose.onNodeWithTag("wiki-plan-section-edit-kind:interface").performClick()
        compose.onNodeWithTag("wiki-plan-section-edit-length").performTextReplacement("900")
        compose.onNodeWithTag("wiki-plan-section-edit-save").performClick()
        compose.waitForIdle()
        assertEquals(listOf("turn 投递与 inbox 领取：long-poll 与心跳|interface|讲 runner 如何用 outbound HTTP 轮询领取工作而非等入站连接|900"), sent)
        assertEquals(1, closed)
    }
}
