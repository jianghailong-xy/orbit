package io.orbitd.android.core.cards

/**
 * A long message from another session shows its first [LINES] lines and a "Show more", by its rendered height rather than its length
 * (design: docs/mocks/session-message-clamp/, approved 2026-11-11; web `SessionMessageCard`, `SESSION_MESSAGE_CLAMP_LINES` and
 * `SESSION_MESSAGE_CLAMP_FROM`). Real task-run messages run 500–3,000 characters over 10–40 lines, so a cut by characters never fired on the
 * ones that filled a screen.
 */
object SessionMessageClamp {
    /** Lines a long message shows while folded. */
    const val LINES = 8

    /** A body taller than this many lines folds; one at or under it shows whole, with no toggle. */
    const val FROM = 12

    const val SHOW_MORE = "Show more"
    const val SHOW_LESS = "Show less"

    /** Whether a body [contentPx] tall, at [linePx] a line, folds. No line height to read means nothing folds. */
    fun folds(contentPx: Int, linePx: Float): Boolean = linePx > 0f && contentPx > linePx * FROM

    /** The height a folded body is cut to. */
    fun foldedPx(linePx: Float): Float = linePx * LINES

    fun toggle(expanded: Boolean): String = if (expanded) SHOW_LESS else SHOW_MORE
}
