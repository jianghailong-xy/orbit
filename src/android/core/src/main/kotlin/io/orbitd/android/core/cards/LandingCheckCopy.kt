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

object LandingModeCopy {
    const val mergeCheck = "Merge check"
    const val command = "Command"
    const val none = "No check"
    const val noneHead = "No check."
    const val noneBody = "Tasks land with only their own acceptance. The merge check still runs before main."
    const val commandNote = "Changes the coordinator makes are listed under Coordinator’s changes."
    const val whoCanSet = "Who can set it"
}

object LandingCheckOriginCopy {
    const val owner = "You"
    const val coordinator = "Coordinator"
    const val card = "Approved on a card"
    const val start = "Set at start"
    fun label(by: String?) = when (by) {
        "OWNER" -> owner
        "COORDINATOR" -> coordinator
        "CARD" -> card
        "START" -> start
        else -> null
    }

    val notes = listOf(
        "OWNER" to "Anything you set; the coordinator then needs a card to change it.",
        "COORDINATOR" to "No card, while the merge check exists.",
        "CARD" to "A change you confirmed on a card.",
        "START" to "The coordinator proposed it and you pressed Start; it may still change without a card. A value you typed on the start card reads as You.",
    )
}

object LandingChangesCopy {
    const val title = "Coordinator’s changes"
    const val intro = "What the coordinator changed on its own since the project started. Revert puts the old value back and takes the field away from the coordinator: it needs a card from then on."
    const val empty = "The coordinator has not changed anything on its own."
    const val landingCheck = "Landing check"
    const val checkExempt = "Check exempt"
    const val usesMergeCheck = "Uses merge check"
    const val noCheck = "No check"
    const val exempt = "exempt"
    const val notExempt = "not exempt"
    const val revert = "Revert"
    const val yourChange = "Your change"
    const val yourChangeNothing = "Your change · nothing to revert"
    const val confirmTitle = "Revert this change?"
    const val confirmConsequence = "The coordinator can no longer change this field without a card."
    const val cancel = "Cancel"
    const val openTask = "Open task"

    fun rowLabel(count: Int) = "$count ${if (count == 1) "change" else "changes"}"
    fun revertedLine(whenAgo: String) = "Reverted by you · $whenAgo · coordinator needs a card for this field"
}

object TaskExemptCopy {
    const val label = "Landing check"
    const val badge = "Exempt"
    const val remove = "Remove exemption"
    const val skipped = "Skipped"
    const val mergeCheckStillRuns = "Merge check before main"
    const val stillRuns = "Still runs"
    fun reason(reason: String) = "Exempt: $reason"
}
