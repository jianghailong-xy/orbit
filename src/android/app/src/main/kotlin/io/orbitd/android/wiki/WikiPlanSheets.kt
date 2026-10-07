package io.orbitd.android.wiki

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import kotlinx.coroutines.launch

// Redraft… and Edit (iOS `WikiPlanView.swift` § Redraft…, § Edit): sheets over the plan's pages. A sheet keeps what the
// owner wrote when the server refuses it, and says why; it closes only once the server took it.

/** What a section is (contract `plan.sectionKinds`), in the contract's order: the kinds the Edit sheets offer (iOS
 * `WikiPlanSectionKind.allCases` without `.unknown`). */
internal val wikiPlanSectionKinds = listOf("overview", "concepts", "flow", "interface", "data", "ops", "pitfalls", "decisions", "conventions", "other")

// MARK: - Redraft…

/** Redraft the plan (mock 22 ⑧): what to change, in the owner's words — empty is a fresh draft — and the protected
 * documents a redraft keeps as they are. [redraft] sends it; true once the server took it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiPlanRedraftSheet(note: String, protectedDocs: List<String>, busy: Boolean = false, close: () -> Unit,
    redraft: suspend (String) -> Boolean) {
    var words by rememberSaveable { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("wiki-plan-redraft-sheet")) {
        SheetBar(WikiPlanCopy.redraftTitle, WikiPlanCopy.cancel, WikiPlanCopy.redraftGo, confirmEnabled = !sending && !busy,
            confirmTag = "wiki-plan-redraft-go", cancel = close) {
            sending = true
            scope.launch { val done = redraft(words); sending = false; if (done) close() }
        }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(note, style = WikiType.label, color = WikiPalette.secondary)
            OutlinedTextField(words, { words = it }, Modifier.fillMaxWidth().heightIn(min = 120.dp).testTag("wiki-plan-redraft-words"),
                placeholder = { Text(WikiPlanCopy.redraftPlaceholder) })
            if (protectedDocs.isNotEmpty()) Text(WikiPlanCopy.protectedKept(protectedDocs), style = WikiType.label, color = WikiPalette.secondary)
            Spacer(Modifier.height(16.dp))
        }
    }
}

// MARK: - Edit

/** Edit one document (mock 22 ⑨): its title, question, length and protection, and its sections — taken out, moved into a
 * new order, or added. Saving makes a new draft, which goes through the gate again; the sections it kept keep their
 * sources, and the next run finds material for the ones it added. [save] sends the draft's shape; null once the server
 * took it, else the gate's errors or why not. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiPlanEditSheet(number: String, stored: WikiPlanDoc, nextVersion: Int, busy: Boolean = false, close: () -> Unit,
    save: suspend (WikiPlanDocInput) -> List<String>?) {
    var form by remember(stored) { mutableStateOf(WikiPlanLogic.docForm(stored)) }
    var minText by remember(stored) { mutableStateOf(form.length.min.toString()) }
    var maxText by remember(stored) { mutableStateOf(form.length.max.toString()) }
    var refused by remember { mutableStateOf<List<String>?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun sections(change: MutableList<WikiPlanLogic.DocForm.Section>.() -> Unit) {
        form = form.copy(sections = form.sections.toMutableList().apply(change))
    }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("wiki-plan-edit-sheet")) {
        SheetBar(WikiPlanCopy.editTitle(number), WikiPlanCopy.cancel, WikiPlanCopy.saveDraft, confirmEnabled = !saving && !busy,
            confirmTag = "wiki-plan-edit-save", cancel = close) {
            saving = true
            val input = WikiPlanLogic.docEdit(stored, form)
            scope.launch { val answer = save(input); saving = false; if (answer != null) refused = answer else close() }
        }
        LazyColumn(Modifier.fillMaxWidth().imePadding().testTag("wiki-plan-edit-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "fields") {
                WikiCard {
                    OutlinedTextField(form.title, { form = form.copy(title = it) }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                        .testTag("wiki-plan-edit-title"), label = { Text(WikiPlanCopy.editTitleField) }, singleLine = true)
                    OutlinedTextField(form.question, { form = form.copy(question = it) }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                        .testTag("wiki-plan-edit-question"), label = { Text(WikiPlanCopy.question) }, minLines = 2, maxLines = 6)
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(WikiPlanCopy.length, Modifier.weight(1f), style = WikiType.prose)
                        PlanNumberField(minText, "wiki-plan-edit-min") { text ->
                            minText = text; text.toIntOrNull()?.let { form = form.copy(length = form.length.copy(min = it)) }
                        }
                        Text("–")
                        PlanNumberField(maxText, "wiki-plan-edit-max") { text ->
                            maxText = text; text.toIntOrNull()?.let { form = form.copy(length = form.length.copy(max = it)) }
                        }
                        Text("chars", style = WikiType.subtext, color = WikiPalette.secondary)
                    }
                    Row(Modifier.fillMaxWidth().toggleable(form.protected, role = Role.Switch) { form = form.copy(protected = it) }
                        .padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-plan-edit-protected"), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(WikiPlanCopy.protected, style = WikiType.prose)
                            Text(WikiPlanCopy.protectedSwitch, style = WikiType.label, color = WikiPalette.secondary)
                        }
                        Switch(checked = form.protected, onCheckedChange = null)
                    }
                }
            }
            item(key = "sections-header") { WikiPlanSectionHead(WikiPlanCopy.sections) }
            item(key = "sections") {
                WikiCard(Modifier.testTag("wiki-plan-edit-sections")) {
                    form.sections.forEachIndexed { i, row ->
                        key(row.id) {
                            if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                            PlanEditRow(i, row, form.sections.size, change = { updated -> sections { this[i] = updated } },
                                remove = { sections { removeAt(i) } }, move = { to -> sections { add(to, removeAt(i)) } })
                        }
                    }
                    if (form.sections.isNotEmpty()) HorizontalDivider(Modifier.padding(start = 16.dp))
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { sections { add(WikiPlanLogic.DocForm.Section(null, "", "other")) } }
                        .heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-plan-edit-add"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(painterResource(R.drawable.ic_add_circle), null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
                        Text(WikiPlanCopy.addSection, style = WikiType.prose, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            item(key = "save-note") { WikiPlanFootnote(WikiPlanCopy.saveNote(nextVersion)) }
            refused?.let { lines -> item(key = "refused") { PlanRefusedLines(lines, "wiki-plan-edit-refused") } }
        }
    }
}

/** One section of the Edit sheet: taken out, its title (written only for one added here), its kind, and moved. */
@Composable
private fun PlanEditRow(index: Int, row: WikiPlanLogic.DocForm.Section, count: Int, change: (WikiPlanLogic.DocForm.Section) -> Unit,
    remove: () -> Unit, move: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 4.dp, bottom = 4.dp).testTag("wiki-plan-edit-row:$index"),
        verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = remove, modifier = Modifier.testTag("wiki-plan-edit-remove:$index")) {
            Icon(painterResource(R.drawable.ic_remove_circle), "Delete", tint = MaterialTheme.colorScheme.error)
        }
        Column(Modifier.weight(1f)) {
            if (row.key == null) OutlinedTextField(row.title, { change(row.copy(title = it)) }, Modifier.fillMaxWidth().testTag("wiki-plan-edit-row-title:$index"),
                placeholder = { Text(WikiPlanCopy.editTitleField) }, singleLine = true)
            else Text(row.title, Modifier.padding(top = 6.dp), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically) {
                PlanKindMenu(row.kind, "wiki-plan-edit-kind:$index") { change(row.copy(kind = it)) }
                Spacer(Modifier.weight(1f))
                IconButton(onClick = { move(index - 1) }, enabled = index > 0, modifier = Modifier.testTag("wiki-plan-edit-up:$index")) {
                    Icon(painterResource(R.drawable.ic_arrow_up), "Move up")
                }
                IconButton(onClick = { move(index + 1) }, enabled = index < count - 1, modifier = Modifier.testTag("wiki-plan-edit-down:$index")) {
                    Icon(painterResource(R.drawable.ic_arrow_down), "Move down")
                }
            }
        }
    }
}

/** One section, edited from its own page: title, kind, what it covers, length. [save] gets the four as written. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WikiPlanSectionEditSheet(index: Int, stored: WikiPlanSection, nextVersion: Int, busy: Boolean = false, close: () -> Unit,
    save: suspend (title: String, kind: String, covers: String, length: Int) -> List<String>?) {
    var title by rememberSaveable(stored.id) { mutableStateOf(stored.title) }
    var kind by rememberSaveable(stored.id) { mutableStateOf(stored.kind) }
    var covers by rememberSaveable(stored.id) { mutableStateOf(stored.covers ?: "") }
    var length by rememberSaveable(stored.id) { mutableStateOf(stored.length ?: WikiPlanCopy.newSectionLength) }
    var lengthText by rememberSaveable(stored.id) { mutableStateOf(length.toString()) }
    var refused by remember { mutableStateOf<List<String>?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        modifier = Modifier.testTag("wiki-plan-section-edit-sheet")) {
        SheetBar(WikiPlanCopy.editTitle("§${index + 1}"), WikiPlanCopy.cancel, WikiPlanCopy.saveDraft, confirmEnabled = !saving && !busy,
            confirmTag = "wiki-plan-section-edit-save", cancel = close) {
            saving = true
            scope.launch { val answer = save(title, kind, covers, length); saving = false; if (answer != null) refused = answer else close() }
        }
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(bottom = 24.dp)) {
            WikiCard {
                OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                    .testTag("wiki-plan-section-edit-title"), label = { Text(WikiPlanCopy.editTitleField) }, singleLine = true)
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(WikiPlanCopy.editKind, Modifier.weight(1f), style = WikiType.prose)
                    PlanKindMenu(kind, "wiki-plan-section-edit-kind") { kind = it }
                }
                OutlinedTextField(covers, { covers = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                    .testTag("wiki-plan-section-edit-covers"), label = { Text(WikiPlanCopy.covers) }, minLines = 2, maxLines = 8)
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(WikiPlanCopy.length, Modifier.weight(1f), style = WikiType.prose)
                    PlanNumberField(lengthText, "wiki-plan-section-edit-length") { text -> lengthText = text; text.toIntOrNull()?.let { length = it } }
                }
            }
            WikiPlanFootnote(WikiPlanCopy.saveNote(nextVersion))
            refused?.let { PlanRefusedLines(it, "wiki-plan-section-edit-refused") }
        }
    }
}

/** A section's kind, picked from the contract's kinds. */
@Composable
private fun PlanKindMenu(kind: String, tag: String, pick: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val label = WikiDocCopy.sectionKind(kind)
    Box {
        TextButton(onClick = { expanded = true }, modifier = Modifier.testTag(tag).semantics { contentDescription = "${WikiPlanCopy.editKind}: $label" }) {
            Text(label)
            Icon(painterResource(R.drawable.ic_chevron_updown), null, Modifier.padding(start = 4.dp).size(14.dp))
        }
        DropdownMenu(expanded, { expanded = false }) {
            wikiPlanSectionKinds.forEach { option ->
                DropdownMenuItem(text = { Text(WikiDocCopy.sectionKind(option)) }, modifier = Modifier.testTag("$tag:$option"),
                    leadingIcon = { if (option == kind) Icon(painterResource(R.drawable.ic_check), null) else Spacer(Modifier.size(24.dp)) },
                    onClick = { expanded = false; pick(option) })
            }
        }
    }
}

/** A whole number the owner types: digits only; one that does not read as a number leaves the value as it was. */
@Composable
private fun PlanNumberField(text: String, tag: String, change: (String) -> Unit) {
    OutlinedTextField(text, { typed -> change(typed.filter(Char::isDigit).take(7)) }, Modifier.width(80.dp).testTag(tag), singleLine = true,
        textStyle = WikiType.prose.copy(textAlign = TextAlign.End), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
}

/** What the server said when it refused a save: the gate's errors (the first eight), or why not. */
@Composable
private fun PlanRefusedLines(lines: List<String>, tag: String) {
    WikiCard(Modifier.padding(top = 8.dp).testTag(tag)) {
        lines.take(8).forEach { Text(it, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), style = WikiType.label, color = MaterialTheme.colorScheme.error) }
    }
}
