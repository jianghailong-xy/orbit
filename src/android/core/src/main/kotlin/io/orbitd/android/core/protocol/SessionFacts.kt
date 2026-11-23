package io.orbitd.android.core.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

/**
 * The session facts a payload carries beside the legacy `status` (contracts/session-state.contract.json): `phase`, `released`,
 * `lastTurnOutcome`, `waitingOn`, and `endReason` / `workFinished` where sent. Every read answers null for a field that is absent
 * (an older server) or whose word this build does not know, so a caller falls back to the old fields instead of guessing, and a new
 * word never crashes a decode. A new field is never rebuilt from `status`.
 */
object SessionFacts {
    private val PHASES = setOf("PENDING", "RUNNING", "IDLE")
    private val OUTCOMES = setOf("ANSWERED", "FAILED", "INTERRUPTED", "CANCELLED")
    private val WAITING_ON = setOf("PERSON", "HOLD", "WAKE")

    private fun word(o: JsonObject, key: String, known: Set<String>?): String? =
        ((o[key] as? JsonPrimitive)?.takeIf { it.isString })?.contentOrNull?.takeIf { it.isNotEmpty() && (known == null || it in known) }

    fun phase(o: JsonObject): String? = word(o, "phase", PHASES)
    fun lastTurnOutcome(o: JsonObject): String? = word(o, "lastTurnOutcome", OUTCOMES)
    fun waitingOn(o: JsonObject): String? = word(o, "waitingOn", WAITING_ON)
    fun endReason(o: JsonObject): String? = word(o, "endReason", null)
    fun released(o: JsonObject): Boolean? = (o["released"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
    fun workFinished(o: JsonObject): Boolean? = (o["workFinished"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    /** Whether the payload carries the new facts: the server sends them together, and `released` is the one every reader needs. */
    fun present(o: JsonObject): Boolean = released(o) != null

    /** The session's work finished: the server's `workFinished` when sent, else an end reason of task_done. */
    fun finished(o: JsonObject): Boolean = workFinished(o) ?: (endReason(o) == "task_done")

    /** Released after a failed turn with nobody having asked for the end: what "Failed" means (design §12). */
    fun failed(o: JsonObject): Boolean = released(o) == true && lastTurnOutcome(o) == "FAILED" && endReason(o) == null
}
