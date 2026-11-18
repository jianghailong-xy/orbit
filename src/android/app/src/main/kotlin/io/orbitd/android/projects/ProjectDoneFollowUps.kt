package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId

/** The done card's follow-up words — the non-code mark, branchless work, findings grouped by criterion, Move to a follow-up… and
 * criteria met by confirmation (docs/mocks/project-done-landing-untracked ③④, docs/mocks/project-done-followups 01–03). Each is
 * named as the web's constant in src/web/src/lib/projectDone.ts and holds its words byte for byte (`DoneCopyParityTest`). */
@Suppress("ConstPropertyName")
object DoneCopy {
    // The non-code mark (decided board ③ A, board 01): set by the coordinator or the owner, never inferred.
    const val NON_CODE_BADGE = "Non-code"
    const val NON_CODE_LEAD = "Non-code project."
    const val NON_CODE_BODY = "Orbit checks the criteria only, not where work landed."
    const val NON_CODE_PROJECT_LINE = "Non-code project · Orbit checks the criteria only, not where work landed"
    const val NON_CODE_MARKED_BY_COORDINATOR = "Marked by the coordinator"
    const val NON_CODE_MARKED_BY_YOU = "Marked by you"
    const val NON_CODE_CHANGE = "Change"
    const val RUN_DELIVERS = "Delivers"
    const val RUN_DELIVERS_CODE = "Code"
    const val RUN_DELIVERS_CODE_HINT = "Tasks land on a branch, and the done card checks the work reached {main}."
    const val RUN_DELIVERS_NOT_CODE = "Not code"
    const val RUN_DELIVERS_NOT_CODE_HINT = "Documents, accounts, approvals. Orbit checks the criteria only; nothing lands."
    const val RUN_LANDING = "Landing"
    /** web projectStart.ts's: what Landing says while the project is marked non-code. */
    const val RUN_SWITCH_OFF = "Off"
    const val RUN_LANDING_OFF_HINT = "Off for a non-code project: Tasks land on, Delivery, Main branch and Merge check don’t apply. Switch Delivers to Code to bring them back."
    const val RUN_TO_NOT_CODE = "The done card stops reading where work landed. Work already on {branch} stays there."
    const val RUN_TO_CODE = "The done card will check where work landed again. Work that ran without a branch will show as “Ran without a branch”."
    const val RUN_TO_NOT_CODE_TITLE = "Mark as not code?"
    const val RUN_TO_NOT_CODE_ACTION = "Mark as not code"
    const val RUN_TO_CODE_TITLE = "Treat this project as code?"
    const val RUN_TO_CODE_ACTION = "Mark as code"

    // The follow-up details (boards 01 B, 02 G/I, 03 Confirm sheet and stale row).
    const val NON_CODE_REASON = "“{reason}”"
    const val MOVED_OUT_CRITERION = "Criterion {n} moved to"
    const val MOVED_OUT_UNNUMBERED = "A criterion moved to"
    const val MOVED_FROM = "Moved from"
    const val MOVED_BY_YOU = "by you"
    const val CONFIRM_SHEET_SCREENSHOT = "Screenshot"
    const val CONFIRM_SHEET_ATTACH = "Attach a screenshot"
    const val CONFIRM_SHEET_UPLOADING = "Uploading…"
    const val CONFIRM_SHEET_REMOVE = "Remove"
    const val CONFIRM_SHEET_NOT_AN_IMAGE = "Attach an image: a PNG, JPEG, GIF or WebP file."
    const val CONFIRM_SHEET_NOT_UPLOADED = "The screenshot was not uploaded"
    const val CRITERION_SCREENSHOT = "Screenshot"
    const val CRITERION_ONE_SCREENSHOT = "1 screenshot"
    const val CRITERION_SCREENSHOTS = "{n} screenshots"
    const val CRITERION_WHAT_CHANGED = "What changed"
    const val CRITERION_HIDE_CHANGES = "Hide changes"
    const val CRITERION_WORDING_CONFIRMED = "Confirmed · revision {r}"
    const val CRITERION_WORDING_NOW = "Now · revision {r}"
    const val CRITERION_WORDING_NOT_KEPT = "The wording confirmed then was not kept."

    // The done card's findings, grouped by criterion with the unmet ones first (decided board ③ B–D).
    const val DONE_CARD_STANDS_IN_WAY_ONE = "1 thing stands in the way"
    const val DONE_CARD_STANDS_IN_WAY = "{n} things stand in the way"
    const val DONE_CARD_FINDINGS_HEADING_ONE = "Orbit can’t prove 1 thing"
    const val DONE_CHECK_UNMET_OPEN_TASK = "Criterion {n} is not met — 1 task is still open"
    const val DONE_CHECK_UNMET_OPEN_TASKS = "Criterion {n} is not met — {m} tasks are still open"
    const val DONE_CHECK_UNMET_NO_TASK = "Criterion {n} is not met — no task serves it"
    const val DONE_CHECK_UNMET_UNCONFIRMED = "Criterion {n} is not met — it waits for confirmation"
    const val DONE_CHECK_NO_BRANCH = "Criterion {n}: {tasks} ran without a branch, so Orbit can’t see whether their changes reached {main}. Check {main} yourself before recording it done."
    const val DONE_CHECK_ON_PROJECT_BRANCH = "Criterion {n} is on the project branch, not on {main} yet"
    const val DONE_CHECK_IN_FLIGHT = "Criterion {n} is being landed on {main}"
    const val DONE_CHECK_NOTHING_TO_LAND = "Criterion {n} has nothing to land"
    const val DONE_CHECK_CODELESS = "Criterion {n} has no code to land"
    const val DONE_CARD_OPEN = "Open"
    const val DONE_CARD_MOVE_TO_FOLLOW_UP = "Move to a follow-up…"
    const val DONE_CARD_MOVE_HINT = "takes criterion {n} and its open tasks out of this project"
    const val DONE_CARD_ANYWAY_KEEPS = "If you record it done anyway, Orbit keeps {criteria} as the gap you accepted."
    const val DONE_CARD_TALLY_OF = "{met} of {n} met"
    const val DONE_CARD_WAIT_CONFIRMATION = "{n} wait for confirmation"
    const val LANDING_RAN_WITHOUT_BRANCH = "Ran without a branch"
    const val LANDING_NO_CODE_TO_LAND = "No code to land"

    // A criterion met by confirmation (board 03): its mode, who confirmed it, and its Confirm sheet.
    const val CRITERION_MET_BY = "Met by"
    const val CRITERION_MET_BY_TASKS = "its tasks"
    const val CRITERION_MET_BY_CONFIRMATION = "confirmation"
    const val CRITERION_MODE_TASKS = "Its tasks"
    const val CRITERION_MODE_TASKS_HINT = "Met when the work filed under it is done."
    const val CRITERION_MODE_CONFIRMATION = "Confirmation"
    const val CRITERION_MODE_CONFIRMATION_HINT = "Met when you, the coordinator or an Agent check confirms it. For facts outside the code: filings, approvals, accounts."
    const val CRITERION_MODE_NOT_CHANGED = "How this criterion is met was not changed"
    const val CRITERION_CONFIRMED_BY_YOU = "Met · confirmed by you"
    const val CRITERION_CONFIRMED_BY_COORDINATOR = "Met · confirmed by the coordinator"
    const val CRITERION_CHECK_PASSED = "Met · Agent check passed"
    const val CRITERION_CHECK_FAILED = "Not met · Agent check failed"
    const val CRITERION_CHECK_RUNNING = "Checking… · Agent check running"
    const val CRITERION_STALE = "Not met · confirmed for an earlier wording"
    const val CRITERION_STALE_DETAIL = "{who} confirmed revision {r} on {date}. The wording has changed since."
    const val CRITERION_WAITS_CONFIRMATION = "Waits for confirmation"
    const val CRITERION_CHECK_STARTED = "started {ago}"
    const val CRITERION_PASS_NOTE = "PASS — {note}"
    const val CRITERION_FAIL_NOTE = "FAIL — {note}"
    const val CRITERION_WHO_YOU = "You"
    const val CRITERION_WHO_COORDINATOR = "The coordinator"
    const val CRITERION_WHO_CHECK = "An Agent check"
    const val DONE_CHECK_ITS_WORK = "its work"
    const val CRITERION_WITHDRAW = "Withdraw"
    const val CRITERION_VIEW_RUN = "View run"
    const val CRITERION_OPEN_CONVERSATION = "Open conversation"
    const val CRITERION_CONFIRM = "Confirm…"
    const val CRITERION_CONFIRM_AGAIN = "Confirm again…"
    const val CRITERION_RUN_CHECK = "Run an Agent check"
    const val CRITERION_RUN_CHECK_AGAIN = "Run the check again"
    const val CRITERION_ACTION_FAILED = "That did not go through"
    const val CONFIRM_SHEET_TITLE = "Confirm criterion {n}"
    const val CONFIRM_SHEET_HOW_CHECKED = "How it’s checked:"
    const val CONFIRM_SHEET_WHAT_CHECKED = "What did you check?"
    const val CONFIRM_SHEET_OPTIONAL = "optional"
    const val CONFIRM_SHEET_PLACEHOLDER = "e.g. the filing number you saw, and where"
    const val CONFIRM_SHEET_FOOTNOTE = "Your name and the time are kept with it. If the wording of this criterion changes, it goes back to not met until someone confirms it again."
    const val CONFIRM_SHEET_CONFIRM = "Confirm"
    const val CONFIRM_SHEET_CANCEL = "Cancel"
    const val CONFIRM_SHEET_NOT_RECORDED = "The confirmation was not recorded"
    const val DONE_ROW_BY_YOU = "by you"
    const val DONE_ROW_BY_COORDINATOR = "by the coordinator"
    const val DONE_ROW_CHECK_PASS = "Agent check PASS"
    const val DONE_ROW_CHECK_FAILED = "Agent check failed"
    const val DONE_ROW_WAITS = "waits for confirmation"
    const val DONE_ROW_STALE = "confirmed for an earlier wording"
    const val DONE_ROW_CHECKING = "checking…"
    const val DONE_ROW_CONFIRMED_BY_YOU = "Confirmed by you"
    const val DONE_ROW_CONFIRMED_BY_COORDINATOR = "Confirmed by the coordinator"
    const val DONE_ROW_CONFIRMED_BY_CHECK = "Confirmed by an Agent check"
    const val ACCEPTANCE_STANDING_MIXED = "{n} criteria stated. {a} met by their tasks; {b} by a confirmation — from you, the coordinator, or an Agent check."
    const val ACCEPTANCE_NOTE_MIXED = "A criterion met by its tasks is read off the work filed under it. A criterion met by confirmation says who confirmed it, when, and what they checked; it goes back to not met when its wording changes or the confirmation is withdrawn."

    // Move to a follow-up… (board 02 ⑥): one dialog, two steps.
    const val MOVE_TITLE = "Move to a follow-up"
    const val MOVE_MOVES = "Moves"
    const val MOVE_AND_ONE_OPEN_TASK = "and its 1 open task"
    const val MOVE_AND_OPEN_TASKS = "and its {n} open tasks"
    const val MOVE_STAYS = "Stays here: its done and cancelled tasks, as this project’s history."
    const val MOVE_KEEPS = "This project keeps {n} criteria."
    const val MOVE_KEEPS_ALL_MET = "This project keeps {n} criteria, all met."
    const val MOVE_TO = "To"
    const val MOVE_NEW_PROJECT = "New project"
    const val MOVE_EXISTING_PROJECT = "Existing project"
    const val MOVE_FOLLOW_UP_TITLE = "{title} · follow-up"
    const val MOVE_FOLLOW_UP_GOAL = "Follow-up of “{title}”: criterion {n}."
    const val MOVE_NEW_HINT = "It starts not started, in the same workspace, with this criterion and its tasks. You start it when you’re ready."
    const val MOVE_SEARCH = "Search open projects"
    const val MOVE_OPEN_ONLY = "Open projects only."
    const val MOVE_PROJECT_TASKS = "{n} tasks"
    const val MOVE_NO_OPEN_PROJECTS = "No other open project."
    const val MOVE_NEXT = "Next"
    const val MOVE_CANCEL = "Cancel"
    const val MOVE_BACK = "Back"
    const val MOVE_CONFIRM_TITLE = "Move criterion {n} to “{project}”?"
    const val MOVE_CONFIRM_THIS_ALL_MET = "This project keeps {n} criteria, all met. You can record it as done right after."
    const val MOVE_CONFIRM_NEW = "{project} is created, not started, and gets criterion {n} {tasks}."
    const val MOVE_CONFIRM_EXISTING = "{project} gets criterion {n} {tasks}, after its own criteria."
    const val MOVE_CONFIRM_RECORD = "Both projects record the move: who moved it and when. Nothing is deleted."
    const val MOVE_CONFIRM_ACTION = "Move criterion {n}"
    const val MOVE_NOT_MOVED = "The criterion was not moved"
}

/** What the cards decide from those words — web's projectDone.ts helpers of the same names, over the same reads. */
object DoneFollowUps {
    private fun countOf(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"

    /** `isNonCode`: the mark on the project, or on its derived read. A marked project reads no landing at all. */
    fun nonCode(doc: JsonObject) = doc.flag("nonCode") || doc.obj("derivedDone")?.flag("nonCode") == true

    /** `nonCodeProvenance`: "Marked by the coordinator · Nov 11" — or null for an unmarked project. */
    fun provenance(doc: JsonObject, format: (String?) -> String? = { ProjectDone.date(it) }): String? {
        if (!doc.flag("nonCode")) return null
        val who = if (doc.text("nonCodeSetBy") == "COORDINATOR") DoneCopy.NON_CODE_MARKED_BY_COORDINATOR else DoneCopy.NON_CODE_MARKED_BY_YOU
        return format(doc.text("nonCodeSetAt"))?.let { "$who · $it" } ?: who
    }
    /** `nonCodeReasonLine`: the mark's reason, quoted — or null when unmarked or none was given. */
    fun reasonLine(doc: JsonObject): String? {
        val reason = doc.text("nonCodeReason")?.trim()
        return if (doc.flag("nonCode") && !reason.isNullOrEmpty()) DoneCopy.NON_CODE_REASON.replace("{reason}", reason) else null
    }

    /** `movedOutLead`: "Criterion 4 moved to" — the words before the destination's linked name. */
    fun movedOutLead(moved: JsonObject) = moved.number("ordinal")?.takeIf { it > 0 }?.let { DoneCopy.MOVED_OUT_CRITERION.replace("{n}", "$it") }
        ?: DoneCopy.MOVED_OUT_UNNUMBERED
    /** `movedByLine`: "by you · Nov 11, 19:40". */
    fun movedBy(movedAt: String?, format: (String?) -> String? = { ProjectDone.dateTime(it) }) =
        format(movedAt)?.let { "${DoneCopy.MOVED_BY_YOU} · $it" } ?: DoneCopy.MOVED_BY_YOU
    /** `screenshotCount`: "1 screenshot", "2 screenshots" — or null for none. */
    fun screenshotCount(count: Int) = when { count <= 0 -> null; count == 1 -> DoneCopy.CRITERION_ONE_SCREENSHOT
        else -> DoneCopy.CRITERION_SCREENSHOTS.replace("{n}", "$count") }
    /** `criteriaPhrase`: "criterion 4", "criteria 3 and 4", "criteria 2, 3 and 4". */
    fun criteriaPhrase(ordinals: List<Int>) = if (ordinals.size == 1) "criterion ${ordinals[0]}"
        else "criteria ${ordinals.dropLast(1).joinToString(", ")} and ${ordinals.last()}"

    /** How a criterion is met: by its tasks (the default) or by confirmation. */
    fun byConfirmation(criterion: JsonObject?) = criterion?.text("satisfiedBy") == "CONFIRMATION"
    /** The derived criterion a finding names, by the key `project_get` gives it. */
    fun derivedFor(doc: JsonObject, key: String?): JsonObject? {
        val item = key?.let { ProjectDone.criterion(doc, it) } ?: return null
        return doc.obj("derivedDone")?.objects("criteria")?.firstOrNull { it.text("definitionId") == item.text("id") }
    }
    /** Whether the criterion a finding names is met by confirmation: then no task holds it. */
    fun findingByConfirmation(doc: JsonObject, finding: JsonObject): Boolean {
        val key = finding.obj("criterion")?.text("key")
        return byConfirmation(derivedFor(doc, key)) || byConfirmation(key?.let { ProjectDone.criterion(doc, it) })
    }
    /** How many criteria met by confirmation still wait for one. */
    fun waitingConfirmation(doc: JsonObject) = doc.obj("derivedDone")?.objects("criteria").orEmpty().count { byConfirmation(it) && !it.flag("satisfied") }

    /** `unlandedLine`: why one criterion is not on main, in the words of the reason the check found — only work Orbit saw no
     * merge of reads "not on main". */
    fun unlandedLine(finding: JsonObject, ordinal: String, main: String): String {
        fun fill(words: String) = words.replace("{n}", ordinal).replace("{main}", main)
        return when (finding.text("reason")) {
            "NO_BRANCH" -> fill(DoneCopy.DONE_CHECK_NO_BRANCH).replace("{tasks}", finding.objects("tasks").size.let {
                if (it > 0) countOf(it, "task", "tasks") else DoneCopy.DONE_CHECK_ITS_WORK })
            "ON_PROJECT_BRANCH" -> fill(DoneCopy.DONE_CHECK_ON_PROJECT_BRANCH)
            "IN_FLIGHT" -> fill(DoneCopy.DONE_CHECK_IN_FLIGHT)
            "NOTHING_TO_LAND" -> fill(DoneCopy.DONE_CHECK_NOTHING_TO_LAND)
            "CODELESS" -> fill(DoneCopy.DONE_CHECK_CODELESS)
            else -> fill(ProjectDone.checkUnlanded)
        }
    }
    /** `unmetLine`: what holds an unmet criterion — its open tasks, no task at all, or the confirmation it waits for. */
    fun unmetLine(finding: JsonObject, ordinal: String, confirmation: Boolean): String {
        val tasks = finding.objects("tasks").size
        return when {
            confirmation -> DoneCopy.DONE_CHECK_UNMET_UNCONFIRMED.replace("{n}", ordinal)
            tasks == 0 -> DoneCopy.DONE_CHECK_UNMET_NO_TASK.replace("{n}", ordinal)
            tasks == 1 -> DoneCopy.DONE_CHECK_UNMET_OPEN_TASK.replace("{n}", ordinal)
            else -> DoneCopy.DONE_CHECK_UNMET_OPEN_TASKS.replace("{n}", ordinal).replace("{m}", "$tasks")
        }
    }

    /** The done check's findings as the card groups them (decided board ③ B–D): the unmet criteria by ordinal, then the other
     * refusals — together what stands in the way — and apart from them the warnings about where work landed. */
    data class Findings(val unmet: List<JsonObject>, val otherRefusals: List<JsonObject>, val warnings: List<JsonObject>) {
        val blocking get() = unmet + otherRefusals
    }
    fun group(findings: List<JsonObject>) = Findings(
        findings.filter { it.text("code") == "DONE_CRITERION_UNSATISFIED" }.sortedBy { it.obj("criterion")?.number("ordinal") ?: 0 },
        findings.filter { it.text("severity") == "REFUSE" && it.text("code") != "DONE_CRITERION_UNSATISFIED" },
        findings.filter { it.text("severity") == "WARN" })
    fun standsInWay(n: Int) = if (n == 1) DoneCopy.DONE_CARD_STANDS_IN_WAY_ONE else DoneCopy.DONE_CARD_STANDS_IN_WAY.replace("{n}", "$n")
    fun cantProve(n: Int) = if (n == 1) DoneCopy.DONE_CARD_FINDINGS_HEADING_ONE else ProjectDone.findingsHeading.replace("{n}", "$n")
    /** What Record as done anyway keeps: the unmet criteria by number — or, with none, the gaps line. */
    fun anywayKeeps(groups: Findings) = if (groups.unmet.isEmpty()) ProjectDone.findingsAccepted
        else DoneCopy.DONE_CARD_ANYWAY_KEEPS.replace("{criteria}", criteriaPhrase(groups.unmet.map { it.obj("criterion")?.number("ordinal") ?: 0 }))
    fun moveHint(ordinal: Int?) = DoneCopy.DONE_CARD_MOVE_HINT.replace("{n}", "${ordinal ?: ""}")

    /** `doneCriterionRowState`: met or not, then who confirmed a criterion met by confirmation, or where a met criterion's work is
     * in a project that reads landing. An unmet criterion met by its tasks is "not met" and nothing more. [warn] draws it yellow. */
    data class RowState(val text: String, val warn: Boolean)
    fun rowState(criterion: JsonObject, nonCode: Boolean, main: String): RowState {
        val satisfied = criterion.flag("satisfied")
        val met = if (satisfied) "met" else ProjectDone.notMet
        if (byConfirmation(criterion)) {
            val standing = criterion.obj("confirmation")
            if (satisfied) {
                val by = when (standing?.obj("current")?.text("confirmerKind")) {
                    "COORDINATOR" -> DoneCopy.DONE_ROW_BY_COORDINATOR; "AGENT_CHECK" -> DoneCopy.DONE_ROW_CHECK_PASS; else -> DoneCopy.DONE_ROW_BY_YOU }
                return RowState("$met · $by", false)
            }
            val why = when {
                standing?.obj("checkRunning") != null -> DoneCopy.DONE_ROW_CHECKING
                standing?.text("state") == "CHECK_FAILED" -> DoneCopy.DONE_ROW_CHECK_FAILED
                standing?.text("state") == "STALE" -> DoneCopy.DONE_ROW_STALE
                else -> DoneCopy.DONE_ROW_WAITS
            }
            return RowState("$met · $why", standing?.text("state") == "STALE")
        }
        if (!satisfied || nonCode) return RowState(met, false)
        return RowState("$met · ${ProjectDone.landingReasonLabel(criterion.text("landingReason"), main)}", criterion.text("landingReason") == "NO_BRANCH")
    }
    /** `confirmationLine`: who confirmed it, when, what they said, and how many screenshots. */
    fun confirmationLine(view: JsonObject?, zone: ZoneId = ZoneId.systemDefault()): String? {
        view ?: return null
        val who = when (view.text("confirmerKind")) { "COORDINATOR" -> DoneCopy.DONE_ROW_CONFIRMED_BY_COORDINATOR
            "AGENT_CHECK" -> DoneCopy.DONE_ROW_CONFIRMED_BY_CHECK; else -> DoneCopy.DONE_ROW_CONFIRMED_BY_YOU }
        return listOfNotNull(who, ProjectDone.date(view.text("at"), zone), view.text("note")?.takeIf { it.isNotEmpty() }?.let { "“$it”" },
            screenshotCount(view.strings("attachmentIds").size)).joinToString(" · ")
    }

    /** One criterion met by confirmation on the criteria card (board 03 ⑤): its state sentence, whether it is met, what was said
     * under it, when, the run or conversation it links to, and the confirmation of an earlier wording What changed compares. */
    data class ConfirmationWork(val sentence: String, val met: Boolean, val failed: Boolean, val stale: JsonObject?, val note: String?,
        val whenText: String?, val runSessionId: String?, val conversationId: String?, val running: Boolean, val state: String, val shots: List<String>)
    fun confirmationWork(item: JsonObject, now: Instant, zone: ZoneId = ZoneId.systemDefault()): ConfirmationWork {
        val standing = item.obj("confirmation")
        val current = standing?.obj("current")
        val running = standing?.obj("checkRunning")
        val state = standing?.text("state") ?: "UNCONFIRMED"
        var met = false
        val note: String?
        val sentence = when {
            state == "CONFIRMED" && current != null -> {
                met = true
                val said = current.text("note")?.takeIf { it.isNotEmpty() }
                note = if (current.text("confirmerKind") == "AGENT_CHECK") said?.let { DoneCopy.CRITERION_PASS_NOTE.replace("{note}", it) } else said?.let { "“$it”" }
                when (current.text("confirmerKind")) { "COORDINATOR" -> DoneCopy.CRITERION_CONFIRMED_BY_COORDINATOR
                    "AGENT_CHECK" -> DoneCopy.CRITERION_CHECK_PASSED; else -> DoneCopy.CRITERION_CONFIRMED_BY_YOU }
            }
            state == "CHECK_FAILED" && current != null -> {
                note = current.text("note")?.takeIf { it.isNotEmpty() }?.let { DoneCopy.CRITERION_FAIL_NOTE.replace("{note}", it) }
                DoneCopy.CRITERION_CHECK_FAILED
            }
            state == "STALE" && current != null -> {
                val who = when (current.text("confirmerKind")) { "OWNER" -> DoneCopy.CRITERION_WHO_YOU; "COORDINATOR" -> DoneCopy.CRITERION_WHO_COORDINATOR
                    else -> DoneCopy.CRITERION_WHO_CHECK }
                note = DoneCopy.CRITERION_STALE_DETAIL.replace("{who}", who).replace("{r}", "${current.number("revision") ?: ""}")
                    .replace("{date}", ProjectDone.date(current.text("at"), zone).orEmpty())
                DoneCopy.CRITERION_STALE
            }
            else -> { note = null; if (running != null) DoneCopy.CRITERION_CHECK_RUNNING else DoneCopy.CRITERION_WAITS_CONFIRMATION }
        }
        val shown = if (running != null && state != "CONFIRMED") running else current
        val whenText = shown?.let {
            if (it === running) ProjectTime.parse(it.text("at"))?.let { at -> ProjectTime.between(at, now).let { s ->
                DoneCopy.CRITERION_CHECK_STARTED.replace("{ago}", if (s < 10) "just now" else "${ProjectTime.span(s)} ago") } }
            else ProjectDone.dateTime(it.text("at"), zone)
        }
        val session = shown?.text("sessionId")
        return ConfirmationWork(sentence, met, state == "CHECK_FAILED", if (state == "STALE") current else null, note, whenText,
            session.takeIf { shown?.text("confirmerKind") == "AGENT_CHECK" }, session.takeIf { shown?.text("confirmerKind") == "COORDINATOR" },
            running != null, state, if (state == "CONFIRMED" || state == "CHECK_FAILED") current?.strings("attachmentIds").orEmpty() else emptyList())
    }

    /** The criteria card's standing line once some criterion is met by confirmation (`ACCEPTANCE_STANDING_MIXED`); null keeps
     * the line it had. */
    fun standingMixed(items: List<JsonObject>): String? {
        val confirmed = items.count { byConfirmation(it) }
        if (confirmed == 0) return null
        return DoneCopy.ACCEPTANCE_STANDING_MIXED.replace("{n}", "${items.size}").replace("{a}", "${items.size - confirmed}").replace("{b}", "$confirmed")
    }

    /** The criterion Move to a follow-up… takes, and what the dialog says about the rest (`MoveCriterionSubject`). */
    data class MoveSubject(val projectId: String, val projectTitle: String, val criterionKey: String, val ordinal: Int, val text: String,
        val openTasks: List<JsonObject>, val keeps: Int, val keepsAllMet: Boolean)
    fun moveSubject(doc: JsonObject, finding: JsonObject): MoveSubject? {
        val criterion = finding.obj("criterion") ?: return null
        val key = criterion.text("key") ?: return null
        val item = ProjectDone.criterion(doc, key)
        val others = doc.obj("derivedDone")?.objects("criteria").orEmpty().filter { it.text("definitionId") != item?.text("id") }
        return MoveSubject(doc.text("id").orEmpty(), doc.text("title").orEmpty(), key, criterion.number("ordinal") ?: 0,
            criterion.text("text").orEmpty(), finding.objects("tasks"), others.size, others.all { it.flag("satisfied") })
    }
    fun moveTasksPhrase(n: Int) = if (n == 1) DoneCopy.MOVE_AND_ONE_OPEN_TASK else DoneCopy.MOVE_AND_OPEN_TASKS.replace("{n}", "$n")
    fun moveKeeps(subject: MoveSubject) = (if (subject.keepsAllMet) DoneCopy.MOVE_KEEPS_ALL_MET else DoneCopy.MOVE_KEEPS).replace("{n}", "${subject.keeps}")
    fun moveConfirmThis(subject: MoveSubject) = (if (subject.keepsAllMet) DoneCopy.MOVE_CONFIRM_THIS_ALL_MET else DoneCopy.MOVE_KEEPS).replace("{n}", "${subject.keeps}")
    /** The second step's sentence about the destination; the open tasks' phrase drops out when none move. */
    fun moveConfirmThere(subject: MoveSubject, newProject: Boolean, destination: String) =
        (if (newProject) DoneCopy.MOVE_CONFIRM_NEW else DoneCopy.MOVE_CONFIRM_EXISTING).replace("{project}", destination).replace("{n}", "${subject.ordinal}")
            .replace("{tasks}", if (subject.openTasks.isNotEmpty()) moveTasksPhrase(subject.openTasks.size) else "").replace(" ,", ",").replace(" .", ".")
    fun moveBody(subject: MoveSubject, newProject: Boolean, title: String, toProjectId: String?) = buildJsonObject {
        if (newProject) putJsonObject("newProject") {
            put("title", title.trim())
            put("goal", DoneCopy.MOVE_FOLLOW_UP_GOAL.replace("{title}", subject.projectTitle).replace("{n}", "${subject.ordinal}"))
        } else put("toProjectId", toProjectId)
    }
    /** The projects a criterion may move to: open ones other than its own, matching the search. */
    fun moveCandidates(projects: List<JsonObject>, self: String, search: String) = projects
        .filter { it.text("status") == "OPEN" && it.text("id") != self }
        .filter { it.text("title").orEmpty().lowercase().contains(search.trim().lowercase()) }

    /** The body a change of one criterion's mode sends: the whole set restated, that one criterion's `satisfiedBy` changed. */
    fun modeBody(items: List<JsonObject>, id: String, mode: String) = buildJsonObject {
        putJsonArray("acceptanceCriteriaItems") {
            items.sortedBy { it.number("ordinal") ?: 0 }.forEach { item -> addJsonObject {
                put("id", item.text("id"))
                put("text", item.text("text").orEmpty())
                put("verificationMethod", item.text("verificationMethod").orEmpty())
                item.text("completionCriterionOverrideReason")?.takeIf { it.isNotEmpty() }?.let { put("completionCriterionOverrideReason", it) }
                put("satisfiedBy", if (item.text("id") == id) mode else item.text("satisfiedBy") ?: "TASKS")
            } }
        }
    }
    /** The Confirm sheet's body: the note if any, the revision read, and the one screenshot. */
    fun confirmBody(note: String, revision: Int?, attachmentId: String?) = buildJsonObject {
        note.trim().takeIf { it.isNotEmpty() }?.let { put("note", it) }
        revision?.takeIf { it > 0 }?.let { put("revision", it) }
        attachmentId?.let { putJsonArray("attachmentIds") { add(it) } }
    }
}
