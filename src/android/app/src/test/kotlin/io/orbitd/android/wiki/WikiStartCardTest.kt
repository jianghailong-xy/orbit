package io.orbitd.android.wiki

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.DirectoryRunner
import io.orbitd.android.directory.DirectoryWorkspace
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastHost
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The setup card on the home, over a real store and an in-memory server (design §12.3.1, mock 41; the web's
 * `WikiStartCard.test.tsx`): that the home draws it while it has nothing to read and not after, and that what it offers does what
 * it says — the form opens where the reader is and writes through the owner's door, a draft is asked for on the spot, and an
 * account with no wiki makes one in one request. What each state SAYS is `WikiStartLogicTest`'s, from the shared fixture; here
 * it is drawn. WHAT REACHES THE SERVER IS THE CLAIM: the server keeps every write, and the tests read them. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1400dp")
class WikiStartCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val route = OrbitRoute(Destination.WIKI)
    private val pushed = mutableListOf<OrbitRoute>()

    @Before fun quiet() { OrbitToasts.clear() }

    private fun show(content: @Composable () -> Unit) {
        compose.activityRule.scenario.onActivity { it.setContent { OrbitTheme { Box { content(); ToastHost({}, {}, {}) } } } }
        compose.waitForIdle()
    }
    private fun awaitTag(tag: String, unmerged: Boolean = false) = compose.waitUntil(10_000) {
        compose.onAllNodesWithTag(tag, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty()
    }
    private fun press(tag: String) { awaitTag(tag); compose.onNodeWithTag(tag).performClick(); compose.waitForIdle() }
    private fun gone(tag: String) = compose.onAllNodesWithTag(tag).assertCountEquals(0)
    private fun says(tag: String, vararg texts: String) = texts.forEach { text ->
        assertTrue("$tag does not say “$text”", compose.onAllNodes((hasTestTag(tag) or hasAnyAncestor(hasTestTag(tag))) and
            hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
    }
    private fun button(to: WikiStartLogic.ActionTo) = "wiki-home-start-${to.name.lowercase().replace('_', '-')}"
    private fun mark(number: Int, state: String) = "wiki-home-start-mark:$number:$state"
    /** The step each mark is on, top to bottom: how the card stands. */
    private fun assertMarks(vararg states: String) = states.forEachIndexed { index, state -> awaitTag(mark(index + 1, state), unmerged = true) }

    // MARK: the card, drawn

    /** Every state: the heading and the lead, one card of three rows, each with its mark, its words and its button; a row is
     * one stop to TalkBack, the button another. */
    @Test fun everyStateDrawsItsThreeSteps() {
        val cards = WikiPlanFixture.plan.fobj("states").keys.sorted().map(WikiStartFixture::card) + WikiStartLogic.firstCard(true) + WikiStartLogic.firstCard(false)
        cards.forEach { card ->
            show { WikiStartSteps(card, busy = false) {} }
            compose.onNode(isHeading() and hasText(card.title)).assertExists()
            compose.onNodeWithTag("wiki-home-start-lead").assertTextEquals(card.lead)
            card.steps.forEachIndexed { index, step ->
                val number = index + 1
                val tag = mark(number, step.state.name.lowercase())
                compose.onNodeWithTag(tag, useUnmergedTree = true).assertExists()
                // A tick where a step is done, its number otherwise.
                compose.onAllNodes(hasText("$number") and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true)
                    .assertCountEquals(if (step.state == WikiStartLogic.StepState.DONE) 0 else 1)
                val row = compose.onNodeWithTag("wiki-home-start-step:$number")
                listOfNotNull(step.title, step.text, step.note).forEach { row.assertTextContains(it) }
                step.action?.let { compose.onNodeWithTag(button(it.to)).assertTextEquals(it.label).assertHasClickAction().assertIsEnabled() }
            }
            val tos = card.steps.mapNotNull { it.action?.to }
            WikiStartLogic.ActionTo.entries.filter { it !in tos }.forEach { gone(button(it)) }
        }
    }

    @Test fun writingShowsHowFarItHasGotAndTheDocumentBeingWritten() {
        show { WikiStartSteps(WikiStartFixture.card("writing"), busy = false) {} }
        compose.onNodeWithTag("wiki-home-start-progress", useUnmergedTree = true).assertExists()
        says("wiki-home-start-step:3", "Writing documents · 2 of 5 written · started 40m ago", "Writing now: 3.2 会话状态生命周期")
    }

    @Test fun aButtonSaysWhatItIsForAndAWriteInFlightTakesNoSecondPress() {
        val pressed = mutableListOf<WikiStartLogic.ActionTo>()
        mapOf("none" to WikiStartLogic.ActionTo.DRAFT, "noneHeld" to WikiStartLogic.ActionTo.SET_UP, "noneQueued" to WikiStartLogic.ActionTo.PLAN,
            "noneOffline" to WikiStartLogic.ActionTo.RUNNERS).forEach { (state, to) ->
            show { WikiStartSteps(WikiStartFixture.card(state), busy = false) { pressed += it } }
            compose.onNodeWithTag(button(to)).performClick()
        }
        show { WikiStartSteps(WikiStartLogic.firstCard(true), busy = false) { pressed += it } }
        compose.onNodeWithTag(button(WikiStartLogic.ActionTo.CREATE)).performClick()
        assertEquals(listOf(WikiStartLogic.ActionTo.DRAFT, WikiStartLogic.ActionTo.SET_UP, WikiStartLogic.ActionTo.PLAN, WikiStartLogic.ActionTo.RUNNERS,
            WikiStartLogic.ActionTo.CREATE), pressed)
        show { WikiStartSteps(WikiStartFixture.card("none"), busy = true) { pressed += it } }
        compose.onNodeWithTag(button(WikiStartLogic.ActionTo.DRAFT)).assertIsNotEnabled()
    }

    // MARK: the server

    private fun space(maintenance: String = "{}") = """{"id":"sp1","slug":"github-com-acme-shop-cli","title":"shop-cli","repoUrlNorm":"github.com/acme/shop-cli",
        "settings":{"reviewMode":"tiered","maintenance":$maintenance}}"""
    private fun maintenanceOn(workspace: String) = """{"enabled":true,"workspaceId":"$workspace"}"""
    private fun planWith(job: String) = """{"spaceId":"sp1","confirmed":null,"draft":null,"proposals":[],"job":$job}"""
    private val noPlan = planWith("null")
    private val heldJob = """{"id":"j1","kind":"draft","trigger":"space_created","state":"held","held":{"reason":"no_maintenance_workspace",
        "at":"2026-11-01T00:00:00.000Z"},"requestedAt":"2026-11-01T00:00:00.000Z","attemptsMax":3}"""
    private fun draftingJob() = """{"id":"j2","kind":"draft","state":"running","startedAt":"${Instant.now().minusSeconds(720)}","attempt":1,"attemptsMax":3,
        "requestedAt":"2026-11-01T00:00:00.000Z"}"""
    private val notStartedJob = """{"id":"j3","kind":"draft","state":"running","attemptsMax":3,"requestedAt":"2026-11-01T00:00:00.000Z"}"""
    private val noDocs = """{"spaceId":"sp1","plan":null,"docs":{"total":0,"written":0},"categories":[]}"""
    private val noArticles = """{"spaceId":"sp1","categories":[],"uncategorized":[]}"""

    private var spaces = "[${space()}]"
    private var plan = noPlan
    private var docs = noDocs
    private var articles = noArticles
    private var workspaces = """[{"id":"eu","name":"shop-cli @ EU","repoUrl":"git@github.com:acme/shop-cli.git","runnerId":"down"},
        {"id":"us","name":"shop-cli @ US","repoUrl":"https://github.com/acme/shop-cli","runnerId":"up"},
        {"id":"sg","name":"shop-cli @ SG","repoUrl":"https://github.com/acme/shop-cli.git","runnerId":"up"},
        {"id":"ba","name":"billing-api","repoUrl":"https://github.com/acme/billing-api","runnerId":"up"},
        {"id":"no","name":"notes","repoUrl":null,"runnerId":"up"}]"""
    private val runners = """[{"id":"up","name":"build-01","online":true},{"id":"down","name":"build-02","online":false}]"""
    private var workspacesStatus = 200
    private var members = """{"workspaces":[{"id":"eu","name":"shop-cli @ EU","runner":"build-02","inWiki":true},
        {"id":"sg","name":"shop-cli @ SG","runner":"build-01","inWiki":true},{"id":"us","name":"shop-cli @ US","runner":"build-01","inWiki":true}],"addable":[]}"""
    /** Every write answers this, while it is set. */
    private var refusal: String? = null

    private val rig = WikiTestRig { request -> answer(request) }
    private fun answer(request: ApiRequest): Pair<Int, String>? {
        val path = request.path.joinToString("/")
        if (request.method != HttpMethod.GET) {
            refusal?.let { return 409 to """{"message":"$it"}""" }
            // As the server does: maintenance on with a workspace, the plan's draft on its way.
            val workspace = rig.body(request)?.let { it["maintenance"]["workspaceId"].text() }
            if (workspace != null) spaces = "[${space(maintenanceOn(workspace))}]"
            plan = planWith(draftingJob())
            return when (path) {
                "wiki/spaces" -> 201 to space(maintenanceOn(workspace ?: ""))
                "wiki/spaces/sp1/plan/redraft" -> 200 to """{"created":true}"""
                else -> 200 to "{}"
            }
        }
        return when (path) {
            "wiki/spaces" -> 200 to spaces
            "wiki/spaces/sp1/docs" -> 200 to docs
            "wiki/spaces/sp1/articles" -> 200 to articles
            "wiki/spaces/sp1/entries" -> 200 to "[]"
            "wiki/spaces/sp1/plan" -> if (plan.isEmpty()) null else 200 to plan
            "wiki/spaces/sp1/workspaces" -> 200 to members
            "workspaces" -> workspacesStatus to workspaces
            "runners" -> 200 to runners
            else -> null
        }
    }
    private fun writes() = rig.requests.filter { it.method != HttpMethod.GET }.map { "${rig.line(it)} ${rig.body(it)}" }

    private fun home(data: DirectoryData = DirectoryData(), from: String? = null, at: OrbitRoute = route): WikiStore {
        val store = rig.store()
        if (from != null) store.open(WikiFrom(workspaceId = from))
        show { WikiHomeScreen(store, at, data, WikiNav({ pushed += it }, {}, "https://wiki.test") {}) }
        return store
    }
    /** The workspaces the open menu lists, top to bottom, by id. */
    private fun offered() = compose.onAllNodes(SemanticsMatcher("a workspace offered") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("wiki-settings-workspace:") == true
    }).fetchSemanticsNodes().sortedBy { it.positionInRoot.y }.map { it.config[SemanticsProperties.TestTag].substringAfter(':') }
    private fun top(tag: String) = compose.onNodeWithTag(tag).fetchSemanticsNode().positionInRoot.y
    /** The shared directory read, every document written or none. */
    private fun docsRead(written: Boolean): String {
        val read = WikiSharedFiles.docs.fobj("docs").fobj("directory").fobj("read")
        val categories = read.farr("categories").map { category ->
            val rows = (category.jsonObject["docs"] as? JsonArray).orEmpty().map { JsonObject(it.jsonObject + ("written" to JsonPrimitive(written))) }
            JsonObject(category.jsonObject + ("docs" to JsonArray(rows)))
        }
        return JsonObject(read + ("categories" to JsonArray(categories)) + ("docs" to buildJsonObject { put("total", 5); put("written", if (written) 5 else 0) })).toString()
    }

    // MARK: the home of a wiki with nothing to read

    @Test fun whileTheFirstDraftWaitsForAWorkspaceSetUpOpensWhereTheReaderIs() {
        plan = planWith(heldJob)
        home()
        awaitTag("wiki-home-start")
        compose.onNodeWithTag("wiki-home-line").assertTextEquals("No documents yet")
        assertMarks("wait", "todo", "todo")
        gone("wiki-home-browse")
        press(button(WikiStartLogic.ActionTo.SET_UP))
        awaitTag("wiki-settings-form")
        compose.onNodeWithText(WikiModeCopy.setUpTitle).assertExists()
        assertTrue("the reader stays where they are", pushed.isEmpty())
    }

    /** The maintenance sheet offers this wiki's workspaces, picks the first that is up, and lists an offline one last, said so. */
    @Test fun setUpOffersOnlyThisWikisWorkspacesTheFirstThatIsUpPicked() {
        plan = planWith(heldJob)
        home()
        press(button(WikiStartLogic.ActionTo.SET_UP))
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains("shop-cli @ SG · build-01", substring = true)
        compose.onNodeWithTag("wiki-settings-form-submit").assertTextEquals(WikiModeCopy.turnOn).assertIsEnabled()
        compose.onNodeWithTag("wiki-settings-workspace").performClick()
        awaitTag("wiki-settings-workspace:eu")
        assertEquals(listOf("sg", "us", "eu"), offered())
        compose.onNodeWithTag("wiki-settings-workspace:eu").assertTextContains(WikiStartCopy.workspaceOffline, substring = true)
        assertTrue(compose.onAllNodes(hasTestTag("wiki-settings-workspace:sg") and hasText(WikiStartCopy.workspaceOffline, substring = true)).fetchSemanticsNodes().isEmpty())
    }

    /** A wiki with no workspace in it yet offers them all, and picks the first that is up. */
    @Test fun aWikiWithNoWorkspaceInItOffersThemAll() {
        plan = planWith(heldJob)
        members = """{"workspaces":[],"addable":[]}"""
        home()
        press(button(WikiStartLogic.ActionTo.SET_UP))
        compose.onNodeWithTag("wiki-settings-workspace").performClick()
        awaitTag("wiki-settings-workspace:eu")
        assertEquals(listOf("ba", "no", "sg", "us", "eu"), offered())
    }

    /** One press: maintenance on, on the workspace the reader came from, and the card moves on without being asked — the plan
     * is read again behind the write. */
    @Test fun setUpTurnsMaintenanceOnInOnePressOnTheWorkspaceTheReaderCameFrom() {
        plan = planWith(heldJob)
        home(from = "us")
        press(button(WikiStartLogic.ActionTo.SET_UP))
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains("shop-cli @ US · build-01", substring = true)
        press("wiki-settings-form-submit")
        assertEquals(listOf("""PATCH /api/wiki/spaces/sp1 {"maintenance":{"enabled":true,"workspaceId":"us","dailyRunLimit":8,"lookbackDays":14}}"""), writes())
        gone("wiki-settings-form")
        assertEquals(WikiCopy.settingsSaved, OrbitToasts.feed.value.transient?.message)
        assertMarks("done", "run", "todo")
        says("wiki-home-start-step:1", "Reads from shop-cli @ US · build-01")
        says("wiki-home-start-step:2", "Drafting the plan · attempt 1 of 3 · started", WikiStartCopy.draftingNote)
    }

    @Test fun theWorkspaceTheReaderCameFromIsPassedOverWhenItsRunnerIsOffline() {
        plan = planWith(heldJob)
        home(from = "eu")
        press(button(WikiStartLogic.ActionTo.SET_UP))
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains("shop-cli @ SG · build-01", substring = true)
    }

    /** Maintenance on and no job was the dead end the board set out to fix: a draft is asked for on the spot. */
    @Test fun aDraftIsAskedForOnTheSpot() {
        spaces = "[${space(maintenanceOn("sg"))}]"
        home()
        assertMarks("done", "wait", "todo")
        says("wiki-home-start-step:1", "Reads from shop-cli @ SG · build-01")
        says("wiki-home-start-step:2", WikiStartCopy.noPlan, WikiPlanCopy.noteServer)
        press(button(WikiStartLogic.ActionTo.DRAFT))
        assertEquals(listOf("POST /api/wiki/spaces/sp1/plan/redraft {}"), writes())
        assertTrue("the reader stays where they are", pushed.isEmpty())
        assertEquals(WikiPlanCopy.redraftAsked, OrbitToasts.feed.value.transient?.message)
        assertMarks("done", "run", "todo")
    }

    @Test fun aDraftTheServerRefusedSaysWhy() {
        spaces = "[${space(maintenanceOn("sg"))}]"
        refusal = "The System model is not configured."
        home()
        press(button(WikiStartLogic.ActionTo.DRAFT))
        compose.onNodeWithText(WikiCopy.planDraftFailed).assertExists()
        compose.onNodeWithText("The System model is not configured.").assertExists()
        compose.onNodeWithTag("wiki-refusal-ok").performClick()
        assertMarks("done", "wait", "todo")
    }

    @Test fun whatMustBeReadFirstOpensThePlan() {
        spaces = "[${space(maintenanceOn("sg"))}]"
        plan = planWith(draftingJob())
        home()
        assertMarks("done", "run", "todo")
        press(button(WikiStartLogic.ActionTo.PLAN))
        assertEquals(listOf(OrbitRoute(Destination.WIKI_PLAN)), pushed)
    }

    /** A runner that is offline: the workspace is there, so the first step is done, and the second sends the reader to the runners. */
    @Test fun aRunnerThatIsOfflineSendsTheReaderToTheRunners() {
        spaces = "[${space(maintenanceOn("eu"))}]"
        plan = planWith(notStartedJob)
        home(DirectoryData(workspaces = listOf(DirectoryWorkspace("eu", "shop-cli @ EU", "down")),
            runners = listOf(DirectoryRunner("down", "build-02", online = false)), ready = true))
        assertMarks("done", "wait", "todo")
        says("wiki-home-start-step:2", "The maintenance runner is offline — the draft starts once it’s back.")
        press(button(WikiStartLogic.ActionTo.RUNNERS))
        assertEquals("the runners' own page: a runner route that names none", listOf(OrbitRoute(Destination.RUNNER, origin = Origin.LINK)), pushed)
    }

    /** The card waits for the plan: a server that has none to read says nothing, as the web's `if (!plan.data) return null`. */
    @Test fun nothingIsDrawnWithoutThePlan() {
        plan = ""
        home()
        awaitTag("wiki-home-line")
        gone("wiki-home-start")
    }

    @Test fun theCardStandsAboveThePlansCategoriesUntilADocumentIsWritten() {
        spaces = "[${space(maintenanceOn("sg"))}]"
        plan = WikiPlanFixture.read("inForce").toString()
        docs = docsRead(written = false)
        home()
        assertMarks("done", "done", "wait")
        says("wiki-home-start-step:2", "v1 confirmed")
        says("wiki-home-start-step:3", WikiStartCopy.notWritten)
        val first = WikiDocLogic.homeCategories(docs.decodeAs(WikiDocsDirectory.serializer()), null).first().key
        awaitTag("wiki-home-category:$first")
        assertTrue("the card, then the categories", top("wiki-home-start") < top("wiki-home-category:$first"))
        compose.onNodeWithTag("wiki-home-list").performScrollToNode(hasTestTag("wiki-home-browse"))
    }

    @Test fun theCardGoesWithTheFirstDocumentWritten() {
        spaces = "[${space(maintenanceOn("sg"))}]"
        plan = WikiPlanFixture.read("inForce").toString()
        docs = docsRead(written = true)
        home()
        awaitTag("wiki-home-line")
        compose.onNodeWithTag("wiki-home-line").assertTextEquals("5 documents · 5 written")
        gone("wiki-home-start")
    }

    @Test fun theCardGoesOnceTheHomeListsTopicArticles() {
        articles = wikiArticlesFixture().obj("directory").obj("read").toString()
        home()
        awaitTag("wiki-home-line")
        gone("wiki-home-start")
        assertTrue(compose.onAllNodes(hasText("No documents yet")).fetchSemanticsNodes().isEmpty())
    }

    /** Once the home reads by the plan it lists no topic article, so none holds the card off (`useWikiHomeContent`). */
    @Test fun topicArticlesDoNotHoldTheCardOffOnceTheHomeReadsByThePlan() {
        spaces = "[${space(maintenanceOn("sg"))}]"
        plan = WikiPlanFixture.read("inForce").toString()
        docs = docsRead(written = false)
        articles = wikiArticlesFixture().obj("directory").obj("read").toString()
        home()
        awaitTag("wiki-home-start")
    }

    // MARK: an account with no wiki

    @Test fun anAccountWithNoWikiSeesTheSameCardAndNoWordOfSpaces() {
        spaces = "[]"
        home()
        awaitTag("wiki-home-first")
        compose.onNode(isHeading() and hasText(WikiCopy.title)).assertExists()
        compose.onNode(isHeading() and hasText(WikiStartCopy.firstTitle)).assertExists()
        assertMarks("wait", "todo", "todo")
        compose.onNodeWithTag(button(WikiStartLogic.ActionTo.CREATE)).assertTextEquals(WikiStartCopy.createOpen)
        compose.onAllNodesWithText(WikiCopy.noSpaces).assertCountEquals(0)
        val words = compose.onAllNodes(hasAnyAncestor(hasTestTag("wiki-home-first")), useUnmergedTree = true).fetchSemanticsNodes()
            .flatMap { node -> node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } }.joinToString(" ")
        assertTrue(words, words.contains(WikiStartCopy.connectFirstText))
        assertFalse(words, Regex("\\bspace\\b", RegexOption.IGNORE_CASE).containsMatchIn(words))
    }

    @Test fun withNoWorkspaceOnARepositoryThereIsNothingToPress() {
        spaces = "[]"
        workspaces = """[{"id":"no","name":"notes","repoUrl":null,"runnerId":"up"}]"""
        home()
        awaitTag("wiki-home-first")
        compose.waitUntil(10_000) { compose.onAllNodesWithText(WikiStartCopy.noRepository).fetchSemanticsNodes().isNotEmpty() }
        gone(button(WikiStartLogic.ActionTo.CREATE))
    }

    @Test fun aFailedReadOfTheWorkspacesSaysNothingOfRepositories() {
        spaces = "[]"
        workspacesStatus = 500
        home()
        awaitTag(button(WikiStartLogic.ActionTo.CREATE))
        compose.onAllNodesWithText(WikiStartCopy.noRepository).assertCountEquals(0)
    }

    @Test fun createWikiGroupsTheWorkspacesUnderTheirRepositoriesAndLeavesOutOneWithNone() {
        spaces = "[]"
        home()
        press(button(WikiStartLogic.ActionTo.CREATE))
        awaitTag("wiki-settings-form")
        compose.onNodeWithText(WikiStartCopy.create).assertExists()
        compose.onNodeWithTag("wiki-settings-form-note").assertTextEquals(WikiStartCopy.createNote)
        compose.onNodeWithTag("wiki-settings-form-submit").assertTextEquals(WikiStartCopy.createSubmit)
        compose.onNodeWithTag("wiki-settings-form-submit-cancel").assertTextEquals(WikiModeCopy.cancel)
        compose.onNodeWithTag("wiki-settings-workspace").performClick()
        awaitTag("wiki-settings-workspace:eu")
        assertEquals(listOf("ba", "sg", "us", "eu"), offered())
        val heads = listOf("github.com/acme/billing-api", "github.com/acme/shop-cli").map { compose.onNodeWithText(it).fetchSemanticsNode().positionInRoot.y }
        assertEquals("the repositories by name", heads.sorted(), heads)
        assertTrue("each over its workspaces", heads[0] < top("wiki-settings-workspace:ba") && top("wiki-settings-workspace:ba") < heads[1] && heads[1] < top("wiki-settings-workspace:sg"))
        compose.onNodeWithTag("wiki-settings-workspace:eu").assertTextContains(WikiStartCopy.workspaceOffline, substring = true)
    }

    @Test fun theNoteSaysWhatTheWikiWillDescribeForTheWorkspacePicked() {
        spaces = "[]"
        home(from = "sg")
        press(button(WikiStartLogic.ActionTo.CREATE))
        awaitTag("wiki-settings-workspace-note")
        compose.onNodeWithTag("wiki-settings-workspace-note").assertTextEquals(WikiStartCopy.createRepositoryNote("github.com/acme/shop-cli"))
        compose.onNodeWithTag("wiki-settings-workspace").performClick()
        press("wiki-settings-workspace:ba")
        compose.onNodeWithTag("wiki-settings-workspace-note").assertTextEquals(WikiStartCopy.createRepositoryNote("github.com/acme/billing-api"))
    }

    /** One request: its name is the repository's last segment, its URL as the workspace records it, maintenance on — and the home
     * is the new wiki's, the card at its second step. */
    @Test fun createWikiMakesItInOneRequestAndGoesToIt() {
        spaces = "[]"
        val store = home(from = "sg")
        press(button(WikiStartLogic.ActionTo.CREATE))
        press("wiki-settings-form-submit")
        assertEquals(listOf("""POST /api/wiki/spaces {"title":"shop-cli","repoUrl":"https://github.com/acme/shop-cli.git","maintenance":{"enabled":true,"workspaceId":"sg","dailyRunLimit":8,"lookbackDays":14}}"""), writes())
        awaitTag("wiki-home-list")
        gone("wiki-settings-form")
        gone("wiki-home-first")
        assertEquals("github-com-acme-shop-cli", store.state.value.currentSpace?.slug)
        compose.onNodeWithTag("wiki-space-picker").assertTextContains("shop-cli")
        assertMarks("done", "run", "todo")
        says("wiki-home-start-step:1", "Reads from shop-cli @ SG · build-01")
        assertTrue("it is the home, not a page over it", pushed.isEmpty())
    }

    /** A refusal stays in the sheet and says why; what the owner picked stays too, and the next press can land. */
    @Test fun aRefusedCreateStaysInTheSheetAndSaysWhy() {
        spaces = "[]"
        refusal = "This repository already has a wiki."
        home(from = "us")
        press(button(WikiStartLogic.ActionTo.CREATE))
        press("wiki-settings-form-submit")
        awaitTag("wiki-settings-form-refused")
        says("wiki-settings-form-refused", "This repository already has a wiki.")
        compose.onNodeWithTag("wiki-settings-form").assertExists()
        compose.onNodeWithTag("wiki-settings-workspace").assertTextContains("shop-cli @ US · build-01", substring = true)
        refusal = null
        press("wiki-settings-form-submit")
        awaitTag("wiki-home-list")
        assertEquals(2, writes().size)
    }

    /** A link that names a wiki the account does not have says so, even on an account with none: it is not an offer to make one. */
    @Test fun aLinkToAWikiTheAccountDoesNotHaveIsNotTheFirstCard() {
        spaces = "[]"
        home(at = OrbitRoute(Destination.WIKI, "gone"))
        awaitTag("wiki-space-unavailable")
        gone("wiki-home-first")
    }
}
