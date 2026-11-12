package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectCrossings
import java.time.Instant
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The task-move card in a conversation and the row word (board docs/mocks/waiting-on-you-removal, 01-board-2 and 01-board-3), on a
 * device: the target project's coordinator conversation, served by the test's own fixture, with one batch of eight moves out of a
 * finished project. Each journey leaves the screenshot set beside the board's phone: the card before the first press (1-card), the
 * second press (2-second-press), the resolved line once approved (3-resolved), and the session row that says it (4-row).
 */
@RunWith(AndroidJUnit4::class)
class TaskMoveCardDeviceTest : IncrementDeviceTest() {
    private val coord = "34MoveSessionCoord0001"
    private val asker = "34MoveSessionAsker0001"
    private val project = "34MoveProjectTarget001"
    private val source = "34MoveProjectSource001"
    private val wiki = "34MoveSessionWiki00001"
    override val ids get() = listOf(workspace, runner, coord, asker, project, source, wiki)

    @Volatile private var theme = "dark"
    /** The answer the batch door recorded, once it has. */
    @Volatile private var decided: Pair<String, String>? = null

    private val titles = listOf(
        "An apiserver never stops gracefully: every restart cuts what is in flight",
        "A later `sudo orbit …` runs the account’s own binary as root",
        "Merged event commits queue on Postgres’s global NOTIFY lock",
        "The runner reconnect storm after a deploy",
        "Heartbeat gaps read as offline",
        "Upgrade the runner without dropping a turn",
        "Parked sessions wake twice",
        "The landing check times out on cold caches",
    )
    private val askedAt = Instant.now().minusSeconds(4 * 3600)
    private fun moveId(i: Int) = "01a0d6a9-d763-70e1-b4cf-8793e971c%03d".format(i)
    private fun key(i: Int) = java.security.MessageDigest.getInstance("SHA-256").digest("move-$i".encodeToByteArray()).joinToString("") { "%02x".format(it) }

    private fun move(i: Int) = """{"id":"${moveId(i)}","kind":"MOVE_TASK","state":"${decided?.first ?: "PENDING"}","fromProjectId":"$source",
        "toProjectId":"$project","title":${quote(titles[i - 1])},"crossingKey":"${key(i)}","subjectTaskId":"${moveId(i + 100)}",
        "requestedBySessionId":"$asker","requestedAt":"${askedAt.plusSeconds(i.toLong())}","decidedAt":${decided?.second?.let { "\"$it\"" } ?: "null"},
        "fromProject":{"title":"Runner link v1: runner ↔ control plane over WebSocket","status":"DONE"},
        "toProject":{"title":"Runner link hardening: false-offline alerts, upgrades and parked work","status":"OPEN"},
        "subjectTask":{"id":"${moveId(i + 100)}","title":${quote(titles[i - 1])}},
        "requestedBySession":{"id":"$asker","title":"Runner link v1 coordinator"},
        "requestedCriterion":{"key":"crit-$i","text":"Criterion ${i + 3}"},"withdrawnCriterion":null}"""
    private fun batches() = """[{"batchKey":"b-${decided?.first ?: "PENDING"}","requestedBySessionId":"$asker","fromProjectId":"$source",
        "toProjectId":"$project","state":"${decided?.first ?: "PENDING"}","since":"${askedAt.plusSeconds(1)}",
        "decidedAt":${decided?.second?.let { "\"$it\"" } ?: "null"},"drawnAs":["TARGET_COORDINATOR"],
        "moves":[${(1..8).joinToString(",") { move(it) }}]}]"""

    private fun row(id: String, title: String, waiting: Boolean, line: String? = null, at: Long = 240) = """{"id":"$id","title":${quote(title)},
        "status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN","provider":"claude","engine":"claude",
        "model":"claude-opus-5-5","assignedRunnerId":"$runner","agentId":"$workspace","agent":{"id":"$workspace","name":"Alpha"},
        "createdAt":"${ago(900)}","lastTurnAt":"${ago(at)}","updatedAt":"${ago(at)}",
        "pendingApprovals":${if (waiting && decided == null) 1 else 0},
        ${if (id == coord && decided == null) """"waitingKind":"MOVE_REQUEST","ownerRequests":[],"taskMoves":[{"requestedBySessionId":"$asker",
        "fromProjectId":"$source","toProjectId":"$project","count":8,"since":"${askedAt.plusSeconds(1)}","title":${quote(titles[0])},
        "handoffIds":[${(1..8).joinToString(",") { "\"${moveId(it)}\"" }}]}],""" else if (waiting) """"waitingKind":null,""" else ""}
        "lastAssistantText":${quote(line ?: "Done.")},"capabilities":{"canSend":true,"canComplete":true},"tags":[]}"""
    private fun detail() = row(coord, "Runner link hardening: false-offline alerts, upgrades and parked work", true,
        "Saying it here does not record it.")
    override fun sessions(view: String, project: String?) = if (view != "open") "[]" else "[" + listOf(
        detail(),
        row(wiki, "Rebuild the wiki articles report", true, at = 9),
    ).joinToString(",") + "]"
    override fun userJson() = """{"id":"u1","email":"a15c@example.test","name":"A15c fixture","preferences":{"theme":"$theme"}}"""

    private fun events() = listOf(
        event(1, "user", """{"text":"Approve them"}""", askedAt.minusSeconds(120).toString(), "t-1"),
        event(2, "assistant", """{"text":"Saying it here does not record it. The 8 moves are waiting on the card below — approving there moves them at once."}""",
            askedAt.minusSeconds(60).toString(), "t-1"),
        event(3, "turn_end", """{"subtype":"success"}""", askedAt.minusSeconds(60).toString(), "t-1"),
    )

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$coord" && req.method == "GET" -> json(detail())
        req.path == "sessions/$coord/events/page" -> json(page(events()))
        req.path == "sessions/$coord/task-moves" && req.method == "GET" -> json(batches())
        req.path == "sessions/$coord/task-moves/decision" -> {
            decided = (if (req.body.contains("\"APPROVE\"")) "APPLIED" else "DENIED") to Instant.now().toString()
            json("[" + (1..8).joinToString(",") { move(it) } + "]")
        }
        req.path == "tasks/evidence-decisions/pending" -> json("""{"decidingSessionId":"$coord","count":0,"oldestAgeSeconds":null,"pending":[],
            "waitingOnYou":[],"waitingOnCoordinator":[],"sentToCoordinator":[],"decided":[]}""")
        req.path == "projects/$project" -> json("""{"id":"$project","title":"Runner link hardening","status":"OPEN","goal":"Harden the runner link.",
            "createdAt":"${ago(2000)}","startedAt":"${ago(1900)}","coordinatorSessionId":"$coord","_count":{"tasks":2},"acceptanceCriteriaItems":[]}""")
        req.path == "projects/$project/open-items" -> json("""{"needsYou":[],"withCoordinator":[],"closedQuestions":[]}""")
        req.path == "projects/$project/promotions/current" -> empty200()
        req.path == "projects/$project/promotions/merged" -> json("[]")
        req.path.startsWith("projects/$project/") -> json("{}")
        else -> null
    }

    private val card get() = "task-moves:b-${decided?.first ?: "PENDING"}"

    private fun openConversation() {
        signIn()
        open("orbit-session:$coord")
        await("the coordinator conversation") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
        await("the move card") { exists(hasTestTag(card), unmerged = true) }
        scrollTranscriptTo(hasTestTag(card))
    }

    /** (1) Before the first press: what it asks, where from, who asked, three moves, Show all 8, the two presses. */
    @Test fun theCardBeforeTheFirstPress() = journey {
        openConversation()
        verify("the title says the batch", textOf("$card:title") == "Move 8 tasks into this project")
        verify("it names the source and its state", textOf("$card:from").startsWith("From Runner link v1") && textOf("$card:from").endsWith("(Done)"))
        verify("three moves with their criteria", (1..3).all { textOf("$card:move:${moveId(it)}:line") ==
            "Task to move · Target criterion requested: Criterion ${it + 3}" } && !exists(hasTestTag("$card:move:${moveId(4)}"), unmerged = true))
        verify("Show all 8", says("$card:show-all", "Show all 8"))
        verify("the batch's presses", says("$card:approve", "Approve 8 moves…") && says("$card:refuse", "Refuse…"))
        verify("the needs-you bar counts it", textOf("needs-you-bar-text").startsWith("1 open question"))
        capture("1-card")
    }

    /** (2) The second press: both projects, each move's key, and the consequence the project page already says. */
    @Test fun theSecondPressListsTheMovesAndTheirKeys() = journey {
        openConversation()
        compose.onNodeWithTag("$card:approve").performClick()
        awaitTag("$card:consequence")
        verify("it asks", textOf("$card:title") == "Approve 8 task moves?")
        verify("both ends", textOf("$card:route").contains(ProjectCrossings.arrow.trim()))
        verify("each move's crossing key", textOf("$card:confirm:${moveId(1)}:line") == "Criterion 4 · key ${key(1).take(12)}…")
        verify("and 5 more", textOf("$card:more") == "and 5 more")
        verify("the consequence", textOf("$card:consequence") == ProjectCrossings.moveApproveConsequence)
        scrollTranscriptTo(hasTestTag("$card:answer"))
        capture("2-second-press")
    }

    /** (3) Approved: one line where the card was, and the batch door was sent every move with its key. */
    @Test fun approvedTheCardIsOneLine() = journey {
        openConversation()
        compose.onNodeWithTag("$card:approve").performClick()
        awaitTag("$card:answer")
        compose.onNodeWithTag("$card:answer").performClick()
        await("the resolved line") { exists(hasTestTag("task-moves:b-APPLIED:resolved-line"), unmerged = true) }
        verify("it says what happened", textOf("task-moves:b-APPLIED:resolved-line") == "Moved 8 tasks into this project")
        verify("the door had every key", (1..8).all { i -> bodies.any { it.first.endsWith("task-moves/decision") && it.second.contains(key(i)) } })
        scrollTranscriptTo(hasTestTag("task-moves:b-APPLIED:resolved"))
        capture("3-resolved")
    }

    /** (4) The session list in the light theme: the coordinator's row says the moves beside the amber dot. */
    @Test fun theRowSaysTheMoves() = journey {
        theme = "light"
        signIn()
        val state = "session-state:" + (ObjectId.canonical(coord) ?: coord)
        await("the coordinator's row") { exists(hasTestTag(state), unmerged = true) || exists(hasTestTag("session-state:$coord"), unmerged = true) }
        val tag = if (exists(hasTestTag(state), unmerged = true)) state else "session-state:$coord"
        verify("the row says the moves", textOf(tag) == "Approve 8 task moves")
        verify("the amber dot", exists(hasTestTag("session-mark-needs-you"), unmerged = true))
        capture("4-row")
    }
}
