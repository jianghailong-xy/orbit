package io.orbitd.android.reader

import io.orbitd.android.core.drive.DriveChatLogic

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.orbitd.android.core.realtime.*
import io.orbitd.android.core.cards.AntigravityRepair
import io.orbitd.android.core.cards.DshRuntime
import io.orbitd.android.core.cards.QuestionRecords
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.cards.SessionMessageNote
import io.orbitd.android.core.cards.BackgroundWakeCard
import io.orbitd.android.core.cards.BgJob
import io.orbitd.android.core.cards.OrbitEvent
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.cards.OrbitEventLine
import io.orbitd.android.cards.LocalSteerDeliveries
import io.orbitd.android.cards.TranscriptCardView
import io.orbitd.android.cards.isOrbitTurnCard
import io.orbitd.android.cards.conversationCard
import io.orbitd.android.cards.DetailFold
import io.orbitd.android.core.translation.Translation
import io.orbitd.android.directory.ExternalSender
import io.orbitd.android.translation.LocalShownOriginals
import io.orbitd.android.translation.BilingualEnglish
import io.orbitd.android.translation.BilingualShown
import io.orbitd.android.translation.InterleavedReply
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.translation.ReplyTranslationFoot
import io.orbitd.android.translation.ShownOriginals
import io.orbitd.android.translation.TranslationShown
import io.orbitd.android.translation.UserTranslationFoot
import io.orbitd.android.management.RunnerUpdateNow
import io.orbitd.android.text.*
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.wiki.RelativeTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** Where a row reads an event whole when it came back `truncated`: the owner's reader ([SessionReaderModel]), or the guest door
 * (GuestSessionPage). */
internal fun interface FullEvents { suspend fun full(seq: Long): RunEvent }

/** The heading of a `user` row that names no other sender: the reader's own words, `You` — and in the guest view, where the
 * conversation is the owner's, the owner's name (GuestSessionPage); the guest's own are attributed to the reader there. */
internal val LocalOwnerHeading = staticCompositionLocalOf { ExternalSender.you }

/** The cards that are lines in the agent's stream, each the whole of a turn Orbit opened for its own news. */
private val WAKE_LINE_KEYS = listOf(":workflow", ":subagent", ":wake", ":watch")

@Composable
internal fun TranscriptRowView(row: TranscriptRow, model: FullEvents, live: Transcript?, open: (String) -> Unit, highlighted: Boolean = false,
    detailOnly: Boolean = false, target: Long? = null) {
    // The turns Orbit opened, folded with their answers (ExchangeFold): [target] opens the way down to a record a link landed on.
    if (row.exchanges.isNotEmpty()) {
        ExchangeFoldView(row, target) { folded -> TranscriptRowView(folded, model, live, open, folded.contains(target ?: -1), target = target) }
        return
    }
    if (row.steps.isNotEmpty()) {
        Box(Modifier.background(if (highlighted) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface)) {
            StepsRowView(row, model, live, open, highlighted)
        }
        return
    }
    val event = row.event
    // Orbit's own SubAgent is one folded block of its own (board docs/mocks/subagent/03.png).
    if (!detailOnly && event.type == "tool_use" && (event.fields.string("name") ?: event.fields.string("toolName")) == SubagentBlock.TOOL_NAME) {
        SubagentBlockView(row, highlighted) { child -> TranscriptRowView(child, model, live, open) }
        return
    }
    // A bg_run call is its job's card from start to end (board 350t1lTONlrPMjilBdXx7, web `JobCard`); one refused, or whose answer names
    // no job, stays a call.
    if (!detailOnly && event.type == "tool_use" && (event.fields.string("name") ?: event.fields.string("toolName")) == BgJob.TOOL) {
        val result = row.result
        val failed = result?.fields?.string("isError") == "true" || result?.fields?.string("is_error") == "true"
        val receipt = result?.let { BgJob.receipt(contentText(it.fields["content"]) ?: it.fields.string("result")) }
        if (!failed && (result == null || receipt != null)) {
            JobCardView(event, receipt, highlighted)
            return
        }
    }
    // So is an Orbit workflow, which opens to its calls by phase (board docs/mocks/subagent-workflow part 4).
    if (!detailOnly && event.type == "tool_use" && (event.fields.string("name") ?: event.fields.string("toolName")) == WorkflowBlock.TOOL_NAME) {
        WorkflowBlockView(row, highlighted) { child -> TranscriptRowView(child, model, live, open) }
        return
    }
    val clipboard = LocalClipboardManager.current
    var expanded by rememberSaveable(row.key) { mutableStateOf(false) }
    var childrenOpen by rememberSaveable(row.key) { mutableStateOf(false) }
    var fullEvent by remember(row.event) { mutableStateOf<RunEvent?>(null) }
    var fullResult by remember(row.result) { mutableStateOf<RunEvent?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    var copyOverflow by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val shown = fullEvent ?: event
    val result = fullResult ?: row.result
    val tool = event.type in setOf("tool_use", "tool_result")
    val cards = remember(shown) { transcriptCards(shown) }
    // The turns Orbit opens for its own news — a background job's news or a wakeup coming due, a watch's wake — are lines
    // in the agent's stream (owner 2026-11-16: they must not look like something the reader sent): no "Orbit" heading, no row tint, no Copy
    // message — the lines are the whole row, as on the web and iOS.
    // A turn carrying only Orbit's blocks that no line knows is the generic From Orbit line, never the reader's row (OrbitEvent).
    if (event.type == "user") {
        val note = shown.fields.string("controlPlaneNote")
        val words = shown.personWords()
        val wakeLines = cards.isNotEmpty() && cards.all { card -> WAKE_LINE_KEYS.any { card.key.endsWith(it) } } &&
            (words.isBlank() || cards.any { it.key.endsWith(":watch") })
        val orbitOnly = cards.isEmpty() && OrbitEvent.draws(words, note, (shown.fields["attachments"] as? JsonArray).orEmpty().isNotEmpty())
        // A SubAgent's end draws nothing: like Claude Code's built-in Agent, the SubAgent is one card from start to end, and that card
        // draws how it ended (SubagentCardEnd, joined by run id). Its card still keeps the turn from being the reader's bubble or the From
        // Orbit line; only a job's news written beside it draws, as it always has.
        // So does a background job's end, new output or stall (board C1): the job is one card from start to end (JobCardView, joined by
        // job id). Only a wakeup that came due beside it draws its line.
        val drawn = if (wakeLines) cards.filterNot { it.key.endsWith(":subagent") || it.key.endsWith(":wake") && BgJob.wakeupsOnly(it.source) == null }
            else cards
        if (wakeLines && drawn.isEmpty()) return
        if (wakeLines || orbitOnly) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp).testTag(row.key), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (orbitOnly) {
                    val delivery = event.turnId?.let { LocalSteerDeliveries.current[it] } ?: shown.fields.string("delivery")
                    val undelivered = delivery == "failed"
                    OrbitEventLine(note!!.trim(), event.ts, BackgroundWakeCard.steerReceipt(
                        BackgroundWakeCard.steerState(shown.fields["steer"] == JsonPrimitive(true), delivery, undelivered)), undelivered)
                } else {
                    drawn.forEach { TranscriptCardView(it, open, shown) }
                }
            }
            return
        }
    }
    // A note-only turn with no card draws nothing, including no row padding.
    val loneNote = shown.fields.string("controlPlaneNote")
    if (event.type == "user" && cards.isEmpty() && shown.fields["sessionMessage"] !is JsonObject &&
        BackgroundWakeCard.drawsNoteAlone(shown.personWords(), (shown.fields["attachments"] as? JsonArray).orEmpty().isNotEmpty(), loneNote, queued = false)) {
        return
    }
    // Settings › Translation (board frames 4–6): the owner's message as they wrote it and the agent's reply in their language, each
    // with its own flip to the English, held by the reader so a recycled row keeps its side.
    val shownOriginals = LocalShownOriginals.current
    val turnTranslation = if (event.type == "user") Translation.turn(shown.fields["translation"]) else null
    val replyTranslation = if (event.type == "assistant" && event.parent().isNullOrEmpty()) Translation.shownReply(shown.fields["translation"], shown.body()) else null
    val translationKey = if (event.type == "user") ShownOriginals.user(event.seq, event.turnId) else ShownOriginals.reply(event.seq)
    // "Show both languages" (02-bilingual.png): your language on top, the English under it, no flip.
    val bilingual = LocalTranslation.current.bilingual
    val flipped = !bilingual && shownOriginals?.has(translationKey) == true
    // "Hide original" leaves this message's own language alone (docs/mocks/translation-hide-original); per message, never kept.
    val hiddenKey = ShownOriginals.hidden(translationKey)
    val originalHidden = bilingual && shownOriginals?.has(hiddenKey) == true
    val showsBoth = bilingual && !originalHidden
    fun shownWords(source: RunEvent): String = when {
        source.type == "user" -> TranslationShown.userWords(source.personWords(), Translation.turn(source.fields["translation"]), flipped)
        source.type == "assistant" && source.parent().isNullOrEmpty() -> TranslationShown.replyWords(source.body(), Translation.shownReply(source.fields["translation"], source.body()), flipped)
        else -> source.body()
    }
    // The owner's answer handed to the coordinator: the row is its one line (`OwnerAnswerLineView`), not a message under a heading. So is
    // a fact told to this session (`CoordinatorDeliveryLineView`), also when the outcomes of this session's requests ride on the same
    // turn: the line first, then their reply cards (web `Transcript.tsx`'s session-replies branch).
    val answerLine = cards.firstOrNull()?.takeIf { line ->
        event.type == "user" && (line.key.endsWith(":ownerAnswer") && cards.size == 1 ||
            line.key.endsWith(":coordinatorDelivery") && cards.drop(1).all { it.key.contains(":reply:") } ||
            // An Orbit turn drawn as its own card (`OrbitTurnCardView`) carries its block in its own fold: the row is the card alone.
            isOrbitTurnCard(line) && cards.drop(1).all { it.key.contains(":reply:") })
    }
    // Another session's message is its bubble (SessionMessageBubble): no row heading, no tint across the row.
    val bubble = cards.firstOrNull { it.key.endsWith(":sessionMessage") }
    /** [reveal]: a failed read opens the card to say so — except for a question card reading itself whole while folded. */
    fun loadFull(copy: Boolean = false, reveal: Boolean = true) { scope.launch {
        loading = true; error = false
        try {
            if (fullEvent == null && event.truncated) fullEvent = model.full(event.seq)
            if (fullResult == null && row.result?.truncated == true) fullResult = model.full(row.result.seq)
            if (copy) {
                val source = if (tool) fullResult ?: row.result ?: fullEvent ?: event else fullEvent ?: event
                // Copy copies the version on screen (board frame 5).
                val value = shownWords(source).ifBlank { source.fields["input"]?.toString() ?: source.payload.toString() }
                if (value.length > COPY_TEXT_LIMIT) copyOverflow = value else clipboard.setText(AnnotatedString(value))
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { error = true; if (reveal) expanded = true }
        finally { loading = false }
    } }
    val resultText = result?.let { contentText(it.fields["content"]) ?: it.fields.string("result") }
    val isError = result?.fields?.string("isError") == "true" || result?.fields?.string("is_error") == "true"
    // A06-15: an agent's question, once it has ended, is the record of it — what was asked and how it was answered (iOS 94f61b52c).
    val questions = remember(shown) {
        if (event.type == "tool_use" && (shown.fields.string("name") ?: shown.fields.string("toolName")) == "AskUserQuestion")
            QuestionRecords.questions(shown.fields["input"]) else emptyList()
    }
    val outcome = remember(questions, resultText, isError) { if (questions.isEmpty()) null else QuestionRecords.outcome(questions, resultText, isError) }
    var questionOpen by rememberSaveable(row.key) { mutableStateOf<Boolean?>(null) }
    // A result this reader cannot read, once it is whole: its own words are the only answer there is, so the card opens on them.
    val questionShown = questionOpen ?: (outcome == null && !isError && !resultText.isNullOrEmpty() && (row.result?.truncated != true || fullResult != null))
    // The folded card is the record, so it reads a clipped call and result whole while still folded: the questions' text, or
    // the answers after the cut, would otherwise be missing from the one place they are shown.
    LaunchedEffect(row.key, questions.isNotEmpty()) { if (questions.isNotEmpty() && (event.truncated || row.result?.truncated == true)) loadFull(reveal = false) }
    val title = when (event.type) {
        "user" -> if (cards.isNotEmpty()) "Orbit" else (event.fields["sessionMessage"] as? JsonObject)?.let { "From ${it.string("fromTitle") ?: "another Orbit session"}" }
            // Somebody other than the owner — a connected Feishu group's member (`externalSender`, docs/feishu-bot-design.md §8.2), or
            // a guest the owner invited (docs/session-guests-design.md §3): their words, headed `From Feishu · <name>` or `From <name>`
            // so they do not read as the owner's own (web `.chat-user-from`, OrbitKit `UserBubbleView`).
            ?: ExternalSender.parse(event.fields["externalSender"])?.let(ExternalSender::label) ?: LocalOwnerHeading.current
        "assistant" -> "Assistant"
        "thinking" -> "Thinking"
        "tool_use" -> if (questions.isNotEmpty()) "Question" else shown.fields.string("name") ?: shown.fields.string("toolName") ?: "Tool"
        "tool_result" -> "Tool output"
        // Nobody pressed Stop on a turn the runner tore down while restarting (runner-go's watchShutdownDrain): say what did.
        "interrupt" -> when (event.fields.string("reason")) {
            "runner_restart" -> "Interrupted — the runner restarted"
            // The owner's Update Now stopped it to install a release (docs/runner-update-drain-design.md D4).
            RunnerUpdateNow.INTERRUPT_REASON -> RunnerUpdateNow.interruptedTitle(event.fields.string("targetVersion"))
            else -> "Interrupted"
        }
        "error", "auth_error" -> "Error"
        "notice", "diagnostic", "auth_settled" -> "Notice"
        "auto_retry" -> EngineErrors.autoRetryTitle(shown.fields.string("variant") == "quota", shown.body())
        "background_task" -> "Background work"
        else -> event.type.replace('_', ' ').replaceFirstChar(Char::uppercase)
    }
    // The turn Orbit sent to continue a turn the owner's Update Now cut: Orbit's words, written for the agent, so one grey Orbit line
    // rather than a message in the reader's name (web `runner-update-resume`).
    val updateResume = event.type == "user" && RunnerUpdateNow.isResume(shown.fields.string("text"))
    // The turn Orbit queued when an owner request ended: prose and JSON for the agent, so one divider (web `owner-request-turn-divider`).
    val requestEnding = if (event.type == "user") OwnerRequests.resolutionTurnLabel(shown.fields.string("text")) else null
    // A person's turn as iOS draws it (`UserBubbleView`): a right-aligned tinted bubble with its copy and time under it, and over it
    // only the name of somebody who is not the reader — a Feishu member, a guest, the owner on a guest's page. Orbit's own turns,
    // another session's message and the dividers keep their rows.
    val userBubble = event.type == "user" && !detailOnly && cards.isEmpty() && answerLine == null && !updateResume && requestEnding == null
    val bg = when { highlighted -> MaterialTheme.colorScheme.secondaryContainer
        userBubble -> MaterialTheme.colorScheme.surface
        event.type == "user" && answerLine == null && bubble == null && !updateResume && requestEnding == null -> MaterialTheme.colorScheme.surfaceVariant
        else -> MaterialTheme.colorScheme.surface }
    // The runtime's calls whose work outlives them: a sub-agent (Agent; Task before 2.x) and a Workflow.
    val taskKind = (shown.fields.string("name") ?: shown.fields.string("toolName")).takeIf { event.type == "tool_use" && it in setOf("Agent", "Task", "Workflow") }
    val activity = LocalTaskActivity.current
    val progress = if (taskKind != null) activity?.progress(event.toolId()) else null
    // A07-4: an Antigravity failure on a session Antigravity runs is its repair card, in place of the line (iOS d2737d665).
    val console = LocalSessionConsole.current
    val repair = if (event.type == "error" || event.type == "assistant") AntigravityRepair.of(shown.body().trim())?.takeIf { console?.executesAntigravity == true } else null
    // A07-5: so is a DeepSeek Harness failure on a session Harness runs (iOS e789ce3dc).
    val dshRepair = if (event.type == "error") DshRuntime.repair(shown.body().trim())?.takeIf { console?.executesDsh == true } else null
    // A reply is the page's own text (iOS `AssistantBubbleView`): no heading, copied by selecting it, or by TalkBack's Copy message.
    val plainReply = event.type == "assistant" && !detailOnly && cards.isEmpty() && repair == null
    // A person's bubble and a plain reply sit on the list's own 16dp margin, as iOS's 16pt; other rows keep their 10dp inset.
    // Nor do they, or a stretch of reasoning, add any above or below: the list's 12dp between rows is iOS's 6 + 6 (`rowInsets`).
    val bare = !highlighted && (userBubble || plainReply || event.type == "thinking")
    Column(Modifier.fillMaxWidth().background(bg).padding(horizontal = if (userBubble || plainReply) 0.dp else 10.dp,
        vertical = if (bare) 0.dp else 10.dp).testTag(row.key)
        .then(if (plainReply) Modifier.semantics { customActions = listOf(CustomAccessibilityAction("Copy message") { loadFull(copy = true); true }) }
            else Modifier), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (answerLine != null) { cards.forEach { TranscriptCardView(it, open, shown) }; return@Column }
        if (updateResume) {
            Text(RunnerUpdateNow.RESUME_NOTE, Modifier.testTag("runner-update-resume"), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@Column
        }
        if (requestEnding != null) {
            Row(Modifier.fillMaxWidth().testTag("owner-request-turn-divider"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                HorizontalDivider(Modifier.weight(1f))
                Text(requestEnding, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider(Modifier.weight(1f))
            }
            return@Column
        }
        if (dshRepair != null && console != null) { Box(Modifier.conversationCard()) { DshRepairCard(dshRepair, console) }; return@Column }
        if (repair != null && console != null) { Box(Modifier.conversationCard()) { AntigravityRepairCard(repair, console) }; return@Column }
        if (event.type == "auto_retry" && console != null) {
            Box(Modifier.conversationCard()) { AutoRetryCard(AutoRetryNotice(shown.body(), shown.fields.string("variant") == "quota", shown.fields["stale"] == JsonPrimitive(true),
                shown.fields["afterUserMsg"] == JsonPrimitive(true)), console) }
            return@Column
        }
        // The main checkout's card (board 01) and an action's outcome line (board 03).
        if (event.type == MainCheckout.ROW_CARD) { MainCheckout.changedNotice(shown.fields)?.let { Box(Modifier.conversationCard()) { MainCheckoutCard(it, row.key, event.seq, event.ts) } }; return@Column }
        if (event.type == MainCheckout.ROW_RESULT) { MainCheckout.resultNotice(shown.fields)?.let { MainCheckoutResultRow(it) }; return@Column }
        // A person's turn as iOS draws it (`UserBubbleView`, UserBubble.kt): images and files over the bubble, the English the agent got
        // inside it under the words, then copy · time · the translation's press on the trailing edge.
        if (userBubble) {
            val atts = (shown.fields["attachments"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>().mapNotNull { a ->
                a.string("id")?.let { id -> Triple("orbit-attachment:$id", a.string("name") ?: "Attachment", a.string("mime")?.startsWith("image/") == true) }
            }
            val words = shownWords(shown)
            val doors = console?.composer
            val turnId = event.turnId
            val foot = turnTranslation?.let { turn -> @Composable {
                UserTranslationFoot(turn, flipped, { shownOriginals?.toggle(translationKey) ?: Unit },
                    retry = if (doors != null && turnId != null) ({ doors.translationAction("turns/$turnId/translation/retry") }) else null,
                    sendAsWritten = if (doors != null && turnId != null) ({ doors.translationAction("turns/$turnId/translation/send-as-written") }) else null,
                    bilingual = bilingual, originalHidden = originalHidden, onHideOriginal = shownOriginals?.let { { it.toggle(hiddenKey) } },
                    cancel = cancelHeldMessage(doors, shown))
            } }
            // A delivered translation's press ends the copy/time line; any other state of it is a line of its own under it (iOS `meta`).
            val delivered = turnTranslation?.state == Translation.TurnState.DONE
            // A steer's state stands in for its time, as on iOS.
            val time = if (row.steer == null) RelativeTime.format(event.ts) else null
            UserTurnColumn {
                if (title != ExternalSender.you) UserTurnSender(title)
                UserTurnAttachments(atts.filter { it.third }.map { it.first to it.second }, atts.filterNot { it.third }.map { it.first to it.second }, open)
                if (words.isNotBlank()) UserWordsBubble(words, BilingualShown.userEnglish(shown.personWords(), turnTranslation, showsBoth), open)
                // A Drive chat's message: the folder and selection delivery told its agent of (board drive-chat 02 ⑪).
                DriveChatLogic.noteLabel(shown.fields.string("controlPlaneNote"))?.let { OrbitAttachedLine(it) }
                if (shown.truncated) TextButton(enabled = !loading, onClick = { loadFull() }) { Text(if (error) "Couldn't load full message · Retry" else "Read full message") }
                if (words.isNotBlank() || time != null || (delivered && foot != null)) UserTurnMetaLine(lead = {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (words.isNotBlank()) UserTurnCopy { loadFull(copy = true, reveal = false) }
                        time?.let { UserTurnMetaText(it) }
                    }
                }, foot = if (delivered) foot else null, dotted = time != null)
                if (!delivered) foot?.invoke()
                row.steer?.let { steer ->
                    val personWords = shown.personWords().trim()
                    val composer = console?.composer?.takeIf { steer.delivery == "failed" && personWords.isNotEmpty() }
                    val loaded = composer?.state?.collectAsState()?.value?.loaded == true
                    SteerStateLine(steer, putBack = composer?.takeIf { loaded }?.let { box -> { box.putBack(personWords) } })
                }
            }
            return@Column
        }
        // A thinking row is its own one line (A06-11); a question card's line folds and opens it, as its record does.
        if (!detailOnly && event.type != "thinking" && bubble == null && !userBubble && !plainReply) Row(Modifier.fillMaxWidth().then(if (questions.isEmpty()) Modifier else Modifier
            .clickable(onClickLabel = if (questionShown) "Hide options" else "Show options", role = Role.Button) { questionOpen = !questionShown }
            .semantics { stateDescription = if (questionShown) "Expanded" else "Collapsed" }),
            horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            if (questions.isNotEmpty()) Text("▸", Modifier.padding(end = 6.dp).rotate(if (questionShown) 90f else 0f).clearAndSetSemantics { },
                color = MaterialTheme.colorScheme.outline, style = MaterialTheme.typography.labelLarge)
            Text(title, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium)
            // Several questions are told apart by their headers; the replay names each over its own question.
            questions.mapNotNull { it.header }.ifEmpty { null }?.joinToString("  ·  ")?.let { headers ->
                Text(headers, Modifier.padding(start = 6.dp).weight(1f, fill = false), color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            // A workflow's agents done out of all, an agent's tool calls.
            progress?.let(TaskProgressCopy::badge)?.let { badge -> Text(badge, Modifier.padding(start = 6.dp)
                .background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 5.dp, vertical = 1.dp),
                fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Spacer(Modifier.weight(1f))
            TextButton(enabled = !loading, onClick = { loadFull(copy = true) }) { Text("Copy message") }
        }
        if (questions.isNotEmpty()) {
            // Answered, or replied to in the conversation, the record says how it ended — a reply is never a red "Failed". A real
            // failure, a result still to come or one this reader cannot read says so as any call does.
            if (!detailOnly && outcome == null) Text(when { isError -> "Failed"; result != null -> "Complete"; else -> "Awaiting result" },
                color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            if (questionShown || detailOnly) {
                QuestionReplay(questions, outcome)
                // Once read, a question's result is only the replay said again; its own words show while they can't be read.
                if (outcome == null) resultText?.takeIf { it.isNotEmpty() }?.let { Text("Output", style = MaterialTheme.typography.labelMedium); CodeText(it) }
            } else QuestionFoldedLines(questions, outcome, Modifier.clickable(onClickLabel = "Show options") { questionOpen = true })
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (error) TextButton(onClick = { loadFull(reveal = false) }) { Text("Couldn't load full output · Retry") }
        } else if (tool) {
            val liveOutput = live?.toolOutputs?.get(event.toolId())?.string("content")
            // The call returned the moment its work started, so its own "Complete" would sit on work just begun.
            val taskRunning = taskKind != null && activity?.isRunning(event.toolId()) == true
            // Workflow progress rows open these same agents; the rest stay ordinary nested records.
            val shownAgents = progress?.agents.orEmpty().mapNotNull { it.transcriptKey }.toSet()
            val nested = row.children.filter { !(it.event.type == "tool_use" && it.event.toolId() in shownAgents) }
            // A06-17: folded and still running, a background task's card says what its sub-agent is on right now (iOS ea175e5af).
            // Once the sub-agent has relayed something, that line takes the progress line's place; until then the progress line stays.
            val liveLine = if (taskKind != null && !expanded && (taskRunning || result == null)) SubagentLiveLine.of(nested) else null
            if (taskKind == "Workflow") TaskProgressCopy.workflowTitle(shown.fields["input"], resultText, progress)?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (!detailOnly) {
                Text(when { isError -> "Failed"; taskRunning -> "Running"; result != null || event.type == "tool_result" -> "Complete"; else -> "Awaiting result" },
                    color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { expanded = !expanded; if (expanded && (shown.truncated || result?.truncated == true)) loadFull() }) {
                    Text(if (expanded) "Hide input and output" else "Show input and output")
                }
                if (liveLine != null) Text(liveLine, Modifier.testTag("subagent-live-line"), color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                else if (taskRunning) progress?.let(TaskProgressCopy::trayLine)?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            // The owner's "Chat about this" reply to one of Orbit's own cards: their message, drawn as their turns are, under the
            // call rather than left inside its output (web `OwnerChatBubble`, OrbitKit `OwnerChatReply`).
            if (!detailOnly) ownerChatWords(row)?.let { words ->
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(10.dp).testTag("owner-chat-reply"),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("You", style = MaterialTheme.typography.labelMedium)
                    MarkdownText(words, open = open)
                }
            }
            if (expanded || detailOnly) {
                // A workflow opens to its progress, its script folded under it; a sub-agent's totals close its transcript.
                if (taskKind == "Workflow" && progress != null) TaskProgressView(progress, row) { card ->
                    TranscriptRowView(card, model, live, open, detailOnly = true)
                }
                val script = ((shown.fields["input"] as? JsonObject)?.get("script") as? JsonPrimitive)?.contentOrNull
                if (taskKind == "Workflow" && script != null) {
                    var scriptOpen by rememberSaveable(row.key) { mutableStateOf(false) }
                    TextButton(onClick = { scriptOpen = !scriptOpen }) { Text((if (scriptOpen) "▾ " else "▸ ") + "Workflow script") }
                    if (scriptOpen) CodeText(script, "js")
                } else shown.fields["input"]?.let { input -> Text("Input", style = MaterialTheme.typography.labelMedium); CodeText(input.toString(), "json") }
                if (taskKind != null && taskKind != "Workflow" && progress != null) TaskProgressView(progress)
                // A launch receipt says only that the work started: hidden once the progress speaks for the work,
                // and always for an agent's ack. A workflow before any progress keeps it.
                val receipt = !isError && resultText != null && (if (taskKind == "Workflow") BackgroundReceipt.workflow(resultText) != null
                    else taskKind != null && BackgroundReceipt.agentId(resultText) != null)
                val output = (if (receipt && (progress != null || taskKind != "Workflow")) null else resultText)
                    ?: (if (result == null) contentText(shown.fields["content"]) ?: shown.fields.string("result") ?: liveOutput else null)
                output?.let { Text("Output", style = MaterialTheme.typography.labelMedium); CodeText(it) }
                contentImages((result ?: shown).fields["content"]).forEach { TranscriptImage(it, "Tool result image", open) }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (error) TextButton(onClick = { loadFull() }) { Text("Couldn't load full output · Retry") }
                if (nested.isNotEmpty()) {
                    Text("${nested.size} subagent records", style = MaterialTheme.typography.labelMedium)
                    nested.take(4).forEach { child -> TranscriptRowView(child, model, live, open) }
                    if (nested.size > 4) TextButton(onClick = { childrenOpen = true }) { Text("Open subagent transcript") }
                }
            } else liveOutput?.let { Text(it.takeLast(240), maxLines = 3, style = MaterialTheme.typography.bodySmall) }
        } else if (event.type in setOf("error", "notice", "diagnostic", "auto_retry", "auth_settled")) {
            EngineLine(shown)
            if (shown.truncated) TextButton(enabled = !loading, onClick = { loadFull() }) { Text(if (error) "Couldn't load full message · Retry" else "Read full message") }
        } else if (event.type == "thinking") {
            // A06-11 (iOS 471b2afbb, d55e9900b): settled, a stretch of reasoning folds to one line that says what it cost —
            // adjacent blocks folded into it — and opens to the reasoning itself.
            val text = remember(row) { row.thinkingText() }
            val label = remember(row, text) { ThinkingSummary.settledLabel(text.length, row.blocks, row.thinkingMs()) }
            ThinkingFold(label, expanded) { expanded = !expanded }
            if (expanded) {
                CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant) { MarkdownText(text, open = open) }
                TextButton(onClick = { if (text.length > COPY_TEXT_LIMIT) copyOverflow = text else clipboard.setText(AnnotatedString(text)) }) { Text("Copy message") }
            }
        } else if (event.type == "interrupt") {
            // The title is the whole row, as on web and iOS: the payload is the runner's bookkeeping (the request a Stop answered, the
            // restart's reason), which the body below would print as raw JSON.
        } else Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val atts = (shown.fields["attachments"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
            val attachmentOnly = shown.type == "user" && shown.body().isBlank() && atts.isNotEmpty()
            // Delivery's appended note stays out of the person's words and is never rendered separately.
            val sessionNote = if (shown.fields["sessionMessage"] is JsonObject) SessionMessageNote.split(shown.fields.string("controlPlaneNote")) else null
            val words = shownWords(shown)
            // A reply still to be translated is the English greyed, with its chip under it (2A).
            val pendingReply = replyTranslation == null && row.awaitsTranslation
            cards.forEach { if (it === bubble) SessionMessageBubble(it.source, shown, open, words, revealed = highlighted) else TranscriptCardView(it, open, shown) }
            if (cards.isEmpty() && !attachmentOnly) { if (shown.fields.string("controlPlaneNote").isNullOrBlank() || words.isNotBlank()) {
                // Both languages, block by block, when the reply pairs with its translation (03-interleaved.png).
                val pairs = if (event.type == "assistant") BilingualShown.replyPairs(shown.body(), replyTranslation, showsBoth) else null
                if (pairs != null) InterleavedReply(pairs, open)
                else if (pendingReply) CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant) {
                    MarkdownText(words.ifBlank { shown.payload.toString() }, open = open)
                } else MarkdownText(words.ifBlank { shown.payload.toString() }, open = open)
                // The English the agent read or wrote, below its dashed divider; a long reply's collapsed (frame 3).
                (if (event.type == "user") BilingualShown.userEnglish(shown.personWords(), turnTranslation, showsBoth)
                    else if (event.type == "assistant") BilingualShown.replyEnglish(shown.body(), replyTranslation, showsBoth) else null)
                    ?.let { BilingualEnglish(it, collapsible = event.type == "assistant") }
            } }
            val doors = console?.composer
            val toggle = { shownOriginals?.toggle(translationKey) ?: Unit }
            val hide = shownOriginals?.let { { it.toggle(hiddenKey) } }
            turnTranslation?.let { turn ->
                val turnId = event.turnId
                UserTranslationFoot(turn, flipped, toggle,
                    retry = if (doors != null && turnId != null) ({ doors.translationAction("turns/$turnId/translation/retry") }) else null,
                    sendAsWritten = if (doors != null && turnId != null) ({ doors.translationAction("turns/$turnId/translation/send-as-written") }) else null,
                    bilingual = bilingual, originalHidden = originalHidden, onHideOriginal = hide, cancel = cancelHeldMessage(doors, shown))
            }
            if (event.type == "assistant") ReplyTranslationFoot(replyTranslation, pendingReply, flipped, toggle,
                retry = if (doors != null && event.seq > 0) ({ doors.translationAction("events/${event.seq}/translation/retry") }) else null,
                bilingual = bilingual, originalHidden = originalHidden, onHideOriginal = hide)
            atts.forEach { attachment -> attachment.string("id")?.let { id ->
                val name = attachment.string("name") ?: "Attachment"
                if (attachment.string("mime")?.startsWith("image/") == true) TranscriptImage("orbit-attachment:$id", name, open)
                else TextButton(onClick = { open("orbit-attachment:$id") }) { Text(name) }
            } }
            // A message naming no sender session draws no bubble: it says whose it is not under its words.
            if (bubble == null && shown.fields["sessionMessage"] is JsonObject)
                Text("Sent by another Orbit session, not by you", style = MaterialTheme.typography.bodySmall)
            // A sender that runs narrower than this session: the one fact of its block the bubble does not show (SessionMessageNote).
            sessionNote?.narrower?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f)) }
            // How a steer of the reader's came out; words that never reached the engine are offered back to the composer.
            row.steer?.let { steer ->
                val words = shown.personWords().trim()
                val composer = console?.composer?.takeIf { steer.delivery == "failed" && words.isNotEmpty() }
                val loaded = composer?.state?.collectAsState()?.value?.loaded == true
                SteerStateLine(steer, putBack = composer?.takeIf { loaded }?.let { box -> { box.putBack(words) } })
            }
            if (shown.truncated) TextButton(enabled = !loading, onClick = { loadFull() }) { Text(if (error) "Couldn't load full message · Retry" else "Read full message") }
        }
    }
    copyOverflow?.let { LongTextDialog(it) { copyOverflow = null } }
    if (childrenOpen) Dialog({ childrenOpen = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) { Column {
            TextButton(onClick = { childrenOpen = false }) { Text("Close subagent transcript") }
            val shownAgents = progress?.agents.orEmpty().mapNotNull { it.transcriptKey }.toSet()
            LazyColumn { items(row.children.filter { !(it.event.type == "tool_use" && it.event.toolId() in shownAgents) }, key = { it.key }) {
                TranscriptRowView(it, model, live, open) } }
        } }
    }
}

/**
 * How a steer of the reader's came out, under its words (web `SteerState` and `UserBubble`'s undelivered line, OrbitApp's meta line): its
 * state in every client's words — in the warning tone once it did not land or nobody can say it did, the server's reason a long press
 * away — then [why] it did not land in the sender's words, and [putBack], its words' way back to the composer.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SteerStateLine(steer: SteerOutcome, why: String? = null, putBack: (() -> Unit)? = null) {
    val undelivered = SteerDelivery.undelivered(steer.delivery)
    val tone = if (undelivered) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.testTag("steer-state")) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            val label = @Composable {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (undelivered) Text("⚠", Modifier.clearAndSetSemantics { }, color = tone, style = MaterialTheme.typography.labelSmall)
                    Text(SteerDelivery.label(steer.delivery), color = tone, style = MaterialTheme.typography.labelSmall)
                }
            }
            val reason = steer.reason?.takeIf { undelivered && it.isNotBlank() }
            if (reason == null) label()
            else TooltipBox(TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above), tooltip = { PlainTooltip { Text(reason) } },
                state = rememberTooltipState()) { label() }
            putBack?.let { TextButton(onClick = it, Modifier.testTag("steer-state:put-back")) {
                Text(SteerDelivery.PUT_BACK, style = MaterialTheme.typography.labelSmall)
            } }
        }
        why?.takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
    }
}

/**
 * A failure or heads-up the engine reported, drawn as iOS's label: red for an error, the warning tone at label size for a notice,
 * and a recoverable diagnostic grey behind the warning mark ([DiagnosticLine]).
 */
@Composable
private fun EngineLine(event: RunEvent) {
    val text = event.body()
    when (event.type) {
        "error" -> ToolFailureSummary.parse(text)?.let { ToolFailureCard(text, it) }
            ?: GlyphLine("⚠", text, MaterialTheme.colorScheme.error, MaterialTheme.typography.bodyLarge)
        // An account switch the conversation has moved past is history, muted with the sign-in failure it came with.
        "notice" -> GlyphLine("⚠", text, if (event.fields["settled"] == JsonPrimitive(true)) MaterialTheme.colorScheme.onSurfaceVariant
            else LocalOrbitColors.current.needsYou, MaterialTheme.typography.labelLarge)
        "auth_settled" -> SettledAuthLine(text, event.fields["resolved"] == JsonPrimitive(true))
        "diagnostic" -> {
            val line: @Composable () -> Unit = {
                DiagnosticLine(event.fields.string("label").orEmpty(), EngineStderr.logText(text),
                    (event.fields["repeats"] as? JsonPrimitive)?.intOrNull ?: 1)
            }
            val console = LocalSessionConsole.current
            // The sandbox warning offers the agent that installs what Codex wants (docs/mocks/codex-sandbox-fix-with-agent);
            // every other diagnostic stays a plain row.
            if (event.fields.string("component") == "sandbox" && event.fields.string("code") == "bubblewrap_missing" && console != null)
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) { line(); SandboxFixCard(console) }
            else line()
        }
        // The self-healing failure's sentence; the card around it (countdown, Retry) is the auto-retry card's.
        else -> GlyphLine("◷", text, MaterialTheme.colorScheme.onSurfaceVariant, MaterialTheme.typography.bodyMedium)
    }
}

/**
 * A recoverable diagnostic, drawn as web draws `.chat-notice.chat-diagnostic` (iOS `DiagnosticNoticeRow`): only the mark keeps the
 * warning tone; the label is dim, the engine's words are in the secondary text colour, and the repeats folded into the row are a
 * dimmed count after them. "Copy message" copies the whole logged line.
 */
@Composable
private fun DiagnosticLine(label: String, text: String, repeats: Int) {
    val warning = LocalOrbitColors.current.needsYou
    val dim = MaterialTheme.colorScheme.outline
    val style = MaterialTheme.typography.labelLarge
    val small = MaterialTheme.typography.bodySmall
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("⚠", Modifier.alignByBaseline().clearAndSetSemantics { }, color = warning, style = style)
        if (label.isNotEmpty()) Text(label, Modifier.alignByBaseline(), color = dim, style = small)
        SelectionContainer(Modifier.alignByBaseline().weight(1f, fill = false)) {
            Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = style)
        }
        if (repeats > 1) Text("×$repeats", Modifier.alignByBaseline(), color = warning.copy(alpha = 0.7f), style = small)
    }
}

@Composable
private fun GlyphLine(glyph: String, text: String, color: Color, style: TextStyle) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(glyph, color = color, style = style, modifier = Modifier.clearAndSetSemantics { })
        SelectionContainer { Text(text, color = color, style = style) }
    }
}

/** A sign-in failure the conversation moved past (web `.chat-authfix-settled`, iOS `AuthErrorCardView.settledRow`): one muted line,
 * a check once the agent worked again, and the runtime's words a tap away. */
@Composable
private fun SettledAuthLine(message: String, resolved: Boolean) {
    var expanded by rememberSaveable(message) { mutableStateOf(false) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val style = MaterialTheme.typography.labelLarge
    Column(Modifier.fillMaxWidth().testTag("auth-settled"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth().clickable(onClickLabel = if (expanded) "Hide message" else "Show message", role = Role.Button) { expanded = !expanded },
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (resolved) "✓" else "⚠", Modifier.clearAndSetSemantics { }, color = if (resolved) LocalOrbitColors.current.success else muted, style = style)
            Text(if (resolved) "Sign-in failed — resolved" else "Sign-in failed", Modifier.weight(1f), color = muted, style = style)
            Text(if (expanded) "⌄" else "›", Modifier.clearAndSetSemantics { }, color = muted, style = style)
        }
        if (expanded) SelectionContainer { Text(message, color = muted, style = MaterialTheme.typography.bodySmall) }
    }
}

/** A tool's failure folded to the call, its path and a stable reason, with the engine's whole log one tap away (iOS `ToolFailureCardView`). */
@Composable
private fun ToolFailureCard(message: String, summary: ToolFailureSummary) {
    var expanded by rememberSaveable(message) { mutableStateOf(false) }
    val error = MaterialTheme.colorScheme.error
    Column(Modifier.conversationCard().testTag("tool-failure-card").drawBehind { drawRect(error, size = size.copy(width = 3.dp.toPx())) }.padding(start = 11.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(summary.tool ?: "Tool call", Modifier.weight(1f, fill = false), fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Failed", color = error, style = MaterialTheme.typography.labelLarge, maxLines = 1)
        }
        summary.path?.let { Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.StartEllipsis) }
        Text(summary.reason, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide full log" else "Show full log") }
        if (expanded) SelectionContainer {
            Text(message, Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(8.dp),
                fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

