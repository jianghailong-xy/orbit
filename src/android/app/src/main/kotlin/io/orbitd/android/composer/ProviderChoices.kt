package io.orbitd.android.composer

import kotlinx.serialization.json.*

/**
 * OrbitKit `SessionProviderChoices`: why a credential, or an engine, can't run on this runner, and where tapping it goes to fix
 * that. Which credentials an engine lists is [ComposerCatalog.credentials]'s question.
 */
internal object ProviderChoices {
    /** Missing outranks signed out; a runner that reports nothing on the engine claims nothing. */
    fun engineBlocker(health: JsonObject?): String? = when {
        health == null -> null
        health.flag("installed") == false -> "Not installed"
        health.text("auth") == "no" -> "Not signed in"
        else -> null
    }

    /** A configured key runs by borrowing an engine's CLI: the binary has to be there, and no sign-in applies. */
    fun byokBlocker(health: JsonObject?) = if (health?.flag("installed") == false) "Not installed" else null

    /** Antigravity's own reasons (iOS d2737d665, cd8e8a41a), from the server's `runner.antigravity`: a runner too old to run it,
     * the CLI not installed — and, for a pick that runs on a sign-in rather than a key, a lapsed Google sign-in or the engine's
     * own answer. */
    fun antigravityBlocker(state: JsonObject?, health: JsonObject?, login: Boolean = false): String? {
        if (state?.flag("supported") == false) return "Update runner"
        if (state?.flag("installed") == false) return "Not installed"
        if (!login) return byokBlocker(health)
        if (state?.text("authSource") == "google" && state.flag("envKeyAvailable") == false) return "Not signed in"
        return engineBlocker(health)
    }

    /** The arrow that closes a row's reason, where tapping the row goes: Antigravity's install-or-key row to its engine page, every
     * other engine's signed-out row to a sign-in (iOS d2737d665), and a missing CLI or a runner too old to its engine page. */
    fun fixSuffix(fixEngine: String?, reason: String?) = if (fixEngine != "antigravity" && reason == "Not signed in") ", sign in →" else " →"
}
