package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.text
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.ProjectCrossings
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The task-move card in a conversation (board waiting-on-you-removal ②) over the real wire: the card before the first press, the second
 * press listing the moves with their crossing keys and the consequence, Cancel, the batch answered whole — every move with the key the
 * card read — and the card turning into its resolved line; a stale key refused whole with the door's code; and one move answered on its
 * own under Show all through the project page's door.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class TaskMoveCardTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val fixture = TaskMoveFixture()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var store: TaskMoveStore

    @Before fun setUp() {
        store = TaskMoveStore(ProjectApi(fixture.auth, runBlocking { fixture.signIn() }), TaskMoveFixture.SESSION, scope)
        store.load()
        compose.waitUntil(10_000) { store.state.value.batches?.size == 1 }
        compose.setContent {
            OrbitTheme(darkTheme = false) {
                val state by store.state.collectAsState()
                Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    state.batches.orEmpty().forEach { TaskMoveCard(it, store) }
                }
            }
        }
    }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    private val key get() = TaskMoves.key(store.state.value.batches!!.first())
    private fun node(suffix: String) = compose.onNodeWithTag("task-moves:$key:$suffix", useUnmergedTree = true)

    @Test fun beforeTheFirstPressTheCardSaysWhatWhereFromAndEachMove() {
        node("title").assertTextEquals("Move 8 tasks into this project")
        node("from").assertTextEquals("From Runner link v1: runner ↔ control plane over WebSocket (Done)")
        node("asked").assertTextContains("Asked by Runner link v1 coordinator", substring = true)
        // Three moves, each with the crossing card's two labels and the criterion it asks for; the rest behind Show all.
        val first = fixture.rows.first().text("id")
        compose.onNodeWithTag("task-moves:$key:move:$first:line", useUnmergedTree = true)
            .assertTextEquals("Task to move · Target criterion requested: ${TaskMoveFixture.CRITERIA[0]}")
        compose.onAllNodes(hasTestTagPrefix("task-moves:$key:move:") and hasTestTagSuffix(":line"), useUnmergedTree = true).assertCountEquals(3)
        node("show-all").assertTextEquals("Show all 8")
        node("refuse").assertTextEquals("Refuse…")
        node("approve").assertTextEquals("Approve 8 moves…")
        assertTrue(fixture.posts().isEmpty())
    }

    @Test fun theSecondPressListsTheMovesWithTheirKeysAndCancelTakesItBack() {
        node("approve").performClick()
        node("title").assertTextEquals("Approve 8 task moves?")
        node("route").assertTextEquals("From Runner link v1: runner ↔ control plane over WebSocket → Runner link hardening")
        val first = fixture.rows.first()
        compose.onNodeWithTag("task-moves:$key:confirm:${first.text("id")}:line", useUnmergedTree = true)
            .assertTextEquals("${TaskMoveFixture.CRITERIA[0]} · key ${first.text("crossingKey")!!.take(12)}…")
        node("more").assertTextEquals("and 5 more")
        node("consequence").assertTextEquals(ProjectCrossings.moveApproveConsequence)
        node("answer").assertTextEquals("Approve 8 moves")
        node("cancel").performClick()
        node("title").assertTextEquals("Move 8 tasks into this project")
        assertTrue("nothing is sent before the second press", fixture.posts().isEmpty())
    }

    @Test fun approvingAnswersTheWholeBatchWithEveryKeyAndTheCardResolves() {
        val sent = fixture.rows
        node("approve").performClick()
        node("answer").performClick()
        compose.waitUntil(10_000) { store.state.value.batches?.firstOrNull()?.text("state") == "APPLIED" }
        val body = Json.parseToJsonElement(fixture.posts().single().body).jsonObject
        assertEquals("/api/sessions/${TaskMoveFixture.SESSION}/task-moves/decision", fixture.posts().single().path)
        assertEquals("APPROVE", body["decision"]!!.jsonPrimitive.content)
        assertEquals(sent.map { it.text("id") to it.text("crossingKey") },
            body["moves"]!!.jsonArray.map { it.jsonObject["handoffId"]!!.jsonPrimitive.content to it.jsonObject["crossingKey"]!!.jsonPrimitive.content })
        compose.waitForIdle()
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTagSuffix(":resolved-line"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasTestTagSuffix(":resolved-line"), useUnmergedTree = true).assertTextEquals("Moved 8 tasks into this project")
        compose.onAllNodes(hasTestTagSuffix(":approve"), useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun refusingSendsDenyAndResolvesAsRefused() {
        node("refuse").performClick()
        node("title").assertTextEquals("Refuse 8 task moves?")
        node("consequence").assertTextEquals(ProjectCrossings.moveDenyConsequence)
        node("answer").assertTextEquals("Refuse 8 moves").performClick()
        compose.waitUntil(10_000) { store.state.value.batches?.firstOrNull()?.text("state") == "DENIED" }
        assertEquals("DENY", Json.parseToJsonElement(fixture.posts().single().body).jsonObject["decision"]!!.jsonPrimitive.content)
        compose.waitUntil(10_000) { compose.onAllNodes(hasTestTagSuffix(":resolved-line"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasTestTagSuffix(":resolved-line"), useUnmergedTree = true).assertTextEquals("Refused 8 task moves into this project")
    }

    /** A key that names another crossing: nothing is written, the second press stays up with the door's code and reason. */
    @Test fun aStaleKeyIsRefusedWholeAndTheSecondPressStays() {
        fixture.mismatch = true
        node("approve").performClick()
        node("answer").performClick()
        compose.waitUntil(10_000) { store.state.value.refusals.isNotEmpty() }
        node("refusal").assertTextContains("APPROVAL_TARGET_MISMATCH", substring = true)
        node("title").assertTextEquals("Approve 8 task moves?")
        assertTrue(fixture.rows.all { it.text("state") == "PENDING" })
    }

    /** Show all draws each move as the project page's crossing row, and one answered on its own goes through that page's door. */
    @Test fun showAllAnswersOneMoveOnItsOwn() {
        node("show-all").performClick()
        node("show-all").assertTextEquals("Show fewer")
        val third = fixture.rows[2]
        val id = third.text("id")!!
        compose.onNodeWithTag("crossing:$id:approve").performScrollTo().performClick()
        compose.onNodeWithTag("crossing:$id:answer").performScrollTo().performClick()
        compose.waitUntil(10_000) { store.state.value.batches?.size == 2 }
        val post = fixture.posts().single()
        assertEquals("/api/projects/${TaskMoveFixture.TO}/handoffs/$id/decision", post.path)
        assertEquals(third.text("crossingKey"), Json.parseToJsonElement(post.body).jsonObject["acknowledgedCrossingKey"]!!.jsonPrimitive.content)
        // The other seven still wait as one card; the one answered is its own resolved line.
        val waiting = store.state.value.batches!!.first { TaskMoves.pending(it) }
        assertEquals(7, TaskMoves.moves(waiting).size)
        assertEquals("Moved 1 task into this project", TaskMoves.resolvedLine(store.state.value.batches!!.first { !TaskMoves.pending(it) }))
    }

    private fun hasTestTagPrefix(prefix: String) = SemanticsMatcher("tag starts with $prefix") {
        it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.startsWith(prefix) == true
    }
    private fun hasTestTagSuffix(suffix: String) = SemanticsMatcher("tag ends with $suffix") {
        it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.TestTag)?.endsWith(suffix) == true
    }
}
