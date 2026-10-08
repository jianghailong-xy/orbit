package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** The owner records a project done at `POST /projects/:id/done` — bound to the seal they read, answering
 * the coordinator's DONE_REQUEST when there is one, and leaving an OWNER record a later check does not
 * undo. Ported from OrbitKit `ProjectDone.swift` (main 7c9d0ceec, the web's `lib/projectDone.ts`): the
 * words, the gaps an unasked card carries, the body a press sends, and the rows the page shows. */
object ProjectDone {
    const val heading = "Is this project done?"
    const val doneWhen = "Done when"
    const val whatOrbitCantProve = "What Orbit can’t prove"
    const val coordinatorCall = "Coordinator’s call"
    const val orbitChecked = "Orbit checked"
    const val recordAsDone = "Record as done"
    const val recordAsDoneAnyway = "Record as done anyway"
    const val receipt = "You recorded this project done"
    const val gapsAccepted = "gaps accepted"
    const val recordingExplanation = "Recording it done is yours. Orbit keeps your record — a later check won’t reopen the project " +
        "unless the criteria change or one of their tasks is reopened."
    const val askedByCoordinator = "asked by the coordinator"
    const val thisProjectIsDone = "This project is done"
    const val onProjectBranch = "On the project branch"
    const val mergedOutsideOrbit = "Merged outside Orbit"
    const val nothingToLand = "nothing to land"
    const val recordedByYou = "recorded by you"
    const val recordedByOrbit = "recorded by Orbit"
    const val readyToClose = "Ready to close"
    const val coordinatorAsked = "The coordinator asked"
    const val gapsItCouldntProve = "gaps it couldn’t prove"
    const val notAskedYet = "not asked yet"
    const val recordAsDoneRow = "Record as done…"
    const val noRequestMeta = "record as done anyway"
    const val noGaps = "Orbit has no gaps to report."
    const val notRecorded = "Project was not recorded done"

    private fun JsonObject.n(key: String) = number(key) ?: 0

    /** The projection's counts; a server without the owner's done door sends none (web's `hasDoneGate`). */
    fun counts(doc: JsonObject): JsonObject? = doc.obj("derivedDone")?.obj("counts")
    fun hasDoneDoor(doc: JsonObject) = counts(doc) != null

    /** `landingReasonLabel`: one criterion's reason, as a row says it. Null is on main. */
    fun landingReasonLabel(reason: String?) = when (reason) {
        "IN_FLIGHT" -> "In flight"
        "ON_PROJECT_BRANCH" -> onProjectBranch
        "NO_RECEIPT" -> mergedOutsideOrbit
        "NOTHING_TO_LAND" -> nothingToLand
        "CODELESS" -> "No code to land"
        else -> "Landed on main"
    }

    /** One criterion of the projection beside the words the document states it in. */
    data class Criterion(val key: String, val text: String, val satisfied: Boolean, val landingReason: String?)
    fun criteria(doc: JsonObject): List<Criterion> {
        val items = doc.objects("acceptanceCriteriaItems")
        return doc.obj("derivedDone")?.objects("criteria").orEmpty().map { c ->
            val id = c.text("definitionId").orEmpty()
            val item = items.firstOrNull { it.text("id") == id }
            Criterion(item?.text("key") ?: item?.text("id") ?: id, item?.text("text") ?: id, c.flag("satisfied"), c.text("landingReason"))
        }
    }
    fun criterionState(c: Criterion) = "${if (c.satisfied) "met" else "not met"} · ${landingReasonLabel(c.landingReason)}"

    /** `syntheticGaps`: the gaps a card nobody asked for carries — every criterion not met, or not on main for a
     * reason that is a gap (nothing to land and no code to land are outcomes, not gaps). */
    fun syntheticGaps(doc: JsonObject): List<JsonObject> = criteria(doc).filter { c ->
        (c.landingReason != null && c.landingReason != "NOTHING_TO_LAND" && c.landingReason != "CODELESS") || !c.satisfied
    }.map { c ->
        buildJsonObject {
            put("criterionKey", c.key)
            put("title", c.text)
            put("whyNotProven", if (c.satisfied) "Orbit cannot prove this criterion is on main: ${landingReasonLabel(c.landingReason)}."
                else "Orbit cannot prove this criterion is met by its work yet.")
        }
    }
    /** The gaps the card shows: the request's, or the ones Orbit fills in when nobody asked. */
    fun gaps(doc: JsonObject, request: JsonObject?): List<JsonObject> = request?.objects("gaps") ?: syntheticGaps(doc)

    /** The body a press sends: the request it answers (or null), the seal — the request's own, or the one standing
     * now when nobody asked — and the gaps the card showed. Null when no seal could be read: no press then. */
    fun body(doc: JsonObject, requestId: String?, request: JsonObject?, currentDigest: String?): JsonObject? {
        val digest = request?.text("criteriaDigest") ?: currentDigest ?: return null
        return buildJsonObject {
            put("requestId", requestId?.let(::JsonPrimitive) ?: JsonNull)
            put("criteriaDigest", digest)
            put("acceptedGaps", JsonArray(gaps(doc, request)))
        }
    }

    /** The request this project is asked about now: its open DONE_REQUEST with a readable payload, while OPEN. */
    fun live(openItems: JsonObject?, status: String?): JsonObject? =
        if (status != "OPEN") null else openItems?.obj("doneRequest")?.takeIf { it.obj("doneRequest") != null }
    fun readyToClose(status: String?, openItems: JsonObject?) = live(openItems, status) != null
    /** "The coordinator asked · 2 gaps it couldn’t prove". */
    fun requestRowDetail(row: JsonObject): String {
        val request = row.obj("doneRequest") ?: return row.text("detailLine").orEmpty()
        return "$coordinatorAsked · ${request.objects("gaps").size} $gapsItCouldntProve"
    }

    /** The done row in Open items: the coordinator's request, the owner's own Record as done…, or nothing (an
     * older server without the projection keeps the status door it had). */
    sealed interface PageRow { data class Asked(val row: JsonObject) : PageRow; data object Own : PageRow }
    fun pageRow(doc: JsonObject, openItems: JsonObject?): PageRow? {
        if (ProjectDoc.status(doc) != "OPEN" || !hasDoneDoor(doc) || openItems == null) return null
        return live(openItems, "OPEN")?.let { PageRow.Asked(it) } ?: PageRow.Own
    }

    fun doneWhenHead(count: Int) = "$doneWhen · $count criteria"
    fun gapsHead(count: Int) = "$whatOrbitCantProve · $count"
    fun meta(projectTitle: String, askedAgo: String?) =
        if (askedAgo == null) "$projectTitle · $noRequestMeta" else "$projectTitle · $askedByCoordinator · $askedAgo"
    /** What the record press says: anyway while some criterion is not met. */
    fun recordLabel(counts: JsonObject?) = if (counts != null && counts.n("met") < counts.n("criteria")) recordAsDoneAnyway else recordAsDone
    /** What the coordinator checked for a gap, and where the evidence is. */
    fun checkedLine(gap: JsonObject): String? {
        val checked = gap.text("coordinatorChecked") ?: return null
        val refs = gap.strings("evidenceRefs")
        return if (refs.isEmpty()) checked else "$checked · evidence ${refs.joinToString(", ")}"
    }
    /** How many items the Orbit checked line counts as open: the owner's, the coordinator's, and the request. */
    fun openItemsCount(items: JsonObject?): Int =
        if (items == null) 0 else items.objects("needsYou").size + items.objects("withCoordinator").size + if (items.obj("doneRequest") == null) 0 else 1
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
    /** `doneProvenance`: who recorded it. */
    fun provenance(doneBy: String?, acceptedGaps: Int) = if (doneBy == "OWNER") "$recordedByYou · $acceptedGaps $gapsAccepted" else recordedByOrbit
    /** "Oct 1", in the reader's own time zone (`formatDoneDate`). */
    fun date(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String? =
        ProjectTime.parse(iso)?.atZone(zone)?.let { DateTimeFormatter.ofPattern("MMM d", Locale.US).format(it) }
}
