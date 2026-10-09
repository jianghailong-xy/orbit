package io.orbitd.android.composer

import io.orbitd.android.management.RunnerPage
import kotlinx.serialization.json.*

/** How a session on OpenCode names the configured key it spends (OrbitKit `OpenCodeKeys`, shared `openCodeKeys`): the session's
 * provider stays `opencode` and the key rides in its model as `orbit-<slug>/<model>`; the pickers list the key under OpenCode as
 * `opencode/<slug>`, which no configured slug can be (none holds a `/`). */
internal object OpenCodeKeys {
    private const val MODEL_PREFIX = "orbit-"
    private const val CHOICE_PREFIX = "opencode/"

    /** The OpenCode model id of [model] on the configured key [slug]. */
    fun model(slug: String, model: String) = "$MODEL_PREFIX$slug/$model"

    /** The configured key an OpenCode model id names, and the model on it — null for any other id. */
    fun key(model: String?): Pair<String, String>? {
        if (model == null || !model.startsWith(MODEL_PREFIX)) return null
        val slash = model.indexOf('/').takeIf { it >= 0 } ?: return null
        val slug = model.substring(MODEL_PREFIX.length, slash)
        val rest = model.substring(slash + 1)
        return if (slug.isEmpty() || rest.isEmpty()) null else slug to rest
    }

    /** The picker identity of the configured key [slug] run on OpenCode. */
    fun choice(slug: String) = "$CHOICE_PREFIX$slug"

    /** The configured key an `opencode/<slug>` choice names, or null for any other identity. */
    fun choiceKey(choice: String?): String? =
        choice?.takeIf { it.startsWith(CHOICE_PREFIX) && it.length > CHOICE_PREFIX.length }?.removePrefix(CHOICE_PREFIX)

    /** The picker identity a session runs on: its provider, except that an OpenCode session whose model names a configured
     * key is on that key's choice (web `providerChoiceFor`). */
    fun choice(provider: String, model: String?): String =
        if (provider == "opencode") key(model)?.let { choice(it.first) } ?: provider else provider
}

/**
 * OrbitKit `SessionProviderChoices`: what each row of the composer's Provider list says and where it lands — the engines in
 * iOS's order, why a row can't run on this runner — and the engine named over the model menu.
 */
internal object ProviderChoices {
    /** The engines a runner signs in, in the picker's order (iOS 25697e200). */
    val engineSlugs = listOf("claude", "codex", "antigravity", "kimi")

    /** A built-in provider's name in the picker (OrbitKit `AgentDefaults.providers`). */
    private val builtInNames = mapOf("claude" to "Claude", "codex" to "Codex", "kimi" to "Kimi", "opencode" to "OpenCode",
        "antigravity" to "Antigravity")

    /** A provider's name: a built-in's own, then a configured row's label, then the slug itself. */
    fun providerName(slug: String, providers: List<JsonObject>) =
        builtInNames[slug] ?: providers.firstOrNull { it.text("slug") == slug }?.text("label") ?: slug

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
     * other engine's to a sign-in (iOS d2737d665). */
    fun fixSuffix(fixEngine: String?) = if (fixEngine == "antigravity") " →" else ", sign in →"

    /** The runtime that actually executes [provider] (the server's `execRuntime`): a key run on OpenCode is OpenCode's, a
     * configured key the CLI it borrows, and anything unknown the server's own Claude fallback. */
    fun executingRuntime(provider: String, providers: List<JsonObject>): String {
        if (OpenCodeKeys.choiceKey(provider) != null) return "opencode"
        providers.firstOrNull { it.text("slug") == provider }?.let { row ->
            val borrowed = row.text("runtime").orEmpty()
            return if (borrowed in setOf("codex", "kimi", "antigravity", "dsh")) borrowed else "claude"
        }
        return if (provider in setOf("codex", "kimi", "opencode", "antigravity", "dsh")) provider else "claude"
    }

    /** The CLI a session (or a draft) runs on: the server's own `engine` where it records one (provider/engine contract §6.1), else the
     * one its provider borrows, as before the server said. */
    fun engine(detail: JsonObject, providers: List<JsonObject>) = detail.text("engine") ?: executingRuntime(detail.text("provider").orEmpty(), providers)

    /** The model menu's title (OrbitKit `engineTitle`, web `engineTitleFor`): the CLI running this session — `Claude Code` for a
     * key it writes DeepSeek's models through — and, while a held pick takes the next turn to another engine, that one after an
     * arrow. Two providers of one CLI read as one title. */
    fun engineTitle(provider: String, providers: List<JsonObject>, next: String? = null): String {
        val runtime = executingRuntime(provider, providers)
        val name = RunnerPage.engineName(runtime)
        val after = next?.let { executingRuntime(it, providers) }?.takeIf { it != runtime } ?: return name
        return "$name → ${RunnerPage.engineName(after)}"
    }
}
