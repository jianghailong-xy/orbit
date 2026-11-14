package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/**
 * Restart the task: the one action the owner's pending-evidence row offers for a revision nobody else can move
 * (`ownerAction: "RESTART_TASK"`, docs/evidence-always-has-an-addressee-design.md §3, D2 = A). The row arrives in the queue's
 * `waitingOnYou`; a row without the field offers nothing, and an older server never sends it. The press is
 * `POST /tasks/:taskId/evidence/:revision/restart` with the Run press's `triggerId`; one that is no longer offered is refused with
 * 409 `EVIDENCE_RESTART_NOT_OFFERED`. The words are `src/shared/src/evidence-restart-copy.fixture.json`, the same table the web and
 * OrbitKit are held to.
 */
object EvidenceRestart {
    const val ownerAction = "RESTART_TASK"
    const val refusalCode = "EVIDENCE_RESTART_NOT_OFFERED"
    const val action = "Restart the task"
    const val explanation = "No run of this task is live to submit it again, and no coordinator was told to act on it. " +
        "Restart the task and a new run will submit evidence against the standard it is held to now."
    const val started = "Restarted: a new run will submit the evidence again."
    const val refused = "Not restarted"
    const val stale = "Not restarted: this row is out of date"

    /** Whether this row offers Restart the task. Absent, null or a word this client does not know offers nothing. */
    fun offered(row: JsonObject): Boolean = row.text("ownerAction") == ownerAction

    /** A refusal's headline: out of date when the server's code says the row has moved on. */
    fun refusalTitle(code: String?): String = if (code == refusalCode) stale else refused
}
