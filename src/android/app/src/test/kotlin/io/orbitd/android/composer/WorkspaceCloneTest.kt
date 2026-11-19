package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.ControlEvent
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** A GitHub workspace's clone: the cases of web's `lib/workspaceClone.test.ts` and OrbitKit's `WorkspaceCloneTests`. */
class WorkspaceCloneTest {
    private fun json(raw: String): JsonObject = Wire.json.parseToJsonElement(raw).jsonObject

    private val uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
    private val public = ObjectId.toPublic(uuid)

    @Test fun aRelaysCloneIsReadWithItsPercentageHeldWhole() {
        assertEquals(CloneHeard(CloneState.CLONING, 42), WorkspaceClone.cloneOf(json("""{"state":"CLONING","progress":41.6}""")))
        assertEquals(CloneHeard(CloneState.CLONING, 100), WorkspaceClone.cloneOf(json("""{"state":"CLONING","progress":130}""")))
        assertEquals(CloneHeard(CloneState.CLONING, 0), WorkspaceClone.cloneOf(json("""{"state":"CLONING","progress":-3}""")))
        assertEquals(CloneHeard(CloneState.PENDING, null), WorkspaceClone.cloneOf(json("""{"state":"PENDING","progress":null}""")))
        assertEquals(CloneHeard(CloneState.READY, null), WorkspaceClone.cloneOf(json("""{"state":"READY","progress":"50"}""")))
        assertNull(WorkspaceClone.cloneOf(json("""{"state":"DONE"}""")))
        assertNull(WorkspaceClone.cloneOf(json("""{"progress":5}""")))
        assertNull(WorkspaceClone.cloneOf(null))
    }

    /** P2 shipped this once: the server's `agent.changed` names the workspace `agentId`, not `id`. */
    @Test fun theServersAgentChangedFrameIsReadByItsAgentId() {
        // Exactly what realtime.service.ts writes for a user-scoped agent.changed with a clone.
        val frame = Wire.decode(
            """{"type":"agent.changed","sessionId":"","agentId":null,"ts":"2026-11-16T12:00:00Z",
               "data":{"agentId":"$public","affectsTaskRows":false,"clone":{"state":"CLONING","progress":42}}}""".encodeToByteArray(),
            ControlEvent.serializer(),
        )
        assertEquals(public to CloneHeard(CloneState.CLONING, 42), WorkspaceClone.event(frame.type, frame.data, frame.agentId))
        // A frame that says `id` is read too; `agentId` wins over it.
        assertEquals("w-id", WorkspaceClone.event("agent.changed", json("""{"id":"w-id","clone":{"state":"READY"}}"""))?.first)
        assertEquals("w-agent", WorkspaceClone.event("agent.changed",
            json("""{"agentId":"w-agent","id":"w-id","clone":{"state":"READY"}}"""))?.first)
        assertEquals("w-id", WorkspaceClone.event("agent.changed", json("""{"agentId":"","id":"w-id","clone":{"state":"READY"}}"""))?.first)
        // The envelope's agentId last.
        assertEquals("env", WorkspaceClone.event("agent.changed", json("""{"clone":{"state":"FAILED"}}"""), "env")?.first)
        assertEquals("w", WorkspaceClone.event("workspace.changed", json("""{"id":"w","clone":{"state":"READY"}}"""))?.first)
        // No clone, or another type: nothing.
        assertNull(WorkspaceClone.event("agent.changed", json("""{"agentId":"w","repoHealth":true}""")))
        assertNull(WorkspaceClone.event("session.updated", json("""{"agentId":"w","clone":{"state":"READY"}}""")))
        assertNull(WorkspaceClone.event("agent.changed", json("""{"clone":{"state":"READY"}}""")))
    }

    @Test fun workspaceIdsAreComparedInOneSpelling() {
        assertTrue(WorkspaceClone.sameWorkspace(uuid, public))
        assertTrue(WorkspaceClone.sameWorkspace(uuid.uppercase(), uuid))
        assertFalse(WorkspaceClone.sameWorkspace(uuid, null))
        assertFalse(WorkspaceClone.sameWorkspace("", ""))
        val ledger = CloneLedger()
        ledger.hear(public, CloneHeard(CloneState.CLONING, 10), atMs = 1)
        assertEquals(CloneHeard(CloneState.CLONING, 10, 1), ledger.heard(uuid))
    }

    @Test fun theLedgerSaysWhenTheStateMovedAndKeepsThePercentageOfTheSameState() {
        val ledger = CloneLedger()
        assertTrue(ledger.hear("w", CloneHeard(CloneState.PENDING), atMs = 1))
        assertTrue(ledger.hear("w", CloneHeard(CloneState.CLONING, 10), atMs = 2))
        assertFalse("a percentage alone is no move", ledger.hear("w", CloneHeard(CloneState.CLONING, 42), atMs = 3))
        assertFalse(ledger.hear("w", CloneHeard(CloneState.CLONING, null), atMs = 4))
        assertEquals(CloneHeard(CloneState.CLONING, 42, 4), ledger.heard("w"))
        assertTrue(ledger.hear("w", CloneHeard(CloneState.READY), atMs = 5))
        assertEquals(CloneHeard(CloneState.READY, null, 5), ledger.heard("w"))
        ledger.clear()
        assertNull(ledger.heard("w"))
    }

    @Test fun aFrameRereadsTheOpenConversationOnlyWhenItsWorkspacesStateMoved() {
        val ledger = CloneLedger()
        val clone = json("""{"agentId":"$public","clone":{"state":"CLONING","progress":5}}""")
        assertTrue(ledger.hearFrame("agent.changed", clone, null, openWorkspaceId = uuid))
        assertFalse("percentage only", ledger.hearFrame("agent.changed",
            json("""{"agentId":"$public","clone":{"state":"CLONING","progress":50}}"""), null, uuid))
        assertFalse("another workspace's conversation is open", ledger.hearFrame("agent.changed",
            json("""{"agentId":"$public","clone":{"state":"READY"}}"""), null, "other"))
        assertEquals(CloneState.READY, ledger.heard(uuid)?.state)
        assertFalse(ledger.hearFrame("session.updated", clone, null, uuid))
    }

    @Test fun cloneNowWeighsTheStoredStateAgainstTheStream() {
        // Nothing stored: the stream.
        assertEquals(CloneHeard(CloneState.CLONING, 4), WorkspaceClone.now(null, CloneHeard(CloneState.CLONING, 4)))
        assertNull(WorkspaceClone.now(null, null))
        // Nothing heard: the store.
        assertEquals(CloneHeard(CloneState.PENDING), WorkspaceClone.now("PENDING", null))
        // Agreeing: the stream adds the percentage.
        assertEquals(CloneHeard(CloneState.CLONING, 42, 5), WorkspaceClone.now("CLONING", CloneHeard(CloneState.CLONING, 42, 5), 10))
        // Disagreeing: the newer one.
        assertEquals(CloneState.FAILED, WorkspaceClone.now("CLONING", CloneHeard(CloneState.FAILED, null, 20), 10)?.state)
        assertEquals(CloneState.CLONING, WorkspaceClone.now("CLONING", CloneHeard(CloneState.FAILED, null, 5), 10)?.state)
        assertEquals("a tie goes to the read", CloneState.CLONING, WorkspaceClone.now("CLONING", CloneHeard(CloneState.FAILED, null, 10), 10)?.state)
        assertEquals("a Retry's PENDING beats the FAILED read before it",
            CloneState.PENDING, WorkspaceClone.now("FAILED", CloneHeard(CloneState.PENDING, null, 20), 10)?.state)
        assertEquals("no read time: the stream", CloneState.FAILED, WorkspaceClone.now("CLONING", CloneHeard(CloneState.FAILED, null, 1))?.state)
        // A stored READY always wins.
        assertEquals(CloneHeard(CloneState.READY), WorkspaceClone.now("READY", CloneHeard(CloneState.CLONING, 90, 99), 1))
        assertEquals(CloneHeard(CloneState.CLONING, 3), WorkspaceClone.now("NONSENSE", CloneHeard(CloneState.CLONING, 3)))
    }

    @Test fun failuresAreReadByPattern() {
        assertEquals(CloneFailure.APP_REMOVED, WorkspaceClone.failureOf("Orbit's GitHub App is no longer installed on o/r. Install it again."))
        assertEquals(CloneFailure.SIGN_IN_EXPIRED, WorkspaceClone.failureOf("Your GitHub sign-in expired: connect GitHub in Settings."))
        assertEquals(CloneFailure.FOLDER_TAKEN, WorkspaceClone.failureOf("/Users/a/orbit-repos/x already exists on mac"))
        assertEquals(CloneFailure.OTHER, WorkspaceClone.failureOf("fatal: repository not found"))
        assertEquals(CloneFailure.OTHER, WorkspaceClone.failureOf(null))
    }

    @Test fun aReasonEndsWithOneFullStop() {
        assertEquals("git said no.", WorkspaceClone.reason("  git said no  "))
        assertEquals("git said no.", WorkspaceClone.reason("git said no."))
        assertEquals("", WorkspaceClone.reason("   "))
        assertEquals("", WorkspaceClone.reason(null))
        assertEquals("Couldn’t clone o/r: git said no.", MachineSetupCopy.cloneCouldNot("o/r", WorkspaceClone.reason("git said no")))
        assertEquals("Couldn’t clone o/r.", MachineSetupCopy.cloneCouldNot("o/r", WorkspaceClone.reason(null)))
    }

    @Test fun aGithubRepositoryIsReadOffItsUrl() {
        assertEquals("orbit-labs/orbit-web", WorkspaceClone.repositoryOf("https://github.com/orbit-labs/orbit-web.git"))
        assertEquals("orbit-labs/orbit-web", WorkspaceClone.repositoryOf("https://github.com/orbit-labs/orbit-web"))
        assertEquals("orbit-labs/orbit-web", WorkspaceClone.repositoryOf("https://github.com/orbit-labs/orbit-web/"))
        assertNull(WorkspaceClone.repositoryOf("https://gitlab.com/o/r.git"))
        assertNull(WorkspaceClone.repositoryOf("git@github.com:o/r.git"))
        assertNull(WorkspaceClone.repositoryOf(null))
    }

    @Test fun theWorkspaceOfADetailIsTheOneItMade() {
        assertEquals("w1", WorkspaceClone.workspaceOf(json("""{"agent":{"id":"w1"},"agentId":"w2"}""")))
        assertEquals("w2", WorkspaceClone.workspaceOf(json("""{"agentId":"w2"}""")))
        assertNull(WorkspaceClone.workspaceOf(null))
    }
}
