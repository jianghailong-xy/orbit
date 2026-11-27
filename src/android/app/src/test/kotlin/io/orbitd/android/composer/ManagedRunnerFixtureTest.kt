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
            assertEquals(name, entry["setupState"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
                ManagedRunner.managedSetupState(status?.runnerId, status))
            assertNull(ManagedRunner.managedSetupState("another-runner", status))
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

    @Test fun theRowsShortLabelsAndTonesAreTheFixtures() {
        val short = fixture.getValue("short").jsonObject
        val tone = fixture.getValue("rowTone").jsonObject
        assertEquals(short.keys, ManagedRunner.SHORT.keys)
        assertEquals(tone.keys, ManagedRunner.ROW_TONE.keys)
        for ((kind, label) in short) assertEquals(kind, label.jsonPrimitive.content, ManagedRunner.SHORT[kind])
        for ((kind, value) in tone) assertEquals(kind, value.jsonPrimitive.content, ManagedRunner.ROW_TONE.getValue(kind).name.lowercase())
    }

    @Test fun theEntryConfirmationAndAsleepWordsAreTheFixtures() {
        val entry = fixture.getValue("entry").jsonObject
        assertEquals(entry["title"]!!.jsonPrimitive.content, ManagedRunner.Entry.TITLE)
        assertEquals(entry["action"]!!.jsonPrimitive.content, ManagedRunner.Entry.ACTION)
        assertEquals(entry["subtitle"]!!.jsonPrimitive.content, ManagedRunner.Entry.SUBTITLE)
        val confirm = fixture.getValue("confirm").jsonObject
        assertEquals(confirm["title"]!!.jsonPrimitive.content, ManagedRunner.Confirm.TITLE)
        assertEquals(confirm["body"]!!.jsonPrimitive.content, ManagedRunner.Confirm.BODY)
        assertEquals(confirm["cancel"]!!.jsonPrimitive.content, ManagedRunner.Confirm.CANCEL)
        assertEquals(confirm["confirm"]!!.jsonPrimitive.content, ManagedRunner.Confirm.CONFIRM)
        val asleep = fixture.getValue("asleep").jsonObject
        assertEquals(asleep["row"]!!.jsonPrimitive.content, ManagedRunner.Asleep.ROW)
        assertEquals(asleep["composer"]!!.jsonPrimitive.content, ManagedRunner.Asleep.COMPOSER)
    }

    /** Every state of the fixture as the managed runner's own machine row reads it (`managedRunnerRow`), and no row for another runner. */
    @Test fun everyStatesRowIsTheSharedRule() {
        for (entry in cases("states")) {
            val name = entry["name"]!!.jsonPrimitive.content
            val status = ManagedRunner.status(entry["status"])!!
            val display = ManagedRunner.display(status)
            val id = status.runnerId ?: "0198f3a2-2222-7000-8000-000000000002"
            val row = ManagedRunner.row(id, status)
            if (status.runnerId == null || display == null || display.kind == "notOffered") { assertNull(name, row); continue }
            assertNotNull(name, row); row!!
            assertEquals(name, ManagedRunner.SHORT[display.kind], row.label)
            val tone = ManagedRunner.ROW_TONE.getValue(display.kind)
            assertEquals(name, if (tone == ManagedRunner.Tone.PROGRESS && !display.moving) ManagedRunner.Tone.IDLE else tone, row.tone)
            assertEquals(name, if (display.kind == "sleeping" && display.acceptsWork) ManagedRunner.Asleep.ROW else null, row.detail)
            assertEquals(name, display.acceptsWork, row.acceptsWork)
            assertNotEquals(name, "Offline", row.label)
            assertNull(name, ManagedRunner.row("0198f3a2-7777-7000-8000-000000000007", status))
        }
        assertNull(ManagedRunner.row(null, null))
    }

    @Test fun setupCopyMatchesTheFixture() {
        val setup = fixture.getValue("setup").jsonObject
        assertEquals(setup["home"]!!.jsonPrimitive.content, ManagedRunner.HOME)
        assertEquals(setOf("notice", "folderUnchecked", "home"), setup.keys)
        for ((key, words) in mapOf("notice" to ManagedRunner.Setup.NOTICE,
            "folderUnchecked" to ManagedRunner.Setup.FOLDER_UNCHECKED)) {
            assertEquals(setup[key]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }, words)
        }
    }

    private companion object { const val FIXTURE = "src/shared/src/managed-runner-states.fixture.json" }
}
