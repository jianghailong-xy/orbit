package io.orbitd.android.directory

/**
 * A new session held by Keep Free (queuedReason `disk_below_floor`): its workspace's disk has less free than its runner's floor, so the
 * server does not start it until the runner reports space above it. Said where a full runner is: the list's and header's word, and the
 * foot-row tag `Queued · low disk space` opening to why. Every word is web `runnerSlots.ts`'s (`DISK_LOW_TITLE`, `DISK_LOW_WAIT`).
 */
internal object QueuedDiskLow {
    const val REASON = "disk_below_floor"
    const val TITLE = "Low disk space"
    const val TAG = "low disk space"
    const val WAIT = "This runner has less free disk space than its Keep Free setting. This session starts once space is freed."

    fun isDiskHeld(gate: QueuedGate?): Boolean = gate?.queuedReason == REASON
}
