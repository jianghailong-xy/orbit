@file:OptIn(ExperimentalMaterial3Api::class)

package io.orbitd.android.wiki

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.launch

// The Wiki's documents on a phone (iOS `WikiDocView.swift`): one document of the plan the owner confirmed — its reader
// and scope, its sections with a superscript footnote after each sourced sentence and a mark after each that is not,
// its footnotes and the entries its quotes came through — and Browse by category and the A–Z index by document. Drawn
// from what the server said and nothing else; where a press goes is decided by the screen that mounts the page
// (`WikiDocs.kt`, `WikiArticles.kt`). The blocks are the web phone's, in its order; every word and count is
// `WikiDocCopy` / `WikiDocLogic`. The Contents sheet's document rows (iOS `WikiDocContentsRows`) are `WikiChrome.kt`'s.

/** Where a press on a document's page goes (iOS `WikiDocActions`). */
internal class WikiDocActions(
    val openEntry: (String) -> Unit = {},
    val openDoc: (String) -> Unit = {},
    val openBrowse: () -> Unit = {},
    val openContents: () -> Unit = {},
    /** A footnote's one button: the session at that record, the task, the project, or the repository's host. */
    val openSource: (WikiDocLogic.OpenTarget) -> Unit = {},
)

/** A footnote the reader opened, from a sentence or from the list (iOS `WikiDocOpenNote`). */
internal data class WikiDocOpenNote(val n: Int)

/** A marked sentence the reader tapped: where it is, for its bubble (iOS `WikiDocOpenMark`). */
internal data class WikiDocOpenMark(val section: String, val block: Int, val sentence: Int) {
    val id: String get() = "$section.$block.$sentence"
}

private val openDocNoteSaver = Saver<WikiDocOpenNote?, Int>(save = { it?.n }, restore = { WikiDocOpenNote(it) })
private val openMarkSaver = Saver<WikiDocOpenMark?, ArrayList<String>>(
    save = { mark -> mark?.let { arrayListOf(it.section, "${it.block}", "${it.sentence}") } },
    restore = { WikiDocOpenMark(it[0], it[1].toInt(), it[2].toInt()) })

/** iOS's system orange, for the washes behind what is marked; its words are `WikiPalette.amber`, legible on either ground. */
private val systemOrange = Color(0xFFFF9500)

/** One row of a document's list, in `WikiDocLogic.Section`'s order: what the page lays out, and where a section address
 * and Next marked › scroll to. */
private sealed interface DocRow {
    val key: String
    data object Crumb : DocRow { override val key = "crumb" }
    data object Title : DocRow { override val key = "title" }
    data object Tags : DocRow { override val key = "tags" }
    data object Updated : DocRow { override val key = "updated" }
    data object Review : DocRow { override val key = "review" }
    data object Scope : DocRow { override val key = "scope" }
    data class Heading(val at: Int, val section: WikiDocSection) : DocRow { override val key: String get() = "section:$at" }
    data class Unwritten(val at: Int, val section: WikiDocSection) : DocRow { override val key: String get() = "unwritten:$at" }
    data class Block(val at: Int, val section: WikiDocSection, val index: Int, val block: WikiDocBlock) : DocRow {
        override val key: String get() = "block:$at:$index"
        /** Whether a sentence of it wears a mark: a row Next marked › stops at. */
        val marked: Boolean get() = block.sentences.orEmpty().any { WikiDocLogic.mark(it) != null }
    }
    data class FootnotesHeader(val footnotes: List<WikiDocFootnote>) : DocRow { override val key: String get() = "footnotes" }
    data class Footnote(val at: Int, val note: WikiDocFootnote) : DocRow { override val key: String get() = "footnote:$at" }
    data class FootnotesMore(val hidden: Int) : DocRow { override val key: String get() = "footnotes-more" }
    data class EntriesHeader(val count: Int) : DocRow { override val key: String get() = "entries" }
    data class GroupHeader(val at: Int, val group: WikiDocLogic.EntryGroup) : DocRow { override val key: String get() = "group:$at" }
    data class Entry(val group: Int, val at: Int, val entry: WikiDocViaEntry) : DocRow { override val key: String get() = "entry:$group:$at" }
    data class GroupMore(val at: Int, val group: WikiDocLogic.EntryGroup) : DocRow { override val key: String get() = "group-more:$at" }
}

private fun docRows(doc: WikiDoc, allFootnotes: Boolean, expanded: Set<String>): List<DocRow> = WikiDocLogic.Section.entries.flatMap { section ->
    when (section) {
        WikiDocLogic.Section.CRUMB -> listOf(DocRow.Crumb)
        WikiDocLogic.Section.TITLE -> listOf(DocRow.Title)
        WikiDocLogic.Section.TAGS -> listOf(DocRow.Tags)
        WikiDocLogic.Section.UPDATED -> listOf(DocRow.Updated)
        WikiDocLogic.Section.REVIEW -> if (doc.status == "needs_review") listOf(DocRow.Review) else emptyList()
        WikiDocLogic.Section.SCOPE -> listOf(DocRow.Scope)
        WikiDocLogic.Section.BODY -> doc.sections.orEmpty().flatMapIndexed { at, part ->
            listOf<DocRow>(DocRow.Heading(at, part)) +
                if (part.written == false) listOf(DocRow.Unwritten(at, part))
                else part.blocks.orEmpty().mapIndexed { b, block -> DocRow.Block(at, part, b, block) }
        }
        WikiDocLogic.Section.FOOTNOTES -> {
            val footnotes = doc.footnotes.orEmpty()
            if (footnotes.isEmpty()) emptyList() else {
                val shown = if (allFootnotes) footnotes else footnotes.take(WikiDocCopy.footnotesShown)
                listOf<DocRow>(DocRow.FootnotesHeader(footnotes)) + shown.mapIndexed { i, note -> DocRow.Footnote(i, note) } +
                    (if (footnotes.size > shown.size) listOf(DocRow.FootnotesMore(footnotes.size - shown.size)) else emptyList())
            }
        }
        WikiDocLogic.Section.ENTRIES -> {
            val entries = doc.entries.orEmpty()
            if (entries.isEmpty()) emptyList() else listOf<DocRow>(DocRow.EntriesHeader(entries.size)) +
                WikiDocLogic.entryGroups(entries).flatMapIndexed { g, group ->
                    val all = group.title in expanded
                    val shown = if (all) group.entries else group.entries.take(WikiDocCopy.groupShownPhone)
                    listOf<DocRow>(DocRow.GroupHeader(g, group)) + shown.mapIndexed { i, entry -> DocRow.Entry(g, i, entry) } +
                        (if (group.entries.size > WikiDocCopy.groupShownPhone && !all) listOf(DocRow.GroupMore(g, group)) else emptyList())
                }
        }
    }
}

// MARK: - one document

/** One document (iOS `WikiDocPage`, mock 24): the crumb, the title, the tags, when and from what it was written, the
 * banner of a document past the threshold, the reader and scope, the text section by section, the footnotes, and the
 * entries its quotes came through — `WikiDocLogic.Section`'s order, which is the web phone's. Opened at a section, it
 * scrolls there once; Back to it finds the reader where they left it. */
@Composable
internal fun WikiDocPage(doc: WikiDoc, github: String?, written: Pair<Int, Int>?, summaries: Map<String, String> = emptyMap(),
    section: String? = null, actions: WikiDocActions = WikiDocActions()) {
    var openNote by rememberSaveable(stateSaver = openDocNoteSaver) { mutableStateOf<WikiDocOpenNote?>(null) }
    var openMark by rememberSaveable(stateSaver = openMarkSaver) { mutableStateOf<WikiDocOpenMark?>(null) }
    var scopeOpen by rememberSaveable { mutableStateOf(false) }
    var allFootnotes by rememberSaveable { mutableStateOf(false) }
    var expanded by rememberSaveable(stateSaver = wikiStringSetSaver) { mutableStateOf(emptySet<String>()) }
    var nextMark by rememberSaveable { mutableIntStateOf(0) }
    var placed by rememberSaveable(section) { mutableStateOf(section == null) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val notes = remember(doc) { buildMap { doc.footnotes.orEmpty().forEach { putIfAbsent(it.n, it) } } }
    val rows = remember(doc, allFootnotes, expanded) { docRows(doc, allFootnotes, expanded) }
    // A section address (from the Contents sheet, Browse or the index) opens the text at it — once.
    val target = section?.let { key -> rows.indexOfFirst { it is DocRow.Heading && it.section.key == key }.takeIf { it >= 0 } }
    LaunchedEffect(target) {
        if (placed || target == null) return@LaunchedEffect
        listState.scrollToItem(target)
        placed = true
    }
    fun nextMarked() {
        val marked = rows.indices.filter { (rows[it] as? DocRow.Block)?.marked == true }
        if (marked.isEmpty()) return
        val row = marked[nextMark % marked.size]
        nextMark += 1
        scope.launch { listState.centerOn(row) }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-doc-list"), state = listState, contentPadding = PaddingValues(bottom = 24.dp)) {
        items(rows, key = { it.key }) { row ->
            when (row) {
                DocRow.Crumb -> Text(listOfNotNull(WikiCopy.title, doc.category?.title).joinToString(" · "), maxLines = 1,
                    overflow = TextOverflow.Ellipsis, style = WikiType.label, color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = actions.openBrowse).heightIn(min = 48.dp)
                        .padding(horizontal = 16.dp).wrapContentHeight(Alignment.CenterVertically).testTag("wiki-doc-crumb"))
                DocRow.Title -> WikiPageTitle(doc.title, "wiki-doc-title")
                DocRow.Tags -> WikiTagFlow(listOf(WikiTag(doc.category?.title ?: doc.category?.key ?: "", category = true)) +
                    WikiDocLogic.tags(doc).map { WikiTag(it, category = false) }, Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                DocRow.Updated -> DocUpdated(doc, written)
                DocRow.Review -> DocReviewBanner(doc) { nextMarked() }
                DocRow.Scope -> DocScope(doc, scopeOpen, { scopeOpen = !scopeOpen }, actions.openDoc)
                is DocRow.Heading -> DocSectionHeading(row.section)
                is DocRow.Unwritten -> Text(WikiDocCopy.sectionNotWritten, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    style = WikiType.subtext, color = WikiPalette.secondary)
                is DocRow.Block -> DocBlockView(row, notes, openNote?.n, { n -> openNote = WikiDocOpenNote(n) }) { openMark = it }
                is DocRow.FootnotesHeader -> WikiReadingHeader(WikiDocCopy.footnotes, WikiDocLogic.footnotesSummary(row.footnotes))
                is DocRow.Footnote -> DocFootnoteRow(row.note, viaEntry(doc, row.note)) { openNote = WikiDocOpenNote(row.note.n) }
                is DocRow.FootnotesMore -> WikiReadingMore(WikiArticleCopy.showMore(row.hidden), "wiki-doc-footnotes-more") { allFootnotes = true }
                is DocRow.EntriesHeader -> WikiReadingHeader(WikiDocCopy.entries, WikiDocCopy.entriesHint(row.count))
                is DocRow.GroupHeader -> WikiKindGroupHeader(row.group.title, row.group.entries.size, row.group.note)
                is DocRow.Entry -> DocEntryRow(row.entry, doc, summaries) { actions.openEntry(row.entry.id) }
                is DocRow.GroupMore -> WikiReadingMore(WikiArticleCopy.showMore(row.group.entries.size - WikiDocCopy.groupShownPhone),
                    "wiki-doc-group-more:${row.at}") { expanded = expanded + row.group.title }
            }
        }
    }
    val opened = openNote?.let { notes[it.n] }
    if (opened != null) ModalBottomSheet(onDismissRequest = { openNote = null }, modifier = Modifier.testTag("wiki-doc-footnote-sheet")) {
        WikiDocFootnoteSheet(opened, viaEntry(doc, opened), github, openSource = { target ->
            openNote = null
            actions.openSource(target)
        }, openEntry = { id ->
            openNote = null
            actions.openEntry(id)
        })
    }
    val why = openMark?.let { markNote(doc, it) }
    if (why != null) ModalBottomSheet(onDismissRequest = { openMark = null }, modifier = Modifier.testTag("wiki-doc-mark-bubble")) {
        WikiDocMarkBubble(why, openFootnote = { n ->
            openMark = null
            openNote = WikiDocOpenNote(n)
        }, openEntry = { id ->
            openMark = null
            actions.openEntry(id)
        })
    }
}

/** The entry a footnote's quote came through, among the document's. */
private fun viaEntry(doc: WikiDoc, note: WikiDocFootnote): WikiDocViaEntry? =
    note.viaEntryId?.let { id -> doc.entries.orEmpty().firstOrNull { it.id == id } }

/** Why a tapped sentence wears its mark, or nothing for a place the document no longer has. */
private fun markNote(doc: WikiDoc, mark: WikiDocOpenMark): WikiDocLogic.MarkNote? {
    val section = doc.sections.orEmpty().firstOrNull { it.key == mark.section } ?: return null
    val sentence = section.blocks.orEmpty().getOrNull(mark.block)?.sentences.orEmpty().getOrNull(mark.sentence) ?: return null
    return WikiDocLogic.markNote(sentence, section, doc)
}

/** A row to the middle of the list, as iOS's `scrollTo(_, anchor: .center)` puts it. */
private suspend fun LazyListState.centerOn(index: Int) {
    animateScrollToItem(index)
    val info = layoutInfo
    val item = info.visibleItemsInfo.firstOrNull { it.index == index } ?: return
    val middle = (info.viewportStartOffset + info.viewportEndOffset) / 2
    animateScrollBy((item.offset + item.size / 2 - middle).toFloat())
}

// MARK: the head

/** When and at which commit it was written, from which plan version, how many sentences — with the amber end of a
 * document under the threshold; or, for a document no run has written, that it is not written yet. */
@Composable
private fun DocUpdated(doc: WikiDoc, written: Pair<Int, Int>?) {
    val amber = WikiPalette.amber
    val text = if (doc.written) buildAnnotatedString {
        append(WikiDocLogic.updatedParts(doc).joinToString(" · "))
        WikiDocLogic.updatedWarn(doc)?.let { warn -> append(" "); withStyle(SpanStyle(color = amber)) { append("· $warn") } }
    } else buildAnnotatedString {
        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(WikiDocCopy.notWritten) }
        append(" ")
        append(WikiDocLogic.notWrittenNote(written?.first, written?.second))
    }
    Text(text, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("wiki-doc-updated"), style = WikiType.label,
        color = WikiPalette.secondary)
}

/** The banner over a document past the threshold (mock 24 ①): how many, why, the legend, Next marked ›. */
@Composable
private fun DocReviewBanner(doc: WikiDoc, nextMarked: () -> Unit) {
    val amber = WikiPalette.amber
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).background(systemOrange.copy(alpha = 0.10f), RoundedCornerShape(12.dp))
        .padding(12.dp).testTag("wiki-doc-review"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("⚠", style = WikiType.subtext, color = amber)
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold, color = amber)) { append(WikiDocCopy.needsReview) }
                append(" · ")
                append(WikiDocLogic.needsReviewText(doc))
            }, style = WikiType.subtext)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                WikiDocLogic.legend(doc).forEach { item ->
                    Row(Modifier.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        WikiDocMarkLabel(item.mark)
                        Text(WikiArticleCopy.count(item.count), style = WikiType.label, color = WikiPalette.secondary)
                    }
                }
                Text(WikiDocCopy.nextMarked, style = WikiType.label, color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable(role = Role.Button, onClick = nextMarked).heightIn(min = 48.dp)
                        .wrapContentHeight(Alignment.CenterVertically).padding(horizontal = 4.dp).testTag("wiki-doc-next-marked"))
            }
        }
    }
}

/** The reader and scope (mock 24 ①): the question, then the three fields folded into one row on a phone. */
@Composable
private fun DocScope(doc: WikiDoc, open: Boolean, toggle: () -> Unit, openDoc: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(12.dp)).padding(12.dp).animateContentSize()
        .testTag("wiki-doc-scope"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(WikiDocCopy.question, style = WikiType.label, color = WikiPalette.secondary)
        Text(doc.question ?: "", style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold))
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = toggle).heightIn(min = 48.dp).testTag("wiki-doc-scope-toggle"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(WikiDocCopy.scopeFolded, style = WikiType.subtext, color = MaterialTheme.colorScheme.onSurface)
            Text(WikiDocLogic.scopeCounts(doc), Modifier.weight(1f), style = WikiType.label, color = WikiPalette.secondary)
            Icon(painterResource(R.drawable.ic_chevron_down), null, Modifier.size(14.dp).rotate(if (open) 180f else 0f), tint = WikiPalette.secondary)
        }
        if (open) {
            DocScopeField(WikiDocCopy.writtenFor, doc.audience.orEmpty())
            DocScopeField(WikiDocCopy.covers, doc.scopeIn.orEmpty())
            val out = doc.scopeOut.orEmpty()
            if (out.isNotEmpty()) {
                Text(WikiDocCopy.notCovered, style = WikiType.label, color = WikiPalette.secondary)
                out.forEach { line ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("•", style = WikiType.subtext)
                        Text(line.text, Modifier.weight(1f, fill = false), style = WikiType.subtext)
                        line.docs.orEmpty().forEach { target ->
                            Text(WikiDocLogic.scopeTarget(target), style = WikiType.subtext, color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.clickable(role = Role.Button) { openDoc(target.slug) }.heightIn(min = 48.dp)
                                    .wrapContentHeight(Alignment.CenterVertically).testTag("wiki-doc-scope-target:${target.slug}"))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DocScopeField(title: String, lines: List<String>) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(title, style = WikiType.label, color = WikiPalette.secondary)
        lines.forEach { line ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("•", style = WikiType.subtext)
                Text(line, style = WikiType.subtext)
            }
        }
    }
}

// MARK: the text

/** `1 会话运行模型与长连接：总览`, with Rewrite pending beside a section a withdrawal left waiting. */
@Composable
private fun DocSectionHeading(section: WikiDocSection) {
    val style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold)
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() }
        .testTag("wiki-doc-section:${section.key}"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${section.number ?: 0}", Modifier.alignByBaseline(), style = style, color = WikiPalette.secondary)
        Text(section.title, Modifier.weight(1f, fill = false).alignByBaseline(), style = style)
        if (section.stale == true) Row(Modifier.alignByBaseline().background(WikiPalette.secondary.copy(alpha = 0.12f), CircleShape)
            .padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(painterResource(R.drawable.ic_refresh), null, Modifier.size(10.dp), tint = WikiPalette.secondary)
            Text(WikiDocCopy.rewritePending, style = WikiType.meta.copy(fontWeight = FontWeight.Medium), color = WikiPalette.secondary)
        }
    }
}

/** A block of a section: a heading, code, a list item, or a paragraph of sentences. */
@Composable
private fun DocBlockView(row: DocRow.Block, notes: Map<Int, WikiDocFootnote>, openNote: Int?, onNote: (Int) -> Unit, onMark: (WikiDocOpenMark) -> Unit) {
    val block = row.block
    val tag = "wiki-doc-block:${row.section.key}.${row.index}"
    when (block.kind) {
        "heading" -> Text(block.text ?: "", Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp)
            .semantics { heading() }.testTag(tag), style = MaterialTheme.typography.titleMedium)
        "code" -> Box(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(8.dp)).horizontalScroll(rememberScrollState())
            .testTag(tag)) {
            Text(block.text ?: "", Modifier.padding(10.dp), style = WikiType.mono, softWrap = false)
        }
        "item" -> Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("•", Modifier.alignByBaseline(), style = WikiType.prose)
            DocParagraph(row, notes, openNote, onNote, onMark, 5, Modifier.weight(1f).alignByBaseline().testTag(tag))
        }
        else -> DocParagraph(row, notes, openNote, onNote, onMark, 6, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag(tag))
    }
}

/** One block's sentences as one paragraph: each sentence's words, its mark after it when it wears one — a link that
 * opens the mark's bubble — and its footnote numbers, superscript links that open their cards. A footnote that did
 * not check is red; the sentences of the footnote that is open are tinted. */
@Composable
private fun DocParagraph(row: DocRow.Block, notes: Map<Int, WikiDocFootnote>, openNote: Int?, onNote: (Int) -> Unit,
    onMark: (WikiDocOpenMark) -> Unit, spacing: Int, modifier: Modifier) {
    val accent = MaterialTheme.colorScheme.primary
    val red = MaterialTheme.colorScheme.error
    val secondary = WikiPalette.secondary
    val noteStyle = wikiNoteStyle(accent)
    val failedStyle = wikiNoteStyle(red)
    val markColors = WikiDocLogic.Mark.entries.associateWith { wikiMarkColor(it) }
    val metaSize = WikiType.meta.fontSize
    // Compose underlines in the text's own colour: a not-verified sentence's red line is drawn from the layout instead.
    val underlined = ArrayList<IntRange>()
    val text = buildAnnotatedString {
        row.block.sentences.orEmpty().forEachIndexed { s, sentence ->
            val mark = WikiDocLogic.mark(sentence)
            val start = length
            appendWikiSegments(sentence.text)
            val end = length
            when (mark) {
                WikiDocLogic.Mark.UNSOURCED -> addStyle(SpanStyle(background = systemOrange.copy(alpha = 0.14f)), start, end)
                WikiDocLogic.Mark.UNVERIFIED -> if (end > start) underlined += start until end
                WikiDocLogic.Mark.WITHDRAWN -> addStyle(SpanStyle(color = secondary, textDecoration = TextDecoration.LineThrough), start, end)
                null -> Unit
            }
            if (openNote != null && sentence.notes.orEmpty().contains(openNote)) addStyle(SpanStyle(background = accent.copy(alpha = 0.14f)), start, end)
            sentence.notes.orEmpty().forEach { n ->
                val failed = notes[n]?.let { it.verdict != "verified" } == true
                withLink(LinkAnnotation.Clickable("note:$n", TextLinkStyles(if (failed) failedStyle else noteStyle)) { onNote(n) }) {
                    append(WikiDocCopy.noteLabel(n))
                }
            }
            if (mark != null) {
                val color = markColors.getValue(mark)
                val at = WikiDocOpenMark(row.section.key, row.index, s)
                append(" ")
                withLink(LinkAnnotation.Clickable("mark:${at.id}", TextLinkStyles(SpanStyle(color = color, background = color.copy(alpha = 0.14f),
                    fontSize = metaSize, fontWeight = FontWeight.SemiBold))) { onMark(at) }) {
                    append(" ${mark.label} ")
                }
            }
            append(" ")
        }
    }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    Text(text, modifier.drawBehind { layout?.let { result -> underlined.forEach { underline(result, it, red) } } },
        style = wikiSpaced(WikiType.prose, spacing), onTextLayout = { layout = it })
}

/** A red line under a range of laid-out text, line by line. */
private fun DrawScope.underline(layout: TextLayoutResult, range: IntRange, color: Color) {
    if (range.first >= layout.layoutInput.text.length) return
    val last = minOf(range.last, layout.layoutInput.text.length - 1)
    val firstLine = layout.getLineForOffset(range.first)
    val lastLine = layout.getLineForOffset(last)
    for (line in firstLine..lastLine) {
        val left = if (line == firstLine) layout.getBoundingBox(range.first).left else layout.getLineLeft(line)
        val right = if (line == lastLine) layout.getBoundingBox(last).right else layout.getLineRight(line)
        val y = layout.getLineBaseline(line) + 2.dp.toPx()
        drawLine(color, Offset(left, y), Offset(right, y), strokeWidth = 1.dp.toPx())
    }
}

// MARK: the footnotes and the entries

/** `9.  Code  src/…/realtime.service.ts · RealtimeService.waitForInbox  ✓` over its words and what they came through. */
@Composable
private fun DocFootnoteRow(note: WikiDocFootnote, entry: WikiDocViaEntry?, open: () -> Unit) {
    val checked = note.verdict == "verified"
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 8.dp)
        .testTag("wiki-doc-footnote:${note.n}"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${note.n}.", Modifier.widthIn(min = 26.dp).alignByBaseline(), style = WikiType.subtext.copy(fontFeatureSettings = "tnum"),
            color = WikiPalette.secondary)
        Column(Modifier.weight(1f).alignByBaseline(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val tint = if (opensAtASessionRecord(note.kind)) MaterialTheme.colorScheme.primary else WikiPalette.secondary
                Text(WikiDocCopy.footnoteKind(note.kind), style = WikiType.meta.copy(fontWeight = FontWeight.Medium), color = tint,
                    modifier = Modifier.background(tint.copy(alpha = 0.12f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
                Text(WikiDocLogic.footnoteWhere(note), Modifier.weight(1f), style = if (WikiDocLogic.isRepo(note)) WikiType.mono else WikiType.subtext,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(WikiDocCopy.verdictList(note.verdict), style = WikiType.label, maxLines = 1,
                    color = if (checked) LocalOrbitColors.current.success else MaterialTheme.colorScheme.error)
            }
            Text(note.quote?.let(WikiDocLogic::quoted) ?: WikiDocCopy.noQuoteGiven, style = WikiType.subtext, color = WikiPalette.secondary,
                maxLines = 1, overflow = TextOverflow.Ellipsis, textDecoration = if (note.verdict == "not_found") TextDecoration.LineThrough else null)
            if (entry != null) Text("via ${entry.title}${WikiDocLogic.viaEntryStatus(entry)?.let { " · $it" } ?: ""}", style = WikiType.meta,
                color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** An entry: its title and the footnotes it carried, its mark, and its summary — or, for one that left the wiki, what
 * became of it and of its sentences. */
@Composable
private fun DocEntryRow(entry: WikiDocViaEntry, doc: WikiDoc, summaries: Map<String, String>, open: () -> Unit) {
    val gone = entry.status == "rejected" || entry.status == "retired" || entry.status == "superseded"
    val line = if (gone) WikiDocLogic.viaEntryNote(entry, doc) else summaries[wikiKey(entry.id)]
    Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 8.dp)
        .testTag("wiki-doc-entry:${entry.id}"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(entry.title, Modifier.weight(1f, fill = false), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textDecoration = if (gone) TextDecoration.LineThrough else null,
                    color = if (gone) WikiPalette.secondary else MaterialTheme.colorScheme.onSurface)
                Text(entry.notes.orEmpty().joinToString("") { WikiDocCopy.noteLabel(it) }, style = WikiType.meta, color = MaterialTheme.colorScheme.primary)
            }
            if (gone) WikiBadge(WikiCopy.statusLabel(entry.status), WikiTone.MUTED)
            else wikiKnownTrust(entry.trust)?.let { WikiBadge(WikiCopy.trustLabel(it), WikiLogic.trustTone(it)) }
        }
        if (!line.isNullOrEmpty()) Text(line, style = WikiType.subtext, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** OrbitKit `WikiDocFootnoteKind.opensAtASessionRecord`: a turn, an event or a tool call. */
private fun opensAtASessionRecord(kind: String) = kind == "turn" || kind == "event" || kind == "tool_call"

/** A mark's colour (iOS `WikiDocMarkLabel.color`): No source amber, Not verified red, Withdrawn grey. */
@Composable
internal fun wikiMarkColor(mark: WikiDocLogic.Mark): Color = when (mark) {
    WikiDocLogic.Mark.UNSOURCED -> WikiPalette.amber
    WikiDocLogic.Mark.UNVERIFIED -> MaterialTheme.colorScheme.error
    WikiDocLogic.Mark.WITHDRAWN -> WikiPalette.secondary
}

/** A mark's label (iOS `WikiDocMarkLabel`): No source (amber), Not verified (red), Withdrawn (grey). */
@Composable
internal fun WikiDocMarkLabel(mark: WikiDocLogic.Mark) {
    val color = wikiMarkColor(mark)
    Text(mark.label, style = WikiType.meta.copy(fontWeight = FontWeight.SemiBold), color = color,
        modifier = Modifier.background(color.copy(alpha = 0.14f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
}

/** What a marked sentence's mark means (iOS `WikiDocMarkBubble`, mock 24 ②): the web's hover note, as a sheet. */
@Composable
internal fun WikiDocMarkBubble(note: WikiDocLogic.MarkNote, openFootnote: (Int) -> Unit, openEntry: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(buildAnnotatedString {
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(note.title) }
            append(" ")
            append(note.text)
        }, Modifier.testTag("wiki-doc-mark-note"), style = WikiType.subtext)
        note.see?.let { see ->
            TextButton(onClick = { openFootnote(see) }, modifier = Modifier.testTag("wiki-doc-mark-see")) { Text(WikiDocCopy.seeFootnote(see), style = WikiType.subtext) }
        }
        note.entryId?.let { id ->
            TextButton(onClick = { openEntry(id) }, modifier = Modifier.testTag("wiki-doc-mark-entry")) { Text(WikiDocCopy.openTheEntry, style = WikiType.subtext) }
        }
        Spacer(Modifier.height(8.dp))
    }
}

/** A footnote's card as a sheet (iOS `WikiDocFootnoteSheet`, mock 24 ③④): its number, the kind of original and whose
 * words, whether the quote checked; the words, or the lines with the quoted one lit; what went wrong; where the
 * original is; the entry it came through as one row; and one button, which opens the original — `WikiDocLogic.CardPart`'s
 * order. */
@Composable
internal fun WikiDocFootnoteSheet(footnote: WikiDocFootnote, entry: WikiDocViaEntry?, github: String?,
    openSource: (WikiDocLogic.OpenTarget) -> Unit, openEntry: (String) -> Unit) {
    val green = LocalOrbitColors.current.success
    val red = MaterialTheme.colorScheme.error
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        WikiDocLogic.CardPart.entries.forEach { part ->
            when (part) {
                WikiDocLogic.CardPart.HEAD -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(WikiDocCopy.noteLabel(footnote.n), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold, fontFeatureSettings = "tnum"),
                        color = MaterialTheme.colorScheme.primary)
                    Text(wikiFootnoteGlyph(footnote.kind), style = WikiType.label, color = WikiPalette.secondary)
                    Text(WikiDocCopy.footnoteKind(footnote.kind), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold))
                    Row(Modifier.weight(1f)) {
                        WikiDocLogic.subLabel(footnote)?.let { Text("· $it", style = WikiType.label, color = WikiPalette.secondary, maxLines = 1,
                            overflow = TextOverflow.Ellipsis) }
                    }
                    Text(WikiDocCopy.verdictCard(footnote.verdict), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold),
                        color = if (footnote.verdict == "verified") green else red)
                }
                WikiDocLogic.CardPart.QUOTE -> {
                    val excerpt = if (footnote.kind != "design_doc" && WikiDocLogic.isRepo(footnote) && footnote.excerpt != null)
                        WikiDocLogic.excerptLines(footnote, WikiDocCopy.excerptLinesPhone) else null
                    val quote = footnote.quote
                    if (excerpt != null) Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f),
                        RoundedCornerShape(10.dp)).testTag("wiki-doc-excerpt")) {
                        Column(Modifier.horizontalScroll(rememberScrollState()).padding(10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            excerpt.first.forEach { line ->
                                Row(Modifier.background(if (line.quoted) green.copy(alpha = 0.12f) else Color.Transparent).padding(vertical = 1.dp),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                    Text("${line.n}", Modifier.widthIn(min = 30.dp), style = WikiType.mono, textAlign = TextAlign.End, maxLines = 1,
                                        color = if (line.quoted) green else WikiPalette.secondary)
                                    Text(line.text, style = WikiType.mono, maxLines = 1, softWrap = false)
                                }
                            }
                        }
                        if (excerpt.second > 0) Text(WikiDocCopy.moreLines(excerpt.second), Modifier.padding(start = 10.dp, end = 10.dp, bottom = 10.dp),
                            style = WikiType.mono, color = WikiPalette.secondary)
                    } else if (quote != null) Text(WikiDocLogic.quoted(quote), Modifier.fillMaxWidth()
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(10.dp)).padding(12.dp),
                        style = WikiType.prose, textDecoration = if (footnote.verdict == "not_found") TextDecoration.LineThrough else null)
                }
                WikiDocLogic.CardPart.PROBLEM -> WikiDocLogic.footnoteProblem(footnote)?.let { Text(it, style = WikiType.subtext, color = red) }
                WikiDocLogic.CardPart.PLACE -> Text(WikiDocLogic.footnotePlace(footnote), style = if (WikiDocLogic.isRepo(footnote)) WikiType.mono else WikiType.subtext,
                    color = WikiPalette.secondary)
                WikiDocLogic.CardPart.VIA -> if (entry != null) Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { openEntry(entry.id) }
                    .heightIn(min = 48.dp).testTag("wiki-doc-via-entry"), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(WikiDocCopy.viaEntry, style = WikiType.label, color = WikiPalette.secondary)
                    Text(wikiKindGlyph(entry.kind), style = WikiType.label, color = WikiPalette.secondary)
                    Text(entry.title, Modifier.weight(1f), style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold), maxLines = 1,
                        overflow = TextOverflow.Ellipsis)
                    wikiKnownTrust(entry.trust)?.let { WikiBadge(WikiCopy.trustLabel(it), WikiLogic.trustTone(it)) }
                }
                WikiDocLogic.CardPart.OPEN -> WikiDocLogic.footnoteOpen(footnote, github)?.let { open ->
                    // The one button opens the original, never the entry: the entry is the Via entry row above it.
                    Button(onClick = { openSource(open.target) }, modifier = Modifier.padding(top = 4.dp).fillMaxWidth().testTag("wiki-doc-source-open")) {
                        Text(open.label)
                    }
                }
            }
        }
        Spacer(Modifier.height(8.dp))
    }
}

/** The kind's glyph (iOS `WikiDocFootnoteSheet.glyph`): a page for a design doc or a contract, brackets for code, a
 * bubble for a session, a comment's bubble for a task comment. */
internal fun wikiFootnoteGlyph(kind: String?) = when (kind) {
    "design_doc", "contract" -> "📄"; "code" -> "</>"; "turn", "event", "tool_call" -> "💬"; "task_comment" -> "🗨"; else -> "▤"
}

// MARK: - Browse by category, by document

/** Browse by document (iOS `WikiDocsBrowsePage`, mock 28 ①): the plan's categories — what each answers — its documents
 * with the reader's question and their state, and each document's sections, one document open at a time. */
@Composable
internal fun WikiDocsBrowsePage(directory: WikiDocsDirectory, actions: WikiDocActions = WikiDocActions(), openSection: (String, String) -> Unit = { _, _ -> }) {
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    var all by rememberSaveable(stateSaver = wikiStringSetSaver) { mutableStateOf(emptySet<String>()) }
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-browse-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "head") { WikiReadingTitle(WikiArticleCopy.browse, WikiDocLogic.browseSummary(directory).joinToString(" · ")) }
        directory.categories.filter { it.docs.orEmpty().isNotEmpty() }.forEachIndexed { c, category ->
            item(key = "category:$c") { WikiCategoryLine("${category.number ?: 0} ${category.title}", WikiDocLogic.categoryLine(category)) }
            category.question?.takeIf { it.isNotEmpty() }?.let { question ->
                item(key = "question:$c") {
                    Text(question, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp), style = WikiType.subtext, color = WikiPalette.secondary)
                }
            }
            category.docs.orEmpty().forEachIndexed { d, doc ->
                val expanded = open == doc.slug
                item(key = "doc:$c:$d") { BrowseDocRow(doc, expanded, actions.openDoc) { open = if (expanded) null else doc.slug } }
                if (expanded) {
                    val sections = doc.sections.orEmpty()
                    val shown = if (doc.slug in all) sections else sections.take(WikiDocCopy.browseSectionsShownPhone)
                    shown.forEachIndexed { s, section ->
                        item(key = "section:$c:$d:$s") {
                            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { openSection(doc.slug, section.key) }.heightIn(min = 48.dp)
                                .padding(start = 32.dp, end = 16.dp).testTag("wiki-browse-section:${doc.slug}:${section.key}"),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text("${section.number ?: 0}", style = WikiType.prose, color = WikiPalette.secondary)
                                Text(section.title, style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    color = if (section.written == false) WikiPalette.secondary else MaterialTheme.colorScheme.onSurface)
                            }
                        }
                    }
                    if (sections.size > shown.size) item(key = "sections-more:$c:$d") {
                        WikiReadingMore(WikiDocCopy.moreSections(sections.size - shown.size), "wiki-browse-sections-more:${doc.slug}", indent = true) {
                            all = all + doc.slug
                        }
                    }
                }
            }
        }
    }
}

/** A document's row: its number and title — a link — its sections' count and state, its chevron, and its question. */
@Composable
private fun BrowseDocRow(doc: WikiDocsDirectory.Doc, expanded: Boolean, openDoc: (String) -> Unit, toggle: () -> Unit) {
    val line = WikiDocLogic.docLine(doc)
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.weight(1f)) {
                Row(Modifier.clickable(role = Role.Button) { openDoc(doc.slug) }.heightIn(min = 48.dp).testTag("wiki-browse-doc:${doc.slug}"),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(doc.number ?: "", style = WikiType.subtext.copy(fontFeatureSettings = "tnum"), color = WikiPalette.secondary)
                    Text(doc.title, style = WikiType.prose, color = MaterialTheme.colorScheme.primary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            Text(line.first, style = WikiType.label, color = WikiPalette.secondary)
            line.second?.let { state ->
                Text(state.text, style = WikiType.label,
                    color = if (state == WikiDocLogic.DocState.NEEDS_REVIEW) WikiPalette.amber else WikiPalette.secondary)
            }
            if (doc.sections.orEmpty().isNotEmpty()) IconButton(onClick = toggle, modifier = Modifier.testTag("wiki-browse-doc-toggle:${doc.slug}")) {
                Icon(painterResource(if (expanded) R.drawable.ic_chevron_down else R.drawable.ic_chevron_forward), doc.title, Modifier.size(14.dp),
                    tint = WikiPalette.secondary)
            } else Spacer(Modifier.width(12.dp))
        }
        val question = doc.question
        if (!question.isNullOrEmpty()) Text(question, Modifier.padding(end = 12.dp), style = WikiType.subtext, color = WikiPalette.secondary,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// MARK: - the A–Z index, by document

/** Every document and every section title no other document shares, under its letter (iOS `WikiDocsIndexPage`, mock
 * 28 ②): a document in bold with its number and category, a section with where it is — and the section index down the
 * side. */
@Composable
internal fun WikiDocsIndexPage(items: List<WikiDocsIndex.Item>, actions: WikiDocActions = WikiDocActions(), openSection: (String, String) -> Unit = { _, _ -> }) {
    val groups = remember(items) { WikiDocLogic.indexGroups(items) }
    // The list's row of each letter: the head, then each group's letter and rows.
    val rows = remember(groups) {
        var at = 1
        groups.associate { group -> group.letter to at.also { at += 1 + group.items.size } }
    }
    WikiIndexedList(groups.map { it.letter }, { rows[it] }) {
        item(key = "head") { WikiReadingTitle(WikiArticleCopy.azIndex, WikiDocLogic.indexSummary(items)) }
        groups.forEach { group ->
            item(key = "letter:${group.letter}") { WikiLetterRow(group.letter) }
            group.items.forEachIndexed { i, item ->
                item(key = "item:${group.letter}:$i") {
                    Column(Modifier.fillMaxWidth().clickable(role = Role.Button) {
                        val key = item.sectionKey
                        if (key != null && item.kind == "section") openSection(item.docSlug, key) else actions.openDoc(item.docSlug)
                    }.heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-index-entry:${item.docSlug}:${item.sectionKey ?: ""}"),
                        verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(item.title, style = WikiType.prose.copy(fontWeight = if (item.kind == "doc") FontWeight.SemiBold else FontWeight.Normal),
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(WikiDocLogic.indexMeta(item), style = WikiType.subtext, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
