package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import java.time.ZoneId

/**
 * The card a session draws when no engine ever ran on it (A08-5; iOS 698b707ea, OrbitKit `SessionRunStart`): "This run never started".
 * Two tiers, one card. A refused SOURCE (`sourceState == REFUSED`) is terminal, so the way on is a new run — "Start it again" — and
 * the card carries the code, the ref and the runner's own words the server wrote down, in the prose of its `fixAction`. A machine-side
 * reason (`error` on a failed or queued run) leaves the conversation resumable — "Send it again" — or waits on the runner. An
 * Antigravity or DeepSeek Harness engine that is missing or refusing to start is not claimed here: those have cards of their own. A
 * Claude turn the runner refused for its region (docs/claude-region-check-contract.md, board 03) is claimed before every reason read by
 * pattern, with its three ways out.
 */
object SessionRunStart {
    const val title = "This run never started"
    const val refusedState = "REFUSED"
    const val unresolvedBlockerKind = "SOURCE_UNRESOLVED"
    const val chatAction = "Chat about this"
    const val startItAgain = "Start it again"
    const val startingAgain = "Starting a new run…"
    const val offlineLabel = "Disconnected — runner went offline"
    const val installAdvice = "Install it from the Machines & models page, then send your message again."
    /** What a press of "Chat about this" puts in the composer. */
    const val chatPrefix = "About this run: "

    /** The region check's three ways out (board 03) are OTHER_PROVIDER — the same Claude Code on a credential Anthropic isn't behind —
     * MOVE_SESSION, to a workspace on another machine, and CHECK_AGAIN, a check now. */
    enum class Kind { START_IT_AGAIN, SEND_IT_AGAIN, OPEN_RUNNER, CHAT_ABOUT_THIS, OTHER_PROVIDER, MOVE_SESSION, CHECK_AGAIN }
    data class Action(val kind: Kind, val label: String) {
        /** The press that answers the card, rather than the one that only looks around. */
        val primary: Boolean get() = kind == Kind.START_IT_AGAIN || kind == Kind.SEND_IT_AGAIN || kind == Kind.OTHER_PROVIDER
    }
    /** A page the body cites, linked after it (the region check's Supported regions): its words and where it goes. */
    data class Link(val label: String, val url: String)
    data class Card(val why: String, val body: String, val lines: List<String> = emptyList(), val actions: List<Action> = emptyList(),
        val footer: String? = null, val link: Link? = null)

    /** The card for a session whose engine never ran, read off its row ([detail], GET /sessions/:id), or null for one this card has
     * nothing to say about. [runnerName] and [runnerVersion] are the assigned runner's; [region] is where its Claude connection last came
     * out (the runner's `region` on GET /runners) — the place a region refusal names, never read out of its sentence. */
    fun card(detail: JsonObject, runnerName: String? = null, runnerVersion: String? = null, region: JsonObject? = null,
        nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): Card? {
        refusalCard(detail.text("sourceState"), detail.text("sourceRefusalCode"), detail.obj("sourceRefusalDetail"))?.let { return it }
        val status = detail.text("runStatus") ?: detail.text("status")
        if (!machineReasonStands(status)) return null
        return machineCard(detail.text("error"), runnerName, runnerVersion, status, region, nowMs, zone)
    }

    /** A machine-side reason is still this session's news only on a failed or queued run. */
    fun machineReasonStands(status: String?) = status == "FAILED" || status == "PENDING"

    /** What the runner said, in whichever key it used — blank counts as unsaid (`SourceRefusalDetail.said`). */
    fun said(detail: JsonObject?): String? = listOf(detail?.text("stderr"), detail?.text("reason")).firstNotNullOfOrNull { it?.trim()?.ifEmpty { null } }

    fun refusalCard(sourceState: String?, code: String?, detail: JsonObject?): Card? {
        if (sourceState != refusedState) return null
        val (why, body) = refusalProse(detail?.text("fixAction"))
        return Card(why, body, listOfNotNull(code, detail?.text("ref"), said(detail)),
            listOf(Action(Kind.START_IT_AGAIN, startItAgain), Action(Kind.CHAT_ABOUT_THIS, chatAction)),
            "No engine ran — the task is still open.")
    }

    /** The two lines of prose, by the server's `fixAction` — never by the code, so explanation and advice cannot disagree. */
    fun refusalProse(fixAction: String?): Pair<String, String> = when (fixAction) {
        "FIX_REF" -> "Its baseline is a branch that doesn't exist yet" to "This project's integration line has not been created."
        "SYNC_INTEGRATION_LINE" -> "The line hasn't absorbed what the prerequisite landed" to
            "The commit this run needed has landed upstream, and this project's line has not caught up with it."
        "RESTORE_COMMIT" -> "This run's commit isn't in the runner's repository" to
            "The commit is pinned, so the machine that was going to start from it has to have it."
        "ENABLE_ISOLATION" -> "The runner couldn't make an isolated checkout" to
            "This run needed its own worktree on the pinned commit, and the workspace wouldn't give it one."
        "BIND_CODEBASE" -> "This project has no repository bound to it" to
            "A task that produces code starts from a commit, and nothing says which repository this project's code lives in."
        "FIX_WORKSPACE_REPO" -> "This workspace's checkout isn't this project's repository" to
            "The run starts from the project's repository, and the machine it was handed checks out a different one."
        "RETRY_OR_FIX_CREDENTIALS" -> "The runner couldn't reach the repository" to
            "Asking the authority for this ref failed — the network, the credentials or the remote itself."
        "FIX_CODEBASE_CONFIG" -> "This project's repository binding isn't usable" to
            "A ref name or a commit in it is written in a form the server won't resolve."
        else -> "This run's baseline couldn't be resolved" to
            "The start stopped before an engine was given anything to do, and starting it again alone would meet the same refusal."
    }

    /** The server's own next step for a refusal (`dispatchRefusalNextStep`), which the project's blocker carries as its required
     * action. */
    fun nextStep(fixAction: String?, ref: String?): String {
        val again = "Until then, a new start meets the same refusal."
        val line = ref?.let { "the integration line ${branchName(it)}" } ?: "the line this run starts from"
        return when (fixAction) {
            "SYNC_INTEGRATION_LINE" -> "The dependency has landed — what is missing is its landed commit on ${line}: the dependency's work " +
                "reached upstream, and this line has not taken in upstream yet. Bring this line up to date with " +
                "upstream first (the main sync at the next task landing does that; if it cannot wait, merge upstream " +
                "into this line from its tip and push it back, with no rebase and no force push), then start it. " +
                "Until then, a new start meets the same refusal: it begins from the same tip and asks for the same " +
                "commits."
            "FIX_REF" -> "The repository had no ${ref?.let { "`$it`" } ?: "ref for this run to start from"} when " +
                "it was resolved: it does not exist yet, it was deleted, or it does not match the name in the " +
                "project's binding. Create it first (this project's first landing on this line creates it), or " +
                "change the binding's integrationRef to the one that exists, then start it. " + again
            "RESTORE_COMMIT" -> "The repository of the runner that runs it does not have the pinned commit: fetch or restore it " +
                "into that repository, then start it. " + again
            "ENABLE_ISOLATION" -> "The runner could not create a separate worktree at the pinned commit: check that " +
                "this workspace's workDir is a git repository and that worktree isolation is not turned off, " +
                "and work through the `git worktree add` error in " +
                "the runner's own words above, then start it. " + again
            else -> "Fix it as ${fixAction.orEmpty()} says, then start it. " + again
        }
    }

    /** The branch a full ref names; a ref outside `refs/heads/` comes back whole. */
    fun branchName(ref: String) = ref.removePrefix("refs/heads/")

    fun machineCard(error: String?, runnerName: String?, runnerVersion: String?, status: String? = "FAILED", region: JsonObject? = null,
        nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): Card? {
        val said = error?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val machine = runnerName?.takeIf { it.isNotEmpty() } ?: "this runner"
        // Before anything read by pattern: the region refusal is the only reason here with a code of its own, and the machine's name in
        // its sentence could hold any of the words the tests below look for (web `machineCause`).
        if (ClaudeRegion.isRegionError(said)) return regionCard(said, machine, status, region, nowMs, zone)
        // An Antigravity or DeepSeek Harness engine repair has a card of its own: one fact, one card.
        if (antigravityRepair(said) || dshRepair(said)) return null
        if (said.lowercase().contains("offline")) return Card("The runner holding this session went offline",
            "$machine stopped reporting while this run was starting. Nothing was produced, and nothing was sent anywhere.",
            listOf(offlineLabel), listOf(Action(Kind.SEND_IT_AGAIN, "Send it again"), Action(Kind.CHAT_ABOUT_THIS, chatAction)),
            "No engine ran — your message is still here.")
        runnerUpgrade(said)?.let { (engine, needs) ->
            return Card("Waiting for a newer runner",
                "$machine runs Orbit runner ${runnerVersion?.takeIf { it.isNotEmpty() } ?: "an unknown version"}; $engine needs $needs. " +
                    "The runner updates itself when no session is running on it, and this run starts then.",
                actions = listOf(Action(Kind.OPEN_RUNNER, "Open the runner")), footer = "No engine ran — your message is still here.")
        }
        notInstalled(said)?.let { engine ->
            return Card("$engine isn't installed on $machine", installAdvice, actions = listOf(Action(Kind.OPEN_RUNNER, "Open the runner")),
                footer = "No engine ran — your message is still here.")
        }
        return null
    }

    /** The web card's two feet, word for word (`RunNeverStartedCard.tsx`'s `waitingFoot` and `endedFoot`): the region card's, whose
     * message still waits — or, from a control plane that predates the hold, whose run it failed. */
    const val waitingFoot = "No engine ran · your message is still here"
    const val endedFoot = "Ended · no engine ran · 0 turns"

    /**
     * An Anthropic-bound Claude turn this machine's runner refused because its connection to Anthropic is in a region Anthropic doesn't
     * offer Claude in (docs/claude-region-check-contract.md §9–§11): the control plane holds the session in the queue, with the refusal
     * in its error — the web's `regionUnsupported`, OrbitKit's `regionCard`, board 03's card.
     *
     * The code says which reason this is; the place comes from [region], never from the sentence. A runner whose region no longer reads
     * blocked — a check passed, the hold is about to release — keeps the server's own words, without the code, rather than a place it no
     * longer reports. A turn stopped by a confirmed flip ran: on a control plane that predates the hold it is a failed run whose engine
     * spoke, and its sentence stands in the transcript instead.
     */
    fun regionCard(error: String, machine: String, status: String?, region: JsonObject?, nowMs: Long, zone: ZoneId): Card? {
        if (status == "FAILED" && ClaudeRegion.isStoppedSentence(error)) return null
        val place = region?.takeIf(ClaudeRegion::blocked)?.text("name")?.takeIf { it.isNotEmpty() }
        val lines = mutableListOf<String>()
        val body = if (region != null && place != null) {
            // Ukraine's excluded regions carry their own code (UA-43): the country alone is a listed one.
            lines += ClaudeRegionCopy.claudeRegionSubject(region.text("regionCode") ?: region.text("country"))
            region.text("checkedAt")?.let { ClaudeRegion.checkTime(it, nowMs, zone) }?.let { at ->
                lines += ClaudeRegionCopy.claudeRegionChecked(at, place, region.flag("viaProxy"))
            }
            ClaudeRegionCopy.claudeRegionConnectionIsIn(machine, place)
        } else {
            lines += ClaudeRegionCopy.claudeRegionSubject(null)
            error.substring(error.indexOf(':') + 1).trim()
        }
        return Card(ClaudeRegionCopy.claudeRegionCantUseAnthropicOn(machine), body, lines,
            listOf(Action(Kind.OTHER_PROVIDER, ClaudeRegionCopy.CLAUDE_REGION_USE_ANOTHER_PROVIDER),
                Action(Kind.MOVE_SESSION, ClaudeRegionCopy.CLAUDE_REGION_MOVE_TO_ANOTHER_MACHINE),
                Action(Kind.CHECK_AGAIN, ClaudeRegionCopy.CLAUDE_REGION_CHECK_AGAIN)),
            // Held, the message is still queued; a control plane that predates the hold failed the run.
            if (status == "FAILED") endedFoot else waitingFoot,
            Link(ClaudeRegionCopy.CLAUDE_REGION_SUPPORTED_REGIONS, ClaudeRegionCopy.CLAUDE_REGION_SUPPORTED_REGIONS_URL))
    }

    fun notInstalled(error: String): String? {
        val at = error.indexOf(" isn't installed on this runner")
        return if (at <= 0) null else error.substring(0, at)
    }

    /** The engine and the release it wants, out of the server's claim sentences: "OpenCode requires Orbit runner 0.1.82 or newer;
     * update this runner first", and the unversioned twins. */
    fun runnerUpgrade(error: String): Pair<String, String>? {
        val suffix = "; update this runner first"
        if (!error.endsWith(suffix)) return null
        val marker = error.indexOf(" requires ")
        if (marker <= 0) return null
        val engine = error.substring(0, marker)
        val requirement = error.substring(marker + " requires ".length, error.length - suffix.length)
        val version = requirement.indexOf("Orbit runner ")
        if (version >= 0 && requirement.endsWith(" or newer")) {
            return engine to "${requirement.substring(version + "Orbit runner ".length, requirement.length - " or newer".length)} or newer"
        }
        return engine to "a newer release"
    }

    /** OrbitKit `EngineAuth.antigravityRepair`: the failures the Antigravity repair card answers. */
    fun antigravityRepair(message: String) = AntigravityRepair.of(message) != null

    /** OrbitKit `DshRuntime.repair`: the failures the DeepSeek Harness repair card answers. */
    fun dshRepair(message: String) = DshRuntime.repair(message) != null

    /** The project blocker's lines for a refused source (OrbitKit `ProjectPage.blockerSourceLines`): its code and ref on one line, then
     * the tasks it refuses, each by its title on the page or its id. Nothing for any other kind. */
    fun blockerSourceLines(blocker: JsonObject, titleFor: (String) -> String?): List<String> {
        if (blocker.text("kind") != unresolvedBlockerKind) return emptyList()
        val detail = blocker.obj("detail")
        return buildList {
            listOfNotNull(detail?.text("code"), detail?.text("ref")).filter { it.isNotEmpty() }.takeIf { it.isNotEmpty() }?.let { add(it.joinToString(" · ")) }
            detail?.strings("taskIds").orEmpty().forEach { id -> add(titleFor(id)?.takeIf { it.isNotEmpty() } ?: id) }
        }
    }
}
