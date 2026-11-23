package io.orbitd.android.directory

import io.orbitd.android.composer.CloneHeard
import io.orbitd.android.composer.CloneState
import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A session held by its GitHub workspace's clone: the waiting card's logic, the row's line and the failed sentence, web's words. */
class QueuedCloneTest {
    private fun row(reason: String?) = DirectorySession(id = "S1", status = "PENDING", runState = "QUEUED", queuedReason = reason)
    private fun workspace(state: String?, url: String? = "https://github.com/acme/widgets.git") = JsonObject(buildMap {
        put("id", JsonPrimitive("W1"))
        url?.let { put("repoUrl", JsonPrimitive(it)) }
        state?.let { put("cloneState", JsonPrimitive(it)) }
    })

    @Test fun pendingSaysWaitingToCloneAndCloningSaysCloning() {
        assertEquals("Waiting to clone acme/widgets", QueuedClone.waitTitle(CloneState.PENDING, "acme/widgets"))
        assertEquals("Cloning acme/widgets", QueuedClone.waitTitle(CloneState.CLONING, "acme/widgets"))
        val pending = QueuedClone.wait(workspace("PENDING"), null)!!
        assertEquals(QueuedClone.Wait(CloneState.PENDING, null, "acme/widgets"), pending)
    }

    @Test fun thePercentageComesFromTheStreamWhenItAgreesWithTheDetail() {
        val clone = QueuedClone.wait(workspace("CLONING"), CloneHeard(CloneState.CLONING, 42, atMs = 10), storedAtMs = 5)!!
        assertEquals(QueuedClone.Wait(CloneState.CLONING, 42, "acme/widgets"), clone)
        // A detail read after a frame that disagrees with it wins, and carries no percentage.
        assertEquals(QueuedClone.Wait(CloneState.PENDING, null, "acme/widgets"),
            QueuedClone.wait(workspace("PENDING"), CloneHeard(CloneState.CLONING, 42, atMs = 1), storedAtMs = 5))
    }

    @Test fun noCardForAnythingButAGithubCloneUnderWay() {
        assertNull(QueuedClone.wait(workspace("READY"), null))
        assertNull(QueuedClone.wait(workspace("FAILED"), null))
        assertNull(QueuedClone.wait(workspace(null), null))
        assertNull(QueuedClone.wait(workspace("CLONING", url = "https://gitlab.com/acme/widgets.git"), null))
        assertNull(QueuedClone.wait(null, null))
    }

    @Test fun theSentenceUnderTheTitle() {
        assertEquals("This session starts when the clone is done.", QueuedClone.STARTS)
        assertEquals("On Studio Mac. ${QueuedClone.STARTS}", "On Studio Mac. ${QueuedClone.STARTS}")
    }

    @Test fun theRowSaysCloningWithThePercentOnceHeardAndWaitingBefore() {
        assertEquals("Cloning · 42%", SessionLine.make(row("WORKSPACE_CLONING"), live = true, cloneProgress = 42).text)
        assertEquals("Waiting for the clone", SessionLine.make(row("WORKSPACE_CLONING"), live = true).text)
        assertEquals("Waiting for the clone", SessionHeader.statusWord(row("WORKSPACE_CLONING")))
        assertEquals(SessionLine.Tone.QUEUED, SessionLine.make(row("WORKSPACE_CLONING"), live = true, cloneProgress = 3).tone)
        assertEquals("Clone failed", SessionLine.make(row("WORKSPACE_CLONE_FAILED"), live = true).text)
        assertFalse(QueuedClone.isHeld(row("runner_updating").queuedGate))
        assertTrue(QueuedClone.isHeld(row("WORKSPACE_CLONE_FAILED").queuedGate))
    }

    @Test fun theFailedSentenceNoLongerPointsAtTheFirstLine() {
        assertEquals("This session starts once the repository is cloned.", QueuedClone.FAILED_WAIT)
        assertFalse(QueuedClone.FAILED_WAIT.contains("first line"))
    }

    /** The words are web `runnerSlots.ts`'s. */
    @Test fun theWordsAreTheWebs() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/lib/runnerSlots.ts").isFile }
        val copy = File(root, "src/web/src/lib/runnerSlots.ts").readText()
        assertTrue(copy.contains("export const CLONE_WAIT_TITLE = '${QueuedClone.TITLE}';"))
        assertTrue(copy.contains("export const CLONE_FAILED_TITLE = '${QueuedClone.FAILED_TITLE}';"))
        assertTrue(copy.contains("export const CLONE_FAILED_WAIT = '${QueuedClone.FAILED_WAIT}';"))
        assertTrue(copy.contains("export const CLONE_WAIT_STARTS = '${QueuedClone.STARTS}';"))
        assertTrue(copy.contains("`\${state === 'CLONING' ? 'Cloning' : 'Waiting to clone'} \${repository}`"))
        assertTrue(copy.contains("`Cloning · \${progress}%`"))
    }
}
