package io.orbitd.android.schedule

import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.navigation.OrbitLinks
import io.orbitd.android.push.PushMessage
import io.orbitd.android.push.PushPayload
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/**
 * A condition's pushes on Android (docs/condition-triggers-design.md §5.3, §6.1): a condition that cannot be read rings as the
 * `condition` kind, and a firing's run rings as its schedule's FINDING. Each is a sample of the shared fixture
 * (src/shared/src/android-push.fixture.json) that push.service.spec pins to what the server really sends: neither is dropped.
 */
class ConditionPushTest {
    private fun sample(name: String): Map<String, String> {
        val root = generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
            .first { java.io.File(it, "src/shared/src/android-push.fixture.json").isFile }
        val fixture = Json.parseToJsonElement(java.io.File(root, "src/shared/src/android-push.fixture.json").readText()).jsonObject
        return fixture["samples"]!!.jsonArray.map { it.jsonObject }.single { it["name"]!!.jsonPrimitive.content == name }["data"]!!
            .jsonObject.mapValues { it.value.jsonPrimitive.content }
    }

    @Test fun aCantReadPushIsShownAndOpensTheConversationItCameFrom() {
        val message = PushMessage.parse(sample("condition-unknown")) ?: throw AssertionError("the server's condition push is dropped")
        assertEquals(PushPayload.CONDITION, message.payload.kind)
        assertEquals("019a0000-0000-7000-8000-000000000020", message.payload.conditionId)
        assertEquals("019a0000-0000-7000-8000-000000000022", message.payload.ownerRequestId)
        assertEquals("Can't read: Root disk below 5%", message.payload.title)
        assertEquals("The check timed out 3 times in a row. The last reading was 5%, 16 minutes ago.", message.payload.body)
        assertEquals("orbit-session:019a0000-0000-7000-8000-000000000021", message.link)
        assertFalse("a condition item is not an owner request's push", message.payload.isOwnerRequest)
    }

    /** With no conversation named, the push carries the item's owner-request link, which opens the conversation that filed it on
     * its card (there is no Waiting on you inbox, docs/mocks/waiting-on-you-removal). */
    @Test fun aCantReadPushWithNoConversationOpensItsCardByTheOwnerRequestLink() {
        val data = sample("condition-unknown")
        val payload = Json.parseToJsonElement(data.getValue("payload")).jsonObject - "sessionID"
        val message = PushMessage.parse(data + ("payload" to JsonObject(payload).toString()))!!
        assertEquals("orbit://owner-request/019a0000-0000-7000-8000-000000000022", message.link)
        assertEquals(ObjectId.canonical("019a0000-0000-7000-8000-000000000022"), OrbitLinks.ownerRequest(message.link!!))
    }

    @Test fun aConditionPushWithoutItsConditionIsRefused() {
        val data = sample("condition-unknown")
        val payload = Json.parseToJsonElement(data.getValue("payload")).jsonObject - "conditionID"
        assertNull(PushMessage.parse(data + ("payload" to JsonObject(payload).toString())))
    }

    @Test fun aFiredConditionsRunRingsAsItsSchedulesFindingAndOpensTheRun() {
        val message = PushMessage.parse(sample("schedule-finding")) ?: throw AssertionError("the fired condition's push is dropped")
        assertEquals(PushPayload.SCHEDULE, message.payload.kind)
        assertEquals("FINDING", message.payload.scheduleKind)
        assertEquals("Ceph capacity guard", message.payload.title)
        assertEquals("orbit-session:019a0000-0000-7000-8000-000000000024", message.link)
    }
}
