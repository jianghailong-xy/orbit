package io.orbitd.android.core.cards

import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The pull request states and the workspace setting, from the read models the web captured from a real apiserver
 * (`src/web/src/lib/landingBoardServerViews.json`); no payload here is hand-written. */
class LandingPullRequestTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .firstOrNull { File(it, "src/web/src/lib/landingBoardServerViews.json").isFile } ?: error("Missing the captured read models")
    private val views = Json.parseToJsonElement(File(root, "src/web/src/lib/landingBoardServerViews.json").readText()).jsonObject
    private fun pr(key: String) = views.obj("landing")!!.obj(key)!!.obj("pullRequest")!!
    private fun card(key: String) = LandingPullRequest.card(pr(key), "main")

    @Test fun openedWithChecksRunning() {
        val m = card("a")
        assertEquals(listOf(PullRequestStage.OPENED, "Pull request open", "2 of 6"), listOf(m.stage, m.head, m.right))
        assertEquals("main requires a pull request. Waiting for the required checks.", m.detail)
        assertEquals(List(2) { PullRequestSegment.PASSED } + List(4) { PullRequestSegment.PENDING }, m.segments)
    }

    @Test fun waitingForReview() {
        val m = card("b")
        assertEquals(listOf(PullRequestStage.WAITING_FOR_REVIEW, "Waiting for review", "6 of 6 ✓"), listOf(m.stage, m.head, m.right))
        assertEquals(listOf("Review on GitHub ↗"), m.actions.map { it.label })
    }

    @Test fun aReviewWaitReadBeforeAnyRequiredCheckWasReportedCountsNothing() {
        val unread = JsonObject(pr("b") + ("checks" to Json.parseToJsonElement("""{"passed":0,"required":0,"failed":[]}""")))
        val card = LandingPullRequest.card(unread, "main")
        assertNull(card.right)
        assertEquals("main requires an approving review.", card.detail)
    }

    @Test fun aRequiredCheckFailed() {
        val m = card("c")
        assertEquals("Check failed: PostgreSQL specs", m.head)
        assertEquals(PullRequestSegment.FAILED, m.segments.last())
        assertEquals(listOf("View log ↗", "View on GitHub ↗"), m.actions.map { it.label })
    }

    @Test fun mainMoved() = assertEquals("Catching up with main", card("d").head)

    @Test fun merged() {
        val m = card("e")
        assertTrue(m.head, Regex("^Landed by pull request #\\d+$").matches(m.head))
        assertTrue(m.detail, Regex("^Merged into main · [0-9a-f]{7}$").matches(m.detail))
        assertEquals(PullRequestTone.GREEN, m.tone)
    }

    @Test fun pushRefusedFellBackToAPullRequest() {
        val m = card("f")
        assertEquals(listOf("Opened a pull request instead", "Push refused"), listOf(m.head, m.right))
        assertTrue(m.detail.contains("Changes must be made through a pull request."))
        assertEquals(PullRequestWords.SETTINGS, m.actions.last().label)
        assertNull(m.actions.last().href)
    }

    @Test fun closedOnGitHub() = assertEquals("Pull request closed", card("closed").head)

    @Test fun theTipShowsOnlyWhileWaitingForReviewAndNotOnPushAsMe() {
        assertTrue(LandingPullRequest.showsTip(card("b"), "PULL_REQUEST", hidden = false))
        assertTrue(LandingPullRequest.showsTip(card("b"), null, hidden = false))
        assertFalse(LandingPullRequest.showsTip(card("b"), "PUSH_AS_ME", hidden = false))
        assertFalse(LandingPullRequest.showsTip(card("b"), "PULL_REQUEST", hidden = true))
        for (key in listOf("a", "c", "d", "e", "f", "closed")) assertFalse(key, LandingPullRequest.showsTip(card(key), null, hidden = false))
    }

    @Test fun everyLandingCardCarriesTheBlock() {
        for (key in listOf("a", "b", "d", "f")) {
            val inFlight = views.obj("integration")!!.obj(key)!!.obj("inFlight")!!
            assertEquals(key, pr(key).number("number"), LandingPullRequest.of(inFlight)?.number("number"))
        }
    }

    @Test fun repoSlug() {
        assertEquals("owner/repo", WorkspaceLandingWords.repoSlug("https://github.com/owner/repo.git"))
        assertEquals("owner/repo", WorkspaceLandingWords.repoSlug("git@github.com:owner/repo"))
        assertNull(WorkspaceLandingWords.repoSlug(null))
    }

    @Test fun wordsMatchTheWeb() {
        fun literals(path: String, block: String): Map<String, String> {
            val text = File(root, path).readText()
            val body = text.substringAfter("export const $block = {").substringBefore("} as const;")
            return Regex("""(\w+):\s*(?:\n\s*)?(["'])(.*?)\2,""", RegexOption.DOT_MATCHES_ALL).findAll(body)
                .associate { it.groupValues[1] to it.groupValues[3].replace("\\'", "'") }
        }
        val setting = literals("src/web/src/components/settings/WorkspaceLandingSetting.tsx", "LANDING_WORDS")
        val tip = literals("src/web/src/components/LandingPullRequest.tsx", "PULL_REQUEST_WORDS")
        assertEquals(WorkspaceLandingWords.SECTION, setting["SECTION"])
        assertEquals(WorkspaceLandingWords.LEAD, setting["LEAD"])
        assertEquals(WorkspaceLandingWords.PULL_REQUEST, setting["PULL_REQUEST"])
        assertEquals(WorkspaceLandingWords.PULL_REQUEST_BODY, setting["PULL_REQUEST_BODY"])
        assertEquals(WorkspaceLandingWords.PUSH_AS_ME, setting["PUSH_AS_ME"])
        assertEquals(WorkspaceLandingWords.PUSH_AS_ME_BODY, setting["PUSH_AS_ME_BODY"])
        assertEquals(WorkspaceLandingWords.NOT_CONNECTED, setting["NOT_CONNECTED"])
        assertEquals(WorkspaceLandingWords.CONNECT, setting["CONNECT"])
        assertEquals(WorkspaceLandingWords.NOT_GITHUB, setting["NOT_GITHUB"])
        assertEquals(WorkspaceLandingWords.REFUSED, setting["REFUSED"])
        assertEquals(WorkspaceLandingWords.CONNECT_AGAIN, setting["CONNECT_AGAIN"])
        assertEquals(WorkspaceLandingWords.REVIEW, setting["REVIEW"])
        assertEquals(PullRequestWords.VIEW, tip["VIEW"]); assertEquals(PullRequestWords.REVIEW, tip["REVIEW"])
        assertEquals(PullRequestWords.LOG, tip["LOG"]); assertEquals(PullRequestWords.SETTINGS, tip["SETTINGS"])
        assertEquals(PullRequestWords.TIP, tip["TIP"]); assertEquals(PullRequestWords.TIP_LINK, tip["TIP_LINK"])
        assertEquals(PullRequestWords.DISMISS, tip["DISMISS"])
        assertTrue(File(root, "src/web/src/lib/landingSession.ts").readText().contains("WAITING_FOR_GITHUB: '${PullRequestWords.WAITING_FOR_GITHUB}'"))
    }

    @Test fun theNoticesReadTheServersFacts() {
        val landing = views.obj("workspaceLanding")!!
        val pending = landing.obj("permissionsPending")!!.obj("permissionsPending")!!
        assertEquals("Landing through pull requests starts once owner accepts Orbit's updated GitHub permissions.",
            WorkspaceLandingWords.permissionsText(pending.text("account")!!))
        val refusal = landing.obj("refused")!!.obj("lastRefusal")!!
        assertTrue(WorkspaceLandingWords.refusalText(refusal.text("branch")!!, "owner/repo", refusal.text("message")!!)
            .startsWith("GitHub refused your last push to main on owner/repo: “GH006"))
    }
}
