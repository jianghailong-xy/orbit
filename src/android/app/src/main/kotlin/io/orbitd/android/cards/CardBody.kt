package io.orbitd.android.cards

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.management.RunnerCopy
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.text.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.*

/** [recorded]: drawn in a review as the record this window's press made of it — what the press made past is left out. */
@Composable
internal fun CardBody(card: InteractionCard, open: (String) -> Unit, owner: OwnerForm? = null, reopen: (() -> Unit)? = null,
    recorded: Boolean = false) {
    val row = card.source
    // The owner-confirmation card draws its question, its receipt and a reviewer's return itself (A08-1).
    if (card.family == CardFamily.OWNER_CONFIRMATION && card.context.text("ownerCard") != null) { OwnerCardBody(card, open, owner, reopen, recorded); return }
    if (card.key.startsWith("receipt:")) {
        CardFields(row, listOf("title", "decision", "decidedAt", "decidedByType", "note", "report", "review", "answers", "reason", "problems", "resultingSeal"), open)
        // The one way to an older version's files, and so to where they are seen to expire: the latest version's do not (§2.8), and only
        // the latest is ever a card. Read when it is pressed: a receipt rides every read of the conversation, and reads nothing itself.
        if (card.family == CardFamily.EVIDENCE && row.flag("citesFiles")) LocalEvidenceFiles.current?.let { files ->
            OutlinedButton(onClick = { files.open(card.key) }, Modifier.testTag("${card.key}:files")) {
                Text(EvidenceFiles.title)
                Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.padding(start = 4.dp).size(14.dp))
            }
        }
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
        CardFamily.DELETE -> DeleteCardBody(DeleteCards.read(row.text("toolName").orEmpty(), row.obj("input") ?: JsonObject(emptyMap())))
        CardFamily.WORKSPACE_WRITE -> {
            val input = row.obj("input") ?: JsonObject(emptyMap())
            // A server that predates this card files what the asker sent: all of it, or the card would ask for a yes with nothing on it.
            if (input.obj("changes") == null) CodeText(input.toString(), "json")
            else WorkspaceWriteCardBody(WorkspaceWriteCards.read(row.text("toolName").orEmpty(), input))
        }
        CardFamily.EVIDENCE -> {
            Text(row.text("title") ?: "", style = MaterialTheme.typography.titleSmall)
            Text("Evidence revision ${row.text("evidenceRevision") ?: ""}", style = MaterialTheme.typography.labelMedium)
            Field("Criterion", row.obj("criterion")?.get("text"), open)
            // What the evidence is, right under what it is measured against, and only when this version cites a file (§2.6).
            EvidenceFilesArea(card)
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
        CardFamily.OWNER_CONFIRMATION -> OwnerCardBody(card, open, owner, reopen, recorded)
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
            // The confirmation before this one is not what its record says.
            if (!recorded) row.obj("confirmation")?.let { recorded ->
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
        CardFamily.EXCEPTION -> Unit // Drawn whole by the exception card (`ExceptionCard`, A08-17).
        CardFamily.QUESTION_RECORD -> Unit // Drawn whole by the record card and its replay (`QuestionRecordCard`, A08-13).
        CardFamily.PROMOTION -> CardFields(row, listOf("state", "sourceRef", "sourceSha", "upstreamRef", "commitsAhead", "filesChanged", "tasks", "checks", "conflicts", "recheck", "execution", "merged"), open)
        CardFamily.WIKI -> CardFields(row, listOf("op", "entryId", "baseRevision", "payload", "similar", "tainted", "decision", "reason", "change", "facts", "version", "categories", "docs", "gate", "sources", "summary", "fields", "trust", "revert"), open)
        CardFamily.BACKGROUND -> CardFields(row, listOf("state", "predicate", "targets", "matches", "expiryDeliveries", "expiresAt"), open)
        CardFamily.REVIEW, CardFamily.SESSION_REQUEST -> CardFields(row, row.keys.filterNot { it.endsWith("Token") }, open)
        CardFamily.COORDINATOR_QUEUE -> Unit
    }
}

/** Where it stands: a runner in the runner list's own words, so it reads the same on its card as on its row; the runner a workspace is on. */
internal fun deleteStatus(delete: DeleteCard, nowMs: Long): String = when {
    !delete.isRunner -> DeleteCards.onRunner(delete.host)
    delete.online -> RunnerCopy.ONLINE
    delete.lastHeartbeatAt != null -> RunnerCopy.offlineLastSeen(RunnerPage.ago(delete.lastHeartbeatAt, nowMs))
    else -> RunnerCopy.OFFLINE
}

/**
 * What a delete takes away (iOS `ToolApprovalCard`'s delete branch, web `DeleteBody`): the name on its own row, where it stands, and
 * for a runner every workspace that goes with it, by name. With none the card says so: an empty place reads as a list that failed to load.
 */
@Composable
private fun DeleteCardBody(delete: DeleteCard) {
    val small = MaterialTheme.typography.bodySmall
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(delete.name, style = MaterialTheme.typography.titleSmall)
    Text(deleteStatus(delete, System.currentTimeMillis()), style = small, color = muted)
    delete.workDir?.let { Text(it, style = small, color = muted, fontFamily = FontFamily.Monospace) }
    if (delete.isRunner && delete.workspaces.isEmpty()) Text(DeleteCards.noWorkspaces, style = small, color = muted)
    if (delete.workspaces.isNotEmpty()) {
        Text(DeleteCards.goesWith, style = MaterialTheme.typography.labelMedium)
        delete.workspaces.forEach { workspace ->
            Text("− ${workspace.name}", style = MaterialTheme.typography.bodyMedium)
            workspace.workDir?.let { Text(it, style = small, color = muted, fontFamily = FontFamily.Monospace) }
        }
    }
    Text(if (delete.isRunner) DeleteCards.runnerNote else DeleteCards.workspaceNote, style = small, color = muted)
}

/**
 * What a workspace write does (iOS `ToolApprovalCard`'s write branch, web `WorkspaceWriteBody`): the name on its own row, where it
 * stands, each variable by name and value, what a write of the variables takes away, then the rest of what changes. A value is on its
 * own block in full, with no line limit: a value cut short would be a yes to something nobody read.
 */
@Composable
private fun WorkspaceWriteCardBody(write: WorkspaceWriteCard) {
    val small = MaterialTheme.typography.bodySmall
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val caption = MaterialTheme.typography.labelMedium
    @Composable fun Block(text: String) = Text(text, style = small, fontFamily = FontFamily.Monospace)
    Text(write.name, style = MaterialTheme.typography.titleSmall)
    Text(DeleteCards.onRunner(write.host), style = small, color = muted)
    write.workDir?.let { Block(it) }
    write.env?.let { env ->
        Text(WorkspaceWriteCards.variables, style = caption)
        if (env.isEmpty()) Text(WorkspaceWriteCards.noVariables, style = small, color = muted)
        env.forEach { Block(it.line) }
    }
    if (write.envRemoved.isNotEmpty()) {
        Text(WorkspaceWriteCards.removed, style = caption)
        write.envRemoved.forEach { Block(it) }
    }
    write.fields.forEach { field ->
        Text(field.caption, style = caption)
        Block(field.value)
    }
    Text(WorkspaceWriteCards.note, style = small, color = muted)
}

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
