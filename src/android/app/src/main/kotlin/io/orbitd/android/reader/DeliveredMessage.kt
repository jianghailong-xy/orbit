package io.orbitd.android.reader

import io.orbitd.android.core.realtime.RunEvent

/**
 * A `user` event's text split where the apiserver recorded that the person's words end (OrbitKit's
 * `splitRecordedNote`). `controlPlaneNote` is exactly what delivery appended, stored beside an echo
 * that is left whole, so the split is a slice rather than a reading of the text. The note comes back
 * trimmed, as the block the model read. Null when the event carries no note, or one that is not the
 * end of its text — then the bubble is exactly what the runner echoed.
 */
internal fun splitRecordedNote(text: String?, note: String?): Pair<String, String>? {
    if (text == null || note == null) return null
    val trimmed = note.trim()
    if (trimmed.isEmpty() || !text.endsWith(note)) return null
    return text.dropLast(note.length) to trimmed
}

/** The words the person typed: the echo without what delivery appended to it. */
internal fun RunEvent.personWords(): String =
    splitRecordedNote(fields.string("text"), fields.string("controlPlaneNote"))?.first ?: body()

/** What each of Orbit's blocks is called where it is shown — web's `TAG_LABEL`. */
private val injectedTagLabels = mapOf(
    "referenced-list" to "referenced list",
    "referenced-task" to "referenced task",
    "orbit_project_coordinator_context" to "project coordinator context",
    "list-conditions" to "list conditions",
    "background-jobs" to "background jobs",
    "orbit-session-message" to "session message",
    "orbit-session-reply" to "session reply",
)

private fun openingTag(text: String): String? {
    if (!text.startsWith("<")) return null
    val tag = text.drop(1).takeWhile { it.code < 128 && (it.isLetterOrDigit() || it in "_-") }
    val next = text.getOrNull(1 + tag.length) ?: return null
    return tag.takeIf { it.isNotEmpty() && (next == '>' || next.isWhitespace()) }
}

/**
 * "referenced list, referenced task ×2" — what a recorded note holds, each block named by its opening
 * tag and skipped past its closing one (OrbitKit's `describeNote`). Only a name: nothing here decides
 * what is shown as the person's.
 */
internal fun describeNote(note: String): String {
    val names = mutableListOf<String>()
    var rest = note.trim()
    while (rest.isNotEmpty()) {
        val tag = openingTag(rest)
        names += tag?.let { injectedTagLabels[it] } ?: "context"
        val close = tag?.let { rest.indexOf("\n</$it>") }?.takeIf { it >= 0 } ?: break
        rest = rest.substring(close + "\n</$tag>".length).trim()
    }
    val counts = names.groupingBy { it }.eachCount()
    return names.distinct().joinToString(", ") { name -> counts.getValue(name).let { if (it > 1) "$name ×$it" else name } }
}
