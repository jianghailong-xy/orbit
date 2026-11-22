package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The folded Background row draws what the shared rule says (board v2, project 34yq7HVPsPDGBiMEm8sL2). `BackgroundRow` is a hand
 * copy of @orbit/shared `backgroundRow.ts`, and `src/shared/src/background-row.fixture.json` is the contract: backgroundRow.spec.ts
 * proves the browser's rule against it, OrbitKit's BackgroundRowRuleParityTests the native one, and this proves Android's against
 * the same file, case by case. A missing fixture is a failure, never a skip.
 */
class BackgroundRowParityTest {
    private val fixture: JsonObject by lazy {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, FIXTURE) }.firstOrNull { it.isFile }
        assertNotNull("$FIXTURE was not found above ${System.getProperty("user.dir")}. The Background row is drawn the same way on " +
            "every client only while all of them read this file; if it moved, move this check with it rather than deleting it.", file)
        Wire.json.parseToJsonElement(file!!.readText()).jsonObject
    }
    private val cases get() = fixture["cases"]!!.jsonArray.map { it.jsonObject }
    private fun clearedAt(c: JsonObject) = BackgroundRow.clearedAt(c["lastUserMessageAt"].text(), c["lastAgentTurnStartedAt"].text())
    private fun JsonElement?.text() = (this as? JsonPrimitive)?.contentOrNull

    private fun item(o: JsonObject) = BackgroundRow.Item(o["id"].text()!!, o["name"].text()!!,
        BackgroundRow.Truncate.valueOf(o["truncate"].text()!!.uppercase()), BackgroundRow.Mark.valueOf(o["mark"].text()!!.uppercase()))

    /** The fixture's `expect`, in Android's types. */
    private fun expected(e: JsonObject): BackgroundRow.Row? {
        if (e["hidden"]?.jsonPrimitive?.boolean == true) return null
        val n = e["name"]!!.jsonObject
        val name = when (n["mode"].text()) {
            "one" -> BackgroundRow.Name.One(item(n["item"]!!.jsonObject))
            "rotate" -> BackgroundRow.Name.Rotate(n["items"]!!.jsonArray.map { item(it.jsonObject) }, n["perNameMs"]!!.jsonPrimitive.int,
                n["changeMs"]!!.jsonPrimitive.int)
            else -> error("unknown mode ${n["mode"]}")
        }
        return BackgroundRow.Row(e["label"].text()!!, name,
            e["countParts"]!!.jsonArray.map { BackgroundRow.CountPart(it.jsonObject["kind"].text()!!, it.jsonObject["text"].text()!!) },
            e["countLine"].text(), e["accessibilityLabel"].text()!!)
    }

    @Test fun everyCaseDrawsTheFoldedRowTheFixtureSays() {
        assertTrue("the fixture lost its cases", cases.size >= 15)
        for (c in cases) {
            val list = c["list"]!!.jsonArray.map { it.jsonObject }
            val live = c["sessionLive"]!!.jsonPrimitive.boolean
            assertEquals(c["case"].text(), expected(c["expect"]!!.jsonObject), BackgroundRow.rowOf(list, clearedAt(c), live))
        }
    }

    @Test fun everyRuleHasACaseAndTheConstantsAreTheFixtures() {
        val rules = fixture["rules"]!!.jsonObject.keys
        val covered = cases.flatMap { c -> c["covers"]!!.jsonArray.map { it.text()!! } }.toSet()
        assertEquals(rules, covered)
        val rotation = fixture["rotation"]!!.jsonObject
        assertEquals(rotation["perNameMs"]!!.jsonPrimitive.int, BackgroundRow.ROTATE_PER_NAME_MS)
        assertEquals(rotation["changeMs"]!!.jsonPrimitive.int, BackgroundRow.ROTATE_CHANGE_MS)
        assertEquals(3000, BackgroundRow.ROTATE_PER_NAME_MS)
        assertEquals(300, BackgroundRow.ROTATE_CHANGE_MS)
    }

    /** "notLive": a session that is not live keeps no running item, whatever its list last said. */
    @Test fun aSessionThatIsNotLiveDropsItsStaleRunningItems() {
        val stale = cases.filter { c -> c["covers"]!!.jsonArray.any { it.text() == "notLive" } && !c["sessionLive"]!!.jsonPrimitive.boolean }
            .filter { c -> c["list"]!!.jsonArray.any { it.jsonObject["status"].text() == "running" } }
        assertTrue("no case of a not-live session with a running item", stale.isNotEmpty())
        for (c in stale) {
            val list = c["list"]!!.jsonArray.map { BackgroundRow.Input.of(it.jsonObject) }
            assertTrue(c["case"].text(), BackgroundRow.shown(list, clearedAt(c), sessionLive = false).first.isEmpty())
        }
    }

    @Test fun theCutOffIsTheLaterOfTheTwo() {
        assertNull(BackgroundRow.clearedAt(null, null))
        assertEquals("2026-11-16T02:40:00.000Z", BackgroundRow.clearedAt("2026-11-16T02:40:00.000Z", null))
        assertEquals("2026-11-16T02:41:00.000Z", BackgroundRow.clearedAt(null, "2026-11-16T02:41:00.000Z"))
        assertEquals("2026-11-16T02:42:00.000Z", BackgroundRow.clearedAt("2026-11-16T02:42:00.000Z", "2026-11-16T02:41:00.000Z"))
    }

    private companion object { const val FIXTURE = "src/shared/src/background-row.fixture.json" }
}
