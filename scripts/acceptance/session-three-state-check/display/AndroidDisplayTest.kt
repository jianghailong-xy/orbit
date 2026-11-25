package io.orbitd.android.sessionfacts

import io.orbitd.android.core.guests.GuestWire
import io.orbitd.android.core.guests.SharedWithMe
import io.orbitd.android.core.guests.displayFacts
import io.orbitd.android.core.guests.marks
import io.orbitd.android.core.guests.word
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SearchHit
import io.orbitd.android.directory.SessionDisplay
import io.orbitd.android.directory.SessionHeader
import io.orbitd.android.directory.displayFacts
import io.orbitd.android.directory.isWorkingForList
import io.orbitd.android.directory.needsOwner
import io.orbitd.android.tasks.TaskDetailLogic
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Test

// Copy to src/android/app/src/test/kotlin/io/orbitd/android/sessionfacts/ of the checkout under test and run with
// ROWS=<rows.json> OUT=<result.json> (gradle: :app:testDebugUnitTest --tests '*AndroidDisplayTest'). Each payload kind is
// decoded as the app decodes it; the list row draws the first two marks and "+N" (SessionRow, `SessionMarkChips(max = 2)`).
class AndroidDisplayTest {
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val now = Instant.parse("2026-11-23T10:00:00Z")

    @Test fun writeDisplay() {
        val rows = Json.parseToJsonElement(File(System.getenv("ROWS")!!).readText()).jsonArray
        val out = buildJsonArray {
            for (r in rows) {
                val o = r.jsonObject
                val kind = o["kind"]!!.jsonPrimitive.content
                val p = o["payload"]!!.jsonObject
                add(buildJsonObject {
                    put("id", o["id"]!!); put("client", "android")
                    try { fill(this, kind, p) } catch (e: Throwable) { put("error", e.toString()) }
                })
            }
        }
        File(System.getenv("OUT")!!).writeText(Json { prettyPrint = true }.encodeToString(JsonArray.serializer(), out))
    }

    private fun JsonObjectBuilder.put(facts: SessionDisplay.Facts) {
        val state = SessionDisplay.state(facts)
        val marks = SessionDisplay.marks(facts)
        put("state", state?.word?.let(::JsonPrimitive) ?: JsonNull)
        put("marks", marks?.let { m -> JsonArray(m.map { JsonPrimitive(it.word) }) } ?: JsonNull)
        if (marks != null) put("phoneMarks", JsonArray((marks.take(2).map { it.word } +
            listOfNotNull((marks.size - 2).takeIf { it > 0 }?.let { "+$it" })).map(::JsonPrimitive)))
        if (state != null) put("drawnIcon", state.icon.name)
    }

    private fun JsonObjectBuilder.drawn(surface: String, state: String, marks: List<String>) = put("drawn", buildJsonObject {
        put(surface, buildJsonObject { put("state", state); put("marks", JsonArray(marks.map(::JsonPrimitive))) })
    })

    private fun fill(b: JsonObjectBuilder, kind: String, p: JsonObject) = with(b) {
        val surfaces = mutableMapOf<String, String>()
        when (kind) {
            "fixture", "listRow", "detail" -> {
                val s = json.decodeFromJsonElement(DirectorySession.serializer(), p)
                put(s.displayFacts)
                surfaces["header"] = SessionHeader.statusWord(s, now = now)
                surfaces["rowValue"] = SessionDisplay.text(s.displayFacts, ", ") ?: SessionHeader.statusWord(s, now = now)
                surfaces["runBadge"] = TaskDetailLogic.runLabel(p)
                surfaces["markdownRun"] = surfaces["runBadge"]!!
                put("group", buildJsonObject { put("needsYou", s.needsOwner()); put("working", s.isWorkingForList()) })
            }
            "taskRun", "sessionSummary", "sessionEnded" -> {
                put(SessionDisplay.facts(p)); surfaces["runBadge"] = TaskDetailLogic.runLabel(p)
            }
            "linkPreview" -> put(SessionDisplay.facts(p))   // Android has no link card; the two functions' reading only.
            "guestRow" -> {
                val list = buildJsonObject { put("sessions", buildJsonArray { add(p) }) }
                val summary = GuestWire.list(list.toString().encodeToByteArray()).single()
                put(summary.state.displayFacts)
                // The drawer's Shared with me row, second line: "Ana · Idle · Finished".
                val line = SharedWithMe.subtitle(summary)
                surfaces["sharedWithMe"] = line
                val parts = line.removePrefix("${summary.ownerName} · ").split(" · ")
                drawn("sharedWithMe", parts.first(), parts.drop(1).filter { it != "Completed" })
            }
            "sharedHead" -> {
                val state = GuestWire.state(p)
                put(state.displayFacts)
                // GuestHead: the pill's word, then every mark (`SessionMarkChips(state.marks)`).
                val marks = state.marks.orEmpty().map { it.word }
                surfaces["sharedPage"] = (listOf(state.word) + marks).joinToString(" · ")
                drawn("sharedHead", state.word, marks)
            }
            "searchHit" -> {
                val hit = json.decodeFromJsonElement(SearchHit.serializer(), p)
                // DirectoryScreen's search row draws these words (agent · lifecycle · run state).
                surfaces["search"] = listOfNotNull(hit.agent?.name, hit.lifecycleState, hit.runState ?: hit.status).joinToString(" · ")
                drawn("search", hit.runState ?: hit.status, emptyList())
            }
            else -> error("unknown kind $kind")
        }
        put("surfaces", buildJsonObject { surfaces.forEach { (k, v) -> put(k, v) } })
    }
}
