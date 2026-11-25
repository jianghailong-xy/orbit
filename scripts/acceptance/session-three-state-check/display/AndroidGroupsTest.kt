package io.orbitd.android.sessionfacts

import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.isWorkingForList
import io.orbitd.android.directory.needsOwner
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Test

// Needs you / Working membership only: runs unchanged on the tip and on the commit before the display change.
// Copy to src/android/app/src/test/kotlin/io/orbitd/android/sessionfacts/ and run with ROWS=<rows.json> OUT=<result.json>.
class AndroidGroupsTest {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    @Test fun writeGroups() {
        val rows = Json.parseToJsonElement(File(System.getenv("ROWS")!!).readText()).jsonArray.map { it.jsonObject }
            .filter { it["kind"]!!.jsonPrimitive.content in listOf("fixture", "listRow") }
        val out = buildJsonArray {
            for (r in rows) {
                val s = json.decodeFromJsonElement(DirectorySession.serializer(), r["payload"]!!.jsonObject)
                add(buildJsonObject { put("id", r["id"]!!); put("needsYou", s.needsOwner()); put("working", s.isWorkingForList()) })
            }
        }
        File(System.getenv("OUT")!!).writeText(Json { prettyPrint = true }.encodeToString(JsonArray.serializer(), out))
    }
}
