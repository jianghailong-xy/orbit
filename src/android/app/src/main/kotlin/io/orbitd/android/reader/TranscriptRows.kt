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
    val engine = EngineReading(events)
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
            if (e.seq in engine.rows) return@mapNotNull engine.rows[e.seq]?.let(::TranscriptRow)
            if (e.type in setOf("turn_end", "status", "user_delivery", "init", "system", "result")) return@mapNotNull null
            if (e.type == "tool_result" && e.seq in usedResults) return@mapNotNull null
            val result = if (e.type == "tool_use") engine.toolFailures[e.toolId()]?.takeIf { e.parent().isNullOrEmpty() }
                ?: results[parent to e.toolId()] else null
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

/**
 * What the engine's own reports turn into, read in event order the way OrbitKit's `TranscriptReducer`
 * folds them: a `system` event's notice or recoverable diagnostic is a notice row, its stderr an error
 * row (repeats folded as "×N", continuation lines joined, a tool's failure settling that call), and a
 * reply or error event that is really the provider failing becomes an error row or an auto-retry row.
 */
internal class EngineReading(events: List<RunEvent>) {
    /** Each listed event's own row in its place, or null where it draws none (silent, benign, folded). */
    val rows = HashMap<Long, RunEvent?>()
    /** Top-level calls an engine failure on stderr settled: the failure stands as their result. */
    val toolFailures = HashMap<String, RunEvent>()

    private class Stderr(val event: RunEvent, var message: String)
    private class Failure(val seq: Long, val toolId: String, var message: String)
    private class Retry(val event: RunEvent, val message: String, val quota: Boolean, val afterUserMsg: Boolean) { var stale = false }

    init {
        val stderrRows = mutableListOf<Stderr>()
        val failures = mutableListOf<Failure>()
        val retries = mutableListOf<Retry>()
        val seen = HashMap<String, Triple<Stderr, String, Int>>()
        var lastStderr: Triple<Stderr, Long, Boolean>? = null
        var lastFailure: Failure? = null
        val open = LinkedHashMap<String, String>()
        var lastRow: RunEvent? = null
        fun retry(e: RunEvent, message: String, quota: Boolean) {
            retries.lastOrNull()?.stale = true
            val afterUserMsg = lastRow?.let { it.type == "user" && it.personWords().isNotBlank() } == true
            retries += Retry(e, message, quota, afterUserMsg); lastRow = e
        }
        // The ladder's order is OrbitKit's: a sign-in failure is not this row's to draw at all.
        fun selfHealing(e: RunEvent, message: String): Boolean = when {
            EngineAuth.isAuthErrorText(message) -> false
            EngineErrors.isUsageLimitErrorText(message) -> { retry(e, message, quota = true); true }
            EngineErrors.isRetryableApiErrorText(message) -> { retry(e, message, quota = false); true }
            else -> false
        }
        events.forEach { e ->
            // A tool call can sit between a stderr line and its continuation; anything else ends the log.
            if (e.type !in setOf("system", "tool_use", "tool_result")) { lastStderr = null; lastFailure = null }
            if (!e.parent().isNullOrEmpty() && e.type in setOf("assistant", "thinking", "tool_use", "tool_result")) {
                // A provider error inside a sub-agent is part of what it did, not a card asking anyone to retry.
                val text = e.fields.string("text") ?: e.fields.string("content") ?: ""
                if (e.type == "assistant" && (EngineErrors.isApiErrorText(text) || EngineErrors.isUsageLimitErrorText(text) ||
                        EngineAuth.isAuthErrorText(text))) rows[e.seq] = e.row("error") { put("text", text) }
                return@forEach
            }
            when (e.type) {
                "tool_use" -> { e.toolId()?.let { open[it] = e.fields.string("name") ?: e.fields.string("toolName") ?: "tool" }; lastRow = e }
                "tool_result" -> { val id = e.toolId(); if (id != null) open.remove(id) else open.keys.lastOrNull()?.let { open.remove(it) } }
                "user" -> { retries.lastOrNull()?.stale = true; lastRow = e }
                "assistant" -> {
                    val text = e.fields.string("text") ?: e.fields.string("content") ?: ""
                    if (!selfHealing(e, text)) {
                        if (!EngineAuth.isAuthErrorText(text) && EngineErrors.isApiErrorText(text)) rows[e.seq] = e.row("error") { put("text", text) }
                        lastRow = e
                    }
                }
                "error" -> if (!selfHealing(e, e.fields.string("message") ?: e.fields.string("error") ?: e.fields.string("text") ?: "error")) lastRow = e
                "thinking", "interrupt" -> lastRow = e
                "system" -> {
                    if (e.fields.string("subtype") == "resumed") { lastStderr = null; lastFailure = null }
                    // A deliberate heads-up wins over stderr; a recoverable diagnostic reads the same way.
                    val notice = e.fields.string("notice")?.ifEmpty { null }
                    val diagnostic = if (notice == null) EngineStderr.recoverableDiagnostic(e.fields) else null
                    if (notice != null || diagnostic != null) {
                        rows[e.seq] = e.row("notice") { put("text", notice ?: diagnostic) }
                        lastRow = e
                        if (notice == null) { lastStderr = null; lastFailure = null }
                        return@forEach
                    }
                    rows[e.seq] = null
                    val line = e.fields.string("stderr")?.let(EngineStderr::clean)
                    if (line.isNullOrEmpty() || EngineStderr.isBenign(line)) { lastStderr = null; lastFailure = null; return@forEach }
                    // A failed apply_patch keeps its continuation on the call it settled, even across a sequence gap.
                    lastFailure?.let { failure ->
                        if (!EngineStderr.startsNewLog(line)) { failure.message += "\n$line"; return@forEach }
                    }
                    val toolFailure = EngineStderr.toolFailure(line)
                    val wanted = toolFailure?.tool?.trim()?.lowercase().orEmpty()
                    val call = if (toolFailure == null) null else open.entries.lastOrNull { wanted.isEmpty() || it.value.lowercase() == wanted }?.key
                    if (call != null) {
                        open.remove(call)
                        lastFailure = Failure(e.seq, call, line).also { failures += it }
                        lastStderr = null
                        return@forEach
                    }
                    lastFailure = null
                    lastStderr?.let { (row, seq, continuing) ->
                        if (e.seq > 0 && seq + 1 == e.seq && continuing && !EngineStderr.startsNewLog(line)) {
                            row.message += "\n$line"; lastStderr = Triple(row, e.seq, true); return@forEach
                        }
                    }
                    // A repeat bumps the first row's count: codex re-reports one line on every request.
                    val key = EngineStderr.foldKey(line)
                    val folded = seen[key]
                    if (folded != null) {
                        val (row, first, count) = folded
                        seen[key] = Triple(row, first, count + 1); row.message = "$first ×${count + 1}"
                        lastStderr = Triple(row, e.seq, EngineStderr.canStartContinuation(line))
                        return@forEach
                    }
                    val row = Stderr(e, line).also { stderrRows += it }
                    seen[key] = Triple(row, line, 1)
                    lastStderr = Triple(row, e.seq, EngineStderr.canStartContinuation(line)); lastRow = e
                }
            }
        }
        stderrRows.forEach { row -> rows[row.event.seq] = row.event.row("error") { put("text", row.message) } }
        failures.forEach { f -> toolFailures[f.toolId] = RunEvent("tool_result", f.seq, buildJsonObject {
            put("toolUseId", f.toolId); put("content", f.message); put("isError", true)
        }) }
        retries.forEach { r -> rows[r.event.seq] = r.event.row("auto_retry") {
            put("text", r.message); put("variant", if (r.quota) "quota" else "apiError")
            put("stale", r.stale); put("afterUserMsg", r.afterUserMsg)
        } }
    }

    /** The row an event is read as: its own sequence and anchor, a payload of its own, nothing left to fetch. */
    private fun RunEvent.row(type: String, build: JsonObjectBuilder.() -> Unit) =
        copy(type = type, payload = buildJsonObject(build), truncated = false)
}

/** A signed-out engine's own words (OrbitKit `EngineAuth.isAuthErrorText`): a sign-in remedy, not an API error. */
internal object EngineAuth {
    fun isAuthErrorText(text: String?): Boolean = text != null && text.trimStart().startsWith("Failed to authenticate")
}

internal fun anchorRow(rows: List<TranscriptRow>, seq: Long): TranscriptRow? =
    rows.firstOrNull { it.contains(seq) } ?: rows.lastOrNull { it.event.seq <= seq } ?: rows.firstOrNull()
