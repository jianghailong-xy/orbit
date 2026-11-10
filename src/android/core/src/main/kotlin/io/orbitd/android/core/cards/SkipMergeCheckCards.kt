package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/**
 * What a skip would let through, read off the `orbit_integration_skip_merge_check` ask (OrbitKit `SkipMergeCheckPreview`, web
 * `SkipMergeCheckBody`). The runner reads it from the project and the landing before it files the card (`runner-go/mcp.go`,
 * `skipMergeCheckFacts`): the command that would NOT run, verbatim, what it said last time, and the agent's reason. A missing
 * field reads as empty; [mainBranch] is the branch's name, `main` where the card names none.
 */
data class SkipMergeCheckCard(val projectTitle: String, val taskTitle: String, val checkCommand: String, val failure: String,
    val reason: String, val mainBranch: String) {
    /** The heading holds one line, so the task's name takes the row under it. */
    val taskLine get() = taskTitle.ifEmpty { "This task" }
    val projectLine get() = projectTitle.takeIf { it.isNotEmpty() }?.let { "In $it" }
    val note get() = "Once, and only this landing: the project’s check command is unchanged, and the next landing and every merge " +
        "into $mainBranch are checked as before."
    /** What a refusal names, ahead of the reason to be typed. */
    val declineName get() = taskTitle.ifEmpty { "this landing" }
}

/** The skip card's names and words. The server reads the card back by id, so there is no standing yes to offer. */
object SkipMergeCheckCards {
    const val tool = "orbit_integration_skip_merge_check"
    const val heading = "Land without the check?"
    const val commandCaption = "This landing runs without the merge check"
    const val reasonCaption = "The agent says this red is the check’s, not the work’s"
    const val action = "Land it without the check"

    fun read(input: JsonObject): SkipMergeCheckCard {
        fun text(key: String) = input.text(key).orEmpty()
        return SkipMergeCheckCard(text("projectTitle"), text("taskTitle"), text("checkCommand"), text("failure"), text("reason"),
            input.text("mainBranch")?.removePrefix("refs/heads/")?.takeIf { it.isNotEmpty() } ?: "main")
    }
}
