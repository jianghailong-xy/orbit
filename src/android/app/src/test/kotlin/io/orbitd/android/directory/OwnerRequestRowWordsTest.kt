package io.orbitd.android.directory

import androidx.activity.ComponentActivity
import android.content.ComponentName
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertExists
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.directory.SessionLine.Tone
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The row words for a session waiting on its own question (board waiting-on-you-removal ①): an open owner request says its kind, task
 * moves say how many wait, a mix keeps "Waiting for approval" — `@orbit/shared` `ownerRequestRowWord`, word for word — and the row's
 * live mark stays the amber dot.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class OwnerRequestRowWordsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val now = Instant.parse("2026-11-11T10:00:00Z")

    private fun requests(vararg kinds: String) = buildJsonArray {
        kinds.forEachIndexed { i, kind -> addJsonObject { put("ownerRequestId", "r$i"); put("kind", kind); put("title", "Request $i"); put("since", now.toString()) } }
    }
    private fun moves(vararg counts: Int) = buildJsonArray {
        counts.forEachIndexed { i, count -> addJsonObject {
            put("requestedBySessionId", "s$i"); put("fromProjectId", "p1"); put("toProjectId", "p2"); put("count", count)
            put("since", now.toString()); put("title", "Move $i"); putJsonArray("handoffIds") { repeat(count) { add("h$i-$it") } }
        } }
    }
    private fun row(kind: String?, requests: JsonArray? = null, moves: JsonArray? = null, pending: Int = 1) =
        DirectorySession("s", "Runner hardening", status = "AWAITING_INPUT", runState = "AWAITING_INPUT", pendingApprovals = pending,
            waitingKind = kind, ownerRequests = requests, taskMoves = moves)
    private fun line(s: DirectorySession) = SessionLine.make(s, live = true, now = now)

    @Test fun anOpenRequestSaysItsKind() {
        mapOf("DECISION" to "Decision for you", "SECRET" to "Key needed", "MANUAL_STEP" to "Steps for you", "CONFIRM" to "Confirm for you")
            .forEach { (kind, word) ->
                assertEquals(SessionLine(word, Tone.APPROVAL), line(row("OWNER_REQUEST", requests(kind))))
                assertEquals(word, SessionHeader.statusWord(row("OWNER_REQUEST", requests(kind, kind), pending = 2), now = now))
            }
    }

    @Test fun taskMovesSayHowManyWait() {
        assertEquals(SessionLine("Approve task move", Tone.APPROVAL), line(row("MOVE_REQUEST", moves = moves(1))))
        assertEquals(SessionLine("Approve 8 task moves", Tone.APPROVAL), line(row("MOVE_REQUEST", moves = moves(8))))
        // Two groups on one row (asked here, and into the project it coordinates): the moves are counted, not the groups.
        assertEquals("Approve 5 task moves", line(row("MOVE_REQUEST", moves = moves(3, 2), pending = 2)).text)
    }

    /** A mix is sent under no single kind; a list missing from an older control plane, or a kind this build has no word for, keeps
     * the long-standing word. */
    @Test fun aMixOrAMissingListKeepsWaitingForApproval() {
        assertEquals("Waiting for approval", line(row(null, requests("DECISION"), moves(2), pending = 2)).text)
        assertEquals("Waiting for approval", line(row("OWNER_REQUEST")).text)
        assertEquals("Waiting for approval", line(row("OWNER_REQUEST", requests("SOMETHING_NEW"))).text)
        assertEquals("Waiting for approval", line(row("MOVE_REQUEST", moves = JsonArray(emptyList()))).text)
        assertEquals("Waiting for approval", line(row("MOVE_REQUEST")).text)
    }

    /** The row is decoded off the wire as the server writes it. */
    @Test fun theWireRowCarriesTheLists() {
        val wire = """{"id":"s","title":"t","status":"AWAITING_INPUT","pendingApprovals":1,"waitingKind":"MOVE_REQUEST","ownerRequests":[],
            "taskMoves":[{"requestedBySessionId":"a","fromProjectId":"b","toProjectId":"c","count":8,"since":"2026-11-09T00:31:00Z","title":"x","handoffIds":[]}]}"""
        val session = io.orbitd.android.core.protocol.Wire.json.decodeFromString(DirectorySession.serializer(), wire)
        assertEquals("Approve 8 task moves", line(session).text)
    }

    /** Every word is `@orbit/shared`'s, which the server and the other clients say too. */
    @Test fun theWordsAreTheSharedOnes() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/shared/src").isDirectory }
        val shared = File(root, "src/shared/src/project-progress.ts").readText()
        OwnerRequestRowWords.requestWords.forEach { (kind, word) -> assertTrue("$kind: $word", shared.contains("$kind: '$word'")) }
        assertTrue(shared.contains("moves === 1 ? '${OwnerRequestRowWords.taskMoves(1)}' : `${OwnerRequestRowWords.taskMoves(23).replace("23", "\${moves}")}`"))
    }

    @Test fun theRowsMarkStaysTheAmberDot() {
        compose.setContent { OrbitTheme { SessionLiveMark(row("MOVE_REQUEST", moves = moves(8)), null) } }
        compose.onNodeWithTag("session-mark-needs-you").assertExists()
        compose.onAllNodesWithTag("session-mark-running").assertCountEquals(0)
    }
}
