package io.orbitd.android.core.cards

/** Context for an ordinary composer draft. This never builds or sends a decision request. */
object CardDiscussion {
    fun context(card: InteractionCard): String? = when (card.family) {
        CardFamily.ACCEPTANCE, CardFamily.START -> {
            val digest = if (card.family == CardFamily.START) card.source.obj("startRequest")?.text("criteriaDigest")
                else card.source.obj("currentVersion")?.text("digest")
            val criteria = card.context.objects("acceptanceCriteriaItems").sortedBy { it.number("ordinal") ?: 0 }
            if (digest.isNullOrBlank() || criteria.isEmpty()) null else buildString {
                append("About the acceptance criteria of “${card.context.text("title").orEmpty()}” (project ${card.projectId}, seal $digest):\n\n")
                append(criteria.mapIndexed { index, item -> "${index + 1}. ${item.text("text").orEmpty()}" }.joinToString("\n"))
                append("\n\n")
            }
        }
        CardFamily.EXCEPTION -> if (card.source.text("assignee") != "OWNER") null else buildString {
            append("About the ${if (card.source.text("kind") == "FUSE_PAUSED") "pause" else "exception"} in project ${card.projectId}:\n\n")
            append(card.source.text("title").orEmpty())
            card.source.text("detailLine")?.takeIf { it.isNotBlank() }?.let { append("\n$it") }
            append("\n\n(open item ${card.objectId}, waiting since ${card.source.text("waitingSince")})\n\n")
        }
        else -> null
    }
}
