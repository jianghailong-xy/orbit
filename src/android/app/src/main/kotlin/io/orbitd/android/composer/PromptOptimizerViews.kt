package io.orbitd.android.composer

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.promptoptimizer.PromptOptimization
import io.orbitd.android.core.promptoptimizer.PromptOptimizer
import io.orbitd.android.core.promptoptimizer.PromptOptimizerCopy
import kotlinx.coroutines.delay

// Prompt optimizer in the composer (board docs/mocks/prompt-optimizer/01-board.png, frames 2–6), as iOS's PromptOptimizerViews.swift
// draws it on a phone: the ✦ Optimize button, the suggestion as a sheet over the composer, the failure line and the Undo toast. Every
// rule is core's (PromptOptimizer, PromptOptimizerState); these only draw it.

/** The tint of text the optimizer added from context (frame 4): iOS's `Color.green.opacity(0.18)`. */
private val AddedTint = Color(0xFF34C759).copy(alpha = 0.18f)

/** How long frame 5's Undo stays offered after Use, as on iOS. */
internal const val PROMPT_OPTIMIZER_UNDO_MILLIS = 8_000L

/** The suggestion's text: what context added tinted and `code` spans monospaced, the backticks dropped. */
internal fun promptOptimizationText(optimization: PromptOptimization): AnnotatedString = buildAnnotatedString {
    PromptOptimizer.runs(optimization.segments).forEach { run ->
        withStyle(SpanStyle(background = if (run.added) AddedTint else Color.Unspecified,
            fontFamily = if (run.code) FontFamily.Monospace else null)) { append(run.text) }
    }
}

/** Frame 2's ✦ Optimize beside Send, and frame 3's busy "Optimizing…", which cancels when pressed. */
@Composable
internal fun PromptOptimizeButton(busy: Boolean, enabled: Boolean, compact: Boolean = false, press: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // Where the toolbar has no room for the words (board composer-usage-tap 04, option C), a 36 dp circle with ✦ alone — or the
    // spinner while busy — said aloud as the full button is.
    Row(Modifier.padding(horizontal = 2.dp).testTag("composer-optimize")
        .semantics { contentDescription = if (busy) "${PromptOptimizerCopy.OPTIMIZING} ${PromptOptimizerCopy.CANCEL_HELP}" else PromptOptimizerCopy.OPTIMIZE_HELP }
        .clip(RoundedCornerShape(50))
        .background(if (busy) muted.copy(alpha = 0.08f) else accent.copy(alpha = 0.10f), RoundedCornerShape(50))
        .border(1.dp, if (busy) muted.copy(alpha = 0.25f) else accent.copy(alpha = 0.25f), RoundedCornerShape(50))
        .clickable(enabled = enabled, role = Role.Button, onClick = press)
        .then(if (compact) Modifier.size(36.dp) else Modifier.heightIn(min = 32.dp).padding(horizontal = 10.dp)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = if (compact) Arrangement.Center else Arrangement.spacedBy(5.dp)) {
        if (compact) {
            if (busy) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 1.5.dp, color = muted)
            else Text("✦", color = accent, style = MaterialTheme.typography.labelLarge)
        } else if (busy) {
            CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = muted)
            Text(PromptOptimizerCopy.OPTIMIZING, color = muted, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        } else {
            Text("✦", color = accent, style = MaterialTheme.typography.labelLarge)
            Text(PromptOptimizerCopy.OPTIMIZE, color = accent, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
    }
}

/**
 * Frame 4 on a phone: the suggestion as a bottom sheet over the composer (iOS's `.sheet` with medium and large detents). Its text with
 * what context added tinted, "Show in <language>" when there is a gloss, the "Used:" chips, and Use / Edit, then use / Try again; × —
 * or the system back, or a swipe down — dismisses, the draft kept. The box changes only on Use.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PromptOptimizationSheet(optimization: PromptOptimization, basedOnEarlierDraft: Boolean, showingGloss: Boolean,
    ownerLanguage: String, toggleGloss: () -> Unit, use: () -> Unit, editThenUse: () -> Unit, tryAgain: () -> Unit, dismiss: () -> Unit) {
    // Opened whole, never half: the card is already no taller than half the screen, as iOS's medium detent.
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), modifier = Modifier.testTag("composer-optimization-sheet")) {
        PromptOptimizationCard(optimization, basedOnEarlierDraft, showingGloss, ownerLanguage, toggleGloss, use, editThenUse, tryAgain, dismiss)
    }
}

/** The sheet's body: header, words, gloss toggle and chips, then the actions — always in view, however long the words are. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PromptOptimizationCard(optimization: PromptOptimization, basedOnEarlierDraft: Boolean, showingGloss: Boolean,
    ownerLanguage: String, toggleGloss: () -> Unit, use: () -> Unit, editThenUse: () -> Unit, tryAgain: () -> Unit, dismiss: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // iOS's medium detent: about half the screen, the words scrolling inside it and the toggle, chips and actions always in view.
    val tallest = (LocalConfiguration.current.screenHeightDp * 0.5f).dp
    Column(Modifier.fillMaxWidth().heightIn(max = tallest).testTag("composer-optimization-card")) {
        Row(Modifier.fillMaxWidth().background(accent.copy(alpha = 0.08f)).padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("✦", color = accent)
            Text(PromptOptimizerCopy.CARD_TITLE, Modifier.weight(1f), color = accent, style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold)
            IconButton(onClick = dismiss, modifier = Modifier.testTag("composer-optimization-dismiss")
                .semantics { contentDescription = PromptOptimizerCopy.DISMISS }) { Text("✕", color = muted) }
        }
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (basedOnEarlierDraft) Text(PromptOptimizerCopy.BASED_ON_EARLIER_DRAFT, style = MaterialTheme.typography.bodySmall, color = muted)
            SelectionContainer {
                val gloss = optimization.gloss
                if (showingGloss && gloss != null) Text(gloss, Modifier.testTag("composer-optimization-text"), style = MaterialTheme.typography.bodyLarge)
                else Text(promptOptimizationText(optimization), Modifier.testTag("composer-optimization-text"), style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (optimization.gloss != null || optimization.chips.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (optimization.gloss != null) Text(PromptOptimizerCopy.agentReceives(optimization.promptLanguage),
                    Modifier.testTag("composer-optimization-agent-note"), style = MaterialTheme.typography.bodySmall, color = muted)
                if (optimization.gloss != null) Text(
                    if (showingGloss) PromptOptimizerCopy.showPrompt(optimization.promptLanguage) else PromptOptimizerCopy.showIn(ownerLanguage),
                    Modifier.testTag("composer-optimization-gloss").clickable(role = Role.Button, onClick = toggleGloss).padding(vertical = 4.dp),
                    color = accent, style = MaterialTheme.typography.labelLarge)
                if (optimization.chips.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(PromptOptimizerCopy.USED, Modifier.align(Alignment.CenterVertically), style = MaterialTheme.typography.labelMedium, color = muted)
                    optimization.chips.forEach { chip ->
                        Text(chip, Modifier.testTag("composer-optimization-chip")
                            .border(BorderStroke(1.dp, muted.copy(alpha = 0.3f)), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 3.dp),
                            style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1)
                    }
                }
            }
        }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = use, modifier = Modifier.testTag("composer-optimization-use")) { Text(PromptOptimizerCopy.USE) }
            FilledTonalButton(onClick = editThenUse, modifier = Modifier.testTag("composer-optimization-edit")) { Text(PromptOptimizerCopy.EDIT_THEN_USE) }
            TextButton(onClick = tryAgain, modifier = Modifier.testTag("composer-optimization-retry")) { Text(PromptOptimizerCopy.TRY_AGAIN) }
        }
    }
}

/** Frame 6: "Couldn't optimize this draft. Try again" over the box. The draft is untouched. */
@Composable
internal fun PromptOptimizationFailureLine(retry: () -> Unit, dismiss: () -> Unit) {
    val red = MaterialTheme.colorScheme.error
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("composer-optimization-failed")
        .background(red.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).border(1.dp, red.copy(alpha = 0.25f), RoundedCornerShape(8.dp))
        .padding(start = 12.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(PromptOptimizerCopy.FAILED, color = red, style = MaterialTheme.typography.bodySmall)
        Text(PromptOptimizerCopy.TRY_AGAIN, Modifier.testTag("composer-optimization-failed-retry").clickable(role = Role.Button, onClick = retry)
            .padding(vertical = 8.dp), color = red, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium,
            textDecoration = TextDecoration.Underline)
        Spacer(Modifier.weight(1f))
        IconButton(onClick = dismiss, modifier = Modifier.size(36.dp).semantics { contentDescription = PromptOptimizerCopy.DISMISS }) {
            Text("✕", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Frame 5: "Draft replaced with the optimized prompt · Undo", for [PROMPT_OPTIMIZER_UNDO_MILLIS] after Use, then [expired]. */
@Composable
internal fun PromptOptimizationUndoToast(undo: () -> Unit, expired: () -> Unit) {
    LaunchedEffect(Unit) { delay(PROMPT_OPTIMIZER_UNDO_MILLIS); expired() }
    Row(Modifier.padding(vertical = 4.dp).testTag("composer-optimization-undo-toast")
        .background(Color.Black.copy(alpha = 0.85f), RoundedCornerShape(8.dp)).padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(PromptOptimizerCopy.REPLACED, color = Color.White, style = MaterialTheme.typography.bodySmall)
        Text(PromptOptimizerCopy.UNDO, Modifier.testTag("composer-optimization-undo").clickable(role = Role.Button, onClick = undo)
            .padding(horizontal = 8.dp, vertical = 10.dp), color = Color(0xFF8CB3FF), style = MaterialTheme.typography.bodySmall,
            textDecoration = TextDecoration.Underline)
    }
}
