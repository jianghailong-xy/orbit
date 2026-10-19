package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*

/** Only the protocol's explicit projections produce cards. Agent prose cannot grant an action. */
fun transcriptCards(event: RunEvent): List<InteractionCard> = buildList {
    val payload = event.fields
    fun addProjection(field: String, title: String, family: CardFamily, required: List<String>) {
        val source = payload.obj(field) ?: return
        if (required.any { source.text(it).isNullOrBlank() }) return
        add(InteractionCard("record:${event.seq}:$field", family, title, source, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
    }
    if (event.type == "user") {
        watchWake(payload.text("text").orEmpty())?.let { wake ->
            val title = when (wake.text("state")) { "MATCHED" -> "Watch triggered"; "EXPIRED" -> "Watch expired"; "REVOKED" -> "Watch stopped: access lost"; else -> "Watch stopped: every target is gone" }
            add(InteractionCard("record:${event.seq}:watch", CardFamily.BACKGROUND, title, wake, "", objectId = wake.text("watchId")!!, binding = "", status = "Recorded"))
        }
        backgroundWake(payload.text("controlPlaneNote").orEmpty())?.let { wake ->
            add(InteractionCard("record:${event.seq}:wake", CardFamily.BACKGROUND, "Background update", wake, "", objectId = "${event.seq}", binding = "", status = "Recorded"))
        }
        addProjection("confirmationReviewRequest", "Review requested", CardFamily.REVIEW, listOf("requestId", "taskId", "title", "runSessionId", "dueAt"))
        addProjection("confirmationReturn", "Sent back by the reviewer", CardFamily.REVIEW, listOf("requestId", "reason"))
        addProjection("taskStart", "Task started", CardFamily.SESSION_REQUEST, listOf("taskId", "title"))
        addProjection("projectStarted", "Project started", CardFamily.SESSION_REQUEST, listOf("projectId", "projectTitle", "by"))
        addProjection("openItemDelivery", "Project item delivered", CardFamily.SESSION_REQUEST, listOf("itemId", "kind", "title"))
        // The owner's answer handed to the coordinator: one line that opens to the words the agent read (`OwnerAnswerLine`).
        payload.obj("ownerAnswer")?.takeIf(OwnerAnswerLine::isCard)?.let { answer ->
            add(InteractionCard("record:${event.seq}:ownerAnswer", CardFamily.SESSION_REQUEST, CoordinatorQueue.sent, answer, "",
                objectId = "${event.seq}", binding = "", status = "Recorded"))
        }
        addProjection("sessionMessage", "Message from another session", CardFamily.SESSION_REQUEST, listOf("fromSessionId"))
        payload.objects("sessionReplies").forEach { row ->
            if (row.text("requestId").isNullOrBlank() || row.text("fromSessionId").isNullOrBlank() ||
                row.text("outcome") !in setOf("REPLIED", "NO_REPLY", "RECIPIENT_ENDED", "EXPIRED", "UNDELIVERED")) return@forEach
            add(InteractionCard("record:${event.seq}:reply:${row.text("requestId")}", CardFamily.SESSION_REQUEST,
                "Session reply · ${row.text("outcome")}", row, "", objectId = row.text("requestId")!!, binding = "", status = "Recorded"))
        }
    }
    if (event.type == "background_task") add(InteractionCard("record:${event.seq}:background", CardFamily.BACKGROUND,
        "Background work", payload, "", objectId = payload.text("taskId") ?: "${event.seq}", binding = "", status = payload.text("status")))
}
