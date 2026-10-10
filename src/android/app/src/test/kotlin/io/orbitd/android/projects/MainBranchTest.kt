package io.orbitd.android.projects

import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.cards.OwnerItem
import io.orbitd.android.core.cards.*
import io.orbitd.android.directory.SessionProjectCopy
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** A project's main branch (project 34cjQN5ynG6eIH5A0neeu; the web's lib/projectStart.ts): the branch a start opens with — the
 * project's own choice, then this account's last choice for its repository, then the coordinator's suggestion, then main — what a
 * press and a pick write, what the integration read says about it, and every sentence that says where work goes, by the branch's
 * name: master at master, and word for word what it always said at main. The words themselves are MainBranchCopyTest's. */
class MainBranchTest {
    private val seal = "c2b4e16c4b59" + "0".repeat(52)
    private val now = Instant.parse("2026-10-10T12:00:00Z")
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    /** The integration read of a project in acme/payments-api, whose coordination workspace reported three branches. */
    private fun view(repository: String? = "acme/payments-api", upstreamRef: String? = "main", chosenAt: String? = null, last: String? = null,
        locked: Boolean = false, names: List<String>? = listOf("develop", "master", "release/2.4")) = buildJsonObject {
        put("line", "PROJECT_BRANCH"); put("ref", "project/p1"); put("locked", locked)
        put("upstreamRef", upstreamRef?.let(::JsonPrimitive) ?: JsonNull)
        put("upstreamChosenAt", chosenAt?.let(::JsonPrimitive) ?: JsonNull)
        put("repository", repository?.let(::JsonPrimitive) ?: JsonNull)
        if (names == null) put("branches", JsonNull) else putJsonObject("branches") {
            putJsonArray("names") { names.forEach { add(it) } }; put("workspaceName", "payments-api"); put("reportedAt", "2026-10-10T08:00:00Z")
        }
        if (last == null) put("lastMainBranch", JsonNull) else putJsonObject("lastMainBranch") {
            put("branch", last); put("repository", "acme/payments-api"); put("chosenAt", "2026-10-08T09:00:00Z")
        }
        if (locked) put("startedAt", "2026-10-07T12:00:00Z")
    }

    // MARK: what the integration read says

    @Test fun theIntegrationReadCarriesTheRepositoryTheBranchesTheLastChoiceAndWhenItWasChosen() {
        val read = view(upstreamRef = "master", chosenAt = "2026-10-08T09:00:00Z", last = "master")
        assertEquals("acme/payments-api", ProjectMainBranch.repository(read))
        assertEquals(ProjectMainBranch.Branches(listOf("develop", "master", "release/2.4"), "payments-api", "2026-10-10T08:00:00Z"), ProjectMainBranch.branches(read))
        assertEquals(ProjectMainBranch.LastChoice("master", "acme/payments-api", "2026-10-08T09:00:00Z"), ProjectMainBranch.lastChoice(read))
        assertEquals("2026-10-08T09:00:00Z", ProjectMainBranch.chosenAt(read))
        assertEquals("master", ProjectMainBranch.stored(read))
        // A server that predates them says none of the four, and that is none: no repository, no main branch to choose.
        val older = j("""{"line":"PROJECT_BRANCH","ref":"project/p1","upstreamRef":"main","locked":false}""")
        assertNull(ProjectMainBranch.repository(older)); assertNull(ProjectMainBranch.branches(older))
        assertNull(ProjectMainBranch.lastChoice(older)); assertNull(ProjectMainBranch.chosenAt(older)); assertNull(ProjectMainBranch.stored(older))
        // Nothing reported yet is no list, and the picker then asks for a name.
        assertNull(ProjectMainBranch.branches(view(names = null)))
        // Before the project is bound, the branch it stands on is the one binding would give it: the owner's last choice there.
        assertEquals("master", ProjectMainBranch.stored(view(upstreamRef = null, last = "master")))
        assertEquals("main", ProjectMainBranch.stored(view(upstreamRef = null)))
    }

    // MARK: the order a start opens with

    @Test fun aStartOpensOnTheProjectsOwnChoiceThenTheLastChoiceForItsRepositoryThenTheSuggestionThenMain() {
        val suggested = "refs/heads/trunk"
        assertEquals("the project's own choice outranks everything", "release/2.4",
            StartProjectCopy.startMainBranch(suggested, view(upstreamRef = "release/2.4", chosenAt = "2026-10-08T09:00:00Z", last = "master")))
        assertEquals("then the owner's last choice for the repository", "master", StartProjectCopy.startMainBranch(suggested, view(upstreamRef = "main", last = "master")))
        assertEquals("then what the coordinator suggests", "trunk", StartProjectCopy.startMainBranch(suggested, view(upstreamRef = "main")))
        assertEquals("then main", "main", StartProjectCopy.startMainBranch(null, view(upstreamRef = "main")))
        assertEquals("main", StartProjectCopy.startMainBranch(null, null))
        // A branch the project only stands on by default — never chosen — is not a choice: the owner's earlier one and the suggestion
        // both outrank it.
        assertEquals("develop", StartProjectCopy.startMainBranch("refs/heads/develop", view(upstreamRef = "release/2.4")))
        // The suggestion is a full ref and the card a name; a name passes as it is.
        assertEquals("develop", StartProjectCopy.startMainBranch("develop", view()))
    }

    @Test fun onlyAProjectWithARepositoryHasAMainBranchOnTheCard() {
        val settings = StartProjectCopy.Settings("PROJECT_BRANCH", "refs/heads/project/p1", false, 2, null, "refs/heads/develop")
        val draft = StartProjectCopy.Draft.of(settings, view(last = "master"))
        assertEquals(StartProjectCopy.Draft("PROJECT_BRANCH", true, 2, "", "master"), draft)
        assertEquals("master", draft.main)
        assertEquals("develop", StartProjectCopy.Draft.of(settings, view()).upstream)
        assertNull(StartProjectCopy.Draft.of(settings, view(repository = null)).upstream)
        assertNull("a read that did not answer offers no main branch", StartProjectCopy.Draft.of(settings, null).upstream)
        assertEquals("main", StartProjectCopy.Draft.of(settings, null).main)
    }

    /** The request carries the coordinator's suggestion, and the owner's own Start… the branch the project already stands on. */
    @Test fun theRequestAndTheDefaultRuleCarryAMainBranchToStartFrom() {
        val row = j("""{"itemId":"item-1","startRequest":{"settings":{"line":"MAIN","automatic":true,"maxConcurrentTasks":1,
            "mergeCheckCommand":null,"upstreamRef":"refs/heads/master"},"why":"","criteriaDigest":"$seal"}}""")
        assertEquals("refs/heads/master", StartProjectCopy.request(row)?.settings?.upstreamRef)
        assertNull(StartProjectCopy.request(j("""{"startRequest":{"settings":{"line":"MAIN","automatic":true,"maxConcurrentTasks":1,
            "mergeCheckCommand":null},"why":"","criteriaDigest":"$seal"}}"""))?.settings?.upstreamRef)
        assertEquals("refs/heads/develop", StartProjectCopy.defaultSettings(view(upstreamRef = "develop"), 1, null).upstreamRef)
        assertNull(StartProjectCopy.defaultSettings(view(upstreamRef = null), 1, null).upstreamRef)
    }

    // MARK: what a press and a pick write

    @Test fun aPressWritesTheMainBranchOnTheCardAsAFullRef() {
        val request = StartProjectCopy.Request(StartProjectCopy.Settings("MAIN", null, true, 1, null, "refs/heads/master"), "", seal)
        val draft = StartProjectCopy.Draft.of(request.settings, view(upstreamRef = null))
        assertEquals(j("""{"criteriaDigest":"$seal","line":"MAIN","upstreamRef":"refs/heads/master","automatic":true,"maxConcurrentTasks":1,
            "mergeCheckCommand":null,"requestId":"item-1"}"""), StartProjectCopy.body(request, draft, "item-1"))
        assertEquals("refs/heads/release/3.0", StartProjectCopy.body(request, draft.copy(upstream = "release/3.0"), null).text("upstreamRef"))
        // No repository, no row, and nothing sent: the project keeps the main branch it stands on.
        assertFalse(StartProjectCopy.body(request, draft.copy(upstream = null), null).containsKey("upstreamRef"))
    }

    /** The conversation's press goes through the card actions with the branch its card showed — and a press that brings no settings
     * of its own names none, whatever the coordinator suggested. */
    @Test fun theConversationsPressSendsTheBranchItsCardShowed() {
        val row = """{"itemId":"item-1","kind":"START_REQUEST","title":"Start this project?","assignee":"OWNER","waitingSince":"2026-09-29T08:24:00.000Z",
            "actions":[],"startRequest":{"settings":{"line":"PROJECT_BRANCH","projectBranchName":"refs/heads/project/p1","automatic":true,
            "maxConcurrentTasks":3,"mergeCheckCommand":null,"upstreamRef":"refs/heads/master"},"why":"","criteriaDigest":"$seal","planDigest":"pp",
            "repository":null,"warnings":[]}}"""
        val reads = mapOf<String, JsonElement>("project" to j("""{"id":"p1","title":"Aurora","startedAt":null,
            "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"Done."}]}"""),
            "openItems" to j("""{"needsYou":[],"withCoordinator":[],"startRequest":$row}"""),
            "acceptanceConfirmation" to j("""{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"$seal","material":[]}}"""))
        val card = CardCatalog.project("s1", "p1", reads).single { it.family == CardFamily.START }
        val request = StartProjectCopy.request(j(row))!!
        val draft = StartProjectCopy.Draft.of(request.settings, view()).copy(upstream = "develop")
        val sent = CardRequests.build(card, CardVerb.START, CardInput(settings = ProjectStartSettings(draft.line, draft.automatic, draft.maxConcurrentTasks,
            draft.mergeCheckCommand, request.settings.projectBranchName, draft.upstream?.let(RunSettings::mainBranchRef))))
        assertEquals(StartProjectCopy.body(request, draft, "item-1"), Json.parseToJsonElement(sent.body!!.decodeToString()).jsonObject)
        val bare = Json.parseToJsonElement(CardRequests.build(card, CardVerb.START, CardInput()).body!!.decodeToString()).jsonObject
        assertFalse(bare.containsKey("upstreamRef"))
    }

    @Test fun choosingInHowItRunsWritesTheBranchAsAFullRefOnlyWhileItCanMove() {
        assertEquals(j("""{"upstreamRef":"refs/heads/master"}"""), RunSettings.mainBranchWrite(view(), "master"))
        assertNull("the branch it already stands on writes nothing", RunSettings.mainBranchWrite(view(), "main"))
        assertNull("a locked line and its main branch are refused together", RunSettings.mainBranchWrite(view(locked = true), "master"))
        val unbound = view(upstreamRef = null, last = "master")
        assertNull(RunSettings.mainBranchWrite(unbound, "master"))
        assertEquals(j("""{"upstreamRef":"refs/heads/develop"}"""), RunSettings.mainBranchWrite(unbound, "develop"))
        assertEquals("refs/heads/release/3.0", RunSettings.mainBranchRef("release/3.0"))
        assertEquals("master", RunSettings.mainBranchName("refs/heads/master"))
        assertEquals("master", RunSettings.mainBranchName("master"))
        assertEquals("main", RunSettings.mainBranchName(null))
        assertEquals("main", RunSettings.mainBranchName(""))
    }

    @Test fun aTypedNameIsOfferedOnlyWhenItLooksLikeABranch() {
        listOf("release/3.0", "master", "feature/x-1", "v2", "a.b").forEach { assertTrue(it, RunSettings.isBranchName(it)) }
        listOf("has space", "a..b", "x~1", "x^", "a:b", "a?", "a*", "a[b", "a\\b", "-x", "/x", "x/", "x.lock", "").forEach {
            assertFalse(it, RunSettings.isBranchName(it))
        }
    }

    // MARK: the words, by the branch's name

    /** At main every sentence is the constant it always was; at master each names master — the start card and How it runs. */
    @Test fun theStartCardAndHowItRunsNameTheBranch() {
        assertEquals(RunSettings.lineMain, RunSettings.lineMain("main"))
        assertEquals(RunSettings.lineMainHint, RunSettings.lineMainHint("main"))
        assertEquals(RunSettings.mergeCheckHint, RunSettings.mergeCheckHint("main"))
        assertEquals(RunSettings.noMergeCheckWarning, RunSettings.noMergeCheckWarning("main"))
        assertEquals(RunSettings.pauseHint, RunSettings.pauseHint("main"))
        assertEquals(RunSettings.automaticHintProjectBranch, RunSettings.automaticHint("PROJECT_BRANCH", "main"))
        assertEquals(RunSettings.automaticHintMain, RunSettings.automaticHint("MAIN", "main"))
        assertEquals(StartProjectCopy.mergingIntoMain, StartProjectCopy.mergingInto("main"))
        assertEquals(StartProjectCopy.eachMergeIntoMain, StartProjectCopy.eachMergeInto("main"))
        mapOf(Triple(true, "PROJECT_BRANCH", true) to RunSettings.automaticOnChecked, Triple(true, "PROJECT_BRANCH", false) to RunSettings.automaticOnUnchecked,
            Triple(true, "MAIN", true) to RunSettings.automaticOnMain, Triple(false, "PROJECT_BRANCH", true) to RunSettings.automaticOff,
            Triple(false, "MAIN", true) to RunSettings.automaticOffMain).forEach { (case, said) ->
            assertEquals(said, RunSettings.automaticSays(case.first, case.second, case.third, "main"))
            assertEquals(said.replace("into main", "into master"), RunSettings.automaticSays(case.first, case.second, case.third, "master"))
        }
        assertEquals("Directly into master", RunSettings.lineMain("master"))
        assertEquals("For a single task or an urgent fix. Every merge into master asks you.", RunSettings.lineMainHint("master"))
        assertEquals("Runs on the combined tree before anything lands — on the project branch and again before master.", RunSettings.mergeCheckHint("master"))
        assertEquals("No merge check: with Automatic on, the branch merges into master with nothing run on the combined tree.", RunSettings.noMergeCheckWarning("master"))
        assertEquals("Paused 2h ago. Stops new tasks, wake-ups and merges into master. Running tasks finish.",
            RunSettings.pauseFootnote("2026-10-10T10:00:00Z", now, "master"))
        assertEquals("The coordinator runs it for you: it decides when each task is done, handles conflicts and failed checks, and merges the branch " +
            "into master once the merge check passes — with a receipt you can revert. The criteria and anything irreversible stay yours.",
            RunSettings.automaticHint("PROJECT_BRANCH", "master"))
        assertEquals("The coordinator runs it for you: it decides when each task is done and handles conflicts and failed checks. Merging into master " +
            "always asks you — a project that lands directly on master never merges by itself. The criteria and anything irreversible stay yours.",
            RunSettings.automaticHint("MAIN", "master"))
        assertEquals(listOf("Merging the branch into master", "Any change to the criteria"),
            StartProjectCopy.comesToYou(false, "PROJECT_BRANCH", emptyList(), 0, 7_200, "master").drop(2).map { it.text })
        assertEquals("Each merge into master", StartProjectCopy.comesToYou(true, "MAIN", emptyList(), 0, 7_200, "master").first().text)
        // The lock: the line's own sentence for a project with no Main branch row, and the row's, which locks the branch with it.
        assertEquals("This project started integrating 3d ago, so the line it lands on can no longer change. Merge it into main, or give up the branch, " +
            "to start another.", RunSettings.lineLocked("3d ago"))
        assertEquals("This project started integrating 3d ago, so the line it lands on and its main branch can no longer change. Merge it into " +
            "master, or give up the branch, to start another.", RunSettings.mainBranchLocked("3d ago", "master"))
        assertEquals("This project started integrating, so the line it lands on and its main branch can no longer change. Merge it into main, or " +
            "give up the branch, to start another.", RunSettings.mainBranchLocked(null, "main"))
        // The new words.
        assertEquals("Your last choice for acme/payments-api", RunSettings.lastChoiceFor("acme/payments-api"))
        assertEquals("New projects in acme/payments-api start with your last choice.", RunSettings.mainBranchRemembers("acme/payments-api"))
        assertEquals("Branches in payments-api", RunSettings.branchesIn("payments-api"))
        assertEquals("Use “release/3.0”", RunSettings.useBranch("release/3.0"))
    }

    /** The start's row on the project page, the undecided line and the session list's suggestion: directly into the branch the start
     * card opens with. */
    @Test fun theStartsRowsSayDirectlyIntoTheBranchTheCardOpensWith() {
        val asked = j("""{"line":"MAIN","automatic":false,"maxConcurrentTasks":2,"upstreamRef":"refs/heads/master"}""")
        assertEquals("The coordinator asked · directly into master · Automatic off · at most 2 at a time", StartProjectCopy.requestSummary(asked))
        assertEquals("The coordinator asked · directly into develop · Automatic off · at most 2 at a time",
            StartProjectCopy.requestSummary(asked, StartProjectCopy.startMainBranch(asked.text("upstreamRef"), view(last = "develop"))))
        assertEquals("The coordinator asked · directly into main · Automatic off · at most 2 at a time",
            StartProjectCopy.requestSummary(j("""{"line":"MAIN","automatic":false,"maxConcurrentTasks":2}""")))
        assertEquals("Tasks land on: decided when you start — the coordinator suggests directly into master", RunSettings.undecidedLine("MAIN", "master"))
        assertEquals("Tasks land on: decided when you start — the coordinator suggests directly into main", RunSettings.undecidedLine("MAIN"))
        assertEquals("Directly into master · Automatic on · 2 at a time", SessionProjectCopy.startSuggestion(
            j("""{"line":"MAIN","automatic":true,"maxConcurrentTasks":2,"upstreamRef":"refs/heads/master"}""")))
        assertEquals("Directly into develop · Automatic on · 2 at a time", SessionProjectCopy.startSuggestion(
            j("""{"line":"MAIN","automatic":true,"maxConcurrentTasks":2,"upstreamRef":"refs/heads/master"}"""), "develop"))
        assertEquals("Directly into main · Automatic on · 2 at a time", SessionProjectCopy.startSuggestion(j("""{"line":"MAIN","automatic":true,"maxConcurrentTasks":2}""")))
    }

    /** The project page beyond the settings: the integration row, the work overview's lanes, the landing row and its jobs, where met
     * criteria landed, and Copy as Markdown. */
    @Test fun theProjectPageNamesTheBranchWhereItSaidMain() {
        val ago = "2026-10-10T10:00:00Z"
        val facts = ProjectPage.integrationFacts(j("""{"line":"PROJECT_BRANCH","ref":"project/p1","upstreamRef":"master","commitsAheadOfUpstream":3,
            "lastUpstreamSyncAt":"$ago","integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"PASSING"}"""), now)!!
        assertEquals(listOf("project/p1", "3 commits ahead of master at last measurement", "synced with master 2h ago"), facts.take(3))
        val onMain = ProjectPage.integrationFacts(j("""{"line":"PROJECT_BRANCH","ref":"project/p1","upstreamRef":"main","commitsAheadOfUpstream":1,
            "lastUpstreamSyncAt":"$ago","integratingCount":0,"queuedCount":0,"mergeCheckOnTip":"PASSING"}"""), now)!!
        assertEquals(listOf("project/p1", "1 commit ahead of main at last measurement", "synced with main 2h ago"), onMain.take(3))
        assertEquals("master", ProjectPage.integrationFacts(j("""{"line":"MAIN","upstreamRef":"master","integratingCount":0,"queuedCount":0}"""), now)!!.first())

        val buckets = j("""{"running":0,"ready":0,"blocked":0,"integrating":0,"onIntegrationLine":2,"onUpstream":3}""")
        val lanes = ProjectPage.overviewCells(buckets, 5, "PROJECT_BRANCH", true, main = "master").associateBy { it.key }
        assertEquals("not on master yet", lanes.getValue("onIntegrationLine").footnote)
        assertEquals("On master" to "landed on master", lanes.getValue("onUpstream").let { it.label to it.footnote })
        val before = ProjectPage.overviewCells(buckets, 5, "PROJECT_BRANCH", true).associateBy { it.key }
        assertEquals("not on main yet", before.getValue("onIntegrationLine").footnote)
        assertEquals("On main" to "landed on main", before.getValue("onUpstream").let { it.label to it.footnote })

        // The landing row and its jobs: the merge and the sync of the branch the view names.
        val job = """{"jobId":"j1","kind":"LAND_PROMOTION","state":"RUNNING","phase":"MAIN_SYNC","startedAt":"2026-10-10T11:58:00Z",
            "heartbeatAt":"2026-10-10T11:59:50Z","taskTitle":null,"timedOut":false,"retryable":false}"""
        val landing = j("""{"upstreamRef":"master","integratingCount":1,"queuedCount":0,"inFlight":$job,"inFlightJobs":[$job]}""")
        ProjectPage.landingLine(landing, now, now, false)!!.let { assertEquals("Merge to master" to "syncing master", it.word to it.state) }
        ProjectPage.landingJobLines(landing, now, now, false).single().line.let { assertEquals("Merge to master" to "syncing master", it.word to it.state) }
        val stopped = j("""{"upstreamRef":"master","integratingCount":1,"queuedCount":0,"inFlightJobs":[{"jobId":"j2","kind":"LAND_TASK","state":"RUNNING",
            "phase":"MAIN_SYNC","startedAt":"2026-10-10T11:30:00Z","heartbeatAt":"2026-10-10T11:31:00Z","timedOut":true,"limitSeconds":600,"retryable":true}]}""")
        assertEquals("The runner took it at 11:30 · stopped at syncing master · no push recorded",
            ProjectPage.landingJobLines(stopped, now, now, false, ZoneOffset.UTC).single().detail)
        ProjectPage.landingLine(j(landing.toString().replace("\"master\"", "\"main\"")), now, now, false)!!.let {
            assertEquals(ProjectPage.integrationJobWords["LAND_PROMOTION"] to ProjectPage.integrationPhaseWords["MAIN_SYNC"], it.word to it.state)
        }

        val landed = j("""{"satisfied":true,"landing":"LANDED","unmet":[]}""")
        val onLine = j("""{"satisfied":true,"landing":"ON_INTEGRATION_LINE","unmet":[]}""")
        assertEquals("on master", ProjectPage.criterionWork(landed, "project/p1", "master")?.landing)
        assertEquals("on project/p1" to "not on master yet", ProjectPage.criterionWork(onLine, "project/p1", "master")?.let { it.landing to it.landingWarning })
        assertEquals("on main", ProjectPage.criterionWork(landed, "project/p1")?.landing)
        assertEquals("not on main yet", ProjectPage.criterionWork(onLine, "project/p1")?.landingWarning)

        fun markdown(upstream: String?) = ProjectMarkdown.project(j("""{"title":"Aurora","status":"OPEN","_count":{"tasks":2},
            "integration":{"upstreamRef":${upstream?.let { "\"$it\"" } ?: "null"}},"acceptanceCriteriaItems":[
            {"ordinal":1,"text":"One.","satisfied":true,"landing":"LANDED"},{"ordinal":2,"text":"Two.","satisfied":true,"landing":"ON_INTEGRATION_LINE"}]}"""),
            "https://orbit.test/projects/p1", null, null)
        assertTrue(markdown("master").contains("1. One. — Met by its work · on master\n2. Two. — Met by its work · on the project branch · not on master yet\n"))
        assertTrue(markdown(null).contains("1. One. — Met by its work · on main\n2. Two. — Met by its work · on the project branch · not on main yet\n"))
        assertEquals(ProjectMarkdown.landingWords, ProjectMarkdown.landingWords("main"))
    }

    /** The done cards: the tallies, a criterion's place, and the gap Orbit fills in when nobody asked. */
    @Test fun theDoneCardsNameTheBranch() {
        val counts = j("""{"criteria":3,"met":2,"onMain":1,"byReason":{"NOTHING_TO_LAND":1}}""")
        assertEquals("2 met · 1 landed on master · 1 nothing to land", ProjectDone.cardTally(counts, "master"))
        assertEquals("2 met · 1 landed on main · 1 nothing to land", ProjectDone.cardTally(counts))
        assertEquals("3 criteria met · 1 landed on master · 1 nothing to land · 0 gaps accepted", ProjectDone.receiptTally(counts, 0, "master"))
        assertEquals("Landed on master", ProjectDone.landingReasonLabel(null, "master"))
        assertEquals("Landed on main", ProjectDone.landingReasonLabel(null))
        assertEquals("On the project branch", ProjectDone.landingReasonLabel("ON_PROJECT_BRANCH", "master"))
        fun doc(upstream: String) = j("""{"title":"Aurora","status":"OPEN","integration":{"upstreamRef":"$upstream"},
            "acceptanceCriteriaItems":[{"id":"c1","key":"k1","ordinal":1,"text":"One."},{"id":"c2","key":"k2","ordinal":2,"text":"Two."}],
            "derivedDone":{"counts":{"criteria":2,"met":2,"onMain":1},"criteria":[{"definitionId":"c1","satisfied":true,"landingReason":null},
            {"definitionId":"c2","satisfied":true,"landingReason":"ON_PROJECT_BRANCH"}]}}""")
        assertEquals("master", ProjectDone.mainBranch(doc("master")))
        assertEquals("2 criteria · 1 on master · 1 on the project branch", ProjectDone.whyNotDoneTally(doc("master")))
        assertEquals("2 criteria · 1 on main · 1 on the project branch", ProjectDone.whyNotDoneTally(doc("main")))
        assertEquals("Orbit cannot prove this criterion is on master: On the project branch.", ProjectDone.syntheticGaps(doc("master")).single().text("whyNotProven"))
        assertEquals("Orbit cannot prove this criterion is on main: On the project branch.", ProjectDone.syntheticGaps(doc("main")).single().text("whyNotProven"))
        assertEquals(ProjectDone.onMain to ProjectDone.landedOnMain, ProjectDone.on("main") to ProjectDone.landedOn("main"))
    }

    /** The merge into the project's main branch: the press, both receipt headings, the receipt's row and the card's title. */
    @Test fun theMergeCardNamesTheBranchItMergesInto() {
        val merged = j("""{"promotionId":"pr-1","state":"MERGED","sourceRef":"refs/heads/project/p1","sourceSha":"58f3a4711d0c",
            "upstreamRef":"refs/heads/master","taskIds":["t1"],"merged":{"sha":"8d5a868","at":"2026-10-10T11:00:00Z","automatic":false}}""")
        assertEquals("master", PromotionCards.mainBranch(merged))
        assertEquals("✓ Merged into master", PromotionCards.title(merged))
        assertEquals("✓ Merged into master automatically", PromotionCards.title(j(merged.toString().replace("\"automatic\":false", "\"automatic\":true"))))
        assertEquals(PromotionCards.mergedHeading, PromotionCards.title(j(merged.toString().replace("refs/heads/master", "refs/heads/main"))))
        assertEquals("Merge to master", PromotionCards.mergeTo("master"))
        assertEquals("Now on master", PromotionCards.nowOn("master"))
        assertEquals(PromotionCards.mergeToMain, PromotionCards.mergeTo("main"))
        assertEquals(PromotionCards.mergedHeading to PromotionCards.mergedAutomaticallyHeading,
            PromotionCards.mergedHeading("main") to PromotionCards.mergedAutomaticallyHeading("main"))
        // The conversation's card for a candidate that asks: its title is the press's words, the branch short.
        val asking = j("""{"promotionId":"pr-2","state":"READY","sourceRef":"refs/heads/project/p1","sourceSha":"58f3a4711d0c","upstreamRef":"refs/heads/master",
            "taskIds":["t1"]}""")
        val reads = mapOf<String, JsonElement>("project" to j("""{"id":"p1","title":"Aurora","startedAt":"2026-10-01T00:00:00Z","acceptanceCriteriaItems":[]}"""),
            "promotion" to asking)
        assertEquals("Merge to master", CardCatalog.project("s1", "p1", reads).single { it.family == CardFamily.PROMOTION }.title)
    }

    /** What waits on the owner, where the server names the branch: the projects list's chip and the session row's item. */
    @Test fun theMergeApprovalsNameTheBranch() {
        fun project(mainBranch: String?) = j("""{"id":"p1","title":"Aurora","status":"OPEN","_count":{"tasks":1},"buckets":{"ready":1},
            "mainBranch":${mainBranch?.let { "\"$it\"" } ?: "null"},"lastActivityAt":"2026-10-10T11:59:00Z",
            "attention":{"ownerItems":[{"kind":"PROMOTION_APPROVAL","count":1,"oldestWaitingSince":"2026-10-10T11:42:00Z"}]}}""")
        assertEquals("Needs you · Approve merge to master · 18m", ProjectAttention.chip(project("master"), now)?.text)
        assertEquals("Needs you · Approve merge to main · 18m", ProjectAttention.chip(project(null), now)?.text)
        val items = NeedsYouLogic.ownerItems(listOf(j("""{"itemId":"i1","kind":"PROMOTION_APPROVAL","title":"Merge 3 tasks into master?",
            "since":"2026-10-10T11:00:00Z","mainBranch":"master"}""")))
        assertEquals(OwnerItem("i1", "PROMOTION_APPROVAL", "Merge 3 tasks into master?", "2026-10-10T11:00:00Z", "master"), items.single())
        assertEquals("Approve merge to master · Aurora", NeedsYouLogic.ownerItemText(items.single(), "Aurora"))
        assertEquals("Approve merge to master", NeedsYouLogic.oldestItemWord(items))
        assertEquals("Approve merge to main", NeedsYouLogic.oldestItemWord(listOf(items.single().copy(mainBranch = null))))
        assertEquals("Approve merge to main", NeedsYouLogic.kindWord("PROMOTION_APPROVAL"))
    }

    /** The session list's project row: the landing line's merge and sync, named by the row's main branch. */
    @Test fun theSessionListsLandingLineNamesTheBranch() {
        val integration = j("""{"activeJobCount":1,"inFlight":{"kind":"LAND_PROMOTION","state":"RUNNING","phase":"MAIN_SYNC",
            "startedAt":"2026-10-10T11:56:00Z","heartbeatAt":"2026-10-10T11:59:30Z","taskTitle":null}}""")
        assertEquals("Merge to master · syncing master · 4m", SessionProjectCopy.landingLine(integration, now, "master")?.text)
        assertEquals("Merge to main · syncing main · 4m", SessionProjectCopy.landingLine(integration, now)?.text)
    }
}
