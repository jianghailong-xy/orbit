package io.orbitd.android.reader

import androidx.compose.runtime.Immutable
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*

internal fun JsonObject.string(key: String) = (get(key) as? JsonPrimitive)?.contentOrNull
internal fun RunEvent.toolId() = fields.string("toolUseId") ?: fields.string("tool_use_id") ?: fields.string("id")
internal fun RunEvent.parent() = fields.string("parentToolUseId")
internal fun RunEvent.body() = fields.string("text") ?: contentText(fields["content"]) ?: fields.string("message") ?: fields.string("result").orEmpty()

internal fun contentText(value: JsonElement?): String? = when (value) {
    null, JsonNull -> null
    is JsonPrimitive -> value.content
    is JsonArray -> value.mapNotNull { block ->
        val obj = block as? JsonObject
        when (obj?.string("type")) { "image" -> null; "text" -> obj.string("text"); else -> contentText(block) }
    }.joinToString("\n").ifEmpty { null }
    is JsonObject -> if (value["content"] is JsonArray) contentText(value["content"]) else value.toString()
}
internal fun contentImages(value: JsonElement?): List<String> = when (value) {
    is JsonObject -> if (value["content"] is JsonArray) contentImages(value["content"]) else if (value.string("type") == "image") {
        val source = value["source"] as? JsonObject
        val data = source?.string("data") ?: value.string("data")
        if (!data.isNullOrEmpty()) listOf("data:${source?.string("media_type") ?: value.string("mimeType") ?: "image/png"};base64,$data") else emptyList()
    } else emptyList()
    is JsonArray -> value.flatMap { contentImages(it) }
    else -> emptyList()
}

@Immutable
internal data class TranscriptRow(val event: RunEvent, val result: RunEvent? = null, val children: List<TranscriptRow> = emptyList()) {
    val key: String get() = "event:${event.seq}"
    fun contains(seq: Long): Boolean = event.seq == seq || result?.seq == seq || children.any { it.contains(seq) }
}

/** Project only durable changes. Live text and tool snapshots are passed to their own row. */
internal fun transcriptRows(events: List<RunEvent>): List<TranscriptRow> {
    // Project an unexplained end as a readable error with the original anchor. A bounded page
    // starting mid-turn cannot prove there was no earlier reply, so wait for an ordinary user or boundary.
    // A steer joins the current turn; it cannot establish the start of a truncated one.
    var knownTurn = false
    var accountedFor = false
    val unexplained = mutableSetOf<Long>()
    events.forEach { event ->
        when (event.type) {
            "user" -> if (event.fields["steer"] != JsonPrimitive(true)) knownTurn = true
            "assistant", "error", "auth_error", "auto_retry", "interrupt" -> accountedFor = true
            "turn_end" -> {
                val subtype = event.fields.string("subtype").orEmpty()
                val authoritativeStatus = event.fields.string("status") in setOf("PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "AWAITING_INPUT", "INTERRUPTED")
                if (knownTurn && !accountedFor && !authoritativeStatus && subtype.isNotEmpty() && subtype !in setOf("success", "completed")) unexplained += event.seq
                accountedFor = false; knownTurn = true
            }
        }
    }
    val knownTools = events.filter { it.type == "tool_use" }.mapNotNull { it.toolId() }.toSet()
    fun parent(event: RunEvent) = event.parent()?.takeIf(knownTools::contains)
    val results = events.filter { it.type == "tool_result" && it.toolId() != null }
        .associateBy { parent(it) to it.toolId() }
    val usedResults = mutableSetOf<Long>()
    val grouped = events.groupBy(::parent)
    fun rows(parent: String?, visited: Set<String>): List<TranscriptRow> {
        return grouped[parent].orEmpty().mapNotNull { e ->
            if (e.seq in unexplained) return@mapNotNull TranscriptRow(e.copy(type = "error", payload = buildJsonObject {
                put("text", "This turn ended without a reply — send the message again to retry.")
            }))
            if (e.type in setOf("turn_end", "status", "user_delivery", "init", "system", "result")) return@mapNotNull null
            if (e.type == "tool_result" && e.seq in usedResults) return@mapNotNull null
            val result = if (e.type == "tool_use") results[parent to e.toolId()] else null
            result?.let { usedResults += it.seq }
            val id = e.toolId()
            val children = if (e.type == "tool_use" && id != null && id !in visited) rows(id, visited + id) else emptyList()
            TranscriptRow(e, result, children)
        }
    }
    // Results may precede calls in a restored partial window; suppress matched results independent of order.
    events.filter { it.type == "tool_use" }.forEach { e -> results[parent(e) to e.toolId()]?.let { usedResults += it.seq } }
    return rows(null, emptySet())
}

internal fun anchorRow(rows: List<TranscriptRow>, seq: Long): TranscriptRow? =
    rows.firstOrNull { it.contains(seq) } ?: rows.lastOrNull { it.event.seq <= seq } ?: rows.firstOrNull()
