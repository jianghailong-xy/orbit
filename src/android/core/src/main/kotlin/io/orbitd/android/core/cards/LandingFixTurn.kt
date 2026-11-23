package io.orbitd.android.core.cards

// A failed landing handed to the task's own work session (contract revision 42, §12.5 W6; board docs/mocks/landing-fix-own-session
// ② b, ruled 2026-11-22): the `landing-fix:v1:<jobId>` turn, as its card in that session says it. The server writes the turn as fixed
// English (apiserver `landing-fix-turn.ts#landingFixMessage`) and carries no card beside it, so the card is read back from those words:
// a turn that does not have their shape parses as nothing and stays the message it was.

/** The card's own words (board ② b). The steps and the lines it quotes are the turn's; these are only what the card adds around them. */
object LandingFixCopy {
    /** The turn's first words, which no person's message is drafted with. */
    const val HEAD = "Orbit could not land your work for "
    const val FROM_ORBIT_LANDING = "From Orbit · Landing"
    const val CONFLICT = "Conflict"
    const val CHECK_FAILED = "Check failed"
    const val NOTHING_WAS_PUSHED = "Nothing was pushed."
    const val THE_PROJECT_BRANCH = "the project branch"
    fun couldNotLand(target: String) = "Orbit could not land your work on $target"
    /** The card's foot: what Orbit does next, the one rule, and the way out — the turn's last paragraph, shortened as the board does. */
    fun footer(branch: String) = "Orbit lands the new commit and runs the checks again. Do not push $branch. " +
        "Not yours to fix? End your turn without committing and say why."
    const val OPEN_LANDING = "Open landing"
    /** The line a fix this session committed lands with (board ② b ③). */
    fun landingAgain(sha: String) = "Landing $sha again"
}

/** One landing-fix turn, read from its words. [state] is `CONFLICT` or `CHECK_FAILED`; [failure] the sentence that says what failed,
 *  without its colon; [quoted] the files that conflicted or the failure lines the check printed; [steps] the three numbered steps;
 *  [landingSessionId] the landing it names (`The full record: landing <id>.`), null when it names none. */
data class LandingFixTurn(
    val taskTitle: String,
    val target: String,
    val state: String,
    val failure: String,
    val targetSha: String?,
    val quoted: List<String>,
    val steps: List<String>,
    val landingSessionId: String?,
) {
    /** The target as the card says it: a project branch is `the project branch`, which the title already names; anything else by name. */
    val targetWords: String get() = if (target.startsWith("project/")) LandingFixCopy.THE_PROJECT_BRANCH else target
}

object LandingFixTurns {
    private val HEAD = Regex("^Orbit could not land your work for \"(.*)\" on (\\S+)\\.$")
    private val CONFLICT = Regex("^Conflict while (rebasing onto|merging into|syncing \\S+ into) (\\S+?)(?: at ([0-9a-f]{7,40}))?:$")
    /** `The check "<label>"[ (<command>)] failed on the combined tree[ (<sha>)], exit <n>:` — the command may hold anything. */
    private val CHECK = Regex("^The check \".*\" (?:\\(.*\\) )?failed on the combined tree.*:$")
    private val RECORD = Regex("^The full record: landing (\\S+)\\.$")
    private val STEP = Regex("^([123])\\. (.+)$")

    /** Whether [text] is a landing-fix turn's words: the head, a failure, and the three steps under it. */
    fun parse(text: String?): LandingFixTurn? {
        if (text == null || !text.startsWith(LandingFixCopy.HEAD)) return null
        val lines = text.replace("\r", "").split("\n")
        val head = HEAD.matchEntire(lines.first()) ?: return null
        val pushed = lines.indexOfFirst { it.startsWith("Nothing was pushed.") }.takeIf { it > 1 } ?: return null
        val failure = lines.subList(1, pushed).filter { it.isNotBlank() }
        val first = failure.firstOrNull() ?: return null
        val conflict = CONFLICT.matchEntire(first)
        val state = when {
            conflict != null -> "CONFLICT"
            CHECK.matches(first) -> "CHECK_FAILED"
            else -> return null
        }
        val quoted = failure.drop(1).let { rest ->
            if (state == "CONFLICT") rest.flatMap { it.split(", ") }.map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("(") } else rest
        }
        val steps = lines.drop(pushed).mapNotNull { STEP.matchEntire(it)?.groupValues?.get(2) }
        if (steps.size != 3) return null
        val landing = lines.firstNotNullOfOrNull { RECORD.matchEntire(it)?.groupValues?.get(1) }?.takeIf { it != "not" }
        return LandingFixTurn(head.groupValues[1], head.groupValues[2], state, first.removeSuffix(":"),
            conflict?.groupValues?.get(3)?.takeIf { it.isNotEmpty() }, quoted, steps, landing)
    }

    /**
     * The sentence under the card's title (board ② b): for a conflict, how it conflicted and at which commit of the target — the target said
     * as [LandingFixTurn.targetWords], as the title already names it; for a failed check, the turn's own sentence.
     */
    fun sentence(turn: LandingFixTurn): String {
        if (turn.state != "CONFLICT") return turn.failure
        val verb = CONFLICT.matchEntire("${turn.failure}:")?.groupValues?.get(1) ?: return turn.failure
        return "Conflict while $verb ${turn.targetWords}"
    }

    /** A step as the card says it: the target named as [LandingFixTurn.targetWords], the rest the turn's words. */
    fun step(turn: LandingFixTurn, step: String): String =
        if (turn.target.startsWith("project/")) step.replace(turn.target, LandingFixCopy.THE_PROJECT_BRANCH) else step
}
