package io.orbitd.android.composer

import kotlinx.serialization.json.*

/**
 * The account and runner the boards draw (docs/mocks/provider-engine-decoupling, boards 4–6): machine `hpc` with Claude Code
 * signed in twice, Codex, Antigravity and OpenCode installed, Kimi Code not, and DeepSeek Harness ready; two DeepSeek keys (the
 * second named "DeepSeek 2" by the migration), a GLM key, a Claude subscription token, a Gemini and a Moonshot key, each with the
 * engines GET /providers says it runs on; and a pool of Claude accounts.
 */
internal object EngineFixture {
    fun obj(text: String) = Json.parseToJsonElement(text).jsonObject

    const val RUNNER = """{"id":"r","name":"hpc","displayName":"hpc","capabilities":["provider:dsh","claude-account-move/v1"],"runsAsRoot":false,
        "engines":[
          {"engine":"claude","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"5c2e91a0","name":"Work","auth":"yes"}]},
          {"engine":"codex","installed":true,"auth":"yes"},
          {"engine":"kimi","installed":false},
          {"engine":"antigravity","installed":true,"auth":"yes","authSource":"google"},
          {"engine":"opencode","installed":true},
          {"engine":"dsh","installed":true,"dsh":{"versionCompatible":true}}],
        "runtimeDefaultModels":{"claude":"claude-opus-5-5","dsh":"deepseek-v4-pro"},
        "modelCatalog":{
          "claude":[{"value":"claude-opus-5-5","label":"Opus 5.5","fastMode":true}],
          "codex":[{"value":"gpt-5.6-sol","label":"gpt-5.6-sol","serviceTiers":["priority"],"reasoningLevels":["low","high"]}],
          "opencode":[{"value":"anthropic/claude-sonnet","label":"anthropic/claude-sonnet"}],
          "dsh":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro","reasoningLevels":["high","max"]},{"value":"deepseek-v4-flash","label":"DeepSeek V4 Flash"}]},
        "commands":[{"name":"review","type":"command"},{"name":"kimi-only","provider":"kimi","type":"command"}]}"""

    private fun deepSeekKey(slug: String, label: String) = """{"slug":"$slug","label":"$label","runtime":"claude","presetSlug":"deepseek",
        "engines":["claude","opencode","dsh"],"defaultModel":"deepseek-v4-pro",
        "models":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro","reasoningLevels":["high"]},{"value":"deepseek-v4-flash","label":"DeepSeek V4 Flash"}]}"""

    val KEYS = """[${deepSeekKey("deepseek", "DeepSeek")},${deepSeekKey("deepseek-2", "DeepSeek 2")},
        {"slug":"glm","label":"Z.AI (GLM)","runtime":"claude","presetSlug":"glm","engines":["claude","opencode"],"defaultModel":"glm-5.2","models":[{"value":"glm-5.2","label":"GLM-5.2"}]},
        {"slug":"claude-max","label":"Claude Max","runtime":"claude","presetSlug":"anthropic","engines":["claude"],"modelsFromRuntime":true,"models":[]},
        {"slug":"gemini","label":"Gemini","runtime":"antigravity","presetSlug":"gemini","engines":["antigravity","opencode"],"defaultModel":"gemini-3.8-flash","models":[{"value":"gemini-3.8-flash","label":"Gemini 3.8 Flash"}]},
        {"slug":"moonshot","label":"Kimi (Moonshot)","runtime":"kimi","presetSlug":"moonshot","engines":["kimi","opencode"],"defaultModel":"kimi-k2.7-code","models":[{"value":"kimi-k2.7-code","label":"Kimi K2.7 Code"}]}]"""

    val POOL = """{"slug":"claude-accounts","label":"Claude accounts","members":[]}"""

    fun providers(keys: String = KEYS) = Json.parseToJsonElement(keys).jsonArray.map { it.jsonObject } +
        ProviderEngines.poolRow(obj(POOL), ProviderEngines.CLAUDE)

    fun catalog(runner: String = RUNNER, keys: String = KEYS, own: List<JsonObject>? = null) = ComposerCatalog(obj(runner), providers(keys), own)
}
