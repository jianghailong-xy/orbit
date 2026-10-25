package io.orbitd.android.text

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import org.commonmark.node.*
import org.commonmark.node.Text as MarkdownLiteral
import org.commonmark.parser.Parser
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.*
import org.commonmark.ext.gfm.tables.*
import org.commonmark.ext.task.list.items.*
import kotlinx.coroutines.*

internal val markdownParser: Parser = Parser.builder().extensions(listOf(TablesExtension.create(),
    StrikethroughExtension.create(), TaskListItemsExtension.create(), AutolinkExtension.create())).build()
internal fun Node.children(): List<Node> = generateSequence(firstChild) { it.next }.toList()
// Keep clipboard parcels comfortably below Android's transaction limit (UTF-16 plus metadata).
internal const val COPY_TEXT_LIMIT = 200_000

/** Native text/links shared by the transcript and Wiki/details. Raw HTML remains literal text. */
@Composable
fun MarkdownText(source: String, modifier: Modifier = Modifier, open: (String) -> Unit = {}) {
    val nodes = remember(source) { markdownParser.parse(source).children() }
    SelectionContainer(modifier) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) { nodes.forEach { MarkdownNode(it, open) } }
    }
}

@Composable
private fun MarkdownNode(node: Node, open: (String) -> Unit) {
    when (node) {
        is Heading -> Text(inline(node, open), style = when (node.level) {
            1 -> MaterialTheme.typography.headlineLarge
            2 -> MaterialTheme.typography.headlineMedium
            else -> MaterialTheme.typography.titleMedium
        }, modifier = Modifier.semantics { heading() })
        is FencedCodeBlock -> CodeText(node.literal.trimEnd('\n'), node.info.substringBefore(' '))
        is IndentedCodeBlock -> CodeText(node.literal.trimEnd('\n'))
        is ThematicBreak -> HorizontalDivider()
        is BlockQuote -> Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { node.children().forEach { MarkdownNode(it, open) } }
        }
        is BulletList, is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            node.children().forEachIndexed { index, child ->
                Row {
                    Text(if (node is OrderedList) "${node.startNumber + index}. " else "• ", Modifier.widthIn(min = 24.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        child.children().forEach { MarkdownNode(it, open) }
                    }
                }
            }
        }
        is TableBlock -> {
            val rows = node.children().flatMap { it.children() }
            val width = 180.dp
            Column(Modifier.horizontalScroll(rememberScrollState()).border(1.dp, MaterialTheme.colorScheme.outlineVariant).testTag("markdown-table")) {
                rows.forEach { row -> Row {
                    row.children().filterIsInstance<TableCell>().forEach { cell ->
                        Text(inline(cell, open), Modifier.width(width).border(0.5.dp, MaterialTheme.colorScheme.outlineVariant).padding(8.dp),
                            style = MaterialTheme.typography.bodyMedium, fontWeight = if (cell.isHeader) FontWeight.Bold else FontWeight.Normal,
                            textAlign = when (cell.alignment) { TableCell.Alignment.CENTER -> TextAlign.Center; TableCell.Alignment.RIGHT -> TextAlign.Right; else -> TextAlign.Start })
                    }
                } }
            }
        }
        is HtmlBlock -> Text(node.literal, style = MaterialTheme.typography.bodyLarge)
        else -> {
            // Split images out of inline prose so they remain visible, including images inside links,
            // and a link to an image file the session can serve (a saved screenshot) as its file row.
            val sessionId = LocalReaderResources.current?.sessionId
            val chunks = remember(node, sessionId) { inlineChunks(node) { MarkdownFileRef.imageFile(it, sessionId) != null } }
            chunks.forEach { chunk ->
                val image = chunk.singleOrNull() as? Image
                val link = (chunk.singleOrNull() as? Link)?.takeIf { it.children().any { child -> child is Image } }
                val file = (chunk.singleOrNull() as? Link)?.let { MarkdownFileRef.imageFile(it, sessionId) }
                if (image != null) TranscriptImage(image.destination, plain(image), open)
                else if (link != null) {
                    MarkdownNode(link, open)
                    TextButton(onClick = { open(link.destination) }) { Text("Open link") }
                }
                else if (file != null) ImageFileRow(file, open)
                else Text(inlineNodes(chunk, open), style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
}

internal fun inlineChunks(node: Node, isImageFile: (Link) -> Boolean = { false }): List<List<Node>> {
    fun imageFile(child: Node) = child is Link && child.children().none { it is Image } && isImageFile(child)
    if (node.children().none { it is Image || it is Link && it.children().any { c -> c is Image } || imageFile(it) }) return listOf(listOf(node))
    val result = mutableListOf<List<Node>>()
    var run = mutableListOf<Node>()
    fun flush() { if (run.isNotEmpty()) result.add(run); run = mutableListOf() }
    node.children().forEach { child ->
        if (child is Image) { flush(); result += listOf(child) }
        else if (child is Link && child.children().any { it is Image }) { flush(); result += listOf(child) }
        else if (imageFile(child)) { flush(); result += listOf(child) }
        else run += child
    }
    flush()
    // Prose that is only the punctuation around a file row ("See [shot](…).") reads as a stray mark on its own line.
    return result.filterIndexed { index, chunk ->
        val besideFile = listOf(index - 1, index + 1).any { i -> result.getOrNull(i)?.singleOrNull()?.let(::imageFile) == true }
        !besideFile || chunk.singleOrNull()?.let(::imageFile) == true || chunk.joinToString("") { plain(it) }.any { it !in PROSE_PUNCTUATION && !it.isWhitespace() }
    }
}

private const val PROSE_PUNCTUATION = "，。；：、,.;:!?！？"

private fun plain(node: Node): String = when (node) {
    is MarkdownLiteral -> node.literal
    is Code -> node.literal
    else -> node.children().joinToString("") { plain(it) }
}

@Composable
private fun inline(node: Node, open: (String) -> Unit): AnnotatedString {
    return inlineNodes(listOf(node), open)
}

@Composable
private fun inlineNodes(nodes: List<Node>, open: (String) -> Unit): AnnotatedString {
    val color = MaterialTheme.colorScheme.primary
    val background = MaterialTheme.colorScheme.surfaceVariant
    return remember(nodes, color, background, open) { buildAnnotatedString {
        fun appendNode(n: Node) {
            fun children() { n.children().forEach { appendNode(it) } }
            when (n) {
                is MarkdownLiteral -> append(n.literal)
                is SoftLineBreak, is HardLineBreak -> append("\n")
                is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { children() }
                is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { children() }
                is Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { children() }
                is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = background)) { append(n.literal) }
                is Link -> withLink(LinkAnnotation.Clickable(n.destination,
                    TextLinkStyles(SpanStyle(color = color, textDecoration = TextDecoration.Underline))) { open(n.destination) }) { children() }
                is Image -> append(plain(n))
                is HtmlInline -> append(n.literal)
                is TaskListItemMarker -> append(if (n.isChecked) "☑ " else "☐ ")
                else -> children()
            }
        }
        nodes.forEach { appendNode(it) }
    } }
}

/** Completed blocks stay parsed while only the unfinished paragraph changes at stream cadence. */
internal fun streamingSplit(source: String): Pair<String, String> {
    var cut = 0; var offset = 0; var fence: Char? = null; var fenceLength = 0
    source.splitToSequence('\n').forEach { line ->
        val trimmed = line.trimStart()
        val marker = trimmed.firstOrNull()
        val length = if (marker == '`' || marker == '~') trimmed.takeWhile { it == marker }.length else 0
        if (length >= 3 && fence == null) { fence = marker; fenceLength = length }
        else if (fence != null && fence == marker && length >= fenceLength && trimmed.drop(length).isBlank()) fence = null
        else if (fence == null && line.isBlank() && offset < source.length) cut = minOf(source.length, offset + line.length + 1)
        offset += line.length + 1
    }
    return source.substring(0, cut) to source.substring(cut)
}

@Composable
fun StreamingText(source: String, open: (String) -> Unit) {
    val split = remember(source) { streamingSplit(source) }
    Column { if (split.first.isNotEmpty()) MarkdownText(split.first, open = open)
        SelectionContainer { Text(split.second, style = MaterialTheme.typography.bodyLarge) } }
}

@Composable
fun CodeText(source: String, language: String = "", preview: Boolean = true) {
    var full by rememberSaveable { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val lines = remember(source) { source.lines() }
    val clipped = preview && (lines.size > 24 || source.length > 4_000)
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(language.ifBlank { "Text" }, style = MaterialTheme.typography.labelMedium)
            TextButton(onClick = { if (source.length > COPY_TEXT_LIMIT) full = true else clipboard.setText(AnnotatedString(source)) }) {
                Text(if (source.length > COPY_TEXT_LIMIT) "Save text" else "Copy")
            }
        }
        SelectionContainer {
            Text(codeSpans(if (clipped) lines.take(24).joinToString("\n").take(4_000) else source, language),
                Modifier.horizontalScroll(rememberScrollState()), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, softWrap = false)
        }
        if (clipped) TextButton(onClick = { full = true }) { Text(if (lines.size == 1) "View full output" else "View all ${lines.size} lines") }
    }
    if (full) LongTextDialog(source, language) { full = false }
}

@Composable
private fun codeSpans(source: String, language: String): AnnotatedString {
    val added = io.orbitd.android.ui.LocalOrbitColors.current.success
    val removed = MaterialTheme.colorScheme.error
    val keyword = MaterialTheme.colorScheme.primary
    return remember(source, language, added, removed, keyword) { buildAnnotatedString {
        if (language in setOf("diff", "patch")) source.splitToSequence('\n').forEachIndexed { i, line ->
            if (i > 0) append("\n")
            withStyle(SpanStyle(color = when { line.startsWith('+') -> added; line.startsWith('-') -> removed; line.startsWith("@@") -> keyword; else -> Color.Unspecified })) { append(line) }
        } else {
            append(source)
            if (language.isNotBlank()) Regex("\\b(fun|val|var|class|const|let|function|return|if|else|import|from|def|public|private|true|false|null|SELECT|FROM|WHERE)\\b").findAll(source)
                .forEach { addStyle(SpanStyle(color = keyword, fontWeight = FontWeight.SemiBold), it.range.first, it.range.last + 1) }
        }
    } }
}

@Composable
fun LongTextDialog(source: String, language: String = "", close: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var saveError by remember { mutableStateOf(false) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/plain")) { uri ->
        if (uri != null) scope.launch {
            saveError = false
            try { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.use { it.write(source.toByteArray()) } ?: error("Unavailable destination") } }
            catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { saveError = true }
        }
    }
    val chunks = remember(source) { outputChunks(source) }
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
            Column(Modifier.padding(12.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = close) { Text("Close output") }
                    if (source.length <= COPY_TEXT_LIMIT) TextButton(onClick = { clipboard.setText(AnnotatedString(source)) }) { Text("Copy all") }
                    TextButton(onClick = { save.launch("orbit-output.txt") }) { Text("Save text") }
                }
                if (source.length > COPY_TEXT_LIMIT) Text("Select a portion to copy, or save the complete text.", style = MaterialTheme.typography.bodySmall)
                if (saveError) Text("Couldn't save text. Try another destination.")
                SelectionContainer { LazyColumn(Modifier.fillMaxSize().testTag("long-output")) {
                    itemsIndexed(chunks, key = { index, _ -> index }) { _, chunk ->
                        Text(codeSpans(chunk, language), Modifier.horizontalScroll(rememberScrollState()).padding(vertical = 2.dp),
                            fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium, softWrap = false)
                    }
                } }
            }
        }
    }
}

/** Bound paragraph width even for a 512 KiB single line. Continuations only affect display;
 * Copy all and Save text always use the original source. Do not split a surrogate pair. */
internal fun outputChunks(source: String): List<String> = source.lines().flatMap { line ->
    if (line.length <= 2_048) listOf(line) else buildList {
        var start = 0
        while (start < line.length) {
            var end = minOf(start + 2_048, line.length)
            if (end < line.length && line[end - 1].isHighSurrogate()) end--
            add(line.substring(start, end)); start = end
        }
    }
}.chunked(32).map { it.joinToString("\n") }
