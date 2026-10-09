package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A08-5 (iOS 698b707ea): "This run never started" — case for case with OrbitKit's SessionRunStartTests, and the project page's
 * SOURCE_UNRESOLVED blocker lines (ProjectPageSectionsTests).
 */
class SessionRunStartTest {
    private fun session(status: String = "FAILED", error: String? = null, sourceState: String? = null, code: String? = null,
        detail: JsonObject? = null, taskId: String? = "task-1") = buildJsonObject {
        put("id", "s"); put("status", status); put("runStatus", status)
        error?.let { put("error", it) }; sourceState?.let { put("sourceState", it) }; code?.let { put("sourceRefusalCode", it) }
        detail?.let { put("sourceRefusalDetail", it) }; taskId?.let { put("taskId", it) }
    }
    private val refusedBaseline = session(sourceState = "REFUSED", code = "BASE_REF_NOT_FOUND", detail = buildJsonObject {
        put("fixAction", "FIX_REF"); put("ref", "refs/heads/project/34bZ3i4AvgJaaow5E9tH")
        put("stderr", "git: fatal: couldn't find remote ref refs/heads/project/34bZ3i4AvgJaaow5E9tH")
    })

    @Test fun aRefusedRunDrawsTheNeverStartedCard() {
        val card = SessionRunStart.card(refusedBaseline)!!
        assertEquals("This run never started", SessionRunStart.title)
        assertEquals("Its baseline is a branch that doesn't exist yet", card.why)
        assertEquals("This project's integration line has not been created.", card.body)
    }

    @Test fun theCardCarriesTheCodeTheRefAndTheRunnersWords() {
        val card = SessionRunStart.card(refusedBaseline)!!
        assertEquals(listOf("BASE_REF_NOT_FOUND", "refs/heads/project/34bZ3i4AvgJaaow5E9tH",
            "git: fatal: couldn't find remote ref refs/heads/project/34bZ3i4AvgJaaow5E9tH"), card.lines)
        assertEquals(listOf("Start it again", "Chat about this"), card.actions.map { it.label })
        assertEquals(SessionRunStart.Kind.START_IT_AGAIN, card.actions.first().kind)
        assertTrue(card.actions.first().primary)
        assertFalse(card.actions.last().primary)
        assertEquals("No engine ran — the task is still open.", card.footer)
    }

    @Test fun theNextStepIsTheServersSentenceForThatAction() {
        val step = SessionRunStart.nextStep("FIX_REF", "refs/heads/project/34bZ3i4AvgJaaow5E9tH")
        assertTrue(step.startsWith("解析的时候仓库里没有 `refs/heads/project/34bZ3i4AvgJaaow5E9tH`："))
        assertTrue(step.endsWith("在那之前重新开工只会得到同一个拒绝。"))
    }

    @Test fun theNextStepNamesTheLineWhenThereIsOne() {
        assertTrue(SessionRunStart.nextStep("SYNC_INTEGRATION_LINE", "refs/heads/project/x").contains("缺的是它落地的提交不在集成线 project/x上"))
        assertTrue(SessionRunStart.nextStep("SYNC_INTEGRATION_LINE", null).contains("缺的是它落地的提交不在这次起跑的线上"))
        assertTrue(SessionRunStart.nextStep("FIX_REF", null).contains("仓库里没有 这次起跑要用的 ref："))
        assertEquals("按处置 SOMETHING_NEW 修好之后再开工。在那之前重新开工只会得到同一个拒绝。", SessionRunStart.nextStep("SOMETHING_NEW", null))
    }

    @Test fun theProseFollowsTheActionTheServerSent() {
        val synced = SessionRunStart.card(session(sourceState = "REFUSED", code = "DEPENDENCY_BASE_NOT_LANDED",
            detail = buildJsonObject { put("fixAction", "SYNC_INTEGRATION_LINE") }))!!
        assertEquals("The line hasn't absorbed what the prerequisite landed", synced.why)
        assertFalse(synced.footer.isNullOrEmpty())
        val later = SessionRunStart.card(session(sourceState = "REFUSED", code = "BASE_SHA_UNAVAILABLE",
            detail = buildJsonObject { put("fixAction", "INVENTED_LATER") }))!!
        assertEquals("This run's baseline couldn't be resolved", later.why)
        assertEquals(listOf("BASE_SHA_UNAVAILABLE"), later.lines)
    }

    @Test fun aRefusalWithNoDetailStillDraws() {
        val card = SessionRunStart.card(session(sourceState = "REFUSED"))!!
        assertEquals("This run's baseline couldn't be resolved", card.why)
        assertEquals(emptyList<String>(), card.lines)
    }

    @Test fun onlyARefusedSessionGetsTheRefusalCard() {
        listOf("UNBOUND", "SELECTED", "PINNED", null).forEach { state ->
            assertNull("$state", SessionRunStart.card(session(status = "RUNNING", sourceState = state, code = "BASE_REF_NOT_FOUND")))
        }
    }

    @Test fun aRunnerThatWentOfflineSaysSoAndOffersAResend() {
        val card = SessionRunStart.card(session(error = "runner offline"), runnerName = "longdeMac-mini.local")!!
        assertEquals("The runner holding this session went offline", card.why)
        assertEquals("longdeMac-mini.local stopped reporting while this run was starting. Nothing was produced, and nothing was sent anywhere.", card.body)
        assertEquals(listOf("Disconnected — runner went offline"), card.lines)
        assertEquals(listOf(SessionRunStart.Kind.SEND_IT_AGAIN, SessionRunStart.Kind.CHAT_ABOUT_THIS), card.actions.map { it.kind })
    }

    @Test fun anEngineThatNeedsANewerRunnerWaitsForTheRunnersOwnUpdate() {
        val card = SessionRunStart.card(session(error = "OpenCode requires Orbit runner 0.1.82 or newer; update this runner first"),
            runnerName = "longdeMac-mini.local", runnerVersion = "0.1.120")!!
        assertEquals("Waiting for a newer runner", card.why)
        assertEquals("longdeMac-mini.local runs Orbit runner 0.1.120; OpenCode needs 0.1.82 or newer. " +
            "The runner updates itself when no session is running on it, and this run starts then.", card.body)
        assertEquals(listOf(SessionRunStart.Kind.OPEN_RUNNER), card.actions.map { it.kind })
        assertFalse(card.actions.single().primary)
    }

    @Test fun anUnversionedUpgradeSentenceDrawsWithoutInventingAVersion() {
        val card = SessionRunStart.card(session(error = "Gemini requires a newer Orbit runner; update this runner first"))!!
        assertTrue(card.body.startsWith("this runner runs Orbit runner an unknown version; Gemini needs a newer release. The runner updates itself"))
    }

    @Test fun anEngineThatIsNotInstalledNamesTheEngineAndTheMachine() {
        val card = SessionRunStart.card(session(error = "OpenCode isn't installed on this runner and installing it failed (exit 1)"),
            runnerName = "longdeMac-mini.local")!!
        assertEquals("OpenCode isn't installed on longdeMac-mini.local", card.why)
        assertEquals("Install it from Infrastructure, then send your message again.", card.body)
        assertEquals(listOf(SessionRunStart.Kind.OPEN_RUNNER), card.actions.map { it.kind })
    }

    @Test fun theTwoEnginesThatAlreadyHaveACardKeepIt() {
        assertNull(SessionRunStart.card(session(status = "PENDING", error = "Antigravity CLI isn't installed on workstation")))
        assertNull(SessionRunStart.card(session(status = "PENDING", error = "DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner")))
    }

    @Test fun aSessionWithNoRecognizableReasonDrawsNothing() {
        assertNull(SessionRunStart.card(session(status = "RUNNING")))
        assertNull(SessionRunStart.card(session(status = "FAILED", error = "  ")))
        assertNull(SessionRunStart.card(session(status = "RUNNING", error = "rate limit exceeded")))
        assertNull("a machine reason on a running session is old news", SessionRunStart.card(session(status = "RUNNING", error = "runner offline")))
    }

    @Test fun theSourceColumnsDecodeAndAnOlderPayloadDecodesToo() {
        val full = Wire.json.parseToJsonElement("""{"id":"s","status":"FAILED","sourceState":"REFUSED","sourceRefusalCode":"BASE_REF_NOT_FOUND",
            "sourceRefusalDetail":{"fixAction":"FIX_REF","ref":"refs/heads/project/p","stderr":"fatal: no ref","refAuthority":"origin","remoteName":"origin"}}""").jsonObject
        assertEquals("fatal: no ref", SessionRunStart.said(full.obj("sourceRefusalDetail")))
        assertNotNull(SessionRunStart.card(full))
        assertNull(SessionRunStart.card(Wire.json.parseToJsonElement("""{"id":"s","status":"RUNNING"}""").jsonObject))
    }

    @Test fun theRunnersWordsComeFromStderrThenReason() {
        assertEquals("from stderr", SessionRunStart.said(buildJsonObject { put("stderr", " from stderr "); put("reason", "from reason") }))
        assertEquals("from reason", SessionRunStart.said(buildJsonObject { put("stderr", "  "); put("reason", "from reason") }))
        assertNull(SessionRunStart.said(buildJsonObject { put("stderr", "\n") }))
        assertEquals("project/x", SessionRunStart.branchName("refs/heads/project/x"))
        assertEquals("refs/tags/v1", SessionRunStart.branchName("refs/tags/v1"))
    }

    /** The project page's blocker for a refused source names the refusal and whose runs it refuses. */
    @Test fun aSourceUnresolvedBlockerNamesTheRefusalAndWhoseRunsItRefuses() {
        val blocker = buildJsonObject {
            put("kind", "SOURCE_UNRESOLVED"); put("owner", "USER")
            putJsonObject("detail") {
                put("code", "BASE_REF_NOT_FOUND"); put("fixAction", "FIX_REF"); put("ref", "refs/heads/project/34bZ3i4AvgJaaow5E9tH")
                putJsonArray("taskIds") { add("t1"); add("t2") }
            }
        }
        assertEquals(listOf("BASE_REF_NOT_FOUND · refs/heads/project/34bZ3i4AvgJaaow5E9tH", "Wire the drain watchdog", "t2"),
            SessionRunStart.blockerSourceLines(blocker) { if (it == "t1") "Wire the drain watchdog" else null })
        assertEquals(listOf("BASE_REF_NOT_FOUND · refs/heads/project/34bZ3i4AvgJaaow5E9tH", "t1", "t2"),
            SessionRunStart.blockerSourceLines(blocker) { null })
        assertEquals(emptyList<String>(), SessionRunStart.blockerSourceLines(JsonObject(blocker + ("kind" to JsonPrimitive("MERGE_REFUSED")))) { null })
        assertEquals("Its baseline is a branch that doesn't exist yet", SessionRunStart.refusalProse("FIX_REF").first)
    }
}
