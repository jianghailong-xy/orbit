package io.orbitd.android.projects

import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.core.cards.PromotionCards
import io.orbitd.android.core.cards.text
import io.orbitd.android.directory.SessionProjectCopy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The main branch's words are the browser's (project 34cjQN5ynG6eIH5A0neeu: "behaviour and sentences follow the web"), held to the
 * web source the same way StartProjectCardCopyTest holds the card to the Swift: every new word is declared there with the same
 * literal, and every sentence that names the branch — rendered here with sentinels, which are put back as the web's own
 * interpolations — is one literal there, so the words either side of the branch are held too. They are held to the web rather
 * than the Swift because the iOS half of the project lands on its own schedule; the Swift parity tests hold the iOS words to the
 * same web lines. The order a start opens with, what a press and a pick send, and which names the picker offers are held to the
 * web's code line for line. A missing counterpart is a failure, never a skip. */
class MainBranchCopyTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/projectStart.ts").isFile }
    /** A web source with `'a ' + 'b'` (and the template halves of one sentence) put back together. */
    private fun web(path: String) = File(root, "src/web/src/$path").readText().replace(Regex("""['`]\s*\+\s*['`]"""), "")
    private val start = web("lib/projectStart.ts")

    /** A sentinel no sentence contains. */
    private val b = "§1"
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    private fun assertDeclares(source: String, name: String, value: String) =
        assertTrue("$name drifted: the web no longer declares it as '$value'", source.contains("export const $name = '$value';"))

    /** [rendered] with each sentinel put back as the web's interpolation is one string or template literal of [source]. */
    private fun assertTemplate(source: String, rendered: String, vararg values: Pair<String, String>) {
        val template = values.fold(rendered) { text, (from, to) -> text.replace(from, to) }
        assertTrue("the web no longer says `$template`", Regex("[`']" + Regex.escape(template) + "[`']").containsMatchIn(source))
    }

    @Test fun theNewWordsAreTheWebsDeclarations() {
        assertDeclares(start, "DEFAULT_MAIN_BRANCH", RunSettings.defaultMainBranch)
        assertDeclares(start, "RUN_MAIN_BRANCH", RunSettings.mainBranch)
        assertDeclares(start, "RUN_MAIN_BRANCH_HINT", RunSettings.mainBranchHint)
        assertDeclares(start, "RUN_LAST_CHOSEN", RunSettings.lastChosen)
        assertDeclares(start, "RUN_TYPE_A_BRANCH", RunSettings.typeABranch)
        assertTemplate(start, RunSettings.lastChoiceFor(b), b to "\${repository}")
        assertTemplate(start, RunSettings.mainBranchRemembers(b), b to "\${repository}")
        assertTemplate(start, RunSettings.branchesIn(b), b to "\${workspace}")
        assertTemplate(start, RunSettings.useBranch(b), b to "\${name}")
        assertTemplate(start, RunSettings.mainBranchRef(b), b to "\${name}")
        assertTemplate(start, RunSettings.mainBranchLocked(b, "§2"), " $b" to "\${since ? ` \${since}` : ''}", "§2" to "\${main}")
    }

    /** The start card's and How it runs' sentences that name the branch, each beside the constant the Swift parity tests read. */
    @Test fun theSettingsSentencesAreTheWebsFunctionsOfTheBranch() {
        val main = "\${main}"
        assertTemplate(start, RunSettings.lineMain(b), b to main)
        assertTemplate(start, RunSettings.lineMainHint(b), b to main)
        assertTemplate(start, RunSettings.mergeCheckHint(b), b to main)
        assertTemplate(start, RunSettings.noMergeCheckWarning(b), b to main)
        assertTemplate(start, RunSettings.pauseHint(b), b to main)
        assertTemplate(start, RunSettings.automaticHint("PROJECT_BRANCH", b), b to main)
        assertTemplate(start, RunSettings.automaticHint("MAIN", b), b to main)
        for (automatic in listOf(true, false)) for (line in listOf("MAIN", "PROJECT_BRANCH")) for (checked in listOf(true, false)) {
            assertTemplate(start, RunSettings.automaticSays(automatic, line, checked, b), b to main)
        }
        assertTemplate(start, StartProjectCopy.mergingInto(b), b to main)
        assertTemplate(start, StartProjectCopy.eachMergeInto(b), b to main)
        assertTrue(start.contains("return line === 'MAIN' ? `directly into \${main}` : 'a project branch';"))
        assertEquals("directly into $b", RunSettings.lineInSentence("MAIN", b))
        assertEquals("a project branch", RunSettings.lineInSentence("PROJECT_BRANCH", b))
        // The request's row says the line the way the browser's does, directly into the branch the card opens with.
        assertTrue(start.contains("runLineInSentence(settings.line, main),"))
        assertTrue(web("components/ProjectProgressStatus.tsx").contains("startRequestSummary(settings, startMainBranch(settings.upstreamRef, standing))"))
        assertTrue(web("components/ProjectIntegrationLine.tsx").contains("runLineInSentence(suggested, startMainBranch(suggestion?.upstreamRef, view))"))
    }

    /** The order a start opens with, what a press sends and what How it runs writes: the web's code, line for line. */
    @Test fun theOrderAndTheWritesAreTheWebsCode() {
        listOf("(standing?.upstreamChosenAt ? standing.upstreamRef : null)", "?? standing?.lastMainBranch?.branch", "?? suggested,",
            "return ref ? ref.replace(/^refs\\/heads\\//u, '') : DEFAULT_MAIN_BRANCH;").forEach {
            assertTrue("projectStart.ts no longer says $it", start.contains(it))
        }
        val card = web("components/StartProjectCard.tsx")
        listOf("upstream: standing?.repository ? startMainBranch(settings.upstreamRef, standing) : null,",
            "...(draft.upstream ? { upstreamRef: mainBranchRef(draft.upstream) } : {}),",
            "...(view.upstreamRef ? { upstreamRef: mainBranchRef(view.upstreamRef) } : {}),",
            "{lastMainBranch && draft.upstream === lastMainBranch.branch ? (").forEach {
            assertTrue("StartProjectCard.tsx no longer says $it", card.contains(it))
        }
        val settings = web("components/ProjectRunSettings.tsx")
        listOf("return view.repository ? mainBranchName(view.upstreamRef ?? view.lastMainBranch?.branch) : null;",
            "...(!view.locked && draft.upstream !== null && draft.upstream !== storedUpstream(view)",
            "? { upstreamRef: mainBranchRef(draft.upstream) }",
            "? runMainBranchLocked(view.startedAt ? ago(view.startedAt, now) : null, main)",
            ": `\${RUN_MAIN_BRANCH_HINT} \${runMainBranchRemembers(repository)}`}",
            "{view.locked && repository === null ? (").forEach {
            assertTrue("ProjectRunSettings.tsx no longer says $it", settings.contains(it))
        }
    }

    /** The picker offers what the web's does: the reported branches, the last choice and the value, in that order and once each;
     * a typed name only when it looks like a branch — by the same rule. */
    @Test fun thePickerIsTheWebsMainBranchSelect() {
        val select = web("components/MainBranchSelect.tsx")
        listOf("const BRANCH_NAME = /^(?![-/])(?!.*\\.\\.)(?!.*\\/$)(?!.*\\.lock$)[^\\s~^:?*[\\\\]+$/u;",
            "const names = [...new Set([...(branches?.names ?? []), ...(remembered ? [remembered] : []), value])];",
            "...(typed && !names.includes(typed) && BRANCH_NAME.test(typed)",
            "{branches ? runBranchesIn(branches.workspaceName) : RUN_TYPE_A_BRANCH}",
            "{option.value === remembered ? <span className=\"main-branch-tag\">{RUN_LAST_CHOSEN}</span> : null}",
            "footer={<div className=\"main-branch-menu-foot\">{RUN_MAIN_BRANCH_HINT}</div>}").forEach {
            assertTrue("MainBranchSelect.tsx no longer says $it", select.contains(it))
        }
    }

    /** The rest of the project page, where the web names the branch: the overview's lanes, the landing words, where met criteria
     * landed, Copy as Markdown, the done cards, the merge card and what waits on the owner. */
    @Test fun theProjectPagesOtherSentencesAreTheWebs() {
        val main = "\${main}"
        val lanes = ProjectPage.overviewCells(j("""{"running":0,"ready":0,"blocked":0,"integrating":0,"onIntegrationLine":1,"onUpstream":1}"""),
            2, "PROJECT_BRANCH", true, main = b).associateBy { it.key }
        val panorama = web("components/ProjectPanoramaHeader.tsx")
        assertTemplate(panorama, lanes.getValue("onIntegrationLine").footnote, b to main)
        assertTemplate(panorama, lanes.getValue("onUpstream").label, b to main)
        assertTemplate(panorama, lanes.getValue("onUpstream").footnote, b to main)
        assertTemplate(panorama, ProjectPage.jobWords(b).getValue("LAND_PROMOTION"), b to main)
        assertTemplate(panorama, ProjectPage.phaseWords(b).getValue("MAIN_SYNC"), b to main)
        assertTrue(panorama.contains("LAND_PROMOTION: 'Merge to main',") && panorama.contains("MAIN_SYNC: 'syncing main',"))
        val line = web("components/ProjectIntegrationLine.tsx")
        assertTrue(line.contains("ahead of {main} at last measurement") && line.contains("<span>synced with {main} {ago("))

        val acceptance = web("components/ProjectAcceptanceCard.tsx")
        val landed = j("""{"satisfied":true,"landing":"LANDED","unmet":[]}""")
        val onLine = j("""{"satisfied":true,"landing":"ON_INTEGRATION_LINE","unmet":[]}""")
        assertTemplate(acceptance, ProjectPage.criterionWork(landed, null, b)!!.landing!!, b to main)
        assertTemplate(acceptance, ProjectPage.criterionWork(onLine, null, b)!!.landingWarning!!, b to main)
        val share = web("components/ProjectShareControls.tsx")
        assertTemplate(share, ProjectMarkdown.landingWords(b).getValue("LANDED"), b to main)
        assertTemplate(share, ProjectMarkdown.landingWords(b).getValue("ON_INTEGRATION_LINE"), b to main)

        val done = web("lib/projectDone.ts")
        assertTemplate(done, ProjectDone.on(b), b to main)
        assertTemplate(done, ProjectDone.landedOn(b), b to main)
        assertTemplate(done, ProjectDone.landingReasonLabel(null, b), b to main)
        val gap = ProjectDone.syntheticGaps(j("""{"integration":{"upstreamRef":"$b"},"acceptanceCriteriaItems":[{"id":"c1","key":"k1","ordinal":1,"text":"One."}],
            "derivedDone":{"criteria":[{"definitionId":"c1","satisfied":true,"landingReason":"ON_PROJECT_BRANCH"}]}}""")).single()
        assertTemplate(web("components/ProjectSettlementCard.tsx"), gap.text("whyNotProven")!!, b to main,
            ProjectDone.landingReasonLabel("ON_PROJECT_BRANCH") to "\${reason}")

        val promotion = web("components/ProjectPromotionCard.tsx")
        assertTemplate(promotion, PromotionCards.mergeTo(b), b to main)
        assertTemplate(promotion, PromotionCards.mergedHeading(b), b to main)
        assertTemplate(promotion, PromotionCards.mergedAutomaticallyHeading(b), b to main)
        assertTemplate(promotion, PromotionCards.nowOn(b), b to "\${mainBranchName(promotion.upstreamRef)}")

        assertTrue(web("lib/projectAttention.ts").contains("PROMOTION_APPROVAL: (_item, main) => `Needs you · Approve merge to \${main}`,"))
        assertEquals("Needs you · Approve merge to $b", ProjectAttention.ownerItemSays(buildJsonObject { put("kind", "PROMOTION_APPROVAL") }, b))
        val workspace = web("components/WorkspaceView.tsx")
        assertTrue(workspace.contains("const OWNER_ITEM_APPROVE_MERGE = '${NeedsYouLogic.kindWord("PROMOTION_APPROVAL")}';"))
        assertTrue(workspace.contains("PROMOTION_APPROVAL: `${NeedsYouLogic.kindWord("PROMOTION_APPROVAL", b)!!.replace(b, main)}`"))
    }

    /** The session list's start suggestion: directly into the branch the start opens with, as sessionProjects.ts builds it. */
    @Test fun theSessionListsSuggestionIsTheWebs() {
        val sessions = web("lib/sessionProjects.ts")
        val suggestion = SessionProjectCopy.startSuggestion(buildJsonObject { put("line", "PROJECT_BRANCH"); put("automatic", true); put("maxConcurrentTasks", 23) })
        assertTemplate(sessions, suggestion, "Project branch" to "\${settings.line === 'MAIN' ? runLineMain(main) : 'Project branch'}",
            "Automatic on" to "Automatic \${settings.automatic ? 'on' : 'off'}", "23 at" to "\${settings.maxConcurrentTasks} at")
        assertTrue(sessions.contains("main: string = mainBranchName(settings.upstreamRef),"))
    }
}
