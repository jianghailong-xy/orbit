package io.orbitd.android.cards

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.cards.OwnerRequest
import io.orbitd.android.core.cards.OwnerRequests
import io.orbitd.android.core.cards.ProjectReopenCopy
import io.orbitd.android.core.cards.ProjectReopenFacts
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.launch

// An agent asking to reopen a settled project (docs/project-reopen-request-design.md §6): the PROJECT_REOPEN card in the conversation that
// asked, and the same card as a row above the project page's header. Every word is `ProjectReopenCopy` in core; iOS `ProjectReopenViews.swift`.

/**
 * A PROJECT_REOPEN request: pending, the whole card; answered, one line saying how. [discuss] hands a talk about the request to the
 * conversation's composer; null on the project page, where Chat about this opens the decline form instead (the reason goes to the asking
 * session). [reopened] runs once Reopen is recorded, so the project page can read the project again.
 */
@Composable
fun ProjectReopenCard(request: OwnerRequest, store: OwnerRequestStore, discuss: ((String) -> Unit)? = null, onProjectPage: Boolean = false,
    reopened: () -> Unit = {}) {
    val tag = "owner-request:${request.id}"
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    if (!request.pending) {
        ProjectReopenFolded(request, tag)
        return
    }
    val scope = rememberCoroutineScope()
    val facts = remember(request) { ProjectReopenFacts.of(request) }
    var declining by remember(request.id) { mutableStateOf(false) }
    var reason by remember(request.id) { mutableStateOf("") }
    var busy by remember(request.id) { mutableStateOf(false) }
    var failure by remember(request.id) { mutableStateOf<String?>(null) }
    val tone = LocalOrbitColors.current.needsYou
    Column(Modifier.fillMaxWidth().testTag(tag).background(tone.copy(alpha = 0.03f), RoundedCornerShape(12.dp))
        .border(1.dp, tone.copy(alpha = 0.45f), RoundedCornerShape(12.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (onProjectPage) Text(ProjectReopenCopy.projectPageRow, Modifier.testTag("$tag:row-label"),
            style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = secondary)
        Text(ProjectReopenCopy.heading(request.title), Modifier.testTag("$tag:title"), style = MaterialTheme.typography.titleMedium)
        if (facts != null) Text(ProjectReopenCopy.settledLine(facts.statusAtAsk, facts.settledAt), Modifier.testTag("$tag:settled"),
            style = MaterialTheme.typography.bodySmall, color = secondary)
        if (request.why.isNotEmpty()) Labelled(ProjectReopenCopy.whyLabel, ProjectReopenCopy.agentSays(request.why), "$tag:why")
        facts?.plannedWork?.takeIf { it.isNotEmpty() }?.let { Labelled(ProjectReopenCopy.plannedWorkLabel, it, "$tag:planned") }
        val others = facts?.otherAskerTitles(request.askedBySessionId).orEmpty()
        listOfNotNull(if (onProjectPage) ProjectReopenCopy.askedBy(request.askedBySessionTitle) else null, ProjectReopenCopy.alsoAskedBy(others))
            .takeIf { it.isNotEmpty() }?.let { Text(it.joinToString(" · "), Modifier.testTag("$tag:askers"), style = MaterialTheme.typography.labelMedium, color = secondary) }
        failure?.let { Text("${OwnerRequests.notRecorded}: $it", Modifier.testTag("$tag:error"), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.error) }
        if (declining) {
            OutlinedTextField(reason, { reason = it.take(2000) }, Modifier.fillMaxWidth().testTag("$tag:reason"),
                placeholder = { Text(ProjectReopenCopy.declinePlaceholder) }, minLines = 2, maxLines = 6)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = {
                    busy = true; failure = null
                    scope.launch { failure = store.act { decline(request.id, reason.trim()) }; busy = false }
                }, Modifier.testTag("$tag:decline-send"), enabled = reason.isNotBlank() && !busy) { Text(ProjectReopenCopy.decline) }
                TextButton(onClick = { declining = false }, Modifier.testTag("$tag:keep")) { Text(ProjectReopenCopy.keep) }
            }
        } else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            // Two full-width buttons, stacked, as iOS draws them.
            Button(onClick = {
                busy = true; failure = null
                scope.launch {
                    failure = store.act { reopenProject(request.id) }
                    if (failure == null) reopened()
                    busy = false
                }
            }, Modifier.fillMaxWidth().testTag("$tag:primary"), enabled = !busy) { Text(ProjectReopenCopy.reopen, fontWeight = FontWeight.Bold) }
            OutlinedButton(onClick = { if (discuss != null) discuss(OwnerRequests.chatContext(request) + "\n\n") else declining = true },
                Modifier.fillMaxWidth().testTag("$tag:chat"), enabled = !busy) { Text(ProjectReopenCopy.chat) }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}

@Composable
private fun Labelled(label: String, text: String, tag: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(text, Modifier.testTag(tag), style = MaterialTheme.typography.bodyMedium)
    }
}

/** An answered request, one line: "Reopened · Nov 23 14:02" or "Declined: <reason>". */
@Composable
private fun ProjectReopenFolded(request: OwnerRequest, tag: String) {
    val done = request.state == "DONE"
    Row(Modifier.fillMaxWidth().testTag("$tag:resolved").padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(painterResource(if (done) R.drawable.ic_check_circle else R.drawable.ic_x_circle), null, Modifier.size(16.dp),
            tint = if (done) LocalOrbitColors.current.success else MaterialTheme.colorScheme.onSurfaceVariant)
        Text(ProjectReopenCopy.outcomeLine(request), Modifier.testTag("$tag:outcome"), style = MaterialTheme.typography.bodySmall)
    }
}
