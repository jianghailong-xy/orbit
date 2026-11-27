package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/** The Android project page held to the shared fixtures every client reads (project "Project page and coordinator cards: iOS/web/Android
 * parity", D2 A, D4 A, G1/G2, G4/G5) — the same cases web's `ProjectPageLabels.fixture.test.tsx` and `projectDone.unmetCounts.test.tsx`
 * and OrbitKit's `ProjectPageParityFixtureTests` assert:
 *
 * - `src/shared/src/project-page-labels.fixture.json`: a criterion's landing half-sentence, receipt times, and the task rows' stalled and
 *   start-by-hand labels;
 * - `contracts/unmet-criteria-counts.fixtures.json`: the Done tallies and the Record as done confirmation counting unmet criteria apart.
 *
 * A missing fixture is a failure, never a skip. */
class ProjectPageLabelsFixtureTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/shared/src/project-page-labels.fixture.json").isFile }
    private fun json(relative: String) = Json.parseToJsonElement(File(root, relative).readText()).jsonObject
    private val labels = json("src/shared/src/project-page-labels.fixture.json")
    private fun JsonObject.cases() = getValue("cases").jsonArray.map { it.jsonObject }
    private fun JsonElement?.textOrNull() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    @Test fun theLandingHalfSentenceReadsTheLandingReason() {
        val landing = labels.getValue("landing").jsonObject
        val main = landing.text("main")!!
        val cases = landing.cases()
        assertEquals(8, cases.size)
        cases.forEachIndexed { index, c ->
            val name = c.text("name")!!
            val criterion = c.getValue("criterion").jsonObject
            val expected = c["expected"].textOrNull()
            // As the server serves it: the item without its reason, the reason on the done read.
            val item = buildJsonObject {
                put("id", "c$index"); put("ordinal", index + 1); put("text", "Criterion $name")
                criterion.filterKeys { it != "landingReason" }.forEach { (k, v) -> put(k, v) }
            }
            val derivedDone = buildJsonObject {
                putJsonArray("criteria") { addJsonObject {
                    put("definitionId", "c$index"); put("satisfied", criterion.getValue("satisfied")); put("landing", criterion.getValue("landing"))
                    put("landingReason", criterion.getValue("landingReason"))
                } }
            }
            val joined = ProjectPage.withLandingReasons(listOf(item), derivedDone).single()
            val work = ProjectPage.criterionWork(joined, "project/p", main)!!
            assertEquals(name, expected, work.landing)
            assertNull(name, work.landingWarning)
            assertEquals(name, expected, ProjectPage.criterionLandingHalfSentence(ProjectDoc.satisfied(joined), joined.text("landingReason"), main))
        }
        // No reason read (an older server, a public page): the row keeps the landing lane's words.
        val old = Json.parseToJsonElement("""{"id":"c","satisfied":true,"landing":"UNKNOWN"}""").jsonObject
        assertEquals("no merge receipt either way", ProjectPage.criterionWork(old, null)?.landing)
        assertEquals(old, ProjectPage.withLandingReasons(listOf(old), null).single())
        // A non-code project reads no landing: its rows keep what they always drew.
        val nonCode = Json.parseToJsonElement("""{"nonCode":true,"criteria":[{"definitionId":"c","landingReason":null}]}""").jsonObject
        assertFalse("landingReason" in ProjectPage.withLandingReasons(listOf(old), nonCode).single())
    }

    /** D4 A: the rule every conversation receipt on Android uses (`OwnerReview.receiptTime`), web's `receiptClock` and OrbitKit's
     * `OwnerConfirmations.receiptTime`. */
    @Test fun receiptTimesAddTheDateWhenNotToday() {
        val receipt = labels.getValue("receiptTime").jsonObject
        val now = Instant.parse(receipt.text("now"))
        val zone = ZoneId.of(receipt.text("timeZone"))
        val locale = Locale.forLanguageTag(receipt.text("locale")!!)
        val cases = receipt.cases()
        assertEquals(4, cases.size)
        cases.forEach { c -> assertEquals(c.text("name"), c.text("expected"), OwnerReview.receiptTime(c.text("at")!!, now, zone, locale)) }
    }

    @Test fun theTaskRowsSayStalledAndStartByHand() {
        val cases = labels.getValue("taskRows").jsonObject.cases()
        assertEquals(5, cases.size)
        cases.forEachIndexed { index, c ->
            val name = c.text("name")!!
            val task = JsonObject(c.getValue("task").jsonObject + mapOf("id" to JsonPrimitive("task-$index"), "title" to JsonPrimitive("Task case $index")))
            val expected = c["taskRow"].textOrNull()
            assertEquals(name, expected, ProjectPage.workTag(task)?.text)
            // The row's band does not swallow it: only a tag its heading already says goes.
            assertEquals(name, expected, ProjectPage.rowTags(task, "Tasks", null, null).firstOrNull()?.text)
            (c["runQueue"] as? JsonObject)?.let { queue ->
                val item = JsonObject(queue + mapOf("taskId" to JsonPrimitive("task-$index"), "title" to JsonPrimitive("Task case $index")))
                assertEquals(name, c["runQueueRow"].textOrNull(), ProjectPage.queueRowState(item))
            }
        }
        // A server that sends no reason keeps the words the run queue always drew.
        assertEquals("Work in progress", ProjectPage.queueRowState(Json.parseToJsonElement("""{"taskId":"t","runState":"RUNNING"}""").jsonObject))
        // An older server sends no autoRunWhenReady: that is no claim either way.
        assertEquals("Blocked", ProjectPage.workTag(Json.parseToJsonElement("""{"workState":"BLOCKED"}""").jsonObject)?.text)
        // Web's words for the same two labels.
        assertEquals(true, File(root, "src/web/src/lib/projectDependencyGraph.ts").readText().contains("export const RUN_STALLED = '${ProjectPage.runStalled}';"))
        assertEquals(true, File(root, "src/web/src/lib/projectStart.ts").readText().contains("export const PROJECT_TASK_STARTS_BY_HAND = '${ProjectPage.startsByHand}';"))
    }

    @Test fun theDoneTalliesAndTheRecordAsDoneConfirmationCountUnmetCriteriaApart() {
        val fixture = json("contracts/unmet-criteria-counts.fixtures.json")
        val project = fixture.getValue("project").jsonObject
        val main = project.text("main")!!
        val expect = fixture.getValue("expect").jsonObject
        val text = expect.getValue("text").jsonObject
        val criteria = fixture.getValue("criteria").jsonArray.map { it.jsonObject }
        fun derived(extra: List<JsonObject> = emptyList()) = buildJsonObject {
            put("status", "OPEN"); put("done", expect.getValue("done")); put("withheld", expect.getValue("withheld"))
            put("confirmation", project.getValue("confirmation")); put("nonCode", false); put("counts", expect.getValue("counts"))
            putJsonArray("criteria") {
                criteria.forEach { c -> addJsonObject {
                    put("definitionId", "c${c.number("ordinal")}"); put("satisfied", c.getValue("satisfied")); put("landing", c.getValue("landing"))
                    put("landingReason", c.getValue("landingReason"))
                } }
                extra.forEach { add(it) }
            }
        }
        val doc = buildJsonObject {
            put("id", "p-handoff-v2"); put("title", project.getValue("title")); put("status", "OPEN")
            putJsonObject("integration") { put("upstreamRef", main); put("locked", false) }
            putJsonArray("acceptanceCriteriaItems") { criteria.forEach { c -> addJsonObject {
                put("id", "c${c.number("ordinal")}"); put("ordinal", c.getValue("ordinal")); put("text", "Criterion ${c.number("ordinal")}")
                put("satisfied", c.getValue("satisfied")); put("landing", c.getValue("landing"))
            } } }
            put("derivedDone", derived())
        }
        val counts = ProjectDone.counts(doc)!!
        assertEquals(text.text("doneTally"), ProjectDone.tally(counts, main))
        assertEquals(text.text("doneCardTally"), ProjectDone.cardTally(counts, main))
        assertEquals(text.text("whyNotDoneTally"), ProjectDone.whyNotDoneTally(doc))
        val running = ProjectDone.runningCount(doc)
        assertEquals(expect.number("running"), running)
        assertEquals(text.text("orbitChecked"), ProjectDone.orbitCheckedLine(counts, null, 0, running))
        assertEquals(true, text.text("doneCardTally")!!.contains("${expect.number("notMet")} not met"))
        // An unmet criterion landing right now is still running, though byReason leaves it out.
        val unmetInFlight = buildJsonObject { put("definitionId", "c6"); put("satisfied", false); put("landing", "UNKNOWN"); put("landingReason", "IN_FLIGHT") }
        assertEquals(running + 1, ProjectDone.criteriaInFlightCount(derived(listOf(unmetInFlight))))
        // A criterion waiting for a confirmation is counted by its own part, never twice.
        assertEquals("1 met · 0 landed on main · 3 not met · 1 wait for confirmation", ProjectDone.cardTally(counts, main, waitingConfirmation = 1))

        // The page's Record as done confirmation says the Done tally, never "with no merge receipt".
        val confirmation = ProjectPage.confirmMessage("DONE", doc, null)
        assertEquals(text.text("doneTally"), confirmation)
        val landingWords = Regex("merged outside Orbit|ran without a branch|no code to land|nothing to land|no merge receipt", RegexOption.IGNORE_CASE)
        (text.values.map { (it as JsonPrimitive).content } + confirmation).forEach { line -> assertNull(line, landingWords.find(line)) }
    }
}
