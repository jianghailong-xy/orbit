package io.orbitd.android.core.realtime

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class Transcript(
    val events: List<RunEvent> = emptyList(),
    val resumeSeq: Long = 0,
    val hasMore: Boolean = false,
    val seeded: Boolean = false,
    val textDrafts: Map<String, String> = emptyMap(),
    val thinkingDrafts: Map<String, String> = emptyMap(),
    val toolOutputs: Map<String, JsonObject> = emptyMap(),
    val backgroundOutputs: Map<String, JsonObject> = emptyMap(),
    val taskProgress: Map<String, JsonObject> = emptyMap(),
    val settledToolIds: Set<String> = emptySet(),
) {
    val maxSeq: Long get() = maxOf(resumeSeq, events.lastOrNull()?.seq ?: 0)
    val oldestSeq: Long? get() = events.firstOrNull()?.seq

    /** The server sends the whole current prefix again on each connect. Never persist animation
     * or append that prefix to a draft from a spent connection. */
    fun withoutLive() = copy(textDrafts = emptyMap(), thinkingDrafts = emptyMap(),
        toolOutputs = emptyMap(), backgroundOutputs = emptyMap(), taskProgress = emptyMap(), settledToolIds = emptySet())

    fun tail(page: EventPage): Transcript = Transcript().page(page).copy(hasMore = page.hasMore)

    /** REST proves coverage. Live seq is not a contiguous counter (filtered events leave gaps),
     * so persisting its maximum could skip a reordered event after a process dies. Keep a
     * conservative REST frontier alongside the UI high-water and replay the overlap on reconnect. */
    fun page(page: EventPage): Transcript {
        val rows = (events + page.events.filter { it.durable }).associateBy { it.seq }.values.sortedBy { it.seq }
        val frontier = page.events.filter { it.seq in 1 until SENTINEL_SEQ }.maxOfOrNull { it.seq } ?: resumeSeq
        return copy(events = rows.takeLast(WINDOW_SIZE), resumeSeq = maxOf(resumeSeq, frontier),
            hasMore = hasMore || rows.size > WINDOW_SIZE, seeded = true)
    }

    fun apply(event: RunEvent): Transcript {
        if (event.type == "resync" || event.type == "ping") return this
        if (event.durable && events.any { it.seq == event.seq }) return this
        // A late event older than the trimmed window is available through history pagination.
        if (event.durable && hasMore && event.seq < (oldestSeq ?: 0)) return this
        val fields = event.fields
        val parent = fields.text("parentToolUseId") ?: ""
        val text = fields.text("delta") ?: fields.text("text") ?: ""
        val rows = if (event.durable) (events + event).sortedBy { it.seq } else events
        var next = copy(events = rows.takeLast(WINDOW_SIZE), hasMore = hasMore || rows.size > WINDOW_SIZE)
        // Reordered history belongs in its sorted position, without clearing the current draft.
        if (event.durable && event.seq < maxSeq) return if (event.type == "tool_result") {
            val id = fields.text("toolUseId") ?: return next
            next.copy(toolOutputs = toolOutputs - id)
        } else next
        when (event.type) {
            "text_delta" -> next = next.copy(textDrafts = textDrafts + (parent to (textDrafts[parent].orEmpty() + text).takeLast(LIVE_TEXT_LIMIT)))
            "thinking_delta" -> next = next.copy(thinkingDrafts = thinkingDrafts + (parent to (thinkingDrafts[parent].orEmpty() + text).takeLast(LIVE_TEXT_LIMIT)))
            "assistant" -> next = next.copy(textDrafts = textDrafts - parent)
            "thinking" -> next = next.copy(thinkingDrafts = thinkingDrafts - parent)
            "tool_output" -> {
                val id = fields.text("toolUseId") ?: return next
                val lastBoundary = events.lastOrNull { it.type in setOf("user", "turn_end", "interrupt", "result") }?.seq ?: 0
                val use = events.lastOrNull { it.type == "tool_use" && it.fields.text("toolUseId") == id }
                val settled = events.any { it.type == "tool_result" && it.fields.text("toolUseId") == id }
                val background = (use?.fields?.get("input") as? JsonObject)?.text("run_in_background") == "true"
                if (id !in settledToolIds && !settled && !background && (use == null || use.seq > lastBoundary)) {
                    val previous = toolOutputs[id]?.number("snapshotSeq")
                    val version = fields.number("snapshotSeq")
                    if (previous == null || version != null && version > previous) {
                        next = next.copy(toolOutputs = toolOutputs + (id to fields))
                    }
                }
            }
            "tool_result" -> fields.text("toolUseId")?.let { next = next.copy(toolOutputs = toolOutputs - it) }
            "tool_use" -> next = next.copy(textDrafts = textDrafts - parent, thinkingDrafts = thinkingDrafts - parent)
            "background_output" -> fields.text("shellId")?.let { next = next.copy(backgroundOutputs = backgroundOutputs + (it to fields)) }
            "task_progress" -> fields.text("toolUseId")?.let { next = next.copy(taskProgress = taskProgress + (it to fields)) }
            "user", "turn_end", "interrupt", "result" -> next = next.finishLive()
            "status" -> if (fields.text("status") != "RUNNING") next = next.finishLive()
        }
        return next
    }

    private fun finishLive() = withoutLive().copy(settledToolIds = settledToolIds + toolOutputs.keys +
        events.filter { it.type == "tool_use" }.mapNotNull { it.fields.text("toolUseId") })

    companion object {
        const val WINDOW_SIZE = 2_000
        private const val LIVE_TEXT_LIMIT = 256 * 1024
    }
}
