package io.orbitd.android.reader

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Which turns the reader folds, over the rows it draws (web Transcript.orbitFold.test.tsx): a run of turns Orbit opened is one row; what
 * the reader said, the newest turn, a turn nobody answered, and anything that went wrong or asks the reader stay as they were.
 */
class ExchangeFoldTest {
    private val b1 = "0195c0de-0000-7000-8000-000000000011"
    private val b4 = "0195c0de-0000-7000-8000-000000000014"
    private var seq = 0L
    private var turn = 0

    private fun delivery(kind: String, task: String, title: String, revision: Int? = null) = buildJsonObject {
        put("text", "From Orbit · project “Link” has news about $title")
        putJsonObject("coordinatorDelivery") {
            put("kind", kind); putJsonObject("task") { put("id", task); put("title", title) }
            put("revision", revision?.let(::JsonPrimitive) ?: JsonNull); put("count", JsonNull); put("deliveredAt", "2026-11-11T09:00:00Z")
        }
    }
    private fun said(text: String) = buildJsonObject { put("text", text) }

    /** One turn: its opening message, a call (or [tools]), and the answer, as the runner records them. */
    private fun exchange(opening: JsonObject, reply: String?, tools: List<String> = listOf("mcp__orbit__task_get")): List<RunEvent> {
        val id = "turn-${++turn}"
        val out = mutableListOf(RunEvent("user", ++seq, opening, id))
        tools.forEach { name ->
            val call = ++seq
            out += RunEvent("tool_use", call, buildJsonObject { put("id", "t$call"); put("name", name); putJsonObject("input") {} }, id)
            out += RunEvent("tool_result", ++seq, buildJsonObject { put("toolUseId", "t$call"); put("content", "ok") }, id)
        }
        reply?.let { out += RunEvent("assistant", ++seq, buildJsonObject { put("text", it) }, id) }
        out += RunEvent("turn_end", ++seq, buildJsonObject { }, id)
        return out
    }
    private fun rows(vararg turns: List<RunEvent>) = ExchangeFold.fold(Steps.group(transcriptRows(turns.toList().flatten())))
    private fun texts(rows: List<TranscriptRow>) = rows.filter { it.exchanges.isEmpty() }.map { it.event.body() }

    @Test fun aRunOfOrbitsTurnsIsOneRowAndTheReadersAndTheNewestStay() {
        val shown = rows(
            exchange(said("Which tasks are waiting on me?"), "None right now.", emptyList()),
            exchange(delivery("EVIDENCE_SUBMITTED", b1, "B1 Targeted hints", 2), "我确认了 B1（[定向提示](orbit-task:x)），它正在落地。\n\n**依据**"),
            exchange(delivery("DEPENDENT_READY", b4, "B4 Link gateway"), "B4 已经开工。"),
            exchange(said("Why was B4b sent back?"), "It conflicts with B5.", emptyList()),
            exchange(delivery("EVIDENCE_SUBMITTED", b4, "B4 Link gateway", 1), "I confirmed B4."),
        )
        val folds = shown.filter { it.exchanges.isNotEmpty() }
        assertEquals(1, folds.size)
        val group = folds.single()
        assertEquals(ExchangeFold.TYPE, group.event.type)
        assertEquals(listOf("Evidence revision 2 submitted: B1 Targeted hints", "Can start now: B4 Link gateway"), group.exchanges.map { it.summary.what })
        assertEquals("我确认了 B1（定向提示），它正在落地。", group.exchanges.first().summary.reply)
        assertTrue("the fold holds what it folds", group.contains(group.exchanges.last().summary.lastSeq))
        assertTrue(texts(shown).containsAll(listOf("Which tasks are waiting on me?", "Why was B4b sent back?", "It conflicts with B5.", "I confirmed B4.")))
        assertFalse(texts(shown).any { it.startsWith("我确认了") })
    }

    @Test fun whatWentWrongWhatAsksTheReaderAndWhatNobodyAnsweredStay() {
        val shown = rows(
            exchange(delivery("PROJECT_BLOCKER_RAISED", b1, "B1 Targeted hints"), "B1 stopped; restarting it."),
            exchange(delivery("EVIDENCE_SUBMITTED", b4, "B4 Link gateway", 1), "Need your call on B4.", listOf("mcp__orbit__ask_owner")),
            exchange(delivery("EVIDENCE_SUBMITTED", b1, "B1 Targeted hints", 3), null),
            exchange(delivery("EVIDENCE_SUBMITTED", b1, "B1 Targeted hints", 4), "I confirmed B1.", emptyList()),
            exchange(said("ok"), "Done.", emptyList()),
        )
        assertTrue(texts(shown).containsAll(listOf("B1 stopped; restarting it.", "Need your call on B4.")))
        // The one nobody answered is still its own line; the one that is none of these folds alone.
        assertEquals(1, shown.count { it.exchanges.isNotEmpty() })
        assertEquals("Evidence revision 4 submitted: B1 Targeted hints", shown.single { it.exchanges.isNotEmpty() }.exchanges.single().summary.what)
        assertEquals(3, shown.count { it.event.type == "user" && it.event.fields["coordinatorDelivery"] != null })
    }

    @Test fun onlyAShortAnswerFolds() {
        fun job(id: String) = listOf(
            "<background-job-wake>",
            "  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:",
            "    $id｜query｜bash q.sh｜$id",
            "      ended｜completed｜exit code 0",
            "  The control plane recorded this for you; the user did not write it.",
            "</background-job-wake>",
        ).joinToString("\n").let { wake -> buildJsonObject { put("text", wake); put("controlPlaneNote", wake) } }
        val watchId = "0195c0de-0000-7000-8000-0000000000c3"
        val watch = buildJsonObject { put("text", listOf(
            "Orbit Watch $watchId matched at generation 1: SESSION_IDLE 1/1", "",
            "This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:", "",
            "```json",
            buildJsonObject {
                put("watchId", watchId); put("generation", 1)
                putJsonArray("changedTargets") { addJsonObject { put("kind", "SESSION"); put("id", b1); put("state", "IDLE") } }
            }.toString(),
            "```",
        ).joinToString("\n")) }
        val reply = buildJsonObject {
            put("text", ""); putJsonArray("sessionReplies") { addJsonObject { put("requestId", "r"); put("fromSessionId", b1); put("fromTitle", "B1 run"); put("outcome", "REPLIED") } }
        }
        val shown = rows(
            exchange(said("Why is 11-10 not ready?"), "I started a query.", emptyList()),
            exchange(job("bgj_1"), "Still running.", listOf("mcp__orbit__bg_output")),
            exchange(job("bgj_2"), "Found it: " + "the job waits on lane 7, which never arrives. ".repeat(2), listOf("mcp__orbit__bg_output")),
            exchange(watch, "Duplicate wake; " + "nothing new. ".repeat(15)),
            exchange(watch, "B1 landed. " + "All three gates are green on main. ".repeat(7)),
            exchange(reply, "Exempt."),
            exchange(said("ok"), "Done.", emptyList()),
        )
        // Each folds alone (14 and 211 characters): the job's answer of 102 stands between them; the watch's 256 and the reply stay.
        assertEquals(listOf(listOf("job"), listOf("watch")), shown.filter { it.exchanges.isNotEmpty() }.map { r -> r.exchanges.map { it.summary.category } })
        val drawn = texts(shown)
        assertTrue(drawn.any { it.startsWith("Found it:") })
        assertTrue(drawn.any { it.startsWith("B1 landed.") })
        assertTrue(drawn.contains("Exempt."))
        assertFalse(drawn.any { it.startsWith("Duplicate wake") })
    }

    @Test fun theNewestTurnNeverFolds() {
        val shown = rows(exchange(said("hi"), "Hello.", emptyList()), exchange(delivery("EVIDENCE_SUBMITTED", b1, "B1", 1), "I confirmed B1."))
        assertTrue(shown.none { it.exchanges.isNotEmpty() })
    }
}
