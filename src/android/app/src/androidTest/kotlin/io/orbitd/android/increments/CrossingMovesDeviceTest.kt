package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Cross-project task moves on the crossing decision card (474dbe301; owner 11-12, project 34vUNVEqe1OFz1uHNULOO), on a device: one batch
 * of eight moves out of a finished project, asked by that project's coordinator, into a project whose coordinator conversation is open.
 * Served by the test's own fixture: the target's handoffs read, each session's task-moves read and the session batch door. Each journey
 * leaves the screenshots set beside iOS: the card and its review in the target coordinator (1, 2), the one batch answer's receipt (3),
 * the same card in the session that asked, in its own words (4, 5), that card once the move was answered at the other end (6), and the
 * session rows saying the moves beside the amber dot (7).
 */
@RunWith(AndroidJUnit4::class)
class CrossingMovesDeviceTest : IncrementDeviceTest() {
    private val coord = "34MoveSessionCoord0001"
    private val asker = "34MoveSessionAsker0001"
    private val project = "34MoveProjectTarget001"
    private val source = "34MoveProjectSource001"
    override val ids get() = listOf(workspace, runner, coord, asker, project, source)

    @Volatile private var theme = "dark"
    /** The answer the batch door recorded, and when. */
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
    private val card = "crossing-batch-${moveId(1)}"

    private fun move(i: Int) = """{"id":"${moveId(i)}","kind":"MOVE_TASK","state":"${decided?.first ?: "PENDING"}","fromProjectId":"$source",
        "toProjectId":"$project","title":${quote(titles[i - 1])},"crossingKey":"${key(i)}","subjectTaskId":"${moveId(i + 100)}",
        "requestedBySessionId":"$asker","requestedAt":"${askedAt.plusSeconds(i.toLong())}","decidedAt":${decided?.second?.let { "\"$it\"" } ?: "null"},
        "reason":"These tasks serve criteria 4–11 there; this project is done.",
        "fromProject":{"title":"Runner link v1: runner ↔ control plane over WebSocket","status":"DONE"},
        "toProject":{"title":"Runner link hardening","status":"OPEN"},
        "subjectTask":{"id":"${moveId(i + 100)}","title":${quote(titles[i - 1])}},
        "requestedBySession":{"id":"$asker","title":"Runner link v1 coordinator"},
        "requestedCriterion":{"key":"${i + 3}","text":"Criterion ${i + 3}"},"withdrawnCriterion":null}"""
    private fun moves() = "[" + (1..8).joinToString(",") { move(it) } + "]"
    private fun batches(drawnAs: String) = """[{"batchKey":"b","requestedBySessionId":"$asker","fromProjectId":"$source","toProjectId":"$project",
        "state":"${decided?.first ?: "PENDING"}","since":"${askedAt.plusSeconds(1)}","decidedAt":${decided?.second?.let { "\"$it\"" } ?: "null"},
        "drawnAs":["$drawnAs"],"moves":${moves()}}]"""

    private fun row(id: String, title: String, projectId: String?, at: Long) = """{"id":"$id","title":${quote(title)},
        "status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN","provider":"claude","engine":"claude",
        "model":"claude-opus-5-5","assignedRunnerId":"$runner","agentId":"$workspace","agent":{"id":"$workspace","name":"Alpha"},
        ${projectId?.let { "\"projectId\":\"$it\"," } ?: ""}"createdAt":"${ago(900)}","lastTurnAt":"${ago(at)}",
        "pendingApprovals":${if (decided == null) 1 else 0},
        ${if (decided == null) """"waitingKind":"MOVE_REQUEST","ownerRequests":[],"taskMoves":[{"requestedBySessionId":"$asker",
        "fromProjectId":"$source","toProjectId":"$project","count":8,"since":"${askedAt.plusSeconds(1)}","title":${quote(titles[0])},
        "handoffIds":[${(1..8).joinToString(",") { "\"${moveId(it)}\"" }}]}],""" else ""}
        "lastAssistantText":"Asked the owner to move the eight tasks.","capabilities":{"canSend":true,"canComplete":true},"tags":[]}"""
    private fun coordRow() = row(coord, "Runner link hardening: false-offline alerts, upgrades and parked work", project, 240)
    private fun askerRow() = row(asker, "Runner link v1 coordinator", source, 250)
    override fun sessions(view: String, project: String?) = if (view != "open") "[]" else "[${coordRow()},${askerRow()}]"
    override fun userJson() = """{"id":"u1","email":"a15c@example.test","name":"A15c fixture","preferences":{"theme":"$theme"}}"""

    private fun events(words: String) = listOf(
        event(1, "user", """{"text":"Bring criteria 4–11's tasks over from Runner link v1"}""", askedAt.minusSeconds(120).toString(), "t-1"),
        event(2, "assistant", """{"text":${quote(words)}}""", askedAt.minusSeconds(60).toString(), "t-1"),
        event(3, "turn_end", """{"subtype":"success"}""", askedAt.minusSeconds(60).toString(), "t-1"),
    )

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$coord" && req.method == "GET" -> json(coordRow())
        req.path == "sessions/$asker" && req.method == "GET" -> json(askerRow())
        req.path == "sessions/$coord/events/page" -> json(page(events("The 8 moves wait on the card below — approving there moves them at once.")))
        req.path == "sessions/$asker/events/page" -> json(page(events("I asked the owner to move the 8 tasks into Runner link hardening.")))
        req.path == "sessions/$coord/task-moves" -> json(batches("TARGET_COORDINATOR"))
        req.path == "sessions/$asker/task-moves" -> json(batches("REQUESTER"))
        req.path.endsWith("/task-moves/decision") -> {
            decided = (if (req.body.contains("\"APPROVE\"")) "APPLIED" else "DENIED") to Instant.now().toString()
            json(moves())
        }
        req.path == "projects/$project/handoffs" -> json(moves())
        req.path == "projects/$source/handoffs" -> json(moves())
        req.path == "tasks/evidence-decisions/pending" -> json("""{"decidingSessionId":"$coord","count":0,"oldestAgeSeconds":null,"pending":[],
            "waitingOnYou":[],"waitingOnCoordinator":[],"sentToCoordinator":[],"decided":[]}""")
        req.path == "projects/$project" || req.path == "projects/$source" -> {
            val (id, title, status, c) = if (req.path.endsWith(project)) listOf(project, "Runner link hardening", "OPEN", coord)
                else listOf(source, "Runner link v1", "DONE", asker)
            json("""{"id":"$id","title":"$title","status":"$status","goal":"The runner link.","createdAt":"${ago(2000)}",
                "startedAt":"${ago(1900)}","coordinatorSessionId":"$c","_count":{"tasks":8},"acceptanceCriteriaItems":[]}""")
        }
        req.path.endsWith("/open-items") -> json("""{"needsYou":[],"withCoordinator":[],"closedQuestions":[]}""")
        req.path.endsWith("/promotions/current") -> empty200()
        req.path.endsWith("/promotions/merged") -> json("[]")
        req.path.startsWith("projects/") -> json("{}")
        else -> null
    }

    private fun openConversation(id: String) {
        signIn()
        open("orbit-session:$id")
        await("the conversation") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
        await("the crossing card") { exists(hasTestTag("$card:preview"), unmerged = true) }
        scrollTranscriptTo(hasTestTag(card))
    }

    private fun openReview() {
        compose.onNodeWithTag("$card:preview").performClick()
        awaitTag("$card:review")
    }

    /** (1–3) The target project's coordinator: the card, its review, and ONE batch answer with every move's key. */
    @Test fun theTargetCoordinatorAnswersTheBatchOnce() = journey {
        openConversation(coord)
        verify("the card asks to move them here", says("$card:preview", "Move these tasks here?"))
        verify("its summary", textOf("$card:summary") == "8 tasks from Runner link v1: runner ↔ control plane over WebSocket · for criteria 4–11")
        capture("1-target-card")
        openReview()
        verify("To this project", textOf("$card:review:to") == "To this project")
        capture("2-target-review")
        compose.onNodeWithTag("$card:review:approve").performClick()
        await("the receipt") { exists(hasTestTag("$card:review:receipt"), unmerged = true) }
        val sent = bodies.filter { it.first.endsWith("task-moves/decision") }
        verify("one answer through the session's batch door", sent.size == 1 && sent.single().first == "POST sessions/$coord/task-moves/decision")
        verify("every move with its key", (1..8).all { sent.single().second.contains(key(it)) })
        verify("no per-crossing door", bodies.none { it.first.contains("/handoffs/") })
        verify("the receipt says it was answered here", textOf("$card:review:receipt").startsWith("Decision recorded · ✓ Approved by you"))
        await("the review leaves") { !exists(hasTestTag("$card:review"), unmerged = true) }
        scrollTranscriptTo(hasTestTag(card))
        capture("3-target-answered")
    }

    /** (4–5) The session that asked: the same card, naming where the tasks go. */
    @Test fun theAskingSessionDrawsTheSameCard() = journey {
        openConversation(asker)
        verify("it names the target", says("$card:preview", "Move these tasks into Runner link hardening?"))
        capture("4-asker-card")
        openReview()
        verify("To the target", textOf("$card:review:to") == "To Runner link hardening")
        capture("5-asker-review")
    }

    /** (6) Answered at the other end while the asking session showed it waiting: its next read says so. */
    @Test fun theAskingSessionSeesTheAnswerFromTheOtherEnd() = journey {
        openConversation(asker)
        verify("it waits", says("$card:preview", "View details & act"))
        decided = "APPLIED" to Instant.now().toString()
        app.realtime.refreshSession()
        await("the receipt from the other end") { textOf("$card:receipt") == "Approved at another end" }
        scrollTranscriptTo(hasTestTag(card))
        capture("6-asker-answered-elsewhere")
    }

    /** (7) The session list in the light theme: both sessions say the moves beside the amber dot. */
    @Test fun theRowsSayTheMoves() = journey {
        theme = "light"
        signIn()
        fun state(id: String) = listOf("session-state:" + (ObjectId.canonical(id) ?: id), "session-state:$id").firstOrNull { exists(hasTestTag(it), unmerged = true) }
        await("both rows") { state(coord) != null && state(asker) != null }
        verify("the coordinator's row says the moves", textOf(state(coord)!!) == "Approve 8 task moves")
        verify("the asking session's row says the moves", textOf(state(asker)!!) == "Approve 8 task moves")
        verify("the amber dots", count(hasTestTag("session-mark-needs-you"), unmerged = true) == 2)
        capture("7-rows")
    }
}
