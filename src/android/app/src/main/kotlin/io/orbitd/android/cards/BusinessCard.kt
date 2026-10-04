package io.orbitd.android.cards

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
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
import io.orbitd.android.text.*
import kotlinx.serialization.json.*
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.*
import java.util.UUID

/** The same component and commands can be embedded in Tasks/Projects and Wiki when routed there. */
@Composable
fun BusinessCard(card: InteractionCard, fresh: Boolean, result: CardActionState = CardActionState(),
    open: (String) -> Unit, discuss: ((String) -> Unit)? = null, submit: (CardVerb, CardInput) -> Unit) {
    var note by rememberSaveable(card.key, card.binding) { mutableStateOf("") }
    var noteAction by rememberSaveable(card.key, card.binding) { mutableStateOf<CardVerb?>(null) }
    var selections by rememberSaveable(card.key, card.binding, stateSaver = jsonSaver(MapSerializer(String.serializer(), ListSerializer(String.serializer())))) { mutableStateOf<Map<String, List<String>>>(emptyMap()) }
    var custom by rememberSaveable(card.key, card.binding, stateSaver = jsonSaver(MapSerializer(String.serializer(), String.serializer()))) { mutableStateOf<Map<String, String>>(emptyMap()) }
    var ownerAnswers by rememberSaveable(card.key, card.binding, stateSaver = jsonSaver(ListSerializer(OwnerAnswer.serializer()))) { mutableStateOf<List<OwnerAnswer>>(emptyList()) }
    var option by rememberSaveable(card.key, card.binding) { mutableStateOf(card.source.obj("question")?.number("recommendedOption")) }
    var settings by rememberSaveable(card.key, card.binding, stateSaver = jsonSaver(ProjectStartSettings.serializer().nullable)) { mutableStateOf(card.source.obj("startRequest")?.obj("settings")?.let {
        runCatching { Wire.json.decodeFromJsonElement(ProjectStartSettings.serializer(), it) }.getOrNull()
    }) }
    var reason by rememberSaveable(card.key, card.binding) { mutableStateOf<String?>(null) }
    val proposal = card.source.obj("payload")?.let { it.obj("entry") ?: it.obj("changes") } ?: card.source.obj("entry")
    var editTitle by rememberSaveable(card.key, card.binding) { mutableStateOf(proposal?.text("title").orEmpty()) }
    var editSummary by rememberSaveable(card.key, card.binding) { mutableStateOf(proposal?.text("summary").orEmpty()) }
    var confirming by remember { mutableStateOf<CardVerb?>(null) }
    val enabled = fresh && !result.busy && !result.uncertain && !result.settled
    val input = CardInput(note, selections, custom, ownerAnswers, option, settings,
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
    Surface(Modifier.fillMaxWidth().testTag(card.key), shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(card.title, style = MaterialTheme.typography.titleMedium)
            Text("Filed by Orbit", style = MaterialTheme.typography.labelSmall)
            card.status?.let { Text(it, style = MaterialTheme.typography.labelMedium) }
            CardBody(card, open)
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
            if (card.family == CardFamily.OWNER_CONFIRMATION && CardVerb.CONFIRM_OWNER in card.actions) {
                val questions = CardRequests.reviewQuestions(card.source.obj("waiting")?.obj("review"))
                questions.forEach { q ->
                    val id = q.text("key") ?: return@forEach
                    val choice = ownerAnswers.firstOrNull { it.key == id } ?: OwnerAnswer(id, q.number("recommendedOption"))
                    fun choose(answer: OwnerAnswer) { ownerAnswers = ownerAnswers.filterNot { it.key == id } + answer }
                    Text(q.text("text") ?: "", style = MaterialTheme.typography.titleSmall)
                    q.objects("options").forEachIndexed { index, o ->
                        ChoiceRow(o.text("label") ?: "", o.text("description"), choice.option == index, enabled,
                            recommended = index == q.number("recommendedOption")) { choose(OwnerAnswer(id, index)) }
                    }
                    ChoiceRow("Other", null, choice.option == null, enabled) { choose(OwnerAnswer(id, text = "")) }
                    if (choice.option == null) OutlinedTextField(choice.text.orEmpty(), { choose(OwnerAnswer(id, text = it)) },
                        Modifier.fillMaxWidth(), enabled = enabled, label = { Text("Your answer") })
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
            if (CardVerb.START in card.actions) settings?.let { draft ->
                StartSettings(draft, enabled) { settings = it }
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
            result.message?.let { Text(it, Modifier.testTag("card-result"), color = if (result.uncertain) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
            result.response?.takeIf { it.text("code") in setOf("TASK_ALREADY_RUNNING", "TASK_RUN_PIN_CONFLICT", "TASK_RUN_PROVIDER_SWITCH_CONFIRMATION_REQUIRED") }
                ?.text("conflictingSessionId")?.takeIf { it.isNotBlank() }?.let { LinkButton("Open the run", "orbit-session:$it", open) }
            if (result.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            card.actions.forEach { verb ->
                val requiresNote = verb in setOf(CardVerb.SEND_BACK, CardVerb.CHAT, CardVerb.MARK_HANDLED)
                val valid = runCatching { CardRequests.build(card, verb, input.copy(triggerId = "validation")) }.isSuccess
                val label = if (verb == CardVerb.REMEMBER) {
                    val rules = ApprovalRules.remember(card.source.text("toolName") ?: "", card.source.obj("input") ?: JsonObject(emptyMap()))
                    "Allow & remember " + rules.joinToString(", ") { it.ruleContent?.removeSuffix(":*") ?: it.toolName }
                } else if (verb == CardVerb.SEND_BACK && noteAction != verb) "Chat about this" else verb.label
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
    }
    confirming?.let { verb -> AlertDialog(onDismissRequest = { confirming = null }, title = { Text("${verb.label}?") },
        text = { Text(when (verb) {
            CardVerb.CANCEL_TASK -> "This ends the task's attempt and closes its exceptions. Its branch and history remain."
            CardVerb.CONFIRM_MERGE -> "Merge the displayed source revision into ${card.source.text("upstreamRef")}. The server checks this exact revision again."
            CardVerb.WIKI_REVERT -> "Take back the changes shown in this run's revert plan."
            else -> "Stop this watch. It will no longer wait for its condition."
        }) }, confirmButton = { TextButton(modifier = Modifier.testTag("confirm:${verb.name}"), enabled = enabled, onClick = { confirming = null; send(verb) }) { Text(verb.label) } },
        dismissButton = { TextButton(onClick = { confirming = null }) { Text("Back") } }) }
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

@Composable
private fun StartSettings(settings: ProjectStartSettings, enabled: Boolean, change: (ProjectStartSettings) -> Unit) {
    Text("Run settings", style = MaterialTheme.typography.titleSmall)
    ChoiceRow("Project branch", "Finished tasks land on the project's branch.", settings.line == "PROJECT_BRANCH", enabled) { change(settings.copy(line = "PROJECT_BRANCH")) }
    ChoiceRow("Main", "Finished tasks land on the upstream branch.", settings.line == "MAIN", enabled) { change(settings.copy(line = "MAIN")) }
    if (settings.line == "PROJECT_BRANCH") OutlinedTextField(settings.projectBranchName.orEmpty(), { change(settings.copy(projectBranchName = it)) },
        Modifier.fillMaxWidth(), enabled = enabled, label = { Text("Project branch (optional)") })
    ChoiceRow("Automatic", "The coordinator runs the project.", settings.automatic, enabled, multiple = true) { change(settings.copy(automatic = !settings.automatic)) }
    var count by remember(settings.maxConcurrentTasks) { mutableStateOf(settings.maxConcurrentTasks.toString()) }
    OutlinedTextField(count, { count = it; change(settings.copy(maxConcurrentTasks = it.toIntOrNull() ?: 0)) }, Modifier.fillMaxWidth(), enabled = enabled,
        label = { Text("Concurrent tasks (1–100)") }, isError = settings.maxConcurrentTasks !in 1..100)
    OutlinedTextField(settings.mergeCheckCommand.orEmpty(), { change(settings.copy(mergeCheckCommand = it)) }, Modifier.fillMaxWidth(), enabled = enabled,
        label = { Text("Merge check command") })
}
