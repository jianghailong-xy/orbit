package io.orbitd.android.wiki

import java.time.ZoneId

// Every sentence the Wiki pages say, word for word from OrbitKit `WikiCopy` / `WikiModeCopy` /
// `WikiHealthCopy` / `WikiArticleCopy` / `WikiDocCopy` (the fixed iOS baseline). One place for the
// words, as there: a word means one thing everywhere, and a sentence reworded here would no longer be
// the one the other client shows.

internal object WikiCopy {
    const val title = "Wiki"
    const val searchPlaceholder = "Search the wiki"
    const val reviewTitle = "Review"
    fun proposalsToReview(count: Int) = "$count proposal${if (count == 1) "" else "s"} to review"
    fun proposalsFrom(count: Int, sessions: Int) =
        "$count proposal${if (count == 1) "" else "s"} from $sessions session${if (sessions == 1) "" else "s"}"
    fun oldest(`when`: String) = "oldest $`when`"

    /** Activity and the number waiting on the owner (design §12.3.2–§12.3.4, §12.3.7): every space's proposals and the
     * things each plan waits on the owner for; the drawer's Wiki row and the bar's Activity badge show it, and say it the
     * way the Projects row says its own. */
    const val activity = "Activity"
    fun waitingOnYou(count: Int) = "$count waiting on you"
    /** Beside Recently changed: how many of its rows came after the reader last looked. */
    fun newSinceLastLooked(count: Int) = "$count new since you last looked"
    /** The share of Activity's first banner that is another space's: `3 proposals to review · 2 in wikova`. */
    fun countInSpace(count: Int, space: String) = "· $count in $space"
    /** After another space's plan banner, which space it is: `Plan draft ready to confirm · in wikova`. */
    fun inSpace(space: String) = "· in $space"
    /** After a space's name in the picker, what waits on the owner in it: `wikova · 2 waiting`. */
    fun spaceWaiting(count: Int) = "· $count waiting"
    /** The picker's words (mock 31 ④): the way into Wiki settings under the spaces, and each space's documents. */
    const val manageSpaces = "Manage spaces"
    fun documentCount(count: Int) = "${WikiArticleCopy.count(count)} ${if (count == 1) "document" else "documents"}"
    const val noDocuments = "No documents yet"

    const val principles = "Principles"
    /** After the home's first three principles, the way to all of them: `All 6 ›` (`wikiAllPrinciples`). */
    fun allPrinciples(count: Int) = "All $count ›"
    const val recentDecisions = "Recent decisions"
    const val recentlyChanged = "Recently changed"
    const val agentsUsed = "Agents used the wiki"
    const val agentsUsedHint = "this week"

    fun entryNoun(count: Int) = if (count == 1) "entry" else "entries"
    fun anchorsVerified(ref: String, ago: String) = if (ago.isEmpty()) "Anchors verified at $ref" else "Anchors verified at $ref $ago"

    const val noSpaces = "No wiki space yet. A space is a codebase, and the first one is made when a session proposes into it."
    /** What the Wiki section says to an account the server has not switched the wiki on for. */
    const val disabledNote = "The wiki is not switched on for this account."
    const val spacePickerHint = "The codebase this wiki describes"
    const val sessionsReceived = "sessions received wiki context"
    const val searches = "searches"
    const val noLongerPushed = "no longer sent to agents"

    const val details = "Details"
    const val sources = "Sources"
    const val anchors = "Anchors"
    const val whereUsed = "Where it's used"
    const val history = "History"
    const val anchorsNote = "Checked again after every commit to main. If the anchored code changes, agents stop getting this entry until someone re-checks it."
    fun pushedTo(sessions: Int, fetched: Int) =
        "Pushed to $sessions session${if (sessions == 1) "" else "s"} this week · fetched $fetched×"
    const val noUseYet = "No session has been shown this entry yet."

    const val edit = "Edit"
    const val supersede = "Supersede…"
    const val retire = "Retire…"
    const val copyLink = "Copy link"
    const val linkCopied = "Copied"
    const val pinned = "Pinned"

    const val editNote = "Only the title and the one-line summary change here."
    const val supersedeNote = "The replacement keeps this entry’s kind, fields and anchor, and this entry points at it."
    const val retireNote = "Agents stop getting this entry. It stays in History, struck through, and the reason goes on the record."
    const val titlePlaceholder = "Title"
    const val summaryPlaceholder = "One line"
    const val reasonPlaceholder = "Why it no longer holds"
    const val save = "Save"
    const val supersedeConfirm = "Supersede"
    const val retireConfirm = "Retire"
    const val saved = "Saved"
    const val settingsSaved = "Wiki settings saved"
    const val superseded = "Superseded"
    const val retired = "Retired"
    const val refused = "The server refused it"
    /** A decide the server recorded `conflict`: the entry had moved past the op (a newer revision), so nothing was
     * applied. iOS shows the action's own toast here — an iOS defect, not copied. */
    const val conflictRefused = "Nothing was applied: the entry changed after this was proposed."
    /** A challenge answered for an entry that is no longer active: recorded `conflict`, nothing applied. */
    const val inactiveRefused = "Nothing was applied: the entry is no longer active."
    const val withdrawnRefused = "Nothing was applied: the proposal was withdrawn."
    /** The banner for a write whose page had gone when it answered. */
    fun landed(done: String, subject: String?) = if (subject.isNullOrBlank()) done else "$done — $subject"
    fun refusedFor(subject: String?, why: String) = if (subject.isNullOrBlank()) why else "$subject: $why"
    const val dismiss = "Dismiss"
    /** A link named a space this account does not have — deleted, or another account's: nothing of it is shown. */
    const val spaceUnavailable = "That space is not available."
    const val spaceUnavailableNote = "It may have been deleted, or it belongs to another account."
    fun editedRationale(title: String) = "the owner edited “$title”"
    fun replacedRationale(title: String) = "the owner replaced “$title”"
    fun retiredRationale(title: String) = "the owner retired “$title”"

    const val noSources = "A quote is what makes a claim checkable. This entry cites none."
    const val noAnchors = "No anchor: nothing in the repository has to stay true for this to hold."
    const val noHistory = "No revision has been recorded."
    const val pushedAtStart = "in its Wiki context at start"
    const val pushedBadge = "Pushed"
    const val fetchedBadge = "Fetched"
    const val quoteVerified = "quote verified ✓"
    const val quoteUnverified = "quote not checked"

    const val historyProposedBy = "Proposed by a session"
    const val historyConfirmedBy = "Confirmed by you"
    const val historyMaintenance = "Wiki maintenance"
    const val historySystem = "Recorded by the server"
    fun revision(number: Int) = "r$number"
    fun compareWith(number: Int) = "Compare with r$number"

    const val proposedBy = "Proposed by"
    const val entryWord = "entry"
    const val reasonLabel = "Reason"
    const val evidenceLabel = "Evidence"
    const val afterLabel = "After"
    const val decidedAccepted = "Accepted"
    const val decidedEdited = "Accepted with your edits"
    const val rejected = "Rejected"
    const val decidedKept = "Kept"
    const val decidedReconfirmed = "Re-confirmed"
    const val decidedAmended = "Amended"
    const val decideFailed = "Couldn't record your answer"
    const val accept = "Accept"
    const val reviewEdit = "Edit"
    const val reject = "Reject"
    const val keep = "Keep"
    const val reviewRetire = "Retire"
    const val acceptNote = "Accepting makes it Confirmed"
    const val webDerivedNote = "Web-derived is never auto-accepted"
    const val rejectReasonFoot = "The reason goes back to the session that proposed it."
    const val similarNone = "None"
    const val similarEntries = "Similar entries"
    const val afterRetire = "Agents stop getting this entry. It stays in History, struck through, and points to the entry that replaced it."
    const val webDerived = "Web-derived"
    const val webDerivedWarning = "this session read web pages before proposing. Accepting shows it to agents."
    const val autoAccept = "Auto-accept"
    const val autoAcceptHint = "These apply without asking you, and still show in Recently changed."
    const val reinforce = "Reinforce"
    const val reinforceNote = "Adds a source to an existing entry"
    const val challenge = "Challenge"
    const val challengeNote = "Flags an entry for re-check; changes nothing"
    const val alwaysAsks = "Always asks you"
    const val alwaysAsksNote = "Add, Amend and Retire, and anything a session proposed after reading the web."

    const val previous = "Previous"
    const val next = "Next"
    fun ofCount(at: Int, total: Int) = "$at of $total"

    const val tabAll = "All"
    const val tabAdd = "Add"
    const val tabAmend = "Amend"
    const val tabRetire = "Retire"

    const val noReview = "Nothing is waiting for you."
    const val noChanges = "Nothing has changed yet."
    const val noDecisions = "No decision has been recorded yet."
    const val noAgentsYet = "No session has used this wiki yet."
    const val noEntrySelected = "That entry is no longer in this space."

    fun trustLabel(trust: String?) = when (trust) {
        "owner" -> "Owner"; "confirmed" -> "Confirmed"; "auto" -> "Auto"; "unreviewed" -> "Unreviewed"
        "proposed" -> "Proposed"; "external" -> "Web-derived"; else -> ""
    }
    fun kindLabel(kind: String?) = when (kind) {
        "principle" -> "Principle"; "convention" -> "Convention"; "decision" -> "Decision"; "pitfall" -> "Pitfall"
        "recipe" -> "Recipe"; "concept" -> "Concept"; "assumption" -> "Assumption"; else -> ""
    }
    fun opLabel(op: String?) = when (op) {
        "add" -> "ADD"; "amend" -> "AMEND"; "supersede" -> "SUPERSEDE"; "retire" -> "RETIRE"
        "reinforce" -> "REINFORCE"; "challenge" -> "CHALLENGE"; else -> ""
    }
    fun statusLabel(status: String?) = when (status) {
        "active" -> "Active"; "proposed" -> "Proposed"; "superseded" -> "Superseded"; "retired" -> "Retired"
        "rejected" -> "Rejected"; else -> ""
    }
    /** The four rejection reasons, in the order Review's menu lists them (contract `rejectReasons`). */
    val rejectReasons = listOf("not_true", "not_useful", "duplicate", "too_specific")
    fun rejectReasonLabel(reason: String) = when (reason) {
        "not_true" -> "Not true"; "not_useful" -> "Not useful"; "duplicate" -> "Duplicate"; "too_specific" -> "Too specific"; else -> reason
    }
}

internal object WikiModeCopy {
    const val settings = "Settings"
    const val settingsTitle = "Wiki settings"
    const val reviewMode = "Review mode"
    const val reviewModeHint = "Only you can switch it"
    const val reviewModeLead = "Who has to look at a change before agents get it."
    const val modeDefault = "default"
    fun modeLabel(mode: String?) = when (mode) { "manual" -> "Manual"; "tiered" -> "Tiered"; "automatic" -> "Automatic"; else -> "" }
    fun modeNote(mode: String?) = when (mode) {
        "manual" -> "Every change from sessions, maintenance and imports waits for you in Review."
        "tiered" -> "Your own words and machine-checked entries apply at once; the rest show as Unreviewed and are not sent to agents."
        "automatic" -> "local-vllm checks each change against its sources first: supported ones apply, partly supported ones show as Unreviewed, the rest are rejected with a reason."
        else -> ""
    }
    const val spotCheck = "Spot-check Automatic"
    const val spotCheckNote = "Send 1 in 200 of the changes it applies to Review, to see what it lets through. Off by default; spot checks do not count toward the 30 waiting in Review."
    const val floorsLead = "Always asks you, in any mode:"
    const val floorsNote = "principles, anything a session proposed after reading the web, and changes to entries you wrote or confirmed. A run that would change more than 10% of the wiki stops."
    const val maintenance = "Maintenance"
    const val maintenanceName = WikiCopy.historyMaintenance
    const val maintenanceNote = "Keeps the wiki up to date from sessions, tasks and receipts as they settle. Runs on the workspace you pick, with the provider pinned."
    const val off = "Off"
    const val on = "On"
    const val setUp = "Set up…"
    const val setUpTitle = "Set up maintenance"
    const val status = "Status"
    const val workspace = "Workspace"
    const val workspaceNote = "The runner that checks out this codebase; maintenance runs there."
    const val provider = "Provider"
    const val providerNote = "Pinned: a run never falls back to another provider."
    const val pinnedNoFallback = "pinned, no fallback"
    const val dailyLimit = "Daily limit"
    const val runsADayUnit = "runs a day"
    const val dailyLimitNote = "A run starts when 20 sessions have settled, or when the oldest waits a day. Each run writes at most 30 changes."
    const val lookback = "Look back"
    const val lookbackNote = "How far back maintenance starts reading when you turn it on. Changing it later never moves maintenance back."
    const val lookbackNow = "From now on"
    const val lookbackAll = "All history"
    const val lookbackUnit = "days"
    const val cancel = "Cancel"
    const val turnOn = "Turn on"
    const val turnOff = "Turn off"
    const val maintenanceEdit = "Edit"
    const val save = "Save"
    const val noWorkspace = "Pick a workspace"
    fun runsADay(runs: Int) = if (runs == 1) "1 run a day" else "$runs $runsADayUnit"
    fun lookbackLabel(days: Int?) = when {
        days == null -> lookbackAll
        days == 0 -> lookbackNow
        days == 1 -> "Last 1 day"
        else -> "Last $days $lookbackUnit"
    }

    const val confirm = "Confirm"
    const val confirmed = "Confirmed"
    const val rejected = "Rejected"
    const val rejectOnRecord = "The reason goes on the record."
    const val notSentUnreviewed = "Not sent to agents while it is Unreviewed."
    const val bannerAuto = "applied without asking you, and sent to agents. Reject takes it back."
    const val bannerUnreviewed = "applied without review, and not sent to agents until you confirm it."
    const val bannerWebDerived = "this session read web pages before proposing. Confirming shows it to agents."
    const val cappedAtUnreviewed = "capped at Unreviewed"
    fun verdictWord(verdict: String?) = when (verdict) {
        "supported" -> "supported"; "partial" -> "partly supported"; "unsupported" -> "not supported"; "duplicate" -> "a duplicate"; else -> ""
    }

    const val run = "run"
    const val viewRun = "View run"
    const val revertRun = "Revert run…"
    const val revertRunConfirm = "Revert run"
    const val revertTitle = "Revert this run?"
    const val revertKeeps = "Changes you have confirmed, edited or rejected since are left as they are."
    const val reverted = "Reverted"
    const val openSession = "Open session"
    const val runAdded = "Added"
    const val runAmended = "Amended"
    const val runReinforced = "Reinforced"
    fun showMore(count: Int) = "Show $count more"
    const val showLess = "Show less"
    fun originWord(origin: String?) = when (origin) {
        "maintenance" -> WikiCopy.historyMaintenance; "import" -> "Import"; "agent" -> "A session"; "watch" -> "A watch"; "owner" -> "You"
        else -> ""
    }
    fun runKicker(origin: String?) = "${originWord(origin)} · $run"
    fun appliedChanges(count: Int) = "Applied $count change${if (count == 1) "" else "s"}"
    fun rejectedByCheck(count: Int) = "$count rejected by the check"
    fun toReview(count: Int) = "$count to review"

    const val reconfirm = "Re-confirm"
    const val amend = "Amend"
    const val retire = "Retire"
    const val challengeWaits = "Agents stop getting this entry until you answer."
    const val challenged = "Challenged"
    const val amendNote = "Your version replaces the entry, and its anchors are checked again."
    fun checkedOnMain(ref: String) = "checked on main at ${WikiLogic.shortSha(ref)}"
}

internal object WikiHealthCopy {
    const val maintenanceOff = "Maintenance off"
    const val setUp = "Set up"
    const val maintenanceOn = "Maintenance on"
    const val maintenanceBehind = "Maintenance behind"
    const val dailyLimitReached = "daily limit reached"
    const val reviewQueueFull = "review queue full"
    fun maintained(ago: String) = "Maintained $ago"
    fun maintainingNow(ago: String) = "Maintaining now · started $ago"
    fun toCatchUp(count: Int) = "${WikiArticleCopy.count(count)} to catch up"
    fun behindBy(count: Int, lag: String) = "${WikiArticleCopy.count(count)} to catch up, oldest $lag"
    fun lastRun(ago: String) = "last run $ago"
    fun lastSuccess(ago: String) = "last success $ago"
    fun failed(count: Int) = if (count == 1) "Maintenance failed" else "Maintenance failed $count times"

    // The server's reasons (mock 35 ⑥, P9): the web's `WIKI_REASON_*`.
    const val reasonWorker = "wiki worker not running"
    const val reasonUnconfigured = "System model not configured"
    const val reasonKeyRefused = "System model refused the key"
    const val reasonUnreachable = "System model unreachable"
    const val reasonRunnerOffline = "Waiting for the runner to come online"
    const val reasonRunnerUpgrade = "Upgrade the runner to read the repository"
}

internal object WikiArticleCopy {
    const val contents = "Contents"
    const val home = "Home"
    const val browse = "Browse by category"
    const val azIndex = "A–Z index"
    const val other = "Other"
    const val footnotes = "Footnotes"
    const val entries = "Entries"
    const val footnoteGone = "This entry is no longer in the wiki."
    const val openEntry = "Open entry"
    const val topicOverview = "Topic overview"
    const val noArticleYet = "No article yet. The maintenance run writes one once this topic has entries."
    const val noArticles = "No article has been written yet. The maintenance run writes one for each topic that has entries."
    const val noTopicEntries = "No entry in this space carries that topic."
    const val groupPrinciples = "Principles & conventions"
    const val groupDecisions = "Decisions"
    const val groupPitfalls = "Pitfalls"
    const val groupRecipes = "Recipes"
    const val groupConcepts = "Concepts"
    const val notePrinciples = "What every task in this topic starts from"
    const val noteDecisions = "Active decisions, newest first"
    const val notePitfalls = "Traps a run has actually hit, with the way out"
    const val noteRecipes = "Steps that worked, with how to check them"
    const val noteConcepts = "The words this topic uses, defined once"
    fun showMore(count: Int) = "Show $count more"
    const val showLess = "Show less"

    /** A count as the pages print it: `11,689`. */
    fun count(value: Int): String {
        val digits = Math.abs(value.toLong()).toString()
        val out = StringBuilder()
        digits.forEachIndexed { i, digit -> if (i > 0 && (digits.length - i) % 3 == 0) out.append(','); out.append(digit) }
        return if (value < 0) "-$out" else out.toString()
    }
    fun entriesCited(count: Int) = "$count ${if (count == 1) "entry" else "entries"} cited"
    fun entriesHint(n: Int) = "the ${count(n)} this article is written from, by kind"
    fun articleCount(n: Int) = "${count(n)} ${if (n == 1) "article" else "articles"}"
    fun entryCount(n: Int) = "${count(n)} ${if (n == 1) "entry" else "entries"}"
    fun topicCount(n: Int) = "${count(n)} ${if (n == 1) "topic" else "topics"}"
    fun sourcesLine(sources: Int, sessions: Int): String {
        val parts = mutableListOf("$sources ${if (sources == 1) "source" else "sources"}")
        if (sessions > 0) parts += "$sessions ${if (sessions == 1) "session" else "sessions"}"
        return parts.joinToString(" · ")
    }
    fun noteLabel(n: Int) = "[$n]"
    fun browseSummary(articles: Int, topics: Int, entries: Int) = "${articleCount(articles)} · ${topicCount(topics)} · ${entryCount(entries)}"
    fun categorySummary(topics: Int, articles: Int, entries: Int) = "${topicCount(topics)} · ${articleCount(articles)} · ${entryCount(entries)}"
    fun browseTopicLine(entries: Int, articles: Int) = "${entryCount(entries)} · ${articleCount(articles)}"
    fun moreArticles(n: Int) = "$n more"
    fun indexSummary(n: Int) = "${articleCount(n)} by title · Chinese titles by pinyin"
    fun updated(generatedAt: String?, ref: String?, entryCount: Int, zone: ZoneId = ZoneId.systemDefault()): String {
        val day = generatedAt?.let { WikiModeLogic.monthDay(it, zone) } ?: ""
        val at = ref?.let { " at ${WikiLogic.shortSha(it)}" } ?: ""
        return "Updated $day$at · written by ${WikiCopy.historyMaintenance} from ${count(entryCount)} ${if (entryCount == 1) "entry" else "entries"}"
    }
}

internal object WikiDocCopy {
    const val plan = "Plan"
    const val question = "Question"
    const val writtenFor = "Written for"
    const val covers = "Covers"
    const val notCovered = "Not covered"
    const val scopeFolded = "Written for · Covers · Not covered"
    const val noSource = "No source"
    const val notVerified = "Not verified"
    const val withdrawn = "Withdrawn"
    const val rewritePending = "Rewrite pending"
    const val needsReview = "Needs review"
    const val nextMarked = "Next marked ›"
    const val notWritten = "Not written yet."
    const val sectionNotWritten = "Not written yet — Wiki maintenance writes it on its next run."
    const val footnotes = "Footnotes"
    const val viaEntry = "Via entry"
    const val noQuoteGiven = "— no quote given"
    const val entries = "Entries"
    const val openTheEntry = "Open the entry ›"
    const val notWrittenShort = "Not written yet"
    const val excerptLinesPhone = 6
    const val footnotesShown = 15
    const val groupShownPhone = 3
    const val browseSectionsShownPhone = 6

    fun sectionKind(kind: String?) = when (kind) {
        "overview" -> "Overview"; "concepts" -> "Concepts"; "flow" -> "Flow"; "interface" -> "Interface"
        "data" -> "Data & config"; "ops" -> "Operations"; "pitfalls" -> "Pitfalls"; "decisions" -> "Decisions"
        "conventions" -> "Conventions"; else -> "Other"
    }
    fun footnoteKind(kind: String?) = when (kind) {
        "design_doc" -> "Design doc"; "code" -> "Code"; "contract" -> "Contract"; "turn", "event", "tool_call" -> "Session"
        "task" -> "Task"; "task_comment" -> "Task comment"; "approval" -> "Approval"; "owner_decision" -> "Owner decision"
        "merge_receipt" -> "Merge receipt"; "note" -> "Note"; else -> "Source"
    }
    fun verdictCard(verdict: String?) = when (verdict) {
        "verified" -> "quote verified ✓"; "not_found" -> "✗ quote not found"; "no_quote" -> "✗ no quote given"; else -> "✗ source not found"
    }
    fun verdictList(verdict: String?) = when (verdict) {
        "verified" -> "✓"; "not_found" -> "✗ quote not found"; "no_quote" -> "✗ no quote"; else -> "✗ not found"
    }
    private fun plural(n: Int, one: String, many: String) = "${WikiArticleCopy.count(n)} ${if (n == 1) one else many}"
    fun moreLines(n: Int) = "… ${plural(n, "more line", "more lines")}"
    fun moreSections(n: Int) = plural(n, "more section", "more sections")
    fun entriesHint(n: Int) = "the ${WikiArticleCopy.count(n)} this document’s quotes came through, by kind"
    fun seeFootnote(n: Int) = "See footnote [$n]"
    fun noteLabel(n: Int) = "[$n]"
    fun sectionList(numbers: List<Int>): String {
        val marks = numbers.toSet().sorted().map { "§$it" }
        if (marks.size <= 1) return marks.firstOrNull() ?: ""
        return "${marks.dropLast(1).joinToString(", ")} and ${marks.last()}"
    }
    fun monthDayTime(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String? =
        iso?.let { WikiModeLogic.runWhen(it, zone).ifEmpty { null } }

    // The home, by the confirmed plan (design §12.3.1, mocks 30 ③, 31 ① ⑥).

    /** The line under the home's head once a plan is confirmed: `35 documents · 5 written` (`wikiDocsWritten`). */
    fun docsWritten(total: Int, written: Int) = "${plural(total, "document", "documents")} · ${WikiArticleCopy.count(written)} written"
    /** A new space's one card (mock 31 ⑥): why it has nothing, over Set up maintenance (`WIKI_NO_DOCUMENTS_NOTE`). */
    const val noDocumentsNote = "This wiki has no documents yet. Maintenance drafts a plan and writes them; it isn’t set up for this space."
    /** A category's documents not written yet, folded into one row under its written ones (`wikiNotWrittenYet`). */
    fun notWrittenYet(n: Int) = "+${WikiArticleCopy.count(n)} not written yet"
    /** A category none of whose documents is written yet, as its one row (`wikiDocsNotWrittenYet`). */
    fun docsNotWrittenYet(n: Int) = "${plural(n, "document", "documents")} · $notWrittenShort"
}
