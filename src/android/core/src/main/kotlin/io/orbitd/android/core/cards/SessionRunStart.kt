package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/**
 * The card a session draws when no engine ever ran on it (A08-5; iOS 698b707ea, OrbitKit `SessionRunStart`): "This run never started".
 * Two tiers, one card. A refused SOURCE (`sourceState == REFUSED`) is terminal, so the way on is a new run — "Start it again" — and
 * the card carries the code, the ref and the runner's own words the server wrote down, in the prose of its `fixAction`. A machine-side
 * reason (`error` on a failed or queued run) leaves the conversation resumable — "Send it again" — or waits on the runner. An
 * Antigravity or DeepSeek Harness engine that is missing or refusing to start is not claimed here: those have cards of their own.
 */
object SessionRunStart {
    const val title = "This run never started"
    const val refusedState = "REFUSED"
    const val unresolvedBlockerKind = "SOURCE_UNRESOLVED"
    const val chatAction = "Chat about this"
    const val startItAgain = "Start it again"
    const val startingAgain = "Starting a new run…"
    const val offlineLabel = "Disconnected — runner went offline"
    const val installAdvice = "Install it from Infrastructure, then send your message again."
    /** What a press of "Chat about this" puts in the composer. */
    const val chatPrefix = "About this run: "

    enum class Kind { START_IT_AGAIN, SEND_IT_AGAIN, OPEN_RUNNER, CHAT_ABOUT_THIS }
    data class Action(val kind: Kind, val label: String) {
        /** The press that answers the card, rather than the one that only looks around. */
        val primary: Boolean get() = kind == Kind.START_IT_AGAIN || kind == Kind.SEND_IT_AGAIN
    }
    data class Card(val why: String, val body: String, val lines: List<String> = emptyList(), val actions: List<Action> = emptyList(),
        val footer: String? = null)

    /** The card for a session whose engine never ran, read off its row ([detail], GET /sessions/:id), or null for one this card has
     * nothing to say about. [runnerName] and [runnerVersion] are the assigned runner's. */
    fun card(detail: JsonObject, runnerName: String? = null, runnerVersion: String? = null): Card? {
        refusalCard(detail.text("sourceState"), detail.text("sourceRefusalCode"), detail.obj("sourceRefusalDetail"))?.let { return it }
        val status = detail.text("runStatus") ?: detail.text("status")
        if (!machineReasonStands(status)) return null
        return machineCard(detail.text("error"), runnerName, runnerVersion)
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
        val again = "在那之前重新开工只会得到同一个拒绝。"
        val line = ref?.let { "集成线 ${branchName(it)}" } ?: "这次起跑的线"
        return when (fixAction) {
            "SYNC_INTEGRATION_LINE" -> "前置已经落地了——缺的是它落地的提交不在${line}上：前置的成果进了 upstream，而这条线还没吸收 " +
                "upstream。先让这条线追上它（下一次任务落地时的 main 同步会做；等不及就从这条线的 tip 出发把 " +
                "upstream 合进来、推回这条线，不 rebase、不 force push），再开工。" +
                "在那之前重新开工只会得到同一个拒绝：新的开工从同一个 tip 起跑，要求的是同一组提交。"
            "FIX_REF" -> "解析的时候仓库里没有 ${ref?.let { "`$it`" } ?: "这次起跑要用的 ref"}：" +
                "它还不存在、已经被删掉，或者和项目绑定里的名字对不上。先把它建出来" +
                "（这个项目在这条线上的第一次落地会创建它），或者把绑定的 integrationRef 改成实际存在的那一条，" +
                "再开工。" + again
            "RESTORE_COMMIT" -> "执行它的 runner 的仓库里没有这次钉住的提交：把它取回或恢复到那个仓库里，再开工。" + again
            "ENABLE_ISOLATION" -> "runner 没能在钉住的提交上建出独立的 worktree：确认这个工作区的 workDir 是 git 仓库、" +
                "没有关掉 worktree 隔离，并按上面 runner 的原话排查 `git worktree add` 的报错，再开工。" + again
            else -> "按处置 ${fixAction.orEmpty()} 修好之后再开工。" + again
        }
    }

    /** The branch a full ref names; a ref outside `refs/heads/` comes back whole. */
    fun branchName(ref: String) = ref.removePrefix("refs/heads/")

    fun machineCard(error: String?, runnerName: String?, runnerVersion: String?): Card? {
        val said = error?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        // An Antigravity or DeepSeek Harness engine repair has a card of its own: one fact, one card.
        if (antigravityRepair(said) || dshRepair(said)) return null
        val machine = runnerName?.takeIf { it.isNotEmpty() } ?: "this runner"
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
    fun antigravityRepair(message: String) =
        message.startsWith("Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one") ||
            message == "Antigravity requires a newer Orbit runner; update this runner first" ||
            message.contains("Antigravity isn't installed") || message.contains("Antigravity CLI isn't installed") ||
            message.contains("Antigravity CLI (\"agy\") not found")

    private val dshKeyRejected = listOf("invalid api key", "api key is invalid", "authentication_error", "authentication fails", "unauthorized",
        "status 401", "status code 401", "http 401", "revoked api key", "api key has been revoked", "invalid credentials")

    /** OrbitKit `DshRuntime.repair`: the failures the DeepSeek Harness repair card answers. */
    fun dshRepair(message: String): Boolean {
        if (message.startsWith("DSH_REQUEST_FAILED")) return false
        if (listOf("DSH_CREDENTIAL_MISSING", "DSH_CREDENTIAL_INVALID", "DSH_NOT_INSTALLED", "DSH_PLATFORM_UNSUPPORTED", "DSH_NODE_UNSUPPORTED")
                .any { message.contains(it) }) return true
        if (message.startsWith("DeepSeek Harness requires a newer Orbit runner")) return true
        val lower = message.lowercase()
        if (!lower.startsWith("dsh ")) return false
        if (lower.contains("no api key") || lower.contains("missing api key")) return true
        return dshKeyRejected.any { lower.contains(it) } || Regex("api key(?:: *\\S+)? is invalid").containsMatchIn(lower)
    }

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
