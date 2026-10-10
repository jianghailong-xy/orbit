package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit DshRuntimeTests (iOS e789ce3dc, 13720e241, cef6c8e0d): a runner's readiness for DeepSeek Harness, the remedy a failed
 * session's message implies and what its card says, and whose approvals offer no remember. */
class DshRuntimeTest {
    private fun runner(capabilities: List<String>?, health: JsonObject?) = buildJsonObject {
        capabilities?.let { putJsonArray("capabilities") { it.forEach(::add) } }
        health?.let { putJsonArray("engines") { add(it) } }
    }
    private fun health(installed: Boolean = true, error: String? = null, compatible: Boolean = true) = buildJsonObject {
        put("engine", "dsh"); put("installed", installed); if (installed) put("version", "0.2.0-rc.2"); put("auth", "unknown")
        error?.let { put("installationError", it) }
        putJsonObject("dsh") { put("versionCompatible", compatible) }
    }

    @Test fun theRunnerStateReadsTheServerGateThenTheEngineReport() {
        assertEquals(DshRuntime.RunnerState.UPDATE_RUNNER, DshRuntime.state(runner(null, health())))
        assertEquals(DshRuntime.RunnerState.UPDATE_RUNNER, DshRuntime.state(runner(listOf("provider:antigravity"), health())))
        val cap = listOf("provider:dsh")
        assertEquals("a runner that hasn't reported Harness claims nothing", DshRuntime.RunnerState.READY, DshRuntime.state(runner(cap, null)))
        assertEquals(DshRuntime.RunnerState.READY, DshRuntime.state(runner(cap, health())))
        assertEquals(DshRuntime.RunnerState.NOT_INSTALLED, DshRuntime.state(runner(cap, health(installed = false))))
        assertEquals(DshRuntime.RunnerState.UNSUPPORTED_PLATFORM,
            DshRuntime.state(runner(cap, health(installed = false, error = "DSH_PLATFORM_UNSUPPORTED: darwin"))))
        assertEquals(DshRuntime.RunnerState.UNSUPPORTED_PLATFORM, DshRuntime.state(runner(cap, health(installed = false, error = "DSH_NODE_UNSUPPORTED: 22"))))
        assertEquals(DshRuntime.RunnerState.UNSUPPORTED_VERSION, DshRuntime.state(runner(cap, health(compatible = false))))
        assertTrue(DshRuntime.RunnerState.NOT_INSTALLED.installable)
        assertTrue(DshRuntime.RunnerState.UNSUPPORTED_VERSION.installable)
        assertFalse(DshRuntime.RunnerState.UPDATE_RUNNER.installable)
        assertFalse(DshRuntime.RunnerState.UNSUPPORTED_PLATFORM.installable)
        assertNull(DshRuntime.RunnerState.READY.hint)
        assertEquals("Install DeepSeek Harness on this runner from Infrastructure.", DshRuntime.RunnerState.NOT_INSTALLED.hint)
        assertEquals("DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only.", DshRuntime.RunnerState.UNSUPPORTED_PLATFORM.hint)
    }

    @Test fun theRepairReadsRunnerCodesAndKeyRejectionOnly() {
        assertEquals(DshRuntime.Repair.NEEDS_KEY, DshRuntime.repair("DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key"))
        assertEquals(DshRuntime.Repair.INVALID_KEY, DshRuntime.repair("dsh session/prompt (-32603): Invalid API key"))
        assertEquals(DshRuntime.Repair.INVALID_KEY, DshRuntime.repair("dsh session/prompt (-32603): status 401 authentication_error"))
        assertEquals(DshRuntime.Repair.UPDATE_RUNNER,
            DshRuntime.repair("DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first"))
        assertEquals(DshRuntime.Repair.NOT_INSTALLED, DshRuntime.repair("DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed"))
        assertEquals(DshRuntime.Repair.UNSUPPORTED_PLATFORM, DshRuntime.repair("DSH_NODE_UNSUPPORTED: node 22"))
        assertNull(DshRuntime.repair("dsh session/prompt (-32603): rate limit exceeded"))
        assertNull("another engine's words are not Harness's", DshRuntime.repair("Invalid API key"))
        assertNull(DshRuntime.repair(null))
        assertTrue(DshRuntime.Repair.INVALID_KEY.isKeyProblem)
        assertTrue(DshRuntime.Repair.NEEDS_KEY.isKeyProblem)
        assertFalse(DshRuntime.Repair.NOT_INSTALLED.isKeyProblem)
        assertTrue("the run-start card leaves them to it", SessionRunStart.dshRepair("DSH_CREDENTIAL_MISSING: configure a DeepSeek Harness API key"))
    }

    /** The real DeepSeek 401 is a bad key; a rate limit, a 5xx, a spent balance or a dropped connection is not. */
    @Test fun theRealDeepSeekKeyRejectionIsAnInvalidKey() {
        val real = "dsh session/prompt (-32603): Internal error: turn failed: Authentication Fails, Your api key: ****0000 is invalid " +
            "(request_id: 64d2f58d-15e2-4744-aafd-d463abb21741) "
        assertEquals(DshRuntime.Repair.INVALID_KEY, DshRuntime.repair("DSH_CREDENTIAL_INVALID: $real"))
        assertEquals(DshRuntime.Repair.INVALID_KEY, DshRuntime.repair(real))
        assertEquals(DshRuntime.Repair.INVALID_KEY,
            DshRuntime.repair("dsh session/prompt (-32603): Internal error: turn failed: Your API key: sk-****abcd is invalid"))
        listOf(
            "dsh session/prompt (-32603): Internal error: turn failed: Rate Limit Reached",
            "dsh session/prompt (-32603): Internal error: turn failed: synthetic-429",
            "dsh session/prompt (-32603): Internal error: turn failed: 503 Service Unavailable",
            "dsh session/prompt (-32603): Internal error: turn failed: Insufficient Balance",
            "dsh session/prompt (-32603): Internal error: turn failed: fetch failed: socket hang up (ECONNRESET)",
            "dsh ACP transport closed: EOF",
            "DSH_REQUEST_FAILED: dsh session/prompt (-32603): Internal error: turn failed: invalid api key? {\"error\":{\"statusCode\":503}}",
        ).forEach { assertNull(it, DshRuntime.repair(it)) }
        assertFalse(SessionRunStart.dshRepair("dsh ACP transport closed: EOF"))
    }

    @Test fun eachRepairSaysWhatStopsTheSessionAndWhereItIsFixed() {
        assertEquals("DeepSeek Harness needs an API key", DshRuntime.Repair.NEEDS_KEY.title("wikova"))
        assertEquals("This session has no DeepSeek Harness key to run on. Add or re-enable the key in Infrastructure, then send your message again.",
            DshRuntime.Repair.NEEDS_KEY.detail)
        assertEquals("DeepSeek rejected this API key", DshRuntime.Repair.INVALID_KEY.title(null))
        assertEquals("Update the key in Infrastructure, then send your message again. Connecting a key does not check it — the first request does.",
            DshRuntime.Repair.INVALID_KEY.detail)
        assertEquals("Waiting for a newer runner", DshRuntime.Repair.UPDATE_RUNNER.title("wikova"))
        assertEquals("DeepSeek Harness isn't installed on “wikova”", DshRuntime.Repair.NOT_INSTALLED.title("wikova"))
        assertEquals("DeepSeek Harness isn't installed on this runner", DshRuntime.Repair.NOT_INSTALLED.title(""))
        assertEquals("Install it from Infrastructure, then send your message again.", DshRuntime.Repair.NOT_INSTALLED.detail)
        assertEquals("DeepSeek Harness can't run on “wikova”", DshRuntime.Repair.UNSUPPORTED_PLATFORM.title("wikova"))
        assertEquals("DeepSeek Harness can't run on this runner", DshRuntime.Repair.UNSUPPORTED_PLATFORM.title(null))
    }

    @Test fun rememberIsNotOfferedOnHarnessAlone() {
        assertFalse(DshRuntime.rememberOffered("dsh"))
        listOf("claude", "codex", "kimi", "opencode", "antigravity", null).forEach { assertTrue("$it", DshRuntime.rememberOffered(it)) }
        // A server that doesn't say the engine: the reader that knows it from the account's keys says it.
        val bash = CardCatalog.session(fixture().text("sessionId")!!, snapshot(), engine = "dsh").single { it.key == "approval:a1" }
        assertEquals(listOf(CardVerb.ALLOW, CardVerb.DENY), bash.actions)
    }
}
