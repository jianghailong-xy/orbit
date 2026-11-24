package io.orbitd.android.core.cards

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The PROJECT_REOPEN owner request on Android (docs/project-reopen-request-design.md §6): an agent asking the owner to reopen a settled
 * project. The words of its card and the rules over its payload, with no view in them. iOS `ProjectReopenRequest.swift` (OrbitKit); web card.
 */
object ProjectReopenCopy {
    fun title(projectTitle: String) = "↺ Reopen project “$projectTitle”?"
    const val whyLabel = "Why"
    const val plannedWorkLabel = "Planned work"
    fun agentSays(why: String) = "The agent says: $why"
    const val reopen = "Reopen"
    const val chat = "💬 Chat about this"
    const val declinePlaceholder = "What should the agent know? It reads this."
    const val decline = "Decline"
    const val keep = "Keep it"
    const val projectPageRow = "An agent asked to reopen this project"
    const val declined = "Declined"

    /** "↺ Reopen project …?" once, whether or not the server's title already carries the mark. */
    fun heading(title: String) = if (title.startsWith("↺")) title else "↺ $title"

    /** "DONE since Nov 18" / "Cancelled since Nov 18". */
    fun settledLine(status: String?, settledAt: String?, zone: ZoneId = ZoneId.systemDefault()): String {
        val word = if (status == "CANCELLED") "Cancelled" else "DONE"
        val at = OwnerRequests.parse(settledAt) ?: return word
        return "$word since ${monthDay(at, zone)}"
    }

    /** "Asked by <session>" outside that session; null when no title is known. */
    fun askedBy(title: String?): String? = title?.takeIf { it.isNotEmpty() }?.let { "Asked by $it" }

    /** "Also asked by A, B" for the askers after the first; null for a lone asker. */
    fun alsoAskedBy(titles: List<String>): String? = titles.takeIf { it.isNotEmpty() }?.let { "Also asked by ${it.joinToString(", ")}" }

    /** The collapsed line once answered: "Reopened · Nov 23 14:02" or "Declined: <reason>". */
    fun outcomeLine(request: OwnerRequest, zone: ZoneId = ZoneId.systemDefault()): String {
        val note = request.resolutionNote?.trim().orEmpty()
        return when (request.state) {
            "DECLINED" -> if (note.isEmpty()) declined else "Declined: “$note”"
            "DONE" -> OwnerRequests.parse(request.resolvedAt)?.let { "Reopened · ${monthDay(it, zone)} ${clock(it, zone)}" } ?: "Reopened"
            "EXPIRED" -> "Expired before anyone answered"
            "WITHDRAWN" -> if (note.isEmpty()) "Withdrawn" else "Withdrawn: “$note”"
            else -> ""
        }
    }

    private fun monthDay(at: Instant, zone: ZoneId) = DateTimeFormatter.ofPattern("MMM d", Locale.US).withZone(zone).format(at)
    private fun clock(at: Instant, zone: ZoneId) = DateTimeFormatter.ofPattern("HH:mm", Locale.US).withZone(zone).format(at)
}

/** What a PROJECT_REOPEN request's payload holds: `{projectId, statusAtAsk, settledAt, plannedWork, askers}`. */
data class ProjectReopenFacts(val projectId: String, val statusAtAsk: String?, val settledAt: String?, val plannedWork: String,
    val askers: List<Asker>) {
    data class Asker(val sessionId: String, val title: String?)

    /** The titles of the askers after the one whose card this is. */
    fun otherAskerTitles(besides: String): List<String> =
        askers.filter { it.sessionId != besides }.mapNotNull { it.title }.filter { it.isNotEmpty() }

    companion object {
        private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

        /** Null for a request that is not a PROJECT_REOPEN or whose payload names no project. */
        fun of(request: OwnerRequest): ProjectReopenFacts? {
            if (request.kind != OwnerRequests.PROJECT_REOPEN) return null
            val payload = request.payload as? JsonObject
            val projectId = payload?.str("projectId") ?: request.projectId ?: return null
            val askers = (payload?.get("askers") as? JsonArray).orEmpty().mapNotNull { row ->
                val obj = row as? JsonObject ?: return@mapNotNull null
                obj.str("sessionId")?.let { Asker(it, obj.str("title")) }
            }
            return ProjectReopenFacts(projectId, payload?.str("statusAtAsk"), payload?.str("settledAt"), payload?.str("plannedWork").orEmpty(), askers)
        }

        /** The pending PROJECT_REOPEN requests of one project, newest first: what its page draws as its row. */
        fun pending(requests: List<OwnerRequest>, projectId: String): List<OwnerRequest> {
            val key = OwnerRequests.key(projectId)
            return requests.filter { it.kind == OwnerRequests.PROJECT_REOPEN && it.pending && of(it)?.let { f -> OwnerRequests.key(f.projectId) == key } == true }
                .sortedByDescending { OwnerRequests.parse(it.createdAt) ?: Instant.MIN }
        }
    }
}
