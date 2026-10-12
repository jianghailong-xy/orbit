package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * OrbitKit `DshRuntime` (iOS e789ce3dc, 7ca6ab87e, 13720e241, cef6c8e0d): what the clients need to know about DeepSeek Harness (`dsh`)
 * that no other engine shares. Harness has no sign-in on the runner — a session runs on the DeepSeek key it was started with — so a
 * runner can only be asked whether it can START Harness: it declares `provider:dsh`, and its engine report says the pinned CLI is
 * installed on a platform it admits. Whether a key works shows in the session that used it.
 */
object DshRuntime {
    /** The engine's own name, as a session's `engine` and a runner's engine report say it. */
    const val ENGINE = "dsh"
    /** The heartbeat capability the server requires before it creates, resumes or hands out a Harness session. */
    const val RUNNER_CAPABILITY = "provider:dsh"
    /** What a `!` command gets on Harness, which has no shell bridge: the command stays in the composer rather than going out to fail. */
    const val SHELL_REFUSAL = "DeepSeek Harness sessions don't run ! shell commands — ask the agent to run it instead."
    /** A Harness session's model while the runner has reported none: the runtime picks, and no other runtime's words describe that. */
    const val PICKED_BY = "Picked by DeepSeek Harness"

    /** Why a runner can't start Harness, most fundamental first, or [READY] — with one sentence on what to do about it. */
    enum class RunnerState(val hint: String?) {
        READY(null),
        UPDATE_RUNNER("This runner predates DeepSeek Harness. It updates itself when no session is running on it."),
        UNSUPPORTED_PLATFORM("DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only."),
        NOT_INSTALLED("Install DeepSeek Harness on this runner from Infrastructure."),
        UNSUPPORTED_VERSION("This runner has a DeepSeek Harness version Orbit does not support. Reinstall it from Infrastructure.");

        /** The one state a client can fix from here: install the pinned CLI on that machine. */
        val installable get() = this == NOT_INSTALLED || this == UNSUPPORTED_VERSION
    }

    /** Whether a runner can start a Harness session. The capability is the server's own gate; with it, the engine report decides, and
     * a runner that hasn't reported Harness yet claims nothing and stays [RunnerState.READY]. */
    fun state(runner: JsonObject): RunnerState {
        if (RUNNER_CAPABILITY !in runner.strings("capabilities")) return RunnerState.UPDATE_RUNNER
        val health = runner.objects("engines").firstOrNull { it.text("engine") == ENGINE } ?: return RunnerState.READY
        val error = health.text("installationError").orEmpty()
        if (error.startsWith("DSH_PLATFORM_UNSUPPORTED") || error.startsWith("DSH_NODE_UNSUPPORTED")) return RunnerState.UNSUPPORTED_PLATFORM
        if ((health["installed"] as? JsonPrimitive)?.booleanOrNull == false) return RunnerState.NOT_INSTALLED
        if (health.obj("dsh")?.flag("versionCompatible") == false) return RunnerState.UNSUPPORTED_VERSION
        return RunnerState.READY
    }

    /** What went wrong in a Harness session, when the runner's or the server's message says so, and what its repair card says. */
    enum class Repair(private val title: String, val detail: String) {
        NEEDS_KEY("DeepSeek Harness needs a DeepSeek key",
            "This session has no DeepSeek key to run on. Add or re-enable a DeepSeek key in Infrastructure, then send your message again."),
        INVALID_KEY("DeepSeek rejected this API key", "Update the DeepSeek key in Infrastructure, then send your message again."),
        UPDATE_RUNNER("Waiting for a newer runner", "This runner predates DeepSeek Harness. It updates itself when no session is running on it."),
        NOT_INSTALLED("DeepSeek Harness isn't installed on this runner", "Install it from Infrastructure, then send your message again."),
        UNSUPPORTED_PLATFORM("DeepSeek Harness can't run on this runner",
            "DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only. Move this work to a runner that can.");

        /** The card's title, naming the machine — “wikova” — where what it lacks is the machine's (iOS `DshRepairCardView.title`). */
        fun title(runnerName: String?): String {
            val machine = runnerName?.takeIf { it.isNotEmpty() }?.let { "“$it”" } ?: return title
            return when (this) {
                NOT_INSTALLED -> "DeepSeek Harness isn't installed on $machine"
                UNSUPPORTED_PLATFORM -> "DeepSeek Harness can't run on $machine"
                else -> title
            }
        }

        /** Fixed on the session's own key, in Infrastructure. */
        val isKeyProblem get() = this == NEEDS_KEY || this == INVALID_KEY
    }

    /** The same evidence the runner's own `dshRequestValidation` accepts as a bad key; anything vaguer (a rate limit, a 5xx, a dropped
     * connection) is not one. */
    private val keyRejected = listOf("invalid api key", "api key is invalid", "authentication_error", "authentication fails", "unauthorized",
        "status 401", "status code 401", "http 401", "revoked api key", "api key has been revoked", "invalid credentials")
    /** The real DeepSeek 401 puts the masked key in between: "Your api key: ****0000 is invalid" (runner `dshKeyRejectedPattern`). */
    private val keyRejectedPattern = Regex("api key(?:: *\\S+)? is invalid")

    /** Read a runner's or the server's message about a Harness session for the remedy it implies. A `DSH_REQUEST_FAILED` lead is the
     * runner's verdict from an upstream status and wins over wording. */
    fun repair(message: String?): Repair? {
        val text = message ?: return null
        if (text.startsWith("DSH_REQUEST_FAILED")) return null
        if ("DSH_CREDENTIAL_MISSING" in text) return Repair.NEEDS_KEY
        if ("DSH_CREDENTIAL_INVALID" in text) return Repair.INVALID_KEY
        if (text.startsWith("DeepSeek Harness requires a newer Orbit runner")) return Repair.UPDATE_RUNNER
        if ("DSH_NOT_INSTALLED" in text) return Repair.NOT_INSTALLED
        if ("DSH_PLATFORM_UNSUPPORTED" in text || "DSH_NODE_UNSUPPORTED" in text) return Repair.UNSUPPORTED_PLATFORM
        val lower = text.lowercase()
        if (!lower.startsWith("dsh ")) return null
        if ("no api key" in lower || "missing api key" in lower) return Repair.NEEDS_KEY
        if (keyRejected.any { it in lower }) return Repair.INVALID_KEY
        return if (keyRejectedPattern.containsMatchIn(lower)) Repair.INVALID_KEY else null
    }

    /** Whether an approval card in a session on [engine] may offer "Allow & remember" (OrbitKit `Approvals.rememberOffered`): Harness's
     * approval bridge answers each ask once — allow-once or reject-once — and drops remember rules, so there the next call would ask
     * again. */
    fun rememberOffered(engine: String?) = engine != ENGINE
}
