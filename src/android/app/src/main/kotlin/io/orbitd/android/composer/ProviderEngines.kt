package io.orbitd.android.composer

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI

/**
 * Which engines a credential runs on: the compatibility table of the provider/engine split (docs/provider-engine-contract.md
 * §2.1), the Kotlin mirror of @orbit/shared `providerEngines.ts` (OrbitKit mirrors it too; keep the three in sync).
 *
 * A session has two axes. Its engine is the CLI on the runner that produced its runtimeSessionId, fixed for the session's life.
 * Its provider is only where the credential comes from: the engine's own sign-in on the runner (the slug is the engine's name),
 * an account pool, a configured key, or OpenCode's own config. A key's answer never needs the key itself: whether it holds a
 * Claude subscription token only the server can tell, so a client reads each key's engines off GET /providers (`engines`).
 */
object ProviderEngines {
    const val CLAUDE = "claude"
    const val CODEX = "codex"
    const val KIMI = "kimi"
    const val ANTIGRAVITY = "antigravity"
    const val OPENCODE = "opencode"
    const val DSH = "dsh"
    const val CURSOR = "cursor"

    /** Every engine a session can run on, in the order a picker lists them. */
    val ALL_ENGINES = listOf(CLAUDE, CODEX, KIMI, ANTIGRAVITY, OPENCODE, DSH, CURSOR)

    /** Each engine's CLI by its own product name: what every engine list, title and pin says. */
    val ENGINE_CLI_NAMES = mapOf(CLAUDE to "Claude Code", CODEX to "Codex", KIMI to "Kimi Code", ANTIGRAVITY to "Antigravity CLI",
        OPENCODE to "OpenCode", DSH to "DeepSeek Harness", CURSOR to "Cursor CLI")

    /**
     * Whether this app draws [engine] in a list of engines, given the runners in view — the account's, where a page has them, else the
     * one it is about (web `webShowsEngine`, OrbitKit `appleShowsEngine`). Every engine but Cursor CLI always; Cursor CLI once one of
     * those runners knows it (CursorRuntime.knows: it declares `provider:cursor` or reports the engine), which is the order its rollout
     * keeps: the runners and what they declare first, then the entrances (project P9). Until then the New Session's engines, a task's
     * engine pin, Infrastructure's engine cards and a runner's Engines rows leave it out, and the app reads as it did before Cursor CLI;
     * from then on a machine that predates it says so on its row.
     */
    fun androidShowsEngine(engine: String?, runners: List<JsonObject>?) = engine != CURSOR || runners.orEmpty().any(CursorRuntime::knows)

    /** The engines whose own sign-in on the runner is a credential: the provider slug is the engine's name. */
    val LOGIN_ENGINES = listOf(CLAUDE, CODEX, KIMI, ANTIGRAVITY, CURSOR)

    /** The permission modes DeepSeek Harness enforces (@orbit/shared `DSH_PERMISSION_MODES`); the server refuses the rest. */
    val DSH_PERMISSION_MODES = listOf("default", "auto", "dontAsk")

    fun isEngine(value: String?) = value in ALL_ENGINES
    fun cliName(engine: String) = ENGINE_CLI_NAMES[engine] ?: engine

    /** Where a session's credential comes from — the four kinds a provider slug can name. */
    sealed interface Credential {
        /** The engine's own sign-in on the runner; the provider slug is the engine's name. */
        data class Login(val engine: String) : Credential
        /** An account pool, which runs on the engine it was made on. */
        data class Pool(val engine: String) : Credential
        /** A configured key. [runtime] is the row's column, which names the protocol its endpoint speaks; [subscriptionToken] is
         * whether the key is a Claude subscription token (`sk-ant-oat…`), which Anthropic serves to Claude Code alone. */
        data class Key(val runtime: String?, val presetSlug: String?, val baseUrl: String, val subscriptionToken: Boolean = false) : Credential
        /** OpenCode's own provider configuration on the runner. */
        data object OpenCode : Credential
    }

    /** The dialect a key's endpoint speaks, from the runtime its row borrows (@orbit/shared `keyDialect`). DeepSeek Harness rows
     * hold DeepSeek's Anthropic-compatible endpoint; a Cursor User API Key speaks Cursor's own, which is no model API; anything unknown
     * speaks nothing. */
    fun keyDialect(runtime: String?): String? = when (runtime ?: CLAUDE) {
        CLAUDE, DSH -> "anthropic"
        CODEX -> "openai"
        KIMI -> "openai-compatible"
        ANTIGRAVITY -> "gemini"
        CURSOR -> "cursor"
        else -> null
    }

    /** The engine whose own protocol each dialect is: what a key runs on when nothing else is named. */
    private val NATIVE_ENGINE = mapOf("anthropic" to CLAUDE, "openai" to CODEX, "openai-compatible" to KIMI, "gemini" to ANTIGRAVITY,
        "cursor" to CURSOR)

    private const val DEEPSEEK_HOST = "api.deepseek.com"
    /** The presets whose key is a DeepSeek platform key. `deepseek-harness` rows exist until the migration folds them in. */
    private val DEEPSEEK_PRESETS = setOf("deepseek", "deepseek-harness")

    /** Whether a row's key is a DeepSeek account's, the only keys DeepSeek Harness runs on: a preset row by its preset, a custom
     * one by its endpoint being DeepSeek's own host. */
    fun isDeepSeekKey(presetSlug: String?, baseUrl: String): Boolean {
        if (!presetSlug.isNullOrEmpty()) return presetSlug in DEEPSEEK_PRESETS
        return try { URI(baseUrl).host?.lowercase() == DEEPSEEK_HOST } catch (_: Exception) { false }
    }

    /** The engines [credential] can run on, its default engine first and the rest in ALL_ENGINES order; empty when nothing can
     * run it (a key on a protocol no engine speaks). */
    fun credentialEngines(credential: Credential): List<String> = when (credential) {
        is Credential.Login -> if (isEngine(credential.engine)) listOf(credential.engine) else emptyList()
        is Credential.Pool -> if (isEngine(credential.engine)) listOf(credential.engine) else emptyList()
        Credential.OpenCode -> listOf(OPENCODE)
        is Credential.Key -> keyEngines(credential)
    }

    private fun keyEngines(key: Credential.Key): List<String> {
        val dialect = keyDialect(key.runtime) ?: return emptyList()
        if (key.subscriptionToken) return if (dialect == "anthropic") listOf(CLAUDE) else emptyList()
        // A Cursor key is spent by Cursor CLI alone: it is no model API OpenCode could call.
        if (dialect == "cursor") return listOf(CURSOR)
        // A row still on the retired `dsh` runtime ran on DeepSeek Harness, and keeps doing so by default.
        val legacyDsh = key.runtime == DSH
        val native = if (legacyDsh) DSH else NATIVE_ENGINE.getValue(dialect)
        val runs = mutableSetOf(NATIVE_ENGINE.getValue(dialect), OPENCODE)
        if (dialect == "anthropic" && (legacyDsh || isDeepSeekKey(key.presetSlug, key.baseUrl))) runs += DSH
        return listOf(native) + ALL_ENGINES.filter { it != native && it in runs }
    }

    /** The engine a caller that names only the credential gets, or null when nothing can run it. */
    fun defaultEngineOf(credential: Credential): String? = credentialEngines(credential).firstOrNull()

    fun isEngineCompatible(engine: String, credential: Credential) = engine in credentialEngines(credential)

    // What a client reads: the server's answer for each key, off its payloads.

    /** The engine whose own protocol a row's endpoint speaks — its model table's home. */
    fun nativeEngine(runtime: String?): String = keyDialect(runtime)?.let(NATIVE_ENGINE::getValue) ?: CLAUDE

    /**
     * The engines [provider] runs on, the one a session naming only it gets first: an engine's own sign-in its engine, OpenCode's
     * own config OpenCode, a key what GET /providers says (`engines`), a pool its own engine. A row from a payload that predates
     * `engines` reads as its protocol's engine, plus OpenCode where the server said so (`runsOnOpenCode`). The legacy built-in
     * `dsh` is DeepSeek Harness on the key its workspace's environment holds. Empty for a provider [rows] does not have (removed,
     * turned off, not loaded yet).
     */
    fun providerEngines(provider: String?, rows: List<JsonObject>): List<String> {
        if (provider.isNullOrEmpty()) return emptyList()
        if (provider in LOGIN_ENGINES) return listOf(provider)
        if (provider == OPENCODE) return listOf(OPENCODE)
        val row = rows.firstOrNull { it.text("slug") == provider }
        if (row != null) {
            if (row["engines"] is JsonArray) return row.strings("engines").filter(::isEngine)
            val native = if (row.text("runtime") == DSH) DSH else nativeEngine(row.text("runtime"))
            return if (row.flag("runsOnOpenCode") == true) listOf(native, OPENCODE) else listOf(native)
        }
        return if (provider == DSH) listOf(DSH) else emptyList()
    }

    fun defaultEngineOf(provider: String?, rows: List<JsonObject>): String? = providerEngines(provider, rows).firstOrNull()

    /** A vendor's name, as its keys are called in a sentence: one key runs on several engines, so it is never named after one. */
    private val KEY_VENDORS = mapOf("anthropic" to "Anthropic", "openai" to "OpenAI", "gemini" to "Google Gemini", "deepseek" to "DeepSeek",
        "deepseek-harness" to "DeepSeek", "moonshot" to "Moonshot", CursorRuntime.KEY_PRESET to "Cursor", "glm" to "Z.AI", "minimax" to "MiniMax",
        "qwen" to "Qwen")

    /** A key as a sentence names it, for the middle of one: `the DeepSeek key “DeepSeek 2”` — its vendor and the name its owner gave
     * it, never its slug; a custom endpoint is DeepSeek's when DeepSeek Harness runs it (`engines`, which only the server can tell).
     * OrbitKit `SessionProviderChoices.keyName`, web `keyName`. */
    fun keyName(row: JsonObject): String {
        val preset = row.text("presetSlug")
        val vendor = if (!preset.isNullOrEmpty()) KEY_VENDORS[preset] else KEY_VENDORS["deepseek"]?.takeIf { DSH in row.strings("engines") }
        val label = row.text("label") ?: row.text("slug").orEmpty()
        return if (vendor != null) "the $vendor key “$label”" else "the key “$label”"
    }

    /** An account pool read as a provider row: it runs on the engine it was made on and nowhere else — Claude Code for one's own
     * unless it says otherwise, Codex for a shared one ([fallback]) — with that engine's catalogue as its model space. [shared]
     * marks one shared with the account, whose members are keys picked for it rather than its own accounts. */
    fun poolRow(row: JsonObject, fallback: String, shared: Boolean = false): JsonObject = (row.text("engine") ?: fallback).let { engine ->
        JsonObject(row + mapOf("runtime" to JsonPrimitive(engine), "engines" to JsonArray(listOf(JsonPrimitive(engine))),
            "pool" to JsonPrimitive(true), "modelsFromRuntime" to JsonPrimitive(true), "sharedPool" to JsonPrimitive(shared)))
    }

    /** The engine a session (or a draft, or a workspace's next session) runs on: the one recorded, which never changes — else the
     * engine its provider ran on before engines were recorded, and Claude Code when even that provider is gone. */
    fun sessionEngine(engine: String?, provider: String?, rows: List<JsonObject>): String =
        engine?.takeIf(::isEngine) ?: defaultEngineOf(provider, rows) ?: CLAUDE
}
