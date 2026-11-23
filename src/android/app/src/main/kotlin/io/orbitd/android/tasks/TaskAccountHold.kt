package io.orbitd.android.tasks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.management.isoMs
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.*

/**
 * A task held because no account that could run it can run now (`accountHold` on task reads, task list items and project task rows;
 * docs/account-health-owner-surface-contract.md §3, web `TaskAccountHold.tsx`).
 */
internal object TaskAccountHold {
    const val OPEN_ACCOUNT = "Open account"
    const val RUN_ELSEWHERE = "Run elsewhere"
    const val ACCOUNTS_PAGE = "machines"
    const val SETTINGS_PAGE = io.orbitd.android.core.cards.SettingsFromConversation.GENERAL_PAGE

    fun of(task: JsonObject): JsonObject? = (task["accountHold"] as? JsonObject)

    /** One quiet line on a row: not while the task runs or waits for a run, nor when the sign-in `hold` stands (that one wins). */
    fun showsOnRow(task: JsonObject): Boolean = of(task) != null && task["hold"].let { it == null || it is JsonNull } &&
        (task["running"] as? JsonPrimitive)?.booleanOrNull != true && (task["queued"] as? JsonPrimitive)?.booleanOrNull != true

    private fun JsonObject.str(key: String) = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun time(iso: String?, now: Long, zone: ZoneId): String? = isoMs(iso)?.let {
        val day = DateTimeFormatter.ofPattern("yyyy-MM-dd", Locale.US).withZone(zone)
        val at = Instant.ofEpochMilli(it)
        DateTimeFormatter.ofPattern(if (day.format(at) == day.format(Instant.ofEpochMilli(now))) "HH:mm" else "MMM d, HH:mm", Locale.US).withZone(zone).format(at)
    }

    /** `Held · Cursor said "…" · Next try 13:19`: the first account's words (else the reason) and the first next trial. */
    fun lineText(hold: JsonObject, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String {
        val first = (hold["accounts"] as? JsonArray)?.firstOrNull() as? JsonObject
        val words = first?.str("line") ?: hold.str("reason").orEmpty()
        val next = first?.let { time(hold.str("until"), now, zone) }?.let { " · Next try $it" }.orEmpty()
        return "Held · $words$next"
    }

    fun accountRoute() = OrbitRoute(Destination.SETTINGS, ACCOUNTS_PAGE)

    /** A pinned task held with relaxation off (`setting`: `orbit-settings:relaxBlockedPins`) offers the Sessions page, where Android keeps
     * the routing settings; it has no row of its own for this one yet. */
    fun settingRoute(hold: JsonObject): OrbitRoute? = hold.str("setting")?.let { OrbitRoute(Destination.SETTINGS, SETTINGS_PAGE) }
}

/** The hold on a list or project row: ONE quiet line under the title, in the row's secondary style, with Open account at its end. */
@Composable
internal fun TaskAccountHoldLine(task: JsonObject, open: (OrbitRoute) -> Unit, modifier: Modifier = Modifier) {
    val hold = TaskAccountHold.of(task) ?: return
    val text = TaskAccountHold.lineText(hold)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(modifier.fillMaxWidth().testTag("task-account-hold-line").semantics(mergeDescendants = false) { contentDescription = "$text · ${TaskAccountHold.OPEN_ACCOUNT}" },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text, Modifier.weight(1f, fill = false).clearAndSetSemantics { }, style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(TaskAccountHold.OPEN_ACCOUNT, Modifier.clickable(role = Role.Button) { open(TaskAccountHold.accountRoute()) }.testTag("task-account-hold-open"),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, maxLines = 1)
    }
}

/** The fuller block on the task view: a Held pill, the reason, Open account, and for a pinned task Run elsewhere. */
@Composable
internal fun TaskAccountHoldNote(hold: JsonObject, open: (OrbitRoute) -> Unit, modifier: Modifier = Modifier) {
    val reason = (hold["reason"] as? JsonPrimitive)?.contentOrNull.orEmpty()
    val setting = TaskAccountHold.settingRoute(hold)
    Column(modifier.fillMaxWidth().testTag("task-account-hold"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Held", style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = LocalOrbitColors.current.needsYou)
            Text(reason, Modifier.weight(1f).testTag("task-account-hold:reason"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(TaskAccountHold.OPEN_ACCOUNT, Modifier.clickable(role = Role.Button) { open(TaskAccountHold.accountRoute()) }.testTag("task-account-hold-open"),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            if (setting != null) Text(TaskAccountHold.RUN_ELSEWHERE, Modifier.clickable(role = Role.Button) { open(setting) }.testTag("task-account-hold-elsewhere"),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
        }
    }
}

/** A pinned task that ran elsewhere says which pin, where it ran and why, in the server's sentence, under that run's row. */
@Composable
internal fun RelaxedRunNote(sentence: String, modifier: Modifier = Modifier) {
    Text(sentence, modifier.testTag("relaxed-run"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
