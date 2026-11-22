package io.orbitd.android.core.schedule

import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The scheduled tasks say on Android what they say on the web and on OrbitKit (CLAUDE.md §5). The words are defined
 * once, in contracts/schedule.contract.json; this holds `ScheduleCopy` to its `copy`, both ways, its closed sets to the
 * lists the code switches on, and the display rules to its `boardPhrases` — the boards' words with the inputs that must
 * produce them (OrbitKit ScheduleCopyParityTests and ScheduleBoardPhraseTests). A missing contract is a failure, never a
 * skip.
 */
class ScheduleCopyParityTest {
    private val contract: JsonObject by lazy {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "contracts/schedule.contract.json") }.firstOrNull { it.isFile }
            ?: throw AssertionError("contracts/schedule.contract.json was not found above ${File("").absolutePath}. The schedule's " +
                "words are one half of a pair; if the other half moved, move this check with it rather than deleting it.")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun flatten(value: JsonElement, path: String, out: MutableMap<String, String>) {
        when (value) {
            is JsonPrimitive -> if (value.isString) out[path] = value.content else fail("$path is not a sentence")
            is JsonObject -> value.forEach { (k, v) -> flatten(v, if (path.isEmpty()) k else "$path.$k", out) }
            is JsonArray -> value.forEachIndexed { i, v -> flatten(v, "$path.$i", out) }
        }
    }

    @Test fun everySentenceOfTheContractIsHereWordForWord() {
        val flat = mutableMapOf<String, String>()
        flatten(contract.getValue("copy"), "", flat)
        assertTrue("the contract's copy was read", flat.size > 200)
        for ((path, sentence) in flat.toSortedMap()) assertEquals("copy.$path", sentence, ScheduleCopy.contract[path])
        for (path in ScheduleCopy.contract.keys.sorted()) if (path !in flat) fail("ScheduleCopy holds $path, which the contract no longer has")
    }

    @Test fun runStatusCopyMatchesTheContractAndWebSource() {
        val flat = mutableMapOf<String, String>()
        flatten(contract.getValue("runStatusCopy"), "", flat)
        assertEquals(flat, ScheduleRunStatusCopy.contract)

        val webPath = "src/shared/src/schedule.ts"
        val web = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, webPath) }.firstOrNull { it.isFile } ?: error("$webPath is missing")
        val source = web.readText().substringAfter("export const SCHEDULE_RUN_STATUS_COPY = {").substringBefore("} as const;")
        val groupPattern = Regex("""(?m)^  (\w+): \{\n([\s\S]*?)^  },""")
        val wordPattern = Regex("""(?m)^ +(\w+): (['"])(.*)\2,$""")
        val webCopy = mutableMapOf<String, String>()
        for (group in groupPattern.findAll(source)) {
            for (word in wordPattern.findAll(group.groupValues[2])) {
                webCopy["${group.groupValues[1]}.${word.groupValues[1]}"] = word.groupValues[3]
            }
        }
        for (word in wordPattern.findAll(source.replace(groupPattern, ""))) {
            webCopy[word.groupValues[1]] = word.groupValues[3]
        }
        assertEquals(webCopy, ScheduleRunStatusCopy.contract)
    }

    @Test fun everyClosedSetMemberHasItsWords() {
        val sets = contract.getValue("closedSets").jsonObject
        fun list(name: String) = sets[name]?.jsonArray?.map { it.jsonPrimitive.content } ?: run { fail("closedSets.$name"); emptyList() }
        assertEquals(list("runStates").toSet(), ScheduleCopy.runStates.keys)
        assertEquals(list("failureReasons").toSet(), ScheduleCopy.failureReasons.keys)
        assertEquals(list("heldReasons").toSet(), ScheduleCopy.heldReasons.keys)
        assertEquals(list("heldReasons").toSet(), ScheduleCopy.heldShort.keys)
        assertEquals(list("endedReasons").toSet(), ScheduleCopy.endedReasons.keys)
        assertEquals(list("accessLevels").toSet(), ScheduleCopy.access.keys)
        assertEquals(list("envelopeParts").toSet(), ScheduleCopy.EnvelopeCard.titles.keys)
        assertEquals(list("changedBy").toSet(), ScheduleCopy.History.who.keys - "ALLOWED")
        assertEquals(list("weekdays"), ScheduleDisplay.weekdayOrder)
        assertEquals(list("weekdays").toSet(), ScheduleCopy.weekdays.keys)
        assertEquals(list("waitingKinds"), ScheduleWaitingItem.kinds)
        assertEquals(list("circles"), ScheduleDisplay.Circle.entries.map { it.rawValue })
    }

    // boardPhrases

    private fun rows(name: String): List<JsonObject> {
        val rows = contract.getValue("boardPhrases").jsonObject[name]?.jsonArray?.map { it.jsonObject }
        assertNotNull("boardPhrases.$name is missing", rows)
        assertFalse("boardPhrases.$name is empty", rows!!.isEmpty())
        return rows
    }

    private fun JsonObject.str(key: String) = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.int(key: String) = (get(key) as? JsonPrimitive)?.intOrNull
    private fun JsonObject.obj(key: String) = get(key) as? JsonObject
    private fun JsonObject.strings(key: String) = (get(key) as? JsonArray)?.map { it.jsonPrimitive.content }.orEmpty()

    @Test fun rules() {
        for (row in rows("rules")) {
            val rule = ScheduleRule.parse(row["rule"])!!
            val form = if (row.str("form") == "long") ScheduleDisplay.RuleForm.long else ScheduleDisplay.RuleForm.short
            assertEquals(row.str("board"), row.str("text"), ScheduleDisplay.ruleText(rule, form))
        }
    }

    @Test fun costsAllowedUsageAndMay() {
        for (row in rows("costs")) {
            val parts = ScheduleDisplay.costsParts(row.int("runsPerWeek")!!, row.int("runLimitMinutes")!!)
            assertEquals(row.str("text"), parts.text)
            assertEquals(row.str("emphasis"), parts.emphasis)
            assertEquals(parts.text, parts.before + parts.emphasis + parts.after)
        }
        for (row in rows("allowed")) assertEquals(row.str("text"), ScheduleDisplay.allowedText(row.int("runsPerWeek")!!, row.int("runLimitMinutes")!!))
        for (row in rows("usage")) assertEquals(row.str("text"), ScheduleDisplay.usageText(row.int("runs")!!, row.int("minutes")!!))
        for (row in rows("may")) assertEquals(row.str("text"), ScheduleDisplay.mayText(row.str("accessLevel")!!))
    }

    @Test fun envelopeCards() {
        for (row in rows("envelope")) {
            val board = row.str("board")
            val widens = row.strings("widens")
            val now = ScheduleEnvelope.parse(row["now"])
            val asked = ScheduleEnvelope.parse(row["asked"])!!
            val ruleNow = ScheduleRule.parse(row["ruleNow"])
            val ruleAsked = ScheduleRule.parse(row["ruleAsked"])
            val sides = ScheduleDisplay.envelopeSides(widens, now, asked, ruleNow, ruleAsked)
            assertEquals(board, row.str("title"), ScheduleDisplay.envelopeTitle("Codex stable check", widens))
            assertEquals(board, row.str("nowText"), sides.now?.text)
            assertEquals(board, row.str("askedText"), sides.asked.text)
            assertEquals(board, row.str("askedLead"), sides.asked.lead)
            assertEquals(board, row.str("keep"), ScheduleDisplay.keepLabel(widens, now))
            assertEquals(board, row.str("note"), ScheduleDisplay.envelopeNote(widens))
            row.str("waitingReason")?.let { reason ->
                assertEquals(board, row.str("waitingBody"), ScheduleDisplay.widenWaitingText(reason, widens, now, asked, ruleNow, ruleAsked))
            }
        }
    }

    /** The phone's timeline rows (iOS board 01 ② ⑧): `schedulePhoneRowLine`'s phrases. */
    @Test fun phoneRows() {
        for (row in rows("phoneRows")) {
            val s = row.obj("schedule")!!
            val opts = row.obj("opts") ?: JsonObject(emptyMap())
            assertEquals(row.str("board"), row.str("text"), ScheduleDisplay.phoneRowLine(
                rule = ScheduleRule.parse(s["rule"])!!, workspaceName = s.str("workspaceName"),
                accessLevel = s.str("accessLevel") ?: "CHECK_ONLY", state = s.str("state") ?: "ACTIVE", heldReason = s.str("heldReason"),
                runningMinutes = opts.int("runningMinutes"), draft = (opts["draft"] as? JsonPrimitive)?.booleanOrNull ?: false))
        }
    }

    @Test fun historyAndTheChangeLine() {
        for (row in rows("history")) {
            val board = row.str("board")
            val before = row.obj("before")
            val after = row.obj("after")!!
            val revision = row.int("revision") ?: 2
            val changedBy = row.str("changedBy")!!
            assertEquals(board, row.str("text"), ScheduleDisplay.recordParts(revision, before, after).text)
            assertEquals(board, row.str("who"), ScheduleDisplay.historyWho(changedBy, before, after).text)
            row.str("line")?.let { line ->
                val title = row.str("title") ?: "Codex stable check"
                assertEquals(board, line, ScheduleDisplay.changeLineText(title, revision, changedBy, before, after))
            }
        }
    }
}
