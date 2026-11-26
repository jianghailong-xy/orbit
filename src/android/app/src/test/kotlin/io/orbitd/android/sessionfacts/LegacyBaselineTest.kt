package io.orbitd.android.sessionfacts

import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.RunState
import io.orbitd.android.directory.SessionHeader
import io.orbitd.android.directory.displayRunState
import io.orbitd.android.directory.effectiveRunState
import io.orbitd.android.directory.hasBackgroundProcess
import io.orbitd.android.directory.isRunning
import io.orbitd.android.directory.isRunningJob
import io.orbitd.android.directory.isWorkingForList
import io.orbitd.android.directory.needsOwner
import io.orbitd.android.directory.resumesOnItsOwn
import io.orbitd.android.directory.retryPending
import io.orbitd.android.tasks.TaskDetailLogic
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Today's drawn state on Android with the session facts absent (an older server): the word and mark of the session list row,
 * the task panel's run badge and the Needs you / Working group of each fixture row, against
 * scripts/acceptance/session-three-state-check/legacy-baseline.android.json (recorded before any display change).
 * UPDATE_BASELINE=<file> writes the file instead of comparing.
 *
 * `SessionLiveMark` is a composable, so `mark` names its branch from the same predicates in the same order (a copy of its `when`:
 * a change to the composable's order is not seen here, a change to a predicate is).
 */
class LegacyBaselineTest {
    private val dir = File("../../../scripts/acceptance/session-three-state-check")
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val now = Instant.parse("2026-11-23T10:00:00Z")

    private fun mark(s: DirectorySession): String {
        val parked = s.effectiveRunState == RunState.AWAITING_INPUT
        return when {
            s.pendingApprovals > 0 -> "needs-you"
            s.confirmationUnderReview != null -> "review"
            s.effectiveRunState == RunState.QUEUED -> "queued"
            s.isRunning() -> "running"
            parked && s.resumesOnItsOwn -> "watching"
            s.isRunningJob(null) -> "jobs"
            s.hasBackgroundProcess(null) -> "services"
            s.displayRunState == RunState.FAILED && !s.retryPending(now) && !s.error.orEmpty().lowercase().contains("offline") -> "failed"
            else -> "none"
        }
    }

    private fun measure(): JsonObject {
        val rows = Json.parseToJsonElement(File(dir, "fixture.json").readText()).jsonArray.map { it.jsonObject }
            .filter { !it["newFields"]!!.jsonPrimitive.boolean }
        return buildJsonObject {
            put("rows", buildJsonArray {
                for (r in rows) {
                    val p = r["payload"]!!.jsonObject
                    val s = json.decodeFromJsonElement(DirectorySession.serializer(), p)
                    add(buildJsonObject {
                        put("name", r["name"]!!)
                        put("mark", mark(s))
                        put("word", SessionHeader.statusWord(s, now = now))
                        put("runBadge", TaskDetailLogic.runLabel(p))
                        put("needsYouGroup", s.needsOwner())
                        put("workingGroup", s.isWorkingForList())
                    })
                }
            })
        }
    }

    @Test fun drawsTodaysWordAndMarkForEveryFixtureRowWithTheFactsAbsent() {
        val got = measure()
        val out = System.getenv("UPDATE_BASELINE")
        if (out != null) { File(out).writeText(Json { prettyPrint = true }.encodeToString(JsonObject.serializer(), got) + "\n"); return }
        assertEquals(Json.parseToJsonElement(File(dir, "legacy-baseline.android.json").readText()), got)
    }
}
