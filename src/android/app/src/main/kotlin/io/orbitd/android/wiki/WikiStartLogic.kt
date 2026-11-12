package io.orbitd.android.wiki

import java.time.Instant
import java.time.ZoneId

// The Wiki while it has nothing to read (design §12.3.1, mock 41), the web's `lib/wikiStart.ts`: one card of three steps —
// connect the repository, confirm the plan, write the documents — that says what happens next, and at most one thing to
// press. With no wiki at all it is the first step, whose button makes one; with a wiki it reads the same plan state
// Activity reads and says where that state stands on the way to something to read. It keeps nothing of its own: whether it
// is drawn, and what it says, is worked out from the reads every time. Amber waits on the owner, blue is the server at
// work, a tick is done, grey has not come yet. Rules over the reads, not over a page, because the clients draw the same
// card: they are held to `src/shared/src/wiki-start.fixture.json`, which `WikiStartLogicTest` reads where the web reads it.

internal object WikiStartCopy {
    const val title = "Set up this wiki"
    const val firstTitle = "Set up your first wiki"
    const val lead = "Documents for this codebase, written from its repository and sessions, for you and your agents."
    const val firstLead = "A wiki is documents for one codebase, written from its repository and sessions, for you and your agents."
    const val connect = "Connect the repository"
    const val connectFirst = "Connect a repository"
    const val confirm = "Confirm the plan"
    const val write = "Write the documents"
    const val connectText = "Pick the workspace Orbit reads this repository from."
    const val connectFirstText = "Pick a workspace. Its repository is what this wiki will describe."
    const val noRepository = "None of your workspaces has a repository yet. Add one, then come back."
    const val confirmTodo = "The ${WikiPlanCopy.drafterServer} drafts the documents this wiki should have. Nothing is written until you confirm it."
    const val writeTodo = "They appear here one by one."
    const val connected = "Connected"
    const val draftingNote = "Usually 1–2 hours. You can leave this page."
    const val noPlan = "No plan yet. A plan lays out this wiki’s documents; nothing is written until you confirm it."
    const val notWritten = "No document is written yet."
    const val create = "Create wiki"
    const val createOpen = "Create wiki…"
    /** The sheet's answer on the right (mock 41: a sheet form, Cancel on the left, Create on the right). */
    const val createSubmit = "Create"
    const val createNote = "A wiki describes one repository and stays up to date from its sessions, tasks and receipts. Runs on the server with this deployment’s ${WikiPlanCopy.drafterServer}."
    const val workspaceOffline = "offline"
    /** The way to another wiki (docs/wiki-explicit-creation-design.md §3.4): the drawer's row under Wiki and the head picker's last item. */
    const val newWiki = "New wiki…"
    /** On a repository in the Create wiki form that already has a wiki in use: one repository, one wiki. */
    const val hasAWiki = "Has a wiki"

    /** A done first step: where maintenance reads the repository from. */
    fun readsFrom(workspace: String?) = if (workspace.isNullOrEmpty()) connected else "Reads from $workspace"
    /** A done second step: `v1 confirmed Nov 2 · 34 documents`. */
    fun confirmed(version: Int, day: String?, documents: Int) =
        "v$version confirmed${if (day.isNullOrEmpty()) "" else " $day"} · ${WikiCopy.documentCount(documents)}"
    /** Under the workspace in the form that makes a wiki: what the wiki will be about, and how it gets there. */
    fun createRepositoryNote(repository: String) = "This wiki will describe $repository. The server reads the repository through this workspace’s runner."
    const val draftQueued = "Draft queued · ${WikiPlanCopy.queuedText}."
    fun drafting(attempt: Int, attempts: Int, ago: String) = "Drafting the plan · attempt $attempt of $attempts · started $ago"
    const val draftingSoon = "Drafting the plan · ${WikiPlanCopy.writingSoon}"
}

/** One workspace as the two forms offer it: its id and the words it is listed by, its repository ([WikiStartLogic.repositoryName])
 * and the URL as the workspace records it, and whether its runner is up — false only when that runner is known to be offline. */
internal data class WikiWorkspaceChoice(val id: String, val label: String, val repository: String?, val repoUrl: String?, val online: Boolean) {
    /** The form's row for it, under [group] where the form lists its repositories. */
    fun option(group: String? = null) = WikiPickerOption(id, label, offline = !online, group = group)
}

internal object WikiStartLogic {
    // MARK: whether it is drawn

    /** Whether the home has nothing to read: no document of the confirmed plan written, and no topic article listed in its
     * place. The first document, or the first article, takes the card away. */
    fun shown(written: Int, topics: Int) = written == 0 && topics == 0

    // MARK: what it says

    enum class StepState { DONE, WAIT, RUN, TODO }
    /** What a step's button does: the two forms on the spot, a draft on the spot, or the page that takes it on. */
    enum class ActionTo { CREATE, SET_UP, DRAFT, PLAN, RUNNERS }
    data class Action(val label: String, val to: ActionTo, val primary: Boolean)
    /** [progress]: writing, how far, and the document being written now. */
    data class Step(val state: StepState, val title: String, val text: String, val note: String? = null,
        val progress: WikiPlanLogic.JobCard.Progress? = null, val action: Action? = null)
    data class Card(val title: String, val lead: String, val steps: List<Step>)
    /** [maintenance]: whether the space's maintenance is on. [readsFrom]: the workspace it reads the repository from, by its
     * label; null while that is not known. [directory]: the confirmed plan's documents, for the writing's count and the
     * document being written. */
    data class Context(val now: Instant, val maintenance: Boolean, val readsFrom: String?, val runnerOnline: Boolean?,
        val directory: WikiDocsDirectory? = null, val zone: ZoneId = ZoneId.systemDefault())

    private fun openPlan(primary: Boolean) = Action(WikiPlanCopy.open, ActionTo.PLAN, primary)
    private val viewRunners = Action(WikiPlanCopy.viewRunners, ActionTo.RUNNERS, true)
    private val confirmTodo = Step(StepState.TODO, WikiStartCopy.confirm, WikiStartCopy.confirmTodo)
    private val writeTodo = Step(StepState.TODO, WikiStartCopy.write, WikiStartCopy.writeTodo)

    /** The second step before a version is confirmed: the draft, wherever it has got to. */
    private fun confirmStep(state: WikiPlanState, context: Context): Step {
        val title = WikiStartCopy.confirm
        val open = WikiPlanLogic.openJob(state)
        val failed = WikiPlanLogic.failedJob(state)
        val draft = state.draft
        val look = WikiPlanLogic.look(state, context.runnerOnline)
        fun wait(text: String, action: Action, note: String? = null) = Step(StepState.WAIT, title, text, note, action = action)
        if (look == WikiPlanLogic.Look.HELD && open != null) return wait(WikiPlanLogic.heldText(open, WikiPlanLogic.Held.RUNNER_OFFLINE), viewRunners)
        if (look == WikiPlanLogic.Look.DRAFT_FAILED && failed != null) return wait(WikiPlanLogic.draftFailedText(failed, state), openPlan(true))
        if (look == WikiPlanLogic.Look.DRAFT_READY && draft != null)
            return wait(WikiPlanLogic.draftReadyText(draft), openPlan(true), WikiPlanLogic.draftReadyNote(draft))
        if (look == WikiPlanLogic.Look.QUEUED) return Step(StepState.RUN, title, WikiStartCopy.draftQueued, action = openPlan(false))
        if (look == WikiPlanLogic.Look.DRAFTING && open != null) {
            val text = open.startedAt?.let { WikiStartCopy.drafting(open.attempt ?: 1, open.attemptsMax ?: 3, WikiHealthLogic.ago(it, context.now)) }
                ?: WikiStartCopy.draftingSoon
            return Step(StepState.RUN, title, text, WikiStartCopy.draftingNote, action = openPlan(false))
        }
        return wait(WikiStartCopy.noPlan, Action(WikiPlanCopy.draft, ActionTo.DRAFT, true), WikiPlanCopy.noteServer)
    }

    /** The third step, once a version is confirmed: its documents' writing, or that it stopped. */
    private fun writeStep(state: WikiPlanState, context: Context): Step {
        val title = WikiStartCopy.write
        val build = WikiPlanLogic.buildJob(state)
        if (build != null && WikiPlanLogic.held(build, context.runnerOnline) != null)
            return Step(StepState.WAIT, title, WikiPlanLogic.heldText(build, WikiPlanLogic.Held.RUNNER_OFFLINE), action = viewRunners)
        val card = WikiPlanLogic.jobCard(build ?: WikiPlanLogic.failedBuild(state), context.now, context.runnerOnline, null, true, context.directory)
            ?: return Step(StepState.WAIT, title, WikiStartCopy.notWritten, action = openPlan(true))
        val text = "${card.title} · ${card.text}"
        if (card.look == WikiPlanLogic.JobLook.FAILED) return Step(StepState.WAIT, title, text, action = openPlan(true))
        return Step(StepState.RUN, title, text, progress = card.progress, action = openPlan(false))
    }

    /** The card of a wiki with nothing to read. The first step waits while there is no workspace to read the repository
     * through: a job held for one, or no job and maintenance not on. With a version confirmed the second step is done
     * whatever the first says, so a workspace lost later reads as what it is. */
    fun card(state: WikiPlanState, context: Context): Card {
        val held = WikiPlanLogic.held(WikiPlanLogic.openJob(state) ?: WikiPlanLogic.buildJob(state), context.runnerOnline)
        val noPlan = WikiPlanLogic.look(state, context.runnerOnline) == WikiPlanLogic.Look.NO_PLAN
        val connect = (held != null && held != WikiPlanLogic.Held.RUNNER_OFFLINE) || (noPlan && !context.maintenance)
        val confirmed = state.confirmed
        val first = if (connect) Step(StepState.WAIT, WikiStartCopy.connect, WikiStartCopy.connectText, action = Action(WikiModeCopy.setUp, ActionTo.SET_UP, true))
            else Step(StepState.DONE, WikiStartCopy.connect, WikiStartCopy.readsFrom(context.readsFrom))
        val second = when {
            confirmed != null -> Step(StepState.DONE, WikiStartCopy.confirm, WikiStartCopy.confirmed(confirmed.version,
                WikiModeLogic.monthDay(confirmed.confirmedAt.orEmpty(), context.zone), confirmed.docs.orEmpty().size))
            connect -> confirmTodo
            else -> confirmStep(state, context)
        }
        val third = if (confirmed != null && !connect) writeStep(state, context) else writeTodo
        return Card(WikiStartCopy.title, WikiStartCopy.lead, listOf(first, second, third))
    }

    /** The card of an account with no wiki: the same three steps, the first of which makes one — or, with no workspace on a
     * repository to make one from, says so and offers nothing to press. */
    fun firstCard(workspaces: Boolean) = Card(WikiStartCopy.firstTitle, WikiStartCopy.firstLead, listOf(
        if (workspaces) Step(StepState.WAIT, WikiStartCopy.connectFirst, WikiStartCopy.connectFirstText, action = Action(WikiStartCopy.createOpen, ActionTo.CREATE, true))
        else Step(StepState.WAIT, WikiStartCopy.connectFirst, WikiStartCopy.noRepository),
        confirmTodo, writeTodo))

    // MARK: the workspaces the two forms offer

    private val scpRemote = Regex("^(?:[^@/\\s]+@)?([^:/\\s]+):(?!/)(\\S+)$")
    private val anyScheme = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)
    private val schemeRemote = Regex("^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?([^/]*)(.*)$", RegexOption.IGNORE_CASE)
    private val trailingSlashes = Regex("/+$")

    /** A repository as a wiki space names it (`normalizeRepoUrl` on the server, design §2.1): no scheme, user, trailing `/` or
     * `.git`, the scp form read as a path and the host in lower case, so every spelling of one remote is one repository. Null
     * when nothing is left. */
    fun repositoryName(raw: String?): String? {
        var url = raw.orEmpty().trim()
        val scp = scpRemote.find(url)
        if (scp != null && !anyScheme.containsMatchIn(url)) url = "ssh://${scp.groupValues[1]}/${scp.groupValues[2]}"
        schemeRemote.find(url)?.let { url = it.groupValues[1].lowercase() + it.groupValues[2] }
        while (true) {
            val trimmed = url.replace(trailingSlashes, "").removeSuffix(".git")
            if (trimmed == url) return url.ifEmpty { null }
            url = trimmed
        }
    }

    /** What a wiki is called when it is made: its repository's last segment. */
    fun repositoryTitle(repository: String) = repository.split('/').lastOrNull { it.isNotEmpty() } ?: repository

    /** The choices in the order they are offered: every one a draft could start on first, then by name. */
    fun choicesInOrder(choices: List<WikiWorkspaceChoice>) =
        choices.sortedWith(compareByDescending<WikiWorkspaceChoice> { it.online }.thenBy { it.label.lowercase() })

    /** A repository the form that makes a wiki offers, with its workspaces; one that has a wiki already is greyed, not offered. */
    data class RepositoryGroup(val repository: String, val choices: List<WikiWorkspaceChoice>, val hasWiki: Boolean = false)

    /** The repositories the form that makes a wiki groups its workspaces under, by name. A workspace with none is left out.
     * [wikis] are the repositories of the wikis in use (`repoUrlNorm`, not Trash's): their groups are `hasWiki`, since a
     * repository has one wiki (design §3.4) and the server refuses a second with 409 WIKI_SPACE_EXISTS. */
    fun repositoryGroups(choices: List<WikiWorkspaceChoice>, wikis: List<String?> = emptyList()): List<RepositoryGroup> {
        val made = wikis.filterNotNull().filter { it.isNotEmpty() }.toSet()
        return choicesInOrder(choices).filter { !it.repository.isNullOrEmpty() }
            .groupBy { it.repository.orEmpty() }.toSortedMap().map { (repository, rows) -> RepositoryGroup(repository, rows, repository in made) }
    }

    /** The workspaces the form that makes a wiki lets one pick: those of the repositories with no wiki yet. */
    fun createOffered(groups: List<RepositoryGroup>) = groups.filter { !it.hasWiki }.flatMap { it.choices }

    /** What Set up maintenance offers, in order (mock 41): a wiki describes one repository, so only its own workspaces — the
     * ones the Workspaces section lists as in the wiki — and always the one in use ([current]); the workspaces of another
     * repository could only read the wrong code. A wiki with no workspace in it yet offers them all. */
    fun setUpChoices(choices: List<WikiWorkspaceChoice>, members: List<WikiSpaceWorkspaceRow>, current: String?): List<WikiWorkspaceChoice> {
        val inWiki = members.filter { it.inWiki }
        return choicesInOrder(if (inWiki.isEmpty()) choices
            else choices.filter { choice -> sameWikiId(choice.id, current) || inWiki.any { sameWikiId(it.id, choice.id) } })
    }

    /** The workspace a form opens on: the one maintenance already reads from; else the one the reader came from, when its
     * runner is not offline; else the first offered whose runner is not; else the first, since a draft that waits for its
     * runner says so on the card. */
    fun workspaceDefault(choices: List<WikiWorkspaceChoice>, current: String?, from: String?): String? {
        if (!current.isNullOrEmpty()) return current
        val offered = choicesInOrder(choices)
        return (offered.firstOrNull { sameWikiId(it.id, from) && it.online } ?: offered.firstOrNull { it.online } ?: offered.firstOrNull())?.id
    }

    // MARK: the card an agent files for a wiki (WIKI_CREATE, design §3.6)

    /** What a WIKI_CREATE card says it will make: the repository, the filing session's workspace as the forms name it — null
     * when it is not among the workspaces read — whether that workspace's runner is offline, and the maintenance. */
    data class CreateCardFacts(val repository: String?, val readsFrom: String?, val offline: Boolean, val maintenance: String)

    fun createCardFacts(repoUrlNorm: String?, workspaceId: String?, choices: List<WikiWorkspaceChoice>): CreateCardFacts {
        val workspace = workspaceId?.let { id -> choices.firstOrNull { sameWikiId(it.id, id) } }
        return CreateCardFacts(repoUrlNorm, workspace?.label, workspace?.online == false, WikiCreateCardCopy.maintenanceText)
    }
}

/** The WIKI_CREATE owner-request card's words (docs/wiki-explicit-creation-design.md §3.6, board 46 part 3; web `WIKI_CREATE_*`). */
internal object WikiCreateCardCopy {
    const val repository = "Repository"
    const val readsFrom = "Reads from"
    const val maintenance = "Maintenance"
    const val create = WikiStartCopy.create
    const val changeSettings = "Change settings…"
    const val notHere = "Not for this repository"
    /** The maintenance a wiki made from the card starts with: the Create wiki form's defaults, on. */
    val maintenanceText = WikiMaintenanceSettings.default.let { "On · ${WikiModeCopy.runsADay(it.dailyRunLimit)} · last ${it.lookbackDays} days" }
    /** A DONE card's line: the wiki it made, by name when the answer names it. */
    fun created(name: String?) = if (name.isNullOrEmpty()) "Wiki created" else "Created the wiki $name"
}
