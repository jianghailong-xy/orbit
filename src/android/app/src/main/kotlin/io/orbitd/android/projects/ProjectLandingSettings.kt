package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.watch.WatchTime
import java.time.Instant
import kotlinx.serialization.json.*

internal enum class LandingCheckMode(val label: String) {
    MERGE_CHECK(LandingModeCopy.mergeCheck),
    COMMAND(LandingModeCopy.command),
    NO_CHECK(LandingModeCopy.none),
}

internal data class ProjectLandingCheck(val command: String?, val setBy: String?, val setAt: String?) {
    val mode get() = when (command) {
        "NONE" -> LandingCheckMode.NO_CHECK
        null, "" -> LandingCheckMode.MERGE_CHECK
        else -> LandingCheckMode.COMMAND
    }

    fun originLine(now: Instant): String? {
        val label = LandingCheckOriginCopy.label(setBy) ?: return null
        val ago = WatchTime.format(setAt, now)
        return if (ago == null) label else "$label · set $ago"
    }

    companion object {
        fun read(view: JsonObject): ProjectLandingCheck {
            val check = view.obj("landingCheck")
            return ProjectLandingCheck(
                if (check == null) view.text("landingCheckCommand") else check.text("command"),
                check?.text("setBy"), check?.text("setAt"),
            )
        }
    }
}

internal fun landingCheckWrite(view: JsonObject, mode: LandingCheckMode, command: String, timeout: Int?): JsonObject? {
    val next = command.takeIf { mode == LandingCheckMode.COMMAND && it.isNotBlank() }
    val stored = ProjectLandingCheck.read(view).mode
    return buildJsonObject {
        if (mode == LandingCheckMode.NO_CHECK) {
            if (stored != LandingCheckMode.NO_CHECK) put("landingCheck", "NONE")
        } else {
            if (next != view.text("landingCheckCommand") || stored == LandingCheckMode.NO_CHECK) {
                put("landingCheckCommand", next?.let(::JsonPrimitive) ?: JsonNull)
            }
            if (timeout != view.number("landingCheckTimeoutSeconds")) {
                put("landingCheckTimeoutSeconds", timeout?.let(::JsonPrimitive) ?: JsonNull)
            }
        }
    }.takeIf { it.isNotEmpty() }
}

internal data class ProjectSettingChange(
    val id: String,
    val taskId: String?,
    val field: Field,
    val origin: String?,
    val oldValue: Value,
    val newValue: Value,
    val reason: String?,
    val revertsChangeId: String?,
    val revertedAt: String?,
    val revertible: Boolean,
    val createdAt: String?,
) {
    enum class Field(val label: String) {
        LANDING_CHECK(LandingChangesCopy.landingCheck),
        TASK_LANDING_CHECK_EXEMPT(LandingChangesCopy.checkExempt),
    }

    sealed interface Value {
        val text: String

        data class LandingCheck(val command: String?, val timeoutSeconds: Int?, val none: Boolean) : Value {
            override val text get() = if (none) LandingChangesCopy.noCheck
                else command?.takeIf { it.isNotEmpty() } ?: LandingChangesCopy.usesMergeCheck
        }

        data class TaskExempt(val exempt: Boolean, val reason: String?) : Value {
            override val text get() = if (exempt) LandingChangesCopy.exempt else LandingChangesCopy.notExempt
        }
    }

    val originLabel get() = when (origin) {
        "COORDINATOR" -> LandingCheckOriginCopy.coordinator
        "CARD" -> LandingCheckOriginCopy.card
        else -> LandingCheckOriginCopy.owner
    }
    val ownerNote get() = LandingChangesCopy.yourChangeNothing.takeIf { !revertible && origin != "COORDINATOR" && revertsChangeId == null }
    val confirmation get() = "${field.label} goes back from ${newValue.text} to ${oldValue.text}."

    companion object {
        fun read(doc: JsonObject): List<ProjectSettingChange> = doc.objects("settingChanges").mapNotNull { row ->
            val id = row.text("id") ?: return@mapNotNull null
            val field = Field.entries.firstOrNull { it.name == row.text("field") } ?: return@mapNotNull null
            val old = value(row.obj("oldValue")) ?: return@mapNotNull null
            val new = value(row.obj("newValue")) ?: return@mapNotNull null
            ProjectSettingChange(id, row.text("taskId"), field, row.text("origin"), old, new, row.text("reason"),
                row.text("revertsChangeId"), row.text("revertedAt"), row.flag("revertible"), row.text("createdAt"))
        }

        private fun value(value: JsonObject?): Value? {
            if (value == null) return null
            val none = (value["none"] as? JsonPrimitive)?.booleanOrNull
            if (none != null) return Value.LandingCheck(value.text("command"), value.number("timeoutSeconds"), none)
            val exempt = (value["exempt"] as? JsonPrimitive)?.booleanOrNull ?: return null
            return Value.TaskExempt(exempt, value.text("reason"))
        }
    }
}
