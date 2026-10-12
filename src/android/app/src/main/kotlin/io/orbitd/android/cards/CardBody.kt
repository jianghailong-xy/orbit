package io.orbitd.android.cards

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import io.orbitd.android.reader.EngineErrors
import io.orbitd.android.text.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId

@Composable
internal fun CardBody(card: InteractionCard, open: (String) -> Unit, owner: OwnerForm? = null, reopen: (() -> Unit)? = null) {
    val row = card.source
    // The owner-confirmation card draws its question, its receipt and a reviewer's return itself (A08-1).
    if (card.family == CardFamily.OWNER_CONFIRMATION && card.context.text("ownerCard") != null) { OwnerCardBody(card, open, owner, reopen); return }
    if (card.key.startsWith("receipt:")) {
        CardFields(row, listOf("title", "decision", "decidedAt", "decidedByType", "note", "report", "review", "answers", "reason", "problems", "resultingSeal"), open)
        return
    }
    when (card.family) {
        CardFamily.TOOL, CardFamily.PROVIDER -> {
            val input = row.obj("input") ?: JsonObject(emptyMap())
            input.text("command")?.let { CodeText(it, "sh") }
            if (input.text("command") == null) listOf("file_path", "notebook_path", "url", "pattern", "path").firstNotNullOfOrNull { input.text(it) }?.let { Text(it) }
            DetailFold("Tool parameters") { CodeText(redactProvider(input, card.family == CardFamily.PROVIDER).toString(), "json") }
        }
        CardFamily.QUESTION -> Unit // The exact questions and options are drawn by the form.
        CardFamily.PLAN -> MarkdownText(row.obj("input")?.text("plan") ?: "Plan ready for review.", open = open)
        CardFamily.CREATE -> {
            val input = row.obj("input") ?: JsonObject(emptyMap())
            Text(input.text("title") ?: "", style = MaterialTheme.typography.titleSmall)
            input.obj("preview")?.let { ImpactRows(it) }
            val isTask = row.text("toolName") == "orbit_task_create"
            if (isTask) {
                val list = input.obj("preview")?.objects("lists")?.firstOrNull()?.text("title")?.takeIf { it.isNotBlank() }
                    ?: input.text("listTitle")?.takeIf { it.isNotBlank() }
                list?.let { Text("Into $it") }
            }
            CardFields(input, if (isTask) listOf("projectTitle", "completionCriterion") else listOf("projectTitle", "listTitle", "completionCriterion"), open)
            input.text("description")?.let { DetailFold("Description") { MarkdownText(it, open = open) } }
            input.text("goal")?.let { DetailFold("Goal") { MarkdownText(it, open = open) } }
            Field("Done when", input["acceptanceCriteria"], open)
            Field("Done when", input["acceptanceCriteriaItems"], open)
            if (row.text("toolName") == "orbit_project_create") Text("The criteria are confirmed when you start the project.", style = MaterialTheme.typography.bodySmall)
        }
        // A batch the server previewed is drawn by its review (`BatchReviewBody`); this is the one it did not.
        CardFamily.BATCH -> Text("The task preview could not be read.")
        CardFamily.DAG -> row.obj("input")?.obj("preview")?.let { preview ->
            Text(preview.text("listTitle") ?: "Dependencies", style = MaterialTheme.typography.titleSmall)
            Text("${preview.number("edgesBefore") ?: "?"} → ${preview.number("edgesAfter") ?: "?"} edges")
            preview.objects("ops").forEach { Text("${it.text("taskTitle")} ${if (it.text("op") == "add") "waits on" else "no longer waits on"} ${it.text("dependsOnTitle")}" + if (it.flag("noop")) " (already so)" else "") }
            CardFields(preview, listOf("becomingRunnable", "becomingManual", "becomingBlocked", "cycle"), open)
            Field("Note", row.obj("input")?.get("note"), open)
        }
        CardFamily.BLOCKER -> row.obj("input")?.let { input ->
            Field("Project", input["projectTitle"], open)
            input.obj("blocker")?.let { CardFields(it, listOf("kind", "subjectTitle", "requiredAction"), open) }
            Field("The agent says it no longer blocks", input["reason"], open)
        }
        CardFamily.EVIDENCE -> {
            Text(row.text("title") ?: "", style = MaterialTheme.typography.titleSmall)
            // Opened by Decide it myself: still saying what it waits for, and that deciding here is the owner's choice.
            if (CoordinatorQueue.isDecidingMyself(card)) { CoordinatorPausedLine(card); CoordinatorNote(card, CoordinatorQueue.decideHere) }
            Text("Evidence revision ${row.text("evidenceRevision") ?: ""}", style = MaterialTheme.typography.labelMedium)
            Field("Criterion", row.obj("criterion")?.get("text"), open)
            Field("What the submitter says was established", row["claim"], open)
            Field("Not established", row["gaps"], open)
            Text("Cited checks", style = MaterialTheme.typography.titleSmall)
            row.objects("citations").forEach { citation ->
                Text("${citation.text("kind")}: ${citation.text("label") ?: citation.text("ref")}")
                Text(if (citation.flag("resolved")) "Reference found" else "Reference not found: ${citation.text("reason") ?: "unresolved"}", style = MaterialTheme.typography.bodySmall)
            }
            row.obj("decidability")?.takeIf { !it.flag("decidable") }?.let { CardFields(it, listOf("refusal", "requiredAction"), open) }
            row.obj("independence")?.takeIf { !it.flag("independent") }?.let { CardFields(it, listOf("disqualification", "requiredAction"), open) }
        }
        CardFamily.OWNER_CONFIRMATION -> OwnerCardBody(card, open, owner, reopen)
        CardFamily.CRITERIA_CHANGE -> {
            CardFields(row, listOf("filedAt", "baselineSeal", "currentSeal"), open)
            row.obj("diff")?.objects("entries")?.forEach { entry ->
                Text("${entry.number("ordinal") ?: ""} · ${entry.text("change") ?: ""}", style = MaterialTheme.typography.titleSmall)
                val rewrites = entry.objects("rewrites")
                if (rewrites.isEmpty()) {
                    Field("On record", entry["onRecord"], open)
                    Field("Proposed", entry["proposed"], open)
                } else rewrites.forEach { rewrite ->
                    Text(fieldLabel(rewrite.text("field") ?: ""), style = MaterialTheme.typography.labelMedium)
                    Text(buildAnnotatedString {
                        rewrite.objects("segments").forEach { segment ->
                            val style = when (segment.text("side")) {
                                "REMOVED", "removed" -> SpanStyle(textDecoration = TextDecoration.LineThrough)
                                "ADDED", "added" -> SpanStyle(textDecoration = TextDecoration.Underline)
                                else -> SpanStyle()
                            }
                            withStyle(style) { append(segment.text("text") ?: "") }
                        }
                    })
                }
            }
            row.obj("decidability")?.takeIf { !it.flag("decidable") }?.let { CardFields(it, listOf("refusal", "requiredAction"), open) }
        }
        CardFamily.ACCEPTANCE -> {
            Text(card.context.text("title") ?: "", style = MaterialTheme.typography.titleSmall)
            card.context.objects("acceptanceCriteriaItems").forEach { criterion ->
                Text("${criterion.number("ordinal") ?: ""}. ${criterion.text("text") ?: ""}")
                Field("Verification", criterion["verificationMethod"], open)
            }
            row.obj("currentVersion")?.text("digest")?.let { Text("Seal ${it.take(8)}", style = MaterialTheme.typography.labelMedium) }
            CardFields(row, listOf("changesSinceConfirmed"), open)
            row.obj("confirmation")?.let { recorded ->
                Field("Confirmed at", recorded["confirmedAt"], open)
                DetailFold("confirmed criteria") { CardFields(recorded, listOf("criteriaMaterial", "startedWith"), open) }
            }
        }
        CardFamily.START -> Unit // Drawn whole by the start card (projects/StartProjectCard.kt `CoordinatorStartCard`).
        CardFamily.OWNER_QUESTION -> {
            Field("Question", row.obj("question")?.get("question"), open)
            CardFields(row, listOf("detailLine", "waitingSince"), open)
            row.obj("question")?.let { CardFields(it, listOf("blocksTaskIds", "ifUnanswered"), open) }
        }
        CardFamily.EXCEPTION -> {
            CardFields(row, listOf("detailLine", "assigneeReason", "waitingSince", "escalatedAt", "facts"), open)
            val offered = row.strings("actions")
            if ("OPEN_TASK_SESSION" in offered) row.text("sessionId")?.let { LinkButton("Open task session", "orbit-session:$it", open) }
            if ("OPEN_COORDINATOR" in offered) row.obj("delivery")?.text("sessionId")?.let { LinkButton("Open coordinator", "orbit-session:$it", open) }
            if (row.text("sessionId") == null && "OPEN_TASK_SESSION" in offered) Text("Task details are not connected yet.", style = MaterialTheme.typography.bodySmall)
        }
        CardFamily.PROMOTION -> CardFields(row, listOf("state", "sourceRef", "sourceSha", "upstreamRef", "commitsAhead", "filesChanged", "tasks", "checks", "conflicts", "recheck", "execution", "merged"), open)
        CardFamily.WIKI -> CardFields(row, listOf("op", "entryId", "baseRevision", "payload", "similar", "tainted", "decision", "reason", "change", "facts", "version", "categories", "docs", "gate", "sources", "summary", "fields", "trust", "revert"), open)
        CardFamily.BACKGROUND -> CardFields(row, listOf("state", "predicate", "targets", "matches", "expiryDeliveries", "expiresAt"), open)
        CardFamily.REVIEW, CardFamily.SESSION_REQUEST -> CardFields(row, row.keys.filterNot { it.endsWith("Token") }, open)
        // A revision waiting for its paused coordinator (`CoordinatorQueue`); one sent to it is a line of the rail (`SessionCards`).
        CardFamily.COORDINATOR_QUEUE -> if (!CoordinatorQueue.isSent(card)) {
            Text(row.text("title") ?: "", style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
            CoordinatorPausedLine(card)
            CoordinatorNote(card, CoordinatorQueue.explanation)
        }
    }
}

/**
 * Why a revision waits for its coordinator (project 34cygPTQe5LPUT7tdUAzG), read off the coordinator's own session: the quota
 * window it ran out of — judged as the conversation's own quota row judges it (`EngineErrors`), from what its failed run said, else
 * from its last reply, since a usage limit can park a retry without failing the run — and when that resets (its `retryAt`); for any
 * other failure, when it retries. A coordinator no longer paused gets the revision when its current turn ends.
 */
internal fun coordinatorPauseLine(coordinator: JsonObject, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    if (!CoordinatorQueue.isPaused(coordinator)) return CoordinatorQueue.back
    val failed = (coordinator.text("runState") ?: coordinator.text("status")) == "FAILED"
    val said = coordinator.text("error")?.takeIf { failed && it.isNotBlank() } ?: coordinator.text("lastAssistantText")
    val window = said?.takeIf(EngineErrors::isUsageLimitErrorText)?.let(EngineErrors::quotaWindow)
    return CoordinatorQueue.pausedLine(window, coordinator.text("retryAt")?.let { OwnerReview.receiptTime(it, now, zone) })
}

@Composable
private fun CoordinatorPausedLine(card: InteractionCard) = Text(coordinatorPauseLine(card.context.obj("coordinator") ?: JsonObject(emptyMap())),
    Modifier.testTag("${card.key}:paused"), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.needsYou)

/** The line under the paused one: that the owner may still decide, or — once they chose to — that it is theirs to choose. */
@Composable
private fun CoordinatorNote(card: InteractionCard, text: String) = Text(text, Modifier.testTag("${card.key}:note"),
    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
internal fun CardFields(source: JsonObject, fields: List<String>, open: (String) -> Unit) {
    fields.forEach { key -> Field(fieldLabel(key), source[key], open) }
}

@Composable
internal fun Field(label: String, value: JsonElement?, open: (String) -> Unit) {
    if (value == null || value == JsonNull || value is JsonArray && value.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium)
        when (value) {
            is JsonPrimitive -> if (value.isString) MarkdownText(value.content, open = open) else Text(value.content)
            is JsonArray -> value.forEachIndexed { index, child ->
                when (child) {
                    is JsonObject -> { if (value.size > 1) Text("${index + 1}."); CardFields(child, child.keys.toList(), open) }
                    else -> Text((child as? JsonPrimitive)?.content ?: child.toString())
                }
            }
            is JsonObject -> CardFields(value, value.keys.filterNot { it in setOf("commitToken", "ctaToken") }, open)
        }
    }
}

internal fun fieldLabel(key: String) = key.replace(Regex("([a-z])([A-Z])"), "$1 $2").replace('_', ' ').replaceFirstChar { it.uppercase() }

@Composable
internal fun DetailFold(label: String, body: @Composable () -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide $label" else "Show $label") }
    if (expanded) body()
}

@Composable
internal fun LinkButton(label: String, destination: String, open: (String) -> Unit) {
    TextButton(onClick = { open(destination) }) { Text(label) }
}

internal fun redactProvider(value: JsonElement, provider: Boolean): JsonElement = if (!provider) value else when (value) {
    is JsonObject -> JsonObject(value.mapValues { (key, child) ->
        if (key.lowercase() in setOf("apikey", "api_key", "token", "secret", "password")) JsonPrimitive("Set") else redactProvider(child, true)
    })
    is JsonArray -> JsonArray(value.map { redactProvider(it, true) })
    else -> value
}
