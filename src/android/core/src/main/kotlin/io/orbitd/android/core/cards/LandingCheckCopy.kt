package io.orbitd.android.core.cards

import kotlinx.serialization.json.*

/** Approved web copy, mirrored by the native clients. */
object LandingCheckCopy {
    const val label = "Landing check"
    const val confirmTitle = "Change project integration settings?"
    const val confirmAction = "Confirm"
    const val command = "Command"
    const val timeout = "Timeout (seconds)"
    const val hint = "Runs when a task lands on the project branch."
    const val inherits = "Uses merge check"
    const val commandPlaceholder = "Leave blank to use merge check"
    const val inheritsTimeout = "Uses merge check timeout"
    const val timeoutPlaceholder = "Leave blank to use merge check timeout"
    const val timeoutHint = "Leave blank to use the merge check timeout."
    const val main = "Not used when tasks land directly on main."
    const val applies = "Applies to the next claimed landing job."
    const val waiting = "Waiting for baseline fix"
    const val resumes = "Landings resume automatically when this open item is resolved."
    const val baselineBody = "The project branch with the latest main fails its checks without this task."
    const val held = "Landings on hold"
    const val upstream = "Upstream"
    const val tip = "Project tip"
    const val baseline = "Combined baseline"
    const val viewHeld = "View held tasks"
    fun attribution(passed: Boolean) = "Checked the project branch with main, without this task · " + if (passed) "passes" else "also fails"
    fun title(branch: String) = "Baseline checks failing on $branch"
    fun inheritedCommand(command: String?) = command?.let { "$inherits: $it" } ?: inherits
    fun inheritedTimeout(seconds: Int?) = seconds?.let { "$inheritsTimeout: $it seconds" } ?: inheritsTimeout
}

object IntegrationCheckProposal {
    fun value(input: JsonObject, key: String, after: Boolean): JsonElement? =
        if (after && input.containsKey(key)) input[key] else input["current" + key.replaceFirstChar { it.uppercase() }]
    fun command(input: JsonObject, layer: String, after: Boolean): String {
        val command = (value(input, layer + "CheckCommand", after) as? JsonPrimitive)?.contentOrNull
        return command ?: if (layer == "landing") LandingCheckCopy.inheritedCommand(
            (value(input, "mergeCheckCommand", after) as? JsonPrimitive)?.contentOrNull) else "no check configured"
    }
    fun timeout(input: JsonObject, layer: String, after: Boolean): String {
        val seconds = (value(input, layer + "CheckTimeoutSeconds", after) as? JsonPrimitive)?.intOrNull
        return seconds?.let { "$it seconds" } ?: if (layer == "landing") LandingCheckCopy.inheritedTimeout(
            (value(input, "mergeCheckTimeoutSeconds", after) as? JsonPrimitive)?.intOrNull) else "3600 seconds"
    }
}
