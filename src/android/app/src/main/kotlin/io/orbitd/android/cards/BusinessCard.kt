package io.orbitd.android.cards

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.alpha
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.Saver
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.tasks.TaskReopen
import io.orbitd.android.tasks.TaskReopenCopy
import io.orbitd.android.text.*
import kotlinx.serialization.json.*
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.*
import java.util.UUID

/** The same component and commands can be embedded in Tasks/Projects and Wiki when routed there. [review] draws it as a review's
 * page (A08-2; iOS `ApprovalReviewLayout`'s review path): its words scroll, its buttons stay pinned under them, and its heading is
 * the review's own title rather than a line of the card. */
@Composable
fun BusinessCard(card: InteractionCard, fresh: Boolean, result: CardActionState = CardActionState(),
    open: (String) -> Unit, discuss: ((String) -> Unit)? = null, submit: (CardVerb, CardInput) -> Unit, review: Boolean = false) {
    var note by rememberSaveable(card.key, card.binding) { mutableStateOf("") }
    var noteAction by rememberSaveable(card.key, card.binding) { mutableStateOf<CardVerb?>(null) }
    var selections by rememberSaveable(card.key, card.binding, stateSaver = jsonSaver(MapSerializer(String.serializer(), ListSerializer(String.serializer())))) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var custom by rememberSaveable(card.key, card.binding, stateSaver = jsonSaver(MapSerializer(String.serializer(), String.serializer()))) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var ownerAnswers by rememberSaveable(card.key, card.binding, stateSaver = jsonSaver(ListSerializer(OwnerAnswer.serializer()))) { mutableStateOf<List<OwnerAnswer>>(emptyList()) }
    var option by rememberSaveable(card.key, card.binding) { mutableStateOf(card.source.obj("question")?.number("recommendedOption")) }
    var reason by rememberSaveable(card.key, card.binding) { mutableStateOf<String?>(null) }
    val proposal = card.source.obj("payload")?.let { it.obj("entry") ?: it.obj("changes") } ?: card.source.obj("entry")
    var editTitle by rememberSaveable(card.key, card.binding) { mutableStateOf(proposal?.text("title").orEmpty()) }
    var editSummary by rememberSaveable(card.key, card.binding) { mutableStateOf(proposal?.text("summary").orEmpty()) }
    var confirming by remember { mutableStateOf<CardVerb?>(null) }
    // A08-7: the batch review's open task page, by its place in the window; the batch's yes waits on the review it came from.
    var batchPage by rememberSaveable(card.key, card.binding) { mutableStateOf<Int?>(null) }
    val batchPreview = card.source.obj("input")?.obj("preview")?.takeIf { card.family == CardFamily.BATCH }
    val enabled = fresh && !result.busy && !result.uncertain && !result.settled
    val input = CardInput(note, selections, custom, ownerAnswers, option,
        edited = if (editTitle.isBlank()) null else buildJsonObject {
            // Amend replaces proposed changes, so preserve the fields this two-field form doesn't edit.
            if (card.source.text("op") == "amend") {
                proposal?.filterKeys { it in setOf("fields", "topics", "aliases") }?.forEach { (k, v) -> put(k, v) }
                proposal?.objects("anchors")?.takeIf { it.isNotEmpty() }?.let { anchors ->
                    put("anchors", JsonArray(anchors.map { anchor -> JsonObject(anchor.filterKeys { it in setOf(
                        "type", "path", "symbol", "regionSha256", "sha", "criterionId", "semanticHash", "contentHash", "command", "expectedExit", "ref") }) }))
                }
            }
            put("title", editTitle.trim()); put("summary", editSummary.trim())
        }, reason = reason)
    fun send(verb: CardVerb) { submit(verb, if (verb == CardVerb.RETRY_TASK) input.copy(triggerId = UUID.randomUUID().toString()) else input) }
    val body: @Composable ColumnScope.() -> Unit = {
        // A revision waiting for the coordinator says when it was submitted, beside its title (`CoordinatorQueue`).
        val submitted = card.source.text("submittedAt")?.takeIf { card.family == CardFamily.COORDINATOR_QUEUE || CoordinatorQueue.isDecidingMyself(card) }
            ?.let { OwnerReview.receiptTime(it) }
        if (!review && submitted != null) Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text(card.title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            Text(submitted, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else if (!review) Text(card.title, style = MaterialTheme.typography.titleMedium)
        Text("From Orbit", style = MaterialTheme.typography.labelSmall)
        card.status?.let { Text(it, style = MaterialTheme.typography.labelMedium) }
        if (batchPreview != null) BatchReviewBody(card, open, batchPage) { batchPage = it }
        else CardBody(card, open, owner = if (card.family == CardFamily.OWNER_CONFIRMATION && CardVerb.CONFIRM_OWNER in card.actions)
                OwnerForm(ownerAnswers, enabled) { answer -> ownerAnswers = ownerAnswers.filterNot { it.key == answer.key } + answer } else null,
            reopen = if (CardVerb.REOPEN_TASK in card.actions && enabled) ({ confirming = CardVerb.REOPEN_TASK }) else null)
        CardDiscussion.context(card)?.let { context ->
            if (discuss == null) Text("Conversation discussion is not connected yet.", style = MaterialTheme.typography.bodySmall)
            else TextButton(onClick = { discuss(context) }, enabled = fresh && !result.busy) { Text("Chat about this") }
        }
        if (card.family == CardFamily.QUESTION && card.actions.isNotEmpty()) {
            approvalQuestions(card.source.obj("input") ?: JsonObject(emptyMap())).forEach { q ->
                Text(q.header ?: q.question, style = MaterialTheme.typography.titleSmall)
                if (q.header != null) Text(q.question)
                q.options.forEach { choice ->
                    ChoiceRow(choice.label, choice.description, choice.label in selections[q.question].orEmpty(), enabled, q.multiSelect) {
                        val old = selections[q.question].orEmpty()
                        selections = selections + (q.question to if (q.multiSelect) {
                            if (choice.label in old) old - choice.label else old + choice.label
                        } else listOf(choice.label))
                        if (!q.multiSelect) custom = custom - q.question
                    }
                }
                OutlinedTextField(custom[q.question].orEmpty(), { value ->
                    custom = custom + (q.question to value)
                    if (!q.multiSelect) selections = selections - q.question
                }, Modifier.fillMaxWidth(), enabled = enabled, label = { Text("Or type your own answer…") })
            }
        }
        if (card.family == CardFamily.OWNER_QUESTION && CardVerb.OWNER_ANSWER in card.actions) {
            val q = card.source.obj("question")
            q?.objects("options")?.forEachIndexed { index, o ->
                ChoiceRow(o.text("label") ?: "", o.text("description"), option == index, enabled,
                    recommended = index == q.number("recommendedOption")) { option = index }
            }
            if (!q?.objects("options").isNullOrEmpty()) ChoiceRow("Other", null, option == null, enabled) { option = null }
            OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), enabled = enabled,
                label = { Text(if (option == null) "Your answer" else "Add a note (optional)") })
        }
        if (card.actions.any { it in setOf(CardVerb.WIKI_REJECT, CardVerb.WIKI_REJECT_ENTRY) }) {
            Text("If rejecting, choose a reason", style = MaterialTheme.typography.labelMedium)
            CardRequests.wikiRejectReasons.forEach { value -> ChoiceRow(value.replace('_', ' '), null, reason == value, enabled) { reason = value } }
        }
        if (card.actions.any { it in setOf(CardVerb.WIKI_EDIT, CardVerb.WIKI_AMEND) }) {
            OutlinedTextField(editTitle, { editTitle = it }, Modifier.fillMaxWidth(), enabled = enabled, label = { Text("Revised title") })
            OutlinedTextField(editSummary, { editSummary = it }, Modifier.fillMaxWidth(), enabled = enabled, label = { Text("Revised summary") })
        }
        if (noteAction != null) {
            Text(noteAction!!.label, style = MaterialTheme.typography.labelMedium)
            if (noteAction == CardVerb.MARK_HANDLED) Text("The task, its branch and history stay where they are. Your reason records why this item is no longer open.")
            OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), enabled = enabled,
                label = { Text(if (noteAction == CardVerb.MARK_HANDLED) "Why is it no longer open?" else "Say what to do instead…") })
            TextButton(onClick = { noteAction = null }, enabled = enabled) { Text("Back") }
        }
    }
    val doors: @Composable ColumnScope.() -> Unit = doors@{
        if (batchPage != null) return@doors
        result.message?.let { Text(it, Modifier.testTag("card-result"), color = if (result.uncertain) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
        result.response?.takeIf { it.text("code") in setOf("TASK_ALREADY_RUNNING", "TASK_RUN_PIN_CONFLICT", "TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED") }
            ?.text("conflictingSessionId")?.takeIf { it.isNotBlank() }?.let { LinkButton("Open the run", "orbit-session:$it", open) }
        if (result.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        // A merge under way: its dead press says how far its job got, beside the Cancel it still offers (iOS `mergingActionLabel`).
        if (card.family == CardFamily.PROMOTION && PromotionCards.isMerging(card.source)) OutlinedButton(onClick = {}, enabled = false,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("${card.key}:merging")) { Text(PromotionCards.mergingActionLabel(card.source)) }
        // Reopen task is pressed in the review's box (iOS `OwnerConfirmationReviewBarView`), not among the card's buttons.
        card.actions.filter { it != CardVerb.REOPEN_TASK }.forEach { verb ->
            val requiresNote = verb in setOf(CardVerb.SEND_BACK, CardVerb.CHAT, CardVerb.MARK_HANDLED)
            // Decide it myself sends nothing: it opens the waiting revision's decision here (`CoordinatorQueue.decideMyself`).
            val valid = verb == CardVerb.DECIDE_MYSELF || runCatching { CardRequests.build(card, verb, input.copy(triggerId = "validation")) }.isSuccess
            val label = if (verb == CardVerb.REMEMBER) {
                val rules = ApprovalRules.remember(card.source.text("toolName") ?: "", card.source.obj("input") ?: JsonObject(emptyMap()))
                "Allow & remember " + rules.joinToString(", ") { it.ruleContent?.removeSuffix(":*") ?: it.toolName }
            } else if (verb == CardVerb.SEND_BACK && noteAction != verb) "Chat about this"
            // The batch's yes names its count, because the question above it scrolls away (iOS `batchCreateAction`).
            else if (verb == CardVerb.CREATE_BATCH && batchPreview != null) BatchReview.createAction(batchPreview.number("taskCount") ?: BatchReview.tasks(batchPreview).size)
            else verb.label
            OutlinedButton(onClick = {
                when {
                    requiresNote && noteAction != verb -> noteAction = verb
                    verb in setOf(CardVerb.CANCEL_TASK, CardVerb.CONFIRM_MERGE, CardVerb.WIKI_REVERT, CardVerb.WATCH_CANCEL) -> confirming = verb
                    else -> send(verb)
                }
            }, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("${card.key}:${verb.name}"),
                enabled = enabled && (valid || requiresNote && noteAction != verb)) { Text(label) }
        }
    }
    // A record — a receipt, a reviewer's return — is drawn dimmed, so it does not read as something still waiting to be pressed.
    val record = card.family == CardFamily.OWNER_CONFIRMATION && card.context.text("ownerCard") in setOf("receipt", "returned")
    if (review) Column(Modifier.fillMaxSize().testTag(card.key)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp), content = body)
        HorizontalDivider()
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = doors)
    } else Surface(Modifier.fillMaxWidth().testTag(card.key).alpha(if (record) 0.72f else 1f), shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { body(); doors() }
    }
    confirming?.let { verb -> AlertDialog(onDismissRequest = { confirming = null },
        title = { Text(if (verb == CardVerb.REOPEN_TASK) TaskReopenCopy.modalTitle else "${verb.label}?") },
        text = { Text(when (verb) {
            // The task panel's own question (`TaskReopen`): a receipt's reopen is a second place to press the one door.
            CardVerb.REOPEN_TASK -> TaskReopen.paragraphs(buildJsonObject { (card.context.obj("view")?.text("projectId"))?.let { put("projectId", it) } })
                .joinToString("\n\n")
            CardVerb.CANCEL_TASK -> "This ends the task's attempt and closes its exceptions. Its branch and history remain."
            CardVerb.CONFIRM_MERGE -> "Merge the displayed source revision into ${card.source.text("upstreamRef")}. The server checks this exact revision again."
            CardVerb.WIKI_REVERT -> "Take back the changes shown in this run's revert plan."
            else -> "Stop this watch. It will no longer wait for its condition."
        }) }, confirmButton = { TextButton(modifier = Modifier.testTag("confirm:${verb.name}"), enabled = enabled, onClick = { confirming = null; send(verb) }) { Text(verb.label) } },
        dismissButton = { TextButton(onClick = { confirming = null }) { Text(if (verb == CardVerb.REOPEN_TASK) "Cancel" else "Back") } }) }
}

private fun <T> jsonSaver(serializer: KSerializer<T>) = Saver<T, String>(
    save = { Wire.json.encodeToString(serializer, it) }, restore = { Wire.json.decodeFromString(serializer, it) })

@Composable
private fun ChoiceRow(label: String, description: String?, selected: Boolean, enabled: Boolean,
    multiple: Boolean = false, recommended: Boolean = false, choose: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(selected, enabled, role = if (multiple) Role.Checkbox else Role.RadioButton, onClick = choose).padding(vertical = 6.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        if (multiple) Checkbox(selected, null, enabled = enabled) else RadioButton(selected, null, enabled = enabled)
        Column(Modifier.weight(1f)) { Text(label + if (recommended) " · Recommended" else ""); description?.let { Text(it, style = MaterialTheme.typography.bodySmall) } }
    }
}
