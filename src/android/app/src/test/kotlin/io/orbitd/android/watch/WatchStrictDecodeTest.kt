package io.orbitd.android.watch

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** A row is a watch only when it carries every field the server always sends (OrbitKit `Watch`'s non-optional
 * properties): a row missing one is left out, never drawn as a normal watch out of defaults. Values this version
 * does not know are still read — as unknown — and the three optional fields may be missing or null. */
class WatchStrictDecodeTest {
    private val complete = WatchFixture.json(id = "34Oaok4mTYwXssYuZtrVT")
    private val required = listOf("id", "observerType", "predicateVersion", "predicate", "mode", "action", "state", "generation",
        "expiresAt", "createdAt", "updatedAt", "targets", "matches", "expiryDeliveries")

    @Test fun aRowMissingAFieldTheServerAlwaysSendsIsNotAWatch() {
        required.forEach { key -> assertNull("a row without $key", Watch.decode(JsonObject(complete - key))) }
    }

    @Test fun aRowWhoseFieldIsOfAnotherKindIsNotAWatch() {
        assertNull(Watch.decode(JsonObject(complete + ("targets" to JsonPrimitive("T1")))))
        assertNull(Watch.decode(JsonObject(complete + ("state" to JsonNull))))
        assertNull(Watch.decode(JsonObject(complete + ("generation" to JsonPrimitive("one")))))
    }

    @Test fun valuesThisVersionDoesNotKnowAreReadAsUnknown() {
        val read = Watch.decode(JsonObject(complete + mapOf("state" to JsonPrimitive("SNOOZED"), "action" to JsonPrimitive("PAGE_SOMEONE"),
            "mode" to JsonPrimitive("FOREVER"))))
        assertNotNull(read)
        assertEquals(WatchState.UNKNOWN, read!!.state)
        assertEquals(WatchAction.UNKNOWN, read.action)
    }

    @Test fun theOptionalFieldsMayBeMissingOrNull() {
        val bare = JsonObject(complete - listOf("observerSessionId", "nextEvaluateAt", "lastEvaluatedAt"))
        assertNotNull(Watch.decode(bare))
        assertNotNull(Watch.decode(JsonObject(complete + ("lastEvaluatedAt" to JsonNull))))
    }
}
