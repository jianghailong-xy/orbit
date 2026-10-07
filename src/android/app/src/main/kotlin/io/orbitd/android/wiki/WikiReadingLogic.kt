package io.orbitd.android.wiki

import android.icu.text.Collator
import android.icu.text.Transliterator
import android.icu.util.ULocale
import java.net.URLEncoder
import java.time.ZoneId

// The reading pages' derivations, ported from OrbitKit `WikiArticleLogic` and `WikiDocLogic`.

internal object WikiArticleLogic {
    /** The index letter bar: A to Z, then `#`. */
    val indexLetters: List<String> = ('A'..'Z').map(Char::toString) + "#"
    /** The subtopic articles Browse shows of a topic before `N more`, on the phone. */
    const val browseShown = 5

    data class DirectoryTopic(val slug: String, val title: String, val count: Int?, val parts: List<Part>) {
        data class Part(val part: Int, val title: String)
    }
    data class DirectoryGroup(val key: String, val title: String, val topics: List<DirectoryTopic>)

    fun categoryTitle(key: String?) = when (key) {
        "platform" -> "Platform core"; "runner" -> "Runner & engines"; "clients" -> "Clients & UI"; "data" -> "Data & backend"
        "engineering" -> "Engineering workflow"; "collaboration" -> "Collaboration"; else -> "Other"
    }

    /** The categories in the contract's order with their topics, an empty one left out, the uncategorized last. */
    fun directoryGroups(directory: WikiArticleDirectory): List<DirectoryGroup> {
        fun row(topic: WikiArticleDirectory.Topic) = DirectoryTopic(topic.slug, topic.title?.takeIf { it.isNotEmpty() } ?: topic.slug,
            topic.article?.let { it.entryCount ?: 0 }, topic.parts.orEmpty().map { DirectoryTopic.Part(it.part, it.title ?: "") })
        val groups = directory.categories.orEmpty().mapNotNull { category ->
            val topics = category.topics.orEmpty()
            if (topics.isEmpty()) null else DirectoryGroup(category.key, category.title ?: categoryTitle(category.key), topics.map(::row))
        }.toMutableList()
        val other = directory.uncategorized.orEmpty()
        if (other.isNotEmpty()) groups += DirectoryGroup("other", WikiArticleCopy.other, other.map(::row))
        return groups
    }

    data class BrowseTopic(val slug: String, val title: String, val description: String?, val entries: Int, val articles: Int,
        val parts: List<WikiArticlePartRef>, val hasArticle: Boolean)
    data class BrowseCategory(val key: String, val title: String, val topics: Int, val articles: Int, val entries: Int, val rows: List<BrowseTopic>)

    fun browseCategories(directory: WikiArticleDirectory): List<BrowseCategory> {
        val all = directory.categories.orEmpty().flatMap { it.topics.orEmpty() } + directory.uncategorized.orEmpty()
        val bySlug = LinkedHashMap<String, WikiArticleDirectory.Topic>().apply { all.forEach { putIfAbsent(it.slug, it) } }
        return directoryGroups(directory).map { group ->
            val rows = group.topics.mapNotNull { row ->
                val topic = bySlug[row.slug] ?: return@mapNotNull null
                val parts = topic.parts.orEmpty()
                BrowseTopic(topic.slug, row.title, topic.description, topic.article?.entryCount ?: 0,
                    (if (topic.article == null) 0 else 1) + parts.size, parts, topic.article != null)
            }
            BrowseCategory(group.key, group.title, rows.size, rows.sumOf { it.articles }, rows.sumOf { it.entries }, rows)
        }
    }
    data class Totals(val articles: Int, val topics: Int, val entries: Int)
    fun browseTotals(categories: List<BrowseCategory>) =
        Totals(categories.sumOf { it.articles }, categories.sumOf { it.topics }, categories.sumOf { it.entries })

    fun isHan(codePoint: Int) = codePoint in 0x3400..0x4DBF || codePoint in 0x4E00..0x9FFF ||
        codePoint in 0xF900..0xFAFF || codePoint in 0x20000..0x2FFFF

    private val pinyin by lazy { Transliterator.getInstance("Han-Latin; Latin-ASCII") }
    private val collator by lazy { Collator.getInstance(ULocale("zh@collation=pinyin")) }

    /** Its first letter, a Chinese first character's pinyin initial, or `#` (web `wikiIndexInitial`). */
    fun indexInitial(title: String): String {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return "#"
        val first = trimmed.codePointAt(0)
        if (first < 128 && Character.isLetter(first)) return String(Character.toChars(first)).uppercase()
        if (!isHan(first)) return "#"
        val letter = pinyin.transliterate(String(Character.toChars(first))).firstOrNull() ?: return "#"
        return if (letter.code < 128 && letter.isLetter()) letter.uppercase() else "#"
    }
    /** Chinese by pinyin, the Latin letters after the Chinese of the same letter (`zh-u-co-pinyin`). */
    fun pinyinOrder(a: String, b: String): Int = collator.compare(a, b)

    data class IndexGroup<T>(val letter: String, val items: List<T>)

    fun indexGroups(items: List<WikiArticleIndex.Item>): List<IndexGroup<WikiArticleIndex.Item>> {
        val sorted = items.sortedWith { a, b ->
            val order = pinyinOrder(a.title ?: "", b.title ?: "")
            when {
                order != 0 -> order
                a.topic.slug != b.topic.slug -> a.topic.slug.compareTo(b.topic.slug)
                else -> a.part.compareTo(b.part)
            }
        }
        val byLetter = sorted.groupBy { indexInitial(it.title ?: "") }
        return indexLetters.mapNotNull { letter -> byLetter[letter]?.let { IndexGroup(letter, it) } }
    }
    fun indexMeta(item: WikiArticleIndex.Item): String =
        if (item.part == 0) WikiArticleCopy.topicOverview
        else "${item.topic.title ?: item.topic.slug} · ${WikiArticleCopy.entryCount(item.entryCount ?: 0)}"

    data class Segment(val kind: Kind, val text: String) { enum class Kind { TEXT, CODE, STRONG } }

    /** Backticked code and `**strong**` words, nothing else; an unpaired mark stays the character it is. */
    fun segments(text: String): List<Segment> {
        val out = mutableListOf<Segment>()
        fun push(kind: Segment.Kind, value: String) {
            if (value.isEmpty()) return
            val last = out.lastOrNull()
            if (kind == Segment.Kind.TEXT && last?.kind == Segment.Kind.TEXT) out[out.lastIndex] = Segment(Segment.Kind.TEXT, last.text + value)
            else out += Segment(kind, value)
        }
        var at = 0
        while (at < text.length) {
            if (text[at] == '`') {
                val end = text.indexOf('`', at + 1)
                if (end > at + 1) { push(Segment.Kind.CODE, text.substring(at + 1, end)); at = end + 1; continue }
            }
            if (at + 1 < text.length && text[at] == '*' && text[at + 1] == '*') {
                val end = text.indexOf("**", at + 2)
                if (end > at + 2) { push(Segment.Kind.STRONG, text.substring(at + 2, end)); at = end + 2; continue }
            }
            push(Segment.Kind.TEXT, text[at].toString()); at++
        }
        return out
    }

    private val kindPlurals = listOf("principle" to "principles", "convention" to "conventions", "decision" to "decisions",
        "pitfall" to "pitfalls", "recipe" to "recipes", "concept" to "concepts", "assumption" to "assumptions")
    fun kindTags(kinds: List<String?>): List<String> = kindPlurals.mapNotNull { (one, many) ->
        val n = kinds.count { it == one }
        if (n == 0) null else "${WikiArticleCopy.count(n)} ${if (n == 1) one else many}"
    }

    data class EntryGroupKind(val title: String, val note: String, val kinds: List<String>)
    val entryGroupKinds = listOf(
        EntryGroupKind(WikiArticleCopy.groupPrinciples, WikiArticleCopy.notePrinciples, listOf("principle", "convention")),
        EntryGroupKind(WikiArticleCopy.groupDecisions, WikiArticleCopy.noteDecisions, listOf("decision")),
        EntryGroupKind(WikiArticleCopy.groupPitfalls, WikiArticleCopy.notePitfalls, listOf("pitfall")),
        EntryGroupKind(WikiArticleCopy.groupRecipes, WikiArticleCopy.noteRecipes, listOf("recipe")),
        EntryGroupKind(WikiArticleCopy.groupConcepts, WikiArticleCopy.noteConcepts, listOf("concept")),
    )
    data class EntryGroup(val title: String, val note: String, val entries: List<WikiEntry>)

    /** Each group leads with the entries the article cites, in footnote order, then the rest newest first. */
    fun entryGroups(entries: List<WikiEntry>, cited: List<String>): List<EntryGroup> {
        val rank = mutableMapOf<String, Int>()
        cited.forEachIndexed { i, id -> rank.putIfAbsent(wikiKey(id), i) }
        return entryGroupKinds.mapNotNull { group ->
            val held = entries.filter { it.kind in group.kinds }
            val first = held.filter { rank[wikiKey(it.id)] != null }.sortedBy { rank.getValue(wikiKey(it.id)) }
            val rest = held.filter { rank[wikiKey(it.id)] == null }.sortedWith(WikiLogic::changedFirst)
            val all = first + rest
            if (all.isEmpty()) null else EntryGroup(group.title, group.note, all)
        }
    }
    /** A turn cited from its session names that session (`wikiSourceCounts`). */
    fun sourceCounts(sources: List<WikiSource>): Pair<Int, Int> {
        val sessions = sources.filter { it.kind == "turn" && it.locator["turnId"].text() != null }.mapNotNull { it.ref }.toSet()
        return sources.size to sessions.size
    }
}

internal object WikiDocLogic {
    private fun plural(n: Int, one: String, many: String) = "${WikiArticleCopy.count(n)} ${if (n == 1) one else many}"
    private data class QuoteGroup(val kinds: Set<String>, val one: String, val many: String)
    private val quoteGroups = listOf(
        QuoteGroup(setOf("turn", "event", "tool_call"), "session quote", "session quotes"),
        QuoteGroup(setOf("design_doc", "code", "contract"), "code & doc quote", "code & doc quotes"),
        QuoteGroup(setOf("task", "task_comment"), "task quote", "task quotes"),
        QuoteGroup(setOf("approval", "owner_decision", "merge_receipt"), "record quote", "record quotes"),
        QuoteGroup(setOf("note"), "note", "notes"),
    )
    fun quoteCounts(footnotes: List<WikiDocFootnote>) = quoteGroups.mapNotNull { group ->
        val n = footnotes.count { it.kind in group.kinds }
        if (n > 0) plural(n, group.one, group.many) else null
    }
    fun tags(doc: WikiDoc): List<String> {
        val footnotes = doc.footnotes.orEmpty()
        val tags = mutableListOf(plural(doc.sections.orEmpty().size, "section", "sections"))
        if (footnotes.isNotEmpty()) tags += listOf(plural(footnotes.size, "footnote", "footnotes")) + quoteCounts(footnotes)
        return tags
    }
    fun updatedParts(doc: WikiDoc, zone: ZoneId = ZoneId.systemDefault()): List<String> {
        if (!doc.written) return emptyList()
        val day = doc.updatedAt?.let { WikiModeLogic.monthDay(it, zone) } ?: ""
        val at = doc.repoSha?.let { " at ${WikiLogic.shortSha(it)}" } ?: ""
        val version = doc.writtenFromPlanVersion ?: doc.planVersion ?: 0
        return listOf("Updated $day$at", "written by ${WikiCopy.historyMaintenance} from plan v$version",
            plural(doc.counts?.sentences ?: 0, "sentence", "sentences"))
    }
    fun updatedWarn(doc: WikiDoc): String? {
        if (!doc.written || doc.status == "needs_review") return null
        val parts = mutableListOf<String>()
        doc.counts?.unsourced?.takeIf { it > 0 }?.let { parts += "${WikiArticleCopy.count(it)} without a source" }
        doc.counts?.unverified?.takeIf { it > 0 }?.let { parts += "${WikiArticleCopy.count(it)} not verified" }
        return if (parts.isEmpty()) null else parts.joinToString(" · ")
    }
    const val needsReviewThreshold = "5%"
    fun needsReviewText(doc: WikiDoc): String {
        val counts = doc.counts
        val marked = (counts?.unsourced ?: 0) + (counts?.unverified ?: 0)
        val share = "%.1f".format(java.util.Locale.ROOT, Math.round((doc.unsourcedShare ?: 0.0) * 1000) / 10.0)
        return "${WikiArticleCopy.count(marked)} of ${plural(counts?.sentences ?: 0, "sentence", "sentences")} ($share%) state something no footnote " +
            "backs, or cite one that couldn’t be verified. Over $needsReviewThreshold, the whole document is marked; " +
            "they’re marked below, and written again when their section is."
    }

    enum class Mark(val label: String) { UNSOURCED(WikiDocCopy.noSource), UNVERIFIED(WikiDocCopy.notVerified), WITHDRAWN(WikiDocCopy.withdrawn) }
    fun mark(sentence: WikiDocSentence) = when (sentence.status) {
        "unsourced" -> Mark.UNSOURCED; "unverified" -> Mark.UNVERIFIED; "withdrawn" -> Mark.WITHDRAWN; else -> null
    }
    data class Legend(val mark: Mark, val label: String, val count: Int)
    fun legend(doc: WikiDoc): List<Legend> = Mark.entries.mapNotNull { mark ->
        val n = when (mark) { Mark.UNSOURCED -> doc.counts?.unsourced; Mark.UNVERIFIED -> doc.counts?.unverified; Mark.WITHDRAWN -> doc.counts?.withdrawn } ?: 0
        if (n > 0) Legend(mark, mark.label, n) else null
    }
    fun rewriteNote(sections: List<WikiDocSection>): String? {
        val stale = sections.filter { it.stale == true }.mapNotNull { it.number }
        return if (stale.isEmpty()) null else "${WikiDocCopy.sectionList(stale)} rewritten at the next run"
    }
    fun notWrittenNote(written: Int?, total: Int?): String {
        val count = if (written != null && total != null) " — ${WikiArticleCopy.count(written)} of ${plural(total, "document is", "documents are")} written" else ""
        return "Wiki maintenance writes it on its next run$count. What it will cover is below."
    }
    fun scopeCounts(doc: WikiDoc) = listOf(doc.audience.orEmpty().size, doc.scopeIn.orEmpty().size, doc.scopeOut.orEmpty().size)
        .joinToString(" · ") { WikiArticleCopy.count(it) }
    fun scopeTarget(target: WikiDoc.Target) = "→ ${target.number ?: target.title ?: target.slug}"

    private fun originWord(note: WikiDocFootnote) = when (note.kind) {
        "code" -> "code"; "design_doc" -> "a design doc"; "contract" -> "a contract"; else -> "a record"
    }
    fun recordName(note: WikiDocFootnote) = when (note.kind) {
        "turn" -> note.seq?.let { "turn #$it" } ?: "turn"
        "event" -> note.seq?.let { "event #$it" } ?: "event"
        "tool_call" -> note.label?.let { "tool call $it" } ?: "tool call"
        "task" -> "task"; "task_comment" -> "comment"
        "approval" -> note.label?.let { "approval of $it" } ?: "approval"
        "owner_decision" -> "decision"; "merge_receipt" -> "merge receipt"; "note" -> "note"
        else -> "lines"
    }
    private fun withdrawClause(reason: String) = when (reason) {
        "rejected" -> "which you rejected"; "retired" -> "which was retired"; "superseded" -> "which was superseded"
        "anchor_changed" -> "whose anchor changed"; "anchor_missing" -> "whose anchor went missing"; else -> "which left the wiki"
    }
    data class MarkNote(val title: String, val text: String, val see: Int?, val entryId: String?)
    fun markNote(sentence: WikiDocSentence, section: WikiDocSection, doc: WikiDoc, zone: ZoneId = ZoneId.systemDefault()): MarkNote? {
        val number = section.number ?: 0
        return when (mark(sentence)) {
            Mark.UNSOURCED -> MarkNote("${WikiDocCopy.noSource}.",
                "This sentence states something no footnote backs. It’s written again, with a source or without the claim, when §$number is.", null, null)
            Mark.UNVERIFIED -> {
                val notes = doc.footnotes.orEmpty().associateBy { it.n }
                val failed = sentence.notes.orEmpty().mapNotNull { notes[it] }.firstOrNull { it.verdict != "verified" }
                val text = when (failed?.verdict) {
                    "no_quote" -> "Its footnote cites ${originWord(failed)} without quoting it, so the sentence couldn’t be checked."
                    "not_found" -> "Its footnote’s quote isn’t in the ${recordName(failed)} it cites, so the sentence couldn’t be checked."
                    "unresolved" -> "Its footnote cites a record this wiki can’t read, so the sentence couldn’t be checked."
                    else -> "Its footnote couldn’t be checked, so neither could the sentence."
                }
                MarkNote("${WikiDocCopy.notVerified}.", text, failed?.n, null)
            }
            Mark.WITHDRAWN -> {
                val withdrawn = sentence.withdrawn ?: return null
                val entry = doc.entries.orEmpty().firstOrNull { it.id == withdrawn.entryId }
                val name = entry?.let { "「${it.title}」" } ?: "an entry"
                val day = withdrawn.at?.let { WikiModeLogic.monthDay(it, zone) }
                MarkNote("${WikiDocCopy.withdrawn}.", "It came through $name, ${withdrawClause(withdrawn.reason)}${day?.let { " on $it" } ?: ""}. " +
                    "§$number is written again at the next maintenance run.", null, withdrawn.entryId)
            }
            null -> null
        }
    }

    fun isRepo(note: WikiDocFootnote) = note.kind == "design_doc" || note.kind == "code" || note.kind == "contract"
    private val eventLabels = mapOf("assistant" to "Agent reply", "user" to "User message", "tool_use" to "Tool call",
        "tool_result" to "Command output", "error" to "Error", "thinking" to "Thinking", "result" to "Run result", "status" to "Status")
    fun subLabel(note: WikiDocFootnote): String? = when (note.kind) {
        "turn" -> if (note.label == "steer") "Steer" else "User message"
        "event" -> note.label?.let { eventLabels[it] }
        "tool_call" -> "Command output"
        "task_comment" -> when (note.label) { "AGENT" -> "Agent’s comment"; "USER" -> "Your comment"; else -> null }
        else -> null
    }
    fun lineRange(start: Int?, end: Int?): String? = when {
        start == null -> null
        end != null && end != start -> "L$start–$end"
        else -> "L$start"
    }
    private fun repoWhere(note: WikiDocFootnote): String {
        val path = note.path ?: note.location ?: ""
        if (note.kind == "design_doc" && note.section != null) return "$path § ${note.section}"
        if (note.kind == "code" && note.symbol != null) return "$path · ${note.symbol}"
        return path
    }
    private fun recordParts(note: WikiDocFootnote, withProject: Boolean, zone: ZoneId): List<String> {
        val parts = mutableListOf<String>()
        when (note.kind) {
            "turn", "event", "tool_call", "approval" -> {
                note.sessionTitle?.let { parts += it }
                if (withProject) note.projectTitle?.let { parts += it }
            }
            "task", "task_comment" -> {
                note.taskTitle?.let { parts += it }
                if (withProject) note.projectTitle?.let { parts += it }
            }
            "merge_receipt" -> (note.taskTitle ?: note.sessionTitle)?.let { parts += it }
            "owner_decision" -> note.projectTitle?.let { parts += it }
            "note" -> return listOf(note.notePath ?: note.location ?: "")
        }
        parts += recordName(note)
        WikiDocCopy.monthDayTime(note.at, zone)?.let { parts += it }
        return parts
    }
    fun footnoteWhere(note: WikiDocFootnote, zone: ZoneId = ZoneId.systemDefault()) =
        if (isRepo(note)) repoWhere(note) else recordParts(note, false, zone).joinToString(" · ")
    fun footnotePlace(note: WikiDocFootnote, zone: ZoneId = ZoneId.systemDefault()): String {
        if (isRepo(note)) return lineRange(note.lineStart, note.lineEnd)?.let { "${repoWhere(note)} · $it" } ?: repoWhere(note)
        return recordParts(note, true, zone).joinToString(" · ")
    }
    /** `https://github.com/<owner>/<repo>` for a space whose repository is on GitHub (`wikiGithubRepo`). */
    fun githubRepo(repoUrlNorm: String?): String? {
        val match = Regex("^github\\.com/([^/\\s]+)/([^/\\s]+?)(?:\\.git)?/?$").matchEntire(repoUrlNorm ?: return null) ?: return null
        return "https://github.com/${match.groupValues[1]}/${match.groupValues[2]}"
    }

    sealed interface OpenTarget {
        data class SessionRecord(val session: String, val record: String) : OpenTarget
        data class Task(val id: String) : OpenTarget
        data class Session(val id: String) : OpenTarget
        data class Project(val id: String) : OpenTarget
        data class External(val url: String) : OpenTarget
    }
    data class FootnoteOpen(val label: String, val target: OpenTarget)

    /** `encodeURIComponent` per path segment. */
    private fun uriComponent(segment: String) = URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
        .replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%7E", "~")

    /** The footnote sheet's one button (`wikiFootnoteOpen`); nil where Orbit has nothing to open — a note. */
    fun footnoteOpen(note: WikiDocFootnote, github: String?): FootnoteOpen? {
        if (isRepo(note)) {
            val path = note.path; val sha = note.sha
            if (github == null || path == null || sha == null) return null
            var lines = ""
            note.lineStart?.let { start -> lines = "#L$start"; note.lineEnd?.takeIf { it != start }?.let { lines += "-L$it" } }
            val encoded = path.split('/').joinToString("/") { uriComponent(it) }
            return FootnoteOpen("Open on GitHub at ${WikiLogic.shortSha(sha)} ↗", OpenTarget.External("$github/blob/$sha/$encoded$lines"))
        }
        val record = note.sessionRecord?.let { OpenTarget.SessionRecord(it.first, it.second) }
        return when (note.kind) {
            "turn" -> record?.let { FootnoteOpen("Open at this turn", it) }
            "event" -> record?.let { FootnoteOpen("Open at this event", it) }
            "tool_call" -> record?.let { FootnoteOpen("Open at this tool call", it) }
            "task" -> note.taskId?.let { FootnoteOpen("Open the task", OpenTarget.Task(it)) }
            "task_comment" -> note.taskId?.let { FootnoteOpen("Open the comment", OpenTarget.Task(it)) }
            "approval", "merge_receipt" -> note.sessionId?.let { FootnoteOpen("Open the session", OpenTarget.Session(it)) }
            "owner_decision" -> note.projectId?.let { FootnoteOpen("Open the project", OpenTarget.Project(it)) }
            else -> null
        }
    }
    fun footnoteProblem(note: WikiDocFootnote): String? = when (note.verdict) {
        "not_found" -> "These words aren’t in the ${recordName(note)} it cites. Open it to see what it does say."
        "no_quote" -> {
            val what = if (isRepo(note)) (if (note.kind == "design_doc") "design doc" else note.kind) else "record"
            "The sentence cites this $what without quoting it, so it couldn’t be checked."
        }
        "unresolved" -> "The record it cites isn’t one this wiki can read, so it couldn’t be checked."
        else -> null
    }
    fun quoted(quote: String) = "“$quote”"

    data class ExcerptLine(val n: Int, val text: String, val quoted: Boolean)
    private fun lineCore(text: String): String = text.replace(Regex("^\\s*(?:/\\*\\*?|\\*/|\\*|//+|#+|--)\\s?"), "")
        .replace(Regex("\\s*\\*/\\s*$"), "").replace(Regex("\\s+"), " ").trim()
    fun excerptLines(note: WikiDocFootnote, shown: Int): Pair<List<ExcerptLine>, Int> {
        var excerpt = note.excerpt?.takeIf { it.isNotEmpty() } ?: return emptyList<ExcerptLine>() to 0
        if (excerpt.endsWith("\n")) excerpt = excerpt.dropLast(1)
        val all = excerpt.split("\n")
        val start = note.lineStart ?: 1
        val quote = note.quote?.replace(Regex("\\s+"), " ")?.trim() ?: ""
        val lines = all.mapIndexed { i, text ->
            val core = lineCore(text)
            ExcerptLine(start + i, text, quote.isNotEmpty() && core.isNotEmpty() && (core.contains(quote) || (core.length >= 8 && quote.contains(core))))
        }
        return lines.take(shown) to maxOf(0, lines.size - shown)
    }
    fun footnotesSummary(footnotes: List<WikiDocFootnote>) =
        (listOf(WikiArticleCopy.count(footnotes.size)) + quoteCounts(footnotes)).joinToString(" · ")

    fun viaEntryStatus(entry: WikiDocViaEntry) = when (entry.status) {
        "rejected" -> "Rejected by you"; "retired" -> "Retired"; "superseded" -> "Superseded"; else -> null
    }
    fun viaEntryNote(entry: WikiDocViaEntry, doc: WikiDoc): String? {
        val withdrawn = mutableListOf<Int>(); var count = 0
        doc.sections.orEmpty().forEach { section -> section.blocks.orEmpty().forEach { block -> block.sentences.orEmpty().forEach { sentence ->
            if (sentence.withdrawn?.entryId == entry.id) { count++; withdrawn += section.number ?: 0 }
        } } }
        val parts = listOfNotNull(viaEntryStatus(entry)).toMutableList()
        if (count == 1) parts += "its sentence in ${WikiDocCopy.sectionList(withdrawn)} is withdrawn"
        else if (count > 1) parts += "its sentences in ${WikiDocCopy.sectionList(withdrawn)} are withdrawn"
        return if (parts.isEmpty()) null else parts.joinToString(" · ")
    }
    data class EntryGroup(val title: String, val note: String, val entries: List<WikiDocViaEntry>)
    fun entryGroups(entries: List<WikiDocViaEntry>): List<EntryGroup> {
        fun first(entry: WikiDocViaEntry) = entry.notes.orEmpty().minOrNull() ?: Int.MAX_VALUE
        return WikiArticleLogic.entryGroupKinds.mapNotNull { group ->
            val held = entries.filter { it.kind in group.kinds }.sortedWith(compareBy<WikiDocViaEntry> { first(it) }.thenBy { it.id })
            if (held.isEmpty()) null else EntryGroup(group.title, group.note, held)
        }
    }

    data class DirectorySection(val key: String, val number: Int, val title: String, val written: Boolean, val stale: Boolean)
    data class DirectoryDoc(val slug: String, val number: String, val title: String, val written: Boolean, val needsReview: Boolean,
        val sections: List<DirectorySection>)
    data class DirectoryGroup(val key: String, val number: Int, val title: String, val docs: List<DirectoryDoc>)
    fun directoryGroups(directory: WikiDocsDirectory): List<DirectoryGroup> = directory.categories.mapNotNull { category ->
        val docs = category.docs.orEmpty()
        if (docs.isEmpty()) null else DirectoryGroup(category.key, category.number ?: 0, category.title.ifEmpty { category.key },
            docs.map { doc -> DirectoryDoc(doc.slug, doc.number ?: "", doc.title.ifEmpty { doc.slug }, doc.written ?: false,
                doc.status == "needs_review", doc.sections.orEmpty().map { DirectorySection(it.key, it.number ?: 0, it.title, it.written ?: false, it.stale ?: false) }) })
    }
    /** Whether a space reads by its documents (a plan is confirmed), or still by topic (`wikiReadsByDocs`). */
    fun readsByDocs(directory: WikiDocsDirectory?) = directory?.plan != null
    private fun sectionCount(docs: List<WikiDocsDirectory.Doc>) = docs.sumOf { it.sections.orEmpty().size }
    fun browseSummary(directory: WikiDocsDirectory): List<String> {
        val categories = directory.categories.filter { it.docs.orEmpty().isNotEmpty() }
        val docs = directory.categories.flatMap { it.docs.orEmpty() }
        val parts = mutableListOf("${plural(docs.size, "document", "documents")} · ${plural(categories.size, "category", "categories")} · " +
            plural(sectionCount(docs), "section", "sections"))
        directory.plan?.let { parts += "plan v${it.version}" }
        return parts
    }
    fun categoryLine(category: WikiDocsDirectory.Category): String {
        val docs = category.docs.orEmpty()
        return "${plural(docs.size, "document", "documents")} · ${plural(sectionCount(docs), "section", "sections")}"
    }
    enum class DocState(val text: String) { NEEDS_REVIEW(WikiDocCopy.needsReview), NOT_WRITTEN(WikiDocCopy.notWrittenShort) }
    fun docLine(doc: WikiDocsDirectory.Doc): Pair<String, DocState?> {
        val sections = plural(doc.sections.orEmpty().size, "section", "sections")
        if (doc.written != true) return sections to DocState.NOT_WRITTEN
        return sections to (if (doc.status == "needs_review") DocState.NEEDS_REVIEW else null)
    }
    fun indexSummary(items: List<WikiDocsIndex.Item>): String {
        val docs = items.count { it.kind == "doc" }
        return "${plural(docs, "document", "documents")} and ${plural(items.size - docs, "section", "sections")} by title · Chinese titles by pinyin"
    }
    fun indexMeta(item: WikiDocsIndex.Item): String =
        if (item.kind == "doc") "${item.docNumber ?: ""} · ${item.category?.title ?: item.category?.key ?: ""} · document"
        else "§${item.sectionNumber ?: 0} in ${item.docNumber ?: ""} ${item.docTitle ?: item.docSlug}"
    fun indexGroups(items: List<WikiDocsIndex.Item>): List<WikiArticleLogic.IndexGroup<WikiDocsIndex.Item>> {
        val sorted = items.sortedWith { a, b ->
            val order = WikiArticleLogic.pinyinOrder(a.title, b.title)
            when {
                order != 0 -> order
                a.kind != b.kind -> if (a.kind == "doc") -1 else 1
                else -> WikiArticleLogic.pinyinOrder(a.docNumber ?: "", b.docNumber ?: "").takeIf { it != 0 }
                    ?: (a.sectionNumber ?: 0).compareTo(b.sectionNumber ?: 0)
            }
        }
        val byLetter = sorted.groupBy { WikiArticleLogic.indexInitial(it.title) }
        return WikiArticleLogic.indexLetters.mapNotNull { letter -> byLetter[letter]?.let { WikiArticleLogic.IndexGroup(letter, it) } }
    }
}
