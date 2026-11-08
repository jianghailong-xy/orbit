package io.orbitd.android.wiki

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The Wiki while it has nothing to read (design §12.3.1, mock 41), held to `src/shared/src/wiki-start.fixture.json` case for
 * case as the web's `lib/wikiStart.test.ts` is, and OrbitKit's `WikiStartParityTests`: the card of every state of the plan,
 * whether it is drawn, and the workspaces its two forms offer. A missing fixture is a failure, never a skip. The new words are
 * held to the web's own source: the iOS port lands beside this one, so no Swift literal is read here. */
class WikiStartLogicTest {
    private val start get() = WikiStartFixture.shared
    private val states get() = start.fobj("states")
    private val workspaces get() = start.fobj("workspaces")
    private val choices by lazy {
        workspaces.farr("choices").map { it.jsonObject }.map {
            WikiWorkspaceChoice(it.fstr("id"), it.fstr("label"), it["repository"].text(), it["repoUrl"].text(), it["online"].bool() == true)
        }
    }

    /** A card in the fixture's shape, words and buttons, so that one comparison holds all of it. */
    private fun json(card: WikiStartLogic.Card) = buildJsonObject {
        put("title", card.title); put("lead", card.lead)
        putJsonArray("steps") {
            card.steps.forEach { step ->
                add(buildJsonObject {
                    put("state", step.state.name.lowercase()); put("title", step.title); put("text", step.text); put("note", step.note)
                    put("progress", step.progress?.let { buildJsonObject { put("done", it.done); put("total", it.total); put("now", it.now) } } ?: JsonNull)
                    put("action", step.action?.let { buildJsonObject { put("label", it.label); put("to", camel(it.to.name)); put("primary", it.primary) } } ?: JsonNull)
                })
            }
        }
    }

    // MARK: the card of every state of the plan

    @Test fun theFixtureCoversEveryStateThePlanHas() {
        assertEquals(17, states.size)
        assertEquals(WikiPlanFixture.plan.fobj("states").keys, states.keys)
        assertEquals(WikiPlanFixture.shared.fstr("now"), start.fstr("now"))
    }

    @Test fun everyStateIsTheFixtures() {
        states.keys.sorted().forEach { name -> assertEquals(name, states.fobj(name), json(WikiStartFixture.card(name))) }
    }

    @Test fun aFirstDraftIsTheFixtures() {
        val rows = start.fobj("firstDrafts")
        assertEquals(3, rows.size)
        rows.keys.sorted().forEach { name ->
            val row = rows.fobj(name)
            val spec = row.fobj("spec")
            assertEquals(name, row.fobj("card"), json(WikiStartLogic.card(WikiPlanFixture.state(spec), WikiStartFixture.context(spec))))
        }
    }

    @Test fun documentsWhoseWritingWaitsForAnOfflineRunnerAreTheFixtures() {
        val row = start.fobj("writingOffline")
        val spec = row.fobj("spec")
        assertEquals(row.fobj("card"), json(WikiStartLogic.card(WikiPlanFixture.state(spec), WikiStartFixture.context(spec))))
    }

    @Test fun asksForTheRepositoryWhenMaintenanceIsOffAndNothingIsOnItsWay() {
        val spec = WikiPlanFixture.spec("none")
        assertEquals(start.fobj("maintenanceOff"), json(WikiStartLogic.card(WikiPlanFixture.state(spec), WikiStartFixture.context(spec, maintenance = false))))
    }

    @Test fun saysItIsConnectedWhileTheWorkspacesNameIsNotReadYet() {
        val spec = WikiPlanFixture.spec("noneDrafting")
        assertEquals(start.fobj("readsFromUnknown"), json(WikiStartLogic.card(WikiPlanFixture.state(spec), WikiStartFixture.context(spec, readsFrom = null))))
    }

    @Test fun neverOffersMoreThanOnePrimaryButton() {
        (states.keys.map(WikiStartFixture::card) + WikiStartLogic.firstCard(true) + WikiStartLogic.firstCard(false)).forEach { card ->
            assertTrue(card.toString(), card.steps.count { it.action?.primary == true } <= 1)
        }
    }

    @Test fun hasExactlyOneStepInMotion() {
        states.keys.forEach { name ->
            assertEquals(name, 1, WikiStartFixture.card(name).steps.count { it.state == WikiStartLogic.StepState.WAIT || it.state == WikiStartLogic.StepState.RUN })
        }
    }

    // MARK: the states the fixture's plan does not reach — every draft of it comes after a version in force, where the second
    // step is done whatever the draft says. The sentences are the board's table (mock 41 ⑤).

    private fun card(state: WikiPlanState, online: Boolean? = true) =
        WikiStartLogic.card(state, WikiStartFixture.context(buildJsonObject { put("runnerOnline", online) }))
    private fun job(name: String) = WikiPlanJob.read(WikiPlanFixture.plan.fobj("jobs")[name])!!

    @Test fun aFirstDraftThatPassedWaitsToBeConfirmed() {
        val step = card(WikiPlanState("sp1", null, WikiPlanFixture.version("v2"), emptyList(), null)).steps
        assertEquals(WikiStartLogic.StepState.DONE, step[0].state)
        assertEquals(WikiStartLogic.Step(WikiStartLogic.StepState.WAIT, "Confirm the plan", "Draft v2 passed the plan check and waits for you. Documents are written once you confirm it.",
            "3 categories · 3 documents", action = WikiStartLogic.Action("Open plan", WikiStartLogic.ActionTo.PLAN, true)), step[1])
        assertEquals(WikiStartLogic.StepState.TODO, step[2].state)
    }

    @Test fun aFirstDraftThatFailedSaysHowAndOpensThePlan() {
        val failed = job("failed")
        val step = card(WikiPlanState("sp1", null, null, emptyList(), failed)).steps[1]
        assertEquals(WikiStartLogic.Step(WikiStartLogic.StepState.WAIT, "Confirm the plan", "${WikiPlanCopy.jobFailed}. ${failed.error} Nothing was saved.",
            action = WikiStartLogic.Action("Open plan", WikiStartLogic.ActionTo.PLAN, true)), step)
        // A run that ended with no words of its own.
        assertEquals("${WikiPlanCopy.jobFailed}. Its run ended without a draft. Nothing was saved.", card(WikiPlanState("sp1", null, null, emptyList(), failed.copy(error = null))).steps[1].text)
        // The Plan card's sentence, of a draft after a version in force.
        val inForce = WikiPlanState("sp1", WikiPlanFixture.version("v1"), null, emptyList(), failed)
        assertEquals("${WikiPlanCopy.redraftFailed}. ${failed.error} v1 stays in force.", WikiPlanLogic.draftFailedText(failed, inForce))
    }

    @Test fun aDraftWhoseRunHasNotStartedSaysSo() {
        val step = card(WikiPlanState("sp1", null, null, emptyList(), job("notStarted"))).steps[1]
        assertEquals("Drafting the plan · waiting for its run to start", step.text)
        assertEquals(WikiStartCopy.draftingNote, step.note)
        assertEquals(WikiStartLogic.StepState.RUN, step.state)
    }

    @Test fun writingHeldByAnOfflineRunnerSendsTheReaderToTheRunners() {
        val steps = card(WikiPlanState("sp1", WikiPlanFixture.version("v1"), null, emptyList(), job("writingQueued")), online = false).steps
        assertEquals("the workspace is there, its runner is not", WikiStartLogic.StepState.DONE, steps[0].state)
        assertEquals(WikiStartLogic.Step(WikiStartLogic.StepState.WAIT, "Write the documents", "The maintenance runner is offline — writing starts once it’s back.",
            action = WikiStartLogic.Action("View runners", WikiStartLogic.ActionTo.RUNNERS, true)), steps[2])
    }

    @Test fun aBuildOfAnotherVersionIsNotThisVersionsWriting() {
        val stopped = job("writingStopped")
        val steps = card(WikiPlanState("sp1", WikiPlanFixture.version("v1"), null, emptyList(), stopped.copy(version = 9))).steps
        assertEquals(WikiStartCopy.notWritten, steps[2].text)
        assertNull(WikiPlanLogic.failedBuild(WikiPlanState("sp1", null, null, emptyList(), stopped)))
    }

    @Test fun aHeldJobWithNoReasonWaitsForAWorkspaceLikeAnyOther() {
        val first = card(WikiPlanState("sp1", null, null, emptyList(), job("held").copy(held = null))).steps[0]
        assertEquals(WikiStartLogic.ActionTo.SET_UP, first.action?.to)
    }

    // MARK: the card of an account with no wiki

    @Test fun anAccountWithNoWikiMakesOneFromAWorkspaceOnARepository() {
        assertEquals(start.fobj("first").fobj("workspaces"), json(WikiStartLogic.firstCard(true)))
    }

    @Test fun withNoWorkspaceOnARepositoryItSaysWhatIsMissingAndOffersNothing() {
        assertEquals(start.fobj("first").fobj("noRepository"), json(WikiStartLogic.firstCard(false)))
        assertNull(WikiStartLogic.firstCard(false).steps[0].action)
    }

    // MARK: whether the card is drawn

    @Test fun itStandsUntilThereIsSomethingToRead() {
        start.farr("shown").map { it.jsonObject }.forEach { row ->
            assertEquals(row.toString(), row["shown"].bool(), WikiStartLogic.shown(row.fint("written"), row.fint("topics")))
        }
    }

    // MARK: the workspaces the two forms offer

    @Test fun aRepositoryIsNamedAsTheServerNamesItHoweverItsUrlIsSpelled() {
        start.farr("repositories").map { it.jsonObject }.forEach { row ->
            val url = row.fstr("url")
            val repository = WikiStartLogic.repositoryName(url)
            assertEquals(url, row["repository"].text(), repository)
            assertEquals(url, row["title"].text(), repository?.let(WikiStartLogic::repositoryTitle))
        }
        assertNull(WikiStartLogic.repositoryName(null))
    }

    @Test fun whatADraftCouldStartOnComesFirstThenByName() {
        assertEquals(workspaces.fstrings("inOrder"), WikiStartLogic.choicesInOrder(choices).map { it.id })
    }

    @Test fun theyAreGroupedByRepositoryAndOneWithNoneIsLeftOut() {
        assertEquals(workspaces.farr("groups").map { it.jsonObject }.map { it.fstr("repository") to it.fstrings("choices") },
            WikiStartLogic.repositoryGroups(choices).map { group -> group.repository to group.choices.map { it.id } })
    }

    @Test fun itOpensOnTheWorkspaceInUseElseTheReadersIfItIsUpElseTheFirstThatIs() {
        workspaces.farr("defaults").map { it.jsonObject }.forEach { row ->
            assertEquals(row.toString(), row["pick"].text(), WikiStartLogic.workspaceDefault(choices, row["current"].text(), row["from"].text()))
        }
        assertEquals(workspaces["allOffline"].text(), WikiStartLogic.workspaceDefault(choices.filter { !it.online }, null, null))
        assertEquals(workspaces["none"].text(), WikiStartLogic.workspaceDefault(emptyList(), null, null))
    }

    /** Ids are compared in either spelling: a workspace a space or a route names may be a UUID where the list says its public id. */
    @Test fun theReadersWorkspaceIsFoundInEitherSpelling() {
        val uuid = "01a0cca7-8609-70ed-a0e2-d4b55b832b99"
        val offered = choices + WikiWorkspaceChoice(wikiPublicId(uuid), "zz", null, null, true)
        assertEquals(wikiPublicId(uuid), WikiStartLogic.workspaceDefault(offered, null, uuid))
    }

    /** Set up offers this wiki's workspaces, the one in use kept whatever the list says; a wiki with none in it offers them all. */
    @Test fun setUpOffersOnlyThisWikisWorkspaces() {
        fun row(id: String, inWiki: Boolean) = WikiSpaceWorkspaceRow(id, id, inWiki = inWiki)
        fun offered(members: List<WikiSpaceWorkspaceRow>, current: String?) = WikiStartLogic.setUpChoices(choices, members, current).map { it.id }
        val members = listOf(row("sg", true), row("eu", true), row("us", false))
        assertEquals("in the order offered, a workspace left out not among them", listOf("sg", "eu"), offered(members, null))
        assertEquals("the one in use stays", listOf("ba", "sg", "eu"), offered(members, "ba"))
        assertEquals("none in the wiki: all of them", workspaces.fstrings("inOrder"), offered(emptyList(), null))
        assertEquals("left out is not in the wiki", workspaces.fstrings("inOrder"), offered(listOf(row("us", false)), null))
    }

    // MARK: the words, as the web writes them

    private val web by lazy { WikiSharedFiles.file("src/web/src/lib/wikiStart.ts").readText() }

    /** What the web's `export const NAME = '…'` says, the System model's name in place. */
    private fun word(name: String): String = (Regex("export const $name =\\s*['`](.*)['`];").find(web)
        ?: throw AssertionError("wikiStart.ts no longer has $name")).groupValues[1].replace("\${WIKI_PLAN_DRAFTER_SERVER}", WikiPlanCopy.drafterServer)

    @Test fun everyWordIsTheWebs() {
        mapOf("WIKI_START_TITLE" to WikiStartCopy.title, "WIKI_START_FIRST_TITLE" to WikiStartCopy.firstTitle, "WIKI_START_LEAD" to WikiStartCopy.lead,
            "WIKI_START_FIRST_LEAD" to WikiStartCopy.firstLead, "WIKI_START_CONNECT" to WikiStartCopy.connect, "WIKI_START_CONNECT_FIRST" to WikiStartCopy.connectFirst,
            "WIKI_START_CONFIRM" to WikiStartCopy.confirm, "WIKI_START_WRITE" to WikiStartCopy.write, "WIKI_START_CONNECT_TEXT" to WikiStartCopy.connectText,
            "WIKI_START_CONNECT_FIRST_TEXT" to WikiStartCopy.connectFirstText, "WIKI_START_NO_REPOSITORY" to WikiStartCopy.noRepository,
            "WIKI_START_CONFIRM_TODO" to WikiStartCopy.confirmTodo, "WIKI_START_WRITE_TODO" to WikiStartCopy.writeTodo, "WIKI_START_CONNECTED" to WikiStartCopy.connected,
            "WIKI_START_DRAFTING_NOTE" to WikiStartCopy.draftingNote, "WIKI_START_NO_PLAN" to WikiStartCopy.noPlan, "WIKI_START_NOT_WRITTEN" to WikiStartCopy.notWritten,
            "WIKI_CREATE" to WikiStartCopy.create, "WIKI_CREATE_OPEN" to WikiStartCopy.createOpen, "WIKI_CREATE_NOTE" to WikiStartCopy.createNote,
            "WIKI_WORKSPACE_OFFLINE" to WikiStartCopy.workspaceOffline).forEach { (name, ours) -> assertEquals(name, word(name), ours) }
    }

    /** The sentences the web writes where it uses them, rendered with the web's own placeholders. */
    @Test fun everySentenceIsTheWebs() {
        listOf(
            "`Reads from \${workspace}`" to WikiStartCopy.readsFrom("\${workspace}"),
            "`This wiki will describe \${repository}. The server reads the repository through this workspace’s runner.`" to WikiStartCopy.createRepositoryNote("\${repository}"),
            "`Draft queued · \${WIKI_PLAN_QUEUED_TEXT}.`" to WikiStartCopy.draftQueued.replace(WikiPlanCopy.queuedText, "\${WIKI_PLAN_QUEUED_TEXT}"),
            "`Drafting the plan · \${WIKI_PLAN_WRITING_SOON}`" to WikiStartCopy.draftingSoon.replace(WikiPlanCopy.writingSoon, "\${WIKI_PLAN_WRITING_SOON}"),
            "`Drafting the plan · attempt \${open.attempt ?? 1} of \${open.attemptsMax} · started \${wikiAgo(open.startedAt, context.now)}`" to
                WikiStartCopy.drafting(7, 8, "\${wikiAgo(open.startedAt, context.now)}").replace(" 7 ", " \${open.attempt ?? 1} ").replace(" 8 ", " \${open.attemptsMax} "),
        ).forEach { (theirs, ours) ->
            assertTrue("wikiStart.ts no longer says $theirs", web.contains(theirs))
            assertEquals(theirs, "`$ours`")
        }
        assertEquals(WikiStartCopy.connected, WikiStartCopy.readsFrom(null))
        assertEquals(WikiStartCopy.connected, WikiStartCopy.readsFrom(""))
        assertEquals("v1 confirmed · 1 document", WikiStartCopy.confirmed(1, null, 1))
        assertEquals("v2 confirmed Nov 2 · 1,034 documents", WikiStartCopy.confirmed(2, "Nov 2", 1034))
    }

    /** The two forms' answers: the sheet's `Create` is the board's (mock 41 ⑨: Cancel on the left, Create on the right), under
     * the title the web's form has. */
    @Test fun theSheetAnswersCreateUnderItsTitle() {
        assertEquals("Create wiki", WikiStartCopy.create)
        assertEquals("Create", WikiStartCopy.createSubmit)
    }
}
