package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A coordinator's start request that names no line (contract §12.15 P-M2): the card's settings decode with none, and the start door
 * is answered with no `line` key and nothing only a line means. */
class StartWithoutLineTest {
    /** The shared fixture's start request with `line` (and the branch only a line names) taken out of its settings. */
    private fun withoutLine(): JsonObject {
        val start = fixture().obj("startItem")!!
        val asked = start.obj("startRequest")!!
        val settings = JsonObject(asked.obj("settings")!! - "line" - "projectBranchName")
        return JsonObject(start + ("startRequest" to JsonObject(asked + ("settings" to settings))))
    }
    private fun card(start: JsonObject): InteractionCard {
        val raw = fixture().obj("snapshot")!!
        val standing = raw.obj("standing")!!
        val updated = JsonObject(raw + ("standing" to JsonObject(standing + ("openItems" to JsonObject(standing.obj("openItems")!! + ("startRequest" to start))))))
        return cardList(updated).single { it.family == CardFamily.START }
    }

    @Test fun settingsWithNoLineDecode() {
        val settings = Wire.json.decodeFromJsonElement(ProjectStartSettings.serializer(), withoutLine().obj("startRequest")!!.obj("settings")!!)
        assertNull(settings.line)
        assertEquals(2, settings.maxConcurrentTasks)
        assertEquals("./verify", settings.mergeCheckCommand)
    }

    @Test fun theStartPressSendsNoLine() {
        val card = card(withoutLine())
        assertTrue(CardVerb.START in card.actions)
        // The request's own settings, as a press that brings none of its own answers them.
        val body = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.START).body!!.decodeToString()).jsonObject
        assertFalse(body.containsKey("line"))
        assertFalse(body.containsKey("projectBranchName"))
        assertFalse(body.containsKey("landingCheckCommand"))
        assertFalse(body.containsKey("upstreamRef"))
        assertEquals("seal1", body.text("criteriaDigest")); assertEquals("start1", body.text("requestId"))
        assertEquals("./verify", body.text("mergeCheckCommand"))
        // The card's own press, with the settings it drew (no line, a main branch it does not offer) says the same.
        val pressed = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.START, CardInput(settings = ProjectStartSettings(null, true, 3, "npm test",
            upstreamRef = "refs/heads/main", deliveryMode = "PLATFORM", landingCheckCommand = "npm run check"))).body!!.decodeToString()).jsonObject
        assertFalse(pressed.containsKey("line"))
        assertFalse(pressed.containsKey("upstreamRef"))
        assertFalse(pressed.containsKey("deliveryMode"))
        assertFalse(pressed.containsKey("landingCheckCommand"))
        assertEquals(3, pressed.number("maxConcurrentTasks"))
    }

    @Test fun aRequestWithALineIsAnsweredAsBefore() {
        val body = Wire.json.parseToJsonElement(CardRequests.build(card(fixture().obj("startItem")!!), CardVerb.START).body!!.decodeToString()).jsonObject
        assertEquals("PROJECT_BRANCH", body.text("line"))
        assertEquals("refs/heads/project/cards", body.text("projectBranchName"))
    }
}
