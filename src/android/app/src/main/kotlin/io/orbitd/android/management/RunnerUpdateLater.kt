package io.orbitd.android.management

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Later (docs/runner-update-drain-design.md §2, D1; iOS `RunnerUpdateLater`): put the update a runner drains for off for an hour,
 * until tonight 02:00 or until tomorrow 09:00, in the reader's own zone. Android draws board 5's action sheet, as iOS does.
 */
internal object RunnerUpdateLater {
    enum class Choice { HOUR, TONIGHT, TOMORROW }

    // The words, as OrbitKit's RunnerPageCopy (the web's runnerCopy.ts) and RunnerUpdateLater say them.
    const val LATER = "Later"
    const val CHANGE = "Change"
    const val UPDATE_NOW = "Update Now…"
    fun updateNowConfirmTitle(version: String) = "Update to $version now?"
    const val UPDATE_NOW_CONFIRM_BODY =
        "The postponement ends. It installs as soon as no turn is running; if turns keep running for an hour, it stops taking new work so they can finish."
    const val UPDATE_NOW_CONFIRM = "Update Now"
    const val POSTPONE_FAILED = "Couldn’t postpone the update"
    const val SHEET_HOUR = "In 1 Hour"
    fun sheetTonight(clock: String) = "Tonight at $clock"
    fun sheetTomorrow(clock: String) = "Tomorrow at $clock"
    fun sheetMessage(version: String?, machine: String?): String =
        "Postpone ${version?.let { "the $it update" } ?: "the update"}${machine?.let { " on $it" } ?: ""}. It takes work again right away."

    /** An hour from now; the next 02:00; 09:00 on the next calendar day — in [zone]. */
    fun until(choice: Choice, now: Instant, zone: ZoneId = ZoneId.systemDefault()): Instant {
        val local = ZonedDateTime.ofInstant(now, zone)
        return when (choice) {
            Choice.HOUR -> now.plusSeconds(3600)
            Choice.TONIGHT -> local.toLocalDate().atTime(2, 0).atZone(zone).let { if (it.toInstant().isAfter(now)) it else it.plusDays(1) }.toInstant()
            Choice.TOMORROW -> local.toLocalDate().plusDays(1).atTime(9, 0).atZone(zone).toInstant()
        }
    }

    fun clock(at: Instant, zone: ZoneId = ZoneId.systemDefault()): String = DateTimeFormatter.ofPattern("HH:mm").withZone(zone).format(at)

    data class Row(val choice: Choice, val label: String, val until: Instant)

    /** Board 5's sheet: `In 1 Hour`, `Tonight at 02:00`, `Tomorrow at 09:00`. */
    fun sheetRows(now: Instant, zone: ZoneId = ZoneId.systemDefault()): List<Row> = Choice.values().map { choice ->
        val at = until(choice, now, zone)
        Row(choice, when (choice) {
            Choice.HOUR -> SHEET_HOUR
            Choice.TONIGHT -> sheetTonight(clock(at, zone))
            Choice.TOMORROW -> sheetTomorrow(clock(at, zone))
        }, at)
    }

    /** POST /runners/:id/self-update/postpone's body (shared `RunnerSelfUpdatePostponeRequest`): the time and the zone it is capped in. */
    fun body(until: Instant, zone: ZoneId = ZoneId.systemDefault()): JsonObject = buildJsonObject {
        put("until", until.toString())
        put("timeZone", zone.id)
    }

    fun path(runnerId: String) = listOf("runners", runnerId, "self-update", "postpone")
}

/**
 * Later… (or Change… on a postponed card): a button that raises board 5's sheet — what it does, the three times, Cancel. [postpone]
 * is handed the time picked and answers null once the server took it, or why not.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RunnerUpdateLaterButton(version: String?, machine: String?, postpone: suspend (Instant) -> String?,
    modifier: Modifier = Modifier, change: Boolean = false, now: () -> Instant = Instant::now) {
    var open by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var picked by remember { mutableStateOf<Instant?>(null) }
    LaunchedEffect(picked) {
        val until = picked ?: return@LaunchedEffect
        busy = true
        failure = postpone(until)
        busy = false
        picked = null
    }
    OutlinedButton({ open = true }, modifier.testTag("runner-update-later"), enabled = !busy) {
        Text((if (change) RunnerUpdateLater.CHANGE else RunnerUpdateLater.LATER) + "…")
    }
    if (open) ModalBottomSheet({ open = false }, Modifier.testTag("runner-update-later-sheet")) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(RunnerUpdateLater.sheetMessage(version, machine), Modifier.fillMaxWidth().padding(bottom = 8.dp).testTag("runner-update-later-sheet:message"),
                textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            RunnerUpdateLater.sheetRows(now()).forEach { row ->
                TextButton({ open = false; picked = row.until }, Modifier.fillMaxWidth().testTag("runner-update-later:${row.choice.name.lowercase()}")) {
                    Text(row.label)
                }
            }
            HorizontalDivider()
            TextButton({ open = false }, Modifier.fillMaxWidth()) { Text("Cancel") }
        }
    }
    failure?.let { why ->
        AlertDialog({ failure = null }, confirmButton = { TextButton({ failure = null }) { Text("OK") } },
            title = { Text(RunnerUpdateLater.POSTPONE_FAILED) }, text = { Text(why) })
    }
}
