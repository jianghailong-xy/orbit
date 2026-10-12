package io.orbitd.android.core.cards

/**
 * OrbitKit `EngineAuth.AntigravityRepair` (iOS d2737d665, cd8e8a41a): the Antigravity failures that earn a repair card in the
 * conversation — no credential to run on, a runner too old to run Antigravity, the CLI not installed — and what the card says.
 */
enum class AntigravityRepair {
    NEEDS_KEY, UPDATE_RUNNER, NOT_INSTALLED;

    fun title(runnerName: String?) = when (this) {
        NEEDS_KEY -> "Antigravity needs authentication"
        UPDATE_RUNNER -> "Waiting for a newer runner"
        NOT_INSTALLED -> "Antigravity CLI isn't installed on ${machine(runnerName)}"
    }

    fun body(runnerName: String?, runnerVersion: String?) = when (this) {
        NEEDS_KEY -> "Sign in with Google on this runner, or connect a Gemini API key in Providers."
        UPDATE_RUNNER -> "${machine(runnerName)} runs Orbit runner ${runnerVersion?.takeIf { it.isNotEmpty() } ?: "an unknown version"}; " +
            "Antigravity needs 0.1.209 or newer. The runner updates itself when no session is running on it, and this session starts then."
        NOT_INSTALLED -> "Install it from Providers, then send your message again."
    }

    companion object {
        /** The runtime's failure, or the queue's capability gate, in the words the runner and the server say them. */
        fun of(message: String?): AntigravityRepair? = when {
            message == null -> null
            message.startsWith("Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one") -> NEEDS_KEY
            message == "Antigravity requires a newer Orbit runner; update this runner first" -> UPDATE_RUNNER
            "Antigravity isn't installed" in message || "Antigravity CLI isn't installed" in message ||
                "Antigravity CLI (\"agy\") not found" in message -> NOT_INSTALLED
            else -> null
        }

        private fun machine(name: String?) = name?.takeIf { it.isNotEmpty() } ?: "this runner"
    }
}
