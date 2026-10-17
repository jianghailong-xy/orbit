package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The owner records a project done at `POST /projects/:id/done` — bound to the seal they read, answering the coordinator's
 * DONE_REQUEST when there is one, and leaving an OWNER record a later check does not undo — or answers the request "Not yet…"
 * at `POST /projects/:id/done-requests/:itemId/decline`. Ported from OrbitKit `ProjectDone.swift` on main (7c9d0ceec and the
 * fixes after it: 84d546a21, 63f5e83c6, e0a942b89, 33a94300f, 21090b959): the words, the gaps an unasked card carries, the body
 * a press sends, the receipt, the rows the page shows and which card a coordinator conversation draws. Every number is the
 * server's (`derivedDone.counts`). */
object ProjectDone {
    // The card's words, as main's ProjectDone.swift declares them.
    const val heading = "Is this project done?"
    const val coordinatorCall = "Coordinator’s call"
    const val doneWhen = "Done when"
    const val whatOrbitCantProve = "What Orbit can’t prove"
    const val coordinatorChecked = "Coordinator checked"
    const val orbitChecked = "Orbit checked"
    const val recordAsDone = "Record as done"
    const val recordAsDoneAnyway = "Record as done anyway"
    const val notYet = "Not yet…"
    const val missingBeforeDone = "What’s missing before it’s done?"
    const val receipt = "You recorded this project done"
    const val gapsAccepted = "gaps accepted"
    const val seeWhatAccepted = "See what you accepted"
    const val reopenProject = "Reopen project"
    const val recordingExplanation = "Recording it done is yours. Orbit keeps your record — a later check won’t reopen the project " +
        "unless the criteria change or one of their tasks is reopened."
    const val notYetHint = "Sends your note and this card’s facts to the coordinator. The card closes; it asks again " +
        "when it has more."
    const val askedByCoordinator = "asked by the coordinator"
    const val showAll = "Show all"
    const val showLess = "Show less"
    const val sendToCoordinator = "Send to coordinator"
    const val back = "Back"
    const val thisProjectIsDone = "This project is done"
    const val onMain = "on main"
    const val onProjectBranch = "On the project branch"
    const val mergedOutsideOrbit = "Merged outside Orbit"
    const val nothingToLand = "nothing to land"
    const val notMet = "not met"
    const val recordedByYou = "recorded by you"
    const val recordedByOrbit = "recorded by Orbit"
    const val readyToClose = "Ready to close"
    const val coordinatorAsked = "The coordinator asked"
    const val gapsItCouldntProve = "gaps it couldn’t prove"
    const val notAskedYet = "not asked yet"
    const val recordAsDoneRow = "Record as done…"
    const val noRequestMeta = "record as done anyway"
    const val landedOnMain = "landed on main"
    /** [onMain] and [landedOnMain], said of the project's main branch (web's `whyNotDoneOn`, `landedOn`). */
    fun on(main: String) = "on $main"
    fun landedOn(main: String) = "landed on $main"
    /** The branch the cards name where work landed: the project document's `integration.upstreamRef`, main when it says none. */
    fun mainBranch(doc: JsonObject) = RunSettings.mainBranchName(doc.obj("integration")?.text("upstreamRef"))
    /** The cards' provenance badge. */
    const val provenanceBadge = "FROM ORBIT"
    const val noGaps = "Orbit has no gaps to report."
    /** What a press the door did not take says, over the door's own message — and the two presses beside it. */
    const val notRecorded = "Project was not recorded done"
    const val notDeclined = "That answer was not sent"
    const val notReopened = "The project was not reopened"

    private fun JsonObject.n(key: String) = number(key) ?: 0

    /** The projection's counts; a server without the owner's done door sends none (web's `hasDoneGate`), and no card is drawn then. */
    fun counts(doc: JsonObject): JsonObject? = doc.obj("derivedDone")?.obj("counts")
    fun hasDoneDoor(doc: JsonObject) = counts(doc) != null

    /** Whether a project's sessions page draws its ending where the progress card was (docs/mocks/project-done-sessions-page, owner
     * decision 2026-10-10): DONE, with the projection's counts to tally. The same card, and the same rule, the conversation's settled
     * branch keeps — and a read without the counts (a server before the owner's done door) keeps the progress card, which in that
     * state says its status and nothing else. */
    fun drawsEnding(doc: JsonObject?) = doc != null && ProjectDoc.status(doc) == "DONE" && counts(doc) != null
    fun showAll(count: Int) = "$showAll $count"

    // The counts, in words.
    private val reasonOrder = listOf("IN_FLIGHT", "ON_PROJECT_BRANCH", "NO_RECEIPT", "NOTHING_TO_LAND", "CODELESS")
    /** A reason as a tally says it (`REASON_LABELS`). */
    fun reasonLabel(reason: String) = when (reason) {
        "IN_FLIGHT" -> "in flight"; "ON_PROJECT_BRANCH" -> "on the project branch"; "NOTHING_TO_LAND" -> nothingToLand
        "NO_RECEIPT" -> "merged outside Orbit"; "CODELESS" -> "no code to land"; else -> reason
    }
    private fun reasonParts(counted: (String) -> Int) = reasonOrder.mapNotNull { reason -> counted(reason).takeIf { it > 0 }?.let { "$it ${reasonLabel(reason)}" } }
    /** CODELESS says the same thing to a reader as a zero-commit task: there is nothing to land. */
    private fun nothingToLandCount(counts: JsonObject) = counts.obj("byReason").let { (it?.number("NOTHING_TO_LAND") ?: 0) + (it?.number("CODELESS") ?: 0) }
    /** `projectDoneCardTally`: the request card's three counts — its head already says how many criteria there are. */
    fun cardTally(counts: JsonObject?, main: String = RunSettings.defaultMainBranch) =
        counts?.let { "${it.n("met")} met · ${it.n("onMain")} ${landedOn(main)} · ${nothingToLandCount(it)} $nothingToLand" }.orEmpty()
    /** `projectDoneReceiptTally`: how many were met, then the same three, then what was accepted. */
    fun receiptTally(counts: JsonObject?, acceptedGaps: Int, main: String = RunSettings.defaultMainBranch) = if (counts == null) "$acceptedGaps $gapsAccepted"
        else "${counts.n("criteria")} criteria met · ${counts.n("onMain")} ${landedOn(main)} · ${nothingToLandCount(counts)} $nothingToLand · $acceptedGaps $gapsAccepted"
    /** `projectWhyNotDoneTally`: the criteria, then where each one stands, in parts that add up to them — a met criterion where its
     * work is, an unmet one as not met and never by its landing lane: "8 criteria · 2 on main · 6 not met". */
    fun whyNotDoneTally(doc: JsonObject): String {
        val criteria = doc.obj("derivedDone")?.objects("criteria") ?: return ""
        val met = criteria.filter { it.flag("satisfied") }
        val parts = listOf("${criteria.size} criteria", "${met.count { it.text("landingReason") == null }} ${on(mainBranch(doc))}") +
            reasonParts { reason -> met.count { it.text("landingReason") == reason } }
        return (parts + listOfNotNull((criteria.size - met.size).takeIf { it > 0 }?.let { "$it $notMet" })).joinToString(" · ")
    }

    /** `landingReasonLabel`: one criterion's reason, as a row says it. Null is on the project's main branch, [main]. */
    fun landingReasonLabel(reason: String?, main: String = RunSettings.defaultMainBranch) = when (reason) {
        "IN_FLIGHT" -> "In flight"
        "ON_PROJECT_BRANCH" -> onProjectBranch
        "NO_RECEIPT" -> mergedOutsideOrbit
        "NOTHING_TO_LAND" -> nothingToLand
        "CODELESS" -> "No code to land"
        else -> "Landed on $main"
    }

    /** One criterion of the projection beside the words the document states it in. */
    data class Criterion(val key: String, val ordinal: Int?, val text: String, val satisfied: Boolean, val landingReason: String?)
    fun criteria(doc: JsonObject): List<Criterion> = doc.obj("derivedDone")?.objects("criteria").orEmpty().map { c ->
        val id = c.text("definitionId").orEmpty()
        val item = criterion(doc, id)
        Criterion(item?.text("key") ?: item?.text("id") ?: id, item?.number("ordinal"), item?.text("text") ?: id, c.flag("satisfied"), c.text("landingReason"))
    }
    /** The criterion a gap or an answer names — by its id or by its key. */
    fun criterion(doc: JsonObject, key: String) = doc.objects("acceptanceCriteriaItems").firstOrNull { it.text("id") == key || it.text("key") == key }
    fun criterionState(c: Criterion, main: String = RunSettings.defaultMainBranch) = "${if (c.satisfied) "met" else "not met"} · ${landingReasonLabel(c.landingReason, main)}"

    /** `syntheticGaps`: the gaps a card nobody asked for carries — every criterion not met, or not on main for a reason that is a gap
     * (nothing to land and no code to land are outcomes, not gaps). */
    fun syntheticGaps(doc: JsonObject): List<JsonObject> = criteria(doc).filter { c ->
        (c.landingReason != null && c.landingReason != "NOTHING_TO_LAND" && c.landingReason != "CODELESS") || !c.satisfied
    }.map { c ->
        val main = mainBranch(doc)
        buildJsonObject {
            put("criterionKey", c.key)
            put("title", c.text)
            put("whyNotProven", if (c.satisfied) "Orbit cannot prove this criterion is on $main: ${landingReasonLabel(c.landingReason, main)}."
                else "Orbit cannot prove this criterion is met by its work yet.")
        }
    }
    /** The gaps the card shows: the request's, or the ones Orbit fills in when nobody asked. */
    fun gaps(doc: JsonObject, request: JsonObject?): List<JsonObject> = request?.objects("gaps") ?: syntheticGaps(doc)

    /** The body a press sends: the request it answers (or null), the seal — the request's own, or the one standing now when nobody
     * asked — and the gaps the card showed. Null when no seal could be read: no press then. */
    fun body(doc: JsonObject, requestId: String?, request: JsonObject?, currentDigest: String?): JsonObject? {
        val digest = request?.text("criteriaDigest") ?: currentDigest ?: return null
        return buildJsonObject {
            put("requestId", requestId?.let(::JsonPrimitive) ?: JsonNull)
            put("criteriaDigest", digest)
            put("acceptedGaps", JsonArray(gaps(doc, request)))
        }
    }
    /** The note "Not yet…" sends, or null while there is nothing in it. */
    fun declineNote(text: String) = text.trim().ifEmpty { null }

    /** The request this project is asked about now: its open DONE_REQUEST with a readable payload, while OPEN. */
    fun live(openItems: JsonObject?, status: String?): JsonObject? =
        if (status != "OPEN") null else openItems?.obj("doneRequest")?.takeIf { it.obj("doneRequest") != null }
    fun readyToClose(status: String?, openItems: JsonObject?) = live(openItems, status) != null
    /** "The coordinator asked · 2 gaps it couldn’t prove". */
    fun requestRowDetail(row: JsonObject): String {
        val request = row.obj("doneRequest") ?: return row.text("detailLine").orEmpty()
        return "$coordinatorAsked · ${request.objects("gaps").size} $gapsItCouldntProve"
    }

    /** The done row in Open items: the coordinator's request, the owner's own Record as done…, or nothing (an older server without
     * the projection keeps the status door it had). */
    sealed interface PageRow { data class Asked(val row: JsonObject) : PageRow; data object Own : PageRow }
    fun pageRow(doc: JsonObject, openItems: JsonObject?): PageRow? {
        if (ProjectDoc.status(doc) != "OPEN" || !hasDoneDoor(doc) || openItems == null) return null
        return live(openItems, "OPEN")?.let { PageRow.Asked(it) } ?: PageRow.Own
    }

    fun doneWhenHead(count: Int) = "$doneWhen · $count criteria"
    fun gapsHead(count: Int) = "$whatOrbitCantProve · $count"
    /** How long the coordinator's request has waited, from its own `waitingSince`: "waiting 25m". Null for an instant this build
     * cannot read. */
    fun requestWaiting(waitingSince: String?, now: Instant): String? = ProjectTime.parse(waitingSince)?.let { "waiting ${ProjectTime.span(ProjectTime.between(it, now))}" }
    /** The card's meta line: which project, and who asked and how long it has waited — or that nobody asked:
     * "Aurora · asked by the coordinator · waiting 25m". */
    fun meta(projectTitle: String, asked: Boolean, waiting: String?) =
        if (!asked) "$projectTitle · $noRequestMeta" else (listOf(projectTitle, askedByCoordinator) + listOfNotNull(waiting)).joinToString(" · ")
    /** What the record press says: anyway while some criterion is not met. */
    fun recordLabel(counts: JsonObject?) = if (counts != null && counts.n("met") < counts.n("criteria")) recordAsDoneAnyway else recordAsDone
    /** What the coordinator checked for a gap, and where the evidence is. */
    fun checkedLine(gap: JsonObject): String? {
        val checked = gap.text("coordinatorChecked") ?: return null
        val refs = gap.strings("evidenceRefs")
        return if (refs.isEmpty()) checked else "$checked · evidence ${refs.joinToString(", ")}"
    }
    /** How many items the Orbit checked line counts as open (`orbitCheckedOpenItemCount`): every row the read holds — the owner's,
     * the coordinator's, and the START_REQUEST kept beside them — except the DONE_REQUEST the card is itself reviewing. The close
     * check refuses a request while any other item is open, so a card the coordinator asked for says "no open items". */
    fun openItemsCount(items: JsonObject?): Int {
        if (items == null) return 0
        val reviewing = items.obj("doneRequest")?.text("itemId")
        return (items.objects("needsYou") + items.objects("withCoordinator") + listOfNotNull(items.obj("startRequest")))
            .count { reviewing == null || it.text("itemId") != reviewing }
    }
    fun runningCount(doc: JsonObject) = counts(doc)?.obj("byReason")?.n("IN_FLIGHT") ?: 0
    /** `orbitCheckedText`: whether every criterion is met, what is running, what is open, and when the owner confirmed the criteria. */
    fun orbitCheckedLine(counts: JsonObject?, confirmedAt: String?, openItems: Int, running: Int, zone: ZoneId = ZoneId.systemDefault()): String {
        val allMet = counts != null && counts.n("met") == counts.n("criteria")
        val lead = if (allMet) "every criterion is met by its work" else "${counts?.n("met") ?: 0} of ${counts?.n("criteria") ?: 0} criteria are met by their work"
        val runningWords = if (running == 0) "nothing running" else "$running item${if (running == 1) "" else "s"} running"
        val open = if (openItems == 0) "no open items" else "$openItems open item${if (openItems == 1) "" else "s"}"
        var line = "$orbitChecked: $lead · $runningWords · $open"
        date(confirmedAt, zone)?.let { line += " · criteria confirmed by you on $it" }
        return line
    }

    // The receipt. `record` is what a press here recorded (the done door's answer), before the reads catch up with it.
    /** Whether the project is recorded done right now, which is when the card is its receipt: its status says DONE, or a press here
     * has just recorded it and the read has not caught up. Not who recorded it once: `doneBy` outlives a reopen. */
    fun recorded(doc: JsonObject, record: JsonObject?) = ProjectDoc.status(doc) == "DONE" || record != null
    /** Whether the owner recorded it — what the receipt line says it in. */
    fun ownerRecorded(doc: JsonObject, record: JsonObject?) = record != null || doc.text("doneBy") == "OWNER"
    /** The gaps the record accepted. */
    fun accepted(doc: JsonObject, record: JsonObject?): List<JsonObject> = record?.objects("acceptedGaps") ?: doc.objects("acceptedGaps")
    private fun doneBy(doc: JsonObject, record: JsonObject?) = if (record != null) record.text("doneBy") ?: "OWNER" else doc.text("doneBy")
    private fun doneAt(doc: JsonObject, record: JsonObject?) = if (record != null) record.text("doneAt").orEmpty() else doc.text("doneAt")
    /** "Project · recorded by you · 2 gaps accepted · Oct 1". */
    fun receiptMeta(doc: JsonObject, record: JsonObject?, zone: ZoneId = ZoneId.systemDefault()) =
        "${doc.text("title").orEmpty()} · ${provenance(doneBy(doc, record), accepted(doc, record).size)}" + (date(doneAt(doc, record), zone)?.let { " · $it" } ?: "")
    /** "You recorded this project done · Oct 1, 01:40", or Orbit's. */
    fun receiptLine(doc: JsonObject, record: JsonObject?, zone: ZoneId = ZoneId.systemDefault()): String {
        if (!ownerRecorded(doc, record)) return "$thisProjectIsDone · $recordedByOrbit"
        return receipt + (dateTime(doneAt(doc, record), zone)?.let { " · $it" } ?: "")
    }
    fun receiptTally(doc: JsonObject, record: JsonObject?) = receiptTally(counts(doc), accepted(doc, record).size, mainBranch(doc))

    /** `doneProvenance`: who recorded it. */
    fun provenance(doneBy: String?, acceptedGaps: Int) = if (doneBy == "OWNER") "$recordedByYou · $acceptedGaps $gapsAccepted" else recordedByOrbit
    /** The settled card's badge: who recorded it. */
    fun settledBadge(doneBy: String?) = if (doneBy == "OWNER") recordedByYou else recordedByOrbit
    /** "Oct 1", in the reader's own time zone (`formatDoneDate`). */
    fun date(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String? =
        ProjectTime.parse(iso)?.atZone(zone)?.let { DateTimeFormatter.ofPattern("MMM d", Locale.US).format(it) }
    /** "Oct 1, 01:40" (`formatDoneDateTime`). */
    fun dateTime(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String? =
        ProjectTime.parse(iso)?.atZone(zone)?.let { DateTimeFormatter.ofPattern("MMM d, HH:mm", Locale.US).format(it) }

    /** The one closing card a coordinator conversation draws for its project (`ProjectDone.slot`, web's
     * `SessionProjectSettlementCard`): nothing — a read that has not answered, a server whose projection carries no counts, or a
     * project nobody has asked about and nothing has recorded; "Is this project done?" while the coordinator's request stands, the
     * row says Record as done… or a press here recorded it — or its receipt once it is recorded; and, for a DONE Orbit recorded
     * itself, the old question's terminal state, "This project is done · recorded by Orbit". Nothing asks "Why is this project not
     * done?" in a conversation (21090b959). */
    sealed interface Slot { data object None : Slot; data object NotDone : Slot; data class Done(val requestId: String?) : Slot }
    fun slot(doc: JsonObject?, request: JsonObject?, waitingKind: String?, record: JsonObject?): Slot {
        if (doc == null || counts(doc) == null) return Slot.None
        if (request != null || waitingKind == "RECORD_AS_DONE" || record != null) return Slot.Done(request?.text("itemId"))
        if (ProjectDoc.status(doc) == "DONE") return if (doc.text("doneBy") == "OWNER") Slot.Done(null) else Slot.NotDone
        return Slot.None
    }
}
