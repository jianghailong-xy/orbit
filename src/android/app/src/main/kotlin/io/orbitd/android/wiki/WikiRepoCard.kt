package io.orbitd.android.wiki

import java.time.Instant
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The Settings maintenance card's repository part, and the settings' probe under the workspace picker
 * (docs/wiki-repo-tiers-design.md §7.3, mock 44 ⑤) — the web's `lib/wikiRepoCard.ts` and OrbitKit's
 * `WikiRepoCardLogic`, all three held to `src/shared/src/wiki-repo-card.fixture.json` (`WikiRepoCardTest`). */
internal object WikiRepoCardCopy {
    const val checkAndRun = "Check again and run now"
    const val changeWorkspace = "Change workspace…"
    const val useFolder = "Use this folder"
    const val dailyLimit = "Daily limit reached"
    const val runUnderWay = "A run is under way"
    const val lastRunFailed = "Last run failed"
    const val lastRunFailedLine = "The last run failed"
    const val useFolderTitle = "Use this folder?"
    const val useFolderNote =
        "The next run keeps this folder's snapshot even though it shares few files with the last one, and later runs compare with it."
    const val runStarted = "Maintenance run started"
    const val runRefused = "Couldn't start the run"
    const val probeChecking = "Checking the folder…"
    const val probeFailed = "Could not check the folder"
    const val folderReading = "Folder, not git · commit anchors off"
}

/** What the card says of the last run's read, and what may be pressed. */
internal data class WikiRepoCard(
    val tag: String, val tone: Tone, val line: String, val canRun: Boolean, val blocked: String?, val useFolder: Boolean,
) {
    enum class Tone { MUTED, WARN, ERROR }
}

internal object WikiRepoCardLogic {
    /** The web's `wikiRepoCard`: null while maintenance is off, or the last run read git and did not fail. */
    fun card(health: WikiSpaceHealth, now: Instant): WikiRepoCard? {
        val maintenance = health.maintenance
        if (!maintenance.enabled) return null
        val repo = health.repo
        val tier = repo?.tier?.takeIf { it in setOf("git", "folder", "sessions", "wrong_repository") }
        val failed = maintenance.lastRun?.outcome == "failed"
        if ((tier == null || tier == "git") && !failed) return null
        val (tag, tone) = when (tier) {
            "folder" -> WikiHealthCopy.repoFolderShort to WikiRepoCard.Tone.MUTED
            "sessions" -> WikiHealthCopy.repoPaused to (if (repo.reason == "fetch_refused") WikiRepoCard.Tone.ERROR else WikiRepoCard.Tone.WARN)
            "wrong_repository" -> WikiHealthCopy.repoWrongShort to WikiRepoCard.Tone.ERROR
            else -> WikiRepoCardCopy.lastRunFailed to WikiRepoCard.Tone.ERROR
        }
        val said = when (tier) {
            "folder" -> WikiRepoCardCopy.folderReading
            "sessions", "wrong_repository" -> repo.detail ?: tag
            else -> WikiRepoCardCopy.lastRunFailedLine
        }
        val `when` = repo?.checkedAt ?: maintenance.lastRun?.endedAt
        val line = if (`when` != null) "$said · checked ${WikiHealthLogic.ago(`when`, now)}" else said
        val blocked = when {
            maintenance.running != null -> WikiRepoCardCopy.runUnderWay
            maintenance.dailyLimitReached -> WikiRepoCardCopy.dailyLimit
            else -> null
        }
        return WikiRepoCard(tag, tone, line, blocked == null, blocked, repo?.reason == "path_overlap")
    }
}

/** `POST /api/wiki/spaces/:id/maintenance/probe` (contract `maintenance.probe`): the tier the chosen workspace's folder
 * would be read on, in the server's words. [tone] is ok, folder, paused, wrong or unchecked. */
internal data class WikiRepoProbeAnswer(
    val workspaceId: String, val tier: String?, val reason: String?, val tone: String, val title: String, val note: String?,
    val canTurnOn: Boolean,
) {
    companion object {
        fun read(element: JsonElement?): WikiRepoProbeAnswer? {
            val c = element as? JsonObject ?: return null
            return WikiRepoProbeAnswer(c["workspaceId"].text() ?: "", c["tier"].text(), c["reason"].text(),
                c["tone"].text() ?: "unchecked", c["title"].text() ?: return null, c["note"].text(), c["canTurnOn"].bool() ?: true)
        }
    }
}
