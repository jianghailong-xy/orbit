package io.orbitd.android.core.cards

/**
 * Another session's message carries a block delivery appended for the agent (apiserver `sessionMessageBlock`), which only says
 * what the card already shows the reader — who sent it, its task, the request — so the card does not fold it under itself
 * (owner, 2026-11-12; docs/mocks/session-message-attached-line; web `splitSessionMessageNote`, OrbitKit `SessionMessageCard.splitNote`).
 */
object SessionMessageNote {
    /** [rest] is whatever else delivery appended, still folded under the card; [narrower] the card's line for a narrower sender. */
    data class Split(val rest: String, val narrower: String?)

    private val BLOCK = Regex("<orbit-session-message\\b[^>]*>[\\s\\S]*?</orbit-session-message>")
    private val NARROWER = Regex("The sender runs in (\\S+), which is narrower than this session's (\\S+)\\.")

    /** The permission modes as the mode picker names them (web `MODE_OPTIONS`, OrbitKit `AgentDefaults.label`). */
    private val MODE_LABELS = mapOf("default" to "Default", "acceptEdits" to "Accept Edits", "plan" to "Plan", "auto" to "Auto",
        "dontAsk" to "Don't Ask", "bypassPermissions" to "Bypass")

    fun narrower(from: String, to: String): String =
        "Sender runs in ${MODE_LABELS[from] ?: from}, narrower than this session's ${MODE_LABELS[to] ?: to}: not taken as your approval"

    fun split(note: String?): Split {
        if (note == null) return Split("", null)
        val narrower = BLOCK.findAll(note).firstNotNullOfOrNull { NARROWER.find(it.value) }
        return Split(BLOCK.replace(note, "").trim(), narrower?.let { narrower(it.groupValues[1], it.groupValues[2]) })
    }
}
