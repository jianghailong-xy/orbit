package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/** The Main branch row as the owner meets it (docs/mocks/project-main-branch/02-ios.png, Android's a–f): on the start card under
 * Tasks land on — opened on the branch the start's order gives, saying when that is the owner's last choice for the repository —
 * its picker (the reported branches, the value ticked, the last choice tagged, a typed name offered as itself, what the choice
 * decides under the list), no row for a project with no repository, the conversation's card pressing the branch it shows, and How
 * it runs writing a pick at once, then locking with the line. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class MainBranchCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val project = "34cjQN5ynG6eIH5A0neeu"
    private val seal = "c2b4e16c4b59" + "0".repeat(52)
    private val tag = "start-card"
    private val now = Instant.parse("2026-10-10T12:00:00Z")
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    /** acme/payments-api, whose coordination workspace reported three branches. */
    private fun view(upstreamRef: String? = "main", chosenAt: String? = null, last: String? = "master", repository: String? = "acme/payments-api",
        locked: Boolean = false, names: List<String>? = listOf("develop", "master", "release/2.4")) = buildJsonObject {
        put("line", "PROJECT_BRANCH"); put("ref", "project/34cfQ7mPaYmN2Wd8Rk3Jt"); put("locked", locked); put("escalationSeconds", 7200)
        put("upstreamRef", upstreamRef?.let(::JsonPrimitive) ?: JsonNull); put("upstreamChosenAt", chosenAt?.let(::JsonPrimitive) ?: JsonNull)
        put("repository", repository?.let(::JsonPrimitive) ?: JsonNull); put("mergeCheckCommand", "make test")
        if (names == null) put("branches", JsonNull) else putJsonObject("branches") {
            putJsonArray("names") { names.forEach { add(it) } }; put("workspaceName", "payments-api"); put("reportedAt", "2026-10-10T08:00:00Z")
        }
        if (last == null) put("lastMainBranch", JsonNull) else putJsonObject("lastMainBranch") {
            put("branch", last); put("repository", "acme/payments-api"); put("chosenAt", "2026-10-08T09:00:00Z")
        }
        put("startedAt", if (locked) JsonPrimitive("2026-10-07T12:00:00Z") else JsonNull)
    }
    private fun request(suggested: String? = null) = StartProjectCopy.Request(
        StartProjectCopy.Settings("PROJECT_BRANCH", "refs/heads/project/$project", true, 2, "make test", suggested), "", seal)

    /** The draft the card last drew. */
    private var drawn: StartProjectCopy.Draft? = null

    private fun card(view: JsonObject?, request: StartProjectCopy.Request = request(), standing: StartProjectCopy.Standing = StartProjectCopy.Standing.LIVE) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            var draft by remember(view, request) { mutableStateOf(StartProjectCopy.Draft.of(request.settings, view)) }
            SideEffect { drawn = draft }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                StartProjectCard(project, "Order service on the new payment gateway", asked = false, askedAgo = null, request = request,
                    criteria = listOf(StartCriterion(1, "Payments settle through the new gateway.")), plan = StartProjectCopy.planView(null, 3),
                    hasCoordinator = true, escalationSeconds = 7_200, draft = draft, onDraft = { draft = it }, standing = standing, enabled = true,
                    starting = false, error = null, tag = tag, startTag = "$tag-confirm", onStart = {}, onViewTasks = {},
                    branches = ProjectMainBranch.branches(view), lastChoice = ProjectMainBranch.lastChoice(view))
            }
        } } }
        compose.waitForIdle()
    }

    private fun shows(text: String) = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
    private fun picker(name: String) = compose.onNodeWithTag("$tag-main-branch-picker:$name")
    private fun openPicker() { compose.onNodeWithTag("$tag-main-branch").performScrollTo().performClick(); compose.waitForIdle() }

    @Test fun theCardOpensOnTheLastChoiceForTheRepositoryAndEverySentenceNamesIt() {
        card(view(), request(suggested = "refs/heads/develop"))
        shows(RunSettings.mainBranch)
        // The owner's last choice for the repository outranks the coordinator's suggestion, and the row says where it came from.
        compose.onNodeWithTag("$tag-main-branch").assertTextEquals("master")
        compose.onNodeWithTag("$tag-main-branch-last", useUnmergedTree = true).performScrollTo().assertTextEquals("Your last choice for acme/payments-api")
        compose.onNodeWithTag("$tag-automatic-says", useUnmergedTree = true).assertTextEquals(
            "The coordinator decides when each task is done and merges into master once the merge check passes — with a receipt you can revert.")
        compose.onNodeWithTag("$tag-line").performScrollTo().performClick()
        compose.onNodeWithText("Directly into master").assertIsDisplayed()
        compose.onNodeWithText("For a single task or an urgent fix. Every merge into master asks you.").assertIsDisplayed()
        compose.onNodeWithTag("$tag-line:MAIN").performClick()
        shows("Directly into master ▾"); shows("Each merge into master")
        assertEquals("master", drawn?.upstream)
    }

    @Test fun thePickerListsTheReportedBranchesTicksTheValueAndTagsTheLastChoice() {
        card(view(), request())
        openPicker()
        compose.onNodeWithTag("$tag-main-branch-picker").assertIsDisplayed()
        compose.onNodeWithTag("$tag-main-branch-picker-head", useUnmergedTree = true).assertTextEquals(RunSettings.branchesIn("payments-api"))
        compose.onNodeWithText(RunSettings.typeABranch, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(RunSettings.mainBranchHint).assertIsDisplayed()
        picker("master").assertTextContains("master").assertTextContains(RunSettings.lastChosen).assertTextContains("✓")
        listOf("develop", "release/2.4").forEach { name ->
            val texts = picker(name).fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.Text].map { it.text }
            assertEquals(name, listOf(name), texts)
        }
        picker("develop").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("$tag-main-branch-picker").assertDoesNotExist()
        compose.onNodeWithTag("$tag-main-branch").assertTextEquals("develop")
        // A branch that is not the last choice says nothing about where it came from, and the sentences follow it.
        compose.onNodeWithTag("$tag-main-branch-last", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$tag-automatic-says", useUnmergedTree = true).assertTextEquals(RunSettings.automaticSays(true, "PROJECT_BRANCH", true, "develop"))
        assertEquals("refs/heads/develop", StartProjectCopy.body(request(), drawn!!, null).text("upstreamRef"))
    }

    @Test fun aNameTheRunnerNeverReportedIsTypedAndUsed() {
        card(view(), request())
        openPicker()
        compose.onNodeWithTag("$tag-main-branch-picker-field").performTextInput("release/3.0")
        compose.waitForIdle()
        listOf("develop", "master", "release/2.4").forEach { picker(it).assertDoesNotExist() }
        compose.onNodeWithTag("$tag-main-branch-picker-use").assertTextEquals("Use “release/3.0”").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("$tag-main-branch").assertTextEquals("release/3.0")
        assertEquals("refs/heads/release/3.0", StartProjectCopy.body(request(), drawn!!, null).text("upstreamRef"))
        // A name that cannot be a branch is not offered; one the list holds is picked from the list.
        openPicker()
        compose.onNodeWithTag("$tag-main-branch-picker-field").performTextInput("two words")
        compose.waitForIdle()
        compose.onNodeWithTag("$tag-main-branch-picker-use").assertDoesNotExist()
        compose.onNodeWithTag("$tag-main-branch-picker-field").performTextReplacement("mast")
        compose.waitForIdle()
        picker("master").assertExists()
        compose.onNodeWithTag("$tag-main-branch-picker-use").assertTextEquals("Use “mast”")
        compose.onNodeWithTag("$tag-main-branch-picker-cancel").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("$tag-main-branch").assertTextEquals("release/3.0")
    }

    /** With no branch reported the picker asks for a name, and lists only the value. */
    @Test fun withNothingReportedThePickerAsksForAName() {
        card(view(last = null, names = null), request(suggested = "refs/heads/trunk"))
        compose.onNodeWithTag("$tag-main-branch").assertTextEquals("trunk")
        compose.onNodeWithTag("$tag-main-branch-last", useUnmergedTree = true).assertDoesNotExist()
        openPicker()
        compose.onNodeWithTag("$tag-main-branch-picker-head", useUnmergedTree = true).assertTextEquals(RunSettings.typeABranch)
        picker("trunk").assertTextContains("✓")
        compose.onAllNodes(hasTestTag("$tag-main-branch-picker:develop")).assertCountEquals(0)
    }

    @Test fun aProjectWithNoRepositoryHasNoRowAndSaysMain() {
        for (read in listOf(view(repository = null), null)) {
            card(read, request(suggested = "refs/heads/master"))
            compose.onNodeWithText(RunSettings.mainBranch).assertDoesNotExist()
            compose.onNodeWithTag("$tag-main-branch").assertDoesNotExist()
            compose.onNodeWithTag("$tag-automatic-says", useUnmergedTree = true).assertTextEquals(RunSettings.automaticOnChecked)
            assertFalse(StartProjectCopy.body(request(), drawn!!, null).containsKey("upstreamRef"))
        }
    }

    @Test fun aCardThatNoLongerStandsHasItsRowDeadLikeTheRest() {
        card(view(), request(), StartProjectCopy.Standing.GONE)
        compose.onNodeWithTag("$tag-main-branch").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("$tag-line").assertIsNotEnabled()
    }

    /** The conversation's card reads the integration with the session, opens on the branch the start's order gives, and presses it. */
    @Test fun theConversationsCardPressesTheBranchItShows() {
        val row = j("""{"itemId":"item-1","kind":"START_REQUEST","title":"Start this project?","assignee":"OWNER","waitingSince":"2026-10-10T11:00:00.000Z",
            "actions":[],"startRequest":{"settings":{"line":"PROJECT_BRANCH","projectBranchName":"refs/heads/project/p1","automatic":true,"maxConcurrentTasks":2,
            "mergeCheckCommand":"make test","upstreamRef":"refs/heads/develop"},"why":"The repository's main branch is develop.","criteriaDigest":"$seal",
            "planDigest":"pp","repository":"acme/payments-api","warnings":[]}}""")
        val reads = mapOf<String, JsonElement>("project" to j("""{"id":"$project","title":"Order service on the new payment gateway","startedAt":null,
            "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"Payments settle through the new gateway."}]}"""),
            "openItems" to j("""{"needsYou":[],"withCoordinator":[],"startRequest":$row}"""),
            "acceptanceConfirmation" to j("""{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"$seal","material":[]}}"""))
        val card = CardCatalog.project("s1", project, reads).single { it.family == CardFamily.START }
        for ((integration, expected) in listOf(view(last = "master") to "refs/heads/master", view(last = null) to "refs/heads/develop", null to null)) {
            val sent = mutableListOf<CardInput>()
            val withRead = if (integration == null) reads else reads + ("integration" to integration)
            compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    CoordinatorStartCard(card, withRead, fresh = true, result = CardActionState(), open = {}, discuss = {}) { _, input -> sent += input }
                }
            } } }
            compose.waitForIdle()
            if (expected == null) compose.onNodeWithTag("start:item-1-main-branch").assertDoesNotExist()
            else compose.onNodeWithTag("start:item-1-main-branch").assertTextEquals(expected.removePrefix("refs/heads/"))
            compose.onNodeWithTag("start:item-1:START").performScrollTo().performClick()
            assertEquals(expected, sent.single().settings?.upstreamRef)
        }
    }

    // MARK: How it runs

    private val writes = mutableListOf<JsonObject?>()
    private fun runSettings(view: JsonObject) {
        val state = ProjectPageState().apply { integration = view }
        val doc = j("""{"id":"$project","coordinatorEnabled":true,"configRevision":"3","maxConcurrentTasks":2,"pausedAt":null}""")
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                RunSettingsSection(state, doc, now, enabled = true, editMergeCheck = {}, integration = { writes += it }, automatic = {}, stepConcurrency = {}, pause = {})
            }
        } } }
        compose.waitForIdle()
    }

    @Test fun howItRunsWritesAPickAtOnceAndNamesTheBranch() {
        runSettings(view(upstreamRef = "master", chosenAt = "2026-10-08T09:00:00Z"))
        compose.onNodeWithTag("project-main-branch").performScrollTo().assertTextEquals("master")
        shows("${RunSettings.mainBranchHint} New projects in acme/payments-api start with your last choice.")
        shows("Directly into master"); shows("For a single task or an urgent fix. Every merge into master asks you.")
        shows(RunSettings.automaticHint("PROJECT_BRANCH", "master")); shows(RunSettings.mergeCheckHint("master"))
        shows(RunSettings.pauseHint("master"))
        compose.onNodeWithTag("project-main-branch").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("project-main-branch-picker:develop").performClick()
        compose.waitForIdle()
        assertEquals(listOf<JsonObject?>(j("""{"upstreamRef":"refs/heads/develop"}""")), writes)
        compose.onNodeWithTag("project-main-branch-picker").assertDoesNotExist()
    }

    @Test fun onceIntegrationStartsTheBranchLocksWithTheLineAndSaysWhy() {
        runSettings(view(upstreamRef = "master", locked = true))
        compose.onNodeWithTag("project-main-branch").assertDoesNotExist()
        shows("🔒 master")
        shows("This project started integrating 3d ago, so the line it lands on and its main branch can no longer change. Merge it into master, " +
            "or give up the branch, to start another.")
        compose.onNodeWithText(RunSettings.lineLocked("3d ago")).assertDoesNotExist()
        // A project with no repository keeps the line's own sentence, under the line.
        runSettings(view(repository = null, locked = true))
        compose.onNodeWithText(RunSettings.mainBranch).assertDoesNotExist()
        shows(RunSettings.lineLocked("3d ago"))
    }
}
