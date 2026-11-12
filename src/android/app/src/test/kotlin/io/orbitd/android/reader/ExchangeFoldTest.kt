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

    @Test fun aBackgroundJobFoldsOnlyInACoordinator() {
        fun job(id: String, name: String) = listOf(
            "<background-job-wake>",
            "  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:",
            "    $id｜query｜bash q.sh｜$name",
            "      ended｜completed｜exit code 0",
            "  The control plane recorded this for you; the user did not write it.",
            "</background-job-wake>",
        ).joinToString("\n").let { wake -> buildJsonObject { put("text", wake); put("controlPlaneNote", wake) } }
        fun turns(): Array<List<RunEvent>> {
            seq = 0; turn = 0
            return arrayOf(
                exchange(said("Why is 11-10 not ready?"), "I started a query.", emptyList()),
                exchange(job("bgj_1", "Ledger split by lane"), "Waiting on one more reading.", listOf("mcp__orbit__bg_output")),
                exchange(job("bgj_2", "Read the ready script"), "Found it: the job waits on lane 7.", listOf("mcp__orbit__bg_output")),
                exchange(delivery("EVIDENCE_SUBMITTED", b1, "B1 Targeted hints", 1), "I confirmed B1."),
                exchange(job("bgj_3", "Clean up"), "Done.", listOf("mcp__orbit__bg_output")),
            )
        }
        fun fold(coordinator: Boolean) = ExchangeFold.fold(Steps.group(transcriptRows(turns().toList().flatten())), coordinator = coordinator)

        // Anywhere but a coordinator a job's turns are the agent's answer to the reader (owner, 2026-11-12); what is not a job still folds.
        val plain = fold(coordinator = false)
        assertTrue(texts(plain).containsAll(listOf("Waiting on one more reading.", "Found it: the job waits on lane 7.")))
        assertEquals(listOf(listOf("I confirmed B1.")), plain.filter { it.exchanges.isNotEmpty() }.map { r -> r.exchanges.map { it.summary.reply } })

        val coordinated = fold(coordinator = true)
        assertEquals(listOf("job", "job", "evidence"), coordinated.single { it.exchanges.isNotEmpty() }.exchanges.map { it.summary.category })
        assertFalse(texts(coordinated).any { it.startsWith("Found it") })
    }

    @Test fun theNewestTurnNeverFolds() {
        val shown = rows(exchange(said("hi"), "Hello.", emptyList()), exchange(delivery("EVIDENCE_SUBMITTED", b1, "B1", 1), "I confirmed B1."))
        assertTrue(shown.none { it.exchanges.isNotEmpty() })
    }
}
