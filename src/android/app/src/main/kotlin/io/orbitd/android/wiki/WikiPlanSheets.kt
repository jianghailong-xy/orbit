package io.orbitd.android.wiki

import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.verticalDrag
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
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
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
    WikiSheet(sending, close, Modifier.testTag("wiki-plan-redraft-sheet")) {
        SheetBar(WikiPlanCopy.redraftTitle, WikiPlanCopy.cancel, WikiPlanCopy.redraftGo, confirmEnabled = !sending && !busy,
            confirmTag = "wiki-plan-redraft-go", cancel = close, cancelEnabled = !sending) {
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
    // A section is moved by dragging its handle, as iOS's list in edit mode (the owner's decision, card
    // 34bs0PdYUHHwiKHYn3rCp): rows trade places as it passes half of the next one, and the order is the form's once it
    // is let go. The drag is measured on the list, which stays put, not on the row, which moves with the finger.
    var drag by remember { mutableStateOf<WikiSectionDrag?>(null) }
    val handles = remember { mutableMapOf<String, Rect>() }
    val heights = remember { mutableMapOf<String, Int>() }
    var list by remember { mutableStateOf<LayoutCoordinates?>(null) }
    WikiSheet(saving, close, Modifier.testTag("wiki-plan-edit-sheet")) {
        SheetBar(WikiPlanCopy.editTitle(number), WikiPlanCopy.cancel, WikiPlanCopy.saveDraft, confirmEnabled = !saving && !busy,
            confirmTag = "wiki-plan-edit-save", cancel = close, cancelEnabled = !saving) {
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
                    val shown = drag?.order?.mapNotNull { id -> form.sections.firstOrNull { it.id == id } } ?: form.sections
                    Column(Modifier.onPlaced { list = it }.pointerInput(Unit) {
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            // Only the handle of a section shown now: a removed one's handle lay where the next moved to.
                            val current = form.sections.map { it.id }
                            val id = handles.entries.firstOrNull { it.key in current && it.value.contains(down.position) }?.key ?: return@awaitEachGesture
                            drag = WikiSectionDrag(id, current, 0f)
                            try {
                                val ended = verticalDrag(down.id) { change -> drag = drag?.moved(change.positionChange().y, heights); change.consume() }
                                val order = drag?.order
                                if (ended && order != null && order != current) form = form.copy(sections = order.mapNotNull { at -> form.sections.firstOrNull { it.id == at } })
                            } finally { drag = null }
                        }
                    }) {
                        shown.forEachIndexed { i, row ->
                            key(row.id) {
                                // A section that goes takes its handle with it.
                                DisposableEffect(row.id) { onDispose { handles.remove(row.id); heights.remove(row.id) } }
                                if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                                val dragged = drag?.id == row.id
                                Box(Modifier.onSizeChanged { heights[row.id] = it.height }.zIndex(if (dragged) 1f else 0f)
                                    .graphicsLayer { translationY = if (dragged) drag?.offset ?: 0f else 0f }) {
                                    PlanEditRow(i, row, shown.size, change = { updated -> sections { this[indexOfFirst { it.id == row.id }] = updated } },
                                        remove = { sections { removeAt(indexOfFirst { it.id == row.id }) } },
                                        move = { by -> sections { val at = indexOfFirst { it.id == row.id }; add(at + by, removeAt(at)) } },
                                        handle = Modifier.onGloballyPositioned { at -> list?.takeIf { it.isAttached }?.let { handles[row.id] = it.localBoundingBoxOf(at) } })
                                }
                            }
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

/** One section of the Edit sheet: taken out, its title (written only for one added here), its kind, and moved — by
 * its handle, or, for TalkBack, which cannot drag, by the row's Move up and Move down actions. */
@Composable
private fun PlanEditRow(index: Int, row: WikiPlanLogic.DocForm.Section, count: Int, change: (WikiPlanLogic.DocForm.Section) -> Unit,
    remove: () -> Unit, move: (Int) -> Unit, handle: Modifier) {
    Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 4.dp, bottom = 4.dp).testTag("wiki-plan-edit-row:$index")
        .semantics {
            customActions = listOfNotNull(CustomAccessibilityAction(WikiPlanCopy.moveUp) { move(-1); true }.takeIf { index > 0 },
                CustomAccessibilityAction(WikiPlanCopy.moveDown) { move(1); true }.takeIf { index < count - 1 })
        }, verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = remove, modifier = Modifier.testTag("wiki-plan-edit-remove:$index")) {
            Icon(painterResource(R.drawable.ic_remove_circle), "Delete", tint = MaterialTheme.colorScheme.error)
        }
        Column(Modifier.weight(1f)) {
            if (row.key == null) OutlinedTextField(row.title, { change(row.copy(title = it)) }, Modifier.fillMaxWidth().testTag("wiki-plan-edit-row-title:$index"),
                placeholder = { Text(WikiPlanCopy.editTitleField) }, singleLine = true)
            else Text(row.title, Modifier.padding(top = 6.dp), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
            PlanKindMenu(row.kind, "wiki-plan-edit-kind:$index") { change(row.copy(kind = it)) }
        }
        // The handle iOS's edit mode draws at a row's trailing edge; the drag itself is the list's.
        Box(handle.size(48.dp).testTag("wiki-plan-edit-drag:$index").clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_reorder), null, tint = WikiPalette.secondary)
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
    WikiSheet(saving, close, Modifier.testTag("wiki-plan-section-edit-sheet")) {
        SheetBar(WikiPlanCopy.editTitle("§${index + 1}"), WikiPlanCopy.cancel, WikiPlanCopy.saveDraft, confirmEnabled = !saving && !busy,
            confirmTag = "wiki-plan-section-edit-save", cancel = close, cancelEnabled = !saving) {
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

/** One drag of the Edit sheet: the section being moved, the order as it stands, and how far the row is from its slot
 * (A13's runner drag, for sections). */
internal data class WikiSectionDrag(val id: String, val order: List<String>, val offset: Float) {
    /** Moved by [dy]: it takes the next row's place once past half of it, the offset kept relative to its new slot. */
    fun moved(dy: Float, heights: Map<String, Int>): WikiSectionDrag {
        var order = order; var offset = offset + dy
        while (true) {
            val at = order.indexOf(id)
            if (at < 0) return this // not a row of this order: nothing moves
            val next = order.getOrNull(at + 1)?.let { heights[it] }
            val previous = order.getOrNull(at - 1)?.let { heights[it] }
            if (next != null && offset > next / 2f) { order = order.toMutableList().apply { add(at + 1, removeAt(at)) }; offset -= next }
            else if (previous != null && offset < -previous / 2f) { order = order.toMutableList().apply { add(at - 1, removeAt(at)) }; offset += previous }
            else return WikiSectionDrag(id, order, offset)
        }
    }
}
