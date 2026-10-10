package io.orbitd.android.composer

import kotlinx.serialization.json.*

/**
 * OrbitKit `SessionProviderChoices`: why a credential, or an engine, can't run on this runner, and where tapping it goes to fix
 * that — and the engine a session runs on. Which credentials an engine lists is [ComposerCatalog.credentials]'s question.
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

    /** The CLI a session (or a draft) runs on, for good: the server's own `engine` where it records one (provider/engine contract
     * §6.1) — a draft's workspace, the one it last ran (`lastEngine`) — else the engine its provider runs on by default, as the
     * account's [providers] say for a key or a pool ([ProviderEngines.sessionEngine]). */
    fun engine(detail: JsonObject, providers: List<JsonObject>) =
        ProviderEngines.sessionEngine(detail.text("engine") ?: detail.text("lastEngine"), detail.text("provider"), providers)

    /** Whether only the account's keys can say that engine: a server that doesn't say it, on a provider that is no engine's own name
     * (a key, or a pool). */
    fun engineFromKeys(detail: JsonObject) = detail.text("engine") == null && detail.text("provider")?.let { !ProviderEngines.isEngine(it) } == true
}
