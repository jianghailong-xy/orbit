package io.orbitd.android.reader

import kotlinx.serialization.json.*

/**
 * Main checkout Git (docs/main-checkout-git-contract.md, boards docs/mocks/main-checkout-git 01–04): the shapes the
 * Android client reads and sends, and the copy it draws, ported from `src/shared/src/mainCheckoutGit.ts` so the
 * card, the bar, the review sheet, the result lines and the isolation dialogs say what web says.
 * `MainCheckoutTest` holds this to `main-checkout-git.fixture.json`.
 */
internal object MainCheckout {
    const val CAPABILITY = "main-checkout-git/v1"
    const val NOTICE_CHANGED = "main-checkout-changed"
    const val NOTICE_RESULT = "main-checkout-action-result"
    /** The transcript row types the two notices become ([EngineReading]). */
    const val ROW_CARD = "main_checkout_card"
    const val ROW_RESULT = "main_checkout_result"
    const val FILE_LIMIT = 200
    const val CARD_VISIBLE_FILES = 8
    const val DIFF_PATHS_MAX = 20
    /** The states that block every merge into the checkout (apiserver `isBlockingRepoState`). */
    val BLOCKING_STATES = setOf("unmerged", "merge", "rebase", "cherry-pick", "revert")

    /** One changed path as a card or a snapshot lists it. Binary files carry no counts. */
    data class File(val path: String, val status: String, val additions: Int? = null, val deletions: Int? = null,
        val binary: Boolean = false, val untracked: Boolean = false)

    /** A `main-checkout-changed` notice: the card (board 01). */
    data class ChangedNotice(val root: String, val branch: String?, val files: List<File>, val fileCount: Int, val truncated: Boolean,
        val fingerprint: String)

    /** What `GET /workspaces/:id/main-checkout` answers (§10.4), or a bar's counts read from the workspace's heartbeat entry. */
    data class Snapshot(val root: String, val branch: String?, val head: String?, val state: String, val upstream: String?,
        val ahead: Int, val behind: Int, val files: List<File>, val fileCount: Int, val truncated: Boolean, val fingerprint: String,
        val checkedAt: String?)

    data class ManagedBranch(val projectId: String, val projectTitle: String, val role: String)

    data class View(val snapshot: Snapshot, val diffs: List<JsonObject>, val actionsSupported: Boolean, val managedBranch: ManagedBranch?,
        val inFlight: Pair<String, String>?)

    /** One action outcome (§6). */
    data class Result(val requestId: String, val kind: String, val root: String, val status: String, val code: String? = null,
        val branch: String? = null, val fileCount: Int? = null, val remaining: Int? = null, val rescueBranch: String? = null,
        val head: String? = null, val subject: String? = null, val upstream: String? = null, val remoteBefore: String? = null,
        val remoteAfter: String? = null, val targetSessionId: String? = null, val targetBranch: String? = null,
        val paths: List<String> = emptyList(), val state: String? = null, val ahead: Int? = null, val behind: Int? = null,
        val gitMessage: String? = null, val runnerName: String? = null, val minutes: Int? = null)

    // -----------------------------------------------------------------------------------------------------------
    // Reading the wire.

    private fun JsonObject.str(key: String) = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.int(key: String) = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
    private fun JsonObject.bool(key: String) = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true
    private fun JsonObject.objs(key: String) = (get(key) as? JsonArray).orEmpty().filterIsInstance<JsonObject>()

    fun file(o: JsonObject): File? = o.str("path")?.let {
        File(it, o.str("status") ?: "M", o.int("additions"), o.int("deletions"), o.bool("binary"), o.bool("untracked"))
    }

    fun changedNotice(fields: JsonObject): ChangedNotice? {
        if (fields.str("noticeKind") != NOTICE_CHANGED) return null
        val root = fields.str("root") ?: return null
        val files = fields.objs("files").mapNotNull(::file)
        return ChangedNotice(root, fields.str("branch"), files, fields.int("fileCount") ?: files.size, fields.bool("truncated"),
            fields.str("fingerprint").orEmpty())
    }

    fun result(o: JsonObject?): Result? {
        o ?: return null
        val kind = o.str("kind") ?: return null
        return Result(o.str("requestId").orEmpty(), kind, o.str("root").orEmpty(), o.str("status") ?: return null, o.str("code"),
            o.str("branch"), o.int("fileCount"), o.int("remaining"), o.str("rescueBranch"), o.str("head"), o.str("subject"), o.str("upstream"),
            o.str("remoteBefore"), o.str("remoteAfter"), o.str("targetSessionId"), o.str("targetBranch"),
            (o["paths"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }, o.str("state"), o.int("ahead"),
            o.int("behind"), o.str("gitMessage"), o.str("runnerName"), o.int("minutes"))
    }

    /** A `main-checkout-action-result` notice's result. */
    fun resultNotice(fields: JsonObject): Result? =
        if (fields.str("noticeKind") != NOTICE_RESULT) null else result(fields["result"] as? JsonObject)

    fun snapshot(o: JsonObject): Snapshot? {
        val root = o.str("root") ?: return null
        val files = o.objs("files").mapNotNull(::file)
        return Snapshot(root, o.str("branch"), o.str("head"), o.str("state") ?: "clean", o.str("upstream"), o.int("ahead") ?: 0,
            o.int("behind") ?: 0, files, o.int("fileCount") ?: files.size, o.bool("truncated"), o.str("fingerprint").orEmpty(), o.str("checkedAt"))
    }

    fun view(o: JsonObject): View? {
        val snapshot = (o["snapshot"] as? JsonObject)?.let(::snapshot) ?: return null
        val managed = (o["managedBranch"] as? JsonObject)?.let { m ->
            m.str("projectTitle")?.let { ManagedBranch(m.str("projectId").orEmpty(), it, m.str("role").orEmpty()) }
        }
        val inFlight = (o["inFlight"] as? JsonObject)?.let { f -> f.str("requestId")?.let { it to f.str("kind").orEmpty() } }
        return View(snapshot, o.objs("diffs"), o.bool("actionsSupported"), managed, inFlight)
    }

    // -----------------------------------------------------------------------------------------------------------
    // The bar (board 01⑤, 02④): read from the workspace's `repoHealth` (§4 counts) and `mainCheckoutActions`.

    /** What the bar draws: its status, and the one button it offers — Review while files are uncommitted, Push once only
     *  commits are left, none without the capability. Null hides the bar: a clean, pushed checkout, or one whose runner
     *  reports no counts (an older runner, or no repository). */
    data class Bar(val root: String, val branch: String?, val status: String, val fileCount: Int, val ahead: Int, val upstream: String?,
        val fingerprint: String, val state: String, val button: Button?)
    enum class Button { REVIEW, PUSH }

    fun bar(repoHealth: JsonObject?, actionsSupported: Boolean): Bar? {
        val h = repoHealth ?: return null
        val root = h.str("root") ?: return null
        val count = h.int("fileCount") ?: return null
        val ahead = h.int("ahead") ?: 0
        if (count <= 0 && ahead <= 0) return null
        val button = when {
            !actionsSupported -> null
            count > 0 -> Button.REVIEW
            else -> Button.PUSH
        }
        return Bar(root, h.str("branch"), barStatus(count, ahead), count, ahead, h.str("upstream"), h.str("fingerprint").orEmpty(),
            h.str("state") ?: "dirty", button)
    }

    /** A worktree session's bar says Review; a Shared session, whose files the review commits, says Review and commit…. */
    fun reviewLabel(isolated: Boolean) = if (isolated) COPY_REVIEW else COPY_REVIEW_AND_COMMIT_SHORT

    // -----------------------------------------------------------------------------------------------------------
    // Requests (§5): what `POST /workspaces/:id/main-checkout/actions` takes, each kind with only its own fields.

    data class Request(val kind: String, val root: String, val fingerprint: String, val requestId: String,
        val files: List<String>? = null, val message: String? = null, val targetSessionId: String? = null,
        val initiatedFromSessionId: String? = null)

    fun move(root: String, fingerprint: String, files: List<String>, targetSessionId: String, requestId: String, from: String?) =
        Request("move", root, fingerprint, requestId, files = files, targetSessionId = targetSessionId, initiatedFromSessionId = from)
    fun commit(root: String, fingerprint: String, files: List<String>, message: String, requestId: String, from: String?) =
        Request("commit", root, fingerprint, requestId, files = files, message = message.trim(), initiatedFromSessionId = from)
    fun push(root: String, fingerprint: String, requestId: String, from: String?) = Request("push", root, fingerprint, requestId, initiatedFromSessionId = from)
    fun rescue(root: String, fingerprint: String, requestId: String, from: String?) = Request("rescue", root, fingerprint, requestId, initiatedFromSessionId = from)

    /** The body, in the contract's field order; fields a kind does not take are never sent (the server answers them with 400). */
    fun encode(r: Request): JsonObject = buildJsonObject {
        put("kind", r.kind)
        put("root", r.root)
        put("fingerprint", r.fingerprint)
        if (r.kind == "move" || r.kind == "commit") r.files?.let { files -> putJsonArray("files") { files.forEach { add(it) } } }
        if (r.kind == "commit") r.message?.let { put("message", it) }
        if (r.kind == "move") r.targetSessionId?.let { put("targetSessionId", it) }
        put("requestId", r.requestId)
        r.initiatedFromSessionId?.let { put("initiatedFromSessionId", it) }
    }

    // -----------------------------------------------------------------------------------------------------------
    // Copy (shared `MAIN_CHECKOUT_COPY` and builders).

    const val COPY_LABEL = "Main checkout"
    const val COPY_MOVE_TO_THIS_WORKTREE = "Move to this worktree"
    const val COPY_MOVE_TO_A_WORKTREE = "Move to a worktree"
    const val COPY_SAVE_AND_CLEAN = "Save to a rescue branch and clean"
    const val COPY_SAVE_AND_CLEAN_HINT =
        "Keeps everything on orbit/rescue-…, then returns the main checkout to its last commit. Ignored files are left alone."
    const val COPY_ASK_AGENT = "Ask the agent about it"
    const val COPY_ASK_AGENT_HINT = "Puts a prompt in the composer; nothing changes until you send it."
    const val COPY_LEAVE_AS_IS = "Leave as is"
    const val COPY_REVIEW = "Review"
    const val COPY_REVIEW_AND_COMMIT_SHORT = "Review and commit…"
    const val COPY_REVIEW_MAIN_CHECKOUT = "Review main checkout"
    const val COPY_COMMIT_MESSAGE = "Commit message"
    const val COPY_NOT_SHOWN = "Not shown: files your .gitignore ignores. Untracked files are included."
    const val COPY_TARGET_OPENED_FROM = "The session you opened this from"
    const val COPY_TARGET_BUSY = "Working now — available when this turn ends"
    const val COPY_CLEAN_UP_CHECKOUT = "Clean up checkout"
    /** A handled card's muted line, in place of its Move hint (shared `MAIN_CHECKOUT_CARD_HANDLED_COPY`). */
    const val COPY_CARD_HANDLED_RESULT = "Handled — see the result below"
    const val COPY_CARD_HANDLED_GONE = "These changes are no longer in the main checkout"

    fun filesCount(n: Int) = "$n ${if (n == 1) "file" else "files"}"
    private fun uncommittedFiles(n: Int, other: Boolean = false) = "$n ${if (other) "other " else ""}uncommitted ${if (n == 1) "file" else "files"}"
    private fun commitsCount(n: Int) = "$n ${if (n == 1) "commit" else "commits"}"
    fun shortSha(sha: String?) = sha.orEmpty().take(7)

    /** "a", "a and b", "a, b and c", "a, b, c and 4 more". */
    fun namePaths(paths: List<String>): String = when {
        paths.size <= 1 -> paths.firstOrNull().orEmpty()
        paths.size <= 3 -> paths.dropLast(1).joinToString(", ") + " and " + paths.last()
        else -> paths.take(3).joinToString(", ") + " and ${paths.size - 3} more"
    }

    fun cardTitle(fileCount: Int, truncated: Boolean) =
        if (truncated) "At least ${filesCount(fileCount)} changed in the main checkout during this turn"
        else "${filesCount(fileCount)} changed in the main checkout during this turn"

    fun cardSubtitle(root: String, branch: String?) =
        "${if (branch != null) "$root on $branch" else root}, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them."

    fun moreFiles(hidden: Int) = "and $hidden more"
    fun truncatedNote(limit: Int = FILE_LIMIT) = "Orbit stopped counting at $limit files."
    fun reviewAndCommit(branch: String) = "Review and commit to $branch…"
    fun moveHint(sessionBranch: String) =
        "Copies them onto $sessionBranch, then clears them from the main checkout. A recovery branch is saved first."
    fun chooseFiles(chosen: Int, total: Int) = "Choose files to commit · $chosen of $total"
    fun commitButton(chosen: Int, branch: String) = "Commit ${filesCount(chosen)} to $branch"
    fun uncommitted(n: Int) = "$n uncommitted"

    fun barStatus(fileCount: Int, ahead: Int): String {
        val parts = mutableListOf(if (fileCount > 0) uncommittedFiles(fileCount) else "Clean")
        if (ahead > 0) parts += "${commitsCount(ahead)} not pushed"
        return parts.joinToString(" · ")
    }

    fun pushLabel(upstream: String) = "Push to $upstream"
    fun managedBranchWarning(projectTitle: String) = "This skips project $projectTitle's landing check."

    // -----------------------------------------------------------------------------------------------------------
    // Result lines (board 03; shared `mainCheckoutResultLine`).

    enum class Tone { OK, REFUSED, WAITING }
    data class Link(val action: String, val label: String)
    data class Line(val tone: Tone, val lead: String, val text: String, val link: Link? = null)

    private val NOTHING = mapOf("move" to "Nothing moved", "commit" to "Nothing committed", "push" to "Nothing pushed", "rescue" to "Nothing saved")
    private val GIT_VERB = mapOf("move" to "move", "commit" to "commit", "push" to "push", "rescue" to "save")
    private val CANT = mapOf("move" to "Can't move right now", "commit" to "Can't commit right now", "push" to "Can't push right now",
        "rescue" to "Can't save right now")

    private fun line(tone: Tone, lead: String, rest: String, link: Link? = null) = Line(tone, lead, lead + rest, link)

    private fun blockedState(state: String?) = when (state) {
        "unmerged" -> "has unresolved conflicts"
        "merge", "rebase", "revert" -> "is in the middle of a $state"
        "cherry-pick" -> "is in the middle of a cherry-pick"
        else -> "is in the middle of an unfinished operation"
    }

    private fun quoted(gitMessage: String?) = if (gitMessage.isNullOrEmpty()) "" else " (“$gitMessage”)"
    private fun remoteOf(upstream: String?) = upstream?.substringBefore('/')?.ifEmpty { null } ?: "origin"

    /** [sessionId]: the session the line is in; [targetTitle]: a move into another session's title; [isolated]: false in a Shared session. */
    fun resultLine(r: Result, sessionId: String? = null, targetTitle: String? = null, isolated: Boolean = true): Line {
        val branch = r.branch ?: "HEAD"
        val upstream = r.upstream ?: "origin/$branch"
        val nothing = NOTHING[r.kind] ?: "Nothing changed"
        val n = filesCount(r.fileCount ?: 0)
        val paths = r.paths
        if (r.status == "done") when (r.kind) {
            "move" -> {
                val into = if (targetTitle != null && r.targetSessionId != null && r.targetSessionId != sessionId)
                    "into the worktree of “$targetTitle”" else "into this worktree"
                val after = if ((r.remaining ?: 0) > 0) " The main checkout still has ${uncommittedFiles(r.remaining!!, true)}."
                    else " The main checkout is clean again."
                return line(Tone.OK, "Moved $n $into.", "$after A copy of what it held is on ${r.rescueBranch}.", Link("view-changes", "View changes"))
            }
            "commit" -> {
                val tail = if (!isolated) "" else " This session's branch is unchanged."
                return line(Tone.OK, "Committed $n to $branch",
                    " in the main checkout as ${shortSha(r.head)} “${r.subject.orEmpty()}”. Not pushed yet.$tail", Link("push", pushLabel(upstream)))
            }
            "push" -> {
                val remote = remoteOf(upstream)
                return if (r.remoteBefore != null) line(Tone.OK, "Pushed $branch to $remote", " (${shortSha(r.remoteBefore)}..${shortSha(r.remoteAfter)}).")
                else line(Tone.OK, "Pushed $branch to $remote", " as a new branch (${shortSha(r.remoteAfter)}).")
            }
            "rescue" -> return line(Tone.OK, "Saved $n to ${r.rescueBranch}",
                " and returned the main checkout to ${shortSha(r.head)}. Ignored files were left alone.", Link("open-in-new-session", "Open in a new session"))
        }
        val reviewAgain = Link("review-again", "Review again")
        val cant = CANT[r.kind] ?: "Can't do that right now"
        return when (r.code) {
            "FINGERPRINT_STALE" -> line(Tone.REFUSED, "$nothing:",
                " the main checkout changed since you looked${if (paths.isNotEmpty()) " (${namePaths(paths)})" else ""}.", reviewAgain)
            "HEAD_MOVED" -> line(Tone.REFUSED, "$nothing:", " $branch moved to ${shortSha(r.head)} since you looked.", reviewAgain)
            "MOVE_CONFLICT" -> {
                val one = paths.size == 1
                val it = if (one) "it" else "them"
                line(Tone.REFUSED, "$nothing:", " ${namePaths(paths)} ${if (one) "is" else "are"} also changed in this worktree, in the same lines. " +
                    "Commit $it to $branch or save $it to a rescue branch instead, or ask the agent to combine them.",
                    Link("ask-agent-combine", "ask the agent to combine them"))
            }
            "MOVE_SOURCE_CHANGED" -> line(Tone.REFUSED, "Copied $n into this worktree but left them in the main checkout:",
                " ${namePaths(paths)} changed while they were moving. A copy of what it held is on ${r.rescueBranch}.",
                Link("review-again", COPY_REVIEW_MAIN_CHECKOUT))
            "TARGET_BUSY" -> line(Tone.REFUSED, "$nothing:", " that session is working on a turn. Move the files when it ends.")
            "CHECKOUT_BLOCKED" -> line(Tone.REFUSED, "$cant:", " the main checkout ${blockedState(r.state)}.", Link("clean-up-checkout", COPY_CLEAN_UP_CHECKOUT))
            "DETACHED" -> line(Tone.REFUSED, "$cant:", " the main checkout isn't on a branch (detached HEAD).")
            "NO_HEAD" -> line(Tone.REFUSED, "$cant:", " the main checkout has no commits yet.")
            "NOTHING_TO_PUSH" -> line(Tone.REFUSED, "Nothing to push:", " $branch is already on $upstream.")
            "NO_REMOTE" -> line(Tone.REFUSED, "$nothing:", " $branch has no upstream and the main checkout has no remote named origin.")
            "PUSH_REJECTED" -> {
                val has = if ((r.behind ?: 0) > 0) "has ${commitsCount(r.behind!!)}" else "has commits"
                line(Tone.REFUSED, "Push rejected:", " $upstream $has the main checkout doesn't. Nothing was changed, and Orbit never force-pushes.",
                    Link("ask-agent-rebase-push", "Ask the agent to rebase and push"))
            }
            "PUSH_AUTH_FAILED" -> line(Tone.REFUSED, "Push failed:",
                " the runner's git couldn't authenticate to ${remoteOf(upstream)}${quoted(r.gitMessage)}. Your commit is still in the main checkout.")
            "PUSH_FAILED" -> line(Tone.REFUSED, "Push failed:",
                " git couldn't push to ${remoteOf(upstream)}${quoted(r.gitMessage)}. Your commit is still in the main checkout.")
            "RESCUE_FAILED" -> line(Tone.REFUSED, "$nothing:",
                " Orbit couldn't save the main checkout to a rescue branch first${quoted(r.gitMessage)}. The main checkout was left as it was.")
            "ACTION_FAILED" -> line(Tone.REFUSED, "$nothing:",
                " git couldn't ${GIT_VERB[r.kind] ?: r.kind}${quoted(r.gitMessage)}. The main checkout was left as it was.")
            "ACTION_IN_FLIGHT" -> line(Tone.REFUSED, "$nothing:", " another action on this main checkout is still running. Try again when it finishes.")
            "CHECKOUT_NOT_REPORTED" -> line(Tone.REFUSED, "$nothing:",
                " ${r.runnerName ?: "the runner"} hasn't reported this main checkout yet. Try again in a minute.")
            "RUNNER_OFFLINE" -> line(Tone.WAITING, "Waiting for the runner",
                " — ${r.runnerName ?: "the runner"} hasn't checked in for ${r.minutes ?: 0} min. " +
                    "Nothing has been changed; this runs when it's back, or you can cancel.", Link("cancel", "Cancel"))
            "TIMEOUT" -> line(Tone.REFUSED, "Timed out:",
                " ${r.runnerName ?: "the runner"} didn't answer within ${r.minutes ?: 0} min, so Orbit stopped waiting. " +
                    "If it ran the action anyway, its result will appear here.")
            "CANCELLED" -> line(Tone.REFUSED, "Cancelled:", " nothing was changed.")
            else -> line(Tone.REFUSED, "$nothing.", "")
        }
    }

    // -----------------------------------------------------------------------------------------------------------
    // A handled card (shared `mainCheckoutCardHandled`): kept as history, its buttons held, one muted line saying why.

    enum class Handled(val line: String) { RESULT(COPY_CARD_HANDLED_RESULT), GONE(COPY_CARD_HANDLED_GONE) }

    /** RESULT when a Move or Save to a rescue branch written after the card in the same session succeeded for all its files, GONE
     *  when the checkout provably holds none of its paths, null while it is live. A refusal, a partial move or a move of fewer files
     *  keeps it live, and so does a checkout Orbit can't see whole. [current] is a snapshot (`files`) or the heartbeat's repo
     *  (`paths`: tracked only and capped, so they settle nothing unless they number `fileCount`). */
    fun handled(notice: ChangedNotice, laterResults: List<Result>, current: JsonObject?): Handled? {
        val took = laterResults.any { r ->
            r.root == notice.root && r.status == "done" && (r.kind == "rescue" || (r.kind == "move" && (r.fileCount ?: 0) >= notice.files.size))
        }
        if (took) return Handled.RESULT
        current ?: return null
        if (current.str("root") != notice.root) return null
        val fileCount = current.int("fileCount") ?: return null
        if (fileCount == 0) return Handled.GONE
        val listed = (current["files"] as? JsonArray)?.let { a -> a.filterIsInstance<JsonObject>().mapNotNull { it.str("path") } }
            ?: (current["paths"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: return null
        if (current.bool("truncated") || listed.size < fileCount) return null
        val now = listed.toSet()
        return if (notice.files.any { it.path in now }) null else Handled.GONE
    }

    // -----------------------------------------------------------------------------------------------------------
    // "Ask the agent …": prompts put in the composer, never sent by themselves (not on the board; the contract leaves them
    // to the client that draws them).

    fun askAboutPrompt(root: String, branch: String?, paths: List<String>, isolated: Boolean) =
        "The main checkout $root${branch?.let { " on $it" } ?: ""} has uncommitted changes" +
            (if (isolated) " outside this session's worktree" else "") +
            (if (paths.isNotEmpty()) ": ${namePaths(paths)}" else "") +
            ". Look at them and tell me where they came from and whether they belong to this session's work, then suggest what to do " +
            "with them. Don't change anything yet."

    fun combinePrompt(paths: List<String>, branch: String?) =
        "Moving the main checkout's uncommitted changes into this worktree was refused: ${namePaths(paths)} " +
            "${if (paths.size == 1) "is" else "are"} also changed here, in the same lines. Combine the main checkout's version with this " +
            "worktree's so both changes are kept, then clear those files from the main checkout${branch?.let { " (on $it)" } ?: ""}. " +
            "Tell me what you combined."

    /** The first message of the session Save & clean's "Open in a new session" opens (the macOS client's words). */
    fun rescuePrompt(rescueBranch: String) =
        "The main checkout's uncommitted changes were saved to $rescueBranch. " +
            "Look at what that branch holds compared with its parent and tell me what it contains."

    fun rebasePushPrompt(root: String, branch: String?, upstream: String?) =
        "Pushing ${branch ?: "the branch"} from the main checkout $root was rejected: ${upstream ?: "its upstream"} has commits it doesn't. " +
            "In the main checkout, rebase ${branch ?: "the branch"} onto ${upstream ?: "its upstream"}, resolve any conflicts, and push it again. " +
            "Never force-push."

    // -----------------------------------------------------------------------------------------------------------
    // Board 04: switching worktree isolation.

    const val ISO_TURN_ON_TITLE = "Turn on worktree isolation?"
    const val ISO_TURN_OFF_TITLE = "Turn off worktree isolation?"
    const val ISO_UNCHANGED = "Nothing in the checkout is changed. Sessions already running keep working in the main checkout until they end."
    const val ISO_UNSEEN = "Orbit can't see this checkout right now."
    const val ISO_REVIEW_FILES = "Review files"
    const val ISO_CANCEL = "Cancel"
    const val ISO_TURN_ON = "Turn on"
    const val ISO_TURN_OFF = "Turn off"
    const val ISO_CLEAN_UP_CHECKOUT = "Clean up checkout"
    const val ISO_LABEL = "Worktree isolation"
    const val ISO_DESCRIPTION = "Each session runs in its own git worktree. Off → sessions run directly in the working directory, sharing it."

    fun isolationDirtyBody(root: String, fileCount: Int, branch: String, head: String) =
        "The main checkout $root has ${uncommittedFiles(fileCount)}. " +
            "New sessions start from the last commit on $branch (${shortSha(head)}), so they won't see those files."

    fun isolationStuckBody(root: String, state: String): String {
        val what = if (state == "unmerged") "has unresolved conflicts" else "is stuck in a $state"
        return "The main checkout $root $what — new sessions can be created, but merges stay blocked until it's cleaned up."
    }

    fun isolationOffBody(root: String, unmergedSessions: Int): String {
        val keep = if (unmergedSessions == 1) "The 1 session with an unmerged worktree keeps it — merge or discard it from the session as before."
            else "The $unmergedSessions sessions with unmerged worktrees keep them — merge or discard them from each session as before."
        return "New sessions will work directly in $root. $keep"
    }

    /** Which board 04 dialog a switch press opens, or null to switch at once (a clean checkout; turning off with no unmerged worktree). */
    sealed interface IsolationDialog {
        data class Dirty(val body: String) : IsolationDialog
        data class Stuck(val body: String) : IsolationDialog
        data object Unseen : IsolationDialog
        data class Off(val body: String) : IsolationDialog
    }

    /** Turning on reads the workspace's heartbeat entry: dirty, stuck, or unseen asks first; clean switches. */
    fun turnOnDialog(repoHealth: JsonObject?): IsolationDialog? {
        val h = repoHealth ?: return IsolationDialog.Unseen
        val root = h.str("root") ?: return IsolationDialog.Unseen
        val state = h.str("state") ?: return IsolationDialog.Unseen
        if (state in BLOCKING_STATES) return IsolationDialog.Stuck(isolationStuckBody(root, state))
        val count = h.int("fileCount") ?: if (state == "dirty") return IsolationDialog.Unseen else 0
        if (count <= 0) return null
        return IsolationDialog.Dirty(isolationDirtyBody(root, count, h.str("branch") ?: "HEAD", h.str("head").orEmpty()))
    }

    /** Turning off asks only while sessions keep unmerged worktrees. */
    fun turnOffDialog(root: String, unmergedSessions: Int): IsolationDialog? =
        if (unmergedSessions <= 0) null else IsolationDialog.Off(isolationOffBody(root, unmergedSessions))

    /** A session of the list that still holds a worktree nobody merged: open, isolated, on a branch, neither merged nor in its target. */
    fun holdsUnmergedWorktree(session: JsonObject): Boolean =
        session.str("isolationStatus") == "worktree" && !session.str("branch").isNullOrEmpty() &&
            session.str("mergeStatus") != "merged" && !session.bool("branchMerged") && session.str("deletedAt") == null
}
