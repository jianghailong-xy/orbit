package io.orbitd.android.composer

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Android puts a new folder and a clone where the server makes them: [MachineSetup.newFolderRootFor], [MachineSetup.cloneRootFor] and
 * [MachineSetup.newFolderPath] held to
 * src/shared/src/new-folder-root.fixture.json, the file `@orbit/shared`, the server and OrbitKit are held to as well. A missing file
 * fails, never skips.
 */
class NewFolderRootFixtureTest {
    @Test fun everyCaseGoesWhereTheFixtureSays() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.firstOrNull { File(it, FIXTURE).isFile }
        assertNotNull("$FIXTURE was not found above the test's working directory", root)
        val fixture = Json.parseToJsonElement(File(root, FIXTURE).readText()).jsonObject
        val cases = fixture.getValue("cases").jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 10)
        for (case in cases) {
            val name = case.getValue("name").jsonPrimitive.content
            val runner = case.getValue("runner").jsonObject
            val got = MachineSetup.newFolderRootFor(
                managed = runner.getValue("managed").jsonPrimitive.boolean,
                up = runner.getValue("up").jsonPrimitive.boolean,
                reposRoot = runner["reposRoot"]?.jsonPrimitive?.contentOrNull,
                capabilities = runner.getValue("capabilities").jsonArray.map { it.jsonPrimitive.content },
            )
            assertEquals(name, case["root"]?.jsonPrimitive?.contentOrNull, got)
            assertEquals(name, case["path"]?.jsonPrimitive?.contentOrNull, got?.let { MachineSetup.newFolderPath(it, "app") })
        }
        val clones = fixture.getValue("clones").jsonArray.map { it.jsonObject }
        assertTrue(clones.size >= 6)
        for (case in clones) {
            val name = case.getValue("name").jsonPrimitive.content
            val runner = case.getValue("runner").jsonObject
            val got = MachineSetup.cloneRootFor(
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
