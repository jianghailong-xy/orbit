package io.orbitd.android.schedule

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.R
import io.orbitd.android.core.schedule.ScheduleCopy as SC
import io.orbitd.android.core.schedule.ScheduleDisplay
import kotlinx.coroutines.launch

/**
 * A schedule's Change… (docs/scheduled-tasks-design.md §8.2, board 03-change ③): Orbit's opening and a composer, before
 * any session exists. The person's first words open the change conversation, and the page gives way to it (replaced,
 * so Back returns to the Scheduled page, not here). A schedule with a change conversation still open goes straight
 * there. Every word is the shared contract's (`ScheduleCopy.ChangeConversation`).
 */
@Composable
fun ScheduleChangePage(store: ScheduledStore, scheduleId: String, openSession: (String) -> Unit, openSchedule: (String) -> Unit) {
    val state by store.state.collectAsState()
    LaunchedEffect(store, scheduleId) { store.loadChange(scheduleId) }
    val change = state.change(scheduleId)
    val open = change?.sessionId
    // A conversation already open goes straight there (board ③).
    LaunchedEffect(open) { if (open != null) openSession(open) }
    if (change == null || open != null) {
        Box(Modifier.fillMaxSize().testTag("schedule-change-draft"), contentAlignment = Alignment.Center) {
            state.errorText?.let { Text(it, color = scheduleRed(), style = MaterialTheme.typography.bodyMedium) }
                ?: CircularProgressIndicator()
        }
        return
    }
    val opening = change.opening
    var typed by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focusRequester = remember { FocusRequester() }
    fun send() {
        val words = typed.trim()
        if (words.isEmpty() || busy) return
        busy = true
        scope.launch {
            val answer = store.openChange(scheduleId, words)
            busy = false
            // Created or found meanwhile (created=false, the words were said there): the conversation takes the page's place.
            if (answer != null) openSession(answer.sessionId)
        }
    }
    Column(Modifier.fillMaxSize().testTag("schedule-change-draft").padding(horizontal = 16.dp)) {
        Text(ScheduleDisplay.fill(SC.ChangeConversation.title, mapOf("title" to opening.title)),
            Modifier.padding(top = 8.dp, bottom = 4.dp), style = MaterialTheme.typography.headlineLarge.copy(fontSize = 32.sp, lineHeight = 38.sp),
            color = MaterialTheme.colorScheme.primary)
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(vertical = 8.dp)) {
            item(key = "opening") { ScheduleChangeOpeningView(opening, openSchedule) }
            state.errorText?.let { error -> item(key = "error") { Text(error, color = scheduleRed(), style = MaterialTheme.typography.bodySmall) } }
        }
        // The composer, focused (board ③): the first words open the conversation; the schedule's agent answers there.
        Row(Modifier.fillMaxWidth().padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            TextField(typed, { typed = it }, Modifier.weight(1f).focusRequester(focusRequester).testTag("schedule-change-input"),
                enabled = !busy, singleLine = true, placeholder = { Text(SC.ChangeConversation.placeholder) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send), keyboardActions = KeyboardActions(onSend = { send() }),
                colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent))
            IconButton(onClick = { send() }, Modifier.testTag("schedule-change-send"), enabled = typed.isNotBlank() && !busy) {
                Icon(painterResource(R.drawable.ic_arrow_up), "Send", tint = MaterialTheme.colorScheme.primary)
            }
        }
        LaunchedEffect(Unit) { focusRequester.requestFocus() }
    }
}
