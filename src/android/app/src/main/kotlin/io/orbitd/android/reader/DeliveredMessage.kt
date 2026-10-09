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
