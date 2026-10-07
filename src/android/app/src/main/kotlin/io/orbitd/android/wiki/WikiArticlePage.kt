@file:OptIn(ExperimentalMaterial3Api::class)

package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.BaselineShift
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import kotlinx.coroutines.launch

// The Wiki's articles on a phone (iOS `WikiArticleView.swift`): a topic's article with its footnotes and its entries,
// a topic with no article yet, Browse by category and the A–Z index — drawn from what the server said and nothing
// else. Each page takes its reads and a set of actions; where a press goes is decided by the screen that mounts it
// (`WikiArticles.kt`), and the bar's Contents button is bound there too. The Contents sheet is `WikiChrome.kt`'s.
// The blocks are the web phone's, block for block and in its order; every word and count is `WikiArticleCopy` /
// `WikiArticleLogic`.

/** Where a press on an article's page goes (iOS `WikiArticleActions`). */
internal class WikiArticleActions(
    val openEntry: (String) -> Unit = {},
    val openArticle: (String, Int) -> Unit = { _, _ -> },
    val openBrowse: () -> Unit = {},
    val openContents: () -> Unit = {},
    /** A footnote's card opened: the screen reads the entry, for what backs it and its anchor. */
    val readEntry: (String) -> Unit = {},
)

/** A footnote number the reader opened, and the sentence it hangs off (iOS `WikiOpenNote`). */
internal data class WikiOpenNote(val n: Int, val block: Int, val sentence: Int) {
    val id: String get() = "$block.$sentence.$n"
}

private val openNoteSaver = Saver<WikiOpenNote?, IntArray>(
    save = { note -> note?.let { intArrayOf(it.n, it.block, it.sentence) } },
    restore = { WikiOpenNote(it[0], it[1], it[2]) })

/** The rows a reader opened on a page, kept with the page across Back and recreation. */
internal val wikiStringSetSaver = Saver<Set<String>, ArrayList<String>>(save = { ArrayList(it) }, restore = { it.toSet() })

/** How many rows a kind group shows before `Show N more` — the topic page's number. */
private const val SHOWN_PER_GROUP = 4

/** A trust this build has a word for — iOS's `trust != .unknown`. */
internal fun wikiKnownTrust(trust: String?): String? = trust?.takeIf { WikiCopy.trustLabel(it).isNotEmpty() }

/** iOS's `.lineSpacing(n)`: the type ramp's line height with `n` more between lines. */
internal fun wikiSpaced(style: TextStyle, extra: Int): TextStyle =
    if (style.lineHeight.isSp) style.copy(lineHeight = (style.lineHeight.value + extra).sp) else style

/** A sentence's runs (`WikiArticleLogic.segments`): inline code in a monospaced face, strong words in bold. */
internal fun AnnotatedString.Builder.appendWikiSegments(text: String) {
    WikiArticleLogic.segments(text).forEach { segment ->
        when (segment.kind) {
            WikiArticleLogic.Segment.Kind.CODE -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(segment.text) }
            WikiArticleLogic.Segment.Kind.STRONG -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(segment.text) }
            WikiArticleLogic.Segment.Kind.TEXT -> append(segment.text)
        }
    }
}

/** A footnote number in the text: small, raised and tinted — iOS's `orbitMeta` at a baseline offset, as a link. */
@Composable
internal fun wikiNoteStyle(color: Color) = SpanStyle(color = color, fontSize = WikiType.meta.fontSize, baselineShift = BaselineShift.Superscript)

// MARK: - one article

/** One of a topic's articles (iOS `WikiArticlePage`, mock 14): the crumb, the title, the tags, when and from what it
 * was written, the text with a superscript footnote after every sentence, the footnotes, then the topic's entries by
 * kind — `WikiArticleLogic.Section`'s order, which is the web phone's. A footnote opens the entry's card as a sheet. */
@Composable
internal fun WikiArticlePage(article: WikiArticle, entries: List<WikiEntry>?, detail: (String) -> WikiEntryDetail? = { null },
    actions: WikiArticleActions = WikiArticleActions()) {
    var open by rememberSaveable(stateSaver = openNoteSaver) { mutableStateOf<WikiOpenNote?>(null) }
    var expanded by rememberSaveable(stateSaver = wikiStringSetSaver) { mutableStateOf(emptySet<String>()) }
    val notes = remember(article.footnotes) { buildMap { article.footnotes.forEach { putIfAbsent(it.n, it) } } }
    val held = entries.orEmpty()
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-article-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
        WikiArticleLogic.Section.entries.forEach { section ->
            when (section) {
                WikiArticleLogic.Section.CRUMB -> item(key = "crumb") { ArticleCrumb(article, actions) }
                WikiArticleLogic.Section.TITLE -> item(key = "title") {
                    WikiPageTitle(article.title ?: article.topic.title ?: article.topic.slug, "wiki-article-title")
                }
                WikiArticleLogic.Section.TAGS -> item(key = "tags") {
                    WikiTagFlow(articleTags(article, entries), Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                }
                WikiArticleLogic.Section.UPDATED -> item(key = "updated") {
                    WikiReadingNote(WikiArticleCopy.updated(article.generatedAt, article.ref, article.entryCount ?: 0))
                }
                WikiArticleLogic.Section.BODY -> article.blocks.forEachIndexed { index, block ->
                    item(key = "block:$index") { ArticleBlock(block, index, open) { open = it } }
                }
                WikiArticleLogic.Section.FOOTNOTES -> {
                    item(key = "footnotes") { WikiReadingHeader(WikiArticleCopy.footnotes, WikiArticleCopy.entriesCited(article.footnotes.size)) }
                    article.footnotes.forEachIndexed { i, footnote ->
                        item(key = "footnote:$i") { ArticleFootnoteRow(footnote, actions.openEntry) }
                    }
                }
                WikiArticleLogic.Section.ENTRIES -> {
                    item(key = "entries") { WikiReadingHeader(WikiArticleCopy.entries, WikiArticleCopy.entriesHint(article.entryIds?.size ?: held.size)) }
                    if (entries != null && held.isEmpty()) item(key = "entries-none") { WikiReadingNote(WikiArticleCopy.noTopicEntries) }
                    WikiArticleLogic.entryGroups(held, article.footnotes.map { it.entryId }).forEachIndexed { g, group ->
                        articleEntryGroup(g, group, group.title in expanded, actions.openEntry) { all ->
                            expanded = if (all) expanded - group.title else expanded + group.title
                        }
                    }
                }
            }
        }
    }
    val footnote = open?.let { notes[it.n] }
    if (footnote != null) ModalBottomSheet(onDismissRequest = { open = null }, modifier = Modifier.testTag("wiki-footnote-card")) {
        // The card reads the entry when it opens, for what backs it and where its anchor was last checked.
        LaunchedEffect(footnote.n) { footnote.entry?.let { actions.readEntry(it.id) } }
        WikiFootnoteCard(footnote, footnote.entry?.let { detail(it.id) }) { id ->
            open = null
            actions.openEntry(id)
        }
    }
}

/** `Wiki · Clients & UI · UI 设计`: the topic's own article is one press away from a subtopic's. */
@Composable
private fun ArticleCrumb(article: WikiArticle, actions: WikiArticleActions) {
    val parts = listOfNotNull(WikiCopy.title, article.topic.categoryTitle, article.topic.title ?: article.topic.slug)
    Text(parts.joinToString(" · "), maxLines = 1, overflow = TextOverflow.Ellipsis, style = WikiType.label,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.fillMaxWidth().clickable(enabled = article.part > 0, role = Role.Button) { actions.openArticle(article.topic.slug, 0) }
            .heightIn(min = 48.dp).padding(horizontal = 16.dp).wrapContentHeight(Alignment.CenterVertically).testTag("wiki-article-crumb"))
}

private fun articleTags(article: WikiArticle, entries: List<WikiEntry>?): List<WikiTag> = buildList {
    article.topic.categoryTitle?.let { add(WikiTag(it, category = true)) }
    add(WikiTag(article.topic.title ?: article.topic.slug, category = false))
    WikiArticleLogic.kindTags(entries.orEmpty().map { it.kind }).forEach { add(WikiTag(it, category = false)) }
}

/** One block: its heading, then its sentences as one paragraph. */
@Composable
private fun ArticleBlock(block: WikiArticleBlock, index: Int, open: WikiOpenNote?, openNote: (WikiOpenNote) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val title = block.heading
        if (!title.isNullOrEmpty()) Text(title, Modifier.padding(top = 10.dp).semantics { heading() },
            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
        Text(articleParagraph(block, index, open, openNote), Modifier.fillMaxWidth().testTag("wiki-article-block:$index"),
            style = wikiSpaced(WikiType.prose, 6))
    }
}

/** One block's sentences as one paragraph, each followed by its footnote numbers — superscript links that open the
 * card — and the sentence whose number is open tinted. */
@Composable
private fun articleParagraph(block: WikiArticleBlock, index: Int, open: WikiOpenNote?, openNote: (WikiOpenNote) -> Unit): AnnotatedString {
    val accent = MaterialTheme.colorScheme.primary
    val noteStyle = wikiNoteStyle(accent)
    return buildAnnotatedString {
        block.sentences.forEachIndexed { s, sentence ->
            val start = length
            appendWikiSegments(sentence.text)
            if (open?.block == index && open.sentence == s) addStyle(SpanStyle(background = accent.copy(alpha = 0.14f)), start, length)
            sentence.notes.forEach { n ->
                withLink(LinkAnnotation.Clickable("note:$n", TextLinkStyles(noteStyle)) { openNote(WikiOpenNote(n, index, s)) }) {
                    append(WikiArticleCopy.noteLabel(n))
                }
            }
            append(" ")
        }
    }
}

/** `1.  改 UI 先给效果图…` over `Convention · Confirmed`: the footnote list's row, which opens the entry. */
@Composable
private fun ArticleFootnoteRow(footnote: WikiArticleFootnote, openEntry: (String) -> Unit) {
    val entry = footnote.entry
    Row(Modifier.fillMaxWidth().clickable(enabled = entry != null, role = Role.Button) { entry?.let { openEntry(it.id) } }
        .heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-footnote:${footnote.n}"),
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${footnote.n}.", Modifier.widthIn(min = 22.dp).alignByBaseline(), style = WikiType.subtext.copy(fontFeatureSettings = "tnum"),
            color = WikiPalette.secondary)
        Column(Modifier.weight(1f).alignByBaseline(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            if (entry != null) {
                Text(entry.title ?: entry.id, style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(WikiCopy.kindLabel(entry.kind) + " ·", style = WikiType.subtext, color = WikiPalette.secondary)
                    wikiKnownTrust(entry.trust)?.let { WikiBadge(WikiCopy.trustLabel(it), WikiLogic.trustTone(it)) }
                }
            } else Text(WikiArticleCopy.footnoteGone, style = WikiType.prose, color = WikiPalette.secondary)
        }
    }
}

/** One kind group: its heading, the rows it shows, and `Show N more` / `Show less`. */
private fun LazyListScope.articleEntryGroup(g: Int, group: WikiArticleLogic.EntryGroup, all: Boolean, openEntry: (String) -> Unit,
    toggle: (Boolean) -> Unit) {
    item(key = "group:$g") { WikiKindGroupHeader(group.title, group.entries.size, group.note) }
    (if (all) group.entries else group.entries.take(SHOWN_PER_GROUP)).forEachIndexed { i, entry ->
        item(key = "entry:$g:$i") { ArticleEntryRow(entry) { openEntry(entry.id) } }
    }
    if (group.entries.size > SHOWN_PER_GROUP) item(key = "group-more:$g") {
        WikiReadingMore(if (all) WikiArticleCopy.showLess else WikiArticleCopy.showMore(group.entries.size - SHOWN_PER_GROUP),
            "wiki-article-group-more:$g") { toggle(all) }
    }
}

/** An entry under the article: its title — struck through once agents no longer get it — its mark, and its summary. */
@Composable
private fun ArticleEntryRow(entry: WikiEntry, open: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).heightIn(min = 48.dp)
        .padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-article-entry:${entry.id}"), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(entry.displayTitle, Modifier.weight(1f), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis,
                textDecoration = if (entry.isEnded) TextDecoration.LineThrough else null,
                color = if (entry.isEnded) WikiPalette.secondary else MaterialTheme.colorScheme.onSurface)
            if (!entry.isEnded) wikiKnownTrust(entry.trust)?.let { WikiBadge(WikiCopy.trustLabel(it), WikiLogic.trustTone(it)) }
        }
        val summary = entry.summary
        if (!summary.isNullOrEmpty()) Text(summary, style = WikiType.subtext, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The entry a footnote names, as a card (iOS `WikiFootnoteCard`, mock 14 ②): its number, kind and mark, its title and
 * a few lines of its summary, what backs it and where its anchor was last checked — read when the card opens — and
 * Open entry across the bottom. */
@Composable
internal fun WikiFootnoteCard(footnote: WikiArticleFootnote, detail: WikiEntryDetail?, openEntry: (String) -> Unit) {
    val entry = footnote.entry
    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Text(WikiArticleCopy.noteLabel(footnote.n), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold, fontFeatureSettings = "tnum"),
                color = MaterialTheme.colorScheme.primary)
            if (entry != null) {
                Text(wikiKindGlyph(entry.kind), style = WikiType.label, color = WikiPalette.secondary)
                Text(WikiCopy.kindLabel(entry.kind), Modifier.weight(1f), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold),
                    color = WikiPalette.secondary)
                wikiKnownTrust(entry.trust)?.let { WikiBadge(WikiCopy.trustLabel(it), WikiLogic.trustTone(it)) }
            }
        }
        if (entry != null) {
            Text(entry.title ?: entry.id, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
            val summary = entry.summary
            if (!summary.isNullOrEmpty()) Text(summary, style = WikiType.subtext, color = WikiPalette.secondary, maxLines = 4, overflow = TextOverflow.Ellipsis)
            FootLine(detail)
            Button(onClick = { openEntry(entry.id) }, modifier = Modifier.padding(top = 8.dp).fillMaxWidth().testTag("wiki-footnote-card-open")) {
                Text(WikiArticleCopy.openEntry)
            }
        } else Text(WikiArticleCopy.footnoteGone, style = WikiType.subtext, color = WikiPalette.secondary)
        Spacer(Modifier.height(8.dp))
    }
}

/** `8 sources · 5 sessions · ✓ 1588c3b`, once the entry has been read. */
@Composable
private fun FootLine(detail: WikiEntryDetail?) {
    if (detail == null) return
    val counts = WikiArticleLogic.sourceCounts(detail.sources)
    val mark = WikiLogic.anchorMark(detail.entry.anchorState, detail.entry.anchorCheckedRef)
    Row(Modifier.testTag("wiki-footnote-card-backing"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(WikiArticleCopy.sourcesLine(counts.first, counts.second), style = WikiType.label, color = WikiPalette.secondary)
        if (mark != null) {
            Text("·", style = WikiType.label, color = WikiPalette.secondary)
            if (mark.tone == WikiTone.GREEN) Text("✓", style = WikiType.label, color = WikiPalette.secondary)
            Text(mark.word, style = WikiType.label, color = WikiPalette.color(mark.tone))
        }
    }
}

// MARK: - a topic with no article yet

/** A topic with no article yet (iOS `WikiTopicEntriesPage`): its entries by kind, and why there is no text over them. */
@Composable
internal fun WikiTopicEntriesPage(title: String, entries: List<WikiEntry>, actions: WikiArticleActions = WikiArticleActions()) {
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-topic-entries"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "title") { WikiPageTitle(title, "wiki-topic-title") }
        item(key = "note") { WikiReadingNote(WikiArticleCopy.noArticleYet) }
        WikiArticleLogic.entryGroups(entries, emptyList()).forEachIndexed { g, group ->
            item(key = "group:$g") { WikiBandHeader(group.title) }
            group.entries.forEachIndexed { i, entry ->
                item(key = "entry:$g:$i") {
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { actions.openEntry(entry.id) }.heightIn(min = 48.dp)
                        .padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-topic-entry:${entry.id}"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(entry.displayTitle, Modifier.weight(1f), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        wikiKnownTrust(entry.trust)?.let { WikiBadge(WikiCopy.trustLabel(it), WikiLogic.trustTone(it)) }
                    }
                }
            }
        }
    }
}

// MARK: - tags

/** One of an article's tags: its category (tinted), its topic, a kind's count (iOS `WikiTag`). */
internal data class WikiTag(val text: String, val category: Boolean)

/** The tags, wrapping onto as many lines as they take (iOS `WikiTagFlow` over `WikiFlowLayout` — Compose's `FlowRow`). */
@Composable
internal fun WikiTagFlow(tags: List<WikiTag>, modifier: Modifier = Modifier) {
    FlowRow(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        tags.forEach { tag ->
            val tint = if (tag.category) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface
            val wash = if (tag.category) MaterialTheme.colorScheme.primary else WikiPalette.secondary
            Text(tag.text, maxLines = 1, style = WikiType.label.copy(fontWeight = FontWeight.Medium), color = tint,
                modifier = Modifier.background(wash.copy(alpha = 0.12f), CircleShape).padding(horizontal = 10.dp, vertical = 3.dp))
        }
    }
}

// MARK: - Browse by category

/** Every category, its topics and each topic's subtopic articles (iOS `WikiBrowsePage`, mock 16 ①). A topic's name
 * opens its own article; its chevron opens the subtopic articles under it. */
@Composable
internal fun WikiBrowsePage(categories: List<WikiArticleLogic.BrowseCategory>, actions: WikiArticleActions = WikiArticleActions()) {
    var open by rememberSaveable(stateSaver = wikiStringSetSaver) { mutableStateOf(emptySet<String>()) }
    var all by rememberSaveable(stateSaver = wikiStringSetSaver) { mutableStateOf(emptySet<String>()) }
    val totals = WikiArticleLogic.browseTotals(categories)
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-browse-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
        item(key = "head") {
            WikiReadingTitle(WikiArticleCopy.browse, WikiArticleCopy.browseSummary(totals.articles, totals.topics, totals.entries))
        }
        if (totals.articles == 0) item(key = "none") { WikiReadingNote(WikiArticleCopy.noArticles) }
        categories.forEachIndexed { c, category ->
            item(key = "category:$c") {
                WikiCategoryLine(category.title, WikiArticleCopy.categorySummary(category.topics, category.articles, category.entries))
            }
            category.rows.forEachIndexed { r, row ->
                val expanded = row.slug in open
                item(key = "topic:$c:$r") {
                    BrowseTopicRow(row, expanded, actions.openArticle) { open = if (expanded) open - row.slug else open + row.slug }
                }
                if (expanded) {
                    val parts = if (row.slug in all) row.parts else row.parts.take(WikiArticleLogic.browseShown)
                    parts.forEachIndexed { p, part ->
                        item(key = "part:$c:$r:$p") {
                            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { actions.openArticle(row.slug, part.part) }.heightIn(min = 48.dp)
                                .padding(start = 32.dp, end = 16.dp).testTag("wiki-browse-part:${row.slug}:${part.part}"),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(part.title ?: "", Modifier.weight(1f), style = WikiType.prose, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(WikiArticleCopy.count(part.entryCount ?: 0), style = WikiType.label.copy(fontFeatureSettings = "tnum"),
                                    color = WikiPalette.secondary)
                            }
                        }
                    }
                    if (row.parts.size > parts.size) item(key = "more:$c:$r") {
                        WikiReadingMore(WikiArticleCopy.moreArticles(row.parts.size - parts.size), "wiki-browse-more:${row.slug}", indent = true) {
                            all = all + row.slug
                        }
                    }
                }
            }
        }
    }
}

/** A topic's row: its name — a link once it has an article — its counts, its chevron, and its description. */
@Composable
private fun BrowseTopicRow(row: WikiArticleLogic.BrowseTopic, expanded: Boolean, openArticle: (String, Int) -> Unit, toggle: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 2.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(row.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = WikiType.prose,
                    color = if (row.hasArticle) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f, fill = false).clickable(enabled = row.hasArticle, role = Role.Button) { openArticle(row.slug, 0) }
                        .heightIn(min = 48.dp).wrapContentHeight(Alignment.CenterVertically).testTag("wiki-browse-topic:${row.slug}"))
                if (row.hasArticle) Text(WikiArticleCopy.browseTopicLine(row.entries, row.articles), style = WikiType.label,
                    color = WikiPalette.secondary, maxLines = 1)
            }
            if (row.parts.isNotEmpty()) IconButton(onClick = toggle, modifier = Modifier.testTag("wiki-browse-topic-toggle:${row.slug}")) {
                Icon(painterResource(if (expanded) R.drawable.ic_chevron_down else R.drawable.ic_chevron_forward), row.title,
                    Modifier.size(14.dp), tint = WikiPalette.secondary)
            }
        }
        val description = row.description
        if (!description.isNullOrEmpty()) Text(description, Modifier.padding(end = 12.dp), style = WikiType.subtext, color = WikiPalette.secondary,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

// MARK: - the A–Z index

/** Every article by title under its letter (iOS `WikiIndexPage`, mock 16 ②): a Chinese title by its first character's
 * pinyin (`WikiArticleLogic.indexInitial`), with the section index down the side. */
@Composable
internal fun WikiIndexPage(groups: List<WikiArticleLogic.IndexGroup<WikiArticleIndex.Item>>, count: Int,
    actions: WikiArticleActions = WikiArticleActions()) {
    // The list's row of each letter: the head, the empty line when there is nothing, then each group's letter and rows.
    val rows = remember(groups, count) {
        var at = if (count == 0) 2 else 1
        groups.associate { group -> group.letter to at.also { at += 1 + group.items.size } }
    }
    WikiIndexedList(groups.map { it.letter }, { rows[it] }) {
        item(key = "head") { WikiReadingTitle(WikiArticleCopy.azIndex, WikiArticleCopy.indexSummary(count)) }
        if (count == 0) item(key = "none") { WikiReadingNote(WikiArticleCopy.noArticles) }
        groups.forEach { group ->
            item(key = "letter:${group.letter}") { WikiLetterRow(group.letter) }
            group.items.forEachIndexed { i, item ->
                item(key = "item:${group.letter}:$i") {
                    Column(Modifier.fillMaxWidth().clickable(role = Role.Button) { actions.openArticle(item.topic.slug, item.part) }.heightIn(min = 48.dp)
                        .padding(horizontal = 16.dp, vertical = 8.dp).testTag("wiki-index-item:${item.topic.slug}:${item.part}"),
                        verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(item.title ?: "", style = WikiType.prose.copy(fontWeight = if (item.part == 0) FontWeight.SemiBold else FontWeight.Normal),
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(WikiArticleLogic.indexMeta(item), style = WikiType.subtext, color = WikiPalette.secondary, maxLines = 1,
                            overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/** A list with iOS's section index down its side (`listSectionIndexVisibility(.visible)`): the rows, and a strip of the
 * letters the list has that jumps it to a letter's group. */
@Composable
internal fun WikiIndexedList(letters: List<String>, rowOf: (String) -> Int?, content: LazyListScope.() -> Unit) {
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    Row(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f).fillMaxHeight().testTag("wiki-index-list"), state = listState,
            contentPadding = PaddingValues(bottom = 24.dp), content = content)
        WikiLetterStrip(letters) { letter -> rowOf(letter)?.let { row -> scope.launch { listState.scrollToItem(row) } } }
    }
}

/** The section index (iOS 26's `sectionIndexLabel` per section): each letter a press that jumps to its group, and a
 * drag down the strip scrubbing through them. The letters are as small as iOS's, so all of A–Z fit; each is still its
 * own button for TalkBack. */
@Composable
private fun WikiLetterStrip(letters: List<String>, jump: (String) -> Unit) {
    if (letters.isEmpty()) return
    val currentJump by rememberUpdatedState(jump)
    BoxWithConstraints(Modifier.fillMaxHeight().width(28.dp).testTag("wiki-index-letters"), contentAlignment = Alignment.Center) {
        val rowHeight = minOf(20.dp, maxHeight / letters.size)
        var height by remember { mutableIntStateOf(0) }
        var last by remember { mutableStateOf<String?>(null) }
        fun scrub(y: Float) {
            if (height <= 0) return
            val letter = letters[(y / height * letters.size).toInt().coerceIn(0, letters.lastIndex)]
            if (letter != last) { last = letter; currentJump(letter) }
        }
        Column(Modifier.fillMaxWidth().onSizeChanged { height = it.height }.pointerInput(letters) {
            detectVerticalDragGestures(onDragStart = { scrub(it.y) }, onDragEnd = { last = null }, onDragCancel = { last = null }) { change, _ ->
                change.consume()
                scrub(change.position.y)
            }
        }, horizontalAlignment = Alignment.CenterHorizontally) {
            letters.forEach { letter ->
                Box(Modifier.fillMaxWidth().height(rowHeight).clickable(role = Role.Button) { jump(letter) }.testTag("wiki-index-letter:$letter"),
                    contentAlignment = Alignment.Center) {
                    Text(letter, style = WikiType.meta.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.primary, maxLines = 1)
                }
            }
        }
    }
}

// MARK: - the reading pages' shared rows

/** A page's title in the list, as iOS's `.font(.title.bold())` row. */
@Composable
internal fun WikiPageTitle(text: String, tag: String) {
    Text(text, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).semantics { heading() }.testTag(tag),
        style = MaterialTheme.typography.headlineLarge)
}

/** Browse's and the index's head: the large title, and the line under it. */
@Composable
internal fun WikiReadingTitle(title: String, line: String) {
    Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineLarge)
        Text(line, style = WikiType.label, color = WikiPalette.secondary)
    }
}

/** A line in the label face, grey: when a page was written, why a list is empty. */
@Composable
internal fun WikiReadingNote(text: String) {
    Text(text, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), style = WikiType.label, color = WikiPalette.secondary)
}

/** The footnotes' and the entries' heading: the title in bold and a hint beside it (iOS `header(_:hint:)`). */
@Composable
internal fun WikiReadingHeader(title: String, hint: String) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() },
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, Modifier.alignByBaseline(), style = WikiType.subtext.copy(fontWeight = FontWeight.Bold), color = MaterialTheme.colorScheme.onSurface)
        Text(hint, Modifier.alignByBaseline(), style = WikiType.label, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A kind group's heading: its title, how many it holds, and what it is. */
@Composable
internal fun WikiKindGroupHeader(title: String, count: Int, note: String) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 2.dp).semantics(mergeDescendants = true) { heading() },
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, Modifier.alignByBaseline(), style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold))
        Text("$count", Modifier.alignByBaseline(), style = WikiType.label.copy(fontWeight = FontWeight.SemiBold), color = WikiPalette.secondary)
        Text(note, Modifier.alignByBaseline(), style = WikiType.label, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A category's heading in Browse: its title in bold and its counts. */
@Composable
internal fun WikiCategoryLine(title: String, line: String) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 2.dp).semantics(mergeDescendants = true) { heading() },
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, Modifier.alignByBaseline(), style = WikiType.subtext.copy(fontWeight = FontWeight.Bold))
        Text(line, Modifier.alignByBaseline(), style = WikiType.label, color = WikiPalette.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A letter as its group's first row, on the grouped band's grey. */
@Composable
internal fun WikiLetterRow(letter: String) {
    Text(letter, Modifier.fillMaxWidth().background(WikiPalette.secondary.copy(alpha = 0.10f)).padding(horizontal = 16.dp, vertical = 8.dp)
        .semantics { heading() }, style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold))
}

/** `Show N more`, `Show less`, `N more`: a plain button in the list. */
@Composable
internal fun WikiReadingMore(label: String, tag: String, indent: Boolean = false, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.padding(start = if (indent) 20.dp else 4.dp).testTag(tag)) {
        Text(label, style = WikiType.subtext)
    }
}
