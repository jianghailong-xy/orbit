package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.cards.ToolCalls.Shape
import io.orbitd.android.text.CodeText
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject

/** A plain tool-call approval's body (web `ToolCallBody`, board docs/mocks/tool-call-card): the call's tool as a badge, its one
 * description line, then what it does: a command, a path and its change, a URL, or an unknown tool's fields with its raw input a
 * press away. */
@Composable
internal fun ToolCallBody(card: InteractionCard, open: (String) -> Unit) {
    val tool = card.source.text("toolName").orEmpty()
    val input = card.source.obj("input") ?: JsonObject(emptyMap())
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(tool, Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.1f), RoundedCornerShape(4.dp))
        .padding(horizontal = 6.dp, vertical = 1.dp).testTag("tool-call:badge"),
        fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
    ToolCalls.descriptionLine(tool, input, card.context)?.let { line ->
        Text(buildAnnotatedString {
            append(line.shown)
            line.original?.let { withStyle(SpanStyle(color = muted)) { append("  $it") } }
        }, Modifier.testTag("tool-call:description"), style = MaterialTheme.typography.bodyMedium)
    }
    when (ToolCalls.shape(tool, input)) {
        Shape.COMMAND -> FoldedMono(ToolCalls.str(input, "command"), prompt = true)
        Shape.EDIT -> {
            PathLine(ToolCalls.path(input))
            if (input["old_string"] != null || input["new_string"] != null)
                CodeText(ToolCalls.diff(ToolCalls.str(input, "old_string"), ToolCalls.str(input, "new_string")), "diff")
        }
        Shape.MULTI_EDIT -> {
            PathLine(ToolCalls.path(input))
            input.objects("edits").forEach { CodeText(ToolCalls.diff(ToolCalls.str(it, "old_string"), ToolCalls.str(it, "new_string")), "diff") }
        }
        Shape.WRITE -> {
            PathLine(ToolCalls.path(input))
            ToolCalls.str(input, "content").takeIf { it.isNotEmpty() }?.let { FoldedMono(it, prompt = false) }
        }
        Shape.FILE -> PathLine(ToolCalls.path(input))
        Shape.FETCH -> Mono(ToolCalls.str(input, "url"))
        Shape.SEARCH -> Mono(ToolCalls.str(input, "query"))
        Shape.PATTERN -> Mono(ToolCalls.str(input, "pattern"))
        Shape.FIELDS -> {
            val fields = ToolCalls.fields(input)
            CardFields(fields, fields.keys.toList(), open)
            var raw by rememberSaveable(card.key) { mutableStateOf(false) }
            TextButton(onClick = { raw = !raw }, Modifier.testTag("tool-call:raw")) {
                Text(if (raw) "▾ ${ToolCalls.hideRaw}" else "▸ ${ToolCalls.showRaw}")
            }
            if (raw) CodeText(ToolCalls.rawInput(input), "json")
        }
    }
    ToolCalls.chips(tool, input).takeIf { it.isNotEmpty() }?.let { chips ->
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            chips.forEach { chip ->
                val tone = if (chip.warn) LocalOrbitColors.current.needsYou else muted
                Text(chip.label, Modifier.background(tone.copy(alpha = 0.1f), RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 2.dp)
                    .testTag("tool-call:chip"), style = MaterialTheme.typography.labelSmall, color = tone)
            }
        }
    }
}

/** A path, its folder in grey and its file name in full ink. */
@Composable
private fun PathLine(path: String) {
    val shown = ToolCalls.relPath(path)
    val cut = shown.lastIndexOf('/')
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Mono(buildAnnotatedString {
        if (cut >= 0) withStyle(SpanStyle(color = muted)) { append(shown.substring(0, cut + 1)) }
        append(shown.substring(cut + 1))
    })
}

@Composable
private fun Mono(text: String) = Mono(AnnotatedString(text))

@Composable
private fun Mono(text: AnnotatedString) = SelectionContainer {
    Text(text, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)).padding(8.dp),
        fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
}

/** A command (after a `$`) or a file's content, folded after [ToolCalls.foldLines] lines; Copy always copies all of it. */
@Composable
private fun FoldedMono(text: String, prompt: Boolean) {
    var open by rememberSaveable(text) { mutableStateOf(false) }
    val fold = ToolCalls.fold(text, open)
    val clipboard = LocalClipboardManager.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)).padding(8.dp)) {
        Box(Modifier.fillMaxWidth()) {
            SelectionContainer(Modifier.horizontalScroll(rememberScrollState())) {
                Text(buildAnnotatedString {
                    if (prompt) withStyle(SpanStyle(color = muted)) { append("$ ") }
                    append(fold.shown)
                }, Modifier.testTag("tool-call:mono"), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, softWrap = false)
            }
            if (prompt) Text("Copy", Modifier.align(androidx.compose.ui.Alignment.TopEnd).background(MaterialTheme.colorScheme.surface, RoundedCornerShape(4.dp))
                .clickable(role = Role.Button) { clipboard.setText(AnnotatedString(text)) }.padding(horizontal = 6.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelSmall, color = muted)
        }
        fold.toggle?.let { more ->
            Text(if (open) ToolCalls.showLess else more, Modifier.padding(top = 6.dp).clickable(role = Role.Button) { open = !open }
                .testTag("tool-call:fold"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
        }
    }
}
