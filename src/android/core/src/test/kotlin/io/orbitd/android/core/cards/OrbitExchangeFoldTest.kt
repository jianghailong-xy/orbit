package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The turns Orbit opened, read and arranged as the web reads them (web lib/orbitExchangeFold.test.ts, Transcript.orbitFold.test.tsx):
 * which turns fold and what their line says, the first line of an answer, a group's count by kind, and its tree by task.
 */
class OrbitExchangeFoldTest {
    private val b1 = "0195c0de-0000-7000-8000-000000000011"
    private val b4 = "0195c0de-0000-7000-8000-000000000014"
    private val b4b = "0195c0de-0000-7000-8000-000000000015"
    private val b5 = "0195c0de-0000-7000-8000-000000000016"
    private val runOfB4 = "0195c0de-0000-7000-8000-0000000000a4"
    private val watch = "0195c0de-0000-7000-8000-0000000000c3"

    private fun user(build: JsonObjectBuilder.() -> Unit) = RunEvent("user", 7, buildJsonObject(build), "turn")
    private fun delivery(kind: String, revision: Int? = 2) = buildJsonObject {
        put("kind", kind); putJsonObject("task") { put("id", b1); put("title", "B1 Targeted hints") }
        put("revision", revision?.let(::JsonPrimitive) ?: JsonNull); put("count", JsonNull); put("deliveredAt", "2026-11-11T09:10:00Z")
    }
    private fun watchText(kind: String, id: String, status: String? = null) = listOf(
        "Orbit Watch $watch matched at generation 1: SESSION_IDLE 1/1", "",
        "This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:", "",
        "```json",
        buildJsonObject {
            put("watchId", watch); put("generation", 1)
            putJsonArray("changedTargets") { addJsonObject {
                put("kind", kind); put("id", id); put("state", "IDLE"); status?.let { putJsonObject("observed") { put("status", it) } }
            } }
        }.toString(),
        "```",
    ).joinToString("\n")
    private val job = """<background-job-wake>
  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:
    bgj_05c42665fe0a｜watch｜bash watch.sh｜Wait for runner 0.1.237 to reach main
      ended｜STATUS｜exit code 0
  The control plane recorded this for you; the user did not write it.
</background-job-wake>"""

    @Test fun aFactToldToTheCoordinatorFoldsAsItsSentence() {
        val head = OrbitExchangeFold.turnOf(user { put("text", "From Orbit · …"); put("coordinatorDelivery", delivery("EVIDENCE_SUBMITTED")) })!!
        assertEquals("Evidence revision 2 submitted: B1 Targeted hints", head.what)
        assertEquals("Evidence revision 2 submitted", head.whatInTask)
        assertEquals("evidence", head.category)
        assertEquals(OrbitExchangeFold.Target("TASK", b1, "B1 Targeted hints"), head.target)
        assertEquals("ready", OrbitExchangeFold.turnOf(user { put("text", "x"); put("coordinatorDelivery", delivery("DEPENDENT_READY", null)) })!!.category)
    }

    @Test fun badNewsAndWhatSomebodyWroteStayInView() {
        listOf("TASK_DISPATCH_REFUSED", "PROJECT_BLOCKER_RAISED").forEach { kind ->
            assertNull(kind, OrbitExchangeFold.turnOf(user { put("text", "x"); put("coordinatorDelivery", delivery(kind, null)) }))
        }
        assertNull(OrbitExchangeFold.turnOf(user { put("text", watchText("TASK", b4, "FAILED")) }))
        assertNull(OrbitExchangeFold.turnOf(user { put("text", job.replace("STATUS", "failed")); put("controlPlaneNote", job.replace("STATUS", "failed")) }))
        assertNull("unconfirmed", OrbitExchangeFold.turnOf(user {
            put("text", "x"); put("coordinatorDelivery", delivery("EVIDENCE_SUBMITTED")); put("delivery", "unconfirmed")
        }))
        listOf("openItemDelivery", "ownerAnswer", "taskStart", "projectStarted").forEach { card ->
            assertNull(card, OrbitExchangeFold.turnOf(user { put("text", "x"); putJsonObject(card) { put("x", 1) } }))
        }
        assertNull("the reader's words", OrbitExchangeFold.turnOf(user { put("text", "Which tasks wait on me?") }))
        assertNull("a steer", OrbitExchangeFold.turnOf(user { put("text", watchText("TASK", b4)); put("steer", true) }))
    }

    @Test fun aWatchAJobAndAReplyFoldUnderTheirOwnWords() {
        val watched = OrbitExchangeFold.turnOf(user { put("text", watchText("SESSION", runOfB4)) }) { _, _ -> "B4 run" }!!
        assertEquals("Watch triggered: B4 run", watched.what)
        assertEquals("Watch triggered", watched.whatInTask)
        assertEquals(OrbitExchangeFold.Target("SESSION", runOfB4, "B4 run"), watched.target)
        val ended = job.replace("STATUS", "completed")
        val woke = OrbitExchangeFold.turnOf(user { put("text", ended); put("controlPlaneNote", ended) })!!
        assertEquals("Background job finished: Wait for runner 0.1.237 to reach main", woke.what)
        assertNull(woke.target)
        val replied = OrbitExchangeFold.turnOf(user {
            put("text", ""); putJsonArray("sessionReplies") { addJsonObject { put("requestId", "r"); put("fromSessionId", runOfB4); put("fromTitle", "B4 run"); put("outcome", "REPLIED") } }
        })!!
        assertEquals("Reply from B4 run", replied.what)
        assertEquals("reply", replied.category)
    }

    @Test fun aStoppedRunARunNoticeAndATaskRunsMessageFoldUnderTheirTasks() {
        val stopped = OrbitExchangeFold.turnOf(user { put("text", "x"); put("coordinatorDelivery", delivery("TASK_RUN_STOPPED", null)) })!!
        assertEquals("Run stopped: B1 Targeted hints", stopped.what)
        assertEquals("project", stopped.category)
        val note = listOf(
            "<orbit-run-notice task=\"34vZUH31xayU3ZWjyRWfh\" run-session=\"3y90ooHJ7OgQrKUV8KyqwZ\" from-session=\"3y90ooHJ7OgQrKUV8KyqwZ\" from-mode=\"auto\">",
            "A run of the task “A task’s delivered_sha can freeze” used notify. It did not reach the account owner.",
            "Message: Background job bgj_c06ee80b2571 ended (exit code 0)",
            "Nothing is waiting for your reply. If the owner should know or decide, use ask_owner with your recommendation.",
            "</orbit-run-notice>",
        ).joinToString("\n")
        val notice = OrbitExchangeFold.turnOf(user { put("text", note); put("controlPlaneNote", note) })!!
        assertEquals("Run notice: A task’s delivered_sha can freeze", notice.what)
        assertEquals("Run notice", notice.whatInTask)
        assertEquals("notice", notice.category)
        assertEquals(OrbitExchangeFold.Target("TASK", "34vZUH31xayU3ZWjyRWfh", "A task’s delivered_sha can freeze"), notice.target)
        assertNull(OrbitExchangeFold.turnOf(user { val n = note.replace("task=\"34vZUH31xayU3ZWjyRWfh\"", "task=\"\""); put("text", n); put("controlPlaneNote", n) })!!.target)
        assertNull("a run question asks", OrbitExchangeFold.runNotice("<orbit-run-question task=\"x\" run-session=\"y\">\nA run asked…\n</orbit-run-question>"))
        assertNull("no closing tag", OrbitExchangeFold.runNotice(note.replace("</orbit-run-notice>", "")))
        val fromTask = OrbitExchangeFold.turnOf(user {
            put("text", "B4 scope note")
            putJsonObject("sessionMessage") { put("fromSessionId", runOfB4); put("fromTitle", "Task: B4 Link gateway"); put("fromAgentName", "orbit"); put("fromTaskId", b4) }
        })!!
        assertEquals("Message from B4 Link gateway", fromTask.what)
        assertEquals("Message", fromTask.whatInTask)
        assertEquals("message", fromTask.category)
        assertEquals(OrbitExchangeFold.Target("TASK", b4, "B4 Link gateway"), fromTask.target)
        val fromChat = OrbitExchangeFold.turnOf(user {
            put("text", "fixed on main"); putJsonObject("sessionMessage") { put("fromSessionId", runOfB4); put("fromTitle", "Task: wiki chat"); put("fromAgentName", "orbit") }
        })!!
        assertEquals("Message from Task: wiki chat", fromChat.what)
        assertEquals(OrbitExchangeFold.Target("SESSION", runOfB4, "Task: wiki chat"), fromChat.target)
    }

    @Test fun theReplysFirstLineAsPlainText() {
        assertEquals("我确认了 B1（定向提示与 NATS），它正在落地。",
            OrbitExchangeFold.replyGist("我确认了 B1（[定向提示与 NATS](orbit-task:x)），它正在落地。\n\n**确认依据**\n- 第 1 版…"))
        assertEquals("Verdict: confirmed B5", OrbitExchangeFold.replyGist("\n## **Verdict:** confirmed `B5`\nmore"))
        assertEquals("first point", OrbitExchangeFold.replyGist("- first point\n- second"))
        assertEquals("code", OrbitExchangeFold.replyGist("```\ncode\n```"))
        assertEquals("", OrbitExchangeFold.replyGist(""))
    }

    @Test fun aGroupCountsWhatItHoldsByKind() {
        assertEquals("3 evidence, 1 can start, 2 watches, 1 background job",
            OrbitExchangeFold.kinds(listOf("watch", "evidence", "evidence", "job", "ready", "watch", "evidence")))
        assertEquals("1 reply", OrbitExchangeFold.kinds(listOf("reply")))
        assertEquals("1 project update, 2 run notices, 1 message", OrbitExchangeFold.kinds(listOf("message", "notice", "project", "notice")))
        assertEquals("7 Orbit updates handled", OrbitExchangeFold.handled(7))
        assertEquals("1 update", OrbitExchangeFold.updates(1))
    }

    private data class Ex(val seq: Long, val target: OrbitExchangeFold.Target?)
    private fun task(id: String, title: String? = null) = OrbitExchangeFold.Target("TASK", id, title)
    private val lookup = object : OrbitExchangeFold.Lookup {
        override fun taskOfSession(sessionId: String) = if (sessionId == runOfB4) b4 to null else null
        override fun upstreamOf(taskId: String) = mapOf(b4 to listOf(b1), b4b to listOf(b4), b5 to listOf(b4, b1))[taskId].orEmpty()
        override fun taskTitle(taskId: String) = mapOf(b1 to "B1", b4 to "B4", b4b to "B4b", b5 to "B5")[taskId]
    }

    @Test fun eachExchangeGoesUnderItsTaskAndATaskUnderItsPrerequisiteInTheGroup() {
        val tree = OrbitExchangeFold.tree(listOf(Ex(10, task(b1, "B1 Targeted hints")), Ex(20, OrbitExchangeFold.Target("SESSION", runOfB4, "B4 run")),
            Ex(30, task(b4)), Ex(35, null), Ex(40, task(b4b)), Ex(50, task(b5))), { it.target }, lookup)!!
        assertEquals(listOf("B1 Targeted hints", OrbitExchangeFold.otherBranch), tree.map { it.title })
        val (b1Branch, other) = tree
        assertEquals(listOf(10L), b1Branch.exchanges.map { it.seq })
        // B5 waits on both B4 and B1: under the one that came first in the group, B1 — once.
        assertEquals(listOf("B4", "B5"), b1Branch.children.map { it.title })
        val b4Branch = b1Branch.children.first()
        assertEquals("the watch on B4's run is B4's", listOf(20L, 30L), b4Branch.exchanges.map { it.seq })
        assertEquals(listOf("B4b"), b4Branch.children.map { it.title })
        assertEquals(listOf(35L), other.exchanges.map { it.seq })
        assertEquals(3, OrbitExchangeFold.downstreamCount(b1Branch))
        assertEquals(listOf(10L, 20L, 30L, 40L, 50L), OrbitExchangeFold.all(b1Branch) { it.seq }.map { it.seq })
    }

    @Test fun aTaskWithoutItsPrerequisitesInTheGroupIsARoot() {
        assertEquals(listOf("B4b", "B5"), OrbitExchangeFold.tree(listOf(Ex(1, task(b4b)), Ex(2, task(b5))), { it.target }, lookup)!!.map { it.title })
    }

    @Test fun aSessionNoTaskIsKnownToRunJoinsEverythingElse() {
        val landing = "0195c0de-0000-7000-8000-0000000000ff"
        val tree = OrbitExchangeFold.tree(listOf(Ex(1, OrbitExchangeFold.Target("SESSION", landing, "Land · B1")), Ex(2, task(b1)),
            Ex(3, OrbitExchangeFold.Target("SESSION", landing))), { it.target }, lookup)!!
        assertEquals(listOf("B1" to listOf(2L), OrbitExchangeFold.otherBranch to listOf(1L, 3L)), tree.map { it.title to it.exchanges.map { e -> e.seq } })
    }

    @Test fun aGroupAboutOneThingIsNoTree() {
        assertNull(OrbitExchangeFold.tree(listOf(Ex(1, task(b1)), Ex(2, task(b1))), { it.target }, lookup))
        assertNull(OrbitExchangeFold.tree(listOf(Ex(1, null), Ex(2, null)), { it.target }, lookup))
        assertEquals("Task 00000011", OrbitExchangeFold.tree(listOf(Ex(1, task(b1)), Ex(2, null)), { it.target }, OrbitExchangeFold.NoLookup)!!.first().title)
    }

    @Test fun prerequisitesAreReadOffTheGraphsMarks() {
        val graph = Wire.json.parseToJsonElement("""{"marks":[
            {"kind":"TASK","id":"m1","taskId":"$b1","title":"B1","status":"DONE","parentTaskId":null},
            {"kind":"RUN","id":"m2","title":"run","taskCount":2,"statusCounts":{},"parentTaskId":null,"expandable":true,
             "members":[{"taskId":"$b4","title":"B4","status":"DONE"},{"taskId":"$b4b","title":"B4b","status":"OPEN"}]},
            {"kind":"TASK","id":"m3","taskId":"$b5","title":"B5","status":"OPEN","parentTaskId":null}],
          "edges":[{"sourceMarkId":"m1","targetMarkId":"m2"},{"sourceMarkId":"m2","targetMarkId":"m3"}],
          "taskCount":4,"folded":true,"truncated":false}""").jsonObject
        val (upstream, titles) = OrbitExchangeFold.upstreamFromGraph(graph)
        assertEquals(listOf(b1), upstream(b4))
        assertEquals(listOf(b4), upstream(b4b))
        assertEquals(listOf(b4b), upstream(b5))
        assertEquals(emptyList<String>(), upstream(b1))
        assertEquals("B4b", titles(b4b))
        assertEquals(emptyList<String>(), OrbitExchangeFold.upstreamFromGraph(null).first(b4))
    }
}
