package io.orbitd.android.reader

/**
 * Whether a pinned transcript is carried back to its tail because the VIEWPORT changed size under it —
 * the keyboard rising over the last line, the composer growing a line, the system bars or the sticky
 * question header moving — OrbitKit's `TailPinning.followsResize` (iOS 50eb1b9b1, web's ResizeObserver).
 * Following answers "did the reader leave the tail?"; nothing re-anchors the bottom when the list itself
 * shrinks, so the last line would sit below the fold until the next message happened to re-pin it.
 * 0 is "not measured yet", which no real viewport is: an unknown is never a resize.
 */
internal object TailPinning {
    fun followsResize(wasPinned: Boolean, previousHeight: Int, currentHeight: Int): Boolean =
        wasPinned && previousHeight > 0 && currentHeight > 0 && currentHeight != previousHeight
}

/** The transcript viewport's last measured height, asked on every measure whether a pinned reader must follow it. */
internal class TranscriptViewport {
    private var height = 0
    fun resized(next: Int, pinned: Boolean): Boolean {
        val previous = height
        height = next
        return TailPinning.followsResize(pinned, previous, next)
    }
}
