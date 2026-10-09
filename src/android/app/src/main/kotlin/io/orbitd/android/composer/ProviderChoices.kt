package io.orbitd.android.composer

import io.orbitd.android.management.RunnerPage
import kotlinx.serialization.json.*

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

    /** The runtime that actually executes [provider] (the server's `execRuntime`): a configured key the CLI it borrows, and
     * anything unknown the server's own Claude fallback. */
    fun executingRuntime(provider: String, providers: List<JsonObject>): String {
        providers.firstOrNull { it.text("slug") == provider }?.let { row ->
            val borrowed = row.text("runtime").orEmpty()
            return if (borrowed in setOf("codex", "kimi", "antigravity", "dsh")) borrowed else "claude"
        }
        return if (provider in setOf("codex", "kimi", "opencode", "antigravity", "dsh")) provider else "claude"
    }

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
