package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Holds `TaskProgressCopy` to the golden table web and iOS answer to (`src/shared/src/taskProgressCopy.golden.json`,
 * asserted by taskProgressCopy.spec.ts and OrbitKit's TaskProgressCopyParityTests): a missing table fails, never skips.
 */
class TaskProgressCopyParityTest {
    private val golden: JsonObject by lazy {
        val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/taskProgressCopy.golden.json") }.firstOrNull { it.isFile }
        assertNotNull("src/shared/src/taskProgressCopy.golden.json was not found above the test's working directory", file)
        Wire.json.parseToJsonElement(file!!.readText()).jsonObject
    }
    private fun JsonElement?.text() = (this as? JsonPrimitive)?.contentOrNull

    @Test fun everyCaseOfTheGoldenTable() {
        val cases = golden["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue("the table lost its cases", cases.size >= 4)
        for (case in cases) {
            val name = case["name"].text()
            val p = TaskProgress.from(case["progress"]) ?: error("$name: progress did not parse")
            assertEquals(name, case["badge"].text(), TaskProgressCopy.badge(p))
            assertEquals(name, case["trayLine"].text(), TaskProgressCopy.trayLine(p))
            assertEquals(name, case["footer"].text(), TaskProgressCopy.footer(p))
            val groups = TaskProgressCopy.phaseGroups(p)
            val expected = case["groups"]!!.jsonArray.map { it.jsonObject }
            assertEquals(name, expected.size, groups.size)
            groups.zip(expected).forEach { (g, e) ->
                assertEquals(name, e["title"].text(), g.title)
                assertEquals(name, e["done"].text()?.toInt(), g.done)
                assertEquals(name, e["total"].text()?.toInt(), g.total)
                val rows = e["agents"]!!.jsonArray.map { it.jsonObject }
                assertEquals(name, rows.size, g.agents.size)
                g.agents.zip(rows).forEach { (a, row) ->
                    assertEquals(name, row["label"].text(), a.label)
                    assertEquals("$name · ${a.label}", row["lane"].text(), TaskProgressCopy.lane(a).name.lowercase())
                    assertEquals("$name · ${a.label}", row["detail"].text(), TaskProgressCopy.detail(a))
                    assertEquals("$name · ${a.label}", row["now"].text(), TaskProgressCopy.now(a))
                }
            }
        }
    }

    @Test fun durations() {
        val rows = golden["durations"]!!.jsonArray
        assertTrue(rows.isNotEmpty())
        rows.forEach { row -> assertEquals(row.jsonArray[1].text(), TaskProgressCopy.duration(row.jsonArray[0].text()!!.toInt())) }
    }

    @Test fun workflowTitles() {
        val rows = golden["titles"]!!.jsonArray.map { it.jsonObject }
        assertTrue(rows.isNotEmpty())
        rows.forEach { t ->
            val progress = t["progressDescription"].text()?.let { TaskProgress.from(buildJsonObject { put("toolUseId", "x"); put("description", it) }) }
            assertEquals(t["name"].text(), t["title"].text(), TaskProgressCopy.workflowTitle(t["input"], t["result"].text(), progress))
        }
    }

    /** A06-6: each workflow agent names the Agent call its activity is nested under. */
    @Test fun agentsCarryTheirTranscriptKey() {
        val p = TaskProgress.from(Wire.json.parseToJsonElement(
            """{"toolUseId":"wf","agents":[{"index":0,"label":"design","transcriptKey":"toolu_agent","model":"opus","state":"running"}]}"""))!!
        assertEquals("toolu_agent", p.agents.single().transcriptKey)
        assertEquals("opus", p.agents.single().model)
    }
}
