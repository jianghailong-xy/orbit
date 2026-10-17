package io.orbitd.android.taskprojects

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A burst of control events becomes one read two seconds after the first, and the next event does not
 * cancel a read already under way (`ProjectsModel.nudge`): a steady stream still lets the page read what
 * changed, where restarting a short wait on every event would never read at all. */
class RefreshNudge(private val scope: CoroutineScope, private val delayMs: Long = 2_000, private val read: suspend () -> Unit) {
    private var pending: Job? = null

    fun nudge() {
        if (pending?.isActive == true) return
        pending = scope.launch {
            delay(delayMs)
            // Cleared before the read: an event that arrives while it runs asks for one more.
            pending = null
            read()
        }
    }
}
