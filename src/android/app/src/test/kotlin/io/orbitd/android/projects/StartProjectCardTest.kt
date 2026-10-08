package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
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

/** The card's wiring to its words and rules — what OrbitKit's `StartProjectWiringTests` asserts over `StartProjectCard`'s
 * SwiftUI source, asserted here over the drawn Compose tree: the header and the coordinator's own words, the Automatic
 * sentence and what still comes to the owner following the switch and the line, the merge check folded to Set / None with
 * nothing warned about, At most bounded at the door's bounds, the plan by level, the caption under Start, a dead Start that
 * says why — and none of the card's old lines. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class StartProjectCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val project = "34WvwUS8YMXfOfWbMqVuu"
    private val seal = "c2b4e16c4b59" + "0".repeat(52)
    private val tag = "start-card"
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    private val criteria = listOf(StartCriterion(1, "Reminders follow one rule on every client."), StartCriterion(2, "The go-live is confirmed by the owner."))
    /** The mock's plan: A; B and C; D after B; E — the go-live, the owner's to confirm — after C and D. */
    private val plan = StartProjectCopy.planView(DependencyGraph(listOf(
        Triple("a", "A · 提醒规则做成两端共用的真源", "EVIDENCE_JUDGMENT"), Triple("b", "B · OrbitKit：提醒规则、文案、DTO 与接口", "EVIDENCE_JUDGMENT"),
        Triple("c", "C · web：Runners 列表与 runner 详情页", "EVIDENCE_JUDGMENT"), Triple("d", "D · iOS/macOS：Runners 列表、Add Runner、Edit", "EVIDENCE_JUDGMENT"),
        Triple("e", "E · 上线", "OWNER_CONFIRMED"),
    ).map { (id, title, criterion) -> GraphMark(MarkKind.TASK, id, title, status = "OPEN", completionCriterion = criterion, autoRunWhenReady = true) },
        listOf("a" to "b", "a" to "c", "b" to "d", "c" to "e", "d" to "e").map { GraphEdge(it.first, it.second) }, 5, false, null), 5)

    private fun request(automatic: Boolean = true, check: String? = "npm test") = StartProjectCopy.Request(
        StartProjectCopy.Settings("PROJECT_BRANCH", "refs/heads/project/$project", automatic, 3, check), "B and C both build on A — one branch checks them together.", seal)

    private var started = 0

    private fun card(request: StartProjectCopy.Request, asked: Boolean, hasCoordinator: Boolean = true, maxConcurrent: Int? = null,
        standing: StartProjectCopy.Standing = StartProjectCopy.Standing.LIVE, chat: (() -> Unit)? = null) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            // Keyed: a second setContent reuses this composition.
            var draft by androidx.compose.runtime.remember(request, maxConcurrent) {
                val opened = StartProjectCopy.Draft.of(request.settings)
                mutableStateOf(maxConcurrent?.let { opened.copy(maxConcurrentTasks = it) } ?: opened)
            }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                StartProjectCard(project, "Runner 页整页改版", asked, if (asked) "56m ago" else null, request, criteria, plan, hasCoordinator, 7_200, draft,
                    { draft = it }, standing, enabled = true, starting = false, error = null, tag = tag, startTag = "$tag-confirm",
                    onStart = { started++ }, onViewTasks = {}, onChatAbout = chat)
            }
        } } }
        compose.waitForIdle()
    }

    private fun shows(text: String) = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()
    private fun texts(): List<String> = compose.onAllNodes(hasText("", substring = true), useUnmergedTree = true).fetchSemanticsNodes()
        .flatMap { node -> if (SemanticsProperties.Text in node.config) node.config[SemanticsProperties.Text].map { it.text } else emptyList() }

    @Test fun theCoordinatorsCardSaysWhoAskedQuotesItAndListsWhatStillComesToTheOwner() {
        card(request(automatic = false), asked = true, chat = {})
        shows("Runner 页整页改版"); shows(StartProjectCopy.askedLine("56m ago"))
        shows(StartProjectCopy.coordinator); shows(request().why); shows(StartProjectCopy.more)
        // Automatic opens on whatever was suggested, and the note says the coordinator suggested off.
        compose.onNodeWithTag("$tag-automatic").assertIsOn()
        shows(RunSettings.automaticOnChecked)
        shows(StartProjectCopy.howItRunsNote(asked = true, suggestedOff = true))
        shows("COMES TO YOU"); shows("E · 上线 · you confirm it"); shows(StartProjectCopy.criteriaChanges); shows("Problems it can’t resolve within 2 h")
        // The plan by level: what starts now, what runs side by side, what needs the owner.
        shows("DONE WHEN · 2 CRITERIA"); shows("PLAN · 5 TASKS IN 4 LEVELS")
        compose.onNodeWithTag("$tag-level:1").assertTextContains("A").assertTextContains("提醒规则做成两端共用的真源").assertTextContains(StartProjectCopy.now)
        compose.onNodeWithTag("$tag-level:2").assertTextContains("B · C").assertTextContains("2 in parallel")
        compose.onNodeWithTag("$tag-level:4").assertTextContains("E").assertTextContains("上线").assertTextContains(StartProjectCopy.you)
        shows("Starts A now · confirms these 2 criteria · seal c2b4e16c4b59")
        shows(CardVerb.CHAT.label)
        compose.onNodeWithTag("$tag-confirm").performScrollTo().assertIsEnabled().performClick()
        assertEquals(1, started)
        // None of the card's old lines: no meta line, no "asked by the coordinator", no order line, no ready check.
        texts().forEach { text ->
            assertFalse(text, text.contains("asked by the coordinator") || text.contains("starts now") || text.contains("start now") ||
                text.contains("Orbit checked the plan") || text.contains(" · seal c2b4e16c4b59 ·") || text.contains(RunSettings.noMergeCheckWarning))
        }
    }

    @Test fun turningAutomaticOffListsEveryDecisionTheCoordinatorWouldHaveMade() {
        card(request(), asked = true)
        compose.onNodeWithTag("$tag-automatic").performScrollTo().performClick().assertIsOff()
        shows(RunSettings.automaticOff)
        shows("Whether each task is done · 4 reviews"); shows("Problems along the way · conflicts, failed checks"); shows(StartProjectCopy.mergingIntoMain)
        compose.onNodeWithText("Problems it can’t resolve within 2 h").assertDoesNotExist()
    }

    @Test fun theLineIsPickedFromTheMenuAndTheSentenceAndTheListFollowIt() {
        card(request(), asked = true)
        compose.onNodeWithTag("$tag-line").performScrollTo().performClick()
        compose.onNodeWithText("project/$project — ${RunSettings.lineProjectBranchHint}").assertIsDisplayed()
        compose.onNodeWithTag("$tag-line:MAIN").performClick()
        shows("${RunSettings.lineMain} ▾"); shows(RunSettings.automaticOnMain); shows(StartProjectCopy.eachMergeIntoMain)
        compose.onNodeWithTag("$tag-automatic").performScrollTo().performClick()
        shows(RunSettings.automaticOffMain)
    }

    @Test fun anEmptyMergeCheckIsNoneAndNothingIsWarnedAbout() {
        card(request(check = null), asked = true)
        compose.onNodeWithTag("$tag-merge-check-value", useUnmergedTree = true).performScrollTo().assertTextEquals(RunSettings.mergeCheckNone)
        shows(RunSettings.mergeCheckNoneSays); shows(RunSettings.automaticOnUnchecked)
        compose.onNodeWithText(RunSettings.noMergeCheckWarning).assertDoesNotExist()
        compose.onNodeWithTag("$tag-merge-check").performClick()
        compose.onNodeWithTag("$tag-merge-check-command").performScrollTo().performTextInput("make check")
        compose.onNodeWithTag("$tag-merge-check-value", useUnmergedTree = true).assertTextEquals(RunSettings.mergeCheckSet)
        shows(RunSettings.mergeCheckHint); shows(RunSettings.automaticOnChecked)
    }

    @Test fun atMostIsBoundedWhereTheDoorBoundsIt() {
        card(request(), asked = true, maxConcurrent = StartProjectCopy.maxConcurrentTasks)
        compose.onNodeWithTag("$tag-at-most-plus").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("$tag-at-most-minus").assertIsEnabled().performClick()
        compose.onNodeWithTag("$tag-at-most").assertTextEquals("99 tasks at a time")
        card(request(), asked = true, maxConcurrent = 1)
        compose.onNodeWithTag("$tag-at-most-minus").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("$tag-at-most").assertTextEquals("1 task at a time")
    }

    @Test fun theOwnersOwnCardQuotesNobodyAndSaysWhenItOpensACoordinator() {
        card(StartProjectCopy.ownerRequest(StartProjectCopy.Settings("PROJECT_BRANCH", null, true, 2, null), seal), asked = false, hasCoordinator = false)
        shows(StartProjectCopy.nobodyAskedLine(hasCoordinator = false))
        shows(StartProjectCopy.opensCoordinator)
        shows(StartProjectCopy.howItRunsNote(asked = false, suggestedOff = false))
        shows("Opens a coordinator · starts A now · confirms these 2 criteria")
        compose.onNodeWithText(StartProjectCopy.coordinator).assertDoesNotExist()
        compose.onNodeWithText(CardVerb.CHAT.label).assertDoesNotExist()
        // With Automatic off nothing is opened, and the seal is back in the caption.
        compose.onNodeWithTag("$tag-automatic").performScrollTo().performClick()
        compose.onNodeWithText(StartProjectCopy.opensCoordinator).assertDoesNotExist()
        shows("Starts A now · confirms these 2 criteria · seal c2b4e16c4b59")
        card(StartProjectCopy.ownerRequest(StartProjectCopy.Settings("MAIN", null, true, 1, null), seal), asked = false, hasCoordinator = true)
        shows(StartProjectCopy.nobodyAsked)
        compose.onNodeWithText(StartProjectCopy.opensCoordinator).assertDoesNotExist()
    }

    @Test fun aRequestThatNoLongerStandsIsDimmedWithStartDeadAndSaysWhy() {
        card(request(), asked = true, standing = StartProjectCopy.Standing.GONE)
        shows(StartProjectCopy.requestGone)
        compose.onNodeWithTag("$tag-confirm").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithTag("$tag-automatic").assertIsNotEnabled()
        card(request(), asked = true, standing = StartProjectCopy.Standing.UNREAD)
        shows(StartProjectCopy.unreadSeal)
        compose.onNodeWithTag("$tag-confirm").performScrollTo().assertIsNotEnabled()
        card(request(), asked = true)
        compose.onNodeWithTag("$tag-stale").assertDoesNotExist()
        compose.onNodeWithTag("$tag-confirm").performScrollTo().assertIsEnabled()
    }

    /** The conversation's card: drawn from the open request the session read carries, and pressed through the card actions
     * with the draft the owner left — Automatic on, the request's branch — under the tags the card actions are found by. */
    @Test fun theCoordinatorsCardInItsConversationPressesStartWithTheDraft() {
        val row = j("""{"itemId":"item-1","kind":"START_REQUEST","title":"Start this project?","assignee":"OWNER","waitingSince":"2026-09-29T08:24:00.000Z",
            "actions":[],"startRequest":{"settings":{"line":"PROJECT_BRANCH","projectBranchName":"refs/heads/project/p1","automatic":false,"maxConcurrentTasks":3,
            "mergeCheckCommand":null},"why":"B and C build on A","criteriaDigest":"$seal","planDigest":"pp","repository":null,"warnings":[]}}""")
        val reads = mapOf<String, JsonElement>("project" to j("""{"id":"$project","title":"Aurora","startedAt":null,"exceptionEscalationSeconds":1800,
            "acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"Done."}]}"""), "openItems" to j("""{"needsYou":[],"withCoordinator":[],"startRequest":$row}"""),
            "acceptanceConfirmation" to j("""{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"$seal","material":[]}}"""))
        val card = CardCatalog.project("s1", project, reads).single { it.family == CardFamily.START }
        val sent = mutableListOf<Pair<CardVerb, CardInput>>()
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                CoordinatorStartCard(card, reads, fresh = true, result = CardActionState(), open = {}, discuss = {}) { verb, input -> sent += verb to input }
            }
        } } }
        compose.waitForIdle()
        compose.onNodeWithTag("start:item-1").assertExists()
        shows("Aurora"); shows(StartProjectCopy.howItRunsNote(asked = true, suggestedOff = true)); shows("Problems it can’t resolve within 30 min")
        shows(CardVerb.CHAT.label)
        compose.onNodeWithTag("start:item-1:START").performScrollTo().assertIsEnabled().performClick()
        assertEquals(listOf(CardVerb.START to ProjectStartSettings("PROJECT_BRANCH", true, 3, "", "refs/heads/project/p1")), sent.map { it.first to it.second.settings })
        // A refusal stays on the card in the door's words.
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                CoordinatorStartCard(card, reads, fresh = true, result = CardActionState(message = "This card changed, expired, or was handled elsewhere."),
                    open = {}, discuss = {}) { _, _ -> }
            }
        } } }
        compose.waitForIdle()
        shows("${StartProjectCopy.notRecorded} — This card changed, expired, or was handled elsewhere.")
        // Once the request is gone from the read, the card stays and says why.
        val gone = reads + ("openItems" to j("""{"needsYou":[],"withCoordinator":[]}"""))
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                CoordinatorStartCard(card.copy(actions = emptyList()), gone, fresh = true, result = CardActionState(), open = {}, discuss = {}) { _, _ -> }
            }
        } } }
        compose.waitForIdle()
        shows(StartProjectCopy.requestGone)
        compose.onNodeWithTag("start:item-1:START").performScrollTo().assertIsNotEnabled()
    }
}
