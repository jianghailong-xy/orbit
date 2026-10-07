package io.orbitd.android.management

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The status inks iOS's RunnerInk draws, taken from the app theme so dark mode follows. */
internal object Ink {
    val green @Composable get() = LocalOrbitColors.current.success
    val amber @Composable get() = LocalOrbitColors.current.needsYou
    val red @Composable get() = MaterialTheme.colorScheme.error
    val muted @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
    @Composable fun tone(tone: String?) = when (tone) { "ok" -> green; "warn" -> amber; "bad" -> red; else -> muted }
}

/** A grouped form section: header (and its trailing note), the card, and the footer under it. */
@Composable
internal fun FormSection(header: String? = null, trailing: String? = null, footer: String? = null,
                         content: @Composable ColumnScope.() -> Unit) {
    if (header != null) Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp, bottom = 6.dp),
        verticalAlignment = Alignment.Bottom) {
        Text(header, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        trailing?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
    } else Spacer(Modifier.height(16.dp))
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp), content = content)
    }
    footer?.let { Text(it, Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp), style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

/** RunnerGauge: a capsule track filled to `fraction`. */
@Composable
internal fun Gauge(fraction: Float, tint: Color, modifier: Modifier = Modifier, height: Dp = 5.dp) {
    val value = fraction.coerceIn(0f, 1f)
    Box(modifier.fillMaxWidth().height(height).clip(CircleShape).background(MaterialTheme.colorScheme.onSurface.copy(alpha = .08f))
        .semantics { progressBarRangeInfo = ProgressBarRangeInfo(value, 0f..1f) }) {
        Box(Modifier.fillMaxWidth(value).fillMaxHeight().clip(CircleShape).background(tint))
    }
}

/** One quota window: its label and percent, the gauge (amber from 90%), and when it resets. */
@Composable
internal fun UsageWindowRow(row: UsageRow, resets: String?) {
    Column(Modifier.padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(row.label, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold))
            Text("${row.percent}%", style = MaterialTheme.typography.labelMedium, color = Ink.muted)
        }
        Gauge(row.percent / 100f, if (row.nearLimit) Ink.amber else MaterialTheme.colorScheme.primary)
        resets?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = if (row.nearLimit) Ink.amber else Ink.muted) }
    }
}

/** A line over the page's foot for a few seconds (iOS runnerNotice). */
@Stable
internal class Notice {
    var text by mutableStateOf<String?>(null); private set
    private var serial by mutableIntStateOf(0)
    fun show(message: String) { text = message; serial++ }
    @Composable fun Host(modifier: Modifier = Modifier) {
        LaunchedEffect(serial) { if (text != null) { delay(3_000); text = null } }
        text?.let {
            Box(modifier.fillMaxWidth().padding(24.dp), Alignment.BottomCenter) {
                Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.inverseSurface, tonalElevation = 3.dp) {
                    Text(it, Modifier.padding(horizontal = 16.dp, vertical = 10.dp), color = MaterialTheme.colorScheme.inverseOnSurface,
                        style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

internal fun copyText(context: Context, label: String, text: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(label, text))
}

/** `Oct 7, 2026 at 3:45 PM`: Date.formatted(date: .abbreviated, time: .shortened) in English. */
internal fun abbreviatedDateTime(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String =
    DateTimeFormatter.ofPattern("MMM d, yyyy 'at' h:mm a", Locale.US).withZone(zone).format(Instant.ofEpochMilli(ms))

/**
 * AccountPauseControls: the same pause controls on runner accounts and pool members. The label is
 * shown to everyone; the buttons only to whoever can manage the account. The owner refreshes after writes.
 */
@Composable
internal fun AccountPauseControls(name: String, pausedUntil: String?, scope: String, canManage: Boolean = true,
                                  signInAgain: (() -> Unit)? = null, signInDisabled: Boolean = false,
                                  save: suspend (Int?) -> String?) {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(pausedUntil) { while (true) { now = System.currentTimeMillis(); delay(1_000) } }
    val until = isoMs(pausedUntil)?.takeIf { it > now }
    var choosing by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val coroutines = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        until?.let {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Paused", Modifier.weight(1f), style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = Ink.amber)
                Text("Until ${abbreviatedDateTime(it)}", style = MaterialTheme.typography.labelSmall, color = Ink.amber)
            }
        }
        if (canManage || signInAgain != null) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            signInAgain?.let { OutlinedButton(onClick = it, enabled = !signInDisabled && !saving) { Text("Sign In Again") } }
            if (canManage) {
                if (until != null) {
                    OutlinedButton(enabled = !saving, onClick = {
                        saving = true; failure = null
                        coroutines.launch { failure = save(null); saving = false }
                    }) { Text("Resume Now") }
                    TextButton(onClick = { choosing = true }, enabled = !saving) { Text("Change Duration…") }
                } else OutlinedButton(onClick = { choosing = true }, enabled = !saving) { Text("Pause…") }
            }
        }
        failure?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.red) }
    }
    if (choosing) AccountPauseDialog(name, scope, onDismiss = { choosing = false }, save = save)
}

@Composable
private fun AccountPauseDialog(name: String, scope: String, onDismiss: () -> Unit, save: suspend (Int?) -> String?) {
    var hours by remember { mutableIntStateOf(2) }
    var custom by remember { mutableStateOf(false) }
    var customHours by remember { mutableStateOf("2") }
    var saving by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val coroutines = rememberCoroutineScope()
    val minutes = if (custom) RunnerPage.pauseMinutes(customHours) else hours * 60
    val title = if (custom) "Pause Account" else "Pause for $hours Hour${if (hours == 1) "" else "s"}"
    AlertDialog(onDismissRequest = { if (!saving) onDismiss() }, title = { Text("Pause Account") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(name, style = MaterialTheme.typography.titleMedium)
            Text(scope, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            Text("Pause for", style = MaterialTheme.typography.labelMedium)
            SingleChoiceSegmentedButtonRow {
                listOf(1, 2, 4, 8).forEachIndexed { index, value ->
                    SegmentedButton(selected = !custom && hours == value, onClick = { hours = value; custom = false },
                        shape = SegmentedButtonDefaults.itemShape(index, 4), enabled = !saving) { Text("${value}h") }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Custom duration", Modifier.weight(1f))
                Switch(checked = custom, onCheckedChange = { custom = it }, enabled = !saving)
            }
            if (custom) {
                OutlinedTextField(customHours, { customHours = it }, label = { Text("Hours") }, singleLine = true, enabled = !saving,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal))
                Text("1 minute to 168 hours", style = MaterialTheme.typography.labelSmall, color = Ink.muted)
            }
            minutes?.let { Text("Automatically resumes at ${abbreviatedDateTime(System.currentTimeMillis() + it * 60_000L)}",
                style = MaterialTheme.typography.bodySmall) }
            Text("Skip this account for new turns. Any running turn will finish normally.", style = MaterialTheme.typography.bodySmall, color = Ink.muted)
            failure?.let { Text(it, color = Ink.red, style = MaterialTheme.typography.labelMedium) }
        }
    }, confirmButton = {
        Button(enabled = minutes != null && !saving, onClick = {
            val chosen = minutes ?: return@Button
            saving = true; failure = null
            coroutines.launch { failure = save(chosen); saving = false; if (failure == null) onDismiss() }
        }) { Text(if (saving) "Saving…" else title) }
    }, dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text("Cancel") } })
}
