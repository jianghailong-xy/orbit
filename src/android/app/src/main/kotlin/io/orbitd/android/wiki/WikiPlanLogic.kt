package io.orbitd.android.wiki

import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import kotlinx.serialization.json.*

// The plan pages' words and readings, ported from OrbitKit `WikiPlanCopy` / `WikiPlanLogic`. Two shapes of a
// plan, one page, as there: a stored version is read back with ids and positions; the draft a job that failed
// the gate last had is kept as it was sent. Both are read into `Shown` first. An owner's edit goes the other
// way, in the draft's shape — never as it was read back.

internal object WikiPlanCopy {
    const val title = "Plan"
    const val redraft = "Redraft…"
    const val confirm = "Confirm plan"
    const val draft = "Draft plan"
    const val open = "Open plan"
    const val edit = "Edit"
    const val accept = "Accept"
    const val reject = "Reject"
    const val cancel = "Cancel"
    const val viewRun = "View run"
    const val setUp = "Set up maintenance"
    const val viewRunners = "View runners"
    const val none = "This space has no plan yet"
    const val emptyTitle = "No plan yet"
    const val documents = "Documents"
    const val inForce = "the plan in force"
    const val queued = "Queued"
    const val drafting = "Drafting"
    const val held = "Held"
    const val failed = "Didn’t pass the plan check"
    const val passed = "Passed the plan check"
    const val writing = "Writing documents"
    const val writingNow = "Writing now:"
    const val jobFailed = "The draft didn’t finish"
    const val buildFailed = "Writing documents didn’t finish"
    const val queuedText = "starts after the Wiki maintenance run that’s going now"
    const val writingSoon = "waiting for its run to start"
    const val question = "Question"
    const val writtenFor = "Written for"
    const val covers = "Covers"
    const val notCovered = "Not covered"
    const val length = "Length"
    const val protected = "Protected"
    const val drawsOn = "Draws on"
    const val sections = "Sections"
    const val protectedNote = "Protected — a redraft keeps it as it is; only you can change it"
    const val notProtectedNote = "Not protected — a redraft may change it"
    const val sourceDocs = "Design docs"
    const val sourceCode = "Code"
    const val sourceContracts = "Contracts"
    const val sourceSessions = "Where to look for the words"
    const val sessionProjects = "Projects"
    const val sessionTime = "Time"
    const val sessionKeywords = "Keywords"
    const val sessionAnchors = "Anchor paths"
    const val sessionKinds = "Entry kinds"
    const val sessionTopics = "Topics"
    const val sessionEvidence = "Looking for"
    const val found = "✓ found"
    const val notFound = "✗ not found"
    const val changes = "Changes to review"
    const val proposedBy = "Proposed by"
    const val why = "Why"
    const val change = "Change"
    const val sources = "Sources"
    const val from = "From"
    const val check = "Check"
    const val changeRejected = "Change rejected"
    const val redraftAsked = "Redraft asked for — it runs as a Wiki maintenance task"
    const val redraftAlready = "A draft is already on its way"
    const val acceptRefused = "This change no longer passes the plan check, so nothing was confirmed:"
    const val redraftTitle = "Redraft the plan"
    const val redraftGo = "Redraft"
    const val redraftPlaceholder = "What should change: what to merge, split, move or leave out"
    const val editTitleField = "Title"
    const val editKind = "Kind"
    const val protectedSwitch = "A redraft keeps it as it is"
    const val addSection = "Add section"
    const val saveDraft = "Save draft"
    const val refsShownPhone = 3
    const val factsShown = 2
    const val newSectionLength = 500

    private fun plural(n: Int, one: String, many: String) = "${WikiArticleCopy.count(n)} ${if (n == 1) one else many}"
    fun versionLabel(version: Int) = "v$version"

    /** Who drafts the plan while the server executes the account (`WIKI_PLAN_DRAFTER_SERVER`): the wiki-worker's
     * System model, never the account's provider. Every sentence that names the drafter takes this name then; under
     * runner each keeps `<provider>`, word for word. */
    const val drafterServer = "System model"

    fun emptyText(provider: String?, serverExecutes: Boolean = false): String {
        val drafter = if (serverExecutes) "The $drafterServer" else provider ?: WikiCopy.historyMaintenance
        return "A plan lays out this wiki’s documents: the categories, the documents in each, who each one is for and what it covers, " +
            "and where each section’s material comes from. $drafter drafts it; nothing is written until you confirm it."
    }

    /** Where a draft runs and how long it takes, under Draft plan (`wikiPlanEmptyNote`). While the server executes the
     * account the wiki-worker drafts it with the System model, so the note is the server's. */
    const val noteServer = "System model · about 1–2 hours"
    const val emptyNoteServer = "Runs on the server with the System model — usually 1–2 hours. Until you confirm a plan, the Wiki shows its topic articles."
    fun emptyNote(place: String?, provider: String?, serverExecutes: Boolean = false): String {
        if (serverExecutes) return emptyNoteServer
        val on = place?.let { ", on $it" } ?: ""
        val with = provider?.let { " with $it" } ?: ""
        return "Runs as a task in the Wiki maintenance list$on$with — usually 1–2 hours. Until you confirm a plan, the Wiki shows its topic articles."
    }
    fun failedHint(inForce: Int?) = "Confirm needs a passing check. Redraft with what to change — " +
        (inForce?.let { "v$it stays in force until you confirm" } ?: "until you confirm a plan, the Wiki shows its topic articles") + "."
    fun chars(length: WikiPlanRange) = if (length.min == length.max) "${WikiArticleCopy.count(length.min)} chars"
        else "${WikiArticleCopy.count(length.min)}–${WikiArticleCopy.count(length.max)} chars"
    fun sectionChars(n: Int) = "~${WikiArticleCopy.count(n)} chars"
    fun errorCount(n: Int) = plural(n, "error", "errors")
    fun changeCount(n: Int) = plural(n, "change", "changes")
    fun andMore(n: Int) = "and ${WikiArticleCopy.count(n)} more"
    fun saveNote(next: Int) = "Saving makes draft v$next; it goes through the plan check again."
    fun editTitle(number: String) = "Edit $number"
    fun confirmed(version: Int) = "Plan v$version confirmed"
    fun changeAdded(version: Int) = "Change added to draft v$version"
    fun draftSaved(version: Int) = "Draft v$version saved"
    fun acceptedNotConfirmed(version: Int, why: String) = "Accepted into draft v$version, but it was not confirmed: $why"
    /** The Edit sheet's TalkBack actions, standing in for the drag a screen reader cannot make. */
    const val moveUp = "Move up"
    const val moveDown = "Move down"
    fun protectedKept(numbers: List<String>) = "Protected, kept as they are: ${numbers.joinToString(" · ")}"
    fun time(since: String?, until: String?) = if (since == null && until == null) "any time" else "${since ?: "the start"} → ${until ?: "now"}"
    fun redraftNote(provider: String?, from: Pair<Int, Boolean>?, serverExecutes: Boolean = false): String {
        val base = from?.let { if (it.second) " from v${it.first}, the plan in force," else " from draft v${it.first}," } ?: ""
        val drafter = if (serverExecutes) "The $drafterServer" else provider ?: WikiCopy.historyMaintenance
        return "$drafter drafts it again$base with what you write here. A draft that doesn’t pass the plan check is " +
            "redrafted with its errors, up to 3 times."
    }
    fun lostLabel(base: Int, number: Int, title: String) = "v$base §$number $title"
    fun protectedMovePhone(movedTo: String?, number: String) = "${movedTo?.let { "Moved to $it" } ?: "Moved out"} — $number is protected"
}

internal object WikiPlanLogic {
    private fun plural(n: Int, one: String, many: String) = "${WikiArticleCopy.count(n)} ${if (n == 1) one else many}"

    // MARK: orders — the web phone's, top to bottom

    /** The plan page's blocks (`WIKI_PLAN_PAGE_SECTIONS`). */
    enum class PageSection { CRUMB, TITLE, META, ACTIONS, HINT, JOB, GATE, CHANGES, DOCUMENTS }
    /** A document's own page (`WIKI_PLAN_DOC_SECTIONS`). */
    enum class DocSection { CRUMB, TITLE, META, FIELDS, SECTIONS }
    /** A section's own page (`WIKI_PLAN_SECTION_SECTIONS`). */
    enum class SectionSection { CRUMB, TITLE, META, COVERS, SOURCES }
    /** A change's card (`WIKI_PLAN_CHANGE_PARTS`). */
    enum class ChangePart { HEAD, TITLE, WHY, CHANGE, SOURCES, FROM, CHECK, ACTIONS }

    // MARK: a plan, as the page draws it

    data class ShownProject(val id: String?, val title: String)
    data class ShownSessions(val projects: List<ShownProject>, val since: String?, val until: String?, val keywords: List<String>,
        val anchorPaths: List<String>, val entryKinds: List<String>, val topics: List<String>, val evidence: String)
    data class ShownDocSource(val path: String, val section: String?)
    data class ShownCodeSource(val path: String, val symbols: List<String>)
    data class ShownSources(val docs: List<ShownDocSource>, val code: List<ShownCodeSource>, val contracts: List<String>, val sessions: ShownSessions?)
    data class ShownSection(val key: String?, val title: String, val kind: String, val covers: String, val length: Int, val sources: ShownSources)
    data class ShownScopeOut(val text: String, val docs: List<String>)
    data class ShownDoc(val index: Int, val number: String, val slug: String, val category: String, val title: String, val question: String,
        val audience: List<String>, val scopeIn: List<String>, val scopeOut: List<ShownScopeOut>, val length: WikiPlanRange,
        val protected: Boolean, val sections: List<ShownSection>, val stored: WikiPlanDoc?)
    data class ShownCategory(val key: String, val number: Int, val title: String, val question: String, val forAgents: Boolean, val docs: List<ShownDoc>)
    enum class ShownStatus(val label: String) { DRAFT("Draft"), CONFIRMED("Confirmed"), SUPERSEDED("Superseded"), FAILED("Draft") }
    data class Shown(val version: Int, val status: ShownStatus, val origin: String, val baseVersion: Int?, val proposalId: String?,
        val categories: List<ShownCategory>, val docs: List<ShownDoc>, val target: WikiPlanRange, val gate: WikiPlanGateReport?,
        val repoCheck: WikiPlanRepoCheck?, val model: String?, val createdAt: String?, val confirmedAt: String?,
        val errors: List<WikiPlanGateError>)

    private class DocRow(val index: Int, val slug: String, val category: String, val title: String, val question: String,
        val audience: List<String>, val scopeIn: List<String>, val scopeOut: List<ShownScopeOut>, val length: WikiPlanRange,
        val protected: Boolean, val sections: List<ShownSection>, val stored: WikiPlanDoc?)
    private class CategoryRow(val key: String, val title: String, val question: String, val forAgents: Boolean)

    /** Number the documents the way the directory does: `<category number>.<place in the category>`. */
    private fun numbered(categories: List<CategoryRow>, rows: List<DocRow>): Pair<List<ShownCategory>, List<ShownDoc>> {
        val numberOf = mutableMapOf<String, Int>()
        categories.forEachIndexed { i, category -> numberOf.putIfAbsent(category.key, i + 1) }
        val placed = mutableMapOf<String, Int>()
        val docs = rows.map { row ->
            val n = numberOf[row.category]
            val number = if (n == null) "—" else { placed[row.category] = (placed[row.category] ?: 0) + 1; "$n.${placed.getValue(row.category)}" }
            ShownDoc(row.index, number, row.slug, row.category, row.title, row.question, row.audience, row.scopeIn, row.scopeOut, row.length,
                row.protected, row.sections, row.stored)
        }
        val shownCategories = categories.mapIndexed { i, category ->
            ShownCategory(category.key, i + 1, category.title.ifEmpty { category.key }, category.question, category.forAgents,
                docs.filter { it.category == category.key && numberOf[category.key] == i + 1 })
        }
        return shownCategories to docs
    }
    private fun sessionsOf(sessions: WikiPlanSessionCondition?): ShownSessions? = sessions?.let {
        ShownSessions(it.projects.orEmpty().map { p -> ShownProject(p.id, p.title ?: p.id) }, it.since, it.until, it.keywords.orEmpty(),
            it.anchorPaths.orEmpty(), it.entryKinds.orEmpty(), it.topics.orEmpty(), it.evidence ?: "")
    }
    private fun shownStatus(status: String) = when (status) { "confirmed" -> ShownStatus.CONFIRMED; "superseded" -> ShownStatus.SUPERSEDED; else -> ShownStatus.DRAFT }

    /** A stored version, as the page draws it (`wikiPlanFromVersion`). */
    fun fromVersion(version: WikiPlanVersion): Shown {
        val rows = version.docs.orEmpty().mapIndexed { index, doc ->
            DocRow(index, doc.slug, doc.category, doc.title, doc.question ?: "", doc.audience.orEmpty(), doc.scopeIn.orEmpty(),
                doc.scopeOut.orEmpty().map { ShownScopeOut(it.text, it.docs.orEmpty()) }, doc.length ?: WikiPlanRange(0, 0), doc.protected ?: false,
                doc.sections.orEmpty().map { section ->
                    ShownSection(section.key, section.title, section.kind, section.covers ?: "", section.length ?: 0,
                        ShownSources(section.sources?.docs.orEmpty().map { ShownDocSource(it.path, it.section) },
                            section.sources?.code.orEmpty().map { ShownCodeSource(it.path, it.symbols.orEmpty()) },
                            section.sources?.contracts.orEmpty().map { it.path }, sessionsOf(section.sources?.sessions)))
                }, doc)
        }
        val categories = version.categories.orEmpty().map { CategoryRow(it.key, it.title ?: it.key, it.question ?: "", it.forAgents ?: false) }
        val (shownCategories, docs) = numbered(categories, rows)
        return Shown(version.version, shownStatus(version.status), version.origin ?: "maintenance", version.baseVersion, version.proposalId,
            shownCategories, docs, version.target ?: WikiPlanRange(20, 35), version.gate, version.repoCheck, version.model,
            version.createdAt, version.confirmedAt, emptyList())
    }

    /** The draft a failed job last had, numbered as the version it would have been (`wikiPlanFromFailedJob`). */
    fun fromFailedJob(job: WikiPlanJob, number: Int, baseVersion: Int?): Shown? {
        val draft = job.draft ?: return null
        val report = if (job.kind != "build") job.report else null
        val rows = draft.docs.mapIndexed { index, doc ->
            DocRow(index, doc.slug, doc.category, doc.title, doc.question, doc.audience, doc.scopeIn,
                doc.scopeOut.map { ShownScopeOut(it.text, it.docs.orEmpty()) }, doc.length, doc.protected ?: false,
                doc.sections.map { section ->
                    ShownSection(section.key, section.title, section.kind, section.covers, section.length,
                        ShownSources(section.sources.docs.orEmpty().map { ShownDocSource(it.path, it.section) },
                            section.sources.code.orEmpty().map { ShownCodeSource(it.path, it.symbols.orEmpty()) },
                            section.sources.contracts.orEmpty().map { it.path },
                            section.sources.sessions?.let { s -> ShownSessions(s.projects.orEmpty().map { ShownProject(null, it) }, s.since, s.until,
                                s.keywords.orEmpty(), s.anchorPaths.orEmpty(), s.entryKinds.orEmpty(), s.topics.orEmpty(), s.evidence ?: "") }))
                }, null)
        }
        val categories = draft.categories.map { CategoryRow(it.key, it.title ?: it.key, it.question ?: "", it.forAgents ?: false) }
        val (shownCategories, docs) = numbered(categories, rows)
        val repo = report?.repo?.let { WikiPlanRepoCheck(it.sha, it.checked, emptyList()) }
        return Shown(number, ShownStatus.FAILED, "maintenance", baseVersion, null, shownCategories, docs, report?.target ?: WikiPlanRange(20, 35),
            null, repo, report?.model ?: job.provider, job.endedAt, null, job.errors.orEmpty())
    }

    fun newest(state: WikiPlanState) = state.draft ?: state.confirmed
    /** A draft or a revision that ended failed with no version stored since it was asked for (`wikiPlanFailedJob`). */
    fun failedJob(state: WikiPlanState): WikiPlanJob? {
        val job = state.job ?: return null
        if (job.state != "failed" || job.kind == "build") return null
        val made = RelativeTime.parse(newest(state)?.createdAt); val asked = RelativeTime.parse(job.requestedAt)
        if (made != null && asked != null && made > asked) return null
        return job
    }
    private val openStates = setOf("queued", "held", "running")
    fun openJob(state: WikiPlanState): WikiPlanJob? = state.job?.takeIf { it.kind != "build" && it.state in openStates }
    fun nextVersion(state: WikiPlanState) = maxOf(state.confirmed?.version ?: 0, state.draft?.version ?: 0) + 1
    fun defaultShown(state: WikiPlanState): Shown? {
        failedJob(state)?.let { failed -> fromFailedJob(failed, nextVersion(state), newest(state)?.version)?.let { return it } }
        state.draft?.let { return fromVersion(it) }
        state.confirmed?.let { return fromVersion(it) }
        return null
    }
    fun base(shown: Shown, state: WikiPlanState): Shown? = when (shown.status) {
        ShownStatus.FAILED -> newest(state)?.let(::fromVersion)
        ShownStatus.DRAFT -> state.confirmed?.let(::fromVersion)
        else -> null
    }

    // MARK: the head

    private fun counts(shown: Shown): String {
        val sections = shown.docs.sumOf { it.sections.size }
        return "${plural(shown.categories.size, "category", "categories")} · ${plural(shown.docs.size, "document", "documents")} · " +
            plural(sections, "section", "sections")
    }
    fun meta(shown: Shown, job: WikiPlanJob?, docs: Pair<Int, Int>?, zone: ZoneId = ZoneId.systemDefault()): List<String> = when (shown.status) {
        ShownStatus.CONFIRMED -> buildList {
            add("Confirmed ${shown.confirmedAt?.let { WikiModeLogic.monthDay(it, zone) } ?: ""} by you".replace("  ", " "))
            add(counts(shown))
            if (docs != null && docs.first < docs.second) add("${WikiArticleCopy.count(docs.first)} written, ${WikiArticleCopy.count(docs.second - docs.first)} to write")
        }
        ShownStatus.SUPERSEDED -> listOf("Superseded · made ${WikiDocCopy.monthDayTime(shown.createdAt, zone) ?: ""}", counts(shown))
        else -> buildList {
            val asked = job?.trigger == "owner"
            if (shown.origin == "owner") add(if (shown.proposalId != null) "v${shown.baseVersion ?: 0} with the change you accepted" else "v${shown.baseVersion ?: 0} with your edit")
            else if (shown.baseVersion != null) add("Redrafted from v${shown.baseVersion}${if (asked) " at your request" else ""}")
            else add(if (asked) "First draft · at your request" else "First draft")
            val made = listOfNotNull(shown.model, WikiDocCopy.monthDayTime(shown.createdAt, zone)).joinToString(" · ")
            if (made.isNotEmpty()) add(made)
            add(counts(shown))
        }
    }
    data class VersionRow(val version: Int, val status: ShownStatus, val note: String)
    fun versionRows(versions: List<WikiPlanVersionSummary>, failed: Pair<Int, String?>?, zone: ZoneId = ZoneId.systemDefault()): List<VersionRow> {
        val rows = versions.map { row ->
            val at = WikiDocCopy.monthDayTime(row.confirmedAt ?: row.createdAt, zone) ?: ""
            val made = if (row.origin == "owner") (if (row.proposalId != null) "Accepted change" else "Your edit") else if (row.baseVersion != null) "Redraft" else "First draft"
            val status = shownStatus(row.status)
            val note = when (status) { ShownStatus.CONFIRMED -> "$at · confirmed by you"; ShownStatus.DRAFT -> "$made · $at · waiting for you"; else -> "$made · $at" }
            VersionRow(row.version, status, note)
        }.toMutableList()
        if (failed != null) rows.add(0, VersionRow(failed.first, ShownStatus.FAILED,
            "Redraft · ${WikiDocCopy.monthDayTime(failed.second, zone) ?: ""} · didn’t pass the check"))
        return rows.sortedByDescending { it.version }
    }
    fun jobHead(job: WikiPlanJob, zone: ZoneId = ZoneId.systemDefault()): String {
        val what = if (job.kind == "revise") "Redraft" else "First draft"
        if (job.trigger == "space_created") return "$what · asked when the space was made"
        return "$what · you asked ${WikiDocCopy.monthDayTime(job.requestedAt, zone) ?: ""}"
    }

    // MARK: the job

    enum class Held { NO_MAINTENANCE_WORKSPACE, MAINTENANCE_PROVIDER_UNUSABLE, RUNNER_OFFLINE }
    fun heldText(held: Held) = when (held) {
        Held.NO_MAINTENANCE_WORKSPACE -> "No maintenance workspace is set up — a draft runs where maintenance runs."
        Held.MAINTENANCE_PROVIDER_UNUSABLE -> "No usable maintenance provider is set up — a draft runs on the provider maintenance uses."
        Held.RUNNER_OFFLINE -> "The maintenance runner is offline — the draft starts once it’s back."
    }
    fun buildHeldText(held: Held) = when (held) {
        Held.NO_MAINTENANCE_WORKSPACE -> "No maintenance workspace is set up — documents are written where maintenance runs."
        Held.MAINTENANCE_PROVIDER_UNUSABLE -> "No usable maintenance provider is set up — documents are written on the provider maintenance uses."
        Held.RUNNER_OFFLINE -> "The maintenance runner is offline — writing starts once it’s back."
    }
    fun heldText(job: WikiPlanJob, held: Held) = if (job.kind == "build") buildHeldText(held) else heldText(held)
    /** What the server stored, or a job whose run has not started while the maintenance runner is offline. */
    fun held(job: WikiPlanJob?, runnerOnline: Boolean?): Held? {
        job ?: return null
        if (job.state == "held") return if (job.held?.reason == "maintenance_provider_unusable") Held.MAINTENANCE_PROVIDER_UNUSABLE else Held.NO_MAINTENANCE_WORKSPACE
        if ((job.state == "running" || job.state == "queued") && job.startedAt == null && runnerOnline == false) return Held.RUNNER_OFFLINE
        return null
    }
    fun buildJob(state: WikiPlanState): WikiPlanJob? = state.job?.takeIf { it.kind == "build" && it.state in openStates }
    fun buildCounts(build: WikiPlanJob?, docs: Pair<Int, Int>?): Pair<Int, Int>? = build?.progress?.let { it.docs.done to it.docs.total } ?: docs
    fun writingDoc(build: WikiPlanJob?, directory: WikiDocsDirectory?): String? {
        val current = build?.progress?.current ?: return null
        directory?.categories.orEmpty().forEach { category ->
            category.docs.orEmpty().firstOrNull { it.slug == current.slug }?.let { doc -> return "${doc.number ?: ""} ${current.title.ifEmpty { doc.title }}" }
        }
        return current.title.ifEmpty { current.slug }
    }
    enum class JobLook { QUEUED, DRAFTING, HELD, FAILED, WRITING }
    data class JobCard(val look: JobLook, val title: String, val text: String, val link: Link?, val progress: Progress?) {
        enum class LinkTo { RUN, SETTINGS, RUNNERS }
        data class Link(val label: String, val to: LinkTo, val sessionId: String?)
        data class Progress(val done: Int, val total: Int, val now: String?)
    }
    /** The gate's checks this build names (OrbitKit `WikiPlanGateCheck`); any other is one `unknown`, as Swift decodes it. */
    private val gateChecks = setOf("schema", "docCount", "protected", "references")
    fun failedChecks(errors: List<WikiPlanGateError>) = errors.map { it.check.takeIf { c -> c in gateChecks } ?: "unknown" }.toSet().size
    private fun attempts(job: WikiPlanJob) = job.attempt ?: (if (job.kind != "build") job.report?.attempts?.size else null) ?: job.attemptsMax ?: 3
    private fun runLink(sessionId: String?) = sessionId?.let { JobCard.Link(WikiPlanCopy.viewRun, JobCard.LinkTo.RUN, it) }
    fun jobCard(job: WikiPlanJob?, now: Instant, runnerOnline: Boolean?, failed: WikiPlanJob?, inForce: Boolean, directory: WikiDocsDirectory?,
        serverExecutes: Boolean = false): JobCard? {
        val draft = job?.takeIf { it.kind != "build" && it.state in openStates }
        val build = if (inForce) job?.takeIf { it.kind == "build" && it.state in openStates } else null
        val going = draft ?: build
        if (going != null) held(going, runnerOnline)?.let { why ->
            val link = if (why == Held.RUNNER_OFFLINE) JobCard.Link(WikiPlanCopy.viewRunners, JobCard.LinkTo.RUNNERS, null)
                else JobCard.Link(WikiPlanCopy.setUp, JobCard.LinkTo.SETTINGS, null)
            return JobCard(JobLook.HELD, WikiPlanCopy.held, heldText(going, why), link, null)
        }
        if (going != null && going.state == "queued") {
            val started = going.waitingFor?.startedAt?.let { " (started ${WikiHealthLogic.ago(it, now)})" } ?: ""
            return JobCard(JobLook.QUEUED, WikiPlanCopy.queued, "${WikiPlanCopy.queuedText}$started", runLink(going.waitingFor?.sessionId), null)
        }
        if (draft != null && draft.state == "running") {
            val who = if (serverExecutes) WikiPlanCopy.drafterServer else draft.provider ?: WikiCopy.historyMaintenance
            val text = draft.startedAt?.let { "$who · attempt ${draft.attempt ?: 1} of ${draft.attemptsMax ?: 3} · started ${WikiHealthLogic.ago(it, now)}" }
                ?: "$who · waiting for its run to start"
            return JobCard(JobLook.DRAFTING, WikiPlanCopy.drafting, text, runLink(draft.sessionId), null)
        }
        if (build != null && build.state == "running") {
            val docs = directory?.takeIf { it.plan != null }?.docs?.let { it.written to it.total }
            val counts = buildCounts(build, docs)
            val written = counts?.let { "${WikiArticleCopy.count(it.first)} of ${WikiArticleCopy.count(it.second)} written" } ?: WikiPlanCopy.writingSoon
            val text = build.startedAt?.let { "$written · started ${WikiHealthLogic.ago(it, now)}" } ?: written
            return JobCard(JobLook.WRITING, WikiPlanCopy.writing, text, runLink(build.sessionId),
                counts?.let { JobCard.Progress(it.first, it.second, writingDoc(build, directory)) })
        }
        if (failed != null) {
            val errors = failed.errors.orEmpty()
            if (errors.isEmpty()) return JobCard(JobLook.FAILED, WikiPlanCopy.jobFailed, failed.error ?: "Its run ended without a draft.", runLink(failed.sessionId), null)
            return JobCard(JobLook.FAILED, WikiPlanCopy.failed, "${failedChecks(errors)} of 4 checks failed · after ${plural(attempts(failed), "attempt", "attempts")} · " +
                "${plural(errors.size, "error", "errors")} listed below", null, null)
        }
        if (inForce && job != null && job.kind == "build" && job.state == "failed")
            return JobCard(JobLook.FAILED, WikiPlanCopy.buildFailed, buildFailedText(job), runLink(job.sessionId), null)
        return null
    }
    fun buildFailedText(job: WikiPlanJob) = "${job.error?.let { "$it · " } ?: ""}Wiki maintenance writes what’s left on its next run"

    // MARK: the gate's report

    val gateOrder = listOf("docCount", "protected", "references", "schema")
    fun gateTitle(check: String) = when (check) { "docCount" -> "Documents"; "protected" -> "Protected documents"; "references" -> "References"; else -> "Fields" }
    data class GateRow(val check: String, val ok: Boolean, val title: String, val text: String)
    data class RefRow(val where: String, val kind: String, val ref: String, val why: String)
    data class Gate(val passed: Boolean, val title: String, val line: String, val aside: String?, val rows: List<GateRow>,
        val refKinds: List<String>, val refs: List<RefRow>)
    private fun firstMatch(pattern: String, text: String): List<String>? = Regex(pattern).find(text)?.groupValues
    private fun singular(many: String) = many.replace(Regex("ies$"), "y").replace(Regex("s$"), "")
    private fun refKind(path: String): Pair<String, String> {
        val kinds = listOf(
            Triple("\\.sources\\.code\\[\\d+\\]\\.symbols\\[\\d+\\]$", "Symbol", "symbols"),
            Triple("\\.sources\\.code\\[\\d+\\](\\.path)?$", "Code path", "code paths"),
            Triple("\\.sources\\.docs\\[\\d+\\]\\.section$", "Doc section", "doc sections"),
            Triple("\\.sources\\.docs\\[\\d+\\](\\.path)?$", "Doc path", "doc paths"),
            Triple("\\.sources\\.contracts\\[\\d+\\]", "Contract", "contracts"),
            Triple("\\.sessions\\.projects\\[\\d+\\]$", "Project", "projects"),
            Triple("\\.sessions\\.topics\\[\\d+\\]$", "Topic", "topics"),
            Triple("\\.sessions\\.anchorPaths\\[\\d+\\]$", "Anchor path", "anchor paths"),
            Triple("\\.sessions\\.entryKinds\\[\\d+\\]$", "Entry kind", "entry kinds"),
            Triple("\\.scopeOut\\[\\d+\\]", "Document", "documents"),
            Triple("\\.category$", "Category", "categories"),
        )
        kinds.forEach { (pattern, one, many) -> if (firstMatch(pattern, path) != null) return one to many }
        return "Reference" to "references"
    }
    /** `plan.docs[12].sections[2]…` is `7.2 §3` (`wikiPlanErrorWhere`). */
    fun errorWhere(shown: Shown, path: String): Pair<ShownDoc?, String> {
        val doc = firstMatch("(?:^|\\.)docs\\[(\\d+)\\]", path)?.get(1)?.toIntOrNull()?.takeIf { it < shown.docs.size } ?: return null to "—"
        val row = shown.docs[doc]
        firstMatch("\\.sections\\[(\\d+)\\]", path)?.get(1)?.toIntOrNull()?.let { return row to "${row.number} §${it + 1}" }
        return row to row.number
    }
    private fun valueAt(shown: Shown, path: String): String? {
        val d = firstMatch("(?:^|\\.)docs\\[(\\d+)\\]", path)?.get(1)?.toIntOrNull()?.takeIf { it < shown.docs.size } ?: return null
        val s = firstMatch("\\.sections\\[(\\d+)\\]", path)?.get(1)?.toIntOrNull()?.takeIf { it < shown.docs[d].sections.size } ?: return null
        val section = shown.docs[d].sections[s]
        fun at(pattern: String) = firstMatch(pattern, path)?.drop(1)?.mapNotNull { it.toIntOrNull() }
        at("\\.sources\\.code\\[(\\d+)\\]\\.symbols\\[(\\d+)\\]$")?.takeIf { it.size == 2 }?.let { m ->
            val code = section.sources.code.getOrNull(m[0]) ?: return null
            return "${code.symbols.getOrNull(m[1]) ?: ""} in ${code.path}"
        }
        at("\\.sources\\.code\\[(\\d+)\\]")?.firstOrNull()?.let { return section.sources.code.getOrNull(it)?.path }
        at("\\.sources\\.docs\\[(\\d+)\\]\\.section$")?.firstOrNull()?.let { i ->
            val doc = section.sources.docs.getOrNull(i) ?: return null
            return "${doc.path} § ${doc.section ?: ""}"
        }
        at("\\.sources\\.docs\\[(\\d+)\\]")?.firstOrNull()?.let { return section.sources.docs.getOrNull(it)?.path }
        at("\\.sources\\.contracts\\[(\\d+)\\]")?.firstOrNull()?.let { return section.sources.contracts.getOrNull(it) }
        val sessions = section.sources.sessions ?: return null
        listOf(sessions.projects.map { it.title } to "\\.projects\\[(\\d+)\\]$", sessions.topics to "\\.topics\\[(\\d+)\\]$",
            sessions.anchorPaths to "\\.anchorPaths\\[(\\d+)\\]$", sessions.entryKinds to "\\.entryKinds\\[(\\d+)\\]$").forEach { (list, pattern) ->
            at(pattern)?.firstOrNull()?.let { return list.getOrNull(it) }
        }
        return null
    }
    data class Lost(val number: Int, val title: String, val movedTo: String?)
    fun lostSections(shown: Shown, base: Shown?, slug: String): List<Lost> {
        val before = base?.docs?.firstOrNull { it.slug == slug } ?: return emptyList()
        val now = shown.docs.firstOrNull { it.slug == slug } ?: return emptyList()
        if (!before.protected) return emptyList()
        val kept = now.sections.map { it.title }.toSet()
        return before.sections.mapIndexedNotNull { i, section ->
            if (section.title in kept) null
            else Lost(i + 1, section.title, shown.docs.firstOrNull { it.slug != slug && it.sections.any { s -> s.title == section.title } }?.number)
        }
    }
    private fun sameDoc(a: ShownDoc, b: ShownDoc) = a.title == b.title && a.question == b.question && a.audience == b.audience && a.scopeIn == b.scopeIn &&
        a.scopeOut == b.scopeOut && a.length == b.length &&
        a.sections.map { "${it.title}|${it.kind}|${it.covers}|${it.length}" } == b.sections.map { "${it.title}|${it.kind}|${it.covers}|${it.length}" }
    private fun joinAnd(items: List<String>) = if (items.size <= 1) items.firstOrNull() ?: "" else "${items.dropLast(1).joinToString(", ")} and ${items.last()}"
    fun protectedText(shown: Shown, base: Shown?): String {
        val kept = base?.docs.orEmpty().filter { it.protected }
        if (kept.isEmpty()) return "No document is protected"
        val changed = mutableListOf<String>(); val unchanged = mutableListOf<String>()
        kept.forEach { doc ->
            val now = shown.docs.firstOrNull { it.slug == doc.slug }
            val number = now?.number ?: doc.number
            val lost = lostSections(shown, base, doc.slug)
            when {
                now == null -> changed += "$number is left out"
                lost.isNotEmpty() -> changed += "$number lost " + lost.joinToString(", ") { "§${it.number} ${it.title}${it.movedTo?.let { m -> " (moved to $m)" } ?: ""}" }
                !sameDoc(doc, now) -> changed += "$number is changed"
                else -> unchanged += number
            }
        }
        if (changed.isEmpty()) return "${joinAnd(unchanged)} unchanged"
        val rest = if (unchanged.isEmpty()) "" else " ${joinAnd(unchanged)} ${if (unchanged.size == 1) "is" else "are"} unchanged."
        return "${changed.joinToString("; ")}.$rest"
    }
    fun gate(shown: Shown, base: Shown?, job: WikiPlanJob?): Gate {
        val sha = shown.repoCheck?.let { WikiLogic.shortSha(it.sha) }
        val at = sha?.let { " · references checked at $it" } ?: ""
        if (shown.status != ShownStatus.FAILED) {
            val gate = shown.gate
            val docs = gate?.docs ?: shown.docs.size
            val target = gate?.target ?: shown.target
            val skipped = gate?.checks?.get("protected") == "skipped"
            val newFields = gate?.needsNewFields.orEmpty()
            val attempt = if (job?.version == shown.version) job.attempt?.let { "attempt $it" } else null
            val rows = gateOrder.map { check ->
                val text = when (check) {
                    "docCount" -> "${plural(docs, "document", "documents")} — within ${target.min}–${target.max}"
                    "protected" -> if (skipped) "Not checked — the version is your own edit" else protectedText(shown, base)
                    "references" -> shown.repoCheck?.let { "All ${WikiArticleCopy.count(it.checked ?: 0)} found at ${sha ?: ""}" } ?: "Every project and topic is this space’s"
                    else -> if (newFields.isEmpty()) "Every field is one the plan has"
                        else "${plural(newFields.size, "field", "fields")} to add: ${newFields.joinToString(", ") { "${it.name} (${it.at})" }}"
                }
                GateRow(check, true, gateTitle(check), text)
            }
            return Gate(true, WikiPlanCopy.passed, "4 checks$at", attempt, rows, emptyList(), emptyList())
        }
        val byCheck = shown.errors.groupBy { it.check }
        val kinds = mutableListOf<Triple<String, String, Int>>() // many, one, count
        val refs = byCheck["references"].orEmpty().map { error ->
            val kind = refKind(error.path)
            val i = kinds.indexOfFirst { it.first == kind.second }
            if (i >= 0) kinds[i] = kinds[i].copy(third = kinds[i].third + 1) else kinds += Triple(kind.second, kind.first, 1)
            RefRow(errorWhere(shown, error.path).second, kind.first, valueAt(shown, error.path) ?: error.path, error.message)
        }
        val checked: Int? = if (job?.kind != "build") job?.report?.repo?.checked else null
        val rows = gateOrder.map { check ->
            val errors = byCheck[check].orEmpty()
            val ok = errors.isEmpty()
            val text = when (check) {
                "docCount" -> "${plural(shown.docs.size, "document", "documents")} — ${if (ok) "within" else "the plan asks for"} ${shown.target.min}–${shown.target.max}"
                "protected" -> if (ok || base != null) protectedText(shown, base) else errors.joinToString(" ") { it.message }
                "references" -> if (ok) { if (checked != null && sha != null) "All ${WikiArticleCopy.count(checked)} found at $sha" else "Every reference was found" }
                    else "${WikiArticleCopy.count(errors.size)}${checked?.let { " of ${WikiArticleCopy.count(it)}" } ?: ""} not found" +
                        "${sha?.let { " at $it" } ?: ""} — files, symbols and headings on origin/main; projects and topics in this space"
                else -> if (ok) "Every field is one the plan has"
                    else "${plural(errors.size, "field isn’t", "fields aren’t")} the plan’s: ${errors.take(3).joinToString("; ") { "${it.path} ${it.message}" }}"
            }
            GateRow(check, ok, gateTitle(check), text)
        }
        val order = kinds.withIndex().sortedWith(compareByDescending<IndexedValue<Triple<String, String, Int>>> { it.value.third }.thenBy { it.index })
        return Gate(false, WikiPlanCopy.failed, "${failedChecks(shown.errors)} of 4 checks failed$at",
            job?.let { "${shown.model ?: it.provider ?: WikiCopy.historyMaintenance} tried ${plural(attempts(it), "time", "times")}" }, rows,
            order.map { "${WikiArticleCopy.count(it.value.third)} ${if (it.value.third == 1) singular(it.value.first) else it.value.first}" }, refs)
    }

    // MARK: categories, documents and sections

    fun categoryLine(category: ShownCategory) = plural(category.docs.size, "document", "documents")
    fun docLine(doc: ShownDoc) = "${plural(doc.sections.size, "section", "sections")} · ${WikiPlanCopy.chars(doc.length)}"
    fun docErrors(shown: Shown, doc: ShownDoc) = shown.errors.filter { firstMatch("(?:^|\\.)docs\\[${doc.index}\\](?:\\.|$)", it.path) != null }
    fun drawsOn(doc: ShownDoc): String {
        val docs = mutableListOf<String>(); val code = mutableListOf<String>(); val contracts = mutableListOf<String>()
        val topics = mutableListOf<String>(); val projects = mutableListOf<String>()
        fun add(value: String, list: MutableList<String>) { if (value !in list) list += value }
        var sessions = false
        doc.sections.forEach { section ->
            section.sources.docs.forEach { add(it.path, docs) }
            section.sources.code.forEach { add(it.path, code) }
            section.sources.contracts.forEach { add(it, contracts) }
            section.sources.sessions?.let { condition ->
                sessions = true
                condition.topics.forEach { add(it, topics) }
                condition.projects.forEach { add(it.id ?: it.title, projects) }
            }
        }
        val parts = mutableListOf<String>()
        if (docs.isNotEmpty()) parts += plural(docs.size, "design doc", "design docs")
        if (code.isNotEmpty()) parts += plural(code.size, "code path", "code paths")
        if (contracts.isNotEmpty()) parts += plural(contracts.size, "contract", "contracts")
        if (topics.isNotEmpty()) parts += "topics ${topics.joinToString(", ")}" else if (sessions) parts += "sessions"
        if (projects.isNotEmpty()) parts += plural(projects.size, "project", "projects")
        return if (parts.isEmpty()) "Nothing yet" else parts.joinToString(" · ")
    }
    fun sourcesSummary(section: ShownSection): String {
        val parts = mutableListOf<String>()
        if (section.sources.docs.isNotEmpty()) parts += plural(section.sources.docs.size, "doc section", "doc sections")
        if (section.sources.code.isNotEmpty()) parts += plural(section.sources.code.size, "code file", "code files")
        if (section.sources.contracts.isNotEmpty()) parts += plural(section.sources.contracts.size, "contract", "contracts")
        if (section.sources.sessions != null) parts += "sessions"
        if (parts.isNotEmpty()) return parts.joinToString(" · ")
        return if (section.kind == "overview") "Sums up the sections after it" else "No sources yet"
    }
    fun sectionLine(section: ShownSection) = listOf(WikiDocCopy.sectionKind(section.kind), WikiPlanCopy.sectionChars(section.length), sourcesSummary(section)).joinToString(" · ")
    fun sectionMeta(shown: Shown, section: ShownSection): String {
        val parts = mutableListOf(WikiDocCopy.sectionKind(section.kind), WikiPlanCopy.sectionChars(section.length))
        if (section.sources.sessions != null && section.sources.docs.isEmpty() && section.sources.code.isEmpty() && section.sources.contracts.isEmpty()) parts += "sessions"
        else shown.repoCheck?.let { parts += "references checked at ${WikiLogic.shortSha(it.sha)}" }
        return parts.joinToString(" · ")
    }
    fun sourceFound(shown: Shown, doc: ShownDoc, section: Int, kind: String, at: Int): Boolean? {
        val tail = "docs[${doc.index}].sections[$section].sources.$kind[$at]"
        val plain = "docs[${doc.index}].sections[$section].$kind[$at]"
        val missed = shown.errors.any { it.check == "references" && (it.path.contains(tail) || it.path.contains(plain)) } ||
            shown.repoCheck?.missing.orEmpty().any { miss -> miss.at?.let { it.contains(tail) || it.contains(plain) } ?: false }
        if (missed) return false
        return if (shown.repoCheck != null) true else null
    }

    // MARK: the changes proposed

    enum class ChangeOp(val label: String) { ADD_SECTION("ADD SECTION"), REMOVE_SECTION("REMOVE SECTION"), ADD_DOCUMENT("ADD DOCUMENT"), CHANGE_DOCUMENT("CHANGE DOCUMENT") }
    data class ChangeRow(val mark: Mark, val n: String, val title: String, val note: String) { enum class Mark { SAME, ADD, REMOVE } }
    data class Change(val op: ChangeOp, val target: String, val title: String, val rows: List<ChangeRow>, val renumber: String?, val added: List<WikiPlanSectionInput>)
    private fun sectionMatch(aKey: String?, aTitle: String, bKey: String?, bTitle: String) = if (aKey != null && bKey != null) aKey == bKey else aTitle == bTitle
    private fun renumbered(text: String?): String? {
        val m = text?.let { firstMatch("^§(\\d+)–(\\d+) become §(\\d+)–(\\d+)$", it) } ?: return text
        return if (m[1] == m[2] && m[3] == m[4]) "§${m[1]} becomes §${m[3]}" else text
    }
    fun change(proposal: WikiPlanProposal, base: Shown?): Change {
        val doc = proposal.change?.doc
        val slug = doc?.slug ?: ""
        val title = doc?.title ?: slug
        val sections = doc?.sections.orEmpty()
        fun note(section: WikiPlanSectionInput) = "${WikiDocCopy.sectionKind(section.kind)} · ${WikiPlanCopy.sectionChars(section.length)}"
        val before = base?.docs?.firstOrNull { it.slug == slug }
            ?: return Change(ChangeOp.ADD_DOCUMENT, title, "Add document “$title”",
                sections.mapIndexed { i, s -> ChangeRow(ChangeRow.Mark.ADD, "+${i + 1}", s.title, note(s)) }, null, sections)
        val target = "${before.number} ${before.title}"
        val added = sections.withIndex().filter { item -> before.sections.none { sectionMatch(item.value.key, item.value.title, it.key, it.title) } }
        val removed = before.sections.withIndex().filter { item -> sections.none { sectionMatch(it.key, it.title, item.value.key, item.value.title) } }
        val count = before.sections.size
        if (added.isNotEmpty() && removed.isEmpty()) {
            val first = added.first()
            val rows = mutableListOf<ChangeRow>()
            if (first.index > 0) { val prev = sections[first.index - 1]; rows += ChangeRow(ChangeRow.Mark.SAME, "${first.index}", prev.title, WikiDocCopy.sectionKind(prev.kind)) }
            rows += added.map { ChangeRow(ChangeRow.Mark.ADD, "+${it.index + 1}", it.value.title, note(it.value)) }
            val from = first.index + 1
            val renumber = if (from <= count) "§$from–$count become §${from + added.size}–${count + added.size}" else null
            return Change(ChangeOp.ADD_SECTION, target, if (added.size == 1) "Add §$from “${first.value.title}”" else "Add ${added.size} sections",
                rows, renumbered(renumber), added.map { it.value })
        }
        if (removed.isNotEmpty() && added.isEmpty()) {
            val first = removed.first()
            val rows = removed.map { ChangeRow(ChangeRow.Mark.REMOVE, "−${it.index + 1}", it.value.title, WikiDocCopy.sectionKind(it.value.kind)) }
            val from = first.index + 2
            val renumber = if (from <= count) "§$from–$count become §${from - removed.size}–${count - removed.size}" else null
            return Change(ChangeOp.REMOVE_SECTION, target, if (removed.size == 1) "Remove §${first.index + 1} “${first.value.title}”" else "Remove ${removed.size} sections",
                rows, renumbered(renumber), emptyList())
        }
        return Change(ChangeOp.CHANGE_DOCUMENT, target, "Change “${before.title}”",
            added.map { ChangeRow(ChangeRow.Mark.ADD, "+${it.index + 1}", it.value.title, note(it.value)) } +
                removed.map { ChangeRow(ChangeRow.Mark.REMOVE, "−${it.index + 1}", it.value.title, WikiDocCopy.sectionKind(it.value.kind)) },
            null, added.map { it.value })
    }
    fun sourceLines(sources: WikiPlanSourcesInput?, projectTitle: (String) -> String? = { null }): List<String> {
        sources ?: return emptyList()
        val lines = mutableListOf<String>()
        sources.docs.orEmpty().forEach { lines += "Design doc ${it.path}${it.section?.let { s -> " § $s" } ?: ""}" }
        sources.code.orEmpty().forEach { val symbols = it.symbols.orEmpty(); lines += "Code ${it.path}${if (symbols.isEmpty()) "" else " · ${symbols.joinToString(" · ")}"}" }
        sources.contracts.orEmpty().forEach { lines += "Contract ${it.path}" }
        sources.sessions?.let { sessions ->
            val projects = sessions.projects.orEmpty().map { "「${projectTitle(it) ?: it}」" }
            val words = sessions.keywords.orEmpty()
            lines += "Sessions${if (projects.isEmpty()) "" else " in ${projects.joinToString(", ")}"}${sessions.since?.let { " since $it" } ?: ""}" +
                (if (words.isEmpty()) "" else " · ${words.joinToString(" · ")}")
        }
        return lines
    }
    fun acceptNote(state: WikiPlanState, op: ChangeOp): String {
        val next = nextVersion(state)
        state.draft?.let { return "Draft v${it.version} is waiting for you — accepting adds this change to a new draft, v$next, for you to confirm" }
        return "Accepting confirms plan v$next · Wiki maintenance writes the ${if (op == ChangeOp.ADD_DOCUMENT || op == ChangeOp.CHANGE_DOCUMENT) "document" else "section"} next"
    }
    fun acceptConfirms(state: WikiPlanState) = state.draft == null

    // MARK: Edit — in the draft's shape

    /** A section of the read, in the draft's shape: no id or position, projects by id (`wikiPlanSectionInput`). */
    fun sectionInput(section: WikiPlanSection): WikiPlanSectionInput {
        val sources = section.sources
        val sessions = sources?.sessions?.let { c -> WikiPlanSessionConditionInput(c.projects.orEmpty().map { it.id }, c.since, c.until,
            c.keywords.orEmpty(), c.anchorPaths.orEmpty(), c.entryKinds.orEmpty(), c.topics.orEmpty(), c.evidence ?: "") }
        return WikiPlanSectionInput(section.key, section.title, section.kind, section.covers ?: "", section.length ?: 0,
            WikiPlanSourcesInput(sources?.docs.orEmpty().map { WikiPlanSources.DocSource(it.path, it.section) },
                sources?.code.orEmpty().map { WikiPlanSources.CodeSource(it.path, it.symbols.orEmpty()) },
                sources?.contracts.orEmpty().map { WikiPlanSources.ContractSource(it.path) }, sessions),
            section.extra?.takeIf { it.isNotEmpty() })
    }
    fun docInput(doc: WikiPlanDoc) = WikiPlanDocInput(doc.category, doc.slug, doc.title, doc.question ?: "", doc.audience.orEmpty(), doc.scopeIn.orEmpty(),
        doc.scopeOut.orEmpty().map { WikiPlanDoc.ScopeOut(it.text, it.docs.orEmpty()) }, doc.length ?: WikiPlanRange(0, 0), doc.protected ?: false,
        doc.sections.orEmpty().map(::sectionInput), doc.extra?.takeIf { it.isNotEmpty() })

    data class DocForm(val title: String, val question: String, val audience: List<String>, val scopeIn: List<String>, val length: WikiPlanRange,
        val protected: Boolean, val sections: List<Section>) {
        data class Section(val key: String?, val title: String, val kind: String, val id: String = key ?: UUID.randomUUID().toString())
    }
    fun docForm(doc: WikiPlanDoc) = DocForm(doc.title, doc.question ?: "", doc.audience.orEmpty(), doc.scopeIn.orEmpty(), doc.length ?: WikiPlanRange(0, 0),
        doc.protected ?: false, doc.sections.orEmpty().map { DocForm.Section(it.key, it.title, it.kind) })
    /** The form's fields over the document as it was — every kept section with its covers, length and sources (`wikiPlanDocEdit`). */
    fun docEdit(doc: WikiPlanDoc, form: DocForm): WikiPlanDocInput {
        val input = docInput(doc)
        val byKey = LinkedHashMap<String, WikiPlanSectionInput>().apply { input.sections.forEach { s -> s.key?.let { putIfAbsent(it, s) } } }
        fun lines(items: List<String>) = items.map { it.trim() }.filter { it.isNotEmpty() }
        return input.copy(title = form.title.trim(), question = form.question.trim(), audience = lines(form.audience), scopeIn = lines(form.scopeIn),
            length = form.length, protected = form.protected, sections = form.sections.map { row ->
                val title = row.title.trim()
                val kept = row.key?.let { byKey[it] }
                kept?.copy(title = title, kind = row.kind) ?: WikiPlanSectionInput(title = title, kind = row.kind, covers = title, length = WikiPlanCopy.newSectionLength)
            })
    }
    fun docEditBody(version: Int, slug: String, doc: WikiPlanDocInput) = buildJsonObject { put("baseVersion", version); put("docSlug", slug); put("doc", doc.json()) }
    /** One section, as its own page edits it (`wikiPlanSectionEditBody`). */
    fun sectionEditBody(version: Int, slug: String, section: WikiPlanSection, title: String, kind: String, covers: String, length: Int): JsonObject {
        val input = sectionInput(section).copy(title = title.trim(), kind = kind, covers = covers.trim(), length = length)
        return buildJsonObject { put("baseVersion", version); put("docSlug", slug); put("sectionKey", section.key); put("section", input.json()) }
    }

    // MARK: the plan on the home

    enum class Look { HELD, DRAFT_FAILED, DRAFT_READY, CHANGES, DRAFTING, QUEUED, WRITING, NO_PLAN }
    fun look(state: WikiPlanState, runnerOnline: Boolean?): Look? {
        val open = openJob(state); val build = buildJob(state)
        return when {
            held(open ?: build, runnerOnline) != null -> Look.HELD
            failedJob(state) != null -> Look.DRAFT_FAILED
            state.draft != null -> Look.DRAFT_READY
            state.proposals.orEmpty().isNotEmpty() -> Look.CHANGES
            open?.state == "running" -> Look.DRAFTING
            open?.state == "queued" -> Look.QUEUED
            build != null && state.confirmed != null -> Look.WRITING
            state.confirmed == null && open == null -> Look.NO_PLAN
            else -> null
        }
    }
    fun pending(state: WikiPlanState, runnerOnline: Boolean?) = (if (held(openJob(state) ?: buildJob(state), runnerOnline) != null) 1 else 0) +
        (if (failedJob(state) != null) 1 else 0) + (if (state.draft != null) 1 else 0) + state.proposals.orEmpty().size
    data class Banner(val text: String, val amber: Boolean, val toSettings: Boolean)

    /** One of Activity's amber plan banners: the banner for one kind of thing that waits, and how many of [pending] it is. */
    data class WaitingBanner(val banner: Banner, val look: Look, val count: Int)

    /** Activity's amber plan banners (`wikiPlanWaitingBanners`, design §12.3.3): the banner for each kind of thing of the plan
     * that waits on the owner, in the order the looks win — held, the draft that failed, the draft to confirm, the changes
     * — each with how many of [pending] it is, so a page's amber banners add up to the number on the bar's Activity badge.
     * Empty when nothing waits. */
    fun waitingBanners(state: WikiPlanState, now: Instant, docs: Pair<Int, Int>?, runnerOnline: Boolean?): List<WaitingBanner> =
        listOf(Look.HELD to (if (held(openJob(state) ?: buildJob(state), runnerOnline) != null) 1 else 0),
            Look.DRAFT_FAILED to (if (failedJob(state) != null) 1 else 0), Look.DRAFT_READY to (if (state.draft != null) 1 else 0),
            Look.CHANGES to state.proposals.orEmpty().size)
            .filter { (_, count) -> count > 0 }
            .map { (look, count) -> WaitingBanner(banner(look, state, now, docs, runnerOnline), look, count) }
    fun banner(look: Look, state: WikiPlanState, now: Instant, docs: Pair<Int, Int>?, runnerOnline: Boolean?): Banner {
        val job = openJob(state)
        return when (look) {
            Look.HELD -> {
                val why = held(job ?: buildJob(state), runnerOnline)
                val what = if (job != null) "Plan draft held" else "Writing documents held"
                if (why == Held.RUNNER_OFFLINE) Banner("$what — the runner is offline", true, false) else Banner("$what — set up maintenance", true, true)
            }
            Look.DRAFT_FAILED -> Banner("Plan draft didn’t pass the check", true, false)
            Look.DRAFT_READY -> Banner("Plan draft ready to confirm", true, false)
            Look.CHANGES -> Banner("${plural(state.proposals.orEmpty().size, "plan change", "plan changes")} to review", true, false)
            Look.DRAFTING -> Banner("Drafting the plan${job?.startedAt?.let { " · started ${WikiHealthLogic.ago(it, now)}" } ?: ""}", false, false)
            Look.QUEUED -> Banner("Plan draft queued", false, false)
            Look.WRITING -> {
                val counts = buildCounts(buildJob(state), docs) ?: (0 to 0)
                Banner("Writing documents · ${WikiArticleCopy.count(counts.first)} of ${WikiArticleCopy.count(counts.second)}", false, false)
            }
            Look.NO_PLAN -> Banner("No plan yet — draft one", false, false)
        }
    }
}
