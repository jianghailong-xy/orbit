package io.orbitd.android.wiki

import android.icu.text.Collator
import android.icu.text.Transliterator
import android.icu.util.ULocale
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.*
import io.orbitd.android.text.MarkdownText
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

internal fun wikiIndexInitial(title: String): String {
    val first = title.trim().codePoints().findFirst().orElse(-1)
    if (first in 65..90 || first in 97..122) return first.toChar().uppercaseChar().toString()
    val han = first in 0x3400..0x4dbf || first in 0x4e00..0x9fff || first in 0xf900..0xfaff || first in 0x20000..0x2ffff
    if (!han) return "#"
    val latin = Transliterator.getInstance("Han-Latin; Latin-ASCII").transliterate(String(Character.toChars(first)))
    return latin.firstOrNull()?.uppercaseChar()?.takeIf { it in 'A'..'Z' }?.toString() ?: "#"
}

internal fun wikiIndexGroups(items: List<JsonObject>): List<Pair<String, List<JsonObject>>> {
    val collator = Collator.getInstance(ULocale("zh@collation=pinyin"))
    val sorted = items.sortedWith { a, b ->
        val compared = collator.compare(a.label(), b.label())
        if (compared != 0) compared else compareValuesBy(a, b, { it.text("docNumber") ?: it.obj("topic")?.text("slug") ?: "" }, { it.number("part") ?: 0 })
    }.groupBy { wikiIndexInitial(it.label()) }
    return (('A'..'Z').map(Char::toString) + "#").mapNotNull { letter -> sorted[letter]?.let { letter to it } }
}

@Composable internal fun WikiDirectory(ui: WikiUi) {
    WikiPageColumn {
        WikiHeading(if (ui.route.destination == Destination.WIKI_INDEX) "A–Z index" else "Browse by category")
        WikiContents(ui)
        val content = ui.page.content
        if (ui.route.destination == Destination.WIKI_INDEX) {
            val items = content.objects("items")
            if (items.isEmpty()) Text("Nothing to read yet.")
            wikiIndexGroups(items).forEach { (letter, rows) ->
                WikiHeading(letter)
                rows.forEach { item ->
                    WikiRow(item.label(), item.text("docTitle") ?: item.obj("topic")?.text("title"), tag = "wiki-index:${item.text("docSlug") ?: item.obj("topic")?.text("slug")}:${item.text("sectionKey") ?: item.number("part")}") {
                        if (content.obj("plan") != null) ui.go(Destination.WIKI_DOC, item.text("docSlug"), section = item.text("sectionKey"))
                        else ui.go(Destination.WIKI_ARTICLE, item.obj("topic")?.text("slug"), part = item.number("part") ?: 0)
                    }
                }
            }
        } else WikiDirectoryRows(content, ui) { destination, id, part, section -> ui.go(destination, id, part, section) }
    }
}

@Composable internal fun WikiDirectoryRows(content: JsonObject, ui: WikiUi, open: (Destination, String?, Int, String?) -> Unit) {
    val docs = content.obj("plan") != null
    val groups = content.objects("categories") + if (content.objects("uncategorized").isNotEmpty()) listOf(buildJsonObject {
        put("title", "Other"); put("topics", content["uncategorized"]!!)
    }) else emptyList()
    if (groups.isEmpty()) Text("Nothing to read yet.")
    groups.forEach { category ->
        WikiHeading(category.label())
        WikiWords(category.text("question"), ui)
        if (docs) category.objects("docs").forEach { doc ->
            WikiRow(listOfNotNull(doc.text("number"), doc.text("title")).joinToString(" "), if (!doc.flag("written")) "Not written yet" else doc.text("status")?.replace('_', ' '), "wiki-doc:${doc.text("slug")}") { open(Destination.WIKI_DOC, doc.text("slug"), 0, null) }
            doc.objects("sections").forEach { section -> WikiRow("  ${section.label()}", if (section.flag("stale")) "Needs updating" else null) { open(Destination.WIKI_DOC, doc.text("slug"), 0, section.text("key")) } }
        } else category.objects("topics").forEach { topic ->
            WikiRow(topic.label(), topic.text("description"), "wiki-article:${topic.text("slug")}:0") { open(Destination.WIKI_ARTICLE, topic.text("slug"), 0, null) }
            topic.objects("parts").forEach { part -> WikiRow("  ${part.label()}", "${part.number("entryCount") ?: 0} entries") { open(Destination.WIKI_ARTICLE, topic.text("slug"), part.number("part") ?: 0, null) } }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun WikiArticle(ui: WikiUi) {
    val article = ui.page.content
    var note by rememberSaveable { mutableStateOf<Int?>(null) }
    WikiPageColumn {
        WikiHeading(article.label())
        WikiContents(ui)
        Text(listOfNotNull(article.text("kind"), article.text("generatedAt"), article.text("model"), article.text("ref")).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
        if (article["blocks"] == null) Text("No article yet. These are the topic’s entries.")
        article.objects("blocks").forEach { block ->
            block.text("heading")?.let { WikiHeading(it) }
            val markdown = block.objects("sentences").joinToString(" ") { sentence -> sentence.text("text").orEmpty() + noteLinks(sentence) }
            MarkdownText(markdown, open = { raw -> if (raw.startsWith("wiki-note:")) note = raw.substringAfter(':').toIntOrNull() else ui.link(raw) })
        }
        article.obj("overview")?.let { part -> WikiRow("Overview · ${part.label()}") { ui.go(Destination.WIKI_ARTICLE, ui.route.id) } }
        article.objects("parts").filter { it.number("part") != ui.route.wikiPart }.forEach { part -> WikiRow(part.label()) { ui.go(Destination.WIKI_ARTICLE, ui.route.id, part = part.number("part") ?: 0) } }
        WikiHeading("Sources")
        article.objects("footnotes").forEach { footnote -> WikiRow("[${footnote.number("n")}] ${footnote.obj("entry")?.label() ?: "Entry unavailable"}") { note = footnote.number("n") } }
        WikiHeading("Entries")
        ui.page.rows.groupBy { it.text("kind") ?: "Other" }.forEach { (kind, entries) ->
            Text(kind.replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.titleMedium)
            entries.forEach { WikiEntryRow(it, ui) }
        }
    }
    val footnote = article.objects("footnotes").firstOrNull { it.number("n") == note }
    if (footnote != null) ModalBottomSheet(onDismissRequest = { note = null }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            WikiHeading(footnote.obj("entry")?.label() ?: "Entry unavailable")
            WikiWords(footnote.obj("entry")?.text("summary"), ui)
            Text("Written from revision ${footnote.number("revision") ?: "—"}")
            if (footnote.obj("entry") != null) TextButton(onClick = { note = null; ui.go(Destination.WIKI_ENTRY, footnote.text("entryId")) }) { Text("Open entry") }
        }
    }
}

private fun noteLinks(sentence: JsonObject) = (sentence["notes"] as? JsonArray).orEmpty().joinToString("") { value ->
    val n = (value as? JsonPrimitive)?.intOrNull
    if (n == null) "" else " [$n](wiki-note:$n)"
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable internal fun WikiDocument(ui: WikiUi) {
    val doc = ui.page.content
    val sections = doc.objects("sections")
    val requesters = remember(doc.text("slug"), sections.map { it.text("key") }) { sections.associate { it.text("key").orEmpty() to BringIntoViewRequester() } }
    val scope = rememberCoroutineScope()
    var note by rememberSaveable { mutableStateOf<Int?>(null) }
    var showMarks by rememberSaveable { mutableStateOf(false) }
    var nextMarked by rememberSaveable { mutableIntStateOf(0) }
    val markedSections = sections.filter { section -> section.objects("blocks").any { block -> block.objects("sentences").any { it.text("status") in setOf("unsourced", "unverified", "withdrawn") } } }
    LaunchedEffect(ui.route.wikiSection, requesters) { ui.route.wikiSection?.let { requesters[it]?.bringIntoView() } }
    WikiPageColumn {
        WikiHeading(listOfNotNull(doc.text("number"), doc.text("title")).joinToString(" "))
        WikiContents(ui)
        if (ui.route.wikiSection != null && sections.none { it.text("key") == ui.route.wikiSection }) Text("That section is no longer in this document.", color = MaterialTheme.colorScheme.error)
        WikiWords(doc.text("question"), ui)
        if (!doc.flag("written")) Text("Not written yet. The next build writes this document from the confirmed plan.")
        Text(listOfNotNull(doc.text("status")?.replace('_', ' '), doc.number("planVersion")?.let { "Plan v$it" }, doc.text("repoSha"), doc.text("updatedAt")).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
        if (markedSections.isNotEmpty()) {
            Text("This document contains ${doc.obj("counts")?.number("unsourced") ?: 0} unsourced, ${doc.obj("counts")?.number("unverified") ?: 0} unverified and ${doc.obj("counts")?.number("withdrawn") ?: 0} withdrawn sentences.")
            Row {
                TextButton(onClick = { showMarks = !showMarks }) { Text(if (showMarks) "Hide marks" else "Show marks") }
                TextButton(onClick = { scope.launch { requesters[markedSections[nextMarked % markedSections.size].text("key")]?.bringIntoView(); nextMarked++ } }) { Text("Next marked section") }
            }
        }
        WikiTextList("For", doc.strings("audience"), ui)
        WikiTextList("Covers", doc.strings("scopeIn"), ui)
        doc.objects("scopeOut").forEach { row ->
            WikiWords(row.text("text"), ui)
            row.objects("docs").forEach { other -> WikiRow(other.label()) { ui.go(Destination.WIKI_DOC, other.text("slug")) } }
        }
        sections.forEach { section ->
            Column(Modifier.bringIntoViewRequester(requesters.getValue(section.text("key").orEmpty())).testTag("wiki-section:${section.text("key")}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                WikiHeading(listOfNotNull(section.number("number")?.toString(), section.text("title")).joinToString(" "))
                if (!section.flag("written")) Text("Not written yet.")
                if (section.flag("stale")) Text("This section needs updating.")
                section.objects("blocks").forEach { block ->
                    when (block.text("kind")) {
                        "heading" -> WikiHeading(block.text("text").orEmpty())
                        "code" -> WikiWords("```\n${block.text("text").orEmpty()}\n```", ui)
                        else -> block.objects("sentences").forEach { sentence ->
                            val status = sentence.text("status")
                            val prose = sentence.text("text").orEmpty()
                            // A withdrawal stays visible with its mark; it is never silently asserted as current.
                            val text = (if (block.text("kind") == "item") "• " else "") + if (status == "withdrawn") "~~$prose~~" else prose
                            MarkdownText(text + noteLinks(sentence), open = { raw -> if (raw.startsWith("wiki-note:")) note = raw.substringAfter(':').toIntOrNull() else ui.link(raw) })
                            if (status == "withdrawn" || showMarks && status in setOf("unsourced", "unverified")) {
                                Text(listOfNotNull(status, sentence.obj("withdrawn")?.text("reason")?.replace('_', ' ')).joinToString(" · "), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                                sentence.obj("withdrawn")?.text("entryId")?.let { id -> TextButton(onClick = { ui.go(Destination.WIKI_ENTRY, id) }) { Text("Open the entry") } }
                            }
                        }
                    }
                }
            }
        }
        WikiHeading("Sources")
        doc.objects("footnotes").forEach { footnote -> WikiRow("[${footnote.number("n")}] ${footnote.text("label") ?: footnote.text("path") ?: footnote.text("kind")}", footnote.text("verdict")?.replace('_', ' '), "wiki-footnote:${footnote.number("n")}") { note = footnote.number("n") } }
        WikiHeading("Entries cited")
        doc.objects("entries").forEach { WikiEntryRow(it, ui) }
    }
    doc.objects("footnotes").firstOrNull { it.number("n") == note }?.let { footnote ->
        ModalBottomSheet(onDismissRequest = { note = null }) {
            Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState())) { WikiSource(footnote, ui, footnote = true) }
        }
    }
}

@Composable internal fun WikiTextList(title: String, lines: List<String>, ui: WikiUi) {
    if (lines.isNotEmpty()) { Text(title, style = MaterialTheme.typography.titleSmall); lines.forEach { WikiWords("• $it", ui) } }
}
