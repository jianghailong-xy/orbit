package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.core.cards.OwnerRequestStep
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.core.cards.TerminalRequest
import io.orbitd.android.management.Terminals
import io.orbitd.android.text.MarkdownText
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What a session asked the owner to do (web `OwnerRequestCard`), drawn the same in the conversation that asked and in the "Waiting on
 * you" inbox. Pending it is the whole request; once ended it is one line saying how, who and when ([OwnerRequestResolved]). [runner]
 * names a runner by the name the owner knows it by. [focusInput]: opened from a push's action, the card takes the focus on its input —
 * the key's field, the answer's words, or Mark done.
 */
@Composable
fun OwnerRequestCard(request: OwnerRequest, store: OwnerRequestStore, runner: (String?) -> String, open: (String) -> Unit,
    now: Instant = Instant.now(), focusInput: Boolean = false) {
    if (!request.pending) { OwnerRequestResolved(request, store, runner, now); return }
    val state by store.state.collectAsState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val tag = "owner-request:${request.id}"
    val runnerName = runner(request.secretSpec?.runnerId)
    // The key is held in this card's state only: never saved, never in a URL, a view model or a cache, gone with the card.
    var value by remember(request.id) { mutableStateOf("") }
    var save by remember(request.id) { mutableStateOf(false) }
    var saveAs by remember(request.id) { mutableStateOf(request.secretSpec?.name.orEmpty()) }
    var savedId by remember(request.id) { mutableStateOf<String?>(null) }
    var chosen by remember(request.id) { mutableStateOf(request.recommendedOption) }
    var text by remember(request.id) { mutableStateOf("") }
    var declining by remember(request.id) { mutableStateOf(false) }
    var reason by remember(request.id) { mutableStateOf("") }
    var busy by remember(request.id) { mutableStateOf(false) }
    var failure by remember(request.id) { mutableStateOf<String?>(null) }
    var later by remember(request.id) { mutableStateOf(false) }
    LaunchedEffect(request.kind) { if (request.kind == OwnerRequests.SECRET) store.loadSavedSecrets() }

    val closed = OwnerRequests.pastDeadline(request, now)
    val grant = request.secretGrant.takeIf { request.kind == OwnerRequests.SECRET }
    val delivering = grant?.state == "PENDING_DELIVERY"
    val removing = grant?.state == "REMOVING"
    val failed = grant?.state == "REMOVED" && grant.endReason == "DELIVERY_FAILED"
    val ready = OwnerRequests.ready(request, value, save, saveAs, savedId, chosen, text)
    fun press(door: suspend io.orbitd.android.core.cards.OwnerRequestsApi.() -> OwnerRequest) {
        busy = true; failure = null
        scope.launch { failure = store.act(door); busy = false }
    }
    fun pressPrimary() {
        when (request.kind) {
            OwnerRequests.SECRET -> {
                val typed = value; val saved = savedId; val name = saveAs.trim().takeIf { save }
                // Cleared before the press goes: nothing typed outlives it on screen.
                value = ""; save = false; savedId = null
                press { if (saved != null) provideSaved(request.id, saved) else provide(request.id, typed, name) }
            }
            OwnerRequests.DECISION -> { val words = text.trim().takeIf { it.isNotEmpty() }; press { done(request.id, chosen, words) } }
            else -> press { done(request.id) }
        }
    }

    val focus = remember { FocusRequester() }
    val shown = remember { BringIntoViewRequester() }
    if (focusInput) LaunchedEffect(request.id) {
        delay(100)
        shown.bringIntoView()
        runCatching { focus.requestFocus() }
    }

    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag(tag).bringIntoViewRequester(shown)
        .background(tone.copy(alpha = 0.07f), RoundedCornerShape(14.dp)).border(1.dp, tone.copy(alpha = 0.28f), RoundedCornerShape(14.dp))
        .padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).background(tone, RoundedCornerShape(50)))
            Text(OwnerRequests.waitingOnYou, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = tone)
            Spacer(Modifier.weight(1f))
            Text(OwnerRequests.askedLine(request, now), Modifier.testTag("$tag:asked"), style = MaterialTheme.typography.labelSmall, color = secondary)
        }
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(request.title, Modifier.weight(1f).testTag("$tag:title"), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold))
            Text(OwnerRequests.kindTag(request.kind), Modifier.background(tone.copy(alpha = 0.16f), RoundedCornerShape(50))
                .padding(horizontal = 8.dp, vertical = 2.dp).testTag("$tag:kind"), style = MaterialTheme.typography.labelSmall, color = tone)
        }
        if (request.why.isNotBlank()) MarkdownText(request.why, Modifier.testTag("$tag:why"), open)
        if (request.blocksTaskIds.isNotEmpty() || request.secretSpec != null) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (request.blocksTaskIds.isNotEmpty()) Fact(OwnerRequests.holdingUp, "$tag:holding") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    request.blocksTaskIds.forEach { id ->
                        Text(state.taskTitles[id] ?: OwnerRequests.task, Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50))
                            .clickable(role = Role.Button) { open("orbit-task:$id") }.padding(horizontal = 8.dp, vertical = 2.dp),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            request.secretSpec?.let { spec ->
                Fact(OwnerRequests.deliveredTo, "$tag:delivered-to") { Text(OwnerRequests.destination(spec, runnerName), style = MaterialTheme.typography.bodySmall) }
                Fact(OwnerRequests.removed, "$tag:removed") { Text(OwnerRequests.removedFact(request), style = MaterialTheme.typography.bodySmall) }
            }
        }

        if (request.kind == OwnerRequests.MANUAL_STEP) Steps(request.steps.orEmpty(), tag, open)
        if (request.kind == OwnerRequests.SECRET) request.secretSpec?.let { spec ->
            when {
                delivering -> {
                    Text(OwnerRequests.onItsWay(runnerName), Modifier.testTag("$tag:on-its-way"), style = MaterialTheme.typography.bodyMedium)
                    if (grant?.runnerOnline == false) Text(OwnerRequests.offline(runnerName, request.expiresAt?.let { OwnerReview.receiptTime(it, now) }),
                        style = MaterialTheme.typography.bodySmall, color = secondary)
                }
                removing -> {
                    grant?.let { OwnerRequests.grantLine(it, runnerName, now) }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    Text(OwnerRequests.enterAgain(runnerName), style = MaterialTheme.typography.bodySmall, color = secondary)
                }
                else -> {
                    if (OwnerRequests.removalToTell(grant)) grant?.let { OwnerRequests.grantLine(it, runnerName, now) }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = secondary)
                    }
                    val using = savedId
                    if (using != null) Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(OwnerRequests.usingSaved(state.savedSecrets.firstOrNull { it.id == using }?.label), Modifier.weight(1f).testTag("$tag:using-saved"))
                        TextButton(onClick = { savedId = null }) { Text(OwnerRequests.enterKeyInstead) }
                    } else {
                        OutlinedTextField(value, { value = it }, Modifier.fillMaxWidth().focusRequester(focus).testTag("$tag:secret"),
                            label = { Text(spec.name) }, placeholder = { Text(OwnerRequests.keyPlaceholder) }, singleLine = true,
                            visualTransformation = PasswordVisualTransformation(), enabled = !busy && !closed,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Done))
                        if (state.savedSecrets.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(OwnerRequests.useSaved, Modifier.align(Alignment.CenterVertically), style = MaterialTheme.typography.bodySmall, color = secondary)
                            state.savedSecrets.forEach { secret ->
                                AssistChip(onClick = { value = ""; save = false; savedId = secret.id }, label = { Text(secret.label) },
                                    modifier = Modifier.testTag("$tag:saved:${secret.id}"))
                            }
                        }
                        Row(Modifier.fillMaxWidth().toggleable(save, role = Role.Checkbox) { save = it }.testTag("$tag:save"),
                            verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(save, null)
                            Text(OwnerRequests.saveToAccount, style = MaterialTheme.typography.bodySmall)
                        }
                        if (save) OutlinedTextField(saveAs, { saveAs = it.take(100) }, Modifier.fillMaxWidth().testTag("$tag:save-as"),
                            label = { Text(OwnerRequests.saveAsLabel) }, singleLine = true)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(painterResource(R.drawable.ic_lock), null, Modifier.size(14.dp).padding(top = 2.dp), tint = secondary)
                        Text(OwnerRequests.secretNotice(spec, runnerName), Modifier.testTag("$tag:notice"), style = MaterialTheme.typography.bodySmall, color = secondary)
                    }
                }
            }
        }
        if (request.kind == OwnerRequests.DECISION) {
            val options = request.options.orEmpty()
            options.forEachIndexed { index, option ->
                Row(Modifier.fillMaxWidth().selectable(chosen == index, role = Role.RadioButton) { chosen = if (chosen == index) null else index }
                    .testTag("$tag:option:$index"), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(chosen == index, null)
                    Column(Modifier.weight(1f)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(option.label, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
                            if (request.recommendedOption == index) Text(OwnerRequests.recommended, style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary)
                        }
                        option.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = secondary) }
                    }
                }
            }
            OutlinedTextField(text, { text = it.take(4000) }, Modifier.fillMaxWidth().focusRequester(focus).testTag("$tag:answer"), enabled = !busy && !closed,
                placeholder = { Text(if (options.isEmpty()) OwnerRequests.yourAnswer else if (chosen != null) OwnerRequests.notePrompt else OwnerRequests.ownAnswerPrompt) },
                minLines = 2, maxLines = 8)
        }
        request.verifyHint?.let { Text(OwnerRequests.verifyHint(it), style = MaterialTheme.typography.bodySmall, color = secondary) }
        if (failed) Text("${OwnerRequests.didNotReach(runnerName)}. ${grant?.removalNote ?: "Enter it again."}", Modifier.testTag("$tag:failed"),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        failure?.let { Text("${OwnerRequests.notRecorded}: $it", Modifier.testTag("$tag:error"), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error) }

        if (declining) {
            OutlinedTextField(reason, { reason = it.take(2000) }, Modifier.fillMaxWidth().testTag("$tag:reason"),
                placeholder = { Text(OwnerRequests.declineReason) }, minLines = 2, maxLines = 6)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { val why = reason.trim(); press { decline(request.id, why) } }, Modifier.testTag("$tag:decline-send"),
                    enabled = reason.isNotBlank() && !busy && !closed) { Text(OwnerRequests.decline) }
                TextButton(onClick = { declining = false }) { Text(OwnerRequests.keepIt) }
            }
        } else FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (delivering) OutlinedButton(onClick = { press { cancelSecret(request.id) } }, Modifier.testTag("$tag:cancel"), enabled = !busy) {
                Text(OwnerRequests.cancel)
            } else Button(onClick = ::pressPrimary, (if (request.kind == OwnerRequests.MANUAL_STEP || request.kind == OwnerRequests.CONFIRM)
                Modifier.focusRequester(focus) else Modifier).testTag("$tag:primary"), enabled = ready && !busy && !closed && !removing) {
                Text(OwnerRequests.primary(request.kind))
            }
            TextButton(onClick = { declining = true }, Modifier.testTag("$tag:decline"), enabled = !closed) { Text(OwnerRequests.declineLabel(request.kind)) }
            val choices = OwnerRequests.snoozeChoices(request, now)
            Box {
                TextButton(onClick = { later = true }, Modifier.testTag("$tag:later"), enabled = choices.isNotEmpty()) { Text(OwnerRequests.remindLater) }
                DropdownMenu(later, { later = false }) {
                    choices.forEach { choice ->
                        DropdownMenuItem(text = { Text(choice.label) }, onClick = {
                            later = false
                            OwnerRequestSnoozes.of(context).snooze(request.id, System.currentTimeMillis() + choice.duration.toMillis())
                        }, modifier = Modifier.testTag("$tag:later:${choice.label}"))
                    }
                }
            }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        request.ifUnanswered?.let {
            Text(AnnotatedString(OwnerRequests.ifNobodyAnswers + " " + it), Modifier.testTag("$tag:if-unanswered"),
                style = MaterialTheme.typography.bodySmall, color = secondary)
        }
    }
}

/**
 * A terminal asking to be approved (docs/terminal-session-design.md, board 2 marker 7): the owner request card's frame, header and
 * buttons — no look of its own. Approve mints the terminal's credential for 30 days; Deny tells the terminal so. Either way the card
 * leaves once the door answers. iOS `TerminalApproveCard`, web `TerminalApproveCard.tsx`; the words are [Terminals]'.
 */
@Composable
fun TerminalApproveCard(request: TerminalRequest, store: OwnerRequestStore, now: Instant = Instant.now()) {
    val scope = rememberCoroutineScope()
    var busy by remember(request.id) { mutableStateOf(false) }
    var failure by remember(request.id) { mutableStateOf<String?>(null) }
    val tag = "terminal-request:${request.id}"
    fun decide(approve: Boolean) {
        busy = true; failure = null
        scope.launch { failure = store.decideTerminal(request, approve); busy = false }
    }
    val tone = LocalOrbitColors.current.needsYou
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().testTag(tag)
        .background(tone.copy(alpha = 0.07f), RoundedCornerShape(14.dp)).border(1.dp, tone.copy(alpha = 0.28f), RoundedCornerShape(14.dp))
        .padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(8.dp).background(tone, RoundedCornerShape(50)))
            Text(OwnerRequests.waitingOnYou, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = tone)
            Spacer(Modifier.weight(1f))
            Text("Asked ${OwnerRequests.ago(request.createdAt, now)}", Modifier.testTag("$tag:asked"), style = MaterialTheme.typography.labelSmall,
                color = secondary)
        }
        Text(Terminals.APPROVE_TITLE, Modifier.testTag("$tag:title"), style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Bold))
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(Terminals.requestLine(request), Modifier.testTag("$tag:line"), style = MaterialTheme.typography.bodyMedium, color = secondary)
            Text(Terminals.APPROVE_DETAIL, Modifier.testTag("$tag:detail"), style = MaterialTheme.typography.bodyMedium, color = secondary)
        }
        failure?.let { Text("${OwnerRequests.notRecorded}: $it", Modifier.testTag("$tag:error"), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { decide(approve = false) }, Modifier.weight(1f).testTag("$tag:deny"), enabled = !busy) { Text(Terminals.DENY) }
            Button(onClick = { decide(approve = true) }, Modifier.weight(1f).testTag("$tag:approve"), enabled = !busy) { Text(Terminals.APPROVE) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}

@Composable
private fun Fact(label: String, tag: String, content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().testTag(tag), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, Modifier.width(96.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.weight(1f)) { content() }
    }
}

@Composable
private fun Steps(steps: List<OwnerRequestStep>, tag: String, open: (String) -> Unit) {
    val clipboard = LocalClipboardManager.current
    Column(Modifier.testTag("$tag:steps"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        steps.forEachIndexed { index, step ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${index + 1}", Modifier.size(22.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50)).padding(top = 2.dp),
                    style = MaterialTheme.typography.labelMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(step.text, Modifier.testTag("$tag:step:$index"), style = MaterialTheme.typography.bodyMedium)
                    step.link?.let { link ->
                        val href = OwnerRequests.openableLink(link)
                        StepValue(link, if (href != null) OwnerRequests.open else null) { href?.let(open) }
                    }
                    step.command?.let { command ->
                        var copied by remember(command) { mutableStateOf(false) }
                        LaunchedEffect(copied) { if (copied) { delay(1_500); copied = false } }
                        StepValue(command, if (copied) OwnerRequests.copied else OwnerRequests.copy) { clipboard.setText(AnnotatedString(command)); copied = true }
                    }
                }
            }
        }
    }
}

@Composable
private fun StepValue(value: String, action: String?, onAction: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp)).padding(start = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(value, Modifier.weight(1f).padding(vertical = 6.dp), style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            maxLines = 3, overflow = TextOverflow.Ellipsis)
        action?.let { TextButton(onClick = onAction) { Text(it) } }
    }
}

/** A request that has ended, as one row (web `OwnerRequestResolved`): how, who, when, and from which device. */
@Composable
fun OwnerRequestResolved(request: OwnerRequest, store: OwnerRequestStore, runner: (String?) -> String, now: Instant = Instant.now()) {
    val scope = rememberCoroutineScope()
    var busy by remember(request.id) { mutableStateOf(false) }
    var failure by remember(request.id) { mutableStateOf<String?>(null) }
    val runnerName = runner(request.secretSpec?.runnerId.takeIf { request.kind == OwnerRequests.SECRET })
    val grant = OwnerRequests.resolvedGrant(request)
    val tag = "owner-request:${request.id}"
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val (icon, tint) = when (request.state) {
        "DONE" -> R.drawable.ic_check_circle to LocalOrbitColors.current.success
        "DECLINED" -> R.drawable.ic_x_circle to secondary
        "EXPIRED" -> R.drawable.ic_clock to secondary
        else -> R.drawable.ic_refresh to secondary
    }
    Row(Modifier.fillMaxWidth().testTag("$tag:resolved").background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
        .padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(icon), null, Modifier.size(18.dp).padding(top = 2.dp), tint = tint)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(request.title, Modifier.testTag("$tag:resolved-title"), style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(OwnerRequests.outcomeLine(request, runnerName), Modifier.testTag("$tag:outcome"), style = MaterialTheme.typography.bodySmall, color = secondary)
            grant?.let { OwnerRequests.grantLine(it, runnerName, now) }?.let {
                Text(it, Modifier.testTag("$tag:grant"), style = MaterialTheme.typography.bodySmall, color = secondary)
            }
            failure?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(OwnerRequests.byLine(request, now), Modifier.testTag("$tag:by"), style = MaterialTheme.typography.labelSmall, color = secondary)
            if (grant?.state == "ACTIVE") TextButton(onClick = {
                busy = true; failure = null
                scope.launch { failure = store.act { revokeSecret(request.id) }; busy = false }
            }, enabled = !busy, modifier = Modifier.testTag("$tag:revoke")) { Text(OwnerRequests.revoke) }
        }
    }
}

/** A request put off with Remind me later, folded in the conversation until it comes back. */
@Composable
fun OwnerRequestSnoozed(request: OwnerRequest, until: Long, now: Instant = Instant.now()) {
    val context = LocalContext.current
    val tag = "owner-request:${request.id}"
    Row(Modifier.fillMaxWidth().testTag("$tag:snoozed").dashedBorder(MaterialTheme.colorScheme.outline, 10.dp)
        .padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(painterResource(R.drawable.ic_clock), null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(request.title, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(OwnerRequests.reminder(OwnerReview.receiptTime(Instant.ofEpochMilli(until).toString(), now)), style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = { OwnerRequestSnoozes.of(context).wake(request.id) }, Modifier.testTag("$tag:show-now")) { Text(OwnerRequests.showNow) }
    }
}

/** One request where a conversation draws it: whole, folded for later, or as its summary. */
@Composable
fun OwnerRequestInConversation(request: OwnerRequest, store: OwnerRequestStore, runner: (String?) -> String, open: (String) -> Unit) {
    val snoozes by OwnerRequestSnoozes.of(LocalContext.current).state.collectAsState()
    // Drawn again when the reminder falls due.
    var due by remember(request.id) { mutableIntStateOf(0) }
    val now = Instant.now()
    val until = snoozes[OwnerRequests.key(request.id)] ?: 0
    if (until > now.toEpochMilli()) LaunchedEffect(until, due) { delay(until - System.currentTimeMillis()); due++ }
    when {
        !request.pending -> OwnerRequestResolved(request, store, runner, now)
        until > now.toEpochMilli() -> OwnerRequestSnoozed(request, until, now)
        else -> OwnerRequestCard(request, store, runner, open, now)
    }
}
