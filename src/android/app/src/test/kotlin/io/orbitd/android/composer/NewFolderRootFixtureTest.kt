package io.orbitd.android.composer

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Android puts a new folder where the server makes it: [MachineSetup.newFolderRootFor] and [MachineSetup.newFolderPath] held to
 * src/shared/src/new-folder-root.fixture.json, the file `@orbit/shared`, the server and OrbitKit are held to as well. A missing file
 * fails, never skips.
 */
class NewFolderRootFixtureTest {
    @Test fun everyCaseGoesWhereTheFixtureSays() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.firstOrNull { File(it, FIXTURE).isFile }
        assertNotNull("$FIXTURE was not found above the test's working directory", root)
        val cases = Json.parseToJsonElement(File(root, FIXTURE).readText()).jsonObject.getValue("cases").jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 10)
        for (case in cases) {
            val name = case.getValue("name").jsonPrimitive.content
            val runner = case.getValue("runner").jsonObject
            val got = MachineSetup.newFolderRootFor(
                managed = runner.getValue("managed").jsonPrimitive.boolean,
                reposRoot = runner["reposRoot"]?.jsonPrimitive?.contentOrNull,
                capabilities = runner.getValue("capabilities").jsonArray.map { it.jsonPrimitive.content },
            )
            assertEquals(name, case["root"]?.jsonPrimitive?.contentOrNull, got)
            assertEquals(name, case["path"]?.jsonPrimitive?.contentOrNull, got?.let { MachineSetup.newFolderPath(it, "app") })
        }
    }

    private companion object {
        const val FIXTURE = "src/shared/src/new-folder-root.fixture.json"
    }
}
