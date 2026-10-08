package io.orbitd.android.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.Instant

// "Start this project?" — the one card the owner starts a project on (ApprovalCards.swift `StartProjectCard`, web's
// `StartProjectCard`): what done is, how much is delegated and what still comes to the owner, and the plan by level, with
// Start and the line under it saying what pressing it does. The owner's own Start… draws it over the project page and the
// coordinator's request draws it in its conversation. Every word is `StartProjectCopy` / `RunSettings`.

/** One criterion a press confirms. */
data class StartCriterion(val ordinal: Int, val text: String)

/** The card itself, drawn from what it is given. A card nobody asked for (`asked` false) quotes nobody and offers no
 * Chat about this; a request that no longer stands is dimmed with Start dead and the reason above it. */
@Composable
internal fun StartProjectCard(
    projectId: String, projectTitle: String, asked: Boolean, askedAgo: String?, request: StartProjectCopy.Request,
    criteria: List<StartCriterion>, plan: StartProjectCopy.PlanView, hasCoordinator: Boolean, escalationSeconds: Int,
    draft: StartProjectCopy.Draft, onDraft: (StartProjectCopy.Draft) -> Unit, standing: StartProjectCopy.Standing,
    enabled: Boolean, starting: Boolean, error: String?, tag: String, startTag: String,
    onStart: () -> Unit, onViewTasks: () -> Unit, onChatAbout: (() -> Unit)? = null, chatEnabled: Boolean = true,
    trailing: @Composable () -> Unit = {},
) {
    val opensCoordinator = draft.automatic && !hasCoordinator
    val editable = enabled && standing == StartProjectCopy.Standing.LIVE && !starting
    var criteriaOpen by remember { mutableStateOf(false) }
    var whyOpen by remember { mutableStateOf(false) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val accent = MaterialTheme.colorScheme.primary
    Column(Modifier.fillMaxWidth().testTag(tag).alpha(if (StartProjectCopy.isOpen(standing)) 1f else 0.6f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("▶", Modifier.clearAndSetSemantics {}, color = accent, style = MaterialTheme.typography.titleMedium)
            Text(StartProjectCopy.title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = accent)
            trailing()
        }
        // Who is asking, and in their own words.
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(projectTitle, fontWeight = FontWeight.SemiBold)
            Text(if (asked) StartProjectCopy.askedLine(askedAgo) else StartProjectCopy.nobodyAskedLine(hasCoordinator), Modifier.testTag("$tag-asked"),
                style = MaterialTheme.typography.labelMedium, color = muted)
        }
        if (asked && request.why.isNotEmpty()) StartCardPanel {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(StartProjectCopy.coordinator, style = MaterialTheme.typography.labelMedium, color = muted)
                Text(request.why, style = MaterialTheme.typography.bodySmall, maxLines = if (whyOpen) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis)
                Text(if (whyOpen) StartProjectCopy.less else StartProjectCopy.more, Modifier.clickable(role = Role.Button) { whyOpen = !whyOpen }.testTag("$tag-why"),
                    style = MaterialTheme.typography.labelMedium, color = accent)
            }
        }
        StartProjectCopy.staleExplanation(standing)?.let {
            Text(it, Modifier.fillMaxWidth().background(accent.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 8.dp)
                .testTag("$tag-stale"), style = MaterialTheme.typography.labelMedium, color = muted)
        }

        // What done is: the criteria a press confirms, open, each clamped to two lines until the toggle.
        StartCardHead(StartProjectCopy.doneWhenHead(criteria.size))
        criteria.forEach { item -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("${item.ordinal}", Modifier.widthIn(min = 14.dp), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelMedium, color = muted,
                textAlign = TextAlign.End)
            Text(item.text, maxLines = if (criteriaOpen) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis)
        } }
        if (criteria.isNotEmpty()) Text(if (criteriaOpen) StartProjectCopy.showLess else StartProjectCopy.readAll(criteria.size),
            Modifier.clickable(role = Role.Button) { criteriaOpen = !criteriaOpen }.testTag("$tag-criteria"), style = MaterialTheme.typography.labelMedium, color = accent)
        Text(StartProjectCopy.explanation(criteria.size), style = MaterialTheme.typography.labelMedium, color = muted)

        // How much is delegated: Automatic first, with what it leaves the owner, then the three settings that can change later.
        StartCardHead(StartProjectCopy.howItRuns)
        StartCardPanel {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(RunSettings.automatic, Modifier.weight(1f))
                    Switch(draft.automatic, { onDraft(draft.copy(automatic = it)) }, enabled = editable,
                        modifier = Modifier.testTag("$tag-automatic").semantics { contentDescription = RunSettings.automatic })
                }
                Text(RunSettings.automaticSays(draft.automatic, draft.line, draft.hasMergeCheck), Modifier.testTag("$tag-automatic-says"),
                    style = MaterialTheme.typography.labelMedium, color = muted)
                if (opensCoordinator) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("✦", Modifier.clearAndSetSemantics {}, style = MaterialTheme.typography.labelMedium, color = muted)
                    Text(StartProjectCopy.opensCoordinator, Modifier.testTag("$tag-opens"), style = MaterialTheme.typography.labelMedium, color = muted)
                }
                ComesToYou(StartProjectCopy.comesToYou(draft.automatic, draft.line, plan.ownerConfirmed, plan.evidenceJudged, escalationSeconds), tag)
            }
            HorizontalDivider()
            LineRow(draft, request, projectId, editable, tag, onDraft)
            HorizontalDivider()
            MergeCheckRow(draft, editable, tag, onDraft)
            HorizontalDivider()
            Row(Modifier.padding(start = 12.dp, end = 6.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(RunSettings.atMost); Spacer(Modifier.weight(1f))
                Text("${draft.maxConcurrentTasks} ${RunSettings.tasksAtATime(draft.maxConcurrentTasks)}", Modifier.testTag("$tag-at-most"), color = muted, maxLines = 1)
                Stepper(draft.maxConcurrentTasks, 1..StartProjectCopy.maxConcurrentTasks, editable, "$tag-at-most") { onDraft(draft.copy(maxConcurrentTasks = it)) }
            }
        }
        Text(StartProjectCopy.howItRunsNote(asked, asked && !request.settings.automatic), Modifier.testTag("$tag-note"),
            style = MaterialTheme.typography.labelMedium, color = muted)

        // The plan by level — what starts now, what runs side by side, what needs the owner; the tasks one press away.
        StartCardHead(StartProjectCopy.planHead(plan.count, plan.levels?.size ?: 1))
        StartCardPanel {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                plan.levels?.forEachIndexed { at, level -> PlanLevel(at + 1, level, tag) }
                // Not while the start is out: leaving then would lose the server's answer to it.
                Text(StartProjectCopy.viewTasks, Modifier.clickable(enabled = !starting, role = Role.Button, onClick = onViewTasks).testTag("$tag-view-tasks"),
                    style = MaterialTheme.typography.bodySmall, color = accent)
            }
        }
        error?.let { Text(it, Modifier.testTag("$tag-error"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }

        // One press, one write; the line under it says what pressing it does.
        Button(onClick = onStart, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag(startTag),
            enabled = enabled && !starting && standing == StartProjectCopy.Standing.LIVE && draft.complete) { Text(StartProjectCopy.action) }
        onChatAbout?.let { chat ->
            OutlinedButton(onClick = chat, Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("$tag-chat"), enabled = chatEnabled && criteria.isNotEmpty()) {
                Text(CardVerb.CHAT.label) }
        }
        Text(StartProjectCopy.barCaption(opensCoordinator, plan.startsNow, criteria.size, StartProjectCopy.shortSeal(request.criteriaDigest)),
            Modifier.fillMaxWidth().testTag("$tag-caption"), style = MaterialTheme.typography.labelSmall, color = muted, textAlign = TextAlign.Center)
    }
}

/** The coordinator's request in its conversation (ApprovalCards.swift `StartProjectCardView`): the same card, drawn from the
 * open `START_REQUEST` the session read carries, its standing re-derived from that read on every render, and pressed at the
 * start door through the card actions (`CardVerb.START`, the request named). A press in flight or taken holds it live while
 * the read catches up, as `RequestedStartProjectSheet` does; a refusal stays on the card in the door's words. */
@Composable
fun CoordinatorStartCard(card: InteractionCard, reads: Map<String, JsonElement>, fresh: Boolean, result: CardActionState,
    open: (String) -> Unit, discuss: ((String) -> Unit)?, submit: (CardVerb, CardInput) -> Unit) {
    val doc = card.context
    val request = StartProjectCopy.request(card.source)
    // The settings as the owner leaves them, kept across recreation like the other cards' drafts; opened with Automatic on.
    var draft by rememberSaveable(card.key, card.binding, stateSaver = draftSaver) {
        mutableStateOf(request?.let { StartProjectCopy.Draft.of(it.settings) } ?: StartProjectCopy.Draft("PROJECT_BRANCH", true, 1))
    }
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (request == null) {
                // Nothing left to draw from: said, rather than drawn blank.
                Text(StartProjectCopy.title, Modifier.testTag(card.key), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Text(StartProjectCopy.requestGone, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                val pressed = result.busy || result.settled
                val standing = if (pressed) StartProjectCopy.Standing.LIVE else StartProjectCopy.standing(card.objectId, request,
                    reads["openItems"] as? JsonObject, reads["acceptanceConfirmation"] as? JsonObject, ProjectDoc.started(doc))
                val message = result.message
                val error = when {
                    message == null || pressed -> null
                    result.uncertain -> message
                    else -> "${StartProjectCopy.notRecorded} — $message"
                }
                val graph = (doc["plan"] as? JsonObject)?.let(DependencyGraph::of)
                val criteria = doc.objects("acceptanceCriteriaItems").sortedBy { it.number("ordinal") ?: 0 }
                    .map { StartCriterion(it.number("ordinal") ?: 0, it.text("text").orEmpty()) }
                val chat = discuss?.let { hand -> CardDiscussion.context(card)?.let { context -> { hand(context) } } }
                StartProjectCard(card.projectId.orEmpty(), doc.text("title").orEmpty(), asked = true,
                    askedAgo = ProjectTime.ago(card.source.text("waitingSince"), Instant.now()), request = request, criteria = criteria,
                    plan = StartProjectCopy.planView(graph, ProjectDoc.taskCount(doc)), hasCoordinator = true,
                    escalationSeconds = doc.number("exceptionEscalationSeconds") ?: StartProjectCopy.defaultEscalationSeconds,
                    draft = draft, onDraft = { draft = it }, standing = standing,
                    enabled = fresh && CardVerb.START in card.actions && !result.uncertain && !result.settled, starting = result.busy, error = error,
                    tag = card.key, startTag = "${card.key}:${CardVerb.START.name}",
                    onStart = { submit(CardVerb.START, CardInput(settings = ProjectStartSettings(draft.line, draft.automatic, draft.maxConcurrentTasks,
                        draft.mergeCheckCommand, request.settings.projectBranchName))) },
                    // The tasks the plan names, on the project's page (the browser's link when there is no list to open).
                    onViewTasks = { card.projectId?.let { open("orbit-project:$it") } },
                    onChatAbout = chat, chatEnabled = fresh && !result.busy)
                if (pressed) message?.let { Text(it, Modifier.testTag("card-result"), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant) }
                if (result.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
    }
}

private val draftSaver = listSaver<StartProjectCopy.Draft, Any>(
    save = { listOf(it.line, it.automatic, it.maxConcurrentTasks, it.mergeCheckCommand) },
    restore = { StartProjectCopy.Draft(it[0] as String, it[1] as Boolean, it[2] as Int, it[3] as String) })

/** What still comes to the owner once the project starts with these settings. */
@Composable
private fun ComesToYou(items: List<StartProjectCopy.ComesToYouItem>, tag: String) {
    val accent = MaterialTheme.colorScheme.primary
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().background(accent.copy(alpha = 0.10f), RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 8.dp)
        .testTag("$tag-comes-to-you"), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(StartProjectCopy.comesToYou.uppercase(), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = accent)
        items.forEach { item -> Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Text("•", Modifier.clearAndSetSemantics {}, style = MaterialTheme.typography.bodySmall, color = accent)
            Text(buildAnnotatedString {
                append(item.text)
                item.detail?.let { detail -> withStyle(SpanStyle(color = muted)) { append(" · $detail") } }
            }, style = MaterialTheme.typography.bodySmall)
        } }
    }
}

/** Where finished tasks land, picked from the platform's menu: each option with what choosing it means, the branch's own
 * name under its option, and the chosen one ticked. */
@Composable
private fun LineRow(draft: StartProjectCopy.Draft, request: StartProjectCopy.Request, projectId: String, editable: Boolean, tag: String,
    onDraft: (StartProjectCopy.Draft) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(RunSettings.tasksLandOn, Modifier.weight(1f))
        Box {
            TextButton(onClick = { menu = true }, enabled = editable, modifier = Modifier.testTag("$tag-line")) {
                Text("${if (draft.line == "MAIN") RunSettings.lineMain else RunSettings.lineProjectBranch} ▾", maxLines = 1) }
            DropdownMenu(menu, { menu = false }) {
                listOf(Triple("PROJECT_BRANCH", RunSettings.lineProjectBranch,
                    "${StartProjectCopy.branch(request.settings.projectBranchName, projectId)} — ${RunSettings.lineProjectBranchHint}"),
                    Triple("MAIN", RunSettings.lineMain, RunSettings.lineMainHint)).forEach { (value, title, hint) ->
                    DropdownMenuItem(text = { Column(Modifier.widthIn(max = 280.dp)) {
                        Text(if (draft.line == value) "✓ $title" else title); Text(hint, style = MaterialTheme.typography.labelSmall) } },
                        onClick = { menu = false; onDraft(draft.copy(line = value)) }, modifier = Modifier.testTag("$tag-line:$value"))
                }
            }
        }
    }
}

/** The check run on the combined tree before anything lands, folded to its value — Set, or None with what that means —
 * and opened to its command. An empty one is a setting like any other. */
@Composable
private fun MergeCheckRow(draft: StartProjectCopy.Draft, editable: Boolean, tag: String, onDraft: (StartProjectCopy.Draft) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { open = !open }.testTag("$tag-merge-check"), verticalAlignment = Alignment.CenterVertically) {
            Text(RunSettings.mergeCheck, Modifier.weight(1f))
            Text(if (draft.hasMergeCheck) RunSettings.mergeCheckSet else RunSettings.mergeCheckNone, Modifier.testTag("$tag-merge-check-value"), color = muted)
            Text(if (open) "  ▴" else "  ›", Modifier.clearAndSetSemantics {}, color = muted)
        }
        if (open) {
            OutlinedTextField(draft.mergeCheckCommand, { onDraft(draft.copy(mergeCheckCommand = it)) }, Modifier.fillMaxWidth().testTag("$tag-merge-check-command"),
                enabled = editable, placeholder = { Text(RunSettings.mergeCheckPlaceholder) },
                textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false))
            Text(RunSettings.mergeCheckHint, style = MaterialTheme.typography.labelMedium, color = muted)
        } else if (!draft.hasMergeCheck) Text(RunSettings.mergeCheckNoneSays, style = MaterialTheme.typography.labelMedium, color = muted)
    }
}

/** One level of the plan: its number, then the one task by label with Now / You, or several side by side. */
@Composable
private fun PlanLevel(number: Int, level: List<StartProjectCopy.LevelTask>, tag: String) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.testTag("$tag-level:$number"), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(20.dp).border(1.dp, muted.copy(alpha = 0.4f), CircleShape), contentAlignment = Alignment.Center) {
            Text("$number", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = muted)
        }
        val only = level.singleOrNull()
        if (only != null) {
            Text(only.label, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
            Text(StartProjectCopy.planTaskRest(only.title, only.label), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1,
                overflow = TextOverflow.Ellipsis)
            if (only.now) StartPill(StartProjectCopy.now, LocalOrbitColors.current.success)
            if (only.you) StartPill(StartProjectCopy.you, MaterialTheme.colorScheme.primary)
        } else {
            Text(level.joinToString(" · ") { it.label }, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
            Text(StartProjectCopy.inParallel(level.size), style = MaterialTheme.typography.labelMedium, color = muted)
        }
    }
}

/** "Now" and "You" beside a task of the plan. */
@Composable
private fun StartPill(text: String, tint: Color) = Text(text, Modifier.background(tint.copy(alpha = 0.16f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 1.dp),
    style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = tint)

/** A section's head: small, upper-cased, secondary. */
@Composable
private fun StartCardHead(title: String) = Text(title.uppercase(), Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelSmall,
    fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** The grouped panel the card's Plan and How it runs sit in, rows divided by hairlines. */
@Composable
private fun StartCardPanel(content: @Composable ColumnScope.() -> Unit) = Column(Modifier.fillMaxWidth()
    .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
    .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.18f), RoundedCornerShape(12.dp)), content = content)
