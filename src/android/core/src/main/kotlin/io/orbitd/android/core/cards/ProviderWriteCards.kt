package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/** One field a provider write sets, in the card's own words. [mono] is a value typed exactly — a URL, a model id. */
data class ProviderWriteField(val caption: String, val value: String, val mono: Boolean)

/** One model on a provider write, with its window ("64K context") and whether it is the default. */
data class ProviderWriteModel(val value: String, val label: String, val context: String, val isDefault: Boolean) {
    /** The line under the id: its display name and its window. */
    val detail get() = listOf(label, context).filter { it.isNotEmpty() }.joinToString(" · ")
}

/**
 * A provider write (`orbit_provider_create` / `_update` / `_delete`) as the card reads it (OrbitKit `ProviderWritePreview`, web
 * `providerWriteInput`): the fields by name, then the model list one model a row. The runner files only what the write sets
 * (`providerCard` in runner-go), so a change shows its changes and nothing it leaves alone. [name] is the label on an add and the
 * slug otherwise; [models] is null when the write leaves the list alone.
 */
data class ProviderWriteCard(val tool: String, val name: String, val fields: List<ProviderWriteField>, val models: List<ProviderWriteModel>?)

/** The provider cards' names and words. A standing yes would let the next write name any endpoint and key, so none is offered. */
object ProviderWriteCards {
    const val createTool = "orbit_provider_create"
    const val updateTool = "orbit_provider_update"
    const val deleteTool = "orbit_provider_delete"
    const val badge = "provider"
    const val models = "Models"
    const val modelsReplace = "Models · replaces the current list"
    const val changeNote = "Only the fields shown change. Everything else stays as it is."
    const val deleteNote = "The provider and its key are removed from your account."
    const val keySet = "Set — not shown"

    private val secrets = setOf("api_key", "token", "secret", "password")

    /** What the endpoint speaks, by the `runtime` a provider is written with. */
    private val protocols = mapOf("claude" to "Anthropic Messages", "codex" to "OpenAI Responses", "kimi" to "Moonshot",
        "antigravity" to "Gemini", "cursor" to "Cursor User API Key")

    fun title(tool: String) = when (tool) {
        createTool -> "Add this provider?"
        updateTool -> "Change this provider?"
        else -> "Delete this provider?"
    }

    /** The yes, in the words of what it does. */
    fun verb(tool: String) = when (tool) {
        createTool -> CardVerb.ADD_PROVIDER
        updateTool -> CardVerb.SAVE_CHANGES
        else -> CardVerb.DELETE_IT
    }

    fun note(tool: String): String? = when (tool) {
        updateTool -> changeNote
        deleteTool -> deleteNote
        else -> null
    }

    /** 65536 → "64K", 1048576 → "1M". Web's `contextSize` and OrbitKit's say the same. */
    fun contextSize(tokens: Int): String = when {
        tokens >= 1_048_576 && tokens % 1_048_576 == 0 -> "${tokens / 1_048_576}M"
        tokens >= 1_000_000 -> (Math.round(tokens / 100_000.0) / 10.0).let { if (it % 1.0 == 0.0) "${it.toInt()}M" else "${it}M" }
        tokens % 1024 == 0 -> "${tokens / 1024}K"
        tokens >= 1000 -> "${Math.round(tokens / 1000.0)}K"
        else -> tokens.toString()
    }

    fun read(tool: String, input: JsonObject): ProviderWriteCard {
        val adding = tool == createTool
        val known = mutableSetOf("slug", "models")
        val fields = buildList {
            fun field(key: String, caption: String, value: String, mono: Boolean) {
                known += key
                if (key in input) add(ProviderWriteField(caption, value, mono))
            }
            // On an add the label is the name under the heading; on a change it is one of the things written.
            if (adding) known += "label" else field("label", "Label", input.text("label").orEmpty(), false)
            val runtime = input.text("runtime").orEmpty()
            field("runtime", "Protocol", protocols[runtime]?.let { "$it ($runtime)" } ?: runtime, false)
            field("baseUrl", "Base URL", input.text("baseUrl").orEmpty(), true)
            field("apiKey", "API key", keySet, false)
            field("defaultModel", "Default model", input.text("defaultModel").orEmpty(), true)
            // Anything a later runner sends that this card has no name for is still shown, never dropped — but a secret by its
            // name only as being set, as the key is.
            input.keys.sorted().filterNot { it in known }.forEach { key ->
                val value = input[key]
                add(if (key.lowercase() in secrets) ProviderWriteField(key, keySet, false)
                    else ProviderWriteField(key, (value as? JsonPrimitive)?.contentOrNull ?: value.toString(), true))
            }
        }
        val defaultModel = input.text("defaultModel").orEmpty()
        val models = (input["models"] as? JsonArray)?.map { element ->
            val row = element as? JsonObject ?: JsonObject(emptyMap())
            val value = row.text("value").orEmpty()
            ProviderWriteModel(value, row.text("label").orEmpty(),
                (row["contextWindow"] as? JsonPrimitive)?.intOrNull?.let { "${contextSize(it)} context" }.orEmpty(),
                value.isNotEmpty() && value == defaultModel)
        }
        return ProviderWriteCard(tool, input.text(if (adding) "label" else "slug").orEmpty(), fields, models)
    }
}
