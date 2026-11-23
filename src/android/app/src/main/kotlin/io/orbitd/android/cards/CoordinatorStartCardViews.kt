package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.reader.personWords
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.JsonPrimitive

// The three cards a coordinator conversation draws after a project starts (board-4; OrbitKit `CriteriaDecisionReceiptCard`,
// `AcceptanceConfirmationReceiptCard`, `ProjectStartedCardView`), in place of the generic cards and the dimmed "When is this project
// done?" preview that stood for them. Their words are core's `CriteriaReceipt`, `StartReceipt` and `ProjectStartedCopy`.

/** The settings a start left a project running with, in one line (OrbitKit `RunSettings.parts`, web `runSettingsParts`). */
object RunSettingsSummary {
    const val mergeCheckSet = "merge check set"
    const val noMergeCheck = "no merge check"
    const val settingDiffers = "Not what the coordinator suggested"

    data class Part(val key: String, val text: String, val differs: Boolean)

    /** "project/34yca… · Automatic on · 3 tasks at a time · merge check set", every part the owner changed marked. */
    fun parts(settings: JsonObject, differs: List<String> = emptyList()): List<Part> {
        val tasks = settings.number("maxConcurrentTasks")
        val line = when {
            settings.text("line") == "MAIN" -> RunSettings.lineMain(RunSettings.mainBranchName(settings.text("upstreamRef")))
            !settings.text("projectBranchName").isNullOrEmpty() -> RunSettings.shortBranch(settings.text("projectBranchName")!!)
            else -> RunSettings.lineProjectBranch
        }
        val automatic = (settings["automatic"] as? JsonPrimitive)?.booleanOrNull == true
        return listOf(
            Part("line", line, "line" in differs),
            Part("automatic", "${RunSettings.automatic} ${if (automatic) "on" else "off"}", "automatic" in differs),
            Part("maxConcurrentTasks", "$tasks ${RunSettings.tasksAtATime(tasks)}", "maxConcurrentTasks" in differs),
            Part("mergeCheckCommand", if (settings.text("mergeCheckCommand").isNullOrEmpty()) noMergeCheck else mergeCheckSet,
                "mergeCheckCommand" in differs),
        )
    }

    fun line(settings: JsonObject, differs: List<String> = emptyList()) = parts(settings, differs).joinToString(" · ") { it.text }

    /** The same line for a reader who cannot see the bold: every changed setting followed by what that means. */
    fun spokenLine(settings: JsonObject, differs: List<String>) =
        parts(settings, differs).joinToString(" · ") { if (it.differs) "${it.text} ($settingDiffers)" else it.text }
}

/** The run-settings line, every setting the owner changed from the coordinator's suggestion in bold. */
@Composable
internal fun RunSettingsSummaryText(settings: JsonObject, differs: List<String>, modifier: Modifier = Modifier) {
    val parts = RunSettingsSummary.parts(settings, differs)
    Text(buildAnnotatedString {
        parts.forEachIndexed { index, part ->
            if (index > 0) append(" · ")
            if (part.differs) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(part.text) } else append(part.text)
        }
    }, modifier.semantics { contentDescription = RunSettingsSummary.spokenLine(settings, differs) },
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** A receipt's chrome (iOS `approvalChrome`): the tone's wash and border, rounded as the conversation's decision cards are. */
@Composable
private fun ReceiptFrame(tag: String, tone: Color, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().testTag(tag).background(tone.copy(alpha = 0.07f), RoundedCornerShape(14.dp))
        .border(1.dp, tone.copy(alpha = 0.28f), RoundedCornerShape(14.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
}

/** The receipt's head: a round check in the frame's tone, and "Decision recorded" (iOS `ApprovalHeader`). */
@Composable
private fun ReceiptHead(title: String, tone: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(22.dp).background(tone.copy(alpha = 0.16f), RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
            Icon(painterResource(R.drawable.ic_check), null, Modifier.size(14.dp), tint = tone)
        }
        Text(title, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold))
    }
}

@Composable
private fun Provenance() = Text(CriteriaReceipt.provenance, style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
    color = MaterialTheme.colorScheme.onSurfaceVariant)

/** "▸ What this approved · …": a reading control, closed by default, never disabled. */
@Composable
private fun Disclosure(tag: String, label: String, open: Boolean, toggle: () -> Unit) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.clickable(role = Role.Button, onClick = toggle).semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
        .padding(vertical = 4.dp).testTag(tag), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.Top) {
        Text("▸", Modifier.rotate(if (open) 90f else 0f).clearAndSetSemantics { }, color = secondary, style = MaterialTheme.typography.labelMedium)
        Text(label, color = secondary, style = MaterialTheme.typography.bodySmall)
    }
}

/** A criterion's words, a stored rewrite struck through and underlined in place. */
private fun runs(words: List<CriterionRun>, secondary: Color): AnnotatedString = buildAnnotatedString {
    words.forEach { run ->
        when (run.side) {
            CriterionRun.Side.KEPT -> append(run.text)
            CriterionRun.Side.REMOVED -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough, color = secondary)) { append(run.text) }
            CriterionRun.Side.ADDED -> withStyle(SpanStyle(textDecoration = TextDecoration.Underline)) { append(run.text) }
        }
    }
}

/**
 * The receipt an answered criteria proposal leaves (OrbitKit `CriteriaDecisionReceiptCard`, web `.criteria-decision`): orange like the
 * question it answers (D1 A), its verdict and check mark green, and under it, folded, what the answer was about.
 */
@Composable
internal fun CriteriaReceiptCard(card: InteractionCard) {
    val settled = card.source
    val warning = LocalOrbitColors.current.needsYou
    val success = LocalOrbitColors.current.success
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val fold = remember(settled) { CriteriaReceipt.fold(settled) }
    var open by rememberSaveable(card.key) { mutableStateOf(false) }
    var unchangedOpen by rememberSaveable(card.key) { mutableStateOf(false) }
    ReceiptFrame(card.key, warning) {
        ReceiptHead(CriteriaReceipt.heading, warning)
        Text(CriteriaReceipt.line(settled), Modifier.testTag("${card.key}:line"),
            style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = success)
        if (fold != null) {
            Disclosure("${card.key}:fold", fold.summary, open) { open = !open }
            if (open) Column(Modifier.padding(start = 14.dp).testTag("${card.key}:fold-open"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                fold.legend?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary) }
                fold.rows.forEach { row ->
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(buildAnnotatedString {
                            withStyle(SpanStyle(color = secondary)) { append(row.ordinal?.let { "$it. " } ?: "• ") }
                            append(runs(row.words, secondary))
                        }, style = MaterialTheme.typography.bodyMedium)
                        Text(row.badge, style = MaterialTheme.typography.labelSmall, color = warning)
                        row.method?.let { method ->
                            Text(buildAnnotatedString { append("${CriteriaReceipt.methodLabel}: "); append(runs(method, secondary)) },
                                style = MaterialTheme.typography.labelSmall, color = secondary)
                        }
                    }
                }
                fold.unchangedLine?.let { line ->
                    Disclosure("${card.key}:unchanged", line, unchangedOpen) { unchangedOpen = !unchangedOpen }
                    if (unchangedOpen) fold.unchanged.forEach { row ->
                        Text("${row.ordinal?.let { "$it. " } ?: ""}${row.text}", style = MaterialTheme.typography.labelMedium, color = secondary)
                    }
                }
                fold.note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = secondary) }
            }
        }
        Provenance()
    }
}

/**
 * The record the start left (OrbitKit `AcceptanceConfirmationReceiptCard`, web `AcceptanceConfirmationReceipt`): blue, a green tick,
 * "You started the project on 5 criteria", the settings it was pressed with, "by you at …" and the fold of what was confirmed. A later
 * confirmation that started nothing says what it confirmed instead, and has no settings line.
 */
@Composable
internal fun StartReceiptCard(card: InteractionCard) {
    val confirmation = card.source
    val blue = MaterialTheme.colorScheme.primary
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    ReceiptFrame(card.key, blue) {
        ReceiptHead(StartReceipt.heading, blue)
        Text(StartReceipt.line(confirmation), Modifier.testTag("${card.key}:line"), style = MaterialTheme.typography.bodyLarge)
        StartReceipt.startedSettings(confirmation)?.let {
            RunSettingsSummaryText(it, StartReceipt.startedDiffers(confirmation), Modifier.testTag("${card.key}:settings"))
        }
        Text(StartReceipt.stamp(confirmation), Modifier.testTag("${card.key}:stamp"),
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace), color = secondary)
        StartReceipt.fold(confirmation)?.let { ReceiptFold(it, card.key, indent = 0.dp) }
        Provenance()
    }
}

/**
 * The message telling a coordinator its project was started, drawn as a card (OrbitKit `ProjectStartedCardView`, web
 * `ProjectStartedCard`): how it was started, which project, what it runs with, and which tasks now wait on the coordinator because
 * they are set to start by hand, each a way into its task. The words the agent read fold at the foot.
 */
@Composable
internal fun ProjectStartedCardView(card: InteractionCard, event: RunEvent?, open: (String) -> Unit, undelivered: Boolean) {
    val started = remember(card.source) { ProjectStarted.parse(card.source) } ?: return
    val tone = MaterialTheme.colorScheme.primary
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    var allTasks by rememberSaveable(card.key) { mutableStateOf(false) }
    var told by rememberSaveable(card.key) { mutableStateOf(false) }
    val tasks = if (allTasks) started.held else started.held.take(ProjectStartedCopy.tasksShown)
    val unlisted = ProjectStartedCopy.unlisted(started)
    Column(Modifier.conversationCard().testTag("turn-project-started")
        .background(tone.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).border(1.dp, tone.copy(alpha = 0.30f), RoundedCornerShape(8.dp))
        .padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(painterResource(R.drawable.ic_play), null, Modifier.size(16.dp), tint = tone)
            Text(ProjectStartedCopy.label(started.by), Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = tone, maxLines = 1)
            Text(ProjectStartedCopy.kind(started.by), Modifier.background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(50))
                .border(1.dp, tone.copy(alpha = 0.30f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
                style = MaterialTheme.typography.labelSmall, color = secondary, maxLines = 1)
        }
        Text(started.projectTitle, style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold))
        started.settings?.let { RunSettingsSummaryText(it, started.differsFromRequest, Modifier.testTag("turn-project-started:settings")) }
        Text(ProjectStartedCopy.lead(started), style = MaterialTheme.typography.bodyMedium)
        if (tasks.isNotEmpty()) Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 2.dp).testTag("turn-project-started:tasks")) {
            tasks.forEachIndexed { index, task ->
                if (index > 0) HorizontalDivider()
                Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open("orbit-task:${task.id}") }.padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(task.title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = tone)
                    Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(12.dp), tint = secondary)
                }
            }
        }
        ProjectStartedCopy.tasksToggle(started, allTasks)?.let {
            Text(it, Modifier.clickable(role = Role.Button) { allTasks = !allTasks }.padding(vertical = 4.dp),
                style = MaterialTheme.typography.labelMedium, color = tone)
        }
        if (unlisted > 0 && (allTasks || started.held.size <= ProjectStartedCopy.tasksShown)) {
            Text(ProjectStartedCopy.moreInProject(unlisted), Modifier.clickable(role = Role.Button) { open("orbit-project:${started.projectId}") }
                .padding(vertical = 4.dp), style = MaterialTheme.typography.labelMedium, color = tone)
        }
        Text(ProjectStartedCopy.meta(started, event?.ts?.let { BackgroundWakeCard.relative(it) }), Modifier.testTag("turn-project-started:meta"),
            style = MaterialTheme.typography.labelSmall, color = secondary)
        if (undelivered) Text(ProjectStartedCopy.undelivered, style = MaterialTheme.typography.labelSmall, color = LocalOrbitColors.current.needsYou)
        val words = event?.personWords()?.trim().orEmpty()
        Disclosure("turn-project-started:told", ProjectStartedCopy.told, told) { told = !told }
        if (told && words.isNotEmpty()) SelectionContainer {
            Text(words, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(6.dp))
                .padding(8.dp).testTag("turn-project-started:words"), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
        }
    }
}
