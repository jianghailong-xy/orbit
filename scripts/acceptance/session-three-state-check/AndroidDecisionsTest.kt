package io.orbitd.android.sessionfacts

import io.orbitd.android.composer.sendEndpoint
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SessionHeader
import io.orbitd.android.directory.runEnded
import io.orbitd.android.tasks.TaskDetailLogic
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Test

// Copy to src/android/app/src/test/kotlin/io/orbitd/android/sessionfacts/ of the checkout under test and run with
// FIXTURE=<fixture.json> OUT=<result.json> (gradle: :app:testDebugUnitTest --tests '*AndroidDecisionsTest').
class AndroidDecisionsTest {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    @Test fun writeDecisions() {
        val rows = Json.parseToJsonElement(File(System.getenv("FIXTURE")!!).readText()).jsonArray
        val out = buildJsonArray {
            for (r in rows) {
                val o = r.jsonObject
                val p = o["payload"]!!.jsonObject
                val send = try { sendEndpoint(p) } catch (e: Throwable) { "ERR " + e.message }
                val word = try { SessionHeader.statusWord(json.decodeFromJsonElement(DirectorySession.serializer(), p), now = Instant.parse("2026-11-23T10:00:00Z")) } catch (e: Throwable) { "ERR " + e }
                add(buildJsonObject {
                    put("name", o["name"]!!); put("newFields", o["newFields"]!!)
                    put("send", send); put("waitOver", runEnded(p)); put("word", word); put("run", TaskDetailLogic.runLabel(p))
                })
            }
        }
        File(System.getenv("OUT")!!).writeText(Json { prettyPrint = true }.encodeToString(JsonArray.serializer(), out))
    }
}
