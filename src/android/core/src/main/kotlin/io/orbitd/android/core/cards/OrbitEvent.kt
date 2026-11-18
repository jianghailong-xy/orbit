package io.orbitd.android.core.cards

/**
 * A turn Orbit opened whose note is a block no dedicated line knows, drawn as one generic line in the agent's stream rather than as the
 * reader's own row (owner rule 2026-11-16: the right side of a conversation is only for words the person typed). Before this, such a turn
 * fell through to a row headed with the reader's name carrying only "Orbit attached: context" over the raw block.
 *
 * Held to OrbitKit's `OrbitEvent.swift` and the web's `OrbitEventLine.tsx` (`OrbitEventCopyParityTest`).
 */
object OrbitEvent {
    const val title = "From Orbit"
    /** Neutral, Orbit's own: neither a success nor a failure. */
    const val mark = "⊕"
    const val details = "Details"
    const val rawSummary = "What the agent read"
    /** The name the line gives a note `describeNote` names nothing in. */
    const val unnamed = "context"

    /** What the line names after its title: [described] (the note as `describeNote` names it), `context` when that names nothing. */
    fun name(described: String): String = described.ifEmpty { unnamed }

    /** Whether a delivered `user` turn is Orbit's alone: nothing typed, nothing attached, and a recorded note. The dedicated lines are
     *  asked first; this is what is left of a turn that would otherwise draw as the reader's row. */
    fun draws(personWords: String, note: String?, hasAttachments: Boolean): Boolean =
        !note.isNullOrBlank() && !hasAttachments && personWords.isBlank()
}
