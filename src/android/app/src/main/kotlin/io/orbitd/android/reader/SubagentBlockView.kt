package io.orbitd.android.reader

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.text.CodeText
import io.orbitd.android.ui.LocalOrbitColors

/** The agent tone iOS draws the SubAgent's rail and ✦ in (`ToolTone.agent`). */
private val AgentTone = Color(0xFFAF52DE)

/**
 * Orbit's own SubAgent — a `mcp__orbit__delegate` call — as one folded block (board docs/mocks/subagent/03.png, iOS `ToolCardView`'s
 * delegate branch): ✦ SubAgent and the call's description with its status, the grey second line ([SubagentBlock.detailLine]) and, for a
 * run still going, the italic line saying what it is on. A tap opens the grey Why line, the SubAgent's own steps and what it handed back.
 * [child] draws a nested record as the transcript does.
 */
@Composable
internal fun SubagentBlockView(row: TranscriptRow, highlighted: Boolean, child: @Composable (TranscriptRow) -> Unit) {
    val event = row.event
    val id = event.toolId()
    val run = id?.let { LocalSubagentRuns.current[it] }
    val resultText = row.result?.let { contentText(it.fields["content"]) ?: it.fields.string("result") }
    val failed = row.result?.fields?.string("isError") == "true" || row.result?.fields?.string("is_error") == "true" ||
        run?.status == "FAILED"
    val block = SubagentBlock.describe(event.fields["input"], run, callRunning = row.result == null)
    val nested = row.children
    // What the opened block ends with; left out when the child's last message already says it (web `DelegateResult`).
    val handedBack = SubagentResult.text(resultText, run)?.takeIf { text ->
        val last = nested.lastOrNull()?.event
        !(last?.type == "assistant" && last.body().trim() == text.trim())
    }
    var open by rememberSaveable(row.key) { mutableStateOf(false) }
    val canOpen = block.why != null || nested.isNotEmpty() || handedBack != null
    val grey = MaterialTheme.colorScheme.onSurfaceVariant
    val description = (event.fields["input"] as? kotlinx.serialization.json.JsonObject)?.string("description")
    Column(Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface)
        .padding(horizontal = 10.dp, vertical = 6.dp).testTag(row.key)) {
        Column(Modifier.fillMaxWidth()
            .then(if (open) Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)) else Modifier)
            .drawBehind { drawRect(AgentTone, size = size.copy(width = 3.dp.toPx())) }
            .padding(start = 11.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth().testTag("subagent-row")
                .then(if (canOpen) Modifier.clickable(onClickLabel = if (open) "Hide steps" else "Show steps", role = Role.Button) { open = !open }
                    .semantics { stateDescription = if (open) "Expanded" else "Collapsed" } else Modifier),
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("›", Modifier.rotate(if (open) 90f else 0f).clearAndSetSemantics { }, color = MaterialTheme.colorScheme.outline,
                    style = MaterialTheme.typography.titleMedium)
                Text("✦", Modifier.clearAndSetSemantics { }, color = AgentTone, style = MaterialTheme.typography.labelLarge)
                Text("SubAgent", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelLarge)
                description?.let { Text(it, Modifier.weight(1f, fill = false), color = grey, fontWeight = FontWeight.Normal,
                    style = MaterialTheme.typography.labelLarge,
                    maxLines = 1, overflow = TextOverflow.Ellipsis) }
                when {
                    failed -> Text("Failed", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
                    block.running -> CircularProgressIndicator(Modifier.size(14.dp).testTag("subagent-running"), color = grey, strokeWidth = 2.dp)
                    else -> Text("✓", Modifier.semantics { stateDescription = "Complete" }, color = LocalOrbitColors.current.success,
                        fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
                }
            }
            // Board 03's narrow-screen line: type (or Background), tier, model and, once ended, duration and cost.
            Text(block.detailLine, Modifier.padding(start = 30.dp).testTag("subagent-detail"), color = grey,
                style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            // Folded and still going, what its sub-agent is on right now (A06-17's live line, in italics as on iOS).
            if (!open && block.running) SubagentLiveLine.of(nested)?.let {
                Text(it, Modifier.padding(start = 30.dp).testTag("subagent-live-line"), color = grey, fontFamily = FontFamily.Monospace,
                    fontStyle = FontStyle.Italic, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (open) {
                // The router's reasons first, then the steps, then the result (board 03).
                block.why?.let { why ->
                    Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append("Why") }; append(" · $why") },
                        Modifier.testTag("subagent-why"), color = grey, style = MaterialTheme.typography.bodyMedium)
                }
                if (nested.isNotEmpty()) Column(Modifier.drawBehind { drawRect(grey.copy(alpha = 0.3f), size = size.copy(width = 1.dp.toPx())) }
                    .padding(start = 6.dp)) {
                    remember(nested) { Steps.group(nested) }.forEach { child(it) }
                }
                handedBack?.let { Text("Output", style = MaterialTheme.typography.labelMedium); CodeText(it) }
            }
        }
    }
}
