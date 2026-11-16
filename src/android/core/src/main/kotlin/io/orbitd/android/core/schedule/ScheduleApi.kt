package io.orbitd.android.core.schedule

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The scheduled tasks' REST doors (apiserver schedules controllers; OrbitKit APIClient's schedule calls). A refusal is
 * the transport's [ApiError] (a server without schedules answers the list 404: `status == 404`); an answer this build
 * cannot read is a [ProtocolException]. The one refusal read as an answer is a card's 409 SCHEDULE_REQUEST_STALE:
 * [ScheduleDecisionOutcome.Stale], shown and never retried.
 */
class ScheduleApi(private val api: OrbitApi, private val handle: SessionHandle) {
    /** The account's schedules, each with its last run, and the runs of the page's window (W2) when the server sends
     * them. [state] is a comma list (`ACTIVE,PAUSED,HELD`). */
    suspend fun list(state: String? = null, workspaceId: String? = null): ScheduleListResponse =
        read(get(listOf("schedules"), listOfNotNull(state?.let { "state" to it }, workspaceId?.let { "workspaceId" to it })),
            ScheduleListResponse::parse)

    /** The inspector: the schedule, its last runs, findings, this month's use, history and pending cards. */
    suspend fun detail(id: String): ScheduleDetailResponse = read(get(listOf("schedules", id)), ScheduleDetailResponse::parse)

    suspend fun runs(id: String, limit: Int = 20): List<ScheduleRunView> =
        read(get(listOf("schedules", id, "runs"), listOf("limit" to limit.toString()))) { e ->
            (e as? JsonObject)?.scheduleList("runs", ScheduleRunView::parse)
        }

    suspend fun pause(id: String) { send(listOf("schedules", id, "pause"), HttpMethod.POST) }
    suspend fun resume(id: String) { send(listOf("schedules", id, "resume"), HttpMethod.POST) }
    /** Run now: one run outside the rule, counted against the week like any other. */
    suspend fun runNow(id: String) { send(listOf("schedules", id, "run"), HttpMethod.POST) }
    /** Undo one revision: the change line's and the history's Undo. */
    suspend fun undo(id: String, revision: Int) {
        send(listOf("schedules", id, "undo"), HttpMethod.POST, buildJsonObject { put("revision", revision) })
    }
    suspend fun delete(id: String) { send(listOf("schedules", id), HttpMethod.DELETE) }
    suspend fun stopRun(runId: String) { send(listOf("schedule-runs", runId, "stop"), HttpMethod.POST) }

    /** The cards waiting on the owner (`state=PENDING`), across conversations. */
    suspend fun requests(state: String = "PENDING"): List<ScheduleCard> =
        read(get(listOf("schedule-requests"), listOf("state" to state))) { e -> (e as? JsonObject)?.scheduleList("requests", ScheduleCard::parse) }

    suspend fun request(id: String): ScheduleCard = read(get(listOf("schedule-requests", id)), ScheduleCard::parse)

    /** Allow a card. A create card that names no zone sends [timezone] (the device's IANA zone). */
    suspend fun allow(id: String, timezone: String?): ScheduleDecisionOutcome =
        decide(id, "allow", buildJsonObject { timezone?.let { put("timezone", it) } })

    suspend fun decline(id: String): ScheduleDecisionOutcome = decide(id, "decline", buildJsonObject { })

    /** The draft panel's cards: the account's PENDING create cards. */
    suspend fun drafts(): List<ScheduleCard> =
        read(get(listOf("schedules", "drafts"))) { e -> (e as? JsonObject)?.scheduleList("drafts", ScheduleCard::parse) }

    /** The quick-add line: opens an ordinary session in [workspaceId] with the sentence; its agent drafts the card. The
     * session's id. */
    suspend fun createDraft(workspaceId: String, text: String): String =
        read(send(listOf("schedules", "drafts"), HttpMethod.POST, buildJsonObject { put("workspaceId", workspaceId); put("text", text) })) { e ->
            (e as? JsonObject)?.scheduleText("sessionId")
        }

    /** The cards a conversation asked and the changes it made, drawn in it. */
    suspend fun sessionCards(sessionId: String): SessionScheduleCardsResponse =
        read(get(listOf("sessions", sessionId, "schedule-cards")), SessionScheduleCardsResponse::parse)

    private suspend fun decide(id: String, door: String, body: JsonObject): ScheduleDecisionOutcome = try {
        val answer = send(listOf("schedule-requests", id, door), HttpMethod.POST, body)
        ScheduleDecisionOutcome.Decided(ScheduleCard.parse((parse(answer) as? JsonObject)?.get("card")))
    } catch (error: ApiError) {
        if (error.status == 409 && error.code == STALE) ScheduleDecisionOutcome.Stale(error.messages.firstOrNull() ?: "") else throw error
    }

    private suspend fun get(path: List<String>, query: List<Pair<String, String>> = emptyList()): ApiResponse =
        api.request(handle, ApiRequest(path, query = query)).requireSuccess()

    /** A press: pause, resume, run, stop and delete send no body, as OrbitKit's `postEmpty` and `delete` do. */
    private suspend fun send(path: List<String>, method: HttpMethod, body: JsonObject? = null): ApiResponse =
        api.request(handle, ApiRequest(path, method, body = body?.toString()?.encodeToByteArray())).requireSuccess()

    private fun parse(response: ApiResponse): JsonElement? =
        runCatching { Wire.json.parseToJsonElement(response.body.decodeToString()) }.getOrNull()

    private fun <T> read(response: ApiResponse, decode: (JsonElement?) -> T?): T = decode(parse(response)) ?: throw ProtocolException()

    companion object {
        const val STALE = "SCHEDULE_REQUEST_STALE"
        const val UNREACHABLE = "Couldn't reach Orbit. Try again."
        const val WITHDRAWN = "This card was withdrawn."

        /** What a refused press says: the server's own message, else that Orbit could not be reached. */
        fun refusal(error: Throwable): String = (error as? ApiError)?.messages?.firstOrNull()?.takeIf { it.isNotBlank() } ?: UNREACHABLE
    }
}
