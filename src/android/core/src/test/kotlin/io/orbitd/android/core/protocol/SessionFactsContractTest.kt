package io.orbitd.android.core.protocol

import java.io.File
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Plan step 5.4: the Android decode of the session facts against contracts/session-state.contract.json, with defaults and unknown words. */
class SessionFactsContractTest {
    private val contract = run {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "contracts/session-state.contract.json").isFile }
        Json.parseToJsonElement(File(root, "contracts/session-state.contract.json").readText()).jsonObject
    }

    @Test fun everyContractVectorDecodesToItsExpectedFacts() {
        val vectors = contract["vectors"]!!.jsonArray.map { it.jsonObject }
        assertTrue(vectors.isNotEmpty())
        for (v in vectors) {
            val expect = v["expect"]!!.jsonObject
            val row = JsonObject(expect + ("id" to JsonPrimitive("s")) + ("status" to JsonPrimitive("AWAITING_INPUT")))
            assertEquals(v.toString(), expect["phase"]!!.jsonPrimitive.content, SessionFacts.phase(row))
            assertEquals(v.toString(), expect["released"]!!.jsonPrimitive.boolean, SessionFacts.released(row))
            assertEquals(v.toString(), expect["lastTurnOutcome"]!!.jsonPrimitive.contentOrNull, SessionFacts.lastTurnOutcome(row))
            assertEquals(v.toString(), expect["waitingOn"]!!.jsonPrimitive.contentOrNull, SessionFacts.waitingOn(row))
            assertTrue(SessionFacts.present(row))
            val dto = Wire.decode(row.toString().encodeToByteArray(), SessionSummary.serializer())
            assertEquals(expect["phase"]!!.jsonPrimitive.content, dto.phase)
            assertEquals(expect["released"]!!.jsonPrimitive.boolean, dto.released)
        }
    }

    @Test fun theWordListsMatchTheContract() {
        val fields = contract["fields"]!!.jsonObject
        for ((name, read) in mapOf<String, (JsonObject) -> String?>("phase" to SessionFacts::phase, "lastTurnOutcome" to SessionFacts::lastTurnOutcome,
            "waitingOn" to SessionFacts::waitingOn)) {
            for (word in fields[name]!!.jsonObject["values"]!!.jsonArray.map { it.jsonPrimitive.content })
                assertEquals("$name $word", word, read(buildJsonObject { put(name, word) }))
        }
    }

    @Test fun aRowFromAnOlderServerHasNoFactsAndDecodes() {
        val row = buildJsonObject { put("id", "s"); put("status", "SUCCEEDED") }
        assertFalse(SessionFacts.present(row))
        assertNull(SessionFacts.phase(row)); assertNull(SessionFacts.released(row)); assertNull(SessionFacts.waitingOn(row))
        val dto = Wire.decode(row.toString().encodeToByteArray(), SessionSummary.serializer())
        assertNull(dto.phase); assertNull(dto.released); assertNull(dto.workFinished)
    }

    @Test fun anUnknownPhaseAndWaitingOnWordReadAsAbsentAndNeverCrashADecode() {
        val json = """[{"id":"s","status":"RUNNING","phase":"HIBERNATING","released":false,"waitingOn":"ROBOT","lastTurnOutcome":"EXPLODED"}]"""
        val row = Wire.decode(json.encodeToByteArray(), ListSerializer(SessionSummary.serializer())).single()
        assertEquals("HIBERNATING", row.phase)
        val obj = Json.parseToJsonElement(json).jsonArray.single().jsonObject
        assertNull(SessionFacts.phase(obj)); assertNull(SessionFacts.waitingOn(obj)); assertNull(SessionFacts.lastTurnOutcome(obj))
        assertEquals(false, SessionFacts.released(obj))
    }

    @Test fun finishedReadsWorkFinishedElseTheEndReason() {
        fun row(s: String) = Json.parseToJsonElement(s).jsonObject
        assertTrue(SessionFacts.finished(row("""{"released":true,"workFinished":true}""")))
        assertFalse(SessionFacts.finished(row("""{"released":true,"workFinished":false,"endReason":"task_done"}""")))
        assertTrue(SessionFacts.finished(row("""{"released":true,"endReason":"task_done"}""")))
        assertFalse(SessionFacts.finished(row("""{"released":true,"endReason":"ended"}""")))
    }
}
