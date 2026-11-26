package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

// The landing's pull request states and the workspace's landing setting (docs/mocks/protected-branch-landing, owner 2026-11-23;
// design §11.2), the web's `LandingPullRequest.tsx` and `WorkspaceLandingSetting.tsx` word for word. Read from the `pullRequest` block
// the landing read models carry and the `landing` block of `GET /workspaces/:id`; nothing is guessed from other fields.

enum class PullRequestStage { OPENED, WAITING_FOR_REVIEW, CHECK_FAILED, CATCHING_UP, MERGED, CLOSED, FELL_BACK }

enum class PullRequestTone { BLUE, GREEN, RED, AMBER }

enum class PullRequestSegment { PASSED, FAILED, PENDING }

/** One link under the card: [href] is a GitHub URL, or null for "Landing settings", which opens the workspace's own page. */
data class PullRequestAction(val label: String, val href: String?)

data class PullRequestCardModel(
    val stage: PullRequestStage,
    val head: String,
    /** "2 of 6", "6 of 6 ✓", or null when the card keeps nothing at the right. */
    val right: String?,
    val detail: String,
    val tone: PullRequestTone,
    /** One segment per required check. */
    val segments: List<PullRequestSegment>,
    val actions: List<PullRequestAction>,
)

object PullRequestWords {
    const val VIEW = "View on GitHub ↗"
    const val REVIEW = "Review on GitHub ↗"
    const val LOG = "View log ↗"
    const val SETTINGS = "Landing settings"
    const val TIP = "Faster next time: with Push as me, landings go straight to main when you may push there, without waiting for a pull request."
    const val TIP_LINK = "Landing settings ›"
    const val DISMISS = "Hide this tip"
    const val OPEN_SESSION = "Open session"
    /** An attempt held on its pull request: it stopped nothing, it waits for GitHub (design §4.2). */
    const val WAITING_FOR_GITHUB = "Waiting for GitHub"
}

object LandingPullRequest {
    /** The pull request block a read model carries, or null when it carries none. */
    fun of(owner: JsonObject?): JsonObject? = owner?.obj("pullRequest")

    fun card(pr: JsonObject, main: String): PullRequestCardModel {
        val number = (pr["number"] as? JsonPrimitive)?.intOrNull?.let { "#$it" }.orEmpty()
        val url = pr.text("url")?.takeIf { it.isNotEmpty() }
        val view = url?.let { listOf(PullRequestAction(PullRequestWords.VIEW, it)) }.orEmpty()
        val checks = pr.obj("checks")
        val passed = checks?.number("passed") ?: 0
        val required = checks?.number("required") ?: 0
        val failed = checks?.objects("failed").orEmpty()
        val segments = List(maxOf(required, 0)) { i ->
            if (i < passed) PullRequestSegment.PASSED else if (i < passed + failed.size) PullRequestSegment.FAILED else PullRequestSegment.PENDING
        }
        // No required check reported yet (a read made before CI registered one) is no count, never "0 of 0".
        val count = if (required > 0) "$passed of $required" else null
        val state = pr.text("state")
        val condition = pr.text("condition")
        val refusal = pr.obj("refusal")

        if (state == "MERGED") {
            val sha = pr.text("mergedSha")?.takeIf { it.isNotEmpty() }?.take(7)
            return PullRequestCardModel(PullRequestStage.MERGED, "Landed by pull request $number".trim(), null,
                "Merged into $main${if (sha != null) " · $sha" else ""}", PullRequestTone.GREEN, segments, view)
        }
        if (state == "CLOSED") {
            return PullRequestCardModel(PullRequestStage.CLOSED, "Pull request closed", null,
                "Pull request $number was closed without merging it.".replace("  ", " "), PullRequestTone.RED, segments, view)
        }
        if (condition == "CHECK_FAILED" && failed.isNotEmpty()) {
            val first = failed.first()
            return PullRequestCardModel(PullRequestStage.CHECK_FAILED, "Check failed: ${first.text("name").orEmpty()}", null,
                "Sent back to the session with the log. Fixes update this pull request.", PullRequestTone.RED, segments,
                listOfNotNull(first.text("url")?.takeIf { it.isNotEmpty() }?.let { PullRequestAction(PullRequestWords.LOG, it) }) + view)
        }
        if (refusal?.text("via") == "PUSH_AS_ME") {
            return PullRequestCardModel(PullRequestStage.FELL_BACK, "Opened a pull request instead", "Push refused",
                "GitHub refused the push to $main: “${refusal.text("message").orEmpty()}” Landing through pull request $number.",
                PullRequestTone.AMBER, segments, view + PullRequestAction(PullRequestWords.SETTINGS, null))
        }
        if (condition == "BEHIND") {
            return PullRequestCardModel(PullRequestStage.CATCHING_UP, "Catching up with $main", count,
                "$main moved since the pull request opened. Orbit is checking the branch again on the new $main.", PullRequestTone.BLUE, segments, view)
        }
        if (condition == "REVIEW_REQUIRED" || condition == "CHANGES_REQUESTED" || condition == "MERGEABLE") {
            return PullRequestCardModel(PullRequestStage.WAITING_FOR_REVIEW, "Waiting for review", count?.let { "$it ✓" },
                (if (count != null) "Checks passed. " else "") + "$main requires an approving review.", PullRequestTone.BLUE, segments,
                url?.let { listOf(PullRequestAction(PullRequestWords.REVIEW, it)) }.orEmpty())
        }
        return PullRequestCardModel(PullRequestStage.OPENED, "Pull request open", count,
            "$main requires a pull request. Waiting for the required checks.", PullRequestTone.BLUE, segments, view)
    }

    /** The Faster tip: on the waiting-for-review card only, and not once the workspace is on Push as me. */
    fun showsTip(model: PullRequestCardModel, workspaceMode: String?, hidden: Boolean): Boolean =
        model.stage == PullRequestStage.WAITING_FOR_REVIEW && !hidden && workspaceMode != "PUSH_AS_ME"
}

/** The workspace's landing setting: a "Landing" section with both choices visible (option A). */
object WorkspaceLandingWords {
    const val SECTION = "Landing"
    const val LEAD = "How finished work reaches main on GitHub."
    const val PULL_REQUEST = "Pull request"
    const val PULL_REQUEST_BODY =
        "Orbit pushes to main when GitHub allows it. When main requires a pull request, Orbit opens one and merges it once the branch's rules pass: required checks, and a review if one is required."
    const val PUSH_AS_ME = "Push as me"
    const val PUSH_AS_ME_BODY =
        "Orbit pushes to main with your GitHub account, so a landing doesn't wait for a pull request where you may push past main's rules. Needs the right to push to main. If GitHub refuses, Orbit opens a pull request instead."
    const val DEFAULT = "Default"
    const val FASTER = "Faster"
    const val NOT_CONNECTED = "Connect GitHub to push as yourself."
    const val CONNECT = "Connect GitHub ›"
    const val NOT_GITHUB = "Landings push with this machine's Git credential."
    const val REFUSED = "Push refused."
    const val CONNECT_AGAIN = "Connect GitHub again ›"
    const val REVIEW = "Review on GitHub ↗"

    fun permissionsText(account: String) = "Landing through pull requests starts once $account accepts Orbit's updated GitHub permissions."

    fun refusalText(branch: String, repo: String?, message: String) =
        "GitHub refused your last push to $branch${if (repo != null) " on $repo" else ""}: “$message” Landings here open a pull request until GitHub accepts your push. Connect GitHub again if your rights have changed."

    /** `owner/repo` of a GitHub URL, for the refusal notice. */
    fun repoSlug(url: String?): String? =
        Regex("github\\.com[/:]([^/]+/[^/.]+?)(?:\\.git)?/?$").find(url.orEmpty())?.groupValues?.get(1)
}
