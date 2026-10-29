package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The delivery mode (§10.5 O-L1/O-L2, A-Q21) in the start card's and How it runs' logic, as the browser's `startDraftOf`,
 * `startBody`, `startComesToYou` and `runSettingsWrites` have it: what a card opens on, what a press sends — the sheets' and the
 * conversation's alike — what still comes to the owner, and what a write carries. */
class DeliveryModeTest {
    private val project = "34noHniU4wmCRkZJkR6df"
    private val seal = "d".repeat(64)
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun request(line: String) = StartProjectCopy.Request(StartProjectCopy.Settings(line, "refs/heads/project/$project", true, 2, null), "", seal)
    /** The integration read: [mode] null is a server that predates the choice. */
    private fun view(mode: String?, line: String? = "MAIN") = buildJsonObject {
        put("line", line?.let(::JsonPrimitive) ?: JsonNull); put("locked", false); put("repository", "acme/payments-api"); put("upstreamRef", "main")
        mode?.let { put("deliveryMode", it) }
    }

    @Test fun theCardOpensOnWhatTheProjectChoseWhereItCanHold() {
        assertNull("a read that says no mode offers no choice", StartProjectCopy.Draft.of(request("MAIN").settings, view(null)).deliveryMode)
        assertNull(StartProjectCopy.Draft.of(request("MAIN").settings).deliveryMode)
        assertEquals("PLATFORM", StartProjectCopy.Draft.of(request("MAIN").settings, view("PLATFORM")).deliveryMode)
        val pushes = StartProjectCopy.Draft.of(request("MAIN").settings, view("AGENT_PUSH"))
        assertEquals("AGENT_PUSH", pushes.deliveryMode); assertTrue(pushes.agentPushes)
        // Off a main line the agent cannot push: the card opens on Orbit's way.
        val branch = StartProjectCopy.Draft.of(request("PROJECT_BRANCH").settings, view("AGENT_PUSH"))
        assertEquals("PLATFORM", branch.deliveryMode); assertFalse(branch.agentPushes)
        assertFalse("a way chosen on main is not the agent's once the line moves", pushes.copy(line = "PROJECT_BRANCH").agentPushes)
        assertEquals("AGENT_PUSH", RunSettings.delivery("MAIN", "AGENT_PUSH"))
        listOf("PROJECT_BRANCH", null).forEach { assertEquals("PLATFORM", RunSettings.delivery(it, "AGENT_PUSH")) }
        assertEquals("PLATFORM", RunSettings.delivery("MAIN", null))
    }

    /** The way rides with a main line only — the door refuses the agent's anywhere else — and a card that offered none records none.
     * The conversation's press sends what the sheets' sends, through the card actions. */
    @Test fun aPressSendsTheWayWithAMainLineOnly() {
        val pushes = StartProjectCopy.Draft("MAIN", true, 2, deliveryMode = "AGENT_PUSH")
        assertEquals(JsonPrimitive("AGENT_PUSH"), StartProjectCopy.body(request("MAIN"), pushes, null)["deliveryMode"])
        assertEquals(JsonPrimitive("PLATFORM"), StartProjectCopy.body(request("MAIN"), pushes.copy(deliveryMode = "PLATFORM"), null)["deliveryMode"])
        assertFalse(StartProjectCopy.body(request("MAIN"), pushes.copy(deliveryMode = null), null).containsKey("deliveryMode"))
        assertFalse(StartProjectCopy.body(request("PROJECT_BRANCH"), pushes.copy(line = "PROJECT_BRANCH"), null).containsKey("deliveryMode"))

        val row = j("""{"itemId":"item-1","kind":"START_REQUEST","assignee":"OWNER","waitingSince":"2026-10-29T01:00:00.000Z","actions":[],
            "startRequest":{"settings":{"line":"MAIN","automatic":true,"maxConcurrentTasks":2,"mergeCheckCommand":null},"why":"",
            "criteriaDigest":"$seal","planDigest":"pp"}}""")
        val document = j("""{"id":"$project","title":"Landing observation","startedAt":null,"acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"Done."}]}""")
        val reads = mapOf<String, JsonElement>("project" to document, "openItems" to j("""{"needsYou":[],"withCoordinator":[],"startRequest":$row}"""),
            "acceptanceConfirmation" to j("""{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"$seal","material":[]}}"""))
        val card = CardCatalog.project("s1", project, reads).single { it.family == CardFamily.START }
        val asked = StartProjectCopy.request(row)!!
        for (draft in listOf(pushes, pushes.copy(deliveryMode = "PLATFORM"), pushes.copy(deliveryMode = null), pushes.copy(line = "PROJECT_BRANCH"))) {
            val sent = CardRequests.build(card, CardVerb.START, CardInput(settings = ProjectStartSettings(draft.line, draft.automatic, draft.maxConcurrentTasks,
                draft.mergeCheckCommand, asked.settings.projectBranchName, deliveryMode = draft.deliveryMode)))
            assertEquals(listOf("projects", project, "start"), sent.path)
            assertEquals(StartProjectCopy.body(asked, draft, "item-1"), Json.parseToJsonElement(sent.body!!.decodeToString()).jsonObject)
        }
    }

    /** O-L2: an agent that pushes its own work to main asks nobody to merge it — no merge comes to the owner, and the sentence under
     * the switch says who pushes instead. */
    @Test fun noMergeIntoMainComesToYouWhereTheAgentPushes() {
        assertEquals(listOf("Any change to the criteria", "Problems it can’t resolve within 2 h"),
            StartProjectCopy.comesToYou(true, "MAIN", emptyList(), 0, 7_200, "main", "AGENT_PUSH").map { it.text })
        assertEquals(listOf("Whether each task is done", "Problems along the way", "Any change to the criteria"),
            StartProjectCopy.comesToYou(false, "MAIN", emptyList(), 0, 7_200, "main", "AGENT_PUSH").map { it.text })
        assertEquals("Orbit's way keeps the merge", "Each merge into master",
            StartProjectCopy.comesToYou(true, "MAIN", emptyList(), 0, 7_200, "master", "PLATFORM").first().text)
        assertEquals("The coordinator decides when each task is done. The agent pushes each task’s work to master itself.",
            RunSettings.automaticSaysAgentPush(true, "master"))
        assertEquals("You decide when each task is done. The agent pushes each task’s work to main itself.", RunSettings.automaticSaysAgentPush(false))
    }

    /** How it runs writes the way at once, only where it can hold, and not to a server that reports none; a line moved off main
     * while the agent pushes takes the way back to Orbit's in the same write, as the door asks. */
    @Test fun howItRunsWritesTheWayWhereItCanHoldAndALineOffMainTakesItBack() {
        assertEquals(j("""{"deliveryMode":"AGENT_PUSH"}"""), RunSettings.deliveryWrite(view("PLATFORM"), "AGENT_PUSH"))
        assertEquals(j("""{"deliveryMode":"PLATFORM"}"""), RunSettings.deliveryWrite(view("AGENT_PUSH"), "PLATFORM"))
        assertNull("nothing moves", RunSettings.deliveryWrite(view("PLATFORM"), "PLATFORM"))
        assertNull("the agent pushes only on a main line", RunSettings.deliveryWrite(view("PLATFORM", line = "PROJECT_BRANCH"), "AGENT_PUSH"))
        assertNull("nor on a line nobody decided", RunSettings.deliveryWrite(view("PLATFORM", line = null), "AGENT_PUSH"))
        assertNull("an older server is sent none", RunSettings.deliveryWrite(view(null), "AGENT_PUSH"))
        assertEquals(j("""{"line":"PROJECT_BRANCH","deliveryMode":"PLATFORM"}"""), RunSettings.lineWrite(view("AGENT_PUSH"), "PROJECT_BRANCH"))
        assertEquals(j("""{"line":"PROJECT_BRANCH"}"""), RunSettings.lineWrite(view("PLATFORM"), "PROJECT_BRANCH"))
        assertEquals(j("""{"line":"MAIN"}"""), RunSettings.lineWrite(view("PLATFORM", line = "PROJECT_BRANCH"), "MAIN"))
    }
}
