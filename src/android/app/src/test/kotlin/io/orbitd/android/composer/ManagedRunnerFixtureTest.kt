package io.orbitd.android.composer

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Android reads every managed runner state the way the shared fixture says (src/shared/src/managed-runner-states.fixture.json), the
 * file `@orbit/shared`, the web and OrbitKit are held to as well. A missing file fails, never skips.
 */
class ManagedRunnerFixtureTest {
    private val fixture: JsonObject by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .firstOrNull { File(it, FIXTURE).isFile }
        assertNotNull("$FIXTURE was not found above the test's working directory", root)
        Json.parseToJsonElement(File(root, FIXTURE).readText()).jsonObject
    }

    private fun cases(key: String) = fixture.getValue(key).jsonArray.map { it.jsonObject }

    private fun ManagedRunner.Display.asJson() = buildJsonObject {
        put("kind", kind); put("title", title); put("detail", detail); put("retry", retry); put("ensure", ensure); put("signIn", signIn)
        put("acceptsWork", acceptsWork); put("startsNewSession", startsNewSession); put("moving", moving)
    }

    @Test fun everyStateIsDisplayedAsTheFixtureSays() {
        val states = cases("states")
        assertTrue(states.size > 20)
        for (entry in states) {
            val name = entry["name"]!!.jsonPrimitive.content
            val status = ManagedRunner.status(entry["status"])
            assertNotNull(name, status)
            val expected = entry["display"]?.takeIf { it !is JsonNull }
            assertEquals(name, expected, ManagedRunner.display(status)?.asJson())
        }
    }

    @Test fun aNewerServersStateOrContractShowsNoManagedUi() {
        val newer = cases("newer")
        assertFalse(newer.isEmpty())
        for (entry in newer) assertNull(entry["name"].toString(), ManagedRunner.display(ManagedRunner.status(entry["status"])))
    }

    @Test fun everyCapabilityAnswerIsReadAsTheFixtureSays() {
        val capabilities = cases("capabilities")
        assertEquals(6, capabilities.size)
        for (entry in capabilities) {
            // A refused read (a pre-feature server's 404) is no capability.
            val read = entry["body"].takeIf { entry["httpStatus"]!!.jsonPrimitive.int == 200 }
            assertEquals(entry["name"].toString(), entry["offered"]!!.jsonPrimitive.boolean, ManagedRunner.offered(read))
        }
        assertFalse(ManagedRunner.offered(null))
    }

    @Test fun theActionWordsAreTheFixtures() {
        val copy = fixture.getValue("copy").jsonObject
        assertEquals(copy["retry"]!!.jsonPrimitive.content, ManagedRunner.RETRY)
        assertEquals(copy["ensure"]!!.jsonPrimitive.content, ManagedRunner.ENSURE)
        assertEquals(copy["signIn"]!!.jsonPrimitive.content, ManagedRunner.SIGN_IN)
    }

    private companion object { const val FIXTURE = "src/shared/src/managed-runner-states.fixture.json" }
}
