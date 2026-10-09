package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/** The merge-to-main card while it merges — OrbitKit `PromotionCards`' merging stage (iOS dbab6fc5b). A confirmation is not
 * a running merge: the merge runs once the candidate's own job does, so what the card says follows that job (`execution`) —
 * queued, confirmed and waiting for it, re-checking the combined tree, or the step it has reached — and Cancel goes dead once
 * the job is pushing, which the server refuses to call back. */
object PromotionCards {
    const val merging = "Merging…"

    /** `refs/heads/x` and `x` are the same branch. */
    fun shortRef(ref: String) = ref.removePrefix("refs/heads/")
    /** Confirmed, or re-checking before it merges: the card's merging stage. */
    fun isMerging(view: JsonObject) = view.text("state") in setOf("CONFIRMED", "RECHECKING")
    private fun job(view: JsonObject) = view.obj("execution")
    private fun into(view: JsonObject) = shortRef(view.text("upstreamRef") ?: "main")

    /** The heading while it merges: "Merge queued: project/x into main", "Re-checking project/x before merging into main…". */
    fun mergingTitle(view: JsonObject): String {
        val branch = shortRef(view.text("sourceRef").orEmpty())
        val job = job(view)
        if (job?.text("state") == "QUEUED") return "Merge queued: $branch into ${into(view)}"
        if (job?.text("state") != "RUNNING") return "Merge confirmed: $branch into ${into(view)}"
        if (job.text("phase") == "CHECK") return "Re-checking $branch before merging into ${into(view)}…"
        return "Merging $branch into ${into(view)}…"
    }

    /** The status row: where the merge's own job stands, and nothing a running job has not said. */
    fun mergingStatusLine(view: JsonObject): String {
        val into = into(view)
        val job = job(view)
        if (job?.text("state") == "QUEUED") return "confirmed — queued to merge into $into"
        if (job?.text("state") != "RUNNING") return "confirmed — waiting for merge execution"
        return when (job.text("phase")) {
            "CHECK" -> if (view.text("state") == "RECHECKING") "$into moved since the check — re-checking the combined tree" else "re-checking the combined tree"
            "FETCH" -> "confirmed — fetching the branches"
            "MAIN_SYNC" -> "confirmed — syncing the branches"
            "REBASE" -> "confirmed — rebasing the branch"
            "MERGE" -> "confirmed — preparing the combined tree"
            "VERIFY" -> "confirmed — verifying the tested tree"
            "PUSH" -> "confirmed — publishing the tested tree to $into"
            else -> "confirmed — starting the merge"
        }
    }

    /** The label of the stage's dead press. */
    fun mergingActionLabel(view: JsonObject): String {
        val job = job(view)
        if (job?.text("state") == "QUEUED") return "Queued"
        if (job?.text("state") != "RUNNING") return "Confirmed"
        return if (job.text("phase") == "CHECK") "Re-checking…" else merging
    }

    /** A merge is called back only before its job pushes. */
    fun cancellable(view: JsonObject) = job(view)?.text("phase") != "PUSH"
}
