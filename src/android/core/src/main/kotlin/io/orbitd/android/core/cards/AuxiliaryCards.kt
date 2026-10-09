package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import java.time.Instant

/** Reusable by Wiki/Watch and notification destinations; nothing here claims a route is installed. */
object AuxiliaryCards {
    private fun context(resource: String) = buildJsonObject { put("resource", resource) }
    fun wikiChangeset(session: String, changeset: JsonObject, now: Instant = Instant.now()): List<InteractionCard> = buildList {
        val id = changeset.text("id") ?: return@buildList
        val unexpired = changeset.text("expiresAt")?.let { runCatching { Instant.parse(it) > now }.getOrDefault(false) } ?: true
        changeset.objects("ops").forEach { op ->
            val opId = op.text("id") ?: return@forEach
            val entry = changeset.objects("entries").firstOrNull { it.text("id") == op.text("entryId") }
            val source = JsonObject(op + ("changesetId" to JsonPrimitive(id)) + ("entry" to (entry ?: JsonNull)))
            val actions = if (unexpired && op.text("decision") == "pending") {
                when (op.text("op")) {
                    "challenge" -> if (entry != null) listOf(CardVerb.WIKI_RECONFIRM, CardVerb.WIKI_AMEND, CardVerb.WIKI_RETIRE) else emptyList()
                    "add", "amend", "supersede" -> listOf(CardVerb.WIKI_ACCEPT, CardVerb.WIKI_EDIT, CardVerb.WIKI_REJECT)
                    "reinforce", "retire" -> listOf(CardVerb.WIKI_ACCEPT, CardVerb.WIKI_REJECT)
                    else -> emptyList()
                }
            } else emptyList()
            add(InteractionCard("wiki-op:$opId", CardFamily.WIKI, "Review Wiki change", source, session, objectId = opId,
                binding = "${op.text("baseRevision")}:${op["payload"]}:${entry?.text("revision")}", actions = actions,
                status = if (unexpired) op.text("decision") else "Expired", context = context("wikiChangeset")))
        }
        if (changeset.flag("revertible")) add(InteractionCard("wiki-revert:$id", CardFamily.WIKI, "Revert this run?",
            JsonObject(changeset + ("changesetId" to JsonPrimitive(id))), session, objectId = id, binding = changeset["revert"].toString(),
            actions = listOf(CardVerb.WIKI_REVERT), context = context("wikiChangeset")))
    }
    fun wikiEntry(session: String, entry: JsonObject): InteractionCard? {
        val id = entry.text("id") ?: return null
        val actions = if (entry.text("status") == "active") when (entry.text("trust")) {
            "unreviewed" -> listOf(CardVerb.WIKI_CONFIRM, CardVerb.WIKI_REJECT_ENTRY)
            "auto" -> listOf(CardVerb.WIKI_REJECT_ENTRY)
            else -> emptyList()
        } else emptyList()
        return InteractionCard("wiki-entry:$id", CardFamily.WIKI, entry.text("title") ?: "Wiki entry", entry, session,
            objectId = id, binding = entry.text("revision") ?: "", actions = actions, status = entry.text("trust"), context = context("wikiEntry"))
    }
    fun wikiPlan(session: String, state: JsonObject): List<InteractionCard> = buildList {
        val space = state.text("spaceId") ?: return@buildList
        state.obj("draft")?.let { draft ->
            val version = draft.text("version") ?: return@let
            add(InteractionCard("wiki-plan:$space:$version", CardFamily.WIKI, "Confirm Wiki plan", draft, session,
                objectId = draft.text("id") ?: version, binding = version,
                actions = if (draft.text("status") == "draft") listOf(CardVerb.PLAN_CONFIRM) else emptyList(),
                status = draft.text("status"), context = context("wikiPlan")))
        }
        state.objects("proposals").forEach { proposal ->
            val id = proposal.text("id") ?: return@forEach
            add(InteractionCard("wiki-proposal:$id", CardFamily.WIKI, "Wiki plan proposal", proposal, session, objectId = id,
                binding = "${proposal.text("baseVersion")}:${proposal["change"]}",
                actions = if (proposal.text("status") == "pending") listOf(CardVerb.PLAN_ACCEPT, CardVerb.PLAN_REJECT) else emptyList(),
                status = proposal.text("status"), context = context("wikiPlan")))
        }
    }
    fun watch(session: String, watch: JsonObject): InteractionCard? {
        val id = watch.text("id") ?: return null
        val actions = when (watch.text("state")) {
            "ACTIVE" -> listOf(CardVerb.WATCH_PAUSE, CardVerb.WATCH_CANCEL)
            "PAUSED" -> listOf(CardVerb.WATCH_RESUME, CardVerb.WATCH_CANCEL)
            else -> emptyList()
        }
        return InteractionCard("watch:$id", CardFamily.BACKGROUND, "Watch", watch, session, objectId = id,
            binding = "${watch.text("generation")}:${watch.text("state")}:${watch.text("updatedAt")}", actions = actions, status = watch.text("state"), context = context("watch"))
    }
}
