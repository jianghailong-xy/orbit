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

    /** What a release establishes about the session: "FINISHED" when its work finished (the server's `workFinished` when sent, else
     * end reason task_done, else a landing container released with no end reason), "FAILED" when a failed turn ended it and nobody
     * asked for the end, else "ENDED" (OrbitKit `SessionRunState.afterRelease`). */
    fun afterRelease(endReason: String?, lastTurnOutcome: String?, workFinished: Boolean?, isLanding: Boolean = false): String = when {
        workFinished ?: (endReason == "task_done" || (endReason == null && isLanding)) -> "FINISHED"
        endReason == null && lastTurnOutcome == "FAILED" -> "FAILED"
        else -> "ENDED"
    }

    fun afterRelease(o: JsonObject): String =
        afterRelease(endReason(o), lastTurnOutcome(o), workFinished(o), (o["sessionKind"] as? JsonPrimitive)?.contentOrNull == "LANDING")

    /** The session's work finished. */
    fun finished(o: JsonObject): Boolean = afterRelease(o) == "FINISHED"

    /** Released after a failed turn with nobody having asked for the end: what "Failed" means (design §12). */
    fun failed(o: JsonObject): Boolean = released(o) == true && afterRelease(o) == "FAILED"

    /** Not released, yet being ended after an interrupted turn: "Interrupted" until the release lands. */
    /** Released by a move to another workspace (`endReason` moved): the server let it go so its runner could commit what it left,
     * which the person who moved it is not told. Drawn as a held idle session — no Ended mark, its idle word and glyph, no resume
     * line — and still resumed by the next message (board docs/mocks/session-move-released; web `sessionReleasedByMove`). */
    fun releasedByMove(released: Boolean?, endReason: String?): Boolean = released == true && endReason == MOVED
    fun releasedByMove(o: JsonObject): Boolean = releasedByMove(released(o), endReason(o))
    const val MOVED = "moved"

    fun endingAfterInterrupt(released: Boolean?, endReason: String?, lastTurnOutcome: String?): Boolean =
        released == false && endReason != null && lastTurnOutcome == "INTERRUPTED"
}
