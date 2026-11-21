package io.orbitd.android.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.cards.TaskExemptCopy
import io.orbitd.android.core.cards.flag
import io.orbitd.android.core.cards.text
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectSettingChange
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.watch.WatchTime
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// A task's exemption from its project's landing check (revision 42 part two, board 04, ruling D5), as the web's
// `TaskLandingExempt` draws it in the task page's Landing section: `Landing check · Exempt`, the reason, who marked it
// and when, and the owner's way to take it off. iOS declares the same words (OrbitKit `TaskExemptCopy`) but draws none
// of them yet, so the web is the reference here.

/** One task's exemption as its read says it; null for a task that is not exempt. */
internal data class TaskLandingExemption(
    /** `landingCheckExemptReason`: why the landing check is not run for it (at most 280 characters). */
    val reason: String?,
    /** `landingCheckExemptBySessionId`: the coordinator session that marked it; null when the owner did. */
    val bySessionId: String?,
    /** `landingCheckExemptOwnerSetAt`: when the owner last set the flag; null while only the coordinator has. */
    val ownerSetAt: String?,
) {
    companion object {
        fun of(task: JsonObject?): TaskLandingExemption? = task?.takeIf { it.flag("landingCheckExempt") }?.let {
            TaskLandingExemption(it.text("landingCheckExemptReason")?.takeIf(String::isNotEmpty),
                it.text("landingCheckExemptBySessionId"), it.text("landingCheckExemptOwnerSetAt"))
        }

        /** Who marked it and when: the newest record of this task's exemption in the project's `settingChanges` that set it
         *  and was not reverted, as the web finds it. Null when the server lists none. */
        fun marked(changes: List<ProjectSettingChange>, taskId: String?): ProjectSettingChange? = changes.firstOrNull { change ->
            change.field == ProjectSettingChange.Field.TASK_LANDING_CHECK_EXEMPT && ObjectId.same(change.taskId, taskId) &&
                (change.newValue as? ProjectSettingChange.Value.TaskExempt)?.exempt == true && change.revertedAt == null
        }

        /** `marked 20m ago`, the web's line beside the origin badge. */
        fun markedLine(change: ProjectSettingChange, now: Instant): String? = WatchTime.format(change.createdAt, now)?.let { "marked $it" }

        /** The one write: the owner takes the exemption off. */
        val removeRequest: JsonObject get() = buildJsonObject { put("landingCheckExempt", false) }
    }
}

/** The exemption's block in the task page's Landing section. */
@Composable
internal fun TaskLandingExemptView(exemption: TaskLandingExemption, marked: ProjectSettingChange?, now: Instant, enabled: Boolean,
    remove: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val amber = LocalOrbitColors.current.needsYou
    Column(Modifier.fillMaxWidth().testTag("task-landing-exempt").background(muted.copy(alpha = 0.08f), RoundedCornerShape(8.dp))
        .padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(TaskExemptCopy.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            Text(TaskExemptCopy.badge, Modifier.testTag("task-landing-exempt-badge").background(amber.copy(alpha = 0.14f), RoundedCornerShape(50))
                .padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = amber)
        }
        exemption.reason?.let { Text(it, Modifier.testTag("task-landing-exempt-reason"), style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium) }
        if (marked != null) Row(Modifier.testTag("task-landing-exempt-origin"), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(marked.originLabel, Modifier.background(muted.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp),
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
            TaskLandingExemption.markedLine(marked, now)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
        }
        OutlinedButton(onClick = remove, enabled = enabled, modifier = Modifier.testTag("task-landing-exempt-remove")) { Text(TaskExemptCopy.remove) }
    }
}
