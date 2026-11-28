package io.orbitd.android.reader

import io.orbitd.android.core.cards.PullRequestTone
import io.orbitd.android.toast.ToastTone
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * docs/design/protected-branch-landing.md §4.6, §11.2: GitHub refused the push to main, so the runner opened a pull request and the
 * merge waits on it. The merge slot and its notice name the pull request; neither reads as a failure. OrbitKit's
 * MergePullRequestLineTests, case for case.
 */
class MergePullRequestLineTest {
    private val open = Json.parseToJsonElement(
        """{"number":214,"url":"https://github.com/o/r/pull/214","state":"OPEN","condition":null,""" +
            """"checks":{"passed":2,"required":6,"failed":[]},"mergeMethod":null,"mergedSha":null,""" +
            """"refusal":{"via":"PULL_REQUEST","message":"Changes must be made through a pull request."}}""",
    ).jsonObject

    @Test fun openPullRequestNamesItsStateAndLinks() {
        val line = WorktreeBarLogic.mergePullRequestLine(open, "main")
        assertEquals("Pull request open #214 · 2 of 6", line.label)
        assertEquals("https://github.com/o/r/pull/214", line.url)
        assertEquals("main requires a pull request. Waiting for the required checks.", line.detail)
        assertEquals(PullRequestTone.BLUE, line.tone)
    }

    @Test fun beforeTheServerReadThePullRequest() {
        val line = WorktreeBarLogic.mergePullRequestLine(null, "main")
        assertEquals("Pull request open", line.label)
        assertNull(line.url)
        assertEquals("main requires a pull request. Orbit merges it once the branch's rules pass.", line.detail)
    }

    @Test fun theMergeResultSaysThePullRequestWasOpened() {
        val detail = buildJsonObject {
            put("mergeStatus", "pull_request"); put("mergeTarget", "main"); put("mergePullRequest", open)
        }
        val notice = WorktreeModel.resultNotice("merge", detail)!!
        assertEquals("Opened pull request #214 into main", notice.message)
        assertEquals("main requires a pull request. Waiting for the required checks.", notice.detail)
        assertEquals(ToastTone.NEUTRAL, notice.tone)
        val bare = WorktreeModel.resultNotice("merge", buildJsonObject { put("mergeStatus", "pull_request") })!!
        assertEquals("Opened a pull request into main", bare.message)
    }
}
