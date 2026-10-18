package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** When the empty box offers the engine's guess (docs/prompt-suggestions-design.md §4.4). */
class PromptSuggestionOfferTest {
    private fun detail(json: String): JsonObject = Wire.json.parseToJsonElement(json).jsonObject
    private val parked = """{"status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
        "pendingApprovals":0,"capabilities":{"canSend":true,"canResume":false}}"""

    private fun offered(detail: String = parked, suggestion: String? = "run the tests", draftEmpty: Boolean = true,
        usable: Boolean = true) = offeredPromptSuggestion(suggestion, detail(detail), draftEmpty, usable)

    @Test fun anIdleEmptyBoxOffersIt() {
        assertEquals("run the tests", offered())
        assertEquals("a stopped turn", "run the tests", offered(parked.replace("\"AWAITING_INPUT\"", "\"INTERRUPTED\"")))
    }

    @Test fun itIsHeldBackWheneverSomethingElseComesFirst() {
        assertNull(offered(suggestion = null))
        assertNull("something typed or staged", offered(draftEmpty = false))
        assertNull("the box cannot send", offered(usable = false))
        assertNull("a turn in flight", offered(parked.replace("\"AWAITING_INPUT\"", "\"RUNNING\"")))
        assertNull("the engine's own turn", offered(parked.replace("\"pendingApprovals\":0", "\"pendingApprovals\":0,\"engineTurnActive\":true")))
        assertNull("a failed run", offered(parked.replace("\"AWAITING_INPUT\"", "\"FAILED\"")))
        assertNull("a card waits", offered(parked.replace("\"pendingApprovals\":0", "\"pendingApprovals\":1")))
        assertNull("an owner item waits", offered(parked.replace("\"pendingApprovals\":0", "\"pendingApprovals\":0,\"waitingKind\":\"OWNER_ITEM\"")))
        assertNull("filed in Completed", offered(parked.replace("\"OPEN\"", "\"COMPLETED\"")))
        assertNull("nothing can reach it", offered(parked.replace("\"canSend\":true", "\"canSend\":false")))
    }
}
