package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The owner's Re-run asks for the owner's reason: the request carries exactly what was typed, and an empty reason is never sent. A
 * check stopped at its time limit says how long it ran against the limit. Every word is the browser's and OrbitKit's.
 */
class RetryReasonTest {
    private val timedOut = buildJsonObject {
        put("name", "MERGE_CHECK"); put("command", "npm test"); put("exitCode", JsonNull); put("timedOut", true)
        put("durationMs", 14_400_000); put("outputTail", ""); put("timeoutSeconds", 14_400)
    }

    private fun row(check: JsonObject? = timedOut, promotionId: String? = "pr1", taskId: String? = null) = buildJsonObject {
        put("itemId", "i1"); put("kind", "INTEGRATION_CHECK_FAILED"); put("title", "Merge check failed: project/p1 → main")
        put("assignee", "OWNER"); put("assigneeReason", "ESCALATED"); put("waitingSince", "2026-11-16T07:00:00Z")
        put("escalatedAt", "2026-11-16T11:00:00Z"); put("taskId", taskId); put("promotionId", promotionId)
        put("requiredAction", "Re-run the merge check after fixing the slow test.")
        putJsonArray("actions") { add("ASK_COORDINATOR_AGAIN"); add("RETRY") }
        putJsonObject("facts") { if (check != null) put("check", check) else put("check", JsonNull) }
    }

    private fun card(row: JsonObject): InteractionCard = CardCatalog.project("s1", "p1", mapOf(
        "project" to buildJsonObject { put("id", "p1") },
        "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row) }; putJsonArray("withCoordinator") {} })).single()

    private fun reason(request: io.orbitd.android.core.net.ApiRequest) =
        Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject["reason"]?.jsonPrimitive?.content

    @Test fun aRerunCarriesExactlyTheTypedReason() {
        val candidate = card(row())
        val rerun = CardRequests.build(candidate, CardVerb.RERUN_CHECK, CardInput(text = "The runner was swapping; it has more memory now."))
        assertEquals(listOf("projects", "p1", "promotions", "pr1", "integration", "retry"), rerun.path)
        assertEquals("The runner was swapping; it has more memory now.", reason(rerun))

        val landing = card(row(promotionId = null, taskId = "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9"))
        val retry = CardRequests.build(landing, CardVerb.RETRY_INTEGRATION, CardInput(text = "A fix to the slow test landed since."))
        assertEquals(listOf("projects", "p1", "tasks", "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9", "integration", "retry"), retry.path)
        assertEquals("A fix to the slow test landed since.", reason(retry))
    }

    @Test fun anEmptyReasonIsNeverSentAndTheRowsOwnSentenceIsNeverTheReason() {
        val candidate = card(row())
        for (empty in listOf("", "   ")) {
            assertThrows(IllegalArgumentException::class.java) { CardRequests.build(candidate, CardVerb.RERUN_CHECK, CardInput(text = empty)) }
        }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(candidate, CardVerb.RERUN_CHECK) }
    }

    @Test fun aTimedOutCheckSaysItsRunTimeAgainstTheLimit() {
        val check = ExceptionCards.timedOutCheck(row())
        assertNotNull(check)
        assertEquals("The check ran 4h of a 4h limit.", ExceptionCards.checkRanAgainstLimit(check!!))
        val older = buildJsonObject { put("timedOut", true); put("durationMs", 5_412_000) }
        assertEquals("The check ran 1h 30m and was stopped at its time limit.", ExceptionCards.checkRanAgainstLimit(older))
        // A check that failed rather than ran out of time has no such line, and neither has a row without a check.
        assertNull(ExceptionCards.timedOutCheck(row(check = buildJsonObject { put("timedOut", false); put("exitCode", 1); put("durationMs", 360_000) })))
        assertNull(ExceptionCards.timedOutCheck(row(check = null)))
    }

    @Test fun everyWordIsTheBrowsersAndOrbitKits() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/web/src/components/ProjectProgressStatus.tsx").isFile }
        val web = File(root, "src/web/src/components/ProjectProgressStatus.tsx").readText()
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/OwnerItemCards.swift").readText()
        mapOf("RETRY_REASON_QUESTION" to ExceptionCards.retryReasonQuestion, "RETRY_REASON_HINT" to ExceptionCards.retryReasonHint,
            "RETRY_REASON_BACK" to ExceptionCards.retryReasonBack, "CHECK_TIME_LIMIT_PRESS" to ExceptionCards.checkTimeLimitPress,
            "CHECK_TIME_LIMIT_CONSEQUENCE" to ExceptionCards.checkTimeLimitConsequence,
        ).forEach { (name, word) ->
            assertTrue("web $name", web.contains("export const $name = '$word';"))
            assertTrue("OrbitKit says \"$word\"", swift.contains("\"$word\""))
        }
        listOf("`The check ran \${checkDuration(durationMs)} of a \${checkDuration(timeoutSeconds * 1000)} limit.`",
            "`The check ran \${checkDuration(durationMs)} and was stopped at its time limit.`").forEach { assertTrue(it, web.contains(it)) }
        assertFalse("the browser no longer sends the row's own sentence", web.contains("row.requiredAction?.trim() || RETRY_REASON_FALLBACK"))
    }
}
